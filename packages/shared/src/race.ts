import { z } from "zod";

/**
 * Lagos Rush: a real-time street race through Lagos, across Third Mainland Bridge, dodging
 * danfos, okadas, potholes, market stalls and checkpoints. Distances are in track units.
 *
 * Each player's own car is simulated on their device (with `stepCar` below) and its position
 * is streamed with `game:input`. The server accepts it within top speed and the road walls,
 * and decides everything that is shared: laps, finishing order, item boxes and oil slicks.
 * Obstacles are a pure function of the race seed and the race clock, so every screen and the
 * server agree on where the traffic is without sending it.
 */
export const RACE_RULES = {
  /** How often the server checks positions and sends a snapshot. */
  tickMs: 100,
  maxRacers: 30,

  car: { length: 36, width: 18, radius: 12 },
  /** Units per second. */
  topSpeed: 600,
  nitroSpeed: 860,
  offroadSpeed: 260,
  reverseSpeed: 180,
  accel: 340,
  nitroAccel: 1000,
  brake: 900,
  coast: 220,
  /** Radians per second at full lock, at low-to-mid speed. */
  turnRate: 2.4,
  /** How long a spin on an oil slick lasts. */
  spinMs: 900,

  countdownMs: 4000,
  /** Positions older than this are ignored, so a dropped player's car stops. */
  inputStaleMs: 1500,
  /** Once someone finishes, everyone else has this long to cross the line. */
  finishGraceMs: 30_000,
  /** The race ends anyway after this long per lap. */
  lapLimitMs: 100_000,

  box: { radius: 30, respawnMs: 6000 },
  nitroMs: 2200,
  slick: { radius: 30, lifeMs: 15_000, max: 30 },

  /** Points: by finishing place, a winner's bonus, a clean-driving bonus, and some for distance if you don't finish. */
  placeBase: 100,
  placeStep: 25,
  winBonus: 150,
  cleanBonus: 50,
  cleanPenaltyPerCrash: 5,
  dnfMaxPoints: 150,

  defaultLaps: 3,
  lapOptions: [1, 2, 3, 4, 5],
} as const;

export const raceSessionConfigSchema = z
  .object({
    laps: z.number().int().min(1).max(5).default(RACE_RULES.defaultLaps),
  })
  .strict();
export type RaceSessionConfig = z.input<typeof raceSessionConfigSchema>;

/**
 * Streamed with `game:input`: where the car is, which way it faces, how fast it's going, a
 * counter that uses the held item when it changes, and how many times the car has crashed.
 */
export const raceInputSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    /** Heading in radians. */
    h: z.number().finite().min(-1000).max(1000),
    v: z.number().finite().min(-1000).max(2000),
    u: z.number().int().min(0).max(1_000_000_000),
    c: z.number().int().min(0).max(1_000_000),
    /** The placement the client is on. Positions from before the server moved the car are ignored. */
    k: z.number().int().min(0).max(1_000_000),
  })
  .strict();
export type RaceInput = z.infer<typeof raceInputSchema>;

export const RACE_ITEM = { none: 0, nitro: 1, oil: 2 } as const;
export const RACE_FLAG = { boost: 1, finished: 2 } as const;

/** n, x, y, heading (centiradians), speed, flags, progress (units since the start line), item, placement. */
export type RacePlayerTuple = [
  n: number,
  x: number,
  y: number,
  h: number,
  v: number,
  flags: number,
  progress: number,
  item: number,
  k: number,
];
/** id, x, y, the player who dropped it. */
export type RaceSlickTuple = [id: number, x: number, y: number, owner: number];
/** kind 0: finished (a = place). kind 1: used nitro. kind 2: dropped oil. */
export type RaceFeedTuple = [kind: 0 | 1 | 2, n: number, a: number];

export interface RaceSnapshot {
  type: "race";
  now: number;
  players: RacePlayerTuple[];
  /** Item boxes that are taken right now. */
  taken: number[];
  slicks: RaceSlickTuple[];
  feed: RaceFeedTuple[];
}

export interface RaceRacer {
  userId: string;
  n: number;
  /** Finish time from the green light, once finished. */
  finishMs: number | null;
  place: number | null;
  crashes: number;
  /** How far through the race, 0 to 1. */
  done: number;
}

export interface RaceView {
  laps: number;
  seed: number;
  /** When the race was set up; the traffic clock runs from here. */
  startedAt: number;
  /** The green light. */
  goAt: number;
  endsAt: number;
  serverNow: number;
  racers: RaceRacer[];
  me: { n: number } | null;
  isPlayer: boolean;
  outcome: { reason: "finished" | "time" | "ended" } | null;
}

// ---------------------------------------------------------------------------------------------
// The track

export type RaceZone = "road" | "bridge" | "market";

/** The route, as control points of a closed curve. A zone runs from its point to the next. */
const ROUTE: Array<{ x: number; y: number; zone: RaceZone; name?: string }> = [
  { x: 10400, y: 8200, zone: "road", name: "Lekki Toll Gate" },
  { x: 8800, y: 8350, zone: "road" },
  { x: 7200, y: 8250, zone: "road", name: "Ozumba Mbadiwe" },
  { x: 5600, y: 8350, zone: "road" },
  { x: 4200, y: 8050, zone: "road", name: "Obalende" },
  { x: 3200, y: 7400, zone: "road" },
  { x: 2700, y: 6400, zone: "bridge", name: "Third Mainland Bridge" },
  { x: 2550, y: 4800, zone: "bridge" },
  { x: 2600, y: 3200, zone: "bridge" },
  { x: 2850, y: 1700, zone: "road" },
  { x: 3500, y: 900, zone: "road", name: "Oworonshoki" },
  { x: 4800, y: 700, zone: "road" },
  { x: 6000, y: 1300, zone: "road", name: "Gbagada" },
  { x: 7000, y: 1100, zone: "market", name: "Oshodi" },
  { x: 8000, y: 1600, zone: "market" },
  { x: 8600, y: 2600, zone: "road" },
  { x: 9800, y: 3000, zone: "road", name: "Ikeja Along" },
  { x: 10600, y: 3900, zone: "road" },
  { x: 10300, y: 5000, zone: "road", name: "Ikoyi" },
  { x: 9600, y: 5800, zone: "bridge", name: "Lekki-Ikoyi Link Bridge" },
  { x: 9900, y: 6900, zone: "road" },
  { x: 10800, y: 7600, zone: "road", name: "Admiralty Way" },
];

const STEP_TARGET = 40;
const HALF = { road: 160, bridge: 160, market: 150 } as const;
/** Hard walls: a dusty shoulder beside the road, railings on bridges. */
const WALL = { road: 220, bridge: 172, market: 200 } as const;

export interface RaceTrack {
  length: number;
  step: number;
  count: number;
  x: Float64Array;
  y: Float64Array;
  /** Direction of travel at each sample. */
  h: Float64Array;
  /** Half width of the tarmac and of the walls at each sample. */
  half: Float64Array;
  wall: Float64Array;
  zone: RaceZone[];
  districts: Array<{ name: string; s: number }>;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

function catmull(p0: number, p1: number, p2: number, p3: number, t: number) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function buildTrack(): RaceTrack {
  // A fine pass along the spline, then even resampling so a distance maps straight to a sample.
  const n = ROUTE.length;
  const fine: Array<{ x: number; y: number; span: number }> = [];
  for (let i = 0; i < n; i++) {
    const a = ROUTE[(i - 1 + n) % n]!;
    const b = ROUTE[i]!;
    const c = ROUTE[(i + 1) % n]!;
    const d = ROUTE[(i + 2) % n]!;
    for (let k = 0; k < 64; k++) {
      const t = k / 64;
      fine.push({ x: catmull(a.x, b.x, c.x, d.x, t), y: catmull(a.y, b.y, c.y, d.y, t), span: i });
    }
  }
  const cum = [0];
  for (let i = 1; i <= fine.length; i++) {
    const p = fine[i - 1]!;
    const q = fine[i % fine.length]!;
    cum.push(cum[i - 1]! + Math.hypot(q.x - p.x, q.y - p.y));
  }
  const length = cum[fine.length]!;
  const count = Math.round(length / STEP_TARGET);
  const step = length / count;
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  const spans: number[] = [];
  let j = 0;
  for (let i = 0; i < count; i++) {
    const s = i * step;
    while (cum[j + 1]! < s) j++;
    const p = fine[j]!;
    const q = fine[(j + 1) % fine.length]!;
    const t = (s - cum[j]!) / (cum[j + 1]! - cum[j]! || 1);
    x[i] = p.x + (q.x - p.x) * t;
    y[i] = p.y + (q.y - p.y) * t;
    spans.push(p.span);
  }
  const h = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const k = (i + 1) % count;
    h[i] = Math.atan2(y[k]! - y[i]!, x[k]! - x[i]!);
  }
  const zone = spans.map((sp) => ROUTE[sp]!.zone);
  // Widths ease between zones, so a wall never jumps sideways under a car.
  const smooth = (src: Record<RaceZone, number>) => {
    const raw = zone.map((z) => src[z]);
    const out = new Float64Array(count);
    const w = 10;
    for (let i = 0; i < count; i++) {
      let sum = 0;
      for (let k = -w; k <= w; k++) sum += raw[(i + k + count) % count]!;
      out[i] = sum / (2 * w + 1);
    }
    return out;
  };
  const districts: RaceTrack["districts"] = [];
  for (let i = 0; i < count; i++) {
    const r = ROUTE[spans[i]!]!;
    if (r.name && (i === 0 || spans[i - 1] !== spans[i])) districts.push({ name: r.name, s: i * step });
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    minX = Math.min(minX, x[i]!);
    minY = Math.min(minY, y[i]!);
    maxX = Math.max(maxX, x[i]!);
    maxY = Math.max(maxY, y[i]!);
  }
  return {
    length,
    step,
    count,
    x,
    y,
    h,
    half: smooth(HALF),
    wall: smooth(WALL),
    zone,
    districts,
    bounds: { minX, minY, maxX, maxY },
  };
}

export const RACE_TRACK: RaceTrack = buildTrack();

/** Wraps a distance along the track into [0, length). */
export function wrapS(s: number) {
  const L = RACE_TRACK.length;
  return ((s % L) + L) % L;
}
/** The shortest signed distance along the track from b to a. */
export function deltaS(a: number, b: number) {
  const L = RACE_TRACK.length;
  let d = wrapS(a) - wrapS(b);
  if (d > L / 2) d -= L;
  if (d < -L / 2) d += L;
  return d;
}

const sampleAt = (s: number) => {
  const T = RACE_TRACK;
  const f = wrapS(s) / T.step;
  const i = Math.floor(f) % T.count;
  return { i, t: f - Math.floor(f), j: (i + 1) % T.count };
};

/** Half widths of the tarmac and the walls at a distance along the track. */
export function widthsAt(s: number) {
  const T = RACE_TRACK;
  const { i, t, j } = sampleAt(s);
  return { half: T.half[i]! + (T.half[j]! - T.half[i]!) * t, wall: T.wall[i]! + (T.wall[j]! - T.wall[i]!) * t };
}

export function zoneAt(s: number): RaceZone {
  return RACE_TRACK.zone[sampleAt(s).i]!;
}

/** Where a point at distance s along the track, d to the right of the centre line, is. */
export function trackPoint(s: number, d = 0) {
  const T = RACE_TRACK;
  const { i, t, j } = sampleAt(s);
  const h = T.h[i]!;
  const x = T.x[i]! + (T.x[j]! - T.x[i]!) * t;
  const y = T.y[i]! + (T.y[j]! - T.y[i]!) * t;
  return { x: x - Math.sin(h) * d, y: y + Math.cos(h) * d, h };
}

export interface TrackLocation {
  /** The sample the car is nearest, to speed up the next lookup. */
  i: number;
  s: number;
  /** Signed distance to the right of the centre line. */
  d: number;
}

/**
 * Finds where a point is on the track. With a hint (the last sample), only nearby samples
 * are searched; the road never comes back near itself, so that is always enough.
 */
export function locate(x: number, y: number, hint = -1): TrackLocation {
  const T = RACE_TRACK;
  let best = { i: 0, t: 0, d2: Infinity };
  const check = (i: number) => {
    const j = (i + 1) % T.count;
    const ax = T.x[i]!;
    const ay = T.y[i]!;
    const dx = T.x[j]! - ax;
    const dy = T.y[j]! - ay;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
    const px = ax + dx * t - x;
    const py = ay + dy * t - y;
    const d2 = px * px + py * py;
    if (d2 < best.d2) best = { i, t, d2 };
  };
  if (hint >= 0) for (let k = -30; k <= 30; k++) check((hint + k + T.count) % T.count);
  if (best.d2 > 600 * 600) for (let i = 0; i < T.count; i++) check(i);
  const h = T.h[best.i]!;
  const j = (best.i + 1) % T.count;
  const cx = T.x[best.i]! + (T.x[j]! - T.x[best.i]!) * best.t;
  const cy = T.y[best.i]! + (T.y[j]! - T.y[best.i]!) * best.t;
  const d = (x - cx) * -Math.sin(h) + (y - cy) * Math.cos(h);
  return { i: best.i, s: (best.i + best.t) * T.step, d };
}

/** Keeps a car inside the walls. Returns the corrected position, and whether it hit one. */
export function clampToWalls(x: number, y: number, loc: TrackLocation) {
  const limit = widthsAt(loc.s).wall - RACE_RULES.car.radius;
  if (Math.abs(loc.d) <= limit) return { x, y, hit: false };
  const p = trackPoint(loc.s, Math.sign(loc.d) * limit);
  return { x: p.x, y: p.y, hit: true };
}

/** Starting grid: rows of six behind the line, staggered. */
export function gridSlot(slot: number) {
  const row = Math.floor(slot / 6);
  const col = slot % 6;
  const s = wrapS(-90 - row * 70 - (col % 2) * 18);
  const p = trackPoint(s, (col - 2.5) * 46);
  return { x: p.x, y: p.y, h: p.h, s };
}

// ---------------------------------------------------------------------------------------------
// Item boxes: rows across the road, the same every race.

export interface RaceBox {
  id: number;
  x: number;
  y: number;
  s: number;
}
export const RACE_BOXES: RaceBox[] = [0.07, 0.27, 0.42, 0.62, 0.8].flatMap((f, row) =>
  [-100, -50, 0, 50, 100].map((d, k) => {
    const s = f * RACE_TRACK.length;
    const p = trackPoint(s, d);
    return { id: row * 5 + k, x: p.x, y: p.y, s };
  }),
);

// ---------------------------------------------------------------------------------------------
// Obstacles, generated from the race seed.

export type ObstacleKind = "pothole" | "cone" | "stall" | "keke" | "danfo" | "okada" | "car";

interface KindInfo {
  /** Half size along and across the road. */
  hs: number;
  hd: number;
  solid: boolean;
  /** Speed kept after hitting it. */
  keep: number;
  crash: boolean;
}
export const OBSTACLE_KINDS: Record<ObstacleKind, KindInfo> = {
  pothole: { hs: 22, hd: 18, solid: false, keep: 0.72, crash: false },
  cone: { hs: 8, hd: 8, solid: true, keep: 0.8, crash: false },
  stall: { hs: 26, hd: 26, solid: true, keep: 0.4, crash: true },
  keke: { hs: 18, hd: 11, solid: true, keep: 0.45, crash: true },
  danfo: { hs: 34, hd: 14, solid: true, keep: 0.35, crash: true },
  okada: { hs: 13, hd: 6, solid: true, keep: 0.55, crash: true },
  car: { hs: 21, hd: 11, solid: true, keep: 0.45, crash: true },
};

export interface StaticObstacle {
  id: number;
  kind: ObstacleKind;
  s: number;
  d: number;
  /** Colour or style variant. */
  v: number;
}

/**
 * A moving obstacle. Danfos drive the whole loop and pull over to the kerb every so often;
 * okadas weave across the lanes; go-slow cars inch along in jams on the bridge.
 */
export interface Mover {
  id: number;
  kind: "danfo" | "okada" | "car";
  s0: number;
  /** Speed along the track. */
  v: number;
  lane: number;
  /** Seconds per cycle (pull-over or weave), and where in the cycle it starts. */
  period: number;
  phase: number;
  /** How far it swings across. */
  amp: number;
  v2: number;
}

export interface RaceCourse {
  statics: StaticObstacle[];
  movers: Mover[];
  /** Statics bucketed by track sample, for quick nearby lookups. */
  buckets: Map<number, StaticObstacle[]>;
}

const BUCKET = 400;
/** A danfo spends this share of each cycle pulled over at a bus stop. */
const STOP_SHARE = 0.3;
const STOP_SPEED = 0.35;

/** Small, fast, seedable random numbers, so every screen builds the same course. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildCourse(seed: number): RaceCourse {
  const rnd = mulberry32(seed);
  const L = RACE_TRACK.length;
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const statics: StaticObstacle[] = [];
  let id = 1;
  // Keep the grid, the first straight and the item rows clear.
  const clear = (s: number) => s < 900 || s > L - 600 || RACE_BOXES.some((b) => Math.abs(deltaS(s, b.s)) < 160);
  const add = (kind: ObstacleKind, s: number, d: number) =>
    statics.push({ id: id++, kind, s: wrapS(s), d, v: Math.floor(rnd() * 4) });

  // Potholes everywhere, a few of them in clusters.
  for (let i = 0; i < 34; i++) {
    const s = rnd() * L;
    if (clear(s)) continue;
    const half = widthsAt(s).half;
    const d = (rnd() * 2 - 1) * (half - 30);
    add("pothole", s, d);
    if (rnd() < 0.3) add("pothole", s + 50 + rnd() * 40, d + (rnd() * 2 - 1) * 50);
  }

  // Market stalls crowd both kerbs at Oshodi, with a few spilling into the road.
  for (let s = 0; s < L; s += 110) {
    if (zoneAt(s) !== "market" || clear(s)) continue;
    const half = widthsAt(s).half;
    for (const side of [-1, 1]) if (rnd() < 0.8) add("stall", s + rnd() * 40, side * (half + 8 + rnd() * 14));
    if (rnd() < 0.18) add("stall", s + 50, (rnd() * 2 - 1) * (half - 60));
  }

  // Roadside traders and parked kekes elsewhere (never on a bridge).
  for (let i = 0; i < 26; i++) {
    const s = rnd() * L;
    if (clear(s) || zoneAt(s) !== "road") continue;
    const half = widthsAt(s).half;
    const side = rnd() < 0.5 ? -1 : 1;
    if (rnd() < 0.5) add("stall", s, side * (half + 14));
    else add("keke", s, side * (half - 14));
  }

  // Police checkpoints: a line of cones across the road with one gap to thread.
  for (let i = 0; i < 3; i++) {
    let s = (0.15 + i * 0.3 + rnd() * 0.08) * L;
    while (zoneAt(s) !== "road" || clear(s)) s += 200;
    const half = widthsAt(s).half;
    const gap = (rnd() * 2 - 1) * (half - 90);
    for (let d = -half + 10; d <= half - 10; d += 26) if (Math.abs(d - gap) > 60) add("cone", s, d);
  }

  // Go-slow on Third Mainland Bridge: knots of cars inching along, with gaps to weave through.
  const bridge: number[] = [];
  for (let i = 0; i < RACE_TRACK.count; i++) {
    const s = i * RACE_TRACK.step;
    if (zoneAt(s) === "bridge" && s < L / 2) bridge.push(s);
  }
  const movers: Mover[] = [];
  if (bridge.length) {
    const from = bridge[0]! + 300;
    const to = bridge[bridge.length - 1]! - 300;
    for (let k = 0; k < 4; k++) {
      const at = from + ((to - from) * (k + 0.5)) / 4;
      const lanes = [-110, -55, 0, 55, 110];
      const open = Math.floor(rnd() * lanes.length);
      lanes.forEach((lane, li) => {
        if (li === open) return;
        const rows = 1 + Math.floor(rnd() * 2);
        for (let r = 0; r < rows; r++)
          movers.push({
            id: id++,
            kind: "car",
            s0: at + r * 70 + rnd() * 30,
            v: 0,
            lane: lane + (rnd() * 2 - 1) * 6,
            period: 2.5 + rnd() * 2,
            phase: rnd(),
            amp: 18 + rnd() * 18,
            v2: Math.floor(rnd() * 6),
          });
      });
    }
  }

  // Danfos and okadas share the road with you, all the way round.
  for (let i = 0; i < 14; i++)
    movers.push({
      id: id++,
      kind: "danfo",
      s0: 1500 + (i / 14) * (L - 3000) + rnd() * 400,
      v: 170 + rnd() * 90,
      lane: pick([-95, -35, 35, 95]),
      period: 7 + rnd() * 5,
      phase: rnd(),
      amp: rnd() < 0.5 ? -1 : 1,
      v2: Math.floor(rnd() * 4),
    });
  for (let i = 0; i < 10; i++)
    movers.push({
      id: id++,
      kind: "okada",
      s0: 1500 + rnd() * (L - 3000),
      v: 320 + rnd() * 90,
      lane: (rnd() * 2 - 1) * 30,
      period: 2.5 + rnd() * 2.5,
      phase: rnd(),
      amp: 50 + rnd() * 60,
      v2: Math.floor(rnd() * 4),
    });

  const buckets = new Map<number, StaticObstacle[]>();
  for (const o of statics) {
    const b = Math.floor(o.s / BUCKET);
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b)!.push(o);
  }
  return { statics, movers, buckets };
}

/** Statics near a distance along the track. */
export function nearbyStatics(course: RaceCourse, s: number) {
  const n = Math.ceil(RACE_TRACK.length / BUCKET);
  const b = Math.floor(wrapS(s) / BUCKET);
  const out: StaticObstacle[] = [];
  for (const k of [b - 1, b, b + 1]) out.push(...(course.buckets.get((k + n) % n) ?? []));
  return out;
}

/**
 * Where a moving obstacle is, `t` seconds into the race clock. `signal` is true while a danfo
 * is flashing its indicator, just before it pulls over.
 */
export function moverAt(m: Mover, t: number) {
  if (m.kind === "car") {
    // Stuck in a go-slow: shuffle forward and settle back, never getting anywhere.
    const c = t / m.period + m.phase;
    return { s: wrapS(m.s0 + (m.amp * (1 - Math.cos(2 * Math.PI * c))) / 2), d: m.lane, signal: false };
  }
  if (m.kind === "okada") {
    const s = m.s0 + m.v * t;
    const d = m.lane + m.amp * Math.sin((2 * Math.PI * t) / m.period + m.phase * 6.28);
    return { s: wrapS(s), d: clampLane(s, d), signal: false };
  }
  // A danfo: drives its lane, then swings over to the kerb and crawls, then pulls out again.
  const P = m.period;
  const W = P * STOP_SHARE;
  const run = P - W;
  const tt = t + m.phase * P;
  const cycles = Math.floor(tt / P);
  const tau = tt - cycles * P;
  const per = m.v * run + m.v * STOP_SPEED * W;
  const into = tau < run ? m.v * tau : m.v * run + m.v * STOP_SPEED * (tau - run);
  const s = m.s0 + (cycles * per + into) - m.phase * per;
  const kerb = m.amp * (widthsAt(s).half - 36);
  const u = tau < run ? 0 : (tau - run) / W;
  const k = Math.min(1, 1.6 * Math.sin(Math.PI * u));
  return { s: wrapS(s), d: m.lane + (kerb - m.lane) * k, signal: tau > run - 0.8 && u < 0.5 };
}

function clampLane(s: number, d: number) {
  const half = widthsAt(s).half - 20;
  return Math.max(-half, Math.min(half, d));
}

/** The moving obstacles at race time t, with their track positions. */
export function moversAt(course: RaceCourse, t: number) {
  return course.movers.map((m) => {
    const p = moverAt(m, t);
    return { m, s: p.s, d: p.d, signal: p.signal };
  });
}

// ---------------------------------------------------------------------------------------------
// Car physics, run on each player's device for their own car.

export interface CarState {
  x: number;
  y: number;
  h: number;
  v: number;
  /** A short knock sideways after a bump, fading fast. */
  bx: number;
  by: number;
  /** Track sample hint. */
  i: number;
  s: number;
  d: number;
  spinUntil: number;
  boostUntil: number;
  crashes: number;
  lastCrashAt: number;
  /** Potholes and slicks already hit, so each one counts once per pass. */
  touched: Record<number, number>;
}

export interface CarControls {
  /** -1 left to 1 right. */
  steer: number;
  gas: boolean;
  brake: boolean;
}

export interface CarHit {
  kind: ObstacleKind | "wall" | "slick";
  x: number;
  y: number;
  crash: boolean;
}

export function newCar(x: number, y: number, h: number): CarState {
  const loc = locate(x, y);
  return {
    x,
    y,
    h,
    v: 0,
    bx: 0,
    by: 0,
    i: loc.i,
    s: loc.s,
    d: loc.d,
    spinUntil: 0,
    boostUntil: 0,
    crashes: 0,
    lastCrashAt: -Infinity,
    touched: {},
  };
}

/**
 * Moves a car by dt seconds. `now` is the server clock in ms (for boosts and spins) and `t` the
 * race clock in seconds (for traffic). Returns what it ran into, for sounds and sparks.
 */
export function stepCar(
  car: CarState,
  ctl: CarControls,
  dt: number,
  now: number,
  t: number,
  course: RaceCourse,
  slicks: ReadonlyArray<{ id: number; x: number; y: number; owner: number }>,
  myN: number,
): CarHit[] {
  const R = RACE_RULES;
  const hits: CarHit[] = [];
  const spinning = now < car.spinUntil;
  const boosting = now < car.boostUntil;
  const { half } = widthsAt(car.s);
  const offroad = Math.abs(car.d) > half;
  const top = boosting ? R.nitroSpeed : offroad ? R.offroadSpeed : R.topSpeed;

  // Speed.
  if (spinning) car.v *= Math.exp(-2.5 * dt);
  else if (boosting) car.v = Math.min(top, car.v + R.nitroAccel * dt);
  else if (ctl.brake)
    car.v = car.v > 0 ? Math.max(0, car.v - R.brake * dt) : Math.max(-R.reverseSpeed, car.v - R.accel * 0.6 * dt);
  else if (ctl.gas)
    car.v = car.v < 0 ? Math.min(0, car.v + R.brake * dt) : car.v + R.accel * (1 - (0.55 * car.v) / R.topSpeed) * dt;
  else car.v = car.v > 0 ? Math.max(0, car.v - R.coast * dt) : Math.min(0, car.v + R.coast * dt);
  if (car.v > top) car.v = Math.max(top, car.v - (offroad ? 900 : 500) * dt);

  // Steering bites from walking pace and loosens a little at top speed.
  if (spinning) car.h += 11 * dt;
  else {
    const grip = Math.min(1, Math.abs(car.v) / 200) * (1 - (0.3 * Math.min(Math.abs(car.v), R.topSpeed)) / R.topSpeed);
    car.h += Math.max(-1, Math.min(1, ctl.steer)) * R.turnRate * grip * Math.sign(car.v) * dt;
  }
  if (car.h > Math.PI) car.h -= 2 * Math.PI;
  if (car.h < -Math.PI) car.h += 2 * Math.PI;

  car.x += (Math.cos(car.h) * car.v + car.bx) * dt;
  car.y += (Math.sin(car.h) * car.v + car.by) * dt;
  const fade = Math.exp(-8 * dt);
  car.bx *= fade;
  car.by *= fade;

  let loc = locate(car.x, car.y, car.i);
  const crash = (kind: CarHit["kind"], keep: number, counts: boolean) => {
    const hard = Math.abs(car.v) > 140;
    car.v *= keep;
    if (counts && hard && now - car.lastCrashAt > 700) {
      car.crashes++;
      car.lastCrashAt = now;
    }
    hits.push({ kind, x: car.x, y: car.y, crash: counts && hard });
  };

  // Walls.
  const wall = clampToWalls(car.x, car.y, loc);
  if (wall.hit) {
    // Scraping along a wall at a shallow angle costs less than hitting it head on.
    const into = Math.abs(Math.sin(car.h - RACE_TRACK.h[loc.i]!));
    car.x = wall.x;
    car.y = wall.y;
    const nx = -Math.sin(RACE_TRACK.h[loc.i]!) * -Math.sign(loc.d);
    const ny = Math.cos(RACE_TRACK.h[loc.i]!) * -Math.sign(loc.d);
    car.bx = nx * 90;
    car.by = ny * 90;
    if (into > 0.35) crash("wall", 1 - 0.6 * into, true);
    else car.v *= 0.985;
    loc = locate(car.x, car.y, loc.i);
  }

  // Obstacles, in track space: along and across the road.
  const r = R.car.radius;
  const collide = (id: number, kind: ObstacleKind, s: number, d: number) => {
    const info = OBSTACLE_KINDS[kind];
    const ds = deltaS(loc.s, s);
    const dd = loc.d - d;
    const cs = Math.max(-info.hs, Math.min(info.hs, ds));
    const cd = Math.max(-info.hd, Math.min(info.hd, dd));
    const ps = ds - cs;
    const pd = dd - cd;
    const dist = Math.hypot(ps, pd);
    if (dist >= r) {
      if (car.touched[id] && Math.abs(ds) > info.hs + r + 40) delete car.touched[id];
      return;
    }
    if (!info.solid) {
      if (car.touched[id]) return;
      car.touched[id] = 1;
      crash(kind, info.keep, false);
      car.h += (id % 2 ? 1 : -1) * 0.12;
      return;
    }
    // Push out the short way, and knock the car off it.
    let ns: number;
    let nd: number;
    if (dist > 0.001) {
      ns = ps / dist;
      nd = pd / dist;
    } else if (info.hs - Math.abs(ds) < info.hd - Math.abs(dd)) {
      ns = Math.sign(ds) || 1;
      nd = 0;
    } else {
      ns = 0;
      nd = Math.sign(dd) || 1;
    }
    const push = r - dist + 1;
    const th = RACE_TRACK.h[loc.i]!;
    const wx = Math.cos(th) * ns - Math.sin(th) * nd;
    const wy = Math.sin(th) * ns + Math.cos(th) * nd;
    car.x += wx * push;
    car.y += wy * push;
    car.bx = wx * 160;
    car.by = wy * 160;
    // Only lose speed if driving into it, not when it's the one catching up.
    const into = Math.cos(car.h) * wx + Math.sin(car.h) * wy;
    if (into * Math.sign(car.v) > -0.1 || Math.abs(car.v) < 60) {
      car.v *= 0.97;
      return;
    }
    crash(kind, info.keep, info.crash);
    loc = locate(car.x, car.y, loc.i);
  };
  for (const o of nearbyStatics(course, loc.s)) collide(o.id, o.kind, o.s, o.d);
  for (const mv of moversAt(course, t)) {
    if (Math.abs(deltaS(loc.s, mv.s)) > 120) continue;
    collide(mv.m.id, mv.m.kind, mv.s, mv.d);
  }

  // Oil slicks spin you out (your own is safe).
  for (const sl of slicks) {
    if (sl.owner === myN) continue;
    const near = (car.x - sl.x) ** 2 + (car.y - sl.y) ** 2 < (R.slick.radius + r * 0.5) ** 2;
    const key = -sl.id;
    if (!near) {
      if (car.touched[key]) delete car.touched[key];
      continue;
    }
    if (car.touched[key] || spinning) continue;
    car.touched[key] = 1;
    car.spinUntil = now + R.spinMs;
    car.v *= 0.6;
    hits.push({ kind: "slick", x: car.x, y: car.y, crash: false });
  }

  const after = clampToWalls(car.x, car.y, loc);
  car.x = after.x;
  car.y = after.y;
  loc = locate(car.x, car.y, loc.i);
  car.i = loc.i;
  car.s = loc.s;
  car.d = loc.d;
  return hits;
}

/** Points for finishing in a place, out of this many racers. */
export function racePlacePoints(place: number, racers: number) {
  const R = RACE_RULES;
  return R.placeBase + R.placeStep * Math.max(0, racers - place) + (place === 1 ? R.winBonus : 0);
}
