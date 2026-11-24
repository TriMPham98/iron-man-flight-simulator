import * as THREE from 'three';
import type { Particles } from '../fx/particles';
import type { Streaks } from '../fx/streaks';
import type { EventBus } from '../sim/events';
import { HOME, HOME_HEIGHT, type Heightfield } from '../world/heightfield';
import { structureTop } from '../world/house';
import { box, glowMaterial, merge, paint } from './modelKit';
import { hazeAll } from '../render/haze';
import type { Hostile } from './types';

/**
 * Malibu Automated CIWS Perimeter Battery (House Defences Capstone L3 / L5):
 *  - Tier 0 (L0–L2): stowed / invisible.
 *  - Tier 1 (L3–L4): 2 visible automated turrets on the Malibu terrace flanks
 *    that visibly swivel and track/shoot incoming bombers & drones inside 650 m.
 *  - Tier 2 (L5): 4 automated turrets with glowing cyan perimeter rings,
 *    900 m engagement range, and higher cadence.
 */

export const CIWS_L3_RANGE = 650;
export const CIWS_L5_RANGE = 900;
const CIWS_L3_INTERVAL = 0.28;
const CIWS_L5_INTERVAL = 0.16;
const CIWS_DAMAGE = 22;

const TURRET_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-24, 18],
  [26, 20],
  [-32, -8],
  [34, -6],
];

let turretGeo: { base: THREE.BufferGeometry; head: THREE.BufferGeometry; glow: THREE.BufferGeometry } | null = null;
function getTurretGeo() {
  if (turretGeo) return turretGeo;
  const base = merge([
    paint(new THREE.CylinderGeometry(0.95, 1.25, 1.1, 10).translate(0, 0.55, 0), 0x2c323b),
    box(1.5, 0.22, 1.5, 0x454e59, 0, 1.15, 0),
  ]);
  const head = merge([
    box(0.85, 0.72, 1.1, 0x525c68, 0, 0.42, -0.05),
    // Twin rotary barrels pointing +Z
    paint(new THREE.CylinderGeometry(0.08, 0.09, 1.45, 8).rotateX(Math.PI / 2).translate(-0.18, 0.42, 0.9), 0x1d2128),
    paint(new THREE.CylinderGeometry(0.08, 0.09, 1.45, 8).rotateX(Math.PI / 2).translate(0.18, 0.42, 0.9), 0x1d2128),
  ]);
  const glow = merge([
    paint(new THREE.TorusGeometry(1.18, 0.05, 6, 16).rotateX(Math.PI / 2).translate(0, 0.12, 0), new THREE.Color(0.45, 0.92, 1.0), 5),
    paint(new THREE.BoxGeometry(0.24, 0.12, 0.08).translate(0, 0.78, 0.45), new THREE.Color(0.55, 0.95, 1.0), 6),
  ]);
  turretGeo = { base, head, glow };
  return turretGeo;
}

interface TurretNode {
  root: THREE.Group;
  head: THREE.Group;
  ringGlow: THREE.Mesh;
  pos: THREE.Vector3;
  fireT: number;
}

interface CiwsBeam {
  a: THREE.Vector3;
  b: THREE.Vector3;
  t: number;
}

export class HouseCiws {
  readonly group = new THREE.Group();
  private readonly turrets: TurretNode[] = [];
  private readonly beams: CiwsBeam[] = [];
  tier: 0 | 1 | 2 = 0;
  private readonly _v = new THREE.Vector3();

  constructor(field: Heightfield, hazeUniforms?: Record<string, THREE.IUniform>) {
    this.group.name = 'house-ciws';
    const g = getTurretGeo();
    const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.6, roughness: 0.38 });
    const glowMat = glowMaterial();

    for (const [ox, oz] of TURRET_OFFSETS) {
      const wx = HOME.x + ox;
      const wz = HOME.y + oz;
      const roof = structureTop(field, wx, wz);
      const wy = roof > -Infinity ? roof : Math.max(field.heightAt(wx, wz), HOME_HEIGHT);
      const root = new THREE.Group();
      root.position.set(wx, wy, wz);
      root.add(new THREE.Mesh(g.base, bodyMat));
      const ringGlow = new THREE.Mesh(g.glow, glowMat);
      root.add(ringGlow);
      const head = new THREE.Group();
      head.position.set(0, 1.2, 0);
      head.add(new THREE.Mesh(g.head, bodyMat));
      root.add(head);
      root.visible = false;
      this.group.add(root);
      this.turrets.push({ root, head, ringGlow, pos: new THREE.Vector3(wx, wy + 1.65, wz), fireT: Math.random() * 0.25 });
    }
    if (hazeUniforms && Object.keys(hazeUniforms).length > 0) hazeAll(this.group, hazeUniforms);
  }

  get activeTurretCount(): number {
    return this.tier === 2 ? 4 : this.tier === 1 ? 2 : 0;
  }

  get range(): number {
    return this.tier === 2 ? CIWS_L5_RANGE : this.tier === 1 ? CIWS_L3_RANGE : 0;
  }

  update(
    dt: number,
    tier: 0 | 1 | 2,
    hostiles: readonly Hostile[],
    particles: Particles,
    streaks: Streaks,
    events: EventBus,
    onKill: (h: Hostile) => void,
    disabled = false,
  ): void {
    this.tier = tier;
    const count = this.activeTurretCount;
    const maxRange = this.range;
    const interval = tier === 2 ? CIWS_L5_INTERVAL : CIWS_L3_INTERVAL;

    for (let i = 0; i < this.turrets.length; i++) {
      const tur = this.turrets[i];
      const on = i < count;
      tur.root.visible = on;
      if (!on) continue;
      tur.ringGlow.visible = tier === 2;
      if (disabled) continue;

      tur.fireT = Math.max(0, tur.fireT - dt);
      // Pick closest airborne threat (prefer bombers first!)
      let target: Hostile | null = null;
      let bestScore = Infinity;
      for (const h of hostiles) {
        if (!h.alive) continue;
        if (h.kind === 'sam' || h.kind === 'ship') continue;
        const d = tur.pos.distanceTo(h.pos);
        if (d > maxRange) continue;
        const score = h.kind === 'bomber' ? d * 0.45 : d;
        if (score < bestScore) {
          bestScore = score;
          target = h;
        }
      }
      if (!target) continue;

      // Visibly swivel turret head toward target
      this._v.copy(target.pos).sub(tur.pos);
      const yaw = Math.atan2(this._v.x, this._v.z);
      const horiz = Math.max(0.01, Math.hypot(this._v.x, this._v.z));
      const pitch = -Math.atan2(this._v.y, horiz);
      tur.head.rotation.set(pitch, yaw, 0, 'YXZ');

      if (tur.fireT <= 0) {
        tur.fireT = interval;
        const killed = target.damage(CIWS_DAMAGE, target.pos, 'repulsor');
        this.beams.push({ a: tur.pos.clone(), b: target.pos.clone(), t: 0.1 });
        particles.burst('spark', target.pos, 5, 10, undefined, 0.8);
        events.emit('repulsorHit', { at: target.pos, value: 0 });
        if (killed) onKill(target);
      }
    }

    // Draw glowing cyan-amber CIWS tracer lines
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      b.t -= dt;
      if (b.t <= 0) {
        this.beams.splice(i, 1);
        continue;
      }
      const k = b.t / 0.1;
      if (tier === 2) {
        streaks.add(b.a, b.b, 4 * k, 8 * k, 13 * k, k, 0.08, 0.2);
      } else {
        streaks.add(b.a, b.b, 11 * k, 7.5 * k, 2.5 * k, k, 0.08, 0.18);
      }
    }
  }

  reset(): void {
    this.beams.length = 0;
  }
}
