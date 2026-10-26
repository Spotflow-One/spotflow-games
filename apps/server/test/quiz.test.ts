import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuizView } from "@spotflow-games/shared";
import { GameError } from "../src/games/contract.js";
import { createQuizEngine, quizPoints } from "../src/games/quiz/engine.js";
import { CURATED_QUIZZES, type QuizSource } from "../src/games/quiz/library.js";
import { Room, type RoomHooks } from "../src/sessions/room.js";

const quiz = {
  id: "test:quiz",
  title: "Test quiz",
  description: "",
  questions: [
    { prompt: "Q1", options: ["a", "b", "c", "d"], correctIndex: 1 },
    { prompt: "Q2", options: ["yes", "no"], correctIndex: 0 },
  ],
};
const source: QuizSource = {
  get: async (id) => (id === quiz.id ? quiz : null),
  list: async () => [],
};
const engine = createQuizEngine(source, { countdownMs: 3000, revealMs: 5000 });
const u = (id: string) => ({ id, displayName: id, avatar: null });

function makeRoom(config: object = { quizId: quiz.id, timeLimitSec: 10 }, hostPlays = true) {
  const hooks: RoomHooks = { sendStates: vi.fn(), sendEvent: vi.fn(), onResults: vi.fn(), onClosed: vi.fn() };
  const room = new Room(
    {
      id: "s1",
      code: "QUIZZZ",
      gameType: "quiz",
      hostId: "host",
      allowLateJoin: false,
      hostPlays,
      config,
      createdAt: new Date(),
    },
    engine,
    hooks,
  );
  room.join(u("host"), "h", 50);
  room.join(u("ada"), "a", 50);
  room.join(u("ben"), "b", 50);
  return { room, hooks };
}
const view = (room: Room, userId: string) => room.viewFor(userId).game as QuizView;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("quizPoints", () => {
  it("gives 1000 for an instant answer and 500 at the buzzer", () => {
    expect(quizPoints(0, 20_000)).toBe(1000);
    expect(quizPoints(10_000, 20_000)).toBe(750);
    expect(quizPoints(20_000, 20_000)).toBe(500);
    expect(quizPoints(30_000, 20_000)).toBe(500);
  });
});

describe("Quiz Arena", () => {
  it("runs countdown, questions, reveals and finishes with server-side scores", async () => {
    const { room, hooks } = makeRoom();
    await room.start("host");
    expect(view(room, "ada")).toMatchObject({ phase: "countdown", question: null, totalQuestions: 2 });

    vi.advanceTimersByTime(3000);
    expect(view(room, "ada")).toMatchObject({ phase: "question", questionNumber: 1, reveal: null });
    expect(JSON.stringify(view(room, "ada"))).not.toContain("correctIndex");

    vi.advanceTimersByTime(2000);
    room.handleAction("ada", { type: "answer", index: 1 }); // correct after 2s of 10s
    room.handleAction("ben", { type: "answer", index: 0 }); // wrong
    expect(view(room, "ada")).toMatchObject({ phase: "question", myAnswer: 1, answeredCount: 2 });
    expect(view(room, "ben").myAnswer).toBe(0);

    room.handleAction("host", { type: "answer", index: 1 }); // everyone answered: closes early
    const reveal = view(room, "ada");
    expect(reveal.phase).toBe("reveal");
    expect(reveal.reveal).toMatchObject({ correctIndex: 1, counts: [1, 2, 0, 0], myPoints: 900 });
    expect(view(room, "ben").reveal?.myPoints).toBe(0);

    vi.advanceTimersByTime(5000);
    expect(view(room, "ada")).toMatchObject({ phase: "question", questionNumber: 2, myAnswer: null });
    vi.advanceTimersByTime(10_000); // nobody answers
    expect(view(room, "ada").phase).toBe("reveal");
    vi.advanceTimersByTime(5000);

    expect(room.status).toBe("results");
    expect(hooks.onResults).toHaveBeenCalledOnce();
    expect(room.participants.get("ada")!.score).toBe(900);
    expect(room.participants.get("host")!.score).toBe(900);
    // Same score: the faster answerer ranks higher.
    expect(room.standings().map((s) => [s.userId, s.rank])).toEqual([
      ["ada", 1],
      ["host", 1],
      ["ben", 3],
    ]);
  });

  it("rejects late, duplicate and invalid answers", async () => {
    const { room } = makeRoom();
    await room.start("host");
    expect(() => room.handleAction("ada", { type: "answer", index: 0 })).toThrow("Answers are closed");
    vi.advanceTimersByTime(3000);
    expect(() => room.handleAction("ada", { type: "answer", index: 9 })).toThrow(GameError);
    room.handleAction("ada", { type: "answer", index: 0 });
    expect(() => room.handleAction("ada", { type: "answer", index: 1 })).toThrow("already answered");
  });

  it("lets only the host skip ahead", async () => {
    const { room } = makeRoom();
    await room.start("host");
    vi.advanceTimersByTime(3000);
    expect(() => room.handleAction("ada", { type: "next" })).toThrow("Only the host");
    room.handleAction("host", { type: "next" });
    expect(view(room, "ada").phase).toBe("reveal");
    room.handleAction("host", { type: "next" });
    expect(view(room, "ada")).toMatchObject({ phase: "question", questionNumber: 2 });
  });

  it("does not let a non-playing host answer, and closes when all players answered", async () => {
    const { room } = makeRoom({ quizId: quiz.id }, false);
    await room.start("host");
    vi.advanceTimersByTime(3000);
    expect(view(room, "host").isPlayer).toBe(false);
    expect(() => room.handleAction("host", { type: "answer", index: 1 })).toThrow("Only players");
    room.handleAction("ada", { type: "answer", index: 1 });
    room.handleAction("ben", { type: "answer", index: 1 });
    expect(view(room, "host").phase).toBe("reveal");
  });

  it("snapshots content at start so later edits do not change the game", async () => {
    const { room } = makeRoom();
    await room.start("host");
    quiz.questions[0]!.prompt = "Edited";
    vi.advanceTimersByTime(3000);
    expect(view(room, "ada").question?.prompt).toBe("Q1");
    quiz.questions[0]!.prompt = "Q1";
  });

  it("refuses to start with an unknown quiz", async () => {
    const { room } = makeRoom({ quizId: "nope" });
    await expect(room.start("host")).rejects.toThrow("no longer exists");
    expect(room.status).toBe("lobby");
  });

  it("keeps the right answer when options are shuffled", async () => {
    for (let i = 0; i < 20; i++) {
      const config = await engine.parseConfig({ quizId: quiz.id, shuffleOptions: true, shuffleQuestions: true });
      for (const q of config.questions) {
        const original = quiz.questions.find((o) => o.prompt === q.prompt)!;
        expect(q.options[q.correctIndex]).toBe(original.options[original.correctIndex]);
      }
    }
  });

  it("can limit the number of questions", async () => {
    const config = await engine.parseConfig({ quizId: quiz.id, questionCount: 1 });
    expect(config.questions).toHaveLength(1);
  });
});

describe("curated quizzes", () => {
  it("are all valid, with unique ids and in-range answers", () => {
    const ids = new Set(CURATED_QUIZZES.map((q) => q.id));
    expect(ids.size).toBe(CURATED_QUIZZES.length);
    for (const q of CURATED_QUIZZES) {
      expect(q.questions.length).toBeGreaterThanOrEqual(10);
      for (const question of q.questions) {
        expect(question.correctIndex).toBeLessThan(question.options.length);
        expect(new Set(question.options).size).toBe(question.options.length);
      }
    }
  });
});

describe("quiz settings", () => {
  it("rejects hosts smuggling their own questions into the settings", async () => {
    await expect(engine.parseConfig({ quizId: quiz.id, questions: [{ prompt: "x" }] })).rejects.toThrow(GameError);
  });
});
