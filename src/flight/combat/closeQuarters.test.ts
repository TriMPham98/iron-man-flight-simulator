import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { Suit } from '../../suit/Suit';
import type { Particles } from '../fx/particles';
import { Streaks } from '../fx/streaks';
import { EventBus, type SimEvent } from '../sim/events';
import { FlightModel } from '../sim/flightModel';
import type { Controls } from '../sim/input';
import { REACTOR_KEYS } from '../sim/reactorPower';
import type { Heightfield } from '../world/heightfield';
import {
  CloseQuarters,
  DIVE_SLAM_REBOUND_VY,
  DIVE_SLAM_SPEED,
  GRAB_MAX_DURATION,
  MELEE_RANGE,
  THROW_SPEED,
  THROW_SPLASH_DAMAGE,
} from './closeQuarters';
import { Dreadnought } from './dreadnought';
import { Drone, type DroneType } from './drones';
import type { Explosions, SurfaceQuery } from './explosions';
import { Frigate } from './frigate';
import { Missiles } from './missiles';
import { PlayerWeapons } from './playerWeapons';
import type { Hostile, PlayerTarget } from './types';

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
    muzzle: vi.fn(),
  };
  return { stub: stub as unknown as Explosions, blasts };
}

function makeGround(opts: { y?: number; water?: boolean } = {}): SurfaceQuery {
  return {
    surface: () => opts.y ?? 0,
    isWater: () => opts.water ?? false,
  };
}

function makeHostile(opts: { id?: number; kind?: Hostile['kind']; pos: THREE.Vector3; hp?: number; radius?: number }): Hostile {
  const maxHp = opts.hp ?? 180;
  return {
    id: opts.id ?? 1,
    kind: opts.kind ?? 'drone',
    pos: opts.pos.clone(),
    vel: v(0, 0, 0),
    radius: opts.radius ?? 3,
    hp: maxHp,
    maxHp,
    alive: true,
    threatened: 0,
    damage(amount: number) {
      if (!this.alive) return false;
      this.hp -= amount;
      if (this.hp <= 0) {
        this.hp = 0;
        this.alive = false;
        return true;
      }
      return false;
    },
  };
}

function makeDrone(pos: THREE.Vector3, type: DroneType = 'drone'): Drone {
  const d = new Drone(pos, v(0, 0, 1), type);
  d.mode = 'attack';
  return d;
}

describe('Close-Quarters Superhero Combat', () => {
  it('Targeted Dive-Slam locks suit into supersonic dive, damages ground/SAMs/ships/boss parts on impact, and executes vel.y = 32 rebound hop', () => {
    const cq = new CloseQuarters();
    const { stub: particles, emitted } = makeParticles();
    const { stub: explosions, blasts } = makeExplosions();
    const bus = new EventBus();
    const events: SimEvent[] = [];
    bus.on((e) => events.push(e));
    const ground = makeGround({ y: 0, water: false });

    const model = {
      pos: v(0, 260, 0),
      vel: v(0, 0, 40),
      grounded: false,
      boosting: false,
      hipHeight: () => 1,
    };

    const sam = makeHostile({ id: 10, kind: 'sam', pos: v(0, 2, 120), hp: 200, radius: 4.5 });
    const shipPart = makeHostile({ id: 11, kind: 'ship', pos: v(28, 6, 120), hp: 350, radius: 5 });
    const bossPart = makeHostile({ id: 12, kind: 'boss', pos: v(-35, 8, 120), hp: 400, radius: 5 });
    const farSam = makeHostile({ id: 13, kind: 'sam', pos: v(400, 2, 120), hp: 200, radius: 4.5 });
    const hostiles = [sam, shipPart, bossPart, farSam];

    // Cannot start when grounded
    model.grounded = true;
    expect(cq.startDiveSlam(model, v(0, -1, 0.45).normalize(), ground, hostiles)).toBe(false);

    // Airborne: locks into supersonic dive toward aimed SAM
    model.grounded = false;
    const started = cq.startDiveSlam(model, v(0, -258, 120).normalize(), ground, hostiles);
    expect(started).toBe(true);
    expect(cq.diveSlamActive).toBe(true);
    expect(model.vel.length()).toBeCloseTo(DIVE_SLAM_SPEED, 1);

    // Simulate frames until impact
    let impact = null;
    for (let i = 0; i < 60 && cq.diveSlamActive; i++) {
      model.pos.addScaledVector(model.vel, 1 / 60);
      impact = cq.update(1 / 60, model, v(0, -1, 0), hostiles, ground, explosions, particles, bus);
    }

    expect(cq.diveSlamActive).toBe(false);
    expect(impact?.impacted).toBe(true);
    expect(impact?.hits).toBe(3);
    expect(model.vel.y).toBe(DIVE_SLAM_REBOUND_VY);
    expect(model.grounded).toBe(false);
    expect(cq.cooldown).toBeGreaterThan(0);
    expect(sam.alive).toBe(false);
    expect(shipPart.hp).toBeLessThan(350);
    expect(bossPart.hp).toBeLessThan(400);
    expect(farSam.hp).toBe(200);
    expect(blasts.length).toBeGreaterThan(0);
    expect(emitted.some((e) => e.kind === 'spark')).toBe(true);
    expect(events.some((e) => e.kind === 'heroSlam')).toBe(true);
  });

  it('Mid-Air Grapple tethers an enemy aircraft for up to 1.8 s and hurls it at 180 m/s for 260 splash damage on impact', () => {
    const cq = new CloseQuarters();
    const { stub: particles } = makeParticles();
    const { stub: explosions, blasts } = makeExplosions();
    const bus = new EventBus();
    const ground = makeGround({ y: 0, water: false });

    const model = { pos: v(0, 300, 0), vel: v(0, 0, 50), grounded: false, hipHeight: () => 1 };
    const grabbed = makeDrone(v(0, 300, MELEE_RANGE - 2), 'drone');
    const farTarget = makeDrone(v(0, 300, 140), 'bomber');
    const outOfRange = makeDrone(v(25, 300, 0), 'interceptor');
    const hostiles: Hostile[] = [grabbed, farTarget, outOfRange];

    // Update once to populate HUD-readable availableMeleeTarget
    cq.update(1 / 60, model, v(0, 0, 1), hostiles, ground, explosions, particles, bus);
    expect(cq.availableMeleeTarget).toBe(grabbed);

    // 1. Grab the enemy aircraft
    const grabRes = cq.tryMeleeAction(model, v(0, 0, 1), hostiles, ground, explosions, particles, { events: bus });
    expect(grabRes.action).toBe('grab');
    expect(cq.grabbedTarget).toBe(grabbed);
    expect(cq.grabRemaining).toBeCloseTo(GRAB_MAX_DURATION, 2);

    // Move suit forward for 0.6 s -> grabbed target stays tethered ahead of suit
    for (let i = 0; i < 6; i++) {
      model.pos.addScaledVector(model.vel, 0.1);
      cq.update(0.1, model, v(0, 0, 1), hostiles, ground, explosions, particles, bus);
    }
    expect(cq.grabbedTarget).toBe(grabbed);
    expect(grabbed.pos.distanceTo(model.pos)).toBeLessThan(10);

    // 2. Second press hurls it along aimDir toward farTarget at 180 m/s
    const aimToTarget = farTarget.pos.clone().sub(model.pos).normalize();
    const throwRes = cq.tryMeleeAction(model, aimToTarget, hostiles, ground, explosions, particles, { events: bus });
    expect(throwRes.action).toBe('throw');
    expect(cq.grabbedTarget).toBeNull();
    expect(cq.thrownInFlight).toBe(1);
    expect(grabbed.vel.length()).toBeCloseTo(THROW_SPEED, 1);

    // Place a nearby bystander within splash radius of farTarget
    const bystander = makeHostile({ id: 99, kind: 'sam', pos: farTarget.pos.clone().add(v(15, 0, 0)), hp: 300 });
    hostiles.push(bystander);

    const hpBefore = farTarget.hp;
    for (let i = 0; i < 90 && cq.thrownInFlight > 0; i++) {
      cq.update(1 / 60, model, aimToTarget, hostiles, ground, explosions, particles, bus);
    }

    expect(cq.thrownInFlight).toBe(0);
    expect(grabbed.alive).toBe(false);
    expect(blasts.length).toBeGreaterThan(0);
    // Heavy splash damage (~260 peak) hits farTarget and nearby bystander
    expect(hpBefore - farTarget.hp).toBeGreaterThanOrEqual(THROW_SPLASH_DAMAGE * 0.7);
    expect(300 - bystander.hp).toBeGreaterThan(100);
  });

  it('auto-hurls a grabbed aircraft when the 1.8 s tether expires and supports Thruster Punch mode', () => {
    const cq = new CloseQuarters();
    const { stub: particles } = makeParticles();
    const { stub: explosions } = makeExplosions();
    const ground = makeGround({ y: 0 });

    const model = { pos: v(0, 400, 0), vel: v(0, 0, 0), grounded: false };
    const d1 = makeDrone(v(0, 400, 8), 'interceptor');
    cq.tryMeleeAction(model, v(0, 0, 1), [d1], ground, explosions, particles);
    expect(cq.grabbedTarget).toBe(d1);

    // Advance past GRAB_MAX_DURATION (1.8 s)
    for (let i = 0; i < 20; i++) {
      cq.update(0.1, model, v(0, 0, 1), [d1], ground, explosions, particles);
    }
    expect(cq.grabbedTarget).toBeNull();
    expect(cq.thrownInFlight).toBe(1);
    expect(d1.vel.length()).toBeCloseTo(THROW_SPEED, 1);

    // Reset and test Thruster Punch mode
    cq.reset();
    const d2 = makeDrone(v(0, 400, 9), 'jammer');
    const res = cq.tryMeleeAction(model, v(0, 0, 1), [d2], ground, explosions, particles, { mode: 'punch' });
    expect(res.action).toBe('punch');
    expect(d2.hp).toBeLessThan(d2.maxHp);
    expect(cq.thrownInFlight).toBe(1);
    expect(cq.cooldown).toBeGreaterThan(0);
  });
});

describe('Dreadnought Chain Reactions, Asymmetric Engine Failure & Warship Searchlights', () => {
  it('triggers secondary detonation when hangar is destroyed, damaging spawned drones and blasting hull HP', () => {
    const { stub: explosions, blasts } = makeExplosions();
    const bus = new EventBus();
    const log: SimEvent[] = [];
    bus.on((e) => log.push(e));
    const spawned: Drone[] = [];

    const boss = new Dreadnought(new THREE.Vector2(0, 500), (at, heading) => {
      const d = new Drone(at, heading, 'drone');
      spawned.push(d);
      return d;
    });
    expect(boss.searchlightCount).toBeGreaterThanOrEqual(2);

    // Spawn 2 drones near the hangar through Dreadnought's launch callback
    const field = { surfaceAt: () => 0, heightAt: () => -40 } as unknown as Heightfield;
    const player: PlayerTarget = { pos: v(0, 500, 0), vel: v(0, 0, 0), alive: true, hit: vi.fn() };
    const missiles = new Missiles(makeParticles().stub, explosions, makeGround(), bus);
    const house = { marks: [], struck: vi.fn() };
    for (let i = 0; i < 26; i++) {
      boss.update(1, i, player, field, [], missiles, makeParticles().stub, explosions, bus, house);
    }
    expect(spawned.length).toBeGreaterThanOrEqual(1);
    // Park spawned drone close to hangar so secondary blast catches it
    spawned[0].pos.copy(boss.hangar.pos).add(v(0, 0, -40));

    const coreHpBefore = boss.core.hp;
    boss.hangar.damage(999, boss.hangar.pos, 'missile');
    boss.partDestroyed(boss.hangar, explosions, bus);

    expect(boss.hangarDetonated).toBe(true);
    expect(boss.core.hp).toBeLessThan(coreHpBefore - 300);
    expect(spawned[0].alive).toBe(false);
    expect(blasts.length).toBeGreaterThanOrEqual(2);
    expect(log.some((e) => e.kind === 'jarvis' && e.text?.includes('Secondary detonation'))).toBe(true);
  });

  it('induces pronounced asymmetric bank tilt and spiral heading instability when 2 engines on one wing fail', () => {
    const { stub: explosions } = makeExplosions();
    const bus = new EventBus();
    const field = { surfaceAt: () => 0, heightAt: () => -40 } as unknown as Heightfield;
    const player: PlayerTarget = { pos: v(0, 500, 0), vel: v(0, 0, 0), alive: true, hit: vi.fn() };
    const missiles = new Missiles(makeParticles().stub, explosions, makeGround(), bus);
    const house = { marks: [], struck: vi.fn() };

    const boss = new Dreadnought(new THREE.Vector2(0, 500), (at, heading) => new Drone(at, heading, 'drone'));
    const portEngines = boss.parts.filter((p) => p.role === 'engine' && p.local.x < 0);
    expect(portEngines).toHaveLength(2);
    for (const e of portEngines) e.damage(9999, e.pos, 'unibeam');

    expect(boss.asymmetricSpiral).toBe(true);
    const headingStart = boss.heading;
    for (let i = 0; i < 90; i++) {
      boss.update(1 / 30, i / 30, player, field, [], missiles, makeParticles().stub, explosions, bus, house);
    }
    expect(Math.abs(boss.bankRoll)).toBeGreaterThan(0.32);
    expect(Math.abs(boss.heading - headingStart)).toBeGreaterThan(0.2);
  });

  it('sweeps Night Ops searchlights on both Dreadnought and Frigate', () => {
    const field = { surfaceAt: () => 0, heightAt: () => -40 } as unknown as Heightfield;
    const { stub: explosions } = makeExplosions();
    const bus = new EventBus();
    const particles = makeParticles().stub;
    const missiles = new Missiles(particles, explosions, makeGround({ water: true }), bus);
    const player: PlayerTarget = { pos: v(0, 500, 0), vel: v(0, 0, 0), alive: true, hit: vi.fn() };

    const frigate = new Frigate(field, v(0, 100, 500));
    expect(frigate.searchlightCount).toBeGreaterThanOrEqual(2);
    frigate.update(0.1, 0.5, player, field, [], missiles, particles, explosions, bus);
    const yawA = frigate.searchlights[0].root.rotation.y;
    frigate.update(0.1, 2.2, player, field, [], missiles, particles, explosions, bus);
    const yawB = frigate.searchlights[0].root.rotation.y;
    expect(yawA).not.toBeCloseTo(yawB, 3);

    const boss = new Dreadnought(new THREE.Vector2(0, 500), (at, h) => new Drone(at, h, 'drone'));
    boss.update(0.1, 0.5, player, field, [], missiles, particles, explosions, bus, { marks: [], struck: vi.fn() });
    const bYawA = boss.searchlights[0].root.rotation.y;
    boss.update(0.1, 2.2, player, field, [], missiles, particles, explosions, bus, { marks: [], struck: vi.fn() });
    const bYawB = boss.searchlights[0].root.rotation.y;
    expect(bYawA).not.toBeCloseTo(bYawB, 3);
  });
});

describe('Ordnance Interception & Near-Miss Hooks', () => {
  it('Missiles.interceptNearSegment shoots down enemy missiles/bombs and checkNearMisses detects close passes once', () => {
    const { stub: particles } = makeParticles();
    const { stub: explosions, blasts } = makeExplosions();
    const bus = new EventBus();
    const ms = new Missiles(particles, explosions, makeGround(), bus);
    const player: PlayerTarget = { pos: v(0, 300, 0), vel: v(0, 0, 0), alive: true, hit: vi.fn() };

    ms.launch({ team: 'enemy', from: v(0, 300, 50), vel: v(0, 0, -100), target: player });
    ms.launch({ team: 'enemy', from: v(0, 308, 0), vel: v(0, 0, -100), target: player });
    ms.launch({ team: 'player', from: v(0, 300, 50), vel: v(0, 0, 200), target: null, aimPoint: v(0, 300, 500) });

    // Near miss check on missile 8 m from player (outside playerRadius 3.2, inside nearMissRadius 18)
    const nm1 = ms.checkNearMisses(player.pos, 3.2, 18);
    expect(nm1).toHaveLength(1);
    expect(nm1[0].dist).toBeCloseTo(8, 1);
    // Same missile does not trigger twice
    expect(ms.checkNearMisses(player.pos, 3.2, 18)).toHaveLength(0);

    // Segment intercept shoots down enemy missiles near segment, leaving player missile intact
    const hits = ms.interceptNearSegment(v(-5, 300, 50), v(5, 300, 50), 4);
    expect(hits).toHaveLength(1);
    expect(blasts.length).toBe(1);
    expect(ms.activeEnemyMissiles()).toHaveLength(1);
    expect(ms.live.some((m) => m.team === 'player')).toBe(true);
  });

  it('PlayerWeapons repulsor bolts and KeyC wrist laser cutter shoot down enemy missiles/bombs and invoke onOrdnanceIntercept', () => {
    const { stub: particles } = makeParticles();
    const { stub: explosions } = makeExplosions();
    const bus = new EventBus();
    const streaks = new Streaks();
    const field = {
      heightAt: () => 0,
      surfaceAt: () => 0,
      raycast: () => -1,
      normalAt: (_x: number, _z: number, out = new THREE.Vector3()) => out.set(0, 1, 0),
    } as unknown as Heightfield;
    const model = new FlightModel({
      surface: () => 0,
      isWater: () => false,
      normal: (_x: number, _z: number, out = new THREE.Vector3()) => out.set(0, 1, 0),
    });
    model.pos.set(0, 300, 0);
    model.vel.set(0, 0, 0);

    const suit = {
      palms: [
        { bone: 'handL', at: [0, 0, 0], normal: [0, 0, 1] },
        { bone: 'handR', at: [0, 0, 0], normal: [0, 0, 1] },
      ],
      boneWorldPoint: (_bone: string, _at: readonly [number, number, number], out: THREE.Vector3) => out.copy(model.pos),
      boneWorldDir: (_bone: string, _dir: readonly [number, number, number], out: THREE.Vector3) => out.set(0, 0, 1),
      setSystemsPower: vi.fn(),
      weaponHardware: { fx: { setLoadout: vi.fn(), siloMuzzle: () => ({ ok: false, caliber: 0 }), launcherMuzzle: () => ({ ok: false, caliber: 0, length: 0 }) }, modelWorld: new THREE.Matrix4() },
    } as unknown as Suit;

    const ms = new Missiles(particles, explosions, makeGround(), bus);
    const pw = new PlayerWeapons(suit, model, field, particles, streaks, ms, explosions, bus);
    const intercepted: Array<{ at: THREE.Vector3; kind: string }> = [];
    pw.onOrdnanceIntercept = (at, kind) => intercepted.push({ at, kind });

    // 1. Repulsor bolt shoots down falling bomb along aim line
    ms.launch({
      team: 'enemy',
      from: v(0, 300, 45),
      vel: v(0, -10, 0),
      target: null,
      aimPoint: v(0, 0, 45),
      onImpact: vi.fn(),
    });
    const idleControls = (overrides: Partial<Controls> = {}): Controls => ({
      aimYaw: 0,
      aimPitch: 0,
      throttle: 0,
      lateral: 0,
      vertical: 0,
      forward: 0,
      boost: false,
      brake: false,
      fire: false,
      missile: false,
      unibeam: false,
      flares: false,
      launcher: false,
      pressed: new Set(),
      zoom: 0,
      ...overrides,
    });

    // Raise arm and fire repulsor bolts along +Z
    for (let i = 0; i < 20 && ms.activeEnemyMissiles().length > 0; i++) {
      pw.update(0.03, idleControls({ fire: true }), v(0, 0, 1), model.pos, [], true);
    }
    expect(ms.activeEnemyMissiles()).toHaveLength(0);
    expect(intercepted.some((x) => x.kind === 'repulsor')).toBe(true);

    // 2. KeyC wrist laser cutter sweeps and shoots down an incoming enemy missile
    const player: PlayerTarget = { pos: model.pos, vel: model.vel, alive: true, hit: vi.fn() };
    ms.launch({
      team: 'enemy',
      from: v(0, 300, 80),
      vel: v(0, 0, -20),
      target: player,
    });
    pw.update(1 / 60, idleControls({ pressed: new Set([REACTOR_KEYS.LASER_CUTTER]) }), v(0, 0, 1), model.pos, [], true);
    for (let i = 0; i < 45 && ms.activeEnemyMissiles().length > 0; i++) {
      pw.update(1 / 60, idleControls(), v(0, 0, 1), model.pos, [], true);
    }
    expect(ms.activeEnemyMissiles()).toHaveLength(0);
    expect(intercepted.some((x) => x.kind === 'laserCutter')).toBe(true);
  });
});
