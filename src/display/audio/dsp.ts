// B6.3 — pure audio analysis. No Web Audio here: input is a magnitude spectrum.
// All time constants use dt (seconds).
import type { AudioFrame } from '../../shared/protocol';
import type { Calib } from '../../shared/state';

export const BAND_HZ = {
  low: [30, 150],
  mid: [150, 2500],
  high: [2500, 12000],
  all: [30, 12000],
} as const;
export const FLUX_HZ: readonly [number, number] = [30, 200];

/** [attack, release] seconds. Release is multiplied by calib.smooth. */
export const ENV_TIMES = {
  low: [0.01, 0.25],
  mid: [0.025, 0.35],
  high: [0.005, 0.15],
} as const;

export const FLUX_HISTORY_S = 1.5;
export const FLUX_MIN = 0.05;
/**
 * Extra onset condition (Decision): flux must also exceed its 1.5 s mean × (1 + FLUX_RATIO_K × onsetK),
 * i.e. ×5 at the default onsetK 1.5. Stationary noise has a dense flux whose mean + k·std is crossed
 * every few frames; kicks are sparse spikes far above their mean. Scaling with onsetK keeps that knob live.
 */
export const FLUX_RATIO_K = 8 / 3;
export const BPM_INTERVALS = 12;
export const DEFAULT_BEAT_PERIOD = 0.5;
export const BEAT_PULSE_TAU = 0.15;
export const ENERGY_PEAK_DECAY = 60;
export const ENERGY_TAU = 30;
export const SILENT_AFTER_S = 3;
export const DB_FLOOR = -120;

// ---------- small pure pieces ----------

/** dB → linear, −Infinity / NaN → 0. */
export function dbToLin(db: number): number {
  return Number.isFinite(db) ? Math.pow(10, db / 20) : 0;
}

/** linear → dB, clamped to DB_FLOOR so nothing non-finite leaves dsp. */
export function linToDb(x: number): number {
  return x > 0 ? Math.max(DB_FLOOR, 20 * Math.log10(x)) : DB_FLOOR;
}

/** Bins whose centre frequency k × binHz lies in [lo, hi). */
export function binRange(binHz: number, lo: number, hi: number, binCount: number): [number, number] {
  const a = Math.max(0, Math.ceil(lo / binHz));
  const b = Math.min(binCount, Math.ceil(hi / binHz));
  return [a, Math.max(a, b)];
}

/** RMS of mag over bins [a, b). */
export function rms(mag: ArrayLike<number>, a: number, b: number): number {
  if (b <= a) return 0;
  let s = 0;
  for (let i = a; i < b; i++) s += mag[i] * mag[i];
  return Math.sqrt(s / (b - a));
}

/** Auto-gain peak follower. Returns the new peak. */
export function autoGainPeak(peak: number, raw: number, dt: number, decay: number, floor: number): number {
  return Math.max(Math.max(raw, peak * Math.exp(-dt / decay)), floor);
}

export function autoGainNorm(raw: number, peak: number): number {
  return peak > 0 ? Math.min(raw / peak, 1) : 0;
}

/** One-pole envelope: τ = attack when rising, release when falling. */
export function envelopeStep(y: number, x: number, dt: number, attack: number, release: number): number {
  const tau = x > y ? attack : release;
  return y + (x - y) * (1 - Math.exp(-dt / tau));
}

/** Fold an inter-onset interval into the single octave [0.375, 0.75) s. */
export function foldInterval(s: number): number {
  if (!(s > 0) || !Number.isFinite(s)) return DEFAULT_BEAT_PERIOD;
  while (s >= 0.75) s /= 2;
  while (s < 0.375) s *= 2;
  return s;
}

export function median(xs: readonly number[]): number {
  const a = [...xs].sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Median of the folded intervals; default 0.5 s when unknown. */
export function beatPeriodFrom(intervals: readonly number[]): number {
  return intervals.length === 0 ? DEFAULT_BEAT_PERIOD : median(intervals.map(foldInterval));
}

// ---------- stateful step ----------

export interface DspState {
  t: number;
  peak: [number, number, number, number]; // low, mid, high, all
  env: [number, number, number]; // low, mid, high
  prevFluxMag: Float32Array | null;
  fluxT: number[];
  fluxV: number[];
  lastOnset: number; // −Infinity until the first onset
  intervals: number[]; // raw intervals, last BPM_INTERVALS
  beatCount: number;
  beat: number;
  energyPeak: number;
  energy: number;
  quietFor: number;
}

export function createDsp(): DspState {
  return {
    t: 0, peak: [0, 0, 0, 0], env: [0, 0, 0], prevFluxMag: null, fluxT: [], fluxV: [],
    lastOnset: -Infinity, intervals: [], beatCount: 0, beat: 0, energyPeak: 0, energy: 0.5, quietFor: 0,
  };
}

/**
 * One analysis frame.
 * @param mag        linear magnitude spectrum, already × calib.inputGain (bin k = k × binHz)
 * @param timePeak   time-domain absolute peak BEFORE inputGain (level meter / clip)
 * @param binHz      sampleRate / fftSize
 */
export function dspStep(
  st: DspState, mag: ArrayLike<number>, timePeak: number, dt: number, calib: Calib, binHz: number,
): AudioFrame {
  st.t += dt;
  const n = mag.length;
  const floor = dbToLin(calib.floorDb);

  // Bands (raw RMS) and auto-gain
  const keys = ['low', 'mid', 'high', 'all'] as const;
  const raw: [number, number, number, number] = [0, 0, 0, 0];
  const norm: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const [lo, hi] = BAND_HZ[keys[i]];
    const [a, b] = binRange(binHz, lo, hi, n);
    raw[i] = rms(mag, a, b);
    st.peak[i] = autoGainPeak(st.peak[i], raw[i], dt, calib.gainDecay, floor);
    norm[i] = autoGainNorm(raw[i], st.peak[i]);
  }

  // Envelopes
  const envKeys = ['low', 'mid', 'high'] as const;
  for (let i = 0; i < 3; i++) {
    const [att, rel] = ENV_TIMES[envKeys[i]];
    st.env[i] = envelopeStep(st.env[i], norm[i], dt, att, rel * calib.smooth);
  }

  // Onset: spectral flux over 30–200 Hz, normalised by the low band's peak
  const [fa, fb] = binRange(binHz, FLUX_HZ[0], FLUX_HZ[1], n);
  let flux = 0;
  if (!st.prevFluxMag || st.prevFluxMag.length !== fb - fa) {
    st.prevFluxMag = new Float32Array(fb - fa);
    for (let i = fa; i < fb; i++) st.prevFluxMag[i - fa] = mag[i];
  } else {
    for (let i = fa; i < fb; i++) {
      const d = mag[i] - st.prevFluxMag[i - fa];
      if (d > 0) flux += d;
      st.prevFluxMag[i - fa] = mag[i];
    }
  }
  flux = st.peak[0] > 0 ? flux / st.peak[0] : 0;

  let mean = 0;
  let sd = 0;
  const h = st.fluxV.length;
  if (h > 0) {
    for (const v of st.fluxV) mean += v;
    mean /= h;
    for (const v of st.fluxV) sd += (v - mean) * (v - mean);
    sd = Math.sqrt(sd / h);
  }
  const onset =
    h > 0 &&
    flux > mean + calib.onsetK * sd &&
    flux > FLUX_MIN &&
    flux > mean * (1 + FLUX_RATIO_K * calib.onsetK) &&
    (st.t - st.lastOnset) * 1000 >= calib.refractoryMs;

  st.fluxT.push(st.t);
  st.fluxV.push(flux);
  while (st.fluxT.length && st.fluxT[0] <= st.t - FLUX_HISTORY_S) { st.fluxT.shift(); st.fluxV.shift(); }

  if (onset) {
    if (Number.isFinite(st.lastOnset)) {
      st.intervals.push(st.t - st.lastOnset);
      if (st.intervals.length > BPM_INTERVALS) st.intervals.shift();
    }
    st.lastOnset = st.t;
    st.beatCount++;
    st.beat = 1;
  } else {
    st.beat *= Math.exp(-dt / BEAT_PULSE_TAU);
  }

  // energy30: all-band RMS / own peak (60 s decay), then EMA τ = 30 s
  st.energyPeak = autoGainPeak(st.energyPeak, raw[3], dt, ENERGY_PEAK_DECAY, floor);
  const eNorm = autoGainNorm(raw[3], st.energyPeak);
  st.energy += (eNorm - st.energy) * (1 - Math.exp(-dt / ENERGY_TAU));

  // silent: all-band raw RMS below floor for 3 s
  st.quietFor = raw[3] < floor ? st.quietFor + dt : 0;

  return {
    low: st.env[0], mid: st.env[1], high: st.env[2], energy: st.energy,
    beat: st.beat, onset, beatCount: st.beatCount, beatPeriod: beatPeriodFrom(st.intervals),
    silent: st.quietFor >= SILENT_AFTER_S,
    levelDb: linToDb(timePeak), clip: timePeak > 0.98,
    rawDb: [linToDb(raw[0]), linToDb(raw[1]), linToDb(raw[2]), linToDb(raw[3])],
  };
}

/** Frame used before the AudioContext runs: silent, nothing moving. */
export function idleFrame(): AudioFrame {
  return {
    low: 0, mid: 0, high: 0, energy: 0.5, beat: 0, onset: false, beatCount: 0, beatPeriod: DEFAULT_BEAT_PERIOD,
    silent: true, levelDb: DB_FLOOR, clip: false, rawDb: [DB_FLOOR, DB_FLOOR, DB_FLOOR, DB_FLOOR],
  };
}
