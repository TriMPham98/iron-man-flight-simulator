import * as THREE from 'three';
import { ACTIVE_LIGHTING, SUN_COLOR, SUN_DIR, SUN_INTENSITY } from './config';

/**
 * Sky, moon/sun and air. A physically based sky is rendered once
 * into a cube map: it is the scene background, the image-based light every
 * PBR surface picks up (pre-filtered), and — sampled along the view ray —
 * the colour distant land and sea fade into, so the haze always matches
 * the sky behind it.
 */
export interface Atmosphere {
  sun: THREE.DirectionalLight;
  fillLight: THREE.HemisphereLight;
  skyCube: THREE.CubeTexture;
  envMap: THREE.Texture;
  /** Uniforms shared by every custom shader that applies the haze. */
  uniforms: Record<string, THREE.IUniform>;
}

/** Height fog: sea-level density (1/m) and scale height falloff (1/m). */
const FOG_DENSITY = ACTIVE_LIGHTING.fogDensity;
const FOG_FALLOFF = ACTIVE_LIGHTING.fogFalloff;

export const ATMOSPHERE_GLSL = /* glsl */ `
uniform samplerCube uSkyCube;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uFogDensity;
uniform float uFogFalloff;
// Haze colour seen along a view ray: the sky at (or just above) the horizon
// behind it, tinted toward the moon/sun. lit is how much of the air on the way
// the sky light reaches: land seen against the light in its own shadow keeps
// the air's indigo/blue but loses the forward glow.
vec3 hazeColor(vec3 rd, float lit) {
  vec3 d = normalize(vec3(rd.x, max(rd.y, 0.015), rd.z));
  vec3 sky = textureLod(uSkyCube, d, 4.0).rgb;
  float s = max(dot(rd, uSunDir), 0.0);
  lit = mix(1.0, lit, smoothstep(0.0, 0.6, s));
  vec2 side = normalize(vec2(-uSunDir.z, uSunDir.x)) * length(d.xz);
  vec3 shade = min(sky, textureLod(uSkyCube, vec3(side.x, d.y, side.y), 4.0).rgb);
  return mix(shade, sky, lit) + uSunColor * lit * (pow(s, 12.0) * 0.08 + pow(s, 3.0) * 0.015);
}
vec3 hazeColor(vec3 rd) { return hazeColor(rd, 1.0); }
// Amount of air between the eye and a point (exponential height fog,
// integrated analytically along the ray)
float hazeAmount(vec3 ro, vec3 p) {
  vec3 rd = p - ro;
  float dist = length(rd);
  rd /= max(dist, 1e-4);
  float b = uFogFalloff;
  float y = max(ro.y, -50.0);
  float k = rd.y * b;
  float fog = uFogDensity * exp(-y * b) * (abs(k) > 1e-5 ? (1.0 - exp(-dist * k)) / k : dist);
  return 1.0 - exp(-max(fog, 0.0));
}
vec3 applyHaze(vec3 col, vec3 ro, vec3 p, float lit) {
  float a = hazeAmount(ro, p);
  return mix(col, hazeColor(normalize(p - ro), lit), a);
}
vec3 applyHaze(vec3 col, vec3 ro, vec3 p) { return applyHaze(col, ro, p, 1.0); }
`;

/**
 * Sky cube shader: in Night Ops (`uNight > 0.5`), renders a moonlit midnight
 * sky with indigo coastal horizon glow, subtle galactic band, procedural
 * seamless 3D starfield, lunar corona and mare-shaded moon disc. In day mode,
 * renders Nishita single-scattering golden-hour sky.
 */
const SKY_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uSun;
uniform float uNight;
varying vec3 vDir;
const float PI = 3.14159265;
const float R_PLANET = 6371e3;
const float R_ATMOS = 6471e3;
const vec3 K_RLH = vec3(5.5e-6, 13.0e-6, 22.4e-6);
const float K_MIE = 21e-6;
const float SH_RLH = 8e3;
const float SH_MIE = 1.2e3;
const float G = 0.84;
const float I_SUN = 22.0;

vec2 rsi(vec3 r0, vec3 rd, float sr) {
  float b = 2.0 * dot(rd, r0);
  float c = dot(r0, r0) - sr * sr;
  float d = b * b - 4.0 * c;
  if (d < 0.0) return vec2(1e5, -1e5);
  return vec2((-b - sqrt(d)) / 2.0, (-b + sqrt(d)) / 2.0);
}

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

float vnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash33(i + vec3(0.0, 0.0, 0.0)).x;
  float n100 = hash33(i + vec3(1.0, 0.0, 0.0)).x;
  float n010 = hash33(i + vec3(0.0, 1.0, 0.0)).x;
  float n110 = hash33(i + vec3(1.0, 1.0, 0.0)).x;
  float n001 = hash33(i + vec3(0.0, 0.0, 1.0)).x;
  float n101 = hash33(i + vec3(1.0, 0.0, 1.0)).x;
  float n011 = hash33(i + vec3(0.0, 1.0, 1.0)).x;
  float n111 = hash33(i + vec3(1.0, 1.0, 1.0)).x;
  float nx00 = mix(n000, n100, f.x);
  float nx10 = mix(n010, n110, f.x);
  float nx01 = mix(n001, n101, f.x);
  float nx11 = mix(n011, n111, f.x);
  return mix(mix(nx00, nx10, f.y), mix(nx01, nx11, f.y), f.z);
}

float fbm3(vec3 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise3(p);
    p = p * 2.03 + vec3(13.7, 7.3, 19.1);
    a *= 0.5;
  }
  return s;
}

vec3 starLayer(vec3 dir, float scale, float threshold, float radius, float brightness) {
  vec3 grid = dir * scale;
  vec3 cell = floor(grid);
  vec3 acc = vec3(0.0);
  // Check local 3x3x3 cells near direction to stay seamless across cube faces
  for (int dz = -1; dz <= 1; dz++) {
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        vec3 c = cell + vec3(float(dx), float(dy), float(dz));
        vec3 h = hash33(c);
        if (h.x < threshold) continue;
        vec3 starDir = normalize(c + 0.18 + 0.64 * h);
        float d = length(dir - starDir);
        float core = smoothstep(radius, radius * 0.15, d);
        if (core <= 0.0) continue;
        float mag = pow((h.x - threshold) / (1.0 - threshold), 1.6);
        vec3 tint = mix(vec3(0.75, 0.88, 1.18), vec3(1.12, 0.96, 0.82), h.y);
        tint = mix(tint, vec3(1.0), 0.45);
        acc += tint * core * (0.25 + 1.15 * mag) * brightness;
      }
    }
  }
  return acc;
}

vec3 nightSky(vec3 rawDir, vec3 sun) {
  float below = clamp(-rawDir.y / 0.25, 0.0, 1.0);
  vec3 r = normalize(vec3(rawDir.x, max(rawDir.y, 0.002), rawDir.z));
  float up = clamp(r.y, 0.0, 1.0);
  float cosA = dot(r, sun);

  // Midnight zenith to dark indigo coastal horizon
  vec3 zenith = vec3(0.008, 0.016, 0.044);
  vec3 horizon = vec3(0.040, 0.072, 0.138);
  vec3 col = mix(horizon, zenith, pow(up, 0.48));
  col += vec3(0.032, 0.056, 0.105) * exp(-up * 12.0);

  // Faint Milky Way dust band across the upper hemisphere
  vec3 galAxis = normalize(vec3(0.42, 0.66, -0.62));
  float band = exp(-pow(dot(r, galAxis) * 3.4, 2.0));
  float dust = fbm3(r * 7.5 + 2.1);
  col += vec3(0.018, 0.028, 0.055) * band * smoothstep(0.28, 0.72, dust) * smoothstep(0.02, 0.25, up);

  // Cool silver-blue moonlight atmospheric scattering & lunar corona
  float mu = max(cosA, 0.0);
  col += vec3(0.052, 0.085, 0.155) * pow(mu, 3.0);
  col += vec3(0.20, 0.30, 0.50) * pow(mu, 22.0);
  col += vec3(0.68, 0.84, 1.12) * pow(mu, 180.0);

  // Seamless procedural starfield (suppressed near horizon & moon glare)
  float starMask = (1.0 - below) * smoothstep(0.015, 0.18, rawDir.y) * (1.0 - smoothstep(0.93, 0.996, cosA));
  if (starMask > 0.001) {
    vec3 stars = starLayer(r, 52.0, 0.84, 0.0105, 1.45) + starLayer(r, 94.0, 0.76, 0.0072, 0.85);
    col += stars * starMask;
  }

  // Crisp moon disc with subtle lunar mare shading
  float disc = smoothstep(0.99978, 0.99988, cosA);
  if (below <= 0.0 && disc > 0.0) {
    float mare = 0.76 + 0.24 * smoothstep(0.32, 0.65, fbm3(r * 140.0));
    col += disc * mare * vec3(13.5, 15.5, 19.0);
  }

  col *= mix(1.0, 0.22, below);
  return col;
}

void main() {
  vec3 r = normalize(vDir);
  vec3 sun = normalize(uSun);
  if (uNight > 0.5) {
    gl_FragColor = vec4(nightSky(r, sun), 1.0);
    return;
  }

  // Golden-hour Nishita single-scattering fallback when uNight < 0.5
  float below = clamp(-r.y / 0.25, 0.0, 1.0);
  r.y = max(r.y, 0.002);
  r = normalize(r);
  vec3 r0 = vec3(0.0, R_PLANET + 250.0, 0.0);
  vec2 p = rsi(r0, r, R_ATMOS);
  float hitGround = rsi(r0, r, R_PLANET).x;
  bool ground = hitGround > 0.0 && hitGround < p.y;
  p.y = ground ? hitGround : p.y;
  p.x = max(p.x, 0.0);
  const int IS = 16;
  const int JS = 6;
  float step = (p.y - p.x) / float(IS);
  float t = 0.0;
  vec3 rl = vec3(0.0);
  vec3 mi = vec3(0.0);
  float odR = 0.0;
  float odM = 0.0;
  float mu = dot(r, sun);
  float gg = G * G;
  float pR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  float pM = 3.0 / (8.0 * PI) * ((1.0 - gg) * (mu * mu + 1.0)) / (pow(1.0 + gg - 2.0 * mu * G, 1.5) * (2.0 + gg));
  for (int i = 0; i < IS; i++) {
    vec3 ip = r0 + r * (t + step * 0.5);
    float h = length(ip) - R_PLANET;
    float dR = exp(-h / SH_RLH) * step;
    float dM = exp(-h / SH_MIE) * step;
    odR += dR;
    odM += dM;
    float js = rsi(ip, sun, R_ATMOS).y / float(JS);
    float jt = 0.0;
    float jR = 0.0;
    float jM = 0.0;
    for (int j = 0; j < JS; j++) {
      vec3 jp = ip + sun * (jt + js * 0.5);
      float jh = length(jp) - R_PLANET;
      jR += exp(-jh / SH_RLH) * js;
      jM += exp(-jh / SH_MIE) * js;
      jt += js;
    }
    vec3 attn = exp(-(K_MIE * 1.1 * (odM + jM) + K_RLH * (odR + jR)));
    rl += dR * attn;
    mi += dM * attn;
    t += step;
  }
  vec3 col = I_SUN * (pR * K_RLH * rl + pM * K_MIE * mi);
  vec3 trans = exp(-(K_MIE * 1.1 * odM + K_RLH * odR));
  float cosA = dot(r, sun);
  float disc = smoothstep(0.99996, 0.999985, cosA);
  if (!ground && below <= 0.0) col += trans * disc * 900.0 * (0.6 + 0.4 * smoothstep(0.99996, 1.0, cosA));
  col *= mix(1.0, 0.3, below);
  gl_FragColor = vec4(col, 1.0);
}
`;

export function createAtmosphere(renderer: THREE.WebGLRenderer, scene: THREE.Scene): Atmosphere {
  const sky = new THREE.Mesh(
    new THREE.BoxGeometry(100, 100, 100),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uSun: { value: SUN_DIR },
        uNight: { value: ACTIVE_LIGHTING.night ? 1 : 0 },
      },
      vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: SKY_FRAG,
    }),
  );

  const skyScene = new THREE.Scene();
  skyScene.add(sky);
  const cubeRt = new THREE.WebGLCubeRenderTarget(256, {
    type: THREE.HalfFloatType,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
  });
  const cubeCam = new THREE.CubeCamera(1, 2000, cubeRt);
  cubeCam.update(renderer, skyScene);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromCubemap(cubeRt.texture).texture;
  pmrem.dispose();
  sky.geometry.dispose();
  sky.material.dispose();

  scene.background = cubeRt.texture;
  scene.environment = env;
  scene.environmentIntensity = ACTIVE_LIGHTING.envIntensity;

  const sun = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
  sun.position.copy(SUN_DIR).multiplyScalar(100);
  sun.castShadow = true;
  // A tight shadow box that rides with the suit: self-shadowing and the
  // suit's own shadow on the ground or the sea when it flies low
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -6;
  sc.right = 6;
  sc.top = 6;
  sc.bottom = -6;
  sc.near = 1;
  sc.far = 400;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;

  const fillLight = new THREE.HemisphereLight(ACTIVE_LIGHTING.hemiSky, ACTIVE_LIGHTING.hemiGround, ACTIVE_LIGHTING.hemiIntensity);
  scene.add(sun, sun.target, fillLight);

  return {
    sun,
    fillLight,
    skyCube: cubeRt.texture,
    envMap: env,
    uniforms: {
      uSkyCube: { value: cubeRt.texture },
      uSunDir: { value: SUN_DIR },
      uSunColor: { value: SUN_COLOR.clone().multiplyScalar(SUN_INTENSITY) },
      uFogDensity: { value: FOG_DENSITY },
      uFogFalloff: { value: FOG_FALLOFF },
    },
  };
}
