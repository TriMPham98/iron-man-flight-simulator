import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { Particles } from '../fx/particles';
import type { Streaks } from '../fx/streaks';
import { EventBus, type SimEvent } from '../sim/events';
import { AWARD, Upgrades, type Store } from '../sim/upgrades';
import type { Explosions, SurfaceQuery } from './explosions';
import { Missiles } from './missiles';
import {
  RIVAL_BEAM_CHARGE,
  RIVAL_BEAM_DURATION,
  RIVAL_DASH_SPEED,
  RIVAL_FLARE_COOLDOWN,
  RIVAL_FLIGHT_POSTURE,
  RIVAL_ICED_DAMAGE_MULT,
  RIVAL_ICING_ALT,
  RIVAL_MAX_HP,
  RIVAL_STALL_DURATION,
  RivalSuit,
} from './rivalSuit';
import { isAircraft, type PlayerTarget } from './types';
import { waveAt } from './waves';

// Missiles & flare sprites create a 2D canvas glow texture
const ctx = new Proxy({}, { get: () => () => ({ addColorStop() {} }) });
vi.stubGlobal('document', { createElement: () => ({ getContext: () => ctx }) });

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function makeHarness(surfaceY = 0) {
  const events = new EventBus();
  const log: SimEvent[] = [];
  events.on((e) => log.push(e));

  const particleCalls: Array<{ kind: string; at: THREE.Vector3 }> = [];
  const particles = {
    emit: vi.fn((kind: string, at: THREE.Vector3) => particleCalls.push({ kind, at: at.clone() })),
    burst: vi.fn((kind: string, at: THREE.Vector3) => particleCalls.push({ kind, at: at.clone() })),
  } as unknown as Particles;

  const streakCalls: Array<{ a: THREE.Vector3; b: THREE.Vector3 }> = [];
  const streaks = {
    add: vi.fn((a: THREE.Vector3, b: THREE.Vector3) => streakCalls.push({ a: a.clone(), b: b.clone() })),
  } as unknown as Streaks;

  const blasts: Array<{ at: THREE.Vector3; size: number }> = [];
  const explosions = {
    blast: vi.fn((at: THREE.Vector3, size: number) => blasts.push({ at: at.clone(), size })),
    muzzle: vi.fn(),
  } as unknown as Explosions;

  const ground: SurfaceQuery = {
    surface: () => surfaceY,
    isWater: () => true,
  };

  const missiles = new Missiles(particles, explosions, ground, events);
  const fxParent = new THREE.Group();

  const hits: Array<{ amount: number; kind: 'bullet' | 'missile' }> = [];
  const player: PlayerTarget = {
    pos: v(0, 600, 0),
    vel: v(0, 0, 120),
    alive: true,
    hit(amount, _at, kind) {
      hits.push({ amount, kind });
    },
  };

  return { events, log, particles, particleCalls, streaks, streakCalls, explosions, blasts, ground, missiles, fxParent, player, hits };
}

function stepRival(
  rival: RivalSuit,
  h: ReturnType<typeof makeHarness>,
  seconds: number,
  dt = 1 / 60,
  startT = 0,
): number {
  let t = startT;
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    t += dt;
    h.events.time = t;
    rival.update(dt, t, h.player, h.ground, h.missiles, h.particles, h.streaks, h.explosions, h.events, h.fxParent);
    h.missiles.update(dt, [rival], h.player);
  }
  return t;
}

describe('RivalSuit (Pillar 3A — Supersonic Rival Ace Boss)', () => {
  it('builds a 2.1–2.4 m armored humanoid silhouette implementing Hostile cleanly', () => {
    const rival = new RivalSuit(v(0, 500, 1500), v(0, 0, -1));
    expect(rival.kind).toBe('rival');
    expect(isAircraft(rival.kind)).toBe(true);
    expect(rival.label).toBe('RIVAL ACE');
    expect(rival.hp).toBe(RIVAL_MAX_HP);
    expect(rival.maxHp).toBe(RIVAL_MAX_HP);
    expect(rival.alive).toBe(true);
    expect(rival.chargingBeam).toBe(false);
    expect(rival.firingBeam).toBe(false);
    expect(rival.iced).toBe(false);

    // Measure upright humanoid silhouette height (armor meshes only, excluding exhaust cones/sprites)
    const bodyGroup = rival.mesh.children[0];
    bodyGroup.rotation.set(0, 0, 0);
    rival.mesh.position.set(0, 0, 0);
    rival.mesh.quaternion.identity();
    rival.mesh.updateMatrixWorld(true);

    const box = new THREE.Box3();
    let meshCount = 0;
    bodyGroup.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        const m = o as THREE.Mesh;
        // Skip additive exhaust plume cones
        if ((m.material as THREE.MeshBasicMaterial).blending === THREE.AdditiveBlending) return;
        meshCount++;
        const g = m.geometry;
        g.computeBoundingBox();
        if (g.boundingBox) {
          const b = g.boundingBox.clone().applyMatrix4(m.matrixWorld);
          box.union(b);
        }
      }
    });
    const height = box.max.y - box.min.y;
    expect(meshCount).toBeGreaterThanOrEqual(4);
    expect(height).toBeGreaterThanOrEqual(2.1);
    expect(height).toBeLessThanOrEqual(2.4);
  });

  it('articulates posture upright during beam stance vs prone at supersonic flight speed', () => {
    const h = makeHarness();
    const rival = new RivalSuit(v(0, 600, 600), v(0, 0, -1));
    // Fly fast in dash mode -> prone flight posture
    rival.mode = 'dash';
    stepRival(rival, h, 1.5);
    expect(rival.vel.length()).toBeGreaterThan(340);
    expect(rival.posture).toBeGreaterThan(RIVAL_FLIGHT_POSTURE * 0.85);
    expect(h.particleCalls.some((p) => p.kind === 'vapor')).toBe(true);

    // Enter beam charge -> flares upright toward posture 0
    rival.mode = 'beamCharge';
    rival.chargingBeam = true;
    stepRival(rival, h, 0.8);
    expect(rival.posture).toBeLessThan(0.25);
  });

  it('pops countermeasure flares on cooldown when threatened and decoys player seekers', () => {
    const h = makeHarness();
    const rival = new RivalSuit(v(0, 600, 500), v(0, 0, -1));
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    try {
      // Launch player seeker tracking the Rival Ace
      h.missiles.launch({
        team: 'player',
        from: v(0, 600, 0),
        vel: v(0, 0, 260),
        target: rival,
      });
      expect(h.missiles.live.length).toBe(1);
      expect(h.missiles.live[0].target).toBe(rival);

      // Threaten the rival -> pops flares and breaks into evade
      rival.threatened = 1;
      stepRival(rival, h, 0.05);

      expect(rival.mode).toBe('evade');
      expect(rival.flares.length).toBeGreaterThan(0);
      expect(rival.flareCooldown).toBeGreaterThan(RIVAL_FLARE_COOLDOWN - 0.5);
      expect(h.missiles.live[0].decoyed).toBe(true);
      expect(h.missiles.live[0].target).not.toBe(rival);
      expect(h.log.some((e) => e.kind === 'flarePop')).toBe(true);

      // Cooldown prevents spamming flares while still threatened
      const flareCount = rival.flares.length;
      rival.threatened = 1;
      stepRival(rival, h, 0.2);
      expect(rival.flares.length).toBeLessThanOrEqual(flareCount);

      // Decoyed player missile runs down its flare and detonates without damaging the rival
      const hpBefore = rival.hp;
      stepRival(rival, h, 3.0);
      expect(rival.hp).toBe(hpBefore);
    } finally {
      rand.mockRestore();
    }
  });

  it('telegraphs chest Unibeam for ~1.1 s, then sweeps and damages the player in its line', () => {
    const h = makeHarness();
    const rival = new RivalSuit(v(0, 600, 350), v(0, 0, -1));
    h.player.pos.set(0, 600, 0);
    h.player.vel.set(0, 0, 0);

    // Put rival in strafe with beam ready
    rival.mode = 'strafe';
    (rival as unknown as { beamCooldown: number }).beamCooldown = 0;

    // Trigger charge
    let t = stepRival(rival, h, 0.05);
    expect(rival.chargingBeam).toBe(true);
    expect(rival.firingBeam).toBe(false);
    expect(rival.label).toContain('RIVAL ACE');
    expect(h.log.some((e) => e.kind === 'unibeamCharge')).toBe(true);
    expect(h.log.some((e) => e.kind === 'jarvis' && e.text?.toLowerCase().includes('unibeam'))).toBe(true);

    // Mid-charge: still charging, not yet firing
    t = stepRival(rival, h, RIVAL_BEAM_CHARGE * 0.5, 1 / 60, t);
    expect(rival.chargingBeam).toBe(true);
    expect(rival.firingBeam).toBe(false);
    expect(rival.beamCharge).toBeGreaterThan(0.4);
    expect(rival.beamCharge).toBeLessThan(1);

    // Complete charge -> transitions into firing sweep
    t = stepRival(rival, h, RIVAL_BEAM_CHARGE * 0.65, 1 / 60, t);
    expect(rival.chargingBeam).toBe(false);
    expect(rival.firingBeam).toBe(true);
    expect(h.log.some((e) => e.kind === 'unibeamFire')).toBe(true);

    // Hold stationary player in sweep path -> beam streaks drawn and player takes damage
    t = stepRival(rival, h, 0.9, 1 / 60, t);
    expect(h.streakCalls.length).toBeGreaterThan(0);
    expect(h.hits.length).toBeGreaterThan(0);

    // Finish beam duration -> returns to strafe
    stepRival(rival, h, RIVAL_BEAM_DURATION, 1 / 60, t);
    expect(rival.firingBeam).toBe(false);
    expect(rival.mode).toBe('strafe');
  });

  it('fires twin palm repulsor streaks and shoulder micro-missile pairs in dogfight', () => {
    const h = makeHarness();
    const rival = new RivalSuit(v(0, 600, 700), v(0, 0, -1));
    h.player.pos.set(0, 600, 0);
    h.player.vel.set(0, 0, 0);
    rival.mode = 'strafe';
    (rival as unknown as { repulsorT: number; missileT: number; beamCooldown: number }).repulsorT = 0;
    (rival as unknown as { repulsorT: number; missileT: number; beamCooldown: number }).missileT = 0;
    (rival as unknown as { repulsorT: number; missileT: number; beamCooldown: number }).beamCooldown = 99;

    stepRival(rival, h, 0.4);
    expect(h.log.some((e) => e.kind === 'enemyFire')).toBe(true);
    expect(h.log.some((e) => e.kind === 'enemyMissile')).toBe(true);
    expect(h.missiles.live.filter((m) => m.team === 'enemy').length).toBeGreaterThanOrEqual(2);
    expect(rival.bolts.length).toBeGreaterThan(0);
  });

  it('implements the high-altitude icing trap: builds ice above 8,800 m, freezes for ~6 s, takes 2× damage, and thaws', () => {
    const h = makeHarness();
    const rival = new RivalSuit(v(0, RIVAL_ICING_ALT + 400, 500), v(0, 0, -1));
    h.player.pos.set(0, RIVAL_ICING_ALT + 500, 0);
    h.player.vel.set(0, 0, 0);
    (rival as unknown as { beamCooldown: number }).beamCooldown = 99;

    // Step until icing reaches 1
    let t = 0;
    for (let i = 0; i < 400 && !rival.iced; i++) {
      t = stepRival(rival, h, 1 / 60, 1 / 60, t);
    }

    expect(rival.icing).toBe(1);
    expect(rival.iced).toBe(true);
    expect(rival.mode).toBe('iced');
    expect(rival.label).toContain('ICED');
    expect(h.log.some((e) => e.kind === 'jarvis' && e.text?.includes('gold-titanium'))).toBe(true);
    expect(h.particleCalls.some((p) => p.kind === 'vapor')).toBe(true);

    // Takes 2× damage while frozen in stall
    const hpBefore = rival.hp;
    rival.damage(100, rival.pos, 'repulsor');
    expect(rival.hp).toBeCloseTo(hpBefore - 100 * RIVAL_ICED_DAMAGE_MULT);

    // Tumbles downward under gravity (velocity.y drops)
    const vyBefore = rival.vel.y;
    t = stepRival(rival, h, 1.0, 1 / 60, t);
    expect(rival.vel.y).toBeLessThan(vyBefore);

    // Recovers after ~6 s stall if still airborne
    t = stepRival(rival, h, RIVAL_STALL_DURATION, 1 / 60, t);
    expect(rival.iced).toBe(false);
    expect(rival.mode).not.toBe('iced');
    expect(rival.alive).toBe(true);
  });

  it('shatters immediately on ocean/ground impact while frozen in an iced stall', () => {
    const h = makeHarness(0);
    const rival = new RivalSuit(v(0, 25, 0), v(0, -1, 0));
    rival.vel.set(0, -40, 0);
    rival.icing = 1;
    rival.iced = true;
    rival.iceStallT = RIVAL_STALL_DURATION;
    rival.mode = 'iced';

    stepRival(rival, h, 1.0);
    expect(rival.alive).toBe(false);
    expect(rival.shattered).toBe(true);
    expect(rival.crashed).toBe(true);
    expect(h.blasts.length).toBeGreaterThan(0);
    expect(h.log.some((e) => e.kind === 'jarvis' && e.text?.toLowerCase().includes('shattered'))).toBe(true);
  });

  it('awards R&D payout on rival destruction and appears in wave progression', () => {
    const data = new Map<string, string>();
    const store: Store = { getItem: (k) => data.get(k) ?? null, setItem: (k, val) => void data.set(k, val) };
    const u = new Upgrades(store);
    const got: string[] = [];
    u.onAward = (_pts, why) => got.push(why);

    u.event({ kind: 'destroyed', t: 10, text: 'rival' });
    expect(u.state.rd).toBe(AWARD.rival);
    expect(got).toEqual(['RIVAL ACE DOWN']);

    // Wave 8 (index 7) and recurring Wave 11 (index 10) feature the Rival Ace
    expect(waveAt(7).rival).toBe(true);
    expect(waveAt(10).rival).toBe(true);
    // Supersonic boost target exceeds Mach 1
    expect(RIVAL_DASH_SPEED).toBeGreaterThan(340);
  });
});
