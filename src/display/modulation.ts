// B4.1 effective value of every param + B4.3 phase integration. Pure.
import { PARAMS, PARAM_COUNT, PARAM_INDEX, fromNorm, toNorm, type Band, type ParamDef } from '../shared/params';
import type { AudioFrame } from '../shared/protocol';
import type { Look, ParamState, Session } from '../shared/state';
import { clamp01, fract, valueNoise1D } from '../shared/math';

export const PHASE_WRAP = 1000;

/** bandValue (B4.1): 'none' → 0, 'beat' → beat pulse, 'energy' → energy30. */
export function bandValue(band: Band, frame: AudioFrame): number {
  switch (band) {
    case 'low': return frame.low;
    case 'mid': return frame.mid;
    case 'high': return frame.high;
    case 'energy': return frame.energy;
    case 'beat': return frame.beat;
    default: return 0;
  }
}

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
  /** Effective values on each param's own scale → `uniform float uP[30]`. */
  values: Float32Array;
  /** Same, normalised 0…1 → `meters.values`. */
  norm: Float32Array;
  /** B4.3: warp and spike run freely; wave wraps at 1000. */
  warpPhase: number;
  spikePhase: number;
  wavePhase: number;
}

export function createModulation(): Modulation {
  return { values: new Float32Array(PARAM_COUNT), norm: new Float32Array(PARAM_COUNT), warpPhase: 0, spikePhase: 0, wavePhase: 0 };
}

function wrapPhase(x: number): number {
  return x - PHASE_WRAP * Math.floor(x / PHASE_WRAP);
}

const I_WARP_SPEED = PARAM_INDEX.warpSpeed;
const I_SPIKE_SPEED = PARAM_INDEX.spikeSpeed;
const I_WAVE_SPEED = PARAM_INDEX.waveSpeed;

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
}
