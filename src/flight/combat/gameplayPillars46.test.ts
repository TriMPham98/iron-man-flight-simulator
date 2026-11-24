import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { Suit } from '../../suit/Suit';
import type { Particles } from '../fx/particles';
import { EventBus, type SimEvent } from '../sim/events';
import { FlightModel } from '../sim/flightModel';
import type { Controls } from '../sim/input';
import { OVERCHARGE_DURATION, REACTOR_KEYS, ReactorPower } from '../sim/reactorPower';
import { AWARD, STOCK_SPEC, UPGRADES, Upgrades, capstoneTier, type Store } from '../sim/upgrades';
import { HOME, HOME_HEIGHT, type Heightfield } from '../world/heightfield';
import { Combat } from './combat';
import { BOMB_BAY_CRIT_MULT, BOMB_CHAIN_RADIUS } from './drones';
import type { SurfaceQuery } from './explosions';
import { CIWS_L3_RANGE, CIWS_L5_RANGE } from './houseCiws';
import { HOT_SWAP_AUTO_R, HOUSE_PARTY_KEY } from './houseParty';
import { RIVAL_FLARE_COOLDOWN, RIVAL_ICING_ALT, RivalSuit } from './rivalSuit';
import type { PlayerTarget } from './types';

// Headless canvas stub for glow/flare textures
const ctx2d = new Proxy({}, { get: () => () => ({ addColorStop() {} }) });
vi.stubGlobal('document', { createElement: () => ({ getContext: () => ctx2d }) });

function idleControls(pressed: string[] = [], overrides: Partial<Controls> = {}): Controls {
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

function makeHarness() {
  const ground: SurfaceQuery & { water: boolean; y: number } = {
    water: true,
    y: 0,
    surface: () => ground.y,
    isWater: () => ground.water,
  };

  const field = {
    heightAt: () => HOME_HEIGHT,
    surfaceAt: () => HOME_HEIGHT,
    raycast: () => -1,
    normalAt: (_x: number, _z: number, out = new THREE.Vector3()) => out.set(0, 1, 0),
    inBounds: () => true,
  } as unknown as Heightfield;

  const model = new FlightModel({
    surface: (x, z) => ground.surface(x, z),
    isWater: (x, z) => ground.isWater(x, z),
    normal: (_x, _z, out = new THREE.Vector3()) => out.set(0, 1, 0),
  });
  model.pos.set(HOME.x, 500, HOME.y);
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
        siloMuzzle: () => ({ ok: false, caliber: 0 }),
        launcherMuzzle: () => ({ ok: false, caliber: 0, length: 0 }),
      },
      modelWorld: new THREE.Matrix4(),
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
  return { combat, model, ground, particles, events, log };
}

describe('Pillar 4A — R&D Capstone Perks (L3 unlock, L5 upgrade)', () => {
  it('defines L3 and L5 capstone perks on every upgrade and scales tiers cleanly', () => {
    expect(capstoneTier(0)).toBe(0);
    expect(capstoneTier(2)).toBe(0);
    expect(capstoneTier(3)).toBe(1);
    expect(capstoneTier(4)).toBe(1);
    expect(capstoneTier(5)).toBe(2);

    for (const up of UPGRADES) {
      expect(up.perks.length, up.id).toBe(2);
      expect(up.perks[0].level).toBe(3);
      expect(up.perks[1].level).toBe(5);
      expect(up.perks[0].name.length).toBeGreaterThan(2);
      expect(up.perks[1].desc.length).toBeGreaterThan(8);
    }

    const s3 = STOCK_SPEC();
    const s5 = STOCK_SPEC();
    for (const up of UPGRADES) {
      up.apply(s3, 3);
      up.apply(s5, 5);
    }
    expect(s3.repulsorBlastTier).toBe(1);
    expect(s5.repulsorBlastTier).toBe(2);
    expect(s3.missileRearAspect).toBe(1);
    expect(s5.missileRearAspect).toBe(2);
    expect(s3.houseCiwsTier).toBe(1);
    expect(s5.houseCiwsTier).toBe(2);
    expect(s5.machAuraTier).toBe(2);
    expect(s5.boostSpeed).toBeCloseTo(1.35, 3);
  });

  it('Arc Reactor L3/L5 capstones boost overcharge gain rate and duration', () => {
    const r = new ReactorPower();
    expect(r.overchargeDuration).toBe(OVERCHARGE_DURATION);
    r.capTier = 1;
    expect(r.overchargeDuration).toBe(OVERCHARGE_DURATION + 2);
    expect(r.feedOvercharge(0.4, 'test')).toBeCloseTo(0.54, 4);

    r.reset();
    r.capTier = 2;
    expect(r.overchargeDuration).toBe(OVERCHARGE_DURATION + 4);
    r.feedOvercharge(0.6, 'test');
    expect(r.overchargeActive).toBe(true);
    expect(r.overchargeRemaining).toBe(OVERCHARGE_DURATION + 4);
  });

  it('Micro-Missiles L5 enables 360° rear-aspect helmet locks behind the suit', () => {
    const h = makeHarness();
    // Target directly behind the player's aim vector (+Z aim, hostile at -Z)
    const behind = h.combat.spawnDrone(new THREE.Vector3(HOME.x, 500, HOME.y - 400), new THREE.Vector3(0, 0, 1), 'drone');
    const aim = new THREE.Vector3(0, 0, 1);

    // Stock suit cannot lock targets behind it
    for (let i = 0; i < 40; i++) {
      h.combat.update(1 / 30, i / 30, idleControls([], { missile: true }), aim, h.model.pos);
    }
    expect(h.combat.weapons.locks.length).toBe(0);

    // L5 Micro-Missiles (missileRearAspect = 2) locks targets 360° behind the suit!
    h.combat.weapons.spec.missileRearAspect = 2;
    for (let i = 0; i < 40; i++) {
      h.combat.update(1 / 30, 2 + i / 30, idleControls([], { missile: true }), aim, h.model.pos);
    }
    expect(h.combat.weapons.locks).toContain(behind);
  });

  it('Armour L3/L5 Reactive Pulse triggers below 25% armour and L5 restores armour + overcharge', () => {
    const h = makeHarness();
    h.combat.spec.armorOverdriveTier = 2;
    const nearby = h.combat.spawnDrone(new THREE.Vector3(HOME.x + 40, 500, HOME.y), new THREE.Vector3(-1, 0, 0), 'drone');

    // Drop armour from 1.0 down to 0.20 in one heavy hit
    h.combat.playerTarget.hit(80, h.model.pos, 'missile');
    expect(h.log.some((e) => e.kind === 'reactivePulse' && e.value === 2)).toBe(true);
    expect(h.combat.reactiveBraceT).toBeGreaterThan(0);
    // L5 Auto-Nanite Surge restores +0.15 armour and feeds +0.25 overcharge
    expect(h.combat.armor).toBeCloseTo(0.35, 2);
    expect(h.combat.reactor.overcharge).toBeCloseTo(0.25, 2);
    expect(nearby.destabilized).toBeGreaterThan(0);
  });

  it('House Defences L3/L5 deploys visible Malibu CIWS turrets that damage incoming bombers', () => {
    const h = makeHarness();
    const bomber = h.combat.spawnDrone(new THREE.Vector3(HOME.x + 250, HOME_HEIGHT + 220, HOME.y), new THREE.Vector3(-1, 0, 0), 'bomber');
    const hpBefore = bomber.hp;

    h.combat.spec.houseCiwsTier = 1;
    for (let i = 0; i < 30; i++) {
      h.combat.update(1 / 30, i / 30, idleControls(), new THREE.Vector3(0, 0, 1), h.model.pos);
    }
    expect(h.combat.houseCiws.activeTurretCount).toBe(2);
    expect(h.combat.houseCiws.range).toBe(CIWS_L3_RANGE);
    expect(bomber.hp).toBeLessThan(hpBefore);

    h.combat.spec.houseCiwsTier = 2;
    h.combat.update(1 / 30, 2, idleControls(), new THREE.Vector3(0, 0, 1), h.model.pos);
    expect(h.combat.houseCiws.activeTurretCount).toBe(4);
    expect(h.combat.houseCiws.range).toBe(CIWS_L5_RANGE);
  });

  it('Propulsion L5 Mach 2.0 Supercruise Aura shatters close enemy seekers while boosting supersonic', () => {
    const h = makeHarness();
    h.model.vel.set(0, 0, 420);
    h.model.boosting = true;
    // Launch an enemy seeker 30 m from player
    h.combat.missiles.launch({
      team: 'enemy',
      from: h.model.pos.clone().add(new THREE.Vector3(0, 0, 30)),
      vel: new THREE.Vector3(0, 0, -100),
      target: h.combat.playerTarget,
    });
    expect(h.combat.missiles.live.length).toBe(1);
    const res = h.combat.physics.updateMachAura(1 / 60, h.model, h.combat.drones, h.combat.missiles, h.particles, 2);
    expect(res.missilesShattered).toBe(1);
    expect(h.combat.missiles.live.length).toBe(0);
  });
});

describe('Pillar 4B — House Party Protocol (Autonomous Wingmen + Mid-Air Hot-Swap)', () => {
  it('deploys 1 autonomous wingman on KeyP (or 2 once >=10 levels fitted) and engages hostiles', () => {
    const h = makeHarness();
    h.combat.fittedLevels = 12;
    const enemy = h.combat.spawnDrone(new THREE.Vector3(HOME.x + 120, 520, HOME.y), new THREE.Vector3(-1, 0, 0), 'drone');

    h.combat.update(1 / 60, 0.1, idleControls([HOUSE_PARTY_KEY]), new THREE.Vector3(0, 0, 1), h.model.pos);
    expect(h.combat.houseParty.activeCount).toBe(2);
    expect(h.log.some((e) => e.kind === 'housePartyLaunch' && e.value === 2)).toBe(true);

    // Step wingmen forward so they fly out and fire repulsors at the hostile
    for (let i = 0; i < 90; i++) {
      h.combat.update(1 / 30, 0.2 + i / 30, idleControls(), new THREE.Vector3(0, 0, 1), h.model.pos);
    }
    expect(h.combat.houseParty.wingmen.some((w) => w.target === enemy)).toBe(true);
    expect(h.log.some((e) => e.kind === 'repulsorFire')).toBe(true);
  });

  it('triggers Mid-Air Hot-Swap when armour fails at 0 reserves and restores full armour on catch', () => {
    const h = makeHarness();
    h.combat.reserves = 0;
    h.model.pos.set(HOME.x, 600, HOME.y);

    // Fatal hit with 0 reserves -> Hot-Swap intercepts instead of immediate suitLost!
    h.combat.playerTarget.hit(150, h.model.pos, 'missile');
    expect(h.combat.lost).toBe(false);
    expect(h.combat.houseParty.hotSwapActive).toBe(true);
    expect(h.log.some((e) => e.kind === 'hotSwapLaunch')).toBe(true);

    // Move pod into auto-catch range and step -> full suit swap!
    h.combat.houseParty.podPos.copy(h.model.pos).add(new THREE.Vector3(0, 0, HOT_SWAP_AUTO_R - 2));
    h.combat.update(1 / 60, 1, idleControls(), new THREE.Vector3(0, 0, 1), h.model.pos);

    expect(h.combat.houseParty.hotSwapActive).toBe(false);
    expect(h.combat.down).toBe(0);
    expect(h.combat.armor).toBe(1);
    expect(h.combat.reactor.overcharge).toBeCloseTo(0.35, 2);
    expect(h.log.some((e) => e.kind === 'hotSwapCatch')).toBe(true);

    // Second fatal hit while Hot-Swap is expended -> now loses the suit normally
    h.combat.reactiveBraceT = 0;
    h.combat.playerTarget.hit(200, h.model.pos, 'missile');
    expect(h.combat.lost).toBe(true);
  });
});

describe('Pillar 6B — Enemy Polish (Bomber Payload Chain-Detonations & Rival Ace Counter-Play)', () => {
  it('opens bomber belly bomb bay on approach, applies 1.75× crit damage, and chain-detonates nearby escorts', () => {
    const h = makeHarness();
    const bomber = h.combat.spawnDrone(new THREE.Vector3(HOME.x + 900, 560, HOME.y), new THREE.Vector3(-1, 0, 0), 'bomber');
    const escort = h.combat.spawnDrone(
      bomber.pos.clone().add(new THREE.Vector3(0, 0, BOMB_CHAIN_RADIUS * 0.4)),
      new THREE.Vector3(-1, 0, 0),
      'drone',
    );

    // Step combat so bomber lines up on the house and opens its bomb bay
    h.combat.update(1 / 60, 0.1, idleControls(), new THREE.Vector3(0, 0, 1), h.model.pos);
    expect(bomber.bayOpen).toBe(true);

    // Verify 1.75× critical damage while bay is open
    const hp0 = bomber.hp;
    bomber.damage(100, bomber.pos, 'repulsor');
    expect(bomber.hp).toBeCloseTo(hp0 - 100 * BOMB_BAY_CRIT_MULT, 3);

    // Finish off bomber while bay is open -> chain-detonation kills nearby escort + emits payloadDetonation
    bomber.damage(500, bomber.pos, 'repulsor');
    expect(bomber.payloadDetonated).toBe(true);
    h.combat.update(1 / 60, 0.2, idleControls(), new THREE.Vector3(0, 0, 1), h.model.pos);

    expect(escort.alive).toBe(false);
    const det = h.log.find((e) => e.kind === 'payloadDetonation');
    expect(det).toBeDefined();
    expect(det?.value).toBe(1);

    // Verify R&D payout on payloadDetonation
    const data = new Map<string, string>();
    const store: Store = { getItem: (k) => data.get(k) ?? null, setItem: (k, val) => void data.set(k, val) };
    const u = new Upgrades(store);
    u.event({ kind: 'payloadDetonation', t: 1, value: 1 });
    expect(u.state.rd).toBe(AWARD.payloadDetonation + 15);
  });

  it('Rival Ace adapts to predictable climb lures with a predictive Unibeam and tightens flares against missile spam', () => {
    const h = makeHarness();
    const rival = new RivalSuit(new THREE.Vector3(0, 5400, 600), new THREE.Vector3(0, 0.4, -0.9));
    const player: PlayerTarget = {
      pos: new THREE.Vector3(0, 5600, 0),
      vel: new THREE.Vector3(0, 65, 0),
      alive: true,
      hit: vi.fn(),
    };
    (rival as unknown as { beamCooldown: number }).beamCooldown = 1.5;

    // Sustained climb lure triggers predictive climb-cut Unibeam + JARVIS warning
    let t = 0;
    for (let i = 0; i < 160 && !rival.predictiveBeam; i++) {
      t += 1 / 60;
      player.pos.addScaledVector(player.vel, 1 / 60);
      rival.update(1 / 60, t, player, h.ground, h.combat.missiles, h.particles, h.combat.streaks, h.combat.explosions, h.events);
    }
    expect(rival.predictiveBeam).toBe(true);
    expect(rival.chargingBeam).toBe(true);
    expect(h.log.some((e) => e.kind === 'jarvis' && e.text?.includes('predictive unibeam'))).toBe(true);

    // Repeated missile spam tightens Rival flare cooldown below stock RIVAL_FLARE_COOLDOWN
    const r2 = new RivalSuit(new THREE.Vector3(0, 600, 500), new THREE.Vector3(0, 0, -1));
    r2.missileAdapt = 2.2;
    r2.popFlares(h.combat.missiles, h.particles, h.events);
    expect(r2.flareCooldown).toBeLessThan(RIVAL_FLARE_COOLDOWN - 1.0);

    // Unpressured high-altitude icing triggers thermal-break dive
    const r3 = new RivalSuit(new THREE.Vector3(0, RIVAL_ICING_ALT - 200, 900), new THREE.Vector3(0, 0.2, -1));
    r3.icing = 0.5;
    r3.mode = 'stalk';
    const farPlayer: PlayerTarget = { pos: new THREE.Vector3(0, RIVAL_ICING_ALT + 200, 0), vel: new THREE.Vector3(0, 0, 0), alive: true, hit: vi.fn() };
    (r3 as unknown as { beamCooldown: number }).beamCooldown = 99;
    r3.update(1 / 60, 1, farPlayer, h.ground, h.combat.missiles, h.particles, h.combat.streaks, h.combat.explosions, h.events);
    expect(r3.thermalBreakActive).toBe(true);
  });

  it('Keybind audit: KeyP (House Party) does not conflict with any existing binding', () => {
    const keys = [
      REACTOR_KEYS.THRUST,
      REACTOR_KEYS.WEAPONS,
      REACTOR_KEYS.SHIELDS,
      REACTOR_KEYS.BALANCED,
      REACTOR_KEYS.LASER_CUTTER,
      REACTOR_KEYS.OVERCHARGE,
      HOUSE_PARTY_KEY,
      'KeyJ',
      'KeyM',
      'KeyN',
      'KeyU',
      'Tab',
      'KeyV',
      'KeyR',
      'KeyF',
      'KeyG',
      'Space',
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});
