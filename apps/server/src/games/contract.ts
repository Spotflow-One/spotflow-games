import type { GameType } from "@spotflow-games/shared";

/** Thrown by engines for invalid player actions. The message is shown to the player. */
export class GameError extends Error {}

/** Services a running game gets from its session. Everything here is server-authoritative. */
export interface GameContext {
  readonly sessionId: string;
  now(): number;
  /** Ids of participants who play (excludes a non-playing host and removed players). */
  players(): string[];
  /** Named timers. Setting a name again replaces it. All are cleared when the session ends. */
  setTimer(name: string, ms: number, fn: () => void): void;
  clearTimer(name: string): void;
  /** Award points. `key` identifies the scoring action, so the same key never awards twice. */
  award(userId: string, points: number, reason: string, key: string): boolean;
  /** Add to a player's tie-break time (lower wins ties), e.g. how long they took to answer. */
  addTiebreakTime(userId: string, ms: number): void;
  /** Push fresh per-player views to everyone. */
  broadcastState(): void;
  /** Send a transient event (e.g. drawing strokes) without a full state push. */
  emitEvent(event: unknown, opts?: { exceptUserId?: string }): void;
  /** End gameplay and move the session to results. */
  finish(): void;
}

export interface ViewerInfo {
  userId: string;
  /**
   * Whether the viewer hosts the session. Hosts moderate, but engines must not use this
   * to reveal hidden answers, secret words or unrevealed votes.
   */
  isHost: boolean;
}

/**
 * The contract every game implements. Adding a game means writing one of these and
 * registering it; sessions, scoring and real-time transport stay the same.
 */
export interface GameEngine<Config = unknown, State = unknown> {
  readonly type: GameType;
  readonly rulesVersion: number;
  readonly minPlayers: number;
  /** Validate and normalize host settings. Throw GameError on bad input. */
  parseConfig(raw: unknown): Config;
  start(ctx: GameContext, config: Config): State;
  handleAction(ctx: GameContext, state: State, userId: string, action: unknown): void;
  /** What one viewer may see. Must hide anything secret from this viewer. */
  viewFor(state: State, viewer: ViewerInfo): unknown;
  onPlayerRemoved?(ctx: GameContext, state: State, userId: string): void;
  /** Allowed actions per second per player. Defaults to 5. */
  readonly actionRateLimit?: number;
}

export type AnyGameEngine = GameEngine<any, any>;
