// B4.1 effective value of every param + B4.3 phase integration. Pure.
import { PARAMS, PARAM_COUNT, PARAM_INDEX, fromNorm, toNorm, type ParamDef } from '../shared/params';
import { bandValue, type AudioFrame } from '../shared/protocol';
import type { Look, ParamState, Session } from '../shared/state';
import { clamp01, fract, valueNoise1D } from '../shared/math';
import { limit, stop, type ReachIn, type ReachParam } from './reach';
import { envStep, type EnvState } from '../shared/envelope';
import { ENV_GROUPS, isEnvGroup, perEnvGroup, type EnvGroup } from '../shared/state';

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
  return normAt(def, ps, index, gate(bandVal, ps.thr), driftScale, reactMaster, driftT);
}

/** B4.1 with the sound `level` already decided (the gate, or the envelope output for shape, line and colour). */
function normAt(
  def: ParamDef, ps: ParamState, index: number, level: number,
  driftScale: number, reactMaster: number, driftT: number,
): number {
  const uBase = toNorm(def, ps.base);
  const drift =
    ps.lock || def.driftPeriod === null || def.driftAmp === 0
      ? 0
      : driftScale * def.driftAmp * (valueNoise1D(index * 37.1 + driftT / def.driftPeriod) * 2 - 1);
  const u = uBase + drift + reactMaster * ps.react * level;
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
  /** Turns, 0…1: the wobble, advancing at the effective `tiltSpeed` (turns/min). */
  tiltPhase: number;
  /** The lean sent to the shader as (tiltX, tiltY): tiltAmt along tiltAngle + tiltPhase. */
  tilt: [number, number];
  /** Design §5.2: envelope state per param (used by the shape, line and colour groups). */
  env: EnvState[];
  /** Per envelope group: hits counted since the caller last reset them (the dashboard draws one line per hit). */
  envHits: Record<EnvGroup, number>;
  /** Per envelope group: the gate has dropped below HIT_OFF since the last hit. */
  envArmed: Record<EnvGroup, boolean>;
  /** Values with base + drift only (no sound), on each param's own scale. */
  rest: Float32Array;
  /** Design §4.5: normalised slider positions where orange and red start (1 = never). */
  zones: Zones;
}

export type Zone = [orange: number, red: number];
export interface Zones { zoom: Zone; mirrorShift: Zone; }

/** What the stop and the zones need to know about the picture (design §4.2–4.3). */
export interface Geom {
  /** Ink radius of what is on screen: max of A and B during a melt. */
  radius: number;
  /** Window half-extents in units of its short side. */
  ax: number; ay: number;
  /** A melt is running (0 < morphT < 1). */
  morphing: boolean;
}

const NO_ZONE: Zone = [1, 1];
/** A hit: the strongest gate of a group's reacting params rises above HIT_ON after falling below HIT_OFF. */
export const HIT_ON = 0.15;
export const HIT_OFF = 0.05;

export function createModulation(): Modulation {
  return {
    values: new Float32Array(PARAM_COUNT), norm: new Float32Array(PARAM_COUNT), warpPhase: 0, spikePhase: 0, wavePhase: 0, spinPhase: 0,
    tiltPhase: 0, tilt: [0, 0],
    rest: new Float32Array(PARAM_COUNT), zones: { zoom: NO_ZONE, mirrorShift: NO_ZONE },
    env: Array.from({ length: PARAM_COUNT }, () => ({ c: 1, y: 0 })), envHits: perEnvGroup(() => 0), envArmed: perEnvGroup(() => true),
  };
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
export function modulate(
  m: Modulation, look: Look, session: Session, frame: AudioFrame, driftT: number, dt: number, geom?: Geom,
): void {
  const driftScale = session.fallback ? 0 : session.autopilot;
  const groupGate = perEnvGroup(() => 0);
  for (let i = 0; i < PARAM_COUNT; i++) {
    const def = PARAMS[i];
    const ps = look.params[def.id];
    let level = gate(bandValue(ps.band, frame), ps.thr);
    if (isEnvGroup(def.group)) {
      const s = m.env[i];
      if (ps.react !== 0 && ps.band !== 'none') groupGate[def.group] = Math.max(groupGate[def.group], level);
      envStep(s, level, look.env[def.group], dt);
      level = s.y;
    }
    const u = normAt(def, ps, i, level, driftScale, session.reactMaster, driftT);
    m.norm[i] = u;
    m.values[i] = fromNorm(def, u);
    m.rest[i] = fromNorm(def, normAt(def, ps, i, 0, driftScale, session.reactMaster, driftT));
  }
  countHits(m, groupGate);
  m.tiltPhase = fract(m.tiltPhase + (m.values[PARAM_INDEX.tiltSpeed] / 60) * dt);
  m.tilt = tiltOf(m.values, m.tiltPhase);
  if (geom) {
    if (session.zoomStop && !session.fallback) applyStop(m, look, geom);
    m.zones = zones(m.rest, look, geom, m.tiltPhase);
  } else {
    m.zones = { zoom: NO_ZONE, mirrorShift: NO_ZONE };
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

/** Wobble: the lean vector of tiltAmt along tiltAngle + phase (turns). */
function tiltOf(v: Float32Array, phase: number): [number, number] {
  const a = v[PARAM_INDEX.tiltAmt];
  const t = (v[PARAM_INDEX.tiltAngle] + phase) * 2 * Math.PI;
  return [a * Math.cos(t), a * Math.sin(t)];
}

function countHits(m: Modulation, groupGate: Record<EnvGroup, number>): void {
  for (const g of ENV_GROUPS) {
    if (m.envArmed[g] && groupGate[g] > HIT_ON) { m.envHits[g]++; m.envArmed[g] = false; }
    else if (groupGate[g] < HIT_OFF) m.envArmed[g] = true;
  }
}

const I_ZOOM = PARAM_INDEX.zoom;
const I_MIRROR_SHIFT = PARAM_INDEX.mirrorShift;
const ZOOM = PARAMS[I_ZOOM];
const MIRROR_SHIFT = PARAMS[I_MIRROR_SHIFT];

/** The reach inputs for a set of param values (own scales). */
function reachIn(v: Float32Array, look: Look, geom: Geom, tiltPhase: number): ReachIn {
  const o = look.options;
  const [tiltX, tiltY] = tiltOf(v, tiltPhase);
  const meltBulge = o.meltMode === 1 && geom.morphing ? v[PARAM_INDEX.meltK] / 4 : 0;
  return {
    zoom: v[I_ZOOM], mirrorShift: v[I_MIRROR_SHIFT], mirrorX: o.mirrorX, mirrorY: o.mirrorY,
    tiltX, tiltY, thickness: v[PARAM_INDEX.thickness],
    spikeAmp: v[PARAM_INDEX.spikeAmp], warpAmt: v[PARAM_INDEX.warpAmt], glow: v[PARAM_INDEX.glow],
    glowWidth: v[PARAM_INDEX.glowWidth], brightness: v[PARAM_INDEX.brightness], meltBulge,
    radius: geom.radius, ax: geom.ax, ay: geom.ay,
  };
}

const limitOf = (i: ReachIn, p: ReachParam, kind: 'ink' | 'glow'): number => {
  const def = p === 'zoom' ? ZOOM : MIRROR_SHIFT;
  return limit(i, p, kind, def.min, def.max);
};

/** Design §4.4, fixed order: mirror shift (zoom at its hand value), then zoom (with the final mirror shift). */
function applyStop(m: Modulation, look: Look, geom: Geom): void {
  const zoomHand = look.params.zoom.base;
  if (look.options.mirrorX || look.options.mirrorY) {
    const lim = limitOf({ ...reachIn(m.values, look, geom, m.tiltPhase), zoom: zoomHand }, 'mirrorShift', 'ink');
    setValue(m, I_MIRROR_SHIFT, stop(look.params.mirrorShift.base, m.values[I_MIRROR_SHIFT], lim));
  }
  const lim = limitOf(reachIn(m.values, look, geom, m.tiltPhase), 'zoom', 'ink');
  setValue(m, I_ZOOM, stop(zoomHand, m.values[I_ZOOM], lim));
}

function setValue(m: Modulation, i: number, v: number): void {
  m.values[i] = v;
  m.norm[i] = clamp01(toNorm(PARAMS[i], v));
}

/** Design §4.5: the other params at rest, so the zones do not flicker with the kick. */
function zones(rest: Float32Array, look: Look, geom: Geom, tiltPhase: number): Zones {
  const i = reachIn(rest, look, geom, tiltPhase);
  const zone = (p: ReachParam, def: typeof ZOOM | typeof MIRROR_SHIFT): Zone => [
    clamp01(toNorm(def, limitOf(i, p, 'glow'))), clamp01(toNorm(def, limitOf(i, p, 'ink'))),
  ];
  const mirrored = look.options.mirrorX || look.options.mirrorY;
  return { zoom: zone('zoom', ZOOM), mirrorShift: mirrored ? zone('mirrorShift', MIRROR_SHIFT) : NO_ZONE };
}

/** Ease a 0…1 turn phase toward the nearest whole turn (shortest way); snaps to exactly 0 when close. */
function glideUpright(phase: number, dt: number): number {
  const target = Math.round(phase); // 0 or 1
  const next = phase + (target - phase) * (1 - Math.exp(-dt / SPIN_RETURN_TAU));
  return Math.abs(target - next) < 1e-4 ? 0 : fract(next);
}
