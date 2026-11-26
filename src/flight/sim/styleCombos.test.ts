import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { EventBus, type SimEvent } from './events';
import { ReactorPower } from './reactorPower';
import {
  COMBO_DECAY_SEC,
  MISSILE_NEAR_MISS_DIST,
  NEAR_MISS_OVERCHARGE,
  ORDNANCE_INTERCEPT_OVERCHARGE,
  PROXIMITY_TICK_INTERVAL,
  REVERSAL_CRIT_WINDOW,
  SNAP_REVERSAL_OVERCHARGE,
  SONIC_KILL_OVERCHARGE,
  StyleComboTracker,
  type StyleFlightState,
} from './styleCombos';

function makeFlightState(overrides: Partial<StyleFlightState> = {}): StyleFlightState {
  return {
    grounded: false,
    speed: 140,
    swing: 0,
    pos: new THREE.Vector3(0, 10, 0),
    vel: new THREE.Vector3(0, 0, 140),
    ...overrides,
  };
}

describe('StyleComboTracker', () => {
  it('builds proximityIntensity, combo, overcharge, and PROXIMITY SKIM ticks when skimming fast and low', () => {
    const reactor = new ReactorPower();
    const bus = new EventBus();
    const events: SimEvent[] = [];
    bus.on((e) => events.push(e));
    const tracker = new StyleComboTracker(reactor, bus);

    const state = makeFlightState({ grounded: false, speed: 150 });
    const dt = 0.1;
    // Skim at 5 m clearance for 1.4 s (past one 1.2 s tick interval)
    for (let i = 0; i < 14; i++) {
      tracker.update(dt, state, 5);
    }

    expect(tracker.proximityIntensity).toBeGreaterThan(0.5);
    expect(tracker.comboCount).toBeGreaterThanOrEqual(2);
    expect(reactor.overcharge).toBeGreaterThan(0.05);
    expect(reactor.lastFeedReason).toBe('proximitySkim');

    const feed = tracker.consumeStyleFeed();
    expect(feed.some((item) => item.label === 'PROXIMITY SKIM' && item.reason === 'proximitySkim')).toBe(true);
    expect(tracker.consumeStyleFeed()).toEqual([]);

    // Climbing high or slowing down decays proximityIntensity back toward 0
    for (let i = 0; i < 30; i++) {
      tracker.update(0.1, makeFlightState({ speed: 30 }), 120);
    }
    expect(tracker.proximityIntensity).toBeLessThan(0.05);
  });

  it('does not build proximity adrenaline when grounded or slow', () => {
    const reactor = new ReactorPower();
    const tracker = new StyleComboTracker(reactor);

    tracker.update(0.5, makeFlightState({ grounded: true, speed: 120 }), 2);
    tracker.update(0.5, makeFlightState({ grounded: false, speed: 40 }), 2);
    expect(tracker.proximityIntensity).toBe(0);
    expect(reactor.overcharge).toBe(0);
  });

  it('awards missile near-miss, ordnance intercept, and sonic takedown with escalating combo multiplier', () => {
    const reactor = new ReactorPower();
    reactor.autoOvercharge = false;
    const tracker = new StyleComboTracker(reactor);

    // Out-of-range miss is ignored
    expect(tracker.recordMissileNearMiss(MISSILE_NEAR_MISS_DIST + 2)).toBe(false);
    expect(tracker.score).toBe(0);

    // 1st action: close call -> 1.0x, +0.12 overcharge
    expect(tracker.recordMissileNearMiss(5)).toBe(true);
    expect(tracker.comboMultiplier).toBe(1);
    expect(reactor.overcharge).toBeCloseTo(NEAR_MISS_OVERCHARGE);

    // 2nd action: ordnance intercept -> 1.5x, +0.14 overcharge
    const interceptPts = tracker.recordOrdnanceIntercept('missile');
    expect(interceptPts).toBeGreaterThan(140);
    expect(tracker.comboMultiplier).toBe(1.5);
    expect(reactor.overcharge).toBeCloseTo(NEAR_MISS_OVERCHARGE + ORDNANCE_INTERCEPT_OVERCHARGE);

    // 3rd action: sonic takedown -> 2.0x, +0.18 overcharge
    const sonicPts = tracker.recordSonicKill();
    expect(sonicPts).toBe(400);
    expect(tracker.comboMultiplier).toBe(2);
    expect(reactor.overcharge).toBeCloseTo(NEAR_MISS_OVERCHARGE + ORDNANCE_INTERCEPT_OVERCHARGE + SONIC_KILL_OVERCHARGE);

    const feed = tracker.consumeStyleFeed();
    expect(feed.map((f) => f.label)).toEqual(['CLOSE CALL', 'ORDNANCE INTERCEPT', 'SONIC TAKEDOWN']);

    // Combo decays after COMBO_DECAY_SEC without activity
    tracker.update(COMBO_DECAY_SEC + 0.1);
    expect(tracker.comboCount).toBe(0);
    expect(tracker.comboMultiplier).toBe(1);
  });

  it('detects momentum-swing reversal, opens 1.5 s crit window, and awards +0.10 overcharge', () => {
    const reactor = new ReactorPower();
    const tracker = new StyleComboTracker(reactor);
    const aim = new THREE.Vector3(0, 0, -1);

    tracker.update(0.05, makeFlightState({ speed: 160, swing: 0.75, vel: new THREE.Vector3(0, 0, 160) }), 200, aim);
    expect(tracker.reversalCritReady).toBe(true);
    expect(tracker.reversalCritTimer).toBeCloseTo(REVERSAL_CRIT_WINDOW, 1);
    expect(reactor.overcharge).toBeCloseTo(SNAP_REVERSAL_OVERCHARGE);

    const feed = tracker.consumeStyleFeed();
    expect(feed).toHaveLength(1);
    expect(feed[0].label).toBe('SNAP REVERSAL');

    // Does not double-trigger while the same swing continues
    tracker.update(0.2, makeFlightState({ speed: 150, swing: 0.9 }), 200, aim);
    expect(tracker.consumeStyleFeed()).toHaveLength(0);

    // Consume crit explicitly
    expect(tracker.consumeReversalCrit()).toBe(true);
    expect(tracker.reversalCritReady).toBe(false);
    expect(tracker.consumeReversalCrit()).toBe(false);
  });

  it('manages micro hit-stop timeScale and recovers smoothly via effectiveDt', () => {
    const tracker = new StyleComboTracker();
    expect(tracker.effectiveDt(0.016)).toBeCloseTo(0.016);

    tracker.triggerHitStop(0.055, 0.12);
    expect(tracker.hitStopTimer).toBeCloseTo(0.055);
    expect(tracker.timeScale).toBeCloseTo(0.12);
    expect(tracker.effectiveDt(0.02)).toBeCloseTo(0.02 * 0.12);

    // Advance 0.03 s -> still in hit-stop
    tracker.update(0.03);
    expect(tracker.hitStopTimer).toBeCloseTo(0.025);
    expect(tracker.timeScale).toBeCloseTo(0.12);

    // Advance past remaining hit-stop -> timeScale restores to 1
    tracker.update(0.03);
    expect(tracker.hitStopTimer).toBe(0);
    expect(tracker.timeScale).toBe(1);
    expect(tracker.effectiveDt(0.016)).toBeCloseTo(0.016);

    // Proximity tick interval constant sanity
    expect(PROXIMITY_TICK_INTERVAL).toBeCloseTo(1.2);
  });
});
