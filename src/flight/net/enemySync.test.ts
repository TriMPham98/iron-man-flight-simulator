import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { Suit } from '../../suit/Suit';
import { Combat } from '../combat/combat';
import type { SurfaceQuery } from '../combat/explosions';
import type { Particles } from '../fx/particles';
import { EventBus } from '../sim/events';
import { FlightModel } from '../sim/flightModel';
import type { Controls } from '../sim/input';
import type { Heightfield } from '../world/heightfield';
import { EnemySync } from './enemySync';
import { cosmetic } from './netDamage';
import {
  decodePilotState,
  decodeWorldState,
  encodePilotState,
  makePilotState,
  PilotFlag,
  type NetEvent,
} from './protocol';

const ctx2d = new Proxy({}, { get: () => () => ({ addColorStop() {} }) });
vi.stubGlobal('document', { createElement: () => ({ getContext: () => ctx2d }) });

const idle = (): Controls => ({
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
});

function makeCombat(events = new EventBus()): Combat {
  const ground: SurfaceQuery = { surface: () => 0, isWater: () => false };
  const field = {
    heightAt: () => 0,
    surfaceAt: () => 0,
    raycast: () => -1,
    normalAt: (_x: number, _z: number, out = new THREE.Vector3()) => out.set(0, 1, 0),
    inBounds: () => true,
  } as unknown as Heightfield;
  const model = new FlightModel({ surface: () => 0, isWater: () => false, normal: (_x, _z, out = new THREE.Vector3()) => out.set(0, 1, 0) });
  model.pos.set(0, 600, 0);
  const suit = {
    palms: [
      { bone: 'handL', at: [0, 0, 0], normal: [0, 0, 1] },
      { bone: 'handR', at: [0, 0, 0], normal: [0, 0, 1] },
    ],
    boneWorldPoint: (_b: string, _a: unknown, out: THREE.Vector3) => out.copy(model.pos),
    boneWorldDir: (_b: string, _d: unknown, out: THREE.Vector3) => out.set(0, 0, 1),
    setSystemsPower: vi.fn(),
    weaponHardware: { fx: { setLoadout: vi.fn() }, muzzle: () => model.pos.clone() },
  } as unknown as Suit;
  const particles = { emit: vi.fn(), burst: vi.fn() } as unknown as Particles;
  return new Combat(field, ground, model, suit, particles, events, () => {}, {});
}

const step = (c: Combat, dt: number) => c.update(dt, 0, idle(), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 600, 0));

describe('Shared fight: host enemies, guest puppets', () => {
  it('mirrors the host wave on the guest, routes guest hits to the host, and syncs the kill back', () => {
    const host = makeCombat();
    const guest = makeCombat();
    const hs = new EnemySync(host);
    const gs = new EnemySync(guest);
    hs.reset('host');
    gs.reset('guest');

    host.callWave();
    const n = host.drones.length;
    expect(n).toBeGreaterThan(0);
    // The guest can't start waves of its own
    guest.callWave();
    expect(guest.drones.length).toBe(0);

    const tick = () => {
      step(host, 1 / 30);
      const out = hs.update(1 / 30, true);
      step(guest, 1 / 30);
      if (out.world) gs.onWorld(decodeWorldState(out.world)!);
      return gs.update(1 / 30, true);
    };
    for (let i = 0; i < 10; i++) tick();

    // Same enemies, same places
    expect(guest.drones.length).toBe(n);
    for (const d of host.drones) {
      const near = guest.drones.some((g) => g.type === d.type && g.pos.distanceTo(d.pos) < 25);
      expect(near).toBe(true);
    }

    // The guest shoots one: its puppet takes nothing locally; the host's drone dies
    const target = host.drones[0];
    const puppet = guest.drones.reduce((a, b) => (a.pos.distanceTo(target.pos) < b.pos.distanceTo(target.pos) ? a : b));
    expect(puppet.damage(1e4, puppet.pos, 'repulsor')).toBe(false);
    expect(puppet.alive).toBe(true);
    let dmg: NetEvent | undefined;
    for (let i = 0; i < 4 && !dmg; i++) dmg = tick().damage;
    expect(dmg?.kind).toBe('dmg');
    if (dmg?.kind === 'dmg') hs.applyDamage(dmg.hits);
    expect(target.alive).toBe(false);

    // The death comes back in the next snapshot
    for (let i = 0; i < 4; i++) tick();
    expect(puppet.alive).toBe(false);
    expect(guest.kills).toBeGreaterThanOrEqual(1);

    // A wingman's cosmetic weapons never hurt anything
    const other = host.drones.find((d) => d.alive)!;
    const hp = other.hp;
    expect(cosmetic(() => other.damage(1e4, other.pos, 'missile'))).toBe(false);
    expect(other.hp).toBe(hp);
  });

  it('mirrors frigates, the dreadnought and the rival, part by part', () => {
    const host = makeCombat();
    const guest = makeCombat();
    const hs = new EnemySync(host);
    const gs = new EnemySync(guest);
    hs.reset('host');
    gs.reset('guest');
    const f = host.spawnFrigate();
    const boss = host.spawnBoss();
    const rival = host.spawnRival();
    const tick = () => {
      step(host, 1 / 30);
      const out = hs.update(1 / 30, true);
      step(guest, 1 / 30);
      if (out.world) gs.onWorld(decodeWorldState(out.world)!);
      return gs.update(1 / 30, true);
    };
    for (let i = 0; i < 6; i++) tick();
    expect(guest.ships.length).toBe(1);
    expect(guest.boss).not.toBeNull();
    expect(guest.rival).not.toBeNull();
    const gf = guest.ships[0];
    expect(gf.mesh.position.distanceTo(f.mesh.position)).toBeLessThan(5);
    expect(guest.boss!.mesh.position.distanceTo(boss.mesh.position)).toBeLessThan(20);
    expect(guest.rival!.pos.distanceTo(rival.pos)).toBeLessThan(40);
    // Parts ride the mirrored hull
    expect(gf.parts[0].pos.distanceTo(f.parts[0].pos)).toBeLessThan(5);

    // Guest knocks out the radar: lands on the host's radar
    const gi = gf.parts.indexOf(gf.radar);
    let dmg: NetEvent | undefined;
    gf.radar.damage(1e5, gf.radar.pos, 'missile');
    for (let i = 0; i < 4 && !dmg; i++) dmg = tick().damage;
    if (dmg?.kind === 'dmg') hs.applyDamage(dmg.hits);
    expect(f.parts[gi].alive).toBe(false);
    for (let i = 0; i < 4; i++) tick();
    expect(gf.radar.alive).toBe(false);

    // The host drops the rival: it leaves the guest's sky too
    host.removeBody(rival);
    for (let i = 0; i < 30; i++) tick();
    expect(guest.rival).toBeNull();
  });

  it('starts and clears every host wave on the guest too (its banner, payout and wave record)', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on((e) => {
      if (e.kind === 'waveStart' || e.kind === 'waveClear') seen.push(`${e.kind}:${e.value}`);
    });
    const host = makeCombat();
    const guest = makeCombat(bus);
    const hs = new EnemySync(host);
    const gs = new EnemySync(guest);
    hs.reset('host');
    gs.reset('guest');
    const tick = () => {
      step(host, 1 / 30);
      const out = hs.update(1 / 30, true);
      step(guest, 1 / 30);
      if (out.world) gs.onWorld(decodeWorldState(out.world)!);
      gs.update(1 / 30, true);
    };
    for (let w = 0; w < 2; w++) {
      host.callWave();
      for (let i = 0; i < 10; i++) tick();
      for (const h of [...host.hostiles]) h.damage(1e6, h.pos, 'missile');
      for (let i = 0; i < 90; i++) tick();
    }
    expect(seen).toEqual(['waveStart:1', 'waveClear:1', 'waveStart:2', 'waveClear:2']);
  });

  it('a guest house repair lands on the host and is not knocked back by the snapshots in flight', () => {
    const host = makeCombat();
    const guest = makeCombat();
    const hs = new EnemySync(host);
    const gs = new EnemySync(guest);
    hs.reset('host');
    gs.reset('guest');
    host.houseHp = 0.4;
    const world = () => decodeWorldState(hs.update(1, true).world!)!;
    gs.onWorld(world());
    expect(guest.houseHp).toBeCloseTo(0.4, 5);
    // Paid for on the guest: shown there at once, the stale snapshot doesn't undo it
    guest.repairHouse(0.25);
    gs.holdHouse(guest.houseHp);
    gs.onWorld(world());
    expect(guest.houseHp).toBeCloseTo(0.65, 5);
    // The host gets it (sent as an event) and the snapshots carry it from then on
    host.repairHouse(0.25);
    gs.onWorld(world());
    expect(guest.houseHp).toBeCloseTo(0.65, 5);
  });

  it('host enemies go after whichever pilot is nearer', () => {
    const host = makeCombat();
    new EnemySync(host).reset('host');
    host.callWave();
    const d = host.drones[0];
    const ally = { pos: d.pos.clone().add(new THREE.Vector3(30, 0, 0)), vel: new THREE.Vector3(), alive: true, hit: vi.fn() };
    host.allies.push(ally);
    const spy = vi.spyOn(d, 'update');
    step(host, 1 / 30);
    expect(spy.mock.calls[0][2]).toBe(ally);
  });

  it('round-trips a full pilot packet', () => {
    const a = makePilotState();
    a.flags = PilotFlag.FIRE | PilotFlag.LASER | PilotFlag.BOOSTING;
    a.reactor = 2;
    a.armor = 0.5;
    a.strafeDashDir = -1;
    a.t = 12.5;
    a.pos.set(1, 2, 3);
    a.q.setFromEuler(new THREE.Euler(0.2, 1.1, -0.3));
    a.aim.set(0, 0.6, 0.8);
    a.s.posture = 1.2;
    a.s.flightness = 0.9;
    const b = makePilotState();
    expect(decodePilotState(encodePilotState(a), b)).toBe(true);
    expect(b.flags).toBe(a.flags);
    expect(b.reactor).toBe(2);
    expect(b.strafeDashDir).toBe(-1);
    expect(b.pos.toArray()).toEqual([1, 2, 3]);
    expect(b.q.angleTo(a.q)).toBeLessThan(1e-5);
    expect(b.s.posture).toBeCloseTo(1.2, 5);
    expect(b.armor).toBeCloseTo(0.5, 1);
  });
});
