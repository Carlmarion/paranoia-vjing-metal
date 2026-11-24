import { describe, expect, test } from 'vitest';
import { envCurve, envStep, type EnvState } from '../src/shared/envelope';
import { neutralEnv, type Env } from '../src/shared/state';
import { mulberry32 } from '../src/shared/math';

const fresh = (): EnvState => ({ c: 1, y: 0 });
const env = (o: Partial<Env>): Env => ({ ...neutralEnv(), ...o });

/** Runs `g(t)` for `seconds` at `fps`; returns y after each frame. */
function run(e: Env, g: (t: number) => number, seconds: number, fps: number, s: EnvState = fresh()): number[] {
  const dt = 1 / fps;
  const out: number[] = [];
  const n = Math.round(seconds * fps);
  for (let i = 0; i < n; i++) { envStep(s, g(i * dt), e, dt); out.push(s.y); }
  return out;
}

describe('envelope (design §5.2)', () => {
  test('neutral settings return the input exactly', () => {
    const rng = mulberry32(3);
    for (const dt of [0, 1 / 120, 1 / 30, 1]) {
      const s = fresh();
      for (let i = 0; i < 300; i++) {
        const g = rng() < 0.2 ? 0 : rng();
        envStep(s, g, neutralEnv(), dt);
        expect(s.y).toBe(g);
      }
    }
  });

  test('attack is the rise time constant', () => {
    const y = run(env({ attack: 0.5 }), () => 1, 0.5, 600);
    expect(y[y.length - 1]).toBeCloseTo(1 - 1 / Math.E, 2);
  });

  test('a sustained sound starts at full and sags to sustain', () => {
    const y = run(env({ sustain: 0.4, decay: 1 }), () => 1, 10, 60);
    expect(y[0]).toBe(1);
    expect(Math.abs(y[y.length - 1] - 0.4)).toBeLessThan(0.01);
  });

  test('release is the tail time constant', () => {
    const s = fresh();
    run(env({ release: 2 }), () => 1, 1, 60, s);
    const y = run(env({ release: 2 }), () => 0, 2, 600, s);
    expect(y[y.length - 1]).toBeCloseTo(1 / Math.E, 2);
  });

  test('a repeat hit inside the tail lands weaker; after a long quiet it is full again', () => {
    const e = env({ sustain: 0.3, decay: 0.3, release: 4 });
    const s = fresh();
    const p1 = Math.max(...run(e, () => 1, 0.1, 60, s));
    run(e, () => 0, 1, 60, s);
    const p2 = Math.max(...run(e, () => 1, 0.1, 60, s));
    run(e, () => 0, 60, 60, s);
    const p3 = Math.max(...run(e, () => 1, 0.1, 60, s));
    expect(p1).toBe(1);
    expect(p2).toBeLessThan(p1 - 0.05);
    expect(Math.abs(p3 - p1)).toBeLessThan(0.01);
  });

  test('frame rate does not change the response: full peak at 30 and 120 fps, curves within 2%', () => {
    const e = env({ sustain: 0.3, decay: 0.3, release: 1 });
    const g = (t: number): number => (t < 0.2 ? 1 : 0);
    const a = run(e, g, 2.2, 30);
    const b = run(e, g, 2.2, 120);
    expect(Math.max(...a)).toBe(1);
    expect(Math.max(...b)).toBe(1);
    for (let k = 1; k <= 22; k++) expect(Math.abs(a[k * 3 - 1] - b[k * 12 - 1])).toBeLessThan(0.02);
  });

  test('a long frame or a zero frame keeps c and y in 0…1 (Review Focus 3)', () => {
    const rng = mulberry32(9);
    for (let i = 0; i < 500; i++) {
      const e: Env = { attack: rng() * 2, sustain: rng(), decay: 0.05 + rng() * 9.95, release: rng() * 20 };
      const s: EnvState = { c: rng(), y: rng() };
      for (const dt of [0, 5]) {
        envStep(s, rng(), e, dt);
        expect(s.c).toBeGreaterThanOrEqual(0); expect(s.c).toBeLessThanOrEqual(1);
        expect(s.y).toBeGreaterThanOrEqual(0); expect(s.y).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('envCurve', () => {
  test('neutral: full on through attack and sustain, off in release', () => {
    const c = envCurve(neutralEnv(), 16);
    for (const arr of [c.attack, c.sustain]) for (const v of arr) expect(v).toBe(1);
    for (const v of c.release) expect(v).toBe(0);
    expect(c.attack.length).toBe(16);
  });

  test('the curve is the real response: rises with attack', () => {
    const c = envCurve({ attack: 0.3, sustain: 1, decay: 1, release: 0 }, 64);
    expect(c.attack[0]).toBeLessThan(0.5);
    expect(c.attack[63]).toBeGreaterThan(0.9);
  });

  test('the curve is the real response: sags to sustain', () => {
    const c = envCurve({ attack: 0, sustain: 0.5, decay: 1, release: 0.05 }, 64);
    expect(c.attack[0]).toBe(1);
    expect(Math.abs(c.sustain[63] - 0.5)).toBeLessThan(0.05);
  });

  test('the curve is the real response: tails off over the release section', () => {
    const c = envCurve({ attack: 0, sustain: 1, decay: 1, release: 2 }, 64);
    expect(c.sustain[63]).toBe(1);
    expect(c.release[0]).toBeGreaterThan(0.9);
    expect(c.release[63]).toBeLessThan(0.05);
  });
});

describe('envCurve on fixed spans (the editor axis)', () => {
  const spans = { attack: 2, sustain: 10, release: 20 };

  test('samples sit on a square-root time axis: the last sample is the span end', () => {
    const c = envCurve({ attack: 0.5, sustain: 1, decay: 1, release: 0 }, 32, spans);
    // last attack sample is at t = 2 s: 1 − e^(−4)
    expect(c.attack[31]).toBeCloseTo(1 - Math.exp(-4), 3);
    // sample i is at t = span × ((i + 1) / n)²: sample 15 at 0.5 s → 1 − 1/e
    expect(c.attack[15]).toBeCloseTo(1 - 1 / Math.E, 2);
  });

  test('a shorter attack makes a steeper curve on the same axis', () => {
    const slow = envCurve({ attack: 1, sustain: 1, decay: 1, release: 0 }, 32, spans);
    const fast = envCurve({ attack: 0.1, sustain: 1, decay: 1, release: 0 }, 32, spans);
    expect(fast.attack[8]).toBeGreaterThan(slow.attack[8]);
  });
});
