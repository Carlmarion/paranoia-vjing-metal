// Design §4.3–4.4: how far the picture reaches toward the window edge, the limits that follow, and the stop. Pure.

/** Glow counts as visible down to this luminance. */
export const GLOW_CUTOFF = 0.08;

export interface ReachIn {
  zoom: number; mirrorShift: number; mirrorX: boolean; mirrorY: boolean; tiltX: number; tiltY: number;
  thickness: number; spikeAmp: number; warpAmt: number; glow: number; glowWidth: number; brightness: number;
  /** meltK / 4 during a fuse melt, else 0 (the smooth union bulges by up to k/4). */
  meltBulge: number;
  /** Ink radius of the shape(s) on screen, motif units. */
  radius: number;
  /** Window half-extents in units of its short side (w / min(w, h), h / min(w, h)). */
  ax: number; ay: number;
}

export type ReachKind = 'ink' | 'glow';
export type ReachParam = 'zoom' | 'mirrorShift';

const BISECT_STEPS = 24;

const validWindow = (i: ReachIn): boolean =>
  Number.isFinite(i.ax) && Number.isFinite(i.ay) && i.ax > 0 && i.ay > 0;

function glowReach(i: ReachIn): number {
  const lum = i.glow * i.brightness;
  return lum > GLOW_CUTOFF ? i.glowWidth * Math.log(lum / GLOW_CUTOFF) : 0;
}

/** Fill of one radius (motif units): ≥ 1 means it touches the window edge. */
function fillOf(i: ReachIn, rMotif: number): number {
  const rho = i.zoom * rMotif;
  const ex = rho + (i.mirrorX ? i.mirrorShift : 0); // mirror shift is added after the zoom division
  const ey = rho + (i.mirrorY ? i.mirrorShift : 0);
  const t = Math.abs(i.tiltX) * ex + Math.abs(i.tiltY) * ey;
  const k = 1 / Math.max(1 - t, 0.05);
  return Math.max((ex * k) / i.ax, (ey * k) / i.ay);
}

/** Window fill of the line (ink) and of the visible glow. */
export function fill(i: ReachIn): { ink: number; glow: number } {
  if (!validWindow(i)) return { ink: 0, glow: 0 };
  const grow = Math.max(i.thickness, 0) + i.spikeAmp + i.warpAmt * Math.SQRT2 + i.meltBulge;
  const rInk = i.radius > 0 ? i.radius + grow : 0;
  const rGlow = i.radius > 0 ? rInk + glowReach(i) : 0;
  return { ink: fillOf(i, rInk), glow: fillOf(i, rGlow) };
}

/** Value of `param` in [min, max] where fill[kind] reaches 1 (bisection); max if never, min if always. */
export function limit(i: ReachIn, param: ReachParam, kind: ReachKind, min: number, max: number): number {
  const at = (v: number): number => fill({ ...i, [param]: v })[kind];
  if (!(at(max) >= 1)) return max;
  if (at(min) >= 1) return min;
  let lo = min, hi = max;
  for (let s = 0; s < BISECT_STEPS; s++) {
    const mid = (lo + hi) / 2;
    if (at(mid) >= 1) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

/** Design §4.4: sound and drift move outward only up to `lim`, never below the hand; inward is free. */
export function stop(hand: number, full: number, lim: number): number {
  return full <= hand ? full : Math.max(hand, Math.min(full, lim));
}
