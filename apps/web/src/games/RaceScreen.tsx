import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Droplet,
  Flag,
  Map as MapIcon,
  Maximize2,
  Minimize2,
  RotateCcw,
  Zap,
} from "lucide-react";
import {
  RACE_FLAG,
  RACE_ITEM,
  RACE_RULES as R,
  RACE_TRACK as T,
  buildCourse,
  clampToWalls,
  locate,
  newCar,
  stepCar,
  trackPoint,
  type CarState,
  type RaceCourse,
  type RacePlayerTuple,
  type RaceSnapshot,
  type RaceView,
  type SessionView,
} from "@spotflow-games/shared";
import { usePreferences } from "../lib/preferences";
import { getSocket } from "../lib/socket";
import { playSound } from "../lib/sound";
import type { RaceWorld } from "./race3d";
import { carPaint } from "./racePaint";

interface Props {
  session: SessionView;
  game: RaceView;
  meId: string;
}

/**
 * Others are drawn a little in the past, so there are two snapshots to blend between. The delay
 * follows how often snapshots actually arrive, which on a busy server or network is slower and
 * less even than the tick.
 */
const INTERP_MIN_MS = 150;
const INTERP_MAX_MS = 600;
/** Past the newest snapshot, cars keep moving on their last speed and heading for up to this long. */
const EXTRAPOLATE_MS = 350;
/**
 * How far back we remember our own car, to match against the server's view of it, which on a
 * slow or stalling connection can be a couple of seconds old.
 */
const HISTORY_MS = 4000;
/** Send the car's position this often while it moves, and at least this often while it doesn't. */
const SEND_EVERY_MS = 100;
const HEARTBEAT_MS = 400;
/**
 * Snap to the server's position only when it stays further than this from anywhere we have
 * recently been, for this long. After a network stall the server is behind for a moment and
 * catches up on its own, and pulling the car back then feels like it lurched backwards.
 */
const SNAP_DIST = 160;
const SNAP_AFTER_MS = 1500;
/** Displayed speed: units per second to km/h, scaled up to Grand Prix speeds. */
const KMH = 0.5;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  until: number;
  color: string;
  size: number;
}
interface WorldCar {
  n: number;
  x: number;
  y: number;
  h: number;
  v: number;
  flags: number;
  progress: number;
}
interface Hud {
  pos: number;
  of: number;
  lap: number;
  speed: number;
  gear: string;
  lapTime: string;
  best: string;
  /** Start lights showing, out of five. */
  lights: number;
  item: number;
  district: string;
  clock: string;
  count: number | null;
  wrongWay: boolean;
  follow: string;
  board: Array<{ n: number; name: string; place: number; me: boolean; done: boolean }>;
}

const firstName = (name?: string) => name?.split(" ")[0] ?? "Racer";
/** Three letters, as on a timing screen. */
const tla = (name: string) =>
  name
    .replace(/[^\p{L}\p{N}]/gu, "")
    .slice(0, 3)
    .toUpperCase() || "???";
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpAngle = (a: number, b: number, t: number) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};
const ordinal = (n: number) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
};
const fmtTime = (ms: number) => {
  const t = Math.max(0, ms) / 1000;
  return `${Math.floor(t / 60)}:${Math.floor(t % 60)
    .toString()
    .padStart(2, "0")}.${Math.floor((t * 10) % 10)}`;
};
const districtAt = (s: number) => {
  let name = T.districts[T.districts.length - 1]!.name;
  for (const d of T.districts) if (s >= d.s) name = d.name;
  return name;
};

/** Starts downloading the 3D renderer; the race picks up the same module. */
export const preloadRace3d = () => import("./race3d").catch(() => undefined);

export function RaceScreen({ session, game, meId }: Props) {
  const { soundEnabled } = usePreferences();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<RaceWorld | null>(null);
  const [noGl, setNoGl] = useState(false);
  const touch = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
  const [full, setFull] = useState(touch);
  const [mapView, setMapView] = useState(false);
  const [hud, setHud] = useState<Hud>({
    pos: 1,
    of: game.racers.length,
    lap: 1,
    speed: 0,
    gear: "N",
    lapTime: "0:00.0",
    best: "",
    lights: 0,
    item: 0,
    district: T.districts[0]!.name,
    clock: "0:00.0",
    count: null,
    wrongWay: false,
    follow: "",
    board: [],
  });
  const [banner, setBanner] = useState<string | null>(null);
  const [feed, setFeed] = useState<Array<{ key: number; text: string; n: number; mine: boolean }>>([]);
  const [announce, setAnnounce] = useState("");
  const course = useMemo(() => buildCourse(game.seed), [game.seed]);

  // Everything the render loop reads lives in refs, so a state push never restarts it.
  const gameRef = useRef(game);
  gameRef.current = game;
  const courseRef = useRef<RaceCourse>(course);
  courseRef.current = course;
  const soundRef = useRef(soundEnabled);
  soundRef.current = soundEnabled;
  const mapRef = useRef(mapView);
  mapRef.current = mapView;
  const names = useRef(new Map<number, string>());
  names.current = new Map(
    game.racers.map((r) => [r.n, firstName(session.participants.find((p) => p.userId === r.userId)?.displayName)]),
  );

  const snaps = useRef<RaceSnapshot[]>([]);
  const offsets = useRef<number[]>([]);
  const arrivals = useRef<number[]>([]);
  const trail = useRef<{ t: number; x: number; y: number }[]>([]);
  const car = useRef<CarState | null>(null);
  const meInfo = useRef({
    k: -1,
    item: 0,
    finished: false,
    progress: -1,
    lapShown: 1,
    driftSince: 0,
    lapStart: 0,
    lastLap: 0,
    best: 0,
  });
  const particles = useRef<Particle[]>([]);
  const controls = useRef({
    keys: new Set<string>(),
    left: false,
    right: false,
    brake: false,
    steer: 0,
    uses: 0,
  });
  const followN = useRef<number | null>(null);
  const followAuto = useRef(true);
  const sent = useRef({ at: 0, body: "" });
  const feedKey = useRef(0);

  const serverNow = () => {
    const o = offsets.current;
    return Date.now() + (o.length ? Math.max(...o) : 0);
  };

  // Snapshots.
  useEffect(() => {
    const onSnapshot = (snap: RaceSnapshot) => {
      const recv = Date.now();
      arrivals.current.push(recv);
      if (arrivals.current.length > 21) arrivals.current.shift();
      offsets.current.push(snap.now - recv);
      if (offsets.current.length > 30) offsets.current.shift();
      snaps.current.push(snap);
      if (snaps.current.length > 12) snaps.current.shift();

      const g = gameRef.current;
      const myN = g.me?.n ?? -1;
      const mine = snap.players.find((p) => p[0] === myN);
      const m = meInfo.current;
      if (mine) {
        const c = car.current;
        // A new placement, or the server disagreeing for a while, puts us where the server says.
        // The server's view is from a moment ago, so it is matched against where we have been.
        const off = !!c && driftFrom(trail.current, c, mine[1], mine[2]) > SNAP_DIST;
        if (!off) m.driftSince = 0;
        else m.driftSince ||= recv;
        if (!c || mine[8] !== m.k || (off && recv - m.driftSince > SNAP_AFTER_MS)) {
          const fresh = newCar(mine[1], mine[2], mine[3] / 100);
          m.driftSince = 0;
          trail.current = [];
          if (c && mine[8] === m.k) {
            fresh.v = c.v;
            fresh.crashes = c.crashes;
            fresh.boostUntil = c.boostUntil;
          }
          car.current = fresh;
          m.k = mine[8];
        }
        if (mine[7] !== RACE_ITEM.none && m.item === RACE_ITEM.none) playSound("zap", soundRef.current);
        m.item = mine[7];
        m.progress = mine[6];
        if (mine[5] & RACE_FLAG.boost && car.current)
          car.current.boostUntil = Math.max(car.current.boostUntil, snap.now + 200);
        if (mine[5] & RACE_FLAG.finished && !m.finished) {
          m.finished = true;
        }
      }
      if (snap.feed.length) {
        const lines: typeof feed = [];
        for (const [kind, n, a] of snap.feed) {
          const who = n === myN ? "You" : (names.current.get(n) ?? "Someone");
          if (kind === 0) {
            if (n === myN) {
              playSound(a === 1 ? "winner" : "complete", soundRef.current);
              setBanner(a === 1 ? "You win! 1st place" : `You finished ${ordinal(a)}`);
              setAnnounce(`You finished ${ordinal(a)}.`);
            } else if (a === 1) {
              setBanner(`${who} wins! Everyone else has ${R.finishGraceMs / 1000}s`);
              setAnnounce(`${who} won the race.`);
            }
          }
          const text =
            kind === 0 ? `${who} finished ${ordinal(a)}` : kind === 1 ? `${who} hit the nitro` : `${who} dropped oil`;
          lines.push({ key: feedKey.current++, text, n, mine: n === myN });
        }
        setFeed((f) => [...lines, ...f].slice(0, 4));
      }
    };
    const socket = getSocket();
    const onEvent = ({ code, event }: { code: string; event: unknown }) => {
      if (code === session.code && (event as RaceSnapshot)?.type === "race") onSnapshot(event as RaceSnapshot);
    };
    socket.on("game:event", onEvent);
    return () => {
      socket.off("game:event", onEvent);
    };
  }, [session.code]);

  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), 3000);
    return () => clearTimeout(t);
  }, [banner]);

  // Old feed lines fade out.
  useEffect(() => {
    if (!feed.length) return;
    const t = setTimeout(() => setFeed((f) => f.slice(0, -1)), 4000);
    return () => clearTimeout(t);
  }, [feed]);

  const fireItem = () => {
    const m = meInfo.current;
    const c = car.current;
    if (m.item === RACE_ITEM.none || !c || serverNow() < gameRef.current.goAt) return;
    controls.current.uses++;
    // Predict the boost; the server confirms it in the next snapshot.
    if (m.item === RACE_ITEM.nitro) c.boostUntil = serverNow() + R.nitroMs;
    playSound("zap", soundRef.current);
    m.item = RACE_ITEM.none;
  };
  const fireItemRef = useRef(fireItem);
  fireItemRef.current = fireItem;

  // Keyboard.
  useEffect(() => {
    const c = controls.current;
    const gameKey = (k: string) =>
      ["w", "a", "s", "d", "e", "arrowup", "arrowdown", "arrowleft", "arrowright", " ", "shift"].includes(k);
    const typing = (e: KeyboardEvent) =>
      e.target instanceof HTMLElement &&
      (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (typing(e) || !gameKey(k)) return;
      e.preventDefault();
      if ((k === " " || k === "shift" || k === "e") && !e.repeat) fireItemRef.current();
      c.keys.add(k);
    };
    const up = (e: KeyboardEvent) => c.keys.delete(e.key.toLowerCase());
    const blur = () => {
      c.keys.clear();
      c.left = c.right = c.brake = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  // The 3D renderer is loaded on demand, so the other games don't download it.
  useEffect(() => {
    let alive = true;
    let made: RaceWorld | null = null;
    import("./race3d")
      .then((m) => {
        if (!alive || !glRef.current) return;
        made = m.createRaceWorld(glRef.current);
        worldRef.current = made;
      })
      .catch(() => alive && setNoGl(true));
    return () => {
      alive = false;
      worldRef.current = null;
      made?.dispose();
    };
  }, []);

  // The render, physics and input loop.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const scene = getScenery();
    let raf = 0;
    let last = performance.now();
    let lastHud = 0;
    let view = { w: 0, h: 0, dpr: 1 };
    let sizedWorld: RaceWorld | null = null;
    let shakeUntil = 0;
    let wrongSince = 0;
    let lastCount: number | null = null;
    let interpMs = INTERP_MIN_MS;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      view = { w: rect.width, h: rect.height, dpr };
      sizedWorld = null;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      const g = gameRef.current;
      const crs = courseRef.current;
      const now = serverNow();
      const raceT = (now - g.startedAt) / 1000;
      const myN = g.me?.n ?? -1;
      const c = car.current;
      const playing = g.isPlayer && !!g.me && !!c;
      const racing = now >= g.goAt;
      const latest = snaps.current[snaps.current.length - 1];
      const slicks = (latest?.slicks ?? []).map(([id, x, y, owner]) => ({ id, x, y, owner }));
      const taken = new Set(latest?.taken ?? []);

      // Controls.
      const k = controls.current;
      const left = k.left || k.keys.has("a") || k.keys.has("arrowleft");
      const right = k.right || k.keys.has("d") || k.keys.has("arrowright");
      const brake = k.brake || k.keys.has("s") || k.keys.has("arrowdown");
      const gas = touch ? !brake : k.keys.has("w") || k.keys.has("arrowup");
      const target = (right ? 1 : 0) - (left ? 1 : 0);
      // Steering eases in, so a tap is a nudge and holding is full lock.
      k.steer += Math.max(-dt * 7, Math.min(dt * 7, target - k.steer));
      if (!target && Math.abs(k.steer) < 0.05) k.steer = 0;

      // Drive.
      if (playing && c) {
        if (racing) {
          const steps = Math.max(1, Math.ceil(dt / (1 / 60)));
          for (let i = 0; i < steps; i++) {
            const hits = stepCar(c, { steer: k.steer, gas, brake }, dt / steps, now, raceT, crs, slicks, myN);
            for (const hit of hits) {
              if (hit.crash || hit.kind === "wall") {
                burst(particles.current, hit.x, hit.y, hit.crash ? 14 : 3, "#ffd36b");
                if (hit.crash) {
                  playSound("boom", soundRef.current);
                  shakeUntil = t + 220;
                }
              } else if (hit.kind === "slick") {
                playSound("boom", soundRef.current);
                setAnnounce("Oil! You spun out.");
              } else burst(particles.current, hit.x, hit.y, 5, "#8b7d6b");
            }
          }
          if (now < c.boostUntil) flame(particles.current, c);
        }

        // Send.
        const body = JSON.stringify({
          x: Math.round(c.x * 10) / 10,
          y: Math.round(c.y * 10) / 10,
          h: Math.round(c.h * 1000) / 1000,
          v: Math.round(c.v),
          u: k.uses,
          c: c.crashes,
          k: Math.max(0, meInfo.current.k),
        });
        const since = t - sent.current.at;
        if ((body !== sent.current.body && since >= SEND_EVERY_MS) || since >= HEARTBEAT_MS) {
          sent.current = { at: t, body };
          getSocket().volatile.emit("game:input", { code: session.code, input: JSON.parse(body) as unknown });
        }
      }

      if (playing && c) {
        const tr = trail.current;
        tr.push({ t: now, x: c.x, y: c.y });
        while (tr.length && tr[0]!.t < now - HISTORY_MS) tr.shift();
      }

      // Everyone else, a little in the past. The delay eases toward its target so time never jumps.
      interpMs += (interpTarget(arrivals.current) - interpMs) * Math.min(1, dt * 2);
      const world = interpolate(snaps.current, now - interpMs);
      const order = standings(world, g);

      // Camera: behind my car, or following someone (or the whole map) when watching.
      let focus: { x: number; y: number; h: number; v: number } | null = null;
      if (playing && c) focus = c;
      else {
        // Watchers follow whoever leads, until they pick someone.
        if (followAuto.current || !world.some((w) => w.n === followN.current)) followN.current = order[0]?.n ?? null;
        focus = world.find((w) => w.n === followN.current) ?? null;
      }
      const overview = mapRef.current || !focus;

      // The 3D world.
      const w3 = worldRef.current;
      if (w3) {
        if (sizedWorld !== w3) {
          w3.resize(view.w, view.h, Math.min(touch ? 1.5 : 2, view.dpr));
          sizedWorld = w3;
        }
        w3.setCourse(crs);
        const cars = world
          .filter((w) => !(w.n === myN && playing))
          .map((w) => ({ n: w.n, x: w.x, y: w.y, h: w.h, v: w.v, boost: !!(w.flags & RACE_FLAG.boost) }));
        if (playing && c) cars.push({ n: myN, x: c.x, y: c.y, h: c.h, v: c.v, boost: now < c.boostUntil });
        w3.render({
          t,
          raceT,
          countdown: now < g.goAt ? g.goAt - now : null,
          focus,
          overview,
          still,
          shake: t < shakeUntil,
          cars,
          taken,
          slicks,
        });
      }

      // Sparks, names and the map, drawn flat over the 3D view.
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ctx.clearRect(0, 0, view.w, view.h);
      const ps = particles.current;
      const pnow = performance.now();
      for (let i = ps.length - 1; i >= 0; i--) {
        const p = ps[i]!;
        if (pnow > p.until) {
          ps.splice(i, 1);
          continue;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        const sp = w3?.project(p.x, p.y, 5);
        if (!sp) continue;
        const size = Math.max(1.5, p.size * sp.scale);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = Math.max(0, (p.until - pnow) / 400);
        ctx.fillRect(sp.x - size / 2, sp.y - size / 2, size, size);
      }
      ctx.globalAlpha = 1;

      if (w3) {
        ctx.font = `800 12px ${FONT}`;
        ctx.textAlign = "center";
        ctx.lineJoin = "round";
        for (const w of world) {
          const mine = w.n === myN && playing;
          if (mine && !overview) continue;
          const sp = w3.project(w.x, w.y, overview ? 0 : 26, w.n);
          if (!sp) continue;
          if (overview) {
            ctx.fillStyle = carPaint(w.n);
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(sp.x, sp.y, mine ? 7 : 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            if (world.length > 12 && !mine) continue;
          } else if (sp.scale < 0.12) continue;
          const name = mine ? "YOU" : tla(names.current.get(w.n) ?? "");
          const label = overview ? sp.y - 12 : sp.y;
          const tw = ctx.measureText(name).width + 12;
          ctx.fillStyle = "rgba(21, 21, 30, 0.85)";
          ctx.fillRect(sp.x - tw / 2, label - 15, tw, 18);
          ctx.fillStyle = carPaint(w.n);
          ctx.fillRect(sp.x - tw / 2, label - 15, 3, 18);
          ctx.fillStyle = "#ffffff";
          ctx.fillText(name, sp.x + 1, label - 2);
        }
      }

      if (!overview) drawMinimap(ctx, scene, view.w, view.h, world, playing && c ? c : null, myN);

      // HUD, a few times a second.
      if (t - lastHud > 120) {
        lastHud = t;
        const myProgress = playing ? meInfo.current.progress : -1;
        const pos = playing ? order.findIndex((o) => o.n === myN) + 1 : 0;
        const lap = Math.max(1, Math.min(g.laps, Math.floor(Math.max(0, myProgress) / T.length) + 1));
        const m = meInfo.current;
        if (!m.lapStart) m.lapStart = g.goAt;
        const lapDone = playing && ((lap > m.lapShown && !m.finished) || (m.finished && !m.lastLap));
        if (lapDone) {
          // Lap times from the server's lap count, so they line up with the timing tower.
          m.lastLap = now - m.lapStart;
          m.best = m.best ? Math.min(m.best, m.lastLap) : m.lastLap;
          m.lapStart = now;
        }
        if (playing && lap > m.lapShown && !m.finished) {
          m.lapShown = lap;
          setBanner(lap === g.laps ? "Final lap!" : `Lap ${lap} of ${g.laps}`);
          setAnnounce(lap === g.laps ? "Final lap." : `Lap ${lap}.`);
          playSound("correct", soundRef.current);
        }
        const countMs = g.goAt - now;
        const count = countMs > 0 ? Math.ceil(countMs / 1000) : countMs > -900 ? 0 : null;
        const lights = countMs > 0 ? Math.min(5, Math.ceil(((R.countdownMs - countMs) / R.countdownMs) * 6)) : 0;
        if (count !== lastCount && count !== null) playSound(count === 0 ? "correct" : "countdown", soundRef.current);
        lastCount = count;
        let wrongWay = false;
        if (playing && c && racing && !m.finished) {
          const along = Math.cos(c.h - T.h[c.i]!);
          if (along < -0.2 && Math.abs(c.v) > 40) wrongSince ||= t;
          else wrongSince = 0;
          wrongWay = wrongSince > 0 && t - wrongSince > 900;
        }
        const followed = playing ? myN : followN.current;
        const next: Hud = {
          pos,
          of: order.length,
          lap,
          speed: Math.round(Math.abs(focus?.v ?? 0) * KMH),
          gear: gearFor(focus?.v ?? 0),
          lapTime: fmtTime(m.finished ? m.lastLap : now < g.goAt ? 0 : now - m.lapStart),
          best: m.best ? fmtTime(m.best) : "",
          lights,
          item: playing ? m.item : 0,
          district: districtAt(playing && c ? c.s : focus ? nearestS(focus) : 0),
          clock: fmtTime(now - g.goAt),
          count,
          wrongWay,
          follow: followed !== null ? (names.current.get(followed) ?? "") : "",
          board: order.map((o, i) => ({
            n: o.n,
            name: names.current.get(o.n) ?? "",
            place: i + 1,
            me: o.n === myN,
            done: !!(o.flags & RACE_FLAG.finished),
          })),
        };
        setHud((h) => (JSON.stringify(h) === JSON.stringify(next) ? h : next));
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [session.code]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (game.isPlayer) canvasRef.current?.focus();
  }, [game.isPlayer]);

  const cycleFollow = (dir: 1 | -1) => {
    const board = hud.board;
    if (!board.length) return;
    const at = board.findIndex((b) => b.n === followN.current);
    followN.current = board[(at + dir + board.length) % board.length]!.n;
    followAuto.current = false;
    setMapView(false);
  };

  /** A held on-screen button. Pointer events keep each thumb's button separate. */
  const hold = (key: "left" | "right" | "brake") => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      controls.current[key] = true;
    },
    onPointerUp: () => {
      controls.current[key] = false;
    },
    onPointerCancel: () => {
      controls.current[key] = false;
    },
    onLostPointerCapture: () => {
      controls.current[key] = false;
    },
  });

  const watching = !game.isPlayer || !game.me;
  const top = hud.board.slice(0, 10);
  const mine = hud.board.find((b) => b.me);
  const shown = mine && !top.includes(mine) ? [...top.slice(0, 9), mine] : top;

  const itemButton = (
    <button
      type="button"
      className={`race-item${hud.item ? " ready" : ""}`}
      disabled={!hud.item}
      onClick={fireItem}
      aria-label={hud.item === RACE_ITEM.nitro ? "Use nitro" : hud.item === RACE_ITEM.oil ? "Drop oil" : "No item"}
    >
      {hud.item === RACE_ITEM.nitro ? (
        <Zap aria-hidden="true" size={22} />
      ) : hud.item === RACE_ITEM.oil ? (
        <Droplet aria-hidden="true" size={22} />
      ) : (
        <span aria-hidden="true">?</span>
      )}
    </button>
  );

  return (
    <div className={`race-stage${full ? " full" : ""}`}>
      <div className="race-frame">
        <canvas ref={glRef} className="race-canvas" aria-hidden="true" />
        <canvas
          ref={canvasRef}
          className="race-canvas race-overlay"
          tabIndex={0}
          role="img"
          aria-label={
            watching
              ? `Lagos Rush. Following ${hud.follow || "the leader"} through ${hud.district}.`
              : `Lagos Rush. You are ${ordinal(hud.pos)} of ${hud.of}, lap ${hud.lap} of ${game.laps}, in ${hud.district}.`
          }
        />
        {noGl && (
          <p className="race-nogl" role="alert">
            Lagos Rush needs 3D graphics (WebGL), which this browser has turned off. Try another browser or turn on
            hardware acceleration.
          </p>
        )}

        <div className="race-tower" aria-label="Positions">
          <div className="race-tower-head">
            <span>Lap</span>
            <b className="sg-num">
              {hud.lap}
              <small>/{game.laps}</small>
            </b>
          </div>
          <ol>
            {shown.map((b) => (
              <li key={b.n} className={b.me ? "me" : ""} style={{ "--c": carPaint(b.n) } as React.CSSProperties}>
                <span className="sg-num">{b.place}</span>
                <i aria-hidden="true" />
                <abbr title={b.me ? "You" : b.name}>{b.me ? "YOU" : tla(b.name)}</abbr>
                {b.done && <Flag aria-label="finished" size={11} />}
              </li>
            ))}
          </ol>
        </div>

        <div className="race-timing">
          <span className="race-clock sg-num" role="timer" aria-label={`Race time ${hud.clock}`}>
            {hud.count !== null && hud.count > 0 ? "0:00.0" : hud.clock}
          </span>
          {!watching && (
            <span className="race-lap sg-num">
              <small>Lap</small> {hud.lapTime}
            </span>
          )}
          {!watching && hud.best && (
            <span className="race-lap best sg-num">
              <small>Best</small> {hud.best}
            </span>
          )}
        </div>
        <span className="race-district">{hud.district}</span>

        {hud.count !== null && (
          <div className={`race-count${hud.count === 0 ? " go" : ""}`} aria-live="assertive">
            <div className="race-lights" aria-hidden="true">
              {[1, 2, 3, 4, 5].map((n) => (
                <span key={n}>
                  <i className={hud.lights >= n ? "on" : ""} />
                  <i className={hud.lights >= n ? "on" : ""} />
                </span>
              ))}
            </div>
            <b>{hud.count === 0 ? "GO!" : <span className="visually-hidden">{hud.count}</span>}</b>
          </div>
        )}

        {banner && (
          <div className="race-banner pop-in" role="status">
            <Flag aria-hidden="true" size={18} />
            {banner}
          </div>
        )}
        {hud.wrongWay && (
          <div className="race-wrong" role="alert">
            <RotateCcw aria-hidden="true" size={22} /> Wrong way!
          </div>
        )}

        {!watching && (
          <div className="race-dash">
            <span className="race-place sg-num" aria-hidden="true">
              P{hud.pos}
              <small>/{hud.of}</small>
            </span>
            <span className="race-speed sg-num" aria-label={`${hud.speed} kilometres an hour`}>
              {hud.speed}
              <small>km/h</small>
            </span>
            <span className="race-gear sg-num" aria-hidden="true">
              {hud.gear}
            </span>
            {!touch && itemButton}
          </div>
        )}

        {!watching && touch && (
          <div className="race-pads">
            <div className="race-pad-group">
              <button type="button" className="race-pad" aria-label="Steer left" {...hold("left")}>
                <ChevronLeft aria-hidden="true" size={36} />
              </button>
              <button type="button" className="race-pad" aria-label="Steer right" {...hold("right")}>
                <ChevronRight aria-hidden="true" size={36} />
              </button>
            </div>
            <div className="race-pad-group">
              {itemButton}
              <button type="button" className="race-pad brake" aria-label="Brake" {...hold("brake")}>
                Brake
              </button>
            </div>
          </div>
        )}

        {touch && (
          <button
            type="button"
            className="sg-btn ghost icon sm race-full"
            aria-label={full ? "Exit full screen" : "Full screen"}
            onClick={() => setFull((f) => !f)}
          >
            {full ? <Minimize2 aria-hidden="true" size={16} /> : <Maximize2 aria-hidden="true" size={16} />}
          </button>
        )}
        {touch && full && (
          <div className="race-rotate" aria-hidden="true">
            <RotateCcw size={28} />
            Turn your phone sideways to race
          </div>
        )}
      </div>

      {watching && (
        <div className="race-watch sg-row">
          <button
            type="button"
            className="sg-btn ghost sm"
            onClick={() => cycleFollow(-1)}
            aria-label="Follow the car ahead"
          >
            <ChevronLeft aria-hidden="true" size={16} />
          </button>
          <span>
            Following <b>{hud.follow || "the leader"}</b>
          </span>
          <button
            type="button"
            className="sg-btn ghost sm"
            onClick={() => cycleFollow(1)}
            aria-label="Follow the car behind"
          >
            <ChevronRight aria-hidden="true" size={16} />
          </button>
          <button
            type="button"
            className="sg-btn ghost sm"
            aria-pressed={mapView}
            onClick={() => setMapView((m) => !m)}
          >
            <MapIcon aria-hidden="true" size={16} />
            Whole map
          </button>
        </div>
      )}

      <ol className="race-feed" aria-hidden="true">
        {feed.map((f) => (
          <li key={f.key} className={f.mine ? "mine" : ""} style={{ "--c": carPaint(f.n) } as React.CSSProperties}>
            {f.text}
          </li>
        ))}
      </ol>

      {!touch && !watching && (
        <p className="race-help sg-muted">
          <kbd>↑</kbd> or <kbd>W</kbd> to drive, <kbd>←</kbd> <kbd>→</kbd> or <kbd>A</kbd> <kbd>D</kbd> to steer,{" "}
          <kbd>↓</kbd> or <kbd>S</kbd> to brake. Grab <b>?</b> boxes for nitro or oil and use them with <kbd>Space</kbd>
          . Dodge the danfos, okadas, potholes and go-slow on Third Mainland Bridge.
        </p>
      )}
      <span className="visually-hidden" aria-live="polite">
        {announce}
      </span>
    </div>
  );
}

/** Final standings, shown above the podium. */
export function RaceOutcome({ session, game, meId }: { session: SessionView; game: RaceView; meId: string }) {
  const names = new Map(session.participants.map((p) => [p.userId, p.displayName]));
  const order = [...game.racers].sort((a, b) => (a.place ?? Infinity) - (b.place ?? Infinity) || b.done - a.done);
  const winner = order[0]?.place === 1 ? order[0] : null;
  const headline = winner
    ? `${winner.userId === meId ? "You" : (names.get(winner.userId) ?? "Someone")} won the race`
    : "Nobody made it home";
  return (
    <section className="sg-card sg-stack race-outcome" aria-labelledby="race-outcome-title">
      <div className="sg-row" style={{ justifyContent: "space-between" }}>
        <h2 id="race-outcome-title" className="sg-h2" style={{ margin: 0 }}>
          {headline}
        </h2>
        <span className="sg-badge race">
          {game.laps} {game.laps === 1 ? "lap" : "laps"} ·{" "}
          {game.outcome?.reason === "finished"
            ? "Everyone finished"
            : game.outcome?.reason === "time"
              ? "Time's up"
              : "Ended by the host"}
        </span>
      </div>
      <table className="race-stats">
        <thead>
          <tr>
            <th scope="col">Pos</th>
            <th scope="col">Racer</th>
            <th scope="col">Time</th>
            <th scope="col" title="Hard hits on traffic, stalls and walls">
              Crashes
            </th>
          </tr>
        </thead>
        <tbody>
          {order.map((r) => (
            <tr key={r.userId} className={r.userId === meId ? "you" : ""}>
              <td className="sg-num">{r.place ?? "–"}</td>
              <th scope="row">
                <i className="race-swatch" style={{ background: carPaint(r.n) }} aria-hidden="true" />
                {names.get(r.userId) ?? "Racer"}
                {r.userId === meId && " (you)"}
              </th>
              <td className="sg-num">
                {r.finishMs !== null ? fmtTime(r.finishMs) : `DNF · ${Math.floor(r.done * 100)}%`}
              </td>
              <td className="sg-num">{r.crashes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function nearestS(p: { x: number; y: number }) {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < T.count; i += 4) {
    const d = (T.x[i]! - p.x) ** 2 + (T.y[i]! - p.y) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best * T.step;
}

/** Finished cars by place, then everyone else by distance. */
function standings(world: WorldCar[], g: RaceView) {
  const place = new Map(g.racers.map((r) => [r.n, r.place]));
  return [...world].sort((a, b) => {
    const pa = place.get(a.n) ?? null;
    const pb = place.get(b.n) ?? null;
    if (pa !== null || pb !== null) return (pa ?? Infinity) - (pb ?? Infinity);
    return b.progress - a.progress;
  });
}

/** How far our recent positions are from where the server put us. */
function driftFrom(trail: { x: number; y: number }[], c: CarState, x: number, y: number) {
  let best = Math.hypot(x - c.x, y - c.y);
  for (const p of trail) best = Math.min(best, Math.hypot(x - p.x, y - p.y));
  return best;
}

/** Enough delay to cover nearly every gap between recent snapshots, plus a margin. */
function interpTarget(arrivals: number[]) {
  if (arrivals.length < 4) return INTERP_MIN_MS;
  const gaps = arrivals.slice(1).map((t, i) => t - arrivals[i]!);
  gaps.sort((a, b) => a - b);
  const p90 = gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.9))]!;
  return Math.max(INTERP_MIN_MS, Math.min(INTERP_MAX_MS, p90 + 60));
}

/** Blends the two snapshots around render time, or carries cars on past the newest one. */
function interpolate(snaps: RaceSnapshot[], rt: number): WorldCar[] {
  if (!snaps.length) return [];
  const newest = snaps[snaps.length - 1]!;
  if (rt > newest.now) {
    const ahead = Math.min(rt - newest.now, EXTRAPOLATE_MS) / 1000;
    return newest.players.map((p) => {
      const h = p[3] / 100;
      // Finished cars stay put.
      const go = p[5] & RACE_FLAG.finished ? 0 : p[4] * ahead;
      const x = p[1] + Math.cos(h) * go;
      const y = p[2] + Math.sin(h) * go;
      // On a bend, a straight guess would leave the road, so it stops at the wall.
      const at = go ? clampToWalls(x, y, locate(x, y)) : { x, y };
      return { n: p[0], x: at.x, y: at.y, h, v: p[4], flags: p[5], progress: p[6] + go };
    });
  }
  let b = snaps.findIndex((s) => s.now >= rt);
  if (b === -1) b = snaps.length - 1;
  const a = Math.max(0, b - 1);
  const sa = snaps[a]!;
  const sb = snaps[b]!;
  const k = sb.now === sa.now ? 1 : Math.max(0, Math.min(1, (rt - sa.now) / (sb.now - sa.now)));
  const pa = new Map<number, RacePlayerTuple>(sa.players.map((p) => [p[0], p]));
  return sb.players.map((p) => {
    const q = pa.get(p[0]);
    // Don't slide across the map when the server moves a car.
    const blend = q && q[8] === p[8];
    return {
      n: p[0],
      x: blend ? lerp(q[1], p[1], k) : p[1],
      y: blend ? lerp(q[2], p[2], k) : p[2],
      h: blend ? lerpAngle(q[3] / 100, p[3] / 100, k) : p[3] / 100,
      v: p[4],
      flags: p[5],
      progress: blend ? lerp(q[6], p[6], k) : p[6],
    };
  });
}

function burst(ps: Particle[], x: number, y: number, count: number, color: string) {
  const until = performance.now() + 400;
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = 60 + Math.random() * 220;
    ps.push({
      x,
      y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      until: until - Math.random() * 150,
      color,
      size: 3 + Math.random() * 4,
    });
  }
  if (ps.length > 400) ps.splice(0, ps.length - 400);
}

function flame(ps: Particle[], c: CarState) {
  const back = R.car.length / 2 + 4;
  for (let i = 0; i < 2; i++) {
    const a = c.h + Math.PI + (Math.random() - 0.5) * 0.5;
    ps.push({
      x: c.x - Math.cos(c.h) * back,
      y: c.y - Math.sin(c.h) * back,
      vx: Math.cos(a) * 160 + Math.cos(c.h) * c.v * 0.6,
      vy: Math.sin(a) * 160 + Math.sin(c.h) * c.v * 0.6,
      until: performance.now() + 160 + Math.random() * 120,
      color: Math.random() < 0.5 ? "#4fe3ff" : "#ff4fd8",
      size: 4 + Math.random() * 5,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Drawing. The city is always a night-time neon scene, whatever the page theme.

const FONT = "Inter, system-ui, sans-serif";

/** Gear on the dash, from the speed shown beside it. */
function gearFor(v: number) {
  if (v < -5) return "R";
  const kmh = v * KMH;
  if (kmh < 4) return "N";
  return String(Math.min(8, 1 + Math.floor(kmh / 38)));
}

interface Scenery {
  mini: Path2D;
  miniBridge: Path2D;
}

let scenery: Scenery | null = null;

/** The minimap's paths never change, so they are built once. */
function getScenery(): Scenery {
  if (scenery) return scenery;
  const line = (keep: (i: number) => boolean) => {
    const p = new Path2D();
    let open = false;
    for (let i = 0; i <= T.count; i++) {
      const k = i % T.count;
      if (!keep(k)) {
        open = false;
        continue;
      }
      const pt = trackPoint(k * T.step, 0);
      if (open) p.lineTo(pt.x, pt.y);
      else p.moveTo(pt.x, pt.y);
      open = true;
    }
    return p;
  };
  scenery = { mini: line(() => true), miniBridge: line((i) => T.zone[i] === "bridge") };
  return scenery;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawMinimap(
  ctx: CanvasRenderingContext2D,
  s: Scenery,
  w: number,
  h: number,
  world: WorldCar[],
  me: CarState | null,
  myN: number,
) {
  const b = T.bounds;
  const size = Math.min(170, w * 0.2, h * 0.34);
  const sc = size / Math.max(b.maxX - b.minX, b.maxY - b.minY);
  const mw = (b.maxX - b.minX) * sc;
  const mh = (b.maxY - b.minY) * sc;
  const x0 = w - mw - 18;
  // Under the timing box, clear of the touch controls at the bottom.
  const y0 = Math.min(h - mh - 18, 92);
  ctx.save();
  ctx.fillStyle = "rgba(21, 21, 30, 0.8)";
  roundRect(ctx, x0 - 8, y0 - 6, mw + 16, mh + 12, 10);
  ctx.fill();
  ctx.translate(x0 - b.minX * sc, y0 - b.minY * sc);
  ctx.scale(sc, sc);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = 3 / sc;
  ctx.stroke(s.mini);
  ctx.strokeStyle = "#4fb3ff";
  ctx.lineWidth = 4 / sc;
  ctx.stroke(s.miniBridge);
  for (const c of world) {
    if (c.n === myN && me) continue;
    ctx.fillStyle = carPaint(c.n);
    ctx.beginPath();
    ctx.arc(c.x, c.y, 3.2 / sc, 0, Math.PI * 2);
    ctx.fill();
  }
  if (me) {
    ctx.fillStyle = carPaint(myN);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2 / sc;
    ctx.beginPath();
    ctx.arc(me.x, me.y, 5 / sc, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}
