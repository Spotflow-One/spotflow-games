import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { GameError } from "../games/contract.js";
import { decode, encode } from "./codec.js";
import type { RoomBuilder, Transport } from "./manager.js";
import type { Room, RoomLog, RoomSnapshot } from "./room.js";
import { roomInfo, type RoomInfo, type RoomStore } from "./store.js";

const key = {
  room: (code: string) => `sg:room:${code}`,
  log: (code: string) => `sg:log:${code}`,
  /** Hash of each player's latest held controls (see GameContext.inputs). */
  input: (code: string) => `sg:input:${code}`,
  lock: (code: string) => `sg:lock:${code}`,
  job: (name: string) => `sg:job:${name}`,
  rooms: "sg:rooms",
  /** Sorted set of room codes by when their next game timer is due. */
  timers: "sg:timers",
};

/** Deletes the lock only if we still hold it. */
const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
/** Sets one player's input and keeps the hash from outliving its room, in one command. */
const SET_INPUT = `redis.call("hset", KEYS[1], ARGV[1], ARGV[2]) return redis.call("pexpire", KEYS[1], ARGV[3])`;
/** Inputs are short-lived: a game reads them every tick, and stale ones are ignored anyway. */
const INPUT_TTL_MS = 60_000;

export interface RedisStoreOptions {
  /** How long a live room is kept without changes. */
  roomTtlMs?: number;
  /** How long a finished room is kept so players can see results. */
  resultsTtlMs?: number;
  /** How long one change may hold a room before the lock expires. */
  lockMs?: number;
  /** How long to wait for a busy room. */
  lockWaitMs?: number;
  /** How often to look for timers whose instance went away before firing them. */
  pollMs?: number;
  log?: Pick<Console, "error">;
}

/** Collects log changes during one change to a room, applied when the room is saved. */
class BufferedLog implements RoomLog {
  ops: Array<{ append: unknown } | { clear: true }> = [];
  sends: Array<{ userId: string; wrap: (entries: unknown[]) => unknown }> = [];
  append(entry: unknown) {
    this.ops.push({ append: entry });
  }
  clear() {
    this.ops.push({ clear: true });
  }
  sendTo(userId: string, wrap: (entries: unknown[]) => unknown) {
    this.sends.push({ userId, wrap });
  }
}

/**
 * Keeps rooms in Redis so any server instance can serve any player. Each change takes a short
 * lock on the room, loads it, runs, and saves it. Game timers are stored as due times: the
 * instance that set a timer fires it, and every instance polls for any it missed.
 */
export class RedisRoomStore implements RoomStore {
  private wakeups = new Map<string, NodeJS.Timeout>();
  private poller: NodeJS.Timeout;
  private readonly o: Required<Omit<RedisStoreOptions, "log">>;

  constructor(
    private redis: Redis,
    private builder: RoomBuilder,
    private transport: () => Transport | null,
    private opts: RedisStoreOptions = {},
  ) {
    this.o = {
      roomTtlMs: opts.roomTtlMs ?? 24 * 60 * 60_000,
      resultsTtlMs: opts.resultsTtlMs ?? 15 * 60_000,
      lockMs: opts.lockMs ?? 10_000,
      lockWaitMs: opts.lockWaitMs ?? 8_000,
      pollMs: opts.pollMs ?? 2_000,
    };
    this.poller = setInterval(() => void this.fireOverdue(), this.o.pollMs);
    this.poller.unref();
  }

  async withRoom<T>(code: string, fn: (room: Room) => T | Promise<T>) {
    const token = await this.lock(code);
    let room: Room | null = null;
    try {
      const raw = await this.redis.get(key.room(code));
      if (!raw) return null;
      const log = new BufferedLog();
      room = this.builder.load(decode<RoomSnapshot>(raw), log);
      if (room.acceptsInput && room.status === "in_progress") await this.loadInputs(room);
      const value = await fn(room);
      await this.save(room, log);
      return { value };
    } finally {
      room?.dispose();
      await this.redis.eval(RELEASE, 1, key.lock(code), token).catch(() => {});
    }
  }

  async insert(room: Room) {
    const ok = await this.redis.set(key.room(room.code), encode(room.toSnapshot()), "PX", this.o.roomTtlMs, "NX");
    if (ok !== "OK") return false;
    await this.redis.sadd(key.rooms, room.code);
    return true;
  }

  async setInput(code: string, userId: string, input: { value: unknown; at: number }) {
    await this.redis.eval(SET_INPUT, 1, key.input(code), userId, JSON.stringify(input), INPUT_TTL_MS);
  }

  private async loadInputs(room: Room) {
    const all = await this.redis.hgetall(key.input(room.code));
    for (const [userId, raw] of Object.entries(all)) {
      if (!room.participants.has(userId)) continue;
      try {
        room.inputs.set(userId, JSON.parse(raw) as { value: unknown; at: number });
      } catch {
        /* ignore a malformed entry */
      }
    }
  }

  async info(code: string) {
    const raw = await this.redis.get(key.room(code));
    return raw ? this.toInfo(raw) : null;
  }

  async list() {
    const codes = await this.redis.smembers(key.rooms);
    if (codes.length === 0) return [];
    const raws = await this.redis.mget(codes.map(key.room));
    const gone = codes.filter((_, i) => !raws[i]);
    if (gone.length) await this.redis.srem(key.rooms, ...gone);
    return raws.filter((r): r is string => !!r).map((r) => this.toInfo(r));
  }

  async codes() {
    return (await this.list()).map((r) => r.code);
  }

  async expireAfter(code: string, ms: number) {
    await this.redis
      .multi()
      .pexpire(key.room(code), ms)
      .pexpire(key.log(code), ms)
      .del(key.input(code))
      .zrem(key.timers, code)
      .exec();
  }

  async exclusive(name: string, ttlMs: number, fn: () => Promise<void>) {
    // Not released afterwards, so the job runs at most once per ttl across all instances.
    if ((await this.redis.set(key.job(name), "1", "PX", ttlMs, "NX")) === "OK") await fn();
  }

  async close() {
    clearInterval(this.poller);
    for (const t of this.wakeups.values()) clearTimeout(t);
    this.wakeups.clear();
  }

  private toInfo(raw: string): RoomInfo {
    const room = this.builder.load(decode<RoomSnapshot>(raw));
    room.dispose();
    return roomInfo(room);
  }

  private async lock(code: string) {
    const token = randomUUID();
    const deadline = Date.now() + this.o.lockWaitMs;
    for (;;) {
      if ((await this.redis.set(key.lock(code), token, "PX", this.o.lockMs, "NX")) === "OK") return token;
      if (Date.now() > deadline) throw new GameError("The game is busy right now. Try again.");
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 20));
    }
  }

  private async save(room: Room, log: BufferedLog) {
    const code = room.code;
    const tx = this.redis.multi();
    if (room.status === "cancelled") {
      tx.del(key.room(code), key.log(code), key.input(code)).srem(key.rooms, code).zrem(key.timers, code);
    } else {
      const ended = room.status === "results" || room.status === "completed";
      const ttl = ended ? this.o.resultsTtlMs : this.o.roomTtlMs;
      tx.set(key.room(code), encode(room.toSnapshot()), "PX", ttl);
      for (const op of log.ops) {
        if ("clear" in op) tx.del(key.log(code));
        else tx.rpush(key.log(code), JSON.stringify(op.append));
      }
      tx.pexpire(key.log(code), ttl);
      const due = room.nextDeadline();
      if (due === null) tx.zrem(key.timers, code);
      else tx.zadd(key.timers, due, code);
      this.wakeAt(code, due);
    }
    await tx.exec();
    for (const send of log.sends) {
      const entries = (await this.redis.lrange(key.log(code), 0, -1)).map((e) => JSON.parse(e) as unknown);
      this.transport()?.sendEvent([send.userId], code, send.wrap(entries));
    }
  }

  /** The instance that set a timer fires it when due. */
  private wakeAt(code: string, due: number | null) {
    clearTimeout(this.wakeups.get(code));
    this.wakeups.delete(code);
    if (due === null) return;
    const t = setTimeout(
      () => {
        this.wakeups.delete(code);
        void this.fire(code);
      },
      Math.max(0, due - Date.now()),
    );
    t.unref();
    this.wakeups.set(code, t);
  }

  private async fire(code: string) {
    try {
      await this.withRoom(code, (room) => room.fireDueTimers());
    } catch (err) {
      this.opts.log?.error(`timers for ${code} failed`, err);
    }
  }

  /** Picks up timers whose instance stopped before firing them. */
  private async fireOverdue() {
    try {
      const codes = await this.redis.zrangebyscore(key.timers, 0, Date.now() - 1000, "LIMIT", 0, 50);
      await Promise.all(codes.map((code) => this.fire(code)));
    } catch (err) {
      this.opts.log?.error("timer poll failed", err);
    }
  }
}

/**
 * Delivers messages through Redis pub/sub, so a change made on one server instance reaches
 * players connected to any instance. Each instance delivers to its own sockets.
 */
export function redisBus(pub: Redis, sub: Redis, local: Transport, log?: Pick<Console, "error">): Transport {
  const channel = "sg:bus";
  type Message =
    | { t: "states"; code: string; views: Parameters<Transport["sendStates"]>[1] }
    | { t: "event"; ids: string[]; code: string; event: unknown }
    | { t: "closed"; ids: string[]; code: string; reason: string };

  // Subscribing before the connection is ready races ioredis's ready check (it sends INFO on a
  // connection already in subscriber mode), which leaves nothing subscribed. Wait for ready.
  const subscribe = () => void sub.subscribe(channel).catch((err) => log?.error("subscribe failed", err));
  if (sub.status === "ready") subscribe();
  else sub.once("ready", subscribe);
  sub.on("message", (ch: string, raw: string) => {
    if (ch !== channel) return;
    try {
      const m = JSON.parse(raw) as Message;
      if (m.t === "states") local.sendStates(m.code, m.views);
      else if (m.t === "event") local.sendEvent(m.ids, m.code, m.event);
      else local.sendClosed(m.ids, m.code, m.reason);
    } catch (err) {
      log?.error("bad bus message", err);
    }
  });
  const publish = (m: Message) =>
    void pub.publish(channel, JSON.stringify(m)).catch((err) => log?.error("publish failed", err));
  return {
    sendStates: (code, views) => publish({ t: "states", code, views }),
    sendEvent: (ids, code, event) => publish({ t: "event", ids, code, event }),
    sendClosed: (ids, code, reason) => publish({ t: "closed", ids, code, reason }),
  };
}
