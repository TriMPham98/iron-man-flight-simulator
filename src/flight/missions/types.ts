import * as THREE from 'three';
import type { Drone, DroneType, Round } from '../combat/drones';
import type { Explosions } from '../combat/explosions';
import type { Missiles } from '../combat/missiles';
import type { Hostile, HouseTarget, PlayerTarget } from '../combat/types';
import type { Particles } from '../fx/particles';
import type { EventBus } from '../sim/events';

export type MissionId = 'rescue' | 'cruise' | 'stealth' | 'rival';

export type MissionPhase = 'briefing' | 'active' | 'victory' | 'failed';

export type MissionTone = 'cyan' | 'amber' | 'red' | 'green';

export interface MissionDefinition {
  readonly id: MissionId;
  readonly code: string;
  readonly title: string;
  readonly subtitle: string;
  readonly summary: string;
  readonly rewardLabel: string;
  readonly difficulty: 'STANDARD' | 'HIGH' | 'EXTREME';
}

export interface WaypointMarker {
  readonly id: string;
  readonly label: string;
  readonly pos: THREE.Vector3;
  readonly color: MissionTone;
  readonly pulse?: boolean;
  readonly detail?: string;
}

export interface MissionMeter {
  readonly label: string;
  /** Normalized 0..1. */
  readonly value: number;
  readonly tone: MissionTone;
  readonly detail?: string;
}

export interface MissionBadge {
  readonly text: string;
  readonly tone: MissionTone;
}

export interface MissionTelemetry {
  readonly id: MissionId;
  readonly code: string;
  readonly title: string;
  readonly phase: MissionPhase;
  readonly objective: string;
  readonly subObjective?: string;
  readonly progressText?: string;
  readonly progress01?: number;
  readonly timerSec?: number | null;
  readonly warning?: string | null;
  readonly meter?: MissionMeter | null;
  readonly badge?: MissionBadge | null;
  readonly waypoints: readonly WaypointMarker[];
  readonly resultSummary?: string;
  readonly rewardAwarded?: number;
}

export interface MissionControls {
  readonly vertical: number;
  readonly boost: boolean;
  readonly brake: boolean;
  readonly pressed: ReadonlySet<string>;
  readonly aimY?: number;
}

export interface MissionModelView {
  readonly pos: THREE.Vector3;
  readonly vel: THREE.Vector3;
  readonly speed: number;
  readonly grounded: boolean;
  forward(out?: THREE.Vector3): THREE.Vector3;
}

export interface MissionWorldView {
  readonly inCloud: number;
  heightAt(x: number, z: number): number;
  surface(x: number, z: number): number;
  isWater(x: number, z: number): boolean;
}

/**
 * Clean typed slice of Combat that missions interact with, including the
 * optional `spawnRival` hook implemented in parallel by `rival-ace`.
 */
export interface MissionCombatAdapter {
  wavesEnabled: boolean;
  readonly group: THREE.Group;
  readonly hostiles: Hostile[];
  readonly drones: Drone[];
  readonly guns: { readonly rounds: Round[] };
  readonly missiles: Pick<Missiles, 'launch'>;
  readonly explosions: Pick<Explosions, 'blast' | 'muzzle'>;
  readonly playerTarget: PlayerTarget;
  readonly house: HouseTarget;
  spawnDrone(at: THREE.Vector3, heading: THREE.Vector3, type?: DroneType): Drone;
  spawnRival?: (near?: THREE.Vector3) => Hostile;
}

export type MissionCue = 'start' | 'warning' | 'lock' | 'ping' | 'success' | 'fail';

export interface MissionContext {
  readonly root: THREE.Group;
  readonly model: MissionModelView;
  readonly world: MissionWorldView;
  readonly combat: MissionCombatAdapter;
  readonly particles: Pick<Particles, 'emit' | 'burst'>;
  readonly events: Pick<EventBus, 'emit'>;
  readonly padPos: THREE.Vector3;
  readonly hazeUniforms?: Record<string, THREE.IUniform>;
  awardRd(points: number, reason: string): void;
  playCue?(cue: MissionCue): void;
}

export interface MissionInstance {
  readonly def: MissionDefinition;
  readonly outcome: 'active' | 'victory' | 'failed';
  start(ctx: MissionContext): void;
  update(dt: number, ctx: MissionContext, controls: MissionControls): MissionTelemetry;
  cleanup(ctx: MissionContext): void;
}

/** Remove a custom Hostile safely from Combat's hostile list. */
export function unregisterHostile(combat: MissionCombatAdapter, hostile: Hostile): void {
  const idx = combat.hostiles.indexOf(hostile);
  if (idx >= 0) combat.hostiles.splice(idx, 1);
}

/** Despawn a mission-spawned drone cleanly without triggering a kill explosion. */
export function despawnMissionDrone(combat: MissionCombatAdapter, drone: Drone): void {
  drone.alive = false;
  drone.crashed = true;
  combat.group.remove(drone.mesh);
  const di = combat.drones.indexOf(drone);
  if (di >= 0) combat.drones.splice(di, 1);
  const hi = combat.hostiles.indexOf(drone);
  if (hi >= 0) combat.hostiles.splice(hi, 1);
}
