import { describe, expect, test } from 'vitest';
import { BLANK_D, bakeMask, blankHalf, downsample2, fromHalf, signedField, toHalf } from '../src/shared/sdf';

/** R × R mask holding one disc (pixel centres within r of (cx, cy)). */
function discMask(R: number, cx: number, cy: number, r: number): Uint8Array {
  const m = new Uint8Array(R * R);
  for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
    if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r) m[y * R + x] = 1;
  }
  return m;
}

describe('signed field (B12.4)', () => {
  test('a centred disc matches the analytic distance within 1 px, negative inside', () => {
    const R = 256;
    const c = R / 2, r = 50;
    const f = signedField(discMask(R, c, c, r), R);
    const px = 2 / R; // motif units per pixel
    let worst = 0;
    for (let y = 0; y < R; y += 3) for (let x = 0; x < R; x += 3) {
      const analytic = (Math.hypot(x + 0.5 - c, y + 0.5 - c) - r) * px;
      worst = Math.max(worst, Math.abs(f[y * R + x] - analytic));
    }
    expect(worst).toBeLessThanOrEqual(px);
    expect(f[c * R + c]).toBeLessThan(0);
    expect(f[0]).toBeGreaterThan(0);
  });

  test('a blank mask gives the constant +2; an all-ink mask the constant −2', () => {
    const R = 32;
    expect(new Set(signedField(new Uint8Array(R * R), R))).toEqual(new Set([BLANK_D]));
    expect(new Set(signedField(new Uint8Array(R * R).fill(1), R))).toEqual(new Set([-BLANK_D]));
  });

  test('row 0 of the field is the top of the mask', () => {
    const R = 64;
    const f = signedField(discMask(R, 32, 8, 4), R); // ink near the top
    expect(f[8 * R + 32]).toBeLessThan(0);
    expect(f[56 * R + 32]).toBeGreaterThan(0);
  });
});

describe('downsample and float16', () => {
  test('the 2×2 downsample is the mean', () => {
    const f = new Float32Array([1, 3, 5, 7, 2, 4, 6, 8, 0, 0, 1, 1, 0, 0, 1, 1]);
    expect(Array.from(downsample2(f, 4))).toEqual([2.5, 6.5, 0, 1]);
  });

  test('float16 round-trip of |d| ≤ 2 is within 2e-3; exact for representable values', () => {
    for (let d = -2; d <= 2; d += 0.0137) expect(Math.abs(fromHalf(toHalf(d)) - d)).toBeLessThanOrEqual(2e-3);
    for (const v of [0, 0.5, -1, 2, -2, 1.5]) expect(fromHalf(toHalf(v))).toBe(v);
    expect(toHalf(2 ** -25 * 1.5)).toBe(1); // 0.75 of the smallest subnormal rounds up to it
    expect(toHalf(2 ** -26)).toBe(0); // 0.25 of it rounds down
  });

  test('blankHalf is +2 everywhere', () => {
    const b = blankHalf(8);
    expect(b).toHaveLength(64);
    expect(new Set(Array.from(b, fromHalf))).toEqual(new Set([BLANK_D]));
  });
});

describe('bake budget (B12.4)', () => {
  test('a 1024² mask bakes to a 512² float16 cell in under 60 ms', () => {
    const R = 1024;
    // a ring of ink, as complex as a real motif for the transform
    const m = discMask(R, 512, 512, 380);
    const hole = discMask(R, 512, 512, 330);
    for (let i = 0; i < m.length; i++) m[i] = m[i] && !hole[i] ? 1 : 0;
    bakeMask(m, R); // warm-up (JIT)
    const t0 = performance.now();
    const half = bakeMask(m, R);
    const ms = performance.now() - t0;
    expect(half).toHaveLength(512 * 512);
    expect(ms).toBeLessThan(60);
  });
});
