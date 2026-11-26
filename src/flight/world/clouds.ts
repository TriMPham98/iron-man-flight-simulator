import * as THREE from 'three';
import { withLogDepth } from '../render/depth';
import { RENDER_ORDER, sortFocus } from '../render/transparency';
import { ATMOSPHERE_GLSL } from './atmosphere';
import { ACTIVE_LIGHTING, WORLD_SIZE } from './config';

/**
 * Storm-lit coastal cumulus drifting over the Pacific at 1.4–2.6 km:
 * dark silver-blue cloud volumes lit by moonlight on their rims, flashing
 * internally with periodic storm lightning discharges, and imparting
 * turbulent buffeting + electrical strike hazards to suits flying inside
 * dense cloud cover.
 */

interface Puff {
  p: THREE.Vector3;
  r: number;
  seed: number;
}

export interface CloudTurbulence {
  vector: THREE.Vector3;
  intensity: number;
}

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
varying float vFlash;
uniform float uBase;
uniform vec3 uLightningOrigin;
uniform float uLightningIntensity;
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
  float lDist = length(c - uLightningOrigin);
  vFlash = uLightningIntensity * (0.12 + 0.88 * exp(-lDist / 1600.0));
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
varying float vFlash;
void main() {
  // Rotate the texture per puff
  float a = vSeed * 6.2831;
  vec2 uv = mat2(cos(a), -sin(a), sin(a), cos(a)) * (vUv - 0.5) + 0.5;
  vec4 tex = texture2D(uMap, uv);
  float density = tex.a;
  if (density * vFade < 0.01) discard;
  vec2 p = vUv * 2.0 - 1.0;
  float z = sqrt(max(0.0, 1.0 - dot(p, p)));
  vec3 n = normalize(vec3(p, z * 0.9 + 0.1));
  float lit = mix(0.62, clamp(dot(n, uSunView) * 0.6 + 0.5, 0.0, 1.0), 0.45);
  lit *= mix(0.55, 1.0, vBaseK) * (0.75 + 0.25 * tex.r);
  // Forward scattering: silver-blue rims looking toward the moon
  float mu = dot(vCenterDir, uSunDir);
  float silver = pow(max(mu, 0.0), 6.0) * (1.0 - density * 0.7) * 2.2 + pow(max(mu, 0.0), 2.0) * 0.35;
  vec3 amb = mix(uAmbBottom, uAmbTop, clamp(n.y * 0.5 + 0.5, 0.0, 1.0) * 0.6 + vBaseK * 0.4);
  vec3 col = amb + uSunCol * (lit * 0.85 + silver);
  // Storm lightning internal scattering
  vec3 boltCol = vec3(0.75, 0.9, 1.45);
  col += boltCol * vFlash * (0.6 + 0.5 * (1.0 - density * 0.55)) * 2.6;
  col = mix(col, vHazeCol, vHaze);
  gl_FragColor = vec4(col, density * vFade * 0.82);
}
`;

function puffTexture(): THREE.Texture {
  if (typeof document === 'undefined') {
    const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
    tex.needsUpdate = true;
    return tex;
  }
  const n = 256;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d')!;
  const img = g.createImageData(n, n);
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  // Tileable value-noise octaves → billowy fbm
  const lattices = [4, 8, 16, 32, 64].map((k) => ({ k, v: Float32Array.from({ length: k * k }, rnd) }));
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
    return sum / 0.97;
  };
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n;
      const v = (y + 0.5) / n;
      const r = Math.hypot(u - 0.5, v - 0.5) * 2;
      // Billows: |noise| folded, eroding the edge of a soft disc
      const f = noise(u, v);
      const billow = 1 - Math.abs(f * 2 - 1);
      const body = Math.max(0, 1 - r * r) * (0.55 + 0.45 * billow);
      const a = Math.max(0, Math.min(1, (body - 0.18 * (1 - billow)) * 1.6));
      const i = (y * n + x) * 4;
      img.data[i] = Math.round(255 * Math.min(1, 0.55 + 0.45 * billow));
      img.data[i + 1] = img.data[i + 2] = img.data[i];
      img.data[i + 3] = Math.round(a * a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

const BOLT_SEGMENTS = 14;

export class Clouds {
  /** Puffs beyond the suit (the near ones are its child, {@link nearMesh}). */
  readonly mesh: THREE.Mesh;
  readonly nearMesh: THREE.Mesh;
  private readonly boltLine: THREE.LineSegments;
  private readonly boltMat: THREE.LineBasicMaterial;
  private readonly boltPos: Float32Array;
  private readonly puffs: Puff[] = [];
  private readonly farGeo: THREE.InstancedBufferGeometry;
  private readonly nearGeo: THREE.InstancedBufferGeometry;
  private readonly iPuff: THREE.InstancedBufferAttribute;
  private readonly iSeed: THREE.InstancedBufferAttribute;
  private readonly nearPuff: THREE.InstancedBufferAttribute;
  private readonly nearSeed: THREE.InstancedBufferAttribute;
  /** Drifted puff centres + radii, unsorted. */
  private readonly raw: Float32Array;
  private readonly order: number[];
  private readonly keys: Float32Array;
  private readonly uniforms: Record<string, THREE.IUniform>;
  /** Wind drift (m/s). */
  private readonly drift = new THREE.Vector3(3.5, 0, -1.5);
  private readonly offset = new THREE.Vector3();

  private time = 0;
  private stormSeed = 9187;
  private nextStrikeSec = 2.6;
  private strikeAge = 10;
  private _lightningIntensity = 0;
  private strikeConsumed = false;
  private readonly _lightningOrigin = new THREE.Vector3();
  private readonly lastEye = new THREE.Vector3();

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
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2;
        const r = Math.sqrt(rnd()) * size;
        const up = rnd() * rnd() * size * 0.7;
        const rad = (0.25 + rnd() * 0.35) * size * (1 - (r / size) * 0.4);
        this.puffs.push({ p: new THREE.Vector3(cx + Math.cos(a) * r, base + up + rad * 0.35, cz + Math.sin(a) * r * 0.7), r: rad, seed: rnd() });
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
    this.order = this.puffs.map((_, i) => i);
    this.keys = new Float32Array(N);
    this.syncRawPositions();

    const night = ACTIVE_LIGHTING.night;
    this.uniforms = {
      ...atmosphere,
      uMap: { value: puffTexture() },
      uSunView: { value: new THREE.Vector3() },
      uSunCol: { value: night ? new THREE.Color(0.36, 0.48, 0.72) : new THREE.Color(1.55, 1.2, 0.86) },
      uAmbTop: { value: night ? new THREE.Color(0.09, 0.13, 0.22) : new THREE.Color(0.42, 0.5, 0.64) },
      uAmbBottom: { value: night ? new THREE.Color(0.03, 0.045, 0.085) : new THREE.Color(0.2, 0.22, 0.3) },
      uBase: { value: BASE },
      uLightningOrigin: { value: this._lightningOrigin },
      uLightningIntensity: { value: 0 },
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

    // Jagged lightning discharge arc rendered inside flashing storm cells
    this.boltPos = new Float32Array(BOLT_SEGMENTS * 2 * 3);
    const boltGeo = new THREE.BufferGeometry();
    const boltAttr = new THREE.BufferAttribute(this.boltPos, 3).setUsage(THREE.DynamicDrawUsage);
    boltGeo.setAttribute('position', boltAttr);
    this.boltMat = new THREE.LineBasicMaterial({
      color: new THREE.Color(1.6, 2.0, 3.2),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.boltLine = new THREE.LineSegments(boltGeo, this.boltMat);
    this.boltLine.frustumCulled = false;
    this.boltLine.visible = false;
    this.boltLine.renderOrder = RENDER_ORDER.cloudsFar;
    this.mesh.add(this.boltLine);
  }

  /** Current storm lightning flash intensity (0–1). */
  get lightningIntensity(): number {
    return this._lightningIntensity;
  }

  /** World position of the active storm flash origin. */
  get lightningOrigin(): THREE.Vector3 {
    return this._lightningOrigin;
  }

  private nextRand(): number {
    this.stormSeed = (this.stormSeed * 16807) % 2147483647;
    return this.stormSeed / 2147483647;
  }

  private syncRawPositions(): void {
    const N = this.puffs.length;
    const half = WORLD_SIZE * 0.6;
    for (let i = 0; i < N; i++) {
      const p = this.puffs[i];
      let x = p.p.x + this.offset.x;
      let z = p.p.z + this.offset.z;
      x = ((((x + half) % (2 * half)) + 2 * half) % (2 * half)) - half;
      z = ((((z + half) % (2 * half)) + 2 * half) % (2 * half)) - half;
      this.raw[i * 4] = x;
      this.raw[i * 4 + 1] = p.p.y;
      this.raw[i * 4 + 2] = z;
      this.raw[i * 4 + 3] = p.r;
    }
  }

  /** Trigger a cloud lightning flash immediately (optionally at a specific world origin). */
  triggerLightning(origin?: THREE.Vector3): void {
    if (origin) {
      this._lightningOrigin.copy(origin);
    } else {
      // Pick a puff reasonably close to the eye so flashes are visible overhead
      const N = this.puffs.length;
      const candidates: number[] = [];
      for (let i = 0; i < N; i++) {
        const dx = this.raw[i * 4] - this.lastEye.x;
        const dz = this.raw[i * 4 + 2] - this.lastEye.z;
        if (dx * dx + dz * dz < 8500 * 8500) candidates.push(i);
      }
      const idx = candidates.length > 0 ? candidates[Math.floor(this.nextRand() * candidates.length)] : Math.floor(this.nextRand() * N);
      this._lightningOrigin.set(this.raw[idx * 4], this.raw[idx * 4 + 1], this.raw[idx * 4 + 2]);
    }
    this.strikeAge = 0;
    this.strikeConsumed = false;
    this._lightningIntensity = 1;
    this.uniforms.uLightningIntensity.value = 1;
    this.rebuildBoltGeometry();
  }

  private rebuildBoltGeometry(): void {
    const ox = this._lightningOrigin.x;
    const oy = this._lightningOrigin.y + 180;
    const oz = this._lightningOrigin.z;
    const mainSegs = 10;
    const totalDrop = 520;
    let px = ox;
    let py = oy;
    let pz = oz;
    let cursor = 0;
    const pushSeg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
      if (cursor + 6 > this.boltPos.length) return;
      this.boltPos[cursor++] = ax;
      this.boltPos[cursor++] = ay;
      this.boltPos[cursor++] = az;
      this.boltPos[cursor++] = bx;
      this.boltPos[cursor++] = by;
      this.boltPos[cursor++] = bz;
    };
    let branchStart: [number, number, number] | null = null;
    for (let i = 0; i < mainSegs; i++) {
      const nx = ox + (this.nextRand() - 0.5) * 260;
      const ny = oy - ((i + 1) / mainSegs) * totalDrop;
      const nz = oz + (this.nextRand() - 0.5) * 260;
      pushSeg(px, py, pz, nx, ny, nz);
      if (i === 3) branchStart = [nx, ny, nz];
      px = nx;
      py = ny;
      pz = nz;
    }
    if (branchStart) {
      let [bx, by, bz] = branchStart;
      const branchDirX = (this.nextRand() - 0.5) * 280;
      const branchDirZ = (this.nextRand() - 0.5) * 280;
      for (let i = 0; i < BOLT_SEGMENTS - mainSegs; i++) {
        const nx = bx + branchDirX * 0.35 + (this.nextRand() - 0.5) * 90;
        const ny = by - 75;
        const nz = bz + branchDirZ * 0.35 + (this.nextRand() - 0.5) * 90;
        pushSeg(bx, by, bz, nx, ny, nz);
        bx = nx;
        by = ny;
        bz = nz;
      }
    }
    while (cursor < this.boltPos.length) this.boltPos[cursor++] = 0;
    (this.boltLine.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** 0–1 cloud density at an arbitrary world position. */
  cloudDensityAt(pos: THREE.Vector3): number {
    let inside = 0;
    const N = this.puffs.length;
    for (let i = 0; i < N; i++) {
      const dx = this.raw[i * 4] - pos.x;
      const dy = this.raw[i * 4 + 1] - pos.y;
      const dz = this.raw[i * 4 + 2] - pos.z;
      const r = this.raw[i * 4 + 3] * 0.8;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < r * r) {
        inside = Math.max(inside, 1 - Math.sqrt(d2) / r);
      }
    }
    return Math.min(1, inside * 1.6);
  }

  /**
   * Returns true once per storm flash when the suit at `pos` is inside dense
   * cloud cover (`inCloud > 0.25`) during an active lightning discharge.
   */
  consumeLightningStrike(pos: THREE.Vector3, inCloudHint?: number): boolean {
    if (this.strikeConsumed || this._lightningIntensity <= 0.25) return false;
    const density = Math.max(inCloudHint ?? 0, this.cloudDensityAt(pos));
    if (density <= 0.25) return false;
    this.strikeConsumed = true;
    return true;
  }

  /**
   * Computes smooth cloud turbulence vector and normalized intensity (0–1)
   * at `pos` for flight buffeting inside storm clouds.
   */
  turbulence(pos: THREE.Vector3, inCloudHint?: number, out = new THREE.Vector3()): CloudTurbulence {
    const density = Math.max(inCloudHint ?? 0, this.cloudDensityAt(pos));
    if (density <= 0.01) {
      out.set(0, 0, 0);
      return { vector: out, intensity: 0 };
    }
    const stormBoost = 1 + this._lightningIntensity * 0.85;
    const intensity = Math.min(1, density * stormBoost);
    const t = this.time;
    const gx = Math.sin(t * 5.3 + pos.x * 0.017 + pos.z * 0.011) * 0.65 + Math.cos(t * 11.7 + pos.y * 0.023) * 0.35;
    const gy = Math.cos(t * 4.7 + pos.z * 0.019 - pos.x * 0.013) * 0.7 + Math.sin(t * 9.9 + pos.y * 0.031) * 0.3;
    const gz = Math.sin(t * 6.1 - pos.x * 0.015 + pos.z * 0.021) * 0.65 + Math.cos(t * 10.3 + pos.y * 0.019) * 0.35;
    out.set(gx, gy, gz).multiplyScalar(intensity);
    return { vector: out, intensity };
  }

  private stepStorm(dt: number): void {
    this.time += dt;
    this.nextStrikeSec -= dt;
    if (this.nextStrikeSec <= 0) {
      this.nextStrikeSec = 3.2 + this.nextRand() * 5.2;
      this.triggerLightning();
    }
    this.strikeAge += dt;
    // Double-pulse cloud-to-cloud flicker envelope over ~0.48 s
    let flash = 0;
    if (this.strikeAge < 0.55) {
      const p1 = Math.exp(-this.strikeAge * 14);
      const p2 = this.strikeAge > 0.11 ? Math.exp(-(this.strikeAge - 0.11) * 11) * 0.85 : 0;
      const p3 = this.strikeAge > 0.24 ? Math.exp(-(this.strikeAge - 0.24) * 15) * 0.45 : 0;
      flash = Math.min(1, p1 + p2 + p3);
    }
    this._lightningIntensity = flash;
    this.uniforms.uLightningIntensity.value = flash;
    this.boltLine.visible = flash > 0.22;
    if (this.boltLine.visible) this.boltMat.opacity = Math.min(1, (flash - 0.2) * 1.4);
  }

  /** 0–1: how deep inside a cloud the eye is (post white-out). */
  update(dt: number, camera: THREE.Camera): number {
    this.offset.addScaledVector(this.drift, dt);
    const eye = camera.position;
    this.lastEye.copy(eye);
    const sv = this.uniforms.uSunView.value as THREE.Vector3;
    sv.copy(this.uniforms.uSunDir.value as THREE.Vector3).transformDirection(camera.matrixWorldInverse);
    this.syncRawPositions();
    this.stepStorm(dt);

    let inside = 0;
    const N = this.puffs.length;
    for (let i = 0; i < N; i++) {
      const dx = this.raw[i * 4] - eye.x;
      const dy = this.raw[i * 4 + 1] - eye.y;
      const dz = this.raw[i * 4 + 2] - eye.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      this.keys[i] = d2;
      const r = this.raw[i * 4 + 3] * 0.8;
      if (d2 < r * r) inside = Math.max(inside, 1 - Math.sqrt(d2) / r);
    }
    // Back to front, split at the suit: [far … | … near]
    this.order.sort((a, b) => this.keys[b] - this.keys[a]);
    const f = sortFocus.valid ? sortFocus.point.distanceToSquared(eye) : 0;
    let split = N;
    if (sortFocus.valid) {
      split = 0;
      while (split < N && this.keys[this.order[split]] >= f) split++;
    }
    const fp = this.iPuff.array as Float32Array;
    const fs = this.iSeed.array as Float32Array;
    const np = this.nearPuff.array as Float32Array;
    const ns = this.nearSeed.array as Float32Array;
    for (let o = 0; o < N; o++) {
      const i = this.order[o];
      const near = o >= split;
      const k = near ? o - split : o;
      (near ? np : fp).set(this.raw.subarray(i * 4, i * 4 + 4), k * 4);
      (near ? ns : fs)[k] = this.puffs[i].seed;
    }
    this.farGeo.instanceCount = split;
    this.nearGeo.instanceCount = N - split;
    this.mesh.visible = true;
    this.nearMesh.visible = split < N;
    this.iPuff.needsUpdate = this.iSeed.needsUpdate = true;
    if (split < N) this.nearPuff.needsUpdate = this.nearSeed.needsUpdate = true;
    return Math.min(1, inside * 1.6);
  }
}
