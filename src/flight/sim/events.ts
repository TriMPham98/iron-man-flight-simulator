import type * as THREE from 'three';

/**
 * Everything that happens in the sky, as it happens: the sound engine, the
 * HUD and the capture recorder all listen here instead of reaching into
 * the systems that caused it.
 */
export type SimEventKind =
  // Suit
  | 'takeoff'
  | 'landed'
  | 'touchdown'
  | 'heroLanding'
  | 'footstep'
  | 'splash'
  /** Skipped off the sea at a shallow angle: value = closing speed (m/s). */
  | 'skip'
  /** Set down on the pad: value = offset from its centre (m), text = the grade. */
  | 'padLanding'
  /** The hover computer has (value 1) or has let go of (0) the pad. */
  | 'padCapture'
  /** Auto-land engaged (value 1) or handed back / done (0). */
  | 'autoLand'
  | 'sonicBoom'
  | 'boostStart'
  | 'boostEnd'
  | 'freefall'
  | 'flapServo'
  // Weapons
  | 'repulsorCharge'
  | 'repulsorFire'
  | 'repulsorHit'
  | 'minigunStart'
  | 'minigunFire'
  | 'minigunStop'
  | 'minigunHit'
  /** War Machine's gauntlet autocannons. */
  | 'cannonFire'
  | 'cannonHit'
  | 'siloOpen'
  | 'siloClose'
  | 'lockTick'
  | 'lockFull'
  | 'missileLaunch'
  | 'launcherFire'
  | 'unibeamCharge'
  | 'unibeamFire'
  | 'unibeamEnd'
  | 'flareSalvo'
  | 'flarePop'
  | 'weaponDeploy'
  | 'weaponStow'
  | 'laserCutterFire'
  // Reactor power routing
  | 'reactorMode'
  | 'reactorOvercharge'
  // World
  | 'explosion'
  | 'bigExplosion'
  | 'treeCut'
  | 'treeFall'
  | 'hitArmor'
  | 'ricochet'
  | 'enemyFire'
  | 'enemyMissile'
  | 'missileWarning'
  | 'missileDecoyed'
  | 'droneFlyby'
  | 'kill'
  /** A hostile counted down (by any weapon, or a frigate gone under): text = drone / sam / ship / frigate. */
  | 'destroyed'
  /** R&D points earned: value = points, text = what for. */
  | 'rdAward'
  | 'waveStart'
  | 'waveClear'
  | 'suitCritical'
  | 'reboot'
  /** Knocked out with no reserve left: value = the wave reached. */
  | 'suitLost'
  /** A fresh run from the pad after the suit was lost. */
  | 'redeploy'
  | 'jarvis'
  /** A round came down on the house: value = what's left of it (0–1). */
  | 'houseHit'
  /** The house is gone (and the run with it). */
  | 'houseLost'
  /** An inbound round shot out of the air (the suit's point defence, or the house's): text = suit / house. */
  | 'intercept'
  /** Physics-combat events: hero-landing slam kill, kinetic ram kill, enemy frozen/iced out. */
  | 'heroSlam'
  | 'kineticRam'
  | 'enemyIced'
  | 'iceKill'
  /** Bomber open-bay payload chain-detonation: value = extra escort kills. */
  | 'payloadDetonation'
  /** R&D Capstone & House Party Protocol events. */
  | 'repulsorPulse'
  | 'reactivePulse'
  | 'housePartyLaunch'
  | 'hotSwapLaunch'
  | 'hotSwapCatch'
  // Lateral Strafe & Close-Quarters
  | 'strafeDash'
  | 'grappleGrab'
  | 'grappleThrow'
  | 'thrusterPunch'
  // Picture (directed reels)
  | 'cameraCut';

export interface SimEvent {
  kind: SimEventKind;
  /** World position (for spatial sound / HUD markers). */
  at?: THREE.Vector3;
  /** Magnitude (impact speed, explosion size, damage …). */
  value?: number;
  side?: 'L' | 'R';
  text?: string;
  /** Sim time (s). */
  t: number;
}

type Listener = (e: SimEvent) => void;

export class EventBus {
  private readonly listeners: Listener[] = [];
  time = 0;

  on(fn: Listener): void {
    this.listeners.push(fn);
  }

  emit(kind: SimEventKind, init: Omit<SimEvent, 'kind' | 't'> = {}): void {
    const e: SimEvent = { kind, t: this.time, ...init };
    if (e.at) e.at = e.at.clone();
    for (const fn of this.listeners) fn(e);
  }
}
