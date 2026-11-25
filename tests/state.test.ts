import { describe, expect, test } from 'vitest';
import { keyAction } from '../src/shared/keys';
import { fromNorm, paramDef, toNorm } from '../src/shared/params';
import { ENV_GROUPS, LOOK_VERSION, defaultLook, defaultSession, migrateLook, neutralEnv, serialiseLook } from '../src/shared/state';
import { clamp, clamp01 } from '../src/shared/math';

describe('Look v2 zoom migration (design §4.1)', () => {
  test('v1 Look keeps the same zoom push at its base', () => {
    for (const [base, react] of [[0.85, 0.06], [0.7, 0.5], [1.2, -0.3], [0.5, 0]] as const) {
      const look = migrateLook({ params: { zoom: { base, react, band: 'low', thr: 0, lock: false } } });
      const z = paramDef('zoom');
      const pushed = fromNorm(z, clamp01(toNorm(z, base) + look.params.zoom.react));
      const old = clamp(base + react * 0.9, 0.5, 1.4);
      expect(pushed).toBeCloseTo(Math.max(old, 0.5), 2);
      expect(look.v).toBe(2);
    }
  });

  test('a v1 Look without a stored zoom react keeps the default react', () => {
    expect(migrateLook({ params: { zoom: { base: 1.2 } } }).params.zoom.react).toBe(paramDef('zoom').react);
  });

  test('a v2 Look is not converted again', () => {
    const once = migrateLook({ params: { zoom: { base: 0.85, react: 0.06, band: 'low', thr: 0, lock: false } } });
    expect(migrateLook(JSON.parse(serialiseLook(once))).params.zoom.react).toBe(once.params.zoom.react);
  });

  test('the default Look is v2 and has the new zoom row', () => {
    expect(LOOK_VERSION).toBe(2);
    expect(defaultLook().v).toBe(2);
    expect(defaultLook().params.zoom.react).toBe(0.034);
    expect(paramDef('zoom').scale).toBe('log');
    expect(paramDef('zoom').max).toBe(3);
  });
});

describe('Look.env migration (design §5.3)', () => {
  test('a Look without env gets neutral envelopes', () => {
    const look = migrateLook({ params: {} });
    for (const g of ENV_GROUPS) expect(look.env[g]).toEqual(neutralEnv());
  });

  test('out-of-range numbers are clamped, wrong types fall back', () => {
    const look = migrateLook({ env: { shape: { attack: 9, sustain: -1, decay: 0, release: 'x' } } });
    expect(look.env.shape).toEqual({ attack: 2, sustain: 0, decay: 0.05, release: 0 });
  });
});

describe('keys', () => {
  test('A toggles Ambient', () => {
    expect(keyAction('a', null)).toEqual({ kind: 'msg', msg: { t: 'cmd', name: 'ambient' } });
    expect(keyAction('0', null)).toEqual({ kind: 'msg', msg: { t: 'cmd', name: 'zero' } });
    expect(keyAction('A', null)).toEqual({ kind: 'msg', msg: { t: 'cmd', name: 'ambient' } });
  });
});

describe('session defaults', () => {
  test('the autopilot starts at 0: no drift after a reload until it is raised by hand', () => {
    expect(defaultSession().autopilot).toBe(0);
  });
});

describe('tilt migration (wobble)', () => {
  test('a stored tiltX/tiltY lean becomes the same amount and direction', () => {
    const look = migrateLook({ v: 2, params: { tiltX: { base: 0.1, react: 0, band: 'none', thr: 0, lock: false }, tiltY: { base: 0.1, react: 0, band: 'none', thr: 0, lock: true } } });
    expect(look.params.tiltAmt.base).toBeCloseTo(Math.hypot(0.1, 0.1), 9);
    expect(look.params.tiltAngle.base).toBeCloseTo(0.125, 9);
    expect(look.params.tiltSpeed.base).toBe(0);
    expect(look.params.tiltAmt.lock).toBe(true);
  });

  test('a stored reaction on tiltX carries over to the amount, pointing its way', () => {
    const look = migrateLook({ v: 2, params: { tiltX: { base: 0, react: -0.3, band: 'low', thr: 0.2, lock: false } } });
    expect(look.params.tiltAmt.react).toBeCloseTo(0.6, 9);
    expect(look.params.tiltAmt.band).toBe('low');
    expect(look.params.tiltAmt.thr).toBe(0.2);
    expect(look.params.tiltAngle.base).toBeCloseTo(0.5, 9);
  });

  test('no stored tilt → defaults', () => {
    const look = migrateLook({ params: {} });
    expect(look.params.tiltAmt).toEqual(defaultLook().params.tiltAmt);
    expect(look.params.tiltAngle).toEqual(defaultLook().params.tiltAngle);
  });
});
