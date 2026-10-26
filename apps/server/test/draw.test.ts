import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrawEvent, DrawView } from "@spotflow-games/shared";
import { GameError } from "../src/games/contract.js";
import { createDrawEngine, guessPoints, normalizeGuess } from "../src/games/draw/engine.js";
import { CURATED_WORD_LISTS, type WordSource } from "../src/games/draw/words.js";
import { Room, type RoomHooks } from "../src/sessions/room.js";

const words = { id: "test:words", title: "Test", words: ["ice cream", "giraffe", "rocket"] };
const source: WordSource = { get: async (id) => (id === words.id ? words : null), list: async () => [] };
const engine = createDrawEngine(source, { choiceMs: 5000, turnEndMs: 3000 });
const u = (id: string) => ({ id, displayName: id, avatar: null });
const stroke = {
  tool: "pen",
  color: 0,
  size: 1,
  points: [
    [10, 10],
    [20, 30],
  ],
};

function makeRoom(config: object = { wordListId: words.id, turnSec: 60 }) {
  const hooks: RoomHooks = { sendStates: vi.fn(), sendEvent: vi.fn(), onResults: vi.fn(), onClosed: vi.fn() };
  const room = new Room(
    {
      id: "s1",
      code: "DRAWWW",
      gameType: "draw",
      hostId: "host",
      allowLateJoin: false,
      hostPlays: true,
      config,
      createdAt: new Date(),
    },
    engine,
    hooks,
  );
  for (const id of ["host", "ada", "ben"]) room.join(u(id), id, 50);
  return { room, hooks };
}
const view = (room: Room, id: string) => room.viewFor(id).game as DrawView;
const drawer = (room: Room) => view(room, "host").drawerId;
const guessersOf = (room: Room) => ["host", "ada", "ben"].filter((id) => id !== drawer(room));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("helpers", () => {
  it("normalizes guesses", () => {
    expect(normalizeGuess("  Ice-Cream! ")).toBe("ice cream");
    expect(normalizeGuess("Jollof   Rice")).toBe("jollof rice");
    expect(normalizeGuess("Café")).toBe("cafe");
  });
  it("scores guessers by order, never below 100", () => {
    expect([0, 1, 2, 3, 4, 9].map(guessPoints)).toEqual([300, 250, 200, 150, 100, 100]);
  });
});

describe("Draw & Guess", () => {
  it("only shows word choices to the drawer, then hides the word from guessers", async () => {
    const { room } = makeRoom();
    await room.start("host");
    const d = drawer(room);
    const [g1] = guessersOf(room);
    expect(view(room, d)).toMatchObject({ phase: "choosing", turnNumber: 1, totalTurns: 3 });
    expect(view(room, d).wordChoices).toHaveLength(3);
    expect(view(room, g1!).wordChoices).toBeNull();

    room.handleAction(d, { type: "choose", index: 0 });
    const word = view(room, d).word!;
    expect(view(room, d).phase).toBe("drawing");
    expect(view(room, g1!).word).toBeNull();
    expect(view(room, g1!).hint.filter((c) => c && c !== " ")).toEqual([]);
    expect(JSON.stringify(view(room, g1!))).not.toContain(word);
  });

  it("scores correct guesses by order, pays the drawer, and ends the turn when everyone has it", async () => {
    const { room } = makeRoom();
    await room.start("host");
    const d = drawer(room);
    const [g1, g2] = guessersOf(room) as [string, string];
    room.handleAction(d, { type: "choose", index: 0 });
    const word = view(room, d).word!;

    vi.advanceTimersByTime(1000);
    room.handleAction(g1, { type: "guess", text: "definitely wrong" });
    expect(view(room, g2).feed.at(-1)).toMatchObject({ userId: g1, kind: "guess", text: "definitely wrong" });
    vi.advanceTimersByTime(1000);
    room.handleAction(g1, { type: "guess", text: word.toUpperCase() });
    expect(view(room, g1).word).toBe(word);
    expect(view(room, g2).word).toBeNull();
    expect(() => room.handleAction(g1, { type: "guess", text: word })).toThrow("already got it");

    room.handleAction(g2, { type: "guess", text: word });
    expect(view(room, g2).phase).toBe("turnEnd");
    expect(view(room, g2).turnPoints).toEqual({ [g1]: 300, [g2]: 250, [d]: 100 });
    expect(room.participants.get(g1)!.score).toBe(300);
    expect(room.participants.get(d)!.score).toBe(100);
  });

  it("tells only the guesser when a guess is close", async () => {
    const { room } = makeRoom();
    await room.start("host");
    const d = drawer(room);
    const [g1, g2] = guessersOf(room) as [string, string];
    room.handleAction(d, { type: "choose", index: 0 });
    const word = view(room, d).word!;
    room.handleAction(g1, { type: "guess", text: word.slice(0, -1) });
    expect(view(room, g1).feed.at(-1)?.kind).toBe("close");
    expect(view(room, g2).feed.some((e) => e.kind === "close")).toBe(false);
  });

  it("rate-limits guesses and blocks the drawer from guessing", async () => {
    const { room } = makeRoom();
    await room.start("host");
    const d = drawer(room);
    const [g1] = guessersOf(room) as [string];
    room.handleAction(d, { type: "choose", index: 0 });
    expect(() => room.handleAction(d, { type: "guess", text: "x" })).toThrow("drawing this one");
    room.handleAction(g1, { type: "guess", text: "one" });
    expect(() => room.handleAction(g1, { type: "guess", text: "two" })).toThrow("Slow down");
  });

  it("only lets the drawer draw, validates strokes, and relays them to everyone else", async () => {
    const { room, hooks } = makeRoom();
    await room.start("host");
    const d = drawer(room);
    const [g1] = guessersOf(room) as [string];
    expect(() => room.handleAction(d, { type: "stroke", stroke })).toThrow("Only the drawer"); // still choosing
    room.handleAction(d, { type: "choose", index: 1 });
    expect(() => room.handleAction(g1, { type: "stroke", stroke })).toThrow(GameError);
    expect(() => room.handleAction(d, { type: "stroke", stroke: { ...stroke, points: [[5000, 1]] } })).toThrow(
      "isn't valid",
    );
    expect(() => room.handleAction(d, { type: "stroke", stroke: { ...stroke, extra: 1 } })).toThrow("isn't valid");

    room.handleAction(d, { type: "stroke", stroke });
    const [ids, event] = (hooks.sendEvent as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(ids).not.toContain(d);
    expect(event).toMatchObject({ type: "stroke", turn: 0 });
    expect(view(room, g1).strokeCount).toBe(1);

    room.handleAction(g1, { type: "sync" });
    const [syncIds, sync] = (hooks.sendEvent as ReturnType<typeof vi.fn>).mock.calls.at(-1)! as [string[], DrawEvent];
    expect(syncIds).toEqual([g1]);
    expect(sync).toMatchObject({ type: "sync", strokes: [stroke] });

    room.handleAction(d, { type: "clear" });
    expect(view(room, g1).strokeCount).toBe(0);
  });

  it("auto-picks a word, reveals hints over time, and rotates every player through drawing", async () => {
    const { room } = makeRoom({ wordListId: words.id, turnSec: 40 });
    await room.start("host");
    const drawers = new Set<string>();
    for (let turn = 1; turn <= 3; turn++) {
      expect(view(room, "host")).toMatchObject({ phase: "choosing", turnNumber: turn });
      drawers.add(drawer(room));
      vi.advanceTimersByTime(5000); // choice timer runs out
      expect(view(room, "host").phase).toBe("drawing");
      const g = guessersOf(room)[0]!;
      const word = room.viewFor(drawer(room)).game as DrawView;
      vi.advanceTimersByTime(20_000);
      const revealed = view(room, g).hint.filter((c) => c && c !== " ").length;
      if (word.wordLength > 4) expect(revealed).toBeGreaterThan(0);
      vi.advanceTimersByTime(20_000); // turn runs out
      expect(view(room, g).phase).toBe("turnEnd");
      expect(view(room, g).word).toBe(word.word);
      vi.advanceTimersByTime(3000);
    }
    expect(drawers.size).toBe(3);
    expect(room.status).toBe("results");
  });

  it("ends the turn when the drawer is removed, and lets the host or drawer skip", async () => {
    const { room } = makeRoom();
    await room.start("host");
    const d = drawer(room);
    if (d === "host") {
      room.handleAction("host", { type: "skip" });
    } else {
      expect(() =>
        room.handleAction(
          guessersOf(room).find((id) => id !== "host")!,
          { type: "skip" },
        ),
      ).toThrow(GameError);
      room.kick("host", d);
    }
    expect(view(room, "host").phase).toBe("turnEnd");
    room.handleAction("host", { type: "skip" });
    expect(view(room, "host").phase).toBe("choosing");
    expect(view(room, "host").turnNumber).toBe(2);
  });

  it("needs at least two players and a real word list", async () => {
    const solo = new Room(
      {
        id: "s2",
        code: "SOLOOO",
        gameType: "draw",
        hostId: "host",
        allowLateJoin: false,
        hostPlays: true,
        config: {},
        createdAt: new Date(),
      },
      engine,
      { sendStates: vi.fn(), sendEvent: vi.fn(), onResults: vi.fn(), onClosed: vi.fn() },
    );
    solo.join(u("host"), "h", 50);
    await expect(solo.start("host")).rejects.toThrow("At least 2");
    const { room } = makeRoom({ wordListId: "nope" });
    await expect(room.start("host")).rejects.toThrow("no longer exists");
  });
});

describe("curated word lists", () => {
  it("have enough unique, guessable words", () => {
    for (const list of CURATED_WORD_LISTS) {
      expect(list.words.length).toBeGreaterThanOrEqual(30);
      expect(new Set(list.words).size).toBe(list.words.length);
      for (const w of list.words) expect(normalizeGuess(w)).toBe(w);
    }
  });
});
