import { randomInt } from "node:crypto";
import {
  RACE_BOXES,
  RACE_FLAG,
  RACE_ITEM,
  RACE_RULES as R,
  RACE_TRACK,
  clampToWalls,
  deltaS,
  gridSlot,
  locate,
  raceInputSchema,
  racePlacePoints,
  raceSessionConfigSchema,
  type RaceFeedTuple,
  type RaceSnapshot,
  type RaceView,
} from "@spotflow-games/shared";
import { GameError, type GameContext, type GameEngine } from "../contract.js";

export interface RaceConfig {
  laps: number;
}

interface Racer {
  userId: string;
  /** Short number used in snapshots instead of the user id. */
  n: number;
  x: number;
  y: number;
  h: number;
  v: number;
  /** Track sample hint for lookups. */
  i: number;
  s: number;
  /** Distance driven from the start line, counting laps. Negative on the grid. */
  progress: number;
  /** Goes up whenever the server places the car, so the client stops predicting from its old spot. */
  k: number;
  lastMoveAt: number;
  /** Last item counter seen from the client. */
  lastU: number;
  item: number;
  boostUntil: number;
  crashes: number;
  finishMs: number | null;
  place: number | null;
}

interface Slick {
  id: number;
  x: number;
  y: number;
  owner: number;
  until: number;
}

interface RaceState {
  config: RaceConfig;
  seed: number;
  startedAt: number;
  goAt: number;
  endsAt: number;
  lastTick: number;
  nextN: number;
  nextSlickId: number;
  racers: Map<string, Racer>;
  /** Item boxes that are taken, by id, until when. */
  taken: Record<number, number>;
  slicks: Slick[];
  finishers: number;
  outcome: RaceView["outcome"];
}

const round = (v: number) => Math.round(v);
/** Positions are extrapolated from the last input for at most this long. */
const EXTRAPOLATE_MS = 250;

export function createRaceEngine() {
  const totalDistance = (state: RaceState) => state.config.laps * RACE_TRACK.length;

  const place = (ctx: GameContext, state: RaceState, r: Racer, slot: number) => {
    const g = gridSlot(slot);
    const loc = locate(g.x, g.y);
    r.x = g.x;
    r.y = g.y;
    r.h = g.h;
    r.v = 0;
    r.i = loc.i;
    r.s = loc.s;
    // The grid is just behind the line, so the first crossing starts lap one.
    r.progress = deltaS(loc.s, 0);
    r.k++;
    r.lastMoveAt = ctx.now();
  };

  const addRacer = (ctx: GameContext, state: RaceState, userId: string) => {
    const r: Racer = {
      userId,
      n: state.nextN++,
      x: 0,
      y: 0,
      h: 0,
      v: 0,
      i: 0,
      s: 0,
      progress: 0,
      k: 0,
      lastMoveAt: 0,
      lastU: -1,
      item: RACE_ITEM.none,
      boostUntil: 0,
      crashes: 0,
      finishMs: null,
      place: null,
    };
    state.racers.set(userId, r);
    // Grid spots go in joining order, so a late joiner starts from the back of the grid.
    place(ctx, state, r, r.n);
    return r;
  };

  const syncRoster = (ctx: GameContext, state: RaceState) => {
    let changed = false;
    for (const id of ctx.players()) {
      if (state.racers.has(id)) continue;
      addRacer(ctx, state, id);
      changed = true;
    }
    if (changed) ctx.broadcastState();
  };

  /** Back markers are more likely to get nitro, so the pack stays close. */
  const rollItem = (state: RaceState, r: Racer) => {
    const ahead = [...state.racers.values()].filter((o) => o.progress > r.progress).length;
    const share = state.racers.size > 1 ? ahead / (state.racers.size - 1) : 0.5;
    return randomInt(100) < 40 + share * 45 ? RACE_ITEM.nitro : RACE_ITEM.oil;
  };

  const applyInputs = (ctx: GameContext, state: RaceState, feed: RaceFeedTuple[]) => {
    const now = ctx.now();
    const racing = now >= state.goAt;
    const inputs = ctx.inputs();
    for (const r of state.racers.values()) {
      const raw = inputs.get(r.userId);
      const fresh = raw && now - raw.at <= R.inputStaleMs;
      const parsed = fresh ? raceInputSchema.safeParse(raw.value) : null;
      if (!racing || !parsed?.success) {
        r.v = 0;
        r.lastMoveAt = now;
        continue;
      }
      const input = parsed.data;
      if (input.k === r.k) {
        // Carry the reported position forward to now, so a car moves smoothly between inputs.
        const ahead = Math.min(EXTRAPOLATE_MS, now - raw!.at) / 1000;
        const tx = input.x + Math.cos(input.h) * input.v * ahead;
        const ty = input.y + Math.sin(input.h) * input.v * ahead;
        const top = now < r.boostUntil + 500 ? R.nitroSpeed : R.topSpeed;
        const allowed = top * ((now - r.lastMoveAt) / 1000) * 1.5 + 12;
        let dx = tx - r.x;
        let dy = ty - r.y;
        const d = Math.hypot(dx, dy);
        if (d > allowed) {
          dx = (dx / d) * allowed;
          dy = (dy / d) * allowed;
        }
        const loc = locate(r.x + dx, r.y + dy, r.i);
        const p = clampToWalls(r.x + dx, r.y + dy, loc);
        const at = locate(p.x, p.y, loc.i);
        r.progress += deltaS(at.s, r.s);
        r.x = p.x;
        r.y = p.y;
        r.i = at.i;
        r.s = at.s;
        r.h = input.h;
        r.v = Math.max(-R.reverseSpeed, Math.min(R.nitroSpeed, input.v));
        // The client counts its own crashes; it can only ever add to them.
        r.crashes = Math.max(r.crashes, Math.min(input.c, r.crashes + 5));
      }
      r.lastMoveAt = now;
      const used = r.lastU >= 0 && input.u !== r.lastU;
      r.lastU = input.u;
      if (used && r.item !== RACE_ITEM.none && r.finishMs === null) useItem(ctx, state, r, feed);
    }
  };

  const useItem = (ctx: GameContext, state: RaceState, r: Racer, feed: RaceFeedTuple[]) => {
    const now = ctx.now();
    if (r.item === RACE_ITEM.nitro) {
      r.boostUntil = now + R.nitroMs;
      feed.push([1, r.n, 0]);
    } else {
      // Oil goes down just behind the car.
      state.slicks.push({
        id: state.nextSlickId++,
        x: r.x - Math.cos(r.h) * (R.car.length / 2 + R.slick.radius),
        y: r.y - Math.sin(r.h) * (R.car.length / 2 + R.slick.radius),
        owner: r.n,
        until: now + R.slick.lifeMs,
      });
      if (state.slicks.length > R.slick.max) state.slicks.shift();
      feed.push([2, r.n, 0]);
    }
    r.item = RACE_ITEM.none;
  };

  const grabBoxes = (ctx: GameContext, state: RaceState) => {
    const now = ctx.now();
    for (const [id, until] of Object.entries(state.taken)) if (now >= until) delete state.taken[Number(id)];
    for (const r of state.racers.values()) {
      if (r.item !== RACE_ITEM.none || r.finishMs !== null) continue;
      for (const b of RACE_BOXES) {
        if (state.taken[b.id]) continue;
        if ((r.x - b.x) ** 2 + (r.y - b.y) ** 2 > (R.box.radius + R.car.radius) ** 2) continue;
        state.taken[b.id] = now + R.box.respawnMs;
        r.item = rollItem(state, r);
        break;
      }
    }
  };

  const checkFinish = (ctx: GameContext, state: RaceState, feed: RaceFeedTuple[]) => {
    const now = ctx.now();
    let changed = false;
    for (const r of state.racers.values()) {
      if (r.finishMs !== null || r.progress < totalDistance(state)) continue;
      r.finishMs = now - state.goAt;
      r.place = ++state.finishers;
      feed.push([0, r.n, r.place]);
      changed = true;
      // The first one home starts the clock on everyone else.
      if (r.place === 1) ctx.setTimer("end", Math.min(R.finishGraceMs, Math.max(0, state.endsAt - now)));
    }
    if (!changed) return;
    if ([...state.racers.values()].every((r) => r.finishMs !== null)) {
      state.outcome = { reason: "finished" };
      ctx.setTimer("end", 2500);
    }
    ctx.broadcastState();
  };

  const snapshot = (ctx: GameContext, state: RaceState, feed: RaceFeedTuple[]): RaceSnapshot => {
    const now = ctx.now();
    return {
      type: "race",
      now,
      players: [...state.racers.values()].map((r) => [
        r.n,
        round(r.x),
        round(r.y),
        round(r.h * 100),
        round(r.v),
        (now < r.boostUntil ? RACE_FLAG.boost : 0) | (r.finishMs !== null ? RACE_FLAG.finished : 0),
        round(r.progress),
        r.item,
        r.k,
      ]),
      taken: Object.keys(state.taken).map(Number),
      slicks: state.slicks.map((s) => [s.id, round(s.x), round(s.y), s.owner]),
      feed,
    };
  };

  const tick = (ctx: GameContext, state: RaceState) => {
    const now = ctx.now();
    state.lastTick = now;
    const feed: RaceFeedTuple[] = [];
    syncRoster(ctx, state);
    applyInputs(ctx, state, feed);
    grabBoxes(ctx, state);
    state.slicks = state.slicks.filter((s) => now < s.until);
    checkFinish(ctx, state, feed);
    ctx.emitEvent(snapshot(ctx, state, feed));
    ctx.setTimer("tick", R.tickMs);
  };

  const engine: GameEngine<RaceConfig, RaceState> = {
    type: "race",
    rulesVersion: 1,
    minPlayers: 1,
    maxPlayers: R.maxRacers,
    acceptsInput: true,

    parseConfig(raw) {
      const parsed = raceSessionConfigSchema.safeParse(raw ?? {});
      if (!parsed.success) throw new GameError("Those game settings aren't valid");
      return { ...parsed.data };
    },

    start(ctx, config) {
      const now = ctx.now();
      const goAt = now + R.countdownMs;
      const state: RaceState = {
        config: { ...config },
        seed: randomInt(2 ** 31),
        startedAt: now,
        goAt,
        endsAt: goAt + config.laps * R.lapLimitMs,
        lastTick: now,
        nextN: 0,
        nextSlickId: 1,
        racers: new Map(),
        taken: {},
        slicks: [],
        finishers: 0,
        outcome: null,
      };
      // Shuffle the grid, so nobody always starts on pole.
      const order = [...ctx.players()];
      for (let i = order.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
      for (const id of order) addRacer(ctx, state, id);
      ctx.setTimer("end", state.endsAt - now);
      ctx.setTimer("tick", R.tickMs);
      ctx.broadcastState();
      return state;
    },

    handleAction() {
      throw new GameError("Lagos Rush is played with live controls");
    },

    onTimer(ctx, state, name) {
      if (name === "tick") tick(ctx, state);
      else if (name === "end") ctx.finish();
    },

    onPlayerRemoved(ctx, state, userId) {
      state.racers.delete(userId);
      ctx.broadcastState();
    },

    onEnd(ctx, state) {
      const now = ctx.now();
      if (!state.outcome) {
        const allIn = [...state.racers.values()].every((r) => r.finishMs !== null);
        state.outcome = { reason: allIn ? "finished" : state.finishers > 0 || now >= state.endsAt ? "time" : "ended" };
      }
      const field = state.racers.size;
      const total = totalDistance(state);
      for (const r of state.racers.values()) {
        if (r.place !== null) {
          ctx.award(r.userId, racePlacePoints(r.place, field), `Finished ${r.place}`, "place");
          const clean = R.cleanBonus - R.cleanPenaltyPerCrash * r.crashes;
          if (clean > 0) ctx.award(r.userId, clean, "Clean driving", "clean");
          ctx.addTiebreakTime(r.userId, r.finishMs ?? 0);
        } else {
          const done = Math.max(0, Math.min(1, r.progress / total));
          const pts = Math.floor(R.dnfMaxPoints * done);
          if (pts > 0) ctx.award(r.userId, pts, "Distance", "distance");
          // Anyone who didn't finish ranks below every finisher, then by distance.
          ctx.addTiebreakTime(r.userId, 10_000_000 + Math.round(total - r.progress));
        }
      }
      state.slicks = [];
      ctx.broadcastState();
    },

    viewFor(state, viewer): RaceView {
      const me = state.racers.get(viewer.userId);
      const total = totalDistance(state);
      return {
        laps: state.config.laps,
        seed: state.seed,
        startedAt: state.startedAt,
        goAt: state.goAt,
        endsAt: state.endsAt,
        serverNow: viewer.now,
        racers: [...state.racers.values()].map((r) => ({
          userId: r.userId,
          n: r.n,
          finishMs: r.finishMs,
          place: r.place,
          crashes: r.crashes,
          done: Math.max(0, Math.min(1, r.progress / total)),
        })),
        me: me ? { n: me.n } : null,
        isPlayer: viewer.isPlayer,
        outcome: state.outcome,
      };
    },
  };
  return engine;
}
