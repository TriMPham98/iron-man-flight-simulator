import * as THREE from 'three';
import { sortIndicesDesc } from '../fx/particles';
import { withLogDepth } from '../render/depth';
import { RENDER_ORDER, sortFocus } from '../render/transparency';
import { ATMOSPHERE_GLSL } from './atmosphere';
import { WORLD_SIZE } from './config';

/**
 * Fair-weather cumulus drifting over the coast at 1.4–2.6 km: each cloud a
 * cluster of soft puffs with a flat base, lit as rounded volumes — sunlit
 * tops, blue-grey undersides, a silver lining when the sun is behind them —
 * and fading into the haze. Sorted back to front and drawn in two instanced
 * calls split at the suit's distance — the puffs beyond it before the jet
 * plumes, the puffs between it and the eye after them — so a cloud behind
 * the suit never paints over its thrust (render/transparency). The camera
 * can fly straight through: puffs thin out as you reach them and the frame
 * goes milky white inside.
 */

interface Puff {
  p: THREE.Vector3;
  r: number;
  seed: number;
  /** 0 = largest puff in its cloud, approaching 1 = smallest. */
  rank: number;
}

/** Rebuild sorted buffers once the camera turns past ~4° or moves past threshold. */
const REBUILD_TURN = Math.cos(THREE.MathUtils.degToRad(4));
const REBUILD_MOVE = 20;
const REBUILD_MOVE_INSIDE = 4;
const REBUILD_DRIFT = 16;
const THIN_DIST = 10000;
const FAR_THIN_DIST = 17000;
const MAX_CLOUD_DIST = 25000;

const VERT = /* glsl */ `
attribute vec4 iPuff; // xyz, radius
attribute float iSeed;
varying vec2 vUv;
varying float vFade;
varying float vHaze;
varying vec3 vHazeCol;
varying vec3 vCenterDir;
varying float vSeed;
varying float vBaseK;
uniform float uBase;
${ATMOSPHERE_GLSL}
void main() {
  vUv = uv;
  vSeed = iSeed;
  vec3 c = iPuff.xyz;
  float r = iPuff.w;
  vec4 mv = viewMatrix * vec4(c, 1.0);
  float dist = length(mv.xyz);
  // Thin out as the eye reaches the puff (no hard cut flying through)
  vFade = smoothstep(r * 0.45, r * 1.4, dist);
  mv.xy += position.xy * r * 2.0;
  vHaze = hazeAmount(cameraPosition, c);
  vHazeCol = hazeColor(normalize(c - cameraPosition));
  vCenterDir = normalize(c - cameraPosition);
  // How far down the cloud this puff sits (bases are darker)
  vBaseK = clamp((c.y - uBase) / 700.0, 0.0, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uSunView;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uAmbTop;
uniform vec3 uAmbBottom;
varying vec2 vUv;
varying float vFade;
varying float vHaze;
varying vec3 vHazeCol;
varying vec3 vCenterDir;
varying float vSeed;
varying float vBaseK;
void main() {
  // Rotate the texture per puff
  float a = vSeed * 6.2831;
  float ca = cos(a);
  float sa = sin(a);
  vec2 uv = mat2(ca, -sa, sa, ca) * (vUv - 0.5) + 0.5;
  vec4 tex = texture2D(uMap, uv);
  float density = tex.a;
  if (density * vFade < 0.01) discard;
  vec2 p = vUv * 2.0 - 1.0;
  float z = sqrt(max(0.0, 1.0 - dot(p, p)));
  vec3 n = normalize(vec3(p, z * 0.9 + 0.1));
  // Wrapped Lambert + Beer-Lambert powder darkening in deep billows
  float sunDot = dot(n, uSunView);
  float lit = mix(0.6, clamp(sunDot * 0.6 + 0.5, 0.0, 1.0), 0.48);
  lit *= mix(0.5, 1.0, vBaseK) * (0.68 + 0.32 * tex.r);
  float powder = 1.0 - 0.32 * exp(-density * 3.5) * (1.0 - max(sunDot, 0.0));
  // Forward scattering: bright golden-silver rims when looking toward the sun
  float mu = dot(vCenterDir, uSunDir);
  float silver = pow(max(mu, 0.0), 6.0) * (1.0 - density * 0.68) * 2.4 + pow(max(mu, 0.0), 2.0) * 0.38;
  // Warm sky/ocean bounce subtle gradient on undersides vs cool zenith ambient
  vec3 amb = mix(uAmbBottom, uAmbTop, clamp(n.y * 0.5 + 0.5, 0.0, 1.0) * 0.6 + vBaseK * 0.4);
  amb += vec3(0.06, 0.045, 0.03) * (1.0 - vBaseK) * (0.5 + 0.5 * tex.g);
  vec3 col = amb * powder + uSunCol * (lit * 0.88 + silver);
  col = mix(col, vHazeCol, vHaze);
  gl_FragColor = vec4(col, density * vFade * 0.82);
}
`;

function puffTexture(): THREE.Texture {
  const n = 384;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d')!;
  const img = g.createImageData(n, n);
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  // Tileable value-noise octaves → billowy fbm with fine cumulus tufts
  const lattices = [4, 8, 16, 32, 64, 128].map((k) => ({ k, v: Float32Array.from({ length: k * k }, rnd) }));
  const noise = (u: number, v: number) => {
    let sum = 0;
    let amp = 0.5;
    for (const { k, v: lat } of lattices) {
      const x = u * k;
      const y = v * k;
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      const fx = x - xi;
      const fy = y - yi;
      const sx = fx * fx * (3 - 2 * fx);
      const sy = fy * fy * (3 - 2 * fy);
      const at = (i: number, j: number) => lat[(((j % k) + k) % k) * k + (((i % k) + k) % k)];
      const a = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * sx;
      const b = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * sx;
      sum += amp * (a + (b - a) * sy);
      amp *= 0.5;
    }
    return sum / 0.985;
  };
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n;
      const v = (y + 0.5) / n;
      const r = Math.hypot(u - 0.5, v - 0.5) * 2;
      // Billows: |noise| folded, eroding the edge of a soft disc
      const f = noise(u, v);
      const billow = 1 - Math.abs(f * 2 - 1);
      const body = Math.max(0, 1 - r * r) * (0.52 + 0.48 * billow);
      const a = Math.max(0, Math.min(1, (body - 0.17 * (1 - billow)) * 1.62));
      const i = (y * n + x) * 4;
      const occ = Math.round(255 * Math.min(1, 0.5 + 0.5 * billow));
      img.data[i] = occ;
      img.data[i + 1] = Math.round(255 * billow);
      img.data[i + 2] = occ;
      img.data[i + 3] = Math.round(a * a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

export class Clouds {
  /** Puffs beyond the suit (the near ones are its child, {@link nearMesh}). */
  readonly mesh: THREE.Mesh;
  readonly nearMesh: THREE.Mesh;
  private readonly puffs: Puff[] = [];
  private readonly farGeo: THREE.InstancedBufferGeometry;
  private readonly nearGeo: THREE.InstancedBufferGeometry;
  private readonly iPuff: THREE.InstancedBufferAttribute;
  private readonly iSeed: THREE.InstancedBufferAttribute;
  private readonly nearPuff: THREE.InstancedBufferAttribute;
  private readonly nearSeed: THREE.InstancedBufferAttribute;
  /** Drifted puff centres + radii, unsorted. */
  private readonly raw: Float32Array;
  private readonly order: Uint16Array;
  private readonly keys: Float32Array;
  private readonly frustum = new THREE.Frustum();
  private readonly _vp = new THREE.Matrix4();
  private readonly _c = new THREE.Vector3();
  private readonly uniforms: Record<string, THREE.IUniform>;
  /** Wind drift (m/s). */
  private readonly drift = new THREE.Vector3(3.5, 0, -1.5);
  private readonly offset = new THREE.Vector3();
  private readonly _dir = new THREE.Vector3();
  private readonly lastEye = new THREE.Vector3(Infinity, 0, 0);
  private readonly lastDir = new THREE.Vector3();
  private readonly lastOffset = new THREE.Vector3(Infinity, 0, 0);
  private lastFov = -1;
  private lastFocusValid = false;
  private lastFocusDist = 0;
  private lastInside = 0;
  private lodScale = 1;
  private dirty = true;

  constructor(atmosphere: Record<string, THREE.IUniform>) {
    let s = 4242;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const BASE = 1400;
    for (let c = 0; c < 70; c++) {
      const cx = (rnd() - 0.5) * WORLD_SIZE * 1.1;
      const cz = (rnd() - 0.5) * WORLD_SIZE * 1.1;
      const base = BASE + rnd() * 600;
      const size = 350 + rnd() * 700;
      const n = 14 + Math.floor(rnd() * 18);
      const cluster: Array<{ p: THREE.Vector3; r: number; seed: number }> = [];
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2;
        const r = Math.sqrt(rnd()) * size;
        const up = rnd() * rnd() * size * 0.7;
        const rad = (0.25 + rnd() * 0.35) * size * (1 - (r / size) * 0.4);
        cluster.push({ p: new THREE.Vector3(cx + Math.cos(a) * r, base + up + rad * 0.35, cz + Math.sin(a) * r * 0.7), r: rad, seed: rnd() });
      }
      cluster.sort((a, b) => b.r - a.r);
      for (let i = 0; i < cluster.length; i++) {
        this.puffs.push({ ...cluster[i], rank: i / cluster.length });
      }
    }
    const N = this.puffs.length;
    const quad = new THREE.PlaneGeometry(1, 1);
    const makeGeo = () => {
      const geo = new THREE.InstancedBufferGeometry();
      geo.index = quad.index;
      geo.setAttribute('position', quad.getAttribute('position'));
      geo.setAttribute('uv', quad.getAttribute('uv'));
      const puff = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4).setUsage(THREE.DynamicDrawUsage);
      const seed = new THREE.InstancedBufferAttribute(new Float32Array(N), 1).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('iPuff', puff);
      geo.setAttribute('iSeed', seed);
      geo.instanceCount = 0;
      return { geo, puff, seed };
    };
    const far = makeGeo();
    const near = makeGeo();
    this.farGeo = far.geo;
    this.nearGeo = near.geo;
    this.iPuff = far.puff;
    this.iSeed = far.seed;
    this.nearPuff = near.puff;
    this.nearSeed = near.seed;
    this.raw = new Float32Array(N * 4);
    this.order = new Uint16Array(N);
    this.keys = new Float32Array(N);
    this.uniforms = {
      ...atmosphere,
      uMap: { value: puffTexture() },
      uSunView: { value: new THREE.Vector3() },
      uSunCol: { value: new THREE.Color(1.55, 1.2, 0.86) },
      uAmbTop: { value: new THREE.Color(0.42, 0.5, 0.64) },
      uAmbBottom: { value: new THREE.Color(0.2, 0.22, 0.3) },
      uBase: { value: BASE },
    };
    const mat = withLogDepth(
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.mesh = new THREE.Mesh(this.farGeo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = RENDER_ORDER.cloudsFar;
    this.mesh.name = 'clouds';
    // Same material, drawn after the plumes (a child: world adds only `mesh`)
    this.nearMesh = new THREE.Mesh(this.nearGeo, mat);
    this.nearMesh.frustumCulled = false;
    this.nearMesh.renderOrder = RENDER_ORDER.cloudsNear;
    this.nearMesh.name = 'clouds-near';
    this.mesh.add(this.nearMesh);
  }

  /** Scale thinning/cull distances (0.35–2.0). */
  setLodScale(scale: number): void {
    const next = THREE.MathUtils.clamp(scale, 0.35, 2);
    if (Math.abs(next - this.lodScale) > 1e-3) {
      this.lodScale = next;
      this.dirty = true;
    }
  }

  /** 0–1: how deep inside a cloud the eye is (post white-out). */
  update(dt: number, camera: THREE.Camera): number {
    this.offset.addScaledVector(this.drift, dt);
    const eye = camera.position;
    const sv = this.uniforms.uSunView.value as THREE.Vector3;
    sv.copy(this.uniforms.uSunDir.value as THREE.Vector3).transformDirection(camera.matrixWorldInverse);
    camera.getWorldDirection(this._dir);
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 0;
    const focusValid = sortFocus.valid;
    const f = focusValid ? sortFocus.point.distanceToSquared(eye) : 0;
    const focusDist = focusValid ? Math.sqrt(f) : 0;
    const moveThresh = this.lastInside > 0 ? REBUILD_MOVE_INSIDE : REBUILD_MOVE;
    if (
      !this.dirty &&
      eye.distanceToSquared(this.lastEye) < moveThresh * moveThresh &&
      this.offset.distanceToSquared(this.lastOffset) < REBUILD_DRIFT * REBUILD_DRIFT &&
      this._dir.dot(this.lastDir) > REBUILD_TURN &&
      fov === this.lastFov &&
      focusValid === this.lastFocusValid &&
      Math.abs(focusDist - this.lastFocusDist) < 4
    ) {
      return this.lastInside;
    }
    this.dirty = false;
    this.lastEye.copy(eye);
    this.lastDir.copy(this._dir);
    this.lastOffset.copy(this.offset);
    this.lastFov = fov;
    this.lastFocusValid = focusValid;
    this.lastFocusDist = focusDist;

    this._vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this._vp);
    const planes = this.frustum.planes;
    let inside = 0;
    let vis = 0;
    const N = this.puffs.length;
    const half = WORLD_SIZE * 0.6;
    const span = 2 * half;
    const ox = this.offset.x;
    const oz = this.offset.z;
    const ex = eye.x;
    const ey = eye.y;
    const ez = eye.z;
    const thinDist2 = (THIN_DIST * this.lodScale) ** 2;
    const farThinDist2 = (FAR_THIN_DIST * this.lodScale) ** 2;
    const maxDist2 = (MAX_CLOUD_DIST * this.lodScale) ** 2;
    for (let i = 0; i < N; i++) {
      const p = this.puffs[i];
      // Drift with the wind, wrapping round the map
      let x = p.p.x + ox;
      let z = p.p.z + oz;
      x = ((((x + half) % span) + span) % span) - half;
      z = ((((z + half) % span) + span) % span) - half;
      const py = p.p.y;
      const pr = p.r;
      const dx = x - ex;
      const dy = py - ey;
      const dz = z - ez;
      const d2 = dx * dx + dy * dy + dz * dz;
      const insideR = pr * 0.8;
      if (d2 < insideR * insideR) inside = Math.max(inside, 1 - Math.sqrt(d2) / insideR);
      if (d2 > maxDist2) continue;
      // Beyond ~10 km drop smaller puffs and scale remaining puffs slightly to preserve silhouettes
      let effR = pr;
      if (d2 > farThinDist2) {
        if (p.rank > 0.3) continue;
        effR *= 1.32;
      } else if (d2 > thinDist2) {
        if (p.rank > 0.55) continue;
        effR *= 1.18;
      }
      this.raw[i * 4] = x;
      this.raw[i * 4 + 1] = py;
      this.raw[i * 4 + 2] = z;
      this.raw[i * 4 + 3] = effR;
      // Frustum cull billboarded puffs with margin so skipped small turns don't clip screen edges
      const rad = effR * 1.45 + Math.sqrt(d2) * 0.08 + 20;
      this._c.set(x, py, z);
      let culled = false;
      for (let k = 0; k < 5; k++) {
        if (planes[k].distanceToPoint(this._c) < -rad) {
          culled = true;
          break;
        }
      }
      if (culled) continue;
      this.keys[i] = d2;
      this.order[vis++] = i;
    }
    // Back to front, split at the suit: [far … | … near]
    sortIndicesDesc(this.order, this.keys, vis);
    let split = vis;
    if (focusValid) {
      split = 0;
      while (split < vis && this.keys[this.order[split]] >= f) split++;
    }
    const fp = this.iPuff.array as Float32Array;
    const fs = this.iSeed.array as Float32Array;
    const np = this.nearPuff.array as Float32Array;
    const ns = this.nearSeed.array as Float32Array;
    const raw = this.raw;
    for (let o = 0; o < vis; o++) {
      const i = this.order[o];
      const i4 = i * 4;
      if (o >= split) {
        const k = o - split;
        const k4 = k * 4;
        np[k4] = raw[i4];
        np[k4 + 1] = raw[i4 + 1];
        np[k4 + 2] = raw[i4 + 2];
        np[k4 + 3] = raw[i4 + 3];
        ns[k] = this.puffs[i].seed;
      } else {
        const k4 = o * 4;
        fp[k4] = raw[i4];
        fp[k4 + 1] = raw[i4 + 1];
        fp[k4 + 2] = raw[i4 + 2];
        fp[k4 + 3] = raw[i4 + 3];
        fs[o] = this.puffs[i].seed;
      }
    }
    const nearCount = vis - split;
    this.farGeo.instanceCount = split;
    this.nearGeo.instanceCount = nearCount;
    this.mesh.visible = split > 0;
    this.nearMesh.visible = nearCount > 0;
    if (split > 0) {
      this.iPuff.clearUpdateRanges();
      this.iPuff.addUpdateRange(0, split * 4);
      this.iPuff.needsUpdate = true;
      this.iSeed.clearUpdateRanges();
      this.iSeed.addUpdateRange(0, split);
      this.iSeed.needsUpdate = true;
    }
    if (nearCount > 0) {
      this.nearPuff.clearUpdateRanges();
      this.nearPuff.addUpdateRange(0, nearCount * 4);
      this.nearPuff.needsUpdate = true;
      this.nearSeed.clearUpdateRanges();
      this.nearSeed.addUpdateRange(0, nearCount);
      this.nearSeed.needsUpdate = true;
    }
    this.lastInside = Math.min(1, inside * 1.6);
    return this.lastInside;
  }

}
