/**
 * Stark Flight Multiplayer wire protocol.
 *
 * High-rate suit kinematics (20–30 Hz) travel as fixed 64-byte little-endian
 * binary packets (zero JSON allocation). Low-rate lobby/session/weapon events
 * travel as compact JSON frames.
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
  | { kind: 'reset'; mode: MatchMode };

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
