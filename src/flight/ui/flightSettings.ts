import type * as THREE from 'three';
import type { FlightApp } from '../app';
import type { Quality, Settings } from './screens';

/**
 * Wires the pause menu into a built FlightApp (one call from
 * FlightApp.build): the menu's buttons drive the sim, the audio sliders set
 * the mix and the graphics preset caps the resolution.
 */

/** Ceiling on the drawing-buffer pixel ratio per preset (on top of the adaptive guard). */
export const QUALITY_DPR: Record<Quality, number> = { low: 0.7, medium: 1, high: 1.25, ultra: Infinity };

/**
 * Ground detail per preset: how far the terrain's close-up grain and micro
 * relief carry (× the base 900 m / 260 m) and the anisotropic filtering on
 * its detail textures. Per-pixel cost only, so the adaptive resolution
 * still answers for the frame time.
 */
export const QUALITY_GROUND: Record<Quality, { reach: number; anisotropy: number }> = {
  low: { reach: 0.75, anisotropy: 1 },
  medium: { reach: 0.9, anisotropy: 4 },
  high: { reach: 1.15, anisotropy: 4 },
  ultra: { reach: 1.35, anisotropy: 8 },
};

/** HDR scene MSAA samples per preset (low skips multisample resolve for fill-rate speed). */
export const QUALITY_SAMPLES: Record<Quality, number> = {
  low: 0,
  medium: 2,
  high: 4,
  ultra: 4,
};

/** LOD distance/density scale per preset (also forms the ceiling for adaptive LOD scaling). */
export const QUALITY_LOD: Record<Quality, number> = {
  low: 0.58,
  medium: 0.75,
  high: 0.85,
  ultra: 0.95,
};

export function bindFlightSettings(app: FlightApp): void {
  const { screens, game, audio, renderer, resolution } = app;
  const applyWorldLod = (s: number) => {
    const { world } = app;
    (world.terrain as { setLodScale?: (v: number) => void }).setLodScale?.(s);
    (world.vegetation as { setLodScale?: (v: number) => void }).setLodScale?.(s);
    world.ocean.setLodScale(s);
    world.clouds.setLodScale(s);
  };
  // ── Graphics preset: cap whatever the adaptive resolution asks for ──
  let cap = Infinity;
  const setPixelRatio = resolution.setPixelRatio;
  resolution.setPixelRatio = (v: number) => setPixelRatio(Math.min(v, cap));
  let quality: Quality | null = null;
  const applyQuality = (q: Quality) => {
    if (q === quality) return;
    const first = quality === null;
    quality = q;
    const touch = screens.touch;
    cap = QUALITY_DPR[q];
    const ground = QUALITY_GROUND[q];
    app.world.terrain.setDetail(
      touch ? ground.reach * 0.85 : ground.reach,
      touch ? Math.min(ground.anisotropy, 2) : ground.anisotropy,
      renderer,
    );
    app.post?.setSamples(QUALITY_SAMPLES[q]);
    app.post?.setLowCost(q === 'low');
    app.post?.setHalfBloom(q === 'low' || (touch && q === 'medium'));
    app.post?.setBilinearUpscale(q === 'low' || touch);
    const lod = QUALITY_LOD[q];
    applyWorldLod(lod);
    app.setPresetLodScale(lod, applyWorldLod);
    app.setMaxAdaptiveDpr(Math.min(app.maxDpr, cap));
    const shadows = q !== 'low';
    const shadowSize = !shadows ? 0 : q === 'medium' || (touch && q === 'high') ? 1024 : 2048;
    app.world.atmosphere.setShadowSize(shadowSize);
    if (renderer.shadowMap.enabled !== shadows) {
      renderer.shadowMap.enabled = shadows;
      // Programs are keyed on shadows: rebuild them
      app.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        for (const mat of Array.isArray(m) ? m : m ? [m] : []) mat.needsUpdate = true;
      });
    }
    // LOW (and touch devices, where fill rate matters most) drop the canvas itself
    // to the active DPR cap so the final pass never runs at a higher ratio than the scene
    app.setOutputDpr(q === 'low' || touch ? Math.min(app.maxDpr, cap) : app.sharpDpr);
    // Down at once (through the cap); back up as the adaptive guard allows
    const want = q === 'ultra' ? app.maxDpr : Math.min(app.maxDpr, cap);
    if (!first || q !== 'ultra') {
      setPixelRatio(Math.min(want, cap));
      window.dispatchEvent(new Event('resize'));
    }
  };

  const apply = (s: Settings) => {
    applyQuality(s.quality);
    audio.setEffectsLevel(s.sfx);
  };
  screens.addSettingsListener(apply);
  apply(screens.settings);

  // ── Pause menu actions ──
  screens.actions = {
    cycleCamera: () => game.rig.cycle(),
    cameraName: () => game.rig.mode,
    forceResume: () => {
      app.paused = false;
      audio.setPaused(false);
      screens.setPaused(false, () => {});
    },
  };

  // ── Pausing without the pointer lock to lose: Esc (flying on after a
  // refused re-lock) or Start on a pad. The menu takes over from there ──
  const pause = () => {
    if (!app.engaged || app.paused || screens.paused || app.director || app.autopilot) return;
    app.paused = true;
    audio.setPaused(true);
    app.input?.releaseLock();
    window.dispatchEvent(new Event('flight:paused'));
    // Touch: nothing to re-lock, so Resume resumes at once
    screens.setPaused(true, () => (app.touch ? screens.actions.forceResume?.() : app.input?.requestLock()));
  };
  // The on-screen pause button
  app.pauseMenu = pause;
  // U (or REFIT) on the pad: the sim held, straight into the R&D refit bay
  app.refitMenu = () => {
    pause();
    screens.showRefit();
  };
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && !e.repeat && !document.pointerLockElement) pause();
  });
  // Leaving the window (Mission Control, Task View, an app switch) stops
  // the flight even when there's no pointer lock to lose
  window.addEventListener('blur', pause);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') pause();
  });
  let startWas = true;
  const pollStart = () => {
    requestAnimationFrame(pollStart);
    const pad = [...(navigator.getGamepads?.() ?? [])].find((g) => g && g.connected);
    const start = (pad?.buttons[9]?.value ?? 0) > 0.5;
    if (start && !startWas) pause();
    startWas = start;
  };
  window.addEventListener('gamepadconnected', () => requestAnimationFrame(pollStart), { once: true });
}
