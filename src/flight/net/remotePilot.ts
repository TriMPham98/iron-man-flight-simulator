import * as THREE from 'three';
import type { Suit } from '../../suit/Suit';
import { Jets } from '../fx/jets';
import type { Particles } from '../fx/particles';
import { ReactorVentFx } from '../fx/reactorVent';
import type { Streaks } from '../fx/streaks';
import { patchLogDepth } from '../render/depth';
import { hazeAll } from '../render/haze';
import type { Explosions } from '../combat/explosions';
import { Missiles } from '../combat/missiles';
import { PlayerWeapons } from '../combat/playerWeapons';
import type { Hostile, PlayerTarget } from '../combat/types';
import { EventBus } from '../sim/events';
import { FlightModel } from '../sim/flightModel';
import type { groundProbe } from '../sim/ground';
import type { Controls } from '../sim/input';
import { REACTOR_KEYS, ReactorPower } from '../sim/reactorPower';
import { SuitDriver } from '../sim/suitDriver';
import { SPEED_OF_SOUND } from '../world/config';
import type { Heightfield } from '../world/heightfield';
import { cosmetic } from './netDamage';
import {
  makePilotState,
  PILOT_SCALARS,
  PilotFlag,
  REACTOR_MODES,
  type PilotNetState,
  type PilotScalar,
  type SuitVariant,
} from './protocol';
import { applyLocalSuitVariant } from './suitVisuals';

/** How far behind the newest packet the puppet is drawn (s): two packets' worth at 25 Hz, so it always has a pair to blend. */
const INTERP_DELAY = 0.1;
/** Past the newest packet it flies on by its velocity for at most this long (s), then holds. */
const MAX_EXTRAPOLATE = 0.25;
/** A jump this far (m) between packets is a reset or a redeploy: no blending across it. */
const TELEPORT = 60;
const BUFFER = 8;

type GroundProbe = ReturnType<typeof groundProbe>;

export interface RemotePilotDeps {
  suit: Suit;
  ground: GroundProbe;
  field: Heightfield;
  particles: Particles;
  explosions: Explosions;
  streaks: Streaks;
  hazeUniforms: Record<string, THREE.IUniform>;
}

/** Nobody: what the puppet's cosmetic missiles think the local pilot is (they never strike it). */
const NO_PLAYER: PlayerTarget = { pos: new THREE.Vector3(0, -1e6, 0), vel: new THREE.Vector3(), alive: false, hit: () => {} };

/**
 * The other pilot, flown in this sim as a puppet of the real rigged suit:
 * the network state drives a {@link FlightModel} (never stepped, only set),
 * which the same {@link SuitDriver} turns into the full body language, boot
 * and palm jets, flaps and landings. A cosmetic copy of their weapons runs on
 * their replicated triggers, so every bolt, tracer, seeker, unibeam, flare
 * and laser cut is the real effect, from the real hardware, along their aim
 * (its hits deal no damage here: each pilot's own sim scores their shots).
 */
export class RemotePilot {
  readonly mesh = new THREE.Group();
  readonly model: FlightModel;
  readonly driver = new SuitDriver();
  readonly jets = new Jets();
  readonly weapons: PlayerWeapons;
  readonly missiles: Missiles;
  readonly reactor: ReactorPower;
  readonly events = new EventBus();
  variant: SuitVariant;
  armor = 1;
  reserves = 0;
  /** Last packet's flags (what the session's HUD reads). */
  flags = 0;

  private readonly vent = new ReactorVentFx();
  private readonly ring: PilotNetState[] = [];
  /** Local clock minus sender clock, tracked at its floor (the least-delayed packet). */
  private offset = Infinity;
  private readonly cur = makePilotState();
  private clock = 0;
  private hasState = false;
  private lastMode = 0;
  private laserSeen = -1;
  private readonly controls: Controls = {
    aimYaw: 0,
    aimPitch: 0,
    throttle: 0,
    lateral: 0,
    vertical: 0,
    forward: 0,
    boost: false,
    brake: false,
    fire: false,
    missile: false,
    unibeam: false,
    flares: false,
    launcher: false,
    pressed: new Set<string>(),
    zoom: 0,
  };
  private readonly _q = new THREE.Quaternion();
  private readonly suit: Suit;
  private readonly deps: RemotePilotDeps;

  constructor(
    readonly id: string,
    variant: SuitVariant,
    public callsign: string,
    deps: RemotePilotDeps,
  ) {
    this.deps = deps;
    const suit = (this.suit = deps.suit);
    this.variant = variant;
    this.model = new FlightModel(deps.ground);
    this.missiles = new Missiles(deps.particles, deps.explosions, deps.ground, this.events);
    this.weapons = new PlayerWeapons(suit, this.model, deps.field, deps.particles, deps.streaks, this.missiles, deps.explosions, this.events);
    this.reactor = new ReactorPower(this.events);
    this.weapons.reactor = this.reactor;
    this.model.reactor = this.reactor.modifiers;

    this.mesh.name = 'remote-pilot';
    this.mesh.add(suit.group, this.jets.group, this.weapons.group, this.missiles.group);
    patchLogDepth(suit.group);
    hazeAll(suit.group, deps.hazeUniforms);
    suit.forEachMesh((m) => {
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      const lit = mats.every((x) => (x as THREE.MeshStandardMaterial).isMeshStandardMaterial && !x.transparent);
      m.castShadow = lit;
      m.receiveShadow = lit;
    });
    // A second set of point lights would change every lit material's light
    // count (a recompile of the whole scene the moment the wingman appears):
    // the puppet's muzzle/jet/flare glows go without them
    const lights: THREE.Light[] = [];
    this.mesh.traverse((o) => {
      if ((o as THREE.PointLight).isPointLight) lights.push(o as THREE.Light);
    });
    for (const l of lights) l.removeFromParent();
    suit.showFinal();
    suit.setSystemsPower({ reactor: 1, eyes: 1, repulsors: 1 });
    this.applyVariant();
    this.mesh.visible = false;
  }

  get pos(): THREE.Vector3 {
    return this.model.pos;
  }
  get vel(): THREE.Vector3 {
    return this.model.vel;
  }
  get speed(): number {
    return this.model.vel.length();
  }
  get mach(): number {
    return this.speed / SPEED_OF_SOUND;
  }
  get firing(): boolean {
    return (this.cur.flags & PilotFlag.FIRE) !== 0;
  }
  get down(): boolean {
    return (this.cur.flags & PilotFlag.DOWN) !== 0;
  }

  setVariant(variant: SuitVariant, callsign?: string): void {
    if (callsign) this.callsign = callsign;
    if (variant === this.variant) return;
    this.variant = variant;
    this.applyVariant();
  }

  private applyVariant(): void {
    const pack = applyLocalSuitVariant(this.suit, this.variant, this.deps.hazeUniforms);
    this.weapons.setVariant(this.variant, this.variant === 'warmachine' ? pack : null);
  }

  /** A packet in (`t` is the sender's wall clock, s). */
  applyPilot(p: PilotNetState): void {
    const last = this.ring[this.ring.length - 1];
    if (last && p.t <= last.t) {
      if (p.t > last.t - 5) return; // stale / duplicate
      // The sender's clock restarted (a rejoin): start over
      this.ring.length = 0;
      this.offset = Infinity;
    }
    // The delay floor drifts up slowly (a clock that runs a touch slow) and drops at once
    const off = this.clock - p.t;
    this.offset = off < this.offset ? off : this.offset + (off - this.offset) * 0.002;
    const slot = this.ring.length >= BUFFER ? this.ring.shift()! : makePilotState();
    copyPilot(p, slot);
    // A reset or redeploy: drop the history so it isn't blended across
    if (last && last.pos.distanceTo(p.pos) > TELEPORT) this.ring.length = 0;
    this.ring.push(slot);
    this.armor = p.armor;
    this.reserves = p.reserves;
    this.flags = p.flags;
  }

  /** Blend the buffered packets at the render time into {@link cur}. */
  private sample(): boolean {
    const n = this.ring.length;
    if (!n) return false;
    // Render time on the sender's clock
    const t = this.clock - this.offset - INTERP_DELAY;
    let i = n - 1;
    while (i > 0 && this.ring[i].t > t) i--;
    const a = this.ring[i];
    const b = this.ring[i + 1];
    const c = this.cur;
    if (!b || a.t >= t) {
      copyPilot(a, c);
      const over = Math.min(MAX_EXTRAPOLATE, Math.max(0, t - a.t));
      if (!b && over > 0) c.pos.addScaledVector(c.vel, over);
    } else {
      lerpPilot(a, b, THREE.MathUtils.clamp((t - a.t) / Math.max(1e-4, b.t - a.t), 0, 1), c);
    }
    // One-shot presses ride a packet: fire each once, when the render time reaches it
    for (let j = 0; j <= i; j++) {
      const s = this.ring[j];
      if (s.flags & PilotFlag.LASER && s.t > this.laserSeen) {
        this.laserSeen = s.t;
        this.controls.pressed.add(REACTOR_KEYS.LASER_CUTTER);
      }
    }
    return true;
  }

  /**
   * One frame: pose the puppet from the network, run its weapons (cosmetic)
   * and jets. `hostiles` are this sim's enemies (its seekers lock and its
   * bolts burst on them, for show).
   */
  update(dt: number, hostiles: readonly Hostile[]): void {
    this.clock += dt;
    this.controls.pressed.clear();
    if (!this.sample()) {
      this.mesh.visible = false;
      return;
    }
    const first = !this.hasState;
    this.hasState = true;
    this.mesh.visible = true;
    const p = this.cur;
    const m = this.model;

    // ── Flight model, set not stepped ──
    m.pos.copy(p.pos);
    m.vel.copy(p.vel);
    m.q.copy(p.q);
    m.omega.copy(p.omega);
    const ms = m as unknown as Record<PilotScalar, number>;
    for (const k of PILOT_SCALARS) ms[k] = p.s[k];
    m.grounded = (p.flags & PilotFlag.GROUNDED) !== 0;
    m.boosting = (p.flags & PilotFlag.BOOSTING) !== 0;
    m.strafeDashDir = p.strafeDashDir;
    const g = m.gait;
    if (first) g.attached = false;
    if (m.grounded && !g.attached) g.attach(m.pos, m.heading, m.ground);
    else if (!m.grounded && g.attached) g.detach(m.pos, m.bodyQuaternion(this._q));
    g.step(dt, m.pos, m.heading, m.vel, m.omega.y, m.crouch, m.ground);

    // ── Reactor routing (and the flaps venting on a change) ──
    const mode = REACTOR_MODES[p.reactor] ?? 'BALANCED';
    this.reactor.mode = mode;
    this.reactor.overchargeRemaining = p.flags & PilotFlag.OVERCHARGE ? Math.max(this.reactor.overchargeRemaining, 1) : 0;
    if (p.reactor !== this.lastMode && !first) {
      const v = this.vent.trigger(mode);
      if (v) this.driver.vent(v.flaps, v.dur + 0.15, v.open);
    }
    this.lastMode = p.reactor;

    // ── Weapons on their triggers (no damage here) ──
    const c = this.controls;
    c.fire = (p.flags & PilotFlag.FIRE) !== 0;
    c.missile = (p.flags & PilotFlag.MISSILE) !== 0;
    c.unibeam = (p.flags & PilotFlag.UNIBEAM) !== 0;
    c.flares = (p.flags & PilotFlag.FLARES) !== 0;
    c.launcher = (p.flags & PilotFlag.LAUNCHER) !== 0;
    c.boost = m.boosting;
    const alive = !this.down;
    cosmetic(() => this.weapons.update(dt, c, p.aim, p.eye, hostiles, alive));

    // ── Body language, then the shots leave the hardware where it's drawn ──
    this.driver.update(dt, this.suit, m, p.aim, this.weapons.arms);
    this.suit.update(dt);
    cosmetic(() => this.weapons.afterPose());
    this.deps.streaks.end();

    const o = this.driver.outputs;
    this.jets.update(
      dt,
      this.suit,
      { bootL: o.bootL, bootR: o.bootR, palmL: o.palmL, palmR: o.palmR, palmBoost: o.palmBoost, mode, overcharge: this.reactor.overchargeActive },
      this.deps.ground,
      this.deps.particles,
      m.vel,
    );
    this.vent.update(dt, this.suit, this.deps.particles, m.vel);
    cosmetic(() => this.missiles.update(dt, hostiles, NO_PLAYER));
  }

  dispose(): void {
    this.missiles.clear();
    this.mesh.removeFromParent();
    this.mesh.clear();
    this.suit.dispose();
  }
}

function copyPilot(a: PilotNetState, out: PilotNetState): void {
  out.flags = a.flags;
  out.reactor = a.reactor;
  out.armor = a.armor;
  out.reserves = a.reserves;
  out.strafeDashDir = a.strafeDashDir;
  out.t = a.t;
  out.pos.copy(a.pos);
  out.vel.copy(a.vel);
  out.q.copy(a.q);
  out.omega.copy(a.omega);
  out.aim.copy(a.aim);
  out.eye.copy(a.eye);
  for (const k of PILOT_SCALARS) out.s[k] = a.s[k];
}

/** Continuous state blended a→b; triggers and modes are a's until b is reached. */
function lerpPilot(a: PilotNetState, b: PilotNetState, k: number, out: PilotNetState): void {
  copyPilot(a, out);
  out.t = a.t + (b.t - a.t) * k;
  // Hermite on position (velocity-matched ends): smooth through the turns at speed
  const dt = Math.max(1e-3, b.t - a.t);
  const k2 = k * k;
  const k3 = k2 * k;
  const h00 = 2 * k3 - 3 * k2 + 1;
  const h10 = k3 - 2 * k2 + k;
  const h01 = -2 * k3 + 3 * k2;
  const h11 = k3 - k2;
  out.pos.set(
    h00 * a.pos.x + h10 * dt * a.vel.x + h01 * b.pos.x + h11 * dt * b.vel.x,
    h00 * a.pos.y + h10 * dt * a.vel.y + h01 * b.pos.y + h11 * dt * b.vel.y,
    h00 * a.pos.z + h10 * dt * a.vel.z + h01 * b.pos.z + h11 * dt * b.vel.z,
  );
  out.vel.lerpVectors(a.vel, b.vel, k);
  out.q.slerpQuaternions(a.q, b.q, k);
  out.omega.lerpVectors(a.omega, b.omega, k);
  out.aim.lerpVectors(a.aim, b.aim, k).normalize();
  out.eye.lerpVectors(a.eye, b.eye, k);
  for (const key of PILOT_SCALARS) out.s[key] = a.s[key] + (b.s[key] - a.s[key]) * k;
  // Being on the ground, boosting and a trigger held count from the later packet once halfway there
  if (k > 0.5) {
    out.flags = b.flags & ~PilotFlag.LASER;
    out.reactor = b.reactor;
  }
}
