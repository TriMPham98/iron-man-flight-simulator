import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { EventBus, type SimEvent } from './events';
import { BOOST_SPEED, FlightModel, G_LIMIT, type GroundProbe } from './flightModel';
import {
  LASER_CUTTER_COOLDOWN,
  LASER_CUTTER_MAX_HEAT,
  MODE_MODIFIERS,
  OVERCHARGE_DURATION,
  OVERCHARGE_MODIFIERS,
  REACTOR_CALLOUT_COOLDOWN,
  REACTOR_KEYS,
  ReactorPower,
  STOCK_REACTOR_MODIFIERS,
} from './reactorPower';
import {
  LASER_CUTTER_ARC_RAD,
  LASER_CUTTER_BASE_DAMAGE,
  LASER_CUTTER_DURATION,
  LaserCutterFx,
  sweepDirection,
  sweepProgressAngle,
} from '../combat/laserCutterFx';
import type { Missile } from '../combat/missiles';
import type { DamageKind, Hostile } from '../combat/types';

function makeFlatGround(): GroundProbe {
  return {
    surface: () => 0,
    isWater: () => false,
    normal: (_x, _z, out) => out.set(0, 1, 0),
  };
}

function makeHostile(id: number, pos: THREE.Vector3, hp = 150, radius = 3): Hostile & { hits: number; lastKind: DamageKind | null } {
  const h: Hostile & { hits: number; lastKind: DamageKind | null } = {
    id,
    kind: 'drone',
    pos: pos.clone(),
    vel: new THREE.Vector3(),
    radius,
    hp,
    maxHp: hp,
    alive: true,
    threatened: 0,
    hits: 0,
    lastKind: null,
    damage(amount, _at, kind) {
      if (!this.alive) return false;
      this.hits++;
      this.lastKind = kind;
      this.hp -= amount;
      if (this.hp <= 0) {
        this.hp = 0;
        this.alive = false;
        return true;
      }
      return false;
    },
  };
  return h;
}

describe('ReactorPower', () => {
  it('starts in BALANCED mode with stock 1.0x multipliers across the board', () => {
    const reactor = new ReactorPower();
    expect(reactor.mode).toBe('BALANCED');
    expect(reactor.displayCode).toBe('BAL');
    expect(reactor.overcharge).toBe(0);
    expect(reactor.overchargeActive).toBe(false);
    expect(reactor.modifiers).toEqual(STOCK_REACTOR_MODIFIERS());
  });

  it('applies exact THRUST, WEAPONS, SHIELDS, and BALANCED multipliers via keybinds', () => {
    const reactor = new ReactorPower();

    // Digit1 -> THRUST (+18% boost speed & thrust, +1.5G, -30% reload/cool speed)
    reactor.handleInput(new Set([REACTOR_KEYS.THRUST]));
    expect(reactor.mode).toBe('THRUST');
    expect(reactor.displayCode).toBe('THR');
    expect(reactor.modifiers.boostSpeed).toBeCloseTo(1.18);
    expect(reactor.modifiers.boostThrust).toBeCloseTo(1.18);
    expect(reactor.modifiers.gLimitBonus).toBeCloseTo(1.5);
    expect(1 / reactor.modifiers.unibeamCool).toBeCloseTo(0.7);
    expect(1 / reactor.modifiers.weaponReload).toBeCloseTo(0.7);

    // Pressing the active mode key again toggles cleanly back to BALANCED
    reactor.handleInput(new Set([REACTOR_KEYS.THRUST]));
    expect(reactor.mode).toBe('BALANCED');
    expect(reactor.modifiers).toEqual(STOCK_REACTOR_MODIFIERS());

    // Digit2 -> WEAPONS (+30% repulsor fire rate & damage, 25% faster unibeam charge, +25% DPS, -25% armor regen)
    reactor.handleInput(new Set([REACTOR_KEYS.WEAPONS]));
    expect(reactor.mode).toBe('WEAPONS');
    expect(reactor.displayCode).toBe('WPN');
    expect(1 / reactor.modifiers.repulsorInterval).toBeCloseTo(1.3);
    expect(reactor.modifiers.repulsorDamage).toBeCloseTo(1.3);
    expect(reactor.modifiers.unibeamCharge).toBeCloseTo(0.75);
    expect(reactor.modifiers.unibeamDps).toBeCloseTo(1.25);
    expect(reactor.modifiers.laserCutterDamage).toBeGreaterThan(1);
    expect(reactor.modifiers.regenRate).toBeCloseTo(0.75);

    // Digit3 -> SHIELDS (-30% damage taken, +60% regen rate, shorter delay, -15% boost speed)
    reactor.handleInput(new Set([REACTOR_KEYS.SHIELDS]));
    expect(reactor.mode).toBe('SHIELDS');
    expect(reactor.displayCode).toBe('SHD');
    expect(reactor.modifiers.damageTaken).toBeCloseTo(0.7);
    expect(reactor.modifiers.regenRate).toBeCloseTo(1.6);
    expect(reactor.modifiers.regenDelay).toBeLessThan(1);
    expect(reactor.modifiers.boostSpeed).toBeCloseTo(0.85);

    // Digit4 -> BALANCED
    reactor.handleInput(new Set([REACTOR_KEYS.BALANCED]));
    expect(reactor.mode).toBe('BALANCED');
    expect(reactor.modifiers).toEqual(STOCK_REACTOR_MODIFIERS());
  });

  it('emits reactorMode events and throttles JARVIS callouts on rapid switching', () => {
    const bus = new EventBus();
    const seen: SimEvent[] = [];
    bus.on((e) => seen.push(e));
    const reactor = new ReactorPower(bus);

    reactor.setMode('THRUST');
    reactor.update(0.2);
    reactor.setMode('WEAPONS');
    reactor.update(0.2);
    reactor.setMode('SHIELDS');

    const modeEvents = seen.filter((e) => e.kind === 'reactorMode');
    const jarvisEvents = seen.filter((e) => e.kind === 'jarvis');
    expect(modeEvents.map((e) => e.text)).toEqual(['THRUST', 'WEAPONS', 'SHIELDS']);
    expect(jarvisEvents.length).toBe(1);
    expect(jarvisEvents[0].text).toBe('Diverting power to thrusters, sir.');

    // Once cooldown elapses, the next switch gets a JARVIS line again
    reactor.update(REACTOR_CALLOUT_COOLDOWN);
    reactor.setMode('BALANCED');
    const jarvisAfter = seen.filter((e) => e.kind === 'jarvis');
    expect(jarvisAfter.length).toBe(2);
    expect(jarvisAfter[1].text).toContain('balanced');
  });

  it('absorbs incoming hits into overcharge only in SHIELDS mode and auto-triggers 400% OVERCHARGE for 8s', () => {
    const bus = new EventBus();
    const seen: SimEvent[] = [];
    bus.on((e) => seen.push(e));
    const reactor = new ReactorPower(bus);

    // Non-SHIELDS modes do not absorb armor hits
    expect(reactor.onArmorHit(25)).toBe(0);
    reactor.setMode('WEAPONS');
    expect(reactor.onArmorHit(25)).toBe(0);
    expect(reactor.overcharge).toBe(0);

    // SHIELDS mode absorbs hits into overcharge
    reactor.setMode('SHIELDS');
    const absorbed = reactor.onArmorHit(25);
    expect(absorbed).toBeGreaterThan(0);
    expect(reactor.overcharge).toBeCloseTo(absorbed);
    expect(reactor.lastFeedReason).toBe('shieldAbsorb');

    // External feed pushes capacitor to 100% -> auto-triggers 400% OVERCHARGE
    reactor.feedOvercharge(1 - reactor.overcharge, 'bossCore');
    expect(reactor.overchargeActive).toBe(true);
    expect(reactor.displayCode).toBe('400%');
    expect(reactor.overchargeRemaining).toBeCloseTo(OVERCHARGE_DURATION);
    expect(reactor.modifiers).toEqual(OVERCHARGE_MODIFIERS);
    expect(seen.some((e) => e.kind === 'reactorOvercharge' && e.value === 1)).toBe(true);
    expect(seen.some((e) => e.kind === 'jarvis' && e.text === 'Power at 400% capacity, sir.')).toBe(true);

    // All three axes boosted simultaneously with no penalties
    expect(reactor.modifiers.boostSpeed).toBeGreaterThan(1);
    expect(reactor.modifiers.repulsorDamage).toBeGreaterThan(1);
    expect(reactor.modifiers.damageTaken).toBeLessThan(1);
    expect(reactor.modifiers.regenRate).toBeGreaterThan(1);

    // Halfway through 8s window
    reactor.update(OVERCHARGE_DURATION / 2);
    expect(reactor.overchargeActive).toBe(true);
    expect(reactor.overcharge).toBeCloseTo(0.5);

    // After 8s, returns cleanly to underlying SHIELDS mode
    reactor.update(OVERCHARGE_DURATION / 2 + 0.05);
    expect(reactor.overchargeActive).toBe(false);
    expect(reactor.overcharge).toBe(0);
    expect(reactor.displayCode).toBe('SHD');
    expect(reactor.modifiers).toEqual(MODE_MODIFIERS.SHIELDS);
    expect(seen.some((e) => e.kind === 'reactorOvercharge' && e.value === 0)).toBe(true);
  });

  it('supports manual overcharge activation via KeyB when autoOvercharge is disabled', () => {
    const reactor = new ReactorPower();
    reactor.autoOvercharge = false;

    reactor.feedOvercharge(0.6, 'unibeamKill');
    expect(reactor.triggerOvercharge()).toBe(false);

    reactor.feedOvercharge(0.5, 'frigateExplosion');
    expect(reactor.overcharge).toBe(1);
    expect(reactor.overchargeActive).toBe(false);

    reactor.handleInput(new Set([REACTOR_KEYS.OVERCHARGE]));
    expect(reactor.overchargeActive).toBe(true);
    expect(reactor.overchargeRemaining).toBeCloseTo(OVERCHARGE_DURATION);
  });

  it('enforces laser cutter thermal threshold and overrides it during 400% OVERCHARGE', () => {
    const reactor = new ReactorPower();
    expect(reactor.canFireLaserCutter(0.0, false, 0)).toBe(true);
    expect(reactor.canFireLaserCutter(LASER_CUTTER_MAX_HEAT - 0.01, false, 0)).toBe(true);
    expect(reactor.canFireLaserCutter(LASER_CUTTER_MAX_HEAT, false, 0)).toBe(false);
    expect(reactor.canFireLaserCutter(0.1, true, 0)).toBe(false);
    expect(reactor.canFireLaserCutter(0.1, false, 0.5)).toBe(false);

    // During overcharge, high heat does not block laser cutter (only active cooldown does)
    reactor.feedOvercharge(1, 'test');
    expect(reactor.canFireLaserCutter(0.95, true, 0)).toBe(true);
    expect(reactor.canFireLaserCutter(0.0, false, 0.4)).toBe(false);
  });

  it('clears overcharge if suit goes down and resets state cleanly on reset()', () => {
    const reactor = new ReactorPower();
    reactor.setMode('THRUST');
    reactor.feedOvercharge(1, 'test');
    expect(reactor.overchargeActive).toBe(true);

    reactor.update(0.1, true);
    expect(reactor.overchargeActive).toBe(false);
    expect(reactor.overcharge).toBe(0);

    reactor.setMode('WEAPONS');
    reactor.feedOvercharge(0.5, 'test');
    reactor.reset();
    expect(reactor.mode).toBe('BALANCED');
    expect(reactor.overcharge).toBe(0);
    expect(reactor.modifiers).toEqual(STOCK_REACTOR_MODIFIERS());
  });

  it('triggers 400% overcharge instantly on storm lightning strike and feeds style overcharge', () => {
    const bus = new EventBus();
    const seen: SimEvent[] = [];
    bus.on((e) => seen.push(e));
    const reactor = new ReactorPower(bus);
    reactor.autoOvercharge = false;

    const added = reactor.feedStyleOvercharge(0.25, 'missileNearMiss', new THREE.Vector3(10, 50, 10));
    expect(added).toBeCloseTo(0.25);
    expect(reactor.overcharge).toBeCloseTo(0.25);
    expect(reactor.lastFeedReason).toBe('missileNearMiss');
    expect(reactor.overchargeActive).toBe(false);

    // Storm lightning strike fills capacitor to 1 and forces 400% overcharge even with autoOvercharge=false
    expect(reactor.triggerStormSurge(new THREE.Vector3(0, 400, 0))).toBe(true);
    expect(reactor.overcharge).toBe(1);
    expect(reactor.overchargeActive).toBe(true);
    expect(reactor.overchargeRemaining).toBeCloseTo(OVERCHARGE_DURATION);
    expect(reactor.displayCode).toBe('400%');
    expect(reactor.lastFeedReason).toBe('stormSurge');
    expect(reactor.modifiers).toEqual(OVERCHARGE_MODIFIERS);
    expect(seen.some((e) => e.kind === 'reactorOvercharge' && e.value === 1)).toBe(true);

    // A second storm strike mid-overcharge refreshes the full 400% window
    reactor.update(3.0);
    expect(reactor.overchargeRemaining).toBeCloseTo(OVERCHARGE_DURATION - 3.0);
    reactor.triggerStormSurge();
    expect(reactor.overchargeRemaining).toBeCloseTo(OVERCHARGE_DURATION);
  });
});

describe('LaserCutterFx', () => {
  it('sweeps smoothly across the full 55 degree horizontal arc', () => {
    expect(sweepProgressAngle(0)).toBeCloseTo(-LASER_CUTTER_ARC_RAD / 2);
    expect(sweepProgressAngle(0.5)).toBeCloseTo(0);
    expect(sweepProgressAngle(1)).toBeCloseTo(LASER_CUTTER_ARC_RAD / 2);

    const fwd = new THREE.Vector3(0, 0, 1);
    const right = new THREE.Vector3(1, 0, 0);
    const leftDir = sweepDirection(fwd, right, sweepProgressAngle(0));
    const rightDir = sweepDirection(fwd, right, sweepProgressAngle(1));
    expect(leftDir.angleTo(rightDir)).toBeCloseTo(LASER_CUTTER_ARC_RAD, 5);
  });

  it('slices multiple hostiles and incoming enemy missiles once each across the sweep arc', () => {
    const cutter = new LaserCutterFx();
    const origin = new THREE.Vector3(0, 100, 0);
    const fwd = new THREE.Vector3(0, 0, 1);
    const up = new THREE.Vector3(0, 1, 0);
    const field = { raycast: () => -1, heightAt: () => 0 };

    // Three drones fanned horizontally within the ~55° arc (facing +Z: +X is pilot's left, -X is pilot's right), plus one far outside
    const dLeft = makeHostile(1, new THREE.Vector3(45, 100, 130), 200);
    const dCenter = makeHostile(2, new THREE.Vector3(0, 100, 140), 500);
    const dRight = makeHostile(3, new THREE.Vector3(-40, 100, 120), 200);
    const dOutside = makeHostile(4, new THREE.Vector3(150, 100, 30), 200);
    const hostiles = [dLeft, dCenter, dRight, dOutside];

    // An incoming enemy missile inside the sweep path
    const missile = { pos: new THREE.Vector3(15, 100, 90) } as Missile;
    const inboundList: Missile[] = [missile];
    const shootDown = vi.fn((m: Missile) => {
      const idx = inboundList.indexOf(m);
      if (idx >= 0) inboundList.splice(idx, 1);
    });
    const missiles = { inbound: () => [...inboundList], shootDown };
    const bus = new EventBus();
    const events: SimEvent[] = [];
    bus.on((e) => events.push(e));
    const kills: number[] = [];

    // Trigger with WEAPONS damage multiplier (1.35x)
    const mult = MODE_MODIFIERS.WEAPONS.laserCutterDamage;
    cutter.trigger(origin, fwd, up, mult, LASER_CUTTER_COOLDOWN);
    expect(cutter.active).toBe(true);

    // Step across the full 0.65 s sweep in 60 Hz frames
    const dt = 1 / 60;
    const frames = Math.ceil(LASER_CUTTER_DURATION / dt) + 2;
    for (let i = 0; i < frames; i++) {
      cutter.step(dt, origin, field, hostiles, missiles, null, null, bus, (h) => kills.push(h.id));
    }

    expect(cutter.active).toBe(false);
    // All 3 drones in arc were hit exactly once; outside drone untouched
    expect(dLeft.hits).toBe(1);
    expect(dCenter.hits).toBe(1);
    expect(dRight.hits).toBe(1);
    expect(dOutside.hits).toBe(0);
    expect(dLeft.alive).toBe(false);
    expect(dRight.alive).toBe(false);
    expect(dCenter.alive).toBe(true);
    expect(dCenter.hp).toBeCloseTo(500 - LASER_CUTTER_BASE_DAMAGE * mult);
    expect(kills).toEqual([1, 3]);
    // Incoming missile was sliced & intercepted
    expect(shootDown).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.kind === 'intercept' && e.text === 'suit')).toBe(true);
  });
});

describe('FlightModel + ReactorPower integration', () => {
  it('scales boost top speed and G-limit headroom live with reactor allocation', () => {
    const model = new FlightModel(makeFlatGround());
    const reactor = new ReactorPower();
    model.reactor = reactor.modifiers;
    model.grounded = false;
    model.boosting = true;

    expect(model.speedTarget).toBeCloseTo(BOOST_SPEED);
    expect(model.gLimit).toBeCloseTo(G_LIMIT);

    reactor.setMode('THRUST');
    expect(model.speedTarget).toBeCloseTo(BOOST_SPEED * 1.18);
    expect(model.gLimit).toBeCloseTo(G_LIMIT + 1.5);

    reactor.setMode('SHIELDS');
    expect(model.speedTarget).toBeCloseTo(BOOST_SPEED * 0.85);
    expect(model.gLimit).toBeCloseTo(G_LIMIT);

    reactor.feedOvercharge(1, 'test');
    expect(model.speedTarget).toBeCloseTo(BOOST_SPEED * OVERCHARGE_MODIFIERS.boostSpeed);
    expect(model.gLimit).toBeCloseTo(G_LIMIT + OVERCHARGE_MODIFIERS.gLimitBonus);
  });
});
