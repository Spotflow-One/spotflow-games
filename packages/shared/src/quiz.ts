import { z } from "zod";

/** Quiz Arena scoring, per the agreed defaults. */
export const QUIZ_RULES = {
  maxPoints: 1000,
  minCorrectPoints: 500,
  defaultTimeLimitSec: 20,
  minTimeLimitSec: 5,
  maxTimeLimitSec: 60,
  countdownMs: 3000,
  revealMs: 6000,
} as const;

export const MAX_QUESTIONS_PER_QUIZ = 50;

export const quizQuestionSchema = z
  .object({
    prompt: z.string().trim().min(1).max(300),
    options: z.array(z.string().trim().min(1).max(120)).min(2).max(4),
    correctIndex: z.number().int().min(0).max(3),
    /** Overrides the session time limit for this question. */
    timeLimitSec: z.number().int().min(QUIZ_RULES.minTimeLimitSec).max(QUIZ_RULES.maxTimeLimitSec).optional(),
  })
  .refine((q) => q.correctIndex < q.options.length, { message: "The correct answer must be one of the options" });
export type QuizQuestion = z.infer<typeof quizQuestionSchema>;

/** What a host picks when creating a Quiz Arena session. */
export const quizSessionConfigSchema = z
  .object({
    quizId: z.string().min(1).max(100),
    timeLimitSec: z
      .number()
      .int()
      .min(QUIZ_RULES.minTimeLimitSec)
      .max(QUIZ_RULES.maxTimeLimitSec)
      .default(QUIZ_RULES.defaultTimeLimitSec),
    questionCount: z.number().int().min(1).max(MAX_QUESTIONS_PER_QUIZ).optional(),
    shuffleQuestions: z.boolean().default(false),
    shuffleOptions: z.boolean().default(false),
  })
  .strict();
export type QuizSessionConfig = z.input<typeof quizSessionConfigSchema>;

export interface QuizSummary {
  id: string;
  title: string;
  description: string;
  questionCount: number;
  curated: boolean;
}

export type QuizAction = { type: "answer"; index: number } | { type: "next" };

/** Quiz state as one player sees it. The correct answer only appears in the reveal. */
export interface QuizView {
  phase: "countdown" | "question" | "reveal";
  title: string;
  questionNumber: number;
  totalQuestions: number;
  /** Server clock time when the current phase ends, plus the server's clock now, to correct for skew. */
  phaseEndsAt: number;
  serverNow: number;
  timeLimitSec: number;
  question: { prompt: string; options: string[] } | null;
  answeredCount: number;
  playerCount: number;
  isPlayer: boolean;
  myAnswer: number | null;
  reveal: {
    correctIndex: number;
    /** How many players picked each option. */
    counts: number[];
    myPoints: number;
    myAnswerMs: number | null;
  } | null;
}
