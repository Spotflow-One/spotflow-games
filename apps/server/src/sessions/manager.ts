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
import { GameError } from "../games/contract.js";
import type { GameRegistry } from "../games/registry.js";
import { generateSessionCode } from "./codes.js";
import { Room, type RoomHooks, type RoomInit, type RoomLog, type RoomSnapshot } from "./room.js";
import { MemoryRoomStore, type RoomInfo, type RoomStore } from "./store.js";

export interface Transport {
  sendStates(code: string, views: Array<[string, SessionView]>): void;
  sendEvent(userIds: string[], code: string, event: unknown): void;
  sendClosed(userIds: string[], code: string, reason: string): void;
}

export interface ManagerOptions {
  lobbyExpiryMs: number;
  /** How long a game may run with nobody connected before it is ended. */
  abandonedGameMs?: number;
  /** How long finished rooms are kept so players can see results. */
  resultsLingerMs?: number;
  maxPlayers?: number;
  log?: Pick<Console, "info" | "error">;
}

/** Builds and loads Room objects with the manager's hooks. Stores use it to rehydrate snapshots. */
export interface RoomBuilder {
  build(init: RoomInit, log?: RoomLog): Room;
  load(snapshot: RoomSnapshot, log?: RoomLog): Room;
}

const LIVE_STATUSES = ["lobby", "ready", "in_progress", "results"] as const;

/** What saving results needs, captured when the game ends. */
interface Results {
  id: string;
  code: string;
  gameType: Room["gameType"];
  config: unknown;
  startedAt: Date | null;
  endedAt: Date | null;
  standings: ReturnType<Room["standings"]>;
  scoreEvents: Room["scoreEvents"];
}

export class SessionManager {
  private sweeper?: NodeJS.Timeout;
  private transport: Transport | null = null;
  private pendingSaves = new Set<Promise<void>>();
  private store: RoomStore;
  readonly maxPlayers: number;
  readonly builder: RoomBuilder;

  constructor(
    private db: Db,
    private registry: GameRegistry,
    private opts: ManagerOptions,
    /** Builds the store. Defaults to keeping rooms in this process. */
    makeStore?: (builder: RoomBuilder, transport: () => Transport | null) => RoomStore,
  ) {
    this.maxPlayers = opts.maxPlayers ?? MAX_PLAYERS_PER_SESSION;
    this.builder = {
      build: (init, log) =>
        new Room(init, this.registry.get(init.gameType), this.hooks(init.code, log), {
          localTimers: !makeStore,
        }),
      load: (snap, log) =>
        Room.fromSnapshot(snap, this.registry.get(snap.init.gameType), this.hooks(snap.init.code, log), {
          localTimers: false,
        }),
    };
    this.store = makeStore ? makeStore(this.builder, () => this.transport) : new MemoryRoomStore();
  }

  /** Whether rooms are shared with other server instances. */
  get shared() {
    return !(this.store instanceof MemoryRoomStore);
  }

  setTransport(transport: Transport) {
    this.transport = transport;
  }

  /**
   * Sessions that are live in the database but have no live room can never finish, so they are
   * cancelled. With rooms in memory that is everything left over from a previous process.
   */
  async recoverOnBoot() {
    if (!this.shared) {
      await this.db
        .update(gameSessions)
        .set({ status: "cancelled", endedAt: sql`now()` })
        .where(inArray(gameSessions.status, [...LIVE_STATUSES]));
      return;
    }
    await this.reconcile();
  }

  startSweeper(intervalMs = 60_000) {
    this.sweeper = setInterval(
      () => void this.sweep().catch((err) => this.opts.log?.error("sweep failed", err)),
      intervalMs,
    );
    this.sweeper.unref();
  }

  async stop() {
    if (this.sweeper) clearInterval(this.sweeper);
    // Shared rooms carry on from another instance; in-process ones end with this process.
    if (!this.shared) {
      for (const code of await this.store.codes()) {
        await this.store.withRoom(code, (room) => room.close("The server is restarting"));
      }
    }
    await this.flushSaves();
    await this.store.close();
  }

  /** Wait for in-flight result saves. Used in tests and shutdown. */
  async flushSaves() {
    while (this.pendingSaves.size) await Promise.all([...this.pendingSaves]);
  }

  info(code: string) {
    return this.store.info(code.toUpperCase());
  }

  async liveRooms(): Promise<RoomInfo[]> {
    return (await this.store.list()).filter(
      (r) => r.status === "lobby" || r.status === "ready" || r.status === "in_progress",
    );
  }

  /** Run `fn` against a live room with exclusive access. Throws if there is no such room. */
  async run<T>(code: string, fn: (room: Room) => T | Promise<T>): Promise<T> {
    const result = await this.store.withRoom(code.toUpperCase(), fn);
    if (!result) throw new GameError("No session with that code");
    return result.value;
  }

  async create(hostId: string, input: CreateSession): Promise<RoomInfo> {
    const data = createSessionSchema.parse(input);
    // Fail fast on bad settings (e.g. an unknown quiz). Content is snapshotted again at start.
    await this.registry.get(data.gameType)?.parseConfig(data.config);
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateSessionCode();
      if (await this.store.info(code)) continue;
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
      const room = this.builder.build({
        id: row.id,
        code,
        gameType: row.gameType,
        hostId,
        allowLateJoin: row.allowLateJoin,
        hostPlays: row.hostPlays,
        config: row.config,
        createdAt: row.createdAt,
      });
      if (!(await this.store.insert(room))) continue;
      this.opts.log?.info(`session ${code} created (${row.gameType}) by ${hostId}`);
      return (await this.store.info(code))!;
    }
    throw new Error("Could not allocate a session code");
  }

  async join(
    code: string,
    user: { id: string; displayName: string; avatar: unknown },
    socketId: string,
    alias?: string | null,
  ) {
    const { room, isNew } = await this.run(code, (room) => {
      const isNew = !room.participants.has(user.id);
      room.join(
        { id: user.id, displayName: user.displayName, avatar: parseAvatar(user.avatar) },
        socketId,
        this.maxPlayers,
        alias,
      );
      return { room: { id: room.id, view: room.viewFor(user.id) }, isNew };
    });
    if (isNew) {
      await this.db
        .insert(sessionParticipants)
        .values({ sessionId: room.id, userId: user.id })
        .onConflictDoUpdate({
          target: [sessionParticipants.sessionId, sessionParticipants.userId],
          set: { status: "active" },
        });
    }
    return room.view;
  }

  /** Tracked, so shutdown waits for players to be marked as disconnected. */
  disconnect(code: string, userId: string, socketId: string) {
    const p = this.store.withRoom(code, (room) => room.disconnect(userId, socketId)).then(() => {});
    this.track(p);
    return p;
  }

  async kick(code: string, actorId: string, userId: string) {
    const id = await this.run(code, (room) => {
      room.kick(actorId, userId);
      return room.id;
    });
    this.transport?.sendClosed([userId], code, "You were removed by the host");
    await this.db
      .update(sessionParticipants)
      .set({ status: "kicked" })
      .where(and(eq(sessionParticipants.sessionId, id), eq(sessionParticipants.userId, userId)));
  }

  async leave(code: string, userId: string) {
    const result = await this.store.withRoom(code, (room) => {
      const inLobby = room.status === "lobby" || room.status === "ready";
      room.leave(userId);
      return { id: room.id, removeRow: inLobby && userId !== room.hostId };
    });
    if (result?.value.removeRow) {
      await this.db
        .delete(sessionParticipants)
        .where(and(eq(sessionParticipants.sessionId, result.value.id), eq(sessionParticipants.userId, userId)));
    }
  }

  /** Expires idle lobbies, ends abandoned games and cleans up the database. One instance at a time. */
  async sweep(now = Date.now()) {
    const abandonedMs = this.opts.abandonedGameMs ?? 10 * 60_000;
    await this.store.exclusive("sweep", 50_000, async () => {
      for (const info of await this.store.list()) {
        const idle = now - info.lastActivity;
        const lobby = info.status === "lobby" || info.status === "ready";
        if (lobby && idle > this.opts.lobbyExpiryMs) {
          await this.store.withRoom(info.code, (room) => room.close("The lobby expired"));
        } else if (info.status === "in_progress" && info.connectedCount === 0 && idle > abandonedMs) {
          await this.store.withRoom(info.code, (room) => room.finish());
        }
      }
      if (this.shared) await this.reconcile();
    });
  }

  /** Cancels sessions the database thinks are live but no store holds (e.g. a lost Redis key). */
  private async reconcile() {
    const live = await this.db
      .select({ id: gameSessions.id, code: gameSessions.code })
      .from(gameSessions)
      .where(
        and(
          inArray(gameSessions.status, [...LIVE_STATUSES]),
          sql`${gameSessions.createdAt} < now() - interval '1 minute'`,
        ),
      );
    if (live.length === 0) return;
    const stored = new Set(await this.store.codes());
    const lost = live.filter((s) => !stored.has(s.code)).map((s) => s.id);
    if (lost.length) {
      await this.db
        .update(gameSessions)
        .set({ status: "cancelled", endedAt: sql`now()` })
        .where(inArray(gameSessions.id, lost));
    }
  }

  private hooks(code: string, log?: RoomLog): RoomHooks {
    return {
      sendStates: (views) => this.transport?.sendStates(code, views),
      sendEvent: (userIds, event) => this.transport?.sendEvent(userIds, code, event),
      onResults: (room) => this.track(this.saveResults(this.captureResults(room))),
      onClosed: (room, reason) =>
        this.track(this.onClosed({ id: room.id, code, endedAt: room.endedAt }, [...room.participants.keys()], reason)),
      log,
    };
  }

  private captureResults(room: Room): Results {
    return {
      id: room.id,
      code: room.code,
      gameType: room.gameType,
      config: room.config,
      startedAt: room.startedAt,
      endedAt: room.endedAt,
      standings: room.standings(),
      scoreEvents: [...room.scoreEvents],
    };
  }

  private track(p: Promise<void>) {
    this.pendingSaves.add(p);
    void p.finally(() => this.pendingSaves.delete(p));
  }

  /** Persists scores and standings in one transaction. Score events are idempotent by key. */
  private async saveResults(r: Results) {
    try {
      await this.db.transaction(async (tx) => {
        if (r.scoreEvents.length > 0) {
          await tx
            .insert(scoreEvents)
            .values(
              r.scoreEvents.map((e) => ({
                sessionId: r.id,
                userId: e.userId,
                gameType: r.gameType,
                points: e.points,
                reason: e.reason,
                idempotencyKey: e.idempotencyKey,
                createdAt: e.at,
              })),
            )
            .onConflictDoNothing({ target: scoreEvents.idempotencyKey });
        }
        for (const s of r.standings) {
          await tx
            .update(sessionParticipants)
            .set({ finalScore: s.score, finalRank: s.rank })
            .where(and(eq(sessionParticipants.sessionId, r.id), eq(sessionParticipants.userId, s.userId)));
        }
        await tx
          .update(gameSessions)
          .set({ status: "completed", config: r.config ?? {}, startedAt: r.startedAt, endedAt: r.endedAt })
          .where(eq(gameSessions.id, r.id));
      });
      await this.store.withRoom(r.code, (room) => room.markCompleted());
      this.opts.log?.info(`session ${r.code} completed`);
    } catch (err) {
      this.opts.log?.error(`session ${r.code} failed to save results`, err);
    } finally {
      await this.store.expireAfter(r.code, this.opts.resultsLingerMs ?? 15 * 60_000);
    }
  }

  private async onClosed(room: { id: string; code: string; endedAt: Date | null }, userIds: string[], reason: string) {
    this.transport?.sendClosed(userIds, room.code, reason);
    try {
      await this.db
        .update(gameSessions)
        .set({ status: "cancelled", endedAt: room.endedAt })
        .where(eq(gameSessions.id, room.id));
    } catch (err) {
      this.opts.log?.error(`session ${room.code} failed to save cancellation`, err);
    }
  }
}
