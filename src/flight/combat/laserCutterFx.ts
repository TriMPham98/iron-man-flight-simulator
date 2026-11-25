import * as THREE from 'three';
import type { Particles } from '../fx/particles';
import type { Streaks } from '../fx/streaks';
import { withLogDepth } from '../render/depth';
import type { EventBus } from '../sim/events';
import type { Heightfield } from '../world/heightfield';
import { segmentToCore } from './hitShape';
import type { Missiles } from './missiles';
import type { Hostile } from './types';

/**
 * One-shot sweeping wrist laser cutter (Iron Man 2 style): a razor-thin
 * crimson-white cutting beam emitted from the right forearm that sweeps across
 * a ~55° horizontal arc in ~0.65 s, slicing through drones, interceptors,
 * missiles, and ship/boss turrets in its path with showers of molten sparks.
 *
 * Also hosts the lightweight blue-white crackling arc particle emitter used
 * during the 400% Reactor Overcharge state.
 */

export const LASER_CUTTER_ARC_RAD = THREE.MathUtils.degToRad(55);
export const LASER_CUTTER_DURATION = 0.65;
export const LASER_CUTTER_RANGE = 420;
export const LASER_CUTTER_BASE_DAMAGE = 260;
const CUTTER_HIT_MARGIN = 2.2;
const CUTTER_MISSILE_RADIUS = 5.5;
const SUBSTEPS = 4;

const CUTTER_VERT = /* glsl */ `
uniform vec3 uA;
uniform vec3 uB;
uniform vec2 uWidth;
attribute float aT;
attribute float aSide;
varying vec2 vUv;
varying float vLen;
varying float vView;
void main() {
  vec3 a = (viewMatrix * vec4(uA, 1.0)).xyz;
  vec3 b = (viewMatrix * vec4(uB, 1.0)).xyz;
  float len = length(uB - uA);
  bool behind = a.z > -0.05 && b.z > -0.05;
  float ta = 0.0;
  if (a.z > -0.05) { float k = (-0.05 - b.z) / (a.z - b.z + 1e-5); ta = 1.0 - k; a = mix(b, a, k); }
  if (b.z > -0.05) b = mix(a, b, (-0.05 - a.z) / (b.z - a.z + 1e-5));
  vec3 dir = b - a;
  float l = length(dir);
  dir = l > 1e-5 ? dir / l : vec3(0.0, 1.0, 0.0);
  float t = aT;
  vec3 mid = mix(a, b, t);
  vec3 side = cross(dir, mid);
  float sl = length(side);
  if (sl < 1e-4 * max(length(mid), 1e-3)) {
    side = cross(dir, abs(dir.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0));
    sl = length(side);
  }
  side /= sl;
  float w = mix(uWidth.x, uWidth.y, mix(ta, 1.0, t));
  vec3 p = mid + side * aSide * w;
  vUv = vec2(aSide, t);
  vLen = mix(ta, 1.0, t) * len;
  vView = -mid.z;
  gl_Position = behind ? vec4(0.0, 0.0, 2.0, 1.0) : projectionMatrix * vec4(p, 1.0);
}
`;

const CUTTER_FRAG = /* glsl */ `
uniform float uTime;
uniform float uPower;
uniform vec3 uBladeCol;
uniform vec3 uHaloCol;
varying vec2 vUv;
varying float vLen;
varying float vView;
void main() {
  float x = abs(vUv.x);
  float core = exp(-pow(x / 0.14, 2.0) * 2.2);
  float blade = exp(-pow(x / 0.36, 2.0) * 2.0);
  float halo = exp(-x * x * 3.5) * 0.4;
  float pulse = 0.88 + 0.12 * sin(vLen * 3.5 - uTime * 95.0);
  vec3 col = vec3(1.0, 0.96, 0.92) * core * 6.5
           + uBladeCol * blade * 2.8 * pulse
           + uHaloCol * halo;
  col *= smoothstep(0.35, 2.5, vView);
  gl_FragColor = vec4(col * uPower, 1.0);
}
`;

const LASER_SPARK_HOT = new THREE.Color(16, 4, 2);
const LASER_SPARK_COOL = new THREE.Color(6, 0.6, 0.15);
const FLAK_SPARK_HOT = new THREE.Color(18, 11, 3);
const FLAK_SPARK_COOL = new THREE.Color(8, 2.4, 0.25);
const ARC_HOT = new THREE.Color(8, 12, 18);
const ARC_COOL = new THREE.Color(1.5, 4.5, 11);

/** War Machine's flak sweep: a wider arc (rad) and a damage bonus. */
export const WM_FLAK_SWEEP_ARC_RAD = THREE.MathUtils.degToRad(64);
export const WM_FLAK_SWEEP_DAMAGE_MULT = 1.12;

/** Its rounds: how many leave a second, how fast (m/s), their spread (rad) and drawn length (m). */
const FLAK_RATE = 75;
const FLAK_SPEED = 1300;
const FLAK_SPREAD = 0.014;
const FLAK_REACH = 18;

interface FlakRound {
  p: THREE.Vector3;
  from: THREE.Vector3;
  dir: THREE.Vector3;
  flown: number;
  /** Where its fuse goes off, or the ground does (m). */
  fuse: number;
}

/** Eased sweep angle (rad) across `[-arc/2, +arc/2]` for normalized progress `u` in `[0, 1]`. */
export function sweepProgressAngle(u: number, totalArcRad = LASER_CUTTER_ARC_RAD): number {
  const c = THREE.MathUtils.clamp(u, 0, 1);
  // Crisp S-curve: snaps out and whips across the sector
  const eased = c * c * (3 - 2 * c);
  return (eased - 0.5) * totalArcRad;
}

/** Unit ray direction rotated horizontally from `forward` toward `right` by `angleRad`. */
export function sweepDirection(forward: THREE.Vector3, right: THREE.Vector3, angleRad: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.copy(forward).multiplyScalar(Math.cos(angleRad)).addScaledVector(right, Math.sin(angleRad)).normalize();
}

/** Squared distance from point `p` to segment `a -> b`. */
function pointSegmentDistSq(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz;
  const t = l2 > 1e-8 ? THREE.MathUtils.clamp(((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / l2, 0, 1) : 0;
  const dx = a.x + abx * t - p.x;
  const dy = a.y + aby * t - p.y;
  const dz = a.z + abz * t - p.z;
  return dx * dx + dy * dy + dz * dz;
}

export interface LaserCutterRaycaster {
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): number;
  heightAt(x: number, z: number): number;
}

export class LaserCutterFx {
  readonly group = new THREE.Group();
  active = false;
  elapsed = 0;
  duration = LASER_CUTTER_DURATION;
  cooldown = 0;
  readonly beamFrom = new THREE.Vector3();
  readonly beamEnd = new THREE.Vector3();
  readonly beamDir = new THREE.Vector3(0, 0, 1);

  private readonly baseFwd = new THREE.Vector3(0, 0, 1);
  private readonly baseRight = new THREE.Vector3(1, 0, 0);
  private readonly hitIds = new Set<number>();
  private readonly hitMissiles = new WeakSet<object>();
  private prevU = 0;
  private damageMult = 1;
  private time = 0;
  private isWarmachine = false;
  private flakPopAcc = 0;
  private flakAcc = 0;
  private readonly flak: FlakRound[] = [];

  private readonly ribbon: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly light = new THREE.PointLight(0xff4030, 0, 24, 2);
  private readonly _dir = new THREE.Vector3();
  private readonly _end = new THREE.Vector3();
  private readonly _v = new THREE.Vector3();
  private readonly _n = new THREE.Vector3();
  private readonly _w = new THREE.Vector3();

  constructor() {
    this.group.name = 'laser-cutter';
    const segs = 16;
    const t: number[] = [];
    const side: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      t.push(u, u);
      side.push(-1, 1);
      if (i < segs) {
        const k = i * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(t.length * 3), 3));
    geo.setAttribute('aT', new THREE.Float32BufferAttribute(t, 1));
    geo.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
    geo.setIndex(idx);
    const mat = withLogDepth(
      new THREE.ShaderMaterial({
        vertexShader: CUTTER_VERT,
        fragmentShader: CUTTER_FRAG,
        uniforms: {
          uA: { value: new THREE.Vector3() },
          uB: { value: new THREE.Vector3() },
          uWidth: { value: new THREE.Vector2(0.18, 0.42) },
          uTime: { value: 0 },
          uPower: { value: 0 },
          uBladeCol: { value: new THREE.Vector3(1.0, 0.22, 0.12) },
          uHaloCol: { value: new THREE.Vector3(1.0, 0.08, 0.04) },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
    this.ribbon = new THREE.Mesh(geo, mat);
    this.ribbon.frustumCulled = false;
    this.ribbon.renderOrder = 8;
    this.ribbon.visible = false;
    this.group.add(this.ribbon, this.light);
  }

  /** Switch between Iron Man's crimson wrist laser cutter and War Machine's flak sweep (a fan of cannon fire, no beam). */
  setVariant(variant: 'ironman' | 'warmachine'): void {
    this.isWarmachine = variant === 'warmachine';
    this.flak.length = 0;
    const u = this.ribbon.material.uniforms;
    if (this.isWarmachine) {
      this.light.color.setHex(0xff9830);
    } else {
      (u.uBladeCol.value as THREE.Vector3).set(1.0, 0.22, 0.12);
      (u.uHaloCol.value as THREE.Vector3).set(1.0, 0.08, 0.04);
      this.light.color.setHex(0xff4030);
    }
  }

  /** Begin a sweeping cutting laser / flak burst anchored to the aim frame. */
  trigger(origin: THREE.Vector3, forward: THREE.Vector3, up: THREE.Vector3, damageMult: number, cooldownDuration: number): void {
    this.active = true;
    this.elapsed = 0;
    this.prevU = 0;
    this.flakPopAcc = 0;
    this.flakAcc = 0;
    this.duration = LASER_CUTTER_DURATION;
    this.cooldown = cooldownDuration;
    this.damageMult = damageMult * (this.isWarmachine ? WM_FLAK_SWEEP_DAMAGE_MULT : 1);
    this.hitIds.clear();
    this.beamFrom.copy(origin);
    this.baseFwd.copy(forward).normalize();
    this.baseRight.crossVectors(this.baseFwd, up);
    if (this.baseRight.lengthSq() < 1e-4) this.baseRight.set(1, 0, 0);
    else this.baseRight.normalize();
    const arc = this.isWarmachine ? WM_FLAK_SWEEP_ARC_RAD : LASER_CUTTER_ARC_RAD;
    sweepDirection(this.baseFwd, this.baseRight, sweepProgressAngle(0, arc), this.beamDir);
    this.beamEnd.copy(origin).addScaledVector(this.beamDir, LASER_CUTTER_RANGE);
  }

  /** Advance cooldown and active sweep, slicing hostiles and enemy missiles along the swept arc. */
  step(
    dt: number,
    origin: THREE.Vector3,
    field: LaserCutterRaycaster | Heightfield,
    hostiles: readonly Hostile[],
    missiles: Pick<Missiles, 'inbound' | 'shootDown'>,
    particles: Particles | null,
    streaks: Streaks | null,
    events: EventBus | null,
    onKill: (h: Hostile) => void,
  ): { slicedHostiles: number; slicedMissiles: number } {
    this.time += dt;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.stepFlak(dt, particles, streaks);
    if (!this.active) {
      this.ribbon.visible = false;
      this.light.intensity = 0;
      return { slicedHostiles: 0, slicedMissiles: 0 };
    }

    this.elapsed += dt;
    const curU = Math.min(1, this.elapsed / this.duration);
    this.beamFrom.copy(origin);
    let slicedHostiles = 0;
    let slicedMissiles = 0;
    const damage = LASER_CUTTER_BASE_DAMAGE * this.damageMult;
    const inbound = missiles.inbound();

    const hotCol = this.isWarmachine ? FLAK_SPARK_HOT : LASER_SPARK_HOT;
    const coolCol = this.isWarmachine ? FLAK_SPARK_COOL : LASER_SPARK_COOL;
    const arc = this.isWarmachine ? WM_FLAK_SWEEP_ARC_RAD : LASER_CUTTER_ARC_RAD;

    for (let s = 1; s <= SUBSTEPS; s++) {
      const u = THREE.MathUtils.lerp(this.prevU, curU, s / SUBSTEPS);
      const ang = sweepProgressAngle(u, arc);
      const dir = sweepDirection(this.baseFwd, this.baseRight, ang, this._dir);
      let reach = LASER_CUTTER_RANGE;
      const hitGround = field.raycast(origin, dir, reach);
      if (hitGround > 0) reach = hitGround;
      const end = this._end.copy(origin).addScaledVector(dir, reach);

      for (const h of hostiles) {
        if (!h.alive || this.hitIds.has(h.id)) continue;
        const d2 = segmentToCore(h, origin, end, this._v, this._n);
        const margin = h.radius + CUTTER_HIT_MARGIN + (this.isWarmachine ? 0.9 : 0);
        if (d2 <= margin * margin) {
          this.hitIds.add(h.id);
          slicedHostiles++;
          const hitAt = this._v.clone();
          const killed = h.damage(damage, hitAt, 'unibeam');
          if (particles) {
            particles.emit('flash', hitAt, h.vel, { scale: this.isWarmachine ? 0.65 : 0.45, color: hotCol, end: coolCol });
            particles.burst('spark', hitAt, this.isWarmachine ? 30 : 22, 24, this._w.copy(dir).negate(), 1.1, { color: hotCol, end: coolCol });
            if (this.isWarmachine) {
              particles.burst('fire', hitAt, 6, 10, undefined, 0.9, { scale: 0.9, life: 0.5 });
              particles.burst('smoke', hitAt, 4, 8, undefined, 0.8, { scale: 1.0, life: 0.8 });
            }
          }
          if (killed) onKill(h);
        }
      }

      for (const m of inbound) {
        if (this.hitMissiles.has(m)) continue;
        const mRad = CUTTER_MISSILE_RADIUS + (this.isWarmachine ? 1.5 : 0);
        if (pointSegmentDistSq(m.pos, origin, end) <= mRad * mRad) {
          this.hitMissiles.add(m);
          slicedMissiles++;
          const at = m.pos.clone();
          if (particles) particles.burst('spark', at, 14, 18, undefined, 1, { color: hotCol, end: coolCol });
          events?.emit('intercept', { at, text: 'suit' });
          missiles.shootDown(m);
        }
      }

      if (s === SUBSTEPS) {
        this.beamDir.copy(dir);
        this.beamEnd.copy(end);
        if (particles) {
          if (hitGround > 0) {
            const water = field.heightAt(end.x, end.z) < 0 && end.y < 1;
            if (water) particles.burst('spray', end, 4, 8, new THREE.Vector3(0, 1.4, 0), 0.7);
            else particles.burst('spark', end, 6, 16, new THREE.Vector3(0, 0.8, 0), 1.0, { color: hotCol, end: coolCol });
          }
          particles.emit('flash', origin, undefined, { scale: 0.05, color: hotCol, end: coolCol });
          // War Machine's flak pops staggered incendiary airbursts along the arc
          if (this.isWarmachine) {
            this.flakPopAcc += dt * 16;
            while (this.flakPopAcc >= 1) {
              this.flakPopAcc -= 1;
              const dPop = Math.min(reach * 0.85, 22 + Math.random() * 140);
              const popAt = this._w.copy(origin).addScaledVector(dir, dPop);
              particles.emit('flash', popAt, undefined, { scale: 0.35, color: hotCol, end: coolCol });
              particles.burst('spark', popAt, 8, 16, undefined, 0.9, { scale: 0.9, life: 0.4, color: hotCol, end: coolCol });
              particles.emit('fire', popAt, undefined, { scale: 0.85, life: 0.35 });
              particles.emit('smoke', popAt, undefined, { scale: 1.1, life: 0.7 });
            }
          }
        }
      }
    }

    this.prevU = curU;
    // Envelope: quick snap-in, crisp cut-out
    const env = THREE.MathUtils.smoothstep(curU, 0, 0.08) * (1 - THREE.MathUtils.smoothstep(curU, 0.88, 1));
    this.ribbon.visible = env > 0.01 && !this.isWarmachine;
    if (this.isWarmachine) this.fireFlak(dt, field);
    const uniforms = this.ribbon.material.uniforms;
    (uniforms.uA.value as THREE.Vector3).copy(this.beamFrom);
    (uniforms.uB.value as THREE.Vector3).copy(this.beamEnd);
    const len = this.beamFrom.distanceTo(this.beamEnd);
    (uniforms.uWidth.value as THREE.Vector2).set(0.16 * env, (0.28 + len * 0.001) * env);
    uniforms.uTime.value = this.time;
    uniforms.uPower.value = env * 1.15;
    this.light.position.copy(this.beamFrom).addScaledVector(this.beamDir, 1.2);
    this.light.intensity = 65 * env;

    // Add a bright streak core along the cut line for extra punch
    if (streaks && env > 0.05 && !this.isWarmachine) {
      streaks.add(this.beamFrom, this.beamEnd, 14 * env, 2.5 * env, 1.5 * env, env, 0.04, 0.14);
    }

    if (curU >= 1) {
      this.active = false;
      this.ribbon.visible = false;
      this.light.intensity = 0;
    }
    return { slicedHostiles, slicedMissiles };
  }

  /** Rounds off the gauntlet along the sweep: each flies on down the line it was fired on. */
  private fireFlak(dt: number, field: LaserCutterRaycaster | Heightfield): void {
    this.flakAcc += dt * FLAK_RATE;
    while (this.flakAcc >= 1) {
      this.flakAcc -= 1;
      const dir = this.beamDir
        .clone()
        .add(this._w.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(2 * FLAK_SPREAD))
        .normalize();
      const ground = field.raycast(this.beamFrom, dir, LASER_CUTTER_RANGE);
      const flown = Math.random() * dt * FLAK_SPEED;
      this.flak.push({
        p: this.beamFrom.clone().addScaledVector(dir, flown),
        from: this.beamFrom.clone(),
        dir,
        flown,
        fuse: ground > 0 ? ground : LASER_CUTTER_RANGE * (0.6 + 0.4 * Math.random()),
      });
    }
  }

  private stepFlak(dt: number, particles: Particles | null, streaks: Streaks | null): void {
    for (let i = this.flak.length - 1; i >= 0; i--) {
      const r = this.flak[i];
      r.flown += FLAK_SPEED * dt;
      if (r.flown >= r.fuse) {
        if (particles) {
          const at = this._w.copy(r.from).addScaledVector(r.dir, r.fuse);
          particles.emit('flash', at, undefined, { scale: 0.3, color: FLAK_SPARK_HOT, end: FLAK_SPARK_COOL });
          particles.emit('smoke', at, undefined, { scale: 0.9, life: 0.7 });
        }
        this.flak.splice(i, 1);
        continue;
      }
      r.p.copy(r.from).addScaledVector(r.dir, r.flown);
      if (streaks) {
        const tail = this._v.copy(r.p).addScaledVector(r.dir, -Math.min(FLAK_REACH, r.flown));
        streaks.add(tail, r.p, 13, 6, 1.2, 0.85, 0.02, 0.22);
      }
    }
  }

  reset(): void {
    this.active = false;
    this.flak.length = 0;
    this.elapsed = 0;
    this.prevU = 0;
    this.cooldown = 0;
    this.hitIds.clear();
    this.ribbon.visible = false;
    this.light.intensity = 0;
  }
}

const _arcA = new THREE.Vector3();
const _arcB = new THREE.Vector3();
const _arcV = new THREE.Vector3();

/**
 * Emit crackling blue-white electric arcs and plasma wisps around the suit
 * while 400% OVERCHARGE is active.
 */
export function emitOverchargeArcs(
  dt: number,
  suitPos: THREE.Vector3,
  suitVel: THREE.Vector3,
  particles: Particles,
  streaks: Streaks,
  intensity = 1,
): void {
  if (intensity <= 0) return;
  // Crackling blue-white plasma sparks shedding off the armour
  if (Math.random() < Math.min(1, dt * 45 * intensity)) {
    const a = Math.random() * Math.PI * 2;
    const h = (Math.random() - 0.5) * 1.5;
    const r = 0.45 + Math.random() * 0.45;
    _arcA.set(suitPos.x + Math.cos(a) * r, suitPos.y + h, suitPos.z + Math.sin(a) * r);
    _arcV.set(Math.cos(a) * 3.5, (Math.random() - 0.3) * 3, Math.sin(a) * 3.5).add(suitVel);
    particles.emit('spark', _arcA, _arcV, { scale: 1.1, life: 0.25, color: ARC_HOT, end: ARC_COOL });
  }
  if (Math.random() < Math.min(1, dt * 20 * intensity)) {
    _arcA.set(suitPos.x + (Math.random() - 0.5) * 0.8, suitPos.y + (Math.random() - 0.5) * 1.2, suitPos.z + (Math.random() - 0.5) * 0.8);
    particles.emit('plasma', _arcA, suitVel, { scale: 0.55, life: 0.22, color: ARC_HOT, end: ARC_COOL });
  }
  // Short jagged electric arcs dancing over the hull
  const arcs = Math.random() < 0.7 ? 2 : 1;
  for (let i = 0; i < arcs; i++) {
    const a1 = Math.random() * Math.PI * 2;
    const a2 = a1 + (Math.random() - 0.5) * 2.0;
    const r1 = 0.35 + Math.random() * 0.4;
    const r2 = 0.45 + Math.random() * 0.5;
    _arcA.set(suitPos.x + Math.cos(a1) * r1, suitPos.y + (Math.random() - 0.5) * 1.4, suitPos.z + Math.sin(a1) * r1);
    _arcB.set(suitPos.x + Math.cos(a2) * r2, suitPos.y + (Math.random() - 0.5) * 1.4, suitPos.z + Math.sin(a2) * r2);
    streaks.add(_arcA, _arcB, 7 * intensity, 11 * intensity, 16 * intensity, 0.9, 0.025, 0.07);
  }
}
