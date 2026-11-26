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
import { Landmarks } from '../world/landmarks';
import { EventBus, type SimEvent, type SimEventKind } from './events';
import { FlightModel } from './flightModel';
import { ACTION_KEYS, type Controls } from './input';
import { REACTOR_KEYS } from './reactorPower';
import { StyleComboTracker } from './styleCombos';
import { AWARD, Upgrades } from './upgrades';

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
  const styleCombos = new StyleComboTracker(combat.reactor, events);
  combat.styleCombos = styleCombos;

  return { combat, styleCombos, model, ground, field, particles, events, log };
}

describe('Night Ops & Upgrades End-to-End Integration', () => {
  it('Keybind audit: all new mobility & close-quarters keys are unique and conflict-free', () => {
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
      snapDash: ACTION_KEYS.SNAP_DASH,
      diveSlam: ACTION_KEYS.DIVE_SLAM,
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

  it('Combat wires CloseQuarters dive-slam (with hit-stop), grapple/throw, thruster punch, and dashInvuln', () => {
    const h = makeCombatHarness();
    expect(h.combat.group.children).toContain(h.combat.closeQuarters.group);
    expect(h.combat.group.children).toContain(h.combat.emergencies.group);

    // 1. Snap-Dash grants dashInvuln dodge protection against incoming hits
    const armorBefore = h.combat.armor;
    expect(h.model.snapDash(-1)).toBe(true);
    expect(h.model.dashInvuln).toBe(true);
    h.combat.playerTarget.hit(40, h.model.pos.clone(), 'missile');
    expect(h.combat.armor).toBe(armorBefore);

    // 2. Grapple & Throw
    const d1 = h.combat.spawnDrone(h.model.pos.clone().add(new THREE.Vector3(0, 0, 6)), new THREE.Vector3(0, 0, 1), 'drone');
    h.combat.update(1 / 60, 0.1, idleControls({ grapple: true }), new THREE.Vector3(0, 0, 1), h.model.pos);
    expect(h.combat.closeQuarters.grabbedTarget).toBe(d1);
    expect(h.log.some((e) => e.kind === 'grappleGrab')).toBe(true);

    h.combat.update(1 / 60, 0.2, idleControls({ grapple: true }), new THREE.Vector3(0, 0, 1), h.model.pos);
    expect(h.combat.closeQuarters.grabbedTarget).toBeNull();
    expect(h.log.some((e) => e.kind === 'grappleThrow')).toBe(true);

    // 3. Thruster Punch after melee cooldown clears
    (h.combat.closeQuarters as unknown as { cooldown: number }).cooldown = 0;
    const d2 = h.combat.spawnDrone(h.model.pos.clone().add(new THREE.Vector3(0, 0, 6)), new THREE.Vector3(0, 0, 1), 'drone');
    h.combat.update(1 / 60, 0.3, idleControls({ punch: true }), new THREE.Vector3(0, 0, 1), h.model.pos);
    expect(h.log.some((e) => e.kind === 'thrusterPunch')).toBe(true);
    expect(d2.hp).toBeLessThan(d2.maxHp);

    // 4. Targeted Dive-Slam kill triggers rebound + micro hit-stop
    (h.combat.closeQuarters as unknown as { cooldown: number }).cooldown = 0;
    const d3 = h.combat.spawnDrone(new THREE.Vector3(0, 2, 120), new THREE.Vector3(0, 0, 1), 'drone');
    d3.hp = 40;
    h.model.pos.set(0, 140, 120);
    h.combat.update(1 / 60, 0.4, idleControls({ diveSlam: true }), new THREE.Vector3(0, -1, 0), h.model.pos);
    expect(h.combat.closeQuarters.diveSlamActive).toBe(true);
    expect(h.log.some((e) => e.kind === 'diveSlam')).toBe(true);

    for (let i = 0; i < 60 && h.combat.closeQuarters.diveSlamActive; i++) {
      h.model.pos.addScaledVector(h.model.vel, 1 / 60);
      h.combat.update(1 / 60, 0.5 + i / 60, idleControls(), new THREE.Vector3(0, -1, 0), h.model.pos);
    }
    expect(h.combat.closeQuarters.diveSlamActive).toBe(false);
    expect(h.model.vel.y).toBe(32);
    expect(d3.alive).toBe(false);
    expect(h.styleCombos.hitStopTimer).toBeGreaterThan(0);
    expect(h.styleCombos.effectiveDt(0.02)).toBeLessThan(0.02);
  });

  it('Combat wires ordnance intercepts, missile near-misses, reversal crit bonus, and sonic kills into StyleComboTracker', () => {
    const h = makeCombatHarness();

    // 1. Ordnance intercept callback -> StyleComboTracker + ordnanceIntercept event
    h.combat.weapons.onOrdnanceIntercept?.(h.model.pos.clone(), 'repulsor');
    expect(h.log.some((e) => e.kind === 'ordnanceIntercept')).toBe(true);
    expect(h.styleCombos.comboCount).toBe(1);
    expect(h.combat.reactor.overcharge).toBeGreaterThan(0);

    // 2. Missile near-miss detected during Combat.update
    h.combat.missiles.launch({
      team: 'enemy',
      from: h.model.pos.clone().add(new THREE.Vector3(6, 0, -4)),
      vel: new THREE.Vector3(0, 0, 480),
      target: null,
    });
    h.combat.update(1 / 60, 0.1, idleControls(), new THREE.Vector3(0, 0, 1), h.model.pos);
    expect(h.styleCombos.comboCount).toBe(2);

    // 3. Snap-Reversal crit window applies 1.75x damage bonus via PlayerWeapons.consumeReversalCrit
    h.styleCombos.update(
      0.05,
      { grounded: false, speed: 180, swing: 0.7, pos: h.model.pos, vel: new THREE.Vector3(0, 0, -180) },
      180,
      new THREE.Vector3(0, 0, 1),
    );
    expect(h.styleCombos.reversalCritReady).toBe(true);

    const target = h.combat.spawnDrone(h.model.pos.clone().add(new THREE.Vector3(0, 0, 40)), new THREE.Vector3(0, 0, 1), 'bomber');
    const hpBefore = target.hp;
    for (let i = 0; i < 24; i++) {
      h.combat.update(1 / 60, 0.2 + i / 60, idleControls({ fire: true }), new THREE.Vector3(0, 0, 1), h.model.pos);
      h.combat.afterPose();
    }
    expect(target.hp).toBeLessThan(hpBefore - 50);
    expect(h.styleCombos.reversalCritReady).toBe(false);

    // 4. Supersonic / destabilized drone kill triggers recordSonicKill
    const sonicVictim = h.combat.spawnDrone(h.model.pos.clone().add(new THREE.Vector3(30, 0, 30)), new THREE.Vector3(0, 0, 1), 'drone');
    sonicVictim.destabilized = 1.5;
    sonicVictim.damage(9999, sonicVictim.pos, 'ram');
    h.combat.update(1 / 60, 0.4, idleControls(), new THREE.Vector3(0, 0, 1), h.model.pos);
    const feed = h.styleCombos.consumeStyleFeed();
    expect(feed.some((f) => f.reason === 'sonicKill')).toBe(true);
  });

  it('EmergencyManager pauses while missions are active and exposes extraHostiles + R&D/Overcharge rewards', () => {
    const h = makeCombatHarness();
    const rdAwards: Array<{ points: number; reason: string }> = [];
    h.combat.onAwardRd = (points, reason) => rdAwards.push({ points, reason });

    // Trigger falling satellite emergency
    const em = h.combat.emergencies.trigger('satellite', undefined, h.model.pos);
    expect(em.kind).toBe('satellite');
    expect(h.combat.emergencies.extraHostiles).toHaveLength(1);
    const sat = h.combat.emergencies.extraHostiles[0];
    const satY0 = sat.pos.y;

    // Paused while MissionManager mission is running: satellite does not fall
    h.combat.emergenciesPaused = true;
    h.combat.update(0.5, 1.0, idleControls(), new THREE.Vector3(0, 0, 1), h.model.pos);
    expect(sat.pos.y).toBe(satY0);

    // Unpaused: satellite falls and can be destroyed as part of combat target list
    h.combat.emergenciesPaused = false;
    h.combat.update(0.2, 1.2, idleControls(), new THREE.Vector3(0, 0, 1), h.model.pos);
    expect(sat.pos.y).toBeLessThan(satY0);

    sat.damage(9999, sat.pos, 'unibeam');
    h.combat.update(1 / 60, 1.22, idleControls(), new THREE.Vector3(0, 0, 1), h.model.pos);
    expect(h.log.some((e) => e.kind === 'emergencyClear')).toBe(true);
    expect(rdAwards.length).toBeGreaterThan(0);
    expect(h.combat.reactor.overcharge).toBeGreaterThan(0);
  });

  it('Upgrades awards R&D for flight gates/courses & Landmarks advances course cleanly', () => {
    const upgrades = new Upgrades(null);
    const landmarks = new Landmarks({ heightAt: () => 20 });
    const events = new EventBus();
    events.on((e) => upgrades.event(e));

    const gate0 = landmarks.gates[0];
    const p0 = gate0.pos.clone().addScaledVector(gate0.normal, -45);
    const p1 = gate0.pos.clone().addScaledVector(gate0.normal, 45);
    landmarks.update(0.05, p0, 120);
    const res = landmarks.update(0.05, p1, 120);
    expect(res.gatePassed?.index).toBe(0);

    events.emit('gatePass', { value: 1, text: '1/11' });
    expect(upgrades.state.rd).toBe(AWARD.gatePass);

    events.emit('gateCourseClear', { value: 42.5, text: '11/11' });
    expect(upgrades.state.rd).toBe(AWARD.gatePass + AWARD.gateCourseClear);

    upgrades.credit(12);
    expect(upgrades.state.rd).toBe(AWARD.gatePass + AWARD.gateCourseClear + 12);
  });

  it('Soundscape handles all newly added SimEventKinds without errors', () => {
    const play = vi.fn();
    const audio = { ready: true, play } as unknown as GameAudio;
    const soundscape = new Soundscape(audio);
    const model = new FlightModel({
      surface: () => 0,
      isWater: () => false,
      normal: (_x, _z, out = new THREE.Vector3()) => out.set(0, 1, 0),
    });

    const newKinds: SimEventKind[] = [
      'snapDash',
      'diveSlam',
      'grappleGrab',
      'grappleThrow',
      'thrusterPunch',
      'gatePass',
      'gateCourseClear',
      'lightningCharge',
      'styleBonus',
      'ordnanceIntercept',
      'emergencyStart',
      'emergencyClear',
      'proximitySkim',
    ];

    let t = 1;
    for (const kind of newKinds) {
      soundscape.on({ kind, at: new THREE.Vector3(0, 100, 0), value: 1, text: 'test', t: t++ }, model);
    }
    expect(play).toHaveBeenCalledTimes(27);
  });
});
