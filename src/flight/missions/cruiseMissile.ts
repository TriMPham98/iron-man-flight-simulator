import * as THREE from 'three';
import { coreDistance } from '../combat/hitShape';
import { box, glowMaterial, loft, merge, paint, type V3 } from '../combat/modelKit';
import type { DamageKind, Hostile } from '../combat/types';
import { hazeAll } from '../render/haze';
import {
  unregisterHostile,
  type MissionContext,
  type MissionControls,
  type MissionDefinition,
  type MissionInstance,
  type MissionTelemetry,
  type WaypointMarker,
} from './types';

/**
 * Cruise Missile Intercept & Redirect:
 * Large hypersonic cruise missiles launch from ~7.4–8.2 km offshore heading
 * straight for the Malibu house at Mach 1.03–1.22 (355–420 m/s).
 *
 * Two ways to neutralize each missile:
 *  1. Shoot it down (high HP, takes sustained fire / locks at speed).
 *  2. Heroic Redirect: fly within {@link CRUISE_GRAPPLE_RADIUS} (18 m) at
 *     matched speed and hold climb (E) / pitch skyward for
 *     {@link CRUISE_GRAPPLE_DURATION} (1.5 s) until its nose pitches above
 *     35° — sending it harmlessly into the upper atmosphere for a huge bonus!
 */

export const CRUISE_DEF: MissionDefinition = {
  id: 'cruise',
  code: 'OP-02',
  title: 'CRUISE MISSILE INTERCEPT',
  subtitle: 'HYPERSONIC DEFENCE',
  summary:
    'Two hypersonic cruise missiles launch from offshore toward the Malibu cliffside. Destroy them with weapons OR fly within 18 m, match speed, and pitch them skyward (>35°) for a Heroic Redirect bonus.',
  rewardLabel: 'UP TO 620 R&D',
  difficulty: 'HIGH',
};

export const CRUISE_TOTAL_WAVES = 2;
export const CRUISE_SPAWN_DIST_WAVE1 = 7400;
export const CRUISE_SPAWN_DIST_WAVE2 = 8200;
export const CRUISE_WAVE1_SPEED = 355;
export const CRUISE_WAVE2_SPEED = 415;
export const CRUISE_HP = 720;
export const CRUISE_GRAPPLE_RADIUS = 18;
export const CRUISE_GRAPPLE_BREAK_RADIUS = 28;
export const CRUISE_GRAPPLE_MAX_REL_SPEED = 135;
export const CRUISE_GRAPPLE_DURATION = 1.5;
export const CRUISE_REDIRECT_PITCH_DEG = 35;
export const CRUISE_REDIRECT_PITCH_RAD = THREE.MathUtils.degToRad(CRUISE_REDIRECT_PITCH_DEG);
export const CRUISE_SAFE_DETONATE_ALT = 3600;
export const CRUISE_IMPACT_RADIUS = 45;
export const CRUISE_SHOOTDOWN_REWARD = 120;
export const CRUISE_REDIRECT_REWARD = 260;
export const CRUISE_CLEAR_BONUS = 100;

let nextMissileHostileId = 9100;

const cmMats = {
  body: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.55, roughness: 0.35 }),
  glow: glowMaterial(),
};

let cmGeoCache: { body: THREE.BufferGeometry; glow: THREE.BufferGeometry } | null = null;

function cruiseMissileGeometry() {
  if (cmGeoCache) return cmGeoCache;
  const sec = (z: number, rx: number, ry: number): V3[] => [
    [0, ry, z],
    [rx * 0.72, ry * 0.68, z],
    [rx, 0, z],
    [rx * 0.72, -ry * 0.68, z],
    [0, -ry, z],
    [-rx * 0.72, -ry * 0.68, z],
    [-rx, 0, z],
    [-rx * 0.72, ry * 0.68, z],
  ];
  const bodyParts: THREE.BufferGeometry[] = [
    loft(
      [
        sec(7.2, 0.04, 0.04),
        sec(5.6, 0.45, 0.42),
        sec(3.4, 0.76, 0.68),
        sec(-3.8, 0.8, 0.72),
        sec(-6.4, 0.62, 0.58),
        sec(-7.0, 0.48, 0.48),
      ],
      (_e, s) => (s === 0 ? 0x9b1814 : s === 1 ? 0xd2d6dc : s >= 4 ? 0x1e2024 : 0x3b4048),
    ),
    // Ventral ramjet intake scoop
    box(0.85, 0.5, 4.2, 0x1c1f24, 0, -0.78, -0.8),
    // Dorsal stabilizer fin
    box(0.12, 1.85, 2.4, 0x2c3036, 0, 1.25, -4.8),
    // Swept mid-body stub wings
    box(5.8, 0.14, 1.9, 0x454b54, 0, 0.05, -0.6),
    // Tail control fins
    box(3.0, 0.1, 1.3, 0x8f1a14, 0, 0, -5.6),
  ];

  const glowParts: THREE.BufferGeometry[] = [
    // Hot warhead collar stripe
    paint(new THREE.CylinderGeometry(0.79, 0.79, 0.35, 12).rotateX(Math.PI / 2).translate(0, 0, 3.6), new THREE.Color(1, 0.18, 0.08), 4.5),
    // Hypersonic booster plume core + cone
    paint(new THREE.ConeGeometry(0.62, 3.8, 12).rotateX(-Math.PI / 2).translate(0, 0, -8.9), new THREE.Color(1, 0.65, 0.22), 7),
    paint(new THREE.ConeGeometry(0.32, 2.4, 10).rotateX(-Math.PI / 2).translate(0, 0, -8.1), new THREE.Color(1, 0.96, 0.85), 10),
  ];

  cmGeoCache = { body: merge(bodyParts), glow: merge(glowParts) };
  return cmGeoCache;
}

export class CruiseMissileEntity implements Hostile {
  readonly id = nextMissileHostileId++;
  readonly kind = 'interceptor' as const;
  readonly label = 'CRUISE MSL';
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly radius = 5.5;
  readonly span: readonly [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(), new THREE.Vector3()];
  readonly maxHp = CRUISE_HP;
  hp = CRUISE_HP;
  alive = true;
  threatened = 0;

  readonly mesh = new THREE.Group();
  readonly targetSpeed: number;
  speed: number;
  /** Pitch angle above horizontal (rad). */
  pitch = 0;
  /** Yaw heading (rad, atan2(x, z)). */
  heading = 0;
  /** True once player has heroically redirected it into the upper atmosphere. */
  redirected = false;
  redirectT = 0;
  detonatedSafely = false;
  struckHouse = false;

  private trailT = 0;
  private readonly _dir = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();
  private readonly _fwd = new THREE.Vector3(0, 0, 1);

  constructor(spawnAt: THREE.Vector3, targetPos: THREE.Vector3, targetSpeed: number) {
    this.targetSpeed = targetSpeed;
    // Start slightly slower during initial booster ramp so the player has fair reaction time
    this.speed = Math.max(200, targetSpeed * 0.68);
    this.pos.copy(spawnAt);
    const to = targetPos.clone().sub(spawnAt);
    this.heading = Math.atan2(to.x, to.z);
    this.pitch = Math.atan2(to.y, Math.max(1, Math.hypot(to.x, to.z)));

    const g = cruiseMissileGeometry();
    this.mesh.add(new THREE.Mesh(g.body, cmMats.body), new THREE.Mesh(g.glow, cmMats.glow));
    this.syncVelocityAndPose();
  }

  damage(amount: number, _at: THREE.Vector3, _kind: DamageKind): boolean {
    if (!this.alive || this.redirected) return false;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      return true;
    }
    return false;
  }

  /** Step flight toward `targetPos` (or skyward once redirected). */
  step(dt: number, targetPos: THREE.Vector3, grappled: boolean, pitchUpInput: number, ctx: MissionContext): void {
    this.threatened = Math.max(0, this.threatened - dt);

    if (this.redirected) {
      this.redirectT += dt;
      // Climb hard into the upper atmosphere
      this.pitch = Math.min(Math.PI * 0.44, this.pitch + dt * 0.45);
      this.speed = Math.min(this.targetSpeed * 1.25, this.speed + 90 * dt);
    } else if (grappled) {
      // Suit is physically wrestling the fuselage skyward!
      const rate = pitchUpInput > 0 ? 0.52 : 0.24;
      this.pitch = Math.min(Math.PI * 0.4, this.pitch + rate * dt);
      this.speed = Math.max(240, this.speed - 18 * dt);
    } else {
      // Accelerate smoothly to hypersonic cruise
      this.speed = Math.min(this.targetSpeed, this.speed + 55 * dt);
      const to = targetPos.clone().sub(this.pos);
      const horiz = Math.max(1, Math.hypot(to.x, to.z));
      const wantHeading = Math.atan2(to.x, to.z);
      const dh = Math.atan2(Math.sin(wantHeading - this.heading), Math.cos(wantHeading - this.heading));
      this.heading += THREE.MathUtils.clamp(dh, -0.35 * dt, 0.35 * dt);

      // Hold ~280 m cruise altitude far out, then terminal dive toward the Malibu cliffside
      const cruiseAlt = horiz > 1800 ? 280 : THREE.MathUtils.lerp(targetPos.y + 6, 280, (horiz - 200) / 1600);
      const wantPitch = THREE.MathUtils.clamp(Math.atan2(cruiseAlt - this.pos.y, Math.min(horiz, 900)), -0.35, 0.22);
      this.pitch += THREE.MathUtils.clamp(wantPitch - this.pitch, -0.4 * dt, 0.4 * dt);
    }

    this.syncVelocityAndPose();
    this.pos.addScaledVector(this.vel, dt);
    this.syncVelocityAndPose();

    // Dense hypersonic contrail + booster embers
    this.trailT += dt;
    if (this.trailT >= 0.025) {
      this.trailT = 0;
      const tail = this.pos.clone().addScaledVector(this._dir, -7.5);
      ctx.particles.emit('trail', tail, undefined, { scale: 2.2, life: 3.0 });
      ctx.particles.emit('ember', tail, this._dir.clone().multiplyScalar(-30), { scale: 1.8 });
      if (this.redirected) {
        ctx.particles.emit('fire', tail, this._dir.clone().multiplyScalar(-18), { scale: 1.4 });
      }
    }

    if (this.redirected) {
      if (this.pos.y >= CRUISE_SAFE_DETONATE_ALT || this.redirectT >= 4.2) {
        this.detonatedSafely = true;
        ctx.combat.explosions.blast(this.pos, 26, { debris: 20, vel: this.vel.clone().multiplyScalar(0.1) });
      }
      return;
    }

    // Check house impact
    if (this.alive && this.pos.distanceTo(targetPos) <= CRUISE_IMPACT_RADIUS) {
      this.struckHouse = true;
      this.alive = false;
      ctx.combat.explosions.blast(this.pos, 24, { debris: 24, burn: true });
      ctx.combat.house.struck(this.pos, 0.35);
    }
  }

  private syncVelocityAndPose(): void {
    const cp = Math.cos(this.pitch);
    this._dir.set(Math.sin(this.heading) * cp, Math.sin(this.pitch), Math.cos(this.heading) * cp).normalize();
    this.vel.copy(this._dir).multiplyScalar(this.speed);
    this.mesh.position.copy(this.pos);
    this._q.setFromUnitVectors(this._fwd, this._dir);
    this.mesh.quaternion.copy(this._q);
    (this.span[0] as THREE.Vector3).copy(this.pos).addScaledVector(this._dir, -6.5);
    (this.span[1] as THREE.Vector3).copy(this.pos).addScaledVector(this._dir, 6.5);
  }
}

export class CruiseMissileMission implements MissionInstance {
  readonly def = CRUISE_DEF;
  outcome: 'active' | 'victory' | 'failed' = 'active';

  wave = 0;
  stoppedCount = 0;
  redirectedCount = 0;
  activeMissile: CruiseMissileEntity | null = null;
  grappleProgress = 0;
  grappled = false;

  private readonly group = new THREE.Group();
  private readonly flyingAway: CruiseMissileEntity[] = [];
  private nextWaveDelay = 0;
  private fastWarnCooldown = 0;
  private warningText: string | null = null;
  private warningT = 0;
  private rewardAwarded = 0;
  private resultSummary = '';
  private tetherSparkT = 0;

  constructor() {
    this.group.name = 'mission-cruise';
  }

  start(ctx: MissionContext): void {
    this.outcome = 'active';
    this.wave = 0;
    this.stoppedCount = 0;
    this.redirectedCount = 0;
    this.activeMissile = null;
    this.flyingAway.length = 0;
    this.grappleProgress = 0;
    this.grappled = false;
    this.nextWaveDelay = 0;
    this.fastWarnCooldown = 0;
    this.warningText = null;
    this.warningT = 0;
    this.rewardAwarded = 0;
    this.resultSummary = '';

    ctx.root.add(this.group);
    ctx.playCue?.('start');
    this.launchWave(ctx, 1);
  }

  private launchWave(ctx: MissionContext, waveNum: number): void {
    this.wave = waveNum;
    this.grappleProgress = 0;
    this.grappled = false;

    const dist = waveNum === 1 ? CRUISE_SPAWN_DIST_WAVE1 : CRUISE_SPAWN_DIST_WAVE2;
    const speed = waveNum === 1 ? CRUISE_WAVE1_SPEED : CRUISE_WAVE2_SPEED;
    // Offshore south-southwest / south-southeast azimuths over open water
    const bearing = waveNum === 1 ? -0.22 : 0.28;
    const spawnAt = new THREE.Vector3(
      ctx.padPos.x + Math.sin(bearing) * dist,
      320,
      ctx.padPos.z + Math.cos(bearing) * dist,
    );

    const m = new CruiseMissileEntity(spawnAt, ctx.padPos, speed);
    if (ctx.hazeUniforms) hazeAll(m.mesh, ctx.hazeUniforms);
    this.group.add(m.mesh);
    ctx.combat.hostiles.push(m);
    this.activeMissile = m;

    ctx.playCue?.('lock');
    ctx.events.emit('jarvis', {
      text:
        waveNum === 1
          ? 'Warning, sir! Hypersonic cruise missile inbound from offshore — bound for the Malibu house. Shoot it down or fly alongside and pitch it skyward!'
          : 'Second launch detected! Faster Mach 1.2 warhead inbound from the south-east!',
    });
  }

  update(dt: number, ctx: MissionContext, controls: MissionControls): MissionTelemetry {
    this.fastWarnCooldown = Math.max(0, this.fastWarnCooldown - dt);
    if (this.warningT > 0) {
      this.warningT -= dt;
      if (this.warningT <= 0) this.warningText = null;
    }

    // Update any redirected missiles still climbing toward safe high-altitude detonation
    for (let i = this.flyingAway.length - 1; i >= 0; i--) {
      const rm = this.flyingAway[i];
      rm.step(dt, ctx.padPos, false, 0, ctx);
      if (rm.detonatedSafely) {
        this.group.remove(rm.mesh);
        this.flyingAway.splice(i, 1);
      }
    }

    if (this.outcome === 'active') {
      if (this.nextWaveDelay > 0) {
        this.nextWaveDelay -= dt;
        if (this.nextWaveDelay <= 0) {
          this.launchWave(ctx, this.wave + 1);
        }
      } else if (this.activeMissile) {
        this.stepActiveMissile(this.activeMissile, dt, ctx, controls);
      }
    }

    return this.buildTelemetry(ctx);
  }

  private stepActiveMissile(
    m: CruiseMissileEntity,
    dt: number,
    ctx: MissionContext,
    controls: MissionControls,
  ): void {
    // Shot down by player weapons?
    if (!m.alive && !m.struckHouse) {
      this.handleShootdown(m, ctx);
      return;
    }

    const suitPos = ctx.model.pos;
    const suitVel = ctx.model.vel;
    const dist = coreDistance(m, suitPos);
    const relSpeed = suitVel.distanceTo(m.vel);
    const climbing =
      controls.vertical > 0.1 ||
      controls.pressed.has('KeyE') ||
      (controls.aimY ?? 0) > 0.2 ||
      suitVel.y > 18;

    // Proximity grapple check
    if (dist <= CRUISE_GRAPPLE_RADIUS) {
      if (relSpeed <= CRUISE_GRAPPLE_MAX_REL_SPEED) {
        this.grappled = true;
        const rate = climbing ? 1.0 : 0.72;
        this.grappleProgress = Math.min(1, this.grappleProgress + (dt * rate) / CRUISE_GRAPPLE_DURATION);
        this.tetherSparkT += dt;
        if (this.tetherSparkT >= 0.08) {
          this.tetherSparkT = 0;
          ctx.particles.burst('plasma', suitPos.clone().lerp(m.pos, 0.5), 4, 8, undefined, 0.6);
        }
      } else {
        this.grappled = false;
        if (this.fastWarnCooldown <= 0) {
          this.fastWarnCooldown = 2.4;
          this.warningText = 'MATCH MISSILE SPEED TO GRAPPLE — OR FIRE WEAPONS!';
          this.warningT = 2.2;
          ctx.playCue?.('warning');
          ctx.events.emit('jarvis', { text: 'Closing too fast to latch on, sir — match its speed to redirect!' });
        }
      }
    } else if (dist > CRUISE_GRAPPLE_BREAK_RADIUS) {
      this.grappled = false;
      this.grappleProgress = Math.max(0, this.grappleProgress - dt * 0.5);
    } else {
      // Between 18 m and 28 m: maintain partial grapple if already latched
      if (!this.grappled) {
        this.grappleProgress = Math.max(0, this.grappleProgress - dt * 0.4);
      } else if (relSpeed <= CRUISE_GRAPPLE_MAX_REL_SPEED) {
        const rate = climbing ? 0.85 : 0.55;
        this.grappleProgress = Math.min(1, this.grappleProgress + (dt * rate) / CRUISE_GRAPPLE_DURATION);
      } else {
        this.grappled = false;
      }
    }

    m.step(dt, ctx.padPos, this.grappled, climbing ? 1 : 0, ctx);

    // Check Heroic Redirect completion!
    if (this.grappled && this.grappleProgress >= 1 && m.pitch >= CRUISE_REDIRECT_PITCH_RAD) {
      this.handleRedirect(m, ctx);
      return;
    }

    // Check house impact
    if (m.struckHouse) {
      unregisterHostile(ctx.combat, m);
      this.group.remove(m.mesh);
      this.activeMissile = null;
      this.grappled = false;
      this.grappleProgress = 0;
      this.outcome = 'failed';
      this.resultSummary = 'MALIBU HOUSE STRUCK · INTERCEPT FAILED';
      ctx.playCue?.('fail');
      ctx.events.emit('jarvis', { text: 'Direct hit on the Malibu cliffside! Intercept failed, sir.' });
    }
  }

  private handleShootdown(m: CruiseMissileEntity, ctx: MissionContext): void {
    unregisterHostile(ctx.combat, m);
    this.group.remove(m.mesh);
    ctx.combat.explosions.blast(m.pos, 18, { debris: 18, vel: m.vel.clone().multiplyScalar(0.15) });
    this.activeMissile = null;
    this.grappled = false;
    this.grappleProgress = 0;
    this.stoppedCount++;
    this.rewardAwarded += CRUISE_SHOOTDOWN_REWARD;
    ctx.awardRd(CRUISE_SHOOTDOWN_REWARD, 'CRUISE MISSILE INTERCEPTED');
    ctx.playCue?.('ping');
    this.advanceOrWin(ctx, false);
  }

  private handleRedirect(m: CruiseMissileEntity, ctx: MissionContext): void {
    // Unregister from combat hostiles first, then mark alive=false so in-flight
    // player seekers immediately drop lock without triggering a shootdown blast.
    unregisterHostile(ctx.combat, m);
    m.alive = false;
    m.redirected = true;
    m.pitch = Math.max(m.pitch, THREE.MathUtils.degToRad(48));
    this.flyingAway.push(m);
    this.activeMissile = null;
    this.grappled = false;
    this.grappleProgress = 0;
    this.stoppedCount++;
    this.redirectedCount++;
    this.rewardAwarded += CRUISE_REDIRECT_REWARD;
    ctx.awardRd(CRUISE_REDIRECT_REWARD, 'MISSILE REDIRECTED');
    ctx.playCue?.('success');
    ctx.events.emit('jarvis', {
      text: 'Missile redirected! Pitching safely into the upper atmosphere — magnificent flying, sir!',
    });
    this.advanceOrWin(ctx, true);
  }

  private advanceOrWin(ctx: MissionContext, wasRedirect: boolean): void {
    if (this.wave < CRUISE_TOTAL_WAVES) {
      this.nextWaveDelay = 3.2;
      if (!wasRedirect) {
        ctx.events.emit('jarvis', { text: 'Warhead neutralized, sir! Stand by — tracking a second launch signature.' });
      }
    } else {
      this.outcome = 'victory';
      this.rewardAwarded += CRUISE_CLEAR_BONUS;
      ctx.awardRd(CRUISE_CLEAR_BONUS, 'COASTLINE DEFENDED');
      ctx.playCue?.('success');
      this.resultSummary =
        this.redirectedCount > 0
          ? `${this.stoppedCount}/${CRUISE_TOTAL_WAVES} STOPPED (${this.redirectedCount} REDIRECTED) · +${this.rewardAwarded} R&D`
          : `${this.stoppedCount}/${CRUISE_TOTAL_WAVES} INTERCEPTED · +${this.rewardAwarded} R&D`;
      ctx.events.emit('jarvis', {
        text: 'All hypersonic threats neutralized, sir. Malibu is safe.',
      });
    }
  }

  private buildTelemetry(ctx: MissionContext): MissionTelemetry {
    const waypoints: WaypointMarker[] = [];
    const m = this.activeMissile;
    let eta: number | null = null;

    if (this.outcome === 'active' && m) {
      const toHouse = m.pos.distanceTo(ctx.padPos);
      eta = toHouse / Math.max(1, m.speed);
      waypoints.push({
        id: `cruise-${m.id}`,
        label: this.grappled ? 'GRAPPLED · PITCH UP' : `CRUISE MSL W${this.wave}`,
        pos: m.pos.clone(),
        color: this.grappled ? 'cyan' : 'red',
        pulse: true,
        detail: `${Math.round(m.speed)} M/S`,
      });
    }

    let objective = `INTERCEPT CRUISE MISSILE (${this.wave}/${CRUISE_TOTAL_WAVES})`;
    let subObjective = 'SHOOT IT DOWN OR FLY WITHIN 18 M & HOLD [E] TO REDIRECT SKYWARD';
    if (this.nextWaveDelay > 0 && this.outcome === 'active') {
      objective = 'TRACKING SECOND LAUNCH';
      subObjective = 'PREPARE FOR MACH 1.2 INTERCEPT';
    } else if (this.grappled && m) {
      const deg = Math.round(THREE.MathUtils.radToDeg(m.pitch));
      objective = 'HOLD [E] / PITCH UP TO REDIRECT';
      subObjective = `NOSE PITCH ${deg}° / ${CRUISE_REDIRECT_PITCH_DEG}° TARGET`;
    } else if (this.outcome === 'victory') {
      objective = 'INTERCEPT COMPLETE';
      subObjective = this.resultSummary;
    } else if (this.outcome === 'failed') {
      objective = 'INTERCEPT FAILED';
      subObjective = this.resultSummary;
    }

    return {
      id: this.def.id,
      code: this.def.code,
      title: this.def.title,
      phase: this.outcome === 'active' ? 'active' : this.outcome,
      objective,
      subObjective,
      progressText: `${this.stoppedCount} / ${CRUISE_TOTAL_WAVES} STOPPED${this.redirectedCount > 0 ? ` · ${this.redirectedCount} REDIRECT` : ''}`,
      progress01: this.stoppedCount / CRUISE_TOTAL_WAVES,
      timerSec: this.outcome === 'active' ? eta : null,
      warning: this.warningText,
      badge: this.grappled
        ? { text: 'GRAPPLE LOCKED', tone: 'cyan' }
        : eta !== null && eta < 10
          ? { text: 'IMPACT IMMINENT', tone: 'red' }
          : null,
      meter:
        this.grappleProgress > 0.01 && m
          ? {
              label: 'REDIRECT GRAPPLE',
              value: this.grappleProgress,
              tone: this.grappleProgress > 0.7 ? 'green' : 'cyan',
              detail: `${Math.round(this.grappleProgress * 100)}%`,
            }
          : null,
      waypoints,
      resultSummary: this.resultSummary || undefined,
      rewardAwarded: this.rewardAwarded || undefined,
    };
  }

  cleanup(ctx: MissionContext): void {
    if (this.activeMissile) {
      unregisterHostile(ctx.combat, this.activeMissile);
      this.group.remove(this.activeMissile.mesh);
      this.activeMissile = null;
    }
    for (const rm of this.flyingAway) {
      unregisterHostile(ctx.combat, rm);
      this.group.remove(rm.mesh);
    }
    this.flyingAway.length = 0;
    ctx.root.remove(this.group);
  }
}
