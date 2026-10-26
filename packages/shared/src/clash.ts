import { z } from "zod";

/**
 * Core Clash: a real-time, two-team shooter in a war zone, drawn in 3D from behind your soldier.
 * Teams score by tagging the other team (and, with bots on, by taking down drones and the Titan).
 *
 * The simulation is flat: positions are (x, y) on a 2400 x 1400 ground plane, and shots fly
 * level at chest height. Cover blocks have a height only for drawing; every one of them stops
 * movement and shots.
 */
export const CLASH_RULES = {
  /** How often the server simulates the arena and sends a snapshot. */
  tickMs: 100,
  arena: { width: 2400, height: 1400 },

  playerRadius: 18,
  /** Arena units per second. */
  playerSpeed: 260,
  playerHp: 100,
  respawnMs: 4000,
  spawnShieldMs: 2000,
  fireCooldownMs: 160,
  shotSpeed: 1100,
  shotRange: 900,
  shotRadius: 5,
  shotDamage: 20,
  /** Health comes back after a while out of combat, and faster at your own base. */
  regenDelayMs: 4000,
  regenPerSec: 8,
  baseHealPerSec: 30,
  baseRadius: 110,
  /** Controls older than this are ignored, so a dropped player stops moving and shooting. */
  inputStaleMs: 1500,

  /** Bots are optional. With them on, drones roam the war zone and a Titan wakes in the middle. */
  drone: {
    radius: 15,
    hp: 40,
    speed: 115,
    contactDamage: 12,
    contactCooldownMs: 800,
    aggroRange: 420,
    spawnEveryMs: 3000,
    /** Drones alive at once: base plus one per this many players, up to max. */
    baseCount: 3,
    playersPerExtra: 3,
    maxCount: 12,
    power: 1,
    points: 20,
  },
  titan: {
    radius: 42,
    baseHp: 300,
    hpPerPlayer: 70,
    maxHp: 2400,
    speed: 55,
    /** The Titan never strays further than this from the centre. */
    leash: 260,
    firstSpawnMs: 45_000,
    respawnMs: 60_000,
    attackEveryMs: 2200,
    /** The Titan glows this long before an attack, so players can dodge. */
    telegraphMs: 500,
    ringShots: 12,
    shotSpeed: 360,
    shotDamage: 14,
    contactDamage: 25,
    contactCooldownMs: 1000,
    /** Team score for the team that did the most damage. */
    power: 5,
    /** Personal points shared among everyone who hit it, by damage. */
    pointsPool: 300,
  },

  /** Team score for tagging a player on the other team. */
  eliminationPower: 1,
  eliminationPoints: 50,
  /** Personal points for each member of the winning team. */
  winBonus: 200,

  teams: 2,
  defaultTarget: 30,
  defaultMinutes: 5,
  targetOptions: [20, 30, 50],
  minuteOptions: [3, 5, 8],
} as const;

/** Each team has a shape as well as a colour, so teams can be told apart without colour. */
export const CLASH_TEAMS = [
  { name: "Blaze", shape: "circle" },
  { name: "Tide", shape: "square" },
] as const;
export type ClashShape = (typeof CLASH_TEAMS)[number]["shape"];

export type CoverKind = "building" | "wall" | "container" | "crate" | "sandbag";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Cover extends Rect {
  kind: CoverKind;
  /** How tall it is drawn. Every block stops movement and shots whatever its height. */
  height: number;
}

const COVER_HEIGHT: Record<CoverKind, number> = { building: 170, wall: 90, container: 75, crate: 45, sandbag: 40 };
const cover = (kind: CoverKind, x: number, y: number, w: number, h: number, height = COVER_HEIGHT[kind]): Cover => ({
  kind,
  x,
  y,
  w,
  h,
  height,
});

/** One half of the war zone, mirrored onto the other so neither team has the better side. */
const HALF: Cover[] = [
  cover("building", 480, 160, 240, 240),
  cover("building", 480, 1000, 240, 240),
  cover("wall", 880, 140, 40, 240),
  cover("wall", 880, 1020, 40, 240),
  cover("container", 820, 560, 60, 160),
  cover("crate", 360, 580, 50, 50),
  cover("crate", 360, 770, 50, 50),
  cover("sandbag", 640, 640, 30, 120),
  cover("crate", 1000, 420, 50, 50),
  cover("crate", 1000, 930, 50, 50),
  cover("sandbag", 260, 340, 120, 30),
  cover("sandbag", 260, 1030, 120, 30),
];

/** Cover blocks. The plaza in the middle is left open for the Titan. */
export const CLASH_WALLS: readonly Cover[] = [
  ...HALF,
  ...HALF.map((c) => ({ ...c, x: 2400 - c.x - c.w })),
  cover("building", 1120, 50, 160, 150, 130),
  cover("building", 1120, 1200, 160, 150, 130),
  cover("sandbag", 1140, 330, 120, 30),
  cover("sandbag", 1140, 1040, 120, 30),
];

export const CLASH_CENTER = { x: 1200, y: 700 } as const;

/** Where drones appear, away from both bases. */
export const CLASH_DRONE_SPAWNS = [
  { x: 1200, y: 480 },
  { x: 1200, y: 920 },
  { x: 780, y: 300 },
  { x: 1620, y: 1100 },
  { x: 780, y: 1100 },
  { x: 1620, y: 300 },
] as const;

/** Team bases, at either end of the war zone. */
export function clashBases(_teams = 2): Array<{ x: number; y: number }> {
  return [
    { x: 140, y: 700 },
    { x: 2260, y: 700 },
  ];
}

export function pointInWall(x: number, y: number): boolean {
  for (const w of CLASH_WALLS) if (x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) return true;
  return false;
}

/**
 * How far along the straight line from one point to another the first cover block is, from 0 to
 * 1, or 1 if nothing is in the way. Blocks can be grown by `pad`, and ones shorter than
 * `minHeight` left out.
 */
export function coverAlong(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  opts: { pad?: number; minHeight?: number } = {},
): number {
  const pad = opts.pad ?? 0;
  const dx = x2 - x1;
  const dy = y2 - y1;
  let best = 1;
  for (const w of CLASH_WALLS) {
    if (opts.minHeight && w.height < opts.minHeight) continue;
    // Slab test of the segment against the block.
    let t0 = 0;
    let t1 = 1;
    let hit = true;
    for (const [p, q] of [
      [-dx, x1 - (w.x - pad)],
      [dx, w.x + w.w + pad - x1],
      [-dy, y1 - (w.y - pad)],
      [dy, w.y + w.h + pad - y1],
    ] as const) {
      if (p === 0) {
        if (q < 0) hit = false;
        continue;
      }
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
    }
    if (hit && t0 <= t1 && t0 < best) best = t0;
  }
  return best;
}

/** Whether a straight line between two points crosses no cover, for line of sight. */
export function lineClear(x1: number, y1: number, x2: number, y2: number): boolean {
  return coverAlong(x1, y1, x2, y2) >= 1;
}

/**
 * Keeps a circle inside the arena and out of the cover blocks by pushing it out along the
 * shortest way. The server and the client both use this, so predicted movement matches.
 */
export function resolveCircle(x: number, y: number, r: number): { x: number; y: number } {
  const { width, height } = CLASH_RULES.arena;
  for (let pass = 0; pass < 2; pass++) {
    for (const w of CLASH_WALLS) {
      const cx = Math.max(w.x, Math.min(x, w.x + w.w));
      const cy = Math.max(w.y, Math.min(y, w.y + w.h));
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r * r) continue;
      if (d2 > 0) {
        const d = Math.sqrt(d2);
        x = cx + (dx / d) * r;
        y = cy + (dy / d) * r;
      } else {
        // The centre is inside the block: leave by the nearest edge.
        const exits = [
          { d: x - w.x, x: w.x - r, y },
          { d: w.x + w.w - x, x: w.x + w.w + r, y },
          { d: y - w.y, x, y: w.y - r },
          { d: w.y + w.h - y, x, y: w.y + w.h + r },
        ].sort((a, b) => a.d - b.d);
        x = exits[0]!.x;
        y = exits[0]!.y;
      }
    }
    x = Math.max(r, Math.min(width - r, x));
    y = Math.max(r, Math.min(height - r, y));
  }
  return { x, y };
}

export const clashSessionConfigSchema = z
  .object({
    target: z.number().int().min(5).max(100).default(CLASH_RULES.defaultTarget),
    minutes: z.number().int().min(2).max(10).default(CLASH_RULES.defaultMinutes),
    /** Drones and the Titan join the fight. */
    bots: z.boolean().default(false),
  })
  .strict();
export type ClashSessionConfig = z.input<typeof clashSessionConfigSchema>;

/**
 * Held controls, streamed with `game:input`. Movement is predicted on the client, which sends
 * where it thinks the player is; the server only accepts it within the player's top speed and
 * outside walls. Hits, damage and scoring are worked out on the server alone.
 */
export const clashInputSchema = z
  .object({
    /** Predicted position. */
    x: z.number().finite(),
    y: z.number().finite(),
    /** Aim angle in radians. */
    a: z.number().finite().min(-10).max(10),
    /** Trigger held. */
    f: z.boolean(),
    /** Shot counter: a change fires once, so a quick tap between snapshots still shoots. */
    s: z.number().int().min(0).max(1_000_000_000),
    /** The life the client is on. Positions from before a respawn are ignored. */
    l: z.number().int().min(0).max(1_000_000),
  })
  .strict();
export type ClashInput = z.infer<typeof clashInputSchema>;

/** Bits in a player's snapshot flags. */
export const CLASH_FLAG = { alive: 1, shield: 2, hurt: 4, firing: 8 } as const;

/**
 * One player in a snapshot: number, x, y, aim (centiradians), health, flags, life, personal
 * points, and tenths of a second until respawn.
 */
export type ClashPlayerTuple = [
  n: number,
  x: number,
  y: number,
  a: number,
  hp: number,
  flags: number,
  life: number,
  pts: number,
  respawn: number,
];
/** kind: 0 drone, 1 Titan. flags: 1 hurt this tick, 2 about to attack. */
export type ClashNpcTuple = [id: number, kind: 0 | 1, x: number, y: number, hp: number, maxHp: number, flags: number];
/** A shot fired this tick. team is -1 for a Titan's shots. t0 is the server time it was fired. */
export type ClashShotTuple = [
  id: number,
  x: number,
  y: number,
  vx: number,
  vy: number,
  team: number,
  t0: number,
  owner: number,
];
/** Who knocked out what. by is a player number, or -1 for an NPC. what: 0 player, 1 drone, 2 Titan. */
export type ClashFeedTuple = [by: number, what: 0 | 1 | 2, victim: number, team: number];

/** Sent every tick as a game event. Public: a shooter has no secrets. */
export interface ClashSnapshot {
  type: "snap";
  now: number;
  power: number[];
  players: ClashPlayerTuple[];
  npcs: ClashNpcTuple[];
  /** Shots fired since the last snapshot. Clients move them along their path between snapshots. */
  shots: ClashShotTuple[];
  /** Shots that hit something or ran out of range. */
  gone: number[];
  feed: ClashFeedTuple[];
}

export interface ClashPlayerStats {
  userId: string;
  n: number;
  team: number;
  eliminations: number;
  deaths: number;
  drones: number;
  titanDamage: number;
  points: number;
}

/** Pushed with session state, on start, roster changes and at the end. Fast-moving data is in snapshots. */
export interface ClashView {
  teamCount: number;
  /** Whether drones and the Titan are in the fight. */
  bots: boolean;
  target: number;
  durationSec: number;
  endsAt: number;
  serverNow: number;
  power: number[];
  players: ClashPlayerStats[];
  /** You, if you're playing. */
  me: { n: number; team: number } | null;
  isPlayer: boolean;
  /** Set once the game is over. winner is null for a draw. */
  outcome: { winner: number | null; reason: "target" | "time" | "ended" } | null;
}
