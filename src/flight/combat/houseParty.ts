import * as THREE from 'three';
import type { Particles } from '../fx/particles';
import type { Streaks } from '../fx/streaks';
import type { EventBus } from '../sim/events';
import type { FlightModel } from '../sim/flightModel';
import { GRAVITY } from '../world/config';
import { PAD, PAD_Y } from '../world/house';
import type { Explosions, SurfaceQuery } from './explosions';
import type { Missiles } from './missiles';
import { box, frustum, glowMaterial, loft, merge, paint, type V3 } from './modelKit';
import { hazeAll } from '../render/haze';
import type { Hostile } from './types';

/**
 * House Party Protocol (Pillar 4B):
 *  1. Autonomous Wingmen (`KeyP`): Launches 1–2 JARVIS-piloted spare Mark suits
 *     straight off the Malibu landing pad (Silver Centurion & Heartbreaker liveries).
 *     They orbit the battle space, prioritize threats shelling the Malibu house
 *     (bombers, SAMs, dreadnought cannon), fire repulsor bursts & micro-rockets,
 *     and peel attacking drones off the player for 45 seconds.
 *  2. Mid-Air Hot-Swap Rescue: When the player's armor hits 0 with 0 reserves left,
 *     if the emergency Hot-Swap pod is ready, JARVIS launches a glowing spare Mark
 *     chassis from Malibu to intercept the falling pilot mid-air! Catching it
 *     (flying/steering within 35 m and pressing P/Space, or automatic dock at 14 m)
 *     snaps the pilot into a fresh 100% armor suit with a 35% overcharge surge.
 */

export const HOUSE_PARTY_KEY = 'KeyP';
export const HOUSE_PARTY_DURATION = 45;
export const HOUSE_PARTY_COOLDOWN = 60;
export const HOT_SWAP_FALL_TIME = 6.8;
export const HOT_SWAP_CATCH_R = 36;
export const HOT_SWAP_AUTO_R = 15;
export const HOT_SWAP_POD_SPEED = 420;
export const HOT_SWAP_MIN_ALT = 115;

export interface WingmanSuitSpec {
  readonly callsign: string;
  readonly primary: number;
  readonly secondary: number;
  readonly accent: number;
  readonly glow: THREE.Color;
}

const WINGMAN_SPECS: readonly WingmanSuitSpec[] = [
  {
    callsign: 'MK XXXIII · CENTURION',
    primary: 0x9b1818,
    secondary: 0xc8cfd8,
    accent: 0x262b33,
    glow: new THREE.Color(0.55, 0.92, 1.0),
  },
  {
    callsign: 'MK XVII · HEARTBREAKER',
    primary: 0x8f1814,
    secondary: 0xd8a842,
    accent: 0x23262c,
    glow: new THREE.Color(1.0, 0.85, 0.45),
  },
];

let sharedGlowMat: THREE.MeshStandardMaterial | null = null;
function wingmanGlowMat(): THREE.MeshStandardMaterial {
  return (sharedGlowMat ??= glowMaterial());
}

const geoBySpec = new Map<string, { body: THREE.BufferGeometry; glow: THREE.BufferGeometry }>();

function wingmanGeometry(spec: WingmanSuitSpec) {
  const cached = geoBySpec.get(spec.callsign);
  if (cached) return cached;
  const body: THREE.BufferGeometry[] = [];
  const glow: THREE.BufferGeometry[] = [];

  const ring = (y: number, w: number, fz: number, bz: number): V3[] => [
    [0, y, fz],
    [w, y, 0],
    [0, y, bz],
    [-w, y, 0],
  ];
  // Helmet
  body.push(
    loft([ring(0.78, 0.1, 0.13, -0.1), ring(0.96, 0.125, 0.15, -0.13), ring(1.12, 0.06, 0.07, -0.08)], (_e, s) =>
      s >= 1 ? spec.primary : spec.secondary,
    ),
    box(0.11, 0.07, 0.05, spec.secondary, 0, 0.92, 0.12),
  );
  // Eyes
  for (const s of [-1, 1]) {
    glow.push(paint(new THREE.BoxGeometry(0.05, 0.018, 0.02).translate(s * 0.04, 0.97, 0.145), spec.glow, 6));
  }
  // Chest & torso
  body.push(
    frustum({ hw0: 0.17, z0: 0.12, z1: -0.11, y0: 0.14, hw1: 0.28, z2: 0.18, z3: -0.16, y1: 0.68 }, (e) =>
      e === 0 ? spec.primary : spec.secondary,
    ),
    frustum({ hw0: 0.18, z0: 0.12, z1: -0.11, y0: -0.06, hw1: 0.16, z2: 0.11, z3: -0.1, y1: 0.16 }, spec.accent),
    frustum({ hw0: 0.14, z0: 0.1, z1: -0.1, y0: -0.16, hw1: 0.2, z2: 0.13, z3: -0.12, y1: -0.04 }, spec.primary),
  );
  // Chest Arc Reactor
  glow.push(paint(new THREE.CircleGeometry(0.075, 12).translate(0, 0.45, 0.195), spec.glow, 8));

  // Shoulders, arms & legs
  for (const s of [-1, 1]) {
    body.push(
      box(0.18, 0.16, 0.22, spec.secondary, s * 0.31, 0.62, 0),
      box(0.11, 0.52, 0.12, spec.primary, s * 0.34, 0.26, 0.04),
      box(0.1, 0.12, 0.1, spec.secondary, s * 0.34, -0.04, 0.06),
      box(0.14, 0.46, 0.16, spec.secondary, s * 0.14, -0.38, 0),
      box(0.13, 0.48, 0.17, spec.primary, s * 0.14, -0.84, 0.02),
    );
    glow.push(
      paint(new THREE.CircleGeometry(0.042, 8).rotateX(Math.PI / 2).translate(s * 0.34, -0.105, 0.06), spec.glow, 6),
      paint(new THREE.CircleGeometry(0.062, 8).rotateX(Math.PI / 2).translate(s * 0.14, -1.09, 0), spec.glow, 7),
    );
  }
  const built = { body: merge(body), glow: merge(glow) };
  geoBySpec.set(spec.callsign, built);
  return built;
}

let podGeoCache: { body: THREE.BufferGeometry; glow: THREE.BufferGeometry } | null = null;
function hotSwapPodGeometry() {
  if (podGeoCache) return podGeoCache;
  const ring = (z: number, r: number): V3[] =>
    Array.from({ length: 8 }, (_, i) => {
      const a = (i / 8) * Math.PI * 2;
      return [Math.cos(a) * r, Math.sin(a) * r, z] as V3;
    });
  const body = merge([
    loft(
      [ring(1.4, 0.12), ring(0.9, 0.48), ring(-0.9, 0.52), ring(-1.35, 0.34)],
      (_e, s) => (s === 0 ? 0xd8a842 : s === 1 ? 0x9b1818 : 0x262b33),
    ),
    box(1.3, 0.08, 0.55, 0xd8a842, 0, 0, -0.7),
    box(0.08, 1.3, 0.55, 0xd8a842, 0, 0, -0.7),
  ]);
  const glow = merge([
    paint(new THREE.TorusGeometry(0.51, 0.045, 6, 16).translate(0, 0, 0.25), new THREE.Color(0.55, 0.92, 1.0), 8),
    paint(new THREE.ConeGeometry(0.32, 1.4, 10).rotateX(-Math.PI / 2).translate(0, 0, -2.0), new THREE.Color(1.0, 0.72, 0.25), 9),
  ]);
  podGeoCache = { body, glow };
  return podGeoCache;
}

export interface WingmanBolt {
  p: THREE.Vector3;
  v: THREE.Vector3;
  life: number;
  target: Hostile | null;
}

export class WingmanSuit {
  readonly mesh = new THREE.Group();
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly callsign: string;
  life = HOUSE_PARTY_DURATION;
  returning = false;
  done = false;
  target: Hostile | null = null;
  private fireT = 0.6;
  private missileT = 4.5;
  private trailT = 0;
  private readonly orbitSide: number;
  private readonly orbitPhase: number;
  private readonly bodyMat: THREE.MeshStandardMaterial;
  private readonly _v = new THREE.Vector3();
  private readonly _w = new THREE.Vector3();
  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();

  constructor(
    readonly index: number,
    spawnPos: THREE.Vector3,
    hazeUniforms?: Record<string, THREE.IUniform>,
  ) {
    const spec = WINGMAN_SPECS[index % WINGMAN_SPECS.length];
    this.callsign = spec.callsign;
    this.orbitSide = index % 2 === 0 ? 1 : -1;
    this.orbitPhase = index * Math.PI;
    const g = wingmanGeometry(spec);
    this.bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.72, roughness: 0.28 });
    const body = new THREE.Group();
    body.add(new THREE.Mesh(g.body, this.bodyMat), new THREE.Mesh(g.glow, wingmanGlowMat()));
    // Prone flight orientation inside outer lookAt wrapper
    body.rotation.x = 1.38;
    this.mesh.add(body);
    if (hazeUniforms && Object.keys(hazeUniforms).length > 0) hazeAll(this.mesh, hazeUniforms);
    this.pos.copy(spawnPos);
    this.vel.set((index === 0 ? -1 : 1) * 18, 95, 20);
    this.mesh.position.copy(this.pos);
  }

  update(
    dt: number,
    t: number,
    playerPos: THREE.Vector3,
    hostiles: readonly Hostile[],
    ground: SurfaceQuery,
    bolts: WingmanBolt[],
    missiles: Missiles,
    particles: Particles,
    events: EventBus,
  ): void {
    if (this.done) return;
    this.life -= dt;
    if (this.life <= 0) this.returning = true;

    const homePos = this._w.set(PAD.x, PAD_Y + 12, PAD.y);
    if (this.returning) {
      const toHome = this._v.copy(homePos).sub(this.pos);
      const dist = toHome.length();
      if (dist < 28 || this.life < -10) {
        this.done = true;
        this.mesh.visible = false;
        return;
      }
      toHome.divideScalar(Math.max(dist, 1));
      const wantVel = toHome.multiplyScalar(220);
      this.vel.lerp(wantVel, 1 - Math.exp(-dt * 3));
      this.pos.addScaledVector(this.vel, dt);
      this.orient();
      this.emitTrail(dt, particles);
      return;
    }

    // Pick priority target: house-threat (bomber / sam / boss) first, else nearest alive hostile
    if (!this.target || !this.target.alive) {
      this.target = pickWingmanTarget(this.pos, playerPos, hostiles);
    }

    const desired = new THREE.Vector3();
    let targetSpeed = 195;
    if (this.target && this.target.alive) {
      const toT = this._v.copy(this.target.pos).sub(this.pos);
      const dist = Math.max(1, toT.length());
      const dirT = toT.clone().divideScalar(dist);
      // Orbit around target at ~240 m to strafe cleanly
      const tang = new THREE.Vector3(-dirT.z * this.orbitSide, 0, dirT.x * this.orbitSide);
      const radial = THREE.MathUtils.clamp((dist - 240) / 260, -0.7, 1.0);
      desired.copy(tang).multiplyScalar(0.75).addScaledVector(dirT, radial);
      desired.y = THREE.MathUtils.clamp((this.target.pos.y + 45 - this.pos.y) / 180, -0.5, 0.65);
      desired.normalize();
      targetSpeed = dist > 700 ? 290 : 195;

      // Draw agro: nearby drones react to the wingman's pressure
      if (dist < 420 && this.target.threatened < 0.8) {
        this.target.threatened = Math.max(this.target.threatened, 0.9);
      }

      // Fire twin repulsor bursts at target
      this.fireT -= dt;
      if (dist < 950 && this.fireT <= 0) {
        this.fireT = 0.38 + Math.random() * 0.22;
        const lead = this.target.pos.clone().addScaledVector(this.target.vel, dist / 760);
        const shotDir = lead.sub(this.pos).normalize();
        bolts.push({
          p: this.pos.clone().addScaledVector(shotDir, 1.6),
          v: shotDir.multiplyScalar(760).addScaledVector(this.vel, 0.3),
          life: 1.8,
          target: this.target,
        });
        particles.emit('flash', this.pos, this.vel, { scale: 0.14 });
        events.emit('repulsorFire', { at: this.pos, side: this.index % 2 === 0 ? 'L' : 'R' });
      }

      // Occasional wingman micro-rocket salvo
      this.missileT -= dt;
      if (dist > 320 && dist < 1800 && !this.target.noLock && this.missileT <= 0) {
        this.missileT = 5.5 + Math.random() * 2.5;
        missiles.launch({
          team: 'player',
          from: this.pos.clone(),
          vel: this.vel.clone().addScaledVector(dirT, 35),
          target: this.target,
          coast: 0.15,
          caliber: 0.008,
          length: 0.16,
          damage: 95,
        });
        events.emit('missileLaunch', { at: this.pos });
      }
    } else {
      // Escort formation orbiting the player
      const ang = t * 0.65 + this.orbitPhase;
      const goal = new THREE.Vector3(
        playerPos.x + Math.cos(ang) * 95,
        Math.max(playerPos.y + 18, ground.surface(playerPos.x, playerPos.z) + 30),
        playerPos.z + Math.sin(ang) * 95,
      );
      desired.copy(goal).sub(this.pos);
      const d = desired.length();
      if (d > 1) desired.divideScalar(d);
      targetSpeed = THREE.MathUtils.clamp(d * 1.4, 70, 280);
    }

    // Terrain clearance
    const surf = Math.max(ground.surface(this.pos.x, this.pos.z), 0);
    if (this.pos.y < surf + 26) desired.y = Math.max(desired.y, 0.65);
    desired.normalize();

    const wantVel = desired.multiplyScalar(targetSpeed);
    this.vel.lerp(wantVel, 1 - Math.exp(-dt * 3.2));
    this.pos.addScaledVector(this.vel, dt);
    if (this.pos.y < surf + 12) {
      this.pos.y = surf + 12;
      if (this.vel.y < 10) this.vel.y = 10;
    }

    this.orient();
    this.emitTrail(dt, particles);
  }

  private orient(): void {
    const dir = this._v.copy(this.vel);
    if (dir.lengthSq() < 1) dir.set(0, 0, 1);
    else dir.normalize();
    this._m.lookAt(new THREE.Vector3(), dir, new THREE.Vector3(0, 1, 0));
    this._q.setFromRotationMatrix(this._m);
    this._q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.copy(this._q);
  }

  private emitTrail(dt: number, particles: Particles): void {
    this.trailT += dt;
    while (this.trailT >= 0.045) {
      this.trailT -= 0.045;
      particles.emit('trail', this.pos, undefined, { scale: 0.45, life: 0.6 });
    }
  }
}

function pickWingmanTarget(pos: THREE.Vector3, playerPos: THREE.Vector3, hostiles: readonly Hostile[]): Hostile | null {
  let best: Hostile | null = null;
  let bestScore = Infinity;
  for (const h of hostiles) {
    if (!h.alive) continue;
    const d = pos.distanceTo(h.pos);
    const dp = playerPos.distanceTo(h.pos);
    const priorityBias =
      h.kind === 'bomber' ? 0.35 : h.kind === 'sam' ? 0.55 : h.kind === 'boss' ? 0.6 : h.kind === 'rival' ? 0.65 : 1.0;
    const score = (d * 0.6 + dp * 0.4) * priorityBias;
    if (score < bestScore) {
      bestScore = score;
      best = h;
    }
  }
  return best;
}

export interface HotSwapState {
  active: boolean;
  podPos: THREE.Vector3;
  podVel: THREE.Vector3;
  distance: number;
  inCatchRange: boolean;
  timeLeft: number;
}

export class HousePartyManager {
  readonly group = new THREE.Group();
  readonly wingmen: WingmanSuit[] = [];
  readonly bolts: WingmanBolt[] = [];

  /** Cooldown before House Party wingmen can be called again (s). */
  cooldown = 0;
  /** Whether emergency Mid-Air Hot-Swap is armed for this run. */
  hotSwapAvailable = true;
  /** Active Mid-Air Hot-Swap rescue sequence state. */
  hotSwapActive = false;
  hotSwapTimer = 0;
  readonly podPos = new THREE.Vector3();
  readonly podVel = new THREE.Vector3();
  private readonly podMesh = new THREE.Group();
  private podTrailT = 0;
  private wavesSinceSwap = 0;
  private readonly _v = new THREE.Vector3();
  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();

  constructor(private readonly hazeUniforms?: Record<string, THREE.IUniform>) {
    this.group.name = 'house-party';
    const pg = hotSwapPodGeometry();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.68, roughness: 0.32 });
    this.podMesh.add(new THREE.Mesh(pg.body, mat), new THREE.Mesh(pg.glow, wingmanGlowMat()));
    this.podMesh.visible = false;
    if (hazeUniforms && Object.keys(hazeUniforms).length > 0) hazeAll(this.podMesh, hazeUniforms);
    this.group.add(this.podMesh);
  }

  get activeCount(): number {
    return this.wingmen.filter((w) => !w.done && !w.returning).length;
  }

  get maxRemaining(): number {
    let m = 0;
    for (const w of this.wingmen) if (!w.done && !w.returning) m = Math.max(m, w.life);
    return m;
  }

  get ready(): boolean {
    return this.cooldown <= 0 && this.activeCount === 0;
  }

  /** Deploy 1 (or 2 with ≥10 fitted levels / wave ≥ 4) autonomous House Party suits from Malibu. */
  deploy(count: 1 | 2, particles: Particles, events: EventBus): boolean {
    if (!this.ready) return false;
    this.cooldown = HOUSE_PARTY_COOLDOWN;
    for (let i = 0; i < count; i++) {
      const offsetX = count === 2 ? (i === 0 ? -5.5 : 5.5) : 0;
      const at = new THREE.Vector3(PAD.x + offsetX, PAD_Y + 2.5, PAD.y);
      const w = new WingmanSuit(i, at, this.hazeUniforms);
      this.wingmen.push(w);
      this.group.add(w.mesh);
      particles.burst('dust', at, 14, 12, new THREE.Vector3(0, 1, 0), 1);
      particles.burst('spark', at, 12, 10, new THREE.Vector3(0, 1, 0), 1);
    }
    events.emit('housePartyLaunch', { at: new THREE.Vector3(PAD.x, PAD_Y + 4, PAD.y), value: count });
    events.emit('jarvis', {
      text:
        count === 2
          ? 'House Party Protocol engaged, sir. Silver Centurion and Heartbreaker airborne from Malibu.'
          : 'House Party Protocol engaged, sir. Silver Centurion inbound from the Malibu bay.',
    });
    return true;
  }

  /**
   * Attempt to trigger an emergency Mid-Air Hot-Swap when armor hits 0 with 0 reserves.
   * Returns true if Hot-Swap took over (preventing immediate suit loss).
   */
  tryStartHotSwap(
    model: FlightModel,
    ground: SurfaceQuery,
    particles: Particles,
    events: EventBus,
  ): boolean {
    if (!this.hotSwapAvailable || this.hotSwapActive) return false;
    this.hotSwapAvailable = false;
    this.hotSwapActive = true;
    this.hotSwapTimer = HOT_SWAP_FALL_TIME;
    this.wavesSinceSwap = 0;

    // If shot down very close to the ground/sea, fire emergency ejection kick so there's room for the mid-air catch!
    const surf = Math.max(ground.surface(model.pos.x, model.pos.z), 0);
    if (model.pos.y - surf < HOT_SWAP_MIN_ALT) {
      model.vel.y = Math.max(model.vel.y, 48);
      model.pos.y = Math.max(model.pos.y, surf + 28);
    }

    // Launch the spare suit pod from Malibu (or clamped within 1.4 km so intercept completes inside the fall window)
    const pad = new THREE.Vector3(PAD.x, PAD_Y + 8, PAD.y);
    const toPlayer = this._v.copy(model.pos).sub(pad);
    const dist = toPlayer.length();
    if (dist > 1350) {
      this.podPos.copy(model.pos).addScaledVector(toPlayer.normalize(), -1350);
      this.podPos.y = Math.max(this.podPos.y, Math.max(ground.surface(this.podPos.x, this.podPos.z), 0) + 120);
    } else {
      this.podPos.copy(pad);
    }
    this.podVel.copy(model.pos).sub(this.podPos).normalize().multiplyScalar(HOT_SWAP_POD_SPEED);
    this.podMesh.position.copy(this.podPos);
    this.podMesh.visible = true;
    particles.burst('spark', this.podPos, 16, 14, new THREE.Vector3(0, 1, 0), 1);

    events.emit('hotSwapLaunch', { at: this.podPos });
    events.emit('jarvis', {
      text: 'Reserves exhausted — launching emergency Mark chassis! Steer into the pod or press P to hot-swap mid-air, sir!',
    });
    return true;
  }

  /** Step wingmen, their bolts, and an active Hot-Swap pod. Returns 'caught' | 'missed' | null for Hot-Swap. */
  update(
    dt: number,
    t: number,
    model: FlightModel,
    hostiles: readonly Hostile[],
    ground: SurfaceQuery,
    missiles: Missiles,
    particles: Particles,
    streaks: Streaks,
    explosions: Explosions,
    events: EventBus,
    catchPressed: boolean,
    onKill: (h: Hostile) => void,
  ): 'caught' | 'missed' | null {
    if (this.cooldown > 0 && this.activeCount === 0) {
      this.cooldown = Math.max(0, this.cooldown - dt);
    }

    let anyReturningNow = false;
    for (let i = this.wingmen.length - 1; i >= 0; i--) {
      const w = this.wingmen[i];
      const wasReturning = w.returning;
      w.update(dt, t, model.pos, hostiles, ground, this.bolts, missiles, particles, events);
      if (!wasReturning && w.returning) anyReturningNow = true;
      if (w.done) {
        this.group.remove(w.mesh);
        this.wingmen.splice(i, 1);
      }
    }
    if (anyReturningNow && this.activeCount === 0) {
      events.emit('jarvis', { text: 'House Party units returning to the Malibu bay, sir.' });
    }

    // Update wingman repulsor bolts
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      const prev = b.p.clone();
      b.p.addScaledVector(b.v, dt);
      b.life -= dt;
      let hit = false;
      for (const h of hostiles) {
        if (!h.alive) continue;
        if (b.p.distanceToSquared(h.pos) < (h.radius + 2.2) ** 2) {
          const killed = h.damage(36, b.p, 'repulsor');
          particles.burst('spark', b.p, 10, 12, undefined, 0.9);
          if (killed) onKill(h);
          hit = true;
          break;
        }
      }
      if (!hit && b.life > 0) {
        streaks.add(prev, b.p, 3.2, 6.5, 11, 0.95, 0.14, 0.28);
      } else {
        this.bolts.splice(i, 1);
      }
    }

    // Update active Mid-Air Hot-Swap pod
    if (!this.hotSwapActive) return null;
    this.hotSwapTimer -= dt;
    // Lead player's falling trajectory smoothly
    const dist = this.podPos.distanceTo(model.pos);
    const tgo = Math.min(1.0, dist / HOT_SWAP_POD_SPEED);
    const intercept = this._v.copy(model.pos).addScaledVector(model.vel, tgo * 0.65);
    const dir = intercept.sub(this.podPos);
    const len = dir.length();
    if (len > 1e-3) dir.divideScalar(len);
    const speed = dist < 120 ? Math.max(220, model.vel.length() + 140) : HOT_SWAP_POD_SPEED;
    this.podVel.copy(dir).multiplyScalar(speed);
    this.podPos.addScaledVector(this.podVel, dt);
    this.podMesh.position.copy(this.podPos);
    if (len > 1e-3) {
      this._m.lookAt(new THREE.Vector3(), dir, new THREE.Vector3(0, 1, 0));
      this._q.setFromRotationMatrix(this._m);
      this._q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
      this.podMesh.quaternion.copy(this._q);
    }

    // Bright pod beacon trail
    this.podTrailT += dt;
    while (this.podTrailT >= 0.025) {
      this.podTrailT -= 0.025;
      particles.emit('plasma', this.podPos, undefined, { scale: 0.75, life: 0.45 });
      particles.emit('fire', this.podPos, undefined, { scale: 0.55, life: 0.3 });
    }

    const curDist = this.podPos.distanceTo(model.pos);
    const caught = curDist <= HOT_SWAP_AUTO_R || (catchPressed && curDist <= HOT_SWAP_CATCH_R);
    if (caught) {
      this.hotSwapActive = false;
      this.podMesh.visible = false;
      particles.burst('plasma', model.pos, 26, 20, undefined, 1.1, { scale: 1.2 });
      particles.burst('spark', model.pos, 24, 18, undefined, 1.0);
      explosions.muzzle(model.pos, new THREE.Vector3(0, 1, 0), 1.4);
      // Arrest vertical fall velocity so the pilot resumes clean flight immediately
      model.vel.y = Math.max(model.vel.y * 0.25, 16);
      events.emit('hotSwapCatch', { at: model.pos });
      events.emit('jarvis', { text: 'Mid-air suit transfer complete. Full armour online — try not to scratch this one, sir.' });
      return 'caught';
    }

    // Fail if the pilot hits the ground/sea or timer expires before docking
    const surf = ground.surface(model.pos.x, model.pos.z);
    if (this.hotSwapTimer <= 0 || model.pos.y <= surf + 2.2) {
      this.hotSwapActive = false;
      this.podMesh.visible = false;
      return 'missed';
    }

    // Apply light gravity hint only if needed (FlightModel already integrates fall gravity while down)
    void GRAVITY;
    return null;
  }

  /** Re-arm emergency Hot-Swap every 3 cleared waves. */
  onWaveClear(): void {
    if (!this.hotSwapAvailable) {
      this.wavesSinceSwap++;
      if (this.wavesSinceSwap >= 3) {
        this.hotSwapAvailable = true;
        this.wavesSinceSwap = 0;
      }
    }
  }

  /** Live telemetry snapshot for HUD rendering. */
  hotSwapTelemetry(playerPos: THREE.Vector3): HotSwapState | null {
    if (!this.hotSwapActive) return null;
    const distance = this.podPos.distanceTo(playerPos);
    return {
      active: true,
      podPos: this.podPos,
      podVel: this.podVel,
      distance,
      inCatchRange: distance <= HOT_SWAP_CATCH_R,
      timeLeft: Math.max(0, this.hotSwapTimer),
    };
  }

  reset(): void {
    for (const w of this.wingmen) this.group.remove(w.mesh);
    this.wingmen.length = 0;
    this.bolts.length = 0;
    this.cooldown = 0;
    this.hotSwapAvailable = true;
    this.hotSwapActive = false;
    this.hotSwapTimer = 0;
    this.wavesSinceSwap = 0;
    this.podMesh.visible = false;
  }
}
