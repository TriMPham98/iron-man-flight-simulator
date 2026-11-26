import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { Suit } from '../../suit/Suit';
import { Soundscape } from '../audio/soundscape';
import type { GameAudio } from '../audio/gameAudio';
import { Combat } from '../combat/combat';
import type { SurfaceQuery } from '../combat/explosions';
import { HOUSE_PARTY_KEY } from '../combat/houseParty';
import type { Particles } from '../fx/particles';
import type { Heightfield } from '../world/heightfield';
import { EventBus, type SimEvent, type SimEventKind } from './events';
import { FlightModel } from './flightModel';
import { HitStop } from './hitStop';
import { ACTION_KEYS, type Controls } from './input';
import { REACTOR_KEYS } from './reactorPower';

// Headless canvas stub for glow/flare textures used by Missiles, PlayerWeapons, RivalSuit
const ctx2d = new Proxy({}, { get: () => () => ({ addColorStop() {} }) });
vi.stubGlobal('document', { createElement: () => ({ getContext: () => ctx2d }) });

function idleControls(overrides: Partial<Controls> = {}, pressed: string[] = []): Controls {
  return {
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
    pressed: new Set(pressed),
    zoom: 0,
    ...overrides,
  };
}

function makeCombatHarness() {
  const ground: SurfaceQuery & { water: boolean; y: number } = {
    water: false,
    y: 0,
    surface: () => ground.y,
    isWater: () => ground.water,
  };

  const field = {
    heightAt: () => 0,
    surfaceAt: () => 0,
    raycast: () => -1,
    normalAt: (_x: number, _z: number, out = new THREE.Vector3()) => out.set(0, 1, 0),
    inBounds: () => true,
  } as unknown as Heightfield;

  const model = new FlightModel({
    surface: (x, z) => ground.surface(x, z),
    isWater: (x, z) => ground.isWater(x, z),
    normal: (_x, _z, out = new THREE.Vector3()) => out.set(0, 1, 0),
  });
  model.pos.set(0, 220, 0);
  model.vel.set(0, 0, 120);
  model.grounded = false;

  const suit = {
    palms: [
      { bone: 'handL', at: [0, 0, 0], normal: [0, 0, 1] },
      { bone: 'handR', at: [0, 0, 0], normal: [0, 0, 1] },
    ],
    boneWorldPoint: (_bone: string, _at: readonly [number, number, number], out: THREE.Vector3) => out.copy(model.pos),
    boneWorldDir: (_bone: string, _dir: readonly [number, number, number], out: THREE.Vector3) => out.set(0, 0, 1),
    setSystemsPower: vi.fn(),
    weaponHardware: {
      fx: {
        setLoadout: vi.fn(),
      },
      muzzle: () => model.pos.clone(),
    },
  } as unknown as Suit;

  const particles = {
    emit: vi.fn(),
    burst: vi.fn(),
  } as unknown as Particles;

  const events = new EventBus();
  const log: SimEvent[] = [];
  events.on((e) => log.push(e));

  const combat = new Combat(field, ground, model, suit, particles, events, () => {}, {});
  const hitStop = new HitStop();
  combat.hitStop = hitStop;

  return { combat, hitStop, model, ground, field, particles, events, log };
}

describe('Close-Quarters & HitStop Integration', () => {
  it('Keybind audit: all close-quarters keys are unique and conflict-free', () => {
    const bindings: Record<string, string> = {
      throttleUp: 'KeyW',
      throttleDown: 'KeyS',
      rollLeft: 'KeyA',
      rollRight: 'KeyD',
      climb: 'KeyE',
      descend: 'KeyQ',
      crouch: 'ControlLeft',
      boost: 'ShiftLeft',
      brake: 'KeyX',
      unibeam: 'Space',
      flares: 'KeyF',
      launchers: 'KeyG',
      reactorThrust: REACTOR_KEYS.THRUST,
      reactorWeapons: REACTOR_KEYS.WEAPONS,
      reactorShields: REACTOR_KEYS.SHIELDS,
      reactorBalanced: REACTOR_KEYS.BALANCED,
      laserCutter: REACTOR_KEYS.LASER_CUTTER,
      overcharge: REACTOR_KEYS.OVERCHARGE,
      houseParty: HOUSE_PARTY_KEY,
      grapple: ACTION_KEYS.GRAPPLE,
      punch: ACTION_KEYS.PUNCH,
      cameraCycle: 'KeyV',
      resetOrRedeploy: 'KeyR',
      callWave: 'KeyN',
      refit: 'KeyU',
      missionsDrawer: 'KeyJ',
      multiplayerDrawer: 'KeyM',
      autoLand: 'Tab',
      pause: 'Escape',
    };
    const codes = Object.values(bindings);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('Combat wires CloseQuarters grapple/throw, thruster punch, and HitStop time dilation', () => {
    const h = makeCombatHarness();
    expect(h.combat.group.children).toContain(h.combat.closeQuarters.group);

    // 1. Grapple & Throw
    const d1 = h.combat.spawnDrone(h.model.pos.clone().add(new THREE.Vector3(0, 0, 6)), new THREE.Vector3(0, 0, 1), 'drone');
    h.combat.update(1 / 60, 0.1, idleControls({ grapple: true }), new THREE.Vector3(0, 0, 1), h.model.pos);
    expect(h.combat.closeQuarters.grabbedTarget).toBe(d1);
    expect(h.log.some((e) => e.kind === 'grappleGrab')).toBe(true);

    h.combat.update(1 / 60, 0.2, idleControls({ grapple: true }), new THREE.Vector3(0, 0, 1), h.model.pos);
    expect(h.combat.closeQuarters.grabbedTarget).toBeNull();
    expect(h.log.some((e) => e.kind === 'grappleThrow')).toBe(true);

    // 2. Thruster Punch after melee cooldown clears
    (h.combat.closeQuarters as unknown as { cooldown: number }).cooldown = 0;
    const d2 = h.combat.spawnDrone(h.model.pos.clone().add(new THREE.Vector3(0, 0, 6)), new THREE.Vector3(0, 0, 1), 'drone');
    h.combat.update(1 / 60, 0.3, idleControls({ punch: true }), new THREE.Vector3(0, 0, 1), h.model.pos);
    expect(h.log.some((e) => e.kind === 'thrusterPunch')).toBe(true);
    expect(d2.hp).toBeLessThan(d2.maxHp);

    // 3. Micro HitStop slows effectiveDt and recovers cleanly
    h.hitStop.trigger(0.055, 0.12);
    expect(h.hitStop.hitStopTimer).toBeGreaterThan(0);
    expect(h.hitStop.effectiveDt(0.02)).toBeLessThan(0.02);

    h.hitStop.update(0.1);
    expect(h.hitStop.hitStopTimer).toBe(0);
    expect(h.hitStop.effectiveDt(0.02)).toBeCloseTo(0.02);
  });

  it('Soundscape handles close-quarters SimEventKinds without errors', () => {
    const play = vi.fn();
    const audio = { ready: true, play } as unknown as GameAudio;
    const soundscape = new Soundscape(audio);
    const model = new FlightModel({
      surface: () => 0,
      isWater: () => false,
      normal: (_x, _z, out = new THREE.Vector3()) => out.set(0, 1, 0),
    });

    const newKinds: SimEventKind[] = [
      'strafeDash',
      'grappleGrab',
      'grappleThrow',
      'thrusterPunch',
    ];

    let t = 1;
    for (const kind of newKinds) {
      soundscape.on({ kind, at: new THREE.Vector3(0, 100, 0), value: 1, text: 'test', t: t++ }, model);
    }
    expect(play).toHaveBeenCalledTimes(9);
  });
});
