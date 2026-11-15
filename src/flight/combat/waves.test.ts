import { describe, expect, it } from 'vitest';
import { waveAt } from './waves';

describe('waves', () => {
  it('opens on three drones and nothing else', () => {
    const w = waveAt(0);
    expect(w.drones).toBe(3);
    expect(w.sams + (w.interceptors ?? 0) + (w.bombers ?? 0) + (w.jammers ?? 0)).toBe(0);
    expect(w.frigate || w.boss).toBeFalsy();
  });

  it('brings each new threat in on its own wave, the dreadnought at the tenth', () => {
    const first = (has: (n: number) => boolean) => Array.from({ length: 12 }, (_, n) => n).find(has)! + 1;
    expect(first((n) => !!waveAt(n).interceptors)).toBe(4);
    expect(first((n) => !!waveAt(n).frigate)).toBe(5);
    expect(first((n) => !!waveAt(n).bombers)).toBe(6);
    expect(first((n) => !!waveAt(n).jammers)).toBe(7);
    expect(first((n) => !!waveAt(n).boss)).toBe(10);
  });

  it('keeps growing past the written waves, with a frigate every third and a dreadnought every fifth', () => {
    const count = (n: number) => {
      const w = waveAt(n);
      return w.drones + w.sams + (w.interceptors ?? 0) + (w.bombers ?? 0) + (w.jammers ?? 0);
    };
    expect(count(13)).toBeGreaterThan(count(10));
    expect(waveAt(12).frigate).toBe(true);
    expect(waveAt(14).boss).toBe(true);
    expect(waveAt(14).frigate).toBe(false);
    expect(waveAt(19).boss).toBe(true);
    // Never both capital ships at once
    for (let n = 0; n < 40; n++) expect(waveAt(n).frigate && waveAt(n).boss).toBeFalsy();
  });
});
