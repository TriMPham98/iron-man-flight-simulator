import * as THREE from 'three';
import { boneSpec } from '../../suit/rig';
import type { Suit } from '../../suit/Suit';
import { beam, box, frustum, glowMaterial, merge, paint } from '../combat/modelKit';
import { patchLogDepth } from '../render/depth';
import { hazeAll } from '../render/haze';
import type { SuitVariant } from './protocol';

/**
 * War Machine (Mk II) visual conversion for both the local rigged GLB suit
 * and the procedural shoulder weapons pack:
 *  - Re-tones the Mark III albedo atlas once into tactical gunmetal charcoal
 *    + brushed titanium silver (preserving all panel lines, scratches & AO)
 *  - Shifts the arc reactor / eye slits / repulsor emissive tint to War
 *    Machine's signature crimson-white glow
 *  - Mounts an articulated 6-barrel M134 rotary minigun on the right shoulder
 *    and a 6-tube micro-missile box pod on the left shoulder directly onto
 *    the `chest` bone so it flies, banks, and leans with the skeleton.
 */

export interface WarMachinePack {
  readonly root: THREE.Group;
  /** Articulated right-shoulder minigun turret pivot (yaw + pitch). */
  readonly turret: THREE.Group;
  /** Spinning 6-barrel cluster. */
  readonly barrels: THREE.Group;
  /** Muzzle flash glow sprite. */
  readonly muzzleGlow: THREE.Mesh;
}

const WM = {
  gunmetal: 0x3b424c,
  plate: 0x5c6674,
  silver: 0x9aa4b2,
  dark: 0x20252c,
  barrel: 0x2a2f37,
  accent: 0xb82820,
};

interface PackGeo {
  chassis: THREE.BufferGeometry;
  turretBody: THREE.BufferGeometry;
  barrels: THREE.BufferGeometry;
  muzzleGlow: THREE.BufferGeometry;
}

let packGeoCache: PackGeo | null = null;

function buildPackGeometry(): PackGeo {
  if (packGeoCache) return packGeoCache;

  // ── Dorsal ammo spine + left-shoulder 6-tube missile box pod ─────────
  // Authored in suit bind-space relative to chest bone origin (feet=0, +Z front, +X left, -X right)
  const chassisParts: THREE.BufferGeometry[] = [
    // Heavy dorsal ammo drum & armored spine housing
    frustum({ hw0: 0.14, z0: -0.10, z1: -0.24, y0: -0.14, hw1: 0.17, z2: -0.11, z3: -0.27, y1: 0.14 }, (e) =>
      e === 2 ? WM.plate : WM.gunmetal,
    ),
    // Metallic spine rib & warning stripe
    box(0.08, 0.24, 0.04, WM.silver, 0, 0.0, -0.275),
    box(0.18, 0.03, 0.04, WM.accent, 0, 0.08, -0.27),
    // Right-shoulder articulated servo pylon (supports M134 turret at x = -0.23, y = 0.28, z = -0.06)
    beam([-0.14, 0.08, -0.19], [-0.23, 0.24, -0.13], 0.028, WM.dark, 6),
    beam([-0.11, 0.02, -0.21], [-0.21, 0.20, -0.15], 0.02, WM.silver, 6),
    box(0.08, 0.07, 0.09, WM.plate, -0.23, 0.24, -0.12),
    // Left-shoulder angled micro-missile box pod (+X side)
    beam([0.14, 0.08, -0.18], [0.22, 0.21, -0.09], 0.024, WM.dark, 6),
    box(0.14, 0.12, 0.22, WM.gunmetal, 0.23, 0.23, -0.07),
    box(0.15, 0.03, 0.20, WM.silver, 0.23, 0.295, -0.07),
    box(0.142, 0.025, 0.06, WM.accent, 0.23, 0.23, 0.01),
  ];
  // 6 recessed missile tube caps on the front of the left pod
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      chassisParts.push(
        paint(
          new THREE.CylinderGeometry(0.015, 0.015, 0.02, 8)
            .rotateX(Math.PI / 2)
            .translate(0.19 + col * 0.04, 0.205 + row * 0.045, 0.045),
          WM.dark,
        ),
      );
    }
  }

  // ── Right-shoulder M134 receiver & ammo feed chute (turret local space) ──
  const turretParts: THREE.BufferGeometry[] = [
    // Main receiver housing
    box(0.11, 0.11, 0.28, WM.gunmetal, 0, 0, -0.02),
    box(0.12, 0.035, 0.20, WM.silver, 0, 0.055, -0.03),
    // Red tactical stripe on receiver flank
    box(0.116, 0.02, 0.08, WM.accent, 0, 0.01, 0.04),
    // Side drum ammo chute
    box(0.05, 0.08, 0.14, WM.dark, 0.07, -0.02, -0.05),
    // Optical target sensor pod on top of receiver
    box(0.045, 0.04, 0.07, WM.dark, -0.03, 0.085, 0.03),
  ];

  // ── 6-barrel rotary cluster (spins around +Z) ──
  const barrelParts: THREE.BufferGeometry[] = [];
  const barrelRadius = 0.03;
  const barrelLen = 0.44;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    barrelParts.push(
      paint(
        new THREE.CylinderGeometry(0.008, 0.008, barrelLen, 6)
          .rotateX(Math.PI / 2)
          .translate(Math.cos(a) * barrelRadius, Math.sin(a) * barrelRadius, barrelLen * 0.5),
        WM.barrel,
      ),
    );
  }
  // Barrel clamp collars
  for (const z of [0.08, 0.26, 0.41]) {
    barrelParts.push(
      paint(
        new THREE.CylinderGeometry(0.042, 0.042, 0.022, 12)
          .rotateX(Math.PI / 2)
          .translate(0, 0, z),
        WM.silver,
      ),
    );
  }

  // Muzzle flash star at barrel tip
  const muzzleGlow = paint(
    new THREE.ConeGeometry(0.045, 0.16, 8).rotateX(Math.PI / 2).translate(0, 0, 0.52),
    new THREE.Color(1.0, 0.72, 0.28),
    5,
  );

  packGeoCache = {
    chassis: merge(chassisParts),
    turretBody: merge(turretParts),
    barrels: merge(barrelParts),
    muzzleGlow,
  };
  return packGeoCache;
}

/** Build a War Machine dorsal weapon pack (positioned relative to the `chest` bone). */
export function buildWarMachinePack(hazeUniforms?: Record<string, THREE.IUniform>): WarMachinePack {
  const g = buildPackGeometry();
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    metalness: 0.78,
    roughness: 0.34,
  });
  const glowMat = glowMaterial();

  const root = new THREE.Group();
  root.name = 'warmachine-pack';

  const chassis = new THREE.Mesh(g.chassis, mat);
  chassis.castShadow = true;
  chassis.receiveShadow = true;
  root.add(chassis);

  const turret = new THREE.Group();
  turret.position.set(-0.23, 0.28, -0.05);
  const receiver = new THREE.Mesh(g.turretBody, mat);
  receiver.castShadow = true;
  turret.add(receiver);

  const barrels = new THREE.Group();
  barrels.position.set(0, 0, 0.11);
  const barrelMesh = new THREE.Mesh(g.barrels, mat);
  barrelMesh.castShadow = true;
  barrels.add(barrelMesh);
  turret.add(barrels);

  const muzzleGlow = new THREE.Mesh(g.muzzleGlow, glowMat);
  muzzleGlow.visible = false;
  turret.add(muzzleGlow);

  root.add(turret);
  patchLogDepth(root);
  if (hazeUniforms) hazeAll(root, hazeUniforms);

  return { root, turret, barrels, muzzleGlow };
}

/**
 * Generate a gunmetal / brushed-silver War Machine albedo CanvasTexture from
 * the Mark III's red/gold texture so every panel line and bevel survives intact.
 */
const recolorCache = new WeakMap<THREE.Texture, THREE.Texture>();

function warMachineTexture(src: THREE.Texture): THREE.Texture {
  const cached = recolorCache.get(src);
  if (cached) return cached;
  if (typeof document === 'undefined' || !src.image) return src;

  const img = src.image as { width?: number; height?: number };
  const w = Number(img.width) || 0;
  const h = Number(img.height) || 0;
  if (w < 2 || h < 2) return src;

  try {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return src;
    ctx.drawImage(img as CanvasImageSource, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h);
    const px = data.data;

    for (let i = 0; i < px.length; i += 4) {
      const r = px[i] / 255;
      const g = px[i + 1] / 255;
      const b = px[i + 2] / 255;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max > 1e-4 ? (max - min) / max : 0;

      // Classify gold vs crimson plates on the Mk III atlas:
      //  - Gold has high G relative to R -> brushed titanium silver
      //  - Red has high R, low G -> tactical matte gunmetal charcoal
      const isGold = sat > 0.22 && r > 0.25 && g > r * 0.52 && b < g * 0.85;
      const isRed = sat > 0.25 && r > g * 1.45 && r > b * 1.45;

      let outR: number;
      let outG: number;
      let outB: number;
      if (isGold) {
        // Brushed titanium silver (Mk II silver trim)
        const v = Math.min(1, 0.22 + lum * 0.92);
        outR = v * 0.95;
        outG = v * 0.99;
        outB = v * 1.05;
      } else if (isRed) {
        // Dark tactical gunmetal charcoal
        const v = Math.min(1, 0.08 + lum * 0.56);
        outR = v * 0.92;
        outG = v * 0.98;
        outB = v * 1.08;
      } else {
        // Neutral dark steel/carbon
        const v = Math.min(1, lum * 0.88);
        outR = v * 0.94;
        outG = v * 0.98;
        outB = v * 1.05;
      }

      px[i] = Math.min(255, Math.round(outR * 255));
      px[i + 1] = Math.min(255, Math.round(outG * 255));
      px[i + 2] = Math.min(255, Math.round(outB * 255));
    }

    ctx.putImageData(data, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = src.colorSpace;
    tex.flipY = src.flipY;
    tex.wrapS = src.wrapS;
    tex.wrapT = src.wrapT;
    tex.needsUpdate = true;
    recolorCache.set(src, tex);
    return tex;
  } catch {
    return src;
  }
}

interface SavedSuitMaterial {
  map: THREE.Texture | null;
  color: THREE.Color;
  emissive: THREE.Color;
  metalness: number;
  roughness: number;
}

interface LocalVariantState {
  variant: SuitVariant;
  pack: WarMachinePack;
  saved: Map<THREE.MeshStandardMaterial, SavedSuitMaterial>;
}

const suitStates = new WeakMap<Suit, LocalVariantState>();

/**
 * Switch the local player's rigged `Suit` between Iron Man Mk III and
 * War Machine Mk II at runtime (idempotent & non-destructive).
 */
export function applyLocalSuitVariant(
  suit: Suit,
  variant: SuitVariant,
  hazeUniforms?: Record<string, THREE.IUniform>,
): WarMachinePack {
  let state = suitStates.get(suit);
  if (!state) {
    const saved = new Map<THREE.MeshStandardMaterial, SavedSuitMaterial>();
    suit.forEachMesh((m) => {
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        const std = mat as THREE.MeshStandardMaterial;
        if (!std || !std.isMeshStandardMaterial || saved.has(std)) continue;
        // Skip interior dark cavity / unmapped auxiliary meshes without albedo map
        if (!std.map && !std.emissiveMap) continue;
        saved.set(std, {
          map: std.map,
          color: std.color.clone(),
          emissive: std.emissive.clone(),
          metalness: std.metalness,
          roughness: std.roughness,
        });
      }
    });

    const pack = buildWarMachinePack(hazeUniforms);
    // Attach directly to the chest bone so it follows every bank, lean & crouch.
    const ch = boneSpec('chest').head;
    pack.root.position.set(0 - ch[0], 1.38 - ch[1], 0 - ch[2]);
    pack.root.visible = false;
    suit.rig.bones.chest.add(pack.root);

    state = { variant: 'ironman', pack, saved };
    suitStates.set(suit, state);
  }

  if (state.variant === variant) return state.pack;
  state.variant = variant;

  const isWM = variant === 'warmachine';
  state.pack.root.visible = isWM;

  for (const [mat, orig] of state.saved) {
    if (isWM) {
      if (orig.map) mat.map = warMachineTexture(orig.map);
      mat.color.setHex(0xffffff);
      mat.metalness = Math.min(1, Math.max(orig.metalness, 0.78));
      mat.roughness = Math.min(1, orig.roughness * 1.08);
      // Shift Mk III cyan/warm-eye glow -> War Machine tactical crimson-white glow
      if (mat.emissiveMap) {
        mat.emissive.setRGB(1.85, 0.45, 0.32);
      }
    } else {
      mat.map = orig.map;
      mat.color.copy(orig.color);
      mat.emissive.copy(orig.emissive);
      mat.metalness = orig.metalness;
      mat.roughness = orig.roughness;
    }
    mat.needsUpdate = true;
  }

  return state.pack;
}
