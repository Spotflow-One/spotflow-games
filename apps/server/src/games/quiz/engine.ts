import { randomInt } from "node:crypto";
import {
  QUIZ_RULES,
  quizSessionConfigSchema,
  type QuizAction,
  type QuizQuestion,
  type QuizView,
} from "@spotflow-games/shared";
import { GameError, type GameContext, type GameEngine } from "../contract.js";
import type { QuizSource } from "./library.js";

/** Resolved settings plus a snapshot of the questions, frozen when the game starts. */
export interface QuizConfig {
  quizId: string;
  title: string;
  timeLimitSec: number;
  questions: QuizQuestion[];
}

interface QuizState {
  config: QuizConfig;
  index: number;
  phase: QuizView["phase"];
  phaseStartedAt: number;
  phaseEndsAt: number;
  /** Answers to the current question: option index and how long it took. */
  answers: Map<string, { index: number; ms: number }>;
  /** Points each player earned on the current question, filled in at reveal. */
  points: Map<string, number>;
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function shuffleOptions(q: QuizQuestion): QuizQuestion {
  const order = shuffle(q.options.map((_, i) => i));
  return { ...q, options: order.map((i) => q.options[i]!), correctIndex: order.indexOf(q.correctIndex) };
}

/** Correct answers earn 1000 points at once, falling linearly to 500 at the buzzer. */
export function quizPoints(ms: number, limitMs: number): number {
  const { maxPoints, minCorrectPoints } = QUIZ_RULES;
  const fraction = Math.min(1, Math.max(0, ms / limitMs));
  return Math.round(maxPoints - (maxPoints - minCorrectPoints) * fraction);
}

export function createQuizEngine(
  source: QuizSource,
  timing: { countdownMs: number; revealMs: number } = {
    countdownMs: QUIZ_RULES.countdownMs,
    revealMs: QUIZ_RULES.revealMs,
  },
) {
  const limitMs = (state: QuizState) =>
    (state.config.questions[state.index]?.timeLimitSec ?? state.config.timeLimitSec) * 1000;

  /** When the phase timer runs out, `onTimer` moves on to the next phase. */
  const setPhase = (ctx: GameContext, state: QuizState, phase: QuizState["phase"], ms: number) => {
    state.phase = phase;
    state.phaseStartedAt = ctx.now();
    state.phaseEndsAt = state.phaseStartedAt + ms;
    ctx.setTimer("phase", ms);
    ctx.broadcastState();
  };

  const openQuestion = (ctx: GameContext, state: QuizState, index: number) => {
    state.index = index;
    state.answers.clear();
    state.points.clear();
    setPhase(ctx, state, "question", limitMs(state));
  };

  const closeQuestion = (ctx: GameContext, state: QuizState) => {
    if (state.phase !== "question") return;
    const question = state.config.questions[state.index]!;
    const limit = limitMs(state);
    for (const userId of ctx.players()) {
      const answer = state.answers.get(userId);
      const correct = answer?.index === question.correctIndex;
      const points = correct ? quizPoints(answer.ms, limit) : 0;
      state.points.set(userId, points);
      if (points > 0) ctx.award(userId, points, `Correct answer to question ${state.index + 1}`, `q${state.index}`);
      // Ties go to whoever was faster overall; wrong or missing answers count as the full time.
      ctx.addTiebreakTime(userId, correct ? answer.ms : limit);
    }
    setPhase(ctx, state, "reveal", timing.revealMs);
  };

  const advance = (ctx: GameContext, state: QuizState) => {
    if (state.index + 1 < state.config.questions.length) openQuestion(ctx, state, state.index + 1);
    else ctx.finish();
  };

  const allAnswered = (ctx: GameContext, state: QuizState) => {
    const players = ctx.players();
    return players.length > 0 && players.every((id) => state.answers.has(id));
  };

  const engine: GameEngine<QuizConfig, QuizState> = {
    type: "quiz",
    rulesVersion: 1,
    minPlayers: 1,
    actionRateLimit: 4,

    async parseConfig(raw) {
      const parsed = quizSessionConfigSchema.safeParse(raw ?? {});
      if (!parsed.success) throw new GameError("Pick a quiz before starting");
      const quiz = await source.get(parsed.data.quizId);
      if (!quiz) throw new GameError("That quiz no longer exists");
      // Deep copy, so edits to the quiz after this point cannot reach a running game.
      const snapshot = structuredClone(quiz.questions);
      let questions = parsed.data.shuffleQuestions ? shuffle(snapshot) : snapshot;
      if (parsed.data.questionCount) questions = questions.slice(0, parsed.data.questionCount);
      if (parsed.data.shuffleOptions) questions = questions.map(shuffleOptions);
      if (questions.length === 0) throw new GameError("That quiz has no questions");
      return { quizId: quiz.id, title: quiz.title, timeLimitSec: parsed.data.timeLimitSec, questions };
    },

    start(ctx, config) {
      const state: QuizState = {
        config,
        index: 0,
        phase: "countdown",
        phaseStartedAt: 0,
        phaseEndsAt: 0,
        answers: new Map(),
        points: new Map(),
      };
      setPhase(ctx, state, "countdown", timing.countdownMs);
      return state;
    },

    handleAction(ctx, state, userId, raw) {
      const action = raw as QuizAction;
      if (action?.type === "answer") {
        if (state.phase !== "question") throw new GameError("Answers are closed");
        if (!ctx.players().includes(userId)) throw new GameError("Only players can answer");
        if (state.answers.has(userId)) throw new GameError("You already answered");
        const question = state.config.questions[state.index]!;
        if (!Number.isInteger(action.index) || action.index < 0 || action.index >= question.options.length) {
          throw new GameError("That isn't one of the options");
        }
        state.answers.set(userId, { index: action.index, ms: Math.max(0, ctx.now() - state.phaseStartedAt) });
        if (allAnswered(ctx, state)) closeQuestion(ctx, state);
        else ctx.broadcastState();
        return;
      }
      if (action?.type === "next") {
        if (!ctx.isHost(userId)) throw new GameError("Only the host can skip ahead");
        if (state.phase === "question") closeQuestion(ctx, state);
        else if (state.phase === "reveal") advance(ctx, state);
        return;
      }
      throw new GameError("Unknown action");
    },

    onTimer(ctx, state, name) {
      if (name !== "phase") return;
      if (state.phase === "countdown") openQuestion(ctx, state, 0);
      else if (state.phase === "question") closeQuestion(ctx, state);
      else advance(ctx, state);
    },

    onPlayerRemoved(ctx, state) {
      if (state.phase === "question" && allAnswered(ctx, state)) closeQuestion(ctx, state);
    },

    viewFor(state, viewer): QuizView {
      const question = state.phase === "countdown" ? null : state.config.questions[state.index]!;
      const mine = state.answers.get(viewer.userId);
      let reveal: QuizView["reveal"] = null;
      if (state.phase === "reveal" && question) {
        const counts = question.options.map(() => 0);
        for (const a of state.answers.values()) counts[a.index]!++;
        reveal = {
          correctIndex: question.correctIndex,
          counts,
          myPoints: state.points.get(viewer.userId) ?? 0,
          myAnswerMs: mine?.ms ?? null,
        };
      }
      return {
        phase: state.phase,
        title: state.config.title,
        questionNumber: state.index + 1,
        totalQuestions: state.config.questions.length,
        phaseEndsAt: state.phaseEndsAt,
        serverNow: viewer.now,
        timeLimitSec: Math.round(limitMs(state) / 1000),
        question: question ? { prompt: question.prompt, options: question.options } : null,
        answeredCount: state.answers.size,
        playerCount: viewer.playerCount,
        isPlayer: viewer.isPlayer,
        myAnswer: mine?.index ?? null,
        reveal,
      };
    },
  };
  return engine;
}
