import * as THREE from 'three';
import type { Particles } from '../fx/particles';
import type { Streaks } from '../fx/streaks';
import type { EventBus } from '../sim/events';
import { GRAVITY, SPEED_OF_SOUND } from '../world/config';
import type { Explosions, SurfaceQuery } from './explosions';
import type { Missiles } from './missiles';
import { beam, box, frustum, glowMaterial, loft, merge, paint, type V3 } from './modelKit';
import type { DamageKind, Decoy, Hostile, PlayerTarget } from './types';

/**
 * Supersonic Rival Powered-Armor Boss ("RIVAL ACE"): a rogue prototype
 * powered-armour pilot built to match the Mark III in speed and lethality,
 * but cast in conventional titanium-steel rather than a gold-titanium alloy.
 *
 * Flies like a peer armoured pilot: high-G banking turns, supersonic boost
 * dashes leaving Mach vapour bursts, defensive break turns with countermeasure
 * flares that decoy player seekers, twin palm repulsor streaks, shoulder
 * micro-missile pairs, and a telegraphed crimson-amber chest Unibeam sweep.
 *
 * Signature tactical counter: lure him above 8,800 m. Without gold-titanium
 * anti-icing, his actuators freeze solid at icing >= 1, cutting his boots for
 * a 6-second helpless tumble at 2× damage vulnerability (or shattering on
 * ground/ocean impact).
 */

export const RIVAL_MAX_HP = 1200;
export const RIVAL_RADIUS = 2.8;
/** Altitude where the rival's prototype plating begins icing rapidly (m). */
export const RIVAL_ICING_ALT = 8800;
/** Altitude where JARVIS tips off the player about the alloy weakness (m). */
export const RIVAL_HINT_ALT = 7600;
/** Duration of the frozen actuator stall once icing hits 1 (s). */
export const RIVAL_STALL_DURATION = 6.0;
/** Damage multiplier while frozen in an iced stall. */
export const RIVAL_ICED_DAMAGE_MULT = 2.0;
/** Telegraphed charge time before the rival's chest Unibeam fires (s). */
export const RIVAL_BEAM_CHARGE = 1.1;
/** Active duration of the rival's sweeping chest Unibeam (s). */
export const RIVAL_BEAM_DURATION = 1.8;
/** Cooldown between countermeasure flare salvos (s). */
export const RIVAL_FLARE_COOLDOWN = 7.0;
/** Flight posture in prone supersonic flight (rad; 0 = upright hover/beam stance). */
export const RIVAL_FLIGHT_POSTURE = 1.42;
/** Flight speed envelope (m/s). */
export const RIVAL_CRUISE_SPEED = 230;
export const RIVAL_DASH_SPEED = 435;
const RIVAL_MAX_G = 14;
/** Hard minimum clearance above terrain/ocean while alive and powered (m). */
const MIN_FLOOR_CLEARANCE = 18;
const REPULSOR_SPEED = 960;
const REPULSOR_DMG = 6;
const BEAM_RANGE = 1800;
const BEAM_DPS = 25;
const BEAM_SWEEP_RATE = 0.52;

export type RivalMode = 'stalk' | 'strafe' | 'dash' | 'evade' | 'beamCharge' | 'beamFire' | 'iced' | 'dying';

interface RivalBolt {
  p: THREE.Vector3;
  v: THREE.Vector3;
  life: number;
}

interface RivalFlare extends Decoy {
  v: THREE.Vector3;
  age: number;
  life: number;
  sprite: THREE.Sprite;
  puffT: number;
}

const C = {
  armor: 0x3e454f,
  plate: 0x4e5663,
  dark: 0x262b33,
  joint: 0x15181d,
  crimson: 0x8f1c18,
  trim: 0x6b1512,
};

const REACTOR_GLOW = new THREE.Color(1.0, 0.26, 0.08);
const VISOR_GLOW = new THREE.Color(1.0, 0.34, 0.08);
const PALM_GLOW = new THREE.Color(1.0, 0.38, 0.12);
const FROST_EMISSIVE = new THREE.Color(0.32, 0.68, 0.95);
const ZERO_COLOR = new THREE.Color(0x000000);

interface RivalGeo {
  torso: THREE.BufferGeometry;
  torsoGlow: THREE.BufferGeometry;
  armL: THREE.BufferGeometry;
  armLGlow: THREE.BufferGeometry;
  armR: THREE.BufferGeometry;
  armRGlow: THREE.BufferGeometry;
}

let geoCache: RivalGeo | null = null;

/**
 * Procedural 2.25 m armoured humanoid silhouette (pelvis at y = 0, boots at
 * y = -1.10, helmet crown at y = +1.15; chest & visor facing +Z). Built once
 * with modelKit and shared across instances.
 */
function rivalGeometry(): RivalGeo {
  if (geoCache) return geoCache;

  const torso: THREE.BufferGeometry[] = [];
  const torsoGlow: THREE.BufferGeometry[] = [];

  // ── Helmet (+0.78 … +1.15) ───────────────────────────────────────────
  const headRing = (y: number, w: number, fz: number, bz: number): V3[] => [
    [0, y, fz], [w * 0.72, y, fz * 0.68], [w, y, 0.01], [w * 0.75, y, bz * 0.75],
    [0, y, bz], [-w * 0.75, y, bz * 0.75], [-w, y, 0.01], [-w * 0.72, y, fz * 0.68],
  ];
  torso.push(
    loft(
      [
        headRing(0.80, 0.095, 0.13, -0.10),
        headRing(0.92, 0.125, 0.155, -0.13),
        headRing(1.05, 0.12, 0.145, -0.135),
        headRing(1.15, 0.065, 0.07, -0.08),
      ],
      (e, s) => {
        if (s === 1 && (e === 0 || e === 7)) return C.dark;
        if (s >= 2) return C.plate;
        return C.armor;
      },
    ),
    // Chin guard & brow crest
    box(0.11, 0.055, 0.07, C.crimson, 0, 0.85, 0.12),
    box(0.055, 0.06, 0.18, C.crimson, 0, 1.13, -0.01),
    // Neck collar
    paint(new THREE.CylinderGeometry(0.085, 0.11, 0.12, 10).translate(0, 0.74, 0), C.joint),
  );
  // Twin angled glowing visor eyes
  for (const s of [-1, 1]) {
    torsoGlow.push(
      paint(
        new THREE.BoxGeometry(0.055, 0.018, 0.02).rotateZ(-s * 0.18).translate(s * 0.042, 0.985, 0.152),
        VISOR_GLOW,
        6,
      ),
    );
  }

  // ── Chest & Torso (+0.14 … +0.72) ────────────────────────────────────
  torso.push(
    // Broad armoured chest cuirass (broad at shoulders, tapered to waist)
    frustum({ hw0: 0.18, z0: 0.13, z1: -0.12, y0: 0.16, hw1: 0.30, z2: 0.19, z3: -0.17, y1: 0.68 }, (e, s) => {
      if (s < 0) return C.dark;
      if (e === 0) return C.plate;
      if (e === 2) return C.dark;
      return C.armor;
    }),
    // Sculpted pectoral plates
    box(0.18, 0.16, 0.07, C.plate, -0.14, 0.50, 0.165),
    box(0.18, 0.16, 0.07, C.plate, 0.14, 0.50, 0.165),
    // Crimson collar & shoulder yoke
    box(0.46, 0.05, 0.22, C.crimson, 0, 0.69, -0.01),
    // Segmented abdomen
    frustum({ hw0: 0.19, z0: 0.13, z1: -0.12, y0: -0.04, hw1: 0.17, z2: 0.12, z3: -0.11, y1: 0.17 }, C.dark),
    box(0.24, 0.04, 0.23, C.crimson, 0, 0.08, 0.01),
    // Pelvis / hip armour + side flare pods
    frustum({ hw0: 0.14, z0: 0.11, z1: -0.10, y0: -0.16, hw1: 0.21, z2: 0.14, z3: -0.13, y1: -0.02 }, C.armor),
  );
  // Chest Arc Reactor housing & glowing crimson-amber core
  torso.push(
    paint(new THREE.TorusGeometry(0.085, 0.018, 6, 8).translate(0, 0.45, 0.205), C.dark),
  );
  torsoGlow.push(
    paint(new THREE.CircleGeometry(0.072, 12).translate(0, 0.45, 0.214), REACTOR_GLOW, 7),
  );

  // ── Shoulder Pauldrons, Micro-Missile Pods & Dorsal Flight Pack ──────
  for (const s of [-1, 1]) {
    // Heavy Monger-inspired shoulder pauldron + micro-missile pod
    torso.push(
      frustum({ x: s * 0.34, hw0: 0.11, z0: 0.15, z1: -0.15, y0: 0.54, hw1: 0.09, z2: 0.12, z3: -0.14, y1: 0.76 }, (e) => (e === 0 ? C.crimson : C.plate)),
      box(0.10, 0.09, 0.14, C.dark, s * 0.29, 0.76, -0.02),
      // Hip flare dispenser drum
      paint(new THREE.CylinderGeometry(0.045, 0.045, 0.08, 8).rotateZ(Math.PI / 2).translate(s * 0.22, -0.08, -0.04), C.dark),
      // Back flight stabilizer fin & thruster spine pod
      box(0.03, 0.44, 0.22, C.dark, s * 0.13, 0.46, -0.24),
      loft(
        [
          [[s * 0.14, 0.62, -0.22], [s * 0.14, 0.52, -0.28], [s * 0.14, 0.24, -0.26], [s * 0.14, 0.30, -0.20]],
          [[s * 0.38, 0.48, -0.34], [s * 0.38, 0.43, -0.38], [s * 0.38, 0.22, -0.34], [s * 0.38, 0.26, -0.30]],
        ],
        (_e, seg) => (seg >= 0 ? C.crimson : C.dark),
      ),
    );
    // Glowing dorsal thruster vents
    torsoGlow.push(
      paint(new THREE.BoxGeometry(0.04, 0.07, 0.02).translate(s * 0.13, 0.26, -0.355), REACTOR_GLOW, 4),
    );
  }

  // ── Legs & Heavy Thruster Boots (-1.10 … -0.12) ──────────────────────
  const legRing = (x: number, y: number, rx: number, rz: number): V3[] => [
    [x, y, rz], [x + rx, y, 0], [x, y, -rz], [x - rx, y, 0],
  ];
  for (const s of [-1, 1]) {
    const x = s * 0.155;
    torso.push(
      // Thigh
      loft(
        [
          legRing(x, -0.10, 0.115, 0.125),
          legRing(x * 1.02, -0.34, 0.105, 0.115),
          legRing(x * 1.04, -0.56, 0.085, 0.095),
        ],
        (e) => (e === 0 || e === 3 ? C.plate : C.armor),
      ),
      // Angular knee guard
      box(0.12, 0.13, 0.13, C.crimson, x * 1.04, -0.57, 0.05),
      // Tapered greave / shin
      loft(
        [
          legRing(x * 1.04, -0.58, 0.085, 0.095),
          legRing(x * 1.05, -0.82, 0.095, 0.105),
          legRing(x * 1.06, -1.04, 0.08, 0.09),
        ],
        (e) => (e === 0 || e === 3 ? C.plate : C.dark),
      ),
      // Boot & sole (bottom at y = -1.10)
      box(0.145, 0.09, 0.26, C.dark, x * 1.06, -1.055, 0.045),
      box(0.13, 0.04, 0.18, C.crimson, x * 1.06, -1.01, 0.08),
      // Calf aero strut
      beam([x * 1.04, -0.62, -0.10], [x * 1.06, -1.02, -0.11], 0.022, C.trim, 4),
    );
    // Boot thruster emitter disc facing -Y
    torsoGlow.push(
      paint(new THREE.CircleGeometry(0.068, 10).rotateX(Math.PI / 2).translate(x * 1.06, -1.102, -0.01), PALM_GLOW, 6),
    );
  }

  // ── Articulated Arms (pivoted at shoulder origin) ────────────────────
  const makeArm = (side: -1 | 1): { body: THREE.BufferGeometry; glow: THREE.BufferGeometry } => {
    const parts: THREE.BufferGeometry[] = [
      // Shoulder joint ball
      paint(new THREE.IcosahedronGeometry(0.085, 0), C.joint),
      // Upper arm
      box(0.125, 0.27, 0.135, C.armor, side * 0.02, -0.16, 0),
      // Elbow guard
      box(0.11, 0.09, 0.12, C.crimson, side * 0.02, -0.32, -0.01),
      // Heavy forearm gauntlet
      frustum({ x: side * 0.02, hw0: 0.068, z0: 0.075, z1: -0.075, y0: -0.60, hw1: 0.078, z2: 0.082, z3: -0.082, y1: -0.34 }, (e) => (e === 0 ? C.plate : C.dark)),
      // Hand / repulsor palm emitter housing
      box(0.09, 0.09, 0.10, C.dark, side * 0.02, -0.64, 0.01),
    ];
    const glow = paint(new THREE.CircleGeometry(0.044, 10).rotateX(Math.PI / 2).translate(side * 0.02, -0.688, 0.01), PALM_GLOW, 6);
    return { body: merge(parts), glow };
  };

  const left = makeArm(1);
  const right = makeArm(-1);

  geoCache = {
    torso: merge(torso),
    torsoGlow: merge(torsoGlow),
    armL: left.body,
    armLGlow: left.glow,
    armR: right.body,
    armRGlow: right.glow,
  };
  return geoCache;
}

let plumeTex: THREE.Texture | null = null;
function glowSpriteTexture(): THREE.Texture {
  if (plumeTex) return plumeTex;
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext?.('2d');
    if (g) {
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, 'rgba(255,250,240,1)');
      grad.addColorStop(0.25, 'rgba(255,150,60,0.85)');
      grad.addColorStop(0.6, 'rgba(255,60,20,0.28)');
      grad.addColorStop(1, 'rgba(255,20,0,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
      plumeTex = new THREE.CanvasTexture(c);
      plumeTex.colorSpace = THREE.SRGBColorSpace;
      return plumeTex;
    }
  }
  // Headless / test fallback without 2D canvas
  const data = new Uint8Array([255, 255, 255, 255]);
  plumeTex = new THREE.DataTexture(data, 1, 1);
  plumeTex.needsUpdate = true;
  return plumeTex;
}

let sharedGlowMat: THREE.MeshStandardMaterial | null = null;
function rivalGlowMaterial(): THREE.MeshStandardMaterial {
  return (sharedGlowMat ??= glowMaterial());
}

let sharedPlumeConeGeo: THREE.BufferGeometry | null = null;
function plumeConeGeo(): THREE.BufferGeometry {
  if (sharedPlumeConeGeo) return sharedPlumeConeGeo;
  // Cone pointing down -Y from y = 0 to y = -1
  const g = new THREE.ConeGeometry(0.11, 1.0, 10, 1, true);
  g.rotateX(Math.PI);
  g.translate(0, -0.5, 0);
  sharedPlumeConeGeo = g;
  return g;
}

const UP = new THREE.Vector3(0, 1, 0);
let nextRivalId = 12000;

export class RivalSuit implements Hostile {
  readonly id = nextRivalId++;
  readonly kind = 'rival' as const;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly radius = RIVAL_RADIUS;
  readonly maxHp = RIVAL_MAX_HP;
  hp = RIVAL_MAX_HP;
  alive = true;
  threatened = 0;

  /** Public combat/state flags for cross-system hooks (Reactor Overcharge, Missions, HUD). */
  chargingBeam = false;
  firingBeam = false;
  /** Beam charge progress 0–1 while charging. */
  beamCharge = 0;
  /** True while actuators are frozen in a high-altitude stall (takes 2× damage). */
  iced = false;
  /** High-altitude ice accumulation 0–1. */
  icing = 0;
  /** Remaining frozen stall time (s). */
  iceStallT = 0;
  /** Current AI flight/combat mode. */
  mode: RivalMode = 'stalk';
  /** Articulated body pitch from upright (0) to prone flight (~1.42 rad). */
  posture = RIVAL_FLIGHT_POSTURE;
  /** Cooldown before the next countermeasure flare salvo (s). */
  flareCooldown = 0;
  /** Set once the defeated suit finishes its crash/shatter (Combat removes it). */
  crashed = false;
  /** True if killed by shattering on ground/ocean impact while iced. */
  shattered = false;
  /** World-space endpoints of the rival's Unibeam (for clash/collision inspection). */
  readonly beamFrom = new THREE.Vector3();
  readonly beamEnd = new THREE.Vector3();
  /** Active countermeasure flares (exposed for testing & inspection). */
  readonly flares: RivalFlare[] = [];
  /** Active palm repulsor bolts in flight. */
  readonly bolts: RivalBolt[] = [];

  readonly mesh = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly armL = new THREE.Group();
  private readonly armR = new THREE.Group();
  private readonly bodyMat: THREE.MeshStandardMaterial;
  private readonly bootPlumes: [THREE.Sprite, THREE.Sprite];
  private readonly bootCones: [THREE.Mesh, THREE.Mesh];
  private readonly palmPlumes: [THREE.Sprite, THREE.Sprite];
  private readonly reactorGlare: THREE.Sprite;
  private readonly reactorHalo: THREE.Sprite;

  private modeT = 0;
  private roll = 0;
  private tumblePitch = 0;
  private tumbleRoll = 0;
  private tumbleYaw = 0;
  private readonly q = new THREE.Quaternion();
  private readonly orbitDir = Math.random() < 0.5 ? -1 : 1;
  private readonly seed = Math.random() * 100;

  // Arsenal timers
  private repulsorT = 1.2;
  private burst = 0;
  private burstT = 0;
  private nextPalm: 'L' | 'R' = 'R';
  private missileT = 6.5;
  private beamCooldown = 11;
  private beamT = 0;
  private beamHitT = 0;
  private readonly beamDir = new THREE.Vector3(0, 0, 1);
  private dashCooldown = 7;

  // FX / callout state
  private vaporT = 0;
  private frostT = 0;
  private smokeT = 0;
  private flybyDone = false;
  private icingHinted = false;
  private beamWarned = false;
  private destroyedHandled = false;

  // Scratch vectors
  private readonly _v = new THREE.Vector3();
  private readonly _w = new THREE.Vector3();
  private readonly _a = new THREE.Vector3();
  private readonly _b = new THREE.Vector3();
  private readonly _dir = new THREE.Vector3();
  private readonly _want = new THREE.Vector3();
  private readonly _m = new THREE.Matrix4();
  private readonly _q2 = new THREE.Quaternion();

  constructor(at: THREE.Vector3, heading: THREE.Vector3) {
    this.mesh.name = 'rival-ace';
    const g = rivalGeometry();
    this.bodyMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      metalness: 0.65,
      roughness: 0.36,
    });
    const glowMat = rivalGlowMaterial();

    this.body.add(new THREE.Mesh(g.torso, this.bodyMat), new THREE.Mesh(g.torsoGlow, glowMat));

    this.armL.position.set(0.36, 0.56, 0.01);
    this.armL.add(new THREE.Mesh(g.armL, this.bodyMat), new THREE.Mesh(g.armLGlow, glowMat));
    this.armR.position.set(-0.36, 0.56, 0.01);
    this.armR.add(new THREE.Mesh(g.armR, this.bodyMat), new THREE.Mesh(g.armRGlow, glowMat));
    this.body.add(this.armL, this.armR);

    const tex = glowSpriteTexture();
    const makeSprite = (color: number, size: number) => {
      const sp = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: tex,
          color,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      sp.scale.setScalar(size);
      return sp;
    };

    const plumeMat = new THREE.MeshBasicMaterial({
      color: 0xff6a28,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    const bootL = makeSprite(0xff7838, 1.3);
    bootL.position.set(0.165, -1.22, -0.01);
    const bootR = makeSprite(0xff7838, 1.3);
    bootR.position.set(-0.165, -1.22, -0.01);
    const coneL = new THREE.Mesh(plumeConeGeo(), plumeMat);
    coneL.position.set(0.165, -1.10, -0.01);
    const coneR = new THREE.Mesh(plumeConeGeo(), plumeMat);
    coneR.position.set(-0.165, -1.10, -0.01);
    this.body.add(bootL, bootR, coneL, coneR);
    this.bootPlumes = [bootL, bootR];
    this.bootCones = [coneL, coneR];

    const palmL = makeSprite(0xff8c40, 0.55);
    palmL.position.set(0.02, -0.74, 0.01);
    const palmR = makeSprite(0xff8c40, 0.55);
    palmR.position.set(-0.02, -0.74, 0.01);
    this.armL.add(palmL);
    this.armR.add(palmR);
    this.palmPlumes = [palmL, palmR];

    this.reactorGlare = makeSprite(0xfff0d8, 0.25);
    this.reactorGlare.position.set(0, 0.45, 0.25);
    this.reactorGlare.visible = false;
    this.reactorHalo = makeSprite(0xff3810, 0.6);
    this.reactorHalo.position.set(0, 0.45, 0.26);
    this.reactorHalo.visible = false;
    this.body.add(this.reactorGlare, this.reactorHalo);

    this.mesh.add(this.body);
    this.mesh.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = false;
    });

    this.pos.copy(at);
    const h = heading.lengthSq() > 1e-4 ? heading.clone().normalize() : new THREE.Vector3(0, 0, -1);
    this.vel.copy(h).multiplyScalar(RIVAL_CRUISE_SPEED);
    this.beamDir.copy(h);
    this.syncTransform(h, 0);
  }

  get label(): string {
    if (this.iced) return 'RIVAL ACE [ICED]';
    if (this.chargingBeam || this.firingBeam) return 'RIVAL ACE [BEAM]';
    return 'RIVAL ACE';
  }

  damage(amount: number, at: THREE.Vector3, kind: DamageKind): boolean {
    if (!this.alive) return false;
    void at;
    void kind;
    const mult = this.iced ? RIVAL_ICED_DAMAGE_MULT : 1;
    this.hp -= amount * mult;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      this.chargingBeam = false;
      this.firingBeam = false;
      this.beamCharge = 0;
      this.mode = 'dying';
      this.modeT = 0;
      return true;
    }
    // Under heavy fire while stalking/strafing, occasionally jink into a dash or evade
    if (!this.iced && !this.chargingBeam && !this.firingBeam && this.mode === 'strafe' && Math.random() < 0.22) {
      this.setMode('evade');
    }
    return false;
  }

  /** Dramatic armor detonation & victory dialogue when defeated (called once by Combat). */
  onDestroyed(explosions: Explosions, events: EventBus): void {
    if (this.destroyedHandled) return;
    this.destroyedHandled = true;
    explosions.blast(this.pos, this.shattered ? 18 : 13, { debris: 22, burn: this.shattered, vel: this.vel.clone().multiplyScalar(0.35) });
    const off = this._a;
    for (let i = 0; i < 3; i++) {
      off.set((Math.random() - 0.5) * 3.5, (Math.random() - 0.5) * 3.5, (Math.random() - 0.5) * 3.5).add(this.pos);
      explosions.blast(off, 6.5, { debris: 8, vel: this.vel.clone().multiplyScalar(0.25) });
    }
    this.bodyMat.color.setHex(0x1b1c1f);
    this.bodyMat.emissive.setHex(0x000000);
    events.emit('jarvis', {
      text: this.shattered
        ? 'Target plating shattered on impact. Icing problem remains unsolved on their end, sir.'
        : 'Hostile arc signature extinguished, sir. One of a kind remains accurate.',
    });
  }

  /** Clean up any detached flare sprites from a parent group (called on reset/removal). */
  disposeFlares(parent: THREE.Object3D): void {
    for (const f of this.flares) {
      parent.remove(f.sprite);
      f.sprite.material.dispose();
    }
    this.flares.length = 0;
  }

  private setMode(m: RivalMode): void {
    if (this.mode === m) return;
    this.mode = m;
    this.modeT = 0;
    if (m !== 'beamCharge') {
      this.chargingBeam = false;
      this.beamCharge = 0;
    }
    if (m !== 'beamFire') {
      this.firingBeam = false;
    }
  }

  update(
    dt: number,
    t: number,
    player: PlayerTarget,
    ground: SurfaceQuery,
    missiles: Missiles,
    particles: Particles,
    streaks: Streaks,
    explosions: Explosions,
    events: EventBus,
    fxParent: THREE.Object3D = this.mesh.parent ?? this.mesh,
  ): void {
    this.modeT += dt;
    this.threatened = Math.max(0, this.threatened - dt);
    this.flareCooldown = Math.max(0, this.flareCooldown - dt);
    this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    this.beamCooldown = Math.max(0, this.beamCooldown - dt);
    this.missileT = Math.max(0, this.missileT - dt);
    this.repulsorT = Math.max(0, this.repulsorT - dt);

    // Always advance active bolts and countermeasure flares even if dying/iced
    this.updateBolts(dt, player, ground, particles, streaks, events);
    this.updateFlares(dt, ground, particles, streaks, fxParent);

    if (this.mode === 'dying') {
      this.updateDying(dt, ground, particles, explosions);
      return;
    }

    // ── High-Altitude Icing Trap ──────────────────────────────────────
    this.updateIcing(dt, player, ground, particles, explosions, events);

    const toP = this._w.copy(player.pos).sub(this.pos);
    const dist = Math.max(0.01, toP.length());
    const toPDir = this._a.copy(toP).divideScalar(dist);
    const speed = this.vel.length();
    const dir = speed > 1e-2
      ? this._dir.copy(this.vel).divideScalar(speed)
      : this._dir.set(toPDir.x, Math.max(0.25, toPDir.y), toPDir.z).normalize();

    // Supersonic flyby audio cue
    if (!this.flybyDone && dist < 110 && speed > 220) {
      this.flybyDone = true;
      events.emit('droneFlyby', { at: this.pos, value: speed });
    } else if (this.flybyDone && dist > 380) {
      this.flybyDone = false;
    }

    // ── Iced Stall: Boots Cut Out, Helpless Tumble ────────────────────
    if (this.iced) {
      this.iceStallT -= dt;
      this.vel.y -= GRAVITY * 1.15 * dt;
      this.vel.multiplyScalar(Math.exp(-0.12 * dt));
      this.pos.addScaledVector(this.vel, dt);

      this.tumblePitch += 2.6 * dt;
      this.tumbleRoll += 3.9 * dt;
      this.tumbleYaw += 1.4 * dt;
      this.posture += (0.55 - this.posture) * (1 - Math.exp(-dt * 3));
      this.mesh.position.copy(this.pos);
      this.mesh.rotation.set(this.tumblePitch, this.tumbleYaw, this.tumbleRoll, 'YXZ');
      this.body.rotation.x = this.posture;
      this.poseArms(dt, 'iced', t);
      this.updatePlumes(t, 0, false);

      // Shatter on ground/ocean impact while frozen!
      const surf = ground.surface(this.pos.x, this.pos.z);
      if (this.pos.y <= surf + 2.0) {
        this.pos.y = surf + 1.2;
        this.shattered = true;
        this.damage(this.hp + 1000, this.pos, 'ram');
        this.onDestroyed(explosions, events);
        events.emit('kill', { at: this.pos, text: 'rival' });
        this.crashed = true;
        this.mesh.visible = false;
        return;
      }

      if (this.iceStallT <= 0) {
        // Thaw recovery: reignite boots with a violent burst
        this.iced = false;
        this.icing = 0.25;
        this.setMode('stalk');
        particles.burst('fire', this.pos, 10, 14, undefined, 1, { scale: 0.65 });
        particles.burst('vapor', this.pos, 14, 16, undefined, 1, { scale: 1.1 });
        events.emit('boostStart', { at: this.pos });
      }
      return;
    }

    // ── Countermeasure Flares & Evasive Break When Threatened ─────────
    if (this.threatened > 0.2 && !this.chargingBeam && !this.firingBeam) {
      if (this.flareCooldown <= 0) {
        this.popFlares(missiles, particles, events, fxParent);
      }
      if (this.mode !== 'evade') {
        this.setMode('evade');
      }
    }

    // ── Unibeam Charge & Sweep State Machine ──────────────────────────
    if (this.mode === 'beamCharge') {
      this.updateBeamCharge(dt, t, player, ground, toPDir, dist, particles, events);
      this.updateFrostMaterial();
      return;
    }
    if (this.mode === 'beamFire') {
      this.updateBeamFire(dt, t, player, ground, toPDir, particles, streaks, events);
      this.updateFrostMaterial();
      return;
    }

    // ── Agile Suit-Like Flight AI ─────────────────────────────────────
    const want = this._want;
    let targetSpeed = RIVAL_CRUISE_SPEED;
    let boosting = false;

    switch (this.mode) {
      case 'stalk': {
        // Pursue player aggressively to any altitude (including into the icing trap!)
        const tgo = Math.min(2.0, dist / Math.max(speed, 180));
        want.copy(player.pos).addScaledVector(player.vel, tgo * 0.6).sub(this.pos);
        // If just thawed out above icing altitude, dive out briefly before re-engaging
        if (this.pos.y > RIVAL_ICING_ALT && this.icing > 0.15 && this.modeT < 1.8) {
          want.y = Math.min(want.y, -Math.max(200, dist * 0.45));
        }
        want.normalize();
        targetSpeed = dist > 1200 ? RIVAL_CRUISE_SPEED * 1.45 : RIVAL_CRUISE_SPEED;
        if (dist > 900 && this.dashCooldown <= 0 && player.alive) {
          this.setMode('dash');
          this.dashCooldown = 8 + Math.random() * 4;
          events.emit('boostStart', { at: this.pos });
        } else if (dist < 1050) {
          this.setMode('strafe');
        }
        break;
      }

      case 'strafe': {
        // High-energy peer dogfight: orbit + vertical weave + lead bursts
        const horiz = this._b.set(toP.x, 0, toP.z);
        const hLen = Math.max(1, horiz.length());
        horiz.divideScalar(hLen);
        const tangent = this._v.set(-horiz.z * this.orbitDir, 0, horiz.x * this.orbitDir);
        // Pull in if > 520 m, peel outward if < 260 m
        const radial = THREE.MathUtils.clamp((dist - 420) / 300, -0.85, 1.0);
        const altErr = THREE.MathUtils.clamp((player.pos.y + Math.sin(t * 1.2 + this.seed) * 90 - this.pos.y) / 220, -0.65, 0.75);
        want.copy(tangent).multiplyScalar(0.85).addScaledVector(horiz, radial).setY(altErr).normalize();
        targetSpeed = dist < 260 ? RIVAL_CRUISE_SPEED * 0.75 : RIVAL_CRUISE_SPEED * 1.08;

        // Transitions: Unibeam clash/sweep, Supersonic dash, or Stalk if separated
        const localSurf = Math.max(ground.surface(this.pos.x, this.pos.z), 0);
        if (dist > 1400) {
          this.setMode('stalk');
        } else if (player.alive && this.beamCooldown <= 0 && dist > 180 && dist < 1300 && this.pos.y >= localSurf + 35) {
          this.startBeamCharge(toPDir, events);
          return;
        } else if (this.dashCooldown <= 0 && this.modeT > 3.5 && player.alive) {
          this.setMode('dash');
          this.dashCooldown = 9 + Math.random() * 4;
          events.emit('boostStart', { at: this.pos });
        }
        break;
      }

      case 'dash': {
        // Supersonic Mach 1.28 slash straight past the player with slight offset
        boosting = true;
        targetSpeed = RIVAL_DASH_SPEED;
        const side = this._b.set(-toPDir.z * this.orbitDir, 0.08, toPDir.x * this.orbitDir).normalize();
        want.copy(player.pos).addScaledVector(side, 55).sub(this.pos).normalize();
        if (dist < 140 || this.modeT > 3.2) {
          this.setMode('strafe');
        }
        break;
      }

      case 'evade': {
        // Hard high-G defensive jinking break turn
        boosting = true;
        targetSpeed = RIVAL_CRUISE_SPEED * 1.38;
        const side = this._b.set(-dir.z, 0, dir.x).normalize().multiplyScalar(Math.sin(t * 2.4 + this.seed) >= 0 ? 1 : -1);
        want.copy(dir).addScaledVector(side, 1.8).setY(Math.sin(t * 3.1 + this.seed) * 0.55).normalize();
        if (this.modeT > 2.2 && this.threatened <= 0) {
          this.setMode('strafe');
        }
        break;
      }
    }

    // Terrain avoidance: sample along the path and account for dive pull-out loss
    const floor = Math.max(
      0,
      ground.surface(this.pos.x, this.pos.z),
      ground.surface(this.pos.x + this.vel.x * 0.6, this.pos.z + this.vel.z * 0.6),
      ground.surface(this.pos.x + this.vel.x * 1.4, this.pos.z + this.vel.z * 1.4),
      ground.surface(this.pos.x + this.vel.x * 2.5, this.pos.z + this.vel.z * 2.5),
    );
    const sink = Math.max(0, -this.vel.y) / Math.max(speed, 1);
    const pullOut = ((speed * speed) / (RIVAL_MAX_G * GRAVITY)) * (1 - Math.sqrt(Math.max(0, 1 - sink * sink)));
    const clearance = this.pos.y - floor - pullOut * 1.3;
    const safe = 130;
    if (clearance < safe) {
      // Pull up along horizontal travel so turning for a low/behind target never dives into terrain
      const h = Math.max(Math.hypot(dir.x, dir.z), 1e-3);
      const pull = 0.35 + Math.min(2.5, ((safe - clearance) / safe) * 1.1);
      want.set(dir.x / h + 0.25 * want.x, Math.max(want.y, pull), dir.z / h + 0.25 * want.z).normalize();
    }

    // High-G banking flight integration
    const maxTurnRate = (RIVAL_MAX_G * GRAVITY) / Math.max(speed, 75);
    const ang = dir.angleTo(want);
    if (ang > 1e-4) {
      const axis = this._b.crossVectors(dir, want);
      if (axis.lengthSq() <= 1e-8) {
        // Antiparallel fallback: never stall straight down when want is 180° opposite dir
        axis.set(-dir.z, 0, dir.x);
        if (axis.lengthSq() <= 1e-8) axis.set(1, 0, 0);
      }
      axis.normalize();
      dir.applyAxisAngle(axis, Math.min(ang, maxTurnRate * dt));
    }
    const accelRate = boosting ? 2.6 : 1.4;
    const nextSpeed = speed + (targetSpeed - speed) * (1 - Math.exp(-dt * accelRate));
    const lateral = this._b.crossVectors(dir, want).y;
    this.roll += (THREE.MathUtils.clamp(-lateral * 4.5, -1.4, 1.4) - this.roll) * (1 - Math.exp(-dt * 4.5));

    this.vel.copy(dir).multiplyScalar(nextSpeed);
    this.pos.addScaledVector(this.vel, dt);
    if (this.enforceFloor(ground, MIN_FLOOR_CLEARANCE, 35)) {
      dir.copy(this.vel).normalize();
    }

    // Posture smoothly tilts upright in hover vs prone at supersonic speed
    const flightness = THREE.MathUtils.smoothstep(nextSpeed, 25, 160);
    const targetPosture = THREE.MathUtils.lerp(0.08, RIVAL_FLIGHT_POSTURE, flightness);
    this.posture += (targetPosture - this.posture) * (1 - Math.exp(-dt * 5));

    this.syncTransform(dir, this.roll);
    this.poseArms(dt, this.burst > 0 ? 'fire' : boosting ? 'dash' : 'flight', t);
    this.updatePlumes(t, boosting ? 1.5 : 0.75 + 0.35 * flightness, true);
    this.updateFrostMaterial();

    // Supersonic Mach vapor & contrail bursts
    if (nextSpeed > SPEED_OF_SOUND * 0.94) {
      this.vaporT += dt;
      while (this.vaporT > 0.025) {
        this.vaporT -= 0.025;
        particles.emit('vapor', this.pos.clone().addScaledVector(dir, -0.6), this._b.copy(this.vel).multiplyScalar(0.45), {
          scale: boosting ? 1.35 : 0.9,
          life: 0.45,
        });
        particles.emit('trail', this.pos.clone().addScaledVector(dir, -1.4), undefined, {
          scale: 0.75,
          life: 0.9,
        });
      }
    }

    // ── Weapons: Twin Palm Repulsors & Shoulder Micro-Missile Pairs ───
    if (player.alive) {
      const facing = dir.dot(toPDir);
      // Twin palm repulsor streaks at medium range
      if (dist < 1200 && facing > 0.25 && this.repulsorT <= 0 && this.burst <= 0) {
        this.burst = 2 + Math.floor(Math.random() * 3);
        this.burstT = 0;
        this.repulsorT = 1.6 + Math.random() * 1.1;
        events.emit('enemyFire', { at: this.pos, value: this.burst });
      }
      if (this.burst > 0) {
        this.burstT -= dt;
        if (this.burstT <= 0) {
          this.burstT = 0.14;
          this.burst--;
          this.firePalmRepulsor(player, particles);
        }
      }

      // Shoulder micro-missile pairs
      if (this.missileT <= 0 && dist > 420 && dist < 2600 && facing > 0.35) {
        this.fireShoulderMissiles(player, missiles, explosions, events);
        this.missileT = 9.5 + Math.random() * 4.0;
      }
    }
  }

  private startBeamCharge(toPDir: THREE.Vector3, events: EventBus): void {
    this.setMode('beamCharge');
    this.chargingBeam = true;
    this.firingBeam = false;
    this.beamCharge = 0;
    this.beamT = 0;
    this.beamDir.copy(toPDir);
    events.emit('unibeamCharge', { at: this.pos });
    if (!this.beamWarned) {
      this.beamWarned = true;
      events.emit('jarvis', { text: 'Watch his chest reactor, sir — he is charging a unibeam! Evade or counter-fire.' });
    }
  }

  /** Hard safety net preventing powered flight or beam hover from clipping/getting stuck under the map. */
  private enforceFloor(ground: SurfaceQuery, minClear: number, climbBoost: number): boolean {
    const surf = Math.max(ground.surface(this.pos.x, this.pos.z), 0);
    if (this.pos.y >= surf + minClear) return false;
    this.pos.y = surf + minClear;
    if (this.vel.y < climbBoost) this.vel.y = climbBoost;
    return true;
  }

  private updateBeamCharge(
    dt: number,
    t: number,
    player: PlayerTarget,
    ground: SurfaceQuery,
    toPDir: THREE.Vector3,
    dist: number,
    particles: Particles,
    events: EventBus,
  ): void {
    if (!player.alive) {
      this.reactorGlare.visible = false;
      this.reactorHalo.visible = false;
      this.setMode('stalk');
      return;
    }
    // Flare upright into combat stance, bleeding speed
    this.vel.multiplyScalar(Math.exp(-dt * 2.6));
    this.pos.addScaledVector(this.vel, dt);
    this.enforceFloor(ground, MIN_FLOOR_CLEARANCE, 0);
    this.posture += (0 - this.posture) * (1 - Math.exp(-dt * 7));
    this.roll *= Math.exp(-dt * 6);

    const flatFace = this._b.set(toPDir.x, 0, toPDir.z);
    if (flatFace.lengthSq() > 1e-4) flatFace.normalize();
    else flatFace.set(0, 0, 1);
    this.syncTransform(flatFace, 0);
    this.poseArms(dt, 'beam', t);
    this.updatePlumes(t, 0.5, true);

    this.chargingBeam = true;
    this.beamCharge = Math.min(1, this.modeT / RIVAL_BEAM_CHARGE);
    this.beamDir.lerp(toPDir, Math.min(1, dt * 4)).normalize();

    const chest = this.chestWorldPos(this.beamFrom);
    this.beamEnd.copy(chest).addScaledVector(this.beamDir, Math.min(dist, BEAM_RANGE));

    // Intense pulsing crimson-amber charge glare
    const pulse = 0.8 + 0.25 * Math.sin(t * (16 + 34 * this.beamCharge));
    this.reactorGlare.visible = true;
    this.reactorHalo.visible = true;
    this.reactorGlare.scale.setScalar((0.35 + 1.15 * this.beamCharge) * pulse);
    this.reactorHalo.scale.setScalar((0.9 + 2.4 * this.beamCharge) * pulse);

    // Pull plasma sparks inward to telegraph the incoming blast
    if (Math.random() < dt * 32) {
      const off = this._v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(1.8 + Math.random() * 1.4);
      const from = this._b.copy(chest).add(off);
      particles.emit('ember', from, off.multiplyScalar(-2.4), { scale: 1.4, life: 0.35 });
    }

    if (this.modeT >= RIVAL_BEAM_CHARGE) {
      this.chargingBeam = false;
      this.firingBeam = true;
      this.mode = 'beamFire';
      this.modeT = 0;
      this.beamT = RIVAL_BEAM_DURATION;
      this.beamHitT = 0;
      // Slight initial offset so the player sees the sweep coming
      const right = this._v.crossVectors(this.beamDir, UP);
      if (right.lengthSq() > 1e-4) {
        right.normalize();
        this.beamDir.addScaledVector(right, this.orbitDir * 0.14).normalize();
      }
      events.emit('unibeamFire', { at: chest });
      void player;
    }
  }

  private updateBeamFire(
    dt: number,
    t: number,
    player: PlayerTarget,
    ground: SurfaceQuery,
    toPDir: THREE.Vector3,
    particles: Particles,
    streaks: Streaks,
    events: EventBus,
  ): void {
    this.vel.multiplyScalar(Math.exp(-dt * 2.2));
    this.pos.addScaledVector(this.vel, dt);
    this.enforceFloor(ground, MIN_FLOOR_CLEARANCE, 0);
    this.posture += (0 - this.posture) * (1 - Math.exp(-dt * 6));

    // Sweep beam toward player at bounded angular rate (dodgeable!)
    const ang = this.beamDir.angleTo(toPDir);
    if (ang > 1e-4) {
      const axis = this._b.crossVectors(this.beamDir, toPDir);
      if (axis.lengthSq() > 1e-8) {
        axis.normalize();
        this.beamDir.applyAxisAngle(axis, Math.min(ang, BEAM_SWEEP_RATE * dt));
      }
    }

    const flatFace = this._b.set(this.beamDir.x, 0, this.beamDir.z);
    if (flatFace.lengthSq() > 1e-4) flatFace.normalize();
    else flatFace.set(0, 0, 1);
    this.syncTransform(flatFace, 0);
    this.poseArms(dt, 'beam', t);
    this.updatePlumes(t, 0.55, true);

    const chest = this.chestWorldPos(this.beamFrom);
    const reach = BEAM_RANGE;
    this.beamEnd.copy(chest).addScaledVector(this.beamDir, reach);
    // Stop on ground/ocean if pointing downward
    if (this.beamDir.y < -0.02) {
      const seaT = Math.min(reach, Math.max(0, -chest.y / this.beamDir.y));
      const sx = chest.x + this.beamDir.x * seaT;
      const sz = chest.z + this.beamDir.z * seaT;
      const approxT = (ground.surface(sx, sz) - chest.y) / this.beamDir.y;
      if (approxT > 0 && approxT < reach) {
        this.beamEnd.copy(chest).addScaledVector(this.beamDir, approxT);
      }
    }

    // Blazing crimson-amber Unibeam ribbons
    const flick = 0.88 + 0.12 * Math.sin(t * 67);
    streaks.add(chest, this.beamEnd, 8.5 * flick, 1.8 * flick, 0.4 * flick, 0.85, 0.55, 1.35);
    streaks.add(chest, this.beamEnd, 14 * flick, 8.5 * flick, 4.2 * flick, 1.0, 0.2, 0.42);
    this.reactorGlare.visible = true;
    this.reactorHalo.visible = true;
    this.reactorGlare.scale.setScalar(1.8 * flick);
    this.reactorHalo.scale.setScalar(3.6 * flick);

    // Hit test against the player
    if (player.alive) {
      const seg = this._v.copy(this.beamEnd).sub(chest);
      const lenSq = Math.max(seg.lengthSq(), 1e-6);
      const u = THREE.MathUtils.clamp(this._b.copy(player.pos).sub(chest).dot(seg) / lenSq, 0, 1);
      const closest = this._b.copy(chest).addScaledVector(seg, u);
      if (closest.distanceToSquared(player.pos) < 3.2 * 3.2) {
        this.beamHitT -= dt;
        if (this.beamHitT <= 0) {
          this.beamHitT = 0.14;
          player.hit(BEAM_DPS * 0.14, closest, 'beam');
          particles.burst('spark', closest, 8, 16, this._v.copy(this.beamDir).negate(), 1.1);
        }
      }
    }

    this.beamT -= dt;
    if (this.beamT <= 0) {
      this.firingBeam = false;
      this.reactorGlare.visible = false;
      this.reactorHalo.visible = false;
      this.beamCooldown = 13 + Math.random() * 4;
      events.emit('unibeamEnd', { at: chest });
      this.setMode('strafe');
    }
  }

  private updateIcing(
    dt: number,
    player: PlayerTarget,
    ground: SurfaceQuery,
    particles: Particles,
    explosions: Explosions,
    events: EventBus,
  ): void {
    void ground;
    void explosions;
    // Tip off the pilot as the rival climbs high chasing them
    if (!this.icingHinted && (this.pos.y >= RIVAL_ICING_ALT || (this.pos.y >= RIVAL_HINT_ALT && player.pos.y >= RIVAL_HINT_ALT + 200))) {
      this.icingHinted = true;
      events.emit('jarvis', {
        text: "He's following us up, sir — his alloy isn't gold-titanium. Push past 9,000 metres!",
      });
    }

    if (this.pos.y > RIVAL_ICING_ALT) {
      const excess = THREE.MathUtils.clamp((this.pos.y - RIVAL_ICING_ALT) / 700, 0, 1.5);
      const rate = 0.22 + 0.35 * excess;
      this.icing = Math.min(1, this.icing + dt * rate);
    } else if (!this.iced) {
      this.icing = Math.max(0, this.icing - dt * 0.18);
    }

    // Stream frost/vapor particles whenever icing is building or frozen
    if (this.icing > 0.05 || this.iced) {
      this.frostT += dt;
      const interval = this.iced ? 0.025 : 0.05;
      while (this.frostT >= interval) {
        this.frostT -= interval;
        const drift = this._v.copy(this.vel).multiplyScalar(0.25).add(
          this._b.set((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6),
        );
        particles.emit('vapor', this.pos, drift, {
          scale: 0.7 + 0.9 * this.icing,
          life: 0.85,
          color: FROST_EMISSIVE,
        });
      }
    }

    // Trigger frozen actuator stall at icing >= 1
    if (!this.iced && this.icing >= 1) {
      this.iced = true;
      this.chargingBeam = false;
      this.firingBeam = false;
      this.beamCharge = 0;
      this.reactorGlare.visible = false;
      this.reactorHalo.visible = false;
      this.iceStallT = RIVAL_STALL_DURATION;
      this.mode = 'iced';
      this.modeT = 0;
      this.tumblePitch = this.mesh.rotation.x;
      this.tumbleYaw = this.mesh.rotation.y;
      this.tumbleRoll = this.mesh.rotation.z;
      particles.burst('vapor', this.pos, 18, 16, undefined, 1, { scale: 1.3, color: FROST_EMISSIVE });
      events.emit('jarvis', {
        text: 'His actuators are frozen solid, sir! Six seconds before thaw — light him up!',
      });
    }
  }

  /** Eject countermeasure flares to decoy incoming player seekers. */
  popFlares(missiles: Missiles, particles: Particles, events: EventBus, fxParent: THREE.Object3D = this.mesh.parent ?? this.mesh): number {
    this.flareCooldown = RIVAL_FLARE_COOLDOWN;
    const speed = this.vel.length();
    const back = speed > 2 ? this._a.copy(this.vel).divideScalar(-speed) : new THREE.Vector3(0, 0, -1);
    const right = this._b.crossVectors(UP, back);
    if (right.lengthSq() < 1e-4) right.set(1, 0, 0);
    else right.normalize();

    const tex = glowSpriteTexture();
    let totalDecoyed = 0;
    for (let i = 0; i < 4; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const eject = new THREE.Vector3()
        .copy(right)
        .multiplyScalar(side * (0.75 + 0.25 * Math.random()))
        .addScaledVector(back, 0.65)
        .add(new THREE.Vector3(0, 0.35 - i * 0.15, 0))
        .normalize();
      const at = this.pos.clone().addScaledVector(right, side * 0.35);
      const v = this.vel.clone().addScaledVector(eject, 22 + Math.random() * 8);
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: tex,
          color: 0xffd288,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      sprite.position.copy(at);
      sprite.scale.setScalar(2.4);
      fxParent.add(sprite);

      const flare: RivalFlare = {
        pos: at,
        heat: 1,
        v,
        age: 0,
        life: 3.4 + Math.random() * 0.6,
        sprite,
        puffT: 0,
      };
      this.flares.push(flare);
      totalDecoyed += missiles.offerHostileDecoy(flare, this.pos, this, 0.72);
      particles.burst('spark', at, 4, 8, eject, 0.6, { scale: 0.7, life: 0.4 });
    }
    events.emit('flarePop', { at: this.pos });
    return totalDecoyed;
  }

  private firePalmRepulsor(player: PlayerTarget, particles: Particles): void {
    const side = this.nextPalm;
    this.nextPalm = side === 'L' ? 'R' : 'L';
    const arm = side === 'L' ? this.armL : this.armR;
    const muzzle = new THREE.Vector3(side === 'L' ? 0.02 : -0.02, -0.7, 0.02);
    this.mesh.updateMatrixWorld(true);
    muzzle.applyMatrix4(arm.matrixWorld);

    const dist = player.pos.distanceTo(muzzle);
    const tgo = dist / REPULSOR_SPEED;
    const aim = this._v
      .copy(player.pos)
      .addScaledVector(player.vel, tgo)
      .sub(muzzle)
      .normalize();
    // Slight ace spread so skilled banking evades fire
    aim.add(this._b.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.028)).normalize();

    this.bolts.push({
      p: muzzle.clone(),
      v: aim.clone().multiplyScalar(REPULSOR_SPEED).addScaledVector(this.vel, 0.35),
      life: 1.8,
    });
    particles.emit('flash', muzzle, this.vel, { scale: 0.14 });
  }

  private fireShoulderMissiles(player: PlayerTarget, missiles: Missiles, explosions: Explosions, events: EventBus): void {
    this.mesh.updateMatrixWorld(true);
    const up = this._v.set(0, 1, 0).transformDirection(this.body.matrixWorld).normalize();
    for (const side of [-1, 1] as const) {
      const from = new THREE.Vector3(side * 0.34, 0.78, 0.02).applyMatrix4(this.body.matrixWorld);
      const kick = up.clone().multiplyScalar(22).addScaledVector(this.vel, 1);
      missiles.launch({
        team: 'enemy',
        from,
        vel: kick,
        target: player,
        coast: 0.28,
        caliber: 0.06,
        length: 0.9,
      });
      explosions.muzzle(from, up, 0.35);
    }
    events.emit('enemyMissile', { at: this.pos });
  }

  private updateBolts(
    dt: number,
    player: PlayerTarget,
    ground: SurfaceQuery,
    particles: Particles,
    streaks: Streaks,
    events: EventBus,
  ): void {
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      const prev = this._a.copy(b.p);
      b.p.addScaledVector(b.v, dt);
      b.life -= dt;
      if (player.alive) {
        const seg = this._v.copy(b.p).sub(prev);
        const len2 = Math.max(seg.lengthSq(), 1e-6);
        const u = THREE.MathUtils.clamp(this._b.copy(player.pos).sub(prev).dot(seg) / len2, 0, 1);
        const closest = this._b.copy(prev).addScaledVector(seg, u);
        if (closest.distanceToSquared(player.pos) < 1.35 * 1.35) {
          player.hit(REPULSOR_DMG, closest, 'bullet');
          particles.burst('spark', closest, 10, 14, seg.normalize().negate(), 0.9);
          this.bolts.splice(i, 1);
          continue;
        }
        if (closest.distanceToSquared(player.pos) < 9 && Math.random() < 0.3) {
          events.emit('ricochet', { at: closest });
        }
      }
      const surf = ground.surface(b.p.x, b.p.z);
      if (b.p.y < surf || b.life <= 0) {
        this.bolts.splice(i, 1);
        continue;
      }
      // Blazing crimson-amber palm repulsor streak
      const tail = this._b.copy(b.p).addScaledVector(b.v, -0.022);
      streaks.add(tail, b.p, 11, 2.8, 0.7, 0.95, 0.09, 0.24);
      streaks.add(tail, b.p, 15, 9, 5, 1.0, 0.04, 0.1);
    }
  }

  private updateFlares(dt: number, ground: SurfaceQuery, particles: Particles, streaks: Streaks, fxParent: THREE.Object3D): void {
    for (let i = this.flares.length - 1; i >= 0; i--) {
      const f = this.flares[i];
      f.age += dt;
      const sp = f.v.length();
      f.v.multiplyScalar(1 / (1 + 0.035 * sp * dt));
      f.v.y -= GRAVITY * dt;
      f.pos.addScaledVector(f.v, dt);
      const left = f.life - f.age;
      f.heat = THREE.MathUtils.smoothstep(left, 0, 0.8);
      f.sprite.position.copy(f.pos);
      f.sprite.scale.setScalar(2.4 * Math.sqrt(Math.max(0.01, f.heat)));
      f.puffT += dt;
      if (f.puffT > 0.05) {
        f.puffT = 0;
        particles.emit('trail', f.pos, undefined, { scale: 0.65, life: 0.9 });
      }
      const tail = this._b.copy(f.pos).addScaledVector(f.v, -0.014);
      streaks.add(tail, f.pos, 14 * f.heat, 10 * f.heat, 4 * f.heat, 1, 0.09, 0.14);
      const surf = ground.surface(f.pos.x, f.pos.z);
      if (left <= 0 || f.pos.y < surf || f.eaten) {
        fxParent.remove(f.sprite);
        f.sprite.material.dispose();
        this.flares.splice(i, 1);
      }
    }
  }

  private updateDying(dt: number, ground: SurfaceQuery, particles: Particles, explosions: Explosions): void {
    if (this.crashed) return;
    this.vel.y -= GRAVITY * 1.45 * dt;
    this.vel.multiplyScalar(Math.exp(-0.15 * dt));
    this.pos.addScaledVector(this.vel, dt);
    this.tumblePitch += 3.2 * dt;
    this.tumbleRoll += 4.5 * dt;
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.set(this.tumblePitch, this.tumbleYaw, this.tumbleRoll, 'YXZ');
    this.updatePlumes(0, 0, false);
    this.reactorGlare.visible = false;
    this.reactorHalo.visible = false;

    this.smokeT += dt;
    while (this.smokeT > 0.025) {
      this.smokeT -= 0.025;
      particles.emit('darkSmoke', this.pos, this._b.set(0, 1.5, 0), { scale: 0.85, life: 0.8 });
      particles.emit('fire', this.pos, this._b.copy(this.vel).multiplyScalar(-0.06), { scale: 0.7 });
    }
    if (this.pos.y < ground.surface(this.pos.x, this.pos.z) + 1.5 || this.modeT > 12) {
      explosions.blast(this.pos, 11, { debris: 18, burn: !ground.isWater(this.pos.x, this.pos.z) });
      this.crashed = true;
      this.mesh.visible = false;
    }
  }

  private chestWorldPos(out: THREE.Vector3): THREE.Vector3 {
    this.mesh.updateMatrixWorld(true);
    return out.set(0, 0.45, 0.24).applyMatrix4(this.body.matrixWorld);
  }

  private syncTransform(forwardDir: THREE.Vector3, roll: number): void {
    const f = forwardDir.lengthSq() > 1e-6 ? forwardDir : new THREE.Vector3(0, 0, 1);
    const upRef = Math.abs(f.y) > 0.96 ? new THREE.Vector3(1, 0, 0) : UP;
    this._m.lookAt(new THREE.Vector3(), f, upRef);
    this.q.setFromRotationMatrix(this._m);
    // lookAt points -Z at target; model faces +Z
    this.q.multiply(this._q2.setFromAxisAngle(UP, Math.PI));
    this.q.multiply(this._q2.setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll));
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.copy(this.q);
    this.body.rotation.x = this.posture;
  }

  private poseArms(dt: number, state: 'flight' | 'dash' | 'fire' | 'beam' | 'iced', t: number): void {
    let rxL = -0.12;
    let rxR = -0.12;
    let rzL = 0.14;
    let rzR = -0.14;
    if (state === 'dash') {
      rxL = rxR = 0.08;
      rzL = 0.06;
      rzR = -0.06;
    } else if (state === 'fire') {
      rxL = -1.35;
      rxR = -1.35;
      rzL = 0.1;
      rzR = -0.1;
    } else if (state === 'beam') {
      rxL = rxR = 0.25;
      rzL = 0.58;
      rzR = -0.58;
    } else if (state === 'iced') {
      rxL = -0.4 + Math.sin(t * 2) * 0.15;
      rxR = 0.35 - Math.sin(t * 2) * 0.15;
      rzL = 0.85;
      rzR = -0.85;
    }
    const k = 1 - Math.exp(-dt * 8);
    this.armL.rotation.x += (rxL - this.armL.rotation.x) * k;
    this.armR.rotation.x += (rxR - this.armR.rotation.x) * k;
    this.armL.rotation.z += (rzL - this.armL.rotation.z) * k;
    this.armR.rotation.z += (rzR - this.armR.rotation.z) * k;
  }

  private updatePlumes(t: number, power: number, lit: boolean): void {
    const flick = 0.85 + 0.15 * Math.sin(t * 58 + this.seed);
    for (let i = 0; i < 2; i++) {
      this.bootPlumes[i].visible = lit;
      this.bootCones[i].visible = lit;
      this.palmPlumes[i].visible = lit;
      if (lit) {
        const s = Math.max(0.25, power) * flick;
        this.bootPlumes[i].scale.setScalar(1.15 * s);
        this.bootCones[i].scale.set(0.85 + 0.25 * s, 1.1 * s, 0.85 + 0.25 * s);
        this.palmPlumes[i].scale.setScalar(0.55 * s);
      }
    }
  }

  private updateFrostMaterial(): void {
    const k = this.iced ? 1 : this.icing;
    this.bodyMat.emissive.copy(ZERO_COLOR).lerp(FROST_EMISSIVE, k * 0.65);
    this.bodyMat.emissiveIntensity = k > 0.02 ? 0.55 + 0.45 * k : 0;
    this.bodyMat.roughness = THREE.MathUtils.lerp(0.36, 0.82, k);
  }
}
