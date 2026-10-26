/**
 * Lagos Rush in 3D: a sunny Grand Prix through Lagos, seen from just behind the car.
 *
 * The race itself (physics, netcode, scoring) stays flat and two-dimensional; this only draws
 * it. A track point (x, y) sits at (x, height, y) here, so the world's y axis points up.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  OBSTACLE_KINDS,
  RACE_BOXES,
  RACE_RULES as R,
  RACE_TRACK as T,
  deltaS,
  gridSlot,
  locate,
  moversAt,
  mulberry32,
  type ObstacleKind,
  type RaceCourse,
} from "@spotflow-games/shared";
import { carAccent, carPaint, liveryKey } from "./racePaint";

export interface RaceFrame {
  /** performance.now() */
  t: number;
  /** Seconds on the race clock, which places the traffic. */
  raceT: number;
  /** Milliseconds until the lights go out, or null once racing. */
  countdown: number | null;
  focus: { x: number; y: number; h: number; v: number } | null;
  overview: boolean;
  still: boolean;
  shake: boolean;
  cars: Array<{ n: number; x: number; y: number; h: number; v: number; boost: boolean }>;
  taken: Set<number>;
  slicks: Array<{ id: number; x: number; y: number }>;
}

export interface RaceWorld {
  setCourse(course: RaceCourse): void;
  resize(w: number, h: number, dpr: number): void;
  render(frame: RaceFrame): void;
  /** Where a track point at a height above the road lands on screen, if it is in front of the camera. */
  /** `key` names whatever is at that point, so repeated lookups for it stay cheap. */
  project(x: number, y: number, up?: number, key?: number): { x: number; y: number; scale: number } | null;
  dispose(): void;
}

const SKY_TOP = "#3f8fdc";
const HORIZON = "#d4e9f7";
const BRIDGE_RISE = 36;
const RAMP_SAMPLES = 22;
const DRAW_DIST = 4200;

// ---------------------------------------------------------------------------------------------
// Track shape

/** Heading at a sample, averaged with the one before so ribbons don't kink at corners. */
const smoothH = (() => {
  const out = new Float64Array(T.count);
  for (let i = 0; i < T.count; i++) {
    const a = T.h[(i - 1 + T.count) % T.count]!;
    const b = T.h[i]!;
    out[i] = Math.atan2(Math.sin(a) + Math.sin(b), Math.cos(a) + Math.cos(b));
  }
  return out;
})();

/** The road rises onto the bridges over the lagoon. */
const ELEV = (() => {
  const bridge = (i: number) => T.zone[(i + T.count) % T.count] === "bridge";
  const out = new Float64Array(T.count);
  for (let i = 0; i < T.count; i++) {
    let dist = RAMP_SAMPLES;
    for (let k = 0; k < RAMP_SAMPLES; k++) if (bridge(i + k) || bridge(i - k)) dist = Math.min(dist, k);
    const u = 1 - dist / RAMP_SAMPLES;
    out[i] = BRIDGE_RISE * u * u * (3 - 2 * u);
  }
  return out;
})();

const at = (i: number, d: number) => {
  const k = ((i % T.count) + T.count) % T.count;
  const h = smoothH[k]!;
  return { x: T.x[k]! - Math.sin(h) * d, y: T.y[k]! + Math.cos(h) * d, e: ELEV[k]! };
};

function elevAtS(s: number) {
  const f = (((s % T.length) + T.length) % T.length) / T.step;
  const i = Math.floor(f) % T.count;
  const j = (i + 1) % T.count;
  return ELEV[i]! + (ELEV[j]! - ELEV[i]!) * (f - Math.floor(f));
}

const isBridge = (i: number) => T.zone[((i % T.count) + T.count) % T.count] === "bridge";

/** How sharply the track turns at a sample, in radians per unit. */
const CURVE = (() => {
  const out = new Float64Array(T.count);
  for (let i = 0; i < T.count; i++) {
    let d = T.h[(i + 3) % T.count]! - T.h[(i - 3 + T.count) % T.count]!;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    out[i] = Math.abs(d) / (6 * T.step);
  }
  return out;
})();
/** Red and white kerbs on the corners and the start straight, as on a circuit. */
const KERB = (() => {
  const raw = Array.from({ length: T.count }, (_, i) => CURVE[i]! > 1 / 2600 || Math.abs(deltaS(i * T.step, 0)) < 700);
  return raw.map((_, i) => {
    if (isBridge(i)) return false;
    for (let k = -5; k <= 5; k++) if (raw[(i + k + T.count) % T.count]) return true;
    return false;
  });
})();

// ---------------------------------------------------------------------------------------------
// Geometry helpers

/** A strip along the track between two offsets, flat, or upright when `wall` is set. */
function ribbon(o: {
  a: (i: number) => number;
  b: (i: number) => number;
  y?: (i: number) => number;
  wall?: { y0: (i: number) => number; y1: (i: number) => number };
  keep?: (i: number) => boolean;
  vEvery: number;
  /** Runs the texture backwards along the track, so text on the right-hand wall reads forwards. */
  flip?: boolean;
}) {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= T.count; i++) {
    const s = i * T.step;
    if (o.wall) {
      const p = at(i, o.a(i));
      pos.push(p.x, o.wall.y0(i), p.y, p.x, o.wall.y1(i), p.y);
    } else {
      const p = at(i, o.a(i));
      const q = at(i, o.b(i));
      const y = o.y ? o.y(i) : p.e;
      pos.push(p.x, y, p.y, q.x, y, q.y);
    }
    // Flat strips run v along the track; upright ones run u along it, so text reads sideways.
    const u = (o.flip ? -s : s) / o.vEvery;
    if (o.wall) uv.push(u, 0, u, 1);
    else uv.push(0, s / o.vEvery, 1, s / o.vEvery);
    if (i < T.count && (!o.keep || o.keep(i))) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

type Part = [
  geo: THREE.BufferGeometry,
  color: string,
  pos: [number, number, number],
  rot?: [number, number, number],
  scale?: [number, number, number],
];

/** Many coloured primitives baked into one geometry, so a model is one draw call. */
function bake(parts: Part[]) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const geos = parts.map(([geo, color, p, r, s]) => {
    const g = geo
      .clone()
      .applyMatrix4(
        m.compose(
          new THREE.Vector3(...p),
          q.setFromEuler(e.set(...(r ?? [0, 0, 0]))),
          new THREE.Vector3(...(s ?? [1, 1, 1])),
        ),
      );
    g.deleteAttribute("uv");
    const c = new THREE.Color(color);
    const n = g.attributes.position!.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    return g;
  });
  const out = mergeGeometries(geos)!;
  for (const g of geos) g.dispose();
  return out;
}

const box = (x: number, y: number, z: number) => new THREE.BoxGeometry(x, y, z);
const cyl = (rt: number, rb: number, h: number, seg = 12) => new THREE.CylinderGeometry(rt, rb, h, seg);

function canvasTexture(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void, repeat = true) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext("2d")!);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ---------------------------------------------------------------------------------------------
// Textures

function roadTexture() {
  return canvasTexture(256, 512, (c) => {
    c.fillStyle = "#3d4046";
    c.fillRect(0, 0, 256, 512);
    const rnd = mulberry32(3);
    for (let i = 0; i < 6000; i++) {
      const v = 50 + Math.floor(rnd() * 40);
      c.fillStyle = `rgb(${v},${v + 2},${v + 6})`;
      c.fillRect(rnd() * 256, rnd() * 512, 2, 2);
    }
    // The racing line: a darker band of rubber down the middle.
    c.fillStyle = "rgba(20,20,24,0.18)";
    c.fillRect(96, 0, 64, 512);
    c.fillStyle = "#f2f2f2";
    c.fillRect(4, 0, 5, 512);
    c.fillRect(247, 0, 5, 512);
    for (const u of [0.25, 0.5, 0.75]) c.fillRect(u * 256 - 2, 0, 4, 230);
  });
}

function kerbTexture() {
  return canvasTexture(32, 64, (c) => {
    c.fillStyle = "#e10600";
    c.fillRect(0, 0, 32, 32);
    c.fillStyle = "#ffffff";
    c.fillRect(0, 32, 32, 32);
  });
}

function grassTexture() {
  return canvasTexture(256, 256, (c) => {
    c.fillStyle = "#4f8f3a";
    c.fillRect(0, 0, 256, 256);
    c.fillStyle = "#5a9c42";
    c.fillRect(0, 0, 256, 128);
    const rnd = mulberry32(5);
    for (let i = 0; i < 3000; i++) {
      c.fillStyle = rnd() < 0.5 ? "rgba(30,70,20,0.25)" : "rgba(140,190,90,0.2)";
      c.fillRect(rnd() * 256, rnd() * 256, 2, 3);
    }
  });
}

const ADS = [
  ["#15151e", "#ffffff", "SPOTFLOW"],
  ["#e10600", "#ffffff", "LAGOS RUSH"],
  ["#ffd23f", "#15151e", "EKO GP"],
  ["#00a19c", "#ffffff", "JOLLOF"],
  ["#1e5bc6", "#ffffff", "NAIJA"],
  ["#ffffff", "#e10600", "DANFO"],
] as const;

function adsTexture() {
  return canvasTexture(1024, 64, (c) => {
    const w = 1024 / ADS.length;
    ADS.forEach(([bg, fg, text], i) => {
      c.fillStyle = bg;
      c.fillRect(i * w, 0, w, 64);
      c.fillStyle = fg;
      c.font = "italic 900 34px system-ui, sans-serif";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(text, i * w + w / 2, 34, w - 16);
    });
  });
}

function windowTexture() {
  return canvasTexture(128, 128, (c) => {
    c.fillStyle = "#ffffff";
    c.fillRect(0, 0, 128, 128);
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) {
        if (x === 0 && y === 3) continue; // A solid patch the roofs sample.
        c.fillStyle = (x + y * 3) % 5 === 0 ? "#8fb6d8" : "#4a6178";
        c.fillRect(x * 32 + 6, y * 32 + 8, 20, 18);
      }
  });
}

function crowdTexture() {
  return canvasTexture(256, 128, (c) => {
    c.fillStyle = "#2a2e38";
    c.fillRect(0, 0, 256, 128);
    const rnd = mulberry32(11);
    const shirts = ["#e10600", "#ffd23f", "#ffffff", "#1e5bc6", "#00a19c", "#ff8000", "#52e252"];
    for (let i = 0; i < 1400; i++) {
      c.fillStyle = shirts[Math.floor(rnd() * shirts.length)]!;
      c.fillRect(rnd() * 256, rnd() * 128, 3, 4);
    }
    c.fillStyle = "rgba(0,0,0,0.25)";
    for (let y = 0; y < 128; y += 16) c.fillRect(0, y, 256, 3);
  });
}

function textTexture(text: string, bg: string, fg: string, w = 512, h = 96, italic = false) {
  const tex = canvasTexture(
    w,
    h,
    (c) => {
      c.fillStyle = bg;
      c.fillRect(0, 0, w, h);
      c.strokeStyle = fg;
      c.lineWidth = 6;
      c.strokeRect(6, 6, w - 12, h - 12);
      c.fillStyle = fg;
      c.font = `${italic ? "italic " : ""}900 ${Math.round(h * 0.5)}px system-ui, sans-serif`;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(text, w / 2, h / 2 + 3, w - 40);
    },
    false,
  );
  return tex;
}

function checkerTexture() {
  const tex = canvasTexture(
    256,
    32,
    (c) => {
      for (let x = 0; x < 16; x++)
        for (let y = 0; y < 2; y++) {
          c.fillStyle = (x + y) % 2 ? "#111111" : "#ffffff";
          c.fillRect(x * 16, y * 16, 16, 16);
        }
    },
    false,
  );
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

function blobTexture() {
  return canvasTexture(
    64,
    64,
    (c) => {
      const g = c.createRadialGradient(32, 32, 4, 32, 32, 32);
      g.addColorStop(0, "rgba(0,0,0,0.55)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      c.fillStyle = g;
      c.fillRect(0, 0, 64, 64);
    },
    false,
  );
}

function boxTexture() {
  return canvasTexture(
    128,
    128,
    (c) => {
      const g = c.createLinearGradient(0, 0, 128, 128);
      g.addColorStop(0, "#ff3d9a");
      g.addColorStop(1, "#4fb3ff");
      c.fillStyle = g;
      c.fillRect(0, 0, 128, 128);
      c.strokeStyle = "#ffffff";
      c.lineWidth = 8;
      c.strokeRect(4, 4, 120, 120);
      c.fillStyle = "#ffffff";
      c.font = "900 92px system-ui, sans-serif";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText("?", 64, 70);
    },
    false,
  );
}

// ---------------------------------------------------------------------------------------------
// Models. Forward is +x, up is +y, right is +z.

function f1Car(n: number) {
  const paint = carPaint(n);
  const accent = carAccent(n);
  const black = "#121216";
  const tyre = "#18181b";
  const rim = "#9a9da6";
  const wheel = (x: number, z: number, r: number, w: number): Part[] => [
    [cyl(r, r, w, 14), tyre, [x, r, z], [Math.PI / 2, 0, 0]],
    [cyl(r * 0.55, r * 0.55, w + 0.3, 10), rim, [x, r, z], [Math.PI / 2, 0, 0]],
  ];
  return bake([
    // Floor and plank.
    [box(30, 1, 13), black, [0, 1.6, 0]],
    // Tub and nose.
    [box(18, 4.2, 6.4), paint, [1, 4, 0]],
    [cyl(1.1, 2.9, 11, 10), paint, [15, 3.4, 0], [0, 0, -Math.PI / 2], [1, 1, 0.75]],
    // Sidepods, tapering back.
    [box(11, 4, 4), paint, [-1, 3.6, 4.8]],
    [box(11, 4, 4), paint, [-1, 3.6, -4.8]],
    [box(4, 3.2, 4.2), black, [5, 3.8, 4.8]],
    [box(4, 3.2, 4.2), black, [5, 3.8, -4.8]],
    // Engine cover and shark fin.
    [box(13, 4.6, 4.4), accent, [-9, 5.6, 0]],
    [box(9, 3, 0.6), paint, [-11, 9, 0]],
    [box(3.2, 3.6, 3), paint, [-3.2, 8.6, 0]],
    // Cockpit, driver and halo.
    [box(6, 0.8, 4.2), black, [2, 6.3, 0]],
    [new THREE.SphereGeometry(1.9, 12, 10), accent === "#15151e" ? "#ffffff" : accent, [0.8, 7.3, 0]],
    [box(6.5, 0.7, 0.7), black, [2.6, 8.8, 0]],
    [box(0.7, 2.8, 0.7), black, [5.6, 7.5, 0]],
    // Front wing and endplates.
    [box(4.5, 0.7, 19), accent, [17, 1.4, 0]],
    [box(4.5, 0.7, 19), paint, [15.5, 2.2, 0], [0, 0, 0.25], [0.7, 1, 1]],
    [box(5, 2.6, 0.5), black, [16.8, 2.2, 9.5]],
    [box(5, 2.6, 0.5), black, [16.8, 2.2, -9.5]],
    // Rear wing on its pylon.
    [box(4.2, 0.9, 15), paint, [-17.5, 10.2, 0]],
    [box(3, 0.6, 15), accent, [-16.4, 11.4, 0]],
    [box(5, 6, 0.5), black, [-17.5, 8.4, 7.6]],
    [box(5, 6, 0.5), black, [-17.5, 8.4, -7.6]],
    [box(1, 5, 1), black, [-16, 6.6, 0]],
    // Diffuser.
    [box(4, 2, 11), black, [-16, 2.2, 0]],
    ...wheel(11, 8.2, 3.9, 3.8),
    ...wheel(11, -8.2, 3.9, 3.8),
    ...wheel(-11.5, 8.4, 4.3, 5),
    ...wheel(-11.5, -8.4, 4.3, 5),
  ]);
}

const SEDANS = ["#c9ced8", "#6b7385", "#b23a3a", "#2d5fa8", "#e8e8e8", "#3c3c46"];
const UMBRELLAS = [
  ["#ff5a4e", "#ffffff"],
  ["#2f9bff", "#ffc53d"],
  ["#3fd08b", "#ffffff"],
  ["#ff7ac8", "#ffc53d"],
];
const RIDERS = ["#ff5a4e", "#2f9bff", "#ffc53d", "#3fd08b"];

function obstacleModel(kind: ObstacleKind, v: number) {
  const k = OBSTACLE_KINDS[kind];
  const L = k.hs * 2;
  const W = k.hd * 2;
  const tyre = "#1a1a1d";
  const wheels = (xs: number[], z: number, r: number): Part[] =>
    xs.flatMap((x) => [
      [cyl(r, r, 3, 10), tyre, [x, r, z], [Math.PI / 2, 0, 0]] as Part,
      [cyl(r, r, 3, 10), tyre, [x, r, -z], [Math.PI / 2, 0, 0]] as Part,
    ]);
  switch (kind) {
    case "pothole":
      return bake([
        [new THREE.CircleGeometry(1, 14), "#17171b", [0, 0.35, 0], [-Math.PI / 2, 0, v], [k.hs, k.hd, 1]],
        [new THREE.CircleGeometry(1, 12), "#4d6c84", [2, 0.45, 1], [-Math.PI / 2, 0, v], [k.hs * 0.5, k.hd * 0.4, 1]],
      ]);
    case "cone":
      return bake([
        [box(14, 1.2, 14), "#ff6a00", [0, 0.6, 0]],
        [new THREE.ConeGeometry(6, 18, 12), "#ff6a00", [0, 10, 0]],
        [cyl(3.6, 4.4, 3.5, 12), "#ffffff", [0, 11, 0]],
      ]);
    case "stall": {
      const [a, b] = UMBRELLAS[v % UMBRELLAS.length]!;
      return bake([
        [box(36, 12, 30), "#8a5a2b", [0, 6, 0]],
        [box(10, 5, 8), "#ffd23f", [-8, 14, -6]],
        [box(9, 5, 9), "#3fd08b", [7, 14, 5]],
        [new THREE.SphereGeometry(4, 8, 6), "#ff6a00", [6, 15, -8]],
        [cyl(0.8, 0.8, 30), "#555555", [0, 15, 0]],
        [new THREE.ConeGeometry(30, 10, 8), a!, [0, 32, 0]],
        [cyl(30.2, 30.2, 2, 8), b!, [0, 27.5, 0]],
      ]);
    }
    case "keke":
      return bake([
        [box(L - 4, 12, W), "#ffc21a", [0, 12, 0]],
        [box(8, 10, W - 4), "#1d2433", [L / 2 - 8, 16, 0]],
        [box(L - 6, 2, W + 2), "#1fa65a", [-2, 25, 0]],
        [box(1.5, 10, 1.5), "#222222", [L / 2 - 4, 20, W / 2 - 1]],
        [box(1.5, 10, 1.5), "#222222", [L / 2 - 4, 20, -W / 2 + 1]],
        [cyl(4, 4, 3, 10), tyre, [L / 2 - 4, 4, 0], [Math.PI / 2, 0, 0]],
        ...wheels([-L / 2 + 6], W / 2 - 1, 4),
      ]);
    case "danfo":
      return bake([
        [box(L, 22, W + 8), "#ffc21a", [0, 16, 0]],
        [box(L + 0.4, 2, W + 8.4), "#15151a", [0, 11, 0]],
        [box(L + 0.4, 2, W + 8.4), "#15151a", [0, 7, 0]],
        [box(L - 14, 7, W + 8.6), "#1d2433", [-4, 21, 0]],
        [box(1, 10, W + 4), "#1d2433", [L / 2, 19, 0]],
        [box(40, 1.5, W + 2), "#6b4a12", [-4, 28, 0]],
        [box(10, 5, 10), "#2d5fa8", [-8, 31, 3]],
        ...wheels([L / 2 - 10, -L / 2 + 10], W / 2 + 3, 5),
      ]);
    case "okada":
      return bake([
        [box(L, 4, 4), "#222226", [0, 7, 0]],
        [cyl(5, 5, 2, 12), tyre, [L / 2 - 3, 5, 0], [Math.PI / 2, 0, 0]],
        [cyl(5, 5, 2, 12), tyre, [-L / 2 + 3, 5, 0], [Math.PI / 2, 0, 0]],
        [box(1, 1, 12), "#9aa0b4", [L / 2 - 4, 14, 0]],
        [box(7, 12, 8), RIDERS[v % RIDERS.length]!, [-2, 16, 0]],
        [new THREE.SphereGeometry(3.6, 10, 8), "#15151a", [-1, 25, 0]],
      ]);
    case "car":
    default:
      return bake([
        [box(L, 9, W), SEDANS[v % SEDANS.length]!, [0, 8, 0]],
        [box(L * 0.5, 7, W - 4), "#2a3140", [-2, 15.5, 0]],
        [box(1, 2.4, 4), "#ff2d55", [-L / 2, 9, W / 2 - 4]],
        [box(1, 2.4, 4), "#ff2d55", [-L / 2, 9, -W / 2 + 4]],
        ...wheels([L / 2 - 8, -L / 2 + 8], W / 2 - 1, 3.6),
      ]);
  }
}

function palmCrown() {
  const parts: Part[] = [];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    parts.push([
      box(28, 1, 6),
      i % 2 ? "#2f7d32" : "#3d9440",
      [Math.cos(a) * 12, -3, Math.sin(a) * 12],
      [0, -a, -0.45],
    ]);
  }
  parts.push([new THREE.SphereGeometry(3, 8, 6), "#6b4a2a", [0, 0, 0]]);
  return bake(parts);
}

// ---------------------------------------------------------------------------------------------

export function createRaceWorld(canvas: HTMLCanvasElement): RaceWorld {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  const scene = new THREE.Scene();
  scene.background = canvasTexture(
    4,
    256,
    (c) => {
      const g = c.createLinearGradient(0, 0, 0, 256);
      g.addColorStop(0, SKY_TOP);
      g.addColorStop(0.55, HORIZON);
      g.addColorStop(1, HORIZON);
      c.fillStyle = g;
      c.fillRect(0, 0, 4, 256);
    },
    false,
  );
  const fog = new THREE.Fog(HORIZON, 1800, DRAW_DIST + 800);
  scene.fog = fog;

  // A near plane well away from the eye keeps depth precise enough for the flat layers of the
  // track, even on phones with a 16-bit depth buffer.
  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 6, 50000);
  scene.add(new THREE.HemisphereLight("#e4f2ff", "#5b7a45", 1.5));
  const sun = new THREE.DirectionalLight("#fff1d6", 2.2);
  sun.position.set(-0.6, 1, -0.4);
  scene.add(sun);

  const disposables: Array<{ dispose(): void }> = [];
  const own = <X extends { dispose(): void }>(x: X) => {
    disposables.push(x);
    return x;
  };
  const tex = (t: THREE.Texture, aniso = true) => {
    if (aniso) t.anisotropy = maxAniso;
    return own(t);
  };
  const colored = own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.05 }));
  const glossy = own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.35 }));
  const add = (g: THREE.BufferGeometry, m: THREE.Material) => {
    own(g);
    const mesh = new THREE.Mesh(g, m);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    scene.add(mesh);
    return mesh;
  };
  const flat = (map: THREE.Texture, extra: THREE.MeshStandardMaterialParameters = {}) =>
    own(new THREE.MeshStandardMaterial({ map, roughness: 0.9, metalness: 0, side: THREE.DoubleSide, ...extra }));
  /** Flat layers lying on each other: a higher layer always wins the depth test. */
  const layer = (n: number) => ({ polygonOffset: true, polygonOffsetFactor: -n, polygonOffsetUnits: -n * 4 });
  const plain = (color: string, extra: THREE.MeshStandardMaterialParameters = {}) =>
    own(new THREE.MeshStandardMaterial({ color, roughness: 0.85, side: THREE.DoubleSide, ...extra }));

  const half = (i: number) => T.half[((i % T.count) + T.count) % T.count]!;
  const wall = (i: number) => T.wall[((i % T.count) + T.count) % T.count]!;
  const e = (i: number) => ELEV[((i % T.count) + T.count) % T.count]!;
  const b = T.bounds;
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minY + b.maxY) / 2;

  // Ground and lagoon.
  const grass = tex(grassTexture());
  grass.repeat.set(160, 160);
  const ground = add(new THREE.PlaneGeometry(64000, 64000), flat(grass, { side: THREE.FrontSide, ...layer(-4) }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(cx, -3, cz);
  ground.updateMatrix();
  // The lagoon: overlapping discs along the bridges make a soft, natural shoreline.
  const lagoon = (r: number, y: number) => {
    const discs: THREE.BufferGeometry[] = [];
    for (let i = 0; i < T.count; i += 3) {
      if (!isBridge(i)) continue;
      const d = new THREE.CircleGeometry(r, 28);
      d.rotateX(-Math.PI / 2);
      d.translate(T.x[i]!, y, T.y[i]!);
      discs.push(d);
    }
    const g = mergeGeometries(discs)!;
    for (const d of discs) d.dispose();
    return g;
  };
  add(lagoon(2050, -2.4), plain("#d8c79a", layer(-3)));
  add(lagoon(1900, -2), plain("#2a78b0", { roughness: 0.45, metalness: 0.1, ...layer(-2) }));

  // Road, kerbs, run-off and walls.
  const road = tex(roadTexture());
  add(ribbon({ a: (i) => -half(i), b: (i) => half(i), vEvery: 520 }), flat(road));
  const kerb = tex(kerbTexture());
  const kerbKeep = (i: number) => KERB[((i % T.count) + T.count) % T.count]!;
  for (const side of [-1, 1])
    add(
      ribbon({
        a: (i) => side * half(i),
        b: (i) => side * (half(i) + 22),
        y: (i) => e(i) + 0.3,
        keep: kerbKeep,
        vEvery: 64,
      }),
      flat(kerb, layer(1)),
    );
  const zoneOf = (i: number) => T.zone[((i % T.count) + T.count) % T.count]!;
  const runoff: Array<[string, (i: number) => boolean]> = [
    ["#3f7f3a", (i) => zoneOf(i) === "road"],
    ["#c7a46a", (i) => zoneOf(i) === "market"],
    ["#9a9ea6", isBridge],
  ];
  for (const [color, keep] of runoff)
    for (const side of [-1, 1])
      add(
        ribbon({ a: (i) => side * half(i), b: (i) => side * wall(i), y: (i) => e(i) - 0.3, keep, vEvery: 100 }),
        plain(color, layer(-1)),
      );

  const ads = tex(adsTexture());
  const notBridge = (i: number) => !isBridge(i);
  for (const side of [-1, 1]) {
    add(
      ribbon({
        a: (i) => side * wall(i),
        b: () => 0,
        wall: { y0: e, y1: (i) => e(i) + 15 },
        keep: notBridge,
        vEvery: 900,
        flip: side > 0,
      }),
      flat(ads),
    );
    // Concrete parapet and blue rail on the bridges.
    add(
      ribbon({ a: (i) => side * wall(i), b: () => 0, wall: { y0: e, y1: (i) => e(i) + 9 }, keep: isBridge, vEvery: 1 }),
      plain("#b9bcc3"),
    );
    add(
      ribbon({
        a: (i) => side * wall(i),
        b: () => 0,
        wall: { y0: (i) => e(i) + 11, y1: (i) => e(i) + 14 },
        keep: isBridge,
        vEvery: 1,
      }),
      plain("#2f6fd6", { metalness: 0.4, roughness: 0.4 }),
    );
    // Embankment under raised road.
    add(
      ribbon({
        a: (i) => side * wall(i),
        b: () => 0,
        wall: { y0: () => -1, y1: e },
        keep: (i) => e(i) > 0.5,
        vEvery: 1,
      }),
      plain("#a7a39a"),
    );
  }

  // Bridge piers.
  const piers: THREE.Matrix4[] = [];
  for (let i = 0; i < T.count; i += 5) {
    if (!isBridge(i)) continue;
    for (const side of [-1, 1]) {
      const p = at(i, side * (wall(i) - 24));
      piers.push(
        new THREE.Matrix4().compose(
          new THREE.Vector3(p.x, e(i) / 2 - 2, p.y),
          new THREE.Quaternion(),
          new THREE.Vector3(1, e(i) + 2, 1),
        ),
      );
    }
  }
  const pierMesh = new THREE.InstancedMesh(own(cyl(9, 11, 1, 10)), plain("#b5b1a6"), piers.length);
  piers.forEach((m, i) => pierMesh.setMatrixAt(i, m));
  scene.add(pierMesh);

  // Start line, grid boxes and the start gantry.
  {
    const ribbonAt = (s0: number, s1: number, d0: number, d1: number) => {
      const g = new THREE.BufferGeometry();
      const pts = [
        [s0, d0],
        [s0, d1],
        [s1, d0],
        [s1, d1],
      ].map(([s, d]) => {
        const i = s! / T.step;
        const k = Math.floor(i);
        const p = at(k, d!);
        const q = at(k + 1, d!);
        const f = i - k;
        return [p.x + (q.x - p.x) * f, e(0) + 0.5, p.y + (q.y - p.y) * f];
      });
      g.setAttribute("position", new THREE.Float32BufferAttribute(pts.flat(), 3));
      g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
      g.setIndex([0, 2, 1, 1, 2, 3]);
      g.computeVertexNormals();
      return g;
    };
    add(ribbonAt(T.length - 12, T.length + 12, -half(0), half(0)), flat(tex(checkerTexture()), layer(2)));
    const marks: Part[] = [];
    for (let slot = 0; slot < R.maxRacers; slot++) {
      const g = gridSlot(slot);
      const fx = Math.cos(g.h);
      const fz = Math.sin(g.h);
      marks.push([box(3, 0.4, 28), "#ffffff", [g.x + fx * 22, 0.4, g.y + fz * 22], [0, -g.h, 0]]);
      for (const side of [-1, 1])
        marks.push([
          box(12, 0.4, 3),
          "#ffffff",
          [g.x + fx * 16 - fz * 13 * side, 0.4, g.y + fz * 16 + fx * 13 * side],
          [0, -g.h, 0],
        ]);
    }
    add(bake(marks), own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, ...layer(2) })));
  }
  const lights: THREE.MeshBasicMaterial[] = [];
  {
    const s = 60;
    const i = Math.floor(s / T.step);
    const h = smoothH[i]!;
    const p = at(i, 0);
    const span = wall(i) + 14;
    const gantry = new THREE.Group();
    gantry.position.set(p.x, e(i), p.y);
    gantry.rotation.y = -h;
    const steel = plain("#2a2d36", { metalness: 0.5, roughness: 0.4 });
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(own(box(8, 82, 8)), steel);
      post.position.set(0, 41, side * span);
      gantry.add(post);
    }
    const beam = new THREE.Mesh(own(box(10, 16, span * 2 + 8)), steel);
    beam.position.set(0, 82, 0);
    gantry.add(beam);
    const banner = new THREE.Mesh(
      own(new THREE.PlaneGeometry(span * 1.6, 14)),
      flat(tex(textTexture("LAGOS RUSH GRAND PRIX", "#e10600", "#ffffff", 1024, 96, true)), { side: THREE.FrontSide }),
    );
    banner.position.set(-5.2, 82, 0);
    banner.rotation.y = -Math.PI / 2;
    gantry.add(banner);
    const pod = own(box(4, 22, 9));
    const lamp = own(new THREE.CircleGeometry(3, 16));
    for (let k = 0; k < 5; k++) {
      const z = (k - 2) * 16;
      const housing = new THREE.Mesh(pod, steel);
      housing.position.set(-6, 64, z);
      gantry.add(housing);
      for (const y of [58, 70]) {
        const mat = own(new THREE.MeshBasicMaterial({ color: "#2a0606" }));
        lights.push(mat);
        const l = new THREE.Mesh(lamp, mat);
        l.position.set(-8.2, y, z);
        l.rotation.y = -Math.PI / 2;
        gantry.add(l);
      }
    }
    scene.add(gantry);
  }

  // Grandstands along the start straight.
  {
    const crowdMap = tex(crowdTexture());
    crowdMap.repeat.set(5, 1.4);
    const crowd = flat(crowdMap);
    const roofMat = plain("#f2f2f2");
    const frame = plain("#6d7380");
    for (const [s, side] of [
      [-700, 1],
      [-200, 1],
      [300, 1],
      [-450, -1],
      [50, -1],
    ] as const) {
      const i = Math.floor((((s % T.length) + T.length) % T.length) / T.step);
      const h = smoothH[i]!;
      const p = at(i, side * (wall(i) + 70));
      const g = new THREE.Group();
      g.position.set(p.x, 0, p.y);
      g.rotation.y = -h;
      const seats = new THREE.Mesh(own(new THREE.PlaneGeometry(420, 90)), crowd);
      seats.position.set(0, 34, 0);
      // Tilted back from the track, facing it.
      seats.rotation.x = side > 0 ? -Math.PI + 0.6 : -0.6;
      g.add(seats);
      const back = new THREE.Mesh(own(box(420, 70, 6)), frame);
      back.position.set(0, 35, side * 36);
      g.add(back);
      const roof = new THREE.Mesh(own(box(430, 3, 90)), roofMat);
      roof.position.set(0, 82, side * 6);
      roof.rotation.x = side * 0.08;
      g.add(roof);
      scene.add(g);
    }
  }

  // The city: buildings, palms, lamps and district boards, placed once from a fixed seed.
  {
    const rnd = mulberry32(9);
    const bridgeSamples: Array<[number, number]> = [];
    for (let i = 0; i < T.count; i += 4) if (isBridge(i)) bridgeSamples.push([T.x[i]!, T.y[i]!]);
    const inWater = (x: number, y: number) =>
      bridgeSamples.some(([bx, by]) => (bx - x) ** 2 + (by - y) ** 2 < 2100 ** 2);
    const nearTrack = (x: number, y: number, clear: number) => {
      for (let i = 0; i < T.count; i += 2) if ((T.x[i]! - x) ** 2 + (T.y[i]! - y) ** 2 < clear * clear) return true;
      return false;
    };
    const walls = ["#f1ece2", "#d9e4ee", "#e8d6b8", "#c9d6c4", "#f3d9d0", "#cdd2da", "#b8c8e0"];
    const pos: number[] = [];
    const uv: number[] = [];
    const col: number[] = [];
    const quad = (
      a: [number, number, number],
      bb: [number, number, number],
      c: [number, number, number],
      d: [number, number, number],
      u: number,
      v: number,
      color: THREE.Color,
      solid: boolean,
    ) => {
      // Wound so the faces point outwards.
      pos.push(...a, ...c, ...bb, ...a, ...d, ...c);
      const U = solid ? [0.01, 0.01, 0.01, 0.01, 0.01, 0.01] : [0, u, u, 0, 0, u];
      const V = solid ? [0.01, 0.01, 0.01, 0.01, 0.01, 0.01] : [0, v, 0, 0, v, v];
      for (let k = 0; k < 6; k++) {
        uv.push(U[k]!, V[k]!);
        col.push(color.r, color.g, color.b);
      }
    };
    const block = (x: number, y: number, a: number, w: number, d: number, h: number, color: THREE.Color) => {
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const corner = (fx: number, fz: number): [number, number] => [x + ca * fx - sa * fz, y + sa * fx + ca * fz];
      const cs = [corner(-w / 2, -d / 2), corner(w / 2, -d / 2), corner(w / 2, d / 2), corner(-w / 2, d / 2)];
      for (let k = 0; k < 4; k++) {
        const p = cs[k]!;
        const q = cs[(k + 1) % 4]!;
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        quad([p[0], 0, p[1]], [q[0], 0, q[1]], [q[0], h, q[1]], [p[0], h, p[1]], len / 64, h / 64, color, false);
      }
      quad(
        [cs[0]![0], h, cs[0]![1]],
        [cs[1]![0], h, cs[1]![1]],
        [cs[2]![0], h, cs[2]![1]],
        [cs[3]![0], h, cs[3]![1]],
        0,
        0,
        color.clone().multiplyScalar(0.8),
        true,
      );
    };
    for (let i = 0; i < T.count; i += 3) {
      if (isBridge(i)) continue;
      for (const side of [-1, 1]) {
        if (rnd() < 0.25) continue;
        const w = 90 + rnd() * 140;
        const d = 70 + rnd() * 110;
        const off = wall(i) + 90 + d / 2 + rnd() * 160;
        const p = at(i + Math.floor(rnd() * 2), side * off);
        const tall = zoneOf(i) === "market" ? 40 + rnd() * 60 : 70 + rnd() * rnd() * 380;
        if (inWater(p.x, p.y) || nearTrack(p.x, p.y, wall(i) + Math.max(w, d) / 2 + 60)) continue;
        block(p.x, p.y, smoothH[i]!, w, d, tall, new THREE.Color(walls[Math.floor(rnd() * walls.length)]!));
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    add(g, own(new THREE.MeshStandardMaterial({ map: tex(windowTexture()), vertexColors: true, roughness: 0.8 })));

    // Palms.
    const palms: THREE.Matrix4[] = [];
    for (let k = 0; k < 900 && palms.length < 340; k++) {
      const i = Math.floor(rnd() * T.count);
      if (isBridge(i)) continue;
      const side = rnd() < 0.5 ? -1 : 1;
      const p = at(i, side * (wall(i) + 30 + rnd() * 70));
      if (inWater(p.x, p.y) || nearTrack(p.x, p.y, wall(i) + 20)) continue;
      const s = 0.8 + rnd() * 0.5;
      palms.push(
        new THREE.Matrix4().compose(
          new THREE.Vector3(p.x, 0, p.y),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6),
          new THREE.Vector3(s, s, s),
        ),
      );
    }
    const trunkGeo = own(cyl(1.8, 2.8, 64, 7));
    trunkGeo.translate(0, 32, 0);
    const trunks = new THREE.InstancedMesh(trunkGeo, plain("#8a6a46"), palms.length);
    const crownGeo = own(palmCrown());
    crownGeo.translate(0, 64, 0);
    const crowns = new THREE.InstancedMesh(crownGeo, colored, palms.length);
    palms.forEach((m, i) => {
      trunks.setMatrixAt(i, m);
      crowns.setMatrixAt(i, m);
    });
    scene.add(trunks, crowns);

    // Street lights over the barriers.
    const lamps: THREE.Matrix4[] = [];
    for (let i = 0; i < T.count; i += 6)
      for (const side of [-1, 1]) {
        const p = at(i, side * (wall(i) + 8));
        lamps.push(
          new THREE.Matrix4().compose(
            new THREE.Vector3(p.x, e(i), p.y),
            new THREE.Quaternion().setFromAxisAngle(
              new THREE.Vector3(0, 1, 0),
              -smoothH[i]! + (side > 0 ? Math.PI : 0),
            ),
            new THREE.Vector3(1, 1, 1),
          ),
        );
      }
    const lampGeo = own(
      bake([
        [cyl(1.2, 1.6, 60, 6), "#8d929c", [0, 30, 0]],
        [box(1.4, 1.4, 22), "#8d929c", [0, 60, 10]],
        [box(5, 2, 8), "#fff6d0", [0, 59, 20]],
      ]),
    );
    const lampMesh = new THREE.InstancedMesh(lampGeo, colored, lamps.length);
    lamps.forEach((m, i) => lampMesh.setMatrixAt(i, m));
    scene.add(lampMesh);

    // District boards, angled toward oncoming cars.
    for (const dist of T.districts) {
      const i = Math.floor((dist.s + 200) / T.step) % T.count;
      const p = at(i, wall(i) + 34);
      const board = new THREE.Group();
      board.position.set(p.x, e(i), p.y);
      board.rotation.y = -smoothH[i]! - Math.PI / 2 - 0.5;
      const sign = new THREE.Mesh(
        own(new THREE.PlaneGeometry(150, 28)),
        flat(tex(textTexture(dist.name.toUpperCase(), "#0f7a43", "#ffffff")), { side: THREE.FrontSide }),
      );
      sign.position.y = 50;
      board.add(sign);
      const back = new THREE.Mesh(own(box(152, 30, 2)), plain("#30343c"));
      back.position.set(0, 50, -1.2);
      board.add(back);
      for (const x of [-60, 60]) {
        const post = new THREE.Mesh(own(box(3, 50, 3)), plain("#8d929c"));
        post.position.set(x, 25, -2);
        board.add(post);
      }
      scene.add(board);
    }
  }

  // Item boxes and oil slicks.
  const boxMat = own(
    new THREE.MeshStandardMaterial({
      map: tex(boxTexture(), false),
      emissive: "#ffffff",
      emissiveIntensity: 0.35,
      transparent: true,
      opacity: 0.92,
    }),
  );
  boxMat.emissiveMap = boxMat.map;
  const boxGeo = own(box(17, 17, 17));
  const itemBoxes = RACE_BOXES.map((bx) => {
    const m = new THREE.Mesh(boxGeo, boxMat);
    m.position.set(bx.x, elevAtS(bx.s) + 14, bx.y);
    scene.add(m);
    return m;
  });
  const slickGeo = own(new THREE.CircleGeometry(R.slick.radius, 20));
  const slickMat = own(
    new THREE.MeshStandardMaterial({ color: "#050507", roughness: 0.08, metalness: 0.7, ...layer(3) }),
  );
  const slickPool: THREE.Mesh[] = [];

  // Cars.
  const carGeos = new Map<string, THREE.BufferGeometry>();
  const blobGeo = own(new THREE.PlaneGeometry(50, 30));
  blobGeo.rotateX(-Math.PI / 2);
  const blobMat = own(
    new THREE.MeshBasicMaterial({ map: tex(blobTexture(), false), transparent: true, depthWrite: false }),
  );
  const flameGeo = own(new THREE.ConeGeometry(3.2, 18, 10));
  flameGeo.rotateZ(Math.PI / 2);
  flameGeo.translate(-26, 4.5, 0);
  const flameMat = own(new THREE.MeshBasicMaterial({ color: "#6fe8ff", transparent: true, opacity: 0.85 }));
  interface CarMesh {
    group: THREE.Group;
    flame: THREE.Mesh;
    key: string;
  }
  const carPool = new Map<number, CarMesh>();
  const hints = new Map<number, number>();
  const carFor = (n: number) => {
    const key = liveryKey(n);
    let c = carPool.get(n);
    if (!c || c.key !== key) {
      if (c) scene.remove(c.group);
      let geo = carGeos.get(key);
      if (!geo) {
        geo = own(f1Car(n));
        carGeos.set(key, geo);
      }
      const group = new THREE.Group();
      group.add(new THREE.Mesh(geo, glossy));
      const blob = new THREE.Mesh(blobGeo, blobMat);
      blob.position.y = 0.4;
      blob.renderOrder = 1;
      group.add(blob);
      const flame = new THREE.Mesh(flameGeo, flameMat);
      group.add(flame);
      c = { group, flame, key };
      carPool.set(n, c);
      scene.add(group);
    }
    return c;
  };
  const elevOf = (key: number, x: number, y: number) => {
    const loc = locate(x, y, hints.get(key) ?? -1);
    hints.set(key, loc.i);
    return elevAtS(loc.s);
  };

  // Obstacles: statics are placed once per course; movers each frame.
  const obstacleGeos = new Map<string, THREE.BufferGeometry>();
  const modelFor = (kind: ObstacleKind, v: number) => {
    const key = `${kind}:${v}`;
    let g = obstacleGeos.get(key);
    if (!g) {
      g = own(obstacleModel(kind, v));
      obstacleGeos.set(key, g);
    }
    return g;
  };
  const decal = own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, ...layer(2) }));
  const signalGeo = own(box(3, 3, 3));
  const signalMat = own(new THREE.MeshBasicMaterial({ color: "#ffa21f" }));
  let statics: THREE.Mesh[] = [];
  let movers: Array<{ mesh: THREE.Mesh; signals: THREE.Mesh[] }> = [];
  let course: RaceCourse | null = null;

  const placeOnTrack = (o: THREE.Object3D, s: number, d: number) => {
    const f = (((s % T.length) + T.length) % T.length) / T.step;
    const i = Math.floor(f);
    const p = at(i, d);
    const q = at(i + 1, d);
    const u = f - i;
    o.position.set(p.x + (q.x - p.x) * u, p.e + (q.e - p.e) * u, p.y + (q.y - p.y) * u);
    o.rotation.set(0, -T.h[i % T.count]!, 0);
  };

  const setCourse = (next: RaceCourse) => {
    if (next === course) return;
    course = next;
    for (const m of statics) scene.remove(m);
    for (const m of movers) scene.remove(m.mesh);
    statics = next.statics.map((o) => {
      const mesh = new THREE.Mesh(modelFor(o.kind, o.v), o.kind === "pothole" ? decal : colored);
      placeOnTrack(mesh, o.s, o.d);
      mesh.updateMatrix();
      mesh.matrixAutoUpdate = false;
      scene.add(mesh);
      return mesh;
    });
    movers = next.movers.map((mv) => {
      const mesh = new THREE.Mesh(modelFor(mv.kind, mv.v2), colored);
      const signals: THREE.Mesh[] = [];
      if (mv.kind === "danfo") {
        const k = OBSTACLE_KINDS.danfo;
        const z = mv.amp > 0 ? k.hd + 4.5 : -(k.hd + 4.5);
        for (const x of [k.hs - 2, -k.hs + 2]) {
          const s = new THREE.Mesh(signalGeo, signalMat);
          s.position.set(x, 12, z);
          s.visible = false;
          mesh.add(s);
          signals.push(s);
        }
      }
      scene.add(mesh);
      return { mesh, signals };
    });
  };

  // Camera state.
  const cam = { x: 0, y: 0, a: 0, e: 0, fov: 62, ready: false };
  const look = new THREE.Vector3();
  const v3 = new THREE.Vector3();
  let width = 1;
  let height = 1;

  const render = (f: RaceFrame) => {
    const dt = Math.min(0.05, Math.max(0, (f.t - (lastT || f.t)) / 1000));
    lastT = f.t;

    // Camera.
    if (f.overview || !f.focus) {
      const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
      const dist = (span / 2 / Math.tan((50 * Math.PI) / 360)) * (width / height < 1.2 ? 1.5 : 1.05);
      camera.fov = 50;
      camera.position.set(cx, dist * 0.92, cz + dist * 0.38);
      camera.lookAt(cx, 0, cz);
      fog.near = 1e6;
      fog.far = 2e6;
      cam.ready = false;
    } else {
      const fc = f.focus;
      const fe = elevOf(-1, fc.x, fc.y);
      if (!cam.ready) Object.assign(cam, { x: fc.x, y: fc.y, a: fc.h, e: fe, ready: true });
      cam.x = fc.x;
      cam.y = fc.y;
      cam.e += (fe - cam.e) * (1 - Math.exp(-dt * 8));
      let d = fc.h - cam.a;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      cam.a += d * (1 - Math.exp(-dt * (f.still ? 3 : 5)));
      const speed = Math.min(1, Math.abs(fc.v) / R.nitroSpeed);
      const fov = f.still ? 62 : 60 + speed * 16;
      cam.fov += (fov - cam.fov) * (1 - Math.exp(-dt * 3));
      camera.fov = cam.fov;
      const back = 78 + speed * 10;
      const fx = Math.cos(cam.a);
      const fz = Math.sin(cam.a);
      camera.position.set(cam.x - fx * back, cam.e + 30, cam.y - fz * back);
      look.set(cam.x + fx * 70, cam.e + 9, cam.y + fz * 70);
      if (f.shake && !f.still) {
        camera.position.x += (Math.random() - 0.5) * 3;
        camera.position.y += (Math.random() - 0.5) * 2;
      }
      camera.lookAt(look);
      fog.near = 1800;
      fog.far = DRAW_DIST + 800;
    }
    camera.updateProjectionMatrix();
    const cxp = camera.position.x;
    const czp = camera.position.z;
    const far2 = f.overview ? Infinity : (DRAW_DIST + 400) ** 2;
    const near = (x: number, z: number) => (x - cxp) ** 2 + (z - czp) ** 2 < far2;

    // Start lights: five pairs come on one by one, then all go out.
    const lit =
      f.countdown !== null && f.countdown > 0
        ? Math.min(5, Math.ceil(((R.countdownMs - f.countdown) / R.countdownMs) * 6))
        : 0;
    lights.forEach((m, i) => m.color.set(Math.floor(i / 2) < lit ? "#ff1a1a" : "#2a0606"));

    // Items.
    const spin = f.still ? 0.6 : f.t / 700;
    itemBoxes.forEach((m, i) => {
      const bx = RACE_BOXES[i]!;
      m.visible = !f.taken.has(bx.id) && near(m.position.x, m.position.z);
      m.rotation.set(0.5, spin, 0.3);
      m.position.y = elevAtS(bx.s) + 14 + (f.still ? 0 : Math.sin(f.t / 300 + i) * 3);
    });
    while (slickPool.length < f.slicks.length) {
      const m = new THREE.Mesh(slickGeo, slickMat);
      m.rotation.x = -Math.PI / 2;
      m.scale.set(1.2, 0.85, 1);
      scene.add(m);
      slickPool.push(m);
    }
    slickPool.forEach((m, i) => {
      const s = f.slicks[i];
      m.visible = !!s;
      if (s) {
        m.position.set(s.x, elevOf(-100 - (s.id % 50), s.x, s.y) + 0.5, s.y);
        m.rotation.z = s.id;
      }
    });

    // Traffic.
    for (const m of statics) m.visible = near(m.position.x, m.position.z);
    if (course) {
      const all = moversAt(course, f.raceT);
      all.forEach((mv, i) => {
        const o = movers[i];
        if (!o) return;
        placeOnTrack(o.mesh, mv.s, mv.d);
        o.mesh.visible = near(o.mesh.position.x, o.mesh.position.z);
        const on = mv.signal && Math.floor(f.t / 250) % 2 === 0;
        for (const s of o.signals) s.visible = on;
      });
    }

    // Racers.
    const seen = new Set<number>();
    for (const c of f.cars) {
      seen.add(c.n);
      const m = carFor(c.n);
      m.group.visible = near(c.x, c.y);
      if (!m.group.visible) continue;
      m.group.position.set(c.x, elevOf(c.n, c.x, c.y), c.y);
      m.group.rotation.y = -c.h;
      m.flame.visible = c.boost;
      if (c.boost) m.flame.scale.set(0.8 + Math.random() * 0.5, 1, 1);
    }
    for (const [n, m] of carPool) if (!seen.has(n)) m.group.visible = false;

    renderer.render(scene, camera);
  };
  let lastT = 0;

  return {
    setCourse,
    resize(w, h, dpr) {
      width = w;
      height = h;
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    },
    render,
    project(x, y, up = 0, key = -1) {
      v3.set(x, elevOf(key, x, y) + up, y);
      const dist = v3.distanceTo(camera.position);
      v3.project(camera);
      if (v3.z > 1 || v3.z < -1) return null;
      // Screen pixels per world unit there.
      const scale = height / (2 * Math.tan((camera.fov * Math.PI) / 360) * Math.max(1, dist));
      return { x: ((v3.x + 1) / 2) * width, y: ((1 - v3.y) / 2) * height, scale };
    },
    dispose() {
      for (const d of disposables) d.dispose();
      renderer.dispose();
    },
  };
}
