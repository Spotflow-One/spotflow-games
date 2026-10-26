import { randomInt } from "node:crypto";
import {
  CANVAS,
  DRAW_RULES,
  drawSessionConfigSchema,
  strokeSchema,
  type DrawAction,
  type DrawEvent,
  type DrawView,
  type FeedEntry,
  type Stroke,
} from "@spotflow-games/shared";
import { GameError, type GameContext, type GameEngine } from "../contract.js";
import type { WordSource } from "./words.js";

/** Resolved settings plus a snapshot of the word list, frozen when the game starts. */
export interface DrawConfig {
  wordListId: string;
  title: string;
  turnSec: number;
  rounds: number;
  words: string[];
}

interface DrawState {
  config: DrawConfig;
  /** Who draws, in order. Built from the players at the start. */
  order: string[];
  totalTurns: number;
  turnIndex: number;
  drawerId: string;
  phase: DrawView["phase"];
  phaseStartedAt: number;
  phaseEndsAt: number;
  choices: string[];
  word: string;
  usedWords: Set<string>;
  revealed: Set<number>;
  /** Correct guessers in order, with how long they took. */
  guessed: Map<string, number>;
  turnPoints: Map<string, number>;
  strokes: Stroke[];
  feed: Array<FeedEntry & { onlyFor?: string }>;
  feedSeq: number;
  lastGuessAt: Map<string, number>;
}

const MAX_FEED = 60;

/** Lowercase, drop punctuation and accents, collapse spaces: "Ice-Cream!" matches "ice cream". */
export function normalizeGuess(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}

/** Points for the nth correct guesser (0-based): 300, 250, 200, 150, then 100 each. */
export function guessPoints(order: number): number {
  return Math.max(DRAW_RULES.minGuessPoints, DRAW_RULES.firstGuessPoints - DRAW_RULES.guessPointsStep * order);
}

export function createDrawEngine(
  source: WordSource,
  timing: { choiceMs: number; turnEndMs: number } = {
    choiceMs: DRAW_RULES.choiceSec * 1000,
    turnEndMs: DRAW_RULES.turnEndMs,
  },
) {
  const addFeed = (state: DrawState, entry: Omit<FeedEntry, "id"> & { onlyFor?: string }) => {
    state.feed.push({ ...entry, id: ++state.feedSeq });
    if (state.feed.length > MAX_FEED) state.feed.splice(0, state.feed.length - MAX_FEED);
  };

  const setPhase = (ctx: GameContext, state: DrawState, phase: DrawState["phase"], ms: number, next: () => void) => {
    state.phase = phase;
    state.phaseStartedAt = ctx.now();
    state.phaseEndsAt = state.phaseStartedAt + ms;
    ctx.setTimer("phase", ms, next);
    ctx.broadcastState();
  };

  const guessers = (ctx: GameContext, state: DrawState) => ctx.players().filter((id) => id !== state.drawerId);

  const pickChoices = (state: DrawState) => {
    let pool = state.config.words.filter((w) => !state.usedWords.has(w));
    if (pool.length < DRAW_RULES.wordChoices) pool = [...state.config.words];
    const picks: string[] = [];
    while (picks.length < DRAW_RULES.wordChoices && pool.length > 0) {
      picks.push(pool.splice(randomInt(pool.length), 1)[0]!);
    }
    return picks;
  };

  const beginTurn = (ctx: GameContext, state: DrawState, index: number) => {
    ctx.clearTimer("hint0");
    ctx.clearTimer("hint1");
    // Skip drawers who have left or been removed.
    while (index < state.totalTurns && !ctx.players().includes(state.order[index % state.order.length]!)) index++;
    if (index >= state.totalTurns || ctx.players().length < 2) {
      ctx.finish();
      return;
    }
    state.turnIndex = index;
    state.drawerId = state.order[index % state.order.length]!;
    state.choices = pickChoices(state);
    state.word = "";
    state.revealed.clear();
    state.guessed.clear();
    state.turnPoints.clear();
    state.strokes = [];
    state.lastGuessAt.clear();
    addFeed(state, { userId: state.drawerId, kind: "system", text: "is choosing a word" });
    setPhase(ctx, state, "choosing", timing.choiceMs, () => chooseWord(ctx, state, randomInt(state.choices.length)));
  };

  const chooseWord = (ctx: GameContext, state: DrawState, index: number) => {
    if (state.phase !== "choosing") return;
    state.word = state.choices[index]!;
    state.usedWords.add(state.word);
    addFeed(state, { userId: state.drawerId, kind: "system", text: "is drawing" });
    const turnMs = state.config.turnSec * 1000;
    DRAW_RULES.hintAt.forEach((at, i) => ctx.setTimer(`hint${i}`, turnMs * at, () => revealLetter(ctx, state)));
    setPhase(ctx, state, "drawing", turnMs, () => endTurn(ctx, state));
  };

  const revealLetter = (ctx: GameContext, state: DrawState) => {
    if (state.phase !== "drawing") return;
    const hidden = [...state.word].map((c, i) => (c !== " " && !state.revealed.has(i) ? i : -1)).filter((i) => i >= 0);
    // Always leave at least two letters hidden.
    if (hidden.length <= 2) return;
    state.revealed.add(hidden[randomInt(hidden.length)]!);
    ctx.broadcastState();
  };

  const endTurn = (ctx: GameContext, state: DrawState) => {
    if (state.phase === "turnEnd") return;
    ctx.clearTimer("hint0");
    ctx.clearTimer("hint1");
    if (state.phase === "drawing") {
      // Ties go to whoever guessed faster overall; a missed word counts as the whole turn.
      for (const id of guessers(ctx, state)) {
        if (!state.guessed.has(id)) ctx.addTiebreakTime(id, state.config.turnSec * 1000);
      }
      addFeed(state, { userId: null, kind: "system", text: `The word was "${state.word}"` });
    } else {
      addFeed(state, { userId: state.drawerId, kind: "system", text: "skipped their turn" });
    }
    setPhase(ctx, state, "turnEnd", timing.turnEndMs, () => beginTurn(ctx, state, state.turnIndex + 1));
  };

  const handleGuess = (ctx: GameContext, state: DrawState, userId: string, text: unknown) => {
    if (state.phase !== "drawing") throw new GameError("Guesses open once the drawing starts");
    if (userId === state.drawerId) throw new GameError("You're drawing this one");
    if (!ctx.players().includes(userId)) throw new GameError("Only players can guess");
    if (state.guessed.has(userId)) throw new GameError("You already got it");
    if (typeof text !== "string") throw new GameError("Type a guess");
    const raw = text.trim().slice(0, DRAW_RULES.maxGuessLength);
    const guess = normalizeGuess(raw);
    if (!guess) throw new GameError("Type a guess");
    const now = ctx.now();
    if (now - (state.lastGuessAt.get(userId) ?? 0) < DRAW_RULES.guessCooldownMs)
      throw new GameError("Slow down a little");
    state.lastGuessAt.set(userId, now);

    const answer = normalizeGuess(state.word);
    if (guess === answer) {
      const ms = now - state.phaseStartedAt;
      const points = guessPoints(state.guessed.size);
      state.guessed.set(userId, ms);
      ctx.award(userId, points, `Guessed "${state.word}"`, `turn${state.turnIndex}:guess`);
      ctx.award(
        state.drawerId,
        DRAW_RULES.drawerPointsPerGuess,
        "Someone guessed your drawing",
        `turn${state.turnIndex}:from:${userId}`,
      );
      ctx.addTiebreakTime(userId, ms);
      state.turnPoints.set(userId, (state.turnPoints.get(userId) ?? 0) + points);
      state.turnPoints.set(
        state.drawerId,
        (state.turnPoints.get(state.drawerId) ?? 0) + DRAW_RULES.drawerPointsPerGuess,
      );
      addFeed(state, { userId, kind: "correct", text: `guessed the word! +${points}` });
      if (guessers(ctx, state).every((id) => state.guessed.has(id))) endTurn(ctx, state);
      else ctx.broadcastState();
      return;
    }
    if (answer.length >= 4 && editDistance(guess, answer) <= 1) {
      // Only the guesser sees that they're close, so the answer doesn't leak.
      addFeed(state, { userId, kind: "close", text: `"${raw}" is close!`, onlyFor: userId });
    } else {
      addFeed(state, { userId, kind: "guess", text: raw });
    }
    ctx.broadcastState();
  };

  const engine: GameEngine<DrawConfig, DrawState> = {
    type: "draw",
    rulesVersion: 1,
    minPlayers: 2,
    // Drawing sends many small stroke chunks; guesses have their own cooldown.
    actionRateLimit: 40,

    async parseConfig(raw) {
      const parsed = drawSessionConfigSchema.safeParse(raw ?? {});
      if (!parsed.success) throw new GameError("Those game settings aren't valid");
      const list = await source.get(parsed.data.wordListId);
      if (!list) throw new GameError("That word list no longer exists");
      if (list.words.length < DRAW_RULES.wordChoices) throw new GameError("That word list needs more words");
      return {
        wordListId: list.id,
        title: list.title,
        turnSec: parsed.data.turnSec,
        rounds: parsed.data.rounds,
        words: [...list.words],
      };
    },

    start(ctx, config) {
      const order = ctx.players();
      const state: DrawState = {
        config,
        order,
        totalTurns: order.length * config.rounds,
        turnIndex: 0,
        drawerId: order[0]!,
        phase: "choosing",
        phaseStartedAt: 0,
        phaseEndsAt: 0,
        choices: [],
        word: "",
        usedWords: new Set(),
        revealed: new Set(),
        guessed: new Map(),
        turnPoints: new Map(),
        strokes: [],
        feed: [],
        feedSeq: 0,
        lastGuessAt: new Map(),
      };
      beginTurn(ctx, state, 0);
      return state;
    },

    handleAction(ctx, state, userId, raw) {
      const action = raw as DrawAction;
      switch (action?.type) {
        case "choose": {
          if (state.phase !== "choosing" || userId !== state.drawerId)
            throw new GameError("It's not your turn to choose");
          if (!Number.isInteger(action.index) || !state.choices[action.index])
            throw new GameError("Pick one of the words");
          chooseWord(ctx, state, action.index);
          return;
        }
        case "stroke": {
          if (state.phase !== "drawing" || userId !== state.drawerId) throw new GameError("Only the drawer can draw");
          if (state.strokes.length >= CANVAS.maxStrokesPerTurn)
            throw new GameError("The canvas is full. Clear it to keep drawing");
          const parsed = strokeSchema.safeParse(action.stroke);
          if (!parsed.success) throw new GameError("That stroke isn't valid");
          state.strokes.push(parsed.data);
          const event: DrawEvent = { type: "stroke", turn: state.turnIndex, stroke: parsed.data };
          ctx.emitEvent(event, { exceptUserId: userId });
          return;
        }
        case "clear": {
          if (state.phase !== "drawing" || userId !== state.drawerId) throw new GameError("Only the drawer can clear");
          state.strokes = [];
          const event: DrawEvent = { type: "clear", turn: state.turnIndex };
          ctx.emitEvent(event, { exceptUserId: userId });
          return;
        }
        case "guess":
          handleGuess(ctx, state, userId, action.text);
          return;
        case "sync": {
          const event: DrawEvent = { type: "sync", turn: state.turnIndex, strokes: state.strokes };
          ctx.emitEvent(event, { onlyUserIds: [userId] });
          return;
        }
        case "skip": {
          if (!ctx.isHost(userId) && userId !== state.drawerId)
            throw new GameError("Only the host or the drawer can skip");
          if (state.phase === "turnEnd") {
            if (!ctx.isHost(userId)) throw new GameError("Only the host can skip ahead");
            beginTurn(ctx, state, state.turnIndex + 1);
          } else {
            endTurn(ctx, state);
          }
          return;
        }
        default:
          throw new GameError("Unknown action");
      }
    },

    onPlayerRemoved(ctx, state, userId) {
      if (state.phase === "turnEnd") return;
      if (userId === state.drawerId) endTurn(ctx, state);
      else if (state.phase === "drawing" && guessers(ctx, state).every((id) => state.guessed.has(id)))
        endTurn(ctx, state);
    },

    viewFor(state, viewer): DrawView {
      const isDrawer = viewer.userId === state.drawerId;
      const canSeeWord =
        state.word !== "" && (isDrawer || state.guessed.has(viewer.userId) || state.phase === "turnEnd");
      const hint = [...state.word].map((c, i) => (c === " " ? " " : canSeeWord || state.revealed.has(i) ? c : null));
      return {
        phase: state.phase,
        turnNumber: state.turnIndex + 1,
        totalTurns: state.totalTurns,
        drawerId: state.drawerId,
        phaseEndsAt: state.phaseEndsAt,
        serverNow: viewer.now,
        turnSec: state.config.turnSec,
        wordChoices: isDrawer && state.phase === "choosing" ? state.choices : null,
        word: canSeeWord ? state.word : null,
        hint,
        wordLength: state.word.replace(/ /g, "").length,
        guessedIds: [...state.guessed.keys()],
        isPlayer: viewer.isPlayer,
        strokeCount: state.strokes.length,
        feed: state.feed
          .filter((e) => !e.onlyFor || e.onlyFor === viewer.userId)
          .map(({ onlyFor: _onlyFor, ...e }) => e),
        turnPoints: state.phase === "turnEnd" ? Object.fromEntries(state.turnPoints) : null,
      };
    },
  };
  return engine;
}
