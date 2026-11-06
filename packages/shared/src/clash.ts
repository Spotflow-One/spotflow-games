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
  /**
   * A dodge is a quick roll: a short dash during which shots pass straight through you. You
   * can't shoot while rolling, and it takes a moment to be ready again.
   */
  dodge: { distance: 190, ms: 280, cooldownMs: 2200 },
  /**
   * Crouching: you walk slower, but you're a smaller target, and enemies close by can't hear you
   * on their minimap.
   */
  crouch: { speed: 0.45, hitRadius: 11 },
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

  /**
   * Power-ups wait at fixed spots and come back a while after someone takes one. A medkit heals
   * (and is left alone at full health), overdrive makes your shots hit harder, and haste makes
   * you run faster.
   */
  pickup: {
    radius: 24,
    medkitHeal: 50,
    overdrive: { ms: 10_000, damageMult: 1.5 },
    haste: { ms: 8_000, speedMult: 1.35 },
    respawnMs: { medkit: 15_000, overdrive: 35_000, haste: 20_000 },
  },

  /**
   * A grenade is lobbed the way you aim, lands where it reaches (or against cover), and goes off
   * after its fuse. It hurts enemies and bots in the blast that cover doesn't shield, most at the
   * middle. Teammates and the thrower are safe.
   */
  grenade: {
    throwRange: 480,
    speed: 650,
    fuseMs: 1100,
    cooldownMs: 9000,
    blastRadius: 140,
    maxDamage: 60,
    minDamage: 20,
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

export type ClashWeaponId = "rifle" | "shotgun" | "sniper";

/**
 * Loadouts. Pick one with 1, 2 or 3; it is yours at once at your own base, otherwise from your
 * next life. Each pellet of a shotgun blast is its own shot.
 */
export const CLASH_WEAPONS: ReadonlyArray<{
  id: ClashWeaponId;
  name: string;
  blurb: string;
  damage: number;
  cooldownMs: number;
  speed: number;
  range: number;
  pellets: number;
  /** Radians between the outermost pellets. */
  spread: number;
}> = [
  {
    id: "rifle",
    name: "Rifle",
    blurb: "Steady all-rounder",
    damage: 20,
    cooldownMs: 160,
    speed: 1100,
    range: 900,
    pellets: 1,
    spread: 0,
  },
  {
    id: "shotgun",
    name: "Shotgun",
    blurb: "Five pellets, up close",
    damage: 11,
    cooldownMs: 700,
    speed: 1000,
    range: 430,
    pellets: 5,
    spread: 0.36,
  },
  {
    id: "sniper",
    name: "Sniper",
    blurb: "One heavy shot, long range",
    damage: 65,
    cooldownMs: 1100,
    speed: 2400,
    range: 1700,
    pellets: 1,
    spread: 0,
  },
];
/** The weapon a player holds is in bits 8 and 9 of their snapshot flags. */
export const CLASH_WEAPON_SHIFT = 8;
export const clashWeaponOf = (flags: number) => CLASH_WEAPONS[(flags >> CLASH_WEAPON_SHIFT) & 3] ?? CLASH_WEAPONS[0]!;

/** Each team has a shape as well as a colour, so teams can be told apart without colour. */
export const CLASH_TEAMS = [
  { name: "Blaze", shape: "circle" },
  { name: "Tide", shape: "square" },
] as const;
export type ClashShape = (typeof CLASH_TEAMS)[number]["shape"];

export type CoverKind =
  | "building"
  | "wall"
  | "container"
  | "crate"
  | "sandbag"
  // Forest
  | "tree"
  | "rock"
  | "log"
  | "cabin"
  // Factory
  | "hall"
  | "tank"
  | "machine"
  | "pipe";

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

const COVER_HEIGHT: Record<CoverKind, number> = {
  building: 170,
  wall: 90,
  container: 75,
  crate: 45,
  sandbag: 40,
  tree: 260,
  rock: 60,
  log: 36,
  cabin: 140,
  hall: 165,
  tank: 190,
  machine: 80,
  pipe: 44,
};
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

/**
 * Builds a whole layout from its top-left quarter, mirrored top to bottom and then left to right,
 * plus pieces that sit on the middle lines (given once, left of or across the centre line, and
 * mirrored only where that makes a copy).
 */
function mirrored(quarter: Cover[], middle: Cover[]): Cover[] {
  const half = [...quarter, ...quarter.map((c) => ({ ...c, y: 1400 - c.y - c.h }))];
  const leftHalf = [...half, ...middle.filter((c) => c.x + c.w <= 1200)];
  const across = middle.filter((c) => c.x + c.w > 1200);
  return [...leftHalf, ...leftHalf.map((c) => ({ ...c, x: 2400 - c.x - c.w })), ...across];
}

/**
 * A pine forest: thick trunks to hide behind, boulders, fallen logs and two log cabins on each
 * side, with a stone clearing in the middle.
 */
const FOREST_WALLS: readonly Cover[] = mirrored(
  [
    cover("cabin", 470, 150, 220, 190),
    cover("tree", 320, 200, 40, 40),
    cover("tree", 770, 160, 40, 40),
    cover("tree", 450, 500, 40, 40),
    cover("tree", 720, 560, 40, 40),
    cover("tree", 1010, 300, 40, 40),
    cover("tree", 230, 420, 40, 40),
    cover("tree", 880, 380, 36, 36),
    cover("rock", 860, 140, 80, 60),
    cover("log", 240, 320, 130, 28),
  ],
  [
    cover("rock", 350, 650, 60, 100),
    cover("log", 630, 640, 30, 120),
    cover("rock", 820, 610, 70, 180),
    cover("cabin", 1120, 1220, 160, 130, 120),
    cover("log", 1140, 330, 120, 28),
    cover("log", 1140, 1042, 120, 28),
    cover("tree", 1180, 140, 40, 40),
    cover("tree", 1060, 70, 40, 40),
  ],
);

/**
 * A factory floor: two halls at each end, silos, machines, a pipeline, stacked containers and
 * pallets, with a loading bay in the middle.
 */
const FACTORY_WALLS: readonly Cover[] = mirrored(
  [
    cover("hall", 470, 140, 250, 220),
    cover("tank", 860, 140, 90, 90),
    cover("machine", 320, 520, 100, 70),
    cover("pipe", 240, 320, 150, 26),
    cover("crate", 980, 380, 50, 50),
    cover("crate", 760, 450, 50, 50),
    cover("wall", 900, 280, 160, 30),
  ],
  [
    cover("container", 820, 600, 60, 200),
    cover("pipe", 610, 620, 30, 160),
    cover("hall", 1100, 40, 200, 150, 150),
    cover("hall", 1100, 1210, 200, 150, 150),
    cover("pipe", 1130, 340, 140, 26),
    cover("pipe", 1130, 1034, 140, 26),
  ],
);

export type ClashScenery = "warzone" | "forest" | "factory";

/** The places a match can be fought in, picked by the host. Each has its own cover. */
export const CLASH_SCENERIES: ReadonlyArray<{ id: ClashScenery; name: string; blurb: string }> = [
  { id: "warzone", name: "War zone", blurb: "Ruined buildings, containers and sandbags at sunset" },
  { id: "forest", name: "Forest", blurb: "Tall pines, boulders, fallen logs and log cabins" },
  { id: "factory", name: "Factory", blurb: "Halls, silos, machines and pipes on a factory floor" },
];
export const CLASH_SCENERY_IDS = ["warzone", "forest", "factory"] as const satisfies readonly ClashScenery[];

const WALLS_BY_SCENERY: Record<ClashScenery, readonly Cover[]> = {
  warzone: CLASH_WALLS,
  forest: FOREST_WALLS,
  factory: FACTORY_WALLS,
};

/** The cover blocks of a scenery. Unknown or missing sceneries are the war zone. */
export function clashWalls(scenery?: ClashScenery | string | null): readonly Cover[] {
  return scenery && Object.hasOwn(WALLS_BY_SCENERY, scenery) ? WALLS_BY_SCENERY[scenery as ClashScenery] : CLASH_WALLS;
}

export const CLASH_CENTER = { x: 1200, y: 700 } as const;

export type ClashPickupKind = "medkit" | "overdrive" | "haste";

/**
 * Power-up spots. Medkits sit just out of each base, haste in the open lanes top and bottom, and
 * the one overdrive in the middle of the plaza, worth fighting over.
 */
export const CLASH_PICKUPS: ReadonlyArray<{ kind: ClashPickupKind; x: number; y: number }> = [
  { kind: "medkit", x: 600, y: 470 },
  { kind: "medkit", x: 600, y: 930 },
  { kind: "medkit", x: 1800, y: 470 },
  { kind: "medkit", x: 1800, y: 930 },
  { kind: "haste", x: 1200, y: 265 },
  { kind: "haste", x: 1200, y: 1135 },
  { kind: "overdrive", x: 1200, y: 700 },
];

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

export function pointInWall(x: number, y: number, walls: readonly Cover[] = CLASH_WALLS): boolean {
  for (const w of walls) if (x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) return true;
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
  opts: { pad?: number; minHeight?: number; walls?: readonly Cover[] } = {},
): number {
  const pad = opts.pad ?? 0;
  const dx = x2 - x1;
  const dy = y2 - y1;
  let best = 1;
  for (const w of opts.walls ?? CLASH_WALLS) {
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
export function lineClear(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  walls: readonly Cover[] = CLASH_WALLS,
): boolean {
  return coverAlong(x1, y1, x2, y2, { walls }) >= 1;
}

/**
 * Keeps a circle inside the arena and out of the cover blocks by pushing it out along the
 * shortest way. The server and the client both use this, so predicted movement matches.
 */
export function resolveCircle(
  x: number,
  y: number,
  r: number,
  walls: readonly Cover[] = CLASH_WALLS,
): { x: number; y: number } {
  const { width, height } = CLASH_RULES.arena;
  for (let pass = 0; pass < 2; pass++) {
    for (const w of walls) {
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
    /** Where the match is fought. */
    scenery: z.enum(CLASH_SCENERY_IDS).default("warzone"),
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
    /** Dodge counter: a change starts a roll, if one is ready. */
    d: z.number().int().min(0).max(1_000_000_000).optional(),
    /** Crouching. */
    c: z.boolean().optional(),
    /** The weapon wanted, by index in CLASH_WEAPONS. */
    w: z.number().int().min(0).max(2).optional(),
    /** Grenade counter: a change throws one, if one is ready. */
    g: z.number().int().min(0).max(1_000_000_000).optional(),
  })
  .strict();
export type ClashInput = z.infer<typeof clashInputSchema>;

/** Bits in a player's snapshot flags. */
export const CLASH_FLAG = {
  alive: 1,
  shield: 2,
  hurt: 4,
  firing: 8,
  dodge: 16,
  crouch: 32,
  overdrive: 64,
  haste: 128,
} as const;

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
/**
 * A grenade thrown this tick: id, where from, where it lands, the server time it was thrown, when
 * it lands, when it goes off, and the thrower's team.
 */
export type ClashGrenadeTuple = [
  id: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  t0: number,
  landAt: number,
  boomAt: number,
  team: number,
];
/** A grenade going off this tick: id, where, and the thrower's team. */
export type ClashBoomTuple = [id: number, x: number, y: number, team: number];
/** A power-up taken this tick: the player's number and the spot's index in CLASH_PICKUPS. */
export type ClashGrabTuple = [n: number, spot: number];
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
  /**
   * For each spot in CLASH_PICKUPS, tenths of a second until its power-up is back; 0 while it is
   * waiting to be taken. Missing from servers that predate power-ups.
   */
  items?: number[];
  /** Power-ups taken this tick. */
  grabs?: ClashGrabTuple[];
  grenades?: ClashGrenadeTuple[];
  booms?: ClashBoomTuple[];
}

export interface ClashPlayerStats {
  userId: string;
  n: number;
  team: number;
  eliminations: number;
  deaths: number;
  drones: number;
  titanDamage: number;
  /** Power-ups taken. */
  pickups?: number;
  points: number;
}

/** Pushed with session state, on start, roster changes and at the end. Fast-moving data is in snapshots. */
export interface ClashView {
  teamCount: number;
  /** Whether drones and the Titan are in the fight. */
  bots: boolean;
  /** Where the match is fought. Missing from servers that predate sceneries: the war zone. */
  scenery?: ClashScenery;
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
