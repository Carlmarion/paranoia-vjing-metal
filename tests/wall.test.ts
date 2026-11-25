import { describe, expect, test } from 'vitest';
import { History, WALL_HISTORY_S, cellAspect, cellDelays, cellRects, cellSteps } from '../src/display/wall';

describe('cell rectangles', () => {
  test.each([[1000, 563, 3, 2], [1000, 563, 7, 8], [1920, 1080, 1, 1]])('%i×%i in %i×%i tiles the buffer exactly', (w, h, cols, rows) => {
    const r = cellRects(w, h, cols, rows);
    expect(r).toHaveLength(cols * rows);
    expect(r.reduce((a, [, , cw, ch]) => a + cw * ch, 0)).toBe(w * h);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const [x, y, cw, ch] = r[row * cols + col];
        expect(cw).toBeGreaterThan(0);
        if (col + 1 < cols) expect(r[row * cols + col + 1][0]).toBe(x + cw);
        else expect(x + cw).toBe(w);
        if (row + 1 < rows) expect(r[(row + 1) * cols + col][1] + r[(row + 1) * cols + col][3]).toBe(y); // next row is below
        else expect(y).toBe(0);
        if (row === 0) expect(y + ch).toBe(h); // the first row is the top one
      }
    }
  });
});

describe('cell steps', () => {
  test('rows: reading order', () => {
    expect(cellSteps(3, 2, 0, 1)).toEqual([0, 1, 2, 3, 4, 5]);
  });
  test('snake: odd rows run right to left', () => {
    expect(cellSteps(3, 2, 1, 1)).toEqual([0, 1, 2, 5, 4, 3]);
  });
  test('centre: the middle first, ring by ring', () => {
    expect(cellSteps(4, 4, 2, 1)).toEqual([1, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 1]);
    expect(cellSteps(3, 3, 2, 1)).toEqual([1, 1, 1, 1, 0, 1, 1, 1, 1]);
  });
  test('diagonal: from the top-left corner', () => {
    expect(cellSteps(3, 2, 3, 1)).toEqual([0, 1, 2, 1, 2, 3]);
  });
  test('random: a fixed shuffle per seed and size', () => {
    const a = cellSteps(4, 3, 4, 7);
    expect([...a].sort((x, y) => x - y)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(cellSteps(4, 3, 4, 7)).toEqual(a);
    expect(cellSteps(4, 3, 4, 8)).not.toEqual(a);
    expect(cellSteps(3, 4, 4, 7)).not.toEqual(a);
    expect(a).not.toEqual(cellSteps(4, 3, 0, 7));
  });
  test('a 1×1 wall has one cell with no delay', () => {
    for (const w of [0, 1, 2, 3, 4] as const) expect(cellSteps(1, 1, w, 3)).toEqual([0]);
  });
});

describe('cell delays', () => {
  test('step × delay', () => {
    const d = cellDelays([0, 1, 2], 0.12);
    expect(d[0]).toBe(0);
    expect(d[1]).toBeCloseTo(0.12, 12);
    expect(d[2]).toBeCloseTo(0.24, 12);
  });
  test('the last cell is never more than WALL_HISTORY_S late: all delays shrink to fit', () => {
    const d = cellDelays(Array.from({ length: 64 }, (_, i) => i), 1);
    expect(WALL_HISTORY_S).toBe(6);
    expect(Math.max(...d)).toBeCloseTo(6, 12);
    expect(d[21]).toBeCloseTo(2, 12);
  });
});

describe('cell aspect', () => {
  test('half-extents of one cell in units of its short side', () => {
    expect(cellAspect(1920, 1080, 1, 1)).toEqual({ ax: 1920 / 1080, ay: 1 });
    expect(cellAspect(1920, 1080, 4, 1)).toEqual({ ax: 1, ay: 1080 / 480 });
  });
});

describe('history', () => {
  test('the newest entry at or before t; the oldest when t is too early; null when empty', () => {
    const h = new History<string>(6);
    expect(h.at(1)).toBeNull();
    h.push(1, 'a'); h.push(2, 'b'); h.push(3, 'c');
    expect(h.at(2.5)).toBe('b');
    expect(h.at(2)).toBe('b');
    expect(h.at(9)).toBe('c');
    expect(h.at(0)).toBe('a');
  });
  test('forgets what is older than its span, and everything on clear', () => {
    const h = new History<number>(6);
    for (let t = 0; t <= 20; t++) h.push(t, t);
    expect(h.at(0)).toBe(14);
    expect(h.at(17.2)).toBe(17);
    h.clear();
    expect(h.at(20)).toBeNull();
  });
});
