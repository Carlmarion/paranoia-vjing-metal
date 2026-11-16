import { describe, expect, test } from 'vitest';
import {
  BRUSH, SYMMETRIES, groupLength, maskStats, pathLength, pointCount, sliceStrokes, smoothPoint, symmetrize,
  type Stroke,
} from '../src/shared/strokes';

const stroke = (pts: number[], group = 0, erase = false): Stroke => ({ pts: new Float32Array(pts), erase, group });

describe('smoothing (B12.1)', () => {
  test('a straight raw line stays straight and lags by at most one sample spacing', () => {
    const s = 0.01;
    let prev: [number, number] | null = null;
    for (let i = 0; i < 200; i++) {
      const raw: [number, number] = [-0.8 + i * s, 0.3 - i * s]; // a diagonal line
      const p = smoothPoint(prev, raw, 0.001);
      expect(p).not.toBeNull();
      prev = p!;
      expect(prev[0] + prev[1]).toBeCloseTo(-0.5, 9); // still on x + y = −0.5
      expect(Math.hypot(raw[0] - prev[0], raw[1] - prev[1])).toBeLessThanOrEqual(Math.hypot(s, s) + 1e-9);
    }
  });

  test('the first point is stored as is; points closer than minDist are dropped', () => {
    const first = smoothPoint(null, [0.2, 0.4], 0.01);
    expect(first).toEqual([0.2, 0.4]);
    expect(smoothPoint(first, [0.205, 0.4], 0.01)).toBeNull();
    expect(smoothPoint(first, [0.3, 0.4], 0.01)).toEqual([0.25, 0.4]);
  });
});

describe('symmetry (B12.1)', () => {
  const pt = new Float32Array([0.5, 0.2]);
  test('free gives the stroke alone', () => {
    expect(symmetrize(pt, 'free')).toHaveLength(1);
  });
  test('X mirror negates x only', () => {
    const out = symmetrize(pt, 'x');
    expect(out).toHaveLength(2);
    expect(Array.from(out[1])).toEqual([-0.5, Float32Array.of(0.2)[0]]);
  });
  test('Y mirror negates y only; XY gives the four reflections', () => {
    expect(Array.from(symmetrize(pt, 'y')[1])).toEqual([0.5, Float32Array.of(-0.2)[0]]);
    const xy = symmetrize(pt, 'xy').map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).sort();
    expect(xy).toEqual(['-0.50,-0.20', '-0.50,0.20', '0.50,-0.20', '0.50,0.20']);
  });
  test('R6 gives 6 points at the same radius, 60° apart', () => {
    const out = symmetrize(pt, 'r6');
    expect(out).toHaveLength(6);
    const r = Math.hypot(0.5, 0.2);
    const angles = out.map((p) => Math.atan2(p[1], p[0]));
    out.forEach((p) => expect(Math.hypot(p[0], p[1])).toBeCloseTo(r, 6));
    for (let k = 1; k < 6; k++) {
      const d = (((angles[k] - angles[0]) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      expect(d).toBeCloseTo((k * Math.PI) / 3, 5);
    }
  });
  test('every mode is listed and copies every point', () => {
    expect(SYMMETRIES).toEqual(['free', 'x', 'y', 'xy', 'r4', 'r6', 'r8']);
    const line = new Float32Array([0, 0, 0.1, 0.1, 0.2, 0.3]);
    for (const m of SYMMETRIES) for (const c of symmetrize(line, m)) expect(c.length).toBe(line.length);
  });
});

describe('path slicing (B12.6)', () => {
  // group 0: one stroke of length 1; group 1: two mirrored copies of length 0.5; group 2: an eraser dot
  const strokes: Stroke[] = [
    stroke([0, 0, 1, 0], 0),
    stroke([0, 0.5, 0.5, 0.5], 1),
    stroke([0, -0.5, -0.5, -0.5], 1),
    stroke([0.3, 0.3], 2, true),
  ];
  const L = pathLength(strokes);

  test('copies of a symmetry group grow together: the path length counts each group once', () => {
    expect(L).toBeCloseTo(1.5, 9);
    expect(groupLength(strokes.slice(1, 3))).toBeCloseTo(0.5, 9);
  });

  test('the prefix at q × L has length q × L, monotonic, and q = 1 is the whole list', () => {
    let prevLen = -1;
    for (let i = 0; i <= 20; i++) {
      const q = i / 20;
      const pre = sliceStrokes(strokes, q * L);
      const len = pathLength(pre);
      expect(len).toBeCloseTo(q * L, 6);
      expect(len).toBeGreaterThanOrEqual(prevLen);
      prevLen = len;
    }
    const all = sliceStrokes(strokes, L);
    expect(all).toHaveLength(strokes.length);
    all.forEach((s, i) => expect(Array.from(s.pts)).toEqual(Array.from(strokes[i].pts)));
  });

  test('mid-group, every copy is cut at the same length', () => {
    const pre = sliceStrokes(strokes, 1.25); // half of group 1
    expect(pre).toHaveLength(3);
    expect(pre[1].pts[2]).toBeCloseTo(0.25, 6);
    expect(pre[2].pts[2]).toBeCloseTo(-0.25, 6);
  });

  test('q = 0 gives nothing; point count adds up', () => {
    expect(sliceStrokes(strokes, 0)).toHaveLength(0);
    expect(pointCount(strokes)).toBe(7);
  });
});

describe('mask stats (B12.1 readout)', () => {
  test('coverage of a known disc is within 2% of its area; centroid at its centre', () => {
    const n = 512;
    const mask = new Uint8Array(n * n);
    const cx = 300.5, cy = 200.5, r = 80;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r) mask[y * n + x] = 1;
    }
    const st = maskStats(mask, n);
    const area = (Math.PI * r * r) / (n * n);
    expect(Math.abs(st.coverage - area) / area).toBeLessThan(0.02);
    expect(st.centroid[0]).toBeCloseTo(cx / n, 3);
    expect(st.centroid[1]).toBeCloseTo(cy / n, 3);
    expect(st.inMargin).toBe(false);
  });

  test('ink in the outer 10% is flagged; an empty mask has zero coverage', () => {
    const n = 100;
    const mask = new Uint8Array(n * n);
    mask[5 * n + 50] = 1;
    expect(maskStats(mask, n).inMargin).toBe(true);
    expect(maskStats(new Uint8Array(n * n), n).coverage).toBe(0);
  });

  test('the brush is the thick placeholder weight: 100 px at 2048', () => {
    expect(BRUSH * 1024).toBeCloseTo(100, 9);
  });
});
