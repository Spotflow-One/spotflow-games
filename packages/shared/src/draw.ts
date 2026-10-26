import { z } from "zod";

/** Draw & Guess rules, per the agreed defaults. */
export const DRAW_RULES = {
  defaultTurnSec: 80,
  minTurnSec: 30,
  maxTurnSec: 180,
  choiceSec: 15,
  turnEndMs: 6000,
  wordChoices: 3,
  /** Guessers earn 300 for guessing first, 50 less for each later guesser, never under 100. */
  firstGuessPoints: 300,
  guessPointsStep: 50,
  minGuessPoints: 100,
  /** The drawer earns this for each correct guess. */
  drawerPointsPerGuess: 50,
  /** Minimum gap between one player's guesses. */
  guessCooldownMs: 700,
  maxGuessLength: 60,
  /** Fraction of the turn after which a letter of the word is revealed. */
  hintAt: [0.5, 0.75],
} as const;

/** Canvas coordinates are integers on a 1000 x 750 board, scaled on each screen. */
export const CANVAS = { width: 1000, height: 750, maxPointsPerStroke: 64, maxStrokesPerTurn: 3000 } as const;

/** Index into the design system's brush colours. */
export const BRUSH_COLORS = ["black", "grey", "red", "orange", "yellow", "green", "blue", "purple", "brown"] as const;
export const BRUSH_SIZES = [4, 10, 22] as const;

export const strokeSchema = z
  .object({
    tool: z.enum(["pen", "eraser"]),
    color: z
      .number()
      .int()
      .min(0)
      .max(BRUSH_COLORS.length - 1),
    size: z
      .number()
      .int()
      .min(0)
      .max(BRUSH_SIZES.length - 1),
    points: z
      .array(z.tuple([z.number().int().min(0).max(CANVAS.width), z.number().int().min(0).max(CANVAS.height)]))
      .min(1)
      .max(CANVAS.maxPointsPerStroke),
  })
  .strict();
export type Stroke = z.infer<typeof strokeSchema>;

export const drawSessionConfigSchema = z
  .object({
    wordListId: z.string().min(1).max(100).default("curated:mixed"),
    turnSec: z.number().int().min(DRAW_RULES.minTurnSec).max(DRAW_RULES.maxTurnSec).default(DRAW_RULES.defaultTurnSec),
    /** How many times everyone draws. */
    rounds: z.number().int().min(1).max(3).default(1),
  })
  .strict();
export type DrawSessionConfig = z.input<typeof drawSessionConfigSchema>;

export interface WordListSummary {
  id: string;
  title: string;
  wordCount: number;
  curated: boolean;
}

export type DrawAction =
  | { type: "choose"; index: number }
  | { type: "stroke"; stroke: Stroke }
  | { type: "clear" }
  | { type: "guess"; text: string }
  | { type: "sync" }
  | { type: "skip" };

/** Transient events sent outside state pushes. */
export type DrawEvent =
  | { type: "stroke"; turn: number; stroke: Stroke }
  | { type: "clear"; turn: number }
  | { type: "sync"; turn: number; strokes: Stroke[] };

export interface FeedEntry {
  id: number;
  userId: string | null;
  kind: "guess" | "correct" | "close" | "system";
  text: string;
}

export interface DrawView {
  phase: "choosing" | "drawing" | "turnEnd";
  turnNumber: number;
  totalTurns: number;
  drawerId: string;
  phaseEndsAt: number;
  serverNow: number;
  turnSec: number;
  /** Only the drawer gets these, while choosing. */
  wordChoices: string[] | null;
  /** The word for the drawer, players who guessed it, and everyone at turn end. */
  word: string | null;
  /** One entry per character: the letter if visible, null if hidden, " " between words. */
  hint: Array<string | null>;
  wordLength: number;
  guessedIds: string[];
  isPlayer: boolean;
  /** The canvas this view belongs to and how many strokes it has, so clients can tell if they missed some. */
  strokeCount: number;
  feed: FeedEntry[];
  /** Points earned in the turn that just ended. */
  turnPoints: Record<string, number> | null;
}
