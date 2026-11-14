// Test helper: synthesise audio and turn it into the magnitude frames an AnalyserNode
// would give (fftSize 2048, Blackman window), at a given frame rate. No Web Audio.
import { mulberry32 } from '../src/shared/math';

export const SR = 48000;
export const FFT = 2048;
export const BIN_HZ = SR / FFT;

function fftMag(re: Float64Array, im: Float64Array): Float32Array {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const a = i + k, b = a + len / 2;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
  const out = new Float32Array(n / 2);
  for (let k = 0; k < n / 2; k++) out[k] = Math.hypot(re[k], im[k]);
  return out;
}

const WIN = (() => {
  const w = new Float64Array(FFT);
  let sum = 0;
  for (let i = 0; i < FFT; i++) {
    const x = (2 * Math.PI * i) / (FFT - 1);
    w[i] = 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x);
    sum += w[i];
  }
  for (let i = 0; i < FFT; i++) w[i] *= 2 / sum; // a full-scale sine → magnitude 1
  return w;
})();

/** Magnitude spectrum of the 2048 samples ending at sample index `end`. */
export function spectrumAt(signal: Float32Array, end: number): Float32Array {
  const re = new Float64Array(FFT);
  const im = new Float64Array(FFT);
  for (let i = 0; i < FFT; i++) {
    const s = end - FFT + i;
    re[i] = s >= 0 && s < signal.length ? signal[s] * WIN[i] : 0;
  }
  return fftMag(re, im);
}

export interface Frame { mag: Float32Array; peak: number; }

/** Analyse `signal` at `fps` frames per second, yielding one frame per tick. */
export function* frames(signal: Float32Array, fps: number): Generator<Frame> {
  const total = signal.length / SR;
  const n = Math.floor(total * fps);
  const hop = SR / fps;
  for (let f = 1; f <= n; f++) {
    const end = Math.round(f * hop);
    let peak = 0;
    for (let i = Math.max(0, end - Math.round(hop)); i < end; i++) peak = Math.max(peak, Math.abs(signal[i]));
    yield { mag: spectrumAt(signal, end), peak };
  }
}

/** Kick train: 55 Hz sine with a fast exponential decay, over a quiet noise floor. */
export function kickTrain(bpm: number, seconds: number, seed = 1): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  const rng = mulberry32(seed);
  const period = 60 / bpm;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const tk = t % period;
    out[i] = 0.8 * Math.sin(2 * Math.PI * 55 * tk) * Math.exp(-tk / 0.04) + 0.003 * (rng() * 2 - 1);
  }
  return out;
}

export function whiteNoise(seconds: number, amp = 0.3, seed = 2): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  const rng = mulberry32(seed);
  for (let i = 0; i < out.length; i++) out[i] = amp * (rng() * 2 - 1);
  return out;
}

export function silence(seconds: number): Float32Array {
  return new Float32Array(Math.round(seconds * SR));
}

/** Kick train + decaying off-beat bass notes + broadband noise. */
export function music(bpm: number, seconds: number, noiseAmp = 0.05, seed = 3): Float32Array {
  const k = kickTrain(bpm, seconds, seed);
  const n = whiteNoise(seconds, noiseAmp, seed + 1);
  const period = 60 / bpm;
  const notes = [55, 73.4, 82.4, 65.4];
  for (let i = 0; i < k.length; i++) {
    const t = i / SR;
    const beat = Math.floor(t / period);
    const tb = t % period;
    const bass = tb > period / 2 ? 0.35 * Math.sin(2 * Math.PI * notes[beat % 4] * t) * Math.exp(-(tb - period / 2) / 0.15) : 0;
    k[i] += bass + n[i];
  }
  return k;
}
