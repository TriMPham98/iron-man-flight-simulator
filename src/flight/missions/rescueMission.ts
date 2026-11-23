import * as THREE from 'three';
import type { Drone } from '../combat/drones';
import { beam, box, glowMaterial, loft, merge, paint, type V3 } from '../combat/modelKit';
import { hazeAll } from '../render/haze';
import {
  despawnMissionDrone,
  type MissionContext,
  type MissionControls,
  type MissionDefinition,
  type MissionInstance,
  type MissionTelemetry,
  type WaypointMarker,
} from './types';

/**
 * Mid-Air Rescue ("Barrel of Monkeys"):
 * Four damaged escape pods deploy high offshore (2,200–3,200 m), descending
 * under partial drogues toward the Pacific with bright smoke & beacon strobes.
 *
 * Catching a pod requires flying inside {@link RESCUE_CATCH_RADIUS} with
 * matched relative velocity (< {@link RESCUE_MAX_REL_SPEED} m/s). Once caught,
 * the pod rides tethered beneath the suit while harassing drones scramble;
 * return to the Malibu landing pad and hover/land to deliver each survivor
 * before the remaining pods hit the water.
 */

export const RESCUE_DEF: MissionDefinition = {
  id: 'rescue',
  code: 'OP-01',
  title: 'MID-AIR RESCUE',
  subtitle: 'BARREL OF MONKEYS',
  summary:
    'Four damaged escape pods are descending offshore from 2,200–3,200 m. Match their descent speed (<35 m/s) to catch each pod mid-air and deliver them safely to the Malibu pad before they hit the ocean.',
  rewardLabel: 'UP TO 440 R&D',
  difficulty: 'STANDARD',
};

export const RESCUE_POD_COUNT = 4;
export const RESCUE_CATCH_RADIUS = 14;
export const RESCUE_MAX_REL_SPEED = 35;
export const RESCUE_DROP_RADIUS = 26;
export const RESCUE_DROP_HEIGHT = 28;
export const RESCUE_DROP_MAX_SPEED = 24;
export const RESCUE_MIN_SAVE_FOR_VICTORY = 2;
export const RESCUE_POD_REWARD = 60;
export const RESCUE_CLEAR_BONUS = 120;
export const RESCUE_PERFECT_BONUS = 80;

export type PodState = 'falling' | 'carrying' | 'rescued' | 'lost';

export interface RescuePod {
  readonly id: number;
  readonly callsign: string;
  readonly pos: THREE.Vector3;
  readonly vel: THREE.Vector3;
  readonly descentRate: number;
  readonly mesh: THREE.Group;
  readonly chute: THREE.Object3D;
  readonly beacon: THREE.Mesh;
  state: PodState;
  smokeT: number;
  phase: number;
}

const podMats = {
  body: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.45, roughness: 0.42 }),
  glow: glowMaterial(),
  chute: new THREE.MeshStandardMaterial({
    color: 0xff6b2b,
    emissive: 0x331205,
    roughness: 0.85,
    metalness: 0.05,
    side: THREE.DoubleSide,
  }),
  beacon: new THREE.MeshBasicMaterial({
    color: 0xffb84d,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
};

let podGeoCache: { body: THREE.BufferGeometry; glow: THREE.BufferGeometry; chute: THREE.BufferGeometry } | null = null;

function podGeometry() {
  if (podGeoCache) return podGeoCache;
  const ring = (y: number, r: number): V3[] =>
    Array.from({ length: 8 }, (_, i) => {
      const a = (i / 8) * Math.PI * 2;
      return [Math.cos(a) * r, y, Math.sin(a) * r] as V3;
    });
  const body = merge([
    loft(
      [ring(-1.1, 0.55), ring(-0.75, 0.92), ring(0.55, 0.88), ring(1.05, 0.52), ring(1.3, 0.2)],
      (_e, s) => (s === 0 ? 0x2a2d33 : s === 1 ? 0xdde3ea : s === 2 ? 0xe05218 : 0xc4ccd4),
    ),
    box(0.32, 0.9, 0.16, 0x1b2028, 0, 0.15, 0.88),
    beam([-0.45, 1.0, 0], [-1.2, 3.6, 0.4], 0.03, 0x30343a),
    beam([0.45, 1.0, 0], [1.2, 3.6, 0.4], 0.03, 0x30343a),
    beam([0, 1.0, -0.45], [0, 3.6, -1.1], 0.03, 0x30343a),
  ]);
  const glow = merge([
    paint(new THREE.CylinderGeometry(0.93, 0.93, 0.16, 12).translate(0, 0.45, 0), new THREE.Color(1, 0.55, 0.12), 4),
    paint(new THREE.SphereGeometry(0.2, 10, 8).translate(0, 1.38, 0), new THREE.Color(1, 0.78, 0.25), 6),
  ]);
  const chute = new THREE.SphereGeometry(2.8, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.48);
  chute.translate(0, 2.4, 0);
  podGeoCache = { body, glow, chute };
  return podGeoCache;
}

export class RescueMission implements MissionInstance {
  readonly def = RESCUE_DEF;
  outcome: 'active' | 'victory' | 'failed' = 'active';

  readonly pods: RescuePod[] = [];
  carrying: RescuePod | null = null;
  rescuedCount = 0;
  lostCount = 0;

  private readonly group = new THREE.Group();
  private readonly dropRing: THREE.Mesh;
  private readonly drones: Drone[] = [];
  private readonly _v = new THREE.Vector3();
  private readonly _pad = new THREE.Vector3();
  private elapsed = 0;
  private fastWarnCooldown = 0;
  private warningText: string | null = null;
  private warningT = 0;
  private rewardAwarded = 0;
  private resultSummary = '';

  constructor() {
    this.group.name = 'mission-rescue';
    this.dropRing = new THREE.Mesh(
      new THREE.RingGeometry(RESCUE_DROP_RADIUS * 0.45, RESCUE_DROP_RADIUS * 0.52, 36).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0x56f5a8,
        transparent: true,
        opacity: 0.7,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.dropRing.visible = false;
    this.group.add(this.dropRing);
  }

  start(ctx: MissionContext): void {
    this.outcome = 'active';
    this.pods.length = 0;
    this.carrying = null;
    this.rescuedCount = 0;
    this.lostCount = 0;
    this.elapsed = 0;
    this.fastWarnCooldown = 0;
    this.warningText = null;
    this.warningT = 0;
    this.rewardAwarded = 0;
    this.resultSummary = '';

    this._pad.copy(ctx.padPos);
    this.dropRing.position.set(ctx.padPos.x, ctx.padPos.y + 0.35, ctx.padPos.z);

    // Deploy 4 pods offshore (+Z seaward) staggered in altitude so the player can
    // chain rescues cleanly before the lowest pods reach the waves.
    const layouts: ReadonlyArray<{ dx: number; dz: number; alt: number; rate: number }> = [
      { dx: -520, dz: 2150, alt: 2250, rate: 14.5 },
      { dx: 180, dz: 2550, alt: 2580, rate: 15.0 },
      { dx: -160, dz: 2950, alt: 2880, rate: 15.2 },
      { dx: 540, dz: 3250, alt: 3180, rate: 15.5 },
    ];

    const g = podGeometry();
    for (let i = 0; i < RESCUE_POD_COUNT; i++) {
      const L = layouts[i];
      const mesh = new THREE.Group();
      mesh.add(new THREE.Mesh(g.body, podMats.body), new THREE.Mesh(g.glow, podMats.glow));
      const chute = new THREE.Mesh(g.chute, podMats.chute);
      mesh.add(chute);
      const beacon = new THREE.Mesh(new THREE.RingGeometry(2.2, 2.8, 24), podMats.beacon);
      beacon.rotation.x = Math.PI / 2;
      mesh.add(beacon);

      const pos = new THREE.Vector3(ctx.padPos.x + L.dx, L.alt, ctx.padPos.z + L.dz);
      const vel = new THREE.Vector3(1.8 * (i % 2 === 0 ? 1 : -1), -L.rate, -1.2);
      mesh.position.copy(pos);
      if (ctx.hazeUniforms) hazeAll(mesh, ctx.hazeUniforms);
      this.group.add(mesh);

      this.pods.push({
        id: i + 1,
        callsign: `POD-${i + 1}`,
        pos,
        vel,
        descentRate: L.rate,
        mesh,
        chute,
        beacon,
        state: 'falling',
        smokeT: i * 0.07,
        phase: i * 1.4,
      });
    }

    ctx.root.add(this.group);
    ctx.playCue?.('start');
    ctx.events.emit('jarvis', {
      text: 'Four damaged escape pods deployed offshore, sir. Match their descent below 35 m/s to catch them mid-air and bring them to the Malibu pad.',
    });
  }

  update(dt: number, ctx: MissionContext, _controls: MissionControls): MissionTelemetry {
    this.elapsed += dt;
    this.fastWarnCooldown = Math.max(0, this.fastWarnCooldown - dt);
    if (this.warningT > 0) {
      this.warningT -= dt;
      if (this.warningT <= 0) this.warningText = null;
    }

    const suitPos = ctx.model.pos;
    const suitVel = ctx.model.vel;

    if (this.outcome === 'active') {
      for (const pod of this.pods) {
        if (pod.state === 'falling') {
          this.stepFallingPod(pod, dt, ctx, suitPos, suitVel);
        } else if (pod.state === 'carrying') {
          this.stepCarriedPod(pod, dt, ctx, suitPos, suitVel);
        }
      }

      // Check completion once no pods are still falling or carried
      const activeCount = this.pods.filter((p) => p.state === 'falling' || p.state === 'carrying').length;
      if (activeCount === 0) {
        this.finish(ctx);
      }
    }

    this.dropRing.visible = this.outcome === 'active' && this.carrying !== null;
    if (this.dropRing.visible) {
      const pulse = 1 + 0.08 * Math.sin(this.elapsed * 5);
      this.dropRing.scale.setScalar(pulse);
    }

    return this.buildTelemetry(ctx);
  }

  private stepFallingPod(
    pod: RescuePod,
    dt: number,
    ctx: MissionContext,
    suitPos: THREE.Vector3,
    suitVel: THREE.Vector3,
  ): void {
    pod.vel.y = -pod.descentRate;
    pod.pos.addScaledVector(pod.vel, dt);
    pod.mesh.position.copy(pod.pos);
    pod.mesh.rotation.z = Math.sin(this.elapsed * 1.7 + pod.phase) * 0.14;
    pod.mesh.rotation.x = Math.cos(this.elapsed * 1.3 + pod.phase) * 0.1;
    pod.beacon.scale.setScalar(1 + 0.35 * Math.sin(this.elapsed * 7 + pod.phase));

    // Bright smoke & flare trail for visual tracking
    pod.smokeT += dt;
    if (pod.smokeT >= 0.08) {
      pod.smokeT = 0;
      ctx.particles.emit('smoke', pod.pos, this._v.set(0, 3, 0), { scale: 1.15, life: 3.4 });
      ctx.particles.emit('ember', pod.pos, this._v.set(0, 2, 0), { scale: 1.5 });
    }

    // Catch check (when hands are free)
    if (!this.carrying) {
      const dist = suitPos.distanceTo(pod.pos);
      if (dist <= RESCUE_CATCH_RADIUS) {
        const relSpeed = suitVel.distanceTo(pod.vel);
        if (relSpeed <= RESCUE_MAX_REL_SPEED) {
          this.catchPod(pod, ctx);
          return;
        } else if (this.fastWarnCooldown <= 0) {
          this.fastWarnCooldown = 2.6;
          this.warningText = `TOO FAST (${Math.round(relSpeed)} M/S) — FLARE TO MATCH DESCENT (<${RESCUE_MAX_REL_SPEED} M/S)`;
          this.warningT = 2.5;
          ctx.playCue?.('warning');
          ctx.events.emit('jarvis', { text: 'Too fast, sir — flare to match descent!' });
        }
      }
    }

    // Ocean / ground impact check
    const surf = ctx.world.surface(pod.pos.x, pod.pos.z);
    if (pod.pos.y <= surf + 1.2) {
      pod.state = 'lost';
      pod.mesh.visible = false;
      this.lostCount++;
      ctx.particles.burst(ctx.world.isWater(pod.pos.x, pod.pos.z) ? 'spray' : 'dust', pod.pos, 24, 18, new THREE.Vector3(0, 1, 0), 1.4, {
        scale: 1.5,
      });
      ctx.playCue?.('warning');
      ctx.events.emit('jarvis', { text: `${pod.callsign} hit the water, sir! We lost the capsule.` });
    }
  }

  private catchPod(pod: RescuePod, ctx: MissionContext): void {
    pod.state = 'carrying';
    pod.chute.visible = false;
    pod.beacon.visible = false;
    this.carrying = pod;
    this.warningText = null;
    this.warningT = 0;
    ctx.playCue?.('ping');
    ctx.particles.burst('plasma', pod.pos, 10, 6, undefined, 0.8);
    ctx.events.emit('jarvis', {
      text: `${pod.callsign} secured under tether, sir! Bring it home to the Malibu pad — hostile drones inbound.`,
    });
    this.spawnHarassers(ctx);
  }

  private spawnHarassers(ctx: MissionContext): void {
    // Keep up to 3 active harassing drones while carrying a pod
    const aliveDrones = this.drones.filter((d) => d.alive);
    const toSpawn = Math.max(0, Math.min(2, 3 - aliveDrones.length));
    for (let i = 0; i < toSpawn; i++) {
      const angle = (i === 0 ? 0.55 : -0.65) + this.rescuedCount * 0.4;
      const dist = 1600 + i * 350;
      const at = new THREE.Vector3(
        ctx.model.pos.x + Math.cos(angle) * dist,
        Math.max(ctx.model.pos.y + 120, 420),
        ctx.model.pos.z + Math.sin(angle) * dist,
      );
      const heading = ctx.model.pos.clone().sub(at).setY(0);
      if (heading.lengthSq() < 1) heading.set(0, 0, -1);
      const d = ctx.combat.spawnDrone(at, heading, 'drone');
      this.drones.push(d);
    }
  }

  private stepCarriedPod(
    pod: RescuePod,
    dt: number,
    ctx: MissionContext,
    suitPos: THREE.Vector3,
    suitVel: THREE.Vector3,
  ): void {
    // Tether smoothly under the suit
    const target = this._v.set(suitPos.x, suitPos.y - 2.3, suitPos.z);
    const alpha = 1 - Math.exp(-dt * 18);
    pod.pos.lerp(target, alpha);
    pod.vel.copy(suitVel);
    pod.mesh.position.copy(pod.pos);
    pod.mesh.rotation.set(0, 0, Math.sin(this.elapsed * 3) * 0.08);

    // Check Malibu PAD drop-off zone
    const horizDist = Math.hypot(suitPos.x - this._pad.x, suitPos.z - this._pad.z);
    const relY = suitPos.y - this._pad.y;
    if (
      horizDist <= RESCUE_DROP_RADIUS &&
      relY >= -4 &&
      relY <= RESCUE_DROP_HEIGHT &&
      (ctx.model.grounded || ctx.model.speed <= RESCUE_DROP_MAX_SPEED)
    ) {
      this.deliverPod(pod, ctx);
    }
  }

  private deliverPod(pod: RescuePod, ctx: MissionContext): void {
    pod.state = 'rescued';
    this.carrying = null;
    this.rescuedCount++;
    // Set the rescued pod safely on the terrace edge beside the pad
    const angle = (this.rescuedCount / RESCUE_POD_COUNT) * Math.PI * 1.1 - 0.55;
    pod.pos.set(this._pad.x + Math.cos(angle) * 9, this._pad.y + 1.1, this._pad.z + Math.sin(angle) * 9);
    pod.vel.set(0, 0, 0);
    pod.mesh.position.copy(pod.pos);
    pod.mesh.rotation.set(0, 0, 0);

    this.rewardAwarded += RESCUE_POD_REWARD;
    ctx.awardRd(RESCUE_POD_REWARD, `${pod.callsign} RESCUED`);
    ctx.playCue?.('ping');

    const remaining = this.pods.filter((p) => p.state === 'falling').length;
    if (remaining > 0) {
      ctx.events.emit('jarvis', {
        text: `${pod.callsign} safe on the Malibu deck, sir! ${remaining} ${remaining === 1 ? 'pod remains' : 'pods remain'} in the air.`,
      });
    }
  }

  private finish(ctx: MissionContext): void {
    if (this.rescuedCount >= RESCUE_MIN_SAVE_FOR_VICTORY) {
      this.outcome = 'victory';
      const perfect = this.rescuedCount === RESCUE_POD_COUNT;
      const bonus = RESCUE_CLEAR_BONUS + (perfect ? RESCUE_PERFECT_BONUS : 0);
      this.rewardAwarded += bonus;
      ctx.awardRd(bonus, perfect ? 'ALL PODS RESCUED' : 'RESCUE COMPLETE');
      ctx.playCue?.('success');
      this.resultSummary = `${this.rescuedCount}/${RESCUE_POD_COUNT} PODS SAVED · +${this.rewardAwarded} R&D`;
      ctx.events.emit('jarvis', {
        text: perfect
          ? 'Every single pod delivered safely, sir. Barrel of monkeys — textbook execution.'
          : `${this.rescuedCount} of ${RESCUE_POD_COUNT} pods secured on the deck, sir. Mission complete.`,
      });
    } else {
      this.outcome = 'failed';
      ctx.playCue?.('fail');
      this.resultSummary = `${this.rescuedCount}/${RESCUE_POD_COUNT} SAVED · TOO MANY PODS LOST`;
      ctx.events.emit('jarvis', { text: 'Too many escape pods lost to the ocean, sir. Rescue failed.' });
    }
  }

  private buildTelemetry(ctx: MissionContext): MissionTelemetry {
    const falling = this.pods.filter((p) => p.state === 'falling');
    const waypoints: WaypointMarker[] = [];

    if (this.outcome === 'active') {
      if (this.carrying) {
        waypoints.push({
          id: 'rescue-pad',
          label: 'MALIBU PAD · DROP',
          pos: this._pad.clone().add(new THREE.Vector3(0, 2, 0)),
          color: 'green',
          pulse: true,
          detail: 'HOVER <24 M/S',
        });
      }
      for (const pod of falling) {
        const alt = Math.max(0, Math.round(pod.pos.y));
        const urgent = alt < 550;
        waypoints.push({
          id: `pod-${pod.id}`,
          label: pod.callsign,
          pos: pod.pos.clone(),
          color: urgent ? 'red' : 'amber',
          pulse: urgent,
          detail: `ALT ${alt}m`,
        });
      }
    }

    // Lowest falling pod's estimated time to splashdown
    let lowestEta: number | null = null;
    for (const p of falling) {
      const eta = Math.max(0, p.pos.y / Math.max(1, p.descentRate));
      if (lowestEta === null || eta < lowestEta) lowestEta = eta;
    }

    let objective = 'INTERCEPT FALLING ESCAPE PODS';
    let subObjective = `MATCH DESCENT (<${RESCUE_MAX_REL_SPEED} M/S) WITHIN ${RESCUE_CATCH_RADIUS} M`;
    if (this.carrying) {
      const dist = Math.round(ctx.model.pos.distanceTo(this._pad));
      objective = `DELIVER ${this.carrying.callsign} TO MALIBU PAD`;
      subObjective = dist < 120 ? 'SLOW BELOW 24 M/S OVER THE PAD TO RELEASE' : `RETURN TO MALIBU PAD (${dist} M)`;
    } else if (this.outcome === 'victory') {
      objective = 'RESCUE MISSION COMPLETE';
      subObjective = this.resultSummary;
    } else if (this.outcome === 'failed') {
      objective = 'RESCUE MISSION FAILED';
      subObjective = this.resultSummary;
    }

    return {
      id: this.def.id,
      code: this.def.code,
      title: this.def.title,
      phase: this.outcome === 'active' ? 'active' : this.outcome,
      objective,
      subObjective,
      progressText: `${this.rescuedCount} / ${RESCUE_POD_COUNT} SAVED${this.lostCount > 0 ? ` · ${this.lostCount} LOST` : ''}`,
      progress01: this.rescuedCount / RESCUE_POD_COUNT,
      timerSec: this.outcome === 'active' ? lowestEta : null,
      warning: this.warningText,
      badge: this.carrying
        ? { text: `CARRYING ${this.carrying.callsign}`, tone: 'green' }
        : falling.length > 0
          ? { text: `${falling.length} IN FREEFALL`, tone: lowestEta !== null && lowestEta < 30 ? 'red' : 'amber' }
          : null,
      meter: null,
      waypoints,
      resultSummary: this.resultSummary || undefined,
      rewardAwarded: this.rewardAwarded || undefined,
    };
  }

  cleanup(ctx: MissionContext): void {
    for (const d of this.drones) despawnMissionDrone(ctx.combat, d);
    this.drones.length = 0;
    for (const p of this.pods) this.group.remove(p.mesh);
    this.pods.length = 0;
    this.carrying = null;
    ctx.root.remove(this.group);
  }
}
