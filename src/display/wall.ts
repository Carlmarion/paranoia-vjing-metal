// The wall (design 2026-11-25 §6): the picture repeated as a grid of cells, each a little later than the one
// before it. Cell geometry, the order the wave visits the cells, and the memory of past frames. Pure.
import { randInt, streamRng } from '../shared/math';
import type { WallWave } from '../shared/state';

/** How far back a cell can look, in seconds: the last cell is never later than this. */
export const WALL_HISTORY_S = 6;

/**
 * One rectangle per cell [x, y, w, h] in GL pixels (origin bottom-left), row by row from the TOP row.
 * Edges are at floor(i × size / count), so the cells tile the buffer with no gap.
 */
export function cellRects(w: number, h: number, cols: number, rows: number): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (let row = 0; row < rows; row++) {
    const top = h - Math.floor((row * h) / rows);
    const bottom = h - Math.floor(((row + 1) * h) / rows);
    for (let col = 0; col < cols; col++) {
      const x0 = Math.floor((col * w) / cols);
      out.push([x0, bottom, Math.floor(((col + 1) * w) / cols) - x0, top - bottom]);
    }
  }
  return out;
}

/** Half-extents of one cell in units of its short side (what the zoom zones measure against). */
export function cellAspect(w: number, h: number, cols: number, rows: number): { ax: number; ay: number } {
  const cw = w / cols, ch = h / rows, short = Math.min(cw, ch);
  return { ax: cw / short, ay: ch / short };
}

/** A fixed shuffle of 0…n−1 for a given seed and wall size, on its own random stream. */
function shuffled(cols: number, rows: number, seed: number): number[] {
  const rng = streamRng(seed + cols * 8 + rows, 'wall');
  const out = Array.from({ length: cols * rows }, (_, i) => i);
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The step at which the wave reaches each cell (same order as cellRects).
 * 0 rows (reading order) · 1 snake · 2 centre outward · 3 diagonal · 4 random.
 */
export function cellSteps(cols: number, rows: number, wave: WallWave, seed: number): number[] {
  if (wave === 4) return shuffled(cols, rows, seed);
  const out: number[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      switch (wave) {
        case 0: out.push(row * cols + col); break;
        case 1: out.push(row * cols + (row % 2 === 1 ? cols - 1 - col : col)); break;
        case 2: out.push(Math.floor(Math.max(Math.abs(col - (cols - 1) / 2), Math.abs(row - (rows - 1) / 2)))); break;
        case 3: out.push(col + row); break;
      }
    }
  }
  return out;
}

/** Seconds each cell is late: step × delay, all scaled down together when the last would pass WALL_HISTORY_S. */
export function cellDelays(steps: readonly number[], delay: number): number[] {
  const max = Math.max(0, ...steps) * delay;
  const k = max > WALL_HISTORY_S ? WALL_HISTORY_S / max : 1;
  return steps.map((s) => s * delay * k);
}

/** The last `spanS` seconds of values, by the time they were pushed (times must not go backwards). */
export class History<T> {
  private items: { t: number; v: T }[] = [];
  private head = 0;

  constructor(private readonly spanS: number) {}

  push(t: number, v: T): void {
    this.items.push({ t, v });
    while (this.items[this.head].t < t - this.spanS) this.head++;
    if (this.head > 1024) { this.items = this.items.slice(this.head); this.head = 0; }
  }

  /** The newest value pushed at or before `t`; the oldest one when `t` is earlier than all; null when empty. */
  at(t: number): T | null {
    const a = this.items;
    if (this.head >= a.length) return null;
    let lo = this.head, hi = a.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (a[mid].t <= t) lo = mid; else hi = mid - 1;
    }
    return a[lo].v;
  }

  clear(): void {
    this.items = [];
    this.head = 0;
  }
}
