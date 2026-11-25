// Design §7: the colour strip's maths. The shader is unchanged:
//   h = hue + hueOffset − clamp(d, −0.1, 0.02) × 10 × hueDepth + |s| × 0.5 × hueSpace
// so the glow (d ≥ 0.02) is hue − 0.2 × hueDepth, and a point at depth k inside the line is hue + 10 × k × hueDepth.
import { clamp, fract } from './math';

/** Reference depth for the core handle: a typical line half-width. */
export const CORE_REF_DEPTH = 0.03;
const GLOW_K = 0.2; // −clamp(d ≥ 0.02) × 10
const CORE_K = 10 * CORE_REF_DEPTH;
/** core − glow = SPAN_K × hueDepth */
const SPAN_K = GLOW_K + CORE_K;
const MAX_DEPTH_K = 0.1; // the shader clamps depth at −0.1

/** At-rest colours at the screen centre, in turns 0…1. */
export interface Handles { glow: number; core: number; }

export function handlesFromParams(hue: number, hueDepth: number): Handles {
  return { glow: fract(hue - GLOW_K * hueDepth), core: fract(hue + CORE_K * hueDepth) };
}

/**
 * Handles → params, one-to-one: hueDepth = (signed arc glow → core) / 0.5, hue = glow + 0.2 × hueDepth.
 * The arc is taken the way closest to `prevDepth`, so handles exactly opposite never flip between two drags.
 */
export function paramsFromHandles(h: Handles, prevDepth: number): { hue: number; hueDepth: number } {
  const raw = fract(h.core - h.glow); // 0…1
  const want = (prevDepth * SPAN_K) % 1;
  const arc = [raw, raw - 1].filter((a) => Math.abs(a) <= 0.5).reduce((best, a) => (Math.abs(a - want) < Math.abs(best - want) ? a : best));
  const hueDepth = clamp(arc / SPAN_K, -1, 1);
  return { hue: fract(h.glow + GLOW_K * hueDepth), hueDepth };
}

/** The colours on screen now, glow → core: `from` (turns) and a signed `length` capped at one turn. */
export function liveSpan(hueEff: number, hueDepthEff: number, thicknessEff: number, hueOffset: number): { from: number; length: number } {
  const depth = clamp(CORE_REF_DEPTH + thicknessEff, 0, MAX_DEPTH_K);
  const length = clamp(hueDepthEff * (GLOW_K + 10 * depth), -1, 1);
  return { from: fract(hueEff + hueOffset - GLOW_K * hueDepthEff), length };
}

/** hue and hueDepth on their own scales (hue: wrap 0…1; hueDepth: lin −1…1, so its normalised span is 2). */
export interface HuePair { hue: number; hueDepth: number; }
const DEPTH_SPAN = 2;

/** Where a full hit (gate 1) takes hue and hueDepth: B4.1 with level 1, no drift. */
export function hitParams(rest: HuePair, react: HuePair, reactMaster: number): HuePair {
  return {
    hue: fract(rest.hue + reactMaster * react.hue),
    hueDepth: clamp(rest.hueDepth + reactMaster * react.hueDepth * DEPTH_SPAN, -1, 1),
  };
}

/** The reacts that make a full hit land on `hit` (hue the short way round); null when reactMaster is 0. */
export function reactsFromHit(rest: HuePair, hit: HuePair, reactMaster: number): HuePair | null {
  if (!(reactMaster > 0)) return null;
  let arc = fract(hit.hue - rest.hue);
  if (arc > 0.5) arc -= 1;
  return {
    hue: clamp(arc / reactMaster, -1, 1),
    hueDepth: clamp((hit.hueDepth - rest.hueDepth) / DEPTH_SPAN / reactMaster, -1, 1),
  };
}
