import * as THREE from 'three';
import type { Particles } from '../fx/particles';
import { hazeAll } from '../render/haze';
import type { EventBus } from '../sim/events';
import type { Drone, DroneType } from './drones';
import type { Explosions } from './explosions';
import type { DamageKind, Hostile } from './types';

/**
 * Dynamic Free-Flight / Between-Wave Emergencies:
 *  a) Falling Orbital Satellite: spawns >9,200 m (inside the icing zone)
 *     plummeting toward the coast/ocean; catch & slow or destroy before
 *     splashdown for bonus R&D + Reactor Overcharge.
 *  b) Rogue Coastal Bomber Wing: 2-3 fast low-level bombers racing along the
 *     shoreline toward the Malibu house.
 *  c) Offshore Distress Flare: sinking vessel / survivor pod offshore guarded
 *     by patrolling drones.
 */

export type EmergencyKind = 'satellite' | 'bomberWing' | 'distressFlare';
export type EmergencyOutcome = 'completed' | 'failed';

export interface ActiveEmergency {
  kind: EmergencyKind;
  title: string;
  objective: string;
  pos: THREE.Vector3;
  timerSec: number;
  progress01: number;
  result: EmergencyOutcome | null;
}

export interface EmergencyHost {
  readonly field: { surfaceAt(x: number, z: number): number; heightAt?(x: number, z: number): number };
  readonly home: THREE.Vector2;
  readonly particles: Particles;
  readonly explosions: Explosions;
  readonly events: EventBus;
  readonly spawnDrone: (at: THREE.Vector3, heading: THREE.Vector3, type?: DroneType) => Drone;
  readonly awardRd?: (points: number, reason: string) => void;
  readonly feedOvercharge?: (amount: number, reason: string, at?: THREE.Vector3) => void;
}

export const SATELLITE_SPAWN_ALT = 9450;
export const SATELLITE_CATCH_RADIUS = 24;
export const SATELLITE_CATCH_TIME = 1.4;
export const SATELLITE_RD_REWARD = 60;
export const SATELLITE_OVERCHARGE = 0.45;

export const BOMBER_WING_COUNT = 3;
export const BOMBER_WING_TIMER = 75;
export const BOMBER_WING_RD_REWARD = 55;
export const BOMBER_WING_OVERCHARGE = 0.35;

export const DISTRESS_GUARD_COUNT = 3;
export const DISTRESS_RESCUE_RADIUS = 35;
export const DISTRESS_TIMER = 80;
export const DISTRESS_RD_REWARD = 50;
export const DISTRESS_OVERCHARGE = 0.3;

export const EMERGENCY_INTERVAL_SEC = 22;
export const EMERGENCY_RESULT_LINGER = 4.0;

const ORDER: readonly EmergencyKind[] = ['satellite', 'bomberWing', 'distressFlare'];

let nextSatId = 80000;

class SatelliteTarget implements Hostile {
  readonly id = nextSatId++;
  readonly kind = 'drone' as const;
  readonly label = 'ORBITAL SAT';
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly radius = 6;
  readonly maxHp = 220;
  hp = 220;
  alive = true;
  threatened = 0;

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

function buildSatelliteMesh(): THREE.Group {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x8e96a0, metalness: 0.85, roughness: 0.25 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xd4a438, metalness: 0.9, roughness: 0.2 });
  const panel = new THREE.MeshStandardMaterial({ color: 0x162b4d, metalness: 0.6, roughness: 0.25, emissive: 0x0a1c38, emissiveIntensity: 0.5 });
  const glow = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(1, 0.42, 0.1), emissiveIntensity: 4 });

  const bus = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.8, 4.2, 8), gold);
  const dish = new THREE.Mesh(new THREE.ConeGeometry(2.2, 1.2, 12, 1, true), metal);
  dish.position.y = 2.6;
  const wingL = new THREE.Mesh(new THREE.BoxGeometry(7.5, 0.15, 2.2), panel);
  wingL.position.x = -5.2;
  const wingR = new THREE.Mesh(new THREE.BoxGeometry(7.5, 0.15, 2.2), panel);
  wingR.position.x = 5.2;
  const reentry = new THREE.Mesh(new THREE.SphereGeometry(2.2, 12, 10), glow);
  reentry.position.y = -1.6;
  reentry.scale.set(1.1, 0.7, 1.1);

  g.add(bus, dish, wingL, wingR, reentry);
  return g;
}

function buildDistressPodMesh(): { root: THREE.Group; beacon: THREE.Mesh } {
  const root = new THREE.Group();
  const hullMat = new THREE.MeshStandardMaterial({ color: 0xb8461c, metalness: 0.3, roughness: 0.6 });
  const podMat = new THREE.MeshStandardMaterial({ color: 0xdcd7cc, metalness: 0.2, roughness: 0.5 });
  const beaconMat = new THREE.MeshStandardMaterial({
    color: 0x330000,
    emissive: new THREE.Color(1.0, 0.18, 0.04),
    emissiveIntensity: 6,
  });

  const hull = new THREE.Mesh(new THREE.BoxGeometry(9, 2.4, 4.2), hullMat);
  hull.rotation.z = 0.22;
  const pod = new THREE.Mesh(new THREE.SphereGeometry(1.9, 14, 10), podMat);
  pod.position.set(2.5, 1.2, 0);
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.45, 10, 8), beaconMat);
  beacon.position.set(2.5, 3.4, 0);

  root.add(hull, pod, beacon);
  return { root, beacon };
}

export class EmergencyManager {
  readonly group = new THREE.Group();
  private active: ActiveEmergency | null = null;
  private nextPopUpT = EMERGENCY_INTERVAL_SEC;
  private nextIndex = 0;
  private lingerT = 0;
  private smokeAcc = 0;
  private flareT = 0;

  /** Satellite state. */
  private sat: SatelliteTarget | null = null;
  private satMesh: THREE.Group | null = null;
  private satCatchT = 0;

  /** Bomber wing state. */
  private wingBombers: Drone[] = [];

  /** Distress flare state. */
  private distressGuards: Drone[] = [];
  private distressPodMesh: THREE.Group | null = null;
  private distressBeacon: THREE.Mesh | null = null;
  private podSecured = false;

  lastReward: { rd: number; overcharge: number; reason: string } | null = null;
  private readonly _v = new THREE.Vector3();

  constructor(private readonly hazeUniforms: Record<string, THREE.IUniform> = {}) {
    this.group.name = 'emergencies';
  }

  get activeEmergency(): ActiveEmergency | null {
    return this.active;
  }

  /** Extra non-wave hostiles exposed by the active emergency (e.g. Falling Orbital Satellite). */
  get extraHostiles(): readonly Hostile[] {
    return this.sat && this.sat.alive ? [this.sat] : [];
  }

  reset(): void {
    this.clearVisuals();
    this.active = null;
    this.sat = null;
    this.satCatchT = 0;
    this.wingBombers = [];
    this.distressGuards = [];
    this.podSecured = false;
    this.nextPopUpT = EMERGENCY_INTERVAL_SEC;
    this.lingerT = 0;
    this.smokeAcc = 0;
    this.flareT = 0;
    this.lastReward = null;
  }

  /** Trigger a specific emergency (or cycle to the next kind). */
  trigger(kind: EmergencyKind = ORDER[this.nextIndex++ % ORDER.length], host?: EmergencyHost, playerPos?: THREE.Vector3): ActiveEmergency {
    this.clearVisuals();
    this.sat = null;
    this.satCatchT = 0;
    this.wingBombers = [];
    this.distressGuards = [];
    this.podSecured = false;
    this.lingerT = 0;
    this.smokeAcc = 0;
    this.flareT = 0;

    const home = host?.home ?? new THREE.Vector2(0, 525);

    if (kind === 'satellite') {
      const sat = new SatelliteTarget();
      const px = playerPos ? playerPos.x : home.x;
      const pz = playerPos ? playerPos.z : home.y;
      sat.pos.set(px + 900, SATELLITE_SPAWN_ALT, pz + 1600);
      sat.vel.set(-22, -92, 32);
      const mesh = buildSatelliteMesh();
      mesh.position.copy(sat.pos);
      if (Object.keys(this.hazeUniforms).length) hazeAll(mesh, this.hazeUniforms);
      this.group.add(mesh);
      this.sat = sat;
      this.satMesh = mesh;
      const estSec = Math.max(20, Math.round(sat.pos.y / Math.abs(sat.vel.y)));
      this.active = {
        kind: 'satellite',
        title: 'FALLING ORBITAL SATELLITE',
        objective: 'INTERCEPT ABOVE 9.2 KM — CATCH OR DESTROY BEFORE SPLASHDOWN',
        pos: sat.pos.clone(),
        timerSec: estSec,
        progress01: 0,
        result: null,
      };
      host?.events.emit('jarvis', {
        text: 'Sir, a deorbiting reconnaissance satellite just entered the upper atmosphere above nine thousand metres. Catch or destroy it before splashdown.',
        at: sat.pos,
      });
      return this.active;
    }

    if (kind === 'bomberWing') {
      const side = Math.random() < 0.5 ? -1 : 1;
      const bombers: Drone[] = [];
      for (let i = 0; i < BOMBER_WING_COUNT; i++) {
        const x = home.x + side * (3200 + i * 380);
        const z = home.y + 420 + (i - 1) * 160;
        const surf = host ? host.field.surfaceAt(x, z) : 0;
        const at = new THREE.Vector3(x, Math.max(surf, 0) + 145 + i * 18, z);
        const heading = new THREE.Vector3(home.x - x, 0, home.y - z).normalize();
        if (host) {
          const b = host.spawnDrone(at, heading, 'bomber');
          b.mode = 'attack';
          b.vel.copy(heading).multiplyScalar(165);
          bombers.push(b);
        }
      }
      this.wingBombers = bombers;
      const leadPos = bombers[0]?.pos.clone() ?? new THREE.Vector3(home.x + side * 3200, 145, home.y + 420);
      this.active = {
        kind: 'bomberWing',
        title: 'ROGUE COASTAL BOMBER WING',
        objective: `INTERCEPT ${bombers.length}/${bombers.length} LOW-LEVEL BOMBERS`,
        pos: leadPos,
        timerSec: BOMBER_WING_TIMER,
        progress01: 0,
        result: null,
      };
      host?.events.emit('jarvis', {
        text: 'Low-level radar contacts hugging the coastline, sir. A rogue bomber wing is racing toward the house.',
        at: leadPos,
      });
      return this.active;
    }

    // Offshore Distress Flare
    const podPos = new THREE.Vector3(home.x + (Math.random() - 0.5) * 1400, 0.5, home.y + 2400);
    const { root, beacon } = buildDistressPodMesh();
    root.position.copy(podPos);
    if (Object.keys(this.hazeUniforms).length) hazeAll(root, this.hazeUniforms);
    this.group.add(root);
    this.distressPodMesh = root;
    this.distressBeacon = beacon;

    const guards: Drone[] = [];
    for (let i = 0; i < DISTRESS_GUARD_COUNT; i++) {
      const a = (i / DISTRESS_GUARD_COUNT) * Math.PI * 2;
      const at = new THREE.Vector3(podPos.x + Math.cos(a) * 240, 140 + i * 25, podPos.z + Math.sin(a) * 240);
      const heading = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a));
      if (host) {
        const d = host.spawnDrone(at, heading, 'drone');
        d.mode = 'patrol';
        guards.push(d);
      }
    }
    this.distressGuards = guards;
    this.active = {
      kind: 'distressFlare',
      title: 'OFFSHORE DISTRESS FLARE',
      objective: `CLEAR ${guards.length} ESCORT DRONES & SECURE SURVIVOR POD`,
      pos: podPos.clone(),
      timerSec: DISTRESS_TIMER,
      progress01: 0,
      result: null,
    };
    host?.events.emit('jarvis', {
      text: 'Picking up an offshore distress beacon, sir. Survivors in the water, and hostiles circling overhead.',
      at: podPos,
    });
    return this.active;
  }

  update(
    dt: number,
    t: number,
    playerPos: THREE.Vector3,
    playerVel: THREE.Vector3,
    host: EmergencyHost,
    eligible = true,
  ): ActiveEmergency | null {
    // Result banner linger before clearing back to idle
    if (this.active && this.active.result !== null) {
      this.lingerT -= dt;
      if (this.lingerT <= 0) {
        this.clearVisuals();
        this.active = null;
      }
      return this.active;
    }

    if (!this.active) {
      if (eligible) {
        this.nextPopUpT -= dt;
        if (this.nextPopUpT <= 0) {
          this.nextPopUpT = EMERGENCY_INTERVAL_SEC;
          this.trigger(ORDER[this.nextIndex++ % ORDER.length], host, playerPos);
        }
      }
      return null;
    }

    const ev = this.active;

    if (ev.kind === 'satellite' && this.sat) {
      return this.updateSatellite(dt, t, playerPos, playerVel, host, ev);
    }
    if (ev.kind === 'bomberWing') {
      return this.updateBomberWing(dt, host, ev);
    }
    if (ev.kind === 'distressFlare') {
      return this.updateDistressFlare(dt, t, playerPos, host, ev);
    }
    return ev;
  }

  private updateSatellite(
    dt: number,
    t: number,
    playerPos: THREE.Vector3,
    playerVel: THREE.Vector3,
    host: EmergencyHost,
    ev: ActiveEmergency,
  ): ActiveEmergency {
    const sat = this.sat!;
    if (!sat.alive) {
      host.explosions.blast(sat.pos, 12, { debris: 18, vel: sat.vel.clone().multiplyScalar(0.1) });
      return this.completeEmergency(host, ev, SATELLITE_RD_REWARD, SATELLITE_OVERCHARGE, 'ORBITAL INTERCEPT', 'satelliteIntercept', 'Orbital debris neutralized before impact, sir.');
    }

    const dist = sat.pos.distanceTo(playerPos);
    if (dist <= SATELLITE_CATCH_RADIUS) {
      // Suit catches & aerobrakes the falling satellite
      this.satCatchT += dt;
      sat.vel.lerp(playerVel, Math.min(1, dt * 4));
      sat.vel.y = Math.min(0, sat.vel.y) * Math.exp(-dt * 4);
      if (Math.random() < Math.min(1, dt * 24)) {
        host.particles.burst('spark', sat.pos, 4, 8, undefined, 0.8);
      }
      if (this.satCatchT >= SATELLITE_CATCH_TIME) {
        sat.alive = false;
        return this.completeEmergency(host, ev, SATELLITE_RD_REWARD, SATELLITE_OVERCHARGE, 'ORBITAL INTERCEPT', 'satelliteIntercept', 'Satellite stabilized and safely recovered, sir.');
      }
    } else {
      this.satCatchT = Math.max(0, this.satCatchT - dt * 0.4);
      sat.vel.y = Math.max(-135, sat.vel.y - 4.5 * dt);
    }

    sat.pos.addScaledVector(sat.vel, dt);
    if (this.satMesh) {
      this.satMesh.position.copy(sat.pos);
      this.satMesh.rotation.set(t * 1.4, t * 2.1, t * 0.8);
    }

    this.smokeAcc += dt * 28;
    while (this.smokeAcc >= 1) {
      this.smokeAcc -= 1;
      host.particles.emit('fire', sat.pos, sat.vel.clone().multiplyScalar(0.1), { scale: 1.4, life: 0.4 });
      host.particles.emit('darkSmoke', sat.pos, undefined, { scale: 1.2, life: 0.9 });
    }

    const surf = host.field.surfaceAt(sat.pos.x, sat.pos.z);
    if (sat.pos.y <= surf + 2) {
      sat.alive = false;
      host.explosions.blast(new THREE.Vector3(sat.pos.x, surf + 1, sat.pos.z), 16, { debris: 24, burn: true });
      return this.failEmergency(host, ev, 'The satellite impacted the sea, sir. Telemetry lost.');
    }

    ev.pos.copy(sat.pos);
    ev.timerSec = Math.max(0, (sat.pos.y - surf) / Math.max(15, -sat.vel.y));
    ev.progress01 = THREE.MathUtils.clamp(Math.max(this.satCatchT / SATELLITE_CATCH_TIME, 1 - sat.hp / sat.maxHp), 0, 1);
    return ev;
  }

  private updateBomberWing(dt: number, host: EmergencyHost, ev: ActiveEmergency): ActiveEmergency {
    ev.timerSec = Math.max(0, ev.timerSec - dt);
    const total = this.wingBombers.length;
    const alive = this.wingBombers.filter((b) => b.alive);
    const destroyed = total - alive.length;
    ev.progress01 = total > 0 ? destroyed / total : 1;

    if (total > 0 && alive.length === 0) {
      return this.completeEmergency(host, ev, BOMBER_WING_RD_REWARD, BOMBER_WING_OVERCHARGE, 'COASTAL BOMBER INTERCEPT', 'bomberWingIntercept', 'Coastal bomber wing eliminated, sir. The shoreline is clear.');
    }

    if (alive.length > 0) {
      ev.pos.copy(alive[0].pos);
      ev.objective = `INTERCEPT ${alive.length}/${total} LOW-LEVEL BOMBERS`;
    }

    if (ev.timerSec <= 0) {
      return this.failEmergency(host, ev, 'The rogue bombers slipped past our coastal screen, sir.');
    }
    return ev;
  }

  private updateDistressFlare(dt: number, t: number, playerPos: THREE.Vector3, host: EmergencyHost, ev: ActiveEmergency): ActiveEmergency {
    ev.timerSec = Math.max(0, ev.timerSec - dt);

    if (this.distressBeacon) {
      const m = this.distressBeacon.material as THREE.MeshStandardMaterial;
      m.emissiveIntensity = 3 + 4 * Math.max(0, Math.sin(t * 7));
    }

    this.flareT -= dt;
    if (this.flareT <= 0) {
      this.flareT = 1.6;
      const top = this._v.copy(ev.pos).add(new THREE.Vector3(0, 3.5, 0));
      host.particles.burst('spark', top, 10, 16, new THREE.Vector3(0, 1, 0), 0.7, { scale: 1.1 });
      host.particles.emit('fire', top, new THREE.Vector3(0, 14, 0), { scale: 1.1, life: 0.7 });
      host.particles.emit('darkSmoke', ev.pos, new THREE.Vector3(0, 4, 0), { scale: 1.5, life: 1.8 });
    }

    const totalGuards = this.distressGuards.length;
    const aliveGuards = this.distressGuards.filter((d) => d.alive).length;
    const guardsCleared = aliveGuards === 0;

    if (!this.podSecured && playerPos.distanceTo(ev.pos) <= DISTRESS_RESCUE_RADIUS) {
      this.podSecured = true;
      host.events.emit('jarvis', {
        text: guardsCleared
          ? 'Survivor pod secured, sir.'
          : 'Survivor pod stabilized, sir — clear the remaining escort drones.',
        at: ev.pos,
      });
    }

    const guardShare = totalGuards > 0 ? 0.5 * ((totalGuards - aliveGuards) / totalGuards) : 0.5;
    ev.progress01 = guardShare + (this.podSecured ? 0.5 : 0);

    if (!guardsCleared && !this.podSecured) {
      ev.objective = `CLEAR ${aliveGuards}/${totalGuards} ESCORT DRONES & SECURE SURVIVOR POD`;
    } else if (!guardsCleared) {
      ev.objective = `ELIMINATE ${aliveGuards} REMAINING ESCORT DRONES`;
    } else if (!this.podSecured) {
      ev.objective = 'FLY TO SURVIVOR POD TO RESCUE';
    }

    if (guardsCleared && this.podSecured) {
      return this.completeEmergency(host, ev, DISTRESS_RD_REWARD, DISTRESS_OVERCHARGE, 'OFFSHORE RESCUE', 'offshoreRescue', 'Coast Guard is inbound to the survivor pod, sir. Well done.');
    }

    if (ev.timerSec <= 0) {
      return this.failEmergency(host, ev, 'The vessel went under before we could secure the survivors, sir.');
    }
    return ev;
  }

  private completeEmergency(
    host: EmergencyHost,
    ev: ActiveEmergency,
    rd: number,
    overcharge: number,
    reason: string,
    ocReason: string,
    jarvisLine: string,
  ): ActiveEmergency {
    ev.result = 'completed';
    ev.progress01 = 1;
    this.lingerT = EMERGENCY_RESULT_LINGER;
    this.lastReward = { rd, overcharge, reason };
    if (host.awardRd) host.awardRd(rd, reason);
    else host.events.emit('rdAward', { value: rd, text: reason, at: ev.pos });
    host.feedOvercharge?.(overcharge, ocReason, ev.pos);
    host.events.emit('jarvis', { text: jarvisLine, at: ev.pos });
    this.clearVisuals();
    return ev;
  }

  private failEmergency(host: EmergencyHost, ev: ActiveEmergency, jarvisLine: string): ActiveEmergency {
    ev.result = 'failed';
    this.lingerT = EMERGENCY_RESULT_LINGER;
    host.events.emit('jarvis', { text: jarvisLine, at: ev.pos });
    this.clearVisuals();
    return ev;
  }

  private clearVisuals(): void {
    if (this.satMesh) {
      this.group.remove(this.satMesh);
      this.satMesh = null;
    }
    if (this.distressPodMesh) {
      this.group.remove(this.distressPodMesh);
      this.distressPodMesh = null;
      this.distressBeacon = null;
    }
  }
}
