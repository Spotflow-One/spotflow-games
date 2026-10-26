import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLASH_FLAG, CLASH_RULES, type ClashSnapshot, type ClashView } from "@spotflow-games/shared";
import { GameError } from "../src/games/contract.js";
import { createClashEngine } from "../src/games/clash/engine.js";
import { decode, encode } from "../src/sessions/codec.js";
import { Room, type RoomHooks, type RoomSnapshot } from "../src/sessions/room.js";

const engine = createClashEngine();
const u = (id: string) => ({ id, displayName: id, avatar: null });
const PLAYERS = ["host", "ada", "ben", "cy"];

/** The engine's internal state, for arranging fights. Tests only. */
interface Fighter {
  userId: string;
  n: number;
  team: number;
  x: number;
  y: number;
  hp: number;
  alive: boolean;
  life: number;
  shieldUntil: number;
  points: number;
  eliminations: number;
}
interface State {
  fighters: Map<string, Fighter>;
  npcs: Array<{ kind: number; x: number; y: number; hp: number; maxHp: number }>;
  power: number[];
  nextDroneAt: number;
  titanAt: number;
  config: { teams: number; target: number };
}

function makeRoom(config: object = {}, players = PLAYERS, allowLateJoin = false) {
  const hooks: RoomHooks = { sendStates: vi.fn(), sendEvent: vi.fn(), onResults: vi.fn(), onClosed: vi.fn() };
  const room = new Room(
    {
      id: "s1",
      code: "CLASH1",
      gameType: "clash",
      hostId: "host",
      allowLateJoin,
      hostPlays: true,
      config,
      createdAt: new Date(),
    },
    engine,
    hooks,
  );
  for (const id of players) room.join(u(id), id, 50);
  return { room, hooks };
}
const state = (room: Room) => room.toSnapshot().gameState as State;
const view = (room: Room, id: string) => room.viewFor(id).game as ClashView;
const score = (room: Room, id: string) => room.viewFor(id).participants.find((p) => p.userId === id)!.score;
const lastSnap = (hooks: RoomHooks) => {
  const calls = (hooks.sendEvent as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1]![1] as ClashSnapshot;
};
const input = (room: Room, id: string, v: Partial<{ x: number; y: number; a: number; f: boolean; s: number }>) => {
  const f = state(room).fighters.get(id)!;
  room.inputs.set(id, { value: { x: f.x, y: f.y, a: 0, f: false, s: 0, l: f.life, ...v }, at: Date.now() });
};
/** Two players on different teams, facing each other along the open top lane. */
function duel(room: Room) {
  const st = state(room);
  st.nextDroneAt = 1e15;
  st.titanAt = 0;
  const [a, b] = [...st.fighters.values()].sort((x, y) => x.team - y.team) as [Fighter, Fighter];
  const enemy = [...st.fighters.values()].find((f) => f.team !== a.team)!;
  Object.assign(a, { x: 200, y: 60, shieldUntil: 0 });
  Object.assign(enemy, { x: 400, y: 60, shieldUntil: 0 });
  // Everyone else stays well out of the way.
  for (const f of st.fighters.values()) if (f !== a && f !== enemy) Object.assign(f, { x: 1500, y: 850 });
  return { a, b: enemy, mate: [...st.fighters.values()].find((f) => f !== a && f.team === a.team) ?? b };
}
/** Advance the clock, keeping `a` holding the trigger. */
function holdFire(room: Room, a: Fighter, ms: number) {
  for (let t = 0; t < ms; t += CLASH_RULES.tickMs) {
    input(room, a.userId, { f: true, a: 0 });
    vi.advanceTimersByTime(CLASH_RULES.tickMs);
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Core Clash", () => {
  it("deals players into balanced teams, never more teams than players", async () => {
    const { room } = makeRoom({ teams: 2 });
    await room.start("host");
    const v = view(room, "ada");
    expect(v.teamCount).toBe(2);
    const sizes = [0, 1].map((t) => v.players.filter((p) => p.team === t).length);
    expect(sizes).toEqual([2, 2]);
    expect(v.me?.team).toBe(v.players.find((p) => p.userId === "ada")!.team);

    const small = makeRoom({ teams: 4 }, ["host", "ada", "ben"]);
    await small.room.start("host");
    expect(view(small.room, "host").teamCount).toBe(3);
    expect(() => small.room.handleAction("ada", { type: "shoot" })).toThrow(GameError);
  });

  it("rejects bad settings", async () => {
    const { room } = makeRoom({ teams: 9 });
    await expect(room.start("host")).rejects.toThrow("Those game settings aren't valid");
  });

  it("moves players no faster than top speed and never into walls", async () => {
    const { room } = makeRoom();
    await room.start("host");
    const ada = state(room).fighters.get("ada")!;
    Object.assign(ada, { x: 300, y: 280 });
    vi.advanceTimersByTime(CLASH_RULES.tickMs);
    // Asks to teleport across the map: only a short step is allowed.
    input(room, "ada", { x: 1400, y: 280 });
    vi.advanceTimersByTime(CLASH_RULES.tickMs);
    expect(ada.x).toBeGreaterThan(300);
    expect(ada.x).toBeLessThan(300 + CLASH_RULES.playerSpeed * 0.1 * 1.6 + 10);
    // Walking into the wall at x 380 stops at its edge.
    for (let i = 0; i < 10; i++) {
      input(room, "ada", { x: ada.x + 20, y: 280 });
      vi.advanceTimersByTime(CLASH_RULES.tickMs);
    }
    expect(ada.x).toBeLessThanOrEqual(380 - CLASH_RULES.playerRadius + 0.01);

    // Malformed or stale input is ignored.
    const before = { x: ada.x, y: ada.y };
    room.inputs.set("ada", { value: { x: "far", y: 1 }, at: Date.now() });
    vi.advanceTimersByTime(CLASH_RULES.tickMs);
    room.inputs.set("ada", { value: { x: 100, y: 280, a: 0, f: true, s: 0, l: ada.life }, at: Date.now() - 5000 });
    vi.advanceTimersByTime(CLASH_RULES.tickMs);
    expect({ x: ada.x, y: ada.y }).toEqual(before);
  });

  it("eliminates enemies for Power and points, but never hurts teammates or shielded players", async () => {
    const { room, hooks } = makeRoom();
    await room.start("host");
    const { a, b, mate } = duel(room);

    // A spawn shield soaks up shots.
    b.shieldUntil = Date.now() + 10_000;
    holdFire(room, a, 600);
    expect(b.hp).toBe(CLASH_RULES.playerHp);
    b.shieldUntil = 0;

    // A teammate in the line of fire takes nothing.
    Object.assign(mate, { x: 300, y: 60 });
    holdFire(room, a, 600);
    expect(mate.hp).toBe(CLASH_RULES.playerHp);
    Object.assign(mate, { x: 1500, y: 850 });

    holdFire(room, a, 3000);
    expect(b.alive).toBe(false);
    expect(a.eliminations).toBe(1);
    expect(a.points).toBe(CLASH_RULES.eliminationPoints);
    expect(state(room).power[a.team]).toBe(CLASH_RULES.eliminationPower);
    const snaps = (hooks.sendEvent as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as ClashSnapshot);
    expect(snaps.some((s) => s.feed.some(([by, what, victim]) => by === a.n && what === 0 && victim === b.n))).toBe(
      true,
    );

    // The knocked-out player comes back at their base with full health and a new life.
    const life = b.life;
    for (let t = 0; t <= CLASH_RULES.respawnMs && !b.alive; t += CLASH_RULES.tickMs)
      vi.advanceTimersByTime(CLASH_RULES.tickMs);
    expect(b.alive).toBe(true);
    expect(b.hp).toBe(CLASH_RULES.playerHp);
    expect(b.life).toBe(life + 1);
    const me = lastSnap(hooks).players.find((p) => p[0] === b.n)!;
    expect(me[5] & CLASH_FLAG.alive).toBeTruthy();
    expect(me[5] & CLASH_FLAG.shield).toBeTruthy();
  });

  it("ends when a team reaches the target and awards points and the win bonus once", async () => {
    const { room, hooks } = makeRoom({ target: 20 });
    await room.start("host");
    const { a, b, mate } = duel(room);
    state(room).power[a.team] = 19;
    holdFire(room, a, 3000);
    expect(room.status).toBe("results");
    expect(hooks.onResults).toHaveBeenCalledTimes(1);
    const v = view(room, a.userId);
    expect(v.outcome).toEqual({ winner: a.team, reason: "target" });
    expect(score(room, a.userId)).toBe(CLASH_RULES.eliminationPoints + CLASH_RULES.winBonus);
    expect(score(room, mate.userId)).toBe(CLASH_RULES.winBonus);
    expect(score(room, b.userId)).toBe(0);
    // Ending again changes nothing.
    room.finish();
    expect(score(room, a.userId)).toBe(CLASH_RULES.eliminationPoints + CLASH_RULES.winBonus);
    expect(room.timers).toEqual({});
  });

  it("scores what was earned when the host ends early, and calls a tie a draw", async () => {
    const { room } = makeRoom();
    await room.start("host");
    const st = state(room);
    const ada = st.fighters.get("ada")!;
    ada.points = 120;
    st.power = st.power.map(() => 10);
    room.end("host");
    expect(view(room, "ada").outcome).toEqual({ winner: null, reason: "ended" });
    expect(score(room, "ada")).toBe(120);
  });

  it("ends on time and gives the win to the team with the most Power", async () => {
    const { room } = makeRoom({ minutes: 2 });
    await room.start("host");
    const st = state(room);
    st.nextDroneAt = 1e15;
    st.titanAt = 0;
    st.power[1] = 7;
    vi.advanceTimersByTime(2 * 60_000 + 100);
    expect(room.status).toBe("results");
    expect(view(room, "host").outcome).toEqual({ winner: 1, reason: "time" });
  });

  it("gives the Titan's Power to the team that did the most damage", async () => {
    const { room } = makeRoom();
    await room.start("host");
    const st = state(room);
    st.nextDroneAt = 1e15;
    for (const f of st.fighters.values()) Object.assign(f, { x: 1500, y: 60 + f.n * 50, shieldUntil: 1e15 });
    vi.advanceTimersByTime(CLASH_RULES.titan.firstSpawnMs + 200);
    const titan = st.npcs.find((n) => n.kind === 1)!;
    expect(titan).toBeDefined();
    expect(titan.maxHp).toBe(CLASH_RULES.titan.baseHp + CLASH_RULES.titan.hpPerPlayer * PLAYERS.length);

    // Team 0 chips at it; team 1 lands the final blow but did less damage overall.
    const t0 = [...st.fighters.values()].find((f) => f.team === 0)!;
    const t1 = [...st.fighters.values()].find((f) => f.team === 1)!;
    titan.hp = 40;
    Object.assign(titan, { x: 800, y: 450 });
    // Pretend team 0 already did most of the work.
    (titan as unknown as { damageBy: Record<string, number> }).damageBy[t0.userId] = titan.maxHp - 60;
    Object.assign(t1, { x: 700, y: 450, shieldUntil: 1e15 });
    holdFire(room, t1, 1500);
    expect(st.npcs.some((n) => n.kind === 1)).toBe(false);
    expect(st.power[0]).toBe(CLASH_RULES.titan.power);
    expect(st.power[1]).toBe(0);
    expect(t0.points).toBeGreaterThan(t1.points);
    expect(st.titanAt).toBeGreaterThan(Date.now());
  });

  it("puts late joiners on the smallest team", async () => {
    const { room } = makeRoom({}, ["host", "ada", "ben"], true);
    await room.start("host");
    room.join(u("dee"), "dee", 50);
    vi.advanceTimersByTime(CLASH_RULES.tickMs);
    const v = view(room, "dee");
    expect(v.me).not.toBeNull();
    expect(v.players.filter((p) => p.team === v.me!.team)).toHaveLength(2);
  });

  it("carries on from a snapshot that went through JSON", async () => {
    const { room, hooks } = makeRoom();
    await room.start("host");
    vi.advanceTimersByTime(3000);
    const snap = decode<RoomSnapshot>(encode(room.toSnapshot()));
    room.dispose();
    const copy = Room.fromSnapshot(snap, engine, hooks);
    const before = (hooks.sendEvent as ReturnType<typeof vi.fn>).mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect((hooks.sendEvent as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before);
    expect(state(copy).fighters.size).toBe(PLAYERS.length);
    expect(lastSnap(hooks).npcs.length).toBeGreaterThan(0);
    copy.dispose();
  });
});
