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
  OBSTACLE_KINDS,
  RACE_BOXES,
  RACE_FLAG,
  RACE_ITEM,
  RACE_RULES as R,
  RACE_TRACK as T,
  buildCourse,
  mulberry32,
  moversAt,
  newCar,
  stepCar,
  trackPoint,
  type CarState,
  type ObstacleKind,
  type RaceCourse,
  type RacePlayerTuple,
  type RaceSnapshot,
  type RaceView,
  type SessionView,
} from "@spotflow-games/shared";
import { usePreferences } from "../lib/preferences";
import { getSocket } from "../lib/socket";
import { playSound } from "../lib/sound";

interface Props {
  session: SessionView;
  game: RaceView;
  meId: string;
}

/** Others are drawn this far in the past, so there are always two snapshots to blend between. */
const INTERP_MS = 150;
/** Send the car's position this often while it moves, and at least this often while it doesn't. */
const SEND_EVERY_MS = 100;
const HEARTBEAT_MS = 400;
/** Snap to the server's position when prediction drifts further than this. */
const SNAP_DIST = 160;
/** Displayed speed: units per second to km/h. */
const KMH = 0.3;

/** Car paint. Past ten racers, cars get one and then two racing stripes. */
const PAINT = [
  "#ff5a4e",
  "#2f9bff",
  "#3fd08b",
  "#ffc53d",
  "#c86bff",
  "#ff7ac8",
  "#2fe0d4",
  "#ff9a3d",
  "#a8ff4a",
  "#f4f4ff",
];
export const carPaint = (n: number) => PAINT[n % PAINT.length]!;

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
  item: number;
  district: string;
  clock: string;
  count: number | null;
  wrongWay: boolean;
  follow: string;
  board: Array<{ n: number; name: string; place: number; me: boolean; done: boolean }>;
}

const firstName = (name?: string) => name?.split(" ")[0] ?? "Racer";
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

export function RaceScreen({ session, game, meId }: Props) {
  const { soundEnabled } = usePreferences();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const touch = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
  const [full, setFull] = useState(touch);
  const [mapView, setMapView] = useState(false);
  const [hud, setHud] = useState<Hud>({
    pos: 1,
    of: game.racers.length,
    lap: 1,
    speed: 0,
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
  const car = useRef<CarState | null>(null);
  const meInfo = useRef({ k: -1, item: 0, finished: false, progress: -1, lapShown: 1 });
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
        // A new placement, or the server disagreeing a lot, puts us where the server says.
        if (!c || mine[8] !== m.k || Math.hypot(mine[1] - c.x, mine[2] - c.y) > SNAP_DIST) {
          const fresh = newCar(mine[1], mine[2], mine[3] / 100);
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
    const cam = { x: 0, y: 0, a: 0, zoom: 1, ready: false };
    let shakeUntil = 0;
    let wrongSince = 0;
    let lastCount: number | null = null;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      view = { w: rect.width, h: rect.height, dpr };
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

      // Everyone else, a little in the past.
      const world = interpolate(snaps.current, now - INTERP_MS);
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
      const rotate = !still && !overview;
      if (focus) {
        if (!cam.ready) {
          Object.assign(cam, { x: focus.x, y: focus.y, a: focus.h, ready: true });
        }
        const follow = 1 - Math.exp(-dt * 10);
        cam.x = lerp(cam.x, focus.x, follow);
        cam.y = lerp(cam.y, focus.y, follow);
        cam.a = lerpAngle(cam.a, focus.h, 1 - Math.exp(-dt * 4));
        cam.zoom = lerp(cam.zoom, 1 + Math.min(1, Math.abs(focus.v) / R.nitroSpeed) * 0.4, 1 - Math.exp(-dt * 2));
      }

      // Draw.
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ctx.fillStyle = COLORS.ground;
      ctx.fillRect(0, 0, view.w, view.h);
      ctx.save();
      let scale: number;
      let theta: number;
      let cx: number;
      let cy: number;
      let ox = cam.x;
      let oy = cam.y;
      if (overview) {
        const b = T.bounds;
        const pad = 400;
        scale = Math.min(view.w / (b.maxX - b.minX + pad * 2), view.h / (b.maxY - b.minY + pad * 2));
        theta = 0;
        cx = view.w / 2;
        cy = view.h / 2;
        ox = (b.minX + b.maxX) / 2;
        oy = (b.minY + b.maxY) / 2;
      } else {
        // About 500 units of road ahead on any screen, a bit more at speed.
        scale = Math.max(view.h, view.w * 0.6) / (720 * cam.zoom);
        theta = rotate ? -Math.PI / 2 - cam.a : 0;
        cx = view.w / 2;
        cy = rotate ? view.h * 0.66 : view.h / 2;
      }
      if (t < shakeUntil && !still) {
        cx += (Math.random() - 0.5) * 8;
        cy += (Math.random() - 0.5) * 8;
      }
      ctx.translate(cx, cy);
      ctx.rotate(theta);
      ctx.scale(scale, scale);
      ctx.translate(-ox, -oy);
      const radius = Math.hypot(view.w, view.h) / scale;
      const near = (x: number, y: number, pad = 200) =>
        Math.abs(x - ox) < radius + pad && Math.abs(y - oy) < radius + pad;

      drawScenery(ctx, scene, t, still, near, overview);
      for (const b of RACE_BOXES) if (!taken.has(b.id) && near(b.x, b.y)) drawBox(ctx, b.x, b.y, t, still);
      for (const s of slicks) if (near(s.x, s.y)) drawSlick(ctx, s.x, s.y, s.id);
      if (!overview) {
        for (const o of crs.statics) {
          const p = trackPoint(o.s, o.d);
          if (near(p.x, p.y)) drawObstacle(ctx, o.kind, p.x, p.y, p.h, o.v, false, t);
        }
        for (const mv of moversAt(crs, raceT)) {
          const p = trackPoint(mv.s, mv.d);
          if (near(p.x, p.y)) drawObstacle(ctx, mv.m.kind, p.x, p.y, p.h, mv.m.v2, mv.signal, t, mv.m.amp);
        }
      }
      for (const w of world) {
        if (w.n === myN && playing) continue;
        if (near(w.x, w.y)) drawCar(ctx, w.x, w.y, w.h, w.n, !!(w.flags & RACE_FLAG.boost), overview ? 2.6 : 1, t);
      }
      if (playing && c)
        drawCar(ctx, c.x, c.y, c.h, myN, now < c.boostUntil, overview ? 3 : 1, t, true, now < c.spinUntil);

      // Particles.
      const ps = particles.current;
      for (let i = ps.length - 1; i >= 0; i--) {
        const p = ps[i]!;
        if (performance.now() > p.until) {
          ps.splice(i, 1);
          continue;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        ctx.fillStyle = p.color;
        ctx.globalAlpha = Math.max(0, (p.until - performance.now()) / 400);
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
      ctx.globalAlpha = 1;
      drawGantry(ctx);
      ctx.restore();

      // Names, upright on screen.
      const toScreen = (x: number, y: number) => {
        const dx = (x - ox) * scale;
        const dy = (y - oy) * scale;
        return {
          x: cx + dx * Math.cos(theta) - dy * Math.sin(theta),
          y: cy + dx * Math.sin(theta) + dy * Math.cos(theta),
        };
      };
      ctx.font = `700 13px ${COLORS.body}`;
      ctx.textAlign = "center";
      ctx.lineWidth = 4;
      ctx.strokeStyle = COLORS.ink;
      for (const w of world) {
        if (w.n === myN && playing) continue;
        if (!near(w.x, w.y, 0)) continue;
        const p = toScreen(w.x, w.y);
        if (overview && world.length > 12) continue;
        const name = names.current.get(w.n) ?? "";
        ctx.strokeText(name, p.x, p.y - 22);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(name, p.x, p.y - 22);
      }

      if (!overview) drawMinimap(ctx, scene, view.w, view.h, world, playing && c ? c : null, myN);

      // HUD, a few times a second.
      if (t - lastHud > 120) {
        lastHud = t;
        const myProgress = playing ? meInfo.current.progress : -1;
        const pos = playing ? order.findIndex((o) => o.n === myN) + 1 : 0;
        const lap = Math.max(1, Math.min(g.laps, Math.floor(Math.max(0, myProgress) / T.length) + 1));
        const m = meInfo.current;
        if (playing && lap > m.lapShown && !m.finished) {
          m.lapShown = lap;
          setBanner(lap === g.laps ? "Final lap!" : `Lap ${lap} of ${g.laps}`);
          setAnnounce(lap === g.laps ? "Final lap." : `Lap ${lap}.`);
          playSound("correct", soundRef.current);
        }
        const countMs = g.goAt - now;
        const count = countMs > 0 ? Math.ceil(countMs / 1000) : countMs > -900 ? 0 : null;
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
  const top = hud.board.slice(0, 5);
  const mine = hud.board.find((b) => b.me);
  const shown = mine && !top.includes(mine) ? [...top.slice(0, 4), mine] : top;

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
        <canvas
          ref={canvasRef}
          className="race-canvas"
          tabIndex={0}
          role="img"
          aria-label={
            watching
              ? `Lagos Rush. Following ${hud.follow || "the leader"} through ${hud.district}.`
              : `Lagos Rush. You are ${ordinal(hud.pos)} of ${hud.of}, lap ${hud.lap} of ${game.laps}, in ${hud.district}.`
          }
        />

        <div className="race-hud-top">
          {!watching && (
            <div className="race-pos" aria-hidden="true">
              <b className="sg-num">
                {hud.pos}
                <small>{ordinal(hud.pos).replace(/\d+/, "")}</small>
              </b>
              <span className="sg-num">
                / {hud.of} · Lap {hud.lap}/{game.laps}
              </span>
            </div>
          )}
          <div className="race-mid">
            <span className="race-clock sg-num" role="timer" aria-label={`Race time ${hud.clock}`}>
              {hud.count !== null && hud.count > 0 ? "0:00.0" : hud.clock}
            </span>
            <span className="race-district">{hud.district}</span>
          </div>
        </div>

        <ol className="race-board" aria-label="Positions">
          {shown.map((b) => (
            <li key={b.n} className={b.me ? "me" : ""} style={{ "--c": carPaint(b.n) } as React.CSSProperties}>
              <span className="sg-num">{b.place}</span>
              <i aria-hidden="true" />
              {b.me ? "You" : b.name}
              {b.done && <Flag aria-label="finished" size={12} />}
            </li>
          ))}
        </ol>

        {hud.count !== null && (
          <div className={`race-count${hud.count === 0 ? " go" : ""}`} aria-live="assertive">
            <div className="race-lights" aria-hidden="true">
              {[3, 2, 1].map((n) => (
                <i key={n} className={hud.count === 0 ? "go" : hud.count !== null && hud.count <= n ? "on" : ""} />
              ))}
            </div>
            <b>{hud.count === 0 ? "GO!" : hud.count}</b>
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
          <div className={`race-dash${touch ? " touch" : ""}`}>
            <span className="race-speed sg-num" aria-label={`${hud.speed} kilometres an hour`}>
              {hud.speed}
              <small>km/h</small>
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

/** Blends the two snapshots around render time. */
function interpolate(snaps: RaceSnapshot[], rt: number): WorldCar[] {
  if (!snaps.length) return [];
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

const COLORS = {
  body: "Inter, system-ui, sans-serif",
  display: "system-ui, sans-serif",
  ground: "#0c0a1c",
  water: "#071a42",
  waterLine: "rgba(80, 170, 255, 0.22)",
  shoulder: "#2a2238",
  road: "#1c1a2b",
  lane: "rgba(255, 255, 255, 0.28)",
  edge: "#ff4fd8",
  rail: "#4fe3ff",
  ink: "#0d0b1f",
  danfo: "#ffc21a",
};

interface Scenery {
  shoulder: Path2D;
  road: Path2D;
  lanes: Path2D;
  edges: Path2D;
  rails: Path2D;
  barriers: Path2D;
  water: Path2D;
  ripples: Path2D;
  start: Array<{ x: number; y: number; h: number; d: number; dark: boolean }>;
  buildings: Array<{
    x: number;
    y: number;
    a: number;
    w: number;
    h: number;
    c: string;
    lit: string;
    windows: number[];
  }>;
  lamps: Array<{ x: number; y: number }>;
  signs: Array<{ x: number; y: number; h: number; name: string }>;
  mini: Path2D;
  miniBridge: Path2D;
}

let scenery: Scenery | null = null;

/** The track's paths and props never change, so they are built once. */
function getScenery(): Scenery {
  if (scenery) return scenery;
  const ring = (d: (i: number) => number) => {
    const p = new Path2D();
    for (const side of [1, -1]) {
      for (let i = 0; i <= T.count; i++) {
        const k = i % T.count;
        const pt = trackPoint(k * T.step, side * d(k));
        if (i === 0) p.moveTo(pt.x, pt.y);
        else p.lineTo(pt.x, pt.y);
      }
      p.closePath();
    }
    return p;
  };
  const line = (d: (i: number) => number, keep: (i: number) => boolean) => {
    const p = new Path2D();
    let open = false;
    for (let i = 0; i <= T.count; i++) {
      const k = i % T.count;
      if (!keep(k)) {
        open = false;
        continue;
      }
      const pt = trackPoint(k * T.step, d(k));
      if (open) p.lineTo(pt.x, pt.y);
      else p.moveTo(pt.x, pt.y);
      open = true;
    }
    return p;
  };
  const bridge = (i: number) => T.zone[i] === "bridge";
  const lanes = new Path2D();
  for (const d of [-80, 0, 80])
    lanes.addPath(
      line(
        () => d,
        () => true,
      ),
    );
  const edges = new Path2D();
  for (const side of [-1, 1])
    edges.addPath(
      line(
        (i) => side * T.half[i]!,
        () => true,
      ),
    );
  const rails = new Path2D();
  const barriers = new Path2D();
  for (const side of [-1, 1]) {
    rails.addPath(line((i) => side * T.wall[i]!, bridge));
    barriers.addPath(
      line(
        (i) => side * T.wall[i]!,
        (i) => !bridge(i),
      ),
    );
  }
  const water = line(() => 0, bridge);
  const ripples = new Path2D();
  for (const d of [-1300, -900, -500, 500, 900, 1300]) ripples.addPath(line(() => d, bridge));

  const rnd = mulberry32(9);
  const bridgeSamples: Array<[number, number]> = [];
  for (let i = 0; i < T.count; i += 4) if (bridge(i)) bridgeSamples.push([T.x[i]!, T.y[i]!]);
  const nearTrack = (x: number, y: number, clear: number) => {
    for (let i = 0; i < T.count; i += 2) if ((T.x[i]! - x) ** 2 + (T.y[i]! - y) ** 2 < clear * clear) return true;
    return false;
  };
  const inWater = (x: number, y: number) => bridgeSamples.some(([bx, by]) => (bx - x) ** 2 + (by - y) ** 2 < 1700 ** 2);
  const hues = ["#2a1f5c", "#3a1f4f", "#1f2d5c", "#2b2448", "#3b2a1f"];
  const lights = ["#ffd36b", "#4fe3ff", "#ff7ac8", "#a8ff4a"];
  const buildings: Scenery["buildings"] = [];
  for (let i = 0; i < T.count; i += 3) {
    if (bridge(i)) continue;
    for (const side of [-1, 1]) {
      if (rnd() < 0.25) continue;
      const w = 90 + rnd() * 140;
      const h = 70 + rnd() * 110;
      const off = T.wall[i]! + 50 + h / 2 + rnd() * 120;
      const p = trackPoint(i * T.step + rnd() * 60, side * off);
      if (inWater(p.x, p.y) || nearTrack(p.x, p.y, T.wall[i]! + Math.max(w, h) / 2 + 20)) continue;
      const windows: number[] = [];
      for (let k = 0; k < 10; k++) windows.push(rnd());
      buildings.push({
        x: p.x,
        y: p.y,
        a: p.h,
        w,
        h,
        c: hues[Math.floor(rnd() * hues.length)]!,
        lit: lights[Math.floor(rnd() * lights.length)]!,
        windows,
      });
    }
  }
  const lamps: Scenery["lamps"] = [];
  for (let i = 0; i < T.count; i += 6)
    for (const side of [-1, 1]) lamps.push(trackPoint(i * T.step, side * (T.wall[i]! + 6)));
  const signs = T.districts.map((d) => {
    const s = d.s + 160;
    const p = trackPoint(s, T.half[Math.floor(s / T.step) % T.count]! + 70);
    return { ...p, name: d.name };
  });
  const start: Scenery["start"] = [];
  for (let row = 0; row < 2; row++)
    for (let d = -150; d < 150; d += 20) {
      const p = trackPoint(row * 20 - 10, d + 10);
      start.push({ ...p, d, dark: (row + d / 20) % 2 === 0 });
    }
  const mini = line(
    () => 0,
    () => true,
  );
  const miniBridge = line(() => 0, bridge);
  scenery = {
    shoulder: ring((i) => T.wall[i]!),
    road: ring((i) => T.half[i]!),
    lanes,
    edges,
    rails,
    barriers,
    water,
    ripples,
    start,
    buildings,
    lamps,
    signs,
    mini,
    miniBridge,
  };
  return scenery;
}

function drawScenery(
  ctx: CanvasRenderingContext2D,
  s: Scenery,
  t: number,
  still: boolean,
  near: (x: number, y: number, pad?: number) => boolean,
  overview: boolean,
) {
  // The lagoon under the bridges.
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = COLORS.water;
  ctx.lineWidth = 3400;
  ctx.stroke(s.water);
  ctx.strokeStyle = COLORS.waterLine;
  ctx.lineWidth = 8;
  ctx.setLineDash([60, 140]);
  ctx.lineDashOffset = still ? 0 : -t / 40;
  ctx.stroke(s.ripples);
  ctx.setLineDash([]);

  if (!overview)
    for (const b of s.buildings) {
      if (!near(b.x, b.y, 300)) continue;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.a);
      ctx.fillStyle = b.c;
      ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.lineWidth = 3;
      ctx.strokeRect(-b.w / 2, -b.h / 2, b.w, b.h);
      // Rooftop lights.
      ctx.fillStyle = b.lit;
      for (let k = 0; k < b.windows.length; k++) {
        if (b.windows[k]! < 0.55) continue;
        const wx = -b.w / 2 + 12 + ((k % 5) * (b.w - 24)) / 5;
        const wy = -b.h / 2 + 12 + (Math.floor(k / 5) * (b.h - 24)) / 2;
        ctx.globalAlpha = 0.35 + b.windows[k]! * 0.5;
        ctx.fillRect(wx, wy, 10, 7);
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }

  ctx.fillStyle = COLORS.shoulder;
  ctx.fill(s.shoulder, "evenodd");
  ctx.fillStyle = COLORS.road;
  ctx.fill(s.road, "evenodd");
  ctx.strokeStyle = COLORS.lane;
  ctx.lineWidth = overview ? 0 : 4;
  if (!overview) {
    ctx.setLineDash([46, 54]);
    ctx.stroke(s.lanes);
    ctx.setLineDash([]);
  }
  ctx.lineWidth = overview ? 24 : 5;
  ctx.strokeStyle = COLORS.edge;
  ctx.globalAlpha = 0.7;
  ctx.stroke(s.edges);
  ctx.globalAlpha = 1;
  ctx.lineWidth = overview ? 30 : 8;
  ctx.strokeStyle = COLORS.rail;
  ctx.stroke(s.rails);
  ctx.strokeStyle = "#5a4f7a";
  ctx.stroke(s.barriers);

  if (overview) return;
  // Street lights.
  for (const l of s.lamps) {
    if (!near(l.x, l.y)) continue;
    ctx.fillStyle = "rgba(255, 211, 107, 0.07)";
    ctx.beginPath();
    ctx.arc(l.x, l.y, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffe7a8";
    ctx.beginPath();
    ctx.arc(l.x, l.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  // The start line.
  for (const q of s.start) {
    ctx.save();
    ctx.translate(q.x, q.y);
    ctx.rotate(q.h);
    ctx.fillStyle = q.dark ? "#0d0b1f" : "#ffffff";
    ctx.fillRect(-10, -10, 20, 20);
    ctx.restore();
  }
  // District signs, readable from the driver's seat.
  for (const sg of s.signs) {
    if (!near(sg.x, sg.y)) continue;
    ctx.save();
    ctx.translate(sg.x, sg.y);
    ctx.rotate(sg.h + Math.PI / 2);
    ctx.font = `800 26px ${COLORS.display}`;
    const w = ctx.measureText(sg.name).width + 36;
    ctx.fillStyle = "#0f7a43";
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 4;
    roundRect(ctx, -w / 2, -26, w, 52, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(sg.name, 0, 1);
    ctx.textBaseline = "alphabetic";
    ctx.restore();
  }
}

/** The Lekki toll gantry over the start line, drawn over the cars. */
function drawGantry(ctx: CanvasRenderingContext2D) {
  const p = trackPoint(70, 0);
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.h);
  ctx.globalAlpha = 0.88;
  ctx.fillStyle = "#2b2160";
  ctx.fillRect(-22, -250, 44, 500);
  ctx.strokeStyle = "#ffc21a";
  ctx.lineWidth = 4;
  ctx.strokeRect(-22, -250, 44, 500);
  for (let d = -200; d <= 200; d += 80) {
    ctx.fillStyle = d === 0 ? "#3fd08b" : "#ff5a4e";
    ctx.beginPath();
    ctx.arc(0, d, 6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.rotate(Math.PI / 2);
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#ffc21a";
  ctx.font = `800 22px ${COLORS.display}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("LEKKI TOLL GATE", 0, 0);
  ctx.textBaseline = "alphabetic";
  ctx.restore();
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

function drawCar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  h: number,
  n: number,
  boost: boolean,
  size: number,
  t: number,
  isMe = false,
  spinning = false,
) {
  const L = R.car.length * size;
  const W = R.car.width * size;
  const paint = carPaint(n);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(h);
  if (isMe) {
    ctx.strokeStyle = spinning ? "#ff4fd8" : "rgba(255,255,255,0.85)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(0, 0, L * 0.75, W * 1.1, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (boost) {
    ctx.fillStyle = `rgba(79, 227, 255, ${0.5 + 0.3 * Math.sin(t / 40)})`;
    ctx.beginPath();
    ctx.moveTo(-L / 2, -W / 3);
    ctx.lineTo(-L / 2 - 26 * size, 0);
    ctx.lineTo(-L / 2, W / 3);
    ctx.fill();
  }
  // Shadow, body, stripes, glass and lights.
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  roundRect(ctx, -L / 2 + 3, -W / 2 + 3, L, W, 6 * size);
  ctx.fill();
  ctx.fillStyle = paint;
  roundRect(ctx, -L / 2, -W / 2, L, W, 6 * size);
  ctx.fill();
  ctx.strokeStyle = COLORS.ink;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  const stripes = Math.floor(n / PAINT.length) % 3;
  ctx.fillStyle = COLORS.ink;
  if (stripes === 1) ctx.fillRect(-L / 2, -2 * size, L, 4 * size);
  if (stripes === 2) {
    ctx.fillRect(-L / 2, -5 * size, L, 3 * size);
    ctx.fillRect(-L / 2, 2 * size, L, 3 * size);
  }
  ctx.fillStyle = "rgba(13, 11, 31, 0.8)";
  roundRect(ctx, 2 * size, -W / 2 + 3 * size, 8 * size, W - 6 * size, 2);
  ctx.fill();
  roundRect(ctx, -L / 2 + 5 * size, -W / 2 + 3 * size, 5 * size, W - 6 * size, 2);
  ctx.fill();
  ctx.fillStyle = "#fff6c8";
  ctx.fillRect(L / 2 - 3 * size, -W / 2 + 2, 3 * size, 4 * size);
  ctx.fillRect(L / 2 - 3 * size, W / 2 - 2 - 4 * size, 3 * size, 4 * size);
  ctx.fillStyle = "#ff3d6e";
  ctx.fillRect(-L / 2, -W / 2 + 2, 2 * size, 4 * size);
  ctx.fillRect(-L / 2, W / 2 - 2 - 4 * size, 2 * size, 4 * size);
  ctx.restore();
}

function drawBox(ctx: CanvasRenderingContext2D, x: number, y: number, t: number, still: boolean) {
  const a = still ? 0.4 : t / 600;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = "rgba(255, 79, 216, 0.18)";
  ctx.beginPath();
  ctx.arc(0, 0, 30, 0, Math.PI * 2);
  ctx.fill();
  ctx.rotate(a);
  ctx.fillStyle = "#2b1d63";
  ctx.strokeStyle = "#4fe3ff";
  ctx.lineWidth = 3;
  roundRect(ctx, -15, -15, 30, 30, 6);
  ctx.fill();
  ctx.stroke();
  ctx.rotate(-a);
  ctx.fillStyle = "#ffd36b";
  ctx.font = `900 22px ${COLORS.display}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("?", 0, 1);
  ctx.textBaseline = "alphabetic";
  ctx.restore();
}

function drawSlick(ctx: CanvasRenderingContext2D, x: number, y: number, id: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(id);
  ctx.fillStyle = "#06050c";
  ctx.beginPath();
  ctx.ellipse(0, 0, R.slick.radius + 4, R.slick.radius - 4, 0, 0, Math.PI * 2);
  ctx.ellipse(12, 8, 14, 10, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(200, 107, 255, 0.55)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(-4, -3, 14, 8, 0.4, 0, Math.PI * 1.3);
  ctx.stroke();
  ctx.restore();
}

const SEDANS = ["#c9ced8", "#6b7385", "#b23a3a", "#2d5fa8", "#e8e8e8", "#3c3c46"];
const UMBRELLAS = [
  ["#ff5a4e", "#ffffff"],
  ["#2f9bff", "#ffc53d"],
  ["#3fd08b", "#ffffff"],
  ["#ff7ac8", "#ffc53d"],
];

function drawObstacle(
  ctx: CanvasRenderingContext2D,
  kind: ObstacleKind,
  x: number,
  y: number,
  h: number,
  v: number,
  signal: boolean,
  t: number,
  side = 1,
) {
  const k = OBSTACLE_KINDS[kind];
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(h);
  const L = k.hs * 2;
  const W = k.hd * 2;
  if (kind === "pothole") {
    ctx.fillStyle = "#0a0812";
    ctx.beginPath();
    ctx.ellipse(0, 0, k.hs, k.hd, v, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#3d3550";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = "rgba(80, 170, 255, 0.25)";
    ctx.beginPath();
    ctx.ellipse(3, 2, k.hs * 0.5, k.hd * 0.4, v, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === "cone") {
    ctx.fillStyle = "#ff8a1f";
    ctx.beginPath();
    ctx.arc(0, 0, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(0, 0, 4.5, 0, Math.PI * 2);
    ctx.stroke();
  } else if (kind === "stall") {
    const [a, b] = UMBRELLAS[v % UMBRELLAS.length]!;
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.beginPath();
    ctx.arc(4, 4, 27, 0, Math.PI * 2);
    ctx.fill();
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = i % 2 ? a! : b!;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, 27, (i / 8) * Math.PI * 2, ((i + 1) / 8) * Math.PI * 2);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(0, 0, 27, 0, Math.PI * 2);
    ctx.stroke();
  } else if (kind === "keke") {
    ctx.fillStyle = "#ffc21a";
    roundRect(ctx, -L / 2, -W / 2, L, W, 6);
    ctx.fill();
    ctx.fillStyle = "#1fa65a";
    roundRect(ctx, -L / 2 + 4, -W / 2 + 2, L - 12, W - 4, 4);
    ctx.fill();
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 2;
    roundRect(ctx, -L / 2, -W / 2, L, W, 6);
    ctx.stroke();
  } else if (kind === "danfo") {
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    roundRect(ctx, -L / 2 + 4, -W / 2 + 4, L, W, 5);
    ctx.fill();
    ctx.fillStyle = COLORS.danfo;
    roundRect(ctx, -L / 2, -W / 2, L, W, 5);
    ctx.fill();
    ctx.fillStyle = COLORS.ink;
    ctx.fillRect(-L / 2, -W / 2 + 6, L, 3);
    ctx.fillRect(-L / 2, W / 2 - 9, L, 3);
    ctx.fillStyle = "rgba(13,11,31,0.75)";
    ctx.fillRect(L / 2 - 12, -W / 2 + 3, 8, W - 6);
    // Roof rack.
    ctx.strokeStyle = "#7a5a00";
    ctx.lineWidth = 2;
    for (let i = -2; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 12, -W / 2 + 10);
      ctx.lineTo(i * 12, W / 2 - 10);
      ctx.stroke();
    }
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 2.5;
    roundRect(ctx, -L / 2, -W / 2, L, W, 5);
    ctx.stroke();
    // About to pull over: the indicator on the kerb side flashes.
    if (signal && Math.floor(t / 250) % 2 === 0) {
      ctx.fillStyle = "#ff9a1f";
      const yy = side > 0 ? W / 2 - 4 : -W / 2;
      ctx.fillRect(L / 2 - 6, yy, 6, 4);
      ctx.fillRect(-L / 2, yy, 6, 4);
      ctx.fillStyle = "rgba(255,154,31,0.35)";
      ctx.beginPath();
      ctx.arc(L / 2, yy + 2, 14, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (kind === "okada") {
    ctx.strokeStyle = "#1a1a24";
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-L / 2, 0);
    ctx.lineTo(L / 2, 0);
    ctx.stroke();
    ctx.strokeStyle = "#9aa0b4";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(L / 2 - 4, -7);
    ctx.lineTo(L / 2 - 4, 7);
    ctx.stroke();
    ctx.fillStyle = ["#ff5a4e", "#2f9bff", "#ffc53d", "#3fd08b"][v % 4]!;
    ctx.beginPath();
    ctx.arc(-2, 0, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = "#fff6c8";
    ctx.beginPath();
    ctx.arc(L / 2 + 1, 0, 2.5, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // A car stuck in go-slow, brake lights on.
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    roundRect(ctx, -L / 2 + 3, -W / 2 + 3, L, W, 6);
    ctx.fill();
    ctx.fillStyle = SEDANS[v % SEDANS.length]!;
    roundRect(ctx, -L / 2, -W / 2, L, W, 6);
    ctx.fill();
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = "rgba(13,11,31,0.7)";
    ctx.fillRect(2, -W / 2 + 3, 8, W - 6);
    ctx.fillRect(-L / 2 + 6, -W / 2 + 3, 6, W - 6);
    ctx.fillStyle = "#ff2d55";
    ctx.fillRect(-L / 2 - 1, -W / 2 + 2, 3, 5);
    ctx.fillRect(-L / 2 - 1, W / 2 - 7, 3, 5);
    ctx.fillStyle = "rgba(255,45,85,0.25)";
    ctx.fillRect(-L / 2 - 14, -W / 2, 14, W);
  }
  ctx.restore();
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
  const size = Math.min(190, w * 0.24);
  const sc = size / Math.max(b.maxX - b.minX, b.maxY - b.minY);
  const mw = (b.maxX - b.minX) * sc;
  const mh = (b.maxY - b.minY) * sc;
  const x0 = w - mw - 18;
  const y0 = 12;
  ctx.save();
  ctx.fillStyle = "rgba(11, 8, 32, 0.78)";
  roundRect(ctx, x0 - 8, y0 - 6, mw + 16, mh + 12, 10);
  ctx.fill();
  ctx.translate(x0 - b.minX * sc, y0 - b.minY * sc);
  ctx.scale(sc, sc);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = 3 / sc;
  ctx.stroke(s.mini);
  ctx.strokeStyle = COLORS.rail;
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
