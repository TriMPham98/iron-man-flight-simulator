import * as THREE from 'three';

/**
 * The world: a 32 km stretch of coastal range on the Pacific, flown in
 * Night Ops by default (moonlit silver-blue sky, dark coastal indigo haze,
 * glowing cliff house and storm-lit clouds). Metres throughout; +Y up, the
 * ocean lies to the south (+Z) and the moon hangs low in the west-south-west
 * over the water.
 */
export const WORLD_SIZE = 32768;
/** Heightfield texels per side (16 m each). */
export const HEIGHT_RES = 2048;
export const TEXEL = WORLD_SIZE / HEIGHT_RES;
/** Tileable detail-noise texture: texels per side and world span (m). */
export const DETAIL_RES = 256;
export const DETAIL_SPAN = 192;
/** Vertex spacing (m) of the finest terrain mesh, the one drawn underfoot. */
export const TERRAIN_PITCH = 4;
export const SEA_LEVEL = 0;

export interface LightingPreset {
  readonly night: boolean;
  /** Direction toward the primary celestial light (unit). */
  readonly dir: THREE.Vector3;
  readonly color: THREE.Color;
  readonly intensity: number;
  readonly hemiSky: number;
  readonly hemiGround: number;
  readonly hemiIntensity: number;
  readonly envIntensity: number;
  readonly fogDensity: number;
  readonly fogFalloff: number;
}

/** Night Ops: cool silver-blue moonlight over the Pacific and dark indigo haze. */
export const NIGHT_LIGHTING: LightingPreset = {
  night: true,
  dir: new THREE.Vector3(-0.74, 0.16, 0.65).normalize(),
  color: new THREE.Color(0.64, 0.78, 1.0),
  intensity: 1.65,
  hemiSky: 0x2b4575,
  hemiGround: 0x0a0f1c,
  hemiIntensity: 0.78,
  envIntensity: 0.9,
  fogDensity: 1 / 25000,
  fogFalloff: 1 / 1300,
};

/** Legacy golden-hour preset (preserved for compatibility). */
export const DAY_LIGHTING: LightingPreset = {
  night: false,
  dir: new THREE.Vector3(-0.74, 0.122, 0.66).normalize(),
  color: new THREE.Color(1.0, 0.78, 0.56),
  intensity: 4.4,
  hemiSky: 0x6b86ad,
  hemiGround: 0x2a241c,
  hemiIntensity: 0.25,
  envIntensity: 0.8,
  fogDensity: 1 / 30000,
  fogFalloff: 1 / 1400,
};

export const NIGHT_OPS = true;
export const ACTIVE_LIGHTING: LightingPreset = NIGHT_OPS ? NIGHT_LIGHTING : DAY_LIGHTING;

/** Direction toward the primary sky light (unit: moon in Night Ops). */
export const SUN_DIR = ACTIVE_LIGHTING.dir.clone();
/** Direct moonlight (or sun) colour. */
export const SUN_COLOR = ACTIVE_LIGHTING.color.clone();
export const SUN_INTENSITY = ACTIVE_LIGHTING.intensity;

/** Speed of sound at sea level (m/s): Mach readout, sonic boom, sound delay. */
export const SPEED_OF_SOUND = 343;
export const GRAVITY = 9.81;
