import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { Suit } from '../../suit/Suit';
import type { Particles } from '../fx/particles';
import { CruiseMissileMission } from '../missions/cruiseMissile';
import { MissionManager, RIVAL_CLEAR_REWARD } from '../missions/missionManager';
import { RescueMission } from '../missions/rescueMission';
import { StealthStrikeMission } from '../missions/stealthStrike';
import type { MissionControls } from '../missions/types';
import { EventBus, type SimEvent } from '../sim/events';
import { FlightModel } from '../sim/flightModel';
import type { Controls } from '../sim/input';
import { MODE_MODIFIERS, REACTOR_KEYS } from '../sim/reactorPower';
import type { Heightfield } from '../world/heightfield';
import { Combat } from './combat';
import type { SurfaceQuery } from './explosions';
import { RAM_MIN_SPEED, UNIBEAM_BASE_COOL, WATER_COOL_BONUS } from './physicsWeapons';
import { RIVAL_BEAM_CHARGE, RivalSuit } from './rivalSuit';

// Headless canvas stub for glow/flare textures used by Missiles, PlayerWeapons, RivalSuit
const ctx2d = new Proxy({}, { get: () => () => ({ addColorStop() {} }) });
vi.stubGlobal('document', { createElement: () => ({ getContext: () => ctx2d }) });

function idleControls(pressed: string[] = []): Controls {
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
  };
}

function idleMissionControls(overrides: Partial<MissionControls> = {}): MissionControls {
  return {
    vertical: 0,
    boost: false,
    brake: false,
    pressed: new Set(),
    aimY: 0,
    ...overrides,
  };
}

function makeIntegratedHarness() {
  const ground: SurfaceQuery & { water: boolean; y: number } = {
    water: true,
    y: 0,
    surface: () => ground.y,
    isWater: () => ground.water,
  };

  const field = {
    heightAt: () => -40,
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
  model.pos.set(0, 500, 1210);
  model.vel.set(0, 0, 0);

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

  const awards: Array<{ points: number; reason: string }> = [];
  const padPos = new THREE.Vector3(0, 54.35, 1210);
  const missions = new MissionManager({
    model,
    world: {
      inCloud: 0,
      heightAt: (x, z) => field.heightAt(x, z),
      surface: (x, z) => ground.surface(x, z),
      isWater: (x, z) => ground.isWater(x, z),
    },
    combat,
    particles,
    events,
    padPos,
    awardRd: (points, reason) => awards.push({ points, reason }),
    playCue: vi.fn(),
  });

  return { combat, missions, model, ground, particles, events, log, awards, padPos };
}

describe('Cross-Pillar Integration (Pillars 1–3)', () => {
  it('Pillar 3A ↔ 3B: launches RivalDuelMission via MissionManager with real Combat.spawnRival() and handles abort + victory cleanly', () => {
    const h = makeIntegratedHarness();
    expect(h.missions.rivalAvailable).toBe(true);
    expect(h.combat.wavesEnabled).toBe(true);

    // Launch real Rival Suit Duel through MissionManager
    expect(h.missions.startMission('rival')).toBe(true);
    expect(h.combat.wavesEnabled).toBe(false);
    expect(h.combat.rival).toBeInstanceOf(RivalSuit);
    const rival1 = h.combat.rival!;
    expect(h.combat.hostiles).toContain(rival1);

    // Abort cleans up the real RivalSuit, restores waves, and leaves zero orphaned hostiles
    h.missions.abortMission(true);
    expect(rival1.alive).toBe(false);
    expect(rival1.crashed).toBe(true);
    expect(h.combat.hostiles).not.toContain(rival1);
    expect(h.combat.wavesEnabled).toBe(true);

    // Re-launching spawns a fresh RivalSuit and defeating it completes the mission + feeds reactor overcharge
    expect(h.missions.startMission('rival')).toBe(true);
    const rival2 = h.combat.rival!;
    expect(rival2).toBeInstanceOf(RivalSuit);
    expect(rival2).not.toBe(rival1);
    expect(rival2.alive).toBe(true);

    const ocBefore = h.combat.reactor.overcharge;
    rival2.damage(9999, rival2.pos, 'unibeam');
    h.combat.update(1 / 60, 1, idleControls(), new THREE.Vector3(0, 0, -1), h.model.pos);
    const tel = h.missions.update(1 / 60, idleMissionControls());

    expect(tel?.phase).toBe('victory');
    expect(h.missions.completed.has('rival')).toBe(true);
    expect(h.combat.wavesEnabled).toBe(true);
    expect(h.awards.some((a) => a.points === RIVAL_CLEAR_REWARD)).toBe(true);
    expect(h.combat.reactor.overcharge).toBeGreaterThan(ocBefore);
    expect(h.combat.reactor.lastFeedReason).toBe('rivalDefeated');
  });

  it('Pillar 2 ↔ 3A: Rival Ace Unibeam striking player in SHIELDS mode feeds ReactorPower toward 400% overcharge', () => {
    const h = makeIntegratedHarness();
    const rival = h.combat.spawnRival(h.model.pos);
    h.model.pos.set(0, 600, 0);
    h.model.vel.set(0, 0, 0);
    rival.pos.set(0, 600, 320);
    rival.vel.set(0, 0, -100);
    rival.mode = 'strafe';
    (rival as unknown as { beamCooldown: number }).beamCooldown = 0;

    // Route reactor power to SHIELDS via Digit3
    h.combat.reactor.handleInput(new Set([REACTOR_KEYS.SHIELDS]), h.model.pos);
    expect(h.combat.reactor.mode).toBe('SHIELDS');
    expect(h.combat.reactor.overcharge).toBe(0);

    // Advance combat until Rival charges and sweeps its Unibeam onto the shielded player
    const aim = new THREE.Vector3(0, 0, 1);
    let t = 0;
    const totalSteps = Math.round((RIVAL_BEAM_CHARGE + 1.4) * 60);
    for (let i = 0; i < totalSteps; i++) {
      t += 1 / 60;
      h.events.time = t;
      h.combat.update(1 / 60, t, idleControls(), aim, h.model.pos);
      if (h.combat.reactor.overchargeActive) break;
    }

    // Rival beam energy was absorbed into the overcharge capacitor (and/or triggered 400% overcharge)
    expect(h.combat.reactor.lastFeedReason).toBe('rivalBeam');
    expect(h.combat.reactor.overchargeActive || h.combat.reactor.overcharge > 0.15).toBe(true);
  });

  it('Pillar 1 ↔ 2: Water-Cooling composes cleanly with THRUST cooling modifier and 400% Overcharge', () => {
    const h = makeIntegratedHarness();
    h.model.wetness = 0.8;
    h.model.immersion = 0;
    h.combat.weapons.unibeamOn = false;

    // In THRUST mode (unibeamCool = 1/0.7), water cooling scales proportionally with reactorCool
    h.combat.reactor.setMode('THRUST');
    const thrustCool = MODE_MODIFIERS.THRUST.unibeamCool;
    h.combat.weapons.unibeamHeat = 0.8;
    const dt = 0.5;
    h.combat.physics.updateWaterAndSplash(
      dt,
      h.model,
      h.combat.weapons,
      h.combat.missiles,
      h.ground,
      h.particles,
      h.events,
    );
    const expectedBonus = (WATER_COOL_BONUS * dt) / (UNIBEAM_BASE_COOL * h.combat.weapons.spec.unibeamCool * thrustCool);
    expect(h.combat.weapons.unibeamHeat).toBeCloseTo(0.8 - expectedBonus, 5);

    // During 400% OVERCHARGE, unibeamHeat stays 0 and water-cooling does not fight overcharge
    h.combat.reactor.feedOvercharge(1.0, 'testOvercharge');
    expect(h.combat.reactor.overchargeActive).toBe(true);
    h.combat.update(1 / 60, 1, idleControls(), new THREE.Vector3(0, 0, 1), h.model.pos);
    expect(h.combat.weapons.unibeamHeat).toBe(0);
    expect(h.combat.weapons.unibeamOverheat).toBe(false);
  });

  it('Pillar 1 ↔ 3: Kinetic Ram & Hero-Landing Shockwave protect Rescue pods & Cruise Missile redirect while hitting mission hostiles', () => {
    const h = makeIntegratedHarness();

    // 1. Mid-Air Rescue: Hero-Landing & high-speed flyby do NOT break rescue pods,
    //    while Kinetic Ram cleanly takes down Rescue harassing drones.
    expect(h.missions.startMission('rescue')).toBe(true);
    const rescue = h.missions.current as RescueMission;
    const pod = rescue.pods[0];

    // Hero-landing right near pod leaves pod intact
    h.combat.onHeroLanding(pod.pos.clone(), 40);
    expect(pod.state).toBe('falling');

    // Catch pod to spawn harassing drones, then kinetic-ram one at high speed
    h.model.pos.copy(pod.pos);
    h.model.vel.copy(pod.vel);
    h.missions.update(0.05, idleMissionControls());
    expect(rescue.carrying).toBe(pod);
    expect(h.combat.drones.length).toBeGreaterThanOrEqual(2);

    const escort = h.combat.drones[0];
    const start = escort.pos.clone().add(new THREE.Vector3(0, 0, -20));
    h.model.pos.copy(start);
    h.model.vel.set(0, 0, RAM_MIN_SPEED + 80);
    h.model.boosting = true;
    // Seed prevSuitPos, then fly straight through escort drone
    h.combat.physics.updateKineticRam(1 / 60, h.model, h.combat.drones, h.combat.playerTarget, h.particles, h.combat.explosions, h.events);
    h.model.pos.copy(escort.pos).add(new THREE.Vector3(0, 0, 20));
    const rams = h.combat.physics.updateKineticRam(1 / 60, h.model, h.combat.drones, h.combat.playerTarget, h.particles, h.combat.explosions, h.events);
    expect(rams).toBe(1);
    expect(escort.alive).toBe(false);
    expect(pod.state).toBe('carrying');

    // 2. Cruise Missile: High-speed close pass for Heroic Redirect does NOT trigger Kinetic Ram kill
    expect(h.missions.startMission('cruise')).toBe(true);
    const cruise = h.missions.current as CruiseMissileMission;
    const missile = cruise.activeMissile!;
    h.model.pos.copy(missile.pos).add(new THREE.Vector3(0, 0, -5));
    h.model.vel.copy(missile.vel);
    h.combat.physics.updateKineticRam(1 / 60, h.model, h.combat.drones, h.combat.playerTarget, h.particles, h.combat.explosions, h.events);
    h.model.pos.copy(missile.pos).add(new THREE.Vector3(0, 0, 5));
    const missileRams = h.combat.physics.updateKineticRam(1 / 60, h.model, h.combat.drones, h.combat.playerTarget, h.particles, h.combat.explosions, h.events);
    expect(missileRams).toBe(0);
    expect(missile.alive).toBe(true);
    expect(missile.hp).toBe(missile.maxHp);

    // 3. Stealth Strike: Hero-Landing Shockwave damages/destroys AEGIS escort turrets
    expect(h.missions.startMission('stealth')).toBe(true);
    const stealth = h.missions.current as StealthStrikeMission;
    const turret = stealth.turrets[0];
    const hpBefore = turret.hp;
    const slamShake = h.combat.onHeroLanding(turret.pos.clone(), 42);
    expect(slamShake).toBeGreaterThan(0);
    expect(turret.hp).toBeLessThan(hpBefore);

    h.missions.abortMission(true);
  });

  it('Keybind audit: all cross-pillar bindings are unique and conflict-free', () => {
    const bindings: Record<string, string> = {
      reactorThrust: REACTOR_KEYS.THRUST,
      reactorWeapons: REACTOR_KEYS.WEAPONS,
      reactorShields: REACTOR_KEYS.SHIELDS,
      reactorBalanced: REACTOR_KEYS.BALANCED,
      laserCutter: REACTOR_KEYS.LASER_CUTTER,
      overcharge: REACTOR_KEYS.OVERCHARGE,
      missionsDrawer: 'KeyJ',
      climbOrRedirect: 'KeyE',
      resetOrRedeploy: 'KeyR',
      cameraCycle: 'KeyV',
      callWave: 'KeyN',
      autoLand: 'Tab',
      flares: 'KeyF',
      launchers: 'KeyG',
      unibeam: 'Space',
    };
    const codes = Object.values(bindings);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
