import { z } from "zod";
import { GAME_TYPES, type GameType } from "./games.js";
import type { AvatarConfig } from "./avatar.js";

/** Shared lifecycle for every game. */
export const SESSION_STATUSES = ["lobby", "ready", "in_progress", "results", "completed", "cancelled"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const MAX_PLAYERS_PER_SESSION = 50;

/** Session codes avoid ambiguous characters (0/O, 1/I/L). */
export const SESSION_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const SESSION_CODE_LENGTH = 6;
export const sessionCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(new RegExp(`^[${SESSION_CODE_ALPHABET}]{${SESSION_CODE_LENGTH}}$`));

export const createSessionSchema = z
  .object({
    gameType: z.enum(GAME_TYPES),
    allowLateJoin: z.boolean().default(false),
    hostPlays: z.boolean().default(true),
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type CreateSession = z.input<typeof createSessionSchema>;

export interface ParticipantView {
  userId: string;
  displayName: string;
  avatar: AvatarConfig | null;
  isHost: boolean;
  connected: boolean;
  score: number;
}

/** What a single client sees. The server builds one per player so secrets never leak. */
export interface SessionView {
  id: string;
  code: string;
  gameType: GameType;
  status: SessionStatus;
  hostId: string;
  allowLateJoin: boolean;
  hostPlays: boolean;
  participants: ParticipantView[];
  /** Game-specific state, already filtered for this viewer. */
  game: unknown;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface SessionSummary {
  id: string;
  code: string;
  gameType: GameType;
  status: SessionStatus;
  hostId: string;
  hostName: string;
  playerCount: number;
  createdAt: string;
}
