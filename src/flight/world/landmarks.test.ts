import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Landmarks, type HeightSampler } from './landmarks';
import { Clouds } from './clouds';
import { ACTIVE_LIGHTING, NIGHT_OPS, SUN_COLOR, SUN_DIR, SUN_INTENSITY } from './config';

function makeMockField(): HeightSampler {
  return {
    heightAt(x: number, z: number): number {
      // Ocean south of z = 1150, coastal bluff & inland canyon relief north of z = 1150
      if (z > 1150) return -60;
      const canyon = Math.abs(Math.sin(x * 0.004)) * 95;
      return 50 + Math.max(0, (1150 - z) * 0.04) + canyon;
    },
  };
}

describe('Landmarks', () => {
  it('constructs offshore rig, coastal bridge, canyon radar arches, and 8-12 flight gates', () => {
    const lm = new Landmarks(makeMockField());
    expect(lm.gates.length).toBeGreaterThanOrEqual(8);
    expect(lm.gates.length).toBeLessThanOrEqual(12);
    expect(lm.structures.map((s) => s.id)).toEqual(
      expect.arrayContaining(['offshore-rig', 'coastal-bridge', 'canyon-arch-1', 'canyon-arch-2', 'canyon-arch-3']),
    );
    expect(lm.group.children.length).toBeGreaterThan(0);

    // Offshore rig should sit 3-5 km out to sea over deep water
    const rig = lm.structures.find((s) => s.id === 'offshore-rig')!;
    expect(rig.pos.z).toBeGreaterThan(3000);
  });

  it('tracks sequential gate progression, split times, course completion, and best time', () => {
    const lm = new Landmarks(makeMockField());
    const total = lm.gates.length;

    // Far away initially: no gate passed, activeGatePos points at Gate 0
    const init = lm.update(0.25, new THREE.Vector3(0, 100, 0), 120);
    expect(init.gatePassed).toBeUndefined();
    expect(init.gatesCleared).toBe(0);
    expect(init.totalGates).toBe(total);
    expect(init.activeGatePos?.distanceTo(lm.gates[0].pos)).toBeCloseTo(0, 4);

    // Passing Gate 1 out of order should NOT advance progression
    const outOfOrder = lm.update(0.25, lm.gates[1].pos.clone(), 150);
    expect(outOfOrder.gatePassed).toBeUndefined();
    expect(outOfOrder.gatesCleared).toBe(0);

    // Clear all gates in sequence at 0.5 s per leg
    for (let i = 0; i < total; i++) {
      const res = lm.update(0.5, lm.gates[i].pos.clone(), 220);
      expect(res.gatePassed).toBeDefined();
      expect(res.gatePassed!.index).toBe(i);
      expect(res.gatePassed!.total).toBe(total);
      expect(res.gatesCleared).toBe(i + 1);
      if (i === 0) {
        expect(res.gatePassed!.splitSec).toBe(0);
        expect(res.gatePassed!.courseComplete).toBe(false);
      } else if (i < total - 1) {
        expect(res.gatePassed!.splitSec).toBeCloseTo(0.5, 4);
        expect(res.gatePassed!.courseComplete).toBe(false);
        expect(res.activeGatePos?.distanceTo(lm.gates[i + 1].pos)).toBeCloseTo(0, 4);
      } else {
        expect(res.gatePassed!.courseComplete).toBe(true);
        expect(res.gatePassed!.bestSec).toBeCloseTo((total - 1) * 0.5, 4);
        expect(res.activeGatePos).toBeNull();
      }
    }

    // Second lap faster (0.2 s per leg) updates bestSec; slower (1.0 s) preserves bestSec
    lm.resetCourse();
    const fastBest = (total - 1) * 0.2;
    let lastBest = Infinity;
    for (let i = 0; i < total; i++) {
      const res = lm.update(0.2, lm.gates[i].pos.clone(), 340);
      if (res.gatePassed?.courseComplete) lastBest = res.gatePassed.bestSec;
    }
    expect(lastBest).toBeCloseTo(fastBest, 4);

    lm.resetCourse();
    for (let i = 0; i < total; i++) {
      const res = lm.update(1.0, lm.gates[i].pos.clone(), 180);
      if (res.gatePassed?.courseComplete) lastBest = res.gatePassed.bestSec;
    }
    expect(lastBest).toBeCloseTo(fastBest, 4);
  });

  it('prevents high-speed tunneling when flying straight through a gate plane in one step', () => {
    const lm = new Landmarks(makeMockField());
    const g0 = lm.gates[0];
    // Start 200 m before Gate 0, jump 400 m through Gate 0 plane in one dt
    const before = g0.pos.clone().addScaledVector(g0.normal, -200);
    const after = g0.pos.clone().addScaledVector(g0.normal, 200);
    expect(lm.update(0.1, before, 400).gatePassed).toBeUndefined();
    const pass = lm.update(0.1, after, 600);
    expect(pass.gatePassed?.index).toBe(0);
    expect(pass.gatesCleared).toBe(1);
  });

  it('computes nearestClearance accurately for rig, bridge, and canyon arches', () => {
    const lm = new Landmarks(makeMockField());
    const rig = lm.structures.find((s) => s.id === 'offshore-rig')!;
    // Inside the under-deck gap (y = 18, deck bottom = 33, legs at ±26/±24)
    const underRig = new THREE.Vector3(rig.pos.x, 18, rig.pos.z);
    const rigClear = lm.nearestClearance(underRig);
    expect(rigClear).not.toBeNull();
    expect(rigClear!.label).toMatch(/Offshore Rig/);
    expect(rigClear!.dist).toBeGreaterThan(10);
    expect(rigClear!.dist).toBeLessThan(20);

    // Touching the upper rig deck surface (y = 40.5) gives ~0 clearance
    const onDeck = new THREE.Vector3(rig.pos.x, 40.5, rig.pos.z);
    const deckClear = lm.nearestClearance(onDeck);
    expect(deckClear!.dist).toBeCloseTo(0, 3);

    // Under the coastal bridge main span
    const bridge = lm.structures.find((s) => s.id === 'coastal-bridge')!;
    const underBridge = new THREE.Vector3(bridge.pos.x, bridge.pos.y - 25, bridge.pos.z);
    const bridgeClear = lm.nearestClearance(underBridge);
    expect(bridgeClear).not.toBeNull();
    expect(bridgeClear!.label).toMatch(/Coastal Bridge/);
    expect(bridgeClear!.dist).toBeGreaterThan(15);
    expect(bridgeClear!.dist).toBeLessThan(30);

    // Flying inside Canyon Arch 1
    const arch1 = lm.structures.find((s) => s.id === 'canyon-arch-1')!;
    const insideArch = new THREE.Vector3(arch1.pos.x, arch1.pos.y + 52, arch1.pos.z);
    const archClear = lm.nearestClearance(insideArch);
    expect(archClear).not.toBeNull();
    expect(archClear!.label).toContain('Canyon Radar Arch');
    expect(archClear!.dist).toBeGreaterThan(30);

    // Rotated bridge deck edge distance check (10 m above bridge center)
    const aboveBridge = new THREE.Vector3(bridge.pos.x, bridge.pos.y + 10, bridge.pos.z);
    expect(lm.nearestClearance(aboveBridge)!.dist).toBeCloseTo(10, 2);

    // Fallback construction without a heightfield also builds all structures & gates
    const noFieldLm = new Landmarks();
    expect(noFieldLm.gates.length).toBe(lm.gates.length);
  });
});

describe('Night Ops Config & Storm Clouds', () => {
  it('activates Night Ops moonlight defaults cleanly', () => {
    expect(NIGHT_OPS).toBe(true);
    expect(ACTIVE_LIGHTING.night).toBe(true);
    expect(SUN_DIR.length()).toBeCloseTo(1, 5);
    expect(SUN_COLOR.b).toBeGreaterThan(SUN_COLOR.r);
    expect(SUN_INTENSITY).toBeGreaterThan(0);
  });

  it('triggers periodic storm lightning, strikes inside dense cloud cover, and outputs turbulence', () => {
    const dummyUniforms = {
      uSkyCube: { value: null },
      uSunDir: { value: SUN_DIR.clone() },
      uSunColor: { value: SUN_COLOR.clone() },
      uFogDensity: { value: 1 / 25000 },
      uFogFalloff: { value: 1 / 1300 },
    };
    const clouds = new Clouds(dummyUniforms);
    const clearPos = new THREE.Vector3(0, 50, 0);

    // Outside clouds: no turbulence, no lightning strike
    expect(clouds.turbulence(clearPos).intensity).toBe(0);
    clouds.triggerLightning(clearPos);
    expect(clouds.lightningIntensity).toBe(1);
    expect(clouds.consumeLightningStrike(clearPos)).toBe(false);

    // Inside dense cloud cover (> 0.25) during active storm flash: triggers once per flash
    const cam = new THREE.PerspectiveCamera();
    cam.position.copy(clearPos);
    cam.updateMatrixWorld();
    clouds.update(0.016, cam);
    clouds.triggerLightning();
    expect(clouds.consumeLightningStrike(clearPos, 0.6)).toBe(true);
    expect(clouds.consumeLightningStrike(clearPos, 0.6)).toBe(false);

    // Turbulence inside cloud returns non-zero intensity and bounded vector
    const turb = clouds.turbulence(clearPos, 0.8);
    expect(turb.intensity).toBeGreaterThan(0.5);
    expect(turb.vector.length()).toBeGreaterThan(0);

    // Periodic random storm lightning fires and decays automatically over time
    let sawPeak = false;
    let sawDecay = false;
    for (let i = 0; i < 60; i++) {
      clouds.update(0.15, cam);
      if (clouds.lightningIntensity > 0.3) sawPeak = true;
      else if (sawPeak && clouds.lightningIntensity === 0) sawDecay = true;
    }
    expect(sawPeak).toBe(true);
    expect(sawDecay).toBe(true);
  });
});
