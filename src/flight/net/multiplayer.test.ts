import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../sim/events';
import {
  decodeSuitState,
  encodeSuitState,
  generateRoomCode,
  sanitizeRoomCode,
  SUIT_STATE_BYTES,
  SuitFlag,
  type ClientControlMessage,
  type PeerInfo,
  type ServerControlMessage,
  type SuitNetState,
} from './protocol';
import { RemoteSuit } from './remoteSuit';
import { buildWarMachinePack } from './suitVisuals';
import { MultiplayerSession } from './multiplayer';
import type { ConnectOptions, NetTransport, TransportBackend, TransportStatus } from './transport';

/** Paired in-memory transport simulating a 2-player room relay for deterministic unit tests. */
class MemoryRelay {
  private readonly peers = new Map<string, MemoryTransport>();
  private nextId = 1;

  createTransport(): MemoryTransport {
    return new MemoryTransport(this);
  }

  connect(t: MemoryTransport, opts: ConnectOptions): void {
    const id = `p${this.nextId++}`;
    const existing = [...this.peers.values()];
    const role = existing.length === 0 ? 'host' : 'guest';
    const info: PeerInfo = {
      id,
      role,
      suit: opts.suit,
      mode: opts.mode,
      callsign: opts.callsign ?? (opts.suit === 'warmachine' ? 'RHODES' : 'STARK'),
    };
    t.peerInfo = info;
    this.peers.set(id, t);
    t.setStatus('connected', 'MEMORY');
    t.onControl({
      type: 'welcome',
      id,
      room: sanitizeRoomCode(opts.room),
      role,
      suit: info.suit,
      mode: existing[0]?.peerInfo?.mode ?? opts.mode,
      peers: existing.map((e) => ({ ...e.peerInfo! })),
      worldTime: 42.5,
    });
    for (const other of existing) {
      other.onControl({ type: 'peerJoined', peer: { ...info } });
    }
  }

  disconnect(t: MemoryTransport): void {
    if (!t.peerInfo) return;
    const leaving = t.peerInfo;
    this.peers.delete(leaving.id);
    t.peerInfo = null;
    const remaining = [...this.peers.values()];
    let newHostId: string | undefined;
    if (leaving.role === 'host' && remaining.length > 0 && remaining[0].peerInfo) {
      remaining[0].peerInfo.role = 'host';
      newHostId = remaining[0].peerInfo.id;
    }
    for (const other of remaining) {
      other.onControl({ type: 'peerLeft', id: leaving.id, newHostId });
    }
  }

  relayControl(from: MemoryTransport, msg: ClientControlMessage): void {
    const info = from.peerInfo;
    if (!info) return;
    if (msg.type === 'select' || msg.type === 'hello') {
      if (msg.suit) info.suit = msg.suit;
      if (msg.mode) info.mode = msg.mode;
      if (msg.callsign) info.callsign = msg.callsign;
      for (const other of this.peers.values()) {
        if (other !== from) other.onControl({ type: 'peerUpdated', peer: { ...info } });
      }
    } else if (msg.type === 'event') {
      for (const other of this.peers.values()) {
        if (other !== from) other.onControl({ type: 'event', from: info.id, event: msg.event });
      }
    }
  }

  relayBinary(from: MemoryTransport, buf: ArrayBuffer): void {
    const copy = buf.slice(0);
    for (const other of this.peers.values()) {
      if (other !== from) other.onBinary(copy);
    }
  }
}

class MemoryTransport implements NetTransport {
  readonly backend: TransportBackend = 'websocket';
  status: TransportStatus = 'disconnected';
  rttMs = 12;
  endpointLabel = 'memory';
  peerInfo: PeerInfo | null = null;
  onStatus: (status: TransportStatus, detail?: string) => void = () => {};
  onControl: (msg: ServerControlMessage) => void = () => {};
  onBinary: (buf: ArrayBuffer) => void = () => {};

  constructor(private readonly relay: MemoryRelay) {}

  setStatus(s: TransportStatus, detail?: string): void {
    this.status = s;
    this.onStatus(s, detail);
  }

  connect(opts: ConnectOptions): void {
    this.relay.connect(this, opts);
  }

  disconnect(): void {
    this.relay.disconnect(this);
    this.setStatus('disconnected');
  }

  sendControl(msg: ClientControlMessage): void {
    this.relay.relayControl(this, msg);
  }

  sendBinary(buf: ArrayBuffer): void {
    this.relay.relayBinary(this, buf);
  }
}

function makeStubGame(pos = new THREE.Vector3(10, 50, 20)) {
  const chest = new THREE.Bone();
  const suitGroup = new THREE.Group();
  const events = new EventBus();
  return {
    time: 12.3,
    onPad: false,
    world: { time: 0 },
    events,
    ground: { surface: () => 0 },
    particles: { emit: () => {} },
    suit: {
      group: suitGroup,
      rig: { bones: { chest } },
      forEachMesh: () => {},
    },
    model: {
      pos: pos.clone(),
      vel: new THREE.Vector3(120, 4, -85),
      q: new THREE.Quaternion(),
      heading: 0.7,
      flightness: 0.9,
      grounded: false,
      boosting: true,
      airbrake: 0,
      placeOnGround: () => {},
    },
    driver: { outputs: { bootL: 1.2, bootR: 1.2 } },
    rig: { aim: (out: THREE.Vector3) => out.set(0.6, 0.1, -0.8).normalize() },
    combat: {
      armor: 0.85,
      reserves: 1,
      down: 0,
      weapons: { unibeamOn: false, arms: { flares: 0 } },
      duelFoes: [] as unknown[],
      wavesEnabled: true,
      wave: -1,
      lost: false,
      clearHostiles: () => {},
      playerTarget: { hit: vi.fn() },
    },
  } as unknown as ConstructorParameters<typeof MultiplayerSession>[0];
}

describe('Multiplayer Protocol (Milestone 1)', () => {
  it('round-trips a 64-byte binary SuitNetState packet accurately', () => {
    const src: SuitNetState = {
      flags: SuitFlag.BOOSTING | SuitFlag.FIRING,
      armor: 0.75,
      reserves: 2,
      t: 123.45,
      px: -412.5,
      py: 1850.25,
      pz: 920.75,
      vx: 240.5,
      vy: -18.25,
      vz: 310.0,
      ax: 0.5,
      ay: -0.2,
      az: 0.84,
      heading: 1.23,
      pitch: -0.18,
      roll: 0.62,
      flightness: 0.95,
      thrust: 1.35,
    };

    const buf = encodeSuitState(src);
    expect(buf.byteLength).toBe(SUIT_STATE_BYTES);

    const dec = decodeSuitState(buf);
    expect(dec).not.toBeNull();
    expect(dec!.flags).toBe(src.flags);
    expect(dec!.reserves).toBe(2);
    expect(dec!.armor).toBeCloseTo(0.75, 2);
    expect(dec!.t).toBeCloseTo(src.t, 2);
    expect(dec!.px).toBeCloseTo(src.px, 3);
    expect(dec!.py).toBeCloseTo(src.py, 3);
    expect(dec!.pz).toBeCloseTo(src.pz, 3);
    expect(dec!.vx).toBeCloseTo(src.vx, 3);
    expect(dec!.vy).toBeCloseTo(src.vy, 3);
    expect(dec!.vz).toBeCloseTo(src.vz, 3);
    expect(dec!.heading).toBeCloseTo(src.heading, 3);
    expect(dec!.roll).toBeCloseTo(src.roll, 3);
    expect(dec!.flightness).toBeCloseTo(src.flightness, 3);
    expect(dec!.thrust).toBeCloseTo(src.thrust, 3);
  });

  it('rejects short, wrong-tag, or non-finite binary packets', () => {
    expect(decodeSuitState(new ArrayBuffer(12))).toBeNull();
    const badTag = new Uint8Array(SUIT_STATE_BYTES);
    badTag[0] = 0x99;
    expect(decodeSuitState(badTag)).toBeNull();

    const nanBuf = encodeSuitState({
      flags: 0,
      armor: 1,
      reserves: 1,
      t: 0,
      px: Number.NaN,
      py: 0,
      pz: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      ax: 0,
      ay: 0,
      az: 1,
      heading: 0,
      pitch: 0,
      roll: 0,
      flightness: 0,
      thrust: 0,
    });
    expect(decodeSuitState(nanBuf)).toBeNull();
  });

  it('sanitizes and generates clean Stark room codes', () => {
    expect(sanitizeRoomCode(' mk2-9x!@# ')).toBe('MK2-9X');
    const code = generateRoomCode();
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
  });
});

describe('War Machine Visuals & RemoteSuit', () => {
  it('builds the War Machine shoulder rotary minigun + missile pod pack cleanly', () => {
    const pack = buildWarMachinePack();
    expect(pack.root.name).toBe('warmachine-pack');
    expect(pack.barrels.children.length).toBeGreaterThan(0);
    expect(pack.muzzleGlow.visible).toBe(false);
  });

  it('dead-reckons supersonic flight, clamps terrain clearance, and swaps War Machine live', () => {
    const remote = new RemoteSuit('p2', 'warmachine', 'RHODES');
    expect(remote.variant).toBe('warmachine');

    remote.applySnapshot({
      flags: SuitFlag.BOOSTING | SuitFlag.FIRING,
      armor: 0.9,
      reserves: 1,
      t: 1,
      px: 100,
      py: 200,
      pz: 300,
      vx: 300,
      vy: 0,
      vz: 0,
      ax: 1,
      ay: 0,
      az: 0,
      heading: Math.PI / 2,
      pitch: 0,
      roll: 0.4,
      flightness: 1,
      thrust: 1.4,
    });

    // Step 0.1 s -> dead reckoning should advance ~30 m along +X
    remote.update(0.1, { surface: () => 0 });
    expect(remote.pos.x).toBeGreaterThan(120);
    expect(remote.pos.x).toBeLessThan(140);
    expect(remote.boosting).toBe(true);

    // Terrain clearance guard prevents underground clipping
    remote.applySnapshot({
      flags: 0,
      armor: 1,
      reserves: 1,
      t: 2,
      px: 100,
      py: -15,
      pz: 300,
      vx: 0,
      vy: -50,
      vz: 0,
      ax: 0,
      ay: 0,
      az: 1,
      heading: 0,
      pitch: 0,
      roll: 0,
      flightness: 0,
      thrust: 0,
    });
    remote.update(0.05, { surface: () => 10 });
    expect(remote.pos.y).toBeGreaterThanOrEqual(10.9);

    // Live suit swap
    remote.setVariant('ironman', 'STARK');
    expect(remote.variant).toBe('ironman');
    expect(remote.callsign).toBe('STARK');
    remote.dispose();
  });
});

describe('MultiplayerSession 2-Player End-to-End Sync', () => {
  it('links Iron Man (host) and War Machine (guest), syncs ocean clock, suit swaps, and 25 Hz flight states', () => {
    const relay = new MemoryRelay();
    const hostGame = makeStubGame(new THREE.Vector3(0, 120, 0));
    const guestGame = makeStubGame(new THREE.Vector3(45, 130, -20));

    const host = new MultiplayerSession(hostGame, {}, () => relay.createTransport());
    const guest = new MultiplayerSession(guestGame, {}, () => relay.createTransport());

    const room = host.hostRoom('STARK1');
    guest.setSuit('warmachine');
    guest.joinRoom(room);

    expect(host.role).toBe('host');
    expect(guest.role).toBe('guest');
    expect(host.peer?.variant).toBe('warmachine');
    expect(guest.peer?.variant).toBe('ironman');
    expect(guestGame.world.time).toBeCloseTo(42.5, 2);

    // Advance 0.1 s (> 25 Hz send interval) so both pilots transmit binary kinematics
    host.update(0.05, false);
    guest.update(0.05, true);
    host.update(0.05, false);
    guest.update(0.05, true);

    // Dead reckoning advances guest (px = 45, vx = 120 m/s) by 0.05 s -> ~51 m
    expect(host.peer!.pos.x).toBeGreaterThan(45);
    expect(host.peer!.pos.x).toBeLessThan(54);
    expect(host.peer!.firing).toBe(true);
    expect(guest.peer!.pos.y).toBeCloseTo(120, 0);

    // Host leaves -> Guest cleanly promotes to host and clears remote mesh
    host.leaveRoom();
    expect(guest.role).toBe('host');
    expect(guest.peer).toBeNull();
    guest.dispose();
  });

  it('duels for real: a hit scored on the other pilot lands on their suit, scaled to armour', () => {
    const relay = new MemoryRelay();
    const hostGame = makeStubGame(new THREE.Vector3(0, 120, 0));
    const guestGame = makeStubGame(new THREE.Vector3(45, 130, -20));
    const host = new MultiplayerSession(hostGame, {}, () => relay.createTransport());
    const guest = new MultiplayerSession(guestGame, {}, () => relay.createTransport());
    host.setMode('duel');
    guest.joinRoom(host.hostRoom('DUEL01'));
    expect(guest.mode).toBe('duel');
    host.update(0.05, false);
    guest.update(0.05, false);

    const foes = (hostGame.combat as unknown as { duelFoes: import('../combat/types').Hostile[] }).duelFoes;
    expect(foes.length).toBe(1);
    const foe = foes[0];
    expect(foe.alive).toBe(true);
    expect(foe.pos.distanceTo(new THREE.Vector3(45, 130, -20))).toBeLessThan(15);
    // Scored here, never a kill here
    expect(foe.damage(50, foe.pos, 'repulsor')).toBe(false);
    host.update(0.06, false);
    const hit = (guestGame.combat as unknown as { playerTarget: { hit: ReturnType<typeof vi.fn> } }).playerTarget.hit;
    expect(hit).toHaveBeenCalledTimes(1);
    expect(hit.mock.calls[0][0]).toBeCloseTo(4.5, 3);
    expect(hit.mock.calls[0][2]).toBe('bullet');

    // No waves in a duel, and the knock-downs keep score on both sides
    expect((hostGame.combat as unknown as { wavesEnabled: boolean }).wavesEnabled).toBe(false);
    expect(host.duel).toEqual({ me: 0, them: 0, foe: 'STARK' });
    (guestGame.combat as unknown as { down: number }).down = 3;
    guest.update(0.05, false);
    host.update(0.05, false);
    host.update(0.2, false);
    expect(guest.duel?.them).toBe(1);
    expect(host.duel?.me).toBe(1);

    // Back to co-op: out of the sights
    host.setMode('coop');
    host.update(0.05, false);
    expect(foes.length).toBe(0);
    expect(host.duel).toBeNull();
    expect((hostGame.combat as unknown as { wavesEnabled: boolean }).wavesEnabled).toBe(true);
    host.dispose();
    guest.dispose();
  });
});
