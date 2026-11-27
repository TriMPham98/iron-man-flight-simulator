import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlightApp } from '../app';
import { bindFlightSettings } from './flightSettings';
import type { Quality, Settings } from './screens';

describe('bindFlightSettings mobile/tablet & desktop behavior', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const origWindow = g.window;
  const origDocument = g.document;
  const origEvent = g.Event;

  beforeEach(() => {
    const listeners = new Map<string, Set<(e: unknown) => void>>();
    const makeTarget = () => ({
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: (e: unknown) => void) => {
        listeners.get(type)?.delete(fn);
      },
      dispatchEvent: (e: { type: string }) => {
        for (const fn of listeners.get(e.type) ?? []) fn(e);
        return true;
      },
    });
    const win = makeTarget();
    g.window = win;
    g.document = { ...makeTarget(), visibilityState: 'visible', pointerLockElement: null };
    g.Event = class FakeEvent {
      constructor(readonly type: string) {}
    };
  });

  afterEach(() => {
    g.window = origWindow;
    g.document = origDocument;
    g.Event = origEvent;
  });

  const makeMockApp = (touch: boolean, initialQuality: Quality) => {
    let listener: ((s: Settings) => void) | null = null;
    const settings: Settings = {
      invertY: false,
      sensitivity: 1,
      volume: 0.9,
      sfx: 1,
      quality: initialQuality,
      touchOpacity: 0.75,
      leftHanded: false,
      showFps: true,
      uiScale: 1,
    };
    const calls = {
      detail: [] as Array<{ reach: number; aniso: number }>,
      samples: [] as number[],
      lowCost: [] as boolean[],
      halfBloom: [] as boolean[],
      bilinear: [] as boolean[],
      shadowSize: [] as number[],
      outputDpr: [] as number[],
      lodScale: [] as number[],
      maxAdaptiveDpr: [] as number[],
    };
    let dpr = touch ? 1.35 : 1.75;
    const app = {
      maxDpr: touch ? 1.35 : 1.75,
      sharpDpr: touch ? 1.35 : 2,
      engaged: true,
      paused: false,
      touch: touch ? {} : null,
      director: null,
      autopilot: null,
      input: { releaseLock: vi.fn(), requestLock: vi.fn() },
      audio: { setEffectsLevel: vi.fn(), setPaused: vi.fn() },
      scene: { traverse: vi.fn() },
      renderer: { shadowMap: { enabled: true } },
      resolution: {
        getPixelRatio: () => dpr,
        setPixelRatio: (v: number) => {
          dpr = v;
        },
      },
      game: { reset: vi.fn(), rig: { cycle: vi.fn(), mode: 'chase' } },
      world: {
        terrain: {
          setDetail: (reach: number, aniso: number) => calls.detail.push({ reach, aniso }),
          setLodScale: (s: number) => calls.lodScale.push(s),
        },
        vegetation: { setLodScale: vi.fn() },
        ocean: { setLodScale: vi.fn() },
        clouds: { setLodScale: vi.fn() },
        atmosphere: {
          setShadowSize: (size: number) => calls.shadowSize.push(size),
        },
      },
      post: {
        setSamples: (n: number) => calls.samples.push(n),
        setLowCost: (b: boolean) => calls.lowCost.push(b),
        setHalfBloom: (b: boolean) => calls.halfBloom.push(b),
        setBilinearUpscale: (b: boolean) => calls.bilinear.push(b),
      },
      screens: {
        touch,
        paused: false,
        settings,
        actions: {},
        addSettingsListener: (fn: (s: Settings) => void) => {
          listener = fn;
        },
        setPaused: vi.fn(),
        showRefit: vi.fn(),
      },
      setPresetLodScale: vi.fn(),
      setMaxAdaptiveDpr: (v: number) => calls.maxAdaptiveDpr.push(v),
      setOutputDpr: (v: number) => calls.outputDpr.push(v),
    };
    bindFlightSettings(app as unknown as FlightApp);
    return {
      app,
      calls,
      setQuality: (q: Quality) => {
        settings.quality = q;
        listener?.(settings);
      },
    };
  };

  it('caps outputDpr, anisotropy, shadowSize, and uses half-bloom + bilinear upscale on touch medium', () => {
    const { calls } = makeMockApp(true, 'medium');
    expect(calls.outputDpr.at(-1)).toBe(1);
    expect(calls.halfBloom.at(-1)).toBe(true);
    expect(calls.bilinear.at(-1)).toBe(true);
    expect(calls.shadowSize.at(-1)).toBe(1024);
    expect(calls.detail.at(-1)?.aniso).toBe(2);
    expect(calls.detail.at(-1)?.reach).toBeCloseTo(0.9 * 0.85);
  });

  it('keeps 1024 shadow map and bilinear upscale on touch high while capping outputDpr to 1.25', () => {
    const { calls } = makeMockApp(true, 'high');
    expect(calls.outputDpr.at(-1)).toBe(1.25);
    expect(calls.halfBloom.at(-1)).toBe(false);
    expect(calls.bilinear.at(-1)).toBe(true);
    expect(calls.shadowSize.at(-1)).toBe(1024);
    expect(calls.detail.at(-1)?.aniso).toBe(2);
  });

  it('preserves full desktop fidelity on ultra preset', () => {
    const { calls } = makeMockApp(false, 'ultra');
    expect(calls.outputDpr.at(-1)).toBe(2);
    expect(calls.halfBloom.at(-1)).toBe(false);
    expect(calls.bilinear.at(-1)).toBe(false);
    expect(calls.shadowSize.at(-1)).toBe(2048);
    expect(calls.detail.at(-1)?.aniso).toBe(8);
    expect(calls.detail.at(-1)?.reach).toBe(1.35);
  });

  it('dispatches flight:paused when pausing so touch devices can release the workshop context', () => {
    const onPaused = vi.fn();
    (window as unknown as EventTarget).addEventListener('flight:paused', onPaused);
    const { app } = makeMockApp(true, 'medium');
    (app as unknown as { pauseMenu: () => void }).pauseMenu();
    expect(onPaused).toHaveBeenCalledTimes(1);
  });
});
