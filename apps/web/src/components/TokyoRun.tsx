import { useEffect, useRef } from "react";

/**
 * Decorative home-page backdrop: a flying car racing rivals through neon Tokyo at night.
 * Drawn on a canvas with parallax layers. Colours come from the arcade-* and game tokens.
 * With reduced motion it draws a single still frame, and it pauses while the tab is hidden.
 */
export function TokyoRun() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const css = getComputedStyle(document.documentElement);
    const token = (name: string) => css.getPropertyValue(`--${name}`).trim();
    const C = {
      sky: token("arcade-sky"),
      deep: token("arcade-sky-deep"),
      pink: token("arcade-grid"),
      cyan: token("arcade-glow"),
      ink: token("arcade-ink"),
      amber: token("game-quiz"),
      coral: token("game-truths"),
      green: token("game-draw"),
    };
    const neon = [C.pink, C.cyan, C.amber, C.coral, C.green];
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let W = 0;
    let H = 0;
    let scale = 1;
    let layers: Layer[] = [];
    let rivals: Car[] = [];
    let streaks: Streak[] = [];

    const setup = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      scale = Math.max(0.55, Math.min(1, W / 1280));
      const rand = seeded(7);
      layers = [
        { speed: 0.02, tile: drawHorizon(W, H, dpr, C) },
        { speed: 0.12, tile: drawCity(W, H, dpr, rand, C, neon, { depth: 0, alpha: 0.5, tower: true }) },
        { speed: 0.35, tile: drawCity(W, H, dpr, rand, C, neon, { depth: 1, alpha: 0.8, tower: false }) },
        { speed: 1, tile: drawCity(W, H, dpr, rand, C, neon, { depth: 2, alpha: 1, tower: false }) },
      ];
      rivals = Array.from({ length: 5 }, (_, i) => ({
        x: rand() * W * 1.5,
        lane: 0.1 + rand() * 0.75,
        speed: 0.75 + rand() * 0.5,
        size: 0.45 + rand() * 0.35,
        color: neon[i % neon.length]!,
      }));
      streaks = Array.from({ length: 28 }, () => ({ x: rand() * W, y: rand() * H, len: 40 + rand() * 120 }));
    };

    let offset = 0;
    let last = performance.now();
    let raf = 0;
    const SPEED = 420; // world pixels per second at the near layer

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      offset += SPEED * dt;
      const t = now / 1000;

      const sky = ctx.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, C.sky);
      sky.addColorStop(1, C.deep);
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, W, H);

      for (const layer of layers) {
        const tw = layer.tile.width / (layer.tile.height / H);
        const x = -((offset * layer.speed) % tw);
        ctx.drawImage(layer.tile, x, 0, tw, H);
        ctx.drawImage(layer.tile, x + tw, 0, tw, H);
      }

      // Speed streaks
      ctx.strokeStyle = C.ink;
      ctx.globalAlpha = 0.12;
      ctx.lineWidth = 1;
      for (const s of streaks) {
        s.x -= SPEED * 2.2 * dt;
        if (s.x + s.len < 0) {
          s.x = W + Math.random() * 200;
          s.y = Math.random() * H;
        }
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x + s.len, s.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // The race runs along the page's .race-lane gap when there is one, so the cards don't hide it.
      const lane = document.querySelector(".race-lane")?.getBoundingClientRect();
      const laneTop = lane ? lane.top : H * 0.35;
      const laneH = lane ? lane.height : H * 0.25;

      // Rivals race past at their own pace; the player weaves between them.
      for (const r of rivals) {
        r.x += (r.speed - 1) * SPEED * 0.6 * dt;
        if (r.x < -200) r.x = W + 100 + Math.random() * W * 0.5;
        if (r.x > W + 300) r.x = -150;
        const y = laneTop + laneH * r.lane + Math.sin(t * 1.7 + r.x * 0.01) * 6;
        drawCar(ctx, r.x, y, r.size * scale, r.color, C, t, false);
      }
      const px = W * (W < 600 ? 0.12 : 0.22);
      const py = laneTop + laneH * (0.42 + Math.sin(t * 0.6) * 0.22) + Math.sin(t * 3.1) * 3;
      drawCar(ctx, px, py, scale, C.cyan, C, t, true, Math.cos(t * 0.6) * 0.05);

      if (!still) raf = requestAnimationFrame(frame);
    };

    const start = () => {
      cancelAnimationFrame(raf);
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    const onVisibility = () => (document.hidden ? cancelAnimationFrame(raf) : !still && start());
    const onResize = () => {
      setup();
      if (still) frame(performance.now());
    };

    setup();
    if (still) {
      offset = 900;
      frame(performance.now());
    } else start();
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return <canvas ref={ref} className="tokyo-run" aria-hidden="true" />;
}

interface Layer {
  speed: number;
  tile: HTMLCanvasElement;
}
interface Car {
  x: number;
  lane: number;
  speed: number;
  size: number;
  color: string;
}
interface Streak {
  x: number;
  y: number;
  len: number;
}
type Colors = Record<"sky" | "deep" | "pink" | "cyan" | "ink" | "amber" | "coral" | "green", string>;

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function makeTile(W: number, H: number, dpr: number) {
  const tile = document.createElement("canvas");
  const w = Math.max(W, 1200) * 1.5;
  tile.width = Math.round(w * dpr);
  tile.height = Math.round(H * dpr);
  const g = tile.getContext("2d")!;
  g.scale(dpr, dpr);
  return { tile, g, w };
}

/** Moon, stars and Mount Fuji on the horizon. */
function drawHorizon(W: number, H: number, dpr: number, C: Colors) {
  const { tile, g, w } = makeTile(W, H, dpr);
  const rand = seeded(3);
  g.fillStyle = C.ink;
  for (let i = 0; i < 90; i++) {
    g.globalAlpha = 0.25 + rand() * 0.6;
    g.fillRect(rand() * w, rand() * H * 0.5, 1.5, 1.5);
  }
  g.globalAlpha = 0.9;
  g.shadowColor = C.pink;
  g.shadowBlur = 40;
  g.fillStyle = C.ink;
  g.beginPath();
  g.arc(w * 0.72, H * 0.16, Math.min(60, H * 0.07), 0, Math.PI * 2);
  g.fill();
  g.shadowBlur = 0;
  // Fuji
  const base = H * 0.72;
  const peak = H * 0.38;
  const cx = w * 0.3;
  const half = Math.min(w * 0.22, H * 0.55);
  g.globalAlpha = 0.55;
  g.fillStyle = C.sky;
  g.beginPath();
  g.moveTo(cx - half, base);
  g.lineTo(cx - half * 0.12, peak);
  g.lineTo(cx + half * 0.12, peak);
  g.lineTo(cx + half, base);
  g.closePath();
  g.fill();
  g.globalAlpha = 0.5;
  g.fillStyle = C.ink;
  g.beginPath();
  g.moveTo(cx - half * 0.12, peak);
  g.lineTo(cx + half * 0.12, peak);
  g.lineTo(cx + half * 0.3, peak + (base - peak) * 0.22);
  g.lineTo(cx + half * 0.1, peak + (base - peak) * 0.16);
  g.lineTo(cx - half * 0.05, peak + (base - peak) * 0.25);
  g.lineTo(cx - half * 0.3, peak + (base - peak) * 0.2);
  g.closePath();
  g.fill();
  g.globalAlpha = 1;
  return tile;
}

const SIGNS = ["ハッピーアワー", "東京", "ゲーム", "ネオン", "渋谷", "クイズ", "ラーメン", "新宿", "カラオケ"];

/** One parallax band of skyscrapers with lit windows and vertical neon signs. */
function drawCity(
  W: number,
  H: number,
  dpr: number,
  rand: () => number,
  C: Colors,
  neon: string[],
  { depth, alpha, tower }: { depth: number; alpha: number; tower: boolean },
) {
  const { tile, g, w } = makeTile(W, H, dpr);
  const unit = Math.max(0.6, Math.min(1, W / 1280));
  const minH = H * [0.3, 0.2, 0.12][depth]!;
  const maxH = H * [0.55, 0.42, 0.3][depth]!;
  const bw = [50, 70, 110][depth]! * unit;
  const windowColors = [C.amber, C.cyan, C.ink];

  if (tower) drawTokyoTower(g, w * 0.62, H, H * 0.58, C);

  let x = 0;
  while (x < w) {
    const width = bw * (0.7 + rand() * 0.8);
    const height = minH + rand() * (maxH - minH);
    const top = H - height;
    g.globalAlpha = alpha;
    g.fillStyle = C.sky;
    g.fillRect(x, top, width, height);
    // Roof edge glow
    g.globalAlpha = 0.5 * alpha;
    g.fillStyle = neon[Math.floor(rand() * neon.length)]!;
    g.fillRect(x, top, width, 2);
    // Windows
    const cell = [6, 9, 12][depth]! * unit;
    for (let wy = top + cell; wy < H - cell; wy += cell * 1.8) {
      for (let wx = x + cell * 0.6; wx < x + width - cell; wx += cell * 1.5) {
        if (rand() < 0.38) {
          g.globalAlpha = (0.25 + rand() * 0.5) * alpha;
          g.fillStyle = windowColors[Math.floor(rand() * windowColors.length)]!;
          g.fillRect(wx, wy, cell * 0.7, cell * 0.8);
        }
      }
    }
    // Vertical neon sign on some buildings
    if (depth > 0 && rand() < 0.55) {
      const text = SIGNS[Math.floor(rand() * SIGNS.length)]!;
      const color = neon[Math.floor(rand() * neon.length)]!;
      const size = (depth === 2 ? 20 : 14) * unit;
      const sw = size * 1.5;
      const sh = Math.min(text.length * size * 1.15 + size, height * 0.7);
      const sx = rand() < 0.5 ? x - sw * 0.3 : x + width - sw * 0.7;
      const sy = top + height * 0.12;
      g.globalAlpha = 0.9 * alpha;
      g.fillStyle = C.sky;
      g.fillRect(sx, sy, sw, sh);
      g.shadowColor = color;
      g.shadowBlur = 14;
      g.strokeStyle = color;
      g.lineWidth = 2;
      g.strokeRect(sx, sy, sw, sh);
      g.fillStyle = color;
      g.font = `700 ${size}px system-ui, sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "top";
      const fits = Math.floor((sh - size * 0.5) / (size * 1.15));
      [...text].slice(0, fits).forEach((ch, i) => g.fillText(ch, sx + sw / 2, sy + size * 0.4 + i * size * 1.15));
      g.shadowBlur = 0;
    }
    x += width + rand() * 14 * unit;
  }
  g.globalAlpha = 1;
  return tile;
}

function drawTokyoTower(g: CanvasRenderingContext2D, cx: number, H: number, height: number, C: Colors) {
  const top = H - height;
  const half = height * 0.16;
  g.save();
  g.globalAlpha = 0.85;
  g.strokeStyle = C.coral;
  g.shadowColor = C.coral;
  g.shadowBlur = 16;
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(cx - half, H);
  g.quadraticCurveTo(cx - half * 0.2, H - height * 0.45, cx, top);
  g.quadraticCurveTo(cx + half * 0.2, H - height * 0.45, cx + half, H);
  g.stroke();
  // Lattice and decks
  for (let i = 1; i < 9; i++) {
    const y = H - (height * i) / 9;
    const k = 1 - i / 9;
    const hw = half * k * k * 0.9 + 2;
    g.beginPath();
    g.moveTo(cx - hw, y);
    g.lineTo(cx + hw, y);
    g.stroke();
  }
  g.fillStyle = C.amber;
  g.fillRect(cx - half * 0.35, H - height * 0.42, half * 0.7, 6);
  g.fillRect(cx - half * 0.2, H - height * 0.7, half * 0.4, 5);
  g.restore();
}

/** A hover car pointing right, with underglow, thruster flame and a light trail. */
function drawCar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  s: number,
  accent: string,
  C: Colors,
  t: number,
  hero: boolean,
  tilt = 0,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(tilt);
  ctx.scale(s, s);

  // Light trail
  const trail = ctx.createLinearGradient(-320, 0, 0, 0);
  trail.addColorStop(0, "transparent");
  trail.addColorStop(1, accent);
  ctx.globalAlpha = hero ? 0.8 : 0.5;
  ctx.fillStyle = trail;
  ctx.fillRect(-320, 10, 320, 3);
  ctx.fillRect(-260, 20, 260, 2);

  // Underglow
  ctx.globalAlpha = 0.45;
  ctx.fillStyle = accent;
  ctx.shadowColor = accent;
  ctx.shadowBlur = 24;
  ctx.beginPath();
  ctx.ellipse(58, 32, 52, 5, 0, 0, Math.PI * 2);
  ctx.fill();

  // Thruster flame
  const flicker = 14 + Math.sin(t * 40) * 4 + Math.sin(t * 23) * 3;
  ctx.globalAlpha = 0.95;
  ctx.fillStyle = C.amber;
  ctx.shadowColor = C.amber;
  ctx.shadowBlur = 18;
  ctx.beginPath();
  ctx.moveTo(4, 10);
  ctx.lineTo(-flicker, 16);
  ctx.lineTo(4, 22);
  ctx.closePath();
  ctx.fill();

  // Body
  ctx.globalAlpha = 1;
  ctx.shadowColor = accent;
  ctx.shadowBlur = hero ? 16 : 8;
  ctx.fillStyle = C.sky;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 12);
  ctx.lineTo(28, 2);
  ctx.lineTo(80, 0);
  ctx.lineTo(122, 15);
  ctx.lineTo(116, 25);
  ctx.lineTo(8, 27);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Cockpit
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 0.6;
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.moveTo(40, 3);
  ctx.lineTo(74, 3);
  ctx.lineTo(90, 12);
  ctx.lineTo(42, 12);
  ctx.closePath();
  ctx.fill();

  // Stripe and headlight beam
  ctx.globalAlpha = 1;
  ctx.fillStyle = C.pink;
  ctx.fillRect(14, 18, 92, 2);
  if (hero) {
    const beam = ctx.createLinearGradient(120, 0, 320, 0);
    beam.addColorStop(0, C.ink);
    beam.addColorStop(1, "transparent");
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.moveTo(120, 15);
    ctx.lineTo(320, -10);
    ctx.lineTo(320, 45);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}
