import type * as THREE from 'three';
import type { EventBus } from './events';

/**
 * Live Arc Reactor power management ("Divert Power").
 *
 * The pilot can route reactor output on the fly between three axes —
 * THRUST (`Digit1`), WEAPONS (`Digit2`), SHIELDS (`Digit3`) — or return to
 * BALANCED (`Digit4`, or tapping the active mode's key again).
 *
 * Taking fire in SHIELDS mode, flying close to an exposed Dreadnought core,
 * riding out a warship detonation, or scoring unibeam kills feeds the
 * capacitor (`overcharge`, 0–1). At 100% (auto-triggered, or manual via
 * `KeyB` when `autoOvercharge` is false), the suit surges into an 8-second
 * 400% OVERCHARGE state that boosts all three axes simultaneously and
 * freezes unibeam heat.
 */

export type ReactorMode = 'BALANCED' | 'THRUST' | 'WEAPONS' | 'SHIELDS';
export type ReactorModeCode = 'BAL' | 'THR' | 'WPN' | 'SHD' | '400%';

export interface ReactorModifiers {
  /** Multiplier on boost top speed (1 = stock). */
  boostSpeed: number;
  /** Multiplier on boost thrust authority (1 = stock). */
  boostThrust: number;
  /** Additive turn G-limit headroom (g). */
  gLimitBonus: number;
  /** Multiplier on repulsor fire interval (<1 = faster fire rate). */
  repulsorInterval: number;
  /** Multiplier on repulsor bolt damage. */
  repulsorDamage: number;
  /** Multiplier on unibeam charge time (<1 = faster wind-up). */
  unibeamCharge: number;
  /** Multiplier on unibeam DPS. */
  unibeamDps: number;
  /** Multiplier on unibeam cool time (>1 = slower cooling, <1 = faster). */
  unibeamCool: number;
  /** Multiplier on missile/launcher reload time (>1 = slower, <1 = faster). */
  weaponReload: number;
  /** Multiplier on sweeping wrist laser cutter damage. */
  laserCutterDamage: number;
  /** Multiplier on incoming armor damage (<1 = more protection). */
  damageTaken: number;
  /** Multiplier on armor regen rate. */
  regenRate: number;
  /** Multiplier on armor regen delay (<1 = shorter quiet period). */
  regenDelay: number;
}

export const STOCK_REACTOR_MODIFIERS = (): ReactorModifiers => ({
  boostSpeed: 1,
  boostThrust: 1,
  gLimitBonus: 0,
  repulsorInterval: 1,
  repulsorDamage: 1,
  unibeamCharge: 1,
  unibeamDps: 1,
  unibeamCool: 1,
  weaponReload: 1,
  laserCutterDamage: 1,
  damageTaken: 1,
  regenRate: 1,
  regenDelay: 1,
});

/** Mode tuning tables. */
export const MODE_MODIFIERS: Record<ReactorMode, Readonly<ReactorModifiers>> = {
  BALANCED: STOCK_REACTOR_MODIFIERS(),
  THRUST: {
    ...STOCK_REACTOR_MODIFIERS(),
    boostSpeed: 1.18,
    boostThrust: 1.18,
    gLimitBonus: 1.5,
    // −30% reload / cool speed => 1 / 0.70 time multiplier
    unibeamCool: 1 / 0.7,
    weaponReload: 1 / 0.7,
  },
  WEAPONS: {
    ...STOCK_REACTOR_MODIFIERS(),
    // +30% repulsor fire rate & bolt damage
    repulsorInterval: 1 / 1.3,
    repulsorDamage: 1.3,
    // 25% faster unibeam charge & +25% DPS
    unibeamCharge: 0.75,
    unibeamDps: 1.25,
    laserCutterDamage: 1.35,
    // −25% armor regen rate
    regenRate: 0.75,
  },
  SHIELDS: {
    ...STOCK_REACTOR_MODIFIERS(),
    // −30% incoming armor damage, +60% regen rate, shorter delay
    damageTaken: 0.7,
    regenRate: 1.6,
    regenDelay: 0.65,
    // −15% boost top speed
    boostSpeed: 0.85,
  },
};

/** 400% OVERCHARGE: all three axes boosted simultaneously with no penalties. */
export const OVERCHARGE_MODIFIERS: Readonly<ReactorModifiers> = {
  boostSpeed: 1.25,
  boostThrust: 1.3,
  gLimitBonus: 2.0,
  repulsorInterval: 1 / 1.45,
  repulsorDamage: 1.45,
  unibeamCharge: 0.55,
  unibeamDps: 1.5,
  unibeamCool: 0.4,
  weaponReload: 0.5,
  laserCutterDamage: 1.65,
  damageTaken: 0.55,
  regenRate: 2.2,
  regenDelay: 0.4,
};

/** Duration of the 400% overcharge state (s). */
export const OVERCHARGE_DURATION = 8.0;
/** Minimum seconds between JARVIS power-routing callouts. */
export const REACTOR_CALLOUT_COOLDOWN = 3.0;
/** Maximum reactor heat (0–1) at which the wrist laser cutter may fire outside overcharge. */
export const LASER_CUTTER_MAX_HEAT = 0.4;
/** Reactor heat spike added when firing the wrist laser cutter. */
export const LASER_CUTTER_HEAT_COST = 0.55;
/** Cooldown between wrist laser cutter sweeps (s). */
export const LASER_CUTTER_COOLDOWN = 2.2;
/** Cooldown during 400% overcharge (s). */
export const LASER_CUTTER_OVERCHARGE_COOLDOWN = 1.2;

const MODE_CODES: Record<ReactorMode, ReactorModeCode> = {
  BALANCED: 'BAL',
  THRUST: 'THR',
  WEAPONS: 'WPN',
  SHIELDS: 'SHD',
};

const MODE_CALLOUTS: Record<ReactorMode, string> = {
  THRUST: 'Diverting power to thrusters, sir.',
  WEAPONS: 'Power routed to weapons systems, sir.',
  SHIELDS: 'Reinforcing armour plating. Power to shields, sir.',
  BALANCED: 'Arc reactor balanced across all systems, sir.',
};

/** Keybindings for reactor routing & manual overcharge (all conflict-free). */
export const REACTOR_KEYS = {
  THRUST: 'Digit1',
  WEAPONS: 'Digit2',
  SHIELDS: 'Digit3',
  BALANCED: 'Digit4',
  LASER_CUTTER: 'KeyC',
  OVERCHARGE: 'KeyB',
} as const;

export class ReactorPower {
  mode: ReactorMode = 'BALANCED';
  /** Live modifier struct shared by FlightModel, PlayerWeapons, and Combat (mutated in place). */
  readonly modifiers: ReactorModifiers = STOCK_REACTOR_MODIFIERS();
  /** Capacitor charge 0–1 while building, or remaining fraction (1→0) while overcharge is active. */
  overcharge = 0;
  /** Seconds left in 400% overcharge (0 when inactive). */
  overchargeRemaining = 0;
  /** Decaying 0–1 flash when overcharge triggers or mode switches. */
  overchargePulse = 0;
  modePulse = 0;
  /** Automatically enter 400% OVERCHARGE when `overcharge` hits 1.0. */
  autoOvercharge = true;
  /** Last reason string passed to `feedOvercharge` (for HUD / diagnostics). */
  lastFeedReason = '';

  private time = 0;
  private lastCalloutT = -Infinity;

  constructor(private readonly events?: EventBus) {}

  get overchargeActive(): boolean {
    return this.overchargeRemaining > 0;
  }

  get displayCode(): ReactorModeCode {
    return this.overchargeActive ? '400%' : MODE_CODES[this.mode];
  }

  /** Normalized per-axis bar levels (0–1) for the diegetic HUD indicator. */
  get axisLevels(): { thrust: number; weapons: number; shields: number } {
    if (this.overchargeActive) return { thrust: 1, weapons: 1, shields: 1 };
    switch (this.mode) {
      case 'THRUST':
        return { thrust: 1, weapons: 0.35, shields: 0.6 };
      case 'WEAPONS':
        return { thrust: 0.6, weapons: 1, shields: 0.35 };
      case 'SHIELDS':
        return { thrust: 0.35, weapons: 0.6, shields: 1 };
      default:
        return { thrust: 0.65, weapons: 0.65, shields: 0.65 };
    }
  }

  /**
   * Switch reactor routing mode. Requesting the already-active non-balanced
   * mode toggles cleanly back to BALANCED.
   */
  setMode(requested: ReactorMode, at?: THREE.Vector3): boolean {
    const next: ReactorMode = requested === this.mode && requested !== 'BALANCED' ? 'BALANCED' : requested;
    if (next === this.mode) return false;
    this.mode = next;
    this.modePulse = 1;
    this.syncModifiers();
    this.events?.emit('reactorMode', { at, text: next });
    if (this.time - this.lastCalloutT >= REACTOR_CALLOUT_COOLDOWN) {
      this.lastCalloutT = this.time;
      this.events?.emit('jarvis', { text: MODE_CALLOUTS[next] });
    }
    return true;
  }

  /** Read one-shot key presses for power allocation and manual overcharge. */
  handleInput(pressed: ReadonlySet<string>, at?: THREE.Vector3): void {
    if (pressed.has(REACTOR_KEYS.THRUST)) this.setMode('THRUST', at);
    else if (pressed.has(REACTOR_KEYS.WEAPONS)) this.setMode('WEAPONS', at);
    else if (pressed.has(REACTOR_KEYS.SHIELDS)) this.setMode('SHIELDS', at);
    else if (pressed.has(REACTOR_KEYS.BALANCED)) this.setMode('BALANCED', at);
    if (pressed.has(REACTOR_KEYS.OVERCHARGE)) this.triggerOvercharge(at);
  }

  /**
   * Feed energy into the overcharge capacitor (0–1). Exposed publicly so
   * combat, bosses, or missions can charge the suit's arc reactor.
   */
  feedOvercharge(amount: number, reason: string, at?: THREE.Vector3): number {
    if (amount <= 0 || !Number.isFinite(amount) || this.overchargeActive) return 0;
    const before = this.overcharge;
    this.overcharge = Math.min(1, this.overcharge + amount);
    const added = this.overcharge - before;
    if (added > 0) this.lastFeedReason = reason;
    if (this.overcharge >= 1 && this.autoOvercharge) {
      this.triggerOvercharge(at);
    }
    return added;
  }

  /**
   * Called when enemy fire strikes the suit's armour. In SHIELDS mode, a share
   * of incoming energy is shunted into the overcharge capacitor.
   */
  onArmorHit(rawAmount: number, at?: THREE.Vector3): number {
    if (this.mode !== 'SHIELDS' || this.overchargeActive || rawAmount <= 0) return 0;
    const gain = Math.min(0.32, rawAmount * 0.012);
    return this.feedOvercharge(gain, 'shieldAbsorb', at);
  }

  /** Trigger the 8-second 400% OVERCHARGE state once the capacitor is full. */
  triggerOvercharge(at?: THREE.Vector3): boolean {
    if (this.overchargeActive || this.overcharge < 1 - 1e-6) return false;
    this.overcharge = 1;
    this.overchargeRemaining = OVERCHARGE_DURATION;
    this.overchargePulse = 1;
    this.syncModifiers();
    this.events?.emit('reactorOvercharge', { at, value: 1 });
    this.events?.emit('jarvis', { text: 'Power at 400% capacity, sir.' });
    return true;
  }

  /** True when the wrist laser cutter is ready to fire. */
  canFireLaserCutter(unibeamHeat: number, unibeamOverheat: boolean, cutterCooldown: number): boolean {
    if (cutterCooldown > 0) return false;
    if (this.overchargeActive) return true;
    return !unibeamOverheat && unibeamHeat < LASER_CUTTER_MAX_HEAT;
  }

  update(dt: number, suitDown = false): void {
    this.time += dt;
    this.overchargePulse = Math.max(0, this.overchargePulse - dt * 1.4);
    this.modePulse = Math.max(0, this.modePulse - dt * 2.5);
    if (suitDown && this.overchargeActive) {
      this.overchargeRemaining = 0;
      this.overcharge = 0;
      this.syncModifiers();
      this.events?.emit('reactorOvercharge', { value: 0 });
      return;
    }
    if (this.overchargeRemaining > 0) {
      this.overchargeRemaining = Math.max(0, this.overchargeRemaining - dt);
      this.overcharge = this.overchargeRemaining / OVERCHARGE_DURATION;
      if (this.overchargeRemaining <= 0) {
        this.syncModifiers();
        this.events?.emit('reactorOvercharge', { value: 0 });
        this.events?.emit('reactorMode', { text: this.mode });
      }
    }
  }

  /** Reset back to balanced nominal power (fresh run / redeploy). */
  reset(): void {
    this.mode = 'BALANCED';
    this.overcharge = 0;
    this.overchargeRemaining = 0;
    this.overchargePulse = 0;
    this.modePulse = 0;
    this.lastFeedReason = '';
    this.syncModifiers();
  }

  private syncModifiers(): void {
    Object.assign(this.modifiers, this.overchargeActive ? OVERCHARGE_MODIFIERS : MODE_MODIFIERS[this.mode]);
  }
}
