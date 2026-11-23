import { describe, expect, test } from 'vitest';
import { fromNorm, paramDef, toNorm } from '../src/shared/params';
import { LOOK_VERSION, defaultLook, migrateLook, serialiseLook } from '../src/shared/state';
import { clamp, clamp01 } from '../src/shared/math';

describe('Look v2 zoom migration (design §4.1)', () => {
  test('v1 Look keeps the same zoom push at its base', () => {
    for (const [base, react] of [[0.85, 0.06], [0.7, 0.5], [1.2, -0.3], [0.5, 0]] as const) {
      const look = migrateLook({ params: { zoom: { base, react, band: 'low', thr: 0, lock: false } } });
      const z = paramDef('zoom');
      const pushed = fromNorm(z, clamp01(toNorm(z, base) + look.params.zoom.react));
      const old = clamp(base + react * 0.9, 0.5, 1.4);
      expect(pushed).toBeCloseTo(Math.max(old, 0.5), 2);
      expect(look.v).toBe(2);
    }
  });

  test('a v1 Look without a stored zoom react keeps the default react', () => {
    expect(migrateLook({ params: { zoom: { base: 1.2 } } }).params.zoom.react).toBe(paramDef('zoom').react);
  });

  test('a v2 Look is not converted again', () => {
    const once = migrateLook({ params: { zoom: { base: 0.85, react: 0.06, band: 'low', thr: 0, lock: false } } });
    expect(migrateLook(JSON.parse(serialiseLook(once))).params.zoom.react).toBe(once.params.zoom.react);
  });

  test('the default Look is v2 and has the new zoom row', () => {
    expect(LOOK_VERSION).toBe(2);
    expect(defaultLook().v).toBe(2);
    expect(defaultLook().params.zoom.react).toBe(0.034);
    expect(paramDef('zoom').scale).toBe('log');
    expect(paramDef('zoom').max).toBe(3);
  });
});
