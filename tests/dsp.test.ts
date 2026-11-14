import { describe, expect, test } from 'vitest';
import {
  ENV_TIMES, beatPeriodFrom, createDsp, dbToLin, dspStep, envelopeStep, foldInterval, idleFrame,
} from '../src/display/audio/dsp';
import type { AudioFrame } from '../src/shared/protocol';
import { defaultCalib } from '../src/shared/state';
import { BIN_HZ, frames, kickTrain, music, silence, whiteNoise } from './audioSynth';

function run(signal: Float32Array, fps: number, scale = 1): AudioFrame[] {
  const st = createDsp();
  const calib = defaultCalib();
  const out: AudioFrame[] = [];
  for (const f of frames(signal, fps)) {
    const mag = scale === 1 ? f.mag : f.mag.map((m) => m * scale);
    out.push(dspStep(st, mag, f.peak, 1 / fps, calib, BIN_HZ));
  }
  return out;
}

const onsetTimes = (fr: AudioFrame[], fps: number) =>
  fr.flatMap((f, i) => (f.onset ? [(i + 1) / fps] : []));

describe('envelope', () => {
  for (const fps of [30, 144]) {
    test(`converges to within 5% at ${fps} fps (attack and release, every band)`, () => {
      const dt = 1 / fps;
      for (const [att, rel] of Object.values(ENV_TIMES)) {
        let y = 0;
        for (let t = 0; t < 3 * att + dt; t += dt) y = envelopeStep(y, 1, dt, att, rel);
        expect(y).toBeGreaterThan(0.95);
        for (let t = 0; t < 3 * rel + dt; t += dt) y = envelopeStep(y, 0, dt, att, rel);
        expect(y).toBeLessThan(0.05);
      }
    });
  }

  test('is frame-rate independent', () => {
    const at = (fps: number) => {
      let y = 0;
      for (let i = 0; i < fps / 10; i++) y = envelopeStep(y, 1, 1 / fps, 0.025, 0.35);
      return y; // value at t = 0.1 s
    };
    expect(at(30)).toBeCloseTo(at(120), 9);
  });

  test('a steady tone drives its band envelope to the top at 30 and 144 fps', () => {
    for (const fps of [30, 144]) {
      const st = createDsp();
      const mag = new Float32Array(1024);
      mag[4] = 0.5; // ~94 Hz → low band
      let f = idleFrame();
      for (let i = 0; i < fps * 0.2; i++) f = dspStep(st, mag, 0.5, 1 / fps, defaultCalib(), BIN_HZ);
      expect(f.low).toBeGreaterThan(0.95);
      expect(f.mid).toBe(0);
    }
  });
});

describe('auto-gain', () => {
  const sig = music(126, 20);
  for (const scale of [0.01, 100]) {
    test(`band outputs stay in 0…1 for input × ${scale}`, () => {
      const fr = run(sig, 60, scale);
      let maxLow = 0;
      for (const f of fr) {
        for (const v of [f.low, f.mid, f.high, f.energy, f.beat]) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
        maxLow = Math.max(maxLow, f.low);
      }
      expect(maxLow).toBeGreaterThan(0.5); // and it actually uses the range
    });
  }

  test('floorDb stops a very quiet signal from being amplified', () => {
    const fr = run(whiteNoise(5, 1e-5), 60); // ≈ −100 dB, below the −60 dB floor
    expect(Math.max(...fr.map((f) => f.low))).toBeLessThan(0.01);
    expect(dbToLin(-60)).toBeCloseTo(0.001, 9);
  });
});

describe('onsets', () => {
  test('126 BPM kick train → 126 ± 3 onsets per minute', () => {
    const fr = run(kickTrain(126, 60), 60);
    const n = fr.filter((f) => f.onset).length;
    expect(Math.abs(n - 126)).toBeLessThanOrEqual(3);
    expect(fr[fr.length - 1].beatCount).toBe(n);
    expect(fr[fr.length - 1].beatPeriod).toBeCloseTo(60 / 126, 1);
  }, 30000);

  test('126 BPM kicks under a bassline and noise are still found', () => {
    const n = run(music(126, 60, 0.2), 60).filter((f) => f.onset).length;
    expect(Math.abs(n - 126)).toBeLessThanOrEqual(3);
  }, 30000);

  test('190 BPM kick train never yields more than 3 onsets in any 1 s window', () => {
    const fps = 60;
    const t = onsetTimes(run(kickTrain(190, 60), fps), fps);
    expect(t.length).toBeGreaterThan(60);
    for (let i = 0; i + 3 < t.length; i++) expect(t[i + 3] - t[i]).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < t.length; i++) expect(t[i] - t[i - 1]).toBeGreaterThanOrEqual(0.34 - 1e-9);
  }, 30000);

  test('white noise yields < 10 onsets per minute', () => {
    for (const fps of [60, 144]) {
      const n = run(whiteNoise(60), fps).filter((f) => f.onset).length;
      expect(n).toBeLessThan(10);
    }
  }, 60000);

  test('beat pulse is 1 at onset and decays with τ = 0.15 s', () => {
    const fr = run(kickTrain(126, 5), 60);
    const i = fr.findIndex((f) => f.onset);
    expect(fr[i].beat).toBe(1);
    expect(fr[i + 1].beat).toBeCloseTo(Math.exp(-1 / 60 / 0.15), 9);
  });
});

describe('bpm', () => {
  test('intervals of 0.25 s, 0.5 s and 1.0 s all fold to 0.5 s', () => {
    expect(foldInterval(0.25)).toBe(0.5);
    expect(foldInterval(0.5)).toBe(0.5);
    expect(foldInterval(1.0)).toBe(0.5);
    expect(beatPeriodFrom([0.25, 0.5, 1.0, 0.5, 0.25])).toBe(0.5);
  });

  test('folds into the single octave 0.375…0.75 s and defaults to 0.5 s', () => {
    for (const s of [0.1, 0.3, 0.4, 0.74, 0.75, 2, 7.3]) {
      const f = foldInterval(s);
      expect(f).toBeGreaterThanOrEqual(0.375);
      expect(f).toBeLessThan(0.75);
    }
    expect(beatPeriodFrom([])).toBe(0.5);
  });
});

describe('silence', () => {
  test('sets silent after 3 s and keeps all bands at 0', () => {
    const fps = 60;
    const fr = run(silence(5), fps);
    fr.forEach((f, i) => {
      const t = (i + 1) / fps;
      expect(f.silent).toBe(t >= 3 + 1e-6);
      expect([f.low, f.mid, f.high, f.beat]).toEqual([0, 0, 0, 0]);
      expect(f.onset).toBe(false);
      expect(f.rawDb.every(Number.isFinite)).toBe(true);
      expect(Number.isFinite(f.levelDb)).toBe(true);
    });
  });

  test('−Infinity dB input (Web Audio silence) gives zero magnitude', () => {
    expect(dbToLin(-Infinity)).toBe(0);
  });

  test('clip flags a time-domain peak above 0.98', () => {
    const st = createDsp();
    const mag = new Float32Array(1024);
    expect(dspStep(st, mag, 0.99, 1 / 60, defaultCalib(), BIN_HZ).clip).toBe(true);
    expect(dspStep(st, mag, 0.5, 1 / 60, defaultCalib(), BIN_HZ).clip).toBe(false);
  });
});
