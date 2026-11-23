import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { Particles } from '../fx/particles';
import { EventBus, type SimEvent } from '../sim/events';
import { AWARD, STOCK_SPEC, Upgrades, type Store } from '../sim/upgrades';
import { Drone, type DroneType } from './drones';
import type { Explosions, SurfaceQuery } from './explosions';
import { Missiles } from './missiles';
import {
  ENEMY_ICING_ALT,
  ICING_JARVIS_LINE,
  PhysicsWeapons,
  RAM_MIN_SPEED,
  RAM_UNBOOSTED_SUIT_DAMAGE,
  SLAM_DAMAGE_MAX,
  SLAM_DAMAGE_MIN,
  SLAM_RADIUS_MAX,
  SLAM_RADIUS_MIN,
  SONIC_SHOCK_RADIUS,
  SPLASH_EVADE_JARVIS_LINE,
  UNIBEAM_BASE_COOL,
  enemyIcingAlt,
  heroSlamStats,
  isLightAircraft,
  isWaterCooling,
} from './physicsWeapons';
import type { DamageKind, Hostile, PlayerTarget } from './types';

// Drone and Missile exhaust/glow textures draw on a canvas
const ctx = new Proxy({}, { get: () => () => ({ addColorStop() {} }) });
vi.stubGlobal('document', { createElement: () => ({ getContext: () => ctx }) });

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function makeParticles() {
  const emitted: Array<{ kind: string; at: THREE.Vector3 }> = [];
  const stub = {
    emit(kind: string, at: THREE.Vector3) {
      emitted.push({ kind, at: at.clone() });
    },
    burst(kind: string, at: THREE.Vector3, n: number) {
      for (let i = 0; i < n; i++) emitted.push({ kind, at: at.clone() });
    },
  };
  return { stub: stub as unknown as Particles, emitted };
}

function makeExplosions() {
  const blasts: Array<{ at: THREE.Vector3; size: number }> = [];
  const stub = {
    blast(at: THREE.Vector3, size: number) {
      blasts.push({ at: at.clone(), size });
    },
  };
  return { stub: stub as unknown as Explosions, blasts };
}

function makeBus() {
  const bus = new EventBus();
  const list: SimEvent[] = [];
  bus.on((e) => list.push(e));
  return { bus, list };
}

function makeUpgrades() {
  const data = new Map<string, string>();
  const store: Store = { getItem: (k) => data.get(k) ?? null, setItem: (k, val) => void data.set(k, val) };
  const u = new Upgrades(store);
  const awards: Array<{ pts: number; why: string }> = [];
  u.onAward = (pts, why) => awards.push({ pts, why });
  return { u, awards };
}

function makeGround(opts: { y?: number; water?: boolean } = {}): SurfaceQuery {
  return {
    surface: () => opts.y ?? 0,
    isWater: () => opts.water ?? false,
  };
}

function makePlayer(pos = v(0, 100, 0), vel = v(0, 0, 0)) {
  const hits: Array<{ amount: number; kind: 'bullet' | 'missile' }> = [];
  const target: PlayerTarget = {
    pos,
    vel,
    alive: true,
    hit(amount, _at, kind) {
      hits.push({ amount, kind });
    },
  };
  return { target, hits };
}

function makeHostile(opts: { id?: number; kind?: Hostile['kind']; pos: THREE.Vector3; hp?: number; radius?: number }): Hostile & { hits: Array<{ amount: number; kind: DamageKind }> } {
  const hits: Array<{ amount: number; kind: DamageKind }> = [];
  const maxHp = opts.hp ?? 220;
  return {
    id: opts.id ?? 1,
    kind: opts.kind ?? 'sam',
    pos: opts.pos.clone(),
    vel: v(0, 0, 0),
    radius: opts.radius ?? 4.5,
    hp: maxHp,
    maxHp,
    alive: true,
    threatened: 0,
    hits,
    damage(amount, _at, kind) {
      if (!this.alive) return false;
      hits.push({ amount, kind });
      this.hp -= amount;
      if (this.hp <= 0) {
        this.alive = false;
        return true;
      }
      return false;
    },
  };
}

function makeDrone(pos: THREE.Vector3, type: DroneType = 'drone', heading = v(0, 0, 1)): Drone {
  const d = new Drone(pos, heading, type);
  d.mode = 'attack';
  return d;
}

describe('Pillar 1 — Weaponize the Icing Ceiling', () => {
  it('uses distinct icing thresholds (~8,800 m interceptors, ~8,200 m others)', () => {
    expect(enemyIcingAlt('interceptor')).toBe(ENEMY_ICING_ALT.interceptor);
    expect(enemyIcingAlt('interceptor')).toBeGreaterThan(enemyIcingAlt('drone'));
    expect(enemyIcingAlt('drone')).toBe(8200);
    expect(enemyIcingAlt('bomber')).toBe(8200);
    expect(enemyIcingAlt('jammer')).toBe(8200);
    expect(enemyIcingAlt('interceptor')).toBe(8800);
  });

  it('builds ice above threshold, slows thrust, emits frost, freezes, tumbles, and calls JARVIS once', () => {
    const pw = new PhysicsWeapons();
    const { stub: particles, emitted } = makeParticles();
    const { stub: explosions } = makeExplosions();
    const { bus, list } = makeBus();
    const ground = makeGround({ y: 0, water: false });
    const { target: player } = makePlayer(v(0, 9200, 0));
    const ms = new Missiles(particles, explosions, ground, bus);

    const drone = makeDrone(v(0, 9100, 0), 'drone');
    const interceptor = makeDrone(v(50, 8600, 0), 'interceptor');
    const initialSpeed = drone.vel.length();

    // Below interceptor's 8,800 m threshold, interceptor stays ice-free while drone builds ice
    pw.updateEnemyIcing(1.0, [drone, interceptor], ground, particles, explosions, bus);
    expect(drone.icing).toBeGreaterThan(0.2);
    expect(interceptor.icing).toBe(0);
    expect(emitted.some((e) => e.kind === 'vapor')).toBe(true);

    // Partial icing slows cruise speed in Drone.update
    for (let i = 0; i < 10; i++) {
      drone.update(0.1, i * 0.1, player, ground, [], ms, particles, explosions, bus);
    }
    expect(drone.vel.length()).toBeLessThan(initialSpeed);

    // Continue icing until freeze-out
    for (let i = 0; i < 30 && !drone.frozen; i++) {
      pw.updateEnemyIcing(0.25, [drone], ground, particles, explosions, bus);
    }
    expect(drone.frozen).toBe(true);
    expect(drone.icing).toBe(1);
    const jarvisLines = list.filter((e) => e.kind === 'jarvis').map((e) => e.text);
    expect(jarvisLines).toContain(ICING_JARVIS_LINE);

    // A second drone freezing does not duplicate the first-time JARVIS line
    const drone2 = makeDrone(v(20, 9500, 0), 'drone');
    for (let i = 0; i < 30 && !drone2.frozen; i++) {
      pw.updateEnemyIcing(0.25, [drone2], ground, particles, explosions, bus);
    }
    expect(drone2.frozen).toBe(true);
    expect(list.filter((e) => e.kind === 'jarvis' && e.text === ICING_JARVIS_LINE)).toHaveLength(1);

    // Frozen drone tumbles downward under gravity with exhaust dead
    drone.vel.set(80, 0, 0);
    const yBefore = drone.pos.y;
    drone.update(0.5, 5, player, ground, [], ms, particles, explosions, bus);
    expect(drone.vel.y).toBeLessThan(-4);
    expect(drone.pos.y).toBeLessThan(yBefore);
  });

  it('increases vulnerability when iced/frozen and shatters on terrain/water crash with R&D award', () => {
    const pw = new PhysicsWeapons();
    const { stub: particles } = makeParticles();
    const { stub: explosions, blasts } = makeExplosions();
    const { bus, list } = makeBus();
    const { u, awards } = makeUpgrades();
    bus.on((e) => u.event(e));

    // Vulnerability: frozen drone takes 1.8× damage
    const fresh = makeDrone(v(0, 500, 0), 'drone');
    const iced = makeDrone(v(0, 500, 0), 'drone');
    iced.icing = 1;
    iced.frozen = true;
    fresh.damage(30, fresh.pos, 'repulsor');
    iced.damage(30, iced.pos, 'repulsor');
    expect(iced.maxHp - iced.hp).toBeCloseTo((fresh.maxHp - fresh.hp) * 1.8, 3);

    // Terrain crash while frozen destroys it and pays ICING KILL
    const falling = makeDrone(v(0, 1.5, 0), 'drone');
    falling.icing = 1;
    falling.frozen = true;
    pw.updateEnemyIcing(0.1, [falling], makeGround({ y: 0, water: true }), particles, explosions, bus);
    expect(falling.alive).toBe(false);
    expect(falling.crashed).toBe(true);
    expect(blasts.length).toBeGreaterThan(0);
    expect(list.some((e) => e.kind === 'iceKill')).toBe(true);
    expect(awards.some((a) => a.why === 'ICING KILL' && a.pts === AWARD.iceKill)).toBe(true);
  });

  it('thaws partial icing in warm air, while a full freeze-out tumbles all the way from >8,200 m to crash', () => {
    const pw = new PhysicsWeapons();
    const { stub: particles } = makeParticles();
    const { stub: explosions, blasts } = makeExplosions();
    const { bus, list } = makeBus();
    const { u, awards } = makeUpgrades();
    bus.on((e) => u.event(e));
    const sea = makeGround({ y: 0, water: true });
    const ms = new Missiles(particles, explosions, sea, bus);
    const { target: player } = makePlayer(v(0, 9000, 0));

    // Partial icing (not yet frozen) thaws when descending into warmer air
    const partial = makeDrone(v(0, 5000, 0), 'drone');
    partial.icing = 0.7;
    for (let i = 0; i < 30; i++) {
      pw.updateEnemyIcing(0.2, [partial], sea, particles, explosions, bus);
    }
    expect(partial.icing).toBe(0);
    expect(partial.frozen).toBe(false);

    // Full freeze-out above 8,200 m stays frozen through lower altitudes until terrain/water crash
    const doomed = makeDrone(v(0, 8600, 0), 'drone');
    let t = 0;
    const dt = 0.25;
    for (let i = 0; i < 400 && doomed.alive; i++) {
      t += dt;
      doomed.update(dt, t, player, sea, [], ms, particles, explosions, bus);
      pw.updateEnemyIcing(dt, [doomed], sea, particles, explosions, bus);
    }
    expect(doomed.alive).toBe(false);
    expect(doomed.crashed).toBe(true);
    expect(doomed.pos.y).toBeLessThanOrEqual(2.5);
    expect(blasts.length).toBeGreaterThan(0);
    expect(list.some((e) => e.kind === 'iceKill')).toBe(true);
    expect(awards.some((a) => a.why === 'ICING KILL' && a.pts === AWARD.iceKill)).toBe(true);
  });
});

describe('Pillar 1 — Hero-Landing Shockwaves', () => {
  it('scales radius (35–140 m) and damage (60–350) with impactSpeed', () => {
    const low = heroSlamStats(7);
    expect(low.radius).toBeCloseTo(SLAM_RADIUS_MIN);
    expect(low.maxDamage).toBeCloseTo(SLAM_DAMAGE_MIN);
    const high = heroSlamStats(45);
    expect(high.radius).toBeCloseTo(SLAM_RADIUS_MAX);
    expect(high.maxDamage).toBeCloseTo(SLAM_DAMAGE_MAX);
    const mid = heroSlamStats(26);
    expect(mid.radius).toBeGreaterThan(low.radius);
    expect(mid.radius).toBeLessThan(high.radius);
  });

  it('destroys nearby SAMs, knocks low-flying drones, spawns shockwave rings, and awards SHOCKWAVE SLAM R&D', () => {
    const pw = new PhysicsWeapons();
    const { stub: particles, emitted } = makeParticles();
    const { bus, list } = makeBus();
    const { u, awards } = makeUpgrades();
    bus.on((e) => u.event(e));

    const nearSam = makeHostile({ id: 1, kind: 'sam', pos: v(20, 2, 0), hp: 220 });
    const farSam = makeHostile({ id: 2, kind: 'sam', pos: v(220, 2, 0), hp: 220 });
    const lowDrone = makeHostile({ id: 3, kind: 'drone', pos: v(60, 15, 0), hp: 300, radius: 2.6 });

    const res = pw.onHeroLanding(v(0, 0, 0), 45, [nearSam, farSam, lowDrone], makeGround({ y: 0 }), particles, bus);
    expect(res.kills).toBe(1);
    expect(res.hits).toBe(2);
    expect(res.shake).toBeGreaterThan(2);
    expect(nearSam.alive).toBe(false);
    expect(nearSam.hits[0].kind).toBe('ram');
    expect(farSam.alive).toBe(true);
    expect(farSam.hits).toHaveLength(0);
    // Low-flying drone damaged and knocked outward/upward
    expect(lowDrone.hp).toBeLessThan(300);
    expect(lowDrone.vel.length()).toBeGreaterThan(20);
    // Visual rings + particles + R&D award
    expect(pw.group.children.length).toBeGreaterThan(0);
    expect(emitted.some((e) => e.kind === 'dust')).toBe(true);
    expect(emitted.some((e) => e.kind === 'spark')).toBe(true);
    expect(emitted.some((e) => e.kind === 'plasma')).toBe(true);
    expect(list.some((e) => e.kind === 'heroSlam')).toBe(true);
    expect(awards.some((a) => a.why === 'SHOCKWAVE SLAM' && a.pts === AWARD.heroSlam)).toBe(true);
  });

  it('does not emit heroSlam R&D bonus when landing hits nothing', () => {
    const pw = new PhysicsWeapons();
    const { stub: particles } = makeParticles();
    const { bus, list } = makeBus();
    const res = pw.onHeroLanding(v(0, 0, 0), 30, [], makeGround({ y: 0 }), particles, bus);
    expect(res.kills).toBe(0);
    expect(list.some((e) => e.kind === 'heroSlam')).toBe(false);
  });
});

describe('Pillar 1 — Water-Cooling & Splash-Dive Evasion', () => {
  it('detects water-cooling when wet, immersed, or skimming <15 m over ocean at speed', () => {
    const sea = makeGround({ y: 0, water: true });
    const land = makeGround({ y: 0, water: false });
    const hipHeight = () => 1;

    expect(isWaterCooling({ pos: v(0, 100, 0), wetness: 0.2, immersion: 0, speed: 10, hipHeight }, land)).toBe(true);
    expect(isWaterCooling({ pos: v(0, 0, 0), wetness: 0, immersion: 0.1, speed: 0, hipHeight }, sea)).toBe(true);
    expect(isWaterCooling({ pos: v(0, 10, 0), wetness: 0, immersion: 0, speed: 50, hipHeight }, sea)).toBe(true);
    expect(isWaterCooling({ pos: v(0, 10, 0), wetness: 0, immersion: 0, speed: 50, hipHeight }, land)).toBe(false);
    expect(isWaterCooling({ pos: v(0, 50, 0), wetness: 0, immersion: 0, speed: 100, hipHeight }, sea)).toBe(false);
    expect(isWaterCooling({ pos: v(0, 10, 0), wetness: 0, immersion: 0, speed: 5, hipHeight }, sea)).toBe(false);
  });

  it('cools unibeamHeat 3× faster total (2× bonus) with steam wisps when skimming water', () => {
    const pw = new PhysicsWeapons();
    const { stub: particles, emitted } = makeParticles();
    const { stub: explosions } = makeExplosions();
    const { bus } = makeBus();
    const sea = makeGround({ y: 0, water: true });
    const ms = new Missiles(particles, explosions, sea, bus);

    const weapons = { unibeamHeat: 0.8, unibeamOverheat: false, unibeamOn: false, spec: STOCK_SPEC() };
    const model = { pos: v(0, 8, 0), vel: v(0, 0, 80), wetness: 0, immersion: 0, speed: 80, hipHeight: () => 0.4 };

    const dt = 0.5;
    // Normal PlayerWeapons cooling (1×) + PhysicsWeapons water-cooling bonus (2×) = 3× total
    const baseCool = dt / UNIBEAM_BASE_COOL;
    weapons.unibeamHeat -= baseCool;
    const res = pw.updateWaterAndSplash(dt, model, weapons, ms, sea, particles, bus);
    expect(res.cooling).toBe(true);
    expect(weapons.unibeamHeat).toBeCloseTo(0.8 - 3 * baseCool, 5);
    expect(emitted.some((e) => e.kind === 'vapor')).toBe(true);
  });

  it('breaks enemy missile locks, veers them off, clears unibeamOverheat, and calls JARVIS when submerged >0.55', () => {
    const pw = new PhysicsWeapons();
    const { stub: particles } = makeParticles();
    const { stub: explosions } = makeExplosions();
    const { bus, list } = makeBus();
    const sea = makeGround({ y: 0, water: true });
    const ms = new Missiles(particles, explosions, sea, bus);
    const { target: player } = makePlayer(v(0, -1, 0));

    // Launch two enemy seekers on the player and one house-strike missile
    ms.launch({ team: 'enemy', from: v(0, 80, -300), vel: v(0, -20, 200), target: player });
    ms.launch({ team: 'enemy', from: v(60, 90, -260), vel: v(-20, -20, 200), target: player });
    ms.launch({ team: 'enemy', from: v(200, 120, -400), vel: v(0, 0, 200), target: null, aimPoint: v(500, 40, 500), onImpact: () => {} });
    expect(ms.threats()).toHaveLength(2);

    const weapons = { unibeamHeat: 1.0, unibeamOverheat: true, unibeamOn: false, spec: STOCK_SPEC() };
    const model = { pos: v(0, -1, 0), vel: v(0, -4, 10), wetness: 1, immersion: 0.8, speed: 11, hipHeight: () => 1 };

    const res = pw.updateWaterAndSplash(0.2, model, weapons, ms, sea, particles, bus);
    expect(res.evaded).toBe(2);
    expect(ms.threats()).toHaveLength(0);
    expect(weapons.unibeamOverheat).toBe(false);
    expect(weapons.unibeamHeat).toBeLessThan(0.6);
    // Seekers redirected to veer/splash aimPoint, house strike untouched
    expect(ms.live[0].decoyed).toBe(true);
    expect(ms.live[0].aimPoint).not.toBeNull();
    expect(ms.live[2].decoyed).toBe(false);
    expect(list.filter((e) => e.kind === 'missileDecoyed')).toHaveLength(2);
    expect(list.filter((e) => e.kind === 'jarvis' && e.text === SPLASH_EVADE_JARVIS_LINE)).toHaveLength(1);
  });
});

describe('Pillar 1 — Mach 1 Shockwave & Kinetic Ramming', () => {
  it('identifies light aircraft correctly', () => {
    expect(isLightAircraft('drone')).toBe(true);
    expect(isLightAircraft('interceptor')).toBe(true);
    expect(isLightAircraft('jammer')).toBe(true);
    expect(isLightAircraft('bomber')).toBe(false);
    expect(isLightAircraft('sam')).toBe(false);
  });

  it('performs swept high-speed kinetic ram with zero suit damage when boosting and KINETIC RAM R&D bonus', () => {
    const pw = new PhysicsWeapons();
    const { stub: particles, emitted } = makeParticles();
    const { stub: explosions, blasts } = makeExplosions();
    const { bus, list } = makeBus();
    const { u, awards } = makeUpgrades();
    bus.on((e) => u.event(e));

    const drone = makeDrone(v(0, 200, 100), 'drone');
    const bomber = makeDrone(v(0, 200, 100), 'bomber');
    const { target: player, hits: playerHits } = makePlayer(v(0, 200, 90), v(0, 0, 220));
    const model = { pos: v(0, 200, 90), vel: v(0, 0, 220), speed: 220, boosting: true };

    // Frame 1 establishes prevSuitPos at z = 90
    pw.updateKineticRam(1 / 60, model, [drone, bomber], player, particles, explosions, bus);
    expect(drone.alive).toBe(true);

    // Frame 2 jumps past drone to z = 110 (swept segment passes directly through z = 100!)
    model.pos.set(0, 200, 110);
    const rams = pw.updateKineticRam(1 / 60, model, [drone, bomber], player, particles, explosions, bus);
    expect(rams).toBe(1);
    expect(drone.alive).toBe(false);
    expect(bomber.alive).toBe(true); // Heavy bomber is NOT kinetic-rammed
    expect(playerHits).toHaveLength(0); // Zero suit damage while boosting
    expect(pw.consumeShake()).toBeGreaterThan(1);
    expect(blasts.length).toBe(1);
    expect(emitted.some((e) => e.kind === 'spark')).toBe(true);
    expect(list.some((e) => e.kind === 'kineticRam')).toBe(true);
    expect(awards.some((a) => a.why === 'KINETIC RAM' && a.pts === AWARD.kineticRam)).toBe(true);
  });

  it('applies minimal suit damage when ramming fast without boost, and ignores speeds <= 120 m/s', () => {
    const pw = new PhysicsWeapons();
    const { stub: particles } = makeParticles();
    const { stub: explosions } = makeExplosions();
    const { bus } = makeBus();

    // Below threshold: no ram
    const slowDrone = makeDrone(v(0, 200, 0), 'interceptor');
    const { target: pSlow, hits: slowHits } = makePlayer(v(0, 200, 0), v(0, 0, RAM_MIN_SPEED - 10));
    pw.updateKineticRam(1 / 60, { pos: v(0, 200, 0), vel: v(0, 0, RAM_MIN_SPEED - 10), speed: RAM_MIN_SPEED - 10, boosting: false }, [slowDrone], pSlow, particles, explosions, bus);
    expect(slowDrone.alive).toBe(true);
    expect(slowHits).toHaveLength(0);

    // Above threshold, not boosting: kills target + minimal suit damage
    const fastDrone = makeDrone(v(0, 200, 0), 'jammer');
    const { target: pFast, hits: fastHits } = makePlayer(v(0, 200, 0), v(0, 0, 150));
    pw.updateKineticRam(1 / 60, { pos: v(0, 200, 0), vel: v(0, 0, 150), speed: 150, boosting: false }, [fastDrone], pFast, particles, explosions, bus);
    expect(fastDrone.alive).toBe(false);
    expect(fastHits).toHaveLength(1);
    expect(fastHits[0].amount).toBe(RAM_UNBOOSTED_SUIT_DAMAGE);
  });

  it('knocks nearby light aircraft off course and detonates incoming enemy missiles on Mach 1 sonicBoom', () => {
    const pw = new PhysicsWeapons();
    const { stub: particles, emitted } = makeParticles();
    const { stub: explosions, blasts } = makeExplosions();
    const { bus } = makeBus();
    const ground = makeGround({ y: 0 });
    const ms = new Missiles(particles, explosions, ground, bus);
    const { target: player } = makePlayer(v(0, 500, 0), v(0, 0, 350));

    const nearDrone = makeDrone(v(40, 500, 30), 'drone');
    const nearInt = makeDrone(v(-80, 520, -20), 'interceptor');
    const farDrone = makeDrone(v(SONIC_SHOCK_RADIUS + 50, 500, 0), 'drone');
    const velBefore = nearDrone.vel.clone();

    // Enemy missiles: 1 inside 160 m, 1 outside 160 m; plus 1 player missile inside 160 m (must NOT detonate!)
    ms.launch({ team: 'enemy', from: v(50, 510, 40), vel: v(-100, 0, -100), target: player });
    ms.launch({ team: 'enemy', from: v(300, 510, 40), vel: v(-100, 0, -100), target: player });
    ms.launch({ team: 'player', from: v(10, 500, 20), vel: v(0, 0, 400), target: farDrone });

    const res = pw.onSonicBoom(v(0, 500, 0), v(0, 0, 350), [nearDrone, nearInt, farDrone], ms, particles);
    expect(res.dronesKnocked).toBe(2);
    expect(res.missilesDetonated).toBe(1);
    expect(nearDrone.vel.distanceTo(velBefore)).toBeGreaterThan(40);
    expect(nearDrone.destabilized).toBeGreaterThan(1);
    expect(nearInt.destabilized).toBeGreaterThan(0.5);
    expect(farDrone.destabilized).toBe(0);
    // Only the nearby enemy missile was shot down; far enemy + player missile remain
    expect(ms.live).toHaveLength(2);
    expect(ms.live.some((m) => m.team === 'player')).toBe(true);
    expect(blasts.length).toBe(1);
    expect(emitted.some((e) => e.kind === 'vapor')).toBe(true);
    expect(pw.group.children.length).toBeGreaterThan(0);

    // Expanding shockwave rings clean up after their duration elapses
    const stubModel = { pos: v(0, 500, 0), vel: v(0, 0, 350), wetness: 0, immersion: 0, speed: 350, boosting: false, hipHeight: () => 1 } as never;
    const stubWeapons = { unibeamHeat: 0, unibeamOverheat: false, unibeamOn: false, spec: STOCK_SPEC() } as never;
    pw.update(1.0, stubModel, stubWeapons, [], ms, player, ground, particles, explosions, bus);
    expect(pw.group.children.length).toBe(0);
  });
});
