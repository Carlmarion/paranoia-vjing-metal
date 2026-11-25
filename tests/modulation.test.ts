import { describe, expect, test } from 'vitest';
import { createModulation, gate, modulate, modulateNorm, type Geom, type Modulation } from '../src/display/modulation';
import { idleFrame } from '../src/display/audio/dsp';
import { PARAMS, PARAM_INDEX, fromNorm, paramDef, toNorm, type ParamId } from '../src/shared/params';
import { bandValue, type AudioFrame } from '../src/shared/protocol';
import { defaultLook, defaultSession, type Look, type Session } from '../src/shared/state';
import { clamp01, mulberry32 } from '../src/shared/math';

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
    look.params.rotation.lock = true;
    for (const t of [0, 13, 77.7, 400, 9999]) expect(valueOf('rotation', look, s, frame(), t)).toBeCloseTo(0, 9);
    look.params.rotation.lock = false;
    const moved = [13, 77.7, 400, 9999].some((t) => Math.abs(valueOf('rotation', look, s, frame(), t)) > 1e-3);
    expect(moved).toBe(true);
  });

  test('params without a drift period never drift; autopilot 0 and fallback disable drift', () => {
    const look = defaultLook();
    for (const t of [5, 50, 500]) {
      expect(valueOf('sat', look, { ...defaultSession(), autopilot: 1 }, frame(), t)).toBeCloseTo(0.9, 6);
      expect(valueOf('rotation', look, { ...defaultSession(), autopilot: 0 }, frame(), t)).toBeCloseTo(0, 9);
      expect(valueOf('rotation', look, { ...defaultSession(), autopilot: 1, fallback: true }, frame(), t)).toBeCloseTo(0, 9);
    }
  });

  test('drift amplitude is autopilot × driftAmp in normalised units', () => {
    const d = paramDef('rotation');
    const look = defaultLook();
    for (let t = 0; t < 2000; t += 7.3) {
      const u = modulateNorm(d, look.params.rotation, PARAM_INDEX.rotation, 0, 1, 1, t);
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

describe('spin (B4.3)', () => {
  const spinLook = (rpm: number, react = 0): Look => {
    const look = defaultLook();
    look.params.spin = { base: rpm, react, band: 'low', thr: 0, lock: false };
    return look;
  };
  /** Shortest distance between two phases on the 0…1 circle. */
  const circ = (a: number, b: number): number => { const d = Math.abs(a - b) % 1; return Math.min(d, 1 - d); };

  test('advances by spin / 60 turns per second, stays in 0…1', () => {
    const m = createModulation();
    for (let i = 0; i < 60 * 45; i++) modulate(m, spinLook(2), noDrift(), frame(), 0, 1 / 60);
    expect(circ(m.spinPhase, 0.5)).toBeLessThan(1e-6); // 45 s at 2 turns/min = 1.5 turns
    expect(m.spinPhase).toBeGreaterThanOrEqual(0);
    expect(m.spinPhase).toBeLessThan(1);
  });

  test('negative speed spins the other way', () => {
    const m = createModulation();
    for (let i = 0; i < 60 * 15; i++) modulate(m, spinLook(-1), noDrift(), frame(), 0, 1 / 60);
    expect(circ(m.spinPhase, 0.75)).toBeLessThan(1e-6);
  });

  test('base 0 with react: the sound turns it, and it stays where the sound left it', () => {
    const m = createModulation();
    for (let i = 0; i < 30; i++) modulate(m, spinLook(0, 0.6), noDrift(), frame({ low: 1 }), 0, 1 / 60);
    const turned = m.spinPhase;
    expect(circ(turned, 0)).toBeGreaterThan(0.01);
    for (let i = 0; i < 60 * 3; i++) modulate(m, spinLook(0, 0.6), noDrift(), frame({ low: 0 }), 0, 1 / 60);
    expect(m.spinPhase).toBeCloseTo(turned, 9);
  });

  test('base 0 and react 0: glides back to upright by the shortest way, without jumps', () => {
    for (const start of [0.3, 0.8]) {
      const m = createModulation();
      m.spinPhase = start;
      let prev = start;
      for (let i = 0; i < 60 * 4; i++) {
        modulate(m, spinLook(0), noDrift(), frame(), 0, 1 / 60);
        expect(circ(m.spinPhase, prev)).toBeLessThanOrEqual(0.05);
        expect(circ(m.spinPhase, 0)).toBeLessThanOrEqual(circ(prev, 0) + 1e-12);
        prev = m.spinPhase;
      }
      expect(m.spinPhase).toBe(0);
    }
  });
});

describe('the stop and the zones (design §4.4, §4.5)', () => {
  const geom: Geom = { radius: 0.8, ax: 1, ay: 1, morphing: false };
  /** No drift; nothing but zoom/mirrorShift grows the picture; zoom reacts fully to low. */
  function quietLook(): Look {
    const look = defaultLook();
    for (const id of ['thickness', 'spikeAmp', 'warpAmt', 'tiltAmt'] as const) {
      look.params[id].base = 0;
      look.params[id].react = 0;
    }
    look.params.zoom = { base: 1, react: 1, band: 'low', thr: 0, lock: false };
    return look;
  }
  function run(look: Look, session: Session, fr: AudioFrame): Modulation {
    const m = createModulation();
    modulate(m, look, session, fr, 0, 1 / 60, geom);
    return m;
  }
  const z = paramDef('zoom');
  const ms = paramDef('mirrorShift');

  test('sound stops at the red line; with the stop off it passes', () => {
    const on = run(quietLook(), noDrift(), frame({ low: 1 })).values[PARAM_INDEX.zoom];
    expect(on).toBeCloseTo(1.25, 3);
    const off = run(quietLook(), { ...noDrift(), zoomStop: false }, frame({ low: 1 })).values[PARAM_INDEX.zoom];
    expect(off).toBeCloseTo(fromNorm(z, clamp01(toNorm(z, 1) + 1)), 6);
  });

  test('the hand past red is never pulled back', () => {
    const look = quietLook();
    look.params.zoom.base = 1.5;
    expect(run(look, noDrift(), frame({ low: 1 })).values[PARAM_INDEX.zoom]).toBe(1.5);
  });

  test('negative react still pulls in', () => {
    const look = quietLook();
    look.params.zoom.react = -1;
    look.params.zoom.base = 1.5;
    expect(run(look, noDrift(), frame({ low: 1 })).values[PARAM_INDEX.zoom]).toBeLessThan(1.5);
  });

  test('mirror shift stops where the ink touches, with zoom at its hand value', () => {
    const look = quietLook();
    look.params.zoom.react = 0;
    look.options.mirrorY = true;
    look.params.mirrorShift = { base: 0, react: 1, band: 'low', thr: 0, lock: false };
    expect(run(look, noDrift(), frame({ low: 1 })).values[PARAM_INDEX.mirrorShift]).toBeCloseTo(0.2, 3);
  });

  test('zones use the picture at rest: they do not move with the kick', () => {
    const quiet = run(quietLook(), noDrift(), frame({ low: 0 })).zones.zoom;
    const kick = run(quietLook(), noDrift(), frame({ low: 1 })).zones.zoom;
    expect(quiet[1]).toBeCloseTo(toNorm(z, 1.25), 3);
    expect(kick).toEqual(quiet);
    expect(quiet[0]).toBeLessThanOrEqual(quiet[1]);
  });

  test('no mirror → no mirror-shift zones; mirror → zones', () => {
    expect(run(quietLook(), noDrift(), frame()).zones.mirrorShift).toEqual([1, 1]);
    const look = quietLook();
    look.options.mirrorY = true;
    expect(run(look, noDrift(), frame()).zones.mirrorShift[1]).toBeCloseTo(toNorm(ms, 0.2), 3);
  });

  test('fallback and no geometry: no stop', () => {
    const free = fromNorm(z, clamp01(toNorm(z, 1) + 1));
    expect(run(quietLook(), { ...noDrift(), fallback: true }, frame({ low: 1 })).values[PARAM_INDEX.zoom]).toBeCloseTo(free, 6);
    const m = createModulation();
    modulate(m, quietLook(), noDrift(), frame({ low: 1 }), 0, 1 / 60);
    expect(m.values[PARAM_INDEX.zoom]).toBeCloseTo(free, 6);
    expect(m.zones.zoom).toEqual([1, 1]);
  });
});

describe('envelope stage (design §5.2)', () => {
  const kickLook = (): Look => {
    const look = defaultLook();
    look.params.zoom = { base: 0.85, react: 0.5, band: 'low', thr: 0, lock: false };
    look.params.waveAmt = { base: 0.4, react: 0.3, band: 'low', thr: 0, lock: false };
    return look;
  };

  test('neutral envelopes: 600 random frames equal the B4.1 formula exactly', () => {
    const rng = mulberry32(17);
    const look = defaultLook();
    for (const def of PARAMS) {
      look.params[def.id].react = rng() * 2 - 1;
      look.params[def.id].band = (['low', 'mid', 'high', 'beat', 'energy', 'none'] as const)[Math.floor(rng() * 6)];
      look.params[def.id].thr = rng() * 0.5;
    }
    const session: Session = { ...defaultSession(), zoomStop: false };
    const m = createModulation();
    for (let f = 0; f < 600; f++) {
      const fr = frame({ low: rng(), mid: rng(), high: rng(), beat: rng(), energy: rng() });
      const dt = 1 / (30 + rng() * 90);
      modulate(m, look, session, fr, f * 0.01, dt);
      for (let i = 0; i < PARAMS.length; i++) {
        const def = PARAMS[i];
        const ps = look.params[def.id];
        const u = modulateNorm(def, ps, i, bandValue(ps.band, fr), session.autopilot, session.reactMaster, f * 0.01);
        expect(m.norm[i]).toBe(Math.fround(u));
      }
    }
  });

  test('a shape tail lingers after the sound stops; inner has no envelope', () => {
    const look = kickLook();
    look.env.shape = { attack: 0, sustain: 1, decay: 1, release: 2 };
    const m = createModulation();
    for (let i = 0; i < 30; i++) modulate(m, look, noDrift(), frame({ low: 1 }), 0, 1 / 60);
    for (let i = 0; i < 60; i++) modulate(m, look, noDrift(), frame({ low: 0 }), 0, 1 / 60);
    expect(m.values[PARAM_INDEX.zoom]).toBeGreaterThan(0.86);
    expect(m.values[PARAM_INDEX.waveAmt]).toBeCloseTo(0.4, 6);
  });

  test('each crossing of the threshold is one hit; a held sound is one hit (Carl: trigger lines)', () => {
    const look = kickLook();
    look.params.zoom.thr = 0.2;
    const m = createModulation();
    for (let k = 0; k < 5; k++) {
      for (let i = 0; i < 6; i++) modulate(m, look, noDrift(), frame({ low: 1 }), 0, 1 / 60);
      for (let i = 0; i < 20; i++) modulate(m, look, noDrift(), frame({ low: 0 }), 0, 1 / 60);
    }
    expect(m.envHits.shape).toBe(5);
    for (let i = 0; i < 300; i++) modulate(m, look, noDrift(), frame({ low: 1 }), 0, 1 / 60);
    expect(m.envHits.shape).toBe(6);
  });

  test('wobbling around the threshold does not count twice (hysteresis)', () => {
    const look = kickLook();
    look.params.zoom.thr = 0;
    const m = createModulation();
    for (let i = 0; i < 60; i++) modulate(m, look, noDrift(), frame({ low: i % 2 ? 0.3 : 0.1 }), 0, 1 / 60);
    expect(m.envHits.shape).toBe(1);
  });

  test('params with react 0 or band none do not count; inner has no hits', () => {
    const look = defaultLook();
    for (const def of PARAMS) look.params[def.id].react = 0;
    look.params.thickness = { base: 0, react: 0, band: 'low', thr: 0, lock: false };
    const m = createModulation();
    modulate(m, look, noDrift(), frame({ low: 1 }), 0, 1 / 60);
    expect(m.envHits.line).toBe(0);
    expect((m.envHits as Record<string, unknown>).inner).toBeUndefined();
  });

});

describe('wobble tilt', () => {
  const tiltLook = (amt: number, angle: number, speed = 0): Look => {
    const look = defaultLook();
    look.params.tiltAmt = { base: amt, react: 0, band: 'none', thr: 0, lock: false };
    look.params.tiltAngle = { base: angle, react: 0, band: 'none', thr: 0, lock: false };
    look.params.tiltSpeed = { base: speed, react: 0, band: 'none', thr: 0, lock: false };
    return look;
  };

  test('amount and angle give the lean vector', () => {
    const m = createModulation();
    modulate(m, tiltLook(0.2, 0), noDrift(), frame(), 0, 1 / 60);
    expect(m.tilt[0]).toBeCloseTo(0.2, 6);
    expect(m.tilt[1]).toBeCloseTo(0, 6);
    modulate(m, tiltLook(0.2, 0.25), noDrift(), frame(), 0, 1 / 60);
    expect(m.tilt[0]).toBeCloseTo(0, 6);
    expect(m.tilt[1]).toBeCloseTo(0.2, 6);
  });

  test('speed turns the direction: 6 turns/min is one turn in 10 s, a quarter in 2.5 s', () => {
    const m = createModulation();
    for (let i = 0; i < 150; i++) modulate(m, tiltLook(0.2, 0, 6), noDrift(), frame(), 0, 1 / 60);
    expect(m.tilt[0]).toBeCloseTo(0, 3);
    expect(m.tilt[1]).toBeCloseTo(0.2, 3);
    for (let i = 0; i < 450; i++) modulate(m, tiltLook(0.2, 0, 6), noDrift(), frame(), 0, 1 / 60);
    expect(m.tilt[0]).toBeCloseTo(0.2, 3);
  });

  test('the sound drives the amount: no lean at rest, a lean on the kick', () => {
    const look = tiltLook(0, 0.125);
    look.params.tiltAmt = { base: 0, react: 0.5, band: 'low', thr: 0, lock: false };
    const m = createModulation();
    modulate(m, look, noDrift(), frame({ low: 0 }), 0, 1 / 60);
    expect(Math.hypot(m.tilt[0], m.tilt[1])).toBe(0);
    modulate(m, look, noDrift(), frame({ low: 1 }), 0, 1 / 60);
    expect(Math.hypot(m.tilt[0], m.tilt[1])).toBeCloseTo(0.2, 6);
    expect(m.tilt[0]).toBeCloseTo(m.tilt[1], 6);
  });
});
