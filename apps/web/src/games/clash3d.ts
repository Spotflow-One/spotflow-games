/**
 * Core Clash in 3D: a dusty war zone at sunset, seen from just behind your soldier.
 *
 * The fight itself (movement, shots, scoring) stays flat and two-dimensional; this only draws
 * it. A ground point (x, y) sits at (x, height, y) here, so the world's y axis points up.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  CLASH_CENTER,
  CLASH_FLAG,
  CLASH_RULES as R,
  CLASH_TEAMS,
  CLASH_WALLS,
  clashBases,
  coverAlong,
  mulberry32,
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
   * `down` runs from 0 to 1 while knocked out, and lifts the camera up and away.
   */
  focus: { x: number; y: number; yaw: number; down: number } | null;
  players: ClashFramePlayer[];
  npcs: Array<{ id: number; kind: 0 | 1; x: number; y: number; flags: number }>;
  shots: Array<{ id: number; x: number; y: number; vx: number; vy: number; team: number }>;
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
const SKY_TOP = "#4a5f86";
const HORIZON = "#e8b98a";
/** Shots fly level at chest height. */
export const CLASH_SHOT_HEIGHT = 38;
/** Third-person camera: how far behind and above the soldier, and how far right of them. */
const CAM_BACK = 150;
const CAM_UP = 80;
const CAM_SHOULDER = 26;
/** Cover at least this tall gets between the camera and the soldier. */
const CAM_BLOCK_HEIGHT = 70;

// ---------------------------------------------------------------------------------------------
// Geometry helpers

type Part = [
  geo: THREE.BufferGeometry,
  color: string,
  pos: [number, number, number],
  rot?: [number, number, number],
  scale?: [number, number, number],
];

/** Many coloured primitives baked into one geometry, so a model is one draw call. */
function bake(parts: Part[], keepUv = false) {
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
    const c = new THREE.Color(color);
    const n = g.attributes.position!.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
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

const SKIN = ["#8d5a3b", "#c68a5a", "#5e3a24", "#e0b48c", "#a86e45", "#6b4129"];
const PANTS = "#3b3f33";
const GEAR = "#4b5137";
const DARK = "#1d1e22";

/** A rounded limb from one joint to another. */
function limb(a: [number, number, number], b: [number, number, number], r: number) {
  const from = new THREE.Vector3(...a);
  const dir = new THREE.Vector3(...b).sub(from);
  const g = new THREE.CapsuleGeometry(r, dir.length(), 3, 8);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize()));
  g.translate(from.x + dir.x / 2, from.y + dir.y / 2, from.z + dir.z / 2);
  return g;
}

/** Where the hips are. Legs hang from here, and a roll spins the soldier about this height. */
const HIP = 29;
const THIGH = 13;
const SHIN = 11;

/**
 * A soldier facing +x, about 64 units tall, holding a rifle at the ready on their right (+z).
 * Team-coloured clothes are a separate mesh, and the legs are jointed so they can walk and tuck.
 */
function soldierModel(n: number, team: number) {
  const skin = SKIN[n % SKIN.length]!;
  const shoulderR: [number, number, number] = [0, 49, 9.5];
  const shoulderL: [number, number, number] = [0, 49, -9.5];
  const elbowR: [number, number, number] = [3, 40, 12];
  const elbowL: [number, number, number] = [11, 41, -6];
  const gripR: [number, number, number] = [10, 40.5, 4.5];
  const gripL: [number, number, number] = [21, 43, 4];
  const body = bake([
    // Head, face and neck.
    [new THREE.CylinderGeometry(2.8, 3.2, 5, 8), skin, [0.5, 53.5, 0]],
    [sphere(6, 14, 12), skin, [0.8, 59, 0], undefined, [1, 1.12, 0.92]],
    [box(2, 2.6, 1.8), skin, [6.6, 58.4, 0], [0, 0, -0.2]],
    [sphere(0.9, 6, 4), DARK, [5.7, 60, 2.2]],
    [sphere(0.9, 6, 4), DARK, [5.7, 60, -2.2]],
    [box(0.8, 0.7, 3), "#5a2e22", [6.2, 55.6, 0]],
    [sphere(1.6, 6, 6), skin, [0.4, 58.5, 5.7], undefined, [0.6, 1, 0.5]],
    [sphere(1.6, 6, 6), skin, [0.4, 58.5, -5.7], undefined, [0.6, 1, 0.5]],
    // Hips, belt, chest rig and backpack.
    [box(9, 8, 15), PANTS, [0, HIP + 2, 0]],
    [box(10, 2.5, 16), DARK, [0, HIP + 6, 0]],
    [box(3, 12, 13), GEAR, [6.4, 43, 0]],
    [box(2.4, 4, 3.5), GEAR, [8.3, 39, 3.6]],
    [box(2.4, 4, 3.5), GEAR, [8.3, 39, -3.6]],
    [box(7, 15, 13), GEAR, [-8.6, 43, 0]],
    [box(4, 4, 11), "#3e4330", [-8.6, 52, 0]],
    // Gloved hands.
    [sphere(2.5, 8, 6), DARK, gripR],
    [sphere(2.5, 8, 6), DARK, gripL],
    // The rifle.
    [box(17, 4.5, 3.4), "#2a2b30", [14, 43.5, 4]],
    [box(9, 4.5, 3), "#2a2b30", [1.5, 42.5, 4]],
    [new THREE.CylinderGeometry(1.1, 1.1, 14, 6), DARK, [29, 44.3, 4], [0, 0, Math.PI / 2]],
    [box(3.5, 8, 3), DARK, [15, 38, 4], [0, 0, 0.25]],
    [box(4, 1.8, 2), DARK, [12, 46.6, 4]],
    [box(3, 4, 2.6), DARK, [8.5, 39.5, 4], [0, 0, -0.3]],
  ]);
  const helmet =
    CLASH_TEAMS[team]?.shape === "square"
      ? [
          // A patrol cap with a peak.
          box(12.5, 5, 12.5).translate(0.4, 63.2, 0),
          box(5.5, 1.2, 10).translate(8.5, 61.4, 0),
        ]
      : [
          // A round combat helmet.
          new THREE.SphereGeometry(7.2, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2)
            .scale(1.06, 0.95, 1)
            .translate(0.6, 60.5, 0),
          new THREE.CylinderGeometry(7.6, 7.8, 1.4, 16).translate(0.6, 60.6, 0),
        ];
  const parts = [
    // Jacket: a chest broader at the shoulders, with sleeves down to the gloves.
    new THREE.CylinderGeometry(10, 7.6, 19, 12).scale(0.66, 1, 1).translate(0, 43, 0),
    sphere(4.3).translate(...shoulderR),
    sphere(4.3).translate(...shoulderL),
    limb(shoulderR, elbowR, 3.2),
    limb(elbowR, gripR, 2.8),
    limb(shoulderL, elbowL, 3.2),
    limb(elbowL, gripL, 2.8),
    ...helmet,
  ];
  const kit = mergeGeometries(parts)!;
  for (const p of parts) p.dispose();
  const thigh = bake([[limb([0, 0, 0], [0, -THIGH, 0], 4.2), PANTS, [0, 0, 0]]]);
  const shin = bake([
    [limb([0, 0, 0], [0, -SHIN + 1, 0], 3.6), PANTS, [0, 0, 0]],
    [box(10, 4.5, 6.5), DARK, [1.8, -SHIN - 1.5, 0]],
  ]);
  return { body, kit, thigh, shin };
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

// ---------------------------------------------------------------------------------------------
// The world

export function createClashWorld(canvas: HTMLCanvasElement): ClashWorld {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
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
        g.addColorStop(0, SKY_TOP);
        g.addColorStop(0.6, HORIZON);
        g.addColorStop(1, HORIZON);
        c.fillStyle = g;
        c.fillRect(0, 0, 4, 256);
      },
      false,
    ),
  );
  scene.fog = new THREE.Fog(HORIZON, 1100, 4200);

  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 4, 20000);
  scene.add(new THREE.HemisphereLight("#ffe6c8", "#6b5a40", 1.6));
  const sun = new THREE.DirectionalLight("#ffd7a8", 2.1);
  sun.position.set(-0.7, 0.8, -0.35);
  scene.add(sun);

  const tex = (t: THREE.Texture) => {
    t.anisotropy = maxAniso;
    return own(t);
  };
  const colored = own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.05 }));
  const layer = (n: number) => ({ polygonOffset: true, polygonOffsetFactor: -n, polygonOffsetUnits: -n * 4 });
  const add = (g: THREE.BufferGeometry, m: THREE.Material | THREE.Material[]) => {
    own(g);
    const mesh = new THREE.Mesh(g, m);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    scene.add(mesh);
    return mesh;
  };

  // Ground: the war zone, a wider wasteland beyond it, and the open plaza in the middle.
  const dirt = tex(dirtTexture());
  dirt.repeat.set(W / 220, H / 220);
  add(
    new THREE.PlaneGeometry(W, H).rotateX(-Math.PI / 2).translate(W / 2, 0, H / 2),
    own(new THREE.MeshStandardMaterial({ map: dirt, roughness: 1 })),
  );
  const waste = tex(dirtTexture());
  waste.repeat.set(60, 60);
  add(
    new THREE.PlaneGeometry(16000, 16000).rotateX(-Math.PI / 2).translate(W / 2, -1, H / 2),
    own(new THREE.MeshStandardMaterial({ map: waste, color: "#c9b08a", roughness: 1 })),
  );
  const plazaR = R.titan.leash + R.titan.radius;
  const plazaTex = tex(concreteTexture("#a39a8a", 4));
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
    }
  };
  for (const c of CLASH_WALLS) coverMesh(c);
  if (sandbags.length) add(bake(sandbags), colored);

  // The perimeter, and ruined blocks beyond it on the skyline.
  const rim = 40;
  for (const [x, y, w, h] of [
    [-rim, -rim, W + rim * 2, rim],
    [-rim, H, W + rim * 2, rim],
    [-rim, 0, rim, H],
    [W, 0, rim, H],
  ] as const)
    add(tiledBox(w, 70, h, 64).translate(x + w / 2, 35, y + h / 2), concrete);
  const skyRnd = mulberry32(42);
  const skyline: Part[] = [];
  for (let i = 0; i < 90; i++) {
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
  const teamMats = [0, 1].map(() => own(new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.1 })));
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
    thighs: THREE.Group[];
    knees: THREE.Group[];
    muzzle: THREE.Sprite;
    shield: THREE.Mesh;
    geos: THREE.BufferGeometry[];
    last: { x: number; y: number };
    vel: { x: number; y: number };
    speed: number;
    phase: number;
    /** When the current roll started, and which way it goes. */
    rollAt: number;
    rollDir: { x: number; y: number };
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
    body.add(new THREE.Mesh(m.body, colored));
    const kit = new THREE.Mesh(m.kit, teamMats[team] ?? teamMats[0]!);
    body.add(kit);
    const thighs: THREE.Group[] = [];
    const knees: THREE.Group[] = [];
    for (const z of [-4.6, 4.6]) {
      const hip = new THREE.Group();
      hip.position.set(0, HIP, z);
      hip.add(new THREE.Mesh(m.thigh, colored));
      const knee = new THREE.Group();
      knee.position.y = -THIGH;
      knee.add(new THREE.Mesh(m.shin, colored));
      hip.add(knee);
      body.add(hip);
      thighs.push(hip);
      knees.push(knee);
    }
    const muzzle = new THREE.Sprite(glow);
    muzzle.position.set(37, 44.3, 4);
    muzzle.scale.setScalar(24);
    body.add(muzzle);
    const shadow = new THREE.Mesh(blobGeo, blob);
    shadow.scale.set(46, 1, 46);
    shadow.position.y = 0.5;
    root.add(shadow);
    const shield = new THREE.Mesh(shieldGeo, shieldMat);
    shield.position.y = 32;
    root.add(shield);
    scene.add(root);
    return {
      team,
      root,
      roll,
      body,
      kit,
      thighs,
      knees,
      muzzle,
      shield,
      geos: [m.body, m.kit, m.thigh, m.shin],
      last: { x: NaN, y: NaN },
      vel: { x: 0, y: 0 },
      speed: 0,
      phase: 0,
      rollAt: 0,
      rollDir: { x: 1, y: 0 },
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
      const fx = Math.cos(yaw);
      const fz = Math.sin(yaw);
      const back = CAM_BACK + down * 90;
      const wantX = x - fx * back - fz * CAM_SHOULDER;
      const wantZ = y - fz * back + fx * CAM_SHOULDER;
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
      camera.fov = 62;
      camera.position.set(x + (wantX - x) * camDist, CAM_UP + down * 140, y + (wantZ - y) * camDist);
      look.set(x + fx * 320, 36 - down * 20, y + fz * 320);
      camera.lookAt(look);
    } else {
      camDist = 1;
      camera.fov = 50;
      camera.position.set(W / 2, 1700, H / 2 + 1350);
      camera.lookAt(W / 2, 0, H / 2 - 60);
    }
    camera.updateProjectionMatrix();

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
      s.shield.visible = !!(p.flags & CLASH_FLAG.shield);
      s.muzzle.visible = !!(p.flags & CLASH_FLAG.firing) && Math.floor(f.t / 45) % 2 === 0;
    }
    for (const n of [...soldiers.keys()]) if (!seen.has(n)) dropSoldier(n);
    shieldMat.opacity = f.still ? 0.22 : 0.16 + 0.08 * Math.sin(f.t / 90);

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
        mesh.material = tracerMats[s.team] ?? tracerMats[0]!;
        mesh.rotation.y = -Math.atan2(s.vy, s.vx);
        (mesh.material as THREE.MeshBasicMaterial).color.set(f.teamColors[s.team] ?? "#ffffff");
      }
    }
    for (let i = f.shots.length; i < shotPool.length; i++) shotPool[i]!.visible = false;

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
