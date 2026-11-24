import { describe, expect, test } from 'vitest';
import { CORE_REF_DEPTH, handlesFromParams, hitParams, liveSpan, paramsFromHandles, reactsFromHit } from '../src/shared/colour';
import { hsv2rgb, mulberry32 } from '../src/shared/math';

const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps;
/** Distance on the colour wheel. */
const wheel = (a: number, b: number): number => { const d = Math.abs(a - b) % 1; return Math.min(d, 1 - d); };

describe('hsv2rgb (the shader formula)', () => {
  test('primaries and white', () => {
    expect(hsv2rgb(0, 1, 1)).toEqual([1, 0, 0]);
    hsv2rgb(1 / 3, 1, 1).forEach((v, i) => expect(v).toBeCloseTo([0, 1, 0][i], 9));
    hsv2rgb(2 / 3, 1, 1).forEach((v, i) => expect(v).toBeCloseTo([0, 0, 1][i], 9));
    expect(hsv2rgb(0.37, 0, 1)).toEqual([1, 1, 1]);
  });
});

describe('handles ↔ hue, hueDepth (design §7.2)', () => {
  test('default: glow 0.48, core 0.655', () => {
    expect(CORE_REF_DEPTH).toBe(0.03);
    const h = handlesFromParams(0.55, 0.35);
    expect(h.glow).toBeCloseTo(0.48, 9);
    expect(h.core).toBeCloseTo(0.655, 9);
  });

  test('round trip for random params', () => {
    const rng = mulberry32(5);
    for (let i = 0; i < 500; i++) {
      const hue = rng(), depth = rng() * 1.98 - 0.99;
      const back = paramsFromHandles(handlesFromParams(hue, depth), depth);
      expect(wheel(back.hue, hue)).toBeLessThan(1e-9);
      expect(back.hueDepth).toBeCloseTo(depth, 9);
    }
  });

  test('every handle pair gives params in range', () => {
    for (let g = 0; g < 1; g += 0.05) for (let c = 0; c < 1; c += 0.05) for (const prev of [-0.9, 0, 0.9]) {
      const p = paramsFromHandles({ glow: g, core: c }, prev);
      expect(p.hueDepth).toBeGreaterThanOrEqual(-1); expect(p.hueDepth).toBeLessThanOrEqual(1);
      expect(p.hue).toBeGreaterThanOrEqual(0); expect(p.hue).toBeLessThan(1);
    }
  });

  test('moving one handle leaves the other colour where it was', () => {
    const rng = mulberry32(6);
    for (let i = 0; i < 200; i++) {
      const glow = rng(), core = rng();
      const h = handlesFromParams(paramsFromHandles({ glow, core }, 0).hue, paramsFromHandles({ glow, core }, 0).hueDepth);
      expect(wheel(h.glow, glow)).toBeLessThan(1e-9);
      expect(wheel(h.core, core)).toBeLessThan(1e-9);
    }
  });

  test('opposite handles follow the previous sign; equal handles give depth 0 (Review Focus 5)', () => {
    expect(paramsFromHandles({ glow: 0.1, core: 0.6 }, 0.8).hueDepth).toBeCloseTo(1, 9);
    expect(paramsFromHandles({ glow: 0.1, core: 0.6 }, -0.8).hueDepth).toBeCloseTo(-1, 9);
    const a = paramsFromHandles({ glow: 0.1, core: 0.6 }, 0.8);
    expect(paramsFromHandles({ glow: 0.1, core: 0.6 }, a.hueDepth).hueDepth).toBe(a.hueDepth);
    expect(paramsFromHandles({ glow: 0.3, core: 0.3 }, 0.5).hueDepth).toBe(0);
  });
});

describe('liveSpan', () => {
  test('glow to core at the live values', () => {
    let s = liveSpan(0.55, 0.35, 0, 0);
    expect(s.from).toBeCloseTo(0.48, 9);
    expect(s.length).toBeCloseTo(0.175, 9);
    s = liveSpan(0.55, 0.35, 0.06, 0);
    expect(s.length).toBeCloseTo(0.385, 9);
    expect(near(liveSpan(0.55, 0.35, 0, 0.25).from, 0.73)).toBe(true);
    expect(liveSpan(0.5, 1, 0.07, 0).length).toBe(1);
    expect(liveSpan(0.5, -1, 0.07, 0).length).toBe(-1);
  });
});

describe('hit colours (ghost handles)', () => {
  test('a full hit moves hue by react turns and hueDepth by react × 2 (its normalised span), times reactMaster', () => {
    const p = hitParams({ hue: 0.55, hueDepth: 0.35 }, { hue: 0.1, hueDepth: 0.2 }, 1);
    expect(p.hue).toBeCloseTo(0.65, 9);
    expect(p.hueDepth).toBeCloseTo(0.75, 9);
    expect(hitParams({ hue: 0.95, hueDepth: 0.9 }, { hue: 0.1, hueDepth: 0.2 }, 1).hue).toBeCloseTo(0.05, 9);
    expect(hitParams({ hue: 0.5, hueDepth: 0.9 }, { hue: 0, hueDepth: 0.2 }, 1).hueDepth).toBe(1);
    expect(hitParams({ hue: 0.55, hueDepth: 0.35 }, { hue: 0.1, hueDepth: 0.2 }, 0.5).hue).toBeCloseTo(0.6, 9);
  });

  test('reacts from a hit round-trip, the short way round', () => {
    const rest = { hue: 0.9, hueDepth: -0.2 };
    for (const master of [0.5, 1, 2]) {
      const react = { hue: 0.15, hueDepth: 0.1 };
      const back = reactsFromHit(rest, hitParams(rest, react, master), master);
      expect(back?.hue).toBeCloseTo(0.15, 9);
      expect(back?.hueDepth).toBeCloseTo(0.1, 9);
    }
    expect(reactsFromHit(rest, { hue: 0.1, hueDepth: -0.2 }, 1)?.hue).toBeCloseTo(0.2, 9);
  });

  test('reactMaster 0 gives no reacts; results are clamped to −1…1', () => {
    expect(reactsFromHit({ hue: 0, hueDepth: 0 }, { hue: 0.2, hueDepth: 0.5 }, 0)).toBeNull();
    expect(reactsFromHit({ hue: 0, hueDepth: -1 }, { hue: 0.4, hueDepth: 1 }, 0.25)).toEqual({ hue: 1, hueDepth: 1 });
  });
});
