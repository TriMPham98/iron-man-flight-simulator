import * as THREE from 'three';
import type { Game } from '../sim/game';
import { PAD } from '../world/house';
import {
  encodeSuitState,
  decodeSuitState,
  generateRoomCode,
  sanitizeRoomCode,
  SuitFlag,
  SUIT_STATE_BYTES,
  type MatchMode,
  type NetEvent,
  type PeerInfo,
  type PlayerRole,
  type ServerControlMessage,
  type SuitNetState,
  type SuitVariant,
} from './protocol';
import { RemoteSuit } from './remoteSuit';
import { applyLocalSuitVariant, type WarMachinePack } from './suitVisuals';
import {
  BroadcastChannelTransport,
  resolveServerBaseUrl,
  WebSocketTransport,
  type NetTransport,
  type TransportBackend,
  type TransportStatus,
} from './transport';

/** Outbound kinematic snapshot rate (Hz). */
const SEND_HZ = 25;
const SEND_INTERVAL = 1 / SEND_HZ;

export interface MultiplayerSnapshot {
  status: TransportStatus;
  detail: string;
  backend: TransportBackend;
  endpoint: string;
  room: string;
  role: PlayerRole;
  suit: SuitVariant;
  mode: MatchMode;
  rttMs: number;
  connected: boolean;
  peer: {
    id: string;
    callsign: string;
    suit: SuitVariant;
    role: PlayerRole;
    distance: number;
    speed: number;
    armor: number;
  } | null;
}

/**
 * Coordinates the 2-player Iron Man + War Machine multiplayer session:
 *  - Manages the room transport (Cloudflare Durable Object WebSocket or local 2-tab)
 *  - Switches the local player's rigged suit between Iron Man Mk III & War Machine Mk II
 *  - Streams 25 Hz 64-byte binary suit kinematics to the other pilot
 *  - Spawns, interpolates, and cleans up the remote pilot's 3D `RemoteSuit`
 *  - Syncs ocean/world time and spawn offsets on join
 */
export class MultiplayerSession {
  readonly group = new THREE.Group();
  suit: SuitVariant = 'ironman';
  mode: MatchMode = 'coop';
  role: PlayerRole = 'host';
  room = '';
  backend: TransportBackend;
  status: TransportStatus = 'disconnected';
  statusDetail = 'OFFLINE';

  peer: RemoteSuit | null = null;
  peerInfo: PeerInfo | null = null;
  selfId = '';

  private transport: NetTransport;
  private readonly sendBuf = new ArrayBuffer(SUIT_STATE_BYTES);
  private readonly listeners = new Set<() => void>();
  private sendAcc = 0;
  private localPack: WarMachinePack | null = null;
  private readonly _aim = new THREE.Vector3();
  private readonly _invQ = new THREE.Quaternion();
  private readonly _localAim = new THREE.Vector3();
  private readonly _euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private clockT = 0;

  constructor(
    private readonly game: Game,
    private readonly hazeUniforms: Record<string, THREE.IUniform>,
    transportFactory?: (backend: TransportBackend) => NetTransport,
  ) {
    this.group.name = 'multiplayer';
    this.makeTransport =
      transportFactory ?? ((b) => (b === 'local' ? new BroadcastChannelTransport() : new WebSocketTransport()));
    // Default to WebSocket if a server is configured (or localhost), otherwise local 2-tab preview
    this.backend = resolveServerBaseUrl() ? 'websocket' : 'local';
    this.transport = this.makeTransport(this.backend);
    this.bindTransport(this.transport);
  }

  private readonly makeTransport: (backend: TransportBackend) => NetTransport;

  /** True while connected or connecting to a room (keeps sim running while Esc menu is open). */
  get active(): boolean {
    return this.status === 'connected' || this.status === 'connecting';
  }

  get rttMs(): number {
    return this.transport.rttMs;
  }

  /** Subscribe to lobby/connection UI updates. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  /** Switch between Cloudflare/local WebSocket server and zero-server same-browser 2-tab mode. */
  setBackend(backend: TransportBackend): void {
    if (this.backend === backend) return;
    const wasActive = this.active;
    const prevRoom = this.room;
    if (wasActive) this.leaveRoom();
    this.backend = backend;
    this.transport = this.makeTransport(backend);
    this.bindTransport(this.transport);
    this.status = 'disconnected';
    this.statusDetail = backend === 'local' ? 'LOCAL 2-TAB READY' : 'SERVER READY';
    this.notify();
    if (wasActive && prevRoom) this.joinRoom(prevRoom);
  }

  /** Switch your own suit between Iron Man Mk III and War Machine Mk II immediately. */
  setSuit(suit: SuitVariant): void {
    if (this.suit === suit && this.localPack) return;
    this.suit = suit;
    this.localPack = applyLocalSuitVariant(this.game.suit, suit, this.hazeUniforms);
    if (this.status === 'connected') {
      this.transport.sendControl({ type: 'select', suit });
    }
    this.game.events.emit('jarvis', {
      text:
        suit === 'warmachine'
          ? 'War Machine Mark II chassis online. Shoulder rotary cannon armed, sir.'
          : 'Mark III gold-titanium armour online, sir.',
    });
    this.notify();
  }

  /** Set match mode (Co-op vs 1v1 Duel). */
  setMode(mode: MatchMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    if (this.status === 'connected') {
      this.transport.sendControl({ type: 'select', mode });
    }
    this.notify();
  }

  /** Create a fresh room with a generated 6-character Stark code. */
  hostRoom(customCode?: string): string {
    const code = sanitizeRoomCode(customCode ?? '') || generateRoomCode();
    this.joinRoom(code);
    return code;
  }

  /** Join an existing room by code. */
  joinRoom(rawCode: string, serverUrl?: string): void {
    const code = sanitizeRoomCode(rawCode);
    if (!code) return;
    this.clearPeer();
    this.room = code;
    this.sendAcc = 0;
    this.transport.connect({
      room: code,
      suit: this.suit,
      mode: this.mode,
      callsign: this.suit === 'warmachine' ? 'RHODES' : 'STARK',
      serverUrl,
    });
    this.notify();
  }

  /** Leave the current room and return to solo flight. */
  leaveRoom(): void {
    this.transport.disconnect();
    this.clearPeer();
    this.room = '';
    this.selfId = '';
    this.status = 'disconnected';
    this.statusDetail = 'OFFLINE';
    this.notify();
  }

  /** Shareable invite URL carrying the room code, opposite suit, and current mode. */
  inviteUrl(): string {
    if (typeof location === 'undefined' || !this.room) return '';
    const u = new URL(location.href);
    u.searchParams.set('room', this.room);
    u.searchParams.set('mode', this.mode);
    u.searchParams.set('suit', this.suit === 'ironman' ? 'warmachine' : 'ironman');
    if (this.backend === 'local') u.searchParams.set('mp', 'local');
    else u.searchParams.delete('mp');
    return u.toString();
  }

  /** Send a reliable gameplay event to the other pilot (hook for Milestones 2 & 3). */
  sendEvent(event: NetEvent): void {
    if (this.status === 'connected') {
      this.transport.sendControl({ type: 'event', event });
    }
  }

  /** Current UI snapshot. */
  snapshot(): MultiplayerSnapshot {
    return {
      status: this.status,
      detail: this.statusDetail,
      backend: this.backend,
      endpoint: this.transport.endpointLabel || resolveServerBaseUrl() || 'LOCAL 2-TAB',
      room: this.room,
      role: this.role,
      suit: this.suit,
      mode: this.mode,
      rttMs: this.transport.rttMs,
      connected: this.status === 'connected',
      peer:
        this.peer && this.peerInfo
          ? {
              id: this.peer.id,
              callsign: this.peer.callsign,
              suit: this.peer.variant,
              role: this.peerInfo.role,
              distance: this.game.model.pos.distanceTo(this.peer.pos),
              speed: this.peer.speed,
              armor: this.peer.armor,
            }
          : null,
    };
  }

  /** Per-frame update: articulate local War Machine minigun, send 25 Hz state, step RemoteSuit. */
  update(dt: number, firingLocal: boolean): void {
    this.clockT += dt;

    // Articulate local War Machine shoulder minigun toward pilot's aim
    if (this.suit === 'warmachine' && this.localPack) {
      const aim = this.game.rig.aim(this._aim);
      const chest = this.game.suit.rig.bones.chest;
      this._invQ.copy(chest.getWorldQuaternion(this._invQ)).invert();
      this._localAim.copy(aim).applyQuaternion(this._invQ);
      const yaw = THREE.MathUtils.clamp(Math.atan2(this._localAim.x, Math.max(0.2, this._localAim.z)), -0.75, 0.75);
      const pitch = THREE.MathUtils.clamp(-Math.asin(THREE.MathUtils.clamp(this._localAim.y, -0.8, 0.8)), -0.65, 0.65);
      const k = 1 - Math.exp(-dt * 14);
      this.localPack.turret.rotation.y = THREE.MathUtils.lerp(this.localPack.turret.rotation.y, yaw, k);
      this.localPack.turret.rotation.x = THREE.MathUtils.lerp(this.localPack.turret.rotation.x, pitch, k);
      if (firingLocal) {
        this.localPack.barrels.rotation.z += dt * 36;
        this.localPack.muzzleGlow.visible = Math.sin(this.clockT * 90) > -0.15;
      } else {
        this.localPack.muzzleGlow.visible = false;
      }
    }

    // Stream binary kinematic snapshot at 25 Hz while connected
    if (this.status === 'connected') {
      this.sendAcc += dt;
      if (this.sendAcc >= SEND_INTERVAL) {
        this.sendAcc %= SEND_INTERVAL;
        this.sendLocalState(firingLocal);
      }
    }

    // Advance remote pilot's interpolated 3D suit
    if (this.peer) {
      this.peer.update(dt, this.game.ground, this.game.particles);
    }
  }

  /** Reposition local suit on the pad with a wingman offset so both suits stand side-by-side. */
  applyPadSpawnOffset(): void {
    if (!this.game.model.grounded) return;
    const heading = Math.atan2(-0.55, 1);
    const sideX = Math.cos(heading);
    const sideZ = -Math.sin(heading);
    const offset = this.role === 'guest' ? 4.0 : -4.0;
    this.game.model.placeOnGround(PAD.x + sideX * offset, PAD.y + sideZ * offset, heading);
  }

  private sendLocalState(firingLocal: boolean): void {
    const m = this.game.model;
    const c = this.game.combat;
    const o = this.game.driver.outputs;
    const aim = this.game.rig.aim(this._aim);

    let flags = 0;
    if (m.grounded) flags |= SuitFlag.GROUNDED;
    if (m.boosting) flags |= SuitFlag.BOOSTING;
    if (m.airbrake > 0.25) flags |= SuitFlag.BRAKING;
    if (firingLocal) flags |= SuitFlag.FIRING;
    if (c.weapons.unibeamOn) flags |= SuitFlag.UNIBEAM;
    if (c.weapons.arms.flares > 0.1) flags |= SuitFlag.FLARES;
    if (c.down > 0) flags |= SuitFlag.DOWN;

    this._euler.setFromQuaternion(m.q, 'YXZ');

    const state: SuitNetState = {
      flags,
      armor: c.armor,
      reserves: c.reserves,
      t: this.game.time,
      px: m.pos.x,
      py: m.pos.y,
      pz: m.pos.z,
      vx: m.vel.x,
      vy: m.vel.y,
      vz: m.vel.z,
      ax: aim.x,
      ay: aim.y,
      az: aim.z,
      heading: m.heading,
      pitch: Math.asin(THREE.MathUtils.clamp(aim.y, -1, 1)),
      roll: this._euler.z,
      flightness: m.flightness,
      thrust: Math.max(o.bootL, o.bootR),
    };

    encodeSuitState(state, this.sendBuf);
    this.transport.sendBinary(this.sendBuf);
  }

  private bindTransport(t: NetTransport): void {
    t.onStatus = (status, detail) => {
      this.status = status;
      this.statusDetail = detail ?? status.toUpperCase();
      if (status === 'disconnected' || status === 'error') {
        this.clearPeer();
      }
      this.notify();
    };

    t.onControl = (msg) => this.handleControl(msg);

    t.onBinary = (buf) => {
      const state = decodeSuitState(buf);
      if (!state) return;
      if (!this.peer) {
        // Fallback if binary arrived slightly before peerJoined
        this.spawnPeer({
          id: 'peer',
          role: this.role === 'host' ? 'guest' : 'host',
          suit: this.suit === 'ironman' ? 'warmachine' : 'ironman',
          mode: this.mode,
          callsign: this.suit === 'ironman' ? 'RHODES' : 'STARK',
        });
      }
      this.peer?.applySnapshot(state);
    };
  }

  private handleControl(msg: ServerControlMessage): void {
    switch (msg.type) {
      case 'welcome': {
        this.selfId = msg.id;
        this.room = msg.room;
        this.role = msg.role;
        this.mode = msg.mode;
        // Sync procedural ocean clock so wave swell matches across both clients
        if (Number.isFinite(msg.worldTime)) {
          this.game.world.time = msg.worldTime;
        }
        if (msg.peers.length > 0) {
          this.spawnPeer(msg.peers[0]);
        }
        // Offset standing position on the terrace so the two suits don't overlap
        if (this.game.onPad) {
          this.applyPadSpawnOffset();
        }
        // Push our selected suit so peer sees the right armor immediately
        this.transport.sendControl({ type: 'select', suit: this.suit, mode: this.mode });
        this.game.events.emit('jarvis', {
          text:
            msg.peers.length > 0
              ? `Uplink established to room ${msg.room}. ${this.peerLabel(msg.peers[0])} is on radar, sir.`
              : `Room ${msg.room} online. Awaiting wingman uplink, sir.`,
        });
        this.notify();
        break;
      }

      case 'peerJoined': {
        this.spawnPeer(msg.peer);
        this.game.events.emit('jarvis', {
          text:
            this.mode === 'duel'
              ? `${this.peerLabel(msg.peer)} has entered Malibu airspace. Duel telemetry online, sir.`
              : `${this.peerLabel(msg.peer)} is online and forming up on your wing, sir.`,
        });
        // Immediately transmit our current pose so the arriving pilot sees us at once
        this.sendLocalState(false);
        this.notify();
        break;
      }

      case 'peerUpdated': {
        this.peerInfo = msg.peer;
        if (msg.peer.role === 'host' && msg.peer.mode !== this.mode) {
          this.mode = msg.peer.mode;
        }
        if (this.peer) {
          this.peer.setVariant(msg.peer.suit, msg.peer.callsign);
        } else {
          this.spawnPeer(msg.peer);
        }
        this.notify();
        break;
      }

      case 'peerLeft': {
        const who = this.peerInfo ? this.peerLabel(this.peerInfo) : 'Wingman';
        if (msg.newHostId && msg.newHostId === this.selfId) {
          this.role = 'host';
        }
        this.clearPeer();
        this.game.events.emit('jarvis', { text: `${who} has broken formation and left the airspace, sir.` });
        this.notify();
        break;
      }

      case 'pong':
        this.notify();
        break;

      case 'event':
        if (msg.event.kind === 'pingCallout') {
          this.game.events.emit('jarvis', { text: msg.event.text });
        }
        break;

      case 'error':
        this.statusDetail = msg.message;
        this.notify();
        break;
    }
  }

  private peerLabel(p: PeerInfo): string {
    return p.suit === 'warmachine' ? `War Machine (${p.callsign})` : `Iron Man (${p.callsign})`;
  }

  private spawnPeer(info: PeerInfo): void {
    this.peerInfo = info;
    if (this.peer) {
      this.peer.setVariant(info.suit, info.callsign);
      return;
    }
    const r = new RemoteSuit(info.id, info.suit, info.callsign, this.hazeUniforms);
    this.peer = r;
    this.group.add(r.mesh);
  }

  private clearPeer(): void {
    if (this.peer) {
      this.group.remove(this.peer.mesh);
      this.peer.dispose();
      this.peer = null;
    }
    this.peerInfo = null;
  }

  dispose(): void {
    this.leaveRoom();
    this.listeners.clear();
  }
}
