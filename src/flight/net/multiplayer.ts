import * as THREE from 'three';
import type { Suit } from '../../suit/Suit';
import type { DamageKind, Hostile, PlayerTarget } from '../combat/types';
import type { Game } from '../sim/game';
import { REACTOR_KEYS } from '../sim/reactorPower';
import { PAD } from '../world/house';
import { EnemySync } from './enemySync';
import { inCosmeticScope } from './netDamage';
import {
  decodePilotState,
  decodeWorldState,
  encodePilotState,
  generateRoomCode,
  makePilotState,
  PILOT_PACKET_TAG,
  PILOT_SCALARS,
  PILOT_STATE_BYTES,
  PilotFlag,
  REACTOR_MODES,
  sanitizeRoomCode,
  WORLD_PACKET_TAG,
  type MatchMode,
  type NetEvent,
  type PeerInfo,
  type PilotScalar,
  type PlayerRole,
  type ServerControlMessage,
  type SuitVariant,
} from './protocol';
import { RemotePilot } from './remotePilot';
import { RemoteSuit } from './remoteSuit';
import { animateWarMachinePack, applyLocalSuitVariant, type WarMachinePack } from './suitVisuals';
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
const ZERO = new THREE.Vector3();
/** Duel hit batches out (Hz). */
const HIT_HZ = 20;
/**
 * A duel hit, from the damage the shooter's weapons deal an enemy to the
 * armour points it takes off the other pilot (their suit is 100 points; the
 * rival ace this sim's weapons are tuned against has 1200): a repulsor bolt
 * ≈ 4.5, a seeker ≈ 11, a second of unibeam ≈ 14.
 */
export const DUEL_DAMAGE = 0.09;
/** The other pilot as a duel target: their suit's hit sphere (m). */
const DUEL_RADIUS = 1.6;

/** The local pilot's triggers this frame (what the wingman's copy of the weapons fires on). */
export interface PilotTriggers {
  fire: boolean;
  missile?: boolean;
  unibeam?: boolean;
  flares?: boolean;
  launcher?: boolean;
  pressed?: ReadonlySet<string>;
}

const NO_TRIGGERS: PilotTriggers = { fire: false };

export interface MultiplayerSessionOptions {
  /**
   * Builds another full rigged suit for the wingman (the app passes
   * `Suit.create`). Without it the wingman is the light procedural stand-in.
   */
  loadSuit?: () => Promise<Suit>;
}

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

  /** The wingman: the full rigged suit once it's built, the procedural stand-in until then. */
  peer: RemotePilot | RemoteSuit | null = null;
  peerInfo: PeerInfo | null = null;
  selfId = '';
  /** The shared fight (absent on a stubbed game with no combat). */
  readonly enemies: EnemySync | null;

  private transport: NetTransport;
  private readonly sendBuf = new ArrayBuffer(PILOT_STATE_BYTES);
  private readonly outState = makePilotState();
  private readonly inState = makePilotState();
  private hasPilotPacket = false;
  /** The laser cutter's key went down since the last packet. */
  private laserPressed = false;
  /** A full suit for the wingman, built once and kept between peers. */
  private fullSuit: Promise<Suit | null> | null = null;
  private spareSuit: Suit | null = null;
  /** The wingman as this sim's enemies see it (host only). */
  private readonly allyTarget: PlayerTarget;
  private readonly listeners = new Set<() => void>();
  private sendAcc = 0;
  private localPack: WarMachinePack | null = null;
  /** The wingman as this pilot's weapons see them in a duel (its hits go to them). */
  private readonly duelFoe: Hostile;
  /** Duel damage dealt since the last batch, and where the last of it landed. */
  private hitAmount = 0;
  private hitKind: DamageKind = 'repulsor';
  private readonly hitAt = new THREE.Vector3();
  private hitAcc = 0;
  private peerWasDown = false;
  private readonly _aim = new THREE.Vector3();
  private readonly _invQ = new THREE.Quaternion();
  private clockT = 0;

  constructor(
    private readonly game: Game,
    private readonly hazeUniforms: Record<string, THREE.IUniform>,
    transportFactory?: (backend: TransportBackend) => NetTransport,
    private readonly opts: MultiplayerSessionOptions = {},
  ) {
    this.group.name = 'multiplayer';
    this.enemies = game.combat?.hostiles ? new EnemySync(game.combat) : null;
    const self = this;
    this.allyTarget = {
      get pos() {
        return self.peer?.pos ?? new THREE.Vector3(0, -1e6, 0);
      },
      get vel() {
        return self.peer?.vel ?? new THREE.Vector3();
      },
      get alive() {
        return !!self.peer && !self.peer.down;
      },
      // (the wingman's sim takes its own hits)
      hit: () => {},
    };
    const hidden = new THREE.Vector3(0, -1e6, 0);
    this.duelFoe = {
      id: -7001,
      kind: 'rival',
      get label() {
        return self.peer?.callsign ?? 'PILOT';
      },
      get pos() {
        return self.peer?.pos ?? hidden;
      },
      get vel() {
        return self.peer?.vel ?? ZERO;
      },
      radius: DUEL_RADIUS,
      maxHp: 100,
      get hp() {
        return (self.peer?.armor ?? 1) * 100;
      },
      set hp(_v: number) {
        /* theirs to keep */
      },
      get alive() {
        return !!self.peer && !self.peer.down;
      },
      set alive(_v: boolean) {
        /* theirs to keep */
      },
      threatened: 0,
      // Scored here, landed there: the hit goes over to the other pilot's sim
      damage: (amount, at, kind) => {
        if (inCosmeticScope() || !(amount > 0) || !this.duelFoe.alive) return false;
        this.hitAmount += amount;
        this.hitKind = kind;
        this.hitAt.copy(at);
        return false;
      },
    };
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
    this.game.setSuitVariant?.(suit, this.localPack);
    if (this.status === 'connected') {
      this.transport.sendControl({ type: 'select', suit });
    }
    this.game.events.emit('jarvis', {
      text:
        suit === 'warmachine'
          ? 'War Machine Mark II chassis online. Auto-locking shoulder Vulcan armed on Space, sir.'
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
    this.preloadSuit();
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
    if (this.enemies) {
      // A guest's enemies were the host's: they leave with the room
      if (this.enemies.role === 'guest') this.game.combat.clearHostiles();
      this.enemies.detach();
    }
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

  /**
   * Per frame, after the sim: send this pilot's state (25 Hz), run the
   * shared fight (snapshots out as host, puppets posed as guest) and fly the
   * wingman.
   */
  update(dt: number, triggers: PilotTriggers | boolean = NO_TRIGGERS): void {
    const tr: PilotTriggers = typeof triggers === 'boolean' ? { fire: triggers } : triggers;
    this.clockT += dt;
    if (tr.pressed?.has(REACTOR_KEYS.LASER_CUTTER)) this.laserPressed = true;

    // PlayerWeapons drives the full War Machine pack animation in live flights;
    // keep a lightweight fallback here when running standalone/stubbed sessions.
    const weapons = this.game.combat?.weapons as { wmPack?: WarMachinePack | null; minigunFiring?: boolean } | undefined;
    if (this.suit === 'warmachine' && this.localPack && !weapons?.wmPack) {
      const aim = this.game.rig.aim(this._aim);
      const chest = this.game.suit.rig.bones.chest;
      chest.getWorldQuaternion(this._invQ);
      animateWarMachinePack(this.localPack, dt, {
        aimWorld: aim,
        chestWorldQuat: this._invQ,
        minigunFiring: tr.fire || !!weapons?.minigunFiring,
        minigunShot: tr.fire || !!weapons?.minigunFiring,
        podOpen: 0,
        podArmed: 0,
        podLoaded: 6,
        ventOpen: 0,
        wristDeploy: 0,
        wristLoaded: [true, true],
        wristLock: [0, 0],
        flakSweepActive: false,
      });
    }

    const connected = this.status === 'connected';
    if (connected) {
      // The guest's wave key asks the host for the next wave
      if (this.role === 'guest' && tr.pressed?.has('KeyN') && this.peer) {
        this.transport.sendControl({ type: 'event', event: { kind: 'callWave' } });
      }
      this.sendAcc += dt;
      if (this.sendAcc >= SEND_INTERVAL) {
        this.sendAcc %= SEND_INTERVAL;
        this.sendLocalState(tr);
      }
    }

    if (this.enemies) {
      // The host's enemies go after whichever pilot is nearer
      const allies = this.game.combat.allies;
      const want = this.role === 'host' && connected && !!this.peer;
      if (want && !allies.includes(this.allyTarget)) allies.push(this.allyTarget);
      else if (!want && allies.includes(this.allyTarget)) allies.splice(allies.indexOf(this.allyTarget), 1);
      const out = this.enemies.update(dt, connected && !!this.peer);
      if (out.world) this.transport.sendBinary(out.world);
      if (out.damage) this.transport.sendControl({ type: 'event', event: out.damage });
    }

    this.updateDuel(dt, connected);

    // Fly the wingman (the full suit runs its weapons against this sim's enemies, for show)
    if (this.peer instanceof RemotePilot) {
      this.peer.update(dt, this.game.combat.hostiles);
    } else if (this.peer) {
      this.peer.update(dt, this.game.ground, this.game.particles);
    }
  }

  /** Duel: the other pilot in this pilot's sights, and the hits on them sent over in batches. */
  private updateDuel(dt: number, connected: boolean): void {
    const foes = this.game.combat?.duelFoes;
    if (!foes) return;
    const want = connected && this.mode === 'duel' && !!this.peer;
    const i = foes.indexOf(this.duelFoe);
    if (want && i < 0) foes.push(this.duelFoe);
    else if (!want && i >= 0) foes.splice(i, 1);
    if (!want) {
      this.hitAmount = 0;
      this.peerWasDown = false;
      return;
    }
    this.hitAcc += dt;
    if (this.hitAcc >= 1 / HIT_HZ) {
      this.hitAcc %= 1 / HIT_HZ;
      if (this.hitAmount > 0) {
        const a = this.hitAt;
        this.transport.sendControl({
          type: 'event',
          event: { kind: 'hit', amount: this.hitAmount * DUEL_DAMAGE, x: a.x, y: a.y, z: a.z, weapon: this.hitKind },
        });
        this.hitAmount = 0;
      }
    }
    const down = !!this.peer?.down;
    if (down && !this.peerWasDown) {
      this.game.events.emit('jarvis', { text: `${this.peer?.callsign ?? 'They'} is down, sir. Splash one.` });
    }
    this.peerWasDown = down;
  }

  /**
   * The house's R&D repair, shared in a room: a guest's goes to the host
   * (whose sim keeps the house) and shows here at once. Returns false when
   * there's no shared fight to send it to (solo, or this is the host).
   */
  repairHouse(share: number): boolean {
    if (this.status !== 'connected' || this.role !== 'guest' || !this.peer || !this.enemies) return false;
    const c = this.game.combat;
    c.repairHouse(share);
    this.enemies.holdHouse(c.houseHp);
    this.transport.sendControl({ type: 'event', event: { kind: 'repairHouse', share } });
    return true;
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

  private sendLocalState(tr: PilotTriggers): void {
    const g = this.game;
    const m = g.model;
    const c = g.combat;
    const p = this.outState;
    let flags = 0;
    if (m.grounded) flags |= PilotFlag.GROUNDED;
    if (m.boosting) flags |= PilotFlag.BOOSTING;
    if (c.down > 0) flags |= PilotFlag.DOWN;
    if (tr.fire) flags |= PilotFlag.FIRE;
    if (tr.missile) flags |= PilotFlag.MISSILE;
    if (tr.unibeam) flags |= PilotFlag.UNIBEAM;
    if (tr.flares) flags |= PilotFlag.FLARES;
    if (tr.launcher) flags |= PilotFlag.LAUNCHER;
    if (this.laserPressed) flags |= PilotFlag.LASER;
    this.laserPressed = false;
    const reactor = c.reactor;
    if (reactor?.overchargeActive) flags |= PilotFlag.OVERCHARGE;
    p.flags = flags;
    p.reactor = Math.max(0, REACTOR_MODES.indexOf(reactor?.mode ?? 'BALANCED'));
    p.armor = c.armor;
    p.reserves = c.reserves;
    p.strafeDashDir = m.strafeDashDir ?? 0;
    // (the session's own clock: the sim's runs slow through a hit-stop)
    p.t = this.clockT;
    p.pos.copy(m.pos);
    p.vel.copy(m.vel);
    p.q.copy(m.q);
    p.omega.copy(m.omega ?? ZERO);
    g.rig.aim(p.aim);
    // Shots are sighted from the eye the pilot is looking through
    const mode = g.rig.mode;
    p.eye.copy(mode === 'flyby' || mode === 'attract' || !g.rig.camera ? (g.head ?? m.pos) : g.rig.camera.position);
    const ms = m as unknown as Partial<Record<PilotScalar, number>>;
    for (const k of PILOT_SCALARS) p.s[k] = ms[k] ?? 0;
    encodePilotState(p, this.sendBuf);
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
      const tag = new Uint8Array(buf, 0, Math.min(1, buf.byteLength))[0];
      if (tag === WORLD_PACKET_TAG) {
        const w = decodeWorldState(buf);
        if (w) this.enemies?.onWorld(w);
        return;
      }
      if (tag !== PILOT_PACKET_TAG || !decodePilotState(buf, this.inState)) return;
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
      this.hasPilotPacket = true;
      this.peer?.applyPilot(this.inState);
    };
  }

  private handleControl(msg: ServerControlMessage): void {
    switch (msg.type) {
      case 'welcome': {
        this.selfId = msg.id;
        this.room = msg.room;
        this.role = msg.role;
        this.mode = msg.mode;
        // Joining a host's room: their enemies replace ours
        this.enemies?.reset(msg.role);
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
        this.sendLocalState(NO_TRIGGERS);
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
          // The host left: their enemies, puppets here, fly on as ours
          this.enemies?.promote();
        }
        this.clearPeer();
        this.game.events.emit('jarvis', { text: `${who} has broken formation and left the airspace, sir.` });
        this.notify();
        break;
      }

      case 'pong':
        this.notify();
        break;

      case 'event': {
        const e = msg.event;
        if (e.kind === 'pingCallout') {
          this.game.events.emit('jarvis', { text: e.text });
        } else if (e.kind === 'dmg' && Array.isArray(e.hits)) {
          this.enemies?.applyDamage(e.hits);
        } else if (e.kind === 'callWave' && this.role === 'host') {
          const c = this.game.combat;
          if (c.waveReady) c.callWave();
        } else if (e.kind === 'repairHouse' && this.role === 'host') {
          const c = this.game.combat;
          if (Number.isFinite(e.share) && !c.lost) c.repairHouse(Math.min(0.25, Math.max(0, e.share)));
        } else if (e.kind === 'hit' && this.mode === 'duel') {
          // The other pilot's shots on this suit (they scored them in their sim)
          const amount = Math.min(60, Number(e.amount));
          if (!(amount > 0)) break;
          const at = new THREE.Vector3(e.x, e.y, e.z);
          if (![at.x, at.y, at.z].every(Number.isFinite)) at.copy(this.game.model.pos);
          const kind = e.weapon === 'unibeam' ? 'beam' : e.weapon === 'missile' || e.weapon === 'launcher' ? 'missile' : 'bullet';
          this.game.combat.playerTarget?.hit(amount, at, kind);
        }
        break;
      }

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
    void this.upgradePeer(r);
  }

  /** Start building the wingman's full suit (once) as soon as a room is in play. */
  private preloadSuit(): void {
    if (this.fullSuit || !this.opts.loadSuit) return;
    this.fullSuit = this.opts.loadSuit().catch((err) => {
      console.warn('[multiplayer] full wingman suit failed to build; keeping the stand-in', err);
      return null;
    });
    void this.fullSuit.then((s) => {
      if (s && !this.spareSuit) this.spareSuit = s;
    });
  }

  /** Swap the stand-in for the full rigged suit once it's built (if the same wingman is still here). */
  private async upgradePeer(standIn: RemoteSuit): Promise<void> {
    this.preloadSuit();
    if (!this.fullSuit) return;
    const suit = await this.fullSuit;
    if (!suit || this.peer !== standIn || this.spareSuit !== suit) return;
    const g = this.game;
    const pilot = new RemotePilot(standIn.id, standIn.variant, standIn.callsign, {
      suit,
      ground: g.ground,
      field: g.world.field,
      particles: g.particles,
      explosions: g.combat.explosions,
      streaks: g.combat.streaks,
      hazeUniforms: this.hazeUniforms,
    });
    this.spareSuit = null;
    this.group.remove(standIn.mesh);
    standIn.dispose();
    this.peer = pilot;
    this.group.add(pilot.mesh);
    if (this.hasPilotPacket) pilot.applyPilot(this.inState);
    this.notify();
  }

  private clearPeer(): void {
    if (this.peer) {
      this.group.remove(this.peer.mesh);
      this.peer.dispose();
      // The full suit is built once (a second download and skinning pass is seconds): a new pilot builds another
      if (this.peer instanceof RemotePilot) this.fullSuit = null;
      this.peer = null;
    }
    this.peerInfo = null;
  }

  dispose(): void {
    this.leaveRoom();
    this.listeners.clear();
  }
}
