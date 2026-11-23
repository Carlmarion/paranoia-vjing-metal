// Design §5.2: the per-group reaction envelope (attack, fatigue/sustain, release). Pure; all time constants use dt.
import type { Env } from '../shared/state';

/** Per-param running state: `c` = charge (fatigue), starts at 1; `y` = output. */
export interface EnvState { c: number; y: number; }

const ease = (tau: number, dt: number): number => (tau <= 0 ? 1 : 1 - Math.exp(-dt / tau));

/**
 * One frame. `g` = the B4.1 gate value (0…1). Mutates `s`; returns `x`, the input after fatigue (for stage display).
 * Neutral settings give `y === g`.
 */
export function envStep(s: EnvState, g: number, env: Env, dt: number): number {
  const gate = g > 0 ? (g < 1 ? g : 1) : 0;
  // fatigue: use the charge before draining it, so a hit's first frame is full at any frame rate
  const x = gate * s.c;
  const target = 1 - (1 - env.sustain) * gate;
  const tauC = target < s.c ? env.decay : Math.max(env.decay, env.release); // refilling takes at least the tail
  s.c += (target - s.c) * ease(tauC, dt);
  // attack / release
  const tau = x > s.y ? env.attack : env.release;
  s.y = tau <= 0 ? x : s.y + (x - s.y) * ease(tau, dt);
  return x;
}

export type EnvStage = 0 | 1 | 2 | 3;
/** Below this, the effect counts as idle. */
const IDLE = 0.01;
const NEAR = 0.95;

/** 0 idle, 1 rising, 2 holding, 3 falling — from the input after fatigue `x` and the output `y`. */
export function envStage(x: number, y: number): EnvStage {
  if (x < IDLE && y < IDLE) return 0;
  if (y < NEAR * x) return 1;
  if (x < NEAR * y) return 3;
  return 2;
}

/** Each section of the drawn curve spans this many of its time constants. */
const SECTION_SPANS = 4;
const SECTION_MIN_S = 0.05;

export interface EnvCurve { attack: Float32Array; sustain: Float32Array; release: Float32Array; }

/**
 * The response to "full on through the attack and sustain sections, then off", sampled for drawing.
 * Section lengths: 4 × attack, 4 × decay, 4 × release (at least 50 ms each). Runs `envStep`, so it is the real curve.
 */
export function envCurve(env: Env, samplesPerSection: number): EnvCurve {
  const s: EnvState = { c: 1, y: 0 };
  const section = (seconds: number, g: number): Float32Array => {
    const out = new Float32Array(samplesPerSection);
    const dt = Math.max(seconds * SECTION_SPANS, SECTION_MIN_S) / samplesPerSection;
    for (let i = 0; i < samplesPerSection; i++) { envStep(s, g, env, dt); out[i] = s.y; }
    return out;
  };
  return { attack: section(env.attack, 1), sustain: section(env.decay, 1), release: section(env.release, 0) };
}

/** Seconds spanned by each section of `envCurve` (for axis labels and dot placement). */
export function envSectionSeconds(env: Env): { attack: number; sustain: number; release: number } {
  const span = (t: number): number => Math.max(t * SECTION_SPANS, SECTION_MIN_S);
  return { attack: span(env.attack), sustain: span(env.decay), release: span(env.release) };
}
