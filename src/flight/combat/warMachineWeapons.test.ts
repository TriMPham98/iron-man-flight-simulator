import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { Suit } from '../../suit/Suit';
import type { GameAudio, PlayOptions } from '../audio/gameAudio';
import { SFX, Soundscape } from '../audio/soundscape';
import type { Particles } from '../fx/particles';
import { animateWarMachinePack, buildWarMachinePack, WM_POD_TUBES } from '../net/suitVisuals';
import { EventBus, type SimEvent } from '../sim/events';
import { FlightModel } from '../sim/flightModel';
import type { Controls } from '../sim/input';
import { REACTOR_KEYS } from '../sim/reactorPower';
import type { Heightfield } from '../world/heightfield';
import { Combat } from './combat';
import type { SurfaceQuery } from './explosions';
import type { Hostile } from './types';

const ctx2d = new Proxy({}, { get: () => () => ({ addColorStop() {} }) });
vi.stubGlobal('document', { createElement: () => ({ getContext: () => ctx2d }) });

function makeControls(overrides: Partial<Controls> = {}): Controls {
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
    pressed: new Set(),
    zoom: 0,
    ...overrides,
  };
}

function makeHarness() {
  const ground: SurfaceQuery = {
    surface: () => 0,
    isWater: () => false,
  };
  const field = {
    heightAt: () => 0,
    surfaceAt: () => 0,
    raycast: () => -1,
    normalAt: (_x: number, _z: number, out = new THREE.Vector3()) => out.set(0, 1, 0),
    inBounds: () => true,
  } as unknown as Heightfield;

  const model = new FlightModel({
    surface: () => 0,
    isWater: () => false,
    normal: (_x: number, _z: number, out = new THREE.Vector3()) => out.set(0, 1, 0),
  });
  model.pos.set(0, 200, 0);
  model.vel.set(0, 0, 0);

  const chest = new THREE.Bone();
  const suit = {
    rig: { bones: { chest } },
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
  const pack = buildWarMachinePack();
  chest.add(pack.root);
  combat.weapons.setVariant('warmachine', pack);

  return { combat, pack, model, events, log, particles };
}

function makeHostile(id: number, pos: THREE.Vector3, hp = 120): Hostile {
  const h: Hostile = {
    id,
    kind: 'drone',
    pos: pos.clone(),
    vel: new THREE.Vector3(),
    radius: 4,
    hp,
    maxHp: hp,
    alive: true,
    threatened: 0,
    damage(amount: number) {
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

describe('War Machine Unique Weapons, Animations & Soundscape', () => {
  it('animates M134 barrel spin inertia, breech recoil, heat glow, 6-tube pod lid, dorsal vents, and forearm pods', () => {
    const pack = buildWarMachinePack();
    expect(pack.podMissiles).toHaveLength(WM_POD_TUBES);
    expect(pack.podLeds).toHaveLength(WM_POD_TUBES);

    const chestQ = new THREE.Quaternion();
    const aim = new THREE.Vector3(0.35, 0.2, 0.9).normalize();

    // 1. Firing spins barrels up, kicks carriage back, opens pod lid & dorsal vents, extends forearm pods
    for (let i = 0; i < 30; i++) {
      animateWarMachinePack(pack, 1 / 60, {
        aimWorld: aim,
        chestWorldQuat: chestQ,
        minigunFiring: true,
        minigunShot: i % 3 === 0,
        podOpen: 1,
        podArmed: 4,
        podLoaded: 5,
        ventOpen: 1,
        wristDeploy: 1,
        wristLoaded: [true, false],
        wristLock: [1, 0],
        flakSweepActive: true,
        wristKickL: i === 5,
      });
    }

    expect(pack.anim.barrelSpeed).toBeGreaterThan(35);
    expect(pack.barrels.rotation.z).toBeGreaterThan(2);
    expect(pack.turret.rotation.y).toBeGreaterThan(0.15);
    expect(pack.carriage.position.z).toBeLessThan(-0.005);
    expect(pack.barrelHeatMat.emissiveIntensity).toBeGreaterThan(0.05);
    expect(pack.podLid.rotation.x).toBeLessThan(-1.2);
    expect(pack.podMissiles[5].visible).toBe(false); // 5 loaded -> index 5 hidden
    expect(pack.podMissiles[0].visible).toBe(true);
    expect(pack.ventL.rotation.y).toBeLessThan(-0.4);
    expect(pack.ventR.rotation.y).toBeGreaterThan(0.4);
    expect(pack.wristL.slide.position.y).toBeGreaterThan(0.01);
    expect(pack.wristL.shroud.rotation.z).toBeLessThan(-1.0);
    expect(pack.wristL.warhead.visible).toBe(true);
    expect(pack.wristR.warhead.visible).toBe(false);

    // 2. Releasing fire lets barrels coast down with inertia rather than freezing instantaneously
    const speedAtRelease = pack.anim.barrelSpeed;
    animateWarMachinePack(pack, 0.05, {
      aimWorld: aim,
      chestWorldQuat: chestQ,
      minigunFiring: false,
      minigunShot: false,
      podOpen: 0,
      podArmed: 0,
      podLoaded: 5,
      ventOpen: 0,
      wristDeploy: 0,
      wristLoaded: [true, true],
      wristLock: [0, 0],
      flakSweepActive: false,
    });
    expect(pack.anim.barrelSpeed).toBeGreaterThan(10);
    expect(pack.anim.barrelSpeed).toBeLessThan(speedAtRelease);
  });

  it('lays the M134 straight down the flight path when the suit is prone, and level ahead when upright', () => {
    const lay = (chestQ: THREE.Quaternion, aim: THREE.Vector3) => {
      const pack = buildWarMachinePack();
      pack.root.quaternion.copy(chestQ);
      for (let i = 0; i < 90; i++) {
        animateWarMachinePack(pack, 1 / 60, {
          aimWorld: aim,
          chestWorldQuat: chestQ,
          minigunFiring: false,
          minigunShot: false,
          podOpen: 0,
          podArmed: 0,
          podLoaded: 6,
          ventOpen: 0,
          wristDeploy: 0,
          wristLoaded: [true, true],
          wristLock: [0, 0],
          flakSweepActive: false,
        });
      }
      pack.root.updateMatrixWorld(true);
      const pos = new THREE.Vector3();
      const bore = new THREE.Vector3();
      pack.minigunMuzzle(pos, bore);
      return bore;
    };
    const ahead = new THREE.Vector3(0, 0, 1);
    // Prone (chest pitched forward 90°: its front faces the ground, its spine runs along the flight path)
    const prone = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    expect(lay(prone, ahead).dot(ahead)).toBeGreaterThan(0.98);
    // Upright hover
    expect(lay(new THREE.Quaternion(), ahead).dot(ahead)).toBeGreaterThan(0.98);
    // Diving prone at 30°
    const dive = new THREE.Vector3(0, -0.5, Math.sqrt(0.75));
    expect(lay(prone, dive).dot(dive)).toBeGreaterThan(0.98);
  });

  it('Space fires the auto-locking M134 shoulder minigun instead of Unibeam, tracking off-axis targets and shredding them', () => {
    const h = makeHarness();
    // Place an enemy 25° off boresight (outside Mk III 4.5° repulsor assist, well inside War Machine's 45° Vulcan auto-lock!)
    const target = makeHostile(101, new THREE.Vector3(140, 200, 300), 80);
    h.combat.hostiles.push(target);

    const aim = new THREE.Vector3(0, 0, 1);
    let t = 0;
    for (let i = 0; i < 65; i++) {
      t += 1 / 60;
      h.events.time = t;
      h.combat.update(1 / 60, t, makeControls({ unibeam: true }), aim, h.model.pos);
    }

    // Never triggered Iron Man's Unibeam or slow stance
    expect(h.combat.weapons.unibeamOn).toBe(false);
    expect(h.combat.weapons.stance).toBe(false);
    expect(h.log.some((e) => e.kind === 'unibeamFire')).toBe(false);

    // Auto-locked off-axis target, fired Vulcan rounds, heated barrels, and destroyed the target
    expect(h.log.some((e) => e.kind === 'minigunStart')).toBe(true);
    expect(h.log.filter((e) => e.kind === 'minigunFire').length).toBeGreaterThan(8);
    expect(h.log.some((e) => e.kind === 'minigunHit' && e.value === 1)).toBe(true);
    expect(target.alive).toBe(false);
    expect(h.combat.weapons.unibeamHeat).toBeGreaterThan(0.1);

    // Releasing Space emits minigunStop
    t += 1 / 60;
    h.events.time = t;
    h.combat.update(1 / 60, t, makeControls({ unibeam: false }), aim, h.model.pos);
    expect(h.log.some((e) => e.kind === 'minigunStop')).toBe(true);
  });

  it('uses War Machine 6-tube shoulder pod, heavy Bunker-Busters, and wider dual-gauntlet flak sweep', () => {
    const h = makeHarness();
    expect(h.combat.weapons.rocketCapacity).toBe(6);

    const aim = new THREE.Vector3(0, 0, 1);
    let t = 0;
    // Hold RMB to open external 6-tube shoulder pod (Mk III internal trap flaps stay closed!)
    for (let i = 0; i < 30; i++) {
      t += 1 / 60;
      h.events.time = t;
      h.combat.update(1 / 60, t, makeControls({ missile: true }), aim, h.model.pos);
    }
    expect(h.combat.weapons.arms.silos).toBe(0);
    expect(h.pack.podLid.rotation.x).toBeLessThan(-1.2);

    // Release RMB -> rockets launch with War Machine heavier payload (155 dmg, 5.8 blast)
    for (let i = 0; i < 20; i++) {
      t += 1 / 60;
      h.events.time = t;
      h.combat.update(1 / 60, t, makeControls({ missile: false }), aim, h.model.pos);
    }
    expect(h.combat.missiles.live.length).toBeGreaterThanOrEqual(1);
    expect(h.combat.missiles.live[0].damage).toBe(155);
    expect(h.combat.missiles.live[0].blast).toBe(5.8);

    // Trigger C -> dual-gauntlet flak sweep raises BOTH arms and activates wider sweep
    t += 1 / 60;
    h.events.time = t;
    h.combat.update(1 / 60, t, makeControls({ pressed: new Set([REACTOR_KEYS.LASER_CUTTER]) }), aim, h.model.pos);
    t += 1 / 60;
    h.events.time = t;
    h.combat.update(1 / 60, t, makeControls(), aim, h.model.pos);
    expect(h.combat.weapons.laserCutterActive).toBe(true);
    expect(h.combat.weapons.arms.aimL).toBeGreaterThan(0);
    expect(h.combat.weapons.arms.aimR).toBeGreaterThan(0);

    // Hold G -> deploys external forearm Bunker-Buster pods (Mk III forearm lids stay flush)
    h.combat.missiles.clear();
    for (let i = 0; i < 32; i++) {
      t += 1 / 60;
      h.events.time = t;
      h.combat.update(1 / 60, t, makeControls({ launcher: true }), aim, h.model.pos);
    }
    expect(h.combat.weapons.arms.launchers).toBe(0);
    expect(h.pack.wristL.shroud.rotation.z).toBeLessThan(-1.0);
    // Release G -> fires heavy Bunker-Buster warhead (340 dmg, 9.5 blast)
    for (let i = 0; i < 30; i++) {
      t += 1 / 60;
      h.events.time = t;
      h.combat.update(1 / 60, t, makeControls({ launcher: false }), aim, h.model.pos);
    }
    expect(h.combat.missiles.live.some((m) => m.damage === 340 && m.blast === 9.5)).toBe(true);
  });

  it('plays the warship Phalanx CIWS buzz-saw for War Machine minigun and alters weapon audio vs Iron Man Mk III', () => {
    const played: Array<{ url: string; opts: PlayOptions }> = [];
    const fakeAudio = {
      ready: true,
      play: vi.fn((url: string, opts: PlayOptions = {}) => {
        played.push({ url, opts });
        return null;
      }),
    } as unknown as GameAudio;

    const model = { pos: new THREE.Vector3() } as FlightModel;
    const sounds = new Soundscape(fakeAudio);

    // Compare Iron Man Mk III vs War Machine Mk II repulsor sound (same sample family, deeper pitch on WM)
    sounds.variant = 'ironman';
    sounds.on({ kind: 'repulsorFire', at: new THREE.Vector3(), t: 1 }, model);
    const mk3Rep = played.find((p) => p.url === SFX.repulsor);

    played.length = 0;
    sounds.variant = 'warmachine';
    sounds.on({ kind: 'repulsorFire', at: new THREE.Vector3(), t: 2 }, model);
    const wmRep = played.find((p) => p.url === SFX.repulsor);
    expect(mk3Rep).toBeDefined();
    expect(wmRep).toBeDefined();
    expect(wmRep!.opts.rate ?? 1).toBeLessThan(mk3Rep!.opts.rate ?? 1);

    // War Machine shoulder minigun uses the warship CIWS buzz-saw & tail
    played.length = 0;
    sounds.on({ kind: 'minigunStart', at: new THREE.Vector3(), t: 3 }, model);
    sounds.on({ kind: 'minigunFire', at: new THREE.Vector3(), t: 3.15 }, model);
    sounds.on({ kind: 'minigunFire', at: new THREE.Vector3(), t: 3.20 }, model); // inside 0.21 s slice -> throttled
    sounds.on({ kind: 'minigunFire', at: new THREE.Vector3(), t: 3.40 }, model); // next crossfade slice
    sounds.on({ kind: 'minigunStop', at: new THREE.Vector3(), value: 0.6, t: 3.55 }, model);

    expect(played.filter((p) => p.url === SFX.ciwsBurst)).toHaveLength(2);
    expect(played.some((p) => p.url === SFX.ciwsTail)).toBe(true);
    expect(played.some((p) => p.url === SFX.steamHiss)).toBe(true);

    // War Machine Bunker-Buster & Flak Sweep play deeper/heavier audio layers
    played.length = 0;
    sounds.on({ kind: 'launcherFire', at: new THREE.Vector3(), t: 4 }, model);
    expect(played.some((p) => p.url === SFX.samLaunch)).toBe(true);
    expect(played.some((p) => p.url === SFX.deepBoom)).toBe(true);

    played.length = 0;
    sounds.on({ kind: 'laserCutterFire', at: new THREE.Vector3(), t: 5 }, model);
    expect(played.some((p) => p.url === SFX.gun)).toBe(true);
    expect(played.find((p) => p.url === SFX.repulsorZap)!.opts.rate).toBeLessThan(1);
  });
});
