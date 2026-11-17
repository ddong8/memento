import * as THREE from "three";
import type { AvatarPreset } from "./avatarPresets";

/**
 * The persona's 3D figure for a person (male / female presets), built from the preset the user
 * picked at onboarding: hair, outfit, glasses / goggles / headphones and the feature ring follow
 * the preset's three features, colours follow the user's theme and outfit colour.
 *
 * Until 2026-11-17 the 3D stage loaded one generic armoured soldier model for every man and
 * every woman; the user had picked "极客全栈架构师" (black-rimmed glasses, hoodie, code ring) and
 * the figure had nothing of it. The silicon agent presets keep their robot model.
 *
 * Chibi proportions and cel shading with ink outlines, so it reads as the same character as the
 * 2D cartoon portrait. Everything is primitives: nothing to download, built in a few ms.
 */

export type CartoonDimension =
  | "all" | "brain" | "intercept" | "communication" | "tech" | "execution" | "project" | "evolution";

export interface CartoonLook {
  presetId: string;
  gender: "male" | "female";
  outfitColor: string;
  themeColor: string;
}

export interface CartoonFrame {
  elapsed: number;
  dimension: CartoonDimension;
  /** -1…1 pointer position over the stage */
  lookX: number;
  lookY: number;
  nod: number;
  /** The head follows the pointer only while not dragging the stage */
  follow: boolean;
}

export interface CartoonAvatar {
  group: THREE.Group;
  head: THREE.Object3D;
  chest: THREE.Object3D;
  update(frame: CartoonFrame): void;
  dispose(): void;
}

type Hair = "short" | "spiky" | "neat" | "messy" | "long" | "bob" | "ponytails";
type Outfit = "hoodie" | "techwear" | "suit" | "jacket" | "coat" | "sport";
type Eyewear = "glasses" | "thin_glasses" | "visor" | "none";

interface Recipe {
  hair: Hair;
  hairColor: string;
  /** A coloured streak in the hair (挑染), in the theme colour */
  streak?: boolean;
  outfit: Outfit;
  eyewear: Eyewear;
  catHeadphones?: boolean;
  glyphs: string[];
}

const CODE = ["</>", "{ }", "λ", "=>", "#", "fn"];

/** Each preset's three features, as parts */
export const RECIPES: Record<string, Recipe> = {
  geek_male: { hair: "short", hairColor: "#24222c", outfit: "hoodie", eyewear: "glasses", glyphs: CODE },
  cyber_male: { hair: "spiky", hairColor: "#1b1d2e", streak: true, outfit: "techwear", eyewear: "visor", glyphs: ["0x", "01", "⌁", "∿", "10", "≡"] },
  elite_male: { hair: "neat", hairColor: "#2b2420", outfit: "suit", eyewear: "none", glyphs: ["◆", "◇", "◆", "◇", "◆", "◇"] },
  vitality_male: { hair: "messy", hairColor: "#2a211c", streak: true, outfit: "jacket", eyewear: "none", glyphs: ["✦", "✧", "✦", "✧", "✦", "✧"] },
  geek_female: { hair: "long", hairColor: "#221f2b", outfit: "hoodie", eyewear: "thin_glasses", glyphs: CODE },
  cyber_female: { hair: "long", hairColor: "#1c1a26", streak: true, outfit: "coat", eyewear: "none", glyphs: ["◎", "⌖", "◉", "⌖", "◎", "◉"] },
  elite_female: { hair: "bob", hairColor: "#2b2220", outfit: "suit", eyewear: "none", glyphs: ["✶", "✷", "✶", "✷", "✶", "✷"] },
  vitality_female: { hair: "ponytails", hairColor: "#3a2722", outfit: "sport", eyewear: "none", catHeadphones: true, glyphs: ["♪", "✦", "♫", "✧", "♪", "✦"] },
};

export function recipeFor(look: Pick<CartoonLook, "presetId" | "gender">): Recipe {
  return RECIPES[look.presetId] ?? (look.gender === "female" ? RECIPES.geek_female : RECIPES.geek_male);
}

// Arm poses per persona dimension, in this rig's terms: arm z swings the arm out sideways (left
// arm positive, right arm negative), x swings it forward (negative) or back; the forearm's x bends
// the elbow forward (negative).
interface ArmPose { x: number; z: number; foreX: number; foreZ: number }
interface Pose { head: [number, number, number]; lean: number; left: ArmPose; right: ArmPose }

const P = (x: number, z: number, foreX = -0.15, foreZ = 0): ArmPose => ({ x, z, foreX, foreZ });
const POSES: Record<CartoonDimension, Pose> = {
  // Relaxed, arms loose at the sides
  all: { head: [0, 0, 0], lean: 0, left: P(0.05, 0.14), right: P(0.05, -0.14) },
  // Thinking: right hand at the chin
  brain: { head: [0.06, -0.1, 0.05], lean: 0.02, left: P(0.05, 0.12), right: P(-1.25, 0.42, -1.85, 0.2) },
  // A firm "stop": right palm out in front
  intercept: { head: [-0.04, 0, 0], lean: -0.03, left: P(0.1, 0.18), right: P(-1.45, -0.05, -0.1) },
  // Explaining: right hand open, reaching forward
  communication: { head: [0.02, 0.16, -0.06], lean: 0.04, left: P(0.05, 0.14), right: P(-0.85, -0.3, -0.55) },
  // Typing: both forearms forward
  tech: { head: [0.14, 0, 0], lean: 0.05, left: P(-0.45, 0.12, -1.15, -0.1), right: P(-0.45, -0.12, -1.15, 0.1) },
  // Getting it done: right fist up
  execution: { head: [-0.08, 0, 0], lean: -0.02, left: P(0.05, 0.16), right: P(-2.75, -0.1, -0.45) },
  // Hands on hips, surveying the project
  project: { head: [-0.03, -0.08, 0], lean: 0, left: P(0.15, 0.62, -0.25, -1.55), right: P(0.15, -0.62, -0.25, 1.55) },
  // Growing: both arms up in a V
  evolution: { head: [-0.12, 0, 0], lean: -0.03, left: P(0, 2.45, -0.15), right: P(0, -2.45, -0.15) },
};

function gradientMap(): THREE.DataTexture {
  // Three bands: shadow, mid, lit
  const data = new Uint8Array([90, 170, 255]);
  const tex = new THREE.DataTexture(data, data.length, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

function glyphTexture(text: string, color: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 64;
  const g = c.getContext("2d");
  if (g) {
    g.font = '600 40px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.shadowColor = color;
    g.shadowBlur = 12;
    g.fillStyle = color;
    g.fillText(text, 64, 34);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function shade(hex: string, amount: number): THREE.Color {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  return new THREE.Color().setHSL(hsl.h, hsl.s, THREE.MathUtils.clamp(hsl.l + amount, 0, 1));
}

export function buildCartoonAvatar(look: CartoonLook, preset?: AvatarPreset): CartoonAvatar {
  const recipe = recipeFor(look);
  const theme = look.themeColor || preset?.themeColor || "#8B5CF6";
  const outfit = look.outfitColor || preset?.outfitColor || "#4F46E5";

  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };
  const ramp = keep(gradientMap());
  const toon = (color: THREE.ColorRepresentation, extra: THREE.MeshToonMaterialParameters = {}) =>
    keep(new THREE.MeshToonMaterial({ color, gradientMap: ramp, ...extra }));
  const glow = (color: THREE.ColorRepresentation, opacity = 1) =>
    keep(new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, toneMapped: false }));
  const inkMat = keep(new THREE.MeshBasicMaterial({ color: 0x1a1426, side: THREE.BackSide }));

  const skin = toon("#f6d2bb");
  const cloth = toon(outfit);
  const clothDark = toon(shade(outfit, -0.14));
  const clothLight = toon(shade(outfit, 0.16));
  const hairMat = toon(recipe.hairColor);
  const streakMat = toon(theme);
  const pants = toon(recipe.outfit === "suit" ? shade(outfit, -0.28) : "#2a3142");
  const shoe = toon("#f4f4f7");
  const sole = toon(theme);
  const white = toon("#fbfbfd");
  const dark = toon("#16131f");

  /** A mesh with an ink outline (inverted hull) */
  const part = (geo: THREE.BufferGeometry, mat: THREE.Material, outline = 0.035): THREE.Mesh => {
    keep(geo);
    const m = new THREE.Mesh(geo, mat);
    if (outline > 0) {
      const ink = new THREE.Mesh(geo, inkMat);
      ink.scale.setScalar(1 + outline);
      ink.raycast = () => {};
      m.add(ink);
    }
    return m;
  };
  const at = <T extends THREE.Object3D>(o: T, x: number, y: number, z: number): T => {
    o.position.set(x, y, z);
    return o;
  };

  const group = new THREE.Group();
  group.name = "cartoon-avatar";

  // ── Legs and shoes ──
  const hipY = 0.6;
  for (const side of [-1, 1]) {
    const leg = at(part(new THREE.CapsuleGeometry(0.085, 0.36, 6, 16), pants), side * 0.1, 0.33, 0);
    group.add(leg);
    const shoeMesh = at(part(new THREE.SphereGeometry(0.1, 20, 14), shoe), side * 0.105, 0.07, 0.035);
    shoeMesh.scale.set(0.95, 0.62, 1.45);
    const soleMesh = at(new THREE.Mesh(keep(new THREE.CylinderGeometry(0.098, 0.1, 0.025, 20)), sole), 0, -0.07, 0);
    soleMesh.scale.set(1, 1, 1);
    shoeMesh.add(soleMesh);
    group.add(shoeMesh);
  }

  // ── Body (pivots at the hip, leans and breathes) ──
  const body = at(new THREE.Group(), 0, hipY, 0);
  group.add(body);
  const torso = at(part(new THREE.CapsuleGeometry(0.2, 0.26, 8, 24), cloth), 0, 0.27, 0);
  torso.scale.set(1.08, 1, 0.82);
  body.add(torso);
  const chest = at(new THREE.Object3D(), 0, 0.36, 0.17);
  body.add(chest);

  const front = 0.168; // the torso's front surface, in body space at chest height
  switch (recipe.outfit) {
    case "hoodie": {
      // Hood resting on the shoulders, drawstrings, kangaroo pocket
      const hood = at(part(new THREE.TorusGeometry(0.15, 0.06, 14, 32), clothDark, 0.03), 0, 0.52, -0.03);
      hood.rotation.x = Math.PI / 2.25;
      hood.scale.set(1.12, 1, 1);
      body.add(hood);
      for (const side of [-1, 1]) {
        const cord = at(new THREE.Mesh(keep(new THREE.CylinderGeometry(0.008, 0.008, 0.13, 8)), white), side * 0.045, 0.42, front + 0.005);
        cord.rotation.x = -0.25;
        body.add(cord);
        body.add(at(new THREE.Mesh(keep(new THREE.SphereGeometry(0.014, 8, 8)), white), side * 0.045, 0.355, front + 0.025));
      }
      const pocket = at(part(new THREE.BoxGeometry(0.22, 0.09, 0.03), clothDark, 0.02), 0, 0.12, front - 0.005);
      pocket.rotation.x = 0.12;
      body.add(pocket);
      break;
    }
    case "techwear": {
      const collar = at(part(new THREE.CylinderGeometry(0.11, 0.14, 0.08, 20, 1, true), clothDark, 0.02), 0, 0.5, 0);
      body.add(collar);
      for (const side of [-1, 1]) {
        const strip = at(new THREE.Mesh(keep(new THREE.BoxGeometry(0.018, 0.3, 0.01)), glow(theme)), side * 0.08, 0.27, front + 0.012);
        strip.rotation.z = side * 0.12;
        body.add(strip);
      }
      const plate = at(part(new THREE.BoxGeometry(0.14, 0.07, 0.03), clothDark, 0.02), 0, 0.36, front + 0.005);
      body.add(plate);
      body.add(at(new THREE.Mesh(keep(new THREE.BoxGeometry(0.06, 0.012, 0.01)), glow(theme)), 0, 0.36, front + 0.024));
      break;
    }
    case "suit": {
      // Open blazer: a light shirt V, lapels and (for men) a tie in the theme colour
      const shirt = at(new THREE.Mesh(keep(new THREE.CircleGeometry(0.085, 3)), white), 0, 0.4, front + 0.012);
      shirt.rotation.z = -Math.PI / 2;
      shirt.scale.set(1.25, 0.75, 1);
      body.add(shirt);
      for (const side of [-1, 1]) {
        const lapel = at(part(new THREE.BoxGeometry(0.035, 0.17, 0.02), clothDark, 0.02), side * 0.06, 0.38, front + 0.01);
        lapel.rotation.z = side * 0.42;
        body.add(lapel);
      }
      if (look.gender === "male") {
        const tie = at(part(new THREE.BoxGeometry(0.03, 0.13, 0.012), toon(theme), 0.02), 0, 0.37, front + 0.022);
        body.add(tie);
      } else {
        body.add(at(new THREE.Mesh(keep(new THREE.SphereGeometry(0.016, 10, 10)), glow(theme)), 0, 0.36, front + 0.025));
      }
      for (const y of [0.22, 0.14]) body.add(at(new THREE.Mesh(keep(new THREE.SphereGeometry(0.011, 8, 8)), dark), 0, y, front + 0.012));
      break;
    }
    case "jacket":
    case "sport": {
      // Zip-up: a zipper line, collar and a stripe on each side in the theme colour
      const zip = at(new THREE.Mesh(keep(new THREE.BoxGeometry(0.012, 0.36, 0.01)), white), 0, 0.27, front + 0.008);
      body.add(zip);
      const collar = at(part(new THREE.TorusGeometry(0.105, 0.03, 10, 28), clothLight, 0.02), 0, 0.5, 0);
      collar.rotation.x = Math.PI / 2;
      body.add(collar);
      for (const side of [-1, 1]) {
        const stripe = at(new THREE.Mesh(keep(new THREE.BoxGeometry(0.012, 0.34, 0.01)), toon(theme)), side * 0.17, 0.27, 0.075);
        stripe.rotation.y = side * 1.0;
        body.add(stripe);
      }
      break;
    }
    case "coat": {
      // High-collar coat flaring below the waist
      const collar = at(part(new THREE.CylinderGeometry(0.1, 0.13, 0.12, 22, 1, true), clothDark, 0.02), 0, 0.52, 0);
      body.add(collar);
      const skirt = at(part(new THREE.CylinderGeometry(0.2, 0.27, 0.22, 24, 1, true), cloth, 0.025), 0, 0.0, 0);
      skirt.scale.set(1, 1, 0.85);
      body.add(skirt);
      const belt = at(new THREE.Mesh(keep(new THREE.TorusGeometry(0.205, 0.014, 8, 32)), glow(theme)), 0, 0.12, 0);
      belt.rotation.x = Math.PI / 2;
      belt.scale.set(1.06, 0.82, 1);
      body.add(belt);
      break;
    }
  }

  // ── Arms (shoulder and elbow pivots) ──
  const shoulderY = 0.47;
  const makeArm = (side: 1 | -1) => {
    const shoulder = at(new THREE.Group(), side * 0.235, shoulderY, 0);
    body.add(shoulder);
    shoulder.add(at(part(new THREE.SphereGeometry(0.075, 16, 12), cloth), 0, 0, 0));
    shoulder.add(at(part(new THREE.CapsuleGeometry(0.066, 0.14, 6, 14), cloth), 0, -0.1, 0));
    const elbow = at(new THREE.Group(), 0, -0.2, 0);
    shoulder.add(elbow);
    elbow.add(at(part(new THREE.CapsuleGeometry(0.06, 0.12, 6, 14), recipe.outfit === "suit" ? cloth : clothLight), 0, -0.085, 0));
    const cuff = at(new THREE.Mesh(keep(new THREE.CylinderGeometry(0.058, 0.058, 0.025, 14)), recipe.outfit === "suit" ? white : clothDark), 0, -0.165, 0);
    elbow.add(cuff);
    const hand = at(part(new THREE.SphereGeometry(0.058, 16, 12), skin), 0, -0.215, 0.005);
    hand.scale.set(0.9, 1.05, 0.85);
    elbow.add(hand);
    return { shoulder, elbow };
  };
  const armL = makeArm(1);
  const armR = makeArm(-1);

  // ── Neck and head ──
  body.add(at(part(new THREE.CylinderGeometry(0.055, 0.06, 0.08, 14), skin, 0.02), 0, 0.53, 0));
  const head = at(new THREE.Group(), 0, 0.57, 0);
  body.add(head);
  const headR = 0.26;
  const face = at(new THREE.Group(), 0, headR * 0.95, 0);
  head.add(face);
  const skull = part(new THREE.SphereGeometry(headR, 40, 30), skin, 0.025);
  skull.scale.set(1, 0.94, 0.94);
  face.add(skull);
  for (const side of [-1, 1]) {
    const ear = at(part(new THREE.SphereGeometry(0.05, 14, 10), skin, 0.03), side * headR * 0.98, -0.02, -0.01);
    ear.scale.set(0.5, 1, 0.8);
    face.add(ear);
  }

  // Eyes: big glossy ovals with a highlight, lids for blinking
  /** How far forward the face's surface is at (x, y) */
  const surf = (x: number, y: number) => {
    const rx = headR, ry = headR * 0.94, rz = headR * 0.94;
    return rz * Math.sqrt(Math.max(0, 1 - (x / rx) ** 2 - (y / ry) ** 2));
  };
  const eyes: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const eye = at(new THREE.Group(), side * 0.09, -0.02, surf(0.09, -0.02) - 0.006);
    eye.rotation.y = side * 0.3;
    const iris = new THREE.Mesh(keep(new THREE.SphereGeometry(0.044, 20, 16)), dark);
    iris.scale.set(0.82, 1.15, 0.4);
    eye.add(iris);
    const tint = at(new THREE.Mesh(keep(new THREE.SphereGeometry(0.026, 14, 12)), glow(shade(theme, -0.05))), 0, -0.012, 0.012);
    tint.scale.set(0.9, 1, 0.35);
    eye.add(tint);
    eye.add(at(new THREE.Mesh(keep(new THREE.SphereGeometry(0.011, 10, 8)), glow("#ffffff")), 0.012 * -side, 0.018, 0.02));
    eye.add(at(new THREE.Mesh(keep(new THREE.SphereGeometry(0.006, 8, 6)), glow("#ffffff")), 0.012 * side, -0.02, 0.02));
    face.add(eye);
    eyes.push(eye);
    const brow = at(new THREE.Mesh(keep(new THREE.CapsuleGeometry(0.008, 0.045, 4, 8)), hairMat), side * 0.09, 0.05, surf(0.09, 0.05) + 0.004);
    brow.rotation.z = Math.PI / 2 + side * 0.1;
    brow.rotation.y = side * 0.3;
    face.add(brow);
    const blush = at(new THREE.Mesh(keep(new THREE.CircleGeometry(0.03, 20)), glow("#ff8fa3", 0.35)), side * 0.15, -0.08, surf(0.15, -0.08) + 0.003);
    blush.rotation.y = side * 0.55;
    blush.scale.set(1.3, 0.7, 1);
    face.add(blush);
  }
  const mouth = at(new THREE.Mesh(keep(new THREE.TorusGeometry(0.03, 0.007, 8, 20, Math.PI)), dark), 0, -0.1, surf(0, -0.1) + 0.002);
  mouth.rotation.z = Math.PI;
  face.add(mouth);
  face.add(at(new THREE.Mesh(keep(new THREE.SphereGeometry(0.012, 10, 8)), toon("#eab49a")), 0, -0.05, surf(0, -0.05) + 0.004));

  // Hair
  const cap = (scale: number, thetaLength: number, y = 0.015) => {
    const m = part(new THREE.SphereGeometry(headR * scale, 40, 24, 0, Math.PI * 2, 0, thetaLength), hairMat, 0.025);
    m.position.y = y;
    m.scale.set(1, 0.98, 1);
    // Tilted back: the hairline sits high on the forehead, the back covers the nape
    m.rotation.x = -0.55;
    return m;
  };
  const fringe = (n: number, spread: number, len: number, tilt: number, mat = hairMat) => {
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : i / (n - 1) - 0.5;
      const a = t * spread;
      const lock = part(new THREE.ConeGeometry(0.06, len, 10), mat, 0.03);
      lock.position.set(Math.sin(a) * headR * 0.95, 0.12, Math.cos(a) * headR * 0.86);
      lock.rotation.set(Math.PI - tilt, 0, -a * 0.6);
      face.add(lock);
    }
  };
  switch (recipe.hair) {
    case "short":
      face.add(cap(1.06, Math.PI * 0.52));
      fringe(5, 1.5, 0.14, 0.5);
      break;
    case "neat": {
      face.add(cap(1.05, Math.PI * 0.5));
      const part1 = part(new THREE.SphereGeometry(0.13, 18, 12), hairMat, 0.03);
      part1.position.set(-0.07, 0.17, 0.12);
      part1.scale.set(1.5, 0.55, 1);
      part1.rotation.z = 0.35;
      face.add(part1);
      break;
    }
    case "spiky": {
      face.add(cap(1.05, Math.PI * 0.5));
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        const spike = part(new THREE.ConeGeometry(0.065, 0.2, 8), i % 3 === 0 && recipe.streak ? streakMat : hairMat, 0.03);
        spike.position.set(Math.sin(a) * 0.15, 0.2, Math.cos(a) * 0.15);
        spike.rotation.set(Math.cos(a) * 0.8, 0, -Math.sin(a) * 0.8);
        face.add(spike);
      }
      break;
    }
    case "messy":
      face.add(cap(1.07, Math.PI * 0.55));
      fringe(6, 1.8, 0.16, 0.35);
      if (recipe.streak) {
        const s = part(new THREE.ConeGeometry(0.055, 0.17, 10), streakMat, 0.03);
        s.position.set(0.13, 0.12, 0.2);
        s.rotation.set(Math.PI - 0.4, 0, -0.45);
        face.add(s);
      }
      for (let i = 0; i < 5; i++) {
        const tuft = part(new THREE.ConeGeometry(0.05, 0.13, 8), hairMat, 0.03);
        tuft.position.set(-0.12 + i * 0.06, 0.25, -0.02 - (i % 2) * 0.05);
        tuft.rotation.set(-0.3, 0, (i - 2) * 0.3);
        face.add(tuft);
      }
      break;
    case "long":
    case "bob":
    case "ponytails": {
      face.add(cap(1.07, Math.PI * 0.56));
      fringe(5, 1.4, 0.15, 0.45, hairMat);
      if (recipe.streak) {
        const s = part(new THREE.ConeGeometry(0.05, 0.16, 10), streakMat, 0.03);
        s.position.set(0.15, 0.08, 0.17);
        s.rotation.set(Math.PI - 0.4, 0, -0.5);
        face.add(s);
      }
      if (recipe.hair === "long") {
        const back = part(new THREE.CapsuleGeometry(headR * 0.88, 0.3, 8, 24), hairMat, 0.025);
        back.position.set(0, -0.2, -0.07);
        back.scale.set(1.05, 1, 0.55);
        face.add(back);
        for (const side of [-1, 1]) {
          const lock = part(new THREE.CapsuleGeometry(0.05, 0.24, 6, 12), hairMat, 0.03);
          lock.position.set(side * 0.22, -0.15, 0.06);
          lock.rotation.z = side * 0.08;
          face.add(lock);
          if (recipe.streak && side === 1) lock.material = streakMat;
        }
      } else if (recipe.hair === "bob") {
        // A shell around the sides and back down to the jaw, open at the face
        const bob = part(
          new THREE.SphereGeometry(headR * 1.1, 32, 20, Math.PI * 0.85, Math.PI * 1.3, Math.PI * 0.3, Math.PI * 0.42),
          toon(recipe.hairColor, { side: THREE.DoubleSide }), 0,
        );
        bob.position.set(0, -0.02, -0.01);
        bob.scale.set(1, 1.1, 0.98);
        face.add(bob);
      } else {
        for (const side of [-1, 1]) {
          const tie = at(new THREE.Mesh(keep(new THREE.SphereGeometry(0.035, 10, 8)), toon(theme)), side * 0.235, 0.06, -0.06);
          face.add(tie);
          const tail = part(new THREE.CapsuleGeometry(0.06, 0.22, 6, 12), hairMat, 0.03);
          tail.position.set(side * 0.31, -0.06, -0.08);
          tail.rotation.z = side * 0.55;
          face.add(tail);
        }
      }
      break;
    }
  }

  // Eyewear and headgear
  if (recipe.eyewear === "glasses" || recipe.eyewear === "thin_glasses") {
    const thick = recipe.eyewear === "glasses" ? 0.011 : 0.006;
    const rimMat = recipe.eyewear === "glasses" ? dark : toon(shade(theme, -0.1));
    const lensMat = keep(new THREE.MeshBasicMaterial({ color: 0xdfe8ff, transparent: true, opacity: 0.18, depthWrite: false }));
    for (const side of [-1, 1]) {
      const rim = at(new THREE.Mesh(keep(new THREE.TorusGeometry(0.056, thick, 8, 28)), rimMat), side * 0.09, -0.02, surf(0.09, -0.02) + 0.03);
      rim.rotation.y = side * 0.24;
      rim.scale.set(1.1, 0.88, 1);
      face.add(rim);
      const lens = at(new THREE.Mesh(keep(new THREE.CircleGeometry(0.054, 24)), lensMat), side * 0.09, -0.02, surf(0.09, -0.02) + 0.028);
      lens.rotation.y = side * 0.24;
      lens.scale.set(1.1, 0.88, 1);
      face.add(lens);
      const temple = at(new THREE.Mesh(keep(new THREE.BoxGeometry(thick * 1.4, thick * 1.4, 0.2)), rimMat), side * 0.205, -0.015, 0.1);
      temple.rotation.y = -side * 0.45;
      face.add(temple);
    }
    const bridge = at(new THREE.Mesh(keep(new THREE.CylinderGeometry(thick * 0.8, thick * 0.8, 0.05, 8)), rimMat), 0, -0.01, surf(0, -0.01) + 0.012);
    bridge.rotation.z = Math.PI / 2;
    face.add(bridge);
  } else if (recipe.eyewear === "visor") {
    const visor = at(
      new THREE.Mesh(keep(new THREE.CylinderGeometry(headR * 1.02, headR * 1.02, 0.07, 40, 1, true, -1.1, 2.2)), glow(theme, 0.85)),
      0, -0.015, 0,
    );
    face.add(visor);
    const band = at(part(new THREE.CylinderGeometry(headR * 1.0, headR * 1.0, 0.03, 40, 1, true, 1.1, Math.PI * 2 - 2.2), dark, 0.02), 0, -0.015, 0);
    face.add(band);
  }
  if (recipe.catHeadphones) {
    const band = at(part(new THREE.TorusGeometry(headR * 1.08, 0.018, 10, 40, Math.PI), toon("#f8fafc"), 0.03), 0, 0.02, -0.01);
    face.add(band);
    for (const side of [-1, 1]) {
      const cup = at(part(new THREE.CylinderGeometry(0.075, 0.075, 0.06, 22), toon("#f8fafc"), 0.03), side * headR * 1.06, -0.02, 0);
      cup.rotation.z = Math.PI / 2;
      face.add(cup);
      // The cup is turned on its side: its outer face is local -y on the right, +y on the left
      const light = at(new THREE.Mesh(keep(new THREE.CircleGeometry(0.045, 20)), glow(theme)), 0, -side * 0.032, 0);
      light.rotation.x = side > 0 ? Math.PI / 2 : -Math.PI / 2;
      cup.add(light);
      const ear = at(part(new THREE.ConeGeometry(0.06, 0.12, 4), toon("#f8fafc"), 0.03), side * 0.17, 0.25, 0);
      ear.rotation.z = -side * 0.35;
      face.add(ear);
      const inner = at(new THREE.Mesh(keep(new THREE.ConeGeometry(0.035, 0.07, 4)), glow(theme, 0.9)), 0, -0.01, 0.025);
      ear.add(inner);
    }
  }

  // ── Feature ring: the preset's third feature, orbiting glyphs at chest height ──
  const ring = at(new THREE.Group(), 0, hipY + 0.3, 0);
  group.add(ring);
  const ringBand = new THREE.Mesh(keep(new THREE.TorusGeometry(0.52, 0.004, 8, 96)), glow(theme, 0.55));
  ringBand.rotation.x = Math.PI / 2;
  ring.add(ringBand);
  const glyphs: THREE.Sprite[] = [];
  recipe.glyphs.forEach((g, i) => {
    const mat = keep(new THREE.SpriteMaterial({ map: keep(glyphTexture(g, theme)), transparent: true, depthWrite: false, toneMapped: false }));
    const s = new THREE.Sprite(mat);
    s.scale.set(0.16, 0.08, 1);
    s.userData.angle = (i / recipe.glyphs.length) * Math.PI * 2;
    ring.add(s);
    glyphs.push(s);
  });

  // ── Animation ──
  const cur: Pose = JSON.parse(JSON.stringify(POSES.all));
  const lerp = THREE.MathUtils.lerp;
  const toward = (a: ArmPose, b: ArmPose, k: number) => {
    a.x = lerp(a.x, b.x, k);
    a.z = lerp(a.z, b.z, k);
    a.foreX = lerp(a.foreX, b.foreX, k);
    a.foreZ = lerp(a.foreZ, b.foreZ, k);
  };
  const apply = (arm: { shoulder: THREE.Group; elbow: THREE.Group }, p: ArmPose, swing: number) => {
    arm.shoulder.rotation.set(p.x + swing, 0, p.z);
    arm.elbow.rotation.set(p.foreX, 0, p.foreZ);
  };
  let nextBlink = 2.5;

  const update = ({ elapsed, dimension, lookX, lookY, nod, follow }: CartoonFrame) => {
    const target = POSES[dimension] ?? POSES.all;
    const k = 0.08;
    cur.head = [lerp(cur.head[0], target.head[0], k), lerp(cur.head[1], target.head[1], k), lerp(cur.head[2], target.head[2], k)];
    cur.lean = lerp(cur.lean, target.lean, k);
    toward(cur.left, target.left, k);
    toward(cur.right, target.right, k);

    const breath = Math.sin(elapsed * 2.2);
    torso.scale.set(1.08 * (1 + breath * 0.012), 1 + breath * 0.012, 0.82 * (1 + breath * 0.018));
    body.position.y = hipY + breath * 0.004;
    body.rotation.x = cur.lean;
    body.rotation.z = Math.sin(elapsed * 0.9) * 0.012;
    const swing = Math.sin(elapsed * 1.1) * 0.025;
    apply(armL, cur.left, swing);
    apply(armR, cur.right, -swing);

    head.rotation.x = cur.head[0] + nod - (follow ? lookY * 0.18 : 0);
    head.rotation.y = cur.head[1] + (follow ? lookX * 0.32 : 0);
    head.rotation.z = cur.head[2] + Math.sin(elapsed * 0.7) * 0.02;

    // Blink every few seconds
    let lid = 1;
    if (elapsed > nextBlink) {
      const t = (elapsed - nextBlink) / 0.14;
      if (t >= 1) nextBlink = elapsed + 2.5 + ((elapsed * 7.31) % 2.5);
      else lid = Math.abs(t * 2 - 1) * 0.9 + 0.1;
    }
    for (const e of eyes) e.scale.y = lid;

    ring.rotation.y = elapsed * 0.35;
    ring.position.y = hipY + 0.3 + Math.sin(elapsed * 1.3) * 0.02;
    for (const s of glyphs) {
      const a = s.userData.angle as number;
      s.position.set(Math.cos(a) * 0.52, Math.sin(elapsed * 1.6 + a * 2) * 0.03, Math.sin(a) * 0.52);
      (s.material as THREE.SpriteMaterial).opacity = 0.55 + 0.45 * Math.max(0, Math.sin(a + elapsed * 0.35));
    }
  };
  update({ elapsed: 0, dimension: "all", lookX: 0, lookY: 0, nod: 0, follow: false });

  return {
    group,
    head: face,
    chest,
    update,
    dispose() {
      for (const d of disposables) d.dispose();
      group.removeFromParent();
    },
  };
}
