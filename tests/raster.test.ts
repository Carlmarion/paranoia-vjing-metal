import { describe, expect, test } from 'vitest';
import { drawStrokes, inkMask, toPx, type StrokeCtx } from '../src/shared/raster';
import { BRUSH, parseShapes, parseStrokes, type Stroke } from '../src/shared/strokes';

/** Records the calls a 2D context receives. */
class FakeCtx implements StrokeCtx {
  calls: string[] = [];
  globalCompositeOperation: GlobalCompositeOperation = 'source-over';
  lineWidth = 1;
  lineCap: CanvasLineCap = 'butt';
  lineJoin: CanvasLineJoin = 'miter';
  strokeStyle: string = '#000';
  beginPath() { this.calls.push('begin'); }
  moveTo(x: number, y: number) { this.calls.push(`M${x.toFixed(1)},${y.toFixed(1)}`); }
  lineTo(x: number, y: number) { this.calls.push(`L${x.toFixed(1)},${y.toFixed(1)}`); }
  stroke() { this.calls.push(`stroke:${this.globalCompositeOperation}`); }
}

const st = (pts: number[], erase = false, group = 0): Stroke => ({ pts: new Float32Array(pts), erase, group });

describe('raster (B12.4)', () => {
  test('motif units map to pixels with y up: y = +0.8 lands in the top rows', () => {
    expect(toPx(-1, 1, 1000)).toEqual([0, 0]);
    expect(toPx(1, -1, 1000)).toEqual([1000, 1000]);
    expect(toPx(0, 0.8, 1000)[1]).toBeCloseTo(100, 9);
  });

  test('round brush of BRUSH diameter; eraser strokes paint destination-out, in order', () => {
    const c = new FakeCtx();
    drawStrokes(c, [st([0, 0, 0.5, 0]), st([0, 0.5, 0, -0.5], true), st([0.1, 0.1])], 1000);
    expect(c.lineWidth).toBeCloseTo((BRUSH * 1000) / 2, 9);
    expect(c.lineCap).toBe('round');
    expect(c.lineJoin).toBe('round');
    expect(c.calls.filter((x) => x.startsWith('stroke'))).toEqual(['stroke:source-over', 'stroke:destination-out', 'stroke:source-over']);
    expect(c.globalCompositeOperation).toBe('source-over');
  });

  test('a one-point stroke still draws a dot', () => {
    const c = new FakeCtx();
    drawStrokes(c, [st([0.2, 0.2])], 100);
    expect(c.calls.some((x) => x.startsWith('L'))).toBe(true);
  });

  test('consecutive ink strokes share one path', () => {
    const c = new FakeCtx();
    drawStrokes(c, [st([0, 0, 0.1, 0]), st([0.2, 0, 0.3, 0]), st([0.4, 0, 0.5, 0])], 100);
    expect(c.calls.filter((x) => x === 'begin')).toHaveLength(1);
  });

  test('ink = alpha ≥ 128', () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 127, 0, 0, 0, 128, 9, 9, 9, 255, 0, 0, 0, 0]);
    expect(Array.from(inkMask(rgba, 2))).toEqual([0, 1, 1, 0]);
  });
});

describe('parsing strokes from the channel or a file', () => {
  test('accepts Float32Array or plain arrays; rejects malformed strokes', () => {
    const ok = parseStrokes([{ pts: [0, 0, 0.5, 0.5], erase: false, group: 2 }, { pts: new Float32Array([0.1, 0.1]), erase: true, group: 3 }]);
    expect(ok).not.toBeNull();
    expect(ok![0].pts).toBeInstanceOf(Float32Array);
    expect(ok![1].erase).toBe(true);
    for (const bad of [null, {}, [{ pts: [0] }], [{ pts: [0, NaN], erase: false, group: 0 }], [{ pts: [], erase: false, group: 0 }], [{ pts: [0, 0], erase: 1, group: 0 }]]) {
      expect(parseStrokes(bad)).toBeNull();
    }
  });

  test('shapes file: name, strokes, skipping broken entries', () => {
    const shapes = parseShapes({ shapes: [{ name: 'Fan', strokes: [{ pts: [0, 0], erase: false, group: 0 }] }, { name: 3 }, 'x'] });
    expect(shapes).toEqual([{ name: 'Fan', strokes: [{ pts: new Float32Array([0, 0]), erase: false, group: 0 }] }]);
    expect(parseShapes([{ name: 'Bare', strokes: [] }])).toEqual([{ name: 'Bare', strokes: [] }]);
    expect(parseShapes('nope')).toEqual([]);
  });
});
