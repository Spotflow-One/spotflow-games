/**
 * Core Clash in 3D, seen from just behind your soldier: a dusty war zone at sunset, a pine forest
 * or a factory floor, as the host picks.
 *
 * The fight itself (movement, shots, scoring) stays flat and two-dimensional; this only draws
 * it. A ground point (x, y) sits at (x, height, y) here, so the world's y axis points up.
 */
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  CLASH_CENTER,
  CLASH_FLAG,
  CLASH_RULES as R,
  CLASH_TEAMS,
  clashBases,
  clashWalls,
  coverAlong,
  mulberry32,
  type ClashPickupKind,
  type ClashScenery,
  type Cover,
} from "@spotflow-games/shared";

export interface ClashFramePlayer {
  n: number;
  x: number;
  y: number;
  /** Aim angle, which is also the way the soldier faces. */
  a: number;
  team: number;
  flags: number;
}

export interface ClashFrame {
  /** performance.now() */
  t: number;
  still: boolean;
  /**
   * The soldier the camera sits behind, facing `yaw`, or null for a view of the whole war zone.
   * `down` runs from 0 to 1 while knocked out, and lifts the camera up and away. `zoom` runs
   * from 0 to 1 while aiming down the sights, and pulls the camera in over the shoulder. `low`
   * runs from 0 to 1 as the soldier crouches, and lowers the camera with them.
   */
  focus: { x: number; y: number; yaw: number; down: number; zoom?: number; low?: number } | null;
  players: ClashFramePlayer[];
  npcs: Array<{ id: number; kind: 0 | 1; x: number; y: number; flags: number }>;
  /** Power-up spots; `ready` while there's one to take. */
  pickups: Array<{ kind: ClashPickupKind; x: number; y: number; ready: boolean }>;
  /** `hot` shots come from a soldier on overdrive. */
  /** `long` shots are sniper rounds. */
  shots: Array<{
    id: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    team: number;
    hot?: boolean;
    long?: boolean;
  }>;
  /** Grenades in the air or on the ground; z is the height. */
  grenades: Array<{ id: number; x: number; y: number; z: number }>;
  /** Blasts, with k running from 0 to 1 over their life. */
  booms: Array<{ x: number; y: number; k: number }>;
  teamColors: string[];
}

export interface ClashWorld {
  resize(w: number, h: number, dpr: number): void;
  render(frame: ClashFrame): void;
  /** Where a ground point, at a height above the ground, lands on screen, if it is in front of the camera. */
  project(x: number, y: number, up?: number): { x: number; y: number; scale: number } | null;
  dispose(): void;
}

const { width: W, height: H } = R.arena;

/** The sky, fog and light of each scenery. */
interface SceneryLook {
  skyTop: string;
  horizon: string;
  fog: [near: number, far: number];
  /** Sky and ground colours of the ambient light, and its strength. */
  ambient: [sky: string, ground: string, intensity: number];
  sun: [color: string, intensity: number];
  rim: [color: string, intensity: number];
}
const LOOKS: Record<ClashScenery, SceneryLook> = {
  warzone: {
    skyTop: "#4a5f86",
    horizon: "#e8b98a",
    fog: [1100, 4200],
    ambient: ["#ffe6c8", "#6b5a40", 1.6],
    sun: ["#ffd7a8", 2.1],
    rim: ["#a8c8ff", 1.1],
  },
  forest: {
    skyTop: "#4f86c0",
    horizon: "#cfe2d2",
    fog: [800, 3400],
    ambient: ["#eaf6dc", "#3e4f2c", 1.5],
    sun: ["#fff0cc", 2.3],
    rim: ["#d6ecff", 0.8],
  },
  factory: {
    skyTop: "#434958",
    horizon: "#cdb79c",
    fog: [1000, 3800],
    ambient: ["#dfe3ea", "#4c4740", 1.55],
    sun: ["#ffe6c4", 1.9],
    rim: ["#b8d0ff", 1.0],
  },
};
/** Shots fly level at chest height. */
export const CLASH_SHOT_HEIGHT = 38;
/** Third-person camera: how far behind and above the soldier, and how far right of them. */
const CAM_BACK = 150;
const CAM_UP = 80;
const CAM_SHOULDER = 26;
/** Aiming down the sights narrows the view and brings the camera this much closer. */
const CAM_FOV = 62;
const AIM_FOV = 40;
const AIM_CLOSER = 45;
const AIM_SHOULDER = 20;
/** Cover at least this tall gets between the camera and the soldier. */
const CAM_BLOCK_HEIGHT = 70;

// ---------------------------------------------------------------------------------------------
// Geometry helpers

/**
 * How a surface looks: a colour plus how rough, how metallic, how brightly it glows and how much
 * camouflage is printed on it. Only the soldier materials read the last four; see `vertexFinish`.
 */
interface Finish {
  c: string;
  r: number;
  m: number;
  g?: number;
  /** Printed with camouflage, 0 to 1. */
  k?: number;
}

type Part = [
  geo: THREE.BufferGeometry,
  color: string | Finish,
  pos: [number, number, number],
  rot?: [number, number, number],
  scale?: [number, number, number],
];

/** Many coloured primitives baked into one geometry, so a model is one draw call. */
function bake(parts: Part[], keepUv = false) {
  // With any finish in the mix, every part carries one (merging needs matching attributes).
  const finished = parts.some(([, color]) => typeof color !== "string");
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
    if (!keepUv) g.deleteAttribute("uv");
    const fin = typeof color === "string" ? { c: color, r: 0.8, m: 0.05 } : color;
    const c = new THREE.Color(fin.c);
    const n = g.attributes.position!.count;
    const col = new Float32Array(n * 3);
    const surf = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      col.set([c.r, c.g, c.b], i * 3);
      surf.set([fin.r, fin.m, fin.g ?? 0, fin.k ?? 0], i * 4);
    }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    if (finished) g.setAttribute("surf", new THREE.BufferAttribute(surf, 4));
    return g;
  });
  // Some primitives (like the octahedron) come without an index; merging needs all or none.
  const mixed = geos.some((g) => !g.index);
  const ready = mixed ? geos.map((g) => (g.index ? g.toNonIndexed() : g)) : geos;
  const out = mergeGeometries(ready)!;
  for (const g of new Set([...geos, ...ready])) g.dispose();
  for (const [geo] of parts) geo.dispose();
  return out;
}

const box = (x: number, y: number, z: number) => new THREE.BoxGeometry(x, y, z);
const sphere = (r: number, w = 10, h = 8) => new THREE.SphereGeometry(r, w, h);

/**
 * A box whose textures repeat once every `unit` world units on every face, so one texture fits
 * blocks of any size without stretching.
 */
function tiledBox(w: number, height: number, d: number, unit: number) {
  const g = new THREE.BoxGeometry(w, height, d);
  const uv = g.attributes.uv!;
  // Faces in order: +x, -x, +y, -y, +z, -z; four corners each.
  const size: Array<[number, number]> = [
    [d, height],
    [d, height],
    [w, d],
    [w, d],
    [w, height],
    [w, height],
  ];
  for (let f = 0; f < 6; f++) {
    const [su, sv] = size[f]!;
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, (uv.getX(i) * su) / unit, (uv.getY(i) * sv) / unit);
    }
  }
  return g;
}

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

/** Speckles a texture, so flat colours read as dirt, concrete or canvas. */
function speckle(c: CanvasRenderingContext2D, w: number, h: number, n: number, alpha: number, seed: number) {
  const rnd = mulberry32(seed);
  for (let i = 0; i < n; i++) {
    c.fillStyle = rnd() < 0.5 ? `rgba(0,0,0,${alpha * rnd()})` : `rgba(255,255,255,${alpha * rnd()})`;
    const s = 1 + rnd() * 3;
    c.fillRect(rnd() * w, rnd() * h, s, s);
  }
}

// ---------------------------------------------------------------------------------------------
// Textures

function dirtTexture() {
  return canvasTexture(256, 256, (c) => {
    c.fillStyle = "#9a8462";
    c.fillRect(0, 0, 256, 256);
    const rnd = mulberry32(7);
    for (let i = 0; i < 26; i++) {
      c.fillStyle = rnd() < 0.5 ? "rgba(70,55,35,0.16)" : "rgba(200,180,140,0.14)";
      c.beginPath();
      c.ellipse(rnd() * 256, rnd() * 256, 10 + rnd() * 40, 6 + rnd() * 24, rnd() * 3, 0, Math.PI * 2);
      c.fill();
    }
    speckle(c, 256, 256, 2600, 0.35, 11);
  });
}

function concreteTexture(base: string, joints: number) {
  return canvasTexture(128, 128, (c) => {
    c.fillStyle = base;
    c.fillRect(0, 0, 128, 128);
    speckle(c, 128, 128, 900, 0.18, 3);
    c.strokeStyle = "rgba(0,0,0,0.22)";
    c.lineWidth = 2;
    for (let x = 0; x <= 128; x += 128 / joints) {
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, 128);
      c.stroke();
    }
    // Rain streaks.
    const rnd = mulberry32(5);
    for (let i = 0; i < 10; i++) {
      c.fillStyle = "rgba(40,30,20,0.08)";
      c.fillRect(rnd() * 128, 0, 2 + rnd() * 5, 30 + rnd() * 90);
    }
  });
}

function windowTexture() {
  return canvasTexture(128, 128, (c) => {
    c.fillStyle = "#c2b39a";
    c.fillRect(0, 0, 128, 128);
    speckle(c, 128, 128, 700, 0.2, 9);
    // Two floors of two windows; some are blown out and burn inside.
    const rnd = mulberry32(21);
    for (let fy = 0; fy < 2; fy++)
      for (let fx = 0; fx < 2; fx++) {
        const x = 14 + fx * 64;
        const y = 12 + fy * 64;
        c.fillStyle = "#5d5346";
        c.fillRect(x - 3, y - 3, 42, 46);
        const lit = rnd() < 0.18;
        c.fillStyle = lit ? "#f29a3a" : "#262833";
        c.fillRect(x, y, 36, 40);
        if (!lit) {
          c.fillStyle = "rgba(160,190,220,0.25)";
          c.fillRect(x + 3, y + 3, 10, 34);
        }
      }
    c.fillStyle = "rgba(0,0,0,0.25)";
    c.fillRect(0, 60, 128, 4);
  });
}

function roofTexture() {
  return canvasTexture(64, 64, (c) => {
    c.fillStyle = "#7c7469";
    c.fillRect(0, 0, 64, 64);
    speckle(c, 64, 64, 400, 0.25, 4);
  });
}

function corrugatedTexture() {
  return canvasTexture(64, 64, (c) => {
    c.fillStyle = "#ffffff";
    c.fillRect(0, 0, 64, 64);
    for (let x = 0; x < 64; x += 8) {
      const g = c.createLinearGradient(x, 0, x + 8, 0);
      g.addColorStop(0, "#c8c8c8");
      g.addColorStop(0.5, "#ffffff");
      g.addColorStop(1, "#9a9a9a");
      c.fillStyle = g;
      c.fillRect(x, 0, 8, 64);
    }
    speckle(c, 64, 64, 200, 0.2, 8);
  });
}

function crateTexture() {
  return canvasTexture(64, 64, (c) => {
    c.fillStyle = "#a8794a";
    c.fillRect(0, 0, 64, 64);
    c.strokeStyle = "rgba(60,35,15,0.45)";
    c.lineWidth = 2;
    for (let y = 0; y <= 64; y += 16) {
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(64, y);
      c.stroke();
    }
    c.strokeStyle = "#6e4a26";
    c.lineWidth = 6;
    c.strokeRect(3, 3, 58, 58);
    c.beginPath();
    c.moveTo(4, 4);
    c.lineTo(60, 60);
    c.stroke();
    speckle(c, 64, 64, 200, 0.2, 2);
  });
}

/** Forest floor: grass with patches of moss, needles and bare earth. */
function grassTexture() {
  return canvasTexture(256, 256, (c) => {
    c.fillStyle = "#5c7a3a";
    c.fillRect(0, 0, 256, 256);
    const rnd = mulberry32(13);
    for (let i = 0; i < 40; i++) {
      const pick = rnd();
      c.fillStyle = pick < 0.35 ? "rgba(40,60,25,0.22)" : pick < 0.7 ? "rgba(150,180,90,0.16)" : "rgba(110,80,45,0.18)";
      c.beginPath();
      c.ellipse(rnd() * 256, rnd() * 256, 10 + rnd() * 36, 6 + rnd() * 22, rnd() * 3, 0, Math.PI * 2);
      c.fill();
    }
    // Blades and fallen needles.
    for (let i = 0; i < 1400; i++) {
      c.strokeStyle = rnd() < 0.7 ? `rgba(30,55,20,${0.3 * rnd()})` : `rgba(190,215,120,${0.35 * rnd()})`;
      c.lineWidth = 1;
      const x = rnd() * 256;
      const y = rnd() * 256;
      const a = rnd() * Math.PI * 2;
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + Math.cos(a) * 4, y + Math.sin(a) * 4);
      c.stroke();
    }
    speckle(c, 256, 256, 1200, 0.2, 19);
  });
}

/** Factory floor: concrete slabs with joints, oil stains and wear. */
function floorTexture() {
  return canvasTexture(256, 256, (c) => {
    c.fillStyle = "#8f8d87";
    c.fillRect(0, 0, 256, 256);
    speckle(c, 256, 256, 3000, 0.2, 23);
    const rnd = mulberry32(31);
    for (let i = 0; i < 9; i++) {
      c.fillStyle = `rgba(30,28,25,${0.08 + rnd() * 0.12})`;
      c.beginPath();
      c.ellipse(rnd() * 256, rnd() * 256, 8 + rnd() * 26, 5 + rnd() * 16, rnd() * 3, 0, Math.PI * 2);
      c.fill();
    }
    c.strokeStyle = "rgba(0,0,0,0.25)";
    c.lineWidth = 2;
    for (let x = 0; x <= 256; x += 128) {
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, 256);
      c.moveTo(0, x);
      c.lineTo(256, x);
      c.stroke();
    }
  });
}

/** Stacked logs, for cabin walls and the forest's palisade. */
function logTexture() {
  return canvasTexture(64, 64, (c) => {
    for (let y = 0; y < 64; y += 16) {
      const g = c.createLinearGradient(0, y, 0, y + 16);
      g.addColorStop(0, "#5a3d24");
      g.addColorStop(0.35, "#8a6340");
      g.addColorStop(0.8, "#6e4c2e");
      g.addColorStop(1, "#3a2615");
      c.fillStyle = g;
      c.fillRect(0, y, 64, 16);
    }
    speckle(c, 64, 64, 260, 0.2, 29);
  });
}

/** Rows of shingles, for cabin roofs. */
function shingleTexture() {
  return canvasTexture(64, 64, (c) => {
    c.fillStyle = "#4a3326";
    c.fillRect(0, 0, 64, 64);
    c.strokeStyle = "rgba(0,0,0,0.35)";
    c.lineWidth = 2;
    for (let y = 0; y < 64; y += 10) {
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(64, y);
      c.stroke();
      for (let x = (y / 10) % 2 ? 0 : 8; x < 64; x += 16) {
        c.beginPath();
        c.moveTo(x, y);
        c.lineTo(x, y + 10);
        c.stroke();
      }
    }
    speckle(c, 64, 64, 200, 0.2, 37);
  });
}

/** Yellow and black warning stripes, round the feet of machines. */
function hazardTexture() {
  return canvasTexture(64, 64, (c) => {
    c.fillStyle = "#e3b02a";
    c.fillRect(0, 0, 64, 64);
    c.fillStyle = "#1d1d1f";
    for (let x = -64; x < 64; x += 32) {
      c.beginPath();
      c.moveTo(x, 64);
      c.lineTo(x + 16, 64);
      c.lineTo(x + 80, 0);
      c.lineTo(x + 64, 0);
      c.closePath();
      c.fill();
    }
    speckle(c, 64, 64, 200, 0.25, 41);
  });
}

function blobTexture() {
  return canvasTexture(
    64,
    64,
    (c) => {
      const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, "rgba(0,0,0,0.55)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      c.fillStyle = g;
      c.fillRect(0, 0, 64, 64);
    },
    false,
  );
}

function glowTexture() {
  return canvasTexture(
    64,
    64,
    (c) => {
      const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, "rgba(255,255,230,1)");
      g.addColorStop(0.3, "rgba(255,210,110,0.9)");
      g.addColorStop(1, "rgba(255,140,40,0)");
      c.fillStyle = g;
      c.fillRect(0, 0, 64, 64);
    },
    false,
  );
}

function flagTexture(team: number, color: string) {
  return canvasTexture(
    128,
    80,
    (c) => {
      c.fillStyle = color;
      c.fillRect(0, 0, 128, 80);
      c.fillStyle = "rgba(0,0,0,0.18)";
      c.fillRect(0, 70, 128, 10);
      c.fillStyle = "#ffffff";
      c.strokeStyle = "#0d0b1f";
      c.lineWidth = 4;
      c.beginPath();
      if (CLASH_TEAMS[team]?.shape === "square") c.rect(44, 20, 40, 40);
      else c.arc(64, 40, 21, 0, Math.PI * 2);
      c.fill();
      c.stroke();
    },
    false,
  );
}

// ---------------------------------------------------------------------------------------------
// Models

// Soldier finishes: special-forces kit in camouflage, coyote and ranger green, with black gloves,
// pads and rifle. The team colour is in the kit mesh (painted white here and tinted by the team's
// material): helmet stripe, glowing visor and strobe, armbands, chest patch and pack lights.
const CAMO: Finish = { c: "#9a8866", r: 0.9, m: 0, k: 1 };
const COYOTE: Finish = { c: "#6e5b40", r: 0.85, m: 0 };
const RANGER: Finish = { c: "#4e5240", r: 0.85, m: 0 };
const BLACK: Finish = { c: "#1d1e21", r: 0.8, m: 0 };
const HELMET: Finish = { c: "#9a9a8c", r: 0.55, m: 0.15 };
const ARMOUR: Finish = { c: "#33363b", r: 0.5, m: 0.35 };
const METAL: Finish = { c: "#9da3ab", r: 0.3, m: 0.95 };
const GUN: Finish = { c: "#222428", r: 0.45, m: 0.5 };
const FURNITURE: Finish = { c: "#6f5c43", r: 0.7, m: 0.05 };
const RUBBER: Finish = { c: "#141518", r: 0.9, m: 0 };
const BOOT: Finish = { c: "#5e4b33", r: 0.75, m: 0 };
const PAINT: Finish = { c: "#ffffff", r: 0.5, m: 0.1 };
/** Dark, glossy goggle glass, and the light that glows through it in the team colour. */
const GLASS: Finish = { c: "#2a2d33", r: 0.08, m: 0.4 };
const VISOR: Finish = { c: "#2a2e34", r: 0.12, m: 0.2, g: 1 };

/** A rounded limb from one joint to another. */
function limb(a: [number, number, number], b: [number, number, number], r: number) {
  const from = new THREE.Vector3(...a);
  const dir = new THREE.Vector3(...b).sub(from);
  const g = new THREE.CapsuleGeometry(r, dir.length(), 3, 10);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize()));
  g.translate(from.x + dir.x / 2, from.y + dir.y / 2, from.z + dir.z / 2);
  return g;
}

const lerp3 = (a: number[], b: number[], k: number): [number, number, number] => [
  a[0]! + (b[0]! - a[0]!) * k,
  a[1]! + (b[1]! - a[1]!) * k,
  a[2]! + (b[2]! - a[2]!) * k,
];

/** Where the hips are. Legs hang from here, and a roll spins the soldier about this height. */
const HIP = 29;
const THIGH = 13;
const SHIN = 11;
/** Crouching bends the legs and drops the hips this far. */
const CROUCH_DROP = 11;
/** The upper body leans into the rifle a little, about the hips: a ready stance. */
const LEAN = new THREE.Matrix4()
  .makeTranslation(0, HIP, 0)
  .multiply(new THREE.Matrix4().makeRotationZ(-0.07))
  .multiply(new THREE.Matrix4().makeTranslation(0, -HIP, 0));
/** The rifle's muzzle, where the flash goes. */
const MUZZLE = new THREE.Vector3(41.5, 44.3, 4).applyMatrix4(LEAN);

/**
 * A special-forces operator facing +x, about 66 units tall, holding a rifle at the ready on their
 * right (+z). The team-coloured markings and glowing goggles are a separate mesh (the kit), and
 * the legs are jointed so they can walk and tuck.
 */
function soldierModel(n: number, team: number) {
  const square = CLASH_TEAMS[team]?.shape === "square";
  const shoulderR: [number, number, number] = [0, 49, 9.5];
  const shoulderL: [number, number, number] = [0, 49, -9.5];
  const elbowR: [number, number, number] = [3, 40, 12];
  const elbowL: [number, number, number] = [11, 41, -6];
  const gripR: [number, number, number] = [10, 40.5, 4.5];
  const gripL: [number, number, number] = [21, 43, 4];
  const across: [number, number, number] = [0, 0, Math.PI / 2];
  const sideways: [number, number, number] = [Math.PI / 2, 0, 0];
  const parts: Part[] = [
    // Head in a black balaclava, a neck gaiter, and a respirator over the mouth.
    [sphere(5.6, 16, 12), BLACK, [0.8, 59, 0], undefined, [1, 1.1, 0.92]],
    [new THREE.CylinderGeometry(3.3, 3.8, 5, 12), BLACK, [0.5, 53.5, 0]],
    [sphere(3.3, 12, 8), ARMOUR, [5.4, 55.2, 0], undefined, [0.8, 0.85, 1.15]],
    [new THREE.CylinderGeometry(1.1, 1.1, 1.8, 10), METAL, [6.1, 54.6, 2.2], [0, 0.45, Math.PI / 2]],
    [new THREE.CylinderGeometry(1.1, 1.1, 1.8, 10), METAL, [6.1, 54.6, -2.2], [0, -0.45, Math.PI / 2]],
    // Headset cups, and the night-vision mount on the front of the helmet.
    [new THREE.CylinderGeometry(2.6, 2.6, 2, 16), BLACK, [0.6, 58.2, 7.4], sideways],
    [new THREE.CylinderGeometry(2.6, 2.6, 2, 16), BLACK, [0.6, 58.2, -7.4], sideways],
    [box(2, 2.6, 3.4), BLACK, [7.6, 63.4, 0], [0, 0, -0.35]],
    [box(1.4, 1.4, 1.4), METAL, [8.4, 62, 0]],
    // Torso in a camouflage combat shirt.
    [new THREE.CylinderGeometry(9.2, 7.4, 19, 16), CAMO, [0, 43, 0], undefined, [0.62, 1, 1]],
    // Plate carrier: front and back plates, cummerbund and shoulder straps.
    [box(3.6, 12, 12.4), COYOTE, [6.3, 44.6, 0]],
    [box(3.6, 13, 12.4), COYOTE, [-6.3, 45, 0]],
    [box(10, 7, 1.6), COYOTE, [0, 40.6, 8.4]],
    [box(10, 7, 1.6), COYOTE, [0, 40.6, -8.4]],
    [box(12.6, 1.6, 3.2), COYOTE, [0, 51.4, 5.2]],
    [box(12.6, 1.6, 3.2), COYOTE, [0, 51.4, -5.2]],
    // Webbing rows, a triple magazine pouch with the mags showing, and an admin pouch.
    [box(0.6, 0.7, 11.6), RANGER, [8.2, 48.6, 0]],
    [box(0.6, 0.7, 11.6), RANGER, [8.2, 46.8, 0]],
    [box(2.8, 5, 3.4), RANGER, [9.4, 40.6, -3.8]],
    [box(2.8, 5, 3.4), RANGER, [9.4, 40.6, 0]],
    [box(2.8, 5, 3.4), RANGER, [9.4, 40.6, 3.8]],
    [box(1.8, 1.6, 2.6), GUN, [9.4, 43.6, -3.8]],
    [box(1.8, 1.6, 2.6), GUN, [9.4, 43.6, 0]],
    [box(1.8, 1.6, 2.6), GUN, [9.4, 43.6, 3.8]],
    [box(1.6, 3.6, 6.4), RANGER, [8.8, 46.6, 0]],
    // Assault pack, and a radio with its antenna.
    [box(4.8, 11, 9.8), RANGER, [-10.2, 44, 0]],
    [box(1.4, 6, 7.6), COYOTE, [-12.8, 43, 0]],
    [box(3.2, 5, 3), BLACK, [-9.6, 51.2, -3.4]],
    [new THREE.CylinderGeometry(0.3, 0.45, 13, 6), BLACK, [-10.4, 59.6, -3.6], [0.12, 0, 0.12]],
    // Shoulders and arms in the combat shirt, with elbow pads and black gloves.
    [sphere(4.1, 12, 8), CAMO, shoulderR],
    [sphere(4.1, 12, 8), CAMO, shoulderL],
    [limb(shoulderR, elbowR, 3.1), CAMO, [0, 0, 0]],
    [limb(elbowR, gripR, 2.7), CAMO, [0, 0, 0]],
    [limb(shoulderL, elbowL, 3.1), CAMO, [0, 0, 0]],
    [limb(elbowL, gripL, 2.7), CAMO, [0, 0, 0]],
    [sphere(3.1, 12, 8), BLACK, elbowR, undefined, [1, 1, 0.9]],
    [sphere(3.1, 12, 8), BLACK, elbowL, undefined, [1, 1, 0.9]],
    [limb(lerp3(elbowR, gripR, 0.8), lerp3(elbowR, gripR, 0.92), 2.9), BLACK, [0, 0, 0]],
    [limb(lerp3(elbowL, gripL, 0.8), lerp3(elbowL, gripL, 0.92), 2.9), BLACK, [0, 0, 0]],
    [sphere(2.6, 12, 8), BLACK, gripR, undefined, [1.2, 0.95, 1.05]],
    [sphere(2.6, 12, 8), BLACK, gripL, undefined, [1.2, 0.95, 1.05]],
    [box(1.6, 1.2, 2.8), ARMOUR, [gripR[0] + 0.4, gripR[1] + 2, gripR[2]]],
    [box(1.6, 1.2, 2.8), ARMOUR, [gripL[0] + 0.4, gripL[1] + 2, gripL[2]]],
    // Hips in camouflage trousers, and the battle belt with its buckle, pouches and holster.
    [box(9, 8, 15), CAMO, [0, HIP + 2, 0]],
    [box(10.6, 2.8, 16.4), RANGER, [0, HIP + 6, 0]],
    [box(1.2, 2.2, 3.6), METAL, [5.5, HIP + 6, 0]],
    [box(3.4, 4, 3.4), COYOTE, [2.6, HIP + 4.4, -8.6]],
    [box(3.4, 4, 3.4), RANGER, [-3, HIP + 4.4, 8.4]],
    [box(3.4, 4, 3.4), COYOTE, [-3, HIP + 4.4, -8.4]],
    [box(4.6, 3.6, 3), RANGER, [-5.6, HIP + 4.6, 0]],
    [box(4, 7, 2.2), BLACK, [1.6, HIP + 1.6, 9.2], [0, 0, 0.12]],
    // The rifle: black, with coyote furniture, an optic, a light and a suppressor.
    [box(1.6, 5.8, 3), RUBBER, [-3.3, 42.3, 4]],
    [box(8, 3.6, 2.6), FURNITURE, [1, 42.6, 4], [0, 0, 0.04]],
    [box(16, 4.8, 3.4), GUN, [14, 43.5, 4]],
    [box(16, 1.2, 2.2), GUN, [16, 46.5, 4]],
    [box(3.4, 7.5, 2.8), FURNITURE, [16.6, 38.2, 4], [0, 0, 0.22]],
    [box(2.8, 5.4, 2.4), FURNITURE, [9, 39.4, 4], [0, 0, -0.3]],
    [box(11, 4, 3.8), GUN, [26.8, 43.9, 4]],
    [box(3, 2.2, 1.6), METAL, [14.5, 47.6, 4]],
    [new THREE.CylinderGeometry(1.6, 1.6, 7.5, 14), GUN, [14, 49.4, 4], across],
    [new THREE.CylinderGeometry(2, 1.6, 1.4, 14), GUN, [18.2, 49.4, 4], across],
    [new THREE.CylinderGeometry(1, 1, 4, 10), METAL, [34, 44.3, 4], across],
    [new THREE.CylinderGeometry(1.7, 1.7, 7, 14), GUN, [38.4, 44.3, 4], across],
    [new THREE.CylinderGeometry(1.1, 1.1, 4, 10), BLACK, [28, 43.6, 6.6], across],
    [box(2.6, 4.2, 2.4), FURNITURE, [27, 40.4, 4]],
  ];
  // A little something per operator: a dump pouch, a light on the shoulder strap, or a knife.
  if (n % 3 === 0) parts.push([box(3.6, 4.6, 3.6), RANGER, [2.6, HIP + 3.6, 9.6]]);
  else if (n % 3 === 1) parts.push([new THREE.CylinderGeometry(1.2, 1, 2.6, 12), BLACK, [5, 51.4, -5.2], across]);
  else parts.push([box(1.2, 5.6, 1.8), BLACK, [7.6, 47, 5.4], [0, 0, 0.5]]);

  const kit: Part[] = square
    ? [
        // An angular maritime helmet with flat goggles.
        [new THREE.CylinderGeometry(7.2, 8.8, 6.6, 4), HELMET, [0.4, 62.4, 0], [0, Math.PI / 4, 0], [1.08, 1, 1]],
        [box(1.4, 3, 9.4), GLASS, [7.9, 57.8, 0]],
        [box(1.5, 1.1, 8.6), VISOR, [7.95, 57.9, 0]],
        [box(1.4, 3, 4), GLASS, [6.5, 57.8, 5.8], [0, -0.75, 0]],
        [box(1.4, 3, 4), GLASS, [6.5, 57.8, -5.8], [0, 0.75, 0]],
        [box(9, 0.8, 1.8), PAINT, [0.3, 65.8, 0]],
      ]
    : [
        // A rounded high-cut helmet with side rails, over wraparound goggles.
        [
          new THREE.SphereGeometry(7.6, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.52),
          HELMET,
          [0.4, 59.8, 0],
          undefined,
          [1.08, 0.95, 1.02],
        ],
        [new THREE.CylinderGeometry(8, 7.6, 3.4, 24, 1, false, Math.PI / 2 - 1.2, 2.4), GLASS, [0.9, 57.4, 0]],
        [new THREE.CylinderGeometry(8.1, 8, 1.1, 24, 1, false, Math.PI / 2 - 1, 2), VISOR, [0.9, 57.6, 0]],
        [box(9.6, 0.8, 1.8), PAINT, [0.2, 66.6, 0]],
      ];
  kit.push(
    // Helmet rails and a strobe glowing in the team colour.
    [box(7.4, 1.2, 1), ARMOUR, [0.2, 60.4, 7.9]],
    [box(7.4, 1.2, 1), ARMOUR, [0.2, 60.4, -7.9]],
    [box(2, 1.2, 2), VISOR, [-3.6, 66.6, 0]],
    // Team armbands, a patch on the chest, and lights on the pack and the rifle.
    [limb(lerp3(shoulderR, elbowR, 0.3), lerp3(shoulderR, elbowR, 0.55), 3.35), PAINT, [0, 0, 0]],
    [limb(lerp3(shoulderL, elbowL, 0.3), lerp3(shoulderL, elbowL, 0.55), 3.35), PAINT, [0, 0, 0]],
    [box(0.4, 2.2, 4.2), PAINT, [9.7, 46.6, 0]],
    [box(0.6, 7.5, 1), VISOR, [-12.8, 44, 3.6]],
    [box(0.6, 7.5, 1), VISOR, [-12.8, 44, -3.6]],
    [box(8, 0.6, 0.4), VISOR, [26.8, 44.8, 5.95]],
    [box(8, 0.6, 0.4), VISOR, [26.8, 44.8, 2.05]],
    [new THREE.CylinderGeometry(1.25, 1.25, 0.4, 14), VISOR, [19, 49.4, 4], across],
  );

  const body = bake(parts).applyMatrix4(LEAN);
  const kitGeo = bake(kit).applyMatrix4(LEAN);
  const thigh = bake([
    [limb([0, 0, 0], [0, -THIGH, 0], 4.3), CAMO, [0, 0, 0]],
    // A thigh pocket and a strap.
    [box(2, 5.4, 4.6), CAMO, [0.6, -6.4, 3.4], [0, 0.6, 0]],
    [new THREE.CylinderGeometry(4.5, 4.5, 1.2, 14), BLACK, [0, -3, 0]],
  ]);
  const shin = bake([
    [limb([0, 0, 0], [0, -SHIN + 1, 0], 3.7), CAMO, [0, 0, 0]],
    // Knee pad.
    [sphere(3.6, 14, 8), BLACK, [2.5, -0.4, 0], undefined, [0.8, 1.1, 1.05]],
    [box(1, 4.6, 3.2), ARMOUR, [3.5, -0.4, 0]],
    // Coyote assault boots: cuff, upper, toe cap and a thick black sole.
    [new THREE.CylinderGeometry(4.1, 4.3, 4, 14), BOOT, [0.2, -SHIN + 0.2, 0]],
    [box(9.6, 4.4, 6.8), BOOT, [1.8, -SHIN - 1.4, 0]],
    [box(3, 3, 6.4), BLACK, [5.6, -SHIN - 1.9, 0]],
    [box(11.2, 1.6, 7.4), RUBBER, [1.9, -SHIN - 4.2, 0]],
  ]);
  return { body, kit: kitGeo, thigh, shin };
}

function droneModel() {
  return bake([
    [new THREE.OctahedronGeometry(12), "#e04dff", [0, 0, 0]],
    [new THREE.TorusGeometry(17, 2, 6, 20), "#2a1e3a", [0, 0, 0], [Math.PI / 2, 0, 0]],
    [sphere(4.5), "#ffffff", [10, 1, 0]],
    [box(34, 2, 2), "#2a1e3a", [0, 0, 0]],
    [box(2, 2, 34), "#2a1e3a", [0, 0, 0]],
  ]);
}

function titanModel() {
  return bake([
    [new THREE.CylinderGeometry(34, 40, 52, 6), "#ff3d6e", [0, 62, 0]],
    [box(30, 22, 40), "#b02148", [0, 98, 0]],
    [box(14, 36, 14), "#3a2030", [0, 18, 22]],
    [box(14, 36, 14), "#3a2030", [0, 18, -22]],
    [box(46, 12, 14), "#3a2030", [6, 78, 40]],
    [box(46, 12, 14), "#3a2030", [6, 78, -40]],
    [box(16, 8, 30), "#1b1c20", [14, 102, 0]],
  ]);
}

// Scenery props. Each is built along its own x axis (the long side of its block), centred on the
// origin with its foot at height 0; `place` turns and moves it onto the block.

/** A triangular prism: a triangle `span` wide and `rise` tall, `length` long along z. */
function prism(span: number, rise: number, length: number) {
  const shape = new THREE.Shape();
  shape.moveTo(-span / 2, 0);
  shape.lineTo(span / 2, 0);
  shape.lineTo(0, rise);
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, { depth: length, bevelEnabled: false }).translate(0, 0, -length / 2);
}

/** Moves parts built along x onto a cover block, turning them when the block is long in y. */
function place(c: Cover, parts: Part[]): Part[] {
  const turned = c.h > c.w;
  const cx = c.x + c.w / 2;
  const cz = c.y + c.h / 2;
  return parts.map(([geo, color, [x, y, z], rot, scale]) => {
    if (turned) geo.rotateY(Math.PI / 2);
    return [geo, color, turned ? [cx + z, y, cz - x] : [cx + x, y, cz + z], rot, scale];
  });
}

/** Rotation and scale of parts must be applied before turning, so `place` takes them baked in. */
function part(
  geo: THREE.BufferGeometry,
  color: string,
  pos: [number, number, number],
  rot?: [number, number, number],
  scale?: [number, number, number],
): Part {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...(rot ?? [0, 0, 0]))),
    new THREE.Vector3(...(scale ?? [1, 1, 1])),
  );
  return [geo.applyMatrix4(m), color, pos];
}

const PINE_GREENS = ["#2d5a33", "#356b3b", "#294f2d", "#3d6e37"];

/** A pine, about `size` times the usual: trunk, then three tiers of needles. */
function pine(x: number, z: number, size: number, rnd: () => number, trunk = 20): Part[] {
  const green = PINE_GREENS[Math.floor(rnd() * PINE_GREENS.length)]!;
  const dark = PINE_GREENS[Math.floor(rnd() * PINE_GREENS.length)]!;
  const spin = rnd() * Math.PI;
  const s = size;
  return [
    [new THREE.CylinderGeometry(trunk * 0.55, trunk * 0.75, 140 * s, 8), "#5a3f2b", [x, 70 * s, z]],
    [new THREE.ConeGeometry(64 * s, 110 * s, 9), dark, [x, (95 + 55) * s, z], [0, spin, 0]],
    [new THREE.ConeGeometry(50 * s, 95 * s, 9), green, [x, (150 + 47) * s, z], [0, spin + 0.3, 0]],
    [new THREE.ConeGeometry(34 * s, 80 * s, 9), green, [x, (205 + 40) * s, z], [0, spin + 0.6, 0]],
  ];
}

/** A boulder that fills its block, with a smaller stone or two at its feet. */
function boulder(c: Cover, rnd: () => number): Part[] {
  const greys = ["#8b8d86", "#7a7c75", "#9a9a92", "#6f7468"];
  const grey = () => greys[Math.floor(rnd() * greys.length)]!;
  const cx = c.x + c.w / 2;
  const cz = c.y + c.h / 2;
  const parts: Part[] = [
    [
      new THREE.IcosahedronGeometry(1, 0),
      grey(),
      [cx, c.height * 0.42, cz],
      [0, rnd() * 3, 0],
      [c.w * 0.62, c.height * 0.62, c.h * 0.62],
    ],
    [
      new THREE.DodecahedronGeometry(1, 0),
      "#5f7046",
      [cx, c.height * 0.72, cz],
      [rnd(), rnd() * 3, 0],
      [Math.min(c.w, c.h) * 0.35, c.height * 0.25, Math.min(c.w, c.h) * 0.35],
    ],
  ];
  for (let i = 0; i < 2; i++) {
    const r = 8 + rnd() * 8;
    parts.push([
      new THREE.DodecahedronGeometry(r, 0),
      grey(),
      [c.x + (i ? c.w + 4 : -4), r * 0.5, c.y + rnd() * c.h],
      [rnd(), rnd() * 3, 0],
    ]);
  }
  return parts;
}

/** A fallen trunk lying along its block. */
function fallenLog(c: Cover): Part[] {
  const len = Math.max(c.w, c.h);
  const r = Math.min(c.w, c.h) / 2;
  const along = (geo: THREE.BufferGeometry) => geo.rotateZ(Math.PI / 2);
  return place(c, [
    [along(new THREE.CylinderGeometry(r, r * 1.05, len - 6, 10)), "#6b4a2e", [0, r, 0]],
    [along(new THREE.CylinderGeometry(r * 0.85, r * 0.85, 3, 10)), "#c9a374", [len / 2 - 2, r, 0]],
    [along(new THREE.CylinderGeometry(r * 0.85, r * 0.85, 3, 10)), "#c9a374", [-len / 2 + 2, r, 0]],
    part(new THREE.CylinderGeometry(3, 4, 22, 6), "#5a3f2b", [len * 0.2, r * 1.6, 0], [0.6, 0, 0.4]),
    part(new THREE.CylinderGeometry(9, 9, 10, 8), "#4f6d3a", [-len * 0.25, r * 1.8, 0], [0, 0, 0], [1, 0.5, 1]),
  ]);
}

/** The roof, chimney, door and lit windows of a log cabin (its walls are textured separately). */
function cabinTrim(c: Cover, wallH: number): Part[] {
  const len = Math.max(c.w, c.h);
  const dep = Math.min(c.w, c.h);
  const rise = c.height - wallH;
  const parts: Part[] = [
    [prism(dep + 24, rise, len + 20).rotateY(Math.PI / 2), "#5b3b27", [0, wallH, 0]],
    [box(24, rise + 40, 24), "#8a8780", [len * 0.28, wallH + rise / 2 + 10, dep * 0.12]],
    [box(28, 6, 28), "#5f5c56", [len * 0.28, wallH + rise + 30, dep * 0.12]],
  ];
  for (const side of [1, -1]) {
    parts.push([box(36, 50, 4), "#3d2817", [0, 25, side * (dep / 2 + 1)]]);
    for (const at of [-0.3, 0.3])
      parts.push([box(28, 22, 3), "#f6cf7a", [len * at, wallH * 0.6, side * (dep / 2 + 1)]]);
  }
  return place(c, parts);
}

/** A factory hall's sawtooth roof with its north lights, big doors and a vent stack. */
function hallTrim(c: Cover, wallH: number): Part[] {
  const len = Math.max(c.w, c.h);
  const dep = Math.min(c.w, c.h);
  const teeth = Math.max(2, Math.round(len / 60));
  const tooth = len / teeth;
  const rise = c.height - wallH;
  const parts: Part[] = [];
  for (let i = 0; i < teeth; i++) {
    const x0 = -len / 2 + i * tooth;
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(tooth, 0);
    shape.lineTo(0, rise);
    shape.closePath();
    parts.push([
      new THREE.ExtrudeGeometry(shape, { depth: dep, bevelEnabled: false }).translate(0, 0, -dep / 2),
      "#6d737a",
      [x0, wallH, 0],
    ]);
    parts.push([box(2, rise * 0.8, dep - 8), "#9cc4dc", [x0 - 0.5, wallH + rise * 0.42, 0]]);
  }
  for (const side of [1, -1]) {
    parts.push([box(len * 0.34, wallH * 0.7, 4), "#59616b", [0, wallH * 0.35, side * (dep / 2 + 1)]]);
    parts.push([box(len * 0.34 + 10, 6, 5), "#e0b13a", [0, wallH * 0.7 + 3, side * (dep / 2 + 1)]]);
    parts.push([box(5, wallH * 0.7, 5), "#e0b13a", [-len * 0.17 - 5, wallH * 0.35, side * (dep / 2 + 1)]]);
    parts.push([box(5, wallH * 0.7, 5), "#e0b13a", [len * 0.17 + 5, wallH * 0.35, side * (dep / 2 + 1)]]);
  }
  parts.push([new THREE.CylinderGeometry(8, 8, rise + 60, 10), "#8d949c", [len * 0.35, wallH + (rise + 60) / 2, 0]]);
  return place(c, parts);
}

/** A silo standing on its block's plinth, with bands and a ladder. */
function silo(c: Cover): Part[] {
  const cx = c.x + c.w / 2;
  const cz = c.y + c.h / 2;
  const r = Math.min(c.w, c.h) * 0.47;
  const body = c.height - 14 - r * 0.5;
  const parts: Part[] = [
    [new THREE.CylinderGeometry(r, r, body, 20), "#c9ced5", [cx, 14 + body / 2, cz]],
    [
      new THREE.SphereGeometry(r, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      "#b5bbc3",
      [cx, 14 + body, cz],
      [0, 0, 0],
      [1, 0.5, 1],
    ],
  ];
  for (const k of [0.25, 0.6, 0.92])
    parts.push([new THREE.CylinderGeometry(r + 1.5, r + 1.5, 5, 20), "#8b939c", [cx, 14 + body * k, cz]]);
  for (const dz of [-6, 6]) parts.push([box(2, body, 2), "#3c4248", [cx - r - 3, 14 + body / 2, cz + dz]]);
  for (let y = 24; y < body; y += 14) parts.push([box(2, 2, 14), "#3c4248", [cx - r - 3, 14 + y, cz]]);
  return parts;
}

/** A machine on a striped base: a press with a yellow head, a motor and a lit control panel. */
function machine(c: Cover, base: number): Part[] {
  const len = Math.max(c.w, c.h);
  const dep = Math.min(c.w, c.h);
  const h = c.height - base;
  return place(c, [
    [box(len * 0.82, h * 0.55, dep * 0.75), "#58626d", [0, base + h * 0.275, 0]],
    [box(len * 0.5, h * 0.35, dep * 0.6), "#e2a92a", [-len * 0.1, base + h * 0.55 + h * 0.175, 0]],
    [box(len * 0.12, h * 0.25, dep * 0.4), "#3a3f45", [-len * 0.1, base + h * 0.9, 0]],
    [
      new THREE.CylinderGeometry(dep * 0.2, dep * 0.2, len * 0.3, 12).rotateZ(Math.PI / 2),
      "#3f6f9a",
      [len * 0.28, base + h * 0.7, 0],
    ],
    [box(4, 22, 18), "#2b2f34", [len * 0.41 + 2, base + h * 0.35, 0]],
    [box(2, 4, 4), "#ff4d3a", [len * 0.41 + 5, base + h * 0.42, -4]],
    [box(2, 4, 4), "#4dff8a", [len * 0.41 + 5, base + h * 0.42, 4]],
  ]);
}

/** A pipeline along its block on stands, with flanges and a smaller pipe beside it. */
function pipeline(c: Cover): Part[] {
  const len = Math.max(c.w, c.h);
  const dep = Math.min(c.w, c.h);
  const r = dep * 0.38;
  const y = c.height - r - 2;
  const along = (geo: THREE.BufferGeometry) => geo.rotateZ(Math.PI / 2);
  const parts: Part[] = [
    [along(new THREE.CylinderGeometry(r, r, len, 12)), "#b0603a", [0, y, -dep * 0.08]],
    [along(new THREE.CylinderGeometry(4, 4, len, 8)), "#8a929b", [0, 12, dep * 0.3]],
  ];
  const stands = Math.max(2, Math.round(len / 55));
  for (let i = 0; i < stands; i++) {
    const x = -len / 2 + (len / stands) * (i + 0.5);
    parts.push([box(6, y, dep - 4), "#474d54", [x, y / 2, 0]]);
    parts.push([
      along(new THREE.CylinderGeometry(r + 3, r + 3, 4, 12)),
      "#7e4a30",
      [x + len / stands / 2 - 2, y, -dep * 0.08],
    ]);
  }
  return place(c, parts);
}

const PICKUP_COLOR: Record<ClashPickupKind, string> = { medkit: "#3fd08b", overdrive: "#ff7a2e", haste: "#5ad8ff" };

/** A first-aid case: white, with a red cross on every side. */
function medkitModel() {
  return bake([
    [box(26, 18, 20), "#f4f1ea", [0, 0, 0]],
    [box(4, 10, 3), "#e0352b", [0, 0, 10.5]],
    [box(10, 4, 3), "#e0352b", [0, 0, 10.5]],
    [box(4, 10, 3), "#e0352b", [0, 0, -10.5]],
    [box(10, 4, 3), "#e0352b", [0, 0, -10.5]],
    [box(10, 3, 3), "#3a3a3a", [0, 10, 0]],
  ]);
}

/** A burning crystal. */
function overdriveModel() {
  return bake([
    [new THREE.OctahedronGeometry(15), "#ff7a2e", [0, 0, 0], [0, 0, 0], [1, 1.5, 1]],
    [new THREE.TorusGeometry(19, 1.6, 6, 24), "#ffd36b", [0, 0, 0], [Math.PI / 2, 0, 0]],
  ]);
}

/** Two chevrons pointing the way you'll run. */
function hasteModel() {
  const parts: Part[] = [];
  for (const x of [-7, 7])
    for (const side of [1, -1]) parts.push([box(16, 5, 5), "#5ad8ff", [x, 0, side * 5], [0, side * 0.75, 0]]);
  return bake(parts);
}

/**
 * Lets a standard material take its roughness, metalness and glow from each vertex (the `surf`
 * attribute `bake` writes for finishes), so a whole soldier, cloth and steel alike, is one draw.
 */
function vertexFinish<M extends THREE.MeshStandardMaterial>(mat: M) {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader =
      "attribute vec4 surf;\nvarying vec4 vSurf;\nvarying vec3 vLocal;\n" +
      shader.vertexShader.replace(
        "#include <color_vertex>",
        "#include <color_vertex>\nvSurf = surf;\nvLocal = position;",
      );
    shader.fragmentShader =
      `varying vec4 vSurf;
varying vec3 vLocal;
float hash3(vec3 p) {
  p = fract(p * 0.3183099 + 0.1) * 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
` +
      shader.fragmentShader
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
// Fine grain on every surface, so nothing reads as flat plastic.
float grain = noise3(vLocal * 2.3);
diffuseColor.rgb *= 0.9 + 0.2 * grain;
// Multi-tone camouflage, in the soldier's own space so it moves with them.
if (vSurf.w > 0.0) {
  vec3 q = vLocal + vec3(0.0, 40.0, 0.0);
  float a = noise3(q * 0.16 + 3.1) * 0.7 + noise3(q * 0.42) * 0.3;
  float b = noise3(q * 0.22 + 17.0) * 0.7 + noise3(q * 0.55 + 9.0) * 0.3;
  vec3 camo = vec3(0.16, 0.13, 0.085);
  camo = mix(camo, vec3(0.065, 0.05, 0.03), smoothstep(0.52, 0.55, a));
  camo = mix(camo, vec3(0.05, 0.065, 0.032), smoothstep(0.54, 0.57, b));
  camo = mix(camo, vec3(0.27, 0.23, 0.15), smoothstep(0.74, 0.77, 1.0 - a));
  diffuseColor.rgb = mix(diffuseColor.rgb, camo * (0.9 + 0.2 * grain), vSurf.w);
}`,
        )
        .replace("#include <roughnessmap_fragment>", "float roughnessFactor = vSurf.x;")
        .replace("#include <metalnessmap_fragment>", "float metalnessFactor = vSurf.y;")
        .replace(
          "#include <emissivemap_fragment>",
          "#include <emissivemap_fragment>\ntotalEmissiveRadiance += vSurf.z * mix(diffuse, vec3(1.0), 0.15) * 1.35;",
        );
  };
  mat.customProgramCacheKey = () => "vertex-finish";
  return mat;
}

// ---------------------------------------------------------------------------------------------
// The world

export function createClashWorld(canvas: HTMLCanvasElement, scenery: ClashScenery = "warzone"): ClashWorld {
  const sky = LOOKS[scenery] ?? LOOKS.warzone;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  // Only soldiers and bots cast real shadows, from a small patch of sun that follows the camera.
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const phone = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  const scene = new THREE.Scene();
  const disposables: Array<{ dispose(): void }> = [];
  const own = <X extends { dispose(): void }>(x: X) => {
    disposables.push(x);
    return x;
  };
  scene.background = own(
    canvasTexture(
      4,
      256,
      (c) => {
        const g = c.createLinearGradient(0, 0, 0, 256);
        g.addColorStop(0, sky.skyTop);
        g.addColorStop(0.6, sky.horizon);
        g.addColorStop(1, sky.horizon);
        c.fillStyle = g;
        c.fillRect(0, 0, 4, 256);
      },
      false,
    ),
  );
  scene.fog = new THREE.Fog(sky.horizon, ...sky.fog);

  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 4, 20000);
  scene.add(new THREE.HemisphereLight(...sky.ambient));
  const sun = new THREE.DirectionalLight(...sky.sun);
  const SUN_DIR = new THREE.Vector3(-0.7, 0.8, -0.35).normalize();
  sun.position.copy(SUN_DIR);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(phone ? 1024 : 2048);
  sun.shadow.radius = 2.5;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);
  // A cool light from behind the soldiers, against the sunset, to pick out their edges.
  const rimLight = new THREE.DirectionalLight(...sky.rim);
  rimLight.position.set(0.6, 0.45, 0.65);
  scene.add(rimLight);
  // Soldiers' metal and paint reflect a soft studio room.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const studio = own(pmrem.fromScene(room, 0.04).texture);
  room.dispose();
  pmrem.dispose();

  const tex = (t: THREE.Texture) => {
    t.anisotropy = maxAniso;
    return own(t);
  };
  const colored = own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.05 }));
  const layer = (n: number) => ({ polygonOffset: true, polygonOffsetFactor: -n, polygonOffsetUnits: -n * 4 });
  const add = (g: THREE.BufferGeometry, m: THREE.Material | THREE.Material[]) => {
    own(g);
    const mesh = new THREE.Mesh(g, m);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    scene.add(mesh);
    return mesh;
  };

  // Ground: the arena, wider land beyond it, and the open plaza in the middle.
  const groundTex = scenery === "forest" ? grassTexture : scenery === "factory" ? floorTexture : dirtTexture;
  const dirt = tex(groundTex());
  dirt.repeat.set(W / 220, H / 220);
  add(
    new THREE.PlaneGeometry(W, H).rotateX(-Math.PI / 2).translate(W / 2, 0, H / 2),
    own(new THREE.MeshStandardMaterial({ map: dirt, roughness: scenery === "factory" ? 0.85 : 1 })),
  );
  const waste = tex(scenery === "factory" ? dirtTexture() : groundTex());
  waste.repeat.set(60, 60);
  add(
    new THREE.PlaneGeometry(16000, 16000).rotateX(-Math.PI / 2).translate(W / 2, -1, H / 2),
    own(
      new THREE.MeshStandardMaterial({
        map: waste,
        color: scenery === "forest" ? "#9fb08e" : scenery === "factory" ? "#7a7672" : "#c9b08a",
        roughness: 1,
      }),
    ),
  );
  const plazaR = R.titan.leash + R.titan.radius;
  const plazaTex = tex(
    concreteTexture(scenery === "forest" ? "#8e8f80" : scenery === "factory" ? "#a3a29c" : "#a39a8a", 4),
  );
  plazaTex.repeat.set(6, 6);
  add(
    new THREE.CircleGeometry(plazaR, 48).rotateX(-Math.PI / 2).translate(CLASH_CENTER.x, 0, CLASH_CENTER.y),
    own(new THREE.MeshStandardMaterial({ map: plazaTex, roughness: 0.95, ...layer(1) })),
  );
  add(
    new THREE.RingGeometry(plazaR - 10, plazaR, 64).rotateX(-Math.PI / 2).translate(CLASH_CENTER.x, 0, CLASH_CENTER.y),
    own(new THREE.MeshBasicMaterial({ color: "#f2c230", ...layer(2) })),
  );

  // Cover.
  const concrete = own(new THREE.MeshStandardMaterial({ map: tex(concreteTexture("#b4aa98", 2)), roughness: 0.95 }));
  const windows = own(new THREE.MeshStandardMaterial({ map: tex(windowTexture()), roughness: 0.9 }));
  const roof = own(new THREE.MeshStandardMaterial({ map: tex(roofTexture()), roughness: 1 }));
  const wood = own(new THREE.MeshStandardMaterial({ map: tex(crateTexture()), roughness: 0.9 }));
  const corrugated = tex(corrugatedTexture());
  const containerColors = ["#b5462f", "#2f6db5", "#3d8a4a"].map((color) =>
    own(new THREE.MeshStandardMaterial({ map: corrugated, color, roughness: 0.6, metalness: 0.3 })),
  );
  const sandbags: Part[] = [];
  const sandRnd = mulberry32(17);
  let containerN = 0;
  // Forest and factory props, baked into one mesh each: matte, and painted metal.
  const props: Part[] = [];
  const metalProps: Part[] = [];
  const propRnd = mulberry32(23);
  const logs =
    scenery === "forest" ? own(new THREE.MeshStandardMaterial({ map: tex(logTexture()), roughness: 0.9 })) : null;
  const sheet =
    scenery === "factory"
      ? own(new THREE.MeshStandardMaterial({ map: corrugated, color: "#b9c4ce", roughness: 0.55, metalness: 0.35 }))
      : null;
  const hazard =
    scenery === "factory" ? own(new THREE.MeshStandardMaterial({ map: tex(hazardTexture()), roughness: 0.8 })) : null;
  const coverMesh = (c: Cover) => {
    const at = (g: THREE.BufferGeometry) => g.translate(c.x + c.w / 2, c.height / 2, c.y + c.h / 2);
    switch (c.kind) {
      case "building": {
        add(at(tiledBox(c.w, c.height, c.h, 64)), [windows, windows, roof, roof, windows, windows]);
        // A parapet around the roof.
        const lip = 6;
        for (const [w, d, dx, dz] of [
          [c.w, lip, 0, -c.h / 2 + lip / 2],
          [c.w, lip, 0, c.h / 2 - lip / 2],
          [lip, c.h, -c.w / 2 + lip / 2, 0],
          [lip, c.h, c.w / 2 - lip / 2, 0],
        ] as const)
          add(tiledBox(w, 10, d, 64).translate(c.x + c.w / 2 + dx, c.height + 5, c.y + c.h / 2 + dz), concrete);
        return;
      }
      case "wall":
        add(at(tiledBox(c.w, c.height, c.h, 64)), concrete);
        return;
      case "container":
        add(at(tiledBox(c.w, c.height, c.h, 40)), containerColors[containerN++ % containerColors.length]!);
        return;
      case "crate":
        add(at(tiledBox(c.w, c.height, c.h, c.w)), wood);
        return;
      case "sandbag": {
        // Rows of bags, three high, laid along the long side.
        const along = c.w >= c.h;
        const len = along ? c.w : c.h;
        const depth = along ? c.h : c.w;
        const rows = Math.max(1, Math.round(depth / 15));
        const bags = Math.max(1, Math.round(len / 28));
        for (let layerN = 0; layerN < 3; layerN++)
          for (let r = 0; r < rows; r++)
            for (let b = 0; b < bags; b++) {
              const u = (b + 0.5 + (layerN % 2 ? 0.5 : 0)) * (len / bags) - len / 2;
              if (Math.abs(u) > len / 2 - 6) continue;
              const v = (r + 0.5) * (depth / rows) - depth / 2;
              const shade = ["#c8b48a", "#bba57a", "#d3c095"][Math.floor(sandRnd() * 3)]!;
              sandbags.push([
                new THREE.CapsuleGeometry(7.5, 14, 3, 8),
                shade,
                [c.x + c.w / 2 + (along ? u : v), 7 + layerN * 12.5, c.y + c.h / 2 + (along ? v : u)],
                along ? [0, 0, Math.PI / 2] : [Math.PI / 2, 0, 0],
                // Squashed flat, whichever way the bag lies.
                along ? [0.8, 1, 1] : [1, 1, 0.8],
              ]);
            }
        return;
      }
      case "tree":
        props.push(...pine(c.x + c.w / 2, c.y + c.h / 2, 0.95 + propRnd() * 0.2, propRnd, c.w / 2));
        return;
      case "rock":
        props.push(...boulder(c, propRnd));
        return;
      case "log":
        props.push(...fallenLog(c));
        return;
      case "cabin": {
        const wallH = Math.round(c.height * 0.6);
        add(tiledBox(c.w, wallH, c.h, 64).translate(c.x + c.w / 2, wallH / 2, c.y + c.h / 2), logs ?? wood);
        props.push(...cabinTrim(c, wallH));
        return;
      }
      case "hall": {
        const wallH = Math.round(c.height * 0.72);
        add(tiledBox(c.w, wallH, c.h, 48).translate(c.x + c.w / 2, wallH / 2, c.y + c.h / 2), sheet ?? concrete);
        metalProps.push(...hallTrim(c, wallH));
        return;
      }
      case "tank":
        add(tiledBox(c.w, 14, c.h, 64).translate(c.x + c.w / 2, 7, c.y + c.h / 2), concrete);
        metalProps.push(...silo(c));
        return;
      case "machine": {
        const base = 12;
        add(tiledBox(c.w, base, c.h, 32).translate(c.x + c.w / 2, base / 2, c.y + c.h / 2), hazard ?? concrete);
        metalProps.push(...machine(c, base));
        return;
      }
      case "pipe":
        metalProps.push(...pipeline(c));
        return;
    }
  };
  const walls = clashWalls(scenery);
  for (const c of walls) coverMesh(c);
  if (sandbags.length) add(bake(sandbags), colored);

  // The perimeter, and the skyline beyond it.
  const rim = 40;
  for (const [x, y, w, h] of [
    [-rim, -rim, W + rim * 2, rim],
    [-rim, H, W + rim * 2, rim],
    [-rim, 0, rim, H],
    [W, 0, rim, H],
  ] as const)
    add(tiledBox(w, 70, h, 64).translate(x + w / 2, 35, y + h / 2), logs ?? concrete);
  const skyRnd = mulberry32(42);
  const skyline: Part[] = [];
  if (scenery === "forest") {
    // A wall of pines all round, and wooded hills further off.
    for (let i = 0; i < 260; i++) {
      const side = i % 4;
      const along = skyRnd();
      const out = 70 + skyRnd() * skyRnd() * 900;
      const x = side < 2 ? -300 + along * (W + 600) : side === 2 ? -out : W + out;
      const z = side >= 2 ? -300 + along * (H + 600) : side === 0 ? -out : H + out;
      skyline.push(...pine(x, z, 1.1 + skyRnd() * 0.9, skyRnd, 26));
    }
    for (let i = 0; i < 26; i++) {
      const ang = (i / 26) * Math.PI * 2;
      const dist = 2200 + skyRnd() * 900;
      const r = 700 + skyRnd() * 600;
      skyline.push([
        sphere(1, 14, 8),
        ["#4b6a41", "#3f5c39", "#56744a"][i % 3]!,
        [W / 2 + Math.cos(ang) * (W / 2 + dist), -r * 0.15, H / 2 + Math.sin(ang) * (H / 2 + dist)],
        [0, 0, 0],
        [r, r * (0.35 + skyRnd() * 0.25), r],
      ]);
    }
  }
  if (scenery === "factory") {
    // Warehouses, tanks and smoking chimneys round the yard.
    for (let i = 0; i < 70; i++) {
      const ang = (i / 70) * Math.PI * 2 + skyRnd() * 0.05;
      const dist = 900 + skyRnd() * 1500;
      const px = W / 2 + Math.cos(ang) * (W / 2 + dist * 0.6);
      const pz = H / 2 + Math.sin(ang) * (H / 2 + dist * 0.6);
      if (i % 5 === 0) {
        const h = 420 + skyRnd() * 380;
        skyline.push([new THREE.CylinderGeometry(22, 34, h, 12), "#8a6f62", [px, h / 2, pz]]);
        skyline.push([new THREE.CylinderGeometry(23, 25, 40, 12), "#c9402e", [px, h - 50, pz]]);
        skyline.push([new THREE.CylinderGeometry(24, 26, 40, 12), "#e8e4dc", [px, h - 10, pz]]);
        for (let k = 0; k < 3; k++)
          skyline.push([sphere(40 + k * 22, 10, 8), "#b9b4ad", [px + k * 50, h + 40 + k * 55, pz + k * 18]]);
      } else if (i % 5 === 1) {
        const r = 60 + skyRnd() * 50;
        skyline.push([new THREE.CylinderGeometry(r, r, r * 1.6, 16), "#b9bec5", [px, r * 0.8, pz]]);
      } else {
        const w = 200 + skyRnd() * 260;
        const h = 90 + skyRnd() * 160;
        skyline.push([
          box(w, h, w * (0.5 + skyRnd() * 0.4)),
          ["#6f7782", "#7d7468", "#5f6670", "#8a8f96"][i % 4]!,
          [px, h / 2, pz],
          [0, ang + Math.PI / 2, 0],
        ]);
      }
    }
  }
  for (let i = 0; i < (scenery === "warzone" ? 90 : 0); i++) {
    const ang = (i / 90) * Math.PI * 2 + skyRnd() * 0.05;
    const dist = 1500 + skyRnd() * 1400;
    const w = 120 + skyRnd() * 220;
    const h = 80 + skyRnd() * (skyRnd() < 0.2 ? 520 : 240);
    const shade = ["#6f6558", "#80776a", "#5d554b", "#8a7d6c"][i % 4]!;
    skyline.push([
      box(w, h, w * (0.6 + skyRnd() * 0.6)),
      shade,
      [W / 2 + Math.cos(ang) * (W / 2 + dist * 0.6), h / 2, H / 2 + Math.sin(ang) * (H / 2 + dist * 0.6)],
      [0, skyRnd() * 3, 0],
    ]);
  }
  add(bake(skyline), colored);
  if (props.length) add(bake(props), colored);
  if (metalProps.length)
    add(
      bake(metalProps),
      own(
        new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: 0.5,
          metalness: 0.45,
          envMap: studio,
          envMapIntensity: 0.5,
        }),
      ),
    );

  // Bases: a painted pad and a flag for each team.
  const bases = clashBases();
  const teamPads: THREE.MeshBasicMaterial[] = [];
  const teamRings: THREE.MeshBasicMaterial[] = [];
  const flags: Array<{ mesh: THREE.Mesh; mat: THREE.MeshStandardMaterial }> = [];
  const pole = bake([[new THREE.CylinderGeometry(3, 3, 180, 8), "#d8d8d8", [0, 90, 0]]]);
  own(pole);
  bases.forEach((b, i) => {
    const pad = own(
      new THREE.MeshBasicMaterial({
        color: "#ffffff",
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
        ...layer(3),
      }),
    );
    teamPads.push(pad);
    add(new THREE.CircleGeometry(R.baseRadius, 40).rotateX(-Math.PI / 2).translate(b.x, 0, b.y), pad);
    const ring = own(new THREE.MeshBasicMaterial({ color: "#ffffff", ...layer(4) }));
    teamRings.push(ring);
    add(new THREE.RingGeometry(R.baseRadius - 7, R.baseRadius, 48).rotateX(-Math.PI / 2).translate(b.x, 0, b.y), ring);
    // Flags fly from the perimeter wall behind each base.
    const px = i === 0 ? -20 : W + 20;
    const p = new THREE.Mesh(pole, colored);
    p.position.set(px, 0, b.y);
    scene.add(p);
    const mat = own(new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.9 }));
    const mesh = new THREE.Mesh(own(new THREE.PlaneGeometry(72, 45, 8, 1).translate(36, 0, 0)), mat);
    mesh.position.set(px, 155, b.y);
    scene.add(mesh);
    flags.push({ mesh, mat });
  });

  // Shared pieces for the moving things.
  const blob = own(new THREE.MeshBasicMaterial({ map: tex(blobTexture()), transparent: true, depthWrite: false }));
  const blobGeo = own(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
  const glow = own(
    new THREE.SpriteMaterial({ map: tex(glowTexture()), blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  const flash = own(new THREE.MeshBasicMaterial({ color: "#ffffff" }));
  const shieldMat = own(
    new THREE.MeshBasicMaterial({ color: "#78e6ff", transparent: true, opacity: 0.22, depthWrite: false }),
  );
  const shieldGeo = own(new THREE.SphereGeometry(34, 18, 12));
  const teamMats = [0, 1].map(() =>
    own(vertexFinish(new THREE.MeshStandardMaterial({ vertexColors: true, envMap: studio, envMapIntensity: 0.7 }))),
  );
  const gearHurt = own(
    new THREE.MeshStandardMaterial({ color: "#ffffff", emissive: "#ffffff", emissiveIntensity: 0.6 }),
  );
  const gear = own(
    vertexFinish(new THREE.MeshStandardMaterial({ vertexColors: true, envMap: studio, envMapIntensity: 0.6 })),
  );
  let colorKey = "";
  const setTeamColors = (colors: string[]) => {
    const key = colors.join(",");
    if (key === colorKey) return;
    colorKey = key;
    colors.forEach((color, i) => {
      teamMats[i]?.color.set(color);
      teamPads[i]?.color.set(color);
      teamRings[i]?.color.set(color);
      const f = flags[i];
      if (f) {
        f.mat.map?.dispose();
        f.mat.map = flagTexture(i, color);
        f.mat.needsUpdate = true;
      }
    });
  };

  // Soldiers.
  interface Soldier {
    team: number;
    root: THREE.Group;
    /** Spins about the hips for a roll. */
    roll: THREE.Group;
    body: THREE.Group;
    kit: THREE.Mesh;
    /** Everything but the kit, which all flashes when hit. */
    gear: THREE.Mesh[];
    thighs: THREE.Group[];
    knees: THREE.Group[];
    muzzle: THREE.Sprite;
    shield: THREE.Mesh;
    aura: THREE.Mesh;
    geos: THREE.BufferGeometry[];
    last: { x: number; y: number };
    vel: { x: number; y: number };
    speed: number;
    phase: number;
    /** When the current roll started, and which way it goes. */
    rollAt: number;
    rollDir: { x: number; y: number };
    /** How far into a crouch, 0 to 1. */
    low: number;
  }
  const soldiers = new Map<number, Soldier>();
  const makeSoldier = (n: number, team: number): Soldier => {
    const m = soldierModel(n, team);
    const root = new THREE.Group();
    const roll = new THREE.Group();
    roll.position.y = HIP;
    root.add(roll);
    const body = new THREE.Group();
    body.position.y = -HIP;
    roll.add(body);
    const torso = new THREE.Mesh(m.body, gear);
    body.add(torso);
    const kit = new THREE.Mesh(m.kit, teamMats[team] ?? teamMats[0]!);
    body.add(kit);
    // Soldiers shade themselves too: the helmet over the face, an arm across the chest.
    const shade = (mesh: THREE.Mesh) => {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      return mesh;
    };
    shade(torso);
    shade(kit);
    const gearMeshes: THREE.Mesh[] = [torso];
    const thighs: THREE.Group[] = [];
    const knees: THREE.Group[] = [];
    for (const z of [-4.6, 4.6]) {
      const hip = new THREE.Group();
      hip.position.set(0, HIP, z);
      // Feet set a little apart.
      hip.rotation.x = z > 0 ? -0.05 : 0.05;
      const thigh = shade(new THREE.Mesh(m.thigh, gear));
      hip.add(thigh);
      const knee = new THREE.Group();
      knee.position.y = -THIGH;
      const shin = shade(new THREE.Mesh(m.shin, gear));
      knee.add(shin);
      gearMeshes.push(thigh, shin);
      hip.add(knee);
      body.add(hip);
      thighs.push(hip);
      knees.push(knee);
    }
    const muzzle = new THREE.Sprite(glow);
    muzzle.position.copy(MUZZLE);
    muzzle.scale.setScalar(24);
    body.add(muzzle);
    const shadow = new THREE.Mesh(blobGeo, blob);
    shadow.scale.set(40, 1, 40);
    shadow.position.y = 0.5;
    root.add(shadow);
    const shield = new THREE.Mesh(shieldGeo, shieldMat);
    shield.position.y = 32;
    root.add(shield);
    const aura = new THREE.Mesh(auraGeo, auraMats.overdrive);
    aura.position.y = 0.8;
    aura.visible = false;
    root.add(aura);
    scene.add(root);
    return {
      team,
      root,
      roll,
      body,
      kit,
      gear: gearMeshes,
      thighs,
      knees,
      muzzle,
      shield,
      aura,
      geos: [m.body, m.kit, m.thigh, m.shin],
      last: { x: NaN, y: NaN },
      vel: { x: 0, y: 0 },
      speed: 0,
      phase: 0,
      rollAt: 0,
      rollDir: { x: 1, y: 0 },
      low: 0,
    };
  };
  const dropSoldier = (n: number) => {
    const s = soldiers.get(n);
    if (!s) return;
    scene.remove(s.root);
    for (const g of s.geos) g.dispose();
    soldiers.delete(n);
  };

  // Bots.
  const droneGeo = own(droneModel());
  const titanGeo = own(titanModel());
  const droneMat = own(new THREE.MeshStandardMaterial({ vertexColors: true, emissive: "#5a1070", roughness: 0.4 }));
  const titanMat = own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.3 }));
  const coreMat = own(new THREE.MeshStandardMaterial({ color: "#ffd36b", emissive: "#ffb020", emissiveIntensity: 1 }));
  const coreGeo = own(new THREE.SphereGeometry(13, 16, 12));
  interface Bot {
    root: THREE.Group;
    mesh: THREE.Mesh;
    core?: THREE.Mesh;
  }
  const bots = new Map<number, Bot>();
  const makeBot = (kind: 0 | 1): Bot => {
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(kind === 0 ? droneGeo : titanGeo, kind === 0 ? droneMat : titanMat);
    mesh.castShadow = true;
    root.add(mesh);
    const shadow = new THREE.Mesh(blobGeo, blob);
    shadow.scale.setScalar(kind === 0 ? 40 : 110);
    shadow.position.y = 0.5;
    root.add(shadow);
    let core: THREE.Mesh | undefined;
    if (kind === 1) {
      core = new THREE.Mesh(coreGeo, coreMat);
      core.position.set(30, 70, 0);
      mesh.add(core);
    }
    scene.add(root);
    return { root, mesh, core };
  };

  // Shots: glowing tracers for players, orbs for the Titan.
  const tracerGeo = own(new THREE.BoxGeometry(30, 2.6, 2.6));
  const orbGeo = own(new THREE.SphereGeometry(7, 10, 8));
  const tracerMats = [0, 1].map(() => own(new THREE.MeshBasicMaterial({ color: "#ffffff" })));
  const orbMat = own(new THREE.MeshBasicMaterial({ color: "#ff4fd8" }));
  const shotPool: THREE.Mesh[] = [];

  // Power-ups: a spinning model over a ring on the ground. The ring stays, dim, while one is away.
  const pickupGeos: Record<ClashPickupKind, THREE.BufferGeometry> = {
    medkit: own(medkitModel()),
    overdrive: own(overdriveModel()),
    haste: own(hasteModel()),
  };
  const pickupMats = Object.fromEntries(
    (Object.keys(PICKUP_COLOR) as ClashPickupKind[]).map((k) => [
      k,
      own(
        new THREE.MeshStandardMaterial({
          vertexColors: true,
          emissive: PICKUP_COLOR[k],
          emissiveIntensity: k === "medkit" ? 0.15 : 0.7,
          roughness: 0.4,
        }),
      ),
    ]),
  ) as Record<ClashPickupKind, THREE.MeshStandardMaterial>;
  const pickupRingGeo = own(new THREE.RingGeometry(26, 32, 32).rotateX(-Math.PI / 2));
  interface Pickup {
    model: THREE.Mesh;
    halo: THREE.Sprite;
    ringMat: THREE.MeshBasicMaterial;
  }
  const pickups: Pickup[] = [];
  const makePickup = (kind: ClashPickupKind, x: number, y: number): Pickup => {
    const ringMat = own(
      new THREE.MeshBasicMaterial({ color: PICKUP_COLOR[kind], transparent: true, opacity: 0.8, ...layer(2) }),
    );
    const ring = new THREE.Mesh(pickupRingGeo, ringMat);
    ring.position.set(x, 0.6, y);
    scene.add(ring);
    const model = new THREE.Mesh(pickupGeos[kind], pickupMats[kind]);
    model.position.set(x, 30, y);
    scene.add(model);
    const haloMat = own(
      new THREE.SpriteMaterial({
        map: glow.map,
        color: PICKUP_COLOR[kind],
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        opacity: 0.55,
      }),
    );
    const halo = new THREE.Sprite(haloMat);
    halo.position.set(x, 30, y);
    halo.scale.setScalar(kind === "overdrive" ? 90 : 64);
    scene.add(halo);
    return { model, halo, ringMat };
  };

  // Soldiers with a power-up running stand in a ring of its colour.
  const auraGeo = own(new THREE.RingGeometry(22, 29, 28).rotateX(-Math.PI / 2));
  const auraMats = {
    overdrive: own(new THREE.MeshBasicMaterial({ color: PICKUP_COLOR.overdrive, transparent: true, ...layer(3) })),
    haste: own(new THREE.MeshBasicMaterial({ color: PICKUP_COLOR.haste, transparent: true, ...layer(3) })),
  };
  const hotMat = own(new THREE.MeshBasicMaterial({ color: "#ffb15a" }));

  // Grenades: a small olive egg with a blinking light; blasts: a glowing fireball that swells and fades.
  const grenadeGeo = own(
    bake([
      [sphere(6, 10, 8), "#4d5a2a", [0, 0, 0], [0, 0, 0], [1, 1.25, 1]],
      [box(3, 4, 3), "#2b2b2b", [0, 8, 0]],
    ]),
  );
  const grenadeMat = own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }));
  const grenadePool: Array<{ mesh: THREE.Mesh; blink: THREE.Sprite }> = [];
  const boomGeo = own(new THREE.SphereGeometry(1, 18, 12));
  const boomPool: Array<{ ball: THREE.Mesh; mat: THREE.MeshBasicMaterial; flare: THREE.Sprite }> = [];

  let width = 1;
  let height = 1;
  let camDist = 1;
  const v3 = new THREE.Vector3();
  const look = new THREE.Vector3();
  const rollAxis = new THREE.Vector3();

  let lastT = 0;
  const render = (f: ClashFrame) => {
    const dt = lastT ? Math.min(0.1, (f.t - lastT) / 1000) : 0;
    lastT = f.t;
    setTeamColors(f.teamColors);

    // Camera.
    if (f.focus) {
      const { x, y, yaw, down } = f.focus;
      const zoom = f.focus.zoom ?? 0;
      const low = f.focus.low ?? 0;
      const fx = Math.cos(yaw);
      const fz = Math.sin(yaw);
      const back = CAM_BACK - zoom * AIM_CLOSER + down * 90;
      const shoulder = CAM_SHOULDER + zoom * AIM_SHOULDER;
      const wantX = x - fx * back - fz * shoulder;
      const wantZ = y - fz * back + fx * shoulder;
      // The camera stays inside the perimeter, and in front of any tall cover behind you.
      const inside = (from: number, to: number, max: number) => {
        const m = 12;
        if (to < m) return (from - m) / (from - to);
        if (to > max - m) return (max - m - from) / (to - from);
        return 1;
      };
      const clear = Math.max(
        0.18,
        Math.min(
          inside(x, wantX, W),
          inside(y, wantZ, H),
          // Cover is grown a little, so the near plane never clips into a wall.
          coverAlong(x, y, wantX, wantZ, { pad: 10, minHeight: CAM_BLOCK_HEIGHT }),
        ),
      );
      // Pull in at once when a wall gets in the way, and ease back out after.
      camDist = clear < camDist ? clear : camDist + (clear - camDist) * Math.min(1, dt * 4);
      camera.fov = CAM_FOV + (AIM_FOV - CAM_FOV) * zoom;
      camera.position.set(
        x + (wantX - x) * camDist,
        CAM_UP - low * CROUCH_DROP * 1.4 + down * 140,
        y + (wantZ - y) * camDist,
      );
      look.set(x + fx * 320, 36 - low * CROUCH_DROP - down * 20, y + fz * 320);
      camera.lookAt(look);
    } else {
      camDist = 1;
      camera.fov = 50;
      camera.position.set(W / 2, 1700, H / 2 + 1350);
      camera.lookAt(W / 2, 0, H / 2 - 60);
    }
    camera.updateProjectionMatrix();

    // The sun's shadow covers the patch of ground in view: around the soldier, or the whole map.
    const reach = f.focus ? 520 : 1500;
    const sx = f.focus ? f.focus.x + Math.cos(f.focus.yaw) * 220 : W / 2;
    const sz = f.focus ? f.focus.y + Math.sin(f.focus.yaw) * 220 : H / 2;
    sun.target.position.set(sx, 0, sz);
    sun.position.copy(SUN_DIR).multiplyScalar(1500).add(sun.target.position);
    const sc = sun.shadow.camera;
    if (sc.right !== reach) {
      sc.left = sc.bottom = -reach;
      sc.right = sc.top = reach;
      sc.near = 100;
      sc.far = 3200;
      sc.updateProjectionMatrix();
    }

    // Flags flutter.
    for (const [i, fl] of flags.entries())
      fl.mesh.rotation.y = (i === 0 ? 0 : Math.PI) + (f.still ? 0 : Math.sin(f.t / 500 + i) * 0.25);

    // Soldiers.
    const seen = new Set<number>();
    for (const p of f.players) {
      seen.add(p.n);
      let s = soldiers.get(p.n);
      if (s && s.team !== p.team) {
        dropSoldier(p.n);
        s = undefined;
      }
      if (!s) {
        s = makeSoldier(p.n, p.team);
        soldiers.set(p.n, s);
      }
      s.root.visible = true;
      s.root.position.set(p.x, 0, p.y);
      s.body.rotation.y = -p.a;
      // Legs swing with how fast the soldier is really moving.
      const fresh = Number.isNaN(s.last.x) || !dt;
      const vx = fresh ? 0 : (p.x - s.last.x) / dt;
      const vy = fresh ? 0 : (p.y - s.last.y) / dt;
      s.last = { x: p.x, y: p.y };
      const ease = Math.min(1, dt * 10);
      s.vel = { x: s.vel.x + (vx - s.vel.x) * ease, y: s.vel.y + (vy - s.vel.y) * ease };
      s.speed = Math.min(400, Math.hypot(s.vel.x, s.vel.y));
      const stride = Math.min(1, s.speed / R.playerSpeed);
      s.phase += s.speed * dt * 0.075;
      // Stepping backwards or sideways still reads as walking, so the legs cycle the same way.
      const swing = f.still ? 0 : Math.sin(s.phase) * 0.62 * stride;
      for (let i = 0; i < 2; i++) {
        const side = i === 0 ? 1 : -1;
        s.thighs[i]!.rotation.z = swing * side + 0.08;
        // A knee bends as its leg comes forward, and stays a little soft at rest.
        s.knees[i]!.rotation.z =
          -0.16 - (f.still ? 0 : Math.max(0, Math.cos(s.phase + (i ? Math.PI : 0))) * 0.9 * stride);
      }
      s.body.position.y = -HIP + (f.still ? 0 : Math.abs(Math.sin(s.phase)) * 1.6 * stride);
      // A crouch: knees bent, hips down, a shorter shuffling step.
      const wantLow = p.flags & CLASH_FLAG.crouch ? 1 : 0;
      s.low = f.still ? wantLow : s.low + Math.sign(wantLow - s.low) * Math.min(Math.abs(wantLow - s.low), dt * 5);
      if (s.low > 0) {
        const lw = s.low;
        const crouchStride = Math.min(1, s.speed / (R.playerSpeed * R.crouch.speed));
        const step = f.still ? 0 : Math.sin(s.phase) * 0.35 * crouchStride;
        for (let i = 0; i < 2; i++) {
          const side = i === 0 ? 1 : -1;
          s.thighs[i]!.rotation.z += (1.25 + step * side - s.thighs[i]!.rotation.z) * lw;
          s.knees[i]!.rotation.z += (-2.05 - s.knees[i]!.rotation.z) * lw;
        }
        s.body.position.y -= CROUCH_DROP * lw;
      }

      // A dodge: a forward roll the way the soldier is moving, tucked up tight.
      const rolling = !!(p.flags & CLASH_FLAG.dodge);
      if (rolling && !s.rollAt) {
        s.rollAt = f.t;
        const len = Math.hypot(s.vel.x, s.vel.y);
        s.rollDir = len > 40 ? { x: s.vel.x / len, y: s.vel.y / len } : { x: Math.cos(p.a), y: Math.sin(p.a) };
      }
      const k = s.rollAt ? (f.t - s.rollAt) / R.dodge.ms : 1;
      if (s.rollAt && k >= 1 && !rolling) s.rollAt = 0;
      if (s.rollAt && k < 1 && !f.still) {
        const u = k * k * (3 - 2 * k);
        rollAxis.set(s.rollDir.y, 0, -s.rollDir.x);
        s.roll.quaternion.setFromAxisAngle(rollAxis, u * Math.PI * 2);
        // Lower to the ground and tuck the legs in through the middle of the roll.
        const tuck = Math.sin(k * Math.PI);
        s.roll.position.y = HIP - tuck * 8;
        // Curled into a ball, so the head clears the ground as it goes over.
        s.roll.scale.setScalar(1 - tuck * 0.3);
        for (let i = 0; i < 2; i++) {
          s.thighs[i]!.rotation.z = 1.5 * tuck;
          s.knees[i]!.rotation.z = -2.2 * tuck;
        }
      } else {
        s.roll.quaternion.identity();
        s.roll.position.y = HIP;
        s.roll.scale.setScalar(1);
      }
      s.kit.material = p.flags & CLASH_FLAG.hurt ? flash : (teamMats[p.team] ?? teamMats[0]!);
      for (const g of s.gear) g.material = p.flags & CLASH_FLAG.hurt ? gearHurt : gear;
      s.shield.visible = !!(p.flags & CLASH_FLAG.shield);
      const buff = p.flags & CLASH_FLAG.overdrive ? "overdrive" : p.flags & CLASH_FLAG.haste ? "haste" : null;
      s.aura.visible = !!buff;
      if (buff) s.aura.material = auraMats[buff];
      s.muzzle.visible = !!(p.flags & CLASH_FLAG.firing) && Math.floor(f.t / 45) % 2 === 0;
    }
    for (const n of [...soldiers.keys()]) if (!seen.has(n)) dropSoldier(n);
    shieldMat.opacity = f.still ? 0.22 : 0.16 + 0.08 * Math.sin(f.t / 90);
    for (const m of Object.values(auraMats)) m.opacity = f.still ? 0.75 : 0.55 + 0.25 * Math.sin(f.t / 120);

    // Power-ups.
    if (!pickups.length) for (const p of f.pickups) pickups.push(makePickup(p.kind, p.x, p.y));
    for (const [i, p] of f.pickups.entries()) {
      const m = pickups[i];
      if (!m) continue;
      m.model.visible = p.ready;
      m.halo.visible = p.ready;
      m.ringMat.opacity = p.ready ? 0.85 : 0.2;
      if (p.ready && !f.still) {
        m.model.rotation.y = f.t / 600 + i;
        m.model.position.y = 30 + Math.sin(f.t / 380 + i) * 5;
      }
    }

    // Bots.
    const seenBots = new Set<number>();
    for (const b of f.npcs) {
      seenBots.add(b.id);
      let m = bots.get(b.id);
      if (!m) {
        m = makeBot(b.kind);
        bots.set(b.id, m);
      }
      m.root.position.set(b.x, 0, b.y);
      const hurt = b.flags & 1;
      if (b.kind === 0) {
        m.mesh.position.y = 46 + (f.still ? 0 : Math.sin(f.t / 260 + b.id) * 5);
        m.mesh.rotation.y = f.still ? 0 : f.t / 300 + b.id;
        m.mesh.material = hurt ? flash : droneMat;
      } else {
        m.mesh.rotation.y = f.still ? 0 : f.t / 2400;
        m.mesh.material = hurt ? flash : titanMat;
        const winding = b.flags & 2;
        coreMat.emissiveIntensity = winding ? 2.5 + Math.sin(f.t / 40) : 1;
        m.core!.scale.setScalar(winding ? 1.4 : 1);
      }
    }
    for (const [id, m] of bots)
      if (!seenBots.has(id)) {
        scene.remove(m.root);
        bots.delete(id);
      }

    // Shots.
    for (const [i, s] of f.shots.entries()) {
      let mesh = shotPool[i];
      if (!mesh) {
        mesh = new THREE.Mesh(tracerGeo, tracerMats[0]);
        shotPool.push(mesh);
        scene.add(mesh);
      }
      mesh.visible = true;
      mesh.position.set(s.x, CLASH_SHOT_HEIGHT, s.y);
      if (s.team < 0) {
        mesh.geometry = orbGeo;
        mesh.material = orbMat;
      } else {
        mesh.geometry = tracerGeo;
        mesh.rotation.y = -Math.atan2(s.vy, s.vx);
        if (s.hot) mesh.material = hotMat;
        else {
          mesh.material = tracerMats[s.team] ?? tracerMats[0]!;
          (mesh.material as THREE.MeshBasicMaterial).color.set(f.teamColors[s.team] ?? "#ffffff");
        }
      }
      mesh.scale.set(s.long && s.team >= 0 ? 4 : 1, s.hot ? 1.8 : 1, s.hot ? 1.8 : 1);
    }
    for (let i = f.shots.length; i < shotPool.length; i++) shotPool[i]!.visible = false;

    // Grenades.
    for (const [i, g] of f.grenades.entries()) {
      let p = grenadePool[i];
      if (!p) {
        const mesh = new THREE.Mesh(grenadeGeo, grenadeMat);
        const blink = new THREE.Sprite(glow);
        blink.scale.setScalar(18);
        blink.position.y = 10;
        mesh.add(blink);
        scene.add(mesh);
        p = { mesh, blink };
        grenadePool.push(p);
      }
      p.mesh.visible = true;
      p.mesh.position.set(g.x, g.z, g.y);
      p.mesh.rotation.z = f.still ? 0 : f.t / 90 + g.id;
      p.blink.visible = f.still || Math.floor(f.t / 120) % 2 === 0;
    }
    for (let i = f.grenades.length; i < grenadePool.length; i++) grenadePool[i]!.mesh.visible = false;

    // Blasts.
    for (const [i, b] of f.booms.entries()) {
      let p = boomPool[i];
      if (!p) {
        const mat = own(
          new THREE.MeshBasicMaterial({
            color: "#ffb15a",
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        const ball = new THREE.Mesh(boomGeo, mat);
        const flare = new THREE.Sprite(glow);
        scene.add(ball, flare);
        p = { ball, mat, flare };
        boomPool.push(p);
      }
      const r = R.grenade.blastRadius * (0.35 + 0.65 * Math.sqrt(b.k));
      p.ball.visible = p.flare.visible = true;
      p.ball.position.set(b.x, r * 0.35, b.y);
      p.ball.scale.set(r, r * 0.7, r);
      p.mat.opacity = 0.75 * (1 - b.k);
      p.flare.position.set(b.x, 40, b.y);
      p.flare.scale.setScalar(r * 2.6 * (1 - b.k * 0.5));
    }
    for (let i = f.booms.length; i < boomPool.length; i++)
      boomPool[i]!.ball.visible = boomPool[i]!.flare.visible = false;

    renderer.render(scene, camera);
  };

  return {
    resize(w, h, dpr) {
      width = w;
      height = h;
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    },
    render,
    project(x, y, up = 0) {
      v3.set(x, up, y);
      const dist = v3.distanceTo(camera.position);
      v3.project(camera);
      if (v3.z > 1 || v3.z < -1) return null;
      // Screen pixels per world unit there.
      const scale = height / (2 * Math.tan((camera.fov * Math.PI) / 360) * Math.max(1, dist));
      return { x: ((v3.x + 1) / 2) * width, y: ((1 - v3.y) / 2) * height, scale };
    },
    dispose() {
      for (const n of [...soldiers.keys()]) dropSoldier(n);
      for (const f of flags) f.mat.map?.dispose();
      for (const d of disposables) d.dispose();
      renderer.dispose();
    },
  };
}
