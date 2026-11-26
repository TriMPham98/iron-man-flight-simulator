import * as THREE from 'three';

/** Default micro hit-stop duration (s) and time dilation scale. */
export const DEFAULT_HITSTOP_DURATION = 0.055;
export const DEFAULT_HITSTOP_SCALE = 0.12;

/**
 * Brief micro hit-stop / time-scale dip for major combat impacts
 * (Dreadnought core destruction, Rival Suit takedown, Dive-Slam kills, Hot-Swap catches).
 */
export class HitStop {
  /** Remaining real-time seconds of active micro hit-stop. */
  hitStopTimer = 0;
  /** Active simulation time-scale (1 normally, <1 during micro hit-stop). */
  timeScale = 1;
  private hitStopScale = DEFAULT_HITSTOP_SCALE;

  trigger(durationSec = DEFAULT_HITSTOP_DURATION, slowScale = DEFAULT_HITSTOP_SCALE): void {
    if (durationSec <= 0 || !Number.isFinite(durationSec)) return;
    this.hitStopTimer = Math.max(this.hitStopTimer, durationSec);
    this.hitStopScale = THREE.MathUtils.clamp(slowScale, 0.01, 1);
    this.timeScale = this.hitStopScale;
  }

  effectiveDt(rawDt: number): number {
    return Math.max(0, rawDt) * this.timeScale;
  }

  update(rawDt: number): void {
    const dt = Math.max(0, rawDt);
    if (this.hitStopTimer > 0) {
      this.hitStopTimer = Math.max(0, this.hitStopTimer - dt);
      this.timeScale = this.hitStopTimer > 0 ? this.hitStopScale : 1;
    } else {
      this.timeScale = 1;
    }
  }

  reset(): void {
    this.hitStopTimer = 0;
    this.timeScale = 1;
    this.hitStopScale = DEFAULT_HITSTOP_SCALE;
  }
}
