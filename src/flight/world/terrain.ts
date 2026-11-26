import * as THREE from 'three';
import { ATMOSPHERE_GLSL } from './atmosphere';
import { HEIGHT_RES, TERRAIN_PITCH, TEXEL, WORLD_SIZE } from './config';
import { TERRAIN_SAMPLE_GLSL, type Heightfield } from './heightfield';

/**
 * Continuous-distance LOD terrain (CDLOD, Strugar 2010). A quadtree over the
 * world picks patches each frame by distance to the eye: 4 m between
 * vertices underfoot, coarsening by octaves out to the horizon. Every patch
 * is the same small grid drawn instanced in one call; near the outer edge of
 * its range each patch morphs its odd vertices onto the next coarser grid,
 * so LOD bands meet without cracks or popping.
 */

/** Cells per full patch side. */
const CELLS = 32;
/** Leaf (finest) node size in metres. */
const LEAF = CELLS * TERRAIN_PITCH;
const LEVELS = Math.round(Math.log2(WORLD_SIZE / LEAF)) + 1;
/** LOD 0 reaches this far (m); each coarser level doubles it. */
const RANGE0 = 270;
const MAX_PATCHES = 2048;

interface Node {
  x: number;
  z: number;
  size: number;
  level: number;
  minY: number;
  maxY: number;
  children: Node[] | null;
}

function patchGeometry(cells: number): THREE.InstancedBufferGeometry {
  const geo = new THREE.InstancedBufferGeometry();
  const n = cells + 1;
  const pos = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      // Grid indices (the shader scales them by the patch spacing)
      pos.set([i, 0, j], (j * n + i) * 3);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      // Alternate the diagonal so slopes don't comb in one direction
      if ((i + j) % 2 === 0) idx.push(a, c, b, b, c, d);
      else idx.push(a, c, d, a, d, b);
    }
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  // Lighting reads the per-pixel terrain normal; this only keeps three happy
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * n * 3).fill(0).map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
  geo.setIndex(idx);
  const inst = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PATCHES * 4), 4);
  inst.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aPatch', inst);
  geo.instanceCount = 0;
  return geo;
}

const VERT_PARS = /* glsl */ `
attribute vec4 aPatch; // x0, z0, spacing (m per cell), lod
uniform vec3 uEye;
uniform float uRange0;
varying vec3 vTerrainPos;
varying float vMorph;
varying vec3 vMacro;
${TERRAIN_SAMPLE_GLSL}
// The broad cover tones (scales of 430 m and up) per vertex rather than per
// pixel, prefiltered to the patch's vertex pitch: three texture reads off
// every terrain pixel
float macroTone(vec2 xz, float scale, float spacing) {
  float lod = max(0.0, log2(spacing * 256.0 / scale));
  return textureLod(uDetail, xz / scale, lod).r * 0.5 + 0.5;
}
`;

const VERT_BODY = /* glsl */ `
  vec2 grid = position.xz;
  float spacing = aPatch.z;
  vec2 world = aPatch.xy + grid * spacing;
  float h0 = terrainHeight(world);
  float range = uRange0 * exp2(aPatch.w);
  float dist = distance(vec3(world.x, h0, world.y), uEye);
  float morph = aPatch.w >= ${LEVELS - 1}.0 ? 0.0 : clamp((dist - range * 0.72) / (range * 0.26), 0.0, 1.0);
  // Odd vertices slide onto their even neighbour: the coarser grid.
  // Ring 1 performs a two-stage 4x morph so its 8 m grid meets ring 2's 32 m grid seamlessly.
  vec2 odd = fract(grid * 0.5) * 2.0;
  if (abs(aPatch.w - 1.0) < 0.5) {
    float m1 = clamp(morph * 2.0, 0.0, 1.0);
    float m2 = clamp(morph * 2.0 - 1.0, 0.0, 1.0);
    vec2 g1 = grid - odd * m1;
    vec2 g2 = g1 - fract(g1 * 0.25) * 4.0 * m2;
    world = aPatch.xy + g2 * spacing;
  } else {
    world -= odd * morph * spacing;
  }
  vMorph = morph;
  // Most vertices don't morph: skip the second height lookup for them
  float h = morph > 0.0 ? terrainHeight(world) : h0;
  vTerrainPos = vec3(world.x, h, world.y);
  vMacro = vec3(macroTone(world, 2900.0, spacing), macroTone(world + 517.0, 1130.0, spacing), macroTone(world - 211.0, 430.0, spacing));
  vec3 transformed = vTerrainPos;
`;

const FRAG_PARS = /* glsl */ `
varying vec3 vTerrainPos;
varying float vMorph;
varying vec3 vMacro;
uniform float uTexel;
uniform float uTime;
uniform float uDetailReach;
uniform sampler2D uPlantShade;
uniform vec4 uShadeBox; // centre x, centre z, 1 / span
${TERRAIN_SAMPLE_GLSL}
${ATMOSPHERE_GLSL}
float tSunVis;
float tAo;
float tWet;
float tRough;
// Detail texture as a 0–1 tone at a scale (m)
float tone(vec2 xz, float scale) { return texture2D(uDetail, xz / scale).r * 0.5 + 0.5; }
`;

const ALBEDO = /* glsl */ `
  vec2 xz = vTerrainPos.xz;
  float hgt = vTerrainPos.y;
  float slopeDetail;
  vec3 wN = terrainNormal(xz, hgt, slopeDetail);
  float viewD = length(vTerrainPos - cameraPosition);
  // Close-up detail (grain, micro relief, triplanar cliffs) fades out with
  // distance and is skipped outright beyond it: far pixels stay cheap.
  // Clamp reach so ultra presets keep crisp detail without pushing extra taps past mid-range.
  float reach = min(uDetailReach, 1.35);
  float near = 1.0 - smoothstep(150.0 * reach, 900.0 * reach, viewD);
  float micro = 1.0 - smoothstep(30.0 * reach, 260.0 * reach, viewD);
  vec4 bake = texture2D(uBake, xz / uWorld + 0.5);
  tSunVis = bake.r;
  tAo = mix(0.55, 1.0, bake.g);
  // The plants' own shade (world/vegetation.ts): the sky they hide from
  // the ground under them and the shadows they throw down-sun
  if (uShadeBox.z > 0.0) {
    vec2 shadeUv = (xz - uShadeBox.xy) * uShadeBox.z;
    float shadeK = 1.0 - smoothstep(0.4, 0.5, max(abs(shadeUv.x), abs(shadeUv.y)));
    if (shadeK > 0.0) {
      vec2 plantShade = texture2D(uPlantShade, shadeUv + 0.5).rg * shadeK;
      tAo *= 1.0 - plantShade.r;
      tSunVis *= 1.0 - plantShade.g;
    }
  }

  float slope = 1.0 - wN.y;
  float m1 = vMacro.x;
  float m2 = vMacro.y;
  float m3 = vMacro.z;
  float mid = tone(xz, 160.0);
  float fine = 0.6;
  float grain = 0.6;
  if (near > 0.0) {
    fine = mix(0.6, tone(xz, 23.0), near);
    grain = mix(0.6, tone(xz, 6.1), near);
  }
  // Rock faces: the detail projected side-on as well (triplanar), so cliffs
  // carry grain and strata instead of streaks smeared down the slope
  float steep = smoothstep(0.3, 0.6, slope);
  vec3 tw = vec3(0.0, 1.0, 0.0);
  if (near > 0.0 && steep > 0.0 && viewD < 450.0) {
    tw = pow(abs(wN), vec3(4.0));
    tw /= tw.x + tw.y + tw.z;
    float gx = tw.x > 0.02 ? tone(vTerrainPos.zy, 6.1) : 0.6;
    float gz = tw.z > 0.02 ? tone(vTerrainPos.xy, 6.1) : 0.6;
    grain = mix(grain, mix(0.6, tw.x * gx + tw.z * gz + tw.y * grain, near), steep);
  }

  // Cover: warm golden grass on the open slopes, deep olive chaparral in broad
  // patches, silvery sage on the dry sun-facing (seaward) slopes, dark
  // oak woodland down the folds where the hills shelter it
  float scrubK = smoothstep(0.49, 0.63, m2 * 0.5 + m3 * 0.35 + mid * 0.15 + slope * 0.35);
  float oakK = smoothstep(0.82, 0.52, bake.g) * smoothstep(0.38, 0.16, slope) * (0.45 + 0.55 * m3);
  float dry = smoothstep(0.05, 0.6, wN.z * 3.0 + (mid - 0.5)) * (1.0 - oakK);
  vec3 grass = mix(vec3(0.42, 0.30, 0.12), vec3(0.62, 0.47, 0.20), m1 * 0.45 + m3 * 0.55) * (0.92 + 0.16 * fine);
  // Burnt-out patches and paler dry grass break the gold up
  grass = mix(grass, vec3(0.64, 0.53, 0.33), smoothstep(0.55, 0.75, mid + (fine - 0.5) * 0.4) * 0.5);
  grass = mix(grass, grass * vec3(0.76, 0.72, 0.64), smoothstep(0.62, 0.8, m2 + (grain - 0.5) * 0.3) * 0.6);
  vec3 scrub = mix(vec3(0.072, 0.095, 0.044), vec3(0.135, 0.155, 0.072), m1) * (0.82 + 0.36 * fine);
  vec3 sage = mix(vec3(0.15, 0.185, 0.135), vec3(0.23, 0.25, 0.19), m3) * (0.85 + 0.3 * fine);
  scrub = mix(scrub, sage, dry * 0.72);
  vec3 oak = vec3(0.045, 0.068, 0.032) * (0.8 + 0.4 * fine);
  vec3 veg = mix(grass, scrub, scrubK);
  veg = mix(veg, oak, oakK * 0.85);
  // Brush stipple close up: the cover is clumps, not paint
  veg *= mix(1.0, 0.74 + 0.52 * grain, near * (0.4 + 0.6 * scrubK));

  // Rock: grey-brown with crisp strata in the cliffs, lighter sandstone on the coast
  float strata = 0.5 + 0.5 * sin(hgt * 0.42 + mid * 9.0 + m1 * 14.0);
  float strataFine = 0.5 + 0.5 * sin(hgt * 1.15 + mid * 14.0 - m2 * 9.0);
  float strataBand = smoothstep(0.22, 0.82, strata * 0.68 + strataFine * 0.32);
  vec3 rock = mix(vec3(0.15, 0.135, 0.12), vec3(0.38, 0.32, 0.26), strataBand * 0.68 + grain * 0.32);
  rock = mix(rock, vec3(0.47, 0.38, 0.28), smoothstep(110.0, 20.0, hgt) * 0.75);
  // Crisp strata relief and dark seepage streaks down cliff faces (skipped on distant hazy ridges)
  if (steep > 0.0) {
    rock *= mix(1.0, 0.78 + 0.38 * strataBand, steep);
    float seepReach = 1.0 - smoothstep(1400.0, 2200.0, viewD);
    if (seepReach > 0.0) {
      rock *= 1.0 - 0.28 * smoothstep(0.55, 0.8, tone(vec2(xz.x * 3.0 + xz.y, hgt * 0.15), 90.0)) * steep * seepReach;
    }
  }
  // Higher up the range the cover thins to rock and dust
  veg = mix(veg, mix(rock, grass, 0.45), smoothstep(700.0, 1250.0, hgt + mid * 160.0));

  float rockK = smoothstep(0.32, 0.56, slope + (grain - 0.5) * 0.16 + slopeDetail * 0.12);
  vec3 col = mix(veg, rock, rockK);

  // The drive's verge: compacted gravel off the curb, then a cleared strip
  // of short dry grass before the cover closes in
  vec4 bed = roadBed(xz);
  if (bed.z < 30.0) {
    float d = bed.z + (grain - 0.5) * 0.9 + (fine - 0.5) * 1.4;
    vec3 gravel = mix(vec3(0.34, 0.3, 0.24), vec3(0.46, 0.4, 0.31), grain) * (0.9 + 0.2 * fine);
    col = mix(col, mix(grass, vec3(0.5, 0.43, 0.29), 0.45), smoothstep(11.0, 8.5, d) * 0.7);
    col = mix(col, gravel, smoothstep(6.4, 5.3, d));
  }

  // Beach, swash, splash zone and seafloor (only near sea level: skipped on hills/mountains)
  float beach = 0.0;
  tWet = 0.0;
  if (hgt < 8.0) {
    vec3 sand = mix(vec3(0.52, 0.43, 0.31), vec3(0.62, 0.53, 0.39), grain);
    beach = smoothstep(4.5 + mid * 3.0, 1.5, hgt) * (1.0 - smoothstep(0.25, 0.45, slope));
    col = mix(col, sand, beach);
    float swash = 0.35 + 0.25 * sin(uTime * 0.7 + xz.x * 0.03 + xz.y * 0.05);
    tWet = smoothstep(swash + 0.9, swash, hgt);
    col = mix(col, sand * 0.48, tWet);
    // Coastal wave-splash zone on low cliff faces & sea stacks
    float coastSplash = (1.0 - smoothstep(swash + 0.5, swash + 2.3, hgt)) * rockK;
    col *= mix(1.0, 0.54, coastSplash * 0.75);
    tWet = max(tWet, coastSplash * 0.7);
    // Sea floor: sand and weed, dimmed (the water shades it from above)
    col = mix(col, mix(vec3(0.32, 0.28, 0.2), vec3(0.08, 0.1, 0.06), mid), smoothstep(0.0, -3.0, hgt));
  }

  // Per-material roughness: sunlit sandstone/granite glints at grazing angles,
  // dry grass stays matte, wet coastal sand & splash zones turn glossy
  float vegRough = mix(0.95, 0.88, clamp(scrubK + oakK, 0.0, 1.0));
  float rockRough = mix(0.86, 0.62, strataBand * 0.65 + grain * 0.35);
  tRough = mix(vegRough, rockRough, rockK);
  tRough = mix(tRough, 0.78, beach);
  tRough = mix(tRough, 0.28, tWet);

  // Underfoot: two finer octaves of tone (clods, pebbles, dry litter) so
  // the ground still has grain at a few metres, not a flat wash. Fades in
  // only within the micro relief's reach, so it costs nothing further out
  float underfoot = 1.0 - smoothstep(20.0 * reach, 160.0 * reach, viewD);
  if (underfoot > 0.0) {
    float clod = tone(xz + 0.53, 3.1);
    float speck = tone(xz * 1.07 + 0.21, 1.1);
    float bit = tone(xz.yx * 0.93 + 0.67, 0.6);
    col *= mix(1.0, (0.72 + 0.56 * clod) * (0.8 + 0.4 * speck), underfoot * (1.0 - 0.6 * tWet));
    // Pale stones and dry litter scattered through the cover, dark gaps between
    float litter = smoothstep(0.66, 0.74, speck * 0.6 + bit * 0.4) * (1.0 - beach * 0.6);
    float gap = smoothstep(0.42, 0.26, speck * 0.5 + bit * 0.5);
    col = mix(col, col * vec3(1.6, 1.5, 1.3), litter * underfoot * 0.7);
    col *= 1.0 - gap * underfoot * 0.22;
  }

  // Mid-to-close normal relief: bridges the 71 m heightfield detail to the 6 m micro crags,
  // fading out cleanly in fixed world metres so far ridges skip extra gradient reads
  float midRelief = 1.0 - smoothstep(110.0, 520.0, viewD);
  if (midRelief > 0.0) {
    float ampMid = mix(mix(0.45, 0.2, beach), 1.25, rockK) * midRelief;
    vec2 gM = texture2D(uDetailGrad, xz / (uDetailSpan * 0.11) + 0.19).rg / 0.11;
    vec3 p = vec3(gM.x, 0.0, gM.y) * (0.105 * ampMid * tw.y);
    if (micro > 0.0) {
      float amp = mix(mix(0.55, 0.22, beach), 1.35, rockK) * micro;
      vec2 gA = texture2D(uDetailGrad, xz / (uDetailSpan * 0.032)).rg / 0.032;
      vec2 gB = texture2D(uDetailGrad, xz / (uDetailSpan * 0.011) + 0.37).rg / 0.011;
      vec2 gT = (gA * 0.05 + gB * 0.012) * amp;
      if (underfoot > 0.0) {
        // ...and the clods' own relief, a finer octave again
        vec2 gC = texture2D(uDetailGrad, xz / (uDetailSpan * 0.0035) + 0.71).rg / 0.0035;
        gT += gC * 0.0035 * amp * underfoot;
      }
      p += vec3(gT.x, 0.0, gT.y) * tw.y;
      if (steep > 0.0) {
        if (tw.x > 0.02) {
          vec2 sx = texture2D(uDetailGrad, vTerrainPos.zy / (uDetailSpan * 0.032)).rg / 0.032 * 0.05 * amp;
          p += vec3(0.0, sx.y, sx.x) * tw.x;
        }
        if (tw.z > 0.02) {
          vec2 sz = texture2D(uDetailGrad, vTerrainPos.xy / (uDetailSpan * 0.032)).rg / 0.032 * 0.05 * amp;
          p += vec3(sz.x, sz.y, 0.0) * tw.z;
        }
      }
    }
    wN = normalize(wN - p);
  }

  diffuseColor.rgb = col;
`;

export class Terrain {
  readonly mesh: THREE.Mesh;
  private readonly full: THREE.InstancedBufferGeometry;
  private readonly halfNear: THREE.InstancedBufferGeometry;
  private readonly halfFar: THREE.InstancedBufferGeometry;
  private readonly quarter: THREE.InstancedBufferGeometry;
  private readonly root: Node;
  private readonly ranges: number[] = [];
  private readonly frustum = new THREE.Frustum();
  private readonly _m = new THREE.Matrix4();
  private readonly _box = new THREE.Box3();
  private readonly halfNearMesh: THREE.Mesh;
  private readonly halfFarMesh: THREE.Mesh;
  private readonly quarterMesh: THREE.Mesh;
  readonly material: THREE.MeshStandardMaterial;
  readonly group = new THREE.Group();
  private fullCount = 0;
  private halfNearCount = 0;
  private halfFarCount = 0;
  private quarterCount = 0;
  private lodScale = 1;
  private readonly uniforms: Record<string, THREE.IUniform>;

  constructor(
    private readonly field: Heightfield,
    atmosphere: Record<string, THREE.IUniform>,
    /** The raw heightfield texels (node bounds). */
    private readonly texels: Float32Array,
  ) {
    for (let l = 0; l < LEVELS; l++) this.ranges.push(RANGE0 * 2 ** l);
    this.root = this.buildTree();
    this.full = patchGeometry(CELLS);
    this.halfNear = patchGeometry(CELLS / 2);
    this.halfFar = patchGeometry(CELLS / 2);
    this.quarter = patchGeometry(CELLS / 4);
    this.uniforms = {
      ...field.uniforms,
      ...atmosphere,
      uEye: { value: new THREE.Vector3() },
      uRange0: { value: RANGE0 },
      uTexel: { value: TEXEL },
      uTime: { value: 0 },
      uDetailReach: { value: 1 },
      uPlantShade: { value: null },
      uShadeBox: { value: new THREE.Vector4(0, 0, 0, 0) },
    };
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
    mat.envMapIntensity = 0.85;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
        .replace('#include <begin_vertex>', VERT_BODY);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
        .replace('#include <map_fragment>', ALBEDO)
        .replace(
          '#include <roughnessmap_fragment>',
          'float roughnessFactor = tRough;',
        )
        .replace(
          '#include <normal_fragment_begin>',
          /* glsl */ `
          vec3 normal = normalize((viewMatrix * vec4(wN, 0.0)).xyz);
          vec3 nonPerturbedNormal = normal;
          float faceDirection = 1.0;`,
        )
        .replace(
          '#include <aomap_fragment>',
          /* glsl */ `
          // Baked low-sun shadow on the direct light, horizon AO on the sky light
          reflectedLight.directDiffuse *= tSunVis;
          reflectedLight.directSpecular *= tSunVis;
          reflectedLight.indirectDiffuse *= tAo;
          reflectedLight.indirectSpecular *= tAo;`,
        )
        .replace('#include <fog_fragment>', 'gl_FragColor.rgb = applyHaze(gl_FragColor.rgb, cameraPosition, vTerrainPos, tSunVis);');
    };
    // Program cache key: one terrain program (Three keys shadow variants separately)
    mat.customProgramCacheKey = () => 'cdlod-terrain';
    this.material = mat;
    this.mesh = new THREE.Mesh(this.full, mat);
    this.halfNearMesh = new THREE.Mesh(this.halfNear, mat);
    this.halfFarMesh = new THREE.Mesh(this.halfFar, mat);
    this.quarterMesh = new THREE.Mesh(this.quarter, mat);
    for (const [m, shadow] of [
      [this.mesh, true],
      [this.halfNearMesh, true],
      [this.halfFarMesh, false],
      [this.quarterMesh, false],
    ] as const) {
      m.frustumCulled = false;
      m.receiveShadow = shadow;
      m.matrixAutoUpdate = false;
      this.group.add(m);
    }
    this.group.name = 'terrain';
  }

  /** Quadtree with per-node height bounds from the heightfield. */
  private buildTree(): Node {
    const make = (x: number, z: number, size: number, level: number): Node => {
      const node: Node = { x, z, size, level, minY: 0, maxY: 0, children: null };
      if (level > 0) {
        const h = size / 2;
        node.children = [
          make(x, z, h, level - 1),
          make(x + h, z, h, level - 1),
          make(x, z + h, h, level - 1),
          make(x + h, z + h, h, level - 1),
        ];
        node.minY = Math.min(...node.children.map((c) => c.minY));
        node.maxY = Math.max(...node.children.map((c) => c.maxY));
      } else {
        // Bounds of the texels under the leaf (plus a texel either side for the spline)
        let lo = Infinity;
        let hi = -Infinity;
        const n = HEIGHT_RES;
        const i0 = Math.max(0, Math.floor((x / WORLD_SIZE + 0.5) * n) - 1);
        const j0 = Math.max(0, Math.floor((z / WORLD_SIZE + 0.5) * n) - 1);
        const span = Math.ceil(size / TEXEL) + 2;
        for (let j = j0; j < Math.min(n, j0 + span); j++) {
          for (let i = i0; i < Math.min(n, i0 + span); i++) {
            const y = this.texels[j * n + i];
            if (y < lo) lo = y;
            if (y > hi) hi = y;
          }
        }
        // Margin for the close-up crags the base relief doesn't carry
        node.minY = lo - 8;
        node.maxY = hi + 8;
      }
      return node;
    };
    return make(-WORLD_SIZE / 2, -WORLD_SIZE / 2, WORLD_SIZE, LEVELS - 1);
  }

  private boxDist2(n: Node, eye: THREE.Vector3): number {
    const dx = Math.max(n.x - eye.x, 0, eye.x - (n.x + n.size));
    const dz = Math.max(n.z - eye.z, 0, eye.z - (n.z + n.size));
    const dy = Math.max(n.minY - eye.y, 0, eye.y - n.maxY);
    return dx * dx + dy * dy + dz * dz;
  }

  private inFrustum(n: Node): boolean {
    this._box.min.set(n.x, n.minY, n.z);
    this._box.max.set(n.x + n.size, n.maxY, n.z + n.size);
    return this.frustum.intersectsBox(this._box);
  }

  private add(n: Node, lod: number, child: boolean, ox = n.x, oz = n.z): void {
    const far = lod >= 2;
    const geo = far ? (child ? this.quarter : this.halfFar) : child ? this.halfNear : this.full;
    const count = far ? (child ? this.quarterCount : this.halfFarCount) : child ? this.halfNearCount : this.fullCount;
    if (count >= MAX_PATCHES) return;
    const attr = geo.getAttribute('aPatch') as THREE.InstancedBufferAttribute;
    // Far rings (lod >= 2) step to 2x coarser vertex spacing (halfFar on full nodes, quarter on child quarters)
    const spacing = (LEAF * 2 ** lod) / (far ? CELLS / 2 : CELLS);
    attr.setXYZW(count, ox, oz, spacing, lod);
    if (far) {
      if (child) this.quarterCount++;
      else this.halfFarCount++;
    } else if (child) {
      this.halfNearCount++;
    } else {
      this.fullCount++;
    }
  }

  private select(n: Node, eye: THREE.Vector3): boolean {
    const lod = n.level;
    if (this.boxDist2(n, eye) > this.ranges[lod] ** 2) return false;
    if (!this.inFrustum(n)) return true;
    if (lod === 0 || this.boxDist2(n, eye) > this.ranges[lod - 1] ** 2) {
      this.add(n, lod, false);
      return true;
    }
    for (const c of n.children!) {
      // A child out of the finer range is drawn at this node's LOD: a
      // half-res (near) or quarter-res (far) patch over the child's quarter
      if (!this.select(c, eye)) {
        if (this.inFrustum(c)) this.add(c, lod, true);
      }
    }
    return true;
  }

  update(camera: THREE.Camera, time: number): void {
    const eye = camera.position;
    this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this._m);
    this.fullCount = 0;
    this.halfNearCount = 0;
    this.halfFarCount = 0;
    this.quarterCount = 0;
    this.select(this.root, eye);
    this.full.instanceCount = this.fullCount;
    this.halfNear.instanceCount = this.halfNearCount;
    this.halfFar.instanceCount = this.halfFarCount;
    this.quarter.instanceCount = this.quarterCount;
    for (const [g, count] of [
      [this.full, this.fullCount],
      [this.halfNear, this.halfNearCount],
      [this.halfFar, this.halfFarCount],
      [this.quarter, this.quarterCount],
    ] as const) {
      if (count <= 0) continue;
      const attr = g.getAttribute('aPatch') as THREE.InstancedBufferAttribute;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, count * 4);
      attr.needsUpdate = true;
    }
    this.mesh.visible = this.fullCount > 0;
    this.halfNearMesh.visible = this.halfNearCount > 0;
    this.halfFarMesh.visible = this.halfFarCount > 0;
    this.quarterMesh.visible = this.quarterCount > 0;
    (this.uniforms.uEye.value as THREE.Vector3).copy(eye);
    this.uniforms.uTime.value = time;
    void this.field;
  }

  /**
   * Scales tessellation ring distances without shrinking the horizon:
   * lower values coarsen mid-range tessellation early for higher FPS,
   * while the outermost root ring always reaches the full world edge.
   */
  setLodScale(scale: number): void {
    const s = Math.max(0.35, Math.min(2.0, scale));
    if (s === this.lodScale) return;
    this.lodScale = s;
    const r0 = RANGE0 * s;
    this.uniforms.uRange0.value = r0;
    for (let l = 0; l < LEVELS; l++) {
      const r = r0 * 2 ** l;
      this.ranges[l] = l === LEVELS - 1 ? Math.max(RANGE0 * 2 ** l, r) : r;
    }
  }

  /** The vegetation's shade map and the box it covers (shared, kept current by the vegetation). */
  setPlantShade(shade: { texture: THREE.Texture | null; box: THREE.Vector4 }): void {
    this.uniforms.uPlantShade.value = shade.texture;
    this.uniforms.uShadeBox.value = shade.box;
  }

  /**
   * How far the close-up ground detail carries, and how sharp it stays at
   * grazing angles. `reach` multiplies the fade distances of the grain and
   * micro relief (1 = 900 m and 260 m); `anisotropy` is the filtering on the
   * detail textures (clamped to what the GPU offers).
   */
  setDetail(reach: number, anisotropy: number, renderer: THREE.WebGLRenderer): void {
    this.uniforms.uDetailReach.value = reach;
    const aniso = Math.max(1, Math.min(anisotropy, renderer.capabilities.getMaxAnisotropy()));
    for (const key of ['uDetail', 'uDetailGrad']) {
      const tex = this.uniforms[key].value as THREE.Texture;
      // Anisotropy needs the mip chain (absent without linear float filtering)
      if (!tex.generateMipmaps || tex.anisotropy === aniso) continue;
      tex.anisotropy = aniso;
      tex.needsUpdate = true;
    }
  }

  get patchCount(): number {
    return this.fullCount + this.halfNearCount + this.halfFarCount + this.quarterCount;
  }
}
