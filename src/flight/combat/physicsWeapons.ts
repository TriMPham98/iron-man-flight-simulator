import * as THREE from 'three';
import type { Particles } from '../fx/particles';
import type { EventBus } from '../sim/events';
import type { FlightModel } from '../sim/flightModel';
import type { Drone, DroneType } from './drones';
import type { Explosions, SurfaceQuery } from './explosions';
import { coreDistance, segmentToCore } from './hitShape';
import type { Missiles } from './missiles';
import type { PlayerWeapons } from './playerWeapons';
import type { Hostile, HostileKind, PlayerTarget } from './types';

/**
 * Pillar 1 — Physics as Weapons:
 *  1. High-altitude enemy icing: luring enemy aircraft above their icing
 *     ceiling builds ice, saps thrust, freezes/stalls them into a tumble,
 *     increases vulnerability, and shatters them on terrain/water impact.
 *  2. Hero-landing shockwaves: kinetic ground-slam scaled by impact speed
 *     that damages/destroys nearby SAMs and low/ground hostiles, throws out
 *     an expanding shockwave ring + dust/sparks + shake, and pays an R&D
 *     bonus on kills.
 *  3. Water-cooling & splash-dive evasion: skimming/wet armor cools the
 *     unibeam 3× faster with steam wisps; plunging underwater breaks enemy
 *     heat-seeker locks (causing them to veer off and splash harmlessly) and
 *     rapidly clears unibeam overheat.
 *  4. Mach 1 shockwave & kinetic ramming: high-speed (>120 m/s) direct
 *     ramming of light aircraft delivers massive 'ram' takedown damage with
 *     zero suit damage while boosting (minimal otherwise); crossing Mach 1
 *     emits a physical shockwave cone (~160 m) that knocks light aircraft
 *     off course and prematurely detonates nearby incoming enemy missiles.
 */

// ── 1. Enemy Icing Ceiling ───────────────────────────────────────────────────

/** Altitude (m) above which each hostile aircraft type begins icing over. */
export const ENEMY_ICING_ALT: Record<DroneType, number> = {
  drone: 8200,
  bomber: 8200,
  jammer: 8200,
  interceptor: 8800,
};

/** Damage multiplier taken by a frozen aircraft (and max partial icing bonus). */
export const ICING_FROZEN_VULN = 1.8;
export const ICING_PARTIAL_VULN = 0.5;
export const ICING_JARVIS_LINE = 'Icing problem solved on our end, sir — not so much on theirs.';

const FROST_COLOR = new THREE.Color(0.84, 0.94, 1.0);
const STEAM_COLOR = new THREE.Color(0.92, 0.96, 1.0);

/** Altitude threshold (m) where an enemy aircraft of `type` begins icing. */
export function enemyIcingAlt(type: DroneType): number {
  return ENEMY_ICING_ALT[type];
}

// ── 2. Hero-Landing Shockwaves ───────────────────────────────────────────────

export const SLAM_SPEED_MIN = 7;
export const SLAM_SPEED_MAX = 45;
export const SLAM_RADIUS_MIN = 35;
export const SLAM_RADIUS_MAX = 140;
export const SLAM_DAMAGE_MIN = 60;
export const SLAM_DAMAGE_MAX = 350;

export interface HeroSlamStats {
  radius: number;
  maxDamage: number;
  intensity: number;
}

/** Scale ground-slam radius (35–140 m) and peak damage (60–350) from impact speed. */
export function heroSlamStats(impactSpeed: number): HeroSlamStats {
  const intensity = THREE.MathUtils.clamp((impactSpeed - SLAM_SPEED_MIN) / (SLAM_SPEED_MAX - SLAM_SPEED_MIN), 0, 1);
  return {
    radius: THREE.MathUtils.lerp(SLAM_RADIUS_MIN, SLAM_RADIUS_MAX, intensity),
    maxDamage: THREE.MathUtils.lerp(SLAM_DAMAGE_MIN, SLAM_DAMAGE_MAX, intensity),
    intensity,
  };
}

export interface HeroSlamResult extends HeroSlamStats {
  hits: number;
  kills: number;
  shake: number;
}

// ── 3. Water-Cooling & Splash-Dive Evasion ───────────────────────────────────

/** Base unibeam cool-down duration (s) and overheat reset level (mirrors playerWeapons.ts). */
export const UNIBEAM_BASE_COOL = 7;
export const UNIBEAM_OVERHEAT_RESET = 0.35;
/** Extra cooling multiplier on top of the base 1× cool rate (1 + 2 = 3× total). */
export const WATER_COOL_BONUS = 2;
/** Low-altitude water-skimming height (m) and speed (m/s) thresholds. */
export const WATER_SKIM_ALT = 15;
export const WATER_SKIM_SPEED = 20;
/** Immersion share at which the suit breaks missile locks and dumps overheat. */
export const SPLASH_DIVE_IMMERSION = 0.55;
/** Fast underwater heat dump rate (heat/s). */
export const UNDERWATER_HEAT_DUMP = 2.5;
export const SPLASH_EVADE_JARVIS_LINE = 'Thermal signature masked by the sea, sir. Seekers lost lock.';

/** True when the suit is wet, immersed, or skimming low and fast over water. */
export function isWaterCooling(
  model: Pick<FlightModel, 'pos' | 'wetness' | 'immersion' | 'speed' | 'hipHeight'>,
  ground: SurfaceQuery,
): boolean {
  if (model.immersion > 0 || model.wetness > 0.05) return true;
  if (!ground.isWater(model.pos.x, model.pos.z)) return false;
  const clearance = model.pos.y - model.hipHeight() - ground.surface(model.pos.x, model.pos.z);
  return clearance < WATER_SKIM_ALT && model.speed >= WATER_SKIM_SPEED;
}

// ── 4. Mach 1 Shockwave & Kinetic Ramming ────────────────────────────────────

export const RAM_MIN_SPEED = 120;
export const RAM_HIT_PAD = 2.2;
export const RAM_BASE_DAMAGE = 160;
export const RAM_SPEED_SCALE = 1.2;
/** Glancing armor damage taken when ramming fast without boost active (0 if boosting). */
export const RAM_UNBOOSTED_SUIT_DAMAGE = 6;
export const SONIC_SHOCK_RADIUS = 160;
export const SONIC_DRONE_IMPULSE = 85;
export const SONIC_DESTABILIZE_TIME = 2.4;

/** Light aircraft eligible for kinetic ram takedowns and Mach 1 shockwave knockback. */
export function isLightAircraft(kind: HostileKind | DroneType): boolean {
  return kind === 'drone' || kind === 'interceptor' || kind === 'jammer';
}

export interface SonicShockResult {
  dronesKnocked: number;
  missilesDetonated: number;
}

// ── Visual Expanding Shockwave Rings ─────────────────────────────────────────

interface ShockRing {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  t: number;
  dur: number;
  r0: number;
  r1: number;
  peakOpacity: number;
}

let groundRingGeo: THREE.BufferGeometry | null = null;
let airRingGeo: THREE.BufferGeometry | null = null;

function getGroundRingGeo(): THREE.BufferGeometry {
  if (!groundRingGeo) groundRingGeo = new THREE.RingGeometry(0.76, 1.0, 48).rotateX(-Math.PI / 2);
  return groundRingGeo;
}

function getAirRingGeo(): THREE.BufferGeometry {
  if (!airRingGeo) airRingGeo = new THREE.RingGeometry(0.82, 1.0, 48);
  return airRingGeo;
}

const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, 1);

/**
 * Coordinates the four physics-weapon combat mechanics and their transient
 * shockwave visuals. Instantiated and ticked by {@link Combat}.
 */
export class PhysicsWeapons {
  readonly group = new THREE.Group();
  private readonly rings: ShockRing[] = [];
  private readonly prevSuitPos = new THREE.Vector3();
  private hasPrevPos = false;
  private readonly ramCooldown = new WeakMap<Drone, number>();
  private readonly frostAcc = new WeakMap<Drone, number>();
  private steamAcc = 0;
  private iceCalloutDone = false;
  private splashCalloutDone = false;
  private pendingShake = 0;

  private readonly _v = new THREE.Vector3();
  private readonly _w = new THREE.Vector3();
  private readonly _seg = new THREE.Vector3();
  private readonly _core = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();

  constructor() {
    this.group.name = 'physics-weapons';
  }

  /** Reset per-run callout flags, tracking state, and active shock rings. */
  reset(): void {
    this.hasPrevPos = false;
    this.steamAcc = 0;
    this.iceCalloutDone = false;
    this.splashCalloutDone = false;
    this.pendingShake = 0;
    for (const r of this.rings) {
      this.group.remove(r.mesh);
      r.mat.dispose();
    }
    this.rings.length = 0;
  }

  /** Read and clear accumulated camera shake (e.g. from kinetic ram impacts). */
  consumeShake(): number {
    const s = this.pendingShake;
    this.pendingShake = 0;
    return s;
  }

  /** Per-frame update: enemy icing, water-cooling/splash-dive, kinetic ramming, and shockwave rings. */
  update(
    dt: number,
    model: FlightModel,
    weapons: PlayerWeapons,
    drones: readonly Drone[],
    missiles: Missiles,
    player: PlayerTarget,
    ground: SurfaceQuery,
    particles: Particles,
    explosions: Explosions,
    events: EventBus,
  ): void {
    this.updateEnemyIcing(dt, drones, ground, particles, explosions, events);
    this.updateWaterAndSplash(dt, model, weapons, missiles, ground, particles, events);
    this.updateKineticRam(dt, model, drones, player, particles, explosions, events);
    this.updateRings(dt);
  }

  // ── 1. High-Altitude Enemy Icing ───────────────────────────────────────────

  updateEnemyIcing(
    dt: number,
    drones: readonly Drone[],
    ground: SurfaceQuery,
    particles: Particles,
    explosions: Explosions,
    events: EventBus,
  ): void {
    for (const d of drones) {
      if (!d.alive) continue;
      const alt = d.pos.y;
      const threshold = enemyIcingAlt(d.type);

      if (alt > threshold) {
        const excess = (alt - threshold) / 800;
        const buildRate = 0.2 + Math.min(0.45, excess * 0.25);
        d.icing = Math.min(1, d.icing + buildRate * dt);
      } else if (!d.frozen && alt < threshold - 150) {
        // Partial ice thaws once out of the icing layer; a full freeze-out is a fatal flameout tumble
        const warmth = Math.min(1, (threshold - 150 - alt) / 3000);
        const thawRate = 0.08 + 0.16 * warmth;
        d.icing = Math.max(0, d.icing - thawRate * dt);
      }

      if (!d.frozen && d.icing >= 1) {
        d.frozen = true;
        particles.burst('vapor', d.pos, 14, 10, undefined, 1, { scale: 1.4, color: FROST_COLOR });
        particles.burst('mist', d.pos, 6, 6, undefined, 1, { scale: 1.1, color: FROST_COLOR });
        events.emit('enemyIced', { at: d.pos, text: d.type });
        if (!this.iceCalloutDone) {
          this.iceCalloutDone = true;
          events.emit('jarvis', { text: ICING_JARVIS_LINE });
        }
      }

      // Emit frost/vapor plume as ice builds and while tumbling frozen
      if (d.icing > 0.15) {
        const rate = d.frozen ? 26 : 12 * d.icing;
        let acc = (this.frostAcc.get(d) ?? 0) + dt * rate;
        while (acc >= 1) {
          acc -= 1;
          this._v.copy(d.vel).multiplyScalar(0.35);
          particles.emit('vapor', d.pos, this._v, { scale: d.frozen ? 1.5 : 0.8 + 0.5 * d.icing, color: FROST_COLOR });
          if (d.frozen && Math.random() < 0.35) {
            particles.emit('mist', d.pos, this._v.set(0, -1, 0), { scale: 1.1, color: FROST_COLOR });
          }
        }
        this.frostAcc.set(d, acc);
      }

      // Terrain / water crash check while frozen or heavily iced
      if (d.frozen || d.icing >= 0.7) {
        const surf = ground.surface(d.pos.x, d.pos.z);
        if (d.pos.y <= surf + 2.5) {
          const crashDmg = d.frozen ? d.maxHp * 2 : d.maxHp * d.icing;
          const killed = d.damage(crashDmg, d.pos, 'ram');
          if (killed) {
            d.crashed = true;
            d.frozen = false;
            particles.burst('vapor', d.pos, 18, 14, UP, 1, { scale: 1.6, color: FROST_COLOR });
            particles.burst('spark', d.pos, 16, 14, UP, 1);
            explosions.blast(d.pos, 5.5, { debris: 8, burn: !ground.isWater(d.pos.x, d.pos.z) });
            events.emit('kill', { at: d.pos, text: d.kind });
            events.emit('iceKill', { at: d.pos, text: d.type });
          }
        }
      }
    }
  }

  // ── 2. Hero-Landing Shockwaves ─────────────────────────────────────────────

  onHeroLanding(
    at: THREE.Vector3,
    impactSpeed: number,
    hostiles: readonly Hostile[],
    ground: SurfaceQuery,
    particles: Particles,
    events: EventBus,
  ): HeroSlamResult {
    const stats = heroSlamStats(impactSpeed);
    const { radius, maxDamage, intensity } = stats;
    let hits = 0;
    let kills = 0;

    for (const h of hostiles) {
      if (!h.alive) continue;
      const d = Math.max(0, coreDistance(h, at) - h.radius);
      if (d >= radius) continue;
      const falloff = 1 - 0.75 * (d / radius);
      const dmg = maxDamage * falloff;
      const killed = h.damage(dmg, at, 'ram');
      hits++;
      // Blast low-flying hostiles outward and upward from the ground slam
      if (isLightAircraft(h.kind) || h.kind === 'bomber') {
        const away = this._v.copy(h.pos).sub(at);
        away.y = Math.max(away.y, 12);
        if (away.lengthSq() < 1e-4) away.set(1, 1, 0);
        away.normalize();
        h.vel.addScaledVector(away, (45 + 60 * intensity) * falloff);
        h.threatened = Math.max(h.threatened, 1.5);
      }
      if (killed) {
        kills++;
        events.emit('kill', { at: h.pos, text: h.kind });
      }
    }

    // Expanding ground-slam dust & energy shockwave ring + sparks
    const ringPos = this._w.set(at.x, ground.surface(at.x, at.z) + 0.35, at.z);
    this.spawnGroundRing(ringPos, 2.5, radius, 0.45 + 0.35 * intensity, 0xffb85c, 0.85);
    this.spawnGroundRing(ringPos, 1.5, radius * 0.72, 0.32 + 0.25 * intensity, 0x7ad8ff, 0.7);

    const ringCount = Math.round(24 + 28 * intensity);
    const ringSpeed = 22 + 48 * intensity;
    for (let i = 0; i < ringCount; i++) {
      const a = (i / ringCount) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      particles.emit('dust', ringPos, this._v.set(c * ringSpeed, 1.2 + 2.5 * intensity, s * ringSpeed), {
        scale: 0.9 + 1.1 * intensity,
        life: 0.7 + 0.5 * intensity,
      });
      if (i % 2 === 0) {
        particles.emit('plasma', ringPos, this._v.set(c * ringSpeed * 1.15, 0.8, s * ringSpeed * 1.15), {
          scale: 0.65 + 0.6 * intensity,
          life: 0.35 + 0.25 * intensity,
        });
      }
    }
    particles.burst('spark', ringPos, Math.round(20 + 30 * intensity), 14 + 20 * intensity, UP, 1.1, { scale: 1 + 0.4 * intensity });
    particles.emit('flash', ringPos, undefined, { scale: 1.2 + 1.8 * intensity });
    if (ground.isWater(at.x, at.z)) {
      ground.foam?.(at.x, at.z, at.x, at.z, Math.min(20, radius * 0.25), 1.4);
    }

    const shake = 0.6 + 1.6 * intensity + (kills > 0 ? 0.5 : 0);
    if (kills > 0) {
      events.emit('heroSlam', { at: ringPos, value: kills });
    }
    return { ...stats, hits, kills, shake };
  }

  // ── 3. Water-Cooling & Splash-Dive Evasion ─────────────────────────────────

  updateWaterAndSplash(
    dt: number,
    model: Pick<FlightModel, 'pos' | 'vel' | 'wetness' | 'immersion' | 'speed' | 'hipHeight'>,
    weapons: Pick<PlayerWeapons, 'unibeamHeat' | 'unibeamOverheat' | 'unibeamOn' | 'spec'>,
    missiles: Missiles,
    ground: SurfaceQuery,
    particles: Particles,
    events: EventBus,
  ): { cooling: boolean; evaded: number } {
    const cooling = isWaterCooling(model, ground);
    let evaded = 0;

    if (cooling && !weapons.unibeamOn && weapons.unibeamHeat > 0) {
      const bonusCool = (WATER_COOL_BONUS * dt) / (UNIBEAM_BASE_COOL * weapons.spec.unibeamCool);
      weapons.unibeamHeat = Math.max(0, weapons.unibeamHeat - bonusCool);
      if (weapons.unibeamOverheat && weapons.unibeamHeat <= UNIBEAM_OVERHEAT_RESET) {
        weapons.unibeamOverheat = false;
      }
    }

    // Steam wisps rising off a hot suit skimming or wet from the sea
    if (cooling && (weapons.unibeamHeat > 0.02 || weapons.unibeamOverheat)) {
      this.steamAcc += dt * (12 + 24 * weapons.unibeamHeat);
      while (this.steamAcc >= 1) {
        this.steamAcc -= 1;
        this._v.copy(model.vel).multiplyScalar(0.35);
        this._v.y += 2.5 + Math.random() * 2;
        particles.emit('vapor', model.pos, this._v, { scale: 0.9 + 0.8 * weapons.unibeamHeat, color: STEAM_COLOR });
      }
    } else {
      this.steamAcc = 0;
    }

    // Splash-dive underwater: immediately break enemy seekers & rapidly clear overheat
    if (model.immersion > SPLASH_DIVE_IMMERSION) {
      if (weapons.unibeamHeat > 0 || weapons.unibeamOverheat) {
        weapons.unibeamHeat = Math.max(0, weapons.unibeamHeat - UNDERWATER_HEAT_DUMP * dt);
        if (weapons.unibeamOverheat && weapons.unibeamHeat <= 0.85) {
          weapons.unibeamOverheat = false;
        }
        const surfY = ground.surface(model.pos.x, model.pos.z);
        this._w.set(model.pos.x, surfY + 0.3, model.pos.z);
        if (Math.random() < Math.min(1, dt * 18)) {
          particles.emit('mist', this._w, this._v.set(0, 4, 0), { scale: 1.4, color: STEAM_COLOR });
        }
      }

      const threats = missiles.threats();
      for (const m of threats) {
        if (m.decoyed) continue;
        m.target = null;
        m.decoyed = true;
        // Veer off laterally away from the suit and splash harmlessly into the sea
        const fwd = this._v.copy(m.vel);
        fwd.y = 0;
        if (fwd.lengthSq() < 1e-4) fwd.set(1, 0, 0);
        fwd.normalize();
        const side = (evaded % 2 === 0 ? 1 : -1);
        const lateral = this._w.set(-fwd.z * side, 0, fwd.x * side);
        const splashX = m.pos.x + fwd.x * 160 + lateral.x * 150;
        const splashZ = m.pos.z + fwd.z * 160 + lateral.z * 150;
        const splashY = ground.surface(splashX, splashZ) - 2;
        m.aimPoint = new THREE.Vector3(splashX, splashY, splashZ);
        // Immediate lateral kick so even a close seeker misses the suit cleanly
        const sp = Math.max(m.vel.length(), 80);
        m.vel.addScaledVector(lateral, sp * 0.45).normalize().multiplyScalar(sp);
        m.life = Math.min(m.life, 3.0);
        evaded++;
        events.emit('missileDecoyed', { at: m.pos });
      }

      if (evaded > 0 && !this.splashCalloutDone) {
        this.splashCalloutDone = true;
        events.emit('jarvis', { text: SPLASH_EVADE_JARVIS_LINE });
      }
    }

    return { cooling, evaded };
  }

  // ── 4A. High-Speed Kinetic Ramming ─────────────────────────────────────────

  updateKineticRam(
    dt: number,
    model: Pick<FlightModel, 'pos' | 'vel' | 'speed' | 'boosting'>,
    drones: readonly Drone[],
    player: PlayerTarget,
    particles: Particles,
    explosions: Explosions,
    events: EventBus,
  ): number {
    if (!this.hasPrevPos || this.prevSuitPos.distanceToSquared(model.pos) > 400 * 400) {
      this.prevSuitPos.copy(model.pos);
      this.hasPrevPos = true;
    }

    let rams = 0;
    if (player.alive && model.speed >= RAM_MIN_SPEED) {
      for (const d of drones) {
        if (!d.alive || !isLightAircraft(d.type)) continue;
        const cd = this.ramCooldown.get(d) ?? 0;
        if (cd > 0) {
          this.ramCooldown.set(d, Math.max(0, cd - dt));
          continue;
        }
        const hitR = d.radius + RAM_HIT_PAD;
        const distSq = segmentToCore(d, this.prevSuitPos, model.pos, this._seg, this._core);
        if (distSq > hitR * hitR) continue;

        this.ramCooldown.set(d, 0.5);
        rams++;
        const hitAt = this._seg.clone().lerp(this._core, 0.5);
        const ramDamage = RAM_BASE_DAMAGE + (model.speed - RAM_MIN_SPEED) * RAM_SPEED_SCALE;
        const killed = d.damage(ramDamage, hitAt, 'ram');

        // Transfer violent forward kinetic momentum to the struck airframe
        const dir = this._v.copy(model.vel).normalize();
        d.vel.addScaledVector(dir, model.speed * 0.75);
        model.vel.multiplyScalar(0.95);

        // Boosting protects the suit completely; fast unboosted ram takes minimal glancing damage
        if (!model.boosting) {
          player.hit(RAM_UNBOOSTED_SUIT_DAMAGE, hitAt, 'bullet');
        }
        this.pendingShake += model.boosting ? 1.5 : 1.2;

        particles.burst('spark', hitAt, 34, 28, dir, 1.1, { scale: 1.3 });
        particles.burst('plasma', hitAt, 10, 14, undefined, 1, { scale: 1.1 });
        particles.emit('flash', hitAt, model.vel.clone().multiplyScalar(0.2), { scale: 1.4 });
        explosions.blast(hitAt, 4.2, { debris: 7, vel: model.vel.clone().multiplyScalar(0.3) });

        if (killed) {
          events.emit('kill', { at: hitAt, text: d.kind });
          events.emit('kineticRam', { at: hitAt, value: model.speed, text: d.type });
        }
      }
    }

    this.prevSuitPos.copy(model.pos);
    return rams;
  }

  // ── 4B. Mach 1 Physical Shockwave Cone ─────────────────────────────────────

  onSonicBoom(
    at: THREE.Vector3,
    vel: THREE.Vector3,
    drones: readonly Drone[],
    missiles: Missiles,
    particles: Particles,
  ): SonicShockResult {
    const fwd = this._v.copy(vel);
    if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, 1);
    fwd.normalize();

    let dronesKnocked = 0;
    let missilesDetonated = 0;

    // Knock nearby light aircraft off course and briefly destabilize them
    for (const d of drones) {
      if (!d.alive || !isLightAircraft(d.type)) continue;
      const off = this._w.copy(d.pos).sub(at);
      const dist = off.length();
      if (dist > SONIC_SHOCK_RADIUS) continue;
      const falloff = 1 - 0.6 * (dist / SONIC_SHOCK_RADIUS);
      // Push radially outward from the Mach cone axis
      const along = off.dot(fwd);
      off.addScaledVector(fwd, -along * 0.6);
      if (off.lengthSq() < 1e-4) off.set(-fwd.z, 0.3, fwd.x);
      off.normalize();
      d.vel.addScaledVector(off, SONIC_DRONE_IMPULSE * falloff);
      d.destabilized = Math.max(d.destabilized, SONIC_DESTABILIZE_TIME * falloff);
      d.threatened = Math.max(d.threatened, 1.5);
      particles.burst('vapor', d.pos, 8, 12, off, 0.8, { scale: 1.2 });
      particles.burst('spark', d.pos, 8, 10, off, 0.9);
      dronesKnocked++;
    }

    // Prematurely detonate nearby incoming enemy missiles
    const toDetonate = missiles.live.filter(
      (m) => m.team === 'enemy' && m.pos.distanceTo(at) <= SONIC_SHOCK_RADIUS,
    );
    for (const m of toDetonate) {
      missiles.shootDown(m);
      missilesDetonated++;
    }

    // Expanding supersonic shockwave ring aligned perpendicular to flight direction
    this.spawnAirRing(at, fwd, 2, SONIC_SHOCK_RADIUS * 0.55, 0.42, 0xd8eeff, 0.65);
    const u = this._w.copy(UP).cross(fwd);
    if (u.lengthSq() < 1e-4) u.set(1, 0, 0);
    u.normalize();
    const w = new THREE.Vector3().crossVectors(fwd, u);
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2;
      const radial = this._seg.copy(u).multiplyScalar(Math.cos(a)).addScaledVector(w, Math.sin(a));
      particles.emit('vapor', at, radial.multiplyScalar(42).addScaledVector(vel, 0.35), { scale: 1.8, life: 0.6 });
    }

    return { dronesKnocked, missilesDetonated };
  }

  // ── Shockwave Ring Visual Pool ─────────────────────────────────────────────

  private spawnGroundRing(at: THREE.Vector3, r0: number, r1: number, dur: number, color: number, peakOpacity: number): void {
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: peakOpacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(getGroundRingGeo(), mat);
    mesh.position.copy(at);
    mesh.scale.setScalar(r0);
    mesh.renderOrder = 6;
    this.group.add(mesh);
    this.rings.push({ mesh, mat, t: 0, dur, r0, r1, peakOpacity });
  }

  private spawnAirRing(at: THREE.Vector3, dir: THREE.Vector3, r0: number, r1: number, dur: number, color: number, peakOpacity: number): void {
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: peakOpacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(getAirRingGeo(), mat);
    mesh.position.copy(at);
    this._q.setFromUnitVectors(FWD, dir);
    mesh.quaternion.copy(this._q);
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
