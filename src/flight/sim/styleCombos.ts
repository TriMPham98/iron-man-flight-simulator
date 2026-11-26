import * as THREE from 'three';
import type { EventBus } from './events';
import type { ReactorPower } from './reactorPower';

/** Minimum airspeed (m/s) required to build Proximity Adrenaline. */
export const PROXIMITY_MIN_SPEED = 55;
/** Maximum clearance (m) to ground/water/landmark to trigger Proximity Adrenaline. */
export const PROXIMITY_MAX_CLEARANCE = 15;
/** Seconds between periodic `'PROXIMITY SKIM'` style ticks while skimming. */
export const PROXIMITY_TICK_INTERVAL = 1.2;
/** Base continuous Overcharge feed rate (per second) at peak proximity intensity. */
export const PROXIMITY_OVERCHARGE_RATE = 0.065;
/** Maximum miss distance (m) for a hostile missile close-call dodge. */
export const MISSILE_NEAR_MISS_DIST = 14;
/** Overcharge bonus awarded per skill event. */
export const NEAR_MISS_OVERCHARGE = 0.12;
export const ORDNANCE_INTERCEPT_OVERCHARGE = 0.14;
export const SNAP_REVERSAL_OVERCHARGE = 0.1;
export const SONIC_KILL_OVERCHARGE = 0.18;
/** Duration (s) of the crit window unlocked by a Snap Reversal. */
export const REVERSAL_CRIT_WINDOW = 1.5;
/** Seconds before an idle style combo expires. */
export const COMBO_DECAY_SEC = 5.0;
/** Default micro hit-stop duration (s) and time dilation scale. */
export const DEFAULT_HITSTOP_DURATION = 0.055;
export const DEFAULT_HITSTOP_SCALE = 0.12;

export type StyleReason =
  | 'proximitySkim'
  | 'missileNearMiss'
  | 'ordnanceIntercept'
  | 'snapReversal'
  | 'sonicKill';

export interface StyleFeedItem {
  label: string;
  reason: StyleReason;
  points: number;
  multiplier: number;
  overcharge: number;
  rdBonus: number;
}

export interface StyleFlightState {
  grounded: boolean;
  speed: number;
  swing: number;
  pos: THREE.Vector3;
  vel?: THREE.Vector3;
}

const clamp = THREE.MathUtils.clamp;

/**
 * Tracks skill-driven flight style, Proximity Adrenaline, combo multipliers,
 * micro hit-stop time dilation, and feeds earned Overcharge into `ReactorPower`.
 */
export class StyleComboTracker {
  /** 0–1 intensity when skimming terrain, water, or landmarks at high speed. */
  proximityIntensity = 0;
  /** Accumulated style score for the current run. */
  score = 0;
  /** Number of chained style actions in the current combo window. */
  comboCount = 0;
  /** Seconds left before the current combo expires. */
  comboTimer = 0;
  /** Remaining real-time seconds of active micro hit-stop. */
  hitStopTimer = 0;
  /** Active simulation time-scale (1 normally, <1 during micro hit-stop). */
  timeScale = 1;
  /** Remaining seconds in the Snap-Reversal crit window (`> 0` => ready). */
  reversalCritTimer = 0;

  private hitStopScale = DEFAULT_HITSTOP_SCALE;
  private proximityTickTimer = 0;
  private inSwingReversal = false;
  private reversalCooldown = 0;
  private readonly feedQueue: StyleFeedItem[] = [];

  constructor(
    private readonly reactor?: ReactorPower,
    private readonly events?: EventBus,
  ) {}

  /** Current combo score multiplier (1.0× up to 5.0×). */
  get comboMultiplier(): number {
    return 1 + Math.min(4, Math.max(0, this.comboCount - 1) * 0.5);
  }

  /** True during the 1.5 s crit window following a Momentum-Swing Reversal. */
  get reversalCritReady(): boolean {
    return this.reversalCritTimer > 0;
  }

  /** Consume an active Snap-Reversal crit window if ready. */
  consumeReversalCrit(): boolean {
    if (this.reversalCritTimer <= 0) return false;
    this.reversalCritTimer = 0;
    return true;
  }

  /**
   * Trigger a brief micro hit-stop / time-scale dip for big impacts
   * (e.g., dive-slam, grapple hurl impact, sonic takedown).
   */
  triggerHitStop(durationSec = DEFAULT_HITSTOP_DURATION, slowScale = DEFAULT_HITSTOP_SCALE): void {
    if (durationSec <= 0 || !Number.isFinite(durationSec)) return;
    this.hitStopTimer = Math.max(this.hitStopTimer, durationSec);
    this.hitStopScale = clamp(slowScale, 0.01, 1);
    this.timeScale = this.hitStopScale;
  }

  /**
   * Return the scaled simulation delta time (`rawDt * timeScale`).
   * Pure with respect to timers; call `update(rawDt, ...)` each frame to
   * advance `hitStopTimer` and restore `timeScale`.
   */
  effectiveDt(rawDt: number): number {
    return Math.max(0, rawDt) * this.timeScale;
  }

  /**
   * Advance hit-stop, proximity adrenaline, momentum-swing reversal detection,
   * and combo decay. Pass `rawDt` (unscaled frame delta).
   */
  update(rawDt: number, model?: StyleFlightState, clearance = Infinity, aimDir?: THREE.Vector3): void {
    const stepRaw = Math.max(0, rawDt);
    if (this.hitStopTimer > 0) {
      this.hitStopTimer = Math.max(0, this.hitStopTimer - stepRaw);
      if (this.hitStopTimer <= 0) this.timeScale = 1;
      else this.timeScale = this.hitStopScale;
    } else {
      this.timeScale = 1;
    }

    const dt = this.effectiveDt(stepRaw);
    this.reversalCritTimer = Math.max(0, this.reversalCritTimer - dt);
    this.reversalCooldown = Math.max(0, this.reversalCooldown - dt);

    if (this.comboTimer > 0) {
      this.comboTimer = Math.max(0, this.comboTimer - dt);
      if (this.comboTimer <= 0) this.comboCount = 0;
    }

    if (!model) return;

    // ── Proximity Adrenaline ─────────────────────────────────────────
    const skimming = !model.grounded && model.speed > PROXIMITY_MIN_SPEED && clearance < PROXIMITY_MAX_CLEARANCE;
    if (skimming) {
      const distK = clamp((PROXIMITY_MAX_CLEARANCE - Math.max(0, clearance)) / (PROXIMITY_MAX_CLEARANCE - 2), 0, 1);
      const speedK = clamp((model.speed - PROXIMITY_MIN_SPEED) / 145, 0.25, 1);
      const target = clamp(distK * 0.7 + speedK * 0.3, 0.15, 1);
      this.proximityIntensity += (target - this.proximityIntensity) * (1 - Math.exp(-dt / 0.35));
      this.proximityIntensity = clamp(this.proximityIntensity, 0, 1);

      if (this.comboCount === 0) this.comboCount = 1;
      this.comboTimer = Math.max(this.comboTimer, 2.0);

      const oc = PROXIMITY_OVERCHARGE_RATE * (0.4 + 0.6 * this.proximityIntensity) * dt;
      this.reactor?.feedStyleOvercharge(oc, 'proximitySkim', model.pos);

      this.proximityTickTimer += dt;
      if (this.proximityTickTimer >= PROXIMITY_TICK_INTERVAL) {
        this.proximityTickTimer -= PROXIMITY_TICK_INTERVAL;
        this.awardStyle('PROXIMITY SKIM', 'proximitySkim', 35, 0, model.pos);
      }
    } else {
      this.proximityIntensity *= Math.exp(-dt / 0.45);
      if (this.proximityIntensity < 1e-4) this.proximityIntensity = 0;
      this.proximityTickTimer = 0;
    }

    // ── Momentum-Swing Reversal ──────────────────────────────────────
    const largeAimReversal = !!(
      aimDir &&
      model.vel &&
      model.speed > PROXIMITY_MIN_SPEED &&
      model.vel.dot(aimDir) / model.speed < -0.35 &&
      model.swing > 0.2
    );
    const swinging = !model.grounded && model.speed > 45 && (model.swing > 0.35 || largeAimReversal);
    if (swinging && !this.inSwingReversal && this.reversalCooldown <= 0) {
      this.inSwingReversal = true;
      this.reversalCooldown = 2.0;
      this.reversalCritTimer = REVERSAL_CRIT_WINDOW;
      this.awardStyle('SNAP REVERSAL', 'snapReversal', 150, SNAP_REVERSAL_OVERCHARGE, model.pos);
    } else if (model.swing < 0.15) {
      this.inSwingReversal = false;
    }
  }

  /**
   * Record a hostile missile passing within close range without hitting.
   * Returns true if within `MISSILE_NEAR_MISS_DIST` and awarded.
   */
  recordMissileNearMiss(dist: number, at?: THREE.Vector3): boolean {
    if (!Number.isFinite(dist) || dist < 0 || dist > MISSILE_NEAR_MISS_DIST) return false;
    const basePoints = Math.round(120 + (MISSILE_NEAR_MISS_DIST - dist) * 8);
    this.awardStyle('CLOSE CALL', 'missileNearMiss', basePoints, NEAR_MISS_OVERCHARGE, at);
    return true;
  }

  /**
   * Record shooting down an incoming missile or falling bomb mid-air.
   * Returns total style points awarded.
   */
  recordOrdnanceIntercept(kind = 'missile', at?: THREE.Vector3): number {
    const basePoints = kind === 'bomb' ? 160 : 140;
    return this.awardStyle('ORDNANCE INTERCEPT', 'ordnanceIntercept', basePoints, ORDNANCE_INTERCEPT_OVERCHARGE, at);
  }

  /**
   * Record a supersonic / sonic-boom takedown.
   * Returns total style points awarded.
   */
  recordSonicKill(at?: THREE.Vector3): number {
    return this.awardStyle('SONIC TAKEDOWN', 'sonicKill', 200, SONIC_KILL_OVERCHARGE, at);
  }

  /** Drain queued style callout items for HUD display & R&D combo bonuses. */
  consumeStyleFeed(): StyleFeedItem[] {
    if (this.feedQueue.length === 0) return [];
    return this.feedQueue.splice(0, this.feedQueue.length);
  }

  /** Reset all combo, proximity, and hit-stop state for a fresh run. */
  reset(): void {
    this.proximityIntensity = 0;
    this.score = 0;
    this.comboCount = 0;
    this.comboTimer = 0;
    this.hitStopTimer = 0;
    this.timeScale = 1;
    this.hitStopScale = DEFAULT_HITSTOP_SCALE;
    this.reversalCritTimer = 0;
    this.proximityTickTimer = 0;
    this.inSwingReversal = false;
    this.reversalCooldown = 0;
    this.feedQueue.length = 0;
  }

  private awardStyle(
    label: string,
    reason: StyleReason,
    basePoints: number,
    overchargeAmount: number,
    at?: THREE.Vector3,
  ): number {
    this.comboCount++;
    this.comboTimer = COMBO_DECAY_SEC;
    const mult = this.comboMultiplier;
    const points = Math.round(basePoints * mult);
    this.score += points;
    const added = overchargeAmount > 0 ? (this.reactor?.feedStyleOvercharge(overchargeAmount, reason, at) ?? overchargeAmount) : 0;
    const rdBonus = Math.max(0, Math.round(points * 0.05));
    this.feedQueue.push({
      label,
      reason,
      points,
      multiplier: mult,
      overcharge: added,
      rdBonus,
    });
    if (rdBonus > 0) this.events?.emit('rdAward', { at, value: rdBonus, text: label });
    return points;
  }
}
