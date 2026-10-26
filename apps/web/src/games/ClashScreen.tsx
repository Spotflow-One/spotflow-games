import { useEffect, useRef, useState } from "react";
import {
  Crosshair,
  Footprints,
  Maximize2,
  Minimize2,
  MousePointer2,
  RotateCcw,
  Shield,
  Swords,
  Zap,
} from "lucide-react";
import {
  CLASH_CENTER,
  CLASH_FLAG,
  CLASH_RULES as R,
  CLASH_TEAMS,
  CLASH_WALLS,
  clashBases,
  coverAlong,
  lineClear,
  resolveCircle,
  type ClashFeedTuple,
  type ClashNpcTuple,
  type ClashPlayerTuple,
  type ClashShape,
  type ClashShotTuple,
  type ClashSnapshot,
  type ClashView,
  type SessionView,
} from "@spotflow-games/shared";
import { usePreferences } from "../lib/preferences";
import { getSocket } from "../lib/socket";
import { playSound } from "../lib/sound";
import { useCountdown } from "../components/Timer";
import type { ClashFrame, ClashWorld } from "./clash3d";

interface Props {
  session: SessionView;
  game: ClashView;
  meId: string;
}

const W = R.arena.width;
const H = R.arena.height;
/** Shots fly at chest height. Matches the renderer. */
const SHOT_HEIGHT = 38;
/**
 * Others are drawn a little in the past, so there are two snapshots to blend between. The delay
 * follows how often snapshots actually arrive, which on a busy server or network is slower and
 * less even than the tick.
 */
const INTERP_MIN_MS = 150;
const INTERP_MAX_MS = 600;
/** Past the newest snapshot, soldiers keep moving the way they were for up to this long. */
const EXTRAPOLATE_MS = 350;
/** How far back we remember our own position, to match against the server's older view of it. */
const HISTORY_MS = 4000;
/** Send controls at most this often while they change, and at least this often while idle. */
const SEND_EVERY_MS = 66;
const HEARTBEAT_MS = 400;
/**
 * Snap to the server's position only when it stays further than this from anywhere we have
 * recently been, for this long, so a network stall doesn't yank you backwards.
 */
const SNAP_DIST = 90;
const SNAP_AFTER_MS = 1500;
const STICK_RADIUS = 56;
/** Turning, in radians: per pixel of mouse or finger, and per second on the arrow keys. */
const MOUSE_TURN = 0.0028;
const TOUCH_TURN = 0.008;
const KEY_TURN = 2.6;
/**
 * Aim help: a shot goes straight at an enemy this close to the crosshair, in radians. Space and
 * the phone's fire button help more, since they can't aim as finely as a mouse.
 */
const ASSIST_NARROW = 0.06;
const ASSIST_WIDE = 0.3;
/** Enemies further than this are never spotted on the minimap or named. */
const SPOT_RANGE = 1400;
/** Enemies this close show on the minimap even behind cover: you can hear them. */
const HEAR_RANGE = 350;

interface Shot {
  t: ClashShotTuple;
  goneAt: number;
}
interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  until: number;
  color: string;
  size: number;
}
interface Stick {
  id: number;
  ox: number;
  oy: number;
  x: number;
  y: number;
}
interface Hud {
  power: number[];
  hp: number;
  alive: boolean;
  respawn: number;
  points: number;
  feed: Array<{ key: number; text: string; mine: boolean; team: number }>;
  titan: { hp: number; maxHp: number } | null;
}

const firstName = (name?: string) => name?.split(" ")[0] ?? "Someone";
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const angleDiff = (a: number, b: number) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
};
const lerpAngle = (a: number, b: number, t: number) => a + angleDiff(a, b) * t;
const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Starts downloading the 3D renderer early, from the lobby, so the game opens straight away. */
export const preloadClash3d = () => import("./clash3d").catch(() => undefined);

export function ClashScreen({ session, game, meId }: Props) {
  const { soundEnabled } = usePreferences();
  const seconds = useCountdown(game.endsAt, game.serverNow);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<ClashWorld | null>(null);
  const dodgeRef = useRef<HTMLElement | null>(null);
  const [noGl, setNoGl] = useState(false);
  const touch = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
  const [full, setFull] = useState(touch);
  const [locked, setLocked] = useState(false);
  const [hud, setHud] = useState<Hud>({
    power: game.power,
    hp: R.playerHp,
    alive: true,
    respawn: 0,
    points: 0,
    feed: [],
    titan: null,
  });
  const [banner, setBanner] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");

  // Everything the render loop reads lives in refs, so a state push never restarts it.
  const gameRef = useRef(game);
  gameRef.current = game;
  const soundRef = useRef(soundEnabled);
  soundRef.current = soundEnabled;
  const names = useRef(new Map<number, string>());
  names.current = new Map(
    game.players.map((p) => [p.n, firstName(session.participants.find((x) => x.userId === p.userId)?.displayName)]),
  );
  const teams = useRef(new Map<number, number>());
  teams.current = new Map(game.players.map((p) => [p.n, p.team]));

  const snaps = useRef<ClashSnapshot[]>([]);
  const offsets = useRef<number[]>([]);
  const arrivals = useRef<number[]>([]);
  const trail = useRef<{ t: number; x: number; y: number }[]>([]);
  const shots = useRef(new Map<number, Shot>());
  const particles = useRef<Particle[]>([]);
  const me = useRef({ x: 0, y: 0, life: -1, alive: false, hurtAt: 0, downAt: 0, driftSince: 0, flags: 0 });
  const controls = useRef({
    keys: new Set<string>(),
    mouseDown: false,
    spaceDown: false,
    fireBtn: false,
    yaw: 0,
    shotCount: 0,
    lastLocalShot: 0,
    /** A dodge asked for; counted up when it starts, which is what the server watches. */
    dodgeAsked: false,
    dodgeCount: 0,
    dodgeReadyAt: 0,
    dash: null as { until: number; dx: number; dy: number } | null,
    move: null as Stick | null,
    look: null as Stick | null,
  });
  const sent = useRef({ at: 0, body: "" });
  const feedKey = useRef(0);

  const serverNow = () => {
    const o = offsets.current;
    return Date.now() + (o.length ? Math.max(...o) : 0);
  };

  // Snapshots.
  useEffect(() => {
    const onSnapshot = (snap: ClashSnapshot) => {
      const recv = Date.now();
      arrivals.current.push(recv);
      if (arrivals.current.length > 21) arrivals.current.shift();
      offsets.current.push(snap.now - recv);
      if (offsets.current.length > 30) offsets.current.shift();
      snaps.current.push(snap);
      if (snaps.current.length > 12) snaps.current.shift();
      for (const t of snap.shots) shots.current.set(t[0], { t, goneAt: Infinity });
      for (const id of snap.gone) {
        const s = shots.current.get(id);
        if (s) s.goneAt = snap.now;
      }

      const g = gameRef.current;
      const myN = g.me?.n ?? -1;
      const mine = snap.players.find((p) => p[0] === myN);
      const m = me.current;
      if (mine) {
        const alive = !!(mine[5] & CLASH_FLAG.alive);
        // A new life, or the server disagreeing for a while, puts us where the server says. The
        // server's view is from a moment ago, so it is matched against where we have been.
        const off = alive && driftFrom(trail.current, m, mine[1], mine[2]) > SNAP_DIST;
        if (!off) m.driftSince = 0;
        else m.driftSince ||= recv;
        if (mine[6] !== m.life || (off && recv - m.driftSince > SNAP_AFTER_MS)) {
          if (mine[6] !== m.life) {
            // Fresh from the base: face the middle of the war zone.
            controls.current.yaw = Math.atan2(CLASH_CENTER.y - mine[2], CLASH_CENTER.x - mine[1]);
          }
          m.x = mine[1];
          m.y = mine[2];
          m.life = mine[6];
          m.driftSince = 0;
          trail.current = [];
        }
        if (mine[5] & CLASH_FLAG.hurt) {
          m.hurtAt = performance.now();
          playSound("boom", soundRef.current);
        }
        if (m.alive && !alive) {
          m.downAt = performance.now();
          setAnnounce("You were tagged. Respawning soon.");
        }
        m.alive = alive;
        m.flags = mine[5];
      }

      // Effects and the kill feed.
      const people = new Map(snap.players.map((p) => [p[0], p]));
      const npcs = new Map<number, ClashNpcTuple>();
      for (const s of snaps.current.slice(-3)) for (const n of s.npcs) npcs.set(n[0], n);
      const feed: Hud["feed"] = [];
      for (const f of snap.feed) {
        const [by, what, victim, team] = f;
        const at = what === 0 ? people.get(victim) : npcs.get(victim);
        if (at)
          burst(
            particles.current,
            what === 0 ? at[1] : at[2],
            what === 0 ? at[2] : at[3],
            what === 2 ? 60 : 40,
            what === 2 ? 40 : 18,
            "#ffd36b",
          );
        const mineFeed = by === myN || (what === 0 && victim === myN);
        if (by === myN) playSound(what === 2 ? "winner" : "correct", soundRef.current);
        if (what === 2) {
          const name = CLASH_TEAMS[team]?.name ?? "A team";
          setBanner(`${name} took down the Titan! +${R.titan.power}`);
          setAnnounce(`${name} took down the Titan.`);
        }
        // A bot's knockout is shown in the colour of the player it knocked out.
        const shownTeam = team >= 0 ? team : (teams.current.get(victim) ?? 0);
        feed.push({ key: feedKey.current++, text: feedText(f, names.current), mine: mineFeed, team: shownTeam });
      }
      const titan = snap.npcs.find((n) => n[1] === 1);
      const hadTitan =
        snaps.current.length > 1 && snaps.current[snaps.current.length - 2]!.npcs.some((n) => n[1] === 1);
      if (titan && !hadTitan) {
        setBanner("The Titan has awakened in the plaza!");
        setAnnounce("The Titan has awakened in the middle of the war zone.");
      }

      setHud((h) => ({
        power: snap.power,
        hp: mine ? mine[4] : h.hp,
        alive: mine ? !!(mine[5] & CLASH_FLAG.alive) : true,
        respawn: mine ? mine[8] / 10 : 0,
        points: mine ? mine[7] : h.points,
        feed: [...feed, ...h.feed].slice(0, 3),
        titan: titan ? { hp: titan[4], maxHp: titan[5] } : null,
      }));
    };
    const socket = getSocket();
    const onEvent = ({ code, event }: { code: string; event: unknown }) => {
      if (code === session.code && (event as ClashSnapshot)?.type === "snap") onSnapshot(event as ClashSnapshot);
    };
    socket.on("game:event", onEvent);
    return () => {
      socket.off("game:event", onEvent);
    };
  }, [session.code]);

  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), 3500);
    return () => clearTimeout(t);
  }, [banner]);

  // Old feed lines fade out.
  useEffect(() => {
    if (!hud.feed.length) return;
    const t = setTimeout(() => setHud((h) => ({ ...h, feed: h.feed.slice(0, -1) })), 4000);
    return () => clearTimeout(t);
  }, [hud.feed]);

  // Keyboard.
  useEffect(() => {
    const c = controls.current;
    const gameKey = (k: string) =>
      ["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", " ", "shift"].includes(k);
    const typing = (e: KeyboardEvent) =>
      e.target instanceof HTMLElement &&
      (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (typing(e) || !gameKey(k)) return;
      e.preventDefault();
      if (k === " ") {
        if (!c.spaceDown) c.shotCount++;
        c.spaceDown = true;
      } else if (k === "shift") {
        if (!e.repeat) c.dodgeAsked = true;
      } else c.keys.add(k);
    };
    const up = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === " ") c.spaceDown = false;
      else c.keys.delete(k);
    };
    const blur = () => {
      c.keys.clear();
      c.spaceDown = false;
      c.mouseDown = false;
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
    let made: ClashWorld | null = null;
    import("./clash3d")
      .then((m) => {
        if (!alive || !glRef.current) return;
        made = m.createClashWorld(glRef.current);
        worldRef.current = made;
      })
      .catch(() => alive && setNoGl(true));
    return () => {
      alive = false;
      worldRef.current = null;
      made?.dispose();
    };
  }, []);

  // The render and input loop.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let last = performance.now();
    let frame = 0;
    let colors = readColors();
    let view = { w: 0, h: 0, dpr: 1 };
    let sizedWorld: ClashWorld | null = null;
    let interpMs = INTERP_MIN_MS;
    let spotted = new Set<number>();
    let inSight = new Set<number>();
    let spottedAt = 0;

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

    const c = controls.current;
    const isLocked = () => document.pointerLockElement === canvas;
    const onMouseMove = (e: MouseEvent) => {
      if (isLocked() || c.mouseDown) c.yaw += e.movementX * MOUSE_TURN;
    };
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      canvas.focus();
      if (!isLocked() && gameRef.current.isPlayer) {
        // Some browsers return a promise that rejects when lock is refused; dragging still turns.
        const asked = canvas.requestPointerLock?.() as unknown;
        if (asked instanceof Promise) asked.catch(() => undefined);
      }
      c.mouseDown = true;
      c.shotCount++;
    };
    const onMouseUp = () => {
      c.mouseDown = false;
    };
    const onLockChange = () => setLocked(isLocked());
    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      for (const t of Array.from(e.changedTouches)) {
        const x = t.clientX - rect.left;
        const y = t.clientY - rect.top;
        const stick = { id: t.identifier, ox: x, oy: y, x, y };
        if (x < rect.width * 0.45) c.move ??= stick;
        else c.look ??= stick;
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      for (const t of Array.from(e.changedTouches)) {
        const x = t.clientX - rect.left;
        const y = t.clientY - rect.top;
        if (c.move?.id === t.identifier) Object.assign(c.move, { x, y });
        if (c.look?.id === t.identifier) {
          // Dragging on the right turns, like a mouse.
          c.yaw += (x - c.look.x) * TOUCH_TURN;
          Object.assign(c.look, { x, y });
        }
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (c.move?.id === t.identifier) c.move = null;
        if (c.look?.id === t.identifier) c.look = null;
      }
    };
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    document.addEventListener("pointerlockchange", onLockChange);
    canvas.addEventListener("touchstart", onTouchStart, { passive: false });
    canvas.addEventListener("touchmove", onTouchMove, { passive: false });
    canvas.addEventListener("touchend", onTouchEnd);
    canvas.addEventListener("touchcancel", onTouchEnd);

    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      if (++frame % 60 === 0) colors = readColors();
      const g = gameRef.current;
      const m = me.current;
      const now = serverNow();
      const myN = g.me?.n ?? -1;
      const myTeam = g.me?.team ?? -2;
      const playing = g.isPlayer && !!g.me && m.life >= 0;
      const alive = playing && m.alive;

      // Everyone else, a little in the past. The delay eases toward its target so time never jumps.
      interpMs += (interpTarget(arrivals.current) - interpMs) * Math.min(1, dt * 2);
      const rt = now - interpMs;
      const world = interpolate(snaps.current, rt);

      // Turn and move, relative to the way you face.
      const k = c.keys;
      c.yaw += ((k.has("arrowright") ? 1 : 0) - (k.has("arrowleft") ? 1 : 0)) * KEY_TURN * dt;
      let fwd = 0;
      let side = 0;
      if (c.move) {
        const dx = c.move.x - c.move.ox;
        const dy = c.move.y - c.move.oy;
        const len = Math.hypot(dx, dy);
        if (len > 8) {
          const s = Math.min(1, len / STICK_RADIUS) / len;
          side = dx * s;
          fwd = -dy * s;
        }
      } else {
        fwd = (k.has("w") || k.has("arrowup") ? 1 : 0) - (k.has("s") || k.has("arrowdown") ? 1 : 0);
        side = (k.has("d") ? 1 : 0) - (k.has("a") ? 1 : 0);
        const len = Math.hypot(fwd, side);
        if (len > 1) {
          fwd /= len;
          side /= len;
        }
      }
      const fx = Math.cos(c.yaw);
      const fy = Math.sin(c.yaw);
      // A dodge rolls the way you're moving, or to your right when standing still.
      if (c.dodgeAsked) {
        c.dodgeAsked = false;
        if (alive && t >= c.dodgeReadyAt && !c.dash) {
          let dx = fx * fwd - fy * side;
          let dy = fy * fwd + fx * side;
          const len = Math.hypot(dx, dy);
          if (len > 0.1) {
            dx /= len;
            dy /= len;
          } else {
            dx = -fy;
            dy = fx;
          }
          c.dash = { until: t + R.dodge.ms, dx, dy };
          c.dodgeCount++;
          c.dodgeReadyAt = t + R.dodge.cooldownMs;
          burst(particles.current, m.x, m.y, 2, 10, "#c9b08a");
        }
      }
      if (c.dash && (t >= c.dash.until || !alive)) c.dash = null;
      if (c.dash) {
        const step = (R.dodge.distance / R.dodge.ms) * 1000 * dt;
        const p = resolveCircle(m.x + c.dash.dx * step, m.y + c.dash.dy * step, R.playerRadius);
        m.x = p.x;
        m.y = p.y;
      } else if (alive && (fwd || side)) {
        const step = R.playerSpeed * dt;
        const p = resolveCircle(
          m.x + (fx * fwd - fy * side) * step,
          m.y + (fy * fwd + fx * side) * step,
          R.playerRadius,
        );
        m.x = p.x;
        m.y = p.y;
      }
      if (playing) {
        const tr = trail.current;
        tr.push({ t: now, x: m.x, y: m.y });
        while (tr.length && tr[0]!.t < now - HISTORY_MS) tr.shift();
      }

      // Who can be seen: by you, for names, and by anyone on your team, for the minimap.
      if (t - spottedAt > 100) {
        spottedAt = t;
        const mates = playing ? world.players.filter((p) => teams.current.get(p.n) === myTeam && p.n !== myN) : [];
        if (alive) mates.push({ n: myN, x: m.x, y: m.y, a: 0, hp: 0, flags: 0 });
        spotted = new Set();
        inSight = new Set();
        for (const p of world.players) {
          if (!playing || teams.current.get(p.n) === myTeam) continue;
          const d = Math.hypot(p.x - m.x, p.y - m.y);
          if (alive && d < SPOT_RANGE && lineClear(m.x, m.y, p.x, p.y)) inSight.add(p.n);
          if (
            inSight.has(p.n) ||
            (alive && d < HEAR_RANGE) ||
            p.flags & CLASH_FLAG.firing ||
            mates.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < SPOT_RANGE && lineClear(q.x, q.y, p.x, p.y))
          )
            spotted.add(p.n);
        }
      }

      // Fire, with a little help onto an enemy right by the crosshair.
      const trigger = c.mouseDown || c.spaceDown || c.fireBtn;
      const wide = c.spaceDown || c.fireBtn || touch;
      const target = alive
        ? assistTarget(world, m, c.yaw, wide ? ASSIST_WIDE : ASSIST_NARROW, myTeam, teams.current)
        : null;
      // On a phone, holding fire also turns you gently onto the target.
      if (target && c.fireBtn) c.yaw = lerpAngle(c.yaw, target.a, Math.min(1, dt * 5));
      const aim = target && trigger ? target.a : c.yaw;
      // No shooting mid-roll.
      const firing = alive && trigger && !c.dash;
      if (firing && t - c.lastLocalShot >= R.fireCooldownMs) {
        c.lastLocalShot = t;
        playSound("zap", soundRef.current);
      }

      // Send controls.
      if (playing) {
        const body = JSON.stringify({
          x: Math.round(m.x * 10) / 10,
          y: Math.round(m.y * 10) / 10,
          a: Math.round(aim * 100) / 100,
          f: firing,
          s: c.shotCount,
          l: m.life,
          d: c.dodgeCount,
        });
        const since = t - sent.current.at;
        if ((body !== sent.current.body && since >= SEND_EVERY_MS) || since >= HEARTBEAT_MS) {
          sent.current = { at: t, body };
          getSocket().volatile.emit("game:input", { code: session.code, input: JSON.parse(body) as unknown });
        }
      }
      // Keep the angle small, as the server only takes angles within a few turns.
      if (Math.abs(c.yaw) > Math.PI * 2) c.yaw = Math.atan2(Math.sin(c.yaw), Math.cos(c.yaw));

      // Shots move in straight lines, so each is drawn exactly where it is now.
      const shotList: ClashFrame["shots"] = [];
      for (const [id, s] of shots.current) {
        const [, x0, y0, vx, vy, team, t0, owner] = s.t;
        const at = owner === myN ? now : rt;
        if (at >= s.goneAt || at - t0 > 3000) {
          if (at >= s.goneAt && at - t0 < 3000) {
            const e = (s.goneAt - t0) / 1000;
            burst(particles.current, x0 + vx * e, y0 + vy * e, SHOT_HEIGHT, 5, team < 0 ? "#ff4fd8" : "#ffe9a8");
          }
          shots.current.delete(id);
          continue;
        }
        if (at < t0) continue;
        const e = (at - t0) / 1000;
        shotList.push({ id, x: x0 + vx * e, y: y0 + vy * e, vx, vy, team });
      }

      // The dodge meter fills as the roll recharges.
      const meter = dodgeRef.current;
      if (meter) {
        const ready = Math.max(0, Math.min(1, 1 - (c.dodgeReadyAt - t) / R.dodge.cooldownMs));
        meter.style.setProperty("--r", ready.toFixed(3));
        meter.classList.toggle("ready", ready >= 1);
      }

      // The 3D world.
      const w3 = worldRef.current;
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ctx.clearRect(0, 0, view.w, view.h);
      if (!w3) return;
      if (sizedWorld !== w3) {
        w3.resize(view.w, view.h, Math.min(touch ? 1.5 : 2, view.dpr));
        sizedWorld = w3;
      }
      const players: ClashFrame["players"] = world.players
        .filter((p) => !(p.n === myN && playing))
        .map((p) => ({ n: p.n, x: p.x, y: p.y, a: p.a, team: teams.current.get(p.n) ?? 0, flags: p.flags }));
      if (alive) {
        let flags = m.flags & CLASH_FLAG.shield;
        if (firing) flags |= CLASH_FLAG.firing;
        if (c.dash) flags |= CLASH_FLAG.dodge;
        if (performance.now() - m.hurtAt < 120) flags |= CLASH_FLAG.hurt;
        players.push({ n: myN, x: m.x, y: m.y, a: aim, team: myTeam, flags });
      }
      w3.render({
        t,
        still,
        focus: playing
          ? { x: m.x, y: m.y, yaw: c.yaw, down: m.alive ? 0 : Math.min(1, (performance.now() - m.downAt) / 900) }
          : null,
        players,
        npcs: world.npcs,
        shots: shotList,
        teamColors: colors.team,
      });

      // Names over teammates, and over enemies you can see.
      ctx.textAlign = "center";
      for (const p of players) {
        if (p.n === myN && playing) continue;
        const ally = p.team === myTeam;
        if (playing && !ally && !inSight.has(p.n)) continue;
        const at = w3.project(p.x, p.y, 76);
        if (!at || at.x < -40 || at.x > view.w + 40 || at.y < -20 || at.y > view.h + 20) continue;
        const hp = world.players.find((q) => q.n === p.n)?.hp ?? R.playerHp;
        drawLabel(ctx, colors, at.x, at.y, names.current.get(p.n) ?? "", p.team, hp, ally || !playing);
      }

      // Sparks.
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
        p.z = Math.max(0, p.z + p.vz * dt);
        p.vz -= 500 * dt;
        const at = w3.project(p.x, p.y, p.z);
        if (!at) continue;
        const s = Math.max(1.5, Math.min(10, p.size * at.scale));
        ctx.globalAlpha = Math.max(0, (p.until - pnow) / 400);
        ctx.fillStyle = p.color;
        ctx.fillRect(at.x - s / 2, at.y - s / 2, s, s);
      }
      ctx.globalAlpha = 1;

      // Crosshair where a shot would land, and brackets on a target the aim help has picked.
      if (alive) {
        const reach = R.shotRange * Math.min(1, rayFraction(m.x, m.y, c.yaw, R.shotRange));
        const at = w3.project(m.x + fx * reach, m.y + fy * reach, SHOT_HEIGHT);
        if (at) drawCrosshair(ctx, at.x, at.y, !!target, t - c.lastLocalShot < 80);
        if (target) {
          const tat = w3.project(target.x, target.y, 34);
          if (tat) drawBrackets(ctx, tat.x, tat.y, Math.max(14, 30 * tat.scale));
        }
      }

      // A red edge when you're hit.
      const hurt = 1 - (performance.now() - m.hurtAt) / 400;
      if (alive && hurt > 0) {
        const grad = ctx.createRadialGradient(
          view.w / 2,
          view.h / 2,
          Math.min(view.w, view.h) * 0.3,
          view.w / 2,
          view.h / 2,
          Math.max(view.w, view.h) * 0.7,
        );
        grad.addColorStop(0, "rgba(255,40,40,0)");
        grad.addColorStop(1, `rgba(255,40,40,${0.45 * hurt})`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, view.w, view.h);
      }

      // Minimap: top left on phones, where thumbs aren't; bottom right on bigger screens.
      const mw = touch || view.w < 720 ? Math.min(150, view.w * 0.26) : 220;
      const mh = (mw * H) / W;
      const mx0 = touch || view.w < 720 ? 8 : view.w - mw - 10;
      const my0 = touch || view.w < 720 ? (view.w < 720 ? 66 : 52) : view.h - mh - 10;
      drawMinimap(ctx, colors, mx0, my0, mw, {
        players: world.players
          .filter((p) => !(p.n === myN && playing))
          .filter((p) => !playing || teams.current.get(p.n) === myTeam || spotted.has(p.n))
          .map((p) => ({ x: p.x, y: p.y, team: teams.current.get(p.n) ?? 0 })),
        npcs: world.npcs,
        me: alive ? { x: m.x, y: m.y, yaw: c.yaw, team: myTeam } : null,
        still,
        t,
      });

      // Touch sticks.
      for (const s of [c.move]) {
        if (!s) continue;
        ctx.strokeStyle = "rgba(255,255,255,0.35)";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(s.ox, s.oy, STICK_RADIUS, 0, Math.PI * 2);
        ctx.stroke();
        const dx = s.x - s.ox;
        const dy = s.y - s.oy;
        const len = Math.min(STICK_RADIUS, Math.hypot(dx, dy));
        const ang = Math.atan2(dy, dx);
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.beginPath();
        ctx.arc(s.ox + Math.cos(ang) * len, s.oy + Math.sin(ang) * len, 24, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      if (isLocked()) document.exitPointerLock();
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("pointerlockchange", onLockChange);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
      canvas.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [session.code]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (game.isPlayer) canvasRef.current?.focus();
  }, [game.isPlayer]);

  const dodgeNow = (e: React.PointerEvent) => {
    e.preventDefault();
    controls.current.dodgeAsked = true;
  };
  const fireHold = {
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      controls.current.fireBtn = true;
      controls.current.shotCount++;
    },
    onPointerUp: () => {
      controls.current.fireBtn = false;
    },
    onPointerCancel: () => {
      controls.current.fireBtn = false;
    },
    onLostPointerCapture: () => {
      controls.current.fireBtn = false;
    },
  };

  const myTeam = game.me?.team ?? null;
  const mm = Math.floor(seconds / 60);
  const ss = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  const leader = hud.power.indexOf(Math.max(...hud.power));

  return (
    <div className={`clash-stage${full ? " full" : ""}`}>
      <div className="clash-frame">
        <canvas ref={glRef} className="clash-canvas" aria-hidden="true" />
        <canvas
          ref={canvasRef}
          className={`clash-canvas clash-overlay${locked ? " locked" : ""}`}
          tabIndex={0}
          role="img"
          aria-label={`Core Clash war zone. ${hud.power
            .map((p, i) => `${CLASH_TEAMS[i]!.name} ${p} of ${game.target}`)
            .join(", ")}.`}
        />
        {noGl && (
          <p className="clash-nogl" role="alert">
            Core Clash needs 3D graphics (WebGL), which this browser has turned off. Try another browser or turn on
            hardware acceleration.
          </p>
        )}

        <div className="clash-hud-top">
          {hud.power.map((p, i) => (
            <div
              key={i}
              className={`clash-power${i === myTeam ? " mine" : ""}${i === leader && p > 0 ? " lead" : ""}`}
              style={{ "--t": `var(--clash-team-${i})`, "--p": Math.min(1, p / game.target) } as React.CSSProperties}
            >
              <span className="clash-power-name">
                <TeamShape shape={CLASH_TEAMS[i]!.shape} />
                {CLASH_TEAMS[i]!.name}
                {i === myTeam && <small> (you)</small>}
              </span>
              <span className="clash-power-bar" aria-hidden="true">
                <i />
              </span>
              <span className="sg-num">
                {p}/{game.target}
              </span>
            </div>
          ))}
          <div
            className={`clash-clock sg-num${seconds <= 30 ? " urgent" : ""}`}
            role="timer"
            aria-label={`${mm} minutes ${ss} seconds left`}
          >
            {mm}:{ss}
          </div>
        </div>

        <div className="clash-hud-mid">
          {hud.titan && (
            <div className="clash-titan" aria-label={`Titan health ${hud.titan.hp} of ${hud.titan.maxHp}`}>
              <span>
                <Swords aria-hidden="true" size={14} /> Titan
              </span>
              <span className="clash-titan-bar" aria-hidden="true">
                <i style={{ width: `${(100 * hud.titan.hp) / hud.titan.maxHp}%` }} />
              </span>
            </div>
          )}
        </div>

        {banner && (
          <div className="clash-banner pop-in" role="status">
            <Zap aria-hidden="true" size={18} />
            {banner}
          </div>
        )}

        {game.isPlayer && !hud.alive && (
          <div className="clash-down">
            <b>Tagged</b>
            <span className="sg-num">Back in {Math.max(0, hud.respawn).toFixed(1)}s</span>
          </div>
        )}

        {!touch && game.isPlayer && hud.alive && !locked && !noGl && (
          <div className="clash-lock">
            <MousePointer2 aria-hidden="true" size={16} />
            Click to aim with your mouse. <kbd>Esc</kbd> lets go.
          </div>
        )}

        {game.isPlayer && game.me && (
          <div className="clash-me" style={{ "--t": `var(--clash-team-${game.me.team})` } as React.CSSProperties}>
            <span className="clash-me-team">
              <TeamShape shape={CLASH_TEAMS[game.me.team]!.shape} />
              {CLASH_TEAMS[game.me.team]!.name}
            </span>
            <span className="clash-hp" aria-label={`Health ${hud.hp}`}>
              <Shield aria-hidden="true" size={14} />
              <span className="clash-hp-bar" aria-hidden="true">
                <i style={{ width: `${hud.hp}%` }} className={hud.hp <= 30 ? "low" : ""} />
              </span>
              <span className="sg-num">{hud.hp}</span>
            </span>
            {!touch && (
              <span
                className="clash-dodge"
                aria-hidden="true"
                ref={(el) => {
                  dodgeRef.current = el;
                }}
              >
                <Footprints size={14} />
                <i />
                <kbd>Shift</kbd>
              </span>
            )}
            <span className="sg-num clash-pts">{hud.points} pts</span>
          </div>
        )}
        {!game.isPlayer && (
          <div className="clash-me">
            <span className="clash-me-team">Watching</span>
          </div>
        )}

        {touch && game.isPlayer && (
          <button
            type="button"
            className="clash-roll"
            aria-label="Dodge roll"
            ref={(el) => {
              if (touch) dodgeRef.current = el;
            }}
            onPointerDown={dodgeNow}
          >
            <Footprints aria-hidden="true" size={22} />
          </button>
        )}
        {touch && game.isPlayer && (
          <button type="button" className="clash-fire" aria-label="Fire" {...fireHold}>
            <Crosshair aria-hidden="true" size={30} />
          </button>
        )}
        {touch && (
          <button
            type="button"
            className="sg-btn ghost icon sm clash-full"
            aria-label={full ? "Exit full screen" : "Full screen"}
            onClick={() => setFull((f) => !f)}
          >
            {full ? <Minimize2 aria-hidden="true" size={16} /> : <Maximize2 aria-hidden="true" size={16} />}
          </button>
        )}
        {touch && full && (
          <div className="clash-rotate" aria-hidden="true">
            <RotateCcw size={28} />
            Turn your phone sideways to play
          </div>
        )}
      </div>

      {/* The feed sits under the war zone so it never covers the view. */}
      <ol className="clash-feed" aria-hidden="true">
        {hud.feed.map((f) => (
          <li
            key={f.key}
            className={f.mine ? "mine" : ""}
            style={{ "--t": `var(--clash-team-${Math.max(0, f.team)})` } as React.CSSProperties}
          >
            {f.text}
          </li>
        ))}
      </ol>

      {!touch && game.isPlayer && (
        <p className="clash-help sg-muted">
          <Crosshair aria-hidden="true" size={16} />
          Move with <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd>. Turn with the mouse or <kbd>←</kbd>{" "}
          <kbd>→</kbd>. Click or hold to fire; <kbd>Space</kbd> fires with aim help; <kbd>Shift</kbd> rolls out of the
          way of shots. Teammates spot enemies on your minimap, and your base heals you.
        </p>
      )}
      <span className="visually-hidden" aria-live="polite">
        {announce}
      </span>
    </div>
  );
}

/** A team's shape, so teams never rely on colour alone. */
export function TeamShape({ shape, size = 12 }: { shape: ClashShape; size?: number }) {
  const s = size;
  const common = { fill: "currentColor", stroke: "var(--on-clash-team)", strokeWidth: 1.5 };
  return (
    <svg width={s} height={s} viewBox="0 0 12 12" aria-hidden="true" className="clash-shape">
      {shape === "circle" ? (
        <circle cx="6" cy="6" r="5" {...common} />
      ) : (
        <rect x="1.2" y="1.2" width="9.6" height="9.6" rx="2" {...common} />
      )}
    </svg>
  );
}

/** Final team standings, shown above the podium. */
export function ClashOutcome({ session, game, meId }: { session: SessionView; game: ClashView; meId: string }) {
  const names = new Map(session.participants.map((p) => [p.userId, p.displayName]));
  const outcome = game.outcome;
  const winner = outcome?.winner ?? null;
  const headline =
    winner === null
      ? "It's a draw"
      : `Team ${CLASH_TEAMS[winner]!.name} wins${game.me?.team === winner ? ". That's you!" : ""}`;
  const order = game.power.map((p, i) => ({ p, i })).sort((a, b) => b.p - a.p);
  return (
    <section className="sg-card sg-stack clash-outcome" aria-labelledby="clash-outcome-title">
      <div className="sg-row" style={{ justifyContent: "space-between" }}>
        <h2 id="clash-outcome-title" className="sg-h2" style={{ margin: 0 }}>
          {headline}
        </h2>
        <span className="sg-badge clash">
          {outcome?.reason === "target"
            ? "Reached the target"
            : outcome?.reason === "time"
              ? "Time's up"
              : "Ended by the host"}
        </span>
      </div>
      <div className="clash-outcome-teams">
        {order.map(({ p, i }) => (
          <div
            key={i}
            className={`clash-outcome-team${i === winner ? " won" : ""}`}
            style={{ "--t": `var(--clash-team-${i})` } as React.CSSProperties}
          >
            <div className="sg-row" style={{ justifyContent: "space-between" }}>
              <b className="sg-row" style={{ gap: 6 }}>
                <TeamShape shape={CLASH_TEAMS[i]!.shape} size={14} />
                {CLASH_TEAMS[i]!.name}
              </b>
              <span className="sg-num">
                {game.bots ? `Score ${p}` : `${p} ${p === 1 ? "tag" : "tags"}`}
                {i === winner ? " · +" + R.winBonus + " pts each" : ""}
              </span>
            </div>
            <table className="clash-stats">
              <thead>
                <tr>
                  <th scope="col">Player</th>
                  <th scope="col" title="Enemies tagged">
                    Tags
                  </th>
                  {game.bots && <th scope="col">Drones</th>}
                  {game.bots && (
                    <th scope="col" title="Damage dealt to Titans">
                      Titan
                    </th>
                  )}
                  <th scope="col" title="Times tagged">
                    Downs
                  </th>
                </tr>
              </thead>
              <tbody>
                {game.players
                  .filter((pl) => pl.team === i)
                  .sort((a, b) => b.points - a.points)
                  .map((pl) => (
                    <tr key={pl.userId} className={pl.userId === meId ? "you" : ""}>
                      <th scope="row">
                        {names.get(pl.userId) ?? "Player"}
                        {pl.userId === meId && " (you)"}
                      </th>
                      <td className="sg-num">{pl.eliminations}</td>
                      {game.bots && <td className="sg-num">{pl.drones}</td>}
                      {game.bots && <td className="sg-num">{pl.titanDamage}</td>}
                      <td className="sg-num">{pl.deaths}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </section>
  );
}

function feedText(f: ClashFeedTuple, names: Map<number, string>) {
  const [by, what, victim, team] = f;
  const who = by >= 0 ? (names.get(by) ?? "Someone") : "A bot";
  if (what === 0)
    return by >= 0
      ? `${who} tagged ${names.get(victim) ?? "someone"}`
      : `${names.get(victim) ?? "Someone"} got wrecked by a bot`;
  if (what === 1) return `${who} popped a drone`;
  return `${CLASH_TEAMS[team]?.name ?? "A team"} felled the Titan`;
}

interface WorldPlayer {
  n: number;
  x: number;
  y: number;
  a: number;
  hp: number;
  flags: number;
}
interface WorldNpc {
  id: number;
  kind: 0 | 1;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  flags: number;
}

/** How far our recent positions are from where the server put us. */
function driftFrom(trail: { x: number; y: number }[], at: { x: number; y: number }, x: number, y: number) {
  let best = Math.hypot(x - at.x, y - at.y);
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

/** Blends the two snapshots around render time, or carries soldiers on past the newest one. */
function interpolate(snaps: ClashSnapshot[], rt: number): { players: WorldPlayer[]; npcs: WorldNpc[] } {
  if (!snaps.length) return { players: [], npcs: [] };
  const newest = snaps[snaps.length - 1]!;
  if (rt > newest.now && snaps.length > 1) {
    // Keep going the way the last two snapshots were heading, but never through a wall.
    const prev = snaps[snaps.length - 2]!;
    const span = Math.max(1, newest.now - prev.now) / 1000;
    const ahead = Math.min(rt - newest.now, EXTRAPOLATE_MS) / 1000;
    const pa = new Map<number, ClashPlayerTuple>(prev.players.map((p) => [p[0], p]));
    const players: WorldPlayer[] = [];
    for (const p of newest.players) {
      if (!(p[5] & CLASH_FLAG.alive)) continue;
      const q = pa.get(p[0]);
      const moving = q && q[6] === p[6] && q[5] & CLASH_FLAG.alive;
      const vx = moving ? (p[1] - q[1]) / span : 0;
      const vy = moving ? (p[2] - q[2]) / span : 0;
      const at = vx || vy ? resolveCircle(p[1] + vx * ahead, p[2] + vy * ahead, R.playerRadius) : { x: p[1], y: p[2] };
      players.push({ n: p[0], x: at.x, y: at.y, a: p[3] / 100, hp: p[4], flags: p[5] });
    }
    return { players, npcs: newest.npcs.map(npcOf) };
  }
  let b = snaps.findIndex((s) => s.now >= rt);
  if (b === -1) b = snaps.length - 1;
  const a = Math.max(0, b - 1);
  const sa = snaps[a]!;
  const sb = snaps[b]!;
  const k = sb.now === sa.now ? 1 : Math.max(0, Math.min(1, (rt - sa.now) / (sb.now - sa.now)));
  const pa = new Map<number, ClashPlayerTuple>(sa.players.map((p) => [p[0], p]));
  const players: WorldPlayer[] = [];
  for (const p of sb.players) {
    if (!(p[5] & CLASH_FLAG.alive)) continue;
    const q = pa.get(p[0]);
    // Don't slide across the map after a respawn.
    const blend = q && q[6] === p[6] && q[5] & CLASH_FLAG.alive;
    players.push({
      n: p[0],
      x: blend ? lerp(q[1], p[1], k) : p[1],
      y: blend ? lerp(q[2], p[2], k) : p[2],
      a: blend ? lerpAngle(q[3] / 100, p[3] / 100, k) : p[3] / 100,
      hp: p[4],
      flags: p[5],
    });
  }
  const na = new Map<number, ClashNpcTuple>(sa.npcs.map((n) => [n[0], n]));
  const npcs = sb.npcs.map((n) => {
    const q = na.get(n[0]);
    return { ...npcOf(n), x: q ? lerp(q[2], n[2], k) : n[2], y: q ? lerp(q[3], n[3], k) : n[3] };
  });
  return { players, npcs };
}

const npcOf = (n: ClashNpcTuple): WorldNpc => ({
  id: n[0],
  kind: n[1],
  x: n[2],
  y: n[3],
  hp: n[4],
  maxHp: n[5],
  flags: n[6],
});

/** The enemy or bot closest to where you're aiming, within `cone` radians, in range and in sight. */
function assistTarget(
  world: ReturnType<typeof interpolate>,
  me: { x: number; y: number },
  yaw: number,
  cone: number,
  team: number,
  teams: Map<number, number>,
) {
  let best: { x: number; y: number; a: number } | null = null;
  let bestD = cone;
  const consider = (x: number, y: number) => {
    const dist = Math.hypot(x - me.x, y - me.y);
    if (dist > R.shotRange || dist < 1) return;
    const a = Math.atan2(y - me.y, x - me.x);
    const d = Math.abs(angleDiff(yaw, a));
    if (d >= bestD || !lineClear(me.x, me.y, x, y)) return;
    bestD = d;
    best = { x, y, a };
  };
  for (const p of world.players) if (teams.get(p.n) !== team && !(p.flags & CLASH_FLAG.shield)) consider(p.x, p.y);
  for (const n of world.npcs) consider(n.x, n.y);
  return best as { x: number; y: number; a: number } | null;
}

/** How far a shot from a point at an angle gets before it hits cover or the edge, as a fraction of `range`. */
function rayFraction(x: number, y: number, a: number, range: number) {
  const dx = Math.cos(a) * range;
  const dy = Math.sin(a) * range;
  let edge = 1;
  if (dx > 0) edge = Math.min(edge, (W - x) / dx);
  if (dx < 0) edge = Math.min(edge, -x / dx);
  if (dy > 0) edge = Math.min(edge, (H - y) / dy);
  if (dy < 0) edge = Math.min(edge, -y / dy);
  return Math.min(edge, coverAlong(x, y, x + dx, y + dy));
}

function burst(ps: Particle[], x: number, y: number, z: number, count: number, color: string) {
  const until = performance.now() + 450;
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = 40 + Math.random() * 180;
    ps.push({
      x,
      y,
      z,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      vz: 60 + Math.random() * 200,
      until: until - Math.random() * 150,
      color,
      size: 3 + Math.random() * 4,
    });
  }
  if (ps.length > 400) ps.splice(0, ps.length - 400);
}

interface Colors {
  display: string;
  body: string;
  frame: string;
  ink: string;
  team: string[];
}

function readColors(): Colors {
  return {
    display: cssVar("--font-display") || "system-ui, sans-serif",
    body: cssVar("--font-body") || "system-ui, sans-serif",
    frame: cssVar("--game-clash") || "#4fa8ff",
    ink: "#0d0b1f",
    team: [0, 1].map((i) => cssVar(`--clash-team-${i}`) || "#ffffff"),
  };
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

function shapePath(ctx: CanvasRenderingContext2D, shape: ClashShape, x: number, y: number, r: number) {
  ctx.beginPath();
  if (shape === "circle") ctx.arc(x, y, r, 0, Math.PI * 2);
  else ctx.rect(x - r * 0.9, y - r * 0.9, r * 1.8, r * 1.8);
}

/** A name tag over a soldier, with their team's shape, and their health once they're hurt. */
function drawLabel(
  ctx: CanvasRenderingContext2D,
  c: Colors,
  x: number,
  y: number,
  name: string,
  team: number,
  hp: number,
  ally: boolean,
) {
  const color = c.team[team] ?? "#ffffff";
  ctx.font = `700 13px ${c.body}`;
  const w = ctx.measureText(name).width + 26;
  ctx.fillStyle = "rgba(11, 8, 32, 0.72)";
  roundRect(ctx, x - w / 2, y - 18, w, 20, 6);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = ally ? 1.5 : 2.5;
  ctx.stroke();
  shapePath(ctx, CLASH_TEAMS[team]?.shape ?? "circle", x - w / 2 + 10, y - 8, 4.5);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  ctx.fillText(name, x + 6, y - 7.5);
  ctx.textBaseline = "alphabetic";
  if (hp < R.playerHp) {
    ctx.fillStyle = c.ink;
    ctx.fillRect(x - 18, y + 4, 36, 5);
    ctx.fillStyle = hp <= 30 ? "#ff5a4e" : "#3fd08b";
    ctx.fillRect(x - 17, y + 5, (34 * hp) / R.playerHp, 3);
  }
}

function drawCrosshair(ctx: CanvasRenderingContext2D, x: number, y: number, onTarget: boolean, kick: boolean) {
  const gap = kick ? 9 : 6;
  const len = 9;
  ctx.lineCap = "round";
  for (const [color, width] of [
    ["rgba(0,0,0,0.6)", 4.5],
    [onTarget ? "#ff5a4e" : "#ffffff", 2],
  ] as const) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      ctx.moveTo(x + dx * gap, y + dy * gap);
      ctx.lineTo(x + dx * (gap + len), y + dy * (gap + len));
    }
    ctx.stroke();
  }
  ctx.fillStyle = onTarget ? "#ff5a4e" : "#ffffff";
  ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
}

function drawBrackets(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  const k = r * 0.45;
  ctx.strokeStyle = "#ff5a4e";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    ctx.moveTo(x + sx * r, y + sy * (r - k));
    ctx.lineTo(x + sx * r, y + sy * r);
    ctx.lineTo(x + sx * (r - k), y + sy * r);
  }
  ctx.stroke();
}

function drawMinimap(
  ctx: CanvasRenderingContext2D,
  c: Colors,
  x0: number,
  y0: number,
  w: number,
  d: {
    players: Array<{ x: number; y: number; team: number }>;
    npcs: WorldNpc[];
    me: { x: number; y: number; yaw: number; team: number } | null;
    still: boolean;
    t: number;
  },
) {
  const s = w / W;
  const h = H * s;
  ctx.save();
  ctx.fillStyle = "rgba(11, 8, 32, 0.78)";
  roundRect(ctx, x0 - 4, y0 - 4, w + 8, h + 8, 8);
  ctx.fill();
  ctx.strokeStyle = c.frame;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.translate(x0, y0);
  ctx.scale(s, s);

  ctx.fillStyle = "rgba(255, 220, 160, 0.08)";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(242, 194, 48, 0.4)";
  ctx.lineWidth = 2 / s;
  ctx.beginPath();
  ctx.arc(CLASH_CENTER.x, CLASH_CENTER.y, R.titan.leash + R.titan.radius, 0, Math.PI * 2);
  ctx.stroke();
  clashBases().forEach((b, i) => {
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = c.team[i]!;
    ctx.beginPath();
    ctx.arc(b.x, b.y, R.baseRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  });
  for (const cv of CLASH_WALLS) {
    ctx.fillStyle = cv.kind === "building" ? "#b8ad9a" : cv.kind === "sandbag" ? "#8f8063" : "#8a8478";
    ctx.fillRect(cv.x, cv.y, cv.w, cv.h);
  }
  for (const n of d.npcs) {
    ctx.fillStyle = n.kind === 1 ? "#ff3d6e" : "#e04dff";
    ctx.beginPath();
    ctx.arc(n.x, n.y, (n.kind === 1 ? 7 : 3.5) / s / 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  const dot = 4 / s;
  for (const p of d.players) {
    shapePath(ctx, CLASH_TEAMS[p.team]?.shape ?? "circle", p.x, p.y, dot);
    ctx.fillStyle = c.team[p.team] ?? "#ffffff";
    ctx.fill();
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.5 / s;
    ctx.stroke();
  }
  if (d.me) {
    // You: an arrow with your view cone.
    const { x, y, yaw } = d.me;
    ctx.fillStyle = "rgba(255,255,255,0.14)";
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, 420, yaw - 0.55, yaw + 0.55);
    ctx.closePath();
    ctx.fill();
    const r = 7 / s;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(yaw) * r * 1.4, y + Math.sin(yaw) * r * 1.4);
    ctx.lineTo(x + Math.cos(yaw + 2.5) * r, y + Math.sin(yaw + 2.5) * r);
    ctx.lineTo(x + Math.cos(yaw - 2.5) * r, y + Math.sin(yaw - 2.5) * r);
    ctx.closePath();
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = c.team[d.me.team] ?? c.ink;
    ctx.lineWidth = 2 / s;
    ctx.stroke();
  }
  ctx.restore();
}
