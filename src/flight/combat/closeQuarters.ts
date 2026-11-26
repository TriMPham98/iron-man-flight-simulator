import * as THREE from 'three';
import type { Particles } from '../fx/particles';
import type { EventBus } from '../sim/events';
import type { FlightModel } from '../sim/flightModel';
import type { Explosions, SurfaceQuery } from './explosions';
import { coreDistance, segmentToCore } from './hitShape';
import type { Hostile, HostileKind } from './types';

/**
 * Close-Quarters Superhero Combat:
 *  Mid-Air Grapple / Throw & Thruster Punch: within ~12 m of an enemy
 *  aircraft (`drone`, `bomber`, `interceptor`, `jammer`), either grabs it
 *  on a 1.8 s tether and hurls it at 180 m/s as an explosive kinetic
 *  projectile (`260` splash damage), or delivers a Thruster Punch sending
 *  it hurtling along `aimDir` into nearby targets.
 */

export const MELEE_RANGE = 12;
export const GRAB_MAX_DURATION = 1.8;
export const THROW_SPEED = 180;
export const THROW_SPLASH_DAMAGE = 260;
export const THROW_SPLASH_RADIUS = 42;
export const PUNCH_SPEED = 155;
export const PUNCH_DAMAGE = 85;
export const MELEE_COOLDOWN = 0.65;

export type MeleeFlightModel = Pick<FlightModel, 'pos' | 'vel' | 'grounded'>;

export type MeleeActionKind = 'grab' | 'throw' | 'punch' | 'none';

export interface MeleeActionResult {
  action: MeleeActionKind;
  target: Hostile | null;
}

interface ThrownTarget {
  target: Hostile;
  vel: THREE.Vector3;
  prevPos: THREE.Vector3;
  life: number;
  splashDamage: number;
  splashRadius: number;
}

interface ShockRing {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  t: number;
  dur: number;
  r0: number;
  r1: number;
  peakOpacity: number;
}

let ringGeo: THREE.BufferGeometry | null = null;
function getRingGeo(): THREE.BufferGeometry {
  if (!ringGeo) ringGeo = new THREE.RingGeometry(0.75, 1.0, 48).rotateX(-Math.PI / 2);
  return ringGeo;
}

const UP = new THREE.Vector3(0, 1, 0);

/** Aircraft types eligible for mid-air grapple/throw and thruster punch. */
export function isGrappleableAircraft(kind: HostileKind): boolean {
  return kind === 'drone' || kind === 'bomber' || kind === 'interceptor' || kind === 'jammer';
}

export class CloseQuarters {
  readonly group = new THREE.Group();

  /** HUD-readable state. */
  grabbedTarget: Hostile | null = null;
  availableMeleeTarget: Hostile | null = null;
  cooldown = 0;
  grabRemaining = 0;

  private readonly thrown: ThrownTarget[] = [];
  private readonly rings: ShockRing[] = [];
  private pendingShake = 0;

  private readonly _v = new THREE.Vector3();
  private readonly _w = new THREE.Vector3();
  private readonly _seg = new THREE.Vector3();
  private readonly _core = new THREE.Vector3();

  constructor() {
    this.group.name = 'close-quarters';
  }

  reset(): void {
    this.grabbedTarget = null;
    this.grabRemaining = 0;
    this.availableMeleeTarget = null;
    this.cooldown = 0;
    this.thrown.length = 0;
    this.pendingShake = 0;
    for (const r of this.rings) {
      this.group.remove(r.mesh);
      r.mat.dispose();
    }
    this.rings.length = 0;
  }

  consumeShake(): number {
    const s = this.pendingShake;
    this.pendingShake = 0;
    return s;
  }

  /** Number of thrown/punched enemy projectiles currently in flight. */
  get thrownInFlight(): number {
    return this.thrown.length;
  }

  /** Find the nearest eligible enemy aircraft within melee reach (~12 m). */
  findMeleeTarget(model: MeleeFlightModel, aimDir: THREE.Vector3, hostiles: readonly Hostile[]): Hostile | null {
    const dir = this._v.copy(aimDir);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();

    let best: Hostile | null = null;
    let bestScore = -Infinity;
    for (const h of hostiles) {
      if (!h.alive || !isGrappleableAircraft(h.kind)) continue;
      if (this.thrown.some((t) => t.target === h)) continue;
      const reach = MELEE_RANGE + (h.kind === 'bomber' ? 4 : 0);
      const dist = coreDistance(h, model.pos);
      if (dist > reach) continue;
      const to = this._w.copy(h.pos).sub(model.pos);
      const dot = dist > 1e-4 ? to.dot(dir) / dist : 1;
      // Prefer targets roughly in front of the suit and closer
      const score = dot * 2 - dist / reach;
      if (score > bestScore) {
        bestScore = score;
        best = h;
      }
    }
    return best;
  }

  /**
   * Mid-Air Grapple / Throw & Thruster Punch:
   * - If already holding a grabbed aircraft, hurls it at 180 m/s along `aimDir`.
   * - Otherwise grabs an enemy aircraft within ~12 m (for up to 1.8 s), or with
   *   `mode: 'punch'` delivers a high-impulse Thruster Punch along `aimDir`.
   */
  tryMeleeAction(
    model: MeleeFlightModel,
    aimDir: THREE.Vector3,
    hostiles: readonly Hostile[],
    ground: SurfaceQuery,
    explosions: Explosions,
    particles: Particles,
    opts: { mode?: 'grab' | 'punch'; events?: EventBus } = {},
  ): MeleeActionResult {
    void ground;
    const dir = this._v.copy(aimDir);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();

    if (this.grabbedTarget) {
      const thrown = this.throwGrabbed(model, dir, explosions, particles, opts.events);
      return { action: thrown ? 'throw' : 'none', target: thrown };
    }

    if (this.cooldown > 0) return { action: 'none', target: null };
    const target = this.findMeleeTarget(model, dir, hostiles);
    if (!target) return { action: 'none', target: null };

    if (opts.mode === 'punch') {
      const hitAt = target.pos.clone();
      const killed = target.damage(PUNCH_DAMAGE, hitAt, 'ram');
      this.launchAsProjectile(target, dir, PUNCH_SPEED);
      this.cooldown = MELEE_COOLDOWN;
      this.pendingShake += 0.95;

      particles.emit('flash', hitAt, model.vel, { scale: 1.1 });
      particles.burst('spark', hitAt, 24, 24, dir, 1.1, { scale: 1.2 });
      particles.burst('plasma', hitAt, 8, 12, dir, 0.9);
      if (killed) opts.events?.emit('kill', { at: hitAt, text: target.kind });
      opts.events?.emit('kineticRam', { at: hitAt, value: PUNCH_SPEED, text: target.kind });
      return { action: 'punch', target };
    }

    // Grapple & tether ahead of the suit
    this.grabbedTarget = target;
    this.grabRemaining = GRAB_MAX_DURATION;
    this.availableMeleeTarget = null;
    this.markTethered(target, true);
    particles.burst('spark', target.pos, 12, 14, undefined, 0.8);
    particles.burst('plasma', target.pos, 6, 8, undefined, 0.8);
    return { action: 'grab', target };
  }

  /** Release/throw the currently grabbed aircraft along `aimDir` (e.g. on key release). */
  releaseGrab(
    model: MeleeFlightModel,
    aimDir: THREE.Vector3,
    explosions: Explosions,
    particles: Particles,
    events?: EventBus,
  ): Hostile | null {
    if (!this.grabbedTarget) return null;
    const dir = this._v.copy(aimDir);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();
    return this.throwGrabbed(model, dir, explosions, particles, events);
  }

  /** Per-frame update for active grapple tether, thrown kinetic projectiles & rings. */
  update(
    dt: number,
    model: MeleeFlightModel,
    aimDir: THREE.Vector3,
    hostiles: readonly Hostile[],
    ground: SurfaceQuery,
    explosions: Explosions,
    particles: Particles,
    events?: EventBus,
  ): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.updateRings(dt);

    const dir = this._v.copy(aimDir);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();

    // Update HUD-facing melee target prompt
    this.availableMeleeTarget = this.grabbedTarget || this.cooldown > 0 ? null : this.findMeleeTarget(model, dir, hostiles);

    // 1. Active Grapple Tether (up to 1.8 s)
    if (this.grabbedTarget) {
      const g = this.grabbedTarget;
      if (!g.alive) {
        this.grabbedTarget = null;
        this.grabRemaining = 0;
      } else {
        this.grabRemaining -= dt;
        const holdDist = 3.2 + g.radius * 0.45;
        g.pos.copy(model.pos).addScaledVector(dir, holdDist);
        g.vel.copy(model.vel);
        this.syncMesh(g);
        if (Math.random() < Math.min(1, dt * 18)) {
          particles.emit('spark', g.pos, model.vel, { scale: 0.7, life: 0.25 });
        }
        if (this.grabRemaining <= 0) {
          this.throwGrabbed(model, dir, explosions, particles, events);
        }
      }
    }

    // 2. Thrown / Punched Kinetic Projectiles
    for (let i = this.thrown.length - 1; i >= 0; i--) {
      const t = this.thrown[i];
      t.life -= dt;
      t.prevPos.copy(t.target.pos);
      t.target.vel.copy(t.vel);
      t.target.pos.addScaledVector(t.vel, dt);
      this.syncMesh(t.target);

      if (Math.random() < Math.min(1, dt * 35)) {
        particles.emit('fire', t.target.pos, t.vel.clone().multiplyScalar(0.15), { scale: 1.1, life: 0.35 });
        particles.emit('darkSmoke', t.target.pos, undefined, { scale: 0.9, life: 0.6 });
      }

      let impactPos: THREE.Vector3 | null = null;
      // Check collision with other hostiles (drones, bombers, SAMs, frigate parts, dreadnought parts)
      for (const h of hostiles) {
        if (!h.alive || h === t.target) continue;
        const hitR = h.radius + t.target.radius + 2.5;
        if (segmentToCore(h, t.prevPos, t.target.pos, this._seg, this._core) <= hitR * hitR) {
          impactPos = this._seg.clone().lerp(this._core, 0.5);
          break;
        }
      }
      // Check collision with terrain or water
      if (!impactPos) {
        const surf = ground.surface(t.target.pos.x, t.target.pos.z);
        if (t.target.pos.y <= surf + 1.5) {
          impactPos = new THREE.Vector3(t.target.pos.x, surf + 0.5, t.target.pos.z);
        }
      }

      if (impactPos || t.life <= 0) {
        const at = impactPos ?? t.target.pos.clone();
        this.detonateThrown(t, at, hostiles, ground, explosions, particles, events);
        this.thrown.splice(i, 1);
      }
    }
  }

  private throwGrabbed(
    model: MeleeFlightModel,
    dir: THREE.Vector3,
    explosions: Explosions,
    particles: Particles,
    events?: EventBus,
  ): Hostile | null {
    void model;
    const target = this.grabbedTarget;
    if (!target) return null;
    this.grabbedTarget = null;
    this.grabRemaining = 0;
    this.cooldown = MELEE_COOLDOWN;

    if (!target.alive) return null;
    this.launchAsProjectile(target, dir, THROW_SPEED);
    this.pendingShake += 0.8;

    explosions.muzzle(target.pos, dir, 1.4);
    particles.burst('plasma', target.pos, 14, 18, dir, 1.0, { scale: 1.1 });
    particles.burst('spark', target.pos, 18, 22, dir, 1.1);
    events?.emit('kineticRam', { at: target.pos, value: THROW_SPEED, text: target.kind });
    return target;
  }

  private launchAsProjectile(target: Hostile, dir: THREE.Vector3, speed: number): void {
    this.markTethered(target, true);
    const vel = dir.clone().normalize().multiplyScalar(speed);
    target.vel.copy(vel);
    this.thrown.push({
      target,
      vel,
      prevPos: target.pos.clone(),
      life: 2.6,
      splashDamage: THROW_SPLASH_DAMAGE,
      splashRadius: THROW_SPLASH_RADIUS,
    });
  }

  private markTethered(target: Hostile, on: boolean): void {
    const d = target as Hostile & { passive?: boolean; destabilized?: number; threatened?: number };
    if ('passive' in d) d.passive = on;
    if (on && 'destabilized' in d && typeof d.destabilized === 'number') {
      d.destabilized = Math.max(d.destabilized, 3.0);
    }
    target.threatened = Math.max(target.threatened, 2.0);
  }

  private syncMesh(h: Hostile): void {
    const withMesh = h as Hostile & { mesh?: THREE.Object3D };
    if (withMesh.mesh) withMesh.mesh.position.copy(h.pos);
  }

  private detonateThrown(
    t: ThrownTarget,
    at: THREE.Vector3,
    hostiles: readonly Hostile[],
    ground: SurfaceQuery,
    explosions: Explosions,
    particles: Particles,
    events?: EventBus,
  ): void {
    const water = ground.isWater(at.x, at.z) && at.y <= ground.surface(at.x, at.z) + 4;
    explosions.blast(at, 11, { debris: 16, burn: !water, vel: t.vel.clone().multiplyScalar(0.1) });
    this.spawnRing(at, 2, t.splashRadius, 0.45, 0xff9a44, 0.85);
    particles.burst('spark', at, 28, 26, UP, 1.1, { scale: 1.25 });

    if (t.target.alive) {
      if (t.target.damage(t.target.maxHp * 2 + 500, at, 'ram')) {
        events?.emit('kill', { at, text: t.target.kind });
      }
    }

    for (const h of hostiles) {
      if (!h.alive || h === t.target) continue;
      const d = Math.max(0, coreDistance(h, at) - h.radius);
      if (d > t.splashRadius) continue;
      const falloff = 1 - 0.55 * (d / t.splashRadius);
      const dmg = t.splashDamage * falloff;
      if (h.damage(dmg, at, 'ram')) {
        events?.emit('kill', { at: h.pos, text: h.kind });
      }
      if (isGrappleableAircraft(h.kind)) {
        const push = this._v.copy(h.pos).sub(at);
        if (push.lengthSq() < 1e-4) push.set(0, 1, 0);
        else push.normalize();
        h.vel.addScaledVector(push, 65 * falloff);
      }
    }

    this.pendingShake += 1.7;
    events?.emit('bigExplosion', { at, value: 11 });
  }

  private spawnRing(at: THREE.Vector3, r0: number, r1: number, dur: number, color: number, peakOpacity: number): void {
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: peakOpacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(getRingGeo(), mat);
    mesh.position.copy(at);
    mesh.scale.setScalar(r0);
    mesh.renderOrder = 6;
    this.group.add(mesh);
    this.rings.push({ mesh, mat, t: 0, dur, r0, r1, peakOpacity });
  }

  private updateRings(dt: number): void {
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.t += dt;
      const u = r.t / r.dur;
      if (u >= 1) {
        this.group.remove(r.mesh);
        r.mat.dispose();
        this.rings.splice(i, 1);
        continue;
      }
      const ease = 1 - (1 - u) * (1 - u);
      r.mesh.scale.setScalar(THREE.MathUtils.lerp(r.r0, r.r1, ease));
      r.mat.opacity = r.peakOpacity * (1 - u) * (1 - u);
    }
  }
}
