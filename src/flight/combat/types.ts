import type * as THREE from 'three';

export type HostileKind = 'drone' | 'interceptor' | 'bomber' | 'jammer' | 'sam' | 'ship' | 'boss' | 'rival';

/** Kinds that fly (the HUD paints them red; the rest are amber). */
export const isAircraft = (k: HostileKind): boolean => k === 'drone' || k === 'interceptor' || k === 'bomber' || k === 'jammer' || k === 'rival';

/** Anything the suit can lock, shoot and blow up. */
export interface Hostile {
  readonly id: number;
  readonly kind: HostileKind;
  readonly pos: THREE.Vector3;
  readonly vel: THREE.Vector3;
  /** Hit sphere (m), or the capsule's radius round {@link span}. */
  readonly radius: number;
  /** A long hit shape: the ends of its spine, in world space (see hitShape). */
  readonly span?: readonly [THREE.Vector3, THREE.Vector3];
  /** What the HUD calls it, when its kind isn't enough. */
  readonly label?: string;
  /** The whole it's one piece of (a ship's parts share theirs). */
  readonly whole?: object;
  /** The seekers can't paint it (a jammer): it has to be shot down by hand. */
  readonly noLock?: boolean;
  hp: number;
  readonly maxHp: number;
  alive: boolean;
  /** Seconds a player missile has been tracking it (it breaks hard). */
  threatened: number;
  /** Apply damage at a point; returns true if this killed it. */
  damage(amount: number, at: THREE.Vector3, kind: DamageKind): boolean;
}

export type DamageKind = 'repulsor' | 'bullet' | 'missile' | 'unibeam' | 'launcher' | 'ram';

/** The player as hostiles see it. */
export interface PlayerTarget {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  alive: boolean;
  /** Apply a hit; `at` is where it struck. */
  hit(amount: number, at: THREE.Vector3, kind: 'bullet' | 'missile' | 'beam'): void;
}

/** Something a heat seeker may chase instead of its target. */
export interface Decoy {
  pos: THREE.Vector3;
  heat: number;
  /** A seeker flew into it: snuffed out by the blast. */
  eaten?: boolean;
}

/**
 * The house, as a launcher sees it when it can't see the suit: spots on its
 * roofs to lay on, and what a round that comes down there does.
 */
export interface HouseTarget {
  readonly marks: readonly THREE.Vector3[];
  /** `damage`: the share of the house a hit on it takes (0–1; a launcher's round when not given). */
  struck(at: THREE.Vector3, damage?: number): void;
}
