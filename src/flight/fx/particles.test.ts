import { describe, expect, it } from 'vitest';
import { sortIndicesDesc } from './particles';

describe('sortIndicesDesc', () => {
  it('handles empty and single-element ranges cleanly', () => {
    const order = new Uint32Array([0]);
    const keys = new Float32Array([42]);
    sortIndicesDesc(order, keys, 0);
    expect(order[0]).toBe(0);
    sortIndicesDesc(order, keys, 1);
    expect(order[0]).toBe(0);
  });

  it('sorts index slices in descending key order across small and large counts', () => {
    for (const n of [5, 16, 17, 64, 512]) {
      const order = new Uint16Array(n + 8);
      const keys = new Float32Array(n + 8);
      let seed = 1337 + n;
      for (let i = 0; i < n; i++) {
        order[i] = i;
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        keys[i] = (seed % 1000) / 10;
      }
      // Sentinel items beyond `n` must stay untouched
      order[n] = 999;
      keys[n] = 1e9;

      sortIndicesDesc(order, keys, n);

      for (let i = 1; i < n; i++) {
        expect(keys[order[i - 1]]).toBeGreaterThanOrEqual(keys[order[i]]);
      }
      expect(order[n]).toBe(999);
    }
  });
});
