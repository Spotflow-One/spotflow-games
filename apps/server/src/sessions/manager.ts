import { and, eq, inArray, sql } from "drizzle-orm";
import {
  MAX_PLAYERS_PER_SESSION,
  parseAvatar,
  type CreateSession,
  type SessionView,
  createSessionSchema,
} from "@spotflow-games/shared";
import type { Db } from "../db/client.js";
import { gameSessions, scoreEvents, sessionParticipants } from "../db/schema.js";
import type { GameRegistry } from "../games/registry.js";
import { generateSessionCode } from "./codes.js";
import { Room } from "./room.js";

export interface Transport {
  sendState(userId: string, view: SessionView): void;
  sendEvent(userIds: string[], code: string, event: unknown): void;
  sendClosed(userIds: string[], code: string, reason: string): void;
}

export interface ManagerOptions {
  lobbyExpiryMs: number;
  /** How long a game may run with nobody connected before it is ended. */
  abandonedGameMs?: number;
  /** How long finished rooms stay in memory so players can see results. */
  resultsLingerMs?: number;
  maxPlayers?: number;
  log?: Pick<Console, "info" | "error">;
}

const LIVE_STATUSES = ["lobby", "ready", "in_progress", "results"] as const;

export class SessionManager {
  private rooms = new Map<string, Room>();
  private sweeper?: NodeJS.Timeout;
  private transport: Transport | null = null;
  private pendingSaves = new Set<Promise<void>>();
  readonly maxPlayers: number;

  constructor(
    private db: Db,
    private registry: GameRegistry,
    private opts: ManagerOptions,
  ) {
    this.maxPlayers = opts.maxPlayers ?? MAX_PLAYERS_PER_SESSION;
  }

  setTransport(transport: Transport) {
    this.transport = transport;
  }

  /** Sessions only live in memory, so anything left live by a previous process is cancelled on boot. */
  async recoverOnBoot() {
    await this.db
      .update(gameSessions)
      .set({ status: "cancelled", endedAt: sql`now()` })
      .where(inArray(gameSessions.status, [...LIVE_STATUSES]));
  }

  startSweeper(intervalMs = 60_000) {
    this.sweeper = setInterval(() => this.sweep(), intervalMs);
    this.sweeper.unref();
  }

  async stop() {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const room of this.rooms.values()) room.close("The server is restarting");
    await this.flushSaves();
  }

  /** Wait for in-flight result saves. Used in tests and shutdown. */
  async flushSaves() {
    await Promise.all([...this.pendingSaves]);
  }

  get(code: string) {
    return this.rooms.get(code.toUpperCase());
  }

  liveRooms() {
    return [...this.rooms.values()].filter((r) => r.isLive);
  }

  async create(hostId: string, input: CreateSession) {
    const data = createSessionSchema.parse(input);
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateSessionCode();
      if (this.rooms.has(code)) continue;
      const [row] = await this.db
        .insert(gameSessions)
        .values({
          code,
          gameType: data.gameType,
          hostId,
          config: data.config,
          allowLateJoin: data.allowLateJoin,
          hostPlays: data.hostPlays,
          rulesVersion: this.registry.get(data.gameType)?.rulesVersion ?? 1,
        })
        .onConflictDoNothing()
        .returning();
      if (!row) continue;
      const room = new Room(
        {
          id: row.id,
          code,
          gameType: row.gameType,
          hostId,
          allowLateJoin: row.allowLateJoin,
          hostPlays: row.hostPlays,
          config: row.config,
          createdAt: row.createdAt,
        },
        this.registry.get(row.gameType),
        {
          sendState: (userId, view) => this.transport?.sendState(userId, view),
          sendEvent: (userIds, event) => this.transport?.sendEvent(userIds, code, event),
          onResults: (r) => this.track(this.saveResults(r)),
          onClosed: (r, reason) => this.track(this.onClosed(r, reason)),
        },
      );
      this.rooms.set(code, room);
      this.opts.log?.info(`session ${code} created (${row.gameType}) by ${hostId}`);
      return room;
    }
    throw new Error("Could not allocate a session code");
  }

  async join(code: string, user: { id: string; displayName: string; avatar: unknown }, socketId: string) {
    const room = this.get(code);
    if (!room) return null;
    const isNew = !room.participants.has(user.id);
    room.join(
      { id: user.id, displayName: user.displayName, avatar: parseAvatar(user.avatar) },
      socketId,
      this.maxPlayers,
    );
    if (isNew) {
      await this.db
        .insert(sessionParticipants)
        .values({ sessionId: room.id, userId: user.id })
        .onConflictDoUpdate({
          target: [sessionParticipants.sessionId, sessionParticipants.userId],
          set: { status: "active" },
        });
    }
    return room;
  }

  async kick(code: string, actorId: string, userId: string) {
    const room = this.get(code);
    if (!room) return null;
    room.kick(actorId, userId);
    this.transport?.sendClosed([userId], room.code, "You were removed by the host");
    await this.db
      .update(sessionParticipants)
      .set({ status: "kicked" })
      .where(and(eq(sessionParticipants.sessionId, room.id), eq(sessionParticipants.userId, userId)));
    return room;
  }

  async leave(code: string, userId: string) {
    const room = this.get(code);
    if (!room) return;
    const inLobby = room.status === "lobby" || room.status === "ready";
    room.leave(userId);
    if (inLobby && userId !== room.hostId) {
      await this.db
        .delete(sessionParticipants)
        .where(and(eq(sessionParticipants.sessionId, room.id), eq(sessionParticipants.userId, userId)));
    }
  }

  sweep(now = Date.now()) {
    const abandonedMs = this.opts.abandonedGameMs ?? 10 * 60_000;
    for (const room of this.rooms.values()) {
      const idle = now - room.lastActivity;
      if ((room.status === "lobby" || room.status === "ready") && idle > this.opts.lobbyExpiryMs) {
        room.close("The lobby expired");
      } else if (room.status === "in_progress" && room.connectedCount() === 0 && idle > abandonedMs) {
        room.finish();
      }
    }
  }

  private track(p: Promise<void>) {
    this.pendingSaves.add(p);
    p.finally(() => this.pendingSaves.delete(p));
  }

  /** Persists scores and standings in one transaction. Score events are idempotent by key. */
  private async saveResults(room: Room) {
    try {
      const standings = room.standings();
      await this.db.transaction(async (tx) => {
        if (room.scoreEvents.length > 0) {
          await tx
            .insert(scoreEvents)
            .values(
              room.scoreEvents.map((e) => ({
                sessionId: room.id,
                userId: e.userId,
                gameType: room.gameType,
                points: e.points,
                reason: e.reason,
                idempotencyKey: e.idempotencyKey,
                createdAt: e.at,
              })),
            )
            .onConflictDoNothing({ target: scoreEvents.idempotencyKey });
        }
        for (const s of standings) {
          await tx
            .update(sessionParticipants)
            .set({ finalScore: s.score, finalRank: s.rank })
            .where(and(eq(sessionParticipants.sessionId, room.id), eq(sessionParticipants.userId, s.userId)));
        }
        await tx
          .update(gameSessions)
          .set({ status: "completed", config: room.config ?? {}, startedAt: room.startedAt, endedAt: room.endedAt })
          .where(eq(gameSessions.id, room.id));
      });
      room.markCompleted();
      this.opts.log?.info(`session ${room.code} completed`);
    } catch (err) {
      this.opts.log?.error(`session ${room.code} failed to save results`, err);
    } finally {
      this.evictLater(room);
    }
  }

  private async onClosed(room: Room, reason: string) {
    this.transport?.sendClosed([...room.participants.keys()], room.code, reason);
    try {
      await this.db
        .update(gameSessions)
        .set({ status: "cancelled", endedAt: room.endedAt })
        .where(eq(gameSessions.id, room.id));
    } catch (err) {
      this.opts.log?.error(`session ${room.code} failed to save cancellation`, err);
    }
    this.rooms.delete(room.code);
  }

  private evictLater(room: Room) {
    const t = setTimeout(
      () => {
        if (this.rooms.get(room.code) === room) this.rooms.delete(room.code);
      },
      this.opts.resultsLingerMs ?? 15 * 60_000,
    );
    t.unref();
  }
}
