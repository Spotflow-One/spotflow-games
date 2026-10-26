import { z } from "zod";

/** Two Truths and a Lie rules, per the agreed defaults. */
export const TRUTHS_RULES = {
  defaultFeatured: 3,
  maxFeatured: 10,
  defaultVoteSec: 30,
  minVoteSec: 15,
  maxVoteSec: 90,
  defaultWriteSec: 120,
  minWriteSec: 60,
  maxWriteSec: 300,
  revealMs: 8000,
  /** Points for spotting the lie. */
  correctVotePoints: 100,
  /** Points to the featured player for each person their lie fooled. */
  fooledPoints: 50,
  minStatementLength: 3,
  maxStatementLength: 140,
} as const;

export const truthsSessionConfigSchema = z
  .object({
    featuredCount: z.number().int().min(1).max(TRUTHS_RULES.maxFeatured).default(TRUTHS_RULES.defaultFeatured),
    voteSec: z
      .number()
      .int()
      .min(TRUTHS_RULES.minVoteSec)
      .max(TRUTHS_RULES.maxVoteSec)
      .default(TRUTHS_RULES.defaultVoteSec),
    writeSec: z
      .number()
      .int()
      .min(TRUTHS_RULES.minWriteSec)
      .max(TRUTHS_RULES.maxWriteSec)
      .default(TRUTHS_RULES.defaultWriteSec),
  })
  .strict();
export type TruthsSessionConfig = z.input<typeof truthsSessionConfigSchema>;

const statement = z.string().trim().min(TRUTHS_RULES.minStatementLength).max(TRUTHS_RULES.maxStatementLength);

export const truthsSubmissionSchema = z
  .object({
    statements: z.tuple([statement, statement, statement]),
    lieIndex: z.number().int().min(0).max(2),
  })
  .strict()
  .refine((s) => new Set(s.statements.map((x) => x.toLowerCase())).size === 3, {
    message: "Make the three statements different",
  });
export type TruthsSubmission = z.infer<typeof truthsSubmissionSchema>;

/** Ideas shown while players write, so nobody stares at a blank box. */
export const TRUTHS_PROMPTS = [
  "A place you've been, or never been",
  "A famous person you've met",
  "An unusual job you've had",
  "A hidden talent",
  "A food you've tried, or never would",
  "Something from your childhood",
  "A record or award you hold",
  "A sport or hobby you've done",
  "A language you speak",
  "A pet you've owned",
] as const;

export type TruthsAction =
  | { type: "submit"; statements: [string, string, string]; lieIndex: number }
  | { type: "vote"; index: number }
  | { type: "next" }
  | { type: "skip" };

export interface TruthsView {
  phase: "writing" | "voting" | "reveal";
  phaseEndsAt: number;
  serverNow: number;
  voteSec: number;
  writeSec: number;
  featuredIds: string[];
  /** Featured players who have submitted their statements. */
  submittedIds: string[];
  isFeatured: boolean;
  isPlayer: boolean;
  /** Your own submission while writing, so you can edit it. */
  mySubmission: TruthsSubmission | null;
  roundNumber: number;
  totalRounds: number;
  authorId: string | null;
  statements: string[] | null;
  /** Only the author sees this before the reveal. */
  myLieIndex: number | null;
  myVote: number | null;
  votedCount: number;
  voterCount: number;
  reveal: {
    lieIndex: number;
    /** Voter ids per statement, revealed once voting closes. */
    votes: string[][];
    points: Record<string, number>;
  } | null;
}
