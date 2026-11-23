import * as THREE from 'three';
import { CRUISE_DEF, CruiseMissileMission } from './cruiseMissile';
import { RESCUE_DEF, RescueMission } from './rescueMission';
import { STEALTH_DEF, StealthStrikeMission } from './stealthStrike';
import {
  unregisterHostile,
  type MissionCombatAdapter,
  type MissionContext,
  type MissionControls,
  type MissionDefinition,
  type MissionId,
  type MissionInstance,
  type MissionTelemetry,
  type RivalHostile,
} from './types';

/**
 * Rival Suit Duel mission:
 * Launches the Supersonic Rival Ace directly via `combat.spawnRival()` and
 * tracks its health, Unibeam charge warnings, and high-altitude icing state.
 */
export const RIVAL_DEF: MissionDefinition = {
  id: 'rival',
  code: 'OP-04',
  title: 'RIVAL SUIT DUEL',
  subtitle: 'IRON VS. IRON',
  summary:
    'Intercept a supersonic rogue powered-armour ace over the Malibu coast. Outfly its twin repulsors and unibeam — or lure it past its high-altitude icing ceiling.',
  rewardLabel: '350 R&D',
  difficulty: 'EXTREME',
};

export const RIVAL_CLEAR_REWARD = 350;
/** Seconds a victory / failed debrief banner stays up before returning to free flight. */
export const MISSION_DEBRIEF_SECONDS = 4.5;

export const MISSIONS: readonly MissionDefinition[] = [RESCUE_DEF, CRUISE_DEF, STEALTH_DEF, RIVAL_DEF];

/** Whether the Rival Ace spawner is available on `Combat`. */
export function isRivalAvailable(combat: MissionCombatAdapter): boolean {
  return typeof combat.spawnRival === 'function';
}

export class RivalDuelMission implements MissionInstance {
  readonly def = RIVAL_DEF;
  outcome: 'active' | 'victory' | 'failed' = 'active';

  rival: RivalHostile | null = null;
  unavailable = false;
  private rewardAwarded = 0;
  private resultSummary = '';

  start(ctx: MissionContext): void {
    this.outcome = 'active';
    this.rival = null;
    this.unavailable = false;
    this.rewardAwarded = 0;
    this.resultSummary = '';

    if (typeof ctx.combat.spawnRival !== 'function') {
      this.unavailable = true;
      this.outcome = 'failed';
      this.resultSummary = 'RIVAL ACE MODULE STANDBY — NOT YET INTEGRATED';
      ctx.playCue?.('warning');
      ctx.events.emit('jarvis', {
        text: 'Rival Ace intercept telemetry is offline, sir — awaiting rival suit module integration.',
      });
      return;
    }

    this.rival = ctx.combat.spawnRival(ctx.model.pos);
    ctx.playCue?.('start');
    ctx.events.emit('jarvis', {
      text: 'Rogue powered-armour signature inbound at supersonic speed, sir! Watch for its unibeam — or test its alloy at high altitude.',
    });
  }

  update(_dt: number, ctx: MissionContext, _controls: MissionControls): MissionTelemetry {
    const r = this.rival;
    if (this.outcome === 'active' && r && !r.alive) {
      this.outcome = 'victory';
      this.rewardAwarded = RIVAL_CLEAR_REWARD;
      ctx.awardRd(RIVAL_CLEAR_REWARD, 'RIVAL ACE DEFEATED');
      ctx.playCue?.('success');
      this.resultSummary = `RIVAL ACE NEUTRALIZED · +${RIVAL_CLEAR_REWARD} R&D`;
      ctx.events.emit('jarvis', { text: 'Rogue armour neutralized, sir. Only one Iron Man in this sky.' });
    }

    const hp01 = r && r.maxHp > 0 ? Math.max(0, r.hp / r.maxHp) : 0;
    const iced = !!r?.iced;
    const chargingBeam = !!r?.chargingBeam;

    return {
      id: this.def.id,
      code: this.def.code,
      title: this.def.title,
      phase: this.outcome === 'active' ? 'active' : this.outcome,
      objective:
        this.outcome === 'victory'
          ? 'RIVAL ACE DEFEATED'
          : this.unavailable
            ? 'RIVAL MODULE STANDBY'
            : 'NEUTRALIZE RIVAL ARMORED ACE',
      subObjective:
        this.outcome !== 'active'
          ? this.resultSummary
          : iced
            ? 'RIVAL ICED OUT — PRESS THE ATTACK (2× DAMAGE)!'
            : 'ENGAGE OR LURE ABOVE 8,800 M TO FREEZE ITS ALLOY',
      progressText: r && r.alive ? `RIVAL ARMOUR ${Math.ceil(hp01 * 100)}%` : undefined,
      progress01: 1 - hp01,
      timerSec: null,
      warning: chargingBeam ? 'RIVAL UNIBEAM CHARGING — EVADE!' : null,
      badge:
        this.outcome === 'active' && r
          ? iced
            ? { text: 'RIVAL FROZEN', tone: 'cyan' }
            : { text: '1V1 DUEL', tone: 'red' }
          : null,
      meter:
        this.outcome === 'active' && r
          ? {
              label: r.label ?? 'RIVAL ACE',
              value: hp01,
              tone: hp01 < 0.3 ? 'amber' : 'red',
              detail: `${Math.ceil(hp01 * 100)}%`,
            }
          : null,
      waypoints:
        this.outcome === 'active' && r && r.alive
          ? [
              {
                id: `rival-${r.id}`,
                label: r.label ?? 'RIVAL ACE',
                pos: r.pos.clone(),
                color: 'red',
                pulse: true,
                detail: `${Math.ceil(hp01 * 100)}% HP`,
              },
            ]
          : [],
      resultSummary: this.resultSummary || undefined,
      rewardAwarded: this.rewardAwarded || undefined,
    };
  }

  cleanup(ctx: MissionContext): void {
    if (this.rival && this.rival.alive) {
      const r = this.rival;
      r.alive = false;
      r.mode = 'dying';
      r.crashed = true;
      r.disposeFlares?.(ctx.combat.group);
      if (r.mesh) {
        r.mesh.visible = false;
        ctx.combat.group.remove(r.mesh);
      }
      unregisterHostile(ctx.combat, r);
    }
    this.rival = null;
  }
}

function createMission(id: MissionId): MissionInstance {
  switch (id) {
    case 'rescue':
      return new RescueMission();
    case 'cruise':
      return new CruiseMissileMission();
    case 'stealth':
      return new StealthStrikeMission();
    case 'rival':
      return new RivalDuelMission();
  }
}

/**
 * Coordinates standalone missions without breaking Free Flight or Wave Defense.
 * Pauses auto-wave spawning while a mission runs, restores it cleanly when the
 * mission completes or aborts, and exposes live {@link telemetry} for the HUD.
 */
export class MissionManager {
  readonly group = new THREE.Group();
  readonly completed = new Set<MissionId>();
  private active: MissionInstance | null = null;
  private prevWavesEnabled = true;
  private debriefT = 0;
  private latestTelemetry: MissionTelemetry | null = null;
  private readonly ctx: MissionContext;

  constructor(ctx: Omit<MissionContext, 'root'>) {
    this.group.name = 'missions';
    this.ctx = { ...ctx, root: this.group };
  }

  /** All mission definitions shown in the launcher drawer. */
  get definitions(): readonly MissionDefinition[] {
    return MISSIONS;
  }

  /** Currently running mission instance, or null in free flight / debrief. */
  get current(): MissionInstance | null {
    return this.active;
  }

  /** Current mission ID while active, or null. */
  get activeId(): MissionId | null {
    return this.active ? this.active.def.id : null;
  }

  /** Latest HUD telemetry (active mission or brief victory/failed debrief card). */
  get telemetry(): MissionTelemetry | null {
    return this.latestTelemetry;
  }

  /** Whether the optional Rival Ace module is present on Combat. */
  get rivalAvailable(): boolean {
    return isRivalAvailable(this.ctx.combat);
  }

  /** Launch a standalone mission (cleanly replacing any active one). */
  startMission(id: MissionId): boolean {
    if (this.active) {
      this.active.cleanup(this.ctx);
      this.active = null;
      this.ctx.combat.wavesEnabled = this.prevWavesEnabled;
    }

    this.prevWavesEnabled = this.ctx.combat.wavesEnabled;
    this.ctx.combat.wavesEnabled = false;
    this.debriefT = 0;

    const mission = createMission(id);
    mission.start(this.ctx);

    // If a mission failed immediately on start (e.g. Rival module not yet wired),
    // restore wave spawning right away and show a brief debrief toast.
    if (mission.outcome !== 'active') {
      this.latestTelemetry = mission.update(0, this.ctx, { vertical: 0, boost: false, brake: false, pressed: new Set() });
      mission.cleanup(this.ctx);
      this.ctx.combat.wavesEnabled = this.prevWavesEnabled;
      this.debriefT = MISSION_DEBRIEF_SECONDS;
      return false;
    }

    this.active = mission;
    this.latestTelemetry = mission.update(0, this.ctx, { vertical: 0, boost: false, brake: false, pressed: new Set() });
    return true;
  }

  /** Abort the active mission and return cleanly to free flight. */
  abortMission(silent = false): void {
    if (!this.active) {
      this.latestTelemetry = null;
      this.debriefT = 0;
      return;
    }
    this.active.cleanup(this.ctx);
    this.active = null;
    this.latestTelemetry = null;
    this.debriefT = 0;
    this.ctx.combat.wavesEnabled = this.prevWavesEnabled;
    if (!silent) {
      this.ctx.events.emit('jarvis', { text: 'Mission aborted. Returning to free flight, sir.' });
    }
  }

  /** Advance active mission or debrief timer by `dt` seconds. */
  update(dt: number, controls: MissionControls): MissionTelemetry | null {
    if (this.active) {
      this.latestTelemetry = this.active.update(dt, this.ctx, controls);
      if (this.active.outcome !== 'active') {
        if (this.active.outcome === 'victory') {
          this.completed.add(this.active.def.id);
        }
        this.active.cleanup(this.ctx);
        this.active = null;
        this.ctx.combat.wavesEnabled = this.prevWavesEnabled;
        this.debriefT = MISSION_DEBRIEF_SECONDS;
      }
      return this.latestTelemetry;
    }

    if (this.debriefT > 0) {
      this.debriefT -= dt;
      if (this.debriefT <= 0) {
        this.debriefT = 0;
        this.latestTelemetry = null;
      }
    }
    return this.latestTelemetry;
  }
}
