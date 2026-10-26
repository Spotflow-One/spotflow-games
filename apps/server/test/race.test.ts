import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OBSTACLE_KINDS,
  RACE_BOXES,
  RACE_FLAG,
  RACE_ITEM,
  RACE_RULES,
  RACE_TRACK,
  buildCourse,
  deltaS,
  gridSlot,
  locate,
  moverAt,
  newCar,
  racePlacePoints,
  stepCar,
  trackPoint,
  widthsAt,
  type RaceSnapshot,
  type RaceView,
} from "@spotflow-games/shared";
import { GameError } from "../src/games/contract.js";
import { createRaceEngine } from "../src/games/race/engine.js";
import { decode, encode } from "../src/sessions/codec.js";
import { Room, type RoomHooks, type RoomSnapshot } from "../src/sessions/room.js";

const engine = createRaceEngine();
const u = (id: string) => ({ id, displayName: id, avatar: null });
const PLAYERS = ["host", "ada", "ben"];
const L = RACE_TRACK.length;

/** The engine's internal state, for arranging races. Tests only. */
interface Racer {
  userId: string;
  n: number;
  x: number;
  y: number;
  h: number;
  i: number;
  s: number;
  progress: number;
  k: number;
  item: number;
  boostUntil: number;
  crashes: number;
  finishMs: number | null;
  place: number | null;
}
interface State {
  racers: Map<string, Racer>;
  goAt: number;
  taken: Record<number, number>;
  slicks: Array<{ owner: number }>;
  config: { laps: number };
}

function makeRoom(config: object = {}, players = PLAYERS, opts: { allowLateJoin?: boolean; hostPlays?: boolean } = {}) {
  const hooks: RoomHooks = { sendStates: vi.fn(), sendEvent: vi.fn(), onResults: vi.fn(), onClosed: vi.fn() };
  const room = new Room(
    {
      id: "s1",
      code: "RACE01",
      gameType: "race",
      hostId: "host",
      allowLateJoin: opts.allowLateJoin ?? false,
      hostPlays: opts.hostPlays ?? true,
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
const view = (room: Room, id: string) => room.viewFor(id).game as RaceView;
const score = (room: Room, id: string) => room.viewFor(id).participants.find((p) => p.userId === id)!.score;
const snaps = (hooks: RoomHooks) =>
  (hooks.sendEvent as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as RaceSnapshot);
const tick = () => vi.advanceTimersByTime(RACE_RULES.tickMs);

/** Report a position for a racer, as its client would. */
function drive(
  room: Room,
  r: Racer,
  x: number,
  y: number,
  extra: Partial<{ h: number; v: number; u: number; c: number }> = {},
) {
  room.inputs.set(r.userId, { value: { x, y, h: r.h, v: 0, u: 0, c: 0, k: r.k, ...extra }, at: Date.now() });
}
/** Drive a racer forward along the centre line, at a legal speed, for this many ticks. */
function driveAlong(room: Room, r: Racer, ticks: number, step = 50) {
  for (let i = 0; i < ticks; i++) {
    const p = trackPoint(r.s + step, 0);
    drive(room, r, p.x, p.y, { h: p.h });
    tick();
  }
}
async function startRace(room: Room) {
  await room.start("host");
  vi.advanceTimersByTime(RACE_RULES.countdownMs);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Lagos Rush track", () => {
  it("is a closed loop that never comes back near itself", () => {
    const T = RACE_TRACK;
    expect(L).toBeGreaterThan(20_000);
    for (let i = 0; i < T.count; i += 3)
      for (let j = i + 60; j < T.count; j += 3) {
        if (T.count - (j - i) < 60) continue;
        expect(Math.hypot(T.x[i]! - T.x[j]!, T.y[i]! - T.y[j]!)).toBeGreaterThan(2 * 220 + 100);
      }
    // Third Mainland Bridge is the long one.
    const names = T.districts.map((d) => d.name);
    expect(names).toContain("Third Mainland Bridge");
    const at = T.districts.findIndex((d) => d.name === "Third Mainland Bridge");
    expect(T.districts[at + 1]!.s - T.districts[at]!.s).toBeGreaterThan(5000);
  });

  it("finds where a point is on the track", () => {
    for (const s of [0, 1234, 9000, L - 10]) {
      const p = trackPoint(s, 40);
      const loc = locate(p.x, p.y);
      expect(Math.abs(deltaS(loc.s, s))).toBeLessThan(2);
      expect(loc.d).toBeCloseTo(40, 0);
      expect(locate(p.x, p.y, loc.i).s).toBeCloseTo(loc.s, 3);
    }
  });

  it("builds the same course from the same seed, and keeps the grid clear", () => {
    const a = buildCourse(42);
    const b = buildCourse(42);
    expect(JSON.stringify(a.statics)).toBe(JSON.stringify(b.statics));
    expect(JSON.stringify(a.movers)).toBe(JSON.stringify(b.movers));
    expect(JSON.stringify(buildCourse(43).statics)).not.toBe(JSON.stringify(a.statics));
    for (const o of a.statics) expect(o.s > 600 && o.s < L - 400).toBe(true);
    const kinds = new Set([...a.statics.map((o) => o.kind), ...a.movers.map((m) => m.kind)]);
    for (const k of ["pothole", "cone", "stall", "danfo", "okada", "car"]) expect(kinds.has(k as never)).toBe(true);
  });

  it("moves traffic smoothly and keeps it on the road", () => {
    const course = buildCourse(7);
    for (const m of course.movers) {
      let prev = moverAt(m, 0);
      for (let t = 0.05; t < 60; t += 0.05) {
        const p = moverAt(m, t);
        expect(Math.abs(deltaS(p.s, prev.s))).toBeLessThan(Math.max(m.v, 200) * 0.05 + 2);
        expect(Math.abs(p.d)).toBeLessThan(widthsAt(p.s).half);
        prev = p;
      }
    }
  });
});

describe("Lagos Rush car", () => {
  const course = buildCourse(1);
  const empty = { statics: [], movers: [], buckets: new Map() };

  it("accelerates to top speed and no further", () => {
    const g = gridSlot(2);
    const car = newCar(g.x, g.y, g.h);
    let top = 0;
    for (let f = 0; f < 300; f++) {
      stepCar(car, { steer: 0, gas: true, brake: false }, 1 / 60, 0, 0, empty, [], 0);
      top = Math.max(top, car.v);
    }
    expect(top).toBeLessThanOrEqual(RACE_RULES.topSpeed);
    expect(top).toBeGreaterThan(RACE_RULES.topSpeed * 0.8);
  });

  it("stays inside the walls and counts hard crashes", () => {
    const p = trackPoint(3000, 0);
    // Pointing straight at the right-hand wall.
    const car = newCar(p.x, p.y, p.h + Math.PI / 2);
    car.v = 400;
    for (let f = 0; f < 120; f++) stepCar(car, { steer: 0, gas: true, brake: false }, 1 / 60, f * 17, 0, empty, [], 0);
    expect(Math.abs(car.d)).toBeLessThanOrEqual(widthsAt(car.s).wall - RACE_RULES.car.radius + 0.5);
    expect(car.crashes).toBeGreaterThan(0);
  });

  it("slows down for potholes once, and stops dead against a stall", () => {
    const pothole = course.statics.find((o) => o.kind === "pothole")!;
    const start = trackPoint(pothole.s - 60, pothole.d);
    const car = newCar(start.x, start.y, start.h);
    car.v = 300;
    let hits = 0;
    for (let f = 0; f < 30; f++)
      hits += stepCar(car, { steer: 0, gas: false, brake: false }, 1 / 60, f * 17, 0, course, [], 0).filter(
        (h) => h.kind === "pothole",
      ).length;
    expect(hits).toBe(1);
    expect(car.v).toBeLessThan(300 * OBSTACLE_KINDS.pothole.keep);
    expect(car.crashes).toBe(0);

    const stall = { statics: [{ id: 1, kind: "stall" as const, s: 5000, d: 0, v: 0 }], movers: [], buckets: new Map() };
    stall.buckets.set(Math.floor(5000 / 400), stall.statics);
    const before = trackPoint(4900, 0);
    const c2 = newCar(before.x, before.y, before.h);
    c2.v = 500;
    for (let f = 0; f < 60; f++) stepCar(c2, { steer: 0, gas: true, brake: false }, 1 / 60, f * 17, 0, stall, [], 0);
    expect(deltaS(c2.s, 5000)).toBeLessThan(-OBSTACLE_KINDS.stall.hs);
    expect(c2.crashes).toBe(1);
  });

  it("spins out on someone else's oil, but not your own", () => {
    const p = trackPoint(4000, 0);
    const ahead = trackPoint(4040, 0);
    const mine = newCar(p.x, p.y, p.h);
    mine.v = 300;
    for (let f = 0; f < 20; f++)
      stepCar(mine, { steer: 0, gas: true, brake: false }, 1 / 60, 1000, 0, empty, [{ id: 1, ...ahead, owner: 0 }], 0);
    expect(mine.spinUntil).toBe(0);
    const theirs = newCar(p.x, p.y, p.h);
    theirs.v = 300;
    for (let f = 0; f < 20; f++)
      stepCar(
        theirs,
        { steer: 0, gas: true, brake: false },
        1 / 60,
        1000,
        0,
        empty,
        [{ id: 1, ...ahead, owner: 3 }],
        0,
      );
    expect(theirs.spinUntil).toBe(1000 + RACE_RULES.spinMs);
  });
});

describe("Lagos Rush", () => {
  it("lines everyone up on the grid and holds them there through the countdown", async () => {
    const { room, hooks } = makeRoom();
    await room.start("host");
    const v = view(room, "ada");
    expect(v.laps).toBe(RACE_RULES.defaultLaps);
    expect(v.goAt - v.startedAt).toBe(RACE_RULES.countdownMs);
    expect(v.racers).toHaveLength(3);
    expect(v.me?.n).toBe(v.racers.find((r) => r.userId === "ada")!.n);
    const ada = state(room).racers.get("ada")!;
    expect(ada.progress).toBeLessThan(0);
    expect(() => room.handleAction("ada", { type: "go" })).toThrow(GameError);

    // A jump start goes nowhere.
    const start = { x: ada.x, y: ada.y };
    const p = trackPoint(ada.s + 40, 0);
    drive(room, ada, p.x, p.y);
    tick();
    expect({ x: ada.x, y: ada.y }).toEqual(start);
    expect(snaps(hooks).at(-1)!.players).toHaveLength(3);
  });

  it("moves cars no faster than top speed and never through the walls", async () => {
    const { room } = makeRoom();
    await startRace(room);
    const ada = state(room).racers.get("ada")!;
    tick();
    const from = { x: ada.x, y: ada.y };
    // Asks to teleport down the road: only a short step is allowed.
    const far = trackPoint(ada.s + 3000, 0);
    drive(room, ada, far.x, far.y);
    tick();
    const moved = Math.hypot(ada.x - from.x, ada.y - from.y);
    expect(moved).toBeGreaterThan(10);
    expect(moved).toBeLessThan(RACE_RULES.topSpeed * 0.1 * 1.5 + 13);
    // Driving off the side stops at the wall.
    for (let i = 0; i < 20; i++) {
      const out = trackPoint(ada.s, 600);
      drive(room, ada, out.x, out.y);
      tick();
    }
    expect(Math.abs(locate(ada.x, ada.y).d)).toBeLessThanOrEqual(widthsAt(ada.s).wall);
    // Input from before the server last placed the car is ignored, as is junk.
    const here = { x: ada.x, y: ada.y };
    room.inputs.set("ada", { value: { ...far, h: 0, v: 0, u: 0, c: 0, k: ada.k - 1 }, at: Date.now() });
    tick();
    room.inputs.set("ada", { value: { x: "far" }, at: Date.now() });
    tick();
    expect({ x: ada.x, y: ada.y }).toEqual(here);
  });

  it("counts laps, finishing order and awards points by place", async () => {
    const { room, hooks } = makeRoom({ laps: 1 });
    await startRace(room);
    const st = state(room);
    const [a, b, c] = ["ada", "ben", "host"].map((id) => st.racers.get(id)!) as [Racer, Racer, Racer];
    // Most of a lap done already, then over the line.
    for (const r of [a, b]) {
      const p = trackPoint(L - 300, 0);
      Object.assign(r, { x: p.x, y: p.y, s: L - 300, i: locate(p.x, p.y).i, progress: L - 300 });
    }
    driveAlong(room, a, 8);
    expect(a.place).toBe(1);
    expect(view(room, "ada").racers.find((r) => r.userId === "ada")!.finishMs).toBeGreaterThan(0);
    expect(snaps(hooks).some((s) => s.feed.some(([kind, n, place]) => kind === 0 && n === a.n && place === 1))).toBe(
      true,
    );
    expect(
      snaps(hooks)
        .at(-1)!
        .players.find((p) => p[0] === a.n)![5] & RACE_FLAG.finished,
    ).toBeTruthy();
    driveAlong(room, b, 8);
    expect(b.place).toBe(2);
    expect(room.status).toBe("in_progress");

    // The last car has the grace period to finish, then the race ends.
    vi.advanceTimersByTime(RACE_RULES.finishGraceMs);
    expect(room.status).toBe("results");
    expect(view(room, "ada").outcome).toEqual({ reason: "time" });
    expect(score(room, "ada")).toBe(racePlacePoints(1, 3) + RACE_RULES.cleanBonus);
    expect(score(room, "ben")).toBe(racePlacePoints(2, 3) + RACE_RULES.cleanBonus);
    expect(score(room, "host")).toBeLessThan(score(room, "ben"));
    expect(c.place).toBeNull();
    const ranks = room.viewFor("ada").participants;
    expect(ranks.find((p) => p.userId === "ada")!.rank).toBe(1);
    expect(ranks.find((p) => p.userId === "host")!.rank).toBe(3);
  });

  it("ends as soon as everyone is home, and docks the clean bonus for crashes", async () => {
    const { room } = makeRoom({ laps: 1 }, ["host"]);
    await startRace(room);
    const me = state(room).racers.get("host")!;
    const p = trackPoint(L - 300, 0);
    Object.assign(me, { x: p.x, y: p.y, s: L - 300, i: locate(p.x, p.y).i, progress: L - 300 });
    for (let i = 0; i < 8; i++) {
      const q = trackPoint(me.s + 50, 0);
      drive(room, me, q.x, q.y, { h: q.h, c: 3 });
      tick();
    }
    expect(me.crashes).toBe(3);
    vi.advanceTimersByTime(3000);
    expect(room.status).toBe("results");
    expect(view(room, "host").outcome).toEqual({ reason: "finished" });
    expect(score(room, "host")).toBe(
      racePlacePoints(1, 1) + RACE_RULES.cleanBonus - 3 * RACE_RULES.cleanPenaltyPerCrash,
    );
  });

  it("hands out items from boxes: nitro boosts, oil drops a slick", async () => {
    const { room, hooks } = makeRoom();
    await startRace(room);
    const st = state(room);
    const ada = st.racers.get("ada")!;
    const box = RACE_BOXES[2]!;
    Object.assign(ada, { x: box.x, y: box.y, s: box.s, i: locate(box.x, box.y).i, progress: box.s });
    drive(room, ada, box.x, box.y);
    tick();
    expect(ada.item).not.toBe(RACE_ITEM.none);
    expect(st.taken[box.id]).toBeGreaterThan(Date.now());
    expect(snaps(hooks).at(-1)!.taken).toContain(box.id);

    ada.item = RACE_ITEM.nitro;
    drive(room, ada, ada.x, ada.y, { u: 0 });
    tick();
    drive(room, ada, ada.x, ada.y, { u: 1 });
    tick();
    expect(ada.item).toBe(RACE_ITEM.none);
    expect(ada.boostUntil).toBeGreaterThan(Date.now());
    expect(
      snaps(hooks)
        .at(-1)!
        .players.find((p) => p[0] === ada.n)![5] & RACE_FLAG.boost,
    ).toBeTruthy();

    ada.item = RACE_ITEM.oil;
    drive(room, ada, ada.x, ada.y, { u: 2 });
    tick();
    expect(st.slicks).toHaveLength(1);
    expect(snaps(hooks).at(-1)!.slicks[0]![3]).toBe(ada.n);
    vi.advanceTimersByTime(RACE_RULES.slick.lifeMs + 200);
    expect(state(room).slicks).toHaveLength(0);
    // The box comes back.
    expect(state(room).taken[box.id]).toBeUndefined();
  });

  it("scores distance for anyone who didn't finish when the host ends it", async () => {
    const { room } = makeRoom({ laps: 2 });
    await startRace(room);
    const st = state(room);
    st.racers.get("ada")!.progress = L;
    st.racers.get("ben")!.progress = L / 2;
    room.end("host");
    expect(view(room, "ada").outcome).toEqual({ reason: "ended" });
    expect(score(room, "ada")).toBe(Math.floor(RACE_RULES.dnfMaxPoints * 0.5));
    expect(score(room, "ben")).toBe(Math.floor(RACE_RULES.dnfMaxPoints * 0.25));
    const ranks = room.viewFor("ada").participants;
    expect(ranks.find((p) => p.userId === "ada")!.rank).toBe(1);
  });

  it("takes up to 30 racers, plus a host who only watches", () => {
    const racers = Array.from({ length: 30 }, (_, i) => `p${i}`);
    const full = makeRoom({}, ["host", ...racers.slice(0, 29)]);
    expect(() => full.room.join(u("late"), "late", 50)).toThrow("This session is full");
    const watching = makeRoom({}, ["host", ...racers], { hostPlays: false });
    expect(watching.room.participants.size).toBe(31);
    expect(() => watching.room.join(u("late"), "late", 50)).toThrow("This session is full");
  });

  it("starts 30 cars on distinct grid spots behind the line", async () => {
    const racers = Array.from({ length: 30 }, (_, i) => `p${i}`);
    const { room } = makeRoom({}, racers.concat("host").slice(-30));
    await room.start("host");
    const cars = [...state(room).racers.values()];
    for (const a of cars) {
      expect(deltaS(a.s, 0)).toBeLessThan(0);
      for (const b of cars) if (a !== b) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(30);
    }
  });

  it("puts late joiners on the grid", async () => {
    const { room } = makeRoom({}, ["host", "ada"], { allowLateJoin: true });
    await startRace(room);
    room.join(u("dee"), "dee", 50);
    tick();
    const v = view(room, "dee");
    expect(v.me).not.toBeNull();
    expect(state(room).racers.get("dee")!.progress).toBeLessThan(0);
  });

  it("carries on from a snapshot that went through JSON", async () => {
    const { room, hooks } = makeRoom();
    await startRace(room);
    const snap = decode<RoomSnapshot>(encode(room.toSnapshot()));
    room.dispose();
    const copy = Room.fromSnapshot(snap, engine, hooks);
    const before = snaps(hooks).length;
    vi.advanceTimersByTime(1000);
    expect(snaps(hooks).length).toBeGreaterThan(before);
    expect(state(copy).racers.size).toBe(PLAYERS.length);
    copy.dispose();
  });
});
