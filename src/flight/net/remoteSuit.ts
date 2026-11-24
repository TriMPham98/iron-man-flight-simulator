import * as THREE from 'three';
import type { Particles } from '../fx/particles';
import { patchLogDepth } from '../render/depth';
import { hazeAll } from '../render/haze';
import { beam, bolts, box, chamfer, cyl, frustum, glowMaterial, loft, merge, paint, slats, type V3 } from '../combat/modelKit';
import { FLIGHT_POSTURE } from '../sim/flightModel';
import { SPEED_OF_SOUND } from '../world/config';
import { SuitFlag, type SuitNetState, type SuitVariant } from './protocol';
import { animateWarMachinePack, buildWarMachinePack, type WarMachinePack } from './suitVisuals';

/**
 * The remote pilot's powered-armor suit in 3D space (Iron Man Mk III or
 * War Machine Mk II):
 *  - Smooth high-speed dead reckoning + exponential error convergence so
 *    supersonic Mach 1.5 flight stays fluid over 20–30 Hz updates
 *  - Full articulated body language (hover upright <-> prone supersonic flight,
 *    banking roll, arm aim/repulsor stance, War Machine shoulder minigun aim
 *    & barrel spin, twin boot jet cones + nozzle flares + Mach vapor wisps)
 *  - Ground/ocean floor clearance guard so extrapolation never dips underground.
 */

interface SuitPalette {
  armor: number;
  plate: number;
  dark: number;
  joint: number;
  accent: number;
  trim: number;
  reactorGlow: THREE.Color;
  visorGlow: THREE.Color;
  palmGlow: THREE.Color;
  plumeColor: number;
  spriteColor: number;
}

const PALETTES: Record<SuitVariant, SuitPalette> = {
  ironman: {
    armor: 0x8f1512,
    plate: 0xb01b16,
    dark: 0x5c0e0c,
    joint: 0x26282e,
    accent: 0xc99c38,
    trim: 0xa67c24,
    reactorGlow: new THREE.Color(0.45, 0.92, 1.0),
    visorGlow: new THREE.Color(1.0, 0.94, 0.72),
    palmGlow: new THREE.Color(0.55, 0.92, 1.0),
    plumeColor: 0x7fc4ff,
    spriteColor: 0x9fdcff,
  },
  warmachine: {
    armor: 0x444c57,
    plate: 0x5b6471,
    dark: 0x22272f,
    joint: 0x15181d,
    accent: 0x858e9a,
    trim: 0xb82820,
    reactorGlow: new THREE.Color(1.0, 0.34, 0.18),
    visorGlow: new THREE.Color(1.0, 0.25, 0.15),
    palmGlow: new THREE.Color(1.0, 0.56, 0.28),
    plumeColor: 0xff8442,
    spriteColor: 0xff9b54,
  },
};

interface SuitGeo {
  torso: THREE.BufferGeometry;
  torsoGlow: THREE.BufferGeometry;
  armL: THREE.BufferGeometry;
  armLGlow: THREE.BufferGeometry;
  armR: THREE.BufferGeometry;
  armRGlow: THREE.BufferGeometry;
}

const geoCache = new Map<SuitVariant, SuitGeo>();

function buildSuitGeo(variant: SuitVariant): SuitGeo {
  const existing = geoCache.get(variant);
  if (existing) return existing;

  const C = PALETTES[variant];
  const bulk = variant === 'warmachine' ? 1.07 : 1.0;
  const torso: THREE.BufferGeometry[] = [];
  const torsoGlow: THREE.BufferGeometry[] = [];

  // ── Helmet (+0.74 … +1.08, pelvis at y = 0, boots at y = -0.96, total ~2.04 m) ──
  const headRing = (y: number, w: number, fz: number, bz: number): V3[] => [
    [0, y, fz],
    [w * 0.72, y, fz * 0.68],
    [w, y, 0.01],
    [w * 0.75, y, bz * 0.75],
    [0, y, bz],
    [-w * 0.75, y, bz * 0.75],
    [-w, y, 0.01],
    [-w * 0.72, y, fz * 0.68],
  ];
  torso.push(
    loft(
      [
        headRing(0.74, 0.09, 0.125, -0.095),
        headRing(0.85, 0.118, 0.145, -0.12),
        headRing(0.97, 0.112, 0.135, -0.125),
        headRing(1.06, 0.06, 0.065, -0.075),
      ],
      (e, s) => {
        if (s === 1 && (e === 0 || e === 7)) return C.accent;
        if (s >= 2) return C.plate;
        return C.armor;
      },
    ),
    box(0.105, 0.05, 0.065, C.accent, 0, 0.79, 0.11),
    paint(new THREE.CylinderGeometry(0.08, 0.10, 0.11, 10).translate(0, 0.69, 0), C.joint),
  );
  for (const s of [-1, 1]) {
    torsoGlow.push(
      paint(
        new THREE.BoxGeometry(0.05, 0.016, 0.02).rotateZ(-s * 0.14).translate(s * 0.038, 0.91, 0.142),
        C.visorGlow,
        6,
      ),
    );
  }

  // ── Chest & Torso ──
  torso.push(
    frustum(
      {
        hw0: 0.165 * bulk,
        z0: 0.12 * bulk,
        z1: -0.11 * bulk,
        y0: 0.14,
        hw1: 0.275 * bulk,
        z2: 0.175 * bulk,
        z3: -0.155 * bulk,
        y1: 0.63,
      },
      (e, s) => {
        if (s < 0) return C.dark;
        if (e === 0) return C.plate;
        if (e === 2) return C.dark;
        return C.armor;
      },
    ),
    box(0.165 * bulk, 0.15, 0.065, C.plate, -0.13 * bulk, 0.46, 0.155 * bulk),
    box(0.165 * bulk, 0.15, 0.065, C.plate, 0.13 * bulk, 0.46, 0.155 * bulk),
    box(0.42 * bulk, 0.045, 0.20, C.accent, 0, 0.64, -0.01),
    frustum({ hw0: 0.175, z0: 0.12, z1: -0.11, y0: -0.04, hw1: 0.16, z2: 0.11, z3: -0.10, y1: 0.15 }, C.dark),
    box(0.22, 0.038, 0.21, C.accent, 0, 0.06, 0.01),
    frustum({ hw0: 0.13, z0: 0.10, z1: -0.095, y0: -0.15, hw1: 0.195, z2: 0.13, z3: -0.12, y1: -0.02 }, C.armor),
  );
  // Chest Arc Reactor
  torso.push(paint(new THREE.TorusGeometry(0.078, 0.016, 6, 12).translate(0, 0.42, 0.188 * bulk), C.dark));
  torsoGlow.push(paint(new THREE.CircleGeometry(0.066, 12).translate(0, 0.42, 0.196 * bulk), C.reactorGlow, 7));

  // Pauldrons & dorsal flaps (War Machine gets its own layered armour below)
  for (const s of [-1, 1]) {
    if (variant === 'warmachine') {
      torso.push(box(0.03, 0.36, 0.18, C.dark, s * 0.11, 0.42, -0.2));
      continue;
    }
    torso.push(
      frustum(
        {
          x: s * 0.31 * bulk,
          hw0: 0.10 * bulk,
          z0: 0.14,
          z1: -0.14,
          y0: 0.50,
          hw1: 0.085 * bulk,
          z2: 0.11,
          z3: -0.13,
          y1: 0.70,
        },
        (e) => (e === 0 ? C.accent : C.plate),
      ),
      box(0.03, 0.36, 0.18, C.dark, s * 0.11, 0.42, -0.20),
    );
  }

  // ── Legs & Thruster Boots (-0.96 … -0.10) ──
  const legRing = (x: number, y: number, rx: number, rz: number): V3[] => [
    [x, y, rz],
    [x + rx, y, 0],
    [x, y, -rz],
    [x - rx, y, 0],
  ];
  for (const s of [-1, 1]) {
    const x = s * 0.145;
    torso.push(
      loft(
        [
          legRing(x, -0.09, 0.105 * bulk, 0.115 * bulk),
          legRing(x * 1.02, -0.31, 0.095 * bulk, 0.105 * bulk),
          legRing(x * 1.03, -0.51, 0.078 * bulk, 0.088 * bulk),
        ],
        (e) => (e === 0 || e === 3 ? C.accent : C.armor),
      ),
      box(0.11, 0.115, 0.12, C.plate, x * 1.03, -0.52, 0.045),
      loft(
        [
          legRing(x * 1.03, -0.53, 0.078 * bulk, 0.088 * bulk),
          legRing(x * 1.04, -0.74, 0.086 * bulk, 0.096 * bulk),
          legRing(x * 1.05, -0.92, 0.074 * bulk, 0.084 * bulk),
        ],
        (e) => (e === 0 || e === 3 ? C.plate : C.dark),
      ),
      box(0.135, 0.08, 0.24, C.dark, x * 1.05, -0.93, 0.04),
      box(0.12, 0.035, 0.16, C.accent, x * 1.05, -0.89, 0.07),
      beam([x * 1.03, -0.56, -0.09], [x * 1.05, -0.90, -0.10], 0.02, C.trim, 4),
    );
    torsoGlow.push(
      paint(new THREE.CircleGeometry(0.062, 10).rotateX(Math.PI / 2).translate(x * 1.05, -0.972, -0.01), C.palmGlow, 6),
    );
  }

  if (variant === 'warmachine') warMachineArmor(C, bulk, torso);

  // ── Articulated Arms ──
  const makeArm = (side: -1 | 1): { body: THREE.BufferGeometry; glow: THREE.BufferGeometry } => {
    const parts: THREE.BufferGeometry[] = [
      paint(new THREE.IcosahedronGeometry(0.078, 0), C.joint),
      box(0.115 * bulk, 0.25, 0.125 * bulk, C.accent, side * 0.02, -0.15, 0),
      box(0.10, 0.08, 0.11, C.dark, side * 0.02, -0.29, -0.01),
      frustum(
        {
          x: side * 0.02,
          hw0: 0.064 * bulk,
          z0: 0.07,
          z1: -0.07,
          y0: -0.55,
          hw1: 0.072 * bulk,
          z2: 0.076,
          z3: -0.076,
          y1: -0.31,
        },
        (e) => (e === 0 ? C.plate : C.armor),
      ),
      box(0.085, 0.085, 0.095, C.plate, side * 0.02, -0.59, 0.01),
    ];
    if (variant === 'warmachine') {
      parts.push(
        // Outer bicep plate, elbow cap and the gauntlet's knuckle guard
        chamfer(0.022, 0.17, 0.11, 0.007, C.armor, side * 0.093, -0.15, 0),
        box(0.006, 0.12, 0.012, C.trim, side * 0.105, -0.15, 0.03),
        cyl(0.042, 0.042, 0.022, 12, C.accent, 'x', side * 0.082, -0.295, -0.005),
        cyl(0.02, 0.02, 0.026, 8, C.dark, 'x', side * 0.09, -0.295, -0.005),
        chamfer(0.09, 0.03, 0.07, 0.008, C.plate, side * 0.02, -0.6, 0.045),
        ...slats(3, 0.07, 0.006, 0.004, 0.012, C.dark, side * 0.02, -0.4, 0.083),
      );
    }
    const glow = paint(
      new THREE.CircleGeometry(0.04, 10).rotateX(Math.PI / 2).translate(side * 0.02, -0.635, 0.01),
      C.palmGlow,
      6,
    );
    return { body: merge(parts), glow };
  };

  const left = makeArm(1);
  const right = makeArm(-1);

  const built: SuitGeo = {
    torso: merge(torso),
    torsoGlow: merge(torsoGlow),
    armL: left.body,
    armLGlow: left.glow,
    armR: right.body,
    armRGlow: right.glow,
  };
  geoCache.set(variant, built);
  return built;
}

/**
 * War Machine's heavier plate over the shared body: layered pauldrons, pec
 * and abdominal plates, a raised collar, thigh / knee / shin armour, calf
 * thruster housings and the faceplate's grille and ear discs.
 */
function warMachineArmor(C: SuitPalette, bulk: number, out: THREE.BufferGeometry[]): void {
  // Helmet: faceplate grille, brow ridge and ear discs
  out.push(
    ...slats(3, 0.06, 0.005, 0.008, 0.013, C.dark, 0, 0.795, 0.137),
    chamfer(0.15, 0.022, 0.03, 0.008, C.plate, 0, 0.965, 0.115),
    cyl(0.034, 0.034, 0.022, 12, C.accent, 'x', 0.118, 0.88, -0.005),
    cyl(0.034, 0.034, 0.022, 12, C.accent, 'x', -0.118, 0.88, -0.005),
    // Raised armoured collar
    loft(
      [
        [[0.13, 0.62, 0.11], [0.15, 0.62, 0], [0.13, 0.62, -0.12], [-0.13, 0.62, -0.12], [-0.15, 0.62, 0], [-0.13, 0.62, 0.11]],
        [[0.11, 0.69, 0.09], [0.13, 0.69, 0], [0.11, 0.69, -0.1], [-0.11, 0.69, -0.1], [-0.13, 0.69, 0], [-0.11, 0.69, 0.09]],
      ],
      (e) => (e === 5 || e === 0 ? C.plate : C.armor),
    ),
  );
  // Chest: pecs either side of the reactor, silver lower edges, abdominal bands, belt buckle
  for (const s of [-1, 1]) {
    out.push(
      chamfer(0.13, 0.1, 0.03, 0.014, C.plate, s * 0.118, 0.54, 0.183 * bulk),
      box(0.11, 0.01, 0.012, C.accent, s * 0.118, 0.487, 0.193 * bulk),
      ...bolts([s * 0.06, 0.575, 0.2 * bulk], [s * 0.17, 0.575, 0.2 * bulk], 2, 'z', C.accent),
      ...slats(3, 0.006, 0.012, 0.09, 0.03, C.dark, s * 0.265 * bulk, 0.48, 0.0, 'y'),
    );
  }
  for (let i = 0; i < 3; i++) {
    const y = 0.2 + i * 0.058;
    out.push(chamfer(0.2 - i * 0.012 + 0.03, 0.046, 0.03, 0.01, i === 1 ? C.plate : C.armor, 0, y, (0.135 + i * 0.008) * bulk));
  }
  out.push(chamfer(0.065, 0.05, 0.024, 0.008, C.dark, 0, 0.06, 0.12), box(0.03, 0.008, 0.006, C.trim, 0, 0.06, 0.133));

  // Layered pauldrons
  for (const s of [-1, 1]) {
    const x = s * 0.36 * bulk;
    out.push(
      chamfer(0.18, 0.06, 0.27, 0.024, C.plate, x, 0.705, 0),
      chamfer(0.19, 0.05, 0.25, 0.02, C.armor, x + s * 0.008, 0.655, 0),
      chamfer(0.17, 0.045, 0.22, 0.018, C.dark, x + s * 0.012, 0.612, 0),
      box(0.006, 0.028, 0.18, C.accent, x + s * 0.105, 0.655, 0),
      box(0.045, 0.012, 0.008, C.trim, x, 0.712, 0.136),
      ...bolts([x - 0.06, 0.737, -0.09], [x + 0.06, 0.737, -0.09], 3, 'y', C.accent),
    );
  }

  // Legs: thigh plates, knee caps, shin plates, calf thruster housings
  for (const s of [-1, 1]) {
    const x = s * 0.145;
    out.push(
      chamfer(0.11, 0.17, 0.028, 0.012, C.plate, x * 1.02, -0.27, 0.112 * bulk),
      box(0.006, 0.13, 0.008, C.accent, x * 1.02 + s * 0.04, -0.27, 0.128 * bulk),
      chamfer(0.022, 0.16, 0.1, 0.007, C.armor, x * 1.02 + s * 0.1 * bulk, -0.29, 0),
      chamfer(0.09, 0.08, 0.03, 0.013, C.armor, x * 1.03, -0.52, 0.112),
      cyl(0.016, 0.016, 0.008, 8, C.accent, 'z', x * 1.03, -0.52, 0.13),
      chamfer(0.08, 0.2, 0.024, 0.01, C.plate, x * 1.04, -0.73, 0.106 * bulk),
      ...slats(3, 0.05, 0.005, 0.004, 0.016, C.dark, x * 1.04, -0.66, 0.122 * bulk),
      chamfer(0.08, 0.15, 0.04, 0.012, C.dark, x * 1.04, -0.72, -0.105 * bulk),
      cyl(0.016, 0.02, 0.02, 8, C.joint, 'y', x * 1.04, -0.8, -0.11 * bulk),
    );
  }
}

let sharedPlumeTex: THREE.Texture | null = null;
function plumeTexture(): THREE.Texture {
  if (sharedPlumeTex) return sharedPlumeTex;
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext?.('2d');
    if (g) {
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.28, 'rgba(210,235,255,0.85)');
      grad.addColorStop(0.65, 'rgba(120,185,255,0.25)');
      grad.addColorStop(1, 'rgba(60,120,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
      sharedPlumeTex = new THREE.CanvasTexture(c);
      sharedPlumeTex.colorSpace = THREE.SRGBColorSpace;
      return sharedPlumeTex;
    }
  }
  sharedPlumeTex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  sharedPlumeTex.needsUpdate = true;
  return sharedPlumeTex;
}

let sharedConeGeo: THREE.BufferGeometry | null = null;
function coneGeo(): THREE.BufferGeometry {
  if (sharedConeGeo) return sharedConeGeo;
  const g = new THREE.ConeGeometry(0.095, 1.0, 10, 1, true);
  g.rotateX(Math.PI);
  g.translate(0, -0.5, 0);
  sharedConeGeo = g;
  return g;
}

let sharedGlowMat: THREE.MeshStandardMaterial | null = null;

export interface RemoteSurfaceQuery {
  surface(x: number, z: number): number;
}

const TELEPORT_SNAP_DIST = 140;

export class RemoteSuit {
  readonly id: string;
  callsign: string;
  variant: SuitVariant;

  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly aim = new THREE.Vector3(0, 0, 1);
  heading = 0;
  pitch = 0;
  roll = 0;
  flightness = 0;
  thrust = 0;
  armor = 1;
  reserves = 1;
  flags = 0;

  /** Root mesh added to the flight scene. */
  readonly mesh = new THREE.Group();

  private readonly body = new THREE.Group();
  private readonly visualRoot = new THREE.Group();
  private armL = new THREE.Group();
  private armR = new THREE.Group();
  private bootPlumes: [THREE.Sprite, THREE.Sprite] | null = null;
  private bootCones: [THREE.Mesh, THREE.Mesh] | null = null;
  private palmPlumes: [THREE.Sprite, THREE.Sprite] | null = null;
  private wmPack: WarMachinePack | null = null;

  // Target state for smooth high-speed dead reckoning
  private readonly tgtPos = new THREE.Vector3();
  private readonly tgtVel = new THREE.Vector3();
  private readonly tgtAim = new THREE.Vector3(0, 0, 1);
  private tgtHeading = 0;
  private tgtPitch = 0;
  private tgtRoll = 0;
  private tgtFlightness = 0;
  private tgtThrust = 0;
  private hasState = false;
  private lastPacketAge = 0;
  private time = 0;
  private vaporT = 0;
  private posture = 0;

  private readonly hazeUniforms?: Record<string, THREE.IUniform>;
  private readonly _dir = new THREE.Vector3();
  private readonly _invQ = new THREE.Quaternion();

  constructor(id: string, variant: SuitVariant, callsign: string, hazeUniforms?: Record<string, THREE.IUniform>) {
    this.id = id;
    this.variant = variant;
    this.callsign = callsign;
    this.hazeUniforms = hazeUniforms;
    this.mesh.name = `remote-suit-${id}`;
    this.mesh.add(this.body);
    this.body.add(this.visualRoot);
    this.rebuildVisuals(variant);
  }

  get grounded(): boolean {
    return (this.flags & SuitFlag.GROUNDED) !== 0;
  }

  get boosting(): boolean {
    return (this.flags & SuitFlag.BOOSTING) !== 0;
  }

  get firing(): boolean {
    return (this.flags & SuitFlag.FIRING) !== 0;
  }

  get unibeam(): boolean {
    return (this.flags & SuitFlag.UNIBEAM) !== 0;
  }

  get down(): boolean {
    return (this.flags & SuitFlag.DOWN) !== 0;
  }

  get speed(): number {
    return this.vel.length();
  }

  get mach(): number {
    return this.speed / SPEED_OF_SOUND;
  }

  /** Switch visual skin between Iron Man Mk III and War Machine Mk II live. */
  setVariant(variant: SuitVariant, callsign?: string): void {
    if (callsign) this.callsign = callsign;
    if (this.variant === variant) return;
    this.variant = variant;
    this.rebuildVisuals(variant);
  }

  private rebuildVisuals(variant: SuitVariant): void {
    this.visualRoot.clear();
    this.wmPack = null;

    const pal = PALETTES[variant];
    const g = buildSuitGeo(variant);
    const bodyMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      metalness: variant === 'warmachine' ? 0.76 : 0.7,
      roughness: variant === 'warmachine' ? 0.34 : 0.28,
    });
    const glowMat = (sharedGlowMat ??= glowMaterial());

    this.visualRoot.add(new THREE.Mesh(g.torso, bodyMat), new THREE.Mesh(g.torsoGlow, glowMat));

    this.armL = new THREE.Group();
    this.armL.position.set(0.33, 0.52, 0.01);
    this.armL.add(new THREE.Mesh(g.armL, bodyMat), new THREE.Mesh(g.armLGlow, glowMat));

    this.armR = new THREE.Group();
    this.armR.position.set(-0.33, 0.52, 0.01);
    this.armR.add(new THREE.Mesh(g.armR, bodyMat), new THREE.Mesh(g.armRGlow, glowMat));
    this.visualRoot.add(this.armL, this.armR);

    if (variant === 'warmachine') {
      this.wmPack = buildWarMachinePack(this.hazeUniforms);
      // Align dorsal pack to RemoteSuit torso coordinates (chest centre ~ y = 0.44)
      this.wmPack.root.position.set(0, 0.5, -0.02);
      this.visualRoot.add(this.wmPack.root);
      // Attach twin forearm gauntlet weapon pods to RemoteSuit forearms
      this.wmPack.wristL.root.position.set(0.085, -0.42, 0.0);
      this.wmPack.wristL.root.rotation.set(0, 0, Math.PI);
      this.wmPack.wristL.root.visible = true;
      this.armL.add(this.wmPack.wristL.root);
      this.wmPack.wristR.root.position.set(-0.085, -0.42, 0.0);
      this.wmPack.wristR.root.rotation.set(0, Math.PI, Math.PI);
      this.wmPack.wristR.root.visible = true;
      this.armR.add(this.wmPack.wristR.root);
    }

    const tex = plumeTexture();
    const makeSprite = (size: number) => {
      const sp = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: tex,
          color: pal.spriteColor,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      sp.scale.setScalar(size);
      return sp;
    };

    const plumeMat = new THREE.MeshBasicMaterial({
      color: pal.plumeColor,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    const bootL = makeSprite(1.1);
    bootL.position.set(0.15, -1.06, -0.01);
    const bootR = makeSprite(1.1);
    bootR.position.set(-0.15, -1.06, -0.01);
    const coneL = new THREE.Mesh(coneGeo(), plumeMat);
    coneL.position.set(0.15, -0.96, -0.01);
    const coneR = new THREE.Mesh(coneGeo(), plumeMat);
    coneR.position.set(-0.15, -0.96, -0.01);
    this.visualRoot.add(bootL, bootR, coneL, coneR);
    this.bootPlumes = [bootL, bootR];
    this.bootCones = [coneL, coneR];

    const palmL = makeSprite(0.45);
    palmL.position.set(0.02, -0.68, 0.01);
    const palmR = makeSprite(0.45);
    palmR.position.set(-0.02, -0.68, 0.01);
    this.armL.add(palmL);
    this.armR.add(palmR);
    this.palmPlumes = [palmL, palmR];

    patchLogDepth(this.visualRoot);
    if (this.hazeUniforms) hazeAll(this.visualRoot, this.hazeUniforms);
  }

  /** Apply an incoming binary kinematic snapshot from the network. */
  applySnapshot(s: SuitNetState): void {
    this.flags = s.flags;
    this.armor = s.armor;
    this.reserves = s.reserves;
    this.tgtPos.set(s.px, s.py, s.pz);
    this.tgtVel.set(s.vx, s.vy, s.vz);
    this.tgtAim.set(s.ax, s.ay, s.az);
    if (this.tgtAim.lengthSq() > 1e-4) this.tgtAim.normalize();
    this.tgtHeading = s.heading;
    this.tgtPitch = s.pitch;
    this.tgtRoll = s.roll;
    this.tgtFlightness = THREE.MathUtils.clamp(s.flightness, 0, 1);
    this.tgtThrust = Math.max(0, s.thrust);
    this.lastPacketAge = 0;

    // First packet or large teleport (e.g., reset to pad): snap immediately
    if (!this.hasState || this.pos.distanceTo(this.tgtPos) > TELEPORT_SNAP_DIST) {
      this.hasState = true;
      this.pos.copy(this.tgtPos);
      this.vel.copy(this.tgtVel);
      this.aim.copy(this.tgtAim);
      this.heading = this.tgtHeading;
      this.pitch = this.tgtPitch;
      this.roll = this.tgtRoll;
      this.flightness = this.tgtFlightness;
      this.thrust = this.tgtThrust;
      this.posture = this.flightness * FLIGHT_POSTURE;
      this.mesh.position.copy(this.pos);
    }
  }

  /** Advance dead reckoning, articulation, plumes, and floor clearance. */
  update(dt: number, ground?: RemoteSurfaceQuery, particles?: Particles): void {
    if (!this.hasState) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    this.time += dt;
    this.lastPacketAge += dt;

    // Advance target via dead reckoning up to 0.35 s past the last packet
    const drDt = this.lastPacketAge < 0.35 ? dt : 0;
    if (drDt > 0) {
      this.tgtPos.addScaledVector(this.tgtVel, drDt);
    }

    // Blend rendered state onto dead-reckoned target smoothly
    const posAlpha = 1 - Math.exp(-dt * 14);
    const velAlpha = 1 - Math.exp(-dt * 16);
    const angAlpha = 1 - Math.exp(-dt * 14);

    this.vel.lerp(this.tgtVel, velAlpha);
    this.pos.addScaledVector(this.vel, dt);
    this.pos.lerp(this.tgtPos, posAlpha);

    // Keep suit from dipping under terrain/ocean during extrapolation
    if (ground) {
      const floor = ground.surface(this.pos.x, this.pos.z) + 0.98;
      if (this.pos.y < floor) this.pos.y = floor;
    }

    this.aim.lerp(this.tgtAim, angAlpha).normalize();
    this.heading = lerpAngle(this.heading, this.tgtHeading, angAlpha);
    this.pitch = THREE.MathUtils.lerp(this.pitch, this.tgtPitch, angAlpha);
    this.roll = THREE.MathUtils.lerp(this.roll, this.tgtRoll, angAlpha);
    this.flightness = THREE.MathUtils.lerp(this.flightness, this.tgtFlightness, angAlpha);
    this.thrust = THREE.MathUtils.lerp(this.thrust, this.tgtThrust, angAlpha);

    // ── Mesh orientation (upright hover <-> prone supersonic flight) ──
    this.mesh.position.copy(this.pos);
    const speed = this.vel.length();
    const targetPosture = this.grounded || this.unibeam ? 0 : this.flightness * FLIGHT_POSTURE;
    this.posture += (targetPosture - this.posture) * (1 - Math.exp(-dt * 10));

    if (this.flightness > 0.25 && speed > 15 && !this.unibeam) {
      this._dir.copy(this.vel).divideScalar(speed);
      const yaw = Math.atan2(this._dir.x, this._dir.z);
      const horiz = Math.max(1e-4, Math.hypot(this._dir.x, this._dir.z));
      const pitchAngle = -Math.atan2(this._dir.y, horiz);
      this.mesh.rotation.set(pitchAngle * this.flightness, yaw, this.roll, 'YXZ');
    } else {
      this.mesh.rotation.set(this.pitch * 0.25, this.heading, this.roll * 0.35, 'YXZ');
    }
    this.body.rotation.x = this.posture;

    // ── Arm poses ──
    const armAlpha = 1 - Math.exp(-dt * 12);
    let lx = 0;
    let lz = 0.14;
    let rx = 0;
    let rz = -0.14;
    if (this.unibeam) {
      lx = 0.45;
      rx = 0.45;
      lz = 0.65;
      rz = -0.65;
    } else if (this.firing) {
      lx = -1.45;
      rx = -1.35;
      lz = 0.08;
      rz = -0.08;
    } else if ((this.flags & SuitFlag.BRAKING) !== 0) {
      lx = -0.85;
      rx = -0.85;
      lz = 0.55;
      rz = -0.55;
    } else if (this.flightness > 0.5) {
      // Swept back sleek supersonic flight posture
      lx = 0.12;
      rx = 0.12;
      lz = 0.18;
      rz = -0.18;
    } else if (!this.grounded) {
      // Hover stabilizers out
      const sway = Math.sin(this.time * 3.2) * 0.04;
      lx = -0.15 + sway;
      rx = -0.15 - sway;
      lz = 0.32;
      rz = -0.32;
    }
    this.armL.rotation.x = THREE.MathUtils.lerp(this.armL.rotation.x, lx, armAlpha);
    this.armL.rotation.z = THREE.MathUtils.lerp(this.armL.rotation.z, lz, armAlpha);
    this.armR.rotation.x = THREE.MathUtils.lerp(this.armR.rotation.x, rx, armAlpha);
    this.armR.rotation.z = THREE.MathUtils.lerp(this.armR.rotation.z, rz, armAlpha);

    // ── War Machine shoulder minigun & pack articulation ──
    if (this.wmPack) {
      this.mesh.updateMatrixWorld(true);
      this.body.getWorldQuaternion(this._invQ);
      animateWarMachinePack(this.wmPack, dt, {
        aimWorld: this.aim,
        chestWorldQuat: this._invQ,
        minigunFiring: this.firing,
        minigunShot: this.firing && Math.sin(this.time * 85) > 0.35,
        podOpen: 0,
        podArmed: 0,
        podLoaded: 6,
        ventOpen: this.firing ? 0.6 : 0,
        wristDeploy: 0,
        wristLoaded: [true, true],
        wristLock: [0, 0],
        flakSweepActive: false,
      });
    }

    // ── Boot & palm plumes ──
    const activePower = this.grounded || this.down ? 0 : Math.max(this.thrust, this.boosting ? 1.45 : 0.45);
    const flicker = 0.88 + 0.14 * Math.sin(this.time * 42);
    if (this.bootPlumes && this.bootCones) {
      for (let i = 0; i < 2; i++) {
        const sp = this.bootPlumes[i];
        const cone = this.bootCones[i];
        sp.visible = activePower > 0.04;
        cone.visible = activePower > 0.08;
        if (sp.visible) sp.scale.setScalar((0.75 + 0.85 * activePower) * flicker);
        if (cone.visible) {
          const len = (0.7 + 1.9 * activePower) * flicker;
          const rad = 0.7 + 0.5 * activePower;
          cone.scale.set(rad, len, rad);
        }
      }
    }
    if (this.palmPlumes) {
      const palmOn = !this.grounded && !this.down && (this.flightness < 0.7 || (this.flags & SuitFlag.BRAKING) !== 0);
      for (const sp of this.palmPlumes) {
        sp.visible = palmOn;
        if (palmOn) sp.scale.setScalar(0.42 * flicker);
      }
    }

    // Supersonic vapour trail wisps when remote pilot boosts near Mach 1
    if (particles && this.boosting && speed > 220) {
      this.vaporT -= dt;
      if (this.vaporT <= 0) {
        this.vaporT = 0.045;
        particles.emit('vapor', this.pos, this.vel.clone().multiplyScalar(0.35), { scale: 1.4, life: 0.45 });
      }
    }
  }

  dispose(): void {
    this.mesh.traverse((o) => {
      const m = o as THREE.Mesh | THREE.Sprite;
      if ((m as THREE.Sprite).isSprite) {
        (m as THREE.Sprite).material.dispose();
      }
    });
    this.mesh.clear();
  }
}

function lerpAngle(a: number, b: number, t: number): number {
  const diff = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + diff * t;
}
