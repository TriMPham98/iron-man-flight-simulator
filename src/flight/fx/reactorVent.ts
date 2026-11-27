import * as THREE from 'three';
import type { FlapId } from '../../animation/flightCheck';
import type { Suit } from '../../suit/Suit';
import type { ReactorMode } from '../sim/reactorPower';
import type { Particles } from './particles';

/**
 * Reactor re-route steam: on a power-mode switch the suit cracks the flight
 * flaps over the systems it is pulling power away from / into and blows
 * off pressure from under them — a hard jet that tears off into the
 * slipstream, then a lingering wisp as the plates close.
 */

export type VentKind = ReactorMode | 'PURGE';

interface VentProfile {
  flaps: readonly FlapId[];
  /** How far the plates open (0–1). */
  open: number;
  /** Seconds the jet blows (the flaps hold a beat longer). */
  dur: number;
  /** Jet exit speed (m/s, relative to the suit). */
  speed: number;
  /** Puffs per second per vent at the start of the blow. */
  rate: number;
  /** Puff size. */
  scale: number;
}

const LEGS: readonly FlapId[] = ['calf.L', 'calf.R', 'thigh.L', 'thigh.R'];
const UPPER: readonly FlapId[] = ['shoulder.L', 'shoulder.R', 'back.L', 'back.R'];

export const VENT_PROFILES: Record<VentKind, VentProfile> = {
  // Power down into the boots: the leg plates kick open and blast
  THRUST: { flaps: LEGS, open: 0.9, dur: 0.5, speed: 9, rate: 80, scale: 0.4 },
  // Into the arms: pauldrons and shoulder blades
  WEAPONS: { flaps: UPPER, open: 0.85, dur: 0.45, speed: 8, rate: 75, scale: 0.38 },
  // Bracing the shell: a slower, heavier blow down the whole back
  SHIELDS: { flaps: ['back.L', 'back.R', 'thigh.L', 'thigh.R', 'calf.L', 'calf.R'], open: 0.6, dur: 0.8, speed: 5.5, rate: 55, scale: 0.5 },
  // Settling back to nominal: a short sigh from the shoulder blades
  BALANCED: { flaps: ['back.L', 'back.R'], open: 0.55, dur: 0.35, speed: 6, rate: 50, scale: 0.34 },
  // Overcharge spent: every plate dumps the heat
  PURGE: { flaps: [...UPPER, ...LEGS], open: 1, dur: 1.1, speed: 10, rate: 70, scale: 0.48 },
};

/** The latch lets go before the gas gets out. */
const DELAY = 0.07;
const STEAM = new THREE.Color(0.93, 0.96, 1.0);

export class ReactorVentFx {
  private profile: VentProfile | null = null;
  private t = 0;
  private acc = 0;
  private readonly _at = new THREE.Vector3();
  private readonly _dir = new THREE.Vector3();
  private readonly _v = new THREE.Vector3();

  /** Start a vent; returns the profile so the flaps can be opened to match. Never cuts a bigger blow short. */
  trigger(kind: VentKind): VentProfile | null {
    const p = VENT_PROFILES[kind];
    if (this.profile && this.profile.dur - this.t > p.dur) return null;
    this.profile = p;
    this.t = 0;
    this.acc = 0;
    return p;
  }

  update(dt: number, suit: Suit, particles: Particles, vel: THREE.Vector3): void {
    const p = this.profile;
    if (!p) return;
    this.t += dt;
    const u = (this.t - DELAY) / p.dur;
    if (u >= 1) {
      this.profile = null;
      return;
    }
    if (u < 0) return;
    // Hard at the crack, tailing off as the pressure drops
    const k = Math.pow(1 - u, 1.4);
    this.acc += dt * p.rate * k;
    const n = Math.floor(this.acc);
    if (n === 0) return;
    this.acc -= n;
    for (const id of p.flaps) {
      if (!suit.flapVent(id, this._at, this._dir)) continue;
      for (let i = 0; i < n; i++) {
        const v = this._v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.5).add(this._dir).normalize();
        v.multiplyScalar(p.speed * (0.6 + 0.6 * Math.random()) * (0.45 + 0.55 * k)).add(vel);
        particles.emit('vapor', this._at, v, { scale: p.scale * (0.75 + 0.5 * Math.random()), life: 1.8 + 0.8 * k, color: STEAM, alpha: 0.9 + 0.5 * k });
      }
      // The cloud it leaves hanging
      if (Math.random() < 0.35 * k) {
        this._v.copy(this._dir).multiplyScalar(p.speed * 0.3).add(vel);
        particles.emit('mist', this._at, this._v, { scale: 0.16, life: 0.6, color: STEAM, alpha: 0.8 });
      }
    }
  }

  reset(): void {
    this.profile = null;
  }
}
