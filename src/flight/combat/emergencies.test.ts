import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { Particles } from '../fx/particles';
import { EventBus, type SimEvent } from '../sim/events';
import { Drone, type DroneType } from './drones';
import {
  BOMBER_WING_COUNT,
  BOMBER_WING_OVERCHARGE,
  BOMBER_WING_RD_REWARD,
  DISTRESS_GUARD_COUNT,
  DISTRESS_OVERCHARGE,
  DISTRESS_RD_REWARD,
  EMERGENCY_RESULT_LINGER,
  EmergencyManager,
  SATELLITE_CATCH_TIME,
  SATELLITE_OVERCHARGE,
  SATELLITE_RD_REWARD,
  SATELLITE_SPAWN_ALT,
  type EmergencyHost,
} from './emergencies';
import type { Explosions } from './explosions';

const ctx = new Proxy({}, { get: () => () => ({ addColorStop() {} }) });
vi.stubGlobal('document', { createElement: () => ({ getContext: () => ctx }) });

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function makeHost() {
  const events = new EventBus();
  const log: SimEvent[] = [];
  events.on((e) => log.push(e));
  const spawned: Drone[] = [];
  const rdAwards: Array<{ pts: number; reason: string }> = [];
  const ocFeeds: Array<{ amount: number; reason: string }> = [];
  const blasts: Array<{ at: THREE.Vector3; size: number }> = [];

  const particles = {
    emit: vi.fn(),
    burst: vi.fn(),
  } as unknown as Particles;

  const explosions = {
    blast(at: THREE.Vector3, size: number) {
      blasts.push({ at: at.clone(), size });
    },
  } as unknown as Explosions;

  const host: EmergencyHost = {
    field: { surfaceAt: () => 0, heightAt: () => -40 },
    home: new THREE.Vector2(0, 525),
    particles,
    explosions,
    events,
    spawnDrone(at: THREE.Vector3, heading: THREE.Vector3, type: DroneType = 'drone') {
      const d = new Drone(at, heading, type);
      spawned.push(d);
      return d;
    },
    awardRd(pts, reason) {
      rdAwards.push({ pts, reason });
    },
    feedOvercharge(amount, reason) {
      ocFeeds.push({ amount, reason });
    },
  };

  return { host, log, spawned, rdAwards, ocFeeds, blasts };
}

describe('Dynamic Free-Flight Emergencies', () => {
  it('spawns Falling Orbital Satellite above 9,200 m and awards R&D + Overcharge on mid-air catch or destruction', () => {
    const mgr = new EmergencyManager();
    const { host, rdAwards, ocFeeds } = makeHost();

    const ev = mgr.trigger('satellite', host, v(0, 8000, 0));
    expect(ev.kind).toBe('satellite');
    expect(ev.pos.y).toBeGreaterThan(9200);
    expect(ev.pos.y).toBe(SATELLITE_SPAWN_ALT);
    expect(mgr.extraHostiles).toHaveLength(1);

    // Fly right beside the satellite to catch/stabilize it
    const sat = mgr.extraHostiles[0];
    const playerVel = v(0, 0, 50);
    for (let i = 0; i < Math.ceil(SATELLITE_CATCH_TIME / 0.1) + 2; i++) {
      mgr.update(0.1, i * 0.1, sat.pos.clone(), playerVel, host, true);
      if (mgr.activeEmergency?.result === 'completed') break;
    }

    expect(mgr.activeEmergency?.result).toBe('completed');
    expect(mgr.activeEmergency?.progress01).toBe(1);
    expect(rdAwards.some((a) => a.pts === SATELLITE_RD_REWARD)).toBe(true);
    expect(ocFeeds.some((o) => o.amount === SATELLITE_OVERCHARGE)).toBe(true);

    // After linger expires, activeEmergency clears cleanly
    mgr.update(EMERGENCY_RESULT_LINGER + 0.1, 10, v(0, 500, 0), playerVel, host, false);
    expect(mgr.activeEmergency).toBeNull();

    // Also supports destroying the satellite by weapon damage
    mgr.trigger('satellite', host, v(0, 8500, 0));
    const sat2 = mgr.extraHostiles[0];
    sat2.damage(999, sat2.pos, 'unibeam');
    mgr.update(0.1, 12, v(0, 1000, 0), v(0, 0, 0), host, true);
    expect(mgr.activeEmergency?.result).toBe('completed');
  });

  it('fails the satellite emergency if it splashes down into the ocean before interception', () => {
    const mgr = new EmergencyManager();
    const { host, blasts } = makeHost();
    mgr.trigger('satellite', host, v(0, 500, 0));
    const sat = mgr.extraHostiles[0];
    sat.pos.y = 1.5;

    mgr.update(0.1, 1, v(0, 500, 0), v(0, 0, 0), host, true);
    expect(mgr.activeEmergency?.result).toBe('failed');
    expect(blasts.length).toBeGreaterThan(0);
  });

  it('spawns Rogue Coastal Bomber Wing (2-3 bombers) and completes when all are destroyed', () => {
    const mgr = new EmergencyManager();
    const { host, spawned, rdAwards, ocFeeds } = makeHost();

    const ev = mgr.trigger('bomberWing', host, v(0, 300, 0));
    expect(ev.kind).toBe('bomberWing');
    expect(spawned).toHaveLength(BOMBER_WING_COUNT);
    expect(spawned.every((d) => d.type === 'bomber')).toBe(true);
    expect(spawned[0].pos.y).toBeLessThan(260);

    // Destroy 1 of 3 -> progress 1/3
    spawned[0].damage(9999, spawned[0].pos, 'missile');
    mgr.update(0.1, 1, v(0, 300, 0), v(0, 0, 0), host, true);
    expect(mgr.activeEmergency?.progress01).toBeCloseTo(1 / BOMBER_WING_COUNT, 3);
    expect(mgr.activeEmergency?.result).toBeNull();

    // Destroy remaining bombers -> completed
    for (const b of spawned.slice(1)) b.damage(9999, b.pos, 'unibeam');
    mgr.update(0.1, 2, v(0, 300, 0), v(0, 0, 0), host, true);
    expect(mgr.activeEmergency?.result).toBe('completed');
    expect(rdAwards.some((a) => a.pts === BOMBER_WING_RD_REWARD)).toBe(true);
    expect(ocFeeds.some((o) => o.amount === BOMBER_WING_OVERCHARGE)).toBe(true);
  });

  it('spawns Offshore Distress Flare guarded by drones and completes once guards are cleared and pod is rescued', () => {
    const mgr = new EmergencyManager();
    const { host, spawned, rdAwards, ocFeeds } = makeHost();

    const ev = mgr.trigger('distressFlare', host, v(0, 200, 0));
    expect(ev.kind).toBe('distressFlare');
    expect(spawned).toHaveLength(DISTRESS_GUARD_COUNT);

    // Clear all guard drones -> 50% progress
    for (const g of spawned) g.damage(9999, g.pos, 'repulsor');
    mgr.update(0.1, 1, v(0, 500, 0), v(0, 0, 0), host, true);
    expect(mgr.activeEmergency?.progress01).toBeCloseTo(0.5, 3);
    expect(mgr.activeEmergency?.result).toBeNull();

    // Fly into survivor pod rescue radius -> completed
    mgr.update(0.1, 2, ev.pos.clone().add(v(10, 5, 0)), v(0, 0, 0), host, true);
    expect(mgr.activeEmergency?.result).toBe('completed');
    expect(mgr.activeEmergency?.progress01).toBe(1);
    expect(rdAwards.some((a) => a.pts === DISTRESS_RD_REWARD)).toBe(true);
    expect(ocFeeds.some((o) => o.amount === DISTRESS_OVERCHARGE)).toBe(true);
  });

  it('automatically triggers an emergency during free-flight / between-wave downtime and exposes clean telemetry', () => {
    const mgr = new EmergencyManager();
    const { host } = makeHost();

    // Not eligible (mid-wave): does not pop up
    for (let i = 0; i < 30; i++) {
      expect(mgr.update(1, i, v(0, 500, 0), v(0, 0, 0), host, false)).toBeNull();
    }

    // Eligible: pops up after EMERGENCY_INTERVAL_SEC
    let popped = null;
    for (let i = 0; i < 30 && !popped; i++) {
      popped = mgr.update(1, 30 + i, v(0, 500, 0), v(0, 0, 0), host, true);
    }
    expect(popped).not.toBeNull();
    expect(popped?.title.length).toBeGreaterThan(5);
    expect(popped?.objective.length).toBeGreaterThan(5);
    expect(popped?.timerSec).toBeGreaterThan(0);

    mgr.reset();
    expect(mgr.activeEmergency).toBeNull();
  });
});
