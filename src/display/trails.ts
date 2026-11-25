// Trails (design 2026-11-25 §5.2): how much of the last frame is kept, and where each pixel was in it. Pure.
// Per second and computed from dt, so the look does not depend on the frame rate.

/** Seconds for an echo to fall to 1/e with `trail` at 1. */
export const TRAIL_MAX_S = 6;
/** Growth rate of the echoes (per second) with `push` at 1. */
export const PUSH_RATE = 1.5;
/** Turns per second with `twist` at 1. */
export const TWIST_RATE = 0.25;

/** Factor applied to the last frame. 0 = trails off. */
export function trailDecay(trail: number, dt: number): number {
  const tau = trail > 0 ? TRAIL_MAX_S * trail * trail : 0;
  return tau > 0 ? Math.exp(-dt / tau) : 0;
}

/**
 * Column-major mat2: a pixel's position now (window-centred, short side = 1) → where it was last frame.
 * The echoes grow by exp(push × PUSH_RATE × dt) and turn by twist × TWIST_RATE × dt, so this is the inverse.
 */
export function trailMatrix(push: number, twist: number, dt: number): [number, number, number, number] {
  const k = Math.exp(-push * PUSH_RATE * dt);
  const a = -twist * TWIST_RATE * dt * 2 * Math.PI;
  const c = Math.cos(a) * k, s = Math.sin(a) * k;
  return [c, s, -s, c];
}
