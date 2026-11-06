import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLASH_FLAG,
  CLASH_CENTER,
  CLASH_DRONE_SPAWNS,
  CLASH_PICKUPS,
  CLASH_RULES,
  CLASH_SCENERIES,
  clashBases,
  clashWalls,
  resolveCircle,
  CLASH_WEAPONS,
  clashWeaponOf,
  pointInWall,
  type ClashSnapshot,
  type ClashView,
} from "@spotflow-games/shared";
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
  dodgeUntil?: number;
  overdriveUntil?: number;
  hasteUntil?: number;
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
const input = (
  room: Room,
  id: string,
  v: Partial<{ x: number; y: number; a: number; f: boolean; s: number; d: number; c: boolean; w: number; g: number }>,
) => {
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
  it("deals players into two balanced teams", async () => {
    const { room } = makeRoom();
    await room.start("host");
    const v = view(room, "ada");
    expect(v.teamCount).toBe(2);
    const sizes = [0, 1].map((t) => v.players.filter((p) => p.team === t).length);
    expect(sizes).toEqual([2, 2]);
    expect(v.me?.team).toBe(v.players.find((p) => p.userId === "ada")!.team);

    expect(v.bots).toBe(false);
    expect(() => room.handleAction("ada", { type: "shoot" })).toThrow(GameError);
  });

  it("rejects bad settings", async () => {
    const { room } = makeRoom({ teams: 3 });
    await expect(room.start("host")).rejects.toThrow("Those game settings aren't valid");
  });

  it("moves players no faster than top speed and never into walls", async () => {
    const { room } = makeRoom();
    await room.start("host");
    const ada = state(room).fighters.get("ada")!;
    Object.assign(ada, { x: 400, y: 280 });
    vi.advanceTimersByTime(CLASH_RULES.tickMs);
    // Asks to teleport across the map: only a short step is allowed.
    input(room, "ada", { x: 1400, y: 280 });
    vi.advanceTimersByTime(CLASH_RULES.tickMs);
    expect(ada.x).toBeGreaterThan(400);
    expect(ada.x).toBeLessThan(400 + CLASH_RULES.playerSpeed * 0.1 * 1.6 + 10);
    // Walking into the building at x 480 stops at its edge.
    for (let i = 0; i < 10; i++) {
      input(room, "ada", { x: ada.x + 20, y: 280 });
      vi.advanceTimersByTime(CLASH_RULES.tickMs);
    }
    expect(ada.x).toBeLessThanOrEqual(480 - CLASH_RULES.playerRadius + 0.01);

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

  it("lets a rolling player dodge shots and dash, once per recharge", async () => {
    const { room, hooks } = makeRoom();
    await room.start("host");
    const { a, b } = duel(room);
    input(room, b.userId, { d: 0 });
    vi.advanceTimersByTime(CLASH_RULES.tickMs);

    // b rolls just as a shot comes in: it flies straight past.
    input(room, b.userId, { d: 1 });
    input(room, a.userId, { f: true, a: 0 });
    vi.advanceTimersByTime(CLASH_RULES.tickMs);
    expect(lastSnap(hooks).players.find((p) => p[0] === b.n)![5] & CLASH_FLAG.dodge).toBeTruthy();
    input(room, a.userId, { f: false, a: 0 });
    input(room, b.userId, { d: 1, x: b.x + 150 });
    vi.advanceTimersByTime(CLASH_RULES.tickMs);
    // The roll covers ground much faster than running.
    expect(b.x).toBeGreaterThan(400 + CLASH_RULES.playerSpeed * 0.1 * 1.6 + 6);
    vi.advanceTimersByTime(800);
    expect(b.hp).toBe(CLASH_RULES.playerHp);

    // Rolling again straight away does nothing until the dodge recharges.
    input(room, b.userId, { d: 2 });
    vi.advanceTimersByTime(CLASH_RULES.tickMs);
    expect(b.dodgeUntil! < Date.now()).toBe(true);
    vi.advanceTimersByTime(CLASH_RULES.dodge.cooldownMs);
    input(room, b.userId, { d: 3 });
    vi.advanceTimersByTime(CLASH_RULES.tickMs);
    expect(b.dodgeUntil! > Date.now()).toBe(true);

    // Without a roll, the same shot lands.
    vi.advanceTimersByTime(CLASH_RULES.dodge.ms);
    input(room, a.userId, { f: true, a: Math.atan2(b.y - a.y, b.x - a.x) });
    vi.advanceTimersByTime(CLASH_RULES.tickMs);
    input(room, a.userId, { f: false, a: 0 });
    vi.advanceTimersByTime(600);
    expect(b.hp).toBe(CLASH_RULES.playerHp - CLASH_RULES.shotDamage);
  });

  it("hands out power-ups to whoever reaches them, and brings them back later", async () => {
    const { room, hooks } = makeRoom();
    await room.start("host");
    const { a, b } = duel(room);
    const P = CLASH_RULES.pickup;
    for (const spot of CLASH_PICKUPS) {
      expect(pointInWall(spot.x, spot.y)).toBe(false);
      expect(spot.x === 1200 || CLASH_PICKUPS.some((o) => o.x === 2400 - spot.x && o.y === spot.y)).toBe(true);
    }
    const spot = (kind: string) => CLASH_PICKUPS.findIndex((p) => p.kind === kind);
    vi.advanceTimersByTime(CLASH_RULES.tickMs);
    expect(lastSnap(hooks).items).toEqual(CLASH_PICKUPS.map(() => 0));

    // A medkit is left alone at full health, and heals when hurt.
    const med = CLASH_PICKUPS[spot("medkit")]!;
    Object.assign(a, { x: med.x, y: med.y });
    input(room, a.userId, {});
    vi.advanceTimersByTime(CLASH_RULES.tickMs);
    expect(lastSnap(hooks).items![spot("medkit")]).toBe(0);
    a.hp = 30;
    input(room, a.userId, {});
    vi.advanceTimersByTime(CLASH_RULES.tickMs);
    // Plus a moment of out-of-combat regen.
    expect(Math.floor(a.hp)).toBe(30 + P.medkitHeal);
    expect(lastSnap(hooks).grabs).toEqual([[a.n, spot("medkit")]]);
    expect(lastSnap(hooks).items![spot("medkit")]).toBeGreaterThan(0);

    // Overdrive makes shots hit harder.
    const od = CLASH_PICKUPS[spot("overdrive")]!;
    Object.assign(a, { x: od.x, y: od.y, hp: CLASH_RULES.playerHp });
    input(room, a.userId, {});
    vi.advanceTimersByTime(CLASH_RULES.tickMs);
    expect(lastSnap(hooks).players.find((p) => p[0] === a.n)![5] & CLASH_FLAG.overdrive).toBeTruthy();
    Object.assign(b, { x: od.x + 200, y: od.y, shieldUntil: 0 });
    input(room, a.userId, { f: true, a: 0 });
    vi.advanceTimersByTime(CLASH_RULES.tickMs);
    input(room, a.userId, { f: false, a: 0 });
    vi.advanceTimersByTime(400);
    expect(b.hp).toBe(CLASH_RULES.playerHp - CLASH_RULES.shotDamage * P.overdrive.damageMult);
    // It's gone for a while, then comes back.
    expect(lastSnap(hooks).items![spot("overdrive")]).toBeGreaterThan(0);
    Object.assign(a, { x: 1500, y: 850 });
    room.inputs.delete(a.userId);
    vi.advanceTimersByTime(P.respawnMs.overdrive);
    expect(lastSnap(hooks).items![spot("overdrive")]).toBe(0);
    expect(a.overdriveUntil! < Date.now()).toBe(true);

    // Haste lets you move faster than normal top speed.
    const hs = CLASH_PICKUPS[spot("haste")]!;
    Object.assign(a, { x: hs.x, y: hs.y });
    input(room, a.userId, {});
    vi.advanceTimersByTime(CLASH_RULES.tickMs);
    expect(a.hasteUntil! > Date.now()).toBe(true);
    const x0 = a.x;
    input(room, a.userId, { x: a.x + 200, y: a.y });
    vi.advanceTimersByTime(CLASH_RULES.tickMs);
    expect(a.x - x0).toBeGreaterThan(CLASH_RULES.playerSpeed * 0.1 * 1.6 + 6);
    expect(view(room, a.userId).players.find((p) => p.n === a.n)!.pickups).toBe(3);
  });

  it("makes a crouching player a smaller target, and shows it", async () => {
    const { room, hooks } = makeRoom();
    await room.start("host");
    const { a, b } = duel(room);
    // A shot that would just graze a standing player...
    Object.assign(b, { y: 60 + CLASH_RULES.crouch.hitRadius + CLASH_RULES.shotRadius + 1 });
    for (let t = 0; t < 1200; t += CLASH_RULES.tickMs) {
      input(room, b.userId, { c: true });
      input(room, a.userId, { f: true, a: 0 });
      vi.advanceTimersByTime(CLASH_RULES.tickMs);
    }
    // ...flies over one who is crouching.
    expect(b.hp).toBe(CLASH_RULES.playerHp);
    expect(lastSnap(hooks).players.find((p) => p[0] === b.n)![5] & CLASH_FLAG.crouch).toBeTruthy();

    // Standing up again, the same shots hit.
    for (let t = 0; t < 600; t += CLASH_RULES.tickMs) {
      input(room, b.userId, { c: false });
      input(room, a.userId, { f: true, a: 0 });
      vi.advanceTimersByTime(CLASH_RULES.tickMs);
    }
    expect(b.hp).toBeLessThan(CLASH_RULES.playerHp);
    expect(lastSnap(hooks).players.find((p) => p[0] === b.n)![5] & CLASH_FLAG.crouch).toBeFalsy();
  });

  it("fires the chosen weapon, switching at base or on the next life", async () => {
    const { room, hooks } = makeRoom();
    await room.start("host");
    const { a, b } = duel(room);
    const [, shotgun, sniper] = CLASH_WEAPONS;
    const myFlags = () => lastSnap(hooks).players.find((p) => p[0] === a.n)![5];

    // Away from base, a new weapon waits for the next life.
    input(room, a.userId, { w: 1 });
    vi.advanceTimersByTime(CLASH_RULES.tickMs);
    expect(clashWeaponOf(myFlags()).id).toBe("rifle");

    // At base it's yours at once. A shotgun fires a fan of pellets.
    const base = a.team === 0 ? { x: 140, y: 700 } : { x: 2260, y: 700 };
    Object.assign(a, base);
    Object.assign(b, { x: base.x + (a.team === 0 ? 150 : -150), y: 700, shieldUntil: 0 });
    const toward = Math.atan2(b.y - a.y, b.x - a.x);
    input(room, a.userId, { w: 1, a: toward });
    input(room, b.userId, {});
    vi.advanceTimersByTime(CLASH_RULES.tickMs);
    expect(clashWeaponOf(myFlags()).id).toBe("shotgun");
    input(room, a.userId, { w: 1, a: toward, f: true });
    vi.advanceTimersByTime(CLASH_RULES.tickMs);
    expect(lastSnap(hooks).shots.filter((s) => s[7] === a.n)).toHaveLength(shotgun!.pellets);
    input(room, a.userId, { w: 1, a: toward, f: false });
    vi.advanceTimersByTime(500);
    // Close up, at least the middle pellets land.
    expect(b.hp).toBeLessThanOrEqual(CLASH_RULES.playerHp - shotgun!.damage * 3);

    // A sniper shot hits hard, and fast shots never skip past anyone.
    b.hp = CLASH_RULES.playerHp;
    input(room, a.userId, { w: 2, a: toward });
    vi.advanceTimersByTime(sniper!.cooldownMs);
    input(room, a.userId, { w: 2, a: toward, f: true });
    vi.advanceTimersByTime(CLASH_RULES.tickMs);
    input(room, a.userId, { w: 2, a: toward, f: false });
    vi.advanceTimersByTime(400);
    expect(b.hp).toBe(CLASH_RULES.playerHp - sniper!.damage);
  });

  it("throws grenades that hurt enemies in the open, but not teammates or anyone behind cover", async () => {
    const { room, hooks } = makeRoom();
    await room.start("host");
    const { a, b, mate } = duel(room);
    const G = CLASH_RULES.grenade;
    Object.assign(a, { x: 200, y: 560 });
    input(room, a.userId, { g: 0 });
    vi.advanceTimersByTime(CLASH_RULES.tickMs);
    // b stands where the grenade lands; a teammate is right beside it too.
    Object.assign(b, { x: a.x + G.throwRange, y: a.y, shieldUntil: 0 });
    Object.assign(mate, { x: a.x + G.throwRange, y: a.y + 30, shieldUntil: 0 });
    input(room, a.userId, { g: 1, a: 0 });
    input(room, b.userId, {});
    vi.advanceTimersByTime(CLASH_RULES.tickMs);
    const thrown = lastSnap(hooks).grenades!;
    expect(thrown).toHaveLength(1);
    expect(thrown[0]![3]).toBeCloseTo(a.x + G.throwRange, -1);
    vi.advanceTimersByTime(G.fuseMs + 200);
    expect(b.hp).toBeLessThan(CLASH_RULES.playerHp - G.minDamage);
    expect(mate.hp).toBe(CLASH_RULES.playerHp);

    // Another throw straight away does nothing until the grenade recharges.
    input(room, a.userId, { g: 2, a: 0 });
    vi.advanceTimersByTime(CLASH_RULES.tickMs);
    expect(lastSnap(hooks).grenades).toEqual([]);

    // A grenade thrown at cover stops against it, and the blast doesn't reach round the corner.
    vi.advanceTimersByTime(G.cooldownMs);
    Object.assign(a, { x: 400, y: 280 });
    Object.assign(b, { x: 760, y: 280, hp: CLASH_RULES.playerHp, shieldUntil: 0 });
    input(room, a.userId, { g: 3, a: 0 });
    input(room, b.userId, {});
    vi.advanceTimersByTime(CLASH_RULES.tickMs);
    expect(lastSnap(hooks).grenades![0]![3]).toBeLessThan(480);
    vi.advanceTimersByTime(G.fuseMs + 200);
    expect(b.hp).toBe(CLASH_RULES.playerHp);
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
    const { room } = makeRoom({ bots: true });
    await room.start("host");
    const st = state(room);
    st.nextDroneAt = 1e15;
    for (const f of st.fighters.values()) Object.assign(f, { x: 1700, y: 440 + f.n * 15, shieldUntil: 1e15 });
    vi.advanceTimersByTime(CLASH_RULES.titan.firstSpawnMs + 200);
    const titan = st.npcs.find((n) => n.kind === 1)!;
    expect(titan).toBeDefined();
    expect(titan.maxHp).toBe(CLASH_RULES.titan.baseHp + CLASH_RULES.titan.hpPerPlayer * PLAYERS.length);

    // Team 0 chips at it; team 1 lands the final blow but did less damage overall.
    const t0 = [...st.fighters.values()].find((f) => f.team === 0)!;
    const t1 = [...st.fighters.values()].find((f) => f.team === 1)!;
    titan.hp = 40;
    Object.assign(titan, { x: 1200, y: 700 });
    // Pretend team 0 already did most of the work.
    (titan as unknown as { damageBy: Record<string, number> }).damageBy[t0.userId] = titan.maxHp - 60;
    Object.assign(t1, { x: 1100, y: 700, shieldUntil: 1e15 });
    holdFire(room, t1, 1500);
    expect(st.npcs.some((n) => n.kind === 1)).toBe(false);
    expect(st.power[0]).toBe(CLASH_RULES.titan.power);
    expect(st.power[1]).toBe(0);
    expect(t0.points).toBeGreaterThan(t1.points);
    expect(st.titanAt).toBeGreaterThan(Date.now());
  });

  it("keeps drones and the Titan out unless the host turns bots on", async () => {
    const off = makeRoom();
    await off.room.start("host");
    vi.advanceTimersByTime(CLASH_RULES.titan.firstSpawnMs + 5000);
    expect(state(off.room).npcs).toHaveLength(0);
    await off.room.end("host");

    const on = makeRoom({ bots: true });
    await on.room.start("host");
    expect(view(on.room, "host").bots).toBe(true);
    vi.advanceTimersByTime(CLASH_RULES.drone.spawnEveryMs + 200);
    expect(state(on.room).npcs.some((n) => n.kind === 0)).toBe(true);
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
    const { room, hooks } = makeRoom({ bots: true });
    await room.start("host");
    vi.advanceTimersByTime(CLASH_RULES.drone.spawnEveryMs + 200);
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

  describe.each(CLASH_SCENERIES.map((sc) => sc.id))("the %s scenery", (scenery) => {
    const walls = clashWalls(scenery);
    const clearOf = (x: number, y: number, r: number) =>
      walls.every((w) => {
        const cx = Math.max(w.x, Math.min(x, w.x + w.w));
        const cy = Math.max(w.y, Math.min(y, w.y + w.h));
        return (x - cx) ** 2 + (y - cy) ** 2 >= r * r;
      });

    it("is fair to both teams", () => {
      for (const w of walls)
        expect(walls.some((o) => o.kind === w.kind && o.x === 2400 - w.x - w.w && o.y === w.y && o.w === w.w)).toBe(
          true,
        );
    });

    it("leaves bases, power-ups and drone spawns open", () => {
      for (const b of clashBases()) expect(clearOf(b.x, b.y, CLASH_RULES.baseRadius)).toBe(true);
      for (const p of CLASH_PICKUPS) expect(clearOf(p.x, p.y, CLASH_RULES.pickup.radius + 10)).toBe(true);
      for (const p of CLASH_DRONE_SPAWNS) expect(clearOf(p.x, p.y, CLASH_RULES.drone.radius + 10)).toBe(true);
      // The Titan's plaza: a little leeway, as it is only pushed out of cover.
      if (scenery !== "warzone")
        expect(clearOf(CLASH_CENTER.x, CLASH_CENTER.y, CLASH_RULES.titan.leash + CLASH_RULES.titan.radius)).toBe(true);
    });

    it("lets a soldier walk from either base to every power-up", () => {
      const step = 10;
      const r = CLASH_RULES.playerRadius;
      const cols = CLASH_RULES.arena.width / step;
      const rows = CLASH_RULES.arena.height / step;
      const open = (i: number, j: number) => {
        const x = i * step + step / 2;
        const y = j * step + step / 2;
        return x >= r && y >= r && x <= 2400 - r && y <= 1400 - r && clearOf(x, y, r);
      };
      const seen = new Uint8Array(cols * rows);
      const start = clashBases()[0]!;
      const queue = [[Math.floor(start.x / step), Math.floor(start.y / step)] as const];
      seen[queue[0]![1] * cols + queue[0]![0]] = 1;
      while (queue.length) {
        const [i, j] = queue.pop()!;
        for (const [di, dj] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const a = i + di;
          const b = j + dj;
          if (a < 0 || b < 0 || a >= cols || b >= rows || seen[b * cols + a] || !open(a, b)) continue;
          seen[b * cols + a] = 1;
          queue.push([a, b]);
        }
      }
      const reached = (x: number, y: number) => seen[Math.floor(y / step) * cols + Math.floor(x / step)] === 1;
      for (const p of [...CLASH_PICKUPS, ...clashBases()]) expect(reached(p.x, p.y)).toBe(true);
    });

    it("is played with its own cover", async () => {
      const { room } = makeRoom({ scenery });
      await room.start("host");
      expect(view(room, "ada").scenery).toBe(scenery);
      const ada = state(room).fighters.get("ada")!;
      // Walking into the first block of cover stops at its edge.
      const w = walls[0]!;
      Object.assign(ada, { x: w.x - 40, y: w.y + w.h / 2 });
      for (let i = 0; i < 6; i++) {
        input(room, "ada", { x: ada.x + 20, y: ada.y });
        vi.advanceTimersByTime(CLASH_RULES.tickMs);
      }
      expect(ada.x).toBeCloseTo(w.x - CLASH_RULES.playerRadius, 0);
      expect(resolveCircle(ada.x, ada.y, CLASH_RULES.playerRadius, walls)).toEqual({ x: ada.x, y: ada.y });
    });
  });

  it("fights in the war zone unless the host picks another scenery", async () => {
    const { room } = makeRoom();
    await room.start("host");
    expect(view(room, "ada").scenery).toBe("warzone");
    const bad = makeRoom({ scenery: "moon" });
    await expect(bad.room.start("host")).rejects.toThrow("Those game settings aren't valid");
  });
});
