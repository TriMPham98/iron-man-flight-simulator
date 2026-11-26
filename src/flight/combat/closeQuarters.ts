import * as THREE from 'three';
import type { Particles } from '../fx/particles';
import type { EventBus } from '../sim/events';
import type { FlightModel } from '../sim/flightModel';
import type { Explosions, SurfaceQuery } from './explosions';
import { coreDistance, segmentToCore } from './hitShape';
import type { Hostile, HostileKind } from './types';

/**
 * Close-Quarters Superhero Combat:
 *  1. Targeted Dive-Slam ("Meteor Ground-Pound"): airborne suit locks into a
 *     steep supersonic dive toward an aimed target or ground point, triggers a
 *     scaled shockwave on impact damaging SAMs/ships/drones/boss parts, and
 *     executes an automatic upward rebound hop (`vel.y = 32`).
 *  2. Mid-Air Grapple / Throw & Thruster Punch: within ~12 m of an enemy
 *     aircraft (`drone`, `bomber`, `interceptor`, `jammer`), either grabs it
 *     on a 1.8 s tether and hurls it at 180 m/s as an explosive kinetic
 *     projectile (`260` splash damage), or delivers a Thruster Punch sending
 *     it hurtling along `aimDir` into nearby targets.
 */

export const MELEE_RANGE = 12;
export const GRAB_MAX_DURATION = 1.8;
export const THROW_SPEED = 180;
export const THROW_SPLASH_DAMAGE = 260;
export const THROW_SPLASH_RADIUS = 42;
export const PUNCH_SPEED = 155;
export const PUNCH_DAMAGE = 85;
export const DIVE_SLAM_SPEED = 380;
export const DIVE_SLAM_REBOUND_VY = 32;
export const DIVE_SLAM_RADIUS = 125;
export const DIVE_SLAM_DAMAGE = 320;
export const DIVE_SLAM_COOLDOWN = 2.5;
export const MELEE_COOLDOWN = 0.65;

export type MeleeFlightModel = Pick<FlightModel, 'pos' | 'vel' | 'grounded'> & {
  boosting?: boolean;
  hipHeight?: () => number;
};

export type CloseQuartersGround = SurfaceQuery & {
  raycast?: (origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number) => number;
};

export type MeleeActionKind = 'grab' | 'throw' | 'punch' | 'none';

export interface MeleeActionResult {
  action: MeleeActionKind;
  target: Hostile | null;
}

export interface DiveSlamImpact {
  impacted: boolean;
  at: THREE.Vector3;
  hits: number;
  kills: number;
  shake: number;
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
  diveSlamActive = false;
  availableMeleeTarget: Hostile | null = null;
  cooldown = 0;
  grabRemaining = 0;

  readonly diveTarget = new THREE.Vector3();
  private diveHostile: Hostile | null = null;
  private diveStartY = 0;
  private diveElapsed = 0;
  private readonly prevSuitPos = new THREE.Vector3();
  private hasPrevSuitPos = false;

  private readonly thrown: ThrownTarget[] = [];
  private readonly rings: ShockRing[] = [];
  private pendingShake = 0;
  private trailAcc = 0;

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
    this.diveSlamActive = false;
    this.diveHostile = null;
    this.diveElapsed = 0;
    this.availableMeleeTarget = null;
    this.cooldown = 0;
    this.hasPrevSuitPos = false;
    this.thrown.length = 0;
    this.pendingShake = 0;
    this.trailAcc = 0;
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
   * Targeted Dive-Slam ("Meteor Ground-Pound"):
   * locks the airborne suit into a steep supersonic dive toward the aimed
   * hostile or terrain/water surface point.
   */
  startDiveSlam(
    model: MeleeFlightModel,
    aimDir: THREE.Vector3,
    ground: CloseQuartersGround,
    hostiles: readonly Hostile[],
  ): boolean {
    if (model.grounded || this.diveSlamActive || this.cooldown > 0) return false;

    const surfHere = ground.surface(model.pos.x, model.pos.z);
    const hipH = model.hipHeight ? model.hipHeight() : 1.0;
    const clearance = model.pos.y - hipH - surfHere;
    if (clearance < 5 && !hostiles.some((h) => h.alive && h.pos.y < model.pos.y - 3)) return false;

    const dir = this._v.copy(aimDir);
    if (dir.lengthSq() < 1e-6) dir.set(0, -1, 0);
    dir.normalize();

    // 1. Prefer an aimed hostile near the sight line (SAM, ship, boss, drone)
    let aimedHostile: Hostile | null = null;
    let bestDot = Math.cos(THREE.MathUtils.degToRad(14));
    for (const h of hostiles) {
      if (!h.alive) continue;
      const to = this._w.copy(h.pos).sub(model.pos);
      const d = to.length();
      if (d < 4 || d > 2600) continue;
      const dot = to.dot(dir) / d;
      if (dot > bestDot) {
        bestDot = dot;
        aimedHostile = h;
      }
    }

    const target = new THREE.Vector3();
    if (aimedHostile) {
      target.copy(aimedHostile.pos);
    } else {
      // 2. Raycast aim against terrain/water; if looking level/up, project steep downward strike ahead
      const diveRay = dir.clone();
      if (diveRay.y > -0.15) {
        diveRay.y = -0.85;
        diveRay.normalize();
      }
      const hitDist = this.raycastSurface(model.pos, diveRay, 2600, ground);
      if (hitDist > 0) {
        target.copy(model.pos).addScaledVector(diveRay, hitDist);
      } else {
        target.set(model.pos.x + diveRay.x * 120, ground.surface(model.pos.x + diveRay.x * 120, model.pos.z + diveRay.z * 120), model.pos.z + diveRay.z * 120);
      }
    }

    this.diveSlamActive = true;
    this.diveTarget.copy(target);
    this.diveHostile = aimedHostile;
    this.diveStartY = model.pos.y;
    this.diveElapsed = 0;
    this.prevSuitPos.copy(model.pos);
    this.hasPrevSuitPos = true;

    const diveDir = this._w.copy(this.diveTarget).sub(model.pos);
    if (diveDir.lengthSq() < 1e-4) diveDir.set(0, -1, 0);
    else diveDir.normalize();
    model.vel.copy(diveDir).multiplyScalar(DIVE_SLAM_SPEED);
    if ('boosting' in model) model.boosting = true;
    return true;
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

  /** Per-frame update for active grapple tether, thrown kinetic projectiles, dive-slam & rings. */
  update(
    dt: number,
    model: MeleeFlightModel,
    aimDir: THREE.Vector3,
    hostiles: readonly Hostile[],
    ground: SurfaceQuery,
    explosions: Explosions,
    particles: Particles,
    events?: EventBus,
  ): DiveSlamImpact | null {
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

    // 3. Targeted Dive-Slam
    if (!this.diveSlamActive) {
      this.prevSuitPos.copy(model.pos);
      this.hasPrevSuitPos = true;
      return null;
    }

    if (!this.hasPrevSuitPos) {
      this.prevSuitPos.copy(model.pos);
      this.hasPrevSuitPos = true;
    }

    this.diveElapsed += dt;
    if (this.diveHostile && this.diveHostile.alive) {
      this.diveTarget.copy(this.diveHostile.pos);
    }

    const toTarget = this._w.copy(this.diveTarget).sub(model.pos);
    const distToTarget = toTarget.length();
    if (distToTarget > 0.5) {
      toTarget.divideScalar(distToTarget);
      model.vel.copy(toTarget).multiplyScalar(DIVE_SLAM_SPEED);
    }

    // Supersonic meteor dive trail
    this.trailAcc += dt * 40;
    while (this.trailAcc >= 1) {
      this.trailAcc -= 1;
      particles.emit('plasma', model.pos, model.vel.clone().multiplyScalar(0.1), { scale: 1.25, life: 0.3 });
      particles.emit('fire', model.pos, undefined, { scale: 0.9, life: 0.25 });
    }

    const surf = ground.surface(model.pos.x, model.pos.z);
    const hipH = model.hipHeight ? model.hipHeight() : 1.0;
    let impactAt: THREE.Vector3 | null = null;

    if (model.pos.y <= surf + hipH + 1.2) {
      impactAt = new THREE.Vector3(model.pos.x, surf, model.pos.z);
    } else if (distToTarget <= Math.max(8, DIVE_SLAM_SPEED * dt * 1.25)) {
      impactAt = this.diveTarget.clone();
    } else {
      // Check swept contact with aimed or ground/ship/boss hostiles
      for (const h of hostiles) {
        if (!h.alive) continue;
        if (h !== this.diveHostile && h.kind !== 'ship' && h.kind !== 'boss' && h.kind !== 'sam') continue;
        const r = h.radius + 4;
        if (segmentToCore(h, this.prevSuitPos, model.pos, this._seg, this._core) <= r * r) {
          impactAt = this._seg.clone();
          break;
        }
      }
    }

    if (!impactAt && this.diveElapsed >= 6.5) {
      impactAt = model.pos.clone();
    }

    this.prevSuitPos.copy(model.pos);

    if (!impactAt) return null;

    return this.resolveDiveSlamImpact(model, impactAt, surf, hipH, hostiles, ground, explosions, particles, events);
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

  private resolveDiveSlamImpact(
    model: MeleeFlightModel,
    impactAt: THREE.Vector3,
    surf: number,
    hipH: number,
    hostiles: readonly Hostile[],
    ground: SurfaceQuery,
    explosions: Explosions,
    particles: Particles,
    events?: EventBus,
  ): DiveSlamImpact {
    this.diveSlamActive = false;
    this.diveHostile = null;
    this.cooldown = DIVE_SLAM_COOLDOWN;

    // Keep the suit cleanly above surface and execute automatic upward rebound hop (vel.y = 32)
    model.pos.x = impactAt.x;
    model.pos.z = impactAt.z;
    model.pos.y = Math.max(impactAt.y + hipH + 0.5, surf + hipH + 0.5);
    model.vel.set(model.vel.x * 0.25, DIVE_SLAM_REBOUND_VY, model.vel.z * 0.25);
    model.grounded = false;

    const drop = Math.max(0, this.diveStartY - impactAt.y);
    const scale = THREE.MathUtils.clamp(0.85 + drop / 400, 0.85, 1.35);
    const radius = DIVE_SLAM_RADIUS * scale;
    const maxDamage = DIVE_SLAM_DAMAGE * scale;

    let hits = 0;
    let kills = 0;
    for (const h of hostiles) {
      if (!h.alive) continue;
      const d = Math.max(0, coreDistance(h, impactAt) - h.radius);
      if (d >= radius) continue;
      const falloff = 1 - 0.65 * (d / radius);
      const dmg = maxDamage * falloff;
      const killed = h.damage(dmg, impactAt, 'ram');
      hits++;
      if (isGrappleableAircraft(h.kind)) {
        const away = this._v.copy(h.pos).sub(impactAt);
        away.y = Math.max(away.y, 18);
        if (away.lengthSq() < 1e-4) away.set(1, 1, 0);
        away.normalize();
        h.vel.addScaledVector(away, 80 * falloff);
        h.threatened = Math.max(h.threatened, 1.5);
      }
      if (killed) {
        kills++;
        events?.emit('kill', { at: h.pos, text: h.kind });
      }
    }

    const ringAt = new THREE.Vector3(impactAt.x, Math.max(impactAt.y, surf) + 0.4, impactAt.z);
    this.spawnRing(ringAt, 3, radius, 0.55, 0xffaa44, 0.9);
    this.spawnRing(ringAt, 2, radius * 0.72, 0.4, 0x7ad8ff, 0.75);
    explosions.blast(impactAt, 10, { debris: 14, burn: !ground.isWater(impactAt.x, impactAt.z) });
    particles.burst('spark', ringAt, 34, 28, UP, 1.2, { scale: 1.3 });
    particles.burst('plasma', ringAt, 16, 22, UP, 1.0, { scale: 1.1 });
    if (ground.isWater(impactAt.x, impactAt.z) && impactAt.y <= surf + 4) {
      ground.foam?.(impactAt.x, impactAt.z, impactAt.x, impactAt.z, Math.min(24, radius * 0.22), 1.5);
    }

    const shake = 2.1 + (kills > 0 ? 0.6 : 0);
    this.pendingShake += shake;
    events?.emit('heroSlam', { at: ringAt, value: Math.max(1, kills) });
    return { impacted: true, at: impactAt, hits, kills, shake };
  }

  private raycastSurface(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, ground: CloseQuartersGround): number {
    if (ground.raycast) {
      const d = ground.raycast(origin, dir, maxDist);
      if (d > 0) return d;
    }
    const steps = 48;
    const ds = maxDist / steps;
    let prevD = 0;
    let prevClear = origin.y - ground.surface(origin.x, origin.z);
    for (let i = 1; i <= steps; i++) {
      const d = i * ds;
      const x = origin.x + dir.x * d;
      const y = origin.y + dir.y * d;
      const z = origin.z + dir.z * d;
      const clear = y - ground.surface(x, z);
      if (clear <= 0) {
        const frac = prevClear > 0 ? prevClear / Math.max(1e-4, prevClear - clear) : 0;
        return prevD + (d - prevD) * frac;
      }
      prevD = d;
      prevClear = clear;
    }
    return -1;
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
