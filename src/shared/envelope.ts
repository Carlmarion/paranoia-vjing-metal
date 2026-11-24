// Design §5.2: the per-group reaction envelope (attack, fatigue/sustain, release). Pure; all time constants use dt.
import type { Env } from './state';

/** Per-param running state: `c` = charge (fatigue), starts at 1; `y` = output. */
export interface EnvState { c: number; y: number; }

const ease = (tau: number, dt: number): number => (tau <= 0 ? 1 : 1 - Math.exp(-dt / tau));

/** One frame. `g` = the B4.1 gate value (0…1). Mutates `s`. Neutral settings give `y === g`. */
export function envStep(s: EnvState, g: number, env: Env, dt: number): void {
  const gate = g > 0 ? (g < 1 ? g : 1) : 0;
  // fatigue: use the charge before draining it, so a hit's first frame is full at any frame rate
  const x = gate * s.c;
  const target = 1 - (1 - env.sustain) * gate;
  const tauC = target < s.c ? env.decay : Math.max(env.decay, env.release); // refilling takes at least the tail
  s.c += (target - s.c) * ease(tauC, dt);
  // attack / release
  const tau = x > s.y ? env.attack : env.release;
  s.y = tau <= 0 ? x : s.y + (x - s.y) * ease(tau, dt);
}

/** Each section of the drawn curve spans this many of its time constants (when no spans are given). */
const SECTION_SPANS = 4;
const SECTION_MIN_S = 0.05;

export interface EnvCurve { attack: Float32Array; sustain: Float32Array; release: Float32Array; }
export interface EnvSpans { attack: number; sustain: number; release: number; }

/** Seconds spanned by each section of `envCurve` by default: 4 × attack, 4 × decay, 4 × release (≥ 50 ms each). */
export function envSectionSeconds(env: Env): EnvSpans {
  const span = (t: number): number => Math.max(t * SECTION_SPANS, SECTION_MIN_S);
  return { attack: span(env.attack), sustain: span(env.decay), release: span(env.release) };
}

/**
 * The response to "full on through the attack and sustain sections, then off", sampled for drawing.
 * Sample i of a section sits at t = span × ((i + 1) / n)² from the section start: a square-root time axis, so
 * short times keep room. Runs `envStep`, so it is the real curve.
 */
export function envCurve(env: Env, samplesPerSection: number, spans: EnvSpans = envSectionSeconds(env)): EnvCurve {
  const s: EnvState = { c: 1, y: 0 };
  const n = samplesPerSection;
  const section = (span: number, g: number): Float32Array => {
    const out = new Float32Array(n);
    let t = 0;
    for (let i = 0; i < n; i++) {
      const next = span * ((i + 1) / n) ** 2;
      envStep(s, g, env, next - t);
      t = next;
      out[i] = s.y;
    }
    return out;
  };
  return { attack: section(spans.attack, 1), sustain: section(spans.sustain, 1), release: section(spans.release, 0) };
}
