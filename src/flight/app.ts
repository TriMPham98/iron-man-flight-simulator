import * as THREE from 'three';
import { Suit } from '../suit/Suit';
import { createAdaptiveResolution, type ResolutionRenderer } from '../scene/adaptiveResolution';
import { deviceProfile } from '../scene/deviceProfile';
import { GameAudio } from './audio/gameAudio';
import { SFX, Soundscape } from './audio/soundscape';
import { CONTEXT_ATTRIBUTES, canReverseDepth, useReversedDepth } from './render/depth';
import { FlightPost, type LensState } from './render/post';
import './render/shaderGuards';
import { portraitZoom, viewportSize, wideZoom } from './render/viewport';
import { Game } from './sim/game';
import { DEFAULT_CAMERA } from './sim/cameraRig';
import { Director, type Reel } from './sim/director';
import { FrigateReel } from './sim/frigateReel';
import { Input, type Controls } from './sim/input';
import { Upgrades } from './sim/upgrades';
import { Hud } from './ui/hud';
import { MissionManager } from './missions/missionManager';
import { MissionHud } from './ui/missionHud';
import { MultiplayerSession } from './net/multiplayer';
import type { EventBus } from './sim/events';
import type { FlightModel } from './sim/flightModel';
import { MultiplayerHud } from './ui/multiplayerHud';
import { SuitWireframe } from './ui/suitWireframe';
import { TouchControls } from './ui/touchControls';
import type { Screens } from './ui/screens';
import { bindFlightSettings } from './ui/flightSettings';
import { SUN_DIR } from './world/config';
import { World } from './world/world';
import { PAD, PAD_Y } from './world/house';

/**
 * The flight sim as an object the page can build, warm and start: on its
 * own (flight.html) or in the background of the workshop, which builds it
 * a step at a time while the suit-up plays and then flies its finished
 * suit straight out of the cell into it (see src/transition).
 */
export interface FlightAppOptions {
  canvas: HTMLCanvasElement;
  hudCanvas: HTMLCanvasElement;
  screens: Screens;
  /**
   * Awaited between the heavy build steps. Standalone it just yields a
   * frame to the boot screen; in the workshop it waits for idle time.
   */
  pace?: (step: string) => Promise<void>;
  /** Boot-screen progress (0–1) and a status line. */
  progress?: (p: number, line?: string) => void;
  /** Embedded in the workshop page (no boot screen, a handoff instead). */
  embedded?: boolean;
  /** Cap on the drawing-buffer pixel ratio. */
  maxPixelRatio?: number;
  /** Floor on the adaptive drawing-buffer pixel ratio. */
  minPixelRatio?: number;
  /** A fixed drawing-buffer pixel ratio (captures: supersampled, never gauged down). */
  pixelRatio?: number;
}

/** Main-thread cost of each build step (ms), for the boot log and the handoff stats. */
export type BuildTimings = Record<string, number>;

const yieldFrame = () => new Promise<void>((r) => setTimeout(r, 16));

export class FlightApp {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly audio = new GameAudio();
  readonly sounds = new Soundscape(this.audio);
  /** The other pilot's suit in multiplayer, heard as a cinematic camera hears one: from outside, through the air. */
  readonly peerSounds = new Soundscape(this.audio, true);
  /** The wingman whose events {@link peerSounds} is hearing. */
  private peerHeard: object | null = null;
  readonly timings: BuildTimings = {};
  readonly query = new URLSearchParams(location.search);
  readonly device = deviceProfile();
  readonly maxDpr: number;
  /** Pixel ratio of the canvas's drawing buffer: {@link sharpDpr} unless a preset holds it down. */
  outputDpr: number;
  /** The canvas as sharp as the screen (to 2×; a touch GPU's stays at the scene's ceiling). */
  readonly sharpDpr: number;
  private sceneDpr: number;
  /**
   * The scene's pixel ratio (what the adaptive resolution, the gauge and the
   * graphics preset move): the scene target's size, not the canvas's. Follow
   * a change with post.resize().
   */
  readonly resolution: ResolutionRenderer = {
    getPixelRatio: () => this.sceneDpr,
    setPixelRatio: (v: number) => {
      this.sceneDpr = Math.min(v, this.outputDpr);
      this.post?.setScale(this.sceneDpr / this.outputDpr);
    },
  };
  world!: World;
  suit!: Suit;
  game!: Game;
  post!: FlightPost;
  hud!: Hud;
  missions!: MissionManager;
  missionHud!: MissionHud;
  multiplayer!: MultiplayerSession;
  multiplayerHud!: MultiplayerHud;
  /** The suit's R&D: points earned in the air, upgrades fitted on the pad. */
  readonly upgrades = new Upgrades();
  /** Holds the sim and opens the R&D refit bay (wired by the settings). */
  refitMenu: () => void = () => {};
  /**
   * Keyboard / mouse / pad. Created only once the sim is shown: its window
   * listeners swallow Space / Tab / F / G / Q, which the workshop still needs
   * while the sim is building behind it.
   */
  input: Input | null = null;
  /** On-screen controls (touch-first devices only; created with the input). */
  touch: TouchControls | null = null;
  /** Opens the pause menu (wired by src/flight/ui/flightSettings.ts). */
  pauseMenu: () => void = () => {};
  director: Reel | null = null;
  lens!: LensState;
  /** The pilot has the stick (title / handoff are over). */
  engaged = false;
  paused = false;
  /** Test / capture hook: replaces live controls when set. */
  autopilot: ((t: number, c: Controls) => void) | null = null;
  /** Hands on the stick before the pilot's are: the handoff's lift-off and hover. */
  handoffPilot: ((dt: number, c: Controls) => void) | null = null;
  /** Runs after the rig has placed the camera: the handoff's matched framing. */
  cameraOverride: ((camera: THREE.PerspectiveCamera, dt: number) => void) | null = null;
  /** HUD visibility goal while not engaged (the handoff fades it up early). */
  hudGoal = 0;
  /** Settings volume, ramped in by the handoff's audio crossfade. */
  volumeScale = 1;
  /**
   * Keep the pixel ratio where it is (the handoff: two renderers share the
   * GPU for a moment, and a resize reallocates every target mid-shot).
   */
  holdResolution = false;
  readonly audioReady: Promise<void>;
  private readonly clock = new THREE.Clock();
  private adaptive!: ReturnType<typeof createAdaptiveResolution>;
  private baseLodScale = 1;
  private lodScale = 1;
  private maxAdaptiveDpr = Infinity;
  private onLodApply: ((scale: number) => void) | null = null;
  private baseExposure = 0.58;
  private raf = 0;
  private running = false;
  private visible = true;

  private readonly opts: FlightAppOptions;
  readonly screens: Screens;

  constructor(opts: FlightAppOptions) {
    this.opts = opts;
    this.screens = opts.screens;
    const { canvas } = opts;
    this.audioReady = this.audio.preload(Soundscape.files()).catch((e) => console.warn(e));
    // 0.1 m to 150 km without the near ground and the far ridges fighting:
    // reversed-Z where the GPU can, log depth where it can't (render/depth.ts)
    const gl = canvas.getContext('webgl2', CONTEXT_ATTRIBUTES);
    const reversed = canReverseDepth(gl);
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      context: gl ?? undefined,
      ...CONTEXT_ATTRIBUTES,
      reverseDepthBuffer: reversed,
      logarithmicDepthBuffer: !reversed,
    });
    const r = this.renderer;
    if (reversed) useReversedDepth(r);
    console.info(
      '[flight] depth',
      r.capabilities.reverseDepthBuffer ? 'reversed-z' : 'logarithmic',
      (() => {
        const gl = r.getContext();
        const d = gl.getExtension('WEBGL_debug_renderer_info');
        return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : '';
      })(),
    );
    this.maxDpr = opts.pixelRatio ?? Math.min(window.devicePixelRatio || 1, opts.maxPixelRatio ?? this.device.maxPixelRatio);
    // The canvas itself is as sharp as the screen (to 2×) and stays that
    // size; only the scene target follows the adaptive ratio, and the final
    // pass upscales it (render/post.ts). A touch GPU keeps the canvas at the
    // scene's ceiling: its fill rate is what the ratio is saving
    this.sharpDpr = opts.screens.touch ? this.maxDpr : Math.max(this.maxDpr, Math.min(window.devicePixelRatio || 1, 2));
    this.outputDpr = this.sharpDpr;
    this.sceneDpr = this.maxDpr;
    r.setPixelRatio(this.outputDpr);
    r.shadowMap.enabled = true;
    r.shadowMap.type = opts.screens.touch ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    Object.assign(canvas.style, { position: 'fixed', left: '0', top: '0', display: 'block' });
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.1, 150000);
    this.syncViewport(true);
    // Rotation, Chrome Android's toolbar and the keyboard move the visual
    // viewport, not always with a window 'resize' (and rotation's can carry
    // the old size): every frame checks too (syncViewport is a no-op then)
    window.addEventListener('resize', () => this.syncViewport(true));
    window.visualViewport?.addEventListener('resize', () => this.syncViewport());
    window.addEventListener('orientationchange', () => this.syncViewport());
  }

  /**
   * Resizes the canvas's drawing buffer (a graphics preset trading the
   * full-resolution final pass away); the scene keeps its own ratio under it.
   */
  setOutputDpr(dpr: number): void {
    const next = Math.min(dpr, this.sharpDpr);
    if (next === this.outputDpr) return;
    this.outputDpr = next;
    this.renderer.setPixelRatio(next);
    this.resolution.setPixelRatio(this.sceneDpr);
    this.syncViewport(true);
  }

  /** The size everything is drawn at (CSS px; src/flight/render/viewport.ts). */
  private view = { w: 0, h: 0 };

  /**
   * Sizes the canvases, the drawing buffer, the camera and the HUD from the
   * one measure of the visible viewport, so the picture is never stretched.
   * `force`: the pixel ratio may have moved (the targets need a resize).
   */
  syncViewport(force = false): void {
    const { w, h } = viewportSize();
    if (!force && w === this.view.w && h === this.view.h) return;
    this.view = { w, h };
    for (const c of [this.opts.canvas, this.opts.hudCanvas]) Object.assign(c.style, { width: `${w}px`, height: `${h}px` });
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Ultra-wide phones: no wider across than 16:9 (desktop is left alone);
    // portrait: no narrower than the workshop's lens it's flown in from
    this.camera.zoom = (this.opts.screens.touch ? wideZoom(this.camera.aspect) : 1) * portraitZoom(this.camera.aspect);
    this.camera.updateProjectionMatrix();
    this.post?.resize();
    this.hud?.resize(w, h);
    this.touch?.fit(w, h);
  }

  private async step<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    await (this.opts.pace ?? yieldFrame)(name);
    const t0 = performance.now();
    const out = await fn();
    this.timings[name] = Math.round(performance.now() - t0);
    return out;
  }

  /** Builds world, suit, sim and post, one paced step at a time. */
  async build(): Promise<void> {
    const progress = this.opts.progress ?? (() => {});
    const { screens } = this.opts;
    const suitLoad = Suit.create((r) => progress(0.1 + 0.5 * r));
    progress(0.08, 'MK III ARMOUR · LOADING');
    progress(0.12, 'TERRAIN · 32 KM · GROWING RELIEF');
    this.world = await this.step('world', () => new World(this.renderer, this.scene, { touch: screens.touch, tier: this.device.tier }));
    console.info(`[flight] world built in ${this.timings.world} ms`);
    progress(0.3, 'LOW SUN · BAKING SHADOWS + SKY');
    this.suit = await suitLoad;
    progress(0.7, 'FLIGHT CONTROL · STABILIZERS · ARSENAL');
    this.game = await this.step('game', () =>
      new Game(this.world, this.suit, this.scene, this.camera, { maxParticles: screens.touch ? 2000 : 5000 }),
    );
    console.info(`[flight] game built in ${this.timings.game} ms`);
    await this.step('post', () => {
      this.post = new FlightPost(this.renderer, this.scene, this.camera);
      this.post.setScale(this.sceneDpr / this.outputDpr);
      this.post.setBilinearUpscale(screens.touch);
      this.post.resize();
      this.hud = new Hud(this.opts.hudCanvas, { maxDpr: this.opts.pixelRatio ?? this.device.maxPixelRatio });
      // The helmet's suit diagram: the suit's own panel lines, flattened once
      const palm = (i: number) => this.suit.palms[i].at;
      this.hud.wireframe = new SuitWireframe(this.suit.finalGeometry, {
        palmL: palm(0),
        palmR: palm(1),
        bootL: [0.16, 0.02, 0.01],
        bootR: [-0.16, 0.02, 0.01],
      });
      if (!this.opts.embedded) this.attachInput();
    });
    const game = this.game;
    const { hud } = this;
    hud.pad = new THREE.Vector3(PAD.x, PAD_Y, PAD.y);
    hud.suitPos = game.model.pos;
    hud.onCue = (cue, n) => this.sounds.hud(cue, n);
    game.events.on((e) => {
      this.sounds.on(e, game.model);
      hud.event(e);
    });
    this.bindUpgrades();
    screens.onSettings = () => this.applySettings();
    this.applySettings();
    bindFlightSettings(this);
    this.bindMissions();
    this.bindMultiplayer();

    const q = this.query;
    this.lens = {
      sunUv: new THREE.Vector2(),
      sunVis: 0,
      speed: 0,
      damage: 0,
      cloud: 0,
      exposure: Number(q.get('exp') ?? 0.58),
      helmet: 0,
      reactorMode: 'BALANCED',
      modePulse: 0,
      overchargeActive: false,
    };
    this.baseExposure = this.lens.exposure;
    this.adaptive = createAdaptiveResolution(this.resolution, () => this.post.resize(), {
      min: this.opts.minPixelRatio ?? this.device.minPixelRatio,
      max: Math.min(this.maxDpr, this.maxAdaptiveDpr),
      lodMin: Math.min(0.5, this.baseLodScale),
      lodMax: this.baseLodScale,
      lodInitial: this.lodScale,
      onLodChange: (s) => this.applyLodScale(s),
    });

    // ?demo plays the directed reel live; ?capture steps it frame by frame
    if (!this.opts.embedded) {
      const capture = q.has('capture');
      const reel = q.get('reel') === 'frigate' ? FrigateReel : Director;
      this.director = capture || q.has('demo') ? new reel(game) : null;
      this.engaged = q.has('fly') || !!this.director;
    }
    game.rig.mode = this.engaged && !this.director ? DEFAULT_CAMERA : 'attract';
    hud.alpha = this.engaged ? 1 : 0;
    this.syncViewport(true);
  }

  /** Sets the quality-preset LOD scale ceiling and optional world applier. */
  setPresetLodScale(scale: number, onApply?: (scale: number) => void): void {
    this.baseLodScale = scale;
    this.lodScale = scale;
    if (onApply) this.onLodApply = onApply;
    this.adaptive?.setLodBounds(scale, Math.min(0.5, scale));
  }

  /** Caps the adaptive resolution ceiling to the active quality preset. */
  setMaxAdaptiveDpr(max: number): void {
    this.maxAdaptiveDpr = max;
    this.adaptive?.setMaxPixelRatio(Math.min(this.maxDpr, max));
  }

  private applyLodScale(scale: number): void {
    this.lodScale = scale;
    if (this.onLodApply) {
      this.onLodApply(scale);
      return;
    }
    const w = this.world;
    if (!w) return;
    (w.terrain as { setLodScale?: (s: number) => void }).setLodScale?.(scale);
    (w.vegetation as { setLodScale?: (s: number) => void }).setLodScale?.(scale);
    w.ocean.setLodScale(scale);
    w.clouds.setLodScale(scale);
  }

  /**
   * Compiles every program the first frames need and runs a few of them
   * unseen, so the frame the handoff (or title) first shows is a steady one.
   * Parallel compile (KHR_parallel_shader_compile) keeps the main thread free.
   */
  async warm(frames = 3): Promise<void> {
    const revealAll = (setCull: boolean) => {
      const vis: Array<[THREE.Object3D, boolean, boolean]> = [];
      const lods: Array<[THREE.LOD, boolean]> = [];
      const touch = (o: THREE.Object3D) => {
        vis.push([o, o.visible, o.frustumCulled]);
        o.visible = true;
        if (setCull) o.frustumCulled = false;
        if ((o as THREE.LOD).isLOD) {
          const lod = o as THREE.LOD;
          lods.push([lod, lod.autoUpdate]);
          lod.autoUpdate = false;
          for (const lvl of lod.levels) {
            if (lvl.object && lvl.object.parent !== lod) lvl.object.traverse(touch);
          }
        }
      };
      this.scene.traverse(touch);
      return () => {
        for (const [lod, au] of lods) lod.autoUpdate = au;
        for (const [o, v, c] of vis) {
          o.visible = v;
          o.frustumCulled = c;
        }
      };
    };

    // Everything, including what is hidden now and shown later (boot jets,
    // flaps, weapons, sprites, and all THREE.LOD tiers): three only compiles visible objects
    await this.step('compile', async () => {
      const restore = revealAll(false);
      // Into the target the scene really renders to (linear HDR, no tone
      // mapping): the programs for the canvas would be different variants
      const r = this.renderer;
      const prev = r.getRenderTarget();
      r.setRenderTarget((this.post as unknown as { rt: THREE.WebGLRenderTarget }).rt ?? null);
      try {
        await r.compileAsync(this.scene, this.camera);
      } finally {
        r.setRenderTarget(prev);
        restore();
      }
    });
    // Upload every texture a few at a time (the first frame would otherwise
    // do them all at once)
    const textures = new Set<THREE.Texture>();
    this.scene.traverse((o) => {
      const mats = (o as THREE.Mesh).material;
      for (const m of Array.isArray(mats) ? mats : mats ? [mats] : []) {
        for (const v of Object.values(m as unknown as Record<string, unknown>)) if ((v as THREE.Texture)?.isTexture) textures.add(v as THREE.Texture);
        const u = (m as THREE.ShaderMaterial).uniforms;
        if (u) for (const x of Object.values(u)) if ((x?.value as THREE.Texture)?.isTexture) textures.add(x.value as THREE.Texture);
      }
    });
    const list = [...textures].filter((t) => !(t as THREE.Texture & { isRenderTargetTexture?: boolean }).isRenderTargetTexture);
    for (let i = 0; i < list.length; i += 4) {
      await this.step(`tex${i / 4}`, () => {
        for (const t of list.slice(i, i + 4)) this.renderer.initTexture(t);
      });
    }
    // One unseen draw of everything, hidden things and all LOD levels included
    // and nothing culled: the GPU builds its pipeline state for each draw on
    // first use (ANGLE/Metal), which would otherwise land on the frame the
    // boot jets first light or an LOD swaps
    await this.step('pipelines', () => {
      const r = this.renderer;
      const restore = revealAll(true);
      const prev = r.getRenderTarget();
      try {
        r.setRenderTarget((this.post as unknown as { rt: THREE.WebGLRenderTarget }).rt ?? null);
        r.render(this.scene, this.camera);
      } finally {
        r.setRenderTarget(prev);
        restore();
      }
    });
    // First sim tick builds its lazy state (pools, probes)
    await this.step('sim', () => {
      this.game.update(1 / 60);
      this.world.update(1 / 60, this.camera);
    });
    for (let i = 0; i < frames; i++) {
      await this.step(`settle${i}`, () => this.frame(1 / 60));
      console.info(`[flight] settle frame ${i}: ${this.timings[`settle${i}`]} ms`);
    }
    if (!this.opts.pixelRatio) await this.step('gauge', () => this.gaugeResolution());
  }

  /**
   * Starts at the pixel ratio this GPU can hold, measured rather than found
   * by dropping frames: the first seconds are the handoff's lift-off shot,
   * which holds its resolution (a resize mid-shot is a stall), so whatever
   * ratio it starts at is the one it is seen at. Two timed full frames (each
   * waited out with a one-pixel read) fit cost = fixed + per-pixel × ratio².
   */
  private gaugeResolution(): void {
    const r = this.resolution;
    const gl = this.renderer.getContext();
    const px = new Uint8Array(4);
    const time = (dpr: number) => {
      r.setPixelRatio(dpr);
      this.post.resize();
      let best = Infinity;
      // The first draw at a size pays for its targets: best of three
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        this.post.render(0, this.lens);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    };
    // GPU budget per frame, leaving the CPU's share and a margin of 60 fps
    const BUDGET = 11;
    const MIN = 0.7;
    const hi = this.adaptive.maxPixelRatio;
    const tHi = time(hi);
    let pick = hi;
    let log = `${hi.toFixed(2)}: ${tHi.toFixed(1)} ms`;
    if (tHi > BUDGET && hi > MIN) {
      const lo = Math.max(MIN, hi * 0.6);
      const tLo = time(lo);
      log += `, ${lo.toFixed(2)}: ${tLo.toFixed(1)} ms`;
      const perPx = (tHi - tLo) / (hi * hi - lo * lo);
      const fixed = tHi - perPx * hi * hi;
      if (perPx > 0 && BUDGET > fixed) pick = Math.sqrt((BUDGET - fixed) / perPx);
      else pick = tLo <= BUDGET ? lo : MIN;
      pick = THREE.MathUtils.clamp(Math.floor(pick * 20) / 20, MIN, hi);
    }
    // Back to the ratio the targets are tracked at, then on to the pick
    r.setPixelRatio(this.adaptive.pixelRatio);
    this.post.resize();
    this.adaptive.set(pick);
    console.info(`[flight] resolution gauge ${log} → ${this.adaptive.pixelRatio.toFixed(2)}`);
  }

  // Lens flare: where the sun is on screen and whether the land hides it
  private sunCheck = 0;
  private sunBlocked = 0;
  private readonly sunWorld = new THREE.Vector3();
  private readonly camDir = new THREE.Vector3();
  private updateLens(dt: number): void {
    const { camera, lens, game, world } = this;
    this.sunWorld.copy(camera.position).addScaledVector(SUN_DIR, 5000);
    const p = this.sunWorld.project(camera);
    const inView = p.z < 1 && Math.abs(p.x) < 1.25 && Math.abs(p.y) < 1.25 && camera.getWorldDirection(this.camDir).dot(SUN_DIR) > 0;
    if (--this.sunCheck <= 0) {
      this.sunCheck = 6;
      this.sunBlocked = world.field.raycast(camera.position, SUN_DIR, 16000) > 0 ? 1 : 0;
    }
    const edge = inView ? 1 - THREE.MathUtils.smoothstep(Math.max(Math.abs(p.x), Math.abs(p.y)), 0.75, 1.25) : 0;
    const goal = edge * (1 - this.sunBlocked) * (game.rig.mode === 'helmet' ? 1.2 : 0.8);
    lens.sunVis += (goal - lens.sunVis) * (1 - Math.exp(-dt / 0.12));
    lens.sunUv.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
    lens.helmet = game.rig.mode === 'helmet' ? 1 : 0;
    lens.speed = Math.min(1, Math.max(0, (game.model.speed - 120) / 300));
    lens.damage = game.combat.damageFlash;
    const reactor = game.combat.reactor;
    lens.reactorMode = reactor.mode;
    lens.modePulse = Math.max(reactor.modePulse, reactor.overchargePulse);
    lens.overchargeActive = reactor.overchargeActive;
    lens.cloud += (world.inCloud - lens.cloud) * (1 - Math.exp(-dt / 0.15));
    // Eye adaptation: stop down into the sun, open up away from it
    const sunward = Math.max(0, this.camDir.dot(SUN_DIR));
    const expGoal = this.baseExposure * THREE.MathUtils.lerp(1.18, 0.72, sunward * sunward);
    lens.exposure += (expGoal - lens.exposure) * (1 - Math.exp(-dt / 0.8));
  }

  /** Creates the controls (once). */
  attachInput(): Input {
    if (!this.input) {
      this.input = new Input(this.opts.canvas);
      if (this.opts.screens.touch) {
        // Touch screens: no pointer lock, the overlay drives the touch source
        this.input.touchMode = true;
        this.touch = new TouchControls(
          this.input,
          this.opts.canvas.parentElement ?? document.body,
          () => this.pauseMenu(),
          () => this.refitMenu(),
        );
        this.hud.waveKey = 'WAVE';
        this.hud.landKey = 'LAND';
        this.syncViewport(true);
      }
    }
    this.applySettings();
    return this.input;
  }

  private applySettings(): void {
    const s = this.opts.screens.settings;
    if (this.input) {
      this.input.invertY = s.invertY;
      this.input.sensitivity = s.sensitivity;
    }
    this.touch?.setOpacity(s.touchOpacity);
    this.touch?.setLeftHanded(s.leftHanded);
    this.audio.setVolume(s.volume * this.volumeScale);
    if (this.hud) {
      this.hud.glow = s.quality !== 'low' && (!this.screens.touch || s.quality === 'ultra');
      this.hud.shadow = s.quality !== 'low' && !this.screens.touch;
      this.hud.showFps = s.showFps;
      this.hud.textScale = s.uiScale;
    }
    document.documentElement.style.setProperty('--fl-ui-scale', String(s.uiScale));
  }

  /** Hands off: what the sim reads while there are no controls yet. */
  private idleControls(): Controls {
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
    } as Controls;
  }

  /** One frame of sim + render. */
  frame(dt: number): void {
    const { input, game, world, hud, director, camera } = this;
    this.syncViewport();
    if (input?.touchMode) {
      // The touch take-off / hover-climb mapping reads what the suit is doing
      const sim = input.touch.sim;
      sim.grounded = game.model.grounded;
      sim.hover = 1 - game.model.flightness;
      sim.pitch = Math.asin(THREE.MathUtils.clamp(game.input.aim.y, -1, 1));
    }
    const c = input ? input.read(dt) : this.idleControls();
    if (director) director.update(dt, c);
    else this.autopilot?.(game.time, c);
    if (!this.engaged || this.paused) {
      // Title / pause: the world keeps living, the controls don't
      c.aimYaw = c.aimPitch = c.throttle = c.lateral = c.vertical = c.forward = 0;
      c.fire = c.missile = c.unibeam = c.flares = c.launcher = c.boost = c.brake = false;
      c.strafeDash = 0;
      c.freefallToggle = false;
      c.freefall = false;
      c.grapple = c.punch = false;
      c.pressed.clear();
      if (!this.paused) this.handoffPilot?.(dt, c);
    }
    for (const code of c.pressed) {
      if (code === 'KeyV') game.rig.cycle();
      // Once the suit is lost, the wave key (N, WAVE, D-pad up) redeploys
      if (game.combat.lost) {
        if (code === 'KeyN' && game.combat.redeployReady) game.redeploy();
        if (code === 'KeyU') this.refitMenu();
        continue;
      }
      if (code === 'KeyN') game.combat.callWave();
      if (code === 'KeyU' && game.onPad) this.refitMenu();
      if (code === 'KeyJ' && !director && !this.autopilot) this.openMissionsMenu();
      if (code === 'KeyM' && !director && !this.autopilot) this.openMultiplayerMenu();
    }
    game.pilotGlide = this.engaged && !director && !this.autopilot;
    game.applyControls(c);
    // In multiplayer, opening Esc or a drawer frees the mouse without freezing physics/network sync
    const simPaused = this.paused && !this.multiplayer?.active;
    const simDt = simPaused ? 0 : game.hitStop.effectiveDt(dt);
    if (!simPaused) {
      game.update(simDt, dt);
      this.missions.update(simDt, {
        vertical: c.vertical,
        boost: c.boost,
        brake: c.brake,
        pressed: c.pressed,
        aimY: game.input.aim.y,
      });
    }
    // (the controls are already zeroed off the stick: title, pause)
    this.multiplayer?.update(dt, c);
    this.cameraOverride?.(camera, dt);
    world.update(simPaused ? dt : simDt, camera);
    this.updateLens(dt);
    // Cinematic shots are seen from outside the suit: no helmet HUD over them
    const cinematic = game.rig.mode === 'flyby';
    const hudGoal = director ? director.hud : cinematic ? 0 : this.engaged ? 1 : this.hudGoal;
    hud.alpha += (hudGoal - hud.alpha) * (1 - Math.exp(-dt / 0.6));
    if (this.touch) {
      this.touch.setActive(this.engaged && !this.paused && !director && !this.autopilot);
      this.touch.setWaveReady(game.combat.waveReady || game.combat.redeployReady);
      this.touch.setLandReady(game.autoLand || game.autoLandReady);
      this.touch.setRefitReady(game.onPad || game.combat.redeployReady);
      hud.bottomInset = this.touch.bottomInset;
      hud.minScale = 0.55;
    }
    hud.jets = game.driver.outputs;
    const { w: vw, h: vh } = this.view;
    hud.sun.set(this.lens.sunUv.x * vw, (1 - this.lens.sunUv.y) * vh, this.lens.sunVis);
    hud.autoLand = !this.engaged || director ? null : game.autoLand ? 'active' : game.autoLandReady ? 'ready' : null;
    // TEMP: the take-off prompt (touch screens have their own stick mapping)
    hud.takeoff = this.engaged && !this.paused && !director && !this.autopilot && !this.touch && game.model.grounded && !game.autoLand && !game.autoLandReady;
    const live = this.engaged && !this.paused && !director && !this.autopilot;
    const refit = live && (game.onPad || game.combat.redeployReady);
    // (between waves, off the pad with an upgrade to buy: called home to fit it)
    const home = live && !refit && game.combat.autoWaveIn !== null && this.upgrades.affordable;
    hud.refitHint = refit
      ? `${this.touch ? 'REFIT' : 'U'} — R&D BAY · ${this.upgrades.state.rd} R&D`
      : home
        ? `RETURN TO THE PAD TO REFIT · ${this.upgrades.state.rd} R&D`
        : null;
    hud.duel = this.multiplayer?.duel ?? null;
    hud.draw(dt, camera, game.model, game.combat, game.ground, game.rig.mode === 'helmet');
    this.missionHud.update(camera, game.model.pos, this.missions.telemetry, this.engaged && !director && !cinematic);
    // (the wingman's marker never sits over a menu: pause, refit, missions or the uplink drawer)
    this.multiplayerHud?.update(camera, game.model.pos, this.engaged && !director && !cinematic, this.paused || this.opts.screens.paused);
    this.sounds.variant = game.suitVariant;
    this.sounds.update(dt, game.model, game.combat, camera, game.rig.mode === 'helmet', game.combat.weapons.unibeamOn);
    // The wingman's sonic boom, as their Mach cone sweeps over the ear
    const peer = this.multiplayer?.peer;
    this.hearPeer(dt, camera);
    this.sounds.wingman(peer && peer.mesh.visible ? peer.pos : null, peer?.vel ?? game.model.vel, peer?.mach ?? 0);
    this.post.render(dt, this.lens);
  }

  /**
   * The R&D ledger on the suit: every system reads the one live spec, the
   * sim's events pay out (not in a directed reel), and the pause menu
   * refits on the pad or once the suit is lost.
   */
  private bindUpgrades(): void {
    const { game, upgrades } = this;
    const { combat } = game;
    combat.spec = combat.weapons.spec = game.model.spec = upgrades.spec;
    // A refit fits what it adds at once (another reserve, a bigger drum)
    // and takes away what it removes; points coming in change nothing.
    // (Counted from the stock suit's full load, so a saved build starts full)
    let reserves = combat.reserves;
    let flares = combat.weapons.flares;
    const sync = () => {
      const W = combat.weapons;
      combat.fittedLevels = upgrades.fitted;
      if (!combat.lost) combat.reserves = Math.max(0, Math.min(combat.maxReserves, combat.reserves + combat.maxReserves - reserves));
      W.flares = Math.max(0, Math.min(W.flareMag, W.flares + W.flareMag - flares));
      reserves = combat.maxReserves;
      flares = W.flareMag;
    };
    upgrades.onChange(sync);
    sync();
    combat.refitDue = () => !game.onPad && upgrades.affordable;
    upgrades.onAward = (points, reason) => game.events.emit('rdAward', { value: points, text: reason });
    game.events.on((e) => {
      if (!this.director && !this.autopilot) upgrades.event(e);
    });
    this.opts.screens.setRefit({
      upgrades,
      gate: () => (combat.lost || game.onPad ? null : 'SET DOWN ON THE PAD TO REFIT'),
      // (a lost run's house comes back whole with the redeploy: nothing to buy)
      house: { hp: () => (combat.lost || combat.wave < 0 ? null : combat.houseHp), repair: (share) => void (this.multiplayer?.repairHouse(share) || combat.repairHouse(share)) },
    });
  }

  /** Wires standalone JARVIS missions + launcher drawer cleanly on top of free flight. */
  private bindMissions(): void {
    const { game, world, upgrades, screens } = this;
    this.missions = new MissionManager({
      model: game.model,
      world: {
        get inCloud() {
          return world.inCloud;
        },
        heightAt: (x, z) => world.field.heightAt(x, z),
        surface: (x, z) => game.ground.surface(x, z),
        isWater: (x, z) => game.ground.isWater(x, z),
      },
      combat: game.combat,
      particles: game.particles,
      events: game.events,
      padPos: new THREE.Vector3(PAD.x, PAD_Y, PAD.y),
      hazeUniforms: world.atmosphere.uniforms,
      awardRd: (points, reason) => {
        if (!this.director && !this.autopilot) upgrades.earn(points, reason);
      },
      playCue: (cue) => {
        if (cue === 'start') this.cue('waveStart', 0.75);
        else if (cue === 'warning') this.cue('rwrChirp', 0.55);
        else if (cue === 'lock') this.cue('rwrPulse', 0.7);
        else if (cue === 'ping') this.cue('ping2', 0.6);
        else if (cue === 'success') this.cue('waveClear', 0.8);
        else if (cue === 'fail') this.cue('deepBoom', 0.7);
      },
    });
    this.scene.add(this.missions.group);

    const closeDrawer = () => {
      this.missionHud.setOpen(false);
      this.paused = false;
      this.audio.setPaused(false);
      if (!this.touch) this.input?.requestLock();
    };
    this.missionHud = new MissionHud(this.missions, {
      onRequestOpen: () => this.openMissionsMenu(),
      onClose: closeDrawer,
      onLaunch: (id) => {
        this.missions.startMission(id);
        closeDrawer();
      },
      onAbort: () => this.missions.abortMission(),
    });
    screens.actions.openMissions = () => this.openMissionsMenu();
    game.events.on((e) => {
      if (e.kind === 'redeploy') this.missions.abortMission(true);
    });
  }

  /** Opens the JARVIS Mission Selector drawer, holding the sim without stacking the pause screen. */
  openMissionsMenu(): void {
    if (!this.engaged || this.director || this.autopilot || this.game.combat.lost) return;
    if (this.multiplayerHud?.open) this.multiplayerHud.setOpen(false);
    if (this.missionHud.open) {
      this.missionHud.setOpen(false);
      this.paused = false;
      this.audio.setPaused(false);
      if (!this.touch) this.input?.requestLock();
      return;
    }
    this.paused = true;
    this.audio.setPaused(true);
    this.missionHud.setOpen(true);
    this.input?.releaseLock();
  }

  /** The other pilot's full suit sounds: its weapons' and jets' events, and its loops from where it flies. */
  private hearPeer(dt: number, camera: THREE.PerspectiveCamera): void {
    const peer = this.multiplayer?.peer as
      | (NonNullable<MultiplayerSession['peer']> & { events?: EventBus; model?: FlightModel; weapons?: { unibeamOn?: boolean }; reactor?: { mode: string; overchargeActive: boolean } })
      | null
      | undefined;
    if (!peer?.events || !peer.model) {
      if (this.peerHeard) this.peerSounds.updateRemote(dt, this.game.model, camera.position, { visible: false, beamOn: false });
      this.peerHeard = null;
      return;
    }
    if (this.peerHeard !== peer) {
      this.peerHeard = peer;
      const model = peer.model;
      peer.events.on((e) => {
        if (this.peerHeard === peer) this.peerSounds.on(e, model);
      });
    }
    this.peerSounds.variant = peer.variant;
    this.peerSounds.updateRemote(dt, peer.model, camera.position, {
      visible: peer.mesh.visible,
      beamOn: !!peer.weapons?.unibeamOn,
      mode: peer.reactor?.mode,
      overcharge: peer.reactor?.overchargeActive,
      down: peer.down,
    });
  }

  /** Wires 2-player Iron Man + War Machine multiplayer session & JARVIS lobby drawer. */
  private bindMultiplayer(): void {
    const { game, world, screens, query } = this;
    // The wingman flies a second full rigged suit, built when a room opens
    this.multiplayer = new MultiplayerSession(game, world.atmosphere.uniforms, undefined, { loadSuit: () => Suit.create() });
    this.scene.add(this.multiplayer.group);

    // Apply URL invite parameters (?suit=warmachine&mode=duel&mp=local&room=XXXXX)
    const suitParam = query.get('suit');
    if (suitParam === 'warmachine' || suitParam === 'ironman') {
      this.multiplayer.setSuit(suitParam);
      this.sounds.variant = suitParam;
    }
    const modeParam = query.get('mode');
    if (modeParam === 'duel' || modeParam === 'coop') {
      this.multiplayer.setMode(modeParam);
    }
    if (query.get('mp') === 'local') {
      this.multiplayer.setBackend('local');
    }
    const roomParam = query.get('room');
    if (roomParam) {
      this.multiplayer.joinRoom(roomParam);
    }

    const closeDrawer = () => {
      this.multiplayerHud.setOpen(false);
      this.paused = false;
      this.audio.setPaused(false);
      if (!this.touch) this.input?.requestLock();
    };
    this.multiplayerHud = new MultiplayerHud(this.multiplayer, {
      onRequestOpen: () => this.openMultiplayerMenu(),
      onClose: closeDrawer,
    });
    screens.actions.openMultiplayer = () => this.openMultiplayerMenu();
  }

  /** Opens the JARVIS Multiplayer Uplink drawer (M key or top-left chip). */
  openMultiplayerMenu(): void {
    if (!this.engaged || this.director || this.autopilot) return;
    if (this.missionHud?.open) this.missionHud.setOpen(false);
    if (this.multiplayerHud.open) {
      this.multiplayerHud.setOpen(false);
      this.paused = false;
      this.audio.setPaused(false);
      if (!this.touch) this.input?.requestLock();
      return;
    }
    this.paused = true;
    this.audio.setPaused(true);
    this.multiplayerHud.setOpen(true);
    this.input?.releaseLock();
  }

  /** Optional per-frame observer (frame-time stats). */
  onFrame: ((dtMs: number) => void) | null = null;

  /** Runs the live loop. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.getDelta();
    const loop = () => {
      if (!this.running || !this.visible) return;
      this.raf = requestAnimationFrame(loop);
      const raw = this.clock.getDelta();
      this.onFrame?.(raw * 1000);
      const dt = Math.min(raw, 0.1);
      if (!this.holdResolution && !this.opts.pixelRatio) this.adaptive.update(dt);
      this.frame(dt);
    };
    document.addEventListener('visibilitychange', () => {
      this.visible = document.visibilityState === 'visible';
      cancelAnimationFrame(this.raf);
      if (this.visible && this.running) {
        this.clock.getDelta();
        loop();
      }
    });
    loop();
  }

  /** A non-spatial one-shot from the sim's (library) sound set. */
  cue(name: keyof typeof SFX, gain = 1): void {
    this.audio.play(SFX[name], { ui: true, gain });
  }

  /** Volume the pilot set, times the handoff's fade. */
  applyVolume(): void {
    this.applySettings();
  }

  /** Pilot takes the stick: pointer lock, sound, the shoulder view. */
  engage(line = 'All systems online. Good evening, sir. The coast is yours.'): void {
    void this.audio.unlock().then(() => this.sounds.start());
    this.attachInput().requestLock();
    this.engaged = true;
    this.handoffPilot = null;
    this.cameraOverride = null;
    this.game.rig.mode = DEFAULT_CAMERA;
    if (line) this.game.events.emit('jarvis', { text: line });
  }

  /** Click-to-relock and Esc-to-pause, once the pilot is flying. */
  bindPointerLock(): void {
    const { canvas, screens } = this.opts;
    canvas.addEventListener('click', () => {
      if (this.engaged && !this.paused) this.input?.requestLock();
    });
    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === canvas;
      if (this.engaged && !locked && !this.autopilot && !this.director) {
        if (this.missionHud?.open || this.multiplayerHud?.open) return;
        this.paused = true;
        this.audio.setPaused(true);
        screens.setPaused(true, () => this.input?.requestLock());
      } else if (locked) {
        this.paused = false;
        this.missionHud?.setOpen(false);
        this.multiplayerHud?.setOpen(false);
        screens.setPaused(false, () => {});
        this.audio.setPaused(false);
        void this.audio.unlock();
      }
    });
  }

  /** Debug / test hooks (window.__flight). */
  hooks(): Record<string, unknown> {
    const { game } = this;
    return {
      THREE,
      app: this,
      post: this.post,
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      world: this.world,
      game,
      suit: this.suit,
      hud: this.hud,
      missions: this.missions,
      multiplayer: this.multiplayer,
      audio: this.audio,
      lens: this.lens,
      setAutopilot: (fn: FlightApp['autopilot']) => {
        this.autopilot = fn;
        this.engaged = true;
        this.handoffPilot = null;
        this.cameraOverride = null;
        game.rig.mode = 'chase';
        this.opts.screens.hideTitle();
      },
      /** Drop the suit into flight somewhere (tests, captures). */
      teleport: (x: number, y: number, z: number, heading: number, speed: number) => {
        const m = game.model;
        m.pos.set(x, y, z);
        m.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
        m.vel.set(Math.sin(heading), 0, Math.cos(heading)).multiplyScalar(speed);
        m.grounded = false;
        m.flightness = speed > 30 ? 1 : 0;
        m.posture = speed > 30 ? 1.42 : 0;
        m.speedCmd = speed;
        game.rig.lookHeading(heading, -0.08);
      },
    };
  }
}
