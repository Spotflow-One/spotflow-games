import { useCallback, useEffect, useRef, useState } from "react";
import { Crosshair, Maximize2, Minimize2, RotateCcw, Shield, Swords, Zap } from "lucide-react";
import {
  CLASH_CENTER,
  CLASH_FLAG,
  CLASH_RULES as R,
  CLASH_TEAMS,
  CLASH_WALLS,
  clashBases,
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

interface Props {
  session: SessionView;
  game: ClashView;
  meId: string;
}

const W = R.arena.width;
const H = R.arena.height;
/** Others are drawn this far in the past, so there are always two snapshots to blend between. */
const INTERP_MS = 120;
/** Send controls at most this often while they change, and at least this often while idle. */
const SEND_EVERY_MS = 66;
const HEARTBEAT_MS = 400;
/** Snap to the server's position when prediction drifts further than this. */
const SNAP_DIST = 90;
const STICK_RADIUS = 56;

interface Shot {
  t: ClashShotTuple;
  goneAt: number;
}
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
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
  start: number;
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
const lerpAngle = (a: number, b: number, t: number) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};
const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function ClashScreen({ session, game, meId }: Props) {
  const { soundEnabled } = usePreferences();
  const seconds = useCountdown(game.endsAt, game.serverNow);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const touch = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
  const [full, setFull] = useState(touch);
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
  const shots = useRef(new Map<number, Shot>());
  const particles = useRef<Particle[]>([]);
  const me = useRef({ x: 0, y: 0, life: -1, alive: false, hurtAt: 0 });
  const controls = useRef({
    keys: new Set<string>(),
    mouse: null as { x: number; y: number; at: number } | null,
    mouseDown: false,
    spaceDown: false,
    aim: 0,
    shotCount: 0,
    lastLocalShot: 0,
    move: null as Stick | null,
    look: null as Stick | null,
  });
  const sent = useRef({ at: 0, body: "" });
  const feedKey = useRef(0);

  const serverNow = () => {
    const o = offsets.current;
    return Date.now() + (o.length ? Math.max(...o) : 0);
  };

  const onSnapshot = useCallback(
    (snap: ClashSnapshot) => {
      const recv = Date.now();
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
        // A new life, or the server disagreeing a lot, puts us where the server says.
        if (mine[6] !== m.life || (alive && Math.hypot(mine[1] - m.x, mine[2] - m.y) > SNAP_DIST)) {
          m.x = mine[1];
          m.y = mine[2];
          m.life = mine[6];
        }
        if (mine[5] & CLASH_FLAG.hurt) m.hurtAt = recv;
        if (m.alive && !alive) {
          playSound("boom", soundRef.current);
          setAnnounce("You were knocked out. Respawning soon.");
        }
        m.alive = alive;
      }

      // Effects and the kill feed.
      const people = new Map(snap.players.map((p) => [p[0], p]));
      const npcs = new Map<number, ClashNpcTuple>();
      for (const s of snaps.current.slice(-3)) for (const n of s.npcs) npcs.set(n[0], n);
      const feed: Hud["feed"] = [];
      for (const f of snap.feed) {
        const [by, what, victim, team] = f;
        const at = what === 0 ? people.get(victim) : npcs.get(victim);
        if (at) burst(particles.current, what === 0 ? at[1] : at[2], what === 0 ? at[2] : at[3], what === 2 ? 40 : 14);
        const mineFeed = by === myN || (what === 0 && victim === myN);
        if (by === myN) playSound(what === 2 ? "winner" : "correct", soundRef.current);
        if (what === 2) {
          const name = CLASH_TEAMS[team]?.name ?? "A team";
          setBanner(`${name} took down the Titan! +${R.titan.power} Power`);
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
        setBanner("The Titan has awakened! Team up to take it down");
        setAnnounce("The Titan has awakened in the middle of the arena.");
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
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    const socket = getSocket();
    const onEvent = ({ code, event }: { code: string; event: unknown }) => {
      if (code === session.code && (event as ClashSnapshot)?.type === "snap") onSnapshot(event as ClashSnapshot);
    };
    socket.on("game:event", onEvent);
    return () => {
      socket.off("game:event", onEvent);
    };
  }, [session.code, onSnapshot]);

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

  // Keyboard and mouse.
  useEffect(() => {
    const c = controls.current;
    const gameKey = (k: string) =>
      ["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(k);
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

  // The render and input loop.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let last = performance.now();
    let frame = 0;
    let colors = readColors();
    let view = { scale: 1, ox: 0, oy: 0, w: 0, h: 0, dpr: 1 };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      const scale = Math.min(rect.width / W, rect.height / H);
      view = {
        scale,
        ox: (rect.width - W * scale) / 2,
        oy: (rect.height - H * scale) / 2,
        w: rect.width,
        h: rect.height,
        dpr,
      };
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const toWorld = (cx: number, cy: number) => {
      const rect = canvas.getBoundingClientRect();
      return { x: (cx - rect.left - view.ox) / view.scale, y: (cy - rect.top - view.oy) / view.scale };
    };
    const c = controls.current;

    const onMouseMove = (e: MouseEvent) => {
      c.mouse = { ...toWorld(e.clientX, e.clientY), at: performance.now() };
    };
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      c.mouse = { ...toWorld(e.clientX, e.clientY), at: performance.now() };
      c.mouseDown = true;
      c.shotCount++;
      canvas.focus();
    };
    const onMouseUp = () => {
      c.mouseDown = false;
    };
    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      for (const t of Array.from(e.changedTouches)) {
        const x = t.clientX - rect.left;
        const y = t.clientY - rect.top;
        const stick = { id: t.identifier, ox: x, oy: y, x, y, start: performance.now() };
        if (x < rect.width / 2) c.move ??= stick;
        else if (!c.look) {
          c.look = stick;
          c.shotCount++;
        }
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      for (const t of Array.from(e.changedTouches)) {
        for (const s of [c.move, c.look]) {
          if (s?.id !== t.identifier) continue;
          s.x = t.clientX - rect.left;
          s.y = t.clientY - rect.top;
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
      const rt = now - INTERP_MS;
      const world = interpolate(snaps.current, rt);
      const myN = g.me?.n ?? -1;
      const playing = g.isPlayer && !!g.me && m.life >= 0;

      // Move.
      let mx = 0;
      let my = 0;
      if (c.move) {
        const dx = c.move.x - c.move.ox;
        const dy = c.move.y - c.move.oy;
        const len = Math.hypot(dx, dy);
        if (len > 8) {
          const k = Math.min(1, len / STICK_RADIUS) / len;
          mx = dx * k;
          my = dy * k;
        }
      } else {
        const k = c.keys;
        mx = (k.has("d") || k.has("arrowright") ? 1 : 0) - (k.has("a") || k.has("arrowleft") ? 1 : 0);
        my = (k.has("s") || k.has("arrowdown") ? 1 : 0) - (k.has("w") || k.has("arrowup") ? 1 : 0);
        const len = Math.hypot(mx, my);
        if (len > 0) {
          mx /= len;
          my /= len;
        }
      }
      if (playing && m.alive && (mx || my)) {
        const p = resolveCircle(m.x + mx * R.playerSpeed * dt, m.y + my * R.playerSpeed * dt, R.playerRadius);
        m.x = p.x;
        m.y = p.y;
      }

      // Aim: the right stick, a recently moved mouse, or the nearest enemy.
      const myTeam = g.me?.team ?? -2;
      let firing: boolean = c.mouseDown || c.spaceDown || !!c.look;
      const lookDrag = c.look ? Math.hypot(c.look.x - c.look.ox, c.look.y - c.look.oy) : 0;
      if (c.look && lookDrag > 14) c.aim = Math.atan2(c.look.y - c.look.oy, c.look.x - c.look.ox);
      else if (c.mouse && (c.mouseDown || t - c.mouse.at < 2500) && !c.look)
        c.aim = Math.atan2(c.mouse.y - m.y, c.mouse.x - m.x);
      else {
        const target = nearestEnemy(world, m.x, m.y, myTeam, teams.current);
        if (target) c.aim = Math.atan2(target.y - m.y, target.x - m.x);
      }
      if (!m.alive) firing = false;
      if (playing && firing && t - c.lastLocalShot >= R.fireCooldownMs) {
        c.lastLocalShot = t;
        playSound("zap", soundRef.current);
      }

      // Send controls.
      if (playing) {
        const body = JSON.stringify({
          x: Math.round(m.x * 10) / 10,
          y: Math.round(m.y * 10) / 10,
          a: Math.round(c.aim * 100) / 100,
          f: firing,
          s: c.shotCount,
          l: m.life,
        });
        const since = t - sent.current.at;
        if ((body !== sent.current.body && since >= SEND_EVERY_MS) || since >= HEARTBEAT_MS) {
          sent.current = { at: t, body };
          getSocket().volatile.emit("game:input", { code: session.code, input: JSON.parse(body) as unknown });
        }
      }

      // Draw.
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ctx.clearRect(0, 0, view.w, view.h);
      ctx.fillStyle = colors.void;
      ctx.fillRect(0, 0, view.w, view.h);
      ctx.save();
      ctx.translate(view.ox, view.oy);
      ctx.scale(view.scale, view.scale);
      drawArena(ctx, colors, g.teamCount, t, reduceMotion);

      // Shots move in straight lines, so each is drawn exactly where it is now.
      for (const [id, s] of shots.current) {
        const [, x0, y0, vx, vy, team, t0, owner] = s.t;
        const at = owner === myN ? now : rt;
        if (at >= s.goneAt || at - t0 > 3000) {
          if (at >= s.goneAt && at - t0 < 3000) {
            const e = (s.goneAt - t0) / 1000;
            burst(particles.current, x0 + vx * e, y0 + vy * e, 4, team < 0 ? colors.npcShot : colors.team[team]);
          }
          shots.current.delete(id);
          continue;
        }
        if (at < t0) continue;
        const e = (at - t0) / 1000;
        drawShot(ctx, x0 + vx * e, y0 + vy * e, vx, vy, team < 0 ? colors.npcShot : colors.team[team]!);
      }

      for (const n of world.npcs) drawNpc(ctx, colors, n, t);
      for (const p of world.players) {
        if (p.n === myN) continue;
        drawPlayer(ctx, colors, p, teams.current.get(p.n) ?? 0, names.current.get(p.n) ?? "", false, t);
      }
      if (playing && m.alive) {
        const flags = world.players.find((p) => p.n === myN)?.flags ?? CLASH_FLAG.alive;
        const hp = world.players.find((p) => p.n === myN)?.hp ?? R.playerHp;
        drawPlayer(
          ctx,
          colors,
          {
            n: myN,
            x: m.x,
            y: m.y,
            a: c.aim,
            hp,
            flags: performance.now() - m.hurtAt < 120 ? flags | CLASH_FLAG.hurt : flags,
          },
          myTeam,
          "You",
          true,
          t,
        );
        if (firing && t - c.lastLocalShot < 60) drawMuzzle(ctx, m.x, m.y, c.aim);
      }

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
      ctx.restore();

      // Touch sticks, in screen space.
      for (const s of [c.move, c.look]) {
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
        ctx.fillStyle = s === c.look ? "rgba(255,90,78,0.6)" : "rgba(255,255,255,0.5)";
        ctx.beginPath();
        ctx.arc(s.ox + Math.cos(ang) * len, s.oy + Math.sin(ang) * len, 24, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
      canvas.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [session.code]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (game.isPlayer) canvasRef.current?.focus();
  }, [game.isPlayer]);

  const myTeam = game.me?.team ?? null;
  const mm = Math.floor(seconds / 60);
  const ss = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  const leader = hud.power.indexOf(Math.max(...hud.power));

  return (
    <div className={`clash-stage${full ? " full" : ""}`} ref={wrapRef}>
      <div className="clash-frame">
        <canvas
          ref={canvasRef}
          className="clash-canvas"
          tabIndex={0}
          role="img"
          aria-label={`Core Clash arena. ${hud.power
            .map((p, i) => `${CLASH_TEAMS[i]!.name} ${p} of ${game.target} Power`)
            .join(", ")}.`}
        />

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
            <b>Knocked out</b>
            <span className="sg-num">Back in {Math.max(0, hud.respawn).toFixed(1)}s</span>
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
            <span className="sg-num clash-pts">{hud.points} pts</span>
          </div>
        )}
        {!game.isPlayer && (
          <div className="clash-me">
            <span className="clash-me-team">Watching</span>
          </div>
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

      {/* The feed sits under the arena so it never hides a base or the Titan. */}
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
          Move with <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> or arrows. Aim with the mouse and click or hold
          to fire. <kbd>Space</kbd> fires at the nearest enemy. Your base heals you.
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
      {shape === "circle" && <circle cx="6" cy="6" r="5" {...common} />}
      {shape === "square" && <rect x="1.2" y="1.2" width="9.6" height="9.6" rx="2" {...common} />}
      {shape === "triangle" && <path d="M6 1 L11 10.5 L1 10.5 Z" {...common} />}
      {shape === "diamond" && <path d="M6 0.8 L11.2 6 L6 11.2 L0.8 6 Z" {...common} />}
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
                {p} Power{i === winner ? " · +" + R.winBonus + " pts each" : ""}
              </span>
            </div>
            <table className="clash-stats">
              <thead>
                <tr>
                  <th scope="col">Player</th>
                  <th scope="col" title="Players knocked out">
                    Tags
                  </th>
                  <th scope="col">Drones</th>
                  <th scope="col" title="Damage dealt to Titans">
                    Titan
                  </th>
                  <th scope="col" title="Times knocked out">
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
                      <td className="sg-num">{pl.drones}</td>
                      <td className="sg-num">{pl.titanDamage}</td>
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

/** Blends the two snapshots around render time. */
function interpolate(snaps: ClashSnapshot[], rt: number): { players: WorldPlayer[]; npcs: WorldNpc[] } {
  if (!snaps.length) return { players: [], npcs: [] };
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
    return {
      id: n[0],
      kind: n[1],
      x: q ? lerp(q[2], n[2], k) : n[2],
      y: q ? lerp(q[3], n[3], k) : n[3],
      hp: n[4],
      maxHp: n[5],
      flags: n[6],
    };
  });
  return { players, npcs };
}

function nearestEnemy(
  world: ReturnType<typeof interpolate>,
  x: number,
  y: number,
  team: number,
  teams: Map<number, number>,
) {
  let best: { x: number; y: number } | null = null;
  let bestD = (R.shotRange + 40) ** 2;
  const consider = (tx: number, ty: number) => {
    const d = (tx - x) ** 2 + (ty - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = { x: tx, y: ty };
    }
  };
  for (const p of world.players) if (teams.get(p.n) !== team && !(p.flags & CLASH_FLAG.shield)) consider(p.x, p.y);
  for (const n of world.npcs) consider(n.x, n.y);
  return best as { x: number; y: number } | null;
}

function burst(ps: Particle[], x: number, y: number, count: number, color = "#ffffff") {
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

interface Colors {
  display: string;
  body: string;
  void: string;
  floor: string;
  grid: string;
  wall: string;
  wallEdge: string;
  frame: string;
  ink: string;
  drone: string;
  titan: string;
  titanCore: string;
  npcShot: string;
  team: string[];
}

function readColors(): Colors {
  return {
    display: cssVar("--font-display") || "system-ui, sans-serif",
    body: cssVar("--font-body") || "system-ui, sans-serif",
    void: "#0b0820",
    floor: "#140f34",
    grid: "rgba(150, 120, 255, 0.12)",
    wall: "#2d2370",
    wallEdge: "#8a7bff",
    frame: cssVar("--game-clash") || "#4fa8ff",
    ink: "#0d0b1f",
    drone: "#e04dff",
    titan: "#ff3d6e",
    titanCore: "#ffd36b",
    npcShot: "#ff4fd8",
    team: [0, 1, 2, 3].map((i) => cssVar(`--clash-team-${i}`) || "#ffffff"),
  };
}

function drawArena(ctx: CanvasRenderingContext2D, c: Colors, teamCount: number, t: number, still: boolean) {
  ctx.fillStyle = c.floor;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = c.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 50; x < W; x += 50) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
  }
  for (let y = 50; y < H; y += 50) {
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
  }
  ctx.stroke();

  // The Titan's lair.
  ctx.strokeStyle = "rgba(255, 61, 110, 0.25)";
  ctx.setLineDash([10, 12]);
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(CLASH_CENTER.x, CLASH_CENTER.y, R.titan.leash + R.titan.radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  clashBases(teamCount).forEach((b, i) => {
    const color = c.team[i]!;
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(b.x, b.y, R.baseRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.setLineDash([14, 10]);
    ctx.lineDashOffset = still ? 0 : -t / 60;
    ctx.stroke();
    ctx.setLineDash([]);
    // The team name sits faintly inside the base, where it never collides with cover.
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = color;
    ctx.font = `800 20px ${c.display}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(CLASH_TEAMS[i]!.name.toUpperCase(), b.x, b.y);
    ctx.textBaseline = "alphabetic";
    ctx.globalAlpha = 1;
  });

  for (const w of CLASH_WALLS) {
    ctx.fillStyle = c.wall;
    roundRect(ctx, w.x, w.y, w.w, w.h, 8);
    ctx.fill();
    ctx.strokeStyle = c.wallEdge;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  ctx.strokeStyle = c.frame;
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, W - 6, H - 6);
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
  else if (shape === "square") roundRect(ctx, x - r * 0.9, y - r * 0.9, r * 1.8, r * 1.8, 5);
  else if (shape === "triangle") {
    ctx.moveTo(x, y - r * 1.1);
    ctx.lineTo(x + r * 1.05, y + r * 0.8);
    ctx.lineTo(x - r * 1.05, y + r * 0.8);
    ctx.closePath();
  } else {
    ctx.moveTo(x, y - r * 1.15);
    ctx.lineTo(x + r * 1.15, y);
    ctx.lineTo(x, y + r * 1.15);
    ctx.lineTo(x - r * 1.15, y);
    ctx.closePath();
  }
}

function drawPlayer(
  ctx: CanvasRenderingContext2D,
  c: Colors,
  p: WorldPlayer,
  team: number,
  name: string,
  isMe: boolean,
  t: number,
) {
  const r = R.playerRadius;
  const color = c.team[team] ?? "#fff";
  // Barrel.
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.a);
  ctx.fillStyle = c.ink;
  roundRect(ctx, 4, -5, r + 12, 10, 4);
  ctx.fill();
  ctx.fillStyle = color;
  roundRect(ctx, r + 6, -3, 8, 6, 2);
  ctx.fill();
  ctx.restore();

  if (isMe) {
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 9, 0, Math.PI * 2);
    ctx.stroke();
  }
  shapePath(ctx, CLASH_TEAMS[team]?.shape ?? "circle", p.x, p.y, r);
  ctx.fillStyle = p.flags & CLASH_FLAG.hurt ? "#ffffff" : color;
  ctx.fill();
  ctx.strokeStyle = c.ink;
  ctx.lineWidth = 4;
  ctx.stroke();

  if (p.flags & CLASH_FLAG.shield) {
    ctx.strokeStyle = `rgba(120, 230, 255, ${0.5 + 0.3 * Math.sin(t / 90)})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 7, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Name and health.
  ctx.font = `700 15px ${c.body}`;
  ctx.textAlign = "center";
  ctx.lineWidth = 4;
  ctx.strokeStyle = c.ink;
  ctx.strokeText(name, p.x, p.y - r - 14);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(name, p.x, p.y - r - 14);
  if (p.hp < R.playerHp) {
    ctx.fillStyle = c.ink;
    ctx.fillRect(p.x - 20, p.y + r + 8, 40, 6);
    ctx.fillStyle = p.hp <= 30 ? "#ff5a4e" : "#3fd08b";
    ctx.fillRect(p.x - 19, p.y + r + 9, (38 * p.hp) / R.playerHp, 4);
  }
}

function drawMuzzle(ctx: CanvasRenderingContext2D, x: number, y: number, a: number) {
  const d = R.playerRadius + 18;
  ctx.fillStyle = "rgba(255, 240, 180, 0.9)";
  ctx.beginPath();
  ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, 7, 0, Math.PI * 2);
  ctx.fill();
}

function drawShot(ctx: CanvasRenderingContext2D, x: number, y: number, vx: number, vy: number, color: string) {
  const len = Math.hypot(vx, vy) || 1;
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 6;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - (vx / len) * 22, y - (vy / len) * 22);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, R.shotRadius + 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(x, y, 2, 0, Math.PI * 2);
  ctx.fill();
}

function drawNpc(ctx: CanvasRenderingContext2D, c: Colors, n: WorldNpc, t: number) {
  const hurt = n.flags & 1;
  if (n.kind === 0) {
    const r = R.drone.radius;
    ctx.save();
    ctx.translate(n.x, n.y);
    ctx.rotate(t / 300 + n.id);
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const rr = i % 2 ? r * 0.75 : r * 1.15;
      ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fillStyle = hurt ? "#ffffff" : c.drone;
    ctx.fill();
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(n.x, n.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = c.ink;
    ctx.beginPath();
    ctx.arc(n.x, n.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const r = R.titan.radius;
  const winding = n.flags & 2;
  if (winding) {
    ctx.strokeStyle = `rgba(255, 211, 107, ${0.4 + 0.4 * Math.sin(t / 50)})`;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(n.x, n.y, r + 16, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.save();
  ctx.translate(n.x, n.y);
  ctx.rotate(t / 1400);
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fillStyle = hurt ? "#ffd0dc" : c.titan;
  ctx.fill();
  ctx.strokeStyle = c.ink;
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = c.titanCore;
  ctx.beginPath();
  ctx.arc(n.x, n.y, 14 + (winding ? 4 : 0), 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = c.ink;
  ctx.lineWidth = 3;
  ctx.stroke();
  // Health ring.
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(n.x, n.y, r + 8, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = c.titanCore;
  ctx.beginPath();
  ctx.arc(n.x, n.y, r + 8, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * n.hp) / n.maxHp);
  ctx.stroke();
}
