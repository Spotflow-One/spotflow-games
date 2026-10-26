import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TruthsView } from "@spotflow-games/shared";
import { GameError } from "../src/games/contract.js";
import { createTruthsEngine } from "../src/games/truths/engine.js";
import { Room, type RoomHooks } from "../src/sessions/room.js";

const engine = createTruthsEngine({ revealMs: 3000 });
const u = (id: string) => ({ id, displayName: id, avatar: null });
const PLAYERS = ["host", "ada", "ben"];

function makeRoom(config: object = { featuredCount: 3, voteSec: 30, writeSec: 120 }, hostPlays = true) {
  const hooks: RoomHooks = { sendStates: vi.fn(), sendEvent: vi.fn(), onResults: vi.fn(), onClosed: vi.fn() };
  const room = new Room(
    {
      id: "s1",
      code: "TRUTHS",
      gameType: "truths",
      hostId: "host",
      allowLateJoin: false,
      hostPlays,
      config,
      createdAt: new Date(),
    },
    engine,
    hooks,
  );
  for (const id of PLAYERS) room.join(u(id), id, 50);
  return { room, hooks };
}
const view = (room: Room, id: string) => room.viewFor(id).game as TruthsView;
const statementsFor = (id: string): [string, string, string] => [`${id} truth one`, `${id} truth two`, `${id} lie`];
const submitAll = (room: Room) => {
  for (const id of view(room, "host").featuredIds)
    room.handleAction(id, { type: "submit", statements: statementsFor(id), lieIndex: 2 });
};
/** The lie's position after the server shuffled the statements, found from the author's view. */
const lieOf = (room: Room) => {
  const author = view(room, "host").authorId!;
  return view(room, author).myLieIndex!;
};
const score = (room: Room, id: string) => room.viewFor(id).participants.find((p) => p.userId === id)!.score;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Two Truths and a Lie", () => {
  it("features up to the configured number of players and validates submissions", async () => {
    const { room } = makeRoom({ featuredCount: 2 });
    await room.start("host");
    const v = view(room, "host");
    expect(v.phase).toBe("writing");
    expect(v.featuredIds).toHaveLength(2);
    expect(v.totalRounds).toBe(2);

    const [f1] = v.featuredIds as [string];
    const outsider = PLAYERS.find((id) => !v.featuredIds.includes(id))!;
    expect(() =>
      room.handleAction(outsider, { type: "submit", statements: statementsFor(outsider), lieIndex: 0 }),
    ).toThrow(GameError);
    expect(() => room.handleAction(f1, { type: "submit", statements: ["same", "same", "same"], lieIndex: 0 })).toThrow(
      "Make the three statements different",
    );
    expect(() => room.handleAction(f1, { type: "submit", statements: ["ok one", "ok two"], lieIndex: 0 })).toThrow(
      GameError,
    );
    expect(() => room.handleAction(f1, { type: "submit", statements: statementsFor(f1), lieIndex: 3 })).toThrow(
      GameError,
    );

    room.handleAction(f1, { type: "submit", statements: statementsFor(f1), lieIndex: 1 });
    expect(view(room, f1).mySubmission?.lieIndex).toBe(1);
    // Others only see who has submitted, never what.
    expect(view(room, outsider).mySubmission).toBeNull();
    expect(JSON.stringify(view(room, outsider))).not.toContain(`${f1} lie`);
    expect(view(room, outsider).submittedIds).toEqual([f1]);
  });

  it("hides the lie and other votes until the reveal, then scores voters and the author", async () => {
    const { room } = makeRoom();
    await room.start("host");
    submitAll(room);
    const v = view(room, "host");
    expect(v.phase).toBe("voting");
    expect(v.roundNumber).toBe(1);
    expect(v.totalRounds).toBe(3);

    const author = v.authorId!;
    const [right, wrong] = PLAYERS.filter((id) => id !== author) as [string, string];
    const lie = lieOf(room);
    expect(view(room, right).statements).toHaveLength(3);
    expect(view(room, right).statements).toContain(`${author} lie`);
    expect(view(room, right).myLieIndex).toBeNull();
    expect(view(room, right).reveal).toBeNull();
    expect(() => room.handleAction(author, { type: "vote", index: 0 })).toThrow(
      "You can't vote on your own statements",
    );

    vi.advanceTimersByTime(2000);
    room.handleAction(right, { type: "vote", index: lie });
    expect(() => room.handleAction(right, { type: "vote", index: lie })).toThrow("You already voted");
    expect(view(room, wrong)).toMatchObject({ myVote: null, votedCount: 1, voterCount: 2, reveal: null });

    room.handleAction(wrong, { type: "vote", index: (lie + 1) % 3 });
    const r = view(room, wrong);
    expect(r.phase).toBe("reveal");
    expect(r.reveal!.lieIndex).toBe(lie);
    expect(r.reveal!.votes[lie]).toEqual([right]);
    expect(r.reveal!.votes[(lie + 1) % 3]).toEqual([wrong]);
    expect(r.reveal!.points).toEqual({ [right]: 100, [author]: 50 });
    expect(score(room, right)).toBe(100);
    expect(score(room, author)).toBe(50);
    expect(score(room, wrong)).toBe(0);
  });

  it("shuffles statements but keeps the lie index pointing at the lie", async () => {
    for (let i = 0; i < 10; i++) {
      const { room } = makeRoom({ featuredCount: 1 });
      await room.start("host");
      submitAll(room);
      const author = view(room, "host").authorId!;
      const viewer = PLAYERS.find((id) => id !== author)!;
      expect(view(room, viewer).statements![lieOf(room)]).toBe(`${author} lie`);
      room.end("host");
    }
  });

  it("moves on when timers run out, dropping featured players who never wrote anything", async () => {
    const { room, hooks } = makeRoom({ featuredCount: 3, voteSec: 15, writeSec: 60 });
    await room.start("host");
    room.handleAction("ada", { type: "submit", statements: statementsFor("ada"), lieIndex: 0 });
    vi.advanceTimersByTime(60_000);
    expect(view(room, "host")).toMatchObject({ phase: "voting", authorId: "ada", totalRounds: 1 });

    // Nobody votes: no points, and the miss counts against the tie-break.
    vi.advanceTimersByTime(15_000);
    expect(view(room, "host").phase).toBe("reveal");
    expect(view(room, "host").reveal!.points).toEqual({});
    vi.advanceTimersByTime(3000);
    expect(room.status).toBe("results");
    expect(hooks.onResults).toHaveBeenCalledOnce();
  });

  it("finishes straight away if nobody submits", async () => {
    const { room } = makeRoom({ featuredCount: 2, writeSec: 60 });
    await room.start("host");
    vi.advanceTimersByTime(60_000);
    expect(room.status).toBe("results");
  });

  it("lets only the host move on early or skip a round without scoring", async () => {
    const { room } = makeRoom({ featuredCount: 2 });
    await room.start("host");
    expect(() => room.handleAction("ada", { type: "next" })).toThrow("Only the host can move on");
    const [f1] = view(room, "host").featuredIds as [string];
    room.handleAction(f1, { type: "submit", statements: statementsFor(f1), lieIndex: 2 });
    room.handleAction("host", { type: "next" });
    expect(view(room, "host")).toMatchObject({ phase: "voting", totalRounds: 1, authorId: f1 });

    const voter = PLAYERS.find((id) => id !== f1)!;
    room.handleAction(voter, { type: "vote", index: lieOf(room) });
    expect(() => room.handleAction("ada", { type: "skip" })).toThrow("Only the host can skip");
    room.handleAction("host", { type: "skip" });
    expect(room.status).toBe("results");
    expect(score(room, voter)).toBe(0);
  });

  it("closes voting early when the host says next, and scores the votes so far", async () => {
    const { room } = makeRoom({ featuredCount: 1 });
    await room.start("host");
    submitAll(room);
    const author = view(room, "host").authorId!;
    const voter = PLAYERS.find((id) => id !== author)!;
    room.handleAction(voter, { type: "vote", index: lieOf(room) });
    room.handleAction("host", { type: "next" });
    expect(view(room, "host").phase).toBe("reveal");
    expect(score(room, voter)).toBe(100);
    room.handleAction("host", { type: "next" });
    expect(room.status).toBe("results");
  });

  it("skips a removed author's round and closes voting when the last voter is removed", async () => {
    const { room } = makeRoom({ featuredCount: 3 });
    await room.start("host");
    submitAll(room);
    let author = view(room, "host").authorId!;
    if (author === "host") {
      // The host can't be kicked, so get to a round by someone else.
      room.handleAction("host", { type: "skip" });
      author = view(room, "host").authorId!;
    }
    const round = view(room, "host").roundNumber;
    room.kick("host", author);
    expect(view(room, "host").roundNumber).toBeGreaterThan(round);

    const current = view(room, "host");
    if (current.phase === "voting") {
      const others = PLAYERS.filter((id) => id !== author && id !== current.authorId);
      room.handleAction(others[0]!, { type: "vote", index: 0 });
      expect(view(room, "host").phase).toBe("reveal");
    }
  });

  it("never features or lets a host who isn't playing vote", async () => {
    const { room } = makeRoom({ featuredCount: 3 }, false);
    await room.start("host");
    const v = view(room, "host");
    expect(v.isPlayer).toBe(false);
    expect(v.featuredIds.sort()).toEqual(["ada", "ben"]);
    submitAll(room);
    expect(() => room.handleAction("host", { type: "vote", index: 0 })).toThrow("Only players can vote");
  });

  it("rejects bad settings", () => {
    expect(() => engine.parseConfig({ featuredCount: 0 })).toThrow(GameError);
    expect(() => engine.parseConfig({ voteSec: 5 })).toThrow(GameError);
    expect(() => engine.parseConfig({ extra: true })).toThrow(GameError);
    expect(engine.parseConfig({})).toEqual({ featuredCount: 3, voteSec: 30, writeSec: 120 });
  });
});
