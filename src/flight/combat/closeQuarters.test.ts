import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { Particles } from '../fx/particles';
import { EventBus, type SimEvent } from '../sim/events';
import type { Heightfield } from '../world/heightfield';
import {
  CloseQuarters,
  GRAB_MAX_DURATION,
  MELEE_RANGE,
  THROW_SPEED,
  THROW_SPLASH_DAMAGE,
} from './closeQuarters';
import { Dreadnought } from './dreadnought';
import { Drone, type DroneType } from './drones';
import type { Explosions, SurfaceQuery } from './explosions';
import { Missiles } from './missiles';
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

describe('Dreadnought Chain Reactions & Asymmetric Engine Failure', () => {
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
});
