import type { Room } from "./room.js";

/** Read-only facts about a room, for listings. */
export interface RoomInfo {
  id: string;
  code: string;
  gameType: Room["gameType"];
  status: Room["status"];
  hostId: string;
  hostName: string;
  playerCount: number;
  createdAt: Date;
  lastActivity: number;
  connectedCount: number;
}

export function roomInfo(room: Room): RoomInfo {
  return {
    id: room.id,
    code: room.code,
    gameType: room.gameType,
    status: room.status,
    hostId: room.hostId,
    hostName: room.participants.get(room.hostId)?.displayName ?? "Host",
    playerCount: room.participants.size,
    createdAt: room.createdAt,
    lastActivity: room.lastActivity,
    connectedCount: room.connectedCount(),
  };
}

/**
 * Where live rooms are kept. Every change to a room goes through `withRoom`, which gives the
 * caller exclusive access, so the same code works whether rooms live in this process or in a
 * shared store used by several server instances.
 */
export interface RoomStore {
  /** Run `fn` with exclusive access to the room and save what it changed. Null if there is no such room. */
  withRoom<T>(code: string, fn: (room: Room) => T | Promise<T>): Promise<{ value: T } | null>;
  /** Store a new room. False if the code is already taken. */
  insert(room: Room): Promise<boolean>;
  info(code: string): Promise<RoomInfo | null>;
  list(): Promise<RoomInfo[]>;
  /** Codes of every stored room, for sweeping. */
  codes(): Promise<string[]>;
  /** Keep a finished room readable for a while, then drop it. */
  expireAfter(code: string, ms: number): Promise<void>;
  /** Run `fn` on at most one server instance at a time, skipping if another is already running it. */
  exclusive(name: string, ttlMs: number, fn: () => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

/** Keeps rooms as live objects in this process. Used for local development and tests. */
export class MemoryRoomStore implements RoomStore {
  private rooms = new Map<string, Room>();
  private queues = new Map<string, Promise<unknown>>();
  private expiries = new Map<string, NodeJS.Timeout>();

  async withRoom<T>(code: string, fn: (room: Room) => T | Promise<T>) {
    // Serialize work per room, like the lock in the shared store.
    const prev = this.queues.get(code) ?? Promise.resolve();
    const run = prev.then(async () => {
      const room = this.rooms.get(code);
      if (!room) return null;
      const value = await fn(room);
      if (room.status === "cancelled") this.drop(code);
      return { value };
    });
    const tail = run.catch(() => {});
    this.queues.set(code, tail);
    void tail.then(() => {
      if (this.queues.get(code) === tail) this.queues.delete(code);
    });
    return run;
  }

  async insert(room: Room) {
    if (this.rooms.has(room.code)) return false;
    this.rooms.set(room.code, room);
    return true;
  }

  async info(code: string) {
    const room = this.rooms.get(code);
    return room ? roomInfo(room) : null;
  }

  async list() {
    return [...this.rooms.values()].map(roomInfo);
  }

  async codes() {
    return [...this.rooms.keys()];
  }

  async expireAfter(code: string, ms: number) {
    clearTimeout(this.expiries.get(code));
    const t = setTimeout(() => this.drop(code), ms);
    t.unref();
    this.expiries.set(code, t);
  }

  async exclusive(_name: string, _ttlMs: number, fn: () => Promise<void>) {
    await fn();
  }

  async close() {
    for (const t of this.expiries.values()) clearTimeout(t);
    for (const room of this.rooms.values()) room.dispose();
  }

  private drop(code: string) {
    this.rooms.get(code)?.dispose();
    this.rooms.delete(code);
    clearTimeout(this.expiries.get(code));
    this.expiries.delete(code);
  }
}
