import { describe, expect, it, vi } from "vitest";
import { GameError } from "../src/games/contract.js";
import { Room, type RoomHooks } from "../src/sessions/room.js";
import type { AnyGameEngine } from "../src/games/contract.js";
import { testEngine } from "./helpers.js";

function makeRoom(
  overrides: Partial<{ allowLateJoin: boolean; hostPlays: boolean }> = {},
  engine: AnyGameEngine = testEngine,
) {
  const hooks: RoomHooks = { sendState: vi.fn(), sendEvent: vi.fn(), onResults: vi.fn(), onClosed: vi.fn() };
  const room = new Room(
    {
      id: "s1",
      code: "ABCDEF",
      gameType: "quiz",
      hostId: "host",
      allowLateJoin: overrides.allowLateJoin ?? false,
      hostPlays: overrides.hostPlays ?? true,
      config: {},
      createdAt: new Date(),
    },
    engine,
    hooks,
  );
  return { room, hooks };
}
const u = (id: string) => ({ id, displayName: id, avatar: null });

describe("Room lifecycle", () => {
  it("goes lobby -> ready -> in_progress -> results", () => {
    const { room, hooks } = makeRoom();
    room.join(u("host"), "s-h", 50);
    room.join(u("p1"), "s-1", 50);
    room.markReady("host");
    expect(room.status).toBe("ready");
    room.start("host");
    expect(room.status).toBe("in_progress");
    room.handleAction("p1", { type: "finish" });
    expect(room.status).toBe("results");
    expect(hooks.onResults).toHaveBeenCalledOnce();
  });

  it("only lets the host control the session", () => {
    const { room } = makeRoom();
    room.join(u("host"), "s-h", 50);
    room.join(u("p1"), "s-1", 50);
    expect(() => room.start("p1")).toThrow(GameError);
    expect(() => room.kick("p1", "host")).toThrow(GameError);
  });

  it("never creates duplicate participants for the same account", () => {
    const { room } = makeRoom();
    room.join(u("p1"), "tab-1", 50);
    const second = room.join(u("p1"), "tab-2", 50);
    expect(second.reconnected).toBe(true);
    expect(room.participants.size).toBe(1);
    room.disconnect("p1", "tab-1");
    expect(room.viewFor("p1").participants[0]!.connected).toBe(true);
    room.disconnect("p1", "tab-2");
    expect(room.viewFor("p1").participants[0]!.connected).toBe(false);
  });

  it("blocks late joining by default but lets existing players reconnect", () => {
    const { room } = makeRoom();
    room.join(u("host"), "s-h", 50);
    room.join(u("p1"), "s-1", 50);
    room.start("host");
    expect(() => room.join(u("late"), "s-l", 50)).toThrow("already started");
    room.disconnect("p1", "s-1");
    expect(room.join(u("p1"), "s-1b", 50).reconnected).toBe(true);
  });

  it("allows late joining when configured", () => {
    const { room } = makeRoom({ allowLateJoin: true });
    room.join(u("host"), "s-h", 50);
    room.start("host");
    expect(() => room.join(u("late"), "s-l", 50)).not.toThrow();
  });

  it("awards each scoring action only once, even on retries", () => {
    const { room } = makeRoom();
    room.join(u("host"), "s-h", 50);
    room.start("host");
    room.handleAction("host", { type: "point" });
    room.handleAction("host", { type: "point" });
    expect(room.participants.get("host")!.score).toBe(100);
    room.handleAction("host", { type: "next" });
    room.handleAction("host", { type: "point" });
    expect(room.participants.get("host")!.score).toBe(200);
    expect(room.scoreEvents).toHaveLength(2);
  });

  it("keeps kicked players out", () => {
    const { room } = makeRoom();
    room.join(u("host"), "s-h", 50);
    room.join(u("p1"), "s-1", 50);
    room.kick("host", "p1");
    expect(() => room.join(u("p1"), "s-1", 50)).toThrow("removed");
  });

  it("excludes a non-playing host from players", () => {
    const { room } = makeRoom({ hostPlays: false });
    room.join(u("host"), "s-h", 50);
    room.join(u("p1"), "s-1", 50);
    expect(room.playerIds()).toEqual(["p1"]);
  });

  it("enforces the session cap", () => {
    const { room } = makeRoom();
    room.join(u("a"), "1", 2);
    room.join(u("b"), "2", 2);
    expect(() => room.join(u("c"), "3", 2)).toThrow("full");
  });

  it("cancels when the host leaves the lobby", () => {
    const { room, hooks } = makeRoom();
    room.join(u("host"), "s-h", 50);
    room.leave("host");
    expect(room.status).toBe("cancelled");
    expect(hooks.onClosed).toHaveBeenCalled();
  });

  it("isolates engine crashes to the room", () => {
    const crashing = {
      ...testEngine,
      viewFor: () => {
        throw new Error("boom");
      },
    };
    const { room } = makeRoom({}, crashing);
    room.join(u("host"), "s-h", 50);
    room.start("host");
    expect(() => room.viewFor("host")).not.toThrow();
    expect(room.status).toBe("cancelled");
  });
});
