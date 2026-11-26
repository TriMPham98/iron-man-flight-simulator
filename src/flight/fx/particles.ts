import * as THREE from 'three';
import { withLogDepth } from '../render/depth';
import { ATMOSPHERE_GLSL } from '../world/atmosphere';
import { GRAVITY } from '../world/config';

/**
 * World-space particles: one pool for everything that burns or glows
 * (additive, HDR so it blooms) and one for everything that hangs in the air
 * (smoke, dust, spray, vapour — alpha blended, sorted back to front, and lit
 * by the low sun as soft spheres so a smoke column has a bright side and a
 * shadow side). Both fade into the haze with distance. Each pool is a single
 * instanced draw.
 */

export type ParticleKind =
  | 'smoke'
  | 'darkSmoke'
  | 'dust'
  | 'spray'
  | 'droplet'
  | 'mist'
  | 'trail'
  | 'vapor'
  | 'fire'
  | 'spark'
  | 'flash'
  | 'ember'
  | 'plasma';

interface Preset {
  glow: boolean;
  life: [number, number];
  size: [number, number];
  grow: number;
  color: [number, number, number];
  /** Colour the particle ends at (glow cools; smoke greys). */
  end?: [number, number, number];
  alpha: number;
  drag: number;
  /** + rises (hot smoke), − falls (spray, sparks), in g. */
  lift: number;
  spin: number;
  /** Alpha curve: rise share of life (0 = pops in). */
  fadeIn: number;
}

const PRESETS: Record<ParticleKind, Preset> = {
  smoke: { glow: false, life: [3.5, 6], size: [3, 5], grow: 4.5, color: [0.42, 0.4, 0.38], alpha: 0.55, drag: 0.9, lift: 0.06, spin: 0.25, fadeIn: 0.06 },
  darkSmoke: { glow: false, life: [5, 9], size: [4, 7], grow: 5, color: [0.07, 0.065, 0.06], end: [0.2, 0.19, 0.18], alpha: 0.7, drag: 0.8, lift: 0.09, spin: 0.2, fadeIn: 0.04 },
  dust: { glow: false, life: [2, 3.5], size: [1.5, 3], grow: 3.5, color: [0.42, 0.34, 0.24], alpha: 0.45, drag: 2.2, lift: 0.01, spin: 0.3, fadeIn: 0.05 },
  spray: { glow: false, life: [0.8, 1.6], size: [0.6, 1.4], grow: 2.6, color: [0.8, 0.85, 0.88], alpha: 0.5, drag: 1.6, lift: -0.55, spin: 0.4, fadeIn: 0.02 },
  // Thrown water: small and ballistic (no puff to hold it up), gone under the surface it falls back to
  droplet: { glow: false, life: [1.1, 2], size: [0.07, 0.16], grow: 0.15, color: [0.86, 0.9, 0.94], alpha: 0.7, drag: 0.3, lift: -1, spin: 0, fadeIn: 0 },
  mist: { glow: false, life: [1.6, 2.8], size: [2.5, 4.5], grow: 3, color: [0.82, 0.86, 0.9], alpha: 0.22, drag: 2.5, lift: 0.0, spin: 0.15, fadeIn: 0.1 },
  trail: { glow: false, life: [3.5, 5.5], size: [0.7, 1.1], grow: 1.6, color: [0.72, 0.72, 0.72], alpha: 0.42, drag: 1.4, lift: 0.01, spin: 0.2, fadeIn: 0.02 },
  vapor: { glow: false, life: [0.25, 0.45], size: [0.4, 0.8], grow: 2.5, color: [0.95, 0.97, 1.0], alpha: 0.3, drag: 3, lift: 0, spin: 0.5, fadeIn: 0.1 },
  fire: { glow: true, life: [0.35, 0.8], size: [2, 3.5], grow: 1.2, color: [9, 4.2, 1.4], end: [1.6, 0.25, 0.05], alpha: 1, drag: 1.6, lift: 0.25, spin: 1.5, fadeIn: 0.02 },
  spark: { glow: true, life: [0.5, 1.3], size: [0.08, 0.16], grow: -0.06, color: [14, 8, 3], end: [3, 0.6, 0.1], alpha: 1, drag: 0.35, lift: -1, spin: 0, fadeIn: 0 },
  flash: { glow: true, life: [0.08, 0.14], size: [6, 9], grow: 12, color: [16, 11, 7], end: [4, 1.5, 0.4], alpha: 1, drag: 0, lift: 0, spin: 0, fadeIn: 0 },
  ember: { glow: true, life: [0.25, 0.5], size: [0.25, 0.45], grow: -0.5, color: [5, 2.2, 0.7], end: [1, 0.2, 0.05], alpha: 1, drag: 2.5, lift: 0.05, spin: 0, fadeIn: 0 },
  plasma: { glow: true, life: [0.18, 0.35], size: [0.35, 0.6], grow: 0.8, color: [3.5, 6, 9], end: [0.6, 1.4, 3], alpha: 1, drag: 3, lift: 0, spin: 0.8, fadeIn: 0 },
};

function puffTexture(glow: boolean): THREE.Texture {
  const n = glow ? 128 : 256;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d')!;
  const img = g.createImageData(n, n);
  // Soft-edged blob with multi-octave lumpy detail inside (smoke), or a clean
  // falloff (glow)
  const rnd = new Float32Array(17 * 17).map(() => Math.random());
  const noise = (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const tx = x - xi;
    const ty = y - yi;
    const at = (i: number, j: number) => rnd[(j % 16) * 17 + (i % 16)];
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    return at(xi, yi) * (1 - sx) * (1 - sy) + at(xi + 1, yi) * sx * (1 - sy) + at(xi, yi + 1) * (1 - sx) * sy + at(xi + 1, yi + 1) * sx * sy;
  };
  const scale = n / 128;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n - 0.5;
      const v = (y + 0.5) / n - 0.5;
      const r = Math.sqrt(u * u + v * v) * 2;
      let a: number;
      let occ = 255;
      if (glow) {
        a = Math.max(0, 1 - r);
        a = a * a * (0.4 + 0.6 * a);
      } else {
        const sx = x / scale;
        const sy = y / scale;
        const lump =
          noise(sx / 16, sy / 16) * 0.5 +
          noise(sx / 8 + 3, sy / 8 + 5) * 0.28 +
          noise(sx / 4 + 7, sy / 4 + 2) * 0.14 +
          noise(sx / 2 + 11, sy / 2 + 9) * 0.08;
        a = Math.max(0, 1 - r * (0.83 + lump * 0.42));
        a = Math.pow(a, 1.35) * (0.62 + 0.38 * lump);
        occ = Math.round(Math.min(1, 0.52 + 0.48 * lump) * 255);
      }
      const k = (y * n + x) * 4;
      img.data[k] = occ;
      img.data[k + 1] = img.data[k + 2] = occ;
      img.data[k + 3] = Math.round(Math.min(1, a) * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iColor;
attribute vec2 iSizeRot;
uniform float uGlow;
varying vec2 vUv;
varying vec4 vColor;
varying float vHaze;
varying vec3 vHazeCol;
${ATMOSPHERE_GLSL}
void main() {
  vUv = uv;
  vec4 mv = viewMatrix * vec4(iPos, 1.0);
  float c = cos(iSizeRot.y);
  float s = sin(iSizeRot.y);
  vec2 corner = mat2(c, s, -s, c) * position.xy * iSizeRot.x;
  mv.xy += corner;
  vColor = iColor;
  // A puff the eye is inside of (the helmet view, a palm flash by the face)
  // fades out before the near plane cuts its square edge across the frame
  vColor.a *= clamp((-mv.z - 0.12) / max(iSizeRot.x, 0.05), 0.0, 1.0);
  vHaze = hazeAmount(cameraPosition, iPos);
  vHazeCol = uGlow > 0.5 ? vec3(0.0) : hazeColor(normalize(iPos - cameraPosition));
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uGlow;
uniform vec3 uSunView;
uniform vec3 uSunCol;
uniform vec3 uAmb;
varying vec2 vUv;
varying vec4 vColor;
varying float vHaze;
varying vec3 vHazeCol;
void main() {
  vec4 tex = texture2D(uMap, vUv);
  float a = tex.a * vColor.a;
  if (a < 0.004) discard;
  if (uGlow > 0.5) {
    gl_FragColor = vec4(vColor.rgb * a * (1.0 - vHaze), 1.0);
    return;
  }
  // Light the puff as a soft sphere with internal crevice occlusion and silver-lining scatter
  vec2 p = vUv * 2.0 - 1.0;
  vec3 n = normalize(vec3(p, sqrt(max(0.0, 1.0 - dot(p, p))) + 0.35));
  float sun = clamp(dot(n, uSunView) * 0.55 + 0.45, 0.0, 1.0) * (0.72 + 0.28 * tex.r);
  // Light through the thin edges toward the sun
  float rim = pow(1.0 - n.z, 2.0) * max(-uSunView.z, 0.0) * (1.2 - 0.5 * tex.a);
  vec3 col = vColor.rgb * (uAmb * (0.78 + 0.22 * tex.r) + uSunCol * (sun * 0.55 + rim * 0.9));
  col = mix(col, vHazeCol, vHaze);
  gl_FragColor = vec4(col, a);
}
`;

/**
 * Sort `order[0..count)` in descending order of `keys[order[i]]` using an
 * inlined iterative quicksort + insertion sort (no comparator closure calls).
 */
export function sortIndicesDesc(order: Uint32Array | Uint16Array | Int32Array, keys: Float32Array, count: number): void {
  if (count <= 1) return;
  const stack = sortStack;
  let sp = 0;
  stack[sp++] = 0;
  stack[sp++] = count - 1;
  while (sp > 0) {
    const hi = stack[--sp];
    const lo = stack[--sp];
    if (hi - lo <= 16) {
      for (let i = lo + 1; i <= hi; i++) {
        const idx = order[i];
        const key = keys[idx];
        let j = i - 1;
        while (j >= lo && keys[order[j]] < key) {
          order[j + 1] = order[j];
          j--;
        }
        order[j + 1] = idx;
      }
      continue;
    }
    const mid = (lo + hi) >> 1;
    const pivot = keys[order[mid]];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (keys[order[i]] > pivot) i++;
      while (keys[order[j]] < pivot) j--;
      if (i <= j) {
        const tmp = order[i];
        order[i] = order[j];
        order[j] = tmp;
        i++;
        j--;
      }
    }
    if (j - lo > hi - i) {
      if (lo < j) {
        stack[sp++] = lo;
        stack[sp++] = j;
      }
      if (i < hi) {
        stack[sp++] = i;
        stack[sp++] = hi;
      }
    } else {
      if (i < hi) {
        stack[sp++] = i;
        stack[sp++] = hi;
      }
      if (lo < j) {
        stack[sp++] = lo;
        stack[sp++] = j;
      }
    }
  }
}

const sortStack = new Int32Array(128);

class Pool {
  readonly max: number;
  count = 0;
  // Structure of arrays
  readonly p: Float32Array;
  readonly v: Float32Array;
  readonly age: Float32Array;
  readonly life: Float32Array;
  readonly size: Float32Array;
  readonly grow: Float32Array;
  readonly rot: Float32Array;
  readonly spin: Float32Array;
  readonly c0: Float32Array;
  readonly c1: Float32Array;
  readonly alpha: Float32Array;
  readonly drag: Float32Array;
  readonly lift: Float32Array;
  readonly fadeIn: Float32Array;
  readonly mesh: THREE.Mesh;
  private readonly iPos: THREE.InstancedBufferAttribute;
  private readonly iColor: THREE.InstancedBufferAttribute;
  private readonly iSizeRot: THREE.InstancedBufferAttribute;
  private readonly geo: THREE.InstancedBufferGeometry;
  private order: Uint32Array;
  private keys: Float32Array;

  constructor(max: number, readonly glow: boolean, uniforms: Record<string, THREE.IUniform>) {
    this.max = max;
    const f = (k: number) => new Float32Array(max * k);
    this.p = f(3);
    this.v = f(3);
    this.age = f(1);
    this.life = f(1);
    this.size = f(1);
    this.grow = f(1);
    this.rot = f(1);
    this.spin = f(1);
    this.c0 = f(3);
    this.c1 = f(3);
    this.alpha = f(1);
    this.drag = f(1);
    this.lift = f(1);
    this.fadeIn = f(1);
    this.order = new Uint32Array(max);
    this.keys = new Float32Array(max);
    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    this.iPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.iColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.iSizeRot = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.iPos);
    geo.setAttribute('iColor', this.iColor);
    geo.setAttribute('iSizeRot', this.iSizeRot);
    geo.instanceCount = 0;
    this.geo = geo;
    const mat = withLogDepth(
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: { ...uniforms, uMap: { value: puffTexture(glow) }, uGlow: { value: glow ? 1 : 0 } },
        transparent: true,
        depthWrite: false,
        blending: glow ? THREE.AdditiveBlending : THREE.NormalBlending,
      }),
    );
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = glow ? 6 : 5;
  }

  spawn(): number {
    if (this.count >= this.max) {
      // Recycle the oldest-by-share slot: overwrite at random to avoid stalls
      return Math.floor(Math.random() * this.max);
    }
    return this.count++;
  }

  private kill(i: number): void {
    const j = --this.count;
    if (i === j) return;
    const mv = (a: Float32Array, k: number) => a.copyWithin(i * k, j * k, j * k + k);
    mv(this.p, 3);
    mv(this.v, 3);
    mv(this.c0, 3);
    mv(this.c1, 3);
    for (const a of [this.age, this.life, this.size, this.grow, this.rot, this.spin, this.alpha, this.drag, this.lift, this.fadeIn]) a[i] = a[j];
  }

  update(dt: number, eye: THREE.Vector3): void {
    for (let i = this.count - 1; i >= 0; i--) {
      // Born this frame: drawn where it was emitted. Emitters place it where
      // the suit is drawn now, so a step on at the suit's speed would put a
      // muzzle or port flash metres ahead of the hardware (in front of the
      // helmet's eye at speed)
      const born = this.age[i] === 0;
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.kill(i);
        continue;
      }
      if (born) continue;
      const d = Math.exp(-this.drag[i] * dt);
      const k = i * 3;
      this.v[k] *= d;
      this.v[k + 1] = this.v[k + 1] * d + this.lift[i] * GRAVITY * dt;
      this.v[k + 2] *= d;
      this.p[k] += this.v[k] * dt;
      this.p[k + 1] += this.v[k + 1] * dt;
      this.p[k + 2] += this.v[k + 2] * dt;
      this.rot[i] += this.spin[i] * dt;
    }
    const n = this.count;
    // Smoke is sorted back to front; glow is additive and needs no order
    const sort = !this.glow;
    if (sort && n > 1) {
      const p = this.p;
      const keys = this.keys;
      const order = this.order;
      const ex = eye.x;
      const ey = eye.y;
      const ez = eye.z;
      for (let i = 0; i < n; i++) {
        order[i] = i;
        const k = i * 3;
        const dx = p[k] - ex;
        const dy = p[k + 1] - ey;
        const dz = p[k + 2] - ez;
        keys[i] = dx * dx + dy * dy + dz * dz;
      }
      sortIndicesDesc(order, keys, n);
    }
    const pos = this.iPos.array as Float32Array;
    const col = this.iColor.array as Float32Array;
    const sr = this.iSizeRot.array as Float32Array;
    for (let o = 0; o < n; o++) {
      const i = sort && n > 1 ? this.order[o] : o;
      const t = this.age[i] / this.life[i];
      const fi = this.fadeIn[i];
      const env = fi > 0 ? Math.min(1, t / fi) : 1;
      const fade = this.glow ? (1 - t) * (1 - t * 0.5) : 1 - t * t * (3 - 2 * t);
      const i3 = i * 3;
      const o3 = o * 3;
      const o4 = o * 4;
      pos[o3] = this.p[i3];
      pos[o3 + 1] = this.p[i3 + 1];
      pos[o3 + 2] = this.p[i3 + 2];
      col[o4] = this.c0[i3] + (this.c1[i3] - this.c0[i3]) * t;
      col[o4 + 1] = this.c0[i3 + 1] + (this.c1[i3 + 1] - this.c0[i3 + 1]) * t;
      col[o4 + 2] = this.c0[i3 + 2] + (this.c1[i3 + 2] - this.c0[i3 + 2]) * t;
      col[o4 + 3] = this.alpha[i] * env * fade;
      // Growth eases out (puffs bloom fast then hang)
      const omt = 1 - t;
      sr[o * 2] = Math.max(0.01, this.size[i] + this.grow[i] * (1 - omt * omt) * this.life[i]);
      sr[o * 2 + 1] = this.rot[i];
    }
    this.geo.instanceCount = n;
    // (only the live ones: the whole pool is 5000 a side)
    for (const attr of [this.iPos, this.iColor, this.iSizeRot]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * attr.itemSize);
      attr.needsUpdate = true;
    }
    this.mesh.visible = n > 0;
  }
}

export interface EmitOptions {
  /** Size multiplier. */
  scale?: number;
  /** Life multiplier. */
  life?: number;
  /** Override colour (start). */
  color?: THREE.Color;
  /** Override colour (end). */
  end?: THREE.Color;
  alpha?: number;
}

export class Particles {
  readonly group = new THREE.Group();
  private readonly glow: Pool;
  private readonly smoke: Pool;
  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly _v = new THREE.Vector3();

  constructor(atmosphere: Record<string, THREE.IUniform>, maxPerPool = 5000) {
    this.uniforms = {
      ...atmosphere,
      uSunView: { value: new THREE.Vector3(0, 1, 0) },
      uSunCol: { value: new THREE.Color(1.6, 1.25, 0.9) },
      uAmb: { value: new THREE.Color(0.32, 0.36, 0.44) },
    };
    this.glow = new Pool(maxPerPool, true, this.uniforms);
    this.smoke = new Pool(maxPerPool, false, this.uniforms);
    this.group.add(this.smoke.mesh, this.glow.mesh);
    this.group.name = 'particles';
  }

  emit(kind: ParticleKind, at: THREE.Vector3, vel?: THREE.Vector3, opts: EmitOptions = {}): void {
    const pr = PRESETS[kind];
    const pool = pr.glow ? this.glow : this.smoke;
    const i = pool.spawn();
    const r = (a: [number, number]) => a[0] + Math.random() * (a[1] - a[0]);
    const k = i * 3;
    pool.p[k] = at.x;
    pool.p[k + 1] = at.y;
    pool.p[k + 2] = at.z;
    pool.v[k] = vel?.x ?? 0;
    pool.v[k + 1] = vel?.y ?? 0;
    pool.v[k + 2] = vel?.z ?? 0;
    pool.age[i] = 0;
    pool.life[i] = r(pr.life) * (opts.life ?? 1);
    const scale = opts.scale ?? 1;
    pool.size[i] = r(pr.size) * scale;
    pool.grow[i] = pr.grow * scale * (0.8 + Math.random() * 0.4);
    pool.rot[i] = Math.random() * Math.PI * 2;
    pool.spin[i] = (Math.random() - 0.5) * 2 * pr.spin;
    const c = opts.color;
    const jitter = pr.glow ? 1 : 0.9 + Math.random() * 0.2;
    pool.c0[k] = (c ? c.r : pr.color[0]) * jitter;
    pool.c0[k + 1] = (c ? c.g : pr.color[1]) * jitter;
    pool.c0[k + 2] = (c ? c.b : pr.color[2]) * jitter;
    const e = pr.end ?? pr.color;
    const ec = opts.end;
    pool.c1[k] = (ec ? ec.r : e[0]) * jitter;
    pool.c1[k + 1] = (ec ? ec.g : e[1]) * jitter;
    pool.c1[k + 2] = (ec ? ec.b : e[2]) * jitter;
    pool.alpha[i] = pr.alpha * (opts.alpha ?? 1);
    pool.drag[i] = pr.drag;
    pool.lift[i] = pr.lift;
    pool.fadeIn[i] = pr.fadeIn;
  }

  /** Burst of `n` particles with random velocity of magnitude ~`speed` around `dir`. */
  burst(kind: ParticleKind, at: THREE.Vector3, n: number, speed: number, dir?: THREE.Vector3, spread = 1, opts?: EmitOptions): void {
    for (let i = 0; i < n; i++) {
      const v = this._v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
      if (v.lengthSq() > 1) v.normalize();
      v.multiplyScalar(spread);
      if (dir) v.add(dir);
      v.multiplyScalar(speed * (0.4 + Math.random() * 0.6));
      this.emit(kind, at, v, opts);
    }
  }

  update(dt: number, camera: THREE.Camera): void {
    const sunView = this.uniforms.uSunView.value as THREE.Vector3;
    sunView.copy(this.uniforms.uSunDir.value as THREE.Vector3).transformDirection(camera.matrixWorldInverse);
    this.glow.update(dt, camera.position);
    this.smoke.update(dt, camera.position);
  }

  get live(): number {
    return this.glow.count + this.smoke.count;
  }
}
