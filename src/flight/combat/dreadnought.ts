import * as THREE from 'three';
import type { Particles } from '../fx/particles';
import type { EventBus } from '../sim/events';
import type { Heightfield } from '../world/heightfield';
import type { Round } from './drones';
import type { Explosions } from './explosions';
import type { Missiles } from './missiles';
import { beam, box, frustum, glowMaterial, loft, merge, paint, panelOn, type V3 } from './modelKit';
import type { DamageKind, Hostile, HouseTarget, PlayerTarget } from './types';

/**
 * The dreadnought: a 120 m armed flying wing that comes in off the sea, takes
 * up a slow circle round the house and shells it until one of them is gone.
 * It is fought a piece at a time, like the frigate, and there are two ways
 * to bring it down:
 *  - the reactor core under its belly, behind a shield two emitter masts
 *    (one on the back, one under the tail) hold up: shoot both masts off and
 *    the core is open;
 *  - or its four engines: each one out slows it and tips it, and with the
 *    last gone it falls.
 * Meanwhile three ball turrets (two on the back, one under the chin) gun for
 * the suit, two batteries ripple seekers at it, a hangar in the tail puts
 * drones up, and the long cannon under the nose is the one laid on the house:
 * knock that out first and the house is safe from it.
 */

const mats = {
  paint: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.45, roughness: 0.55 }),
  glow: glowMaterial(),
  charred: new THREE.MeshStandardMaterial({ color: 0x0b0b0c, metalness: 0.2, roughness: 0.95 }),
};

const C = {
  top: 0x596069,
  side: 0x4b5158,
  belly: 0x363a40,
  edge: 0x17191c,
  dark: 0x0c0d0f,
  steel: 0x5b6067,
  red: 0x5c1410,
  glass: 0x07090c,
};

/** Cruise speed with all four engines (m/s), and the least height it holds over the sea or the ground under it (m). */
const SPEED = 30;
const ALT = 520;
const CLEARANCE = 330;
/** The circle it holds round the house (m). */
const HOLD_R = 1500;
/** Turrets: reach (m), round speed (m/s), rounds a second, burst and pause (s), armour a round takes off. */
const TURRET_RANGE = 1900;
const TURRET_ROUND = 1000;
const TURRET_RATE = 11;
const TURRET_BURST = 1.5;
const TURRET_PAUSE = 2.2;
const TURRET_DAMAGE = 3;
/** Batteries: reach (m), seekers in a salvo and the gap between them (s). */
const BATTERY_RANGE = 4800;
const BATTERY_SALVO = 3;
const BATTERY_GAP = 0.5;
/** The cannon: how near the house it opens up (m), seconds between rounds, and the share of the house each takes. */
const CANNON_RANGE = 2900;
const CANNON_RELOAD = 7;
export const CANNON_DAMAGE = 0.06;
/** The hangar: seconds between launches, and the most of its own drones it keeps up. */
const HANGAR_EVERY = 16;
const HANGAR_MAX = 3;
/** The hull, as far as the suit is concerned: an ellipsoid's half-axes (m). */
const HULL = new THREE.Vector3(18, 9, 62);

type Role = 'engine' | 'turret' | 'battery' | 'emitter' | 'cannon' | 'hangar' | 'core';

const STATS: Record<Role, { hp: number; radius: number; label: string }> = {
  engine: { hp: 650, radius: 5, label: 'ENGINE' },
  turret: { hp: 260, radius: 3, label: 'TURRET' },
  battery: { hp: 340, radius: 4, label: 'MSL BTY' },
  emitter: { hp: 380, radius: 3.5, label: 'SHIELD' },
  cannon: { hp: 550, radius: 4.5, label: 'CANNON' },
  hangar: { hp: 420, radius: 5, label: 'HANGAR' },
  core: { hp: 2400, radius: 6.5, label: 'CORE' },
};

let nextId = 9000;

/** One lockable, destructible piece of the dreadnought. */
export class BossPart implements Hostile {
  readonly id = nextId++;
  readonly kind = 'boss' as const;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly radius: number;
  readonly maxHp: number;
  hp: number;
  alive = true;
  threatened = 0;
  /** Burning since it was knocked out (s). */
  burnT = 0;
  /** Went down with the ship instead of being shot off it (no kill, no award). */
  scuttled = false;

  constructor(
    readonly owner: Dreadnought,
    readonly role: Role,
    /** Hit centre in the hull's frame. */
    readonly local: THREE.Vector3,
    /** What gets scorched when it's shot away. */
    readonly visual: THREE.Object3D | null,
  ) {
    const s = STATS[role];
    this.radius = s.radius;
    this.maxHp = this.hp = s.hp;
  }

  get whole(): Dreadnought {
    return this.owner;
  }

  get label(): string {
    return this.role === 'core' && this.owner.shielded ? 'CORE SHLD' : STATS[this.role].label;
  }

  damage(amount: number, at: THREE.Vector3, kind: DamageKind): boolean {
    if (!this.alive) return false;
    void at;
    // Behind the shield next to nothing gets through; the beam does a little better
    if (this.role === 'core' && this.owner.shielded) {
      amount *= kind === 'unibeam' ? 0.2 : 0.06;
      this.owner.shieldFlash = 1;
    }
    this.hp -= amount;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      return true;
    }
    return false;
  }
}

interface Geo {
  hull: THREE.BufferGeometry;
  hullLo: THREE.BufferGeometry;
  hullCoarse: THREE.BufferGeometry;
  glow: THREE.BufferGeometry;
  glowLo: THREE.BufferGeometry;
  pod: THREE.BufferGeometry;
  podGlow: THREE.BufferGeometry;
  turretBase: THREE.BufferGeometry;
  turretHead: THREE.BufferGeometry;
  battery: THREE.BufferGeometry;
  mast: THREE.BufferGeometry;
  mastGlow: THREE.BufferGeometry;
  cannon: THREE.BufferGeometry;
  hangar: THREE.BufferGeometry;
  core: THREE.BufferGeometry;
  cage: THREE.BufferGeometry;
}

let geoCache: Geo | null = null;

/** Where the pieces sit in the hull's frame (nose +Z, m). */
const AT = {
  engines: [
    [-25, -3.2, 2],
    [25, -3.2, 2],
    [-38, -2.4, -24],
    [38, -2.4, -24],
  ] as V3[],
  /** (x, y, z, 1 on the back / −1 slung underneath) */
  turrets: [
    [0, 7.6, 36, 1],
    [0, 7.4, -30, 1],
    [0, -4.6, 44, -1],
  ] as [number, number, number, number][],
  batteries: [
    [-9, 7.2, -8],
    [9, 7.2, -8],
  ] as V3[],
  /** (x, y, z, 1 up / −1 down) */
  emitters: [
    [0, 7.4, 8, 1],
    [0, -5.2, -42, -1],
  ] as [number, number, number, number][],
  cannon: [0, -6.4, 26] as V3,
  hangar: [0, -1.5, -58] as V3,
  core: [0, -9.5, -8] as V3,
};

function geometry(): Geo {
  if (geoCache) return geoCache;
  const hull: THREE.BufferGeometry[] = [];
  const glow: THREE.BufferGeometry[] = [];

  // The body: a chined, flat-bellied manta lofted nose to tail
  const sec = (z: number, w: number, t: number, b: number, c = 0): V3[] => [
    [0, t, z], [0.55 * w, 0.8 * t, z], [w, c, z], [0.62 * w, 0.78 * b, z],
    [0, b, z], [-0.62 * w, 0.78 * b, z], [-w, c, z], [-0.55 * w, 0.8 * t, z],
  ];
  hull.push(
    loft(
      [
        sec(62, 1.4, 0.5, -0.5),
        sec(52, 7, 3, -2.4, -0.3),
        sec(32, 13.5, 6, -4.4, -0.3),
        sec(6, 17, 7.5, -5.6),
        sec(-24, 17, 7.2, -5.6),
        sec(-46, 12.5, 5.2, -4.2),
        sec(-60, 8.5, 3.6, -2.8),
        sec(-63, 7.5, 3, -2.4),
      ],
      (e, s) => {
        if (s < 0 || s > 6) return C.edge;
        if (e === 0 || e === 7) return C.top;
        if (e === 1 || e === 6) return C.side;
        return C.belly;
      },
    ),
  );
  // Swept wings out to the tips, dark along the leading edge
  const wingSec = (x: number, zLE: number, zTE: number, th: number, y: number): V3[] => {
    const ch = zLE - zTE;
    return [
      [x, y, zLE], [x, y + th, zLE - ch * 0.3], [x, y + th * 0.45, zTE + ch * 0.25],
      [x, y, zTE], [x, y - th * 0.3, zTE + ch * 0.25], [x, y - th * 0.55, zLE - ch * 0.3],
    ];
  };
  for (const s of [-1, 1]) {
    hull.push(
      loft(
        [wingSec(s * 13, 24, -32, 3.4, -0.6), wingSec(s * 32, 6, -36, 2.2, -0.2), wingSec(s * 50, -18, -40, 0.7, 0.4)],
        (e) => (e === 0 || e === 5 ? C.edge : e >= 3 ? C.belly : C.top),
        [false, true],
      ),
    );
    // Canted fins either side of the tail, red at the tips
    hull.push(
      loft(
        [
          [[0.5, 0, -40], [0, 0, -58], [-0.5, 0, -40], [0, 0, -34]].map(([x, y, z]) => [x, y, z] as V3),
          [[0.3, 9, -50], [0, 9, -60], [-0.3, 9, -50], [0, 9, -46]].map(([x, y, z]) => [x, y, z] as V3),
          [[0.2, 11, -53], [0, 11, -60.5], [-0.2, 11, -53], [0, 11, -50]].map(([x, y, z]) => [x, y, z] as V3),
        ],
        (_e, seg) => (seg >= 1 ? C.red : C.side),
      )
        .rotateZ(-s * 0.4)
        .translate(s * 9, 4.6, 0),
    );
    // Running lights down the flanks, nav lights on the tips
    for (let k = 0; k < 6; k++) glow.push(paint(new THREE.BoxGeometry(0.3, 0.3, 2.4).translate(s * (15.6 - Math.abs(k - 2.5) * 0.9), 0.4, 26 - k * 12), new THREE.Color(1, 0.12, 0.04), 3));
    glow.push(paint(new THREE.BoxGeometry(0.5, 0.3, 0.8).translate(s * 49.6, 0.6, -30), s < 0 ? 0xff2010 : 0x20ff40, 4));
  }
  // The bridge: a raked block on the back with a band of dark glass
  const bridge = { hw0: 5.2, z0: 30, z1: 12, y0: 5.4, hw1: 3.6, z2: 27, z3: 15, y1: 10.2 };
  hull.push(frustum(bridge, (e, s) => (s < 0 ? C.edge : e === 0 ? C.side : C.top)));
  hull.push(panelOn(bridge, 'f', -0.85, 0.85, 0.5, 0.82, C.glass), panelOn(bridge, 'l', -0.7, 0.7, 0.5, 0.82, C.glass), panelOn(bridge, 'r', -0.7, 0.7, 0.5, 0.82, C.glass));
  // A spine of plating aft of it, and the intakes either side
  hull.push(box(4.2, 1.6, 36, C.side, 0, 7.2, -22));
  for (const s of [-1, 1]) hull.push(box(3.4, 2.4, 14, C.dark, s * 7.5, 6, -14), box(3, 2, 0.4, C.edge, s * 7.5, 6, -6.9));
  // The red eye in the nose
  glow.push(paint(new THREE.CircleGeometry(0.9, 16).scale(1.6, 0.7, 1).translate(0, 0, 61.4), new THREE.Color(1, 0.06, 0.02), 6));
  // The cradle the core hangs in
  hull.push(box(10, 3, 14, C.edge, AT.core[0], AT.core[1] + 5, AT.core[2]));

  // An engine: a nacelle on a pylon under the wing, its nozzle lit
  const pod: THREE.BufferGeometry[] = [
    paint(new THREE.CylinderGeometry(3.3, 3.6, 13, 14).rotateX(Math.PI / 2), C.steel),
    paint(new THREE.CylinderGeometry(3.6, 3, 4, 14, 1, true).rotateX(Math.PI / 2).translate(0, 0, 8.4), C.edge),
    paint(new THREE.CylinderGeometry(2.6, 3.3, 4.5, 14, 1, true).rotateX(Math.PI / 2).translate(0, 0, -8.6), C.dark),
    box(1.6, 3.6, 9, C.side, 0, 4, 0),
  ];
  const podGlow = paint(new THREE.CircleGeometry(2.5, 16).rotateY(Math.PI).translate(0, 0, -9.6), new THREE.Color(1, 0.5, 0.16), 4);

  // A ball turret: a ring, a faceted head and two barrels
  const turretBase = paint(new THREE.CylinderGeometry(2.4, 2.8, 1.2, 12), C.edge);
  const turretHead = merge([
    paint(new THREE.IcosahedronGeometry(2.1, 0).translate(0, 1.6, 0), C.steel),
    paint(new THREE.CylinderGeometry(0.22, 0.26, 5.2, 8).rotateX(Math.PI / 2).translate(-0.55, 1.7, 3.4), C.dark),
    paint(new THREE.CylinderGeometry(0.22, 0.26, 5.2, 8).rotateX(Math.PI / 2).translate(0.55, 1.7, 3.4), C.dark),
  ]);

  // A battery: a box of six tubes canted up and out
  const battery: THREE.BufferGeometry[] = [box(5.4, 2.4, 7, C.side, 0, 1.2, 0)];
  for (let i = 0; i < 6; i++) battery.push(paint(new THREE.CylinderGeometry(0.62, 0.62, 0.3, 10).translate(((i % 2) - 0.5) * 2.4, 2.5, (Math.floor(i / 2) - 1) * 2), C.dark));

  // A shield emitter: a braced mast with a lit crystal at its head
  const mast = merge([
    beam([0, 0, 0], [0, 6.4, 0], 0.5, C.steel, 6),
    beam([-2, 0, 0], [0, 4.6, 0], 0.2, C.edge),
    beam([2, 0, 0], [0, 4.6, 0], 0.2, C.edge),
    beam([0, 0, -2], [0, 4.6, 0], 0.2, C.edge),
    paint(new THREE.TorusGeometry(1.5, 0.16, 6, 20).rotateX(Math.PI / 2).translate(0, 6.6, 0), C.edge),
  ]);
  const mastGlow = paint(new THREE.OctahedronGeometry(1.1).scale(1, 1.6, 1).translate(0, 6.9, 0), new THREE.Color(0.55, 0.3, 1), 5);

  // The cannon: a gondola under the nose and the long barrel out of it
  const cannon = merge([
    frustum({ hw0: 2.6, z0: 6, z1: -6, y0: 0, hw1: 1.8, z2: 5, z3: -5, y1: -3.4 }, (e, s) => (s < 0 ? C.edge : e % 2 ? C.side : C.belly)),
    paint(new THREE.CylinderGeometry(0.7, 0.85, 15, 10).rotateX(Math.PI / 2).translate(0, -1.9, 12), C.dark),
    paint(new THREE.CylinderGeometry(1.05, 1.05, 1.6, 10).rotateX(Math.PI / 2).translate(0, -1.9, 19), C.edge),
  ]);

  // The hangar: a lit mouth in the tail
  const hangar = merge([box(12, 5, 3, C.edge, 0, 0, 0), box(9.6, 3.2, 0.3, C.dark, 0, -0.2, -1.6)]);

  // The core: a hot sphere in a cage of ribs
  const core = paint(new THREE.SphereGeometry(4.6, 20, 14), new THREE.Color(1, 0.42, 0.12), 5);
  const ribs: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 3; k++) ribs.push(paint(new THREE.TorusGeometry(5.3, 0.3, 6, 24).rotateY((k * Math.PI) / 3), C.edge));
  ribs.push(paint(new THREE.TorusGeometry(5.3, 0.3, 6, 24).rotateX(Math.PI / 2), C.edge));

  // Lo LOD (450–1800 m): fewer stations, 1-seg wings & fins, no small intake/running-light greebles
  const hullLo: THREE.BufferGeometry[] = [
    loft(
      [
        sec(62, 1.4, 0.5, -0.5),
        sec(32, 13.5, 6, -4.4, -0.3),
        sec(6, 17, 7.5, -5.6),
        sec(-32, 15.5, 6.5, -5.0),
        sec(-63, 7.5, 3, -2.4),
      ],
      (e, s) => {
        if (s < 0 || s > 3) return C.edge;
        if (e === 0 || e === 7) return C.top;
        if (e === 1 || e === 6) return C.side;
        return C.belly;
      },
    ),
    frustum(bridge, (e, s) => (s < 0 ? C.edge : e === 0 ? C.side : C.top)),
    box(4.2, 1.6, 36, C.side, 0, 7.2, -22),
    box(10, 3, 14, C.edge, AT.core[0], AT.core[1] + 5, AT.core[2]),
  ];
  const glowLo: THREE.BufferGeometry[] = [
    paint(new THREE.CircleGeometry(0.9, 6).scale(1.6, 0.7, 1).translate(0, 0, 61.4), new THREE.Color(1, 0.06, 0.02), 6),
  ];
  for (const s of [-1, 1]) {
    hullLo.push(
      loft(
        [wingSec(s * 13, 24, -32, 3.4, -0.6), wingSec(s * 50, -18, -40, 0.7, 0.4)],
        (e) => (e === 0 || e === 5 ? C.edge : e >= 3 ? C.belly : C.top),
        [false, true],
      ),
      loft(
        [
          [[0.5, 0, -40], [0, 0, -58], [-0.5, 0, -40], [0, 0, -34]].map(([x, y, z]) => [x, y, z] as V3),
          [[0.2, 11, -53], [0, 11, -60.5], [-0.2, 11, -53], [0, 11, -50]].map(([x, y, z]) => [x, y, z] as V3),
        ],
        (_e, seg) => (seg >= 0 ? C.side : C.red),
      )
        .rotateZ(-s * 0.4)
        .translate(s * 9, 4.6, 0),
    );
    glowLo.push(paint(new THREE.BoxGeometry(0.6, 0.35, 0.9).translate(s * 49.6, 0.6, -30), s < 0 ? 0xff2010 : 0x20ff40, 4));
  }

  // Coarse silhouette (> 1800 m): minimal manta diamond + swept wings + bridge block
  const cSec = (z: number, w: number, t: number, b: number): V3[] => [
    [0, t, z], [w, 0, z], [0, b, z], [-w, 0, z],
  ];
  const cWing = (x: number, zLE: number, zTE: number, th: number): V3[] => [
    [x, 0, zLE], [x, th, (zLE + zTE) * 0.5], [x, 0, zTE], [x, -th * 0.6, (zLE + zTE) * 0.5],
  ];
  const hullCoarse: THREE.BufferGeometry[] = [
    loft([cSec(62, 1.5, 0.6, -0.6), cSec(0, 17, 7.5, -5.6), cSec(-63, 7.5, 3, -2.4)], (e) => (e === 0 || e === 3 ? C.top : C.belly)),
    frustum(bridge, C.side),
  ];
  for (const s of [-1, 1]) {
    hullCoarse.push(
      loft([cWing(s * 13, 24, -32, 3.2), cWing(s * 50, -18, -40, 0.8)], (e) => (e >= 2 ? C.belly : C.top), [false, true]),
      box(0.5, 10, 14, C.side, s * 10, 9.5, -52),
    );
  }

  geoCache = {
    hull: merge(hull),
    hullLo: merge(hullLo),
    hullCoarse: merge(hullCoarse),
    glow: merge(glow),
    glowLo: merge(glowLo),
    pod: merge(pod),
    podGlow,
    turretBase,
    turretHead,
    battery: merge(battery),
    mast,
    mastGlow,
    cannon,
    hangar,
    core,
    cage: merge(ribs),
  };
  return geoCache;
}

interface Turret {
  part: BossPart;
  root: THREE.Group;
  head: THREE.Group;
  /** 1 on the back, −1 slung underneath. */
  up: number;
  fireT: number;
  pauseT: number;
  roundAcc: number;
  track: number;
}

interface Battery {
  part: BossPart;
  reload: number;
  salvo: number;
  salvoT: number;
}

const FWD = new THREE.Vector3(0, 0, 1);

export class Dreadnought {
  readonly mesh = new THREE.Group();
  readonly parts: BossPart[] = [];
  readonly core: BossPart;
  readonly cannon: BossPart;
  readonly hangar: BossPart;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  heading = 0;
  /** Coming down (every piece of it is dead by then). */
  falling = false;
  /** Hit the ground or the sea and gone (the manager removes it). */
  gone = false;
  /** A hit on the shielded core lights the shield up (0–1). */
  shieldFlash = 0;
  private readonly engines: BossPart[] = [];
  private readonly emitters: BossPart[] = [];
  private readonly turrets: Turret[] = [];
  private readonly batteries: Battery[] = [];
  private readonly shell: THREE.Mesh;
  private readonly shellMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(0.5, 0.25, 1), emissiveIntensity: 0.5, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false });
  private readonly nozzles: THREE.Mesh[] = [];
  private readonly drones: Array<{ alive: boolean; pos?: THREE.Vector3; damage?: (amount: number, at: THREE.Vector3, kind: DamageKind) => boolean }> = [];
  hangarDetonated = false;
  private spiralCalled = false;
  private cannonT = 3;
  private cannonCalled = false;
  private hangarT = 8;
  private speed = SPEED;
  private list = 0;
  private trim = 0;
  private sink = 0;
  private fallT = 0;
  private burnT = 0;
  private readonly _v = new THREE.Vector3();
  private readonly _w = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();
  private readonly _q2 = new THREE.Quaternion();

  constructor(
    private readonly home: THREE.Vector2,
    /** Puts one of its drones in the air at a point, flying a heading. */
    private readonly launchDrone: (at: THREE.Vector3, heading: THREE.Vector3) => { alive: boolean },
  ) {
    this.build();
    this.core = this.parts.find((p) => p.role === 'core')!;
    this.cannon = this.parts.find((p) => p.role === 'cannon')!;
    this.hangar = this.parts.find((p) => p.role === 'hangar')!;
    this.shell = new THREE.Mesh(new THREE.SphereGeometry(8.2, 28, 18), this.shellMat);
    this.shell.position.set(...AT.core);
    this.shell.castShadow = false;
    this.mesh.add(this.shell);
    // In off the sea (+Z), a good way out, nose on the house
    this.pos.set(home.x + (Math.random() - 0.5) * 3000, ALT, home.y + 7200);
    this.heading = Math.atan2(home.x - this.pos.x, home.y - this.pos.z);
    this.place(0);
  }

  /** The emitters still stand: the core is behind its shield. */
  get shielded(): boolean {
    return this.emitters.some((p) => p.alive);
  }

  get enginesUp(): number {
    return this.engines.filter((p) => p.alive).length;
  }

  /** The cannon is laid on the house right now. */
  get shelling(): boolean {
    return !this.falling && this.cannon.alive && Math.hypot(this.pos.x - this.home.x, this.pos.z - this.home.y) < CANNON_RANGE;
  }

  /** True when 2 engines on the same wing side are destroyed while the other wing has thrust. */
  get asymmetricSpiral(): boolean {
    const portOut = this.engines.filter((e) => !e.alive && e.local.x < 0).length;
    const stbdOut = this.engines.filter((e) => !e.alive && e.local.x > 0).length;
    return (portOut >= 2 || stbdOut >= 2) && portOut !== stbdOut;
  }

  /** Current bank/roll tilt angle (rad). */
  get bankRoll(): number {
    return this.list;
  }

  // ── Model ────────────────────────────────────────────────────────────
  private build(): void {
    const g = geometry();
    const hullLod = new THREE.LOD();
    const hullHi = new THREE.Group();
    hullHi.add(new THREE.Mesh(g.hull, mats.paint), new THREE.Mesh(g.glow, mats.glow));
    const hullLo = new THREE.Group();
    hullLo.add(new THREE.Mesh(g.hullLo, mats.paint), new THREE.Mesh(g.glowLo, mats.glow));
    hullLod.addLevel(hullHi, 0);
    hullLod.addLevel(hullLo, 450);
    hullLod.addLevel(new THREE.Mesh(g.hullCoarse, mats.paint), 1800);
    this.mesh.add(hullLod);
    const add = (role: Role, at: V3, visual: THREE.Object3D, aim?: V3): BossPart => {
      visual.position.set(at[0], at[1], at[2]);
      this.mesh.add(visual);
      const part = new BossPart(this, role, new THREE.Vector3(...(aim ?? at)), visual);
      this.parts.push(part);
      return part;
    };
    for (const at of AT.engines) {
      const pod = new THREE.Group();
      const nozzle = new THREE.Mesh(g.podGlow, mats.glow);
      pod.add(new THREE.Mesh(g.pod, mats.paint), nozzle);
      this.nozzles.push(nozzle);
      this.engines.push(add('engine', at, pod));
    }
    for (const [x, y, z, up] of AT.turrets) {
      const root = new THREE.Group();
      if (up < 0) root.rotation.z = Math.PI;
      const head = new THREE.Group();
      head.add(new THREE.Mesh(g.turretHead, mats.paint));
      root.add(new THREE.Mesh(g.turretBase, mats.paint), head);
      const part = add('turret', [x, y, z], root, [x, y + up * 1.8, z]);
      this.turrets.push({ part, root, head, up, fireT: 0, pauseT: 1 + Math.random() * 2, roundAcc: 0, track: 0 });
    }
    AT.batteries.forEach((at, i) => {
      const m = new THREE.Mesh(g.battery, mats.paint);
      m.rotation.z = at[0] < 0 ? 0.3 : -0.3;
      this.batteries.push({ part: add('battery', at, m, [at[0], at[1] + 1.4, at[2]]), reload: 9 + i * 5, salvo: 0, salvoT: 0 });
    });
    for (const [x, y, z, up] of AT.emitters) {
      const m = new THREE.Group();
      m.add(new THREE.Mesh(g.mast, mats.paint), new THREE.Mesh(g.mastGlow, mats.glow));
      if (up < 0) m.rotation.z = Math.PI;
      this.emitters.push(add('emitter', [x, y, z], m, [x, y + up * 5.5, z]));
    }
    add('cannon', AT.cannon, new THREE.Mesh(g.cannon, mats.paint), [AT.cannon[0], AT.cannon[1] - 1.8, AT.cannon[2] + 3]);
    add('hangar', AT.hangar, new THREE.Mesh(g.hangar, mats.paint));
    const core = new THREE.Group();
    core.add(new THREE.Mesh(g.core, mats.glow), new THREE.Mesh(g.cage, mats.paint));
    add('core', AT.core, core);

    this.mesh.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = false;
    });
  }

  // ── Sim ──────────────────────────────────────────────────────────────
  update(
    dt: number,
    t: number,
    player: PlayerTarget,
    field: Heightfield,
    rounds: Round[],
    missiles: Missiles,
    particles: Particles,
    explosions: Explosions,
    events: EventBus,
    house: HouseTarget,
  ): void {
    if (this.gone) return;
    if (!this.falling && (!this.core.alive || this.enginesUp === 0)) this.bringDown(explosions, events);
    this.steer(dt, t, field);
    this.place(t);
    if (this.falling) {
      this.fall(dt, field, particles, explosions);
      return;
    }
    // The shield: a faint shell round the core that flares where it's hit
    this.shieldFlash = Math.max(0, this.shieldFlash - dt * 3);
    this.shell.visible = this.shielded;
    this.shellMat.opacity = 0.12 + 0.05 * Math.sin(t * 3) + 0.5 * this.shieldFlash;
    this.nozzles.forEach((n, i) => {
      n.visible = this.engines[i].alive;
      n.scale.setScalar(0.9 + 0.1 * Math.sin(t * 40 + i * 2));
    });
    for (const tu of this.turrets) if (tu.part.alive) this.updateTurret(tu, dt, player, rounds, particles, events);
    for (const b of this.batteries) if (b.part.alive) this.updateBattery(b, dt, player, missiles, explosions, events);
    if (this.cannon.alive) this.updateCannon(dt, house, missiles, explosions, events);
    if (this.hangar.alive) this.updateHangar(dt, player);
    this.burn(dt, particles);
  }

  /** In to the circle round the house and round it, over whatever ground is under it. */
  private steer(dt: number, t: number, field: Heightfield): void {
    const up = this.enginesUp;
    const goal = this.falling ? 0 : SPEED * (0.3 + 0.175 * up);
    this.speed += (goal - this.speed) * (1 - Math.exp(-dt * (this.falling ? 0.25 : 0.5)));
    if (!this.falling) {
      const rx = this.pos.x - this.home.x;
      const rz = this.pos.z - this.home.y;
      const r = Math.max(1, Math.hypot(rx, rz));
      // Tangent (anticlockwise), pulled in or out onto the circle
      const pull = ((r - HOLD_R) / HOLD_R) * 3;
      const want = Math.atan2(-rz / r - (rx / r) * pull, rx / r - (rz / r) * pull);
      const turn = Math.atan2(Math.sin(want - this.heading), Math.cos(want - this.heading));
      const portOut = this.engines.filter((e) => !e.alive && e.local.x < 0).length;
      const stbdOut = this.engines.filter((e) => !e.alive && e.local.x > 0).length;
      const asym = stbdOut - portOut;
      const severeAsym = (portOut >= 2 || stbdOut >= 2) && portOut !== stbdOut;
      const turnCap = severeAsym ? 0.02 * dt : 0.06 * dt;
      this.heading += THREE.MathUtils.clamp(turn, -turnCap, turnCap);
      // Asymmetric engine loss induces bank tilt; losing 2 engines on one wing triggers severe roll & spiral instability
      const targetList = severeAsym ? Math.sign(asym) * 0.48 + Math.sin(t * 1.6) * 0.08 : asym * 0.09;
      this.list += (targetList - this.list) * (1 - Math.exp(-dt * (severeAsym ? 1.1 : 0.4)));
      if (severeAsym) {
        const spiralPull = Math.sign(asym) * 0.22 + Math.sin(t * 1.3) * 0.06;
        this.heading += spiralPull * dt;
        this.trim += (Math.sin(t * 0.9) * 0.06 - this.trim) * (1 - Math.exp(-dt * 1.5));
      } else {
        this.trim += (0 - this.trim) * (1 - Math.exp(-dt * 0.8));
      }
      const ahead = Math.max(field.surfaceAt(this.pos.x, this.pos.z), field.surfaceAt(this.pos.x + Math.sin(this.heading) * 400, this.pos.z + Math.cos(this.heading) * 400), 0);
      const alt = Math.max(ALT, ahead + CLEARANCE);
      this.pos.y += THREE.MathUtils.clamp(alt - this.pos.y, -6 * dt, 10 * dt);
    }
    this.vel.set(Math.sin(this.heading) * this.speed, -this.sink, Math.cos(this.heading) * this.speed);
    this.pos.addScaledVector(this.vel, dt);
  }

  /** Pose the hull; carry every part's hit point along. */
  private place(t: number): void {
    const pitch = Math.sin(t * 0.31) * 0.01 + this.trim;
    const roll = Math.sin(t * 0.23 + 1) * 0.015 + this.list;
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.set(pitch, this.heading, roll, 'YXZ');
    this.mesh.updateMatrixWorld();
    for (const p of this.parts) {
      p.pos.copy(p.local).applyMatrix4(this.mesh.matrixWorld);
      p.vel.copy(this.vel);
    }
  }

  private updateTurret(tu: Turret, dt: number, player: PlayerTarget, rounds: Round[], particles: Particles, events: EventBus): void {
    const at = tu.part.pos;
    const to = this._v.copy(player.pos).sub(at);
    const dist = to.length();
    const tgo = dist / TURRET_ROUND;
    const lead = this._w.copy(player.pos).addScaledVector(player.vel, tgo).addScaledVector(this.vel, -tgo).sub(at).normalize();
    // In the mount's own frame: one on the back can't shoot down through the hull, nor the chin gun up
    const local = lead.clone().applyQuaternion(tu.root.getWorldQuaternion(this._q).invert());
    const can = player.alive && dist < TURRET_RANGE && local.y > -0.12;
    if (can) {
      tu.track += dt;
      tu.head.quaternion.slerp(this._q2.setFromUnitVectors(FWD, local), Math.min(1, dt * 2.2));
      const err = this._v.set(0, 0, 1).applyQuaternion(tu.head.quaternion).angleTo(local);
      if (tu.fireT > 0) tu.fireT -= dt;
      else if (tu.pauseT > 0) tu.pauseT -= dt;
      else if (err < 0.07 && tu.track > 0.8) {
        tu.fireT = TURRET_BURST;
        tu.pauseT = TURRET_PAUSE + Math.random();
        events.emit('enemyFire', { at: at.clone(), value: 6 });
      }
    } else {
      tu.track = 0;
      tu.fireT = 0;
      tu.pauseT = Math.max(tu.pauseT, 0.6);
    }
    if (tu.fireT <= 0) return;
    tu.head.updateMatrixWorld();
    const muzzle = this._v.set(0, 1.7, 6.2).applyMatrix4(tu.head.matrixWorld);
    const dir = this._w.set(0, 0, 1).transformDirection(tu.head.matrixWorld);
    tu.roundAcc += dt * TURRET_RATE;
    while (tu.roundAcc >= 1) {
      tu.roundAcc--;
      const d = dir.clone().add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.02)).normalize();
      rounds.push({ p: muzzle.clone(), v: d.multiplyScalar(TURRET_ROUND).add(this.vel), life: 2, dmg: TURRET_DAMAGE });
      particles.emit('flash', muzzle, this.vel, { scale: 0.16 });
    }
  }

  private updateBattery(b: Battery, dt: number, player: PlayerTarget, missiles: Missiles, explosions: Explosions, events: EventBus): void {
    b.reload -= dt;
    if (b.salvo === 0 && b.reload <= 0 && player.alive && player.pos.distanceTo(b.part.pos) < BATTERY_RANGE) {
      b.salvo = BATTERY_SALVO;
      b.salvoT = 0;
      b.reload = 15 + Math.random() * 6;
    }
    if (b.salvo <= 0) return;
    b.salvoT -= dt;
    if (b.salvoT > 0) return;
    b.salvo--;
    b.salvoT = BATTERY_GAP;
    const up = this._w.set(Math.sign(b.part.local.x) * 0.3, 1, 0).normalize().transformDirection(this.mesh.matrixWorld);
    const from = this._v.copy(b.part.pos).addScaledVector(up, 2);
    missiles.launch({ team: 'enemy', from, vel: up.clone().multiplyScalar(45).add(this.vel), target: player, coast: 0.6 });
    explosions.muzzle(from, up, 2);
    events.emit('enemyMissile', { at: from, value: 1 });
  }

  private updateCannon(dt: number, house: HouseTarget, missiles: Missiles, explosions: Explosions, events: EventBus): void {
    if (!this.shelling || !house.marks.length) return;
    if (!this.cannonCalled) {
      this.cannonCalled = true;
      events.emit('jarvis', { text: 'It is ranging on the house, sir. The cannon under its nose — take that first.' });
    }
    this.cannonT -= dt;
    if (this.cannonT > 0) return;
    this.cannonT = CANNON_RELOAD;
    const mark = house.marks[Math.floor(Math.random() * house.marks.length)];
    const fwd = this._w.set(0, -0.05, 1).normalize().transformDirection(this.mesh.matrixWorld);
    const from = this._v.set(AT.cannon[0], AT.cannon[1] - 1.9, AT.cannon[2] + 20).applyMatrix4(this.mesh.matrixWorld);
    missiles.launch({ team: 'enemy', from, vel: fwd.clone().multiplyScalar(90).add(this.vel), target: null, aimPoint: mark, onImpact: (p) => house.struck(p, CANNON_DAMAGE), coast: 0.3, caliber: 0.3, length: 3.2 });
    explosions.muzzle(from, fwd, 3.5);
    events.emit('enemyMissile', { at: from, value: 1 });
  }

  private updateHangar(dt: number, player: PlayerTarget): void {
    this.hangarT -= dt;
    if (this.hangarT > 0 || !player.alive) return;
    this.hangarT = HANGAR_EVERY;
    for (let i = this.drones.length - 1; i >= 0; i--) if (!this.drones[i].alive) this.drones.splice(i, 1);
    if (this.drones.length >= HANGAR_MAX) return;
    const aft = this._w.set(0, -0.15, -1).normalize().transformDirection(this.mesh.matrixWorld);
    this.drones.push(this.launchDrone(this._v.copy(this.hangar.pos).addScaledVector(aft, 10), aft));
  }

  /** Fire-control radars that have the suit (the RWR's lock warning). */
  *trackers(): Generator<THREE.Vector3> {
    for (const tu of this.turrets) if (tu.part.alive && tu.track > 0.3) yield tu.part.pos;
  }

  /** Smoke and fire off anything shot away. */
  private burn(dt: number, particles: Particles): void {
    this.burnT += dt;
    if (this.burnT < 0.06) return;
    const step = this.burnT;
    this.burnT = 0;
    for (const p of this.parts) {
      if (p.alive) continue;
      p.burnT += step;
      const k = Math.max(0.35, 1 - p.burnT / 60) * (p.role === 'engine' ? 1.6 : 1);
      particles.emit('darkSmoke', p.pos, this._v.set(0, 2, 0).addScaledVector(this.vel, 0.6), { scale: 0.9 * k });
      if (Math.random() < 0.6 * k) particles.emit('fire', p.pos, this._w.set(0, 1.5, 0).addScaledVector(this.vel, 0.8), { scale: 0.8 * k });
    }
  }

  /** A part was shot away: it blows, and what's left of it is scorched black. */
  partDestroyed(p: BossPart, explosions: Explosions, events: EventBus): void {
    explosions.blast(p.pos, p.role === 'engine' || p.role === 'core' ? 13 : 8, { debris: 12, vel: this.vel });
    p.visual?.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = mats.charred;
    });
    if (this.falling || p.role === 'core') return;
    if (p.role === 'emitter') {
      events.emit('jarvis', { text: this.shielded ? 'One shield emitter down. One more and the core is open.' : 'The shield is down, sir. The core is open.' });
    } else if (p.role === 'engine') {
      const n = this.enginesUp;
      if (this.asymmetricSpiral && !this.spiralCalled) {
        this.spiralCalled = true;
        events.emit('jarvis', { text: 'Two engines gone on one wing, sir — she is rolling hard and losing stability!' });
      } else if (n > 0) {
        events.emit('jarvis', { text: n === 1 ? 'One engine is all that is holding her up, sir.' : `An engine is out. ${n === 3 ? 'Three' : 'Two'} left, and she is slowing.` });
      }
    } else if (p.role === 'cannon') {
      events.emit('jarvis', { text: 'The cannon is out. The house is safe from that, at least.' });
    } else if (p.role === 'hangar') {
      if (!this.hangarDetonated && (this.drones.some((d) => d.alive) || this.drones.length < HANGAR_MAX || this.hangarT <= HANGAR_EVERY)) {
        this.hangarDetonated = true;
        explosions.blast(p.pos, 18, { debris: 24, burn: true, vel: this.vel });
        // Internal secondary detonation bypasses external core shield and blasts hull HP
        const hullBlast = 460;
        this.core.hp = Math.max(0, this.core.hp - hullBlast);
        if (this.core.hp <= 0) this.core.alive = false;
        // Destroy/damage nearby active drones spawned by this hangar
        for (const d of this.drones) {
          if (!d.alive) continue;
          const dist = d.pos ? d.pos.distanceTo(p.pos) : 0;
          if (dist > 450) continue;
          const dmg = 260 * (1 - 0.5 * Math.min(1, dist / 450));
          if (d.damage) d.damage(dmg, p.pos, 'missile');
          else d.alive = false;
        }
        events.emit('jarvis', { text: 'Secondary detonation in the hangar bay, sir! Her aft hull took heavy internal damage.' });
      } else {
        events.emit('jarvis', { text: 'Hangar is burning. No more drones from her.' });
      }
    }
  }

  private bringDown(explosions: Explosions, events: EventBus): void {
    this.falling = true;
    this.fallT = 0;
    for (const p of this.parts) {
      if (p.alive) p.scuttled = true;
      p.alive = false;
    }
    this.shell.visible = false;
    for (const n of this.nozzles) n.visible = false;
    explosions.blast(this.core.pos, 24, { debris: 30, burn: false, vel: this.vel });
    events.emit('jarvis', { text: 'She is coming down, sir. I would not be underneath.' });
  }

  private fall(dt: number, field: Heightfield, particles: Particles, explosions: Explosions): void {
    this.fallT += dt;
    this.sink = Math.min(70, this.sink + 5.5 * dt);
    this.trim = Math.min(0.5, this.trim + 0.035 * dt);
    this.list += (this.list >= 0 ? 1 : -1) * 0.03 * dt;
    // Secondaries along the hull all the way down
    if (Math.random() < dt * 1.6) {
      const at = this._v.set((Math.random() - 0.5) * 26, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 110).applyMatrix4(this.mesh.matrixWorld);
      explosions.blast(at, 6 + Math.random() * 7, { debris: 6, vel: this.vel });
    }
    this.burnT += dt;
    if (this.burnT > 0.04) {
      this.burnT = 0;
      for (let i = 0; i < 4; i++) {
        const at = this._v.set((Math.random() - 0.5) * 28, 4, (Math.random() - 0.5) * 110).applyMatrix4(this.mesh.matrixWorld);
        particles.emit('darkSmoke', at, this._w.set(0, 5, 0), { scale: 2.2 });
        if (Math.random() < 0.6) particles.emit('fire', at, this._w.set(0, 3, 0).addScaledVector(this.vel, 0.5), { scale: 1.6 });
      }
    }
    const floor = Math.max(field.surfaceAt(this.pos.x, this.pos.z), 0);
    if (this.pos.y - 8 > floor) return;
    // Down: she goes up along her whole length
    for (let k = -2; k <= 2; k++) {
      const at = this._v.set((Math.random() - 0.5) * 16, 0, k * 24).applyMatrix4(this.mesh.matrixWorld);
      at.y = Math.max(at.y, floor + 2);
      explosions.blast(at, k === 0 ? 34 : 20, { debris: k === 0 ? 40 : 14, burn: true, vel: this.vel });
    }
    this.gone = true;
    this.mesh.visible = false;
  }

  // ── Contact ──────────────────────────────────────────────────────────
  /** Keep the suit out of the hull: push it clear and kill its speed into the steel. */
  collide(p: THREE.Vector3, v: THREE.Vector3): void {
    if (this.gone || p.distanceToSquared(this.pos) > 80 * 80) return;
    this._q.copy(this.mesh.quaternion).invert();
    const local = this._v.copy(p).sub(this.pos).applyQuaternion(this._q);
    const k = Math.hypot(local.x / (HULL.x + 1.2), local.y / (HULL.y + 1.2), local.z / (HULL.z + 1.2));
    if (k >= 1 || k < 1e-4) return;
    // Out along the ellipsoid's normal, back in the world
    const n = this._w.set(local.x / HULL.x ** 2, local.y / HULL.y ** 2, local.z / HULL.z ** 2).normalize();
    local.multiplyScalar(1 / k);
    p.copy(local.applyQuaternion(this.mesh.quaternion).add(this.pos));
    n.applyQuaternion(this.mesh.quaternion);
    const into = v.dot(n) - this.vel.dot(n);
    if (into < 0) v.addScaledVector(n, -into);
  }
}
