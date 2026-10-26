import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuizView, TruthsView } from "@spotflow-games/shared";
import type { AnyGameEngine } from "../src/games/contract.js";
import { createDrawEngine } from "../src/games/draw/engine.js";
import { createQuizEngine } from "../src/games/quiz/engine.js";
import { createTruthsEngine } from "../src/games/truths/engine.js";
import { decode, encode } from "../src/sessions/codec.js";
import { Room, type RoomHooks, type RoomSnapshot } from "../src/sessions/room.js";

/**
 * A shared store saves a room after every change and loads it again for the next one, so a
 * game must carry on the same from a snapshot that went through JSON.
 */
const quiz = {
  id: "test:quiz",
  title: "Test quiz",
  description: "",
  questions: [
    { prompt: "Q1", options: ["a", "b", "c", "d"], correctIndex: 1 },
    { prompt: "Q2", options: ["yes", "no"], correctIndex: 0 },
  ],
};
const words = { id: "test:words", title: "Test", words: ["giraffe", "rocket", "teapot"] };
const quizEngine = createQuizEngine(
  { get: async (id) => (id === quiz.id ? quiz : null), list: async () => [] },
  { countdownMs: 3000, revealMs: 5000 },
);
const drawEngine = createDrawEngine(
  { get: async (id) => (id === words.id ? words : null), list: async () => [] },
  { choiceMs: 5000, turnEndMs: 3000 },
);
const truthsEngine = createTruthsEngine({ revealMs: 3000 });
const PLAYERS = ["host", "ada", "ben"];
const u = (id: string) => ({ id, displayName: id, avatar: null });
const hooks = (): RoomHooks => ({ sendStates: vi.fn(), sendEvent: vi.fn(), onResults: vi.fn(), onClosed: vi.fn() });

async function startRoom(engine: AnyGameEngine, gameType: "quiz" | "draw" | "truths", config: object) {
  const room = new Room(
    {
      id: "s1",
      code: "SNAPSH",
      gameType,
      hostId: "host",
      allowLateJoin: false,
      hostPlays: true,
      config,
      createdAt: new Date(),
    },
    engine,
    hooks(),
  );
  for (const id of PLAYERS) room.join(u(id), id, 50);
  await room.start("host");
  return room;
}

/** Saves and reloads the room the way the shared store does, and drops the original. */
function reload(room: Room, engine: AnyGameEngine) {
  const snap = decode<RoomSnapshot>(encode(room.toSnapshot()));
  room.dispose();
  const copy = Room.fromSnapshot(snap, engine, hooks());
  for (const id of PLAYERS) expect(copy.viewFor(id)).toEqual(room.viewFor(id));
  return copy;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("rooms survive a save and reload", () => {
  it("quiz keeps answers, scores and timers", async () => {
    let room = await startRoom(quizEngine, "quiz", { quizId: quiz.id, timeLimitSec: 10 });
    room = reload(room, quizEngine);
    // The countdown timer was saved with the room and fires on the reloaded copy.
    vi.advanceTimersByTime(3000);
    expect((room.viewFor("ada").game as QuizView).phase).toBe("question");
    room.handleAction("ada", { type: "answer", index: 1 });
    room = reload(room, quizEngine);
    // A second answer from the same player is still refused after the reload.
    expect(() => room.handleAction("ada", { type: "answer", index: 0 })).toThrow();
    vi.advanceTimersByTime(10_000);
    room = reload(room, quizEngine);
    expect(room.viewFor("ada").participants.find((p) => p.userId === "ada")!.score).toBeGreaterThan(0);
  });

  it("draw keeps the turn, word and hints", async () => {
    let room = await startRoom(drawEngine, "draw", { wordListId: words.id, turnSec: 60 });
    room = reload(room, drawEngine);
    // Letting the choice time run out picks a word on the reloaded copy.
    vi.advanceTimersByTime(5000);
    room = reload(room, drawEngine);
    const drawer = PLAYERS.find((id) => (room.viewFor(id).game as { word?: string }).word)!;
    const word = (room.viewFor(drawer).game as { word: string }).word;
    expect(words.words).toContain(word);
    const guesser = PLAYERS.find((id) => id !== drawer)!;
    room.handleAction(guesser, { type: "guess", text: word });
    room = reload(room, drawEngine);
    expect(room.viewFor(guesser).participants.find((p) => p.userId === guesser)!.score).toBeGreaterThan(0);
  });

  it("truths keeps statements, votes and the reveal timer", async () => {
    let room = await startRoom(truthsEngine, "truths", { featuredCount: 3, voteSec: 30, writeSec: 120 });
    const view = (id: string) => room.viewFor(id).game as TruthsView;
    for (const id of view("host").featuredIds)
      room.handleAction(id, { type: "submit", statements: [`${id} one`, `${id} two`, `${id} lie`], lieIndex: 2 });
    room = reload(room, truthsEngine);
    const author = view("host").authorId!;
    const voter = PLAYERS.find((id) => id !== author)!;
    room.handleAction(voter, { type: "vote", index: view(author).myLieIndex! });
    room = reload(room, truthsEngine);
    vi.advanceTimersByTime(30_000);
    room = reload(room, truthsEngine);
    expect(view("host").phase).toBe("reveal");
  });
});
