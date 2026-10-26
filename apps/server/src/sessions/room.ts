import type { AvatarConfig, GameType, ParticipantView, SessionStatus, SessionView } from "@spotflow-games/shared";
import type { AnyGameEngine, GameContext } from "../games/contract.js";
import { GameError } from "../games/contract.js";
import { rankPlayers } from "./ranking.js";

export interface RoomParticipant {
  userId: string;
  displayName: string;
  avatar: AvatarConfig | null;
  socketIds: Set<string>;
  score: number;
  tiebreakMs: number;
  joinedAt: number;
}

export interface PendingScoreEvent {
  userId: string;
  points: number;
  reason: string;
  idempotencyKey: string;
  at: Date;
}

/** Bulky per-session data kept outside the snapshot (see GameContext.appendLog). */
export interface RoomLog {
  append(entry: unknown): void;
  clear(): void;
  /** Deliver the whole log to a player, wrapped as a game event. */
  sendTo(userId: string, wrap: (entries: unknown[]) => unknown): void;
}

/** How a room reaches clients and storage. Implemented by the socket layer and session manager. */
export interface RoomHooks {
  /** Each connected participant's own view, pushed in one batch. */
  sendStates(views: Array<[userId: string, view: SessionView]>): void;
  sendEvent(userIds: string[], event: unknown): void;
  /** Called once when gameplay ends, to persist results. */
  onResults(room: Room): void;
  onClosed(room: Room, reason: string): void;
  /** Defaults to an in-memory log. */
  log?: RoomLog;
}

export interface RoomInit {
  id: string;
  code: string;
  gameType: GameType;
  hostId: string;
  allowLateJoin: boolean;
  hostPlays: boolean;
  config: unknown;
  createdAt: Date;
}

export interface RoomOptions {
  now?: () => number;
  /**
   * Fire timers with setTimeout in this process. Off when a shared store fires them instead,
   * because the room may be loaded on a different server instance by then.
   */
  localTimers?: boolean;
}

/** Everything needed to rebuild a room on any server instance. Encode it with codec.ts. */
export interface RoomSnapshot {
  init: RoomInit;
  config: unknown;
  status: SessionStatus;
  startedAt: Date | null;
  endedAt: Date | null;
  lastActivity: number;
  participants: RoomParticipant[];
  removed: string[];
  scoreEvents: PendingScoreEvent[];
  awardedKeys: string[];
  timers: Record<string, number>;
  gameState: unknown;
}

function memoryLog(hooks: Pick<RoomHooks, "sendEvent">): RoomLog {
  let entries: unknown[] = [];
  return {
    append: (entry) => void entries.push(entry),
    clear: () => void (entries = []),
    sendTo: (userId, wrap) => hooks.sendEvent([userId], wrap([...entries])),
  };
}

/**
 * Server-authoritative state for one live game session.
 * Each room is isolated: errors in one game's engine are caught at the room boundary.
 */
export class Room {
  readonly id: string;
  readonly code: string;
  readonly gameType: GameType;
  readonly hostId: string;
  readonly allowLateJoin: boolean;
  readonly hostPlays: boolean;
  readonly createdAt: Date;
  config: unknown;
  status: SessionStatus = "lobby";
  startedAt: Date | null = null;
  endedAt: Date | null = null;
  lastActivity: number;

  readonly participants = new Map<string, RoomParticipant>();
  readonly removed = new Set<string>();
  readonly scoreEvents: PendingScoreEvent[] = [];
  /** Due times of the game's named timers, in epoch ms. */
  readonly timers: Record<string, number> = {};
  private awardedKeys = new Set<string>();
  private gameState: unknown = null;
  private broadcastQueued = false;
  private starting = false;
  private localTimer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly localTimers: boolean;
  private readonly log: RoomLog;

  constructor(
    private init: RoomInit,
    private engine: AnyGameEngine | undefined,
    private hooks: RoomHooks,
    opts: RoomOptions = {},
  ) {
    this.id = init.id;
    this.code = init.code;
    this.gameType = init.gameType;
    this.hostId = init.hostId;
    this.allowLateJoin = init.allowLateJoin;
    this.hostPlays = init.hostPlays;
    this.config = init.config;
    this.createdAt = init.createdAt;
    this.now = opts.now ?? Date.now;
    this.localTimers = opts.localTimers ?? true;
    this.lastActivity = this.now();
    this.log = hooks.log ?? memoryLog(hooks);
  }

  static fromSnapshot(snap: RoomSnapshot, engine: AnyGameEngine | undefined, hooks: RoomHooks, opts?: RoomOptions) {
    const room = new Room(snap.init, engine, hooks, opts);
    room.config = snap.config;
    room.status = snap.status;
    room.startedAt = snap.startedAt;
    room.endedAt = snap.endedAt;
    room.lastActivity = snap.lastActivity;
    for (const p of snap.participants) room.participants.set(p.userId, p);
    for (const id of snap.removed) room.removed.add(id);
    room.scoreEvents.push(...snap.scoreEvents);
    for (const key of snap.awardedKeys) room.awardedKeys.add(key);
    Object.assign(room.timers, snap.timers);
    room.gameState = snap.gameState;
    room.armLocalTimer();
    return room;
  }

  toSnapshot(): RoomSnapshot {
    return {
      init: this.init,
      config: this.config,
      status: this.status,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      lastActivity: this.lastActivity,
      participants: [...this.participants.values()],
      removed: [...this.removed],
      scoreEvents: this.scoreEvents,
      awardedKeys: [...this.awardedKeys],
      timers: { ...this.timers },
      gameState: this.gameState,
    };
  }

  get isLive() {
    return this.status === "lobby" || this.status === "ready" || this.status === "in_progress";
  }

  /** When the next timer is due, or null if none is set. */
  nextDeadline(): number | null {
    const times = Object.values(this.timers);
    return times.length ? Math.min(...times) : null;
  }

  playerIds(): string[] {
    return [...this.participants.keys()].filter((id) => this.hostPlays || id !== this.hostId);
  }

  connectedCount() {
    let n = 0;
    for (const p of this.participants.values()) if (p.socketIds.size > 0) n++;
    return n;
  }

  /**
   * Join or reconnect. The same account always maps to one participant, so opening a
   * second tab or reconnecting never creates a duplicate.
   */
  join(user: { id: string; displayName: string; avatar: AvatarConfig | null }, socketId: string, maxPlayers: number) {
    this.touch();
    if (this.removed.has(user.id)) throw new GameError("You were removed from this session");
    const existing = this.participants.get(user.id);
    if (existing) {
      existing.socketIds.add(socketId);
      existing.displayName = user.displayName;
      existing.avatar = user.avatar;
      this.broadcast();
      return { reconnected: true };
    }
    if (!this.isLive) throw new GameError("This session has ended");
    if (this.status === "in_progress" && !this.allowLateJoin) throw new GameError("This game has already started");
    if (this.participants.size >= maxPlayers) throw new GameError("This session is full");
    this.participants.set(user.id, {
      userId: user.id,
      displayName: user.displayName,
      avatar: user.avatar,
      socketIds: new Set([socketId]),
      score: 0,
      tiebreakMs: 0,
      joinedAt: this.now(),
    });
    this.broadcast();
    return { reconnected: false };
  }

  disconnect(userId: string, socketId: string) {
    const p = this.participants.get(userId);
    if (!p || !p.socketIds.delete(socketId)) return;
    this.broadcast();
  }

  /** A player leaving on purpose. In the lobby they are dropped; mid-game they keep their score. */
  leave(userId: string) {
    this.touch();
    const p = this.participants.get(userId);
    if (!p) return;
    if (userId === this.hostId && (this.status === "lobby" || this.status === "ready")) {
      this.close("The host left the lobby");
      return;
    }
    if (this.status === "lobby" || this.status === "ready") {
      this.participants.delete(userId);
    } else {
      p.socketIds.clear();
    }
    this.broadcast();
  }

  kick(actorId: string, userId: string) {
    this.requireHost(actorId);
    if (userId === this.hostId) throw new GameError("The host cannot remove themselves");
    if (!this.participants.has(userId)) throw new GameError("That player is not in this session");
    this.touch();
    this.participants.delete(userId);
    this.removed.add(userId);
    if (this.status === "in_progress")
      this.safely(() => this.engine?.onPlayerRemoved?.(this.ctx, this.gameState, userId));
    this.broadcast();
  }

  markReady(actorId: string) {
    this.requireHost(actorId);
    if (this.status !== "lobby") throw new GameError("Only a lobby can be marked ready");
    this.touch();
    this.status = "ready";
    this.broadcast();
  }

  reopen(actorId: string) {
    this.requireHost(actorId);
    if (this.status !== "ready") throw new GameError("The session is not in the ready state");
    this.touch();
    this.status = "lobby";
    this.broadcast();
  }

  async start(actorId: string) {
    this.requireHost(actorId);
    if (this.status !== "lobby" && this.status !== "ready") throw new GameError("This session cannot be started");
    if (!this.engine) throw new GameError("This game is not available yet");
    if (this.playerIds().length < this.engine.minPlayers) {
      throw new GameError(`At least ${this.engine.minPlayers} players are needed to start`);
    }
    if (this.starting) throw new GameError("The game is already starting");
    this.starting = true;
    try {
      // Settings, including a snapshot of the content, are frozen from here on.
      const config = await this.engine.parseConfig(this.config);
      if (this.status !== "lobby" && this.status !== "ready") return;
      this.touch();
      this.config = config;
      this.status = "in_progress";
      this.startedAt = new Date(this.now());
      this.gameState = this.engine.start(this.ctx, this.config);
      this.broadcast();
    } finally {
      this.starting = false;
    }
  }

  /** Host ends the game. In the lobby this cancels; mid-game it goes to results with scores so far. */
  end(actorId: string) {
    this.requireHost(actorId);
    if (this.status === "lobby" || this.status === "ready") {
      this.close("The host cancelled the session");
    } else if (this.status === "in_progress") {
      this.finish();
    } else {
      throw new GameError("This session has already ended");
    }
  }

  handleAction(userId: string, action: unknown) {
    if (this.status !== "in_progress" || !this.engine) throw new GameError("The game is not in progress");
    if (!this.participants.has(userId)) throw new GameError("You are not in this session");
    this.touch();
    this.engine.handleAction(this.ctx, this.gameState, userId, action);
  }

  /** Runs every timer that is due, in order. Timers set while doing so fire too if already due. */
  fireDueTimers() {
    for (let guard = 0; guard < 100 && this.status === "in_progress"; guard++) {
      const due = Object.entries(this.timers)
        .filter(([, at]) => at <= this.now())
        .sort((a, b) => a[1] - b[1])[0];
      if (!due) break;
      delete this.timers[due[0]];
      this.safely(() => this.engine?.onTimer?.(this.ctx, this.gameState, due[0]));
    }
    this.armLocalTimer();
  }

  get actionRateLimit() {
    return this.engine?.actionRateLimit ?? 5;
  }

  finish() {
    if (this.status !== "in_progress") return;
    this.clearTimers();
    this.status = "results";
    this.endedAt = new Date(this.now());
    this.broadcast();
    this.hooks.onResults(this);
  }

  /** Called by the manager after results are saved. */
  markCompleted() {
    this.status = "completed";
    this.broadcast();
  }

  close(reason: string) {
    if (this.status === "completed" || this.status === "cancelled") return;
    this.clearTimers();
    this.status = "cancelled";
    this.endedAt = new Date(this.now());
    this.broadcast();
    this.hooks.onClosed(this, reason);
  }

  /** Stop local timers when this in-process copy of the room is discarded. */
  dispose() {
    if (this.localTimer) clearTimeout(this.localTimer);
    this.localTimer = null;
  }

  standings() {
    return rankPlayers(
      this.playerIds().map((id) => {
        const p = this.participants.get(id)!;
        return { userId: id, score: p.score, tiebreak: p.tiebreakMs, displayName: p.displayName };
      }),
    );
  }

  viewFor(userId: string): SessionView {
    const ended = this.status === "results" || this.status === "completed";
    const ranks = ended ? new Map(this.standings().map((r) => [r.userId, r.rank])) : null;
    const participants: ParticipantView[] = [...this.participants.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({
        userId: p.userId,
        displayName: p.displayName,
        avatar: p.avatar,
        isHost: p.userId === this.hostId,
        connected: p.socketIds.size > 0,
        score: p.score,
        rank: ranks?.get(p.userId) ?? null,
      }));
    let game: unknown = null;
    if (this.engine && this.gameState !== null) {
      const players = this.playerIds();
      const viewer = {
        userId,
        isHost: userId === this.hostId,
        isPlayer: players.includes(userId),
        playerCount: players.length,
        now: this.now(),
      };
      game = this.safely(() => this.engine!.viewFor(this.gameState, viewer)) ?? null;
    }
    return {
      id: this.id,
      code: this.code,
      gameType: this.gameType,
      status: this.status,
      hostId: this.hostId,
      allowLateJoin: this.allowLateJoin,
      hostPlays: this.hostPlays,
      participants,
      game,
      createdAt: this.createdAt.toISOString(),
      startedAt: this.startedAt?.toISOString() ?? null,
      endedAt: this.endedAt?.toISOString() ?? null,
    };
  }

  /** Coalesces many state changes in one tick into a single push per player. */
  broadcast() {
    if (this.broadcastQueued) return;
    this.broadcastQueued = true;
    queueMicrotask(() => {
      this.broadcastQueued = false;
      this.flush();
    });
  }

  flush() {
    const views: Array<[string, SessionView]> = [];
    for (const p of this.participants.values()) {
      if (p.socketIds.size > 0) views.push([p.userId, this.viewFor(p.userId)]);
    }
    if (views.length) this.hooks.sendStates(views);
  }

  private touch() {
    this.lastActivity = this.now();
  }

  private requireHost(actorId: string) {
    if (actorId !== this.hostId) throw new GameError("Only the host can do that");
  }

  private clearTimers() {
    for (const name of Object.keys(this.timers)) delete this.timers[name];
    this.armLocalTimer();
  }

  /** In local mode, keep one setTimeout pointed at the earliest due timer. */
  private armLocalTimer() {
    if (!this.localTimers) return;
    this.dispose();
    const next = this.nextDeadline();
    if (next === null || this.status !== "in_progress") return;
    this.localTimer = setTimeout(() => this.fireDueTimers(), Math.max(0, next - this.now()));
  }

  /** Runs engine code so a crashing game cannot take down the server or other sessions. */
  private safely<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch (err) {
      if (err instanceof GameError) throw err;
      console.error(`[room ${this.code}] game engine error`, err);
      this.close("The game hit an error and was stopped");
      return undefined;
    }
  }

  private _ctx?: GameContext;
  private get ctx(): GameContext {
    return (this._ctx ??= this.buildContext());
  }

  private buildContext(): GameContext {
    return {
      sessionId: this.id,
      now: () => this.now(),
      players: () => this.playerIds(),
      isHost: (userId) => userId === this.hostId,
      setTimer: (name, ms) => {
        this.timers[name] = this.now() + Math.max(0, ms);
        this.armLocalTimer();
      },
      clearTimer: (name) => {
        delete this.timers[name];
        this.armLocalTimer();
      },
      award: (userId, points, reason, key) => {
        const idempotencyKey = `${this.id}:${key}:${userId}`;
        const p = this.participants.get(userId);
        if (!p || this.awardedKeys.has(idempotencyKey) || !Number.isInteger(points)) return false;
        this.awardedKeys.add(idempotencyKey);
        p.score += points;
        this.scoreEvents.push({ userId, points, reason, idempotencyKey, at: new Date(this.now()) });
        return true;
      },
      addTiebreakTime: (userId, ms) => {
        const p = this.participants.get(userId);
        if (p) p.tiebreakMs += Math.max(0, Math.round(ms));
      },
      broadcastState: () => this.broadcast(),
      emitEvent: (event, opts) => {
        const ids = (opts?.onlyUserIds ?? [...this.participants.keys()]).filter(
          (id) => id !== opts?.exceptUserId && this.participants.has(id),
        );
        this.hooks.sendEvent(ids, event);
      },
      appendLog: (entry) => this.log.append(entry),
      clearLog: () => this.log.clear(),
      sendLog: (userId, wrap) => {
        if (this.participants.has(userId)) this.log.sendTo(userId, wrap);
      },
      finish: () => this.finish(),
    };
  }
}
