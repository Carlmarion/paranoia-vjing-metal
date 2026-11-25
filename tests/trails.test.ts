import { describe, expect, test } from 'vitest';
import { PUSH_RATE, TRAIL_MAX_S, TWIST_RATE, trailDecay, trailMatrix } from '../src/display/trails';

type M = [number, number, number, number];
/** Column-major mat2 product a·b. */
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
];
const close = (a: M, b: M): void => { for (let i = 0; i < 4; i++) expect(a[i]).toBeCloseTo(b[i], 10); };

describe('trail decay', () => {
  test('off at 0: nothing of the last frame is kept', () => {
    expect(trailDecay(0, 1 / 60)).toBe(0);
    expect(trailDecay(-0.2, 1 / 60)).toBe(0);
  });

  test('at full, an echo falls to 1/e in TRAIL_MAX_S', () => {
    expect(trailDecay(1, TRAIL_MAX_S)).toBeCloseTo(Math.exp(-1), 10);
    expect(trailDecay(0.5, TRAIL_MAX_S / 4)).toBeCloseTo(Math.exp(-1), 10);
  });

  test('does not depend on the frame rate', () => {
    expect(trailDecay(0.7, 1 / 120) * trailDecay(0.7, 1 / 120)).toBeCloseTo(trailDecay(0.7, 1 / 60), 12);
  });
});

describe('trail matrix', () => {
  test('identity when push and twist are 0', () => {
    close(trailMatrix(0, 0, 1 / 60), [1, 0, 0, 1]);
  });

  test('two half steps equal one full step', () => {
    const half = trailMatrix(0.6, -0.4, 1 / 120);
    close(mul(half, half), trailMatrix(0.6, -0.4, 1 / 60));
  });

  test('positive push samples the last frame nearer the centre, so echoes move outward', () => {
    const m = trailMatrix(1, 0, 1);
    expect(m[0]).toBeCloseTo(Math.exp(-PUSH_RATE), 10);
    expect(m[1]).toBeCloseTo(0, 10);
  });

  test('twist turns by TWIST_RATE turns per second, with no scale', () => {
    const m = trailMatrix(0, 1, 1); // a quarter turn back
    expect(TWIST_RATE).toBe(0.25);
    close(m, [0, -1, 1, 0]);
  });
});
