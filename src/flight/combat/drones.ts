import * as THREE from 'three';
import type { Particles } from '../fx/particles';
import type { Streaks } from '../fx/streaks';
import type { EventBus } from '../sim/events';
import type { Explosions, SurfaceQuery } from './explosions';
import type { Missiles } from './missiles';
import { box, glowMaterial, loft, merge, paint, type V3 } from './modelKit';
import type { DamageKind, Hostile, HostileKind, HouseTarget, PlayerTarget } from './types';

/**
 * Hostile drones: tailless jet UCAVs, gunmetal with a red sensor eye.
 * Each flies a simple fighter brain — find the suit, run in leading it,
 * fire short cannon bursts inside 900 m, overshoot and extend, come round
 * again — plus terrain avoidance, a hard break when a rocket is on it, and
 * the odd heat seeker from range. Shot down, it trails fire and smoke all
 * the way in and blows again where it hits.
 *
 * The same airframe comes in three more builds ({@link DRONE_TYPES}):
 *  - interceptors, stretched and dark: twice as fast, quicker with their
 *    seekers, and too fast to turn with — they slash through and extend;
 *  - jammers, a radome on the back: unarmed, they stand off and blind the
 *    suit's seekers (and can't be painted themselves), and run when chased;
 *  - bombers, three times the size: they ignore the suit and fly runs on
 *    the house, with a tail gun for whoever follows them in.
 */

const mats = {
  body: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.35, roughness: 0.5 }),
  glow: glowMaterial(),
};

const C = {
  top: 0x6c737c,
  side: 0x5c626a,
  belly: 0x464b52,
  edge: 0x2a2d32,
  flap: 0x50555c,
  dark: 0x131416,
  glass: 0x07090c,
  red: 0x5c1410,
  store: 0x8e9194,
  storeNose: 0x2e3134,
};

let geoCache: { body: THREE.BufferGeometry; glow: THREE.BufferGeometry } | null = null;

/** The airframe, nose +Z: two merged geometries shared by every drone. */
function droneGeometry() {
  if (geoCache) return geoCache;
  const body: THREE.BufferGeometry[] = [];
  const glow: THREE.BufferGeometry[] = [];

  // Fuselage: a chined, flat-bottomed blended body lofted nose to tail
  const sec = (z: number, w: number, t: number, b: number, c = 0): V3[] => [
    [0, t, z], [0.55 * w, 0.82 * t, z], [w, c, z], [0.62 * w, 0.75 * b, z],
    [0, b, z], [-0.62 * w, 0.75 * b, z], [-w, c, z], [-0.55 * w, 0.82 * t, z],
  ];
  body.push(
    loft(
      [
        sec(2.3, 0.02, 0.01, -0.01),
        sec(1.95, 0.2, 0.11, -0.08, -0.01),
        sec(1.35, 0.4, 0.25, -0.15, -0.02),
        sec(0.6, 0.55, 0.33, -0.2, -0.02),
        sec(-0.3, 0.58, 0.31, -0.2, -0.02),
        sec(-1.2, 0.5, 0.24, -0.17),
        sec(-1.85, 0.32, 0.16, -0.12),
        sec(-2.0, 0.27, 0.13, -0.1),
      ],
      (e, s) => {
        // A dark sensor brow over the nose; chines a shade darker; grey belly
        if (s === 1 && (e === 0 || e === 7)) return C.glass;
        if (e === 0 || e === 7 || s < 0 || s > 6) return C.top;
        if (e === 1 || e === 6) return C.side;
        return C.belly;
      },
    ),
  );

  // Cranked flying wing: diamond-ish aerofoil, dark leading edge, elevons
  const wingSec = (x: number, zLE: number, zTE: number, th: number, y: number): V3[] => {
    const ch = zLE - zTE;
    return [
      [x, y, zLE], [x, y + th, zLE - ch * 0.3], [x, y + th * 0.45, zTE + ch * 0.25],
      [x, y, zTE], [x, y - th * 0.3, zTE + ch * 0.25], [x, y - th * 0.55, zLE - ch * 0.3],
    ];
  };
  for (const s of [-1, 1]) {
    body.push(
      loft(
        [wingSec(s * 0.25, 0.66, -1.2, 0.1, -0.05), wingSec(s * 0.92, 0.12, -0.85, 0.07, -0.04), wingSec(s * 2.05, -0.86, -1.2, 0.025, 0.02)],
        (e, seg) => {
          if (e === 0 || e === 5) return C.edge;
          if (e === 2 && seg === 1) return C.flap;
          if (e >= 3) return C.belly;
          return C.top;
        },
        [false, true],
      ),
    );
    // Canted tail fins with red tips
    body.push(
      loft(
        [
          [[0.03, 0, -0.78], [0, 0, -1.6], [-0.03, 0, -0.78], [0, 0, -0.5]].map(([x, y, z]) => [x, y, z] as V3),
          [[0.016, 0.52, -1.28], [0, 0.52, -1.62], [-0.016, 0.52, -1.28], [0, 0.52, -1.14]].map(([x, y, z]) => [x, y, z] as V3),
          [[0.012, 0.62, -1.38], [0, 0.62, -1.63], [-0.012, 0.62, -1.38], [0, 0.62, -1.28]].map(([x, y, z]) => [x, y, z] as V3),
        ],
        (_e, seg) => (seg >= 1 ? C.red : C.side),
      )
        .rotateZ(-s * 0.55)
        .translate(s * 0.26, 0.13, 0),
    );
    // A heat seeker on a pylon under each wing
    const x = s * 1.05;
    body.push(
      box(0.05, 0.11, 0.5, C.dark, x, -0.12, -0.05),
      paint(new THREE.CylinderGeometry(0.055, 0.055, 1.0, 8).rotateX(Math.PI / 2).translate(x, -0.235, -0.1), C.store),
      paint(new THREE.ConeGeometry(0.055, 0.2, 8).rotateX(Math.PI / 2).translate(x, -0.235, 0.5), C.storeNose),
      box(0.26, 0.012, 0.12, C.storeNose, x, -0.235, -0.52),
      box(0.012, 0.26, 0.12, C.storeNose, x, -0.235, -0.52),
    );
    // Nav lights on the wingtips: red to port (−x), green to starboard
    glow.push(paint(new THREE.BoxGeometry(0.05, 0.03, 0.08).translate(s * 2.04, 0.02, -0.92), s < 0 ? 0xff2010 : 0x20ff40, 3));
  }

  // Dorsal intake: a scoop faired into the spine, its mouth black
  const intake = (z: number, w0: number, w1: number, y0: number, y1: number): V3[] => [
    [w0, y0, z], [w1, y1, z], [-w1, y1, z], [-w0, y0, z],
  ];
  body.push(
    loft(
      [intake(0.95, 0.3, 0.24, 0.2, 0.42), intake(0.45, 0.31, 0.24, 0.22, 0.45), intake(-0.4, 0.18, 0.12, 0.24, 0.35)],
      (e, s) => (s < 0 ? C.dark : e === 1 ? C.top : C.side),
    ),
  );
  // Flattened 2D nozzle round the tail, the hot core inside it
  const nozzle = (z: number, w: number, y0: number, y1: number): V3[] => [
    [w, y0, z], [w * 0.92, y1, z], [-w * 0.92, y1, z], [-w, y0, z],
  ];
  body.push(loft([nozzle(-1.72, 0.31, -0.07, 0.15), nozzle(-2.08, 0.26, -0.03, 0.1)], C.dark, [false, false]));
  glow.push(paint(new THREE.PlaneGeometry(0.44, 0.11).rotateY(Math.PI).translate(0, 0.035, -2.05), new THREE.Color(1, 0.45, 0.12), 3));
  // Weapons-bay doors on the belly
  body.push(box(0.36, 0.02, 1.0, C.edge, 0, -0.2, 0.15));
  // Chin sensor ball with the red eye in it
  body.push(paint(new THREE.SphereGeometry(0.1, 12, 8).translate(0, -0.11, 1.55), C.glass));
  glow.push(paint(new THREE.CircleGeometry(0.06, 12).scale(1.4, 0.8, 1).translate(0, -0.11, 1.652), new THREE.Color(1, 0.06, 0.02), 6));

  geoCache = { body: merge(body), glow: merge(glow) };
  return geoCache;
}

let glowTex: THREE.Texture | null = null;
function exhaustTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,240,220,1)');
  grad.addColorStop(0.3, 'rgba(255,160,70,0.7)');
  grad.addColorStop(1, 'rgba(255,80,20,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}

let nextId = 1;

export interface Round {
  p: THREE.Vector3;
  v: THREE.Vector3;
  life: number;
  /** Armour it takes off on a hit (default 4). */
  dmg?: number;
}

/** Beyond this far from the suit (m) an attacking drone runs in at {@link INGRESS_DASH} × cruise. */
const INGRESS_DIST = 1800;
const INGRESS_DASH = 1.5;

type Mode = 'patrol' | 'attack' | 'extend' | 'break' | 'dying';

export type DroneType = 'drone' | 'interceptor' | 'jammer' | 'bomber';

interface DroneSpec {
  label?: string;
  hp: number;
  /** The airframe's scale (x, y, z) and the hit sphere that goes with it (m). */
  scale: V3;
  radius: number;
  /** Tint over the paint, and the exhaust's colour and size. */
  tint: number;
  flame: number;
  flameSize: number;
  /** Cruise speed: least, and the spread over it (m/s). */
  cruise: readonly [number, number];
  /** The pull it turns at (g), and its dash running in from far out (× cruise). */
  g: number;
  dash: number;
  /** Nose cannon (bursts in the cone) or a turret that fires any way it likes. */
  guns: 'nose' | 'turret' | null;
  /** Heat seekers: seconds to the first, and between them (least, spread). */
  seekers: readonly [number, number, number, number] | null;
  role: 'fighter' | 'jammer' | 'bomber';
}

export const DRONE_TYPES: Record<DroneType, DroneSpec> = {
  drone: { hp: 100, scale: [1, 1, 1], radius: 2.6, tint: 0xffffff, flame: 0xffc080, flameSize: 1.6, cruise: [165, 45], g: 7.5, dash: 1.5, guns: 'nose', seekers: [14, 16, 18, 16], role: 'fighter' },
  interceptor: { label: 'INT', hp: 80, scale: [0.8, 0.85, 1.35], radius: 2.6, tint: 0x4a4e5c, flame: 0x9fd0ff, flameSize: 2.6, cruise: [280, 40], g: 11, dash: 1.15, guns: 'nose', seekers: [5, 6, 9, 6], role: 'fighter' },
  jammer: { label: 'JAM', hp: 130, scale: [1.3, 1.3, 1.3], radius: 3.4, tint: 0xd8c9a0, flame: 0xffc080, flameSize: 1.8, cruise: [150, 20], g: 6, dash: 1, guns: null, seekers: null, role: 'jammer' },
  bomber: { label: 'BMR', hp: 420, scale: [3.2, 3.2, 3.2], radius: 7.5, tint: 0x8f9a86, flame: 0xffb070, flameSize: 5, cruise: [120, 15], g: 3, dash: 1.2, guns: 'turret', seekers: null, role: 'bomber' },
};

/** A jammer stands off this far from the suit (m), and runs when it comes inside {@link JAM_FLEE}. */
const JAM_STANDOFF = 2400;
const JAM_FLEE = 1100;
/** …and blinds the seekers out to here (m). */
export const JAM_RANGE = 4500;
/** A bomber's run: height over the house (m), how far out it lets go (m), bombs in a stick, the gap between them (s), and the share of the house each takes. */
const BOMB_HEIGHT = 520;
const BOMB_RELEASE = 1300;
const BOMB_STICK = 2;
const BOMB_GAP = 0.6;
export const BOMB_DAMAGE = 0.07;
/** After a stick it runs on this long (s) before it comes round for another. */
const BOMB_EXTEND = 16;

const variantMats = new Map<DroneType, THREE.MeshStandardMaterial>();
function bodyMaterial(type: DroneType): THREE.MeshStandardMaterial {
  if (type === 'drone') return mats.body;
  let m = variantMats.get(type);
  if (!m) {
    m = mats.body.clone();
    m.color.set(DRONE_TYPES[type].tint);
    variantMats.set(type, m);
  }
  return m;
}

let radomeGeo: { body: THREE.BufferGeometry; glow: THREE.BufferGeometry } | null = null;
/** The jammer's emitter: a flat dish on a pylon over the spine, an amber ring round its rim. */
function radome() {
  if (radomeGeo) return radomeGeo;
  radomeGeo = {
    body: merge([
      box(0.1, 0.34, 0.5, C.dark, 0, 0.42, -0.2),
      paint(new THREE.CylinderGeometry(0.95, 1.05, 0.14, 20).translate(0, 0.64, -0.2), C.edge),
    ]),
    glow: merge([paint(new THREE.TorusGeometry(1.02, 0.03, 6, 28).rotateX(Math.PI / 2).translate(0, 0.64, -0.2), new THREE.Color(1, 0.55, 0.08), 4)]),
  };
  return radomeGeo;
}

export class Drone implements Hostile {
  readonly id = nextId++;
  readonly kind: HostileKind;
  readonly label?: string;
  readonly noLock?: boolean;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly radius: number;
  readonly maxHp: number;
  hp: number;
  alive = true;
  private readonly spec: DroneSpec;
  threatened = 0;
  readonly mesh = new THREE.Group();
  mode: Mode = 'patrol';
  /** Scripted drones hold their course and don't shoot back. */
  passive = false;
  private modeT = 0;
  private gunT = 0;
  private burst = 0;
  private missileT: number;
  private lockT = 0;
  /** Bombs left in the stick being dropped, the time to the next (s), and the roof it is laid on. */
  private stick = 0;
  private stickT = 0;
  private mark: THREE.Vector3 | null = null;
  /** Which way round a jammer circles. */
  private readonly orbit = Math.random() < 0.5 ? -1 : 1;
  private readonly q = new THREE.Quaternion();
  private roll = 0;
  private readonly exhaust: THREE.Sprite;
  private readonly cruise: number;
  private readonly jink = Math.random() * 100;
  private smokeT = 0;
  private spin = 0;
  private readonly _v = new THREE.Vector3();
  private readonly _w = new THREE.Vector3();
  private readonly _m = new THREE.Matrix4();
  private readonly patrolAt = new THREE.Vector3();
  /** Set when it hit the ground dying (the manager removes it). */
  crashed = false;
  flybyDone = false;

  constructor(at: THREE.Vector3, heading: THREE.Vector3, readonly type: DroneType = 'drone') {
    const sp = (this.spec = DRONE_TYPES[type]);
    this.kind = type;
    this.label = sp.label;
    if (sp.role === 'jammer') this.noLock = true;
    this.radius = sp.radius;
    this.maxHp = this.hp = sp.hp;
    this.cruise = sp.cruise[0] + Math.random() * sp.cruise[1];
    this.missileT = sp.seekers ? sp.seekers[0] + Math.random() * sp.seekers[1] : Infinity;
    const g = droneGeometry();
    // (the airframe in its own group, so the build's scale leaves the exhaust sprite alone)
    const frame = new THREE.Group();
    frame.add(new THREE.Mesh(g.body, bodyMaterial(type)), new THREE.Mesh(g.glow, mats.glow));
    if (sp.role === 'jammer') {
      const r = radome();
      frame.add(new THREE.Mesh(r.body, bodyMaterial(type)), new THREE.Mesh(r.glow, mats.glow));
    }
    frame.scale.set(...sp.scale);
    this.mesh.add(frame);
    this.mesh.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = false;
    });
    this.exhaust = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: exhaustTexture(), color: sp.flame, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.exhaust.scale.setScalar(sp.flameSize);
    this.mesh.add(this.exhaust);
    this.exhaust.position.set(0, 0.02 * sp.scale[1], -2.4 * sp.scale[2]);
    this.pos.copy(at);
    this.vel.copy(heading).normalize().multiplyScalar(this.cruise);
    this.patrolAt.copy(at);
  }

  damage(amount: number, at: THREE.Vector3, kind: DamageKind): boolean {
    if (!this.alive) return false;
    this.hp -= amount;
    void at;
    void kind;
    if (this.hp <= 0) {
      this.alive = false;
      this.mode = 'dying';
      this.spin = (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 3);
      return true;
    }
    // Hit: it flinches into a break (a bomber holds its run)
    if (this.spec.role !== 'bomber' && this.mode === 'attack' && Math.random() < 0.4) this.setMode('break');
    return false;
  }

  private setMode(m: Mode): void {
    this.mode = m;
    this.modeT = 0;
  }

  update(
    dt: number,
    t: number,
    player: PlayerTarget,
    ground: SurfaceQuery,
    rounds: Round[],
    missiles: Missiles,
    particles: Particles,
    explosions: Explosions,
    events: EventBus,
    house?: HouseTarget,
  ): void {
    const spec = this.spec;
    const big = spec.scale[2];
    this.modeT += dt;
    this.threatened = Math.max(0, this.threatened - dt);
    const speed = this.vel.length();
    const dir = this._v.copy(this.vel).divideScalar(Math.max(speed, 1));
    const toP = this._w.copy(player.pos).sub(this.pos);
    const dist = toP.length();

    if (this.mode === 'dying') {
      // Falling wreck: nose drops, it rolls, burns and smokes
      this.vel.y -= 9.81 * dt * 1.4;
      this.vel.multiplyScalar(Math.exp(-0.15 * dt));
      this.pos.addScaledVector(this.vel, dt);
      this.roll += this.spin * dt;
      this.smokeT += dt;
      while (this.smokeT > 0.025) {
        this.smokeT -= 0.025;
        particles.emit('darkSmoke', this.pos, this._w.set(0, 1, 0), { scale: 0.45 * big, life: 0.6 });
        particles.emit('fire', this.pos, this._w.copy(this.vel).multiplyScalar(-0.05), { scale: 0.45 * big });
      }
      this.orient(dt, this.vel.clone().normalize(), 0);
      if (this.pos.y < ground.surface(this.pos.x, this.pos.z) + 1) {
        explosions.blast(this.pos, 7 * Math.sqrt(big), { debris: 10, burn: !ground.isWater(this.pos.x, this.pos.z) });
        this.crashed = true;
      }
      return;
    }

    // ── Brain ──────────────────────────────────────────────────────────
    let want = new THREE.Vector3();
    const facing = dist > 1 ? dir.dot(toP) / dist : 0;
    if (this.passive) {
      want.copy(dir);
    } else if (spec.role === 'jammer' && this.mode !== 'break') {
      // Stand off: circle the suit out of its reach, above it; run when it closes
      const away = toP.clone().setY(0).normalize().negate();
      if (dist < JAM_FLEE) want.copy(away).setY(0.12);
      else {
        const tangent = new THREE.Vector3(-away.z, 0, away.x).multiplyScalar(this.orbit);
        want.copy(tangent).addScaledVector(away, THREE.MathUtils.clamp((JAM_STANDOFF - dist) / 600, -1, 1));
        want.y = THREE.MathUtils.clamp((player.pos.y + 350 - this.pos.y) / 400, -0.3, 0.3);
      }
      want.normalize();
      this.mode = 'attack';
      if (this.threatened > 0.5 && Math.random() < dt * 1.5) this.setMode('break');
    } else if (spec.role === 'bomber' && house && house.marks.length) {
      want.copy(this.bomb(dt, dir, house, missiles, explosions, events));
    } else switch (this.mode) {
      case 'patrol':
        // Orbit the patrol point until the suit comes near (or is seen firing)
        want.copy(this.patrolAt).sub(this.pos).setY(0);
        if (want.length() < 400) want.set(-dir.z, 0, dir.x);
        want.normalize();
        if (dist < 5500) this.setMode('attack');
        break;
      case 'attack': {
        // Lead pursuit
        const tgo = dist / Math.max(speed + 300, 200);
        want.copy(player.pos).addScaledVector(player.vel, tgo).sub(this.pos).normalize();
        if (dist < 160) this.setMode('extend');
        if (this.threatened > 0.5 && Math.random() < dt * 1.5) this.setMode('break');
        break;
      }
      case 'extend':
        // Run out past the suit, then come round
        want.copy(dir).addScaledVector(toP.clone().normalize(), -0.4).setY(dir.y * 0.5 + 0.15).normalize();
        // (an interceptor is already a long way out by then: it comes straight round)
        if (this.modeT > (this.type === 'interceptor' ? 1.5 : 3.5 + Math.random() * 2)) this.setMode('attack');
        break;
      case 'break': {
        // Hard jinking turn across the threat
        const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(Math.sin(t * 1.3 + this.jink) > 0 ? 1 : -1);
        want.copy(dir).addScaledVector(side, 1.6).add(new THREE.Vector3(0, Math.sin(t * 2.1 + this.jink) * 0.6, 0)).normalize();
        if (this.modeT > 2.5) this.setMode('attack');
        break;
      }
    }
    // Terrain avoidance: look ahead and pull up hard if low
    const ahead = this.pos.clone().addScaledVector(this.vel, 2.5);
    const floor = Math.max(ground.surface(ahead.x, ahead.z), ground.surface(this.pos.x, this.pos.z), 0);
    // …judged from where the dive is taking it: the height it will lose
    // pulling out at its own g (a fast one needs a lot of sky, and one that
    // misjudged it used to fly into the sea and quietly vanish)
    const sink = Math.max(0, -this.vel.y) / Math.max(speed, 1);
    const pullOut = ((speed * speed) / (spec.g * 9.81)) * (1 - Math.sqrt(Math.max(0, 1 - sink * sink)));
    const clearance = this.pos.y - floor - (this.passive ? 0 : pullOut * 1.25);
    const safe = this.passive ? 40 : 140 + 30 * (big - 1);
    if (clearance < safe) {
      // Pull up along the way it's going: turning for a target behind it
      // from a dive, the short way round used to be down through the ground
      const h = Math.max(Math.hypot(dir.x, dir.z), 1e-3);
      want.set(dir.x / h + 0.3 * want.x, Math.max(want.y, 0.25 + (safe - clearance) / safe), dir.z / h + 0.3 * want.z);
    }
    if (this.pos.y > 4000) want.y = Math.min(want.y, -0.2);
    want.normalize();

    // ── Fly: turn the velocity toward `want` within the g limit ───────
    const maxRate = (spec.g * 9.81) / Math.max(speed, 80);
    const ang = dir.angleTo(want);
    if (ang > 1e-4) {
      const axis = new THREE.Vector3().crossVectors(dir, want).normalize();
      dir.applyAxisAngle(axis, Math.min(ang, maxRate * dt));
    }
    // Running in from far out they dash, and settle to cruise for the merge
    const fleeing = spec.role === 'jammer' && dist < JAM_FLEE;
    const dash = fleeing ? 1.3 : spec.role !== 'fighter' ? 1 : this.mode === 'extend' ? 1.25 : this.mode === 'attack' && dist > INGRESS_DIST ? Math.min(spec.dash, INGRESS_DASH) : 1;
    const sp = speed + (this.cruise * dash - speed) * (1 - Math.exp(-dt * 0.8));
    // Bank into the turn: roll by the lateral acceleration
    const lateral = new THREE.Vector3().crossVectors(dir, want).y;
    this.roll += (THREE.MathUtils.clamp(-lateral * 4, -1.3, 1.3) - this.roll) * (1 - Math.exp(-dt * 3));
    this.vel.copy(dir).multiplyScalar(sp);
    this.pos.addScaledVector(this.vel, dt);
    this.orient(dt, dir, this.roll);
    this.exhaust.material.opacity = 0.75 + 0.25 * Math.sin(t * 50 + this.jink);

    // ── Guns: short bursts when the suit is in the cone and in range ──
    this.gunT -= dt;
    const inSights = spec.guns === 'turret' ? dist < 800 : spec.guns === 'nose' && this.mode === 'attack' && dist < 950 && facing > 0.985;
    if (inSights && !this.passive && player.alive) {
      if (this.gunT <= 0 && this.burst <= 0) {
        this.burst = 4 + Math.floor(Math.random() * 3);
        this.gunT = 0.9 + Math.random() * 0.8;
        events.emit('enemyFire', { at: this.pos, value: this.burst });
      }
    }
    if (this.burst > 0) {
      this.burstT -= dt;
      if (this.burstT <= 0) {
        this.burstT = 0.07;
        this.burst--;
        // (a bomber's gun is in its tail)
        const muzzle = this.pos.clone().addScaledVector(dir, spec.guns === 'turret' ? -2 * big : 2.4 * big);
        const tgo = dist / 900;
        const aim = player.pos.clone().addScaledVector(player.vel, tgo).sub(muzzle).normalize();
        // Spread: they're drones, not snipers
        aim.add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(spec.guns === 'turret' ? 0.05 : 0.035)).normalize();
        rounds.push({ p: muzzle, v: aim.multiplyScalar(900).add(this.vel), life: 1.6 });
        particles.emit('flash', muzzle, undefined, { scale: 0.09 });
      }
    }

    // ── Heat seeker from range ───────────────────────────────────────
    this.missileT -= dt;
    if (spec.seekers && this.mode === 'attack' && !this.passive && player.alive && dist > 700 && dist < 2800 && facing > 0.9) {
      this.lockT += dt;
      if (this.lockT > 1.6 && this.missileT <= 0) {
        missiles.launch({ team: 'enemy', from: this.pos.clone().addScaledVector(dir, -0.5).add(new THREE.Vector3(0, -0.5, 0)), vel: this.vel, target: player });
        events.emit('enemyMissile', { at: this.pos });
        this.missileT = spec.seekers[2] + Math.random() * spec.seekers[3];
        this.lockT = 0;
      }
    } else {
      this.lockT = Math.max(0, this.lockT - dt);
    }
  }

  private burstT = 0;

  /**
   * A bomber's run: in on the house at height, a stick of glide bombs let go
   * short of it, on over the top and out, then round for another. Returns
   * the way it wants to fly.
   */
  private bomb(dt: number, dir: THREE.Vector3, house: HouseTarget, missiles: Missiles, explosions: Explosions, events: EventBus): THREE.Vector3 {
    const want = new THREE.Vector3();
    this.mark ??= house.marks[Math.floor(Math.random() * house.marks.length)];
    const to = want.copy(this.mark).sub(this.pos);
    const flat = Math.hypot(to.x, to.z);
    const climb = THREE.MathUtils.clamp((this.mark.y + BOMB_HEIGHT - this.pos.y) / 300, -0.35, 0.35);
    if (this.mode === 'extend') {
      // Straight on over the house and away
      want.copy(dir).setY(climb).normalize();
      if (this.modeT > BOMB_EXTEND) {
        this.mark = null;
        this.setMode('attack');
      }
      return want;
    }
    this.mode = 'attack';
    to.setY(0).normalize();
    const lined = dir.x * to.x + dir.z * to.z > 0.96 * Math.hypot(dir.x, dir.z);
    to.setY(climb).normalize();
    if (this.stick === 0 && flat < BOMB_RELEASE && lined) {
      this.stick = BOMB_STICK;
      this.stickT = 0;
    }
    if (this.stick > 0) {
      this.stickT -= dt;
      if (this.stickT <= 0) {
        this.stickT = BOMB_GAP;
        this.stick--;
        const at = house.marks[Math.floor(Math.random() * house.marks.length)];
        const from = this.pos.clone().add(new THREE.Vector3(0, -0.8 * this.spec.scale[1], 0));
        missiles.launch({ team: 'enemy', from, vel: this.vel, target: null, aimPoint: at, onImpact: (p) => house.struck(p, BOMB_DAMAGE), coast: 0.5, caliber: 0.2, length: 2.6 });
        explosions.muzzle(from, dir, 1.2);
        events.emit('enemyMissile', { at: from });
        if (this.stick === 0) this.setMode('extend');
      }
    }
    return to;
  }

  private orient(dt: number, dir: THREE.Vector3, roll: number): void {
    void dt;
    this._m.lookAt(new THREE.Vector3(), dir, new THREE.Vector3(0, 1, 0));
    this.q.setFromRotationMatrix(this._m);
    // lookAt points −Z at the target; the model's nose is +Z
    this.q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
    this.q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll));
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.copy(this.q);
  }
}

/** Drone cannon rounds in flight: drawn as tracers, tested against the suit. */
export class Guns {
  readonly rounds: Round[] = [];
  private readonly _v = new THREE.Vector3();
  private readonly _a = new THREE.Vector3();
  private readonly _b = new THREE.Vector3();

  update(dt: number, player: PlayerTarget, ground: SurfaceQuery, particles: Particles, streaks: Streaks, events: EventBus): void {
    for (let i = this.rounds.length - 1; i >= 0; i--) {
      const r = this.rounds[i];
      const prev = this._a.copy(r.p);
      r.v.y -= 9.81 * dt;
      r.p.addScaledVector(r.v, dt);
      r.life -= dt;
      // Segment vs the suit's hit sphere
      if (player.alive) {
        const seg = this._v.copy(r.p).sub(prev);
        const len = seg.length();
        const t = THREE.MathUtils.clamp(this._b.copy(player.pos).sub(prev).dot(seg) / Math.max(len * len, 1e-6), 0, 1);
        const closest = this._b.copy(prev).addScaledVector(seg, t);
        if (closest.distanceToSquared(player.pos) < 1.15 ** 2) {
          player.hit(r.dmg ?? 4, closest, 'bullet');
          particles.burst('spark', closest, 8, 12, seg.normalize().negate(), 0.9);
          this.rounds.splice(i, 1);
          continue;
        }
        // Near miss: a crack past the suit
        if (closest.distanceToSquared(player.pos) < 9 && Math.random() < 0.3) events.emit('ricochet', { at: closest });
      }
      const surf = ground.surface(r.p.x, r.p.z);
      if (r.p.y < surf || r.life <= 0) {
        if (r.p.y < surf + 2) {
          const at = this._b.set(r.p.x, surf + 0.2, r.p.z);
          particles.burst(ground.isWater(at.x, at.z) ? 'spray' : 'dust', at, 3, 5, new THREE.Vector3(0, 1, 0), 0.6, { scale: 0.6 });
        }
        this.rounds.splice(i, 1);
        continue;
      }
      // Tracer: a hot orange dash behind the round
      const tail = this._b.copy(r.p).addScaledVector(r.v, -0.018);
      streaks.add(tail, r.p, 6, 2.2, 0.6, 1, 0.07, 0.12);
    }
  }
}
