import * as THREE from 'three';

/**
 * Stark Flight Multiplayer wire protocol.
 *
 * Binary (little-endian, tagged by the first byte): the full pilot state at
 * 25 Hz (0x02) and the host's enemy snapshot at 15 Hz (0x03). The 64-byte
 * 0x01 kinematic packet is what the procedural stand-in suit reads. Low-rate
 * lobby/session events and the guest's damage batches travel as JSON.
 */

export type SuitVariant = 'ironman' | 'warmachine';
export type MatchMode = 'coop' | 'duel';
export type PlayerRole = 'host' | 'guest';

/** Bitmask packed into byte 1 of every binary suit state packet. */
export const SuitFlag = {
  GROUNDED: 1 << 0,
  BOOSTING: 1 << 1,
  BRAKING: 1 << 2,
  FIRING: 1 << 3,
  UNIBEAM: 1 << 4,
  FLARES: 1 << 5,
  DOWN: 1 << 6,
  WALKING: 1 << 7,
} as const;

export const STATE_PACKET_TAG = 0x01;
export const SUIT_STATE_BYTES = 64;

export interface SuitNetState {
  flags: number;
  /** Armour 0–1. */
  armor: number;
  reserves: number;
  /** Sender simulation clock (s). */
  t: number;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  ax: number;
  ay: number;
  az: number;
  heading: number;
  pitch: number;
  roll: number;
  flightness: number;
  thrust: number;
}

export interface PeerInfo {
  id: string;
  role: PlayerRole;
  suit: SuitVariant;
  mode: MatchMode;
  callsign: string;
}

/** Extensible reliable gameplay events (wired for Milestones 2 & 3). */
export type NetEvent =
  | { kind: 'pingCallout'; text: string }
  | { kind: 'repulsor'; ox: number; oy: number; oz: number; dx: number; dy: number; dz: number; side: 'L' | 'R' }
  | { kind: 'flare'; ox: number; oy: number; oz: number; vx: number; vy: number; vz: number }
  | { kind: 'sonicBoom'; x: number; y: number; z: number }
  | { kind: 'hit'; amount: number; x: number; y: number; z: number; weapon: 'repulsor' | 'missile' | 'unibeam' | 'minigun' }
  | { kind: 'reset'; mode: MatchMode }
  /** Guest → host: damage the guest's own shots dealt to enemy puppets, [netId, part (−1 = whole), amount, damage kind]. */
  | { kind: 'dmg'; hits: [number, number, number, string][] }
  /** Guest → host: the guest pressed the wave key. */
  | { kind: 'callWave' };

export type ClientControlMessage =
  | { type: 'hello'; suit: SuitVariant; mode: MatchMode; callsign?: string }
  | { type: 'select'; suit?: SuitVariant; mode?: MatchMode; callsign?: string }
  | { type: 'ping'; t: number }
  | { type: 'event'; event: NetEvent };

export type ServerControlMessage =
  | {
      type: 'welcome';
      id: string;
      room: string;
      role: PlayerRole;
      suit: SuitVariant;
      mode: MatchMode;
      peers: PeerInfo[];
      worldTime: number;
    }
  | { type: 'peerJoined'; peer: PeerInfo }
  | { type: 'peerUpdated'; peer: PeerInfo }
  | { type: 'peerLeft'; id: string; newHostId?: string }
  | { type: 'pong'; t: number; serverTime: number }
  | { type: 'event'; from: string; event: NetEvent }
  | { type: 'error'; message: string };

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Normalize user-entered room codes (uppercase alphanumerics + hyphen, max 12 chars). */
export function sanitizeRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 12);
}

/** Generate a readable 6-character Stark room code (e.g. "MK2-8X" or "RHO4K9"). */
export function generateRoomCode(): string {
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
  }
  return out;
}

/** Encode one suit kinematic snapshot into a 64-byte little-endian ArrayBuffer. */
export function encodeSuitState(s: SuitNetState, target?: ArrayBuffer): ArrayBuffer {
  const buf = target && target.byteLength >= SUIT_STATE_BYTES ? target : new ArrayBuffer(SUIT_STATE_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, STATE_PACKET_TAG);
  v.setUint8(1, s.flags & 0xff);
  v.setUint8(2, Math.max(0, Math.min(255, Math.round(s.armor * 255))));
  v.setUint8(3, Math.max(0, Math.min(255, s.reserves | 0)));
  v.setFloat32(4, s.t, true);
  v.setFloat32(8, s.px, true);
  v.setFloat32(12, s.py, true);
  v.setFloat32(16, s.pz, true);
  v.setFloat32(20, s.vx, true);
  v.setFloat32(24, s.vy, true);
  v.setFloat32(28, s.vz, true);
  v.setFloat32(32, s.ax, true);
  v.setFloat32(36, s.ay, true);
  v.setFloat32(40, s.az, true);
  v.setFloat32(44, s.heading, true);
  v.setFloat32(48, s.pitch, true);
  v.setFloat32(52, s.roll, true);
  v.setFloat32(56, s.flightness, true);
  v.setFloat32(60, s.thrust, true);
  return buf;
}

/** Decode a 64-byte binary suit state packet (returns null if malformed). */
export function decodeSuitState(buf: ArrayBuffer | Uint8Array): SuitNetState | null {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.byteLength < SUIT_STATE_BYTES) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint8(0) !== STATE_PACKET_TAG) return null;

  const px = v.getFloat32(8, true);
  const py = v.getFloat32(12, true);
  const pz = v.getFloat32(16, true);
  if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return null;

  return {
    flags: v.getUint8(1),
    armor: v.getUint8(2) / 255,
    reserves: v.getUint8(3),
    t: v.getFloat32(4, true),
    px,
    py,
    pz,
    vx: v.getFloat32(20, true),
    vy: v.getFloat32(24, true),
    vz: v.getFloat32(28, true),
    ax: v.getFloat32(32, true),
    ay: v.getFloat32(36, true),
    az: v.getFloat32(40, true),
    heading: v.getFloat32(44, true),
    pitch: v.getFloat32(48, true),
    roll: v.getFloat32(52, true),
    flightness: v.getFloat32(56, true),
    thrust: v.getFloat32(60, true),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Full pilot state (v2): everything the other client needs to fly a puppet of
// the real rigged suit through the same SuitDriver body language, and to run
// a cosmetic copy of its weapons (same bolts, missiles, beams, flares).
// ─────────────────────────────────────────────────────────────────────────────

export const PILOT_PACKET_TAG = 0x02;

/** Bits of the pilot packet's u16 flag word. */
export const PilotFlag = {
  GROUNDED: 1 << 0,
  BOOSTING: 1 << 1,
  DOWN: 1 << 2,
  FIRE: 1 << 3,
  MISSILE: 1 << 4,
  UNIBEAM: 1 << 5,
  FLARES: 1 << 6,
  LAUNCHER: 1 << 7,
  /** The laser-cutter key went down since the last packet. */
  LASER: 1 << 8,
  OVERCHARGE: 1 << 9,
} as const;

export const REACTOR_MODES = ['BALANCED', 'THRUST', 'WEAPONS', 'SHIELDS'] as const;

/** Flight-model scalars carried in order after the vectors. */
export const PILOT_SCALARS = [
  'posture',
  'flightness',
  'throttle',
  'yawAcc',
  'trimRoll',
  'trimPitch',
  'surge',
  'airbrake',
  'liftSpill',
  'swing',
  'freefall',
  'palmBrake',
  'crouch',
  'strafeDashActive',
  'impactSpeed',
  'gLoad',
] as const;
export type PilotScalar = (typeof PILOT_SCALARS)[number];

export interface PilotNetState {
  flags: number;
  /** Index into {@link REACTOR_MODES}. */
  reactor: number;
  armor: number;
  reserves: number;
  strafeDashDir: -1 | 0 | 1;
  /** Sender sim clock (s). */
  t: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  q: THREE.Quaternion;
  omega: THREE.Vector3;
  /** Weapons aim (unit) and the eye it is sighted from. */
  aim: THREE.Vector3;
  eye: THREE.Vector3;
  s: Record<PilotScalar, number>;
}

const PILOT_HEADER = 12;
const PILOT_VEC_FLOATS = 3 + 3 + 4 + 3 + 3 + 3;
export const PILOT_STATE_BYTES = PILOT_HEADER + (PILOT_VEC_FLOATS + PILOT_SCALARS.length) * 4;

export function makePilotState(): PilotNetState {
  const s = {} as Record<PilotScalar, number>;
  for (const k of PILOT_SCALARS) s[k] = 0;
  return {
    flags: 0,
    reactor: 0,
    armor: 1,
    reserves: 0,
    strafeDashDir: 0,
    t: 0,
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    q: new THREE.Quaternion(),
    omega: new THREE.Vector3(),
    aim: new THREE.Vector3(0, 0, 1),
    eye: new THREE.Vector3(),
    s,
  };
}

export function encodePilotState(p: PilotNetState, target?: ArrayBuffer): ArrayBuffer {
  const buf = target && target.byteLength >= PILOT_STATE_BYTES ? target : new ArrayBuffer(PILOT_STATE_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, PILOT_PACKET_TAG);
  v.setInt8(1, p.strafeDashDir);
  v.setUint16(2, p.flags & 0xffff, true);
  v.setUint8(4, p.reactor);
  v.setUint8(5, Math.max(0, Math.min(255, Math.round(p.armor * 255))));
  v.setUint8(6, Math.max(0, Math.min(255, p.reserves | 0)));
  v.setFloat32(8, p.t, true);
  let o = PILOT_HEADER;
  const f = (x: number) => {
    v.setFloat32(o, x, true);
    o += 4;
  };
  for (const vec of [p.pos, p.vel]) f(vec.x), f(vec.y), f(vec.z);
  f(p.q.x), f(p.q.y), f(p.q.z), f(p.q.w);
  for (const vec of [p.omega, p.aim, p.eye]) f(vec.x), f(vec.y), f(vec.z);
  for (const k of PILOT_SCALARS) f(p.s[k]);
  return buf;
}

/** Decode into `out` (allocation free); false if the packet is not a sane pilot state. */
export function decodePilotState(buf: ArrayBuffer | Uint8Array, out: PilotNetState): boolean {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.byteLength < PILOT_STATE_BYTES) return false;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint8(0) !== PILOT_PACKET_TAG) return false;
  let o = PILOT_HEADER;
  const f = () => {
    const x = v.getFloat32(o, true);
    o += 4;
    return x;
  };
  const px = f(), py = f(), pz = f();
  if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return false;
  const sd = v.getInt8(1);
  out.strafeDashDir = sd > 0 ? 1 : sd < 0 ? -1 : 0;
  out.flags = v.getUint16(2, true);
  out.reactor = Math.min(REACTOR_MODES.length - 1, v.getUint8(4));
  out.armor = v.getUint8(5) / 255;
  out.reserves = v.getUint8(6);
  out.t = v.getFloat32(8, true);
  out.pos.set(px, py, pz);
  out.vel.set(f(), f(), f());
  out.q.set(f(), f(), f(), f());
  if (out.q.lengthSq() < 1e-6) out.q.identity();
  else out.q.normalize();
  out.omega.set(f(), f(), f());
  out.aim.set(f(), f(), f());
  if (out.aim.lengthSq() < 1e-6) out.aim.set(0, 0, 1);
  else out.aim.normalize();
  out.eye.set(f(), f(), f());
  for (const k of PILOT_SCALARS) {
    const x = f();
    out.s[k] = Number.isFinite(x) ? x : 0;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Enemy world snapshot (host → guest). The host runs the only real enemy AI;
// the guest flies puppets of the same classes at these poses.
// ─────────────────────────────────────────────────────────────────────────────

export const WORLD_PACKET_TAG = 0x03;

/** Snapshot body classes (what the guest has to build to mirror it). */
export const NetBodyClass = {
  DRONE: 0,
  INTERCEPTOR: 1,
  BOMBER: 2,
  JAMMER: 3,
  SAM: 4,
  FRIGATE: 5,
  BOSS: 6,
  RIVAL: 7,
} as const;

export interface NetBody {
  id: number;
  cls: number;
  alive: boolean;
  hp: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  meshPos: THREE.Vector3;
  meshQ: THREE.Quaternion;
  /** Frigate / dreadnought: each part's alive flag and hp, in the class's own part order. */
  parts: { alive: boolean; hp: number }[];
}

export interface WorldNetState {
  t: number;
  wave: number;
  houseHp: number;
  bodies: NetBody[];
}

const WORLD_HEADER = 12;
const BODY_BYTES = 2 + 1 + 1 + 4 + 12 * 3 + 16 + 1;
const PART_BYTES = 1 + 4;

export function worldStateBytes(w: WorldNetState): number {
  let n = WORLD_HEADER;
  for (const b of w.bodies) n += BODY_BYTES + b.parts.length * PART_BYTES;
  return n;
}

export function encodeWorldState(w: WorldNetState): ArrayBuffer {
  const buf = new ArrayBuffer(worldStateBytes(w));
  const v = new DataView(buf);
  v.setUint8(0, WORLD_PACKET_TAG);
  v.setInt8(1, Math.max(-1, Math.min(127, w.wave)));
  v.setUint16(2, Math.min(0xffff, w.bodies.length), true);
  v.setFloat32(4, w.t, true);
  v.setFloat32(8, w.houseHp, true);
  let o = WORLD_HEADER;
  for (const b of w.bodies) {
    v.setUint16(o, b.id & 0xffff, true);
    v.setUint8(o + 2, b.cls);
    v.setUint8(o + 3, b.alive ? 1 : 0);
    v.setFloat32(o + 4, b.hp, true);
    o += 8;
    for (const vec of [b.pos, b.vel, b.meshPos]) {
      v.setFloat32(o, vec.x, true);
      v.setFloat32(o + 4, vec.y, true);
      v.setFloat32(o + 8, vec.z, true);
      o += 12;
    }
    v.setFloat32(o, b.meshQ.x, true);
    v.setFloat32(o + 4, b.meshQ.y, true);
    v.setFloat32(o + 8, b.meshQ.z, true);
    v.setFloat32(o + 12, b.meshQ.w, true);
    o += 16;
    v.setUint8(o, b.parts.length);
    o += 1;
    for (const p of b.parts) {
      v.setUint8(o, p.alive ? 1 : 0);
      v.setFloat32(o + 1, p.hp, true);
      o += PART_BYTES;
    }
  }
  return buf;
}

export function decodeWorldState(buf: ArrayBuffer | Uint8Array): WorldNetState | null {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.byteLength < WORLD_HEADER) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint8(0) !== WORLD_PACKET_TAG) return null;
  const n = v.getUint16(2, true);
  const w: WorldNetState = { wave: v.getInt8(1), t: v.getFloat32(4, true), houseHp: v.getFloat32(8, true), bodies: [] };
  let o = WORLD_HEADER;
  const vec = () => {
    const r = new THREE.Vector3(v.getFloat32(o, true), v.getFloat32(o + 4, true), v.getFloat32(o + 8, true));
    o += 12;
    return r;
  };
  for (let i = 0; i < n; i++) {
    if (o + BODY_BYTES > bytes.byteLength) return null;
    const id = v.getUint16(o, true);
    const cls = v.getUint8(o + 2);
    const alive = v.getUint8(o + 3) === 1;
    const hp = v.getFloat32(o + 4, true);
    o += 8;
    const pos = vec();
    const vel = vec();
    const meshPos = vec();
    const meshQ = new THREE.Quaternion(v.getFloat32(o, true), v.getFloat32(o + 4, true), v.getFloat32(o + 8, true), v.getFloat32(o + 12, true));
    o += 16;
    if (meshQ.lengthSq() < 1e-6) meshQ.identity();
    else meshQ.normalize();
    const np = v.getUint8(o);
    o += 1;
    if (o + np * PART_BYTES > bytes.byteLength) return null;
    const parts: NetBody['parts'] = [];
    for (let j = 0; j < np; j++) {
      parts.push({ alive: v.getUint8(o) === 1, hp: v.getFloat32(o + 1, true) });
      o += PART_BYTES;
    }
    if (![pos.x, pos.y, pos.z, meshPos.x, meshPos.y, meshPos.z].every(Number.isFinite)) continue;
    w.bodies.push({ id, cls, alive, hp, pos, vel, meshPos, meshQ, parts });
  }
  return w;
}
