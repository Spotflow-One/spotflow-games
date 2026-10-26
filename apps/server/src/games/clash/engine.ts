import { randomInt } from "node:crypto";
import {
  CLASH_CENTER,
  CLASH_DRONE_SPAWNS,
  CLASH_FLAG,
  CLASH_RULES as R,
  clashBases,
  clashInputSchema,
  clashSessionConfigSchema,
  pointInWall,
  resolveCircle,
  type ClashFeedTuple,
  type ClashSnapshot,
  type ClashShotTuple,
  type ClashView,
} from "@spotflow-games/shared";
import { GameError, type GameContext, type GameEngine } from "../contract.js";

export interface ClashConfig {
  teams: number;
  target: number;
  minutes: number;
}

interface Fighter {
  userId: string;
  /** Short number used in snapshots instead of the user id. */
  n: number;
  team: number;
  x: number;
  y: number;
  /** Aim in radians. */
  a: number;
  hp: number;
  alive: boolean;
  /** Goes up on every respawn, so the client knows to stop predicting from its old position. */
  life: number;
  respawnAt: number;
  shieldUntil: number;
  lastShotAt: number;
  /** Last shot counter seen from the client. */
  lastS: number;
  lastHurtAt: number;
  lastMoveAt: number;
  firing: boolean;
  eliminations: number;
  deaths: number;
  drones: number;
  titanDamage: number;
  points: number;
}

interface Npc {
  id: number;
  kind: 0 | 1;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  /** Where a drone with nobody to chase is drifting to. */
  wanderX: number;
  wanderY: number;
  contactAt: number;
  attackAt: number;
  telegraphAt: number;
  ringNext: boolean;
  /** Titan damage by player, to share out points and Power. */
  damageBy: Record<string, number>;
}

interface Shot {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** -1 for NPC shots. */
  team: number;
  ownerId: string | null;
  damage: number;
  expiresAt: number;
}

interface ClashState {
  config: ClashConfig;
  endsAt: number;
  lastTick: number;
  nextId: number;
  nextN: number;
  fighters: Map<string, Fighter>;
  npcs: Npc[];
  shots: Shot[];
  power: number[];
  nextDroneAt: number;
  /** When the next Titan appears, or 0 while one is alive. */
  titanAt: number;
  outcome: ClashView["outcome"];
}

/** What one tick produced for its snapshot. Not stored. */
interface TickOut {
  shots: ClashShotTuple[];
  gone: number[];
  feed: ClashFeedTuple[];
  hurt: Set<string | number>;
}

const SUBSTEPS = 4;
const round = (v: number) => Math.round(v);
const dist2 = (ax: number, ay: number, bx: number, by: number) => (ax - bx) ** 2 + (ay - by) ** 2;

export function createClashEngine() {
  const teamSizes = (state: ClashState) => {
    const sizes = new Array<number>(state.config.teams).fill(0);
    for (const f of state.fighters.values()) sizes[f.team]!++;
    return sizes;
  };

  const spawnPoint = (state: ClashState, team: number) => {
    const base = clashBases(state.config.teams)[team]!;
    const angle = (randomInt(360) * Math.PI) / 180;
    const r = randomInt(50);
    return resolveCircle(base.x + Math.cos(angle) * r, base.y + Math.sin(angle) * r, R.playerRadius);
  };

  const respawn = (ctx: GameContext, state: ClashState, f: Fighter) => {
    const p = spawnPoint(state, f.team);
    f.x = p.x;
    f.y = p.y;
    f.hp = R.playerHp;
    f.alive = true;
    f.life++;
    f.shieldUntil = ctx.now() + R.spawnShieldMs;
    f.lastMoveAt = ctx.now();
    f.lastHurtAt = 0;
  };

  const addFighter = (ctx: GameContext, state: ClashState, userId: string, team: number) => {
    const f: Fighter = {
      userId,
      n: state.nextN++,
      team,
      x: 0,
      y: 0,
      a: 0,
      hp: R.playerHp,
      alive: false,
      life: 0,
      respawnAt: 0,
      shieldUntil: 0,
      lastShotAt: 0,
      lastS: -1,
      lastHurtAt: 0,
      lastMoveAt: 0,
      firing: false,
      eliminations: 0,
      deaths: 0,
      drones: 0,
      titanDamage: 0,
      points: 0,
    };
    state.fighters.set(userId, f);
    respawn(ctx, state, f);
    // Face the middle of the arena.
    f.a = Math.atan2(CLASH_CENTER.y - f.y, CLASH_CENTER.x - f.x);
    return f;
  };

  /** Late joiners go to the smallest team. */
  const syncRoster = (ctx: GameContext, state: ClashState) => {
    let changed = false;
    for (const id of ctx.players()) {
      if (state.fighters.has(id)) continue;
      const sizes = teamSizes(state);
      addFighter(ctx, state, id, sizes.indexOf(Math.min(...sizes)));
      changed = true;
    }
    if (changed) ctx.broadcastState();
  };

  const isShielded = (ctx: GameContext, f: Fighter) => ctx.now() < f.shieldUntil;

  const fire = (ctx: GameContext, state: ClashState, f: Fighter, out: TickOut) => {
    const now = ctx.now();
    f.lastShotAt = now;
    const start = R.playerRadius + 4;
    const x = f.x + Math.cos(f.a) * start;
    const y = f.y + Math.sin(f.a) * start;
    if (pointInWall(x, y)) return;
    addShot(state, out, now, {
      x,
      y,
      vx: Math.cos(f.a) * R.shotSpeed,
      vy: Math.sin(f.a) * R.shotSpeed,
      team: f.team,
      ownerId: f.userId,
      ownerN: f.n,
      damage: R.shotDamage,
      rangeMs: (R.shotRange / R.shotSpeed) * 1000,
    });
  };

  const addShot = (
    state: ClashState,
    out: TickOut,
    now: number,
    s: Omit<Shot, "id" | "expiresAt"> & { ownerN: number; rangeMs: number },
  ) => {
    const id = state.nextId++;
    state.shots.push({
      id,
      x: s.x,
      y: s.y,
      vx: s.vx,
      vy: s.vy,
      team: s.team,
      ownerId: s.ownerId,
      damage: s.damage,
      expiresAt: now + s.rangeMs,
    });
    out.shots.push([id, round(s.x), round(s.y), round(s.vx), round(s.vy), s.team, now, s.ownerN]);
  };

  /** Applies damage to a player. `by` is the shooter, or null for an NPC. */
  const hurtFighter = (
    ctx: GameContext,
    state: ClashState,
    f: Fighter,
    damage: number,
    by: Fighter | null,
    out: TickOut,
  ) => {
    if (!f.alive || isShielded(ctx, f)) return;
    f.hp -= damage;
    f.lastHurtAt = ctx.now();
    out.hurt.add(f.userId);
    if (f.hp > 0) return;
    f.hp = 0;
    f.alive = false;
    f.firing = false;
    f.deaths++;
    f.respawnAt = ctx.now() + R.respawnMs;
    if (by) {
      by.eliminations++;
      by.points += R.eliminationPoints;
      state.power[by.team]! += R.eliminationPower;
    }
    out.feed.push([by?.n ?? -1, 0, f.n, by?.team ?? -1]);
  };

  const hurtNpc = (ctx: GameContext, state: ClashState, npc: Npc, damage: number, by: Fighter, out: TickOut) => {
    if (npc.hp <= 0) return;
    const dealt = Math.min(damage, npc.hp);
    npc.hp -= damage;
    out.hurt.add(npc.id);
    if (npc.kind === 1) {
      npc.damageBy[by.userId] = (npc.damageBy[by.userId] ?? 0) + dealt;
      by.titanDamage += dealt;
    }
    if (npc.hp > 0) return;
    if (npc.kind === 0) {
      by.drones++;
      by.points += R.drone.points;
      state.power[by.team]! += R.drone.power;
      out.feed.push([by.n, 1, npc.id, by.team]);
      return;
    }
    // The Titan's Power goes to the team that did the most damage, so teamwork beats a lucky last hit.
    const teamDamage = new Array<number>(state.config.teams).fill(0);
    for (const [userId, dmg] of Object.entries(npc.damageBy)) {
      const f = state.fighters.get(userId);
      if (!f) continue;
      teamDamage[f.team]! += dmg;
      f.points += Math.floor((R.titan.pointsPool * dmg) / npc.maxHp);
    }
    const best = Math.max(...teamDamage);
    const winners = teamDamage.flatMap((d, i) => (d === best ? [i] : []));
    // A dead heat goes to the team that landed the final blow.
    const team = winners.includes(by.team) ? by.team : winners[0]!;
    state.power[team]! += R.titan.power;
    state.titanAt = ctx.now() + R.titan.respawnMs;
    out.feed.push([by.n, 2, npc.id, team]);
  };

  const applyInputs = (ctx: GameContext, state: ClashState, out: TickOut) => {
    const now = ctx.now();
    const inputs = ctx.inputs();
    for (const f of state.fighters.values()) {
      const raw = inputs.get(f.userId);
      const fresh = raw && now - raw.at <= R.inputStaleMs;
      const parsed = fresh ? clashInputSchema.safeParse(raw.value) : null;
      if (!f.alive || !parsed?.success) {
        f.firing = false;
        f.lastMoveAt = now;
        continue;
      }
      const input = parsed.data;
      f.a = input.a;
      // Accept the client's position only within top speed (with slack for network jitter).
      if (input.l === f.life) {
        const allowed = R.playerSpeed * ((now - f.lastMoveAt) / 1000) * 1.6 + 6;
        let dx = input.x - f.x;
        let dy = input.y - f.y;
        const d = Math.hypot(dx, dy);
        if (d > allowed) {
          dx = (dx / d) * allowed;
          dy = (dy / d) * allowed;
        }
        const p = resolveCircle(f.x + dx, f.y + dy, R.playerRadius);
        f.x = p.x;
        f.y = p.y;
      }
      f.lastMoveAt = now;
      const tapped = f.lastS >= 0 && input.s !== f.lastS;
      f.lastS = input.s;
      f.firing = input.f;
      if ((input.f || tapped) && now - f.lastShotAt >= R.fireCooldownMs) fire(ctx, state, f, out);
    }
  };

  const moveShots = (ctx: GameContext, state: ClashState, dt: number, out: TickOut) => {
    const now = ctx.now();
    const kept: Shot[] = [];
    shots: for (const s of state.shots) {
      for (let i = 0; i < SUBSTEPS; i++) {
        s.x += (s.vx * dt) / SUBSTEPS;
        s.y += (s.vy * dt) / SUBSTEPS;
        if (pointInWall(s.x, s.y) || s.x < 0 || s.y < 0 || s.x > R.arena.width || s.y > R.arena.height) {
          out.gone.push(s.id);
          continue shots;
        }
        const owner = s.ownerId ? state.fighters.get(s.ownerId) : undefined;
        for (const f of state.fighters.values()) {
          if (!f.alive || f.team === s.team) continue;
          if (dist2(s.x, s.y, f.x, f.y) > (R.playerRadius + R.shotRadius) ** 2) continue;
          // A spawn shield soaks up the shot.
          hurtFighter(ctx, state, f, s.damage, owner ?? null, out);
          out.gone.push(s.id);
          continue shots;
        }
        if (s.team >= 0 && owner) {
          for (const npc of state.npcs) {
            const r = npc.kind === 1 ? R.titan.radius : R.drone.radius;
            if (npc.hp <= 0 || dist2(s.x, s.y, npc.x, npc.y) > (r + R.shotRadius) ** 2) continue;
            hurtNpc(ctx, state, npc, s.damage, owner, out);
            out.gone.push(s.id);
            continue shots;
          }
        }
      }
      if (now >= s.expiresAt) out.gone.push(s.id);
      else kept.push(s);
    }
    state.shots = kept;
  };

  const nearestFighter = (state: ClashState, x: number, y: number, range: number, now: number) => {
    let best: Fighter | null = null;
    let bestD = range * range;
    for (const f of state.fighters.values()) {
      if (!f.alive || now < f.shieldUntil) continue;
      const d = dist2(x, y, f.x, f.y);
      if (d < bestD) {
        best = f;
        bestD = d;
      }
    }
    return best;
  };

  const runNpcs = (ctx: GameContext, state: ClashState, dt: number, out: TickOut) => {
    const now = ctx.now();
    for (const npc of state.npcs) {
      if (npc.hp <= 0) continue;
      const titan = npc.kind === 1;
      const radius = titan ? R.titan.radius : R.drone.radius;
      const speed = titan ? R.titan.speed : R.drone.speed;
      const target = nearestFighter(state, npc.x, npc.y, titan ? R.titan.leash + 300 : R.drone.aggroRange, now);
      let tx = target?.x ?? npc.wanderX;
      let ty = target?.y ?? npc.wanderY;
      if (titan && dist2(tx, ty, CLASH_CENTER.x, CLASH_CENTER.y) > R.titan.leash ** 2) {
        const ang = Math.atan2(ty - CLASH_CENTER.y, tx - CLASH_CENTER.x);
        tx = CLASH_CENTER.x + Math.cos(ang) * R.titan.leash;
        ty = CLASH_CENTER.y + Math.sin(ang) * R.titan.leash;
      }
      const d = Math.hypot(tx - npc.x, ty - npc.y);
      if (d > 2) {
        const step = Math.min(d, speed * dt);
        const p = resolveCircle(npc.x + ((tx - npc.x) / d) * step, npc.y + ((ty - npc.y) / d) * step, radius);
        npc.x = p.x;
        npc.y = p.y;
      } else if (!target && !titan) {
        pickWander(npc);
      }
      // Bumping into players hurts them.
      const cooldown = titan ? R.titan.contactCooldownMs : R.drone.contactCooldownMs;
      if (now - npc.contactAt >= cooldown) {
        for (const f of state.fighters.values()) {
          if (!f.alive || dist2(npc.x, npc.y, f.x, f.y) > (radius + R.playerRadius + 2) ** 2) continue;
          hurtFighter(ctx, state, f, titan ? R.titan.contactDamage : R.drone.contactDamage, null, out);
          npc.contactAt = now;
        }
      }
      if (titan) titanAttack(ctx, state, npc, out);
    }
    state.npcs = state.npcs.filter((n) => n.hp > 0);
  };

  const pickWander = (npc: Npc) => {
    npc.wanderX = 300 + randomInt(1000);
    npc.wanderY = 150 + randomInt(600);
  };

  /** Alternates a ring of shots with an aimed burst at whoever is closest, after a visible wind-up. */
  const titanAttack = (ctx: GameContext, state: ClashState, npc: Npc, out: TickOut) => {
    const now = ctx.now();
    if (now < npc.attackAt) return;
    if (!npc.telegraphAt) {
      npc.telegraphAt = now + R.titan.telegraphMs;
      return;
    }
    if (now < npc.telegraphAt) return;
    npc.telegraphAt = 0;
    npc.attackAt = now + R.titan.attackEveryMs;
    const shot = (angle: number) => {
      const start = R.titan.radius + 6;
      addShot(state, out, now, {
        x: npc.x + Math.cos(angle) * start,
        y: npc.y + Math.sin(angle) * start,
        vx: Math.cos(angle) * R.titan.shotSpeed,
        vy: Math.sin(angle) * R.titan.shotSpeed,
        team: -1,
        ownerId: null,
        ownerN: -1,
        damage: R.titan.shotDamage,
        rangeMs: 2500,
      });
    };
    const target = nearestFighter(state, npc.x, npc.y, 700, now);
    if (npc.ringNext || !target) {
      const offset = (randomInt(360) * Math.PI) / 180;
      for (let i = 0; i < R.titan.ringShots; i++) shot(offset + (i / R.titan.ringShots) * Math.PI * 2);
    } else {
      const aim = Math.atan2(target.y - npc.y, target.x - npc.x);
      for (const spread of [-0.18, 0, 0.18]) shot(aim + spread);
    }
    npc.ringNext = !npc.ringNext;
  };

  const spawnNpcs = (ctx: GameContext, state: ClashState) => {
    const now = ctx.now();
    const players = state.fighters.size;
    const drones = state.npcs.filter((n) => n.kind === 0).length;
    const cap = Math.min(R.drone.maxCount, R.drone.baseCount + Math.ceil(players / R.drone.playersPerExtra));
    if (drones < cap && now >= state.nextDroneAt) {
      state.nextDroneAt = now + R.drone.spawnEveryMs;
      // Pick a spawn point nobody is standing near.
      const open = CLASH_DRONE_SPAWNS.filter((p) =>
        [...state.fighters.values()].every((f) => !f.alive || dist2(p.x, p.y, f.x, f.y) > 160 ** 2),
      );
      const at = open[randomInt(Math.max(1, open.length))] ?? CLASH_DRONE_SPAWNS[0];
      if (open.length) state.npcs.push(makeNpc(state, 0, at.x, at.y, R.drone.hp));
    }
    if (state.titanAt && now >= state.titanAt) {
      state.titanAt = 0;
      const hp = Math.min(R.titan.maxHp, R.titan.baseHp + R.titan.hpPerPlayer * players);
      const titan = makeNpc(state, 1, CLASH_CENTER.x, CLASH_CENTER.y, hp);
      titan.attackAt = now + 1500;
      state.npcs.push(titan);
    }
  };

  const makeNpc = (state: ClashState, kind: 0 | 1, x: number, y: number, hp: number): Npc => {
    const npc: Npc = {
      id: state.nextId++,
      kind,
      x,
      y,
      hp,
      maxHp: hp,
      wanderX: x,
      wanderY: y,
      contactAt: 0,
      attackAt: 0,
      telegraphAt: 0,
      ringNext: true,
      damageBy: {},
    };
    if (kind === 0) pickWander(npc);
    return npc;
  };

  const heal = (ctx: GameContext, state: ClashState, dt: number) => {
    const now = ctx.now();
    const bases = clashBases(state.config.teams);
    for (const f of state.fighters.values()) {
      if (!f.alive || f.hp >= R.playerHp) continue;
      const base = bases[f.team]!;
      const atBase = dist2(f.x, f.y, base.x, base.y) <= R.baseRadius ** 2;
      const rate = atBase ? R.baseHealPerSec : now - f.lastHurtAt >= R.regenDelayMs ? R.regenPerSec : 0;
      f.hp = Math.min(R.playerHp, f.hp + rate * dt);
    }
  };

  const snapshot = (ctx: GameContext, state: ClashState, out: TickOut): ClashSnapshot => {
    const now = ctx.now();
    return {
      type: "snap",
      now,
      power: [...state.power],
      players: [...state.fighters.values()].map((f) => [
        f.n,
        round(f.x),
        round(f.y),
        round(f.a * 100),
        Math.ceil(f.hp),
        (f.alive ? CLASH_FLAG.alive : 0) |
          (f.alive && now < f.shieldUntil ? CLASH_FLAG.shield : 0) |
          (out.hurt.has(f.userId) ? CLASH_FLAG.hurt : 0) |
          (f.firing ? CLASH_FLAG.firing : 0),
        f.life,
        f.points,
        f.alive ? 0 : Math.max(0, Math.ceil((f.respawnAt - now) / 100)),
      ]),
      npcs: state.npcs.map((n) => [
        n.id,
        n.kind,
        round(n.x),
        round(n.y),
        Math.ceil(n.hp),
        n.maxHp,
        (out.hurt.has(n.id) ? 1 : 0) | (n.telegraphAt ? 2 : 0),
      ]),
      shots: out.shots,
      gone: out.gone,
      feed: out.feed,
    };
  };

  const tick = (ctx: GameContext, state: ClashState) => {
    const now = ctx.now();
    // A late timer must not teleport everything, so cap the step.
    const dt = Math.min(0.25, Math.max(0, (now - state.lastTick) / 1000));
    state.lastTick = now;
    const out: TickOut = { shots: [], gone: [], feed: [], hurt: new Set() };

    syncRoster(ctx, state);
    for (const f of state.fighters.values()) if (!f.alive && now >= f.respawnAt) respawn(ctx, state, f);
    applyInputs(ctx, state, out);
    moveShots(ctx, state, dt, out);
    runNpcs(ctx, state, dt, out);
    heal(ctx, state, dt);
    spawnNpcs(ctx, state);

    ctx.emitEvent(snapshot(ctx, state, out));
    const leader = state.power.findIndex((p) => p >= state.config.target);
    if (leader >= 0) {
      state.outcome = { winner: leader, reason: "target" };
      ctx.finish();
      return;
    }
    ctx.setTimer("tick", R.tickMs);
  };

  const engine: GameEngine<ClashConfig, ClashState> = {
    type: "clash",
    rulesVersion: 1,
    minPlayers: 2,
    acceptsInput: true,

    parseConfig(raw) {
      const parsed = clashSessionConfigSchema.safeParse(raw ?? {});
      if (!parsed.success) throw new GameError("Those game settings aren't valid");
      return { ...parsed.data };
    },

    start(ctx, config) {
      const now = ctx.now();
      const players = ctx.players();
      // Never more teams than players, so nobody plays an empty team.
      const teams = Math.max(2, Math.min(config.teams, players.length));
      const state: ClashState = {
        config: { ...config, teams },
        endsAt: now + config.minutes * 60_000,
        lastTick: now,
        nextId: 1,
        nextN: 0,
        fighters: new Map(),
        npcs: [],
        shots: [],
        power: new Array<number>(teams).fill(0),
        nextDroneAt: now + 2000,
        titanAt: now + R.titan.firstSpawnMs,
        outcome: null,
      };
      // Shuffle, then deal players round the teams so sizes differ by one at most.
      const order = [...players];
      for (let i = order.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
      order.forEach((id, i) => addFighter(ctx, state, id, i % teams));
      ctx.setTimer("end", config.minutes * 60_000);
      ctx.setTimer("tick", R.tickMs);
      ctx.broadcastState();
      return state;
    },

    handleAction() {
      throw new GameError("Core Clash is played with live controls");
    },

    onTimer(ctx, state, name) {
      if (name === "tick") tick(ctx, state);
      else if (name === "end") ctx.finish();
    },

    onPlayerRemoved(ctx, state, userId) {
      state.fighters.delete(userId);
      ctx.broadcastState();
    },

    onEnd(ctx, state) {
      if (!state.outcome) {
        const best = Math.max(...state.power);
        const leaders = state.power.flatMap((p, i) => (p === best ? [i] : []));
        state.outcome = {
          winner: leaders.length === 1 && best > 0 ? leaders[0]! : null,
          reason: ctx.now() >= state.endsAt ? "time" : "ended",
        };
      }
      const winner = state.outcome.winner;
      for (const f of state.fighters.values()) {
        if (f.points > 0) ctx.award(f.userId, f.points, "Combat", "combat");
        if (winner !== null && f.team === winner) ctx.award(f.userId, R.winBonus, "Team win", "win");
        // Ties go to whoever was knocked out less.
        ctx.addTiebreakTime(f.userId, f.deaths * 1000);
      }
      state.shots = [];
      ctx.broadcastState();
    },

    viewFor(state, viewer): ClashView {
      const me = state.fighters.get(viewer.userId);
      return {
        teamCount: state.config.teams,
        target: state.config.target,
        durationSec: state.config.minutes * 60,
        endsAt: state.endsAt,
        serverNow: viewer.now,
        power: [...state.power],
        players: [...state.fighters.values()].map((f) => ({
          userId: f.userId,
          n: f.n,
          team: f.team,
          eliminations: f.eliminations,
          deaths: f.deaths,
          drones: f.drones,
          titanDamage: Math.round(f.titanDamage),
          points: f.points,
        })),
        me: me ? { n: me.n, team: me.team } : null,
        isPlayer: viewer.isPlayer,
        outcome: state.outcome,
      };
    },
  };
  return engine;
}
