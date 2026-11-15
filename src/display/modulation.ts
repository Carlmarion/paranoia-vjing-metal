// B4.1 effective value of every param + B4.3 phase integration. Pure.
import { PARAMS, PARAM_COUNT, PARAM_INDEX, fromNorm, toNorm, type ParamDef } from '../shared/params';
import { bandValue, type AudioFrame } from '../shared/protocol';
import type { Look, ParamState, Session } from '../shared/state';
import { clamp01, fract, valueNoise1D } from '../shared/math';

export const PHASE_WRAP = 1000;

/** Threshold gate: 0 below thr, 1 at band = 1. thr ≥ 1 → always 0. */
export function gate(bandVal: number, thr: number): number {
  return thr >= 1 ? 0 : Math.max(0, bandVal - thr) / (1 - thr);
}

/**
 * B4.1 for one param. Returns the effective value normalised 0…1 (wrapped for 'wrap', clamped otherwise).
 * @param driftScale session.autopilot (0 disables drift, e.g. in fallback)
 */
export function modulateNorm(
  def: ParamDef, ps: ParamState, index: number, bandVal: number,
  driftScale: number, reactMaster: number, driftT: number,
): number {
  const uBase = toNorm(def, ps.base);
  const drift =
    ps.lock || def.driftPeriod === null || def.driftAmp === 0
      ? 0
      : driftScale * def.driftAmp * (valueNoise1D(index * 37.1 + driftT / def.driftPeriod) * 2 - 1);
  const u = uBase + drift + reactMaster * ps.react * gate(bandVal, ps.thr);
  return def.scale === 'wrap' ? fract(u) : clamp01(u);
}

export interface Modulation {
  /** Effective values on each param's own scale → `uniform float uP[PARAM_COUNT]`. */
  values: Float32Array;
  /** Same, normalised 0…1 → `meters.values`. */
  norm: Float32Array;
  /** B4.3: warp and spike run freely; wave wraps at 1000. */
  warpPhase: number;
  spikePhase: number;
  wavePhase: number;
  /** Turns, 0…1: turns at the effective `spin` speed (turns/min); glides back upright while spin is fully off. */
  spinPhase: number;
}

export function createModulation(): Modulation {
  return { values: new Float32Array(PARAM_COUNT), norm: new Float32Array(PARAM_COUNT), warpPhase: 0, spikePhase: 0, wavePhase: 0, spinPhase: 0 };
}

function wrapPhase(x: number): number {
  return x - PHASE_WRAP * Math.floor(x / PHASE_WRAP);
}

const I_WARP_SPEED = PARAM_INDEX.warpSpeed;
const I_SPIKE_SPEED = PARAM_INDEX.spikeSpeed;
const I_WAVE_SPEED = PARAM_INDEX.waveSpeed;
const I_SPIN = PARAM_INDEX.spin;
/** Time constant (s) of the glide back to upright when spin is fully off (base 0, react 0). */
export const SPIN_RETURN_TAU = 0.4;

/**
 * Per frame: fills m.values / m.norm and integrates the three phases.
 * @param look   the Look to render (store's renderLook: fallback and crossfade already applied)
 * @param driftT from the autopilot
 */
export function modulate(m: Modulation, look: Look, session: Session, frame: AudioFrame, driftT: number, dt: number): void {
  const driftScale = session.fallback ? 0 : session.autopilot;
  for (let i = 0; i < PARAM_COUNT; i++) {
    const def = PARAMS[i];
    const ps = look.params[def.id];
    const u = modulateNorm(def, ps, i, bandValue(ps.band, frame), driftScale, session.reactMaster, driftT);
    m.norm[i] = u;
    m.values[i] = fromNorm(def, u);
  }
  // Warp and spike phases are noise coordinates: wrapping them would make the shape jump, so they
  // run freely (the shader's integer hash stays exact). The wave phase feeds a sine and wraps seamlessly.
  m.warpPhase += m.values[I_WARP_SPEED] * dt;
  m.spikePhase += m.values[I_SPIKE_SPEED] * dt;
  m.wavePhase = wrapPhase(m.wavePhase + m.values[I_WAVE_SPEED] * dt);
  const spin = look.params.spin;
  m.spinPhase = spin.base === 0 && spin.react === 0
    ? glideUpright(m.spinPhase, dt)
    : fract(m.spinPhase + (m.values[I_SPIN] / 60) * dt);
}

/** Ease a 0…1 turn phase toward the nearest whole turn (shortest way); snaps to exactly 0 when close. */
function glideUpright(phase: number, dt: number): number {
  const target = Math.round(phase); // 0 or 1
  const next = phase + (target - phase) * (1 - Math.exp(-dt / SPIN_RETURN_TAU));
  return Math.abs(target - next) < 1e-4 ? 0 : fract(next);
}
