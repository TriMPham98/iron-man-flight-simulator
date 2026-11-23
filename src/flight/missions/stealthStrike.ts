import * as THREE from 'three';
import type { Drone } from '../combat/drones';
import { box, frustum, glowMaterial, merge, paint } from '../combat/modelKit';
import type { DamageKind, Hostile } from '../combat/types';
import { hazeAll } from '../render/haze';
import {
  despawnMissionDrone,
  unregisterHostile,
  type MissionBadge,
  type MissionContext,
  type MissionControls,
  type MissionDefinition,
  type MissionInstance,
  type MissionTelemetry,
  type WaypointMarker,
} from './types';

/**
 * Sea-Skimming Stealth Strike:
 * An offshore fortified AEGIS radar relay warship sits ~4.5 km out to sea with
 * a strict radar detection ceiling ({@link STEALTH_RADAR_CEILING} = 38 m AGL).
 *
 * Flying below 38 m AGL over the waves OR inside cloud cover
 * (`world.inCloud > 0.25`) keeps the suit hidden (`STEALTH: MASKED`).
 * Climbing above the ceiling in open air fills the `RADAR LOCK` meter (0→100%)
 * with accelerating warning cues; at 100%, the relay fires heavy SAM salvos
 * and scrambles interceptors until you drop back under the radar floor.
 *
 * Objective: slip in low and destroy the armored AEGIS RADAR MAST (and
 * optional escort turrets for bonus R&D).
 */

export const STEALTH_DEF: MissionDefinition = {
  id: 'stealth',
  code: 'OP-03',
  title: 'SEA-SKIMMING STEALTH STRIKE',
  subtitle: 'UNDER THE HORIZON',
  summary:
    'An offshore AEGIS radar relay monitors the coast ~4.5 km out to sea. Skim below 38 m AGL or hide inside clouds to stay masked, slip in unseen, and destroy the armored AEGIS RADAR MAST.',
  rewardLabel: 'UP TO 430 R&D',
  difficulty: 'HIGH',
};

export const STEALTH_RADAR_CEILING = 38;
export const STEALTH_CLOUD_MASK = 0.25;
export const STEALTH_SHIP_DIST = 4500;
export const STEALTH_DETECT_RANGE = 5400;
export const STEALTH_LOCK_FILL_BASE = 0.26;
export const STEALTH_LOCK_DECAY_RATE = 0.36;
export const STEALTH_MAST_HP = 520;
export const STEALTH_TURRET_HP = 220;
export const STEALTH_CLEAR_REWARD = 240;
export const STEALTH_GHOST_BONUS = 100;
export const STEALTH_TURRET_BONUS = 45;

let nextStealthHostileId = 9500;

const stMats = {
  body: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.5, roughness: 0.52 }),
  glow: glowMaterial(),
};

/**
 * Custom target on the AEGIS relay. Uses `kind: 'sam'` with a real `mesh`
 * property so `Combat.update` safely hides its mesh and emits a size-10 burn
 * blast on destruction without crashing.
 */
export class StealthTarget implements Hostile {
  readonly id = nextStealthHostileId++;
  readonly kind = 'sam' as const;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly radius: number;
  readonly maxHp: number;
  hp: number;
  alive = true;
  threatened = 0;

  constructor(
    readonly role: 'mast' | 'turret',
    readonly label: string,
    readonly mesh: THREE.Object3D,
    worldPos: THREE.Vector3,
    hp: number,
    radius: number,
  ) {
    this.pos.copy(worldPos);
    this.maxHp = this.hp = hp;
    this.radius = radius;
  }

  damage(amount: number, _at: THREE.Vector3, _kind: DamageKind): boolean {
    if (!this.alive) return false;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      return true;
    }
    return false;
  }
}

function buildRelayVisuals(origin: THREE.Vector3): {
  root: THREE.Group;
  mastHead: THREE.Group;
  mastPos: THREE.Vector3;
  turrets: Array<{ group: THREE.Group; pos: THREE.Vector3 }>;
} {
  const root = new THREE.Group();
  root.position.copy(origin);

  const hullColor = 0x3b424c;
  const deckColor = 0x262b32;
  const accent = 0x525b66;

  // Stealth frigate / offshore AEGIS platform hull + angled citadel
  const hullGeo = merge([
    frustum({ hw0: 11, z0: -48, z1: 48, y0: -4, hw1: 9.5, z2: -45, z3: 52, y1: 7 }, hullColor),
    box(17, 1.2, 88, deckColor, 0, 7.6, 0),
    frustum({ hw0: 7.5, z0: -18, z1: 18, y0: 7.6, hw1: 5.5, z2: -14, z3: 14, y1: 19 }, accent),
    // Tall armored radar tower
    frustum({ hw0: 4.0, z0: -6, z1: 6, y0: 19, hw1: 2.2, z2: -3.5, z3: 3.5, y1: 32 }, hullColor),
    // Fore/aft turret pedestals
    box(4.5, 2.4, 4.5, deckColor, 0, 9.2, 28),
    box(4.5, 2.4, 4.5, deckColor, 0, 9.2, -28),
  ]);
  root.add(new THREE.Mesh(hullGeo, stMats.body));

  // Destructible rotating AEGIS Radar Mast head
  const mastHead = new THREE.Group();
  mastHead.position.set(0, 35.5, 0);
  const mastBody = merge([
    box(8.8, 3.6, 1.4, 0x6c7580, 0, 0, 0),
    box(1.4, 3.6, 8.8, 0x555e68, 0, 0, 0),
    paint(new THREE.CylinderGeometry(1.4, 1.9, 5.5, 10).translate(0, -1.5, 0), 0x3b424c),
  ]);
  const mastGlow = merge([
    paint(new THREE.BoxGeometry(8.2, 2.2, 1.55), new THREE.Color(1, 0.25, 0.12), 5.5),
    paint(new THREE.SphereGeometry(0.9, 12, 8).translate(0, 3.1, 0), new THREE.Color(1, 0.2, 0.1), 8),
  ]);
  mastHead.add(new THREE.Mesh(mastBody, stMats.body), new THREE.Mesh(mastGlow, stMats.glow));
  root.add(mastHead);

  // Two escort turrets
  const turrets: Array<{ group: THREE.Group; pos: THREE.Vector3 }> = [];
  for (const z of [28, -28]) {
    const tg = new THREE.Group();
    tg.position.set(0, 11.4, z);
    const tBody = merge([
      paint(new THREE.CylinderGeometry(1.8, 2.1, 2.2, 12), 0x5a626d),
      box(1.1, 1.1, 4.2, 0x22262b, 0, 0.5, z > 0 ? 1.8 : -1.8),
    ]);
    const tGlow = paint(new THREE.BoxGeometry(0.9, 0.4, 0.4).translate(0, 1.25, 0), new THREE.Color(1, 0.55, 0.12), 4.5);
    tg.add(new THREE.Mesh(tBody, stMats.body), new THREE.Mesh(tGlow, stMats.glow));
    root.add(tg);
    turrets.push({ group: tg, pos: origin.clone().add(tg.position) });
  }

  return {
    root,
    mastHead,
    mastPos: origin.clone().add(mastHead.position),
    turrets,
  };
}

export class StealthStrikeMission implements MissionInstance {
  readonly def = STEALTH_DEF;
  outcome: 'active' | 'victory' | 'failed' = 'active';

  radarLock = 0;
  masked = true;
  maskedBy: 'sea' | 'cloud' | 'range' | 'exposed' = 'range';
  alerted = false;
  everAlerted = false;
  mast: StealthTarget | null = null;
  readonly turrets: StealthTarget[] = [];
  readonly relayPos = new THREE.Vector3();

  private readonly group = new THREE.Group();
  private relayVisual: THREE.Group | null = null;
  private mastHead: THREE.Group | null = null;
  private readonly interceptors: Drone[] = [];
  private readonly turretAwarded = new Set<number>();
  private elapsed = 0;
  private samSalvoT = 0;
  private samBurstLeft = 0;
  private samBurstGap = 0;
  private scrambleCooldown = 0;
  private gunT = 0;
  private warnBeepT = 0;
  private alertCallCooldown = 0;
  private rewardAwarded = 0;
  private resultSummary = '';

  constructor() {
    this.group.name = 'mission-stealth';
  }

  start(ctx: MissionContext): void {
    this.outcome = 'active';
    this.radarLock = 0;
    this.masked = true;
    this.maskedBy = 'range';
    this.alerted = false;
    this.everAlerted = false;
    this.turrets.length = 0;
    this.turretAwarded.clear();
    this.elapsed = 0;
    this.samSalvoT = 1.2;
    this.samBurstLeft = 0;
    this.samBurstGap = 0;
    this.scrambleCooldown = 0;
    this.gunT = 0;
    this.warnBeepT = 0;
    this.alertCallCooldown = 0;
    this.rewardAwarded = 0;
    this.resultSummary = '';

    // Pick a deep-water position ~4.5 km offshore (+Z seaward) clear of islands
    const candidate = new THREE.Vector3(ctx.padPos.x - 950, 0, ctx.padPos.z + STEALTH_SHIP_DIST);
    for (let k = 0; k < 10 && ctx.world.heightAt(candidate.x, candidate.z) > -8; k++) {
      candidate.x -= 280;
      candidate.z += 220;
    }
    this.relayPos.copy(candidate);

    const vis = buildRelayVisuals(this.relayPos);
    this.relayVisual = vis.root;
    this.mastHead = vis.mastHead;
    if (ctx.hazeUniforms) hazeAll(vis.root, ctx.hazeUniforms);
    this.group.add(vis.root);

    this.mast = new StealthTarget('mast', 'AEGIS RADAR', vis.mastHead, vis.mastPos, STEALTH_MAST_HP, 6.0);
    ctx.combat.hostiles.push(this.mast);

    vis.turrets.forEach((t, idx) => {
      const target = new StealthTarget('turret', `ESCORT CIWS ${idx + 1}`, t.group, t.pos, STEALTH_TURRET_HP, 4.2);
      this.turrets.push(target);
      ctx.combat.hostiles.push(target);
    });

    ctx.root.add(this.group);
    ctx.playCue?.('start');
    ctx.events.emit('jarvis', {
      text: 'AEGIS radar relay located 4.5 kilometres offshore, sir. Stay below 38 metres over the waves — or inside cloud cover — to remain masked and destroy the radar mast.',
    });
  }

  update(dt: number, ctx: MissionContext, _controls: MissionControls): MissionTelemetry {
    this.elapsed += dt;
    this.alertCallCooldown = Math.max(0, this.alertCallCooldown - dt);
    this.scrambleCooldown = Math.max(0, this.scrambleCooldown - dt);

    if (this.mastHead && this.mast?.alive) {
      this.mastHead.rotation.y = this.elapsed * (this.alerted ? 3.8 : 1.4);
    }

    if (this.outcome === 'active') {
      // Award bonus for any destroyed optional escort turrets
      for (const t of this.turrets) {
        if (!t.alive && !this.turretAwarded.has(t.id)) {
          this.turretAwarded.add(t.id);
          unregisterHostile(ctx.combat, t);
          this.rewardAwarded += STEALTH_TURRET_BONUS;
          ctx.awardRd(STEALTH_TURRET_BONUS, 'ESCORT TURRET OUT');
        }
      }

      // Check primary objective: AEGIS RADAR MAST destroyed
      if (this.mast && !this.mast.alive) {
        this.completeStrike(ctx);
      } else {
        this.stepStealthAndDefense(dt, ctx);
      }
    }

    return this.buildTelemetry(ctx);
  }

  private stepStealthAndDefense(dt: number, ctx: MissionContext): void {
    const suitPos = ctx.model.pos;
    const surf = Math.max(0, ctx.world.surface(suitPos.x, suitPos.z));
    const agl = suitPos.y - surf;
    const horizDist = Math.hypot(suitPos.x - this.relayPos.x, suitPos.z - this.relayPos.z);

    const inRange = horizDist <= STEALTH_DETECT_RANGE;
    const underCeiling = agl <= STEALTH_RADAR_CEILING;
    const inCloud = ctx.world.inCloud > STEALTH_CLOUD_MASK;

    if (!inRange) {
      this.masked = true;
      this.maskedBy = 'range';
    } else if (inCloud) {
      this.masked = true;
      this.maskedBy = 'cloud';
    } else if (underCeiling) {
      this.masked = true;
      this.maskedBy = 'sea';
    } else {
      this.masked = false;
      this.maskedBy = 'exposed';
    }

    if (this.masked) {
      const wasAlerted = this.alerted;
      this.radarLock = Math.max(0, this.radarLock - STEALTH_LOCK_DECAY_RATE * dt);
      if (wasAlerted && this.radarLock <= 0.05) {
        this.alerted = false;
        ctx.events.emit('jarvis', { text: 'Back under the radar floor, sir. AEGIS lock broken.' });
      }
    } else {
      // Closer to the relay fills radar lock faster
      const rangeFactor = THREE.MathUtils.lerp(1.65, 0.85, THREE.MathUtils.clamp(horizDist / STEALTH_DETECT_RANGE, 0, 1));
      this.radarLock = Math.min(1, this.radarLock + STEALTH_LOCK_FILL_BASE * rangeFactor * dt);

      // Escalating warning tones while lock builds
      this.warnBeepT -= dt;
      if (this.warnBeepT <= 0) {
        this.warnBeepT = THREE.MathUtils.lerp(0.65, 0.16, this.radarLock);
        ctx.playCue?.(this.radarLock >= 0.9 ? 'lock' : 'warning');
      }

      if (this.radarLock >= 1 && !this.alerted) {
        this.alerted = true;
        this.everAlerted = true;
        this.samSalvoT = 0.25;
        if (this.alertCallCooldown <= 0) {
          this.alertCallCooldown = 8;
          ctx.events.emit('jarvis', {
            text: 'AEGIS has a full radar lock! SAM salvos and interceptors launching — dive below 38 metres!',
          });
        }
      }
    }

    // Active retaliatory defense when radar lock is at 100%
    if (this.alerted && ctx.combat.playerTarget.alive) {
      this.stepRetaliation(dt, ctx, horizDist);
    }
  }

  private stepRetaliation(dt: number, ctx: MissionContext, horizDist: number): void {
    // 1. Intense SAM salvos (3 missiles per ripple every 4.5 s)
    this.samSalvoT -= dt;
    if (this.samBurstLeft === 0 && this.samSalvoT <= 0) {
      this.samBurstLeft = 3;
      this.samBurstGap = 0;
      this.samSalvoT = 4.6;
    }
    if (this.samBurstLeft > 0) {
      this.samBurstGap -= dt;
      if (this.samBurstGap <= 0) {
        this.samBurstGap = 0.42;
        this.samBurstLeft--;
        const launchAt = this.relayPos.clone().add(new THREE.Vector3((this.samBurstLeft - 1) * 3.5, 10.5, 14));
        const up = new THREE.Vector3(0, 1, 0);
        ctx.combat.missiles.launch({
          team: 'enemy',
          from: launchAt,
          vel: up.clone().multiplyScalar(55),
          target: ctx.combat.playerTarget,
          coast: 0.45,
        });
        ctx.combat.explosions.muzzle(launchAt, up, 2.0);
        ctx.events.emit('enemyMissile', { at: launchAt, value: 1 });
      }
    }

    // 2. Scramble up to 2 fast interceptors
    const aliveInterceptors = this.interceptors.filter((d) => d.alive).length;
    if (this.scrambleCooldown <= 0 && aliveInterceptors < 2) {
      this.scrambleCooldown = 12;
      const from = this.relayPos.clone().add(new THREE.Vector3(aliveInterceptors === 0 ? -120 : 120, 260, 180));
      const heading = ctx.model.pos.clone().sub(from).setY(0);
      if (heading.lengthSq() < 1) heading.set(0, 0, -1);
      const interceptor = ctx.combat.spawnDrone(from, heading, 'interceptor');
      this.interceptors.push(interceptor);
    }

    // 3. Surviving escort turrets fire tracer bursts inside 2.4 km
    this.gunT -= dt;
    if (this.gunT <= 0 && horizDist < 2400) {
      this.gunT = 0.22;
      for (const t of this.turrets) {
        if (!t.alive) continue;
        const dir = ctx.model.pos
          .clone()
          .addScaledVector(ctx.model.vel, horizDist / 1050)
          .sub(t.pos)
          .normalize();
        dir.x += (Math.random() - 0.5) * 0.03;
        dir.y += (Math.random() - 0.5) * 0.03;
        dir.z += (Math.random() - 0.5) * 0.03;
        dir.normalize();
        ctx.combat.guns.rounds.push({ p: t.pos.clone(), v: dir.multiplyScalar(1050), life: 2.2, dmg: 3 });
      }
    }
  }

  private completeStrike(ctx: MissionContext): void {
    this.outcome = 'victory';
    this.alerted = false;
    this.radarLock = 0;

    if (this.mast) unregisterHostile(ctx.combat, this.mast);
    for (const t of this.turrets) unregisterHostile(ctx.combat, t);
    for (const d of this.interceptors) despawnMissionDrone(ctx.combat, d);
    this.interceptors.length = 0;

    ctx.combat.explosions.blast(this.relayPos.clone().add(new THREE.Vector3(0, 28, 0)), 22, { debris: 24, burn: true });

    const ghost = !this.everAlerted;
    const bonus = STEALTH_CLEAR_REWARD + (ghost ? STEALTH_GHOST_BONUS : 0);
    this.rewardAwarded += bonus;
    ctx.awardRd(bonus, ghost ? 'GHOST STRIKE COMPLETE' : 'AEGIS RELAY BLINDED');
    ctx.playCue?.('success');
    this.resultSummary = ghost
      ? `UNDETECTED GHOST STRIKE · +${this.rewardAwarded} R&D`
      : `AEGIS RADAR DESTROYED · +${this.rewardAwarded} R&D`;
    ctx.events.emit('jarvis', {
      text: ghost
        ? 'AEGIS mast obliterated without a single radar lock, sir. Ghost strike complete.'
        : 'AEGIS radar mast destroyed, sir. Their offshore detection net is blind.',
    });
  }

  private buildTelemetry(ctx: MissionContext): MissionTelemetry {
    const waypoints: WaypointMarker[] = [];
    if (this.outcome === 'active' && this.mast?.alive) {
      waypoints.push({
        id: 'aegis-mast',
        label: 'AEGIS RADAR MAST',
        pos: this.mast.pos.clone(),
        color: this.alerted ? 'red' : 'amber',
        pulse: true,
        detail: `${Math.ceil((this.mast.hp / this.mast.maxHp) * 100)}% HP`,
      });
      for (const t of this.turrets) {
        if (!t.alive) continue;
        waypoints.push({
          id: `turret-${t.id}`,
          label: 'ESCORT CIWS',
          pos: t.pos.clone(),
          color: 'amber',
          detail: 'OPTIONAL',
        });
      }
    }

    const agl = Math.max(0, Math.round(ctx.model.pos.y - Math.max(0, ctx.world.surface(ctx.model.pos.x, ctx.model.pos.z))));
    const mastPct = this.mast ? Math.ceil((this.mast.hp / this.mast.maxHp) * 100) : 0;

    let badge: MissionBadge = { text: 'STEALTH: MASKED', tone: 'green' };
    if (this.maskedBy === 'cloud') badge = { text: 'STEALTH: CLOUD MASKED', tone: 'cyan' };
    else if (this.alerted) badge = { text: 'RADAR LOCK · SAM ALERT', tone: 'red' };
    else if (!this.masked) badge = { text: `EXPOSED · ${agl}M AGL`, tone: 'amber' };

    return {
      id: this.def.id,
      code: this.def.code,
      title: this.def.title,
      phase: this.outcome === 'active' ? 'active' : this.outcome,
      objective: this.outcome === 'victory' ? 'STEALTH STRIKE COMPLETE' : 'DESTROY AEGIS RADAR MAST',
      subObjective:
        this.outcome === 'victory'
          ? this.resultSummary
          : `STAY BELOW ${STEALTH_RADAR_CEILING} M AGL OR IN CLOUD COVER (NOW ${agl} M)`,
      progressText: this.outcome === 'victory' ? 'RELAY BLINDED' : `MAST INTEGRITY ${mastPct}%`,
      progress01: 1 - mastPct / 100,
      timerSec: null,
      warning:
        this.outcome === 'active' && !this.masked
          ? this.alerted
            ? `RADAR LOCK 100% — DIVE BELOW ${STEALTH_RADAR_CEILING} M TO BREAK LOCK!`
            : `ABOVE ${STEALTH_RADAR_CEILING} M RADAR FLOOR — DESCEND OR ENTER CLOUDS!`
          : null,
      badge: this.outcome === 'active' ? badge : null,
      meter:
        this.outcome === 'active'
          ? {
              label: 'RADAR LOCK',
              value: this.radarLock,
              tone: this.radarLock >= 0.85 ? 'red' : this.radarLock >= 0.35 ? 'amber' : 'green',
              detail: `${Math.round(this.radarLock * 100)}%`,
            }
          : null,
      waypoints,
      resultSummary: this.resultSummary || undefined,
      rewardAwarded: this.rewardAwarded || undefined,
    };
  }

  cleanup(ctx: MissionContext): void {
    if (this.mast) unregisterHostile(ctx.combat, this.mast);
    for (const t of this.turrets) unregisterHostile(ctx.combat, t);
    for (const d of this.interceptors) despawnMissionDrone(ctx.combat, d);
    this.interceptors.length = 0;
    this.turrets.length = 0;
    this.mast = null;
    if (this.relayVisual) {
      this.group.remove(this.relayVisual);
      this.relayVisual = null;
    }
    ctx.root.remove(this.group);
  }
}
