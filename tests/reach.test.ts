import { describe, expect, test } from 'vitest';
import { fill, limit, stop, type ReachIn } from '../src/display/reach';

const base: ReachIn = {
  zoom: 1, mirrorShift: 0, mirrorX: false, mirrorY: false, tiltX: 0, tiltY: 0, thickness: 0, spikeAmp: 0, warpAmt: 0,
  glow: 0, glowWidth: 0.12, brightness: 1, meltBulge: 0, radius: 0.8, ax: 16 / 9, ay: 1,
};
const w = (o: Partial<ReachIn>): ReachIn => ({ ...base, ...o });

describe('fill (design §4.3)', () => {
  test('ink fill is zoom × radius over the short side', () => {
    expect(fill(base).ink).toBeCloseTo(0.8, 9);
    expect(fill(w({ zoom: 1.25 })).ink).toBeCloseTo(1, 9);
  });

  test('mirror shift counts only on a mirrored axis, and does not scale with zoom', () => {
    expect(fill(w({ mirrorShift: 0.3 })).ink).toBeCloseTo(0.8, 9);
    expect(fill(w({ mirrorShift: 0.3, mirrorY: true })).ink).toBeCloseTo(1.1, 9);
    expect(fill(w({ mirrorShift: 0.3, mirrorY: true, zoom: 2 })).ink).toBeCloseTo(1.9, 9);
  });

  test('tilt pushes the far side outward', () => {
    expect(fill(w({ tiltY: 0.2 })).ink).toBeGreaterThan(0.8);
  });

  test('thickness, spikes, warp and the melt bulge grow the ink', () => {
    expect(fill(w({ thickness: 0.05, spikeAmp: 0.02, warpAmt: 0.01, meltBulge: 0.02 })).ink)
      .toBeCloseTo(0.8 + 0.05 + 0.02 + 0.01 * Math.SQRT2 + 0.02, 9);
    expect(fill(w({ thickness: -0.02 })).ink).toBeCloseTo(0.8, 9);
  });

  test('glow reaches beyond the ink; no glow → same as ink', () => {
    expect(fill(w({ glow: 0.5 })).glow).toBeGreaterThan(fill(w({ glow: 0.5 })).ink);
    expect(fill(w({ glow: 0.5 })).glow).toBeCloseTo(0.8 + 0.12 * Math.log(0.5 / 0.08), 9);
    expect(fill(w({ glow: 0 })).glow).toBe(fill(w({ glow: 0 })).ink);
  });

  test('a wide window uses its short side for y and its long side for x', () => {
    expect(fill(w({ mirrorX: true, mirrorShift: 0.6 })).ink).toBeCloseTo(Math.max(1.4 / (16 / 9), 0.8), 9);
  });
});

describe('limit', () => {
  test('zoom limit for the ink is where fill reaches 1', () => {
    const l = limit(base, 'zoom', 'ink', 0.5, 3);
    expect(l).toBeCloseTo(1.25, 3);
    expect(fill(w({ zoom: l })).ink).toBeCloseTo(1, 3);
    expect(limit(w({ ax: 1, ay: 1 }), 'zoom', 'ink', 0.5, 3)).toBeCloseTo(1.25, 3);
  });

  test('a taller or wider window never lowers the limit', () => {
    const sq = limit(w({ ax: 1, ay: 1 }), 'zoom', 'ink', 0.5, 3);
    expect(limit(w({ ax: 1, ay: 2 }), 'zoom', 'ink', 0.5, 3)).toBeGreaterThanOrEqual(sq - 1e-6);
    expect(limit(w({ ax: 2, ay: 1 }), 'zoom', 'ink', 0.5, 3)).toBeGreaterThanOrEqual(sq - 1e-6);
  });

  test('glow limit is below the ink limit', () => {
    expect(limit(w({ glow: 0.5 }), 'zoom', 'glow', 0.5, 3)).toBeLessThan(limit(w({ glow: 0.5 }), 'zoom', 'ink', 0.5, 3));
  });

  test('mirror shift limit with mirror Y', () => {
    expect(limit(w({ mirrorY: true }), 'mirrorShift', 'ink', 0, 0.6)).toBeCloseTo(0.2, 3);
  });

  test('never reached → max; always exceeded → min', () => {
    expect(limit(w({ radius: 0.1 }), 'zoom', 'ink', 0.5, 3)).toBe(3);
    expect(limit(w({ radius: 3 }), 'zoom', 'ink', 0.5, 3)).toBe(0.5);
  });
});

describe('edge inputs (Review Focus 1, 2)', () => {
  test('an empty shape has zero fill and no limit', () => {
    const f = fill(w({ radius: 0 }));
    expect(f.ink).toBe(0);
    expect(Number.isFinite(f.glow)).toBe(true);
    expect(limit(w({ radius: 0 }), 'zoom', 'ink', 0.5, 3)).toBe(3);
  });

  test('a zero-size or broken window gives finite results and no limit', () => {
    for (const o of [{ ax: 0, ay: 0 }, { ax: NaN, ay: 1 }, { ax: Infinity, ay: 1 }]) {
      const f = fill(w(o));
      expect(Number.isFinite(f.ink) && Number.isFinite(f.glow)).toBe(true);
      expect(limit(w(o), 'zoom', 'ink', 0.5, 3)).toBe(3);
    }
  });

  test('glow with brightness 0 does not produce NaN', () => {
    expect(Number.isFinite(fill(w({ glow: 0.5, brightness: 0 })).glow)).toBe(true);
  });
});

describe('stop (design §4.4)', () => {
  test('sound stops at the limit, never below the hand, inward is free', () => {
    expect(stop(0.9, 1.2, 1.0)).toBe(1.0);
    expect(stop(1.1, 1.2, 1.0)).toBe(1.1);
    expect(stop(0.9, 0.7, 1.0)).toBe(0.7);
    expect(stop(0.9, 0.95, 1.0)).toBe(0.95);
  });
});
