import { z } from "zod";

/**
 * Core Clash: a real-time, top-down team shooter. Teams race to fill a shared Power bar by
 * knocking out drones, taking down the Titan boss, and tagging players on other teams.
 * Distances are in arena units on a 1600 x 900 board, scaled on each screen.
 */
export const CLASH_RULES = {
  /** How often the server simulates the arena and sends a snapshot. */
  tickMs: 100,
  arena: { width: 1600, height: 900 },

  playerRadius: 18,
  /** Arena units per second. */
  playerSpeed: 230,
  playerHp: 100,
  respawnMs: 3000,
  spawnShieldMs: 1500,
  fireCooldownMs: 220,
  shotSpeed: 720,
  shotRange: 620,
  shotRadius: 5,
  shotDamage: 18,
  /** Health comes back after a while out of combat, and faster at your own base. */
  regenDelayMs: 4000,
  regenPerSec: 8,
  baseHealPerSec: 30,
  baseRadius: 90,
  /** Controls older than this are ignored, so a dropped player stops moving and shooting. */
  inputStaleMs: 1500,

  drone: {
    radius: 15,
    hp: 40,
    speed: 115,
    contactDamage: 12,
    contactCooldownMs: 800,
    aggroRange: 420,
    spawnEveryMs: 2500,
    /** Drones alive at once: base plus one per this many players, up to max. */
    baseCount: 3,
    playersPerExtra: 3,
    maxCount: 12,
    power: 2,
    points: 20,
  },
  titan: {
    radius: 42,
    baseHp: 300,
    hpPerPlayer: 70,
    maxHp: 2400,
    speed: 55,
    /** The Titan never strays further than this from the centre. */
    leash: 240,
    firstSpawnMs: 30_000,
    respawnMs: 40_000,
    attackEveryMs: 2200,
    /** The Titan glows this long before an attack, so players can dodge. */
    telegraphMs: 500,
    ringShots: 12,
    shotSpeed: 320,
    shotDamage: 14,
    contactDamage: 25,
    contactCooldownMs: 1000,
    /** Team Power for the team that did the most damage. */
    power: 25,
    /** Personal points shared among everyone who hit it, by damage. */
    pointsPool: 300,
  },

  eliminationPower: 5,
  eliminationPoints: 50,
  /** Personal points for each member of the winning team. */
  winBonus: 200,

  defaultTeams: 2,
  defaultTarget: 100,
  defaultMinutes: 5,
  teamOptions: [2, 3, 4],
  targetOptions: [60, 100, 150],
  minuteOptions: [3, 5, 8],
} as const;

/** Each team has a shape as well as a colour, so teams can be told apart without colour. */
export const CLASH_TEAMS = [
  { name: "Blaze", shape: "circle" },
  { name: "Tide", shape: "square" },
  { name: "Volt", shape: "triangle" },
  { name: "Nova", shape: "diamond" },
] as const;
export type ClashShape = (typeof CLASH_TEAMS)[number]["shape"];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Cover blocks. The middle is left open for the Titan. */
export const CLASH_WALLS: readonly Rect[] = [
  { x: 380, y: 180, w: 40, h: 200 },
  { x: 380, y: 520, w: 40, h: 200 },
  { x: 1180, y: 180, w: 40, h: 200 },
  { x: 1180, y: 520, w: 40, h: 200 },
  { x: 700, y: 120, w: 200, h: 40 },
  { x: 700, y: 740, w: 200, h: 40 },
  { x: 590, y: 420, w: 60, h: 60 },
  { x: 950, y: 420, w: 60, h: 60 },
];

export const CLASH_CENTER = { x: 800, y: 450 } as const;

/** Where drones appear, away from every base. */
export const CLASH_DRONE_SPAWNS = [
  { x: 800, y: 260 },
  { x: 800, y: 640 },
  { x: 520, y: 300 },
  { x: 1080, y: 600 },
  { x: 520, y: 600 },
  { x: 1080, y: 300 },
] as const;

/** Team bases: left and right for two teams, corners (or three of them plus the bottom) otherwise. */
export function clashBases(teams: number): Array<{ x: number; y: number }> {
  if (teams <= 2)
    return [
      { x: 110, y: 450 },
      { x: 1490, y: 450 },
    ];
  if (teams === 3)
    return [
      { x: 110, y: 110 },
      { x: 1490, y: 110 },
      { x: 800, y: 835 },
    ];
  return [
    { x: 110, y: 110 },
    { x: 1490, y: 110 },
    { x: 110, y: 790 },
    { x: 1490, y: 790 },
  ];
}

export function pointInWall(x: number, y: number): boolean {
  for (const w of CLASH_WALLS) if (x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) return true;
  return false;
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
    teams: z.number().int().min(2).max(4).default(CLASH_RULES.defaultTeams),
    target: z.number().int().min(20).max(300).default(CLASH_RULES.defaultTarget),
    minutes: z.number().int().min(2).max(10).default(CLASH_RULES.defaultMinutes),
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
