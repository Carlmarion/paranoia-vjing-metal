import { describe, expect, test } from 'vitest';
import { createModulation, gate, modulate, modulateNorm } from '../src/display/modulation';
import { idleFrame } from '../src/display/audio/dsp';
import { PARAMS, PARAM_INDEX, fromNorm, paramDef, toNorm, type ParamId } from '../src/shared/params';
import type { AudioFrame } from '../src/shared/protocol';
import { defaultLook, defaultSession, type Look, type Session } from '../src/shared/state';
import { mulberry32 } from '../src/shared/math';

const frame = (o: Partial<AudioFrame> = {}): AudioFrame => ({ ...idleFrame(), silent: false, ...o });
const noDrift = (): Session => ({ ...defaultSession(), autopilot: 0 });

function valueOf(id: ParamId, look: Look, session: Session, fr: AudioFrame, driftT = 0): number {
  const m = createModulation();
  modulate(m, look, session, fr, driftT, 1 / 60);
  return m.values[PARAM_INDEX[id]];
}

describe('threshold gate', () => {
  test('band below thr → no change; band = 1 → full react', () => {
    const look = defaultLook();
    look.params.zoom = { base: 0.85, react: 0.5, band: 'low', thr: 0.3, lock: false };
    const z = paramDef('zoom');
    expect(valueOf('zoom', look, noDrift(), frame({ low: 0.2 }))).toBeCloseTo(0.85, 6);
    expect(valueOf('zoom', look, noDrift(), frame({ low: 0.3 }))).toBeCloseTo(0.85, 6);
    expect(valueOf('zoom', look, noDrift(), frame({ low: 1 }))).toBeCloseTo(fromNorm(z, toNorm(z, 0.85) + 0.5), 6);
  });

  test('gate is linear above thr and closed at thr ≥ 1', () => {
    expect(gate(0.65, 0.3)).toBeCloseTo(0.5, 9);
    expect(gate(1, 0)).toBe(1);
    expect(gate(1, 1)).toBe(0);
    expect(gate(0.1, 0.5)).toBe(0);
  });

  test("band 'none' never reacts; reactMaster scales the reaction", () => {
    const look = defaultLook();
    look.params.glow = { base: 0.2, react: 1, band: 'none', thr: 0, lock: false };
    expect(valueOf('glow', look, noDrift(), frame({ low: 1, mid: 1, high: 1, beat: 1 }))).toBeCloseTo(0.2, 6);
    look.params.glow.band = 'beat';
    expect(valueOf('glow', look, { ...noDrift(), reactMaster: 0.5 }, frame({ beat: 0.6 }))).toBeCloseTo(0.5, 6);
    expect(valueOf('glow', look, { ...noDrift(), reactMaster: 0 }, frame({ beat: 1 }))).toBeCloseTo(0.2, 6);
  });

  test("'energy' reads energy30 and negative react pulls down", () => {
    const look = defaultLook();
    look.params.waveAmt = { base: 0.5, react: -0.5, band: 'energy', thr: 0, lock: false };
    expect(valueOf('waveAmt', look, noDrift(), frame({ energy: 1 }))).toBeCloseTo(0, 6);
  });
});

describe('scales', () => {
  test('log: fromNorm is geometric', () => {
    const d = paramDef('warpScale'); // 0.5…8
    expect(fromNorm(d, 0.5)).toBeCloseTo(2, 9);
    expect(toNorm(d, 2)).toBeCloseTo(0.5, 9);
    const look = defaultLook();
    look.params.warpScale = { base: 2, react: 0.25, band: 'high', thr: 0, lock: false };
    expect(valueOf('warpScale', look, noDrift(), frame({ high: 1 }))).toBeCloseTo(0.5 * Math.pow(16, 0.75), 6);
  });

  test('wrap: hue wraps instead of clamping', () => {
    const look = defaultLook();
    look.params.hue = { base: 0.9, react: 0.3, band: 'low', thr: 0, lock: false };
    expect(valueOf('hue', look, noDrift(), frame({ low: 1 }))).toBeCloseTo(0.2, 6);
    look.params.hue = { base: 0.1, react: -0.3, band: 'low', thr: 0, lock: false };
    expect(valueOf('hue', look, noDrift(), frame({ low: 1 }))).toBeCloseTo(0.8, 6);
  });
});

describe('drift', () => {
  test('lock removes drift', () => {
    const look = defaultLook();
    const s = { ...defaultSession(), autopilot: 1 };
    look.params.tiltX.lock = true;
    for (const t of [0, 13, 77.7, 400, 9999]) expect(valueOf('tiltX', look, s, frame(), t)).toBeCloseTo(0, 9);
    look.params.tiltX.lock = false;
    const moved = [13, 77.7, 400, 9999].some((t) => Math.abs(valueOf('tiltX', look, s, frame(), t)) > 1e-3);
    expect(moved).toBe(true);
  });

  test('params without a drift period never drift; autopilot 0 and fallback disable drift', () => {
    const look = defaultLook();
    for (const t of [5, 50, 500]) {
      expect(valueOf('sat', look, { ...defaultSession(), autopilot: 1 }, frame(), t)).toBeCloseTo(0.9, 6);
      expect(valueOf('tiltY', look, { ...defaultSession(), autopilot: 0 }, frame(), t)).toBeCloseTo(0, 9);
      expect(valueOf('tiltY', look, { ...defaultSession(), autopilot: 1, fallback: true }, frame(), t)).toBeCloseTo(0, 9);
    }
  });

  test('drift amplitude is autopilot × driftAmp in normalised units', () => {
    const d = paramDef('tiltX');
    const look = defaultLook();
    for (let t = 0; t < 2000; t += 7.3) {
      const u = modulateNorm(d, look.params.tiltX, PARAM_INDEX.tiltX, 0, 1, 1, t);
      expect(Math.abs(u - 0.5)).toBeLessThanOrEqual(d.driftAmp + 1e-9);
    }
  });
});

test('output always inside min…max (fuzz)', () => {
  const rng = mulberry32(42);
  const bands = ['none', 'low', 'mid', 'high', 'energy', 'beat'] as const;
  const m = createModulation();
  for (let k = 0; k < 500; k++) {
    const look = defaultLook();
    for (const def of PARAMS) {
      look.params[def.id] = {
        base: def.min + rng() * (def.max - def.min), react: rng() * 2 - 1,
        band: bands[Math.floor(rng() * 6)], thr: rng() * 0.95, lock: rng() < 0.2,
      };
    }
    const s = { ...defaultSession(), autopilot: rng(), reactMaster: rng() * 2 };
    modulate(m, look, s, frame({ low: rng(), mid: rng(), high: rng(), energy: rng(), beat: rng() }), rng() * 1e4, 1 / 60);
    PARAMS.forEach((def, i) => {
      expect(m.values[i]).toBeGreaterThanOrEqual(def.min - 1e-6);
      expect(m.values[i]).toBeLessThanOrEqual(def.max + 1e-6);
      expect(m.norm[i]).toBeGreaterThanOrEqual(0);
      expect(m.norm[i]).toBeLessThanOrEqual(1);
    });
  }
});

describe('phases (B4.3)', () => {
  test('integrate speed × dt, never jump when speed changes; wave wraps at 1000, warp runs freely', () => {
    const look = defaultLook();
    look.params.waveSpeed = { base: 2, react: 0, band: 'none', thr: 0, lock: false };
    const m = createModulation();
    const s = noDrift();
    for (let i = 0; i < 60; i++) modulate(m, look, s, frame(), 0, 1 / 60);
    expect(m.wavePhase).toBeCloseTo(2, 6);
    look.params.waveSpeed.base = -4;
    const before = m.wavePhase;
    modulate(m, look, s, frame(), 0, 1 / 60);
    expect(Math.abs(m.wavePhase - before)).toBeLessThanOrEqual(4 / 60 + 1e-9);
    m.warpPhase = 999.999;
    modulate(m, look, s, frame(), 0, 1); // warpSpeed 0.15
    expect(m.warpPhase).toBeCloseTo(1000.149, 6);
    m.wavePhase = 0.01;
    modulate(m, look, s, frame(), 0, 1 / 60);
    expect(m.wavePhase).toBeGreaterThan(999);
  });
});
