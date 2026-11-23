import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { Drone, DroneType, Round } from '../combat/drones';
import type { Hostile } from '../combat/types';
import {
  CRUISE_CLEAR_BONUS,
  CRUISE_GRAPPLE_DURATION,
  CRUISE_IMPACT_RADIUS,
  CRUISE_REDIRECT_REWARD,
  CRUISE_SHOOTDOWN_REWARD,
  CRUISE_WAVE1_SPEED,
  CRUISE_WAVE2_SPEED,
  CruiseMissileMission,
} from './cruiseMissile';
import {
  MISSION_DEBRIEF_SECONDS,
  MISSIONS,
  MissionManager,
  RIVAL_CLEAR_REWARD,
} from './missionManager';
import {
  RESCUE_CLEAR_BONUS,
  RESCUE_MAX_REL_SPEED,
  RESCUE_PERFECT_BONUS,
  RESCUE_POD_COUNT,
  RESCUE_POD_REWARD,
  RescueMission,
} from './rescueMission';
import {
  STEALTH_CLEAR_REWARD,
  STEALTH_GHOST_BONUS,
  STEALTH_RADAR_CEILING,
  STEALTH_TURRET_BONUS,
  StealthStrikeMission,
} from './stealthStrike';
import type { MissionCombatAdapter, MissionContext, MissionControls } from './types';

function makeControls(overrides: Partial<MissionControls> = {}): MissionControls {
  return {
    vertical: 0,
    boost: false,
    brake: false,
    pressed: new Set(),
    aimY: 0,
    ...overrides,
  };
}

function makeHarness(opts: { withRival?: boolean } = {}) {
  const padPos = new THREE.Vector3(0, 54.35, 1210);
  const pos = padPos.clone();
  const vel = new THREE.Vector3(0, 0, 0);
  const model = {
    pos,
    vel,
    get speed() {
      return vel.length();
    },
    grounded: false,
    forward: (out = new THREE.Vector3()) => out.set(0, 0, 1),
  };

  let inCloud = 0;
  const world = {
    get inCloud() {
      return inCloud;
    },
    setCloud(v: number) {
      inCloud = v;
    },
    heightAt: () => -60,
    surface: (_x: number, _z: number) => 0,
    isWater: () => true,
  };

  const awards: Array<{ points: number; reason: string }> = [];
  const jarvisLines: string[] = [];
  const launchedMissiles: unknown[] = [];
  const blasts: Array<{ at: THREE.Vector3; size: number }> = [];
  const houseHits: Array<{ at: THREE.Vector3; damage?: number }> = [];
  const spawnedDroneTypes: DroneType[] = [];
  let nextDroneId = 100;

  const hostiles: Hostile[] = [];
  const drones: Drone[] = [];
  const rounds: Round[] = [];
  const group = new THREE.Group();

  let mockRival: Hostile | null = null;

  const combat: MissionCombatAdapter = {
    wavesEnabled: true,
    group,
    hostiles,
    drones,
    guns: { rounds },
    missiles: {
      launch: (m) => {
        launchedMissiles.push(m);
      },
    },
    explosions: {
      blast: (at, size) => {
        blasts.push({ at: at.clone(), size });
      },
      muzzle: () => {},
    },
    playerTarget: {
      pos,
      vel,
      alive: true,
      hit: () => {},
    },
    house: {
      marks: [padPos.clone()],
      struck: (at, damage) => {
        houseHits.push({ at: at.clone(), damage });
      },
    },
    spawnDrone: (at, heading, type = 'drone') => {
      spawnedDroneTypes.push(type);
      const fake = {
        id: nextDroneId++,
        kind: type,
        pos: at.clone(),
        vel: heading.clone().normalize().multiplyScalar(150),
        radius: 2.6,
        hp: 100,
        maxHp: 100,
        alive: true,
        threatened: 0,
        crashed: false,
        mesh: new THREE.Group(),
        damage(amt: number): boolean {
          fake.hp -= amt;
          if (fake.hp <= 0) {
            fake.alive = false;
            return true;
          }
          return false;
        },
      };
      const drone = fake as unknown as Drone;
      drones.push(drone);
      hostiles.push(drone);
      group.add(drone.mesh);
      return drone;
    },
    ...(opts.withRival
      ? {
          spawnRival: () => {
            mockRival = {
              id: 7777,
              kind: 'boss',
              label: 'RIVAL ACE',
              pos: new THREE.Vector3(0, 600, 2600),
              vel: new THREE.Vector3(0, 0, -250),
              radius: 2.4,
              hp: 900,
              maxHp: 900,
              alive: true,
              threatened: 0,
              damage(amt: number) {
                this.hp -= amt;
                if (this.hp <= 0) {
                  this.hp = 0;
                  this.alive = false;
                  return true;
                }
                return false;
              },
            };
            hostiles.push(mockRival);
            return mockRival;
          },
        }
      : {}),
  };

  const ctxBase: Omit<MissionContext, 'root'> = {
    model,
    world,
    combat,
    particles: { emit: vi.fn(), burst: vi.fn() },
    events: {
      emit: (kind, init) => {
        if (kind === 'jarvis' && init?.text) jarvisLines.push(init.text);
      },
    },
    padPos,
    awardRd: (points, reason) => awards.push({ points, reason }),
    playCue: vi.fn(),
  };

  const manager = new MissionManager(ctxBase);
  return {
    manager,
    model,
    world,
    combat,
    padPos,
    awards,
    jarvisLines,
    launchedMissiles,
    blasts,
    houseHits,
    spawnedDroneTypes,
    getRival: () => mockRival,
  };
}

describe('MissionManager architecture & Rival adapter', () => {
  it('exposes all 4 selectable missions and pauses/restores auto-wave spawning cleanly', () => {
    const h = makeHarness();
    expect(h.manager.definitions).toHaveLength(4);
    expect(MISSIONS.map((m) => m.id)).toEqual(['rescue', 'cruise', 'stealth', 'rival']);
    expect(h.combat.wavesEnabled).toBe(true);

    expect(h.manager.startMission('rescue')).toBe(true);
    expect(h.combat.wavesEnabled).toBe(false);
    expect(h.manager.activeId).toBe('rescue');
    expect(h.manager.telemetry?.phase).toBe('active');

    h.manager.abortMission();
    expect(h.combat.wavesEnabled).toBe(true);
    expect(h.manager.activeId).toBeNull();
    expect(h.manager.telemetry).toBeNull();
  });

  it('handles Rival Suit Duel cleanly when spawnRival is not yet integrated', () => {
    const h = makeHarness({ withRival: false });
    expect(h.manager.rivalAvailable).toBe(false);
    expect(h.manager.startMission('rival')).toBe(false);
    // Waves immediately restored and informative standby notice emitted
    expect(h.combat.wavesEnabled).toBe(true);
    expect(h.manager.activeId).toBeNull();
    expect(h.jarvisLines.some((l) => /offline|integration/i.test(l))).toBe(true);
    // Debrief clears after MISSION_DEBRIEF_SECONDS
    h.manager.update(MISSION_DEBRIEF_SECONDS + 0.1, makeControls());
    expect(h.manager.telemetry).toBeNull();
  });

  it('launches and completes Rival Suit Duel when combat.spawnRival is present', () => {
    const h = makeHarness({ withRival: true });
    expect(h.manager.rivalAvailable).toBe(true);
    expect(h.manager.startMission('rival')).toBe(true);
    expect(h.combat.wavesEnabled).toBe(false);

    const rival = h.getRival()!;
    expect(rival).toBeTruthy();
    rival.damage(9999, rival.pos, 'unibeam');

    const tel = h.manager.update(0.05, makeControls());
    expect(tel?.phase).toBe('victory');
    expect(h.manager.completed.has('rival')).toBe(true);
    expect(h.combat.wavesEnabled).toBe(true);
    expect(h.awards.some((a) => a.points === RIVAL_CLEAR_REWARD)).toBe(true);
  });
});

describe('Mid-Air Rescue ("Barrel of Monkeys")', () => {
  it('deploys 4 pods at 2200–3200 m, warns on Mach flyby, catches when speed matched, and delivers to Malibu PAD', () => {
    const h = makeHarness();
    h.manager.startMission('rescue');
    const mission = h.manager.current as RescueMission;
    expect(mission.pods).toHaveLength(RESCUE_POD_COUNT);
    for (const p of mission.pods) {
      expect(p.pos.y).toBeGreaterThanOrEqual(2200);
      expect(p.pos.y).toBeLessThanOrEqual(3200);
    }

    // Attempt a Mach 1 pass through Pod 1 -> should warn, NOT catch
    const pod1 = mission.pods[0];
    h.model.pos.copy(pod1.pos);
    h.model.vel.set(0, 0, 340);
    const fastTel = h.manager.update(0.05, makeControls());
    expect(mission.carrying).toBeNull();
    expect(pod1.state).toBe('falling');
    expect(fastTel?.warning).toMatch(/TOO FAST/i);
    expect(h.jarvisLines.some((l) => /Too fast, sir/i.test(l))).toBe(true);

    // Match descent velocity (<35 m/s relative) -> catches pod & spawns harassing drones
    h.model.pos.copy(pod1.pos);
    h.model.vel.copy(pod1.vel).add(new THREE.Vector3(5, 0, 0));
    expect(h.model.vel.distanceTo(pod1.vel)).toBeLessThan(RESCUE_MAX_REL_SPEED);
    h.manager.update(0.05, makeControls());
    expect(mission.carrying).toBe(pod1);
    expect(pod1.state).toBe('carrying');
    expect(h.spawnedDroneTypes.length).toBeGreaterThanOrEqual(2);

    // Fly back and hover over Malibu PAD -> delivers pod and awards R&D
    h.model.pos.copy(h.padPos).add(new THREE.Vector3(0, 6, 0));
    h.model.vel.set(0, 0, 0);
    h.manager.update(0.05, makeControls());
    expect(mission.carrying).toBeNull();
    expect(pod1.state).toBe('rescued');
    expect(mission.rescuedCount).toBe(1);
    expect(h.awards.some((a) => a.points === RESCUE_POD_REWARD)).toBe(true);

    // Catch and deliver the remaining 3 pods for a perfect victory
    for (let i = 1; i < RESCUE_POD_COUNT; i++) {
      const pod = mission.pods[i];
      h.model.pos.copy(pod.pos);
      h.model.vel.copy(pod.vel);
      h.manager.update(0.05, makeControls());
      expect(mission.carrying).toBe(pod);

      h.model.pos.copy(h.padPos).add(new THREE.Vector3(0, 4, 0));
      h.model.vel.set(0, 0, 0);
      h.manager.update(0.05, makeControls());
      expect(pod.state).toBe('rescued');
    }

    expect(mission.outcome).toBe('victory');
    expect(h.manager.completed.has('rescue')).toBe(true);
    expect(h.combat.wavesEnabled).toBe(true);
    // Perfect clear pays 4*pod + clear + perfect bonus
    const totalRd = h.awards.reduce((s, a) => s + a.points, 0);
    expect(totalRd).toBe(RESCUE_POD_COUNT * RESCUE_POD_REWARD + RESCUE_CLEAR_BONUS + RESCUE_PERFECT_BONUS);
    // Harassing mission drones cleaned up on mission end
    expect(h.combat.drones).toHaveLength(0);
  });

  it('fails if too many pods splash into the ocean', () => {
    const h = makeHarness();
    h.manager.startMission('rescue');
    const mission = h.manager.current as RescueMission;
    // Drop 3 pods near sea level so they splash down
    for (let i = 0; i < 3; i++) {
      mission.pods[i].pos.y = 2;
    }
    // Rescue pod 4 alone (1/4 < min 2)
    mission.pods[3].pos.y = 2;
    h.manager.update(0.2, makeControls());
    expect(mission.lostCount).toBe(4);
    expect(mission.outcome).toBe('failed');
    expect(h.manager.activeId).toBeNull();
    expect(h.combat.wavesEnabled).toBe(true);
  });
});

describe('Cruise Missile Intercept & Redirect', () => {
  it('supports Heroic Redirect (18m proximity grapple + climb >35° for 1.5s) and Weapon Shootdown across 2 waves', () => {
    const h = makeHarness();
    h.manager.startMission('cruise');
    const mission = h.manager.current as CruiseMissileMission;

    const m1 = mission.activeMissile!;
    expect(m1).toBeTruthy();
    expect(m1.targetSpeed).toBe(CRUISE_WAVE1_SPEED);
    expect(h.combat.hostiles).toContain(m1);

    // Stay within 18 m of Wave 1 missile at matched speed while holding climb (KeyE / vertical=1)
    for (let step = 0; step < 35 && mission.activeMissile === m1; step++) {
      h.model.pos.copy(m1.pos).add(new THREE.Vector3(0, -4, 0));
      h.model.vel.copy(m1.vel);
      h.manager.update(0.06, makeControls({ vertical: 1, aimY: 0.45 }));
    }

    expect(CRUISE_GRAPPLE_DURATION).toBe(1.5);
    expect(m1.redirected).toBe(true);
    expect(m1.alive).toBe(false);
    expect(h.combat.hostiles).not.toContain(m1);
    expect(mission.redirectedCount).toBe(1);
    expect(h.awards.some((a) => a.points === CRUISE_REDIRECT_REWARD && a.reason === 'MISSILE REDIRECTED')).toBe(true);

    // Advance past inter-wave delay -> Wave 2 faster missile launches
    for (let i = 0; i < 40 && !mission.activeMissile; i++) {
      h.manager.update(0.1, makeControls());
    }
    const m2 = mission.activeMissile!;
    expect(m2).toBeTruthy();
    expect(m2.targetSpeed).toBe(CRUISE_WAVE2_SPEED);
    expect(m2.targetSpeed).toBeGreaterThan(m1.targetSpeed);

    // Shoot down Wave 2 with weapons
    m2.damage(9999, m2.pos, 'unibeam');
    const finalTel = h.manager.update(0.05, makeControls());
    expect(finalTel?.phase).toBe('victory');
    expect(mission.stoppedCount).toBe(2);
    expect(h.manager.completed.has('cruise')).toBe(true);
    expect(h.awards.some((a) => a.points === CRUISE_SHOOTDOWN_REWARD)).toBe(true);
    expect(h.awards.some((a) => a.points === CRUISE_CLEAR_BONUS)).toBe(true);
  });

  it('fails if an un-stopped cruise missile impacts the Malibu house', () => {
    const h = makeHarness();
    h.manager.startMission('cruise');
    const mission = h.manager.current as CruiseMissileMission;
    const m1 = mission.activeMissile!;
    // Move missile just outside impact radius heading straight into pad
    m1.pos.copy(h.padPos).add(new THREE.Vector3(0, 0, CRUISE_IMPACT_RADIUS - 10));
    const tel = h.manager.update(0.05, makeControls());
    expect(m1.struckHouse).toBe(true);
    expect(tel?.phase).toBe('failed');
    expect(h.houseHits.length).toBeGreaterThanOrEqual(1);
    expect(h.combat.wavesEnabled).toBe(true);
  });
});

describe('Sea-Skimming Stealth Strike', () => {
  it('masks below 38 m AGL and in clouds, triggers SAM/interceptor alert at 100% radar lock, and awards Ghost bonus if undetected', () => {
    const h = makeHarness();
    h.manager.startMission('stealth');
    const mission = h.manager.current as StealthStrikeMission;
    expect(mission.mast).toBeTruthy();
    expect(mission.turrets).toHaveLength(2);

    // Fly at 22 m AGL inside radar range -> STEALTH: MASKED, radarLock stays 0
    h.model.pos.copy(mission.relayPos).add(new THREE.Vector3(0, 22, -1500));
    const lowTel = h.manager.update(0.5, makeControls());
    expect(mission.masked).toBe(true);
    expect(mission.radarLock).toBe(0);
    expect(lowTel?.badge?.text).toMatch(/MASKED/i);

    // Climb to 1500 m INSIDE a cloud (inCloud > 0.25) -> still masked!
    h.model.pos.y = 1500;
    h.world.setCloud(0.6);
    const cloudTel = h.manager.update(0.5, makeControls());
    expect(mission.masked).toBe(true);
    expect(mission.maskedBy).toBe('cloud');
    expect(mission.radarLock).toBe(0);
    expect(cloudTel?.badge?.text).toMatch(/CLOUD/i);

    // Destroy optional turret + primary mast while undetected -> Ghost Strike bonus!
    mission.turrets[0].damage(999, mission.turrets[0].pos, 'repulsor');
    h.manager.update(0.05, makeControls());
    expect(h.awards.some((a) => a.points === STEALTH_TURRET_BONUS)).toBe(true);

    mission.mast!.damage(9999, mission.mast!.pos, 'unibeam');
    const winTel = h.manager.update(0.05, makeControls());
    expect(winTel?.phase).toBe('victory');
    expect(h.awards.some((a) => a.points === STEALTH_CLEAR_REWARD + STEALTH_GHOST_BONUS)).toBe(true);
  });

  it('fills radar lock above 38 m in open air, fires SAM salvos & scrambles interceptors, and breaks lock when diving back low', () => {
    const h = makeHarness();
    h.manager.startMission('stealth');
    const mission = h.manager.current as StealthStrikeMission;

    // Fly exposed at 220 m AGL in open air 1.2 km from AEGIS relay
    h.world.setCloud(0);
    h.model.pos.copy(mission.relayPos).add(new THREE.Vector3(0, STEALTH_RADAR_CEILING + 180, -1200));

    for (let i = 0; i < 40; i++) {
      h.manager.update(0.15, makeControls());
    }
    expect(mission.masked).toBe(false);
    expect(mission.radarLock).toBe(1);
    expect(mission.alerted).toBe(true);
    expect(mission.everAlerted).toBe(true);
    expect(h.launchedMissiles.length).toBeGreaterThanOrEqual(1);
    expect(h.spawnedDroneTypes).toContain('interceptor');

    // Dive back below 38 m AGL -> radar lock drains and alert clears
    h.model.pos.y = 18;
    for (let i = 0; i < 30; i++) {
      h.manager.update(0.15, makeControls());
    }
    expect(mission.masked).toBe(true);
    expect(mission.radarLock).toBe(0);
    expect(mission.alerted).toBe(false);

    // Completing after an alert awards base reward without Ghost bonus
    mission.mast!.damage(9999, mission.mast!.pos, 'missile');
    h.manager.update(0.05, makeControls());
    expect(mission.outcome).toBe('victory');
    expect(h.awards.some((a) => a.points === STEALTH_CLEAR_REWARD)).toBe(true);
    expect(h.awards.some((a) => a.points === STEALTH_CLEAR_REWARD + STEALTH_GHOST_BONUS)).toBe(false);
  });
});
