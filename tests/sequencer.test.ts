import { describe, expect, test } from 'vitest';
import { Sequencer, easeMorph, invertMorph, type SeqCommand, type SeqOutput } from '../src/display/sequencer';
import { idleFrame } from '../src/display/audio/dsp';
import type { AudioFrame } from '../src/shared/protocol';
import { defaultOptions, defaultSession, type LookOptions, type Session } from '../src/shared/state';
import { mulberry32, streamRng } from '../src/shared/math';
import { Autopilot, type AutopilotContext } from '../src/display/autopilot';
import { initialModel, reduce } from '../src/display/store';
import { savePreset } from '../src/display/presets';
import { emptyPresets, defaultLook } from '../src/shared/state';

const FPS = 60;
const DT = 1 / FPS;
const LINGERS = [0, 0.25, 0.5, 0.75, 1];

const silentFrame = (): AudioFrame => idleFrame();
const beatFrame = (onset: boolean, beatPeriod = 0.476): AudioFrame =>
  ({ ...idleFrame(), silent: false, onset, beatPeriod });

/** Steps a sequencer the way display/main.ts does, applying its session patches like the store. */
class Sim {
  seq: Sequencer;
  session: Session;
  options: LookOptions;
  linger = 0.5;
  t = 0;
  outs: SeqOutput[] = [];
  constructor(seed: number, public count = 12, opts: Partial<LookOptions> = {}, sess: Partial<Session> = {}) {
    this.options = { ...defaultOptions(), ...opts };
    this.session = { ...defaultSession(), ...sess };
    this.seq = new Sequencer(seed, this.options.holdBeats);
  }
  step(frame: AudioFrame = silentFrame()): SeqOutput {
    this.t += DT;
    const o = this.seq.step(DT, frame, { count: this.count, options: this.options, session: this.session, linger: this.linger });
    if (o.sessionPatch) this.session = { ...this.session, ...o.sessionPatch };
    this.outs.push(o);
    return o;
  }
  run(seconds: number, frameAt: (t: number) => AudioFrame = silentFrame): void {
    const n = Math.round(seconds * FPS);
    for (let i = 0; i < n; i++) this.step(frameAt(this.t + DT));
  }
  /** Motifs shown at rest, in order (A after each landing). */
  shown(): number[] {
    const s: number[] = [this.outs[0]?.motifA ?? 0];
    for (const o of this.outs) if (o.motifA !== s[s.length - 1]) s.push(o.motifA);
    return s;
  }
}

/** The shape on screen is the same, or uMorphT moved by ≤ 0.05 on the same pair. */
function shownMotif(o: SeqOutput): number | null {
  if (o.motifA === o.motifB || o.morphT <= 1e-9) return o.motifA;
  if (o.morphT >= 1 - 1e-9) return o.motifB;
  return null;
}
function expectContinuous(outs: SeqOutput[]): void {
  for (let i = 1; i < outs.length; i++) {
    const a = outs[i - 1];
    const b = outs[i];
    if (a.motifA === b.motifA && a.motifB === b.motifB) {
      expect(Math.abs(b.morphT - a.morphT), `frame ${i}`).toBeLessThanOrEqual(0.05);
    } else {
      const sa = shownMotif(a);
      expect(sa, `frame ${i}: pair changed mid-morph`).not.toBeNull();
      expect(shownMotif(b), `frame ${i}`).toBe(sa);
    }
  }
}

describe('eased curve (B7.2)', () => {
  test('uMorphT = 0.5 at p = 0.5 for every linger', () => {
    for (const l of LINGERS) expect(easeMorph(0.5, l)).toBeCloseTo(0.5, 12);
  });

  test('zero speed at p = 0 and p = 1, endpoints exact', () => {
    const h = 1e-4;
    for (const l of LINGERS) {
      expect(easeMorph(0, l)).toBe(0);
      expect(easeMorph(1, l)).toBe(1);
      expect((easeMorph(h, l) - easeMorph(0, l)) / h).toBeLessThan(1e-3);
      expect((easeMorph(1, l) - easeMorph(1 - h, l)) / h).toBeLessThan(1e-3);
    }
  });

  test('strictly increasing for every linger', () => {
    for (let l = 0; l <= 1.0001; l += 0.05) {
      let prev = -1;
      for (let i = 0; i <= 2000; i++) {
        const y = easeMorph(i / 2000, l);
        expect(y).toBeGreaterThan(prev);
        prev = y;
      }
    }
  });

  test('inversion by bisection returns p within 1e-4', () => {
    for (let l = 0; l <= 1.0001; l += 0.1) {
      for (let i = 0; i <= 200; i++) {
        const p = i / 200;
        expect(Math.abs(invertMorph(easeMorph(p, l), l) - p)).toBeLessThan(1e-4);
      }
    }
  });
});

describe('motif order', () => {
  test('same seed + same beat stream → same motif sequence', () => {
    const stream = (t: number) => beatFrame(Math.abs((t % 0.5) - 0) < DT / 2 + 1e-9);
    const run = (seed: number) => {
      const s = new Sim(seed, 12, { holdBeats: 16, morphBeats: 4 });
      s.run(240, stream);
      return s.shown();
    };
    const a = run(7);
    expect(a.length).toBeGreaterThan(10);
    expect(run(7)).toEqual(a);
    expect(run(8)).not.toEqual(a);
  });

  for (const count of [5, 6, 12]) {
    test(`no motif repeats within 3 transitions (count ${count})`, () => {
      const s = new Sim(123, count, { holdBeats: 16, morphBeats: 4 });
      s.run(1200);
      const seq = s.shown();
      expect(seq.length).toBeGreaterThan(80);
      for (let i = 0; i + 3 < seq.length; i++) expect(new Set(seq.slice(i, i + 4)).size).toBe(4);
    });
  }

  test('with count ≤ 4 the target is never the current motif', () => {
    const s = new Sim(5, 3, { holdBeats: 16, morphBeats: 4 });
    s.run(600);
    const seq = s.shown();
    expect(seq.length).toBeGreaterThan(20);
    for (let i = 1; i < seq.length; i++) expect(seq[i]).not.toBe(seq[i - 1]);
  });

  test('sequential order steps through every motif', () => {
    const s = new Sim(1, 5, { holdBeats: 16, morphBeats: 4 }, { order: 'sequential' });
    s.run(200);
    expect(s.shown().slice(0, 7)).toEqual([0, 1, 2, 3, 4, 0, 1]);
  });

  test('queued motif is used as the next target and cleared', () => {
    const s = new Sim(1, 12, { holdBeats: 16, morphBeats: 4 }, { queued: 9 });
    s.run(20);
    expect(s.shown()[1]).toBe(9);
    expect(s.session.queued).toBeNull();
  });
});

describe('beats and timing', () => {
  test('in silence a morph still starts after holdBeats × 0.5 s', () => {
    for (const holdBeats of [16, 32] as const) {
      const s = new Sim(3, 12, { holdBeats });
      s.run(holdBeats * 0.5 + 1);
      const first = s.outs.findIndex((o) => o.phase === 'morph');
      expect(Math.abs((first + 1) / FPS - holdBeats * 0.5)).toBeLessThanOrEqual(DT + 1e-9);
    }
  });

  test('no onset for 3 s starts the virtual clock even when not silent', () => {
    const s = new Sim(3);
    s.run(10, () => beatFrame(false));
    const beats = s.outs.reduce((n, o) => n + o.beats, 0);
    expect(Math.abs(beats - 20)).toBeLessThanOrEqual(1); // the clock runs from boot
  });

  test('real onsets count one beat each and the morph lasts morphBeats × beatPeriod', () => {
    const s = new Sim(3, 12, { holdBeats: 16, morphBeats: 8 });
    let k = 0;
    s.run(30, () => beatFrame(++k % 30 === 0, 0.5)); // an onset every 0.5 s
    const start = s.outs.findIndex((o) => o.phase === 'morph');
    const end = s.outs.findIndex((o, i) => i > start && o.phase === 'hold');
    expect((start + 1) / FPS).toBeCloseTo(8, 0); // 16 onsets
    expect((end - start) / FPS).toBeCloseTo(4, 1); // 8 beats × 0.5 s
  });

  test('frozen stops the sequencer', () => {
    const s = new Sim(3, 12, { holdBeats: 16 }, { frozen: true });
    s.run(30);
    expect(s.outs.every((o) => o.phase === 'hold' && o.motifA === 0)).toBe(true);
    expect(s.outs.at(-1)?.beats).toBeGreaterThanOrEqual(0);
  });

  test('autoAdvance off holds forever at 0 remaining', () => {
    const s = new Sim(3, 12, { holdBeats: 16 }, { autoAdvance: false });
    s.run(30);
    expect(s.outs.every((o) => o.phase === 'hold')).toBe(true);
    expect(s.outs.at(-1)?.holdRemaining).toBe(0);
  });
});

describe('commands (B7.3)', () => {
  test('next / goto / random start a morph now; prev goes back', () => {
    const s = new Sim(11, 12, { holdBeats: 128, morphBeats: 4 });
    s.run(1);
    s.seq.command({ name: 'goto', index: 5 });
    expect(s.step().motifB).toBe(5);
    s.run(5);
    expect(s.outs.at(-1)?.motifA).toBe(5);
    s.seq.command({ name: 'next' });
    const nb = s.step().motifB;
    expect(nb).not.toBe(5);
    s.run(5);
    s.seq.command({ name: 'prev' });
    expect(s.step().motifB).toBe(5);
    s.run(5);
    s.seq.command({ name: 'prev' });
    expect(s.step().motifB).toBe(0);
    s.run(5);
    s.seq.command({ name: 'random' });
    expect(s.step().phase).toBe('morph');
  });

  test('a command during a morph speeds it up to finish within 1 s, then runs', () => {
    const s = new Sim(11, 12, { holdBeats: 16, morphBeats: 64 }); // 32 s morphs in silence
    s.run(8.5);
    expect(s.outs.at(-1)?.phase).toBe('morph');
    const i0 = s.outs.length;
    s.seq.command({ name: 'goto', index: 3 });
    s.run(1.2);
    const landed = s.outs.findIndex((o, i) => i >= i0 && o.phase === 'hold');
    expect(landed).toBeGreaterThan(0);
    expect((landed - i0) / FPS).toBeLessThanOrEqual(1 + 2 * DT);
    expect(s.outs.at(-1)?.motifB).toBe(3);
    expectContinuous(s.outs);
  });
});

describe('uMorphT continuity at 60 fps', () => {
  for (const linger of LINGERS) {
    test(`plain autopilot run, linger ${linger}`, () => {
      const s = new Sim(2, 12, { holdBeats: 16, morphBeats: 4 });
      s.linger = linger;
      s.run(120);
      expectContinuous(s.outs);
      expect(s.outs.some((o) => o.phase === 'morph')).toBe(true);
    });
  }

  test('commands arriving at random moments, including mid-morph', () => {
    const rng = mulberry32(99);
    const s = new Sim(4, 12, { holdBeats: 16, morphBeats: 8 });
    const cmds: SeqCommand[] = [{ name: 'next' }, { name: 'prev' }, { name: 'random' }, { name: 'goto', index: 2 }];
    for (let i = 0; i < 60 * 300; i++) {
      if (rng() < 0.01) s.seq.command(cmds[Math.floor(rng() * cmds.length)]);
      s.linger = 0.3 + 0.4 * Math.sin(i / 500);
      s.step();
    }
    expectContinuous(s.outs);
  });

  test('melt hold entered and left at any position', () => {
    const rng = mulberry32(5);
    for (const linger of LINGERS) {
      const s = new Sim(6, 12, { holdBeats: 16, morphBeats: 16 });
      s.linger = linger;
      for (let i = 0; i < 60 * 400; i++) {
        if (rng() < 0.02) s.session = { ...s.session, meltHold: !s.session.meltHold };
        s.step();
      }
      expectContinuous(s.outs);
      expect(s.outs.some((o) => o.phase === 'meltHold' && o.morphT > 0.05 && o.morphT < 0.95)).toBe(true);
    }
  });

  test('melt hold sets uMorphT = holdPos directly and resumes from it', () => {
    const s = new Sim(6, 12, { holdBeats: 16, morphBeats: 16 });
    s.run(12); // HOLD ends at 8 s, then morph for 8 s
    const before = s.outs.at(-1)!;
    expect(before.phase).toBe('morph');
    s.session = { ...s.session, meltHold: true };
    const enter = s.step();
    expect(enter.morphT).toBe(before.morphT);
    expect(s.session.holdPos).toBe(before.morphT);
    s.session = { ...s.session, holdPos: 0.8 }; // user scrubs
    expect(s.step().morphT).toBe(0.8);
    s.run(5);
    expect(s.outs.at(-1)?.morphT).toBe(0.8); // paused
    s.session = { ...s.session, meltHold: false };
    const leave = s.step();
    expect(leave.phase).toBe('morph');
    expect(Math.abs(leave.morphT - 0.8)).toBeLessThan(0.01);
  });

  test('melt hold entered during HOLD picks B first and starts at A', () => {
    const s = new Sim(6, 12, { holdBeats: 128 });
    s.run(1);
    s.session = { ...s.session, meltHold: true, holdPos: 0.6 };
    const o = s.step();
    expect(o.phase).toBe('meltHold');
    expect(o.motifB).not.toBe(o.motifA);
    expect(o.morphT).toBe(0);
    expect(s.session.holdPos).toBe(0);
  });
});

describe('randomness streams (B7.5)', () => {
  test('randomize and mutate never shift the motif order', () => {
    const run = (withRandomize: boolean) => {
      const s = new Sim(31, 12, { holdBeats: 16, morphBeats: 4 });
      let model = initialModel(31, null).model;
      const env = { rng: streamRng(31, 'presets'), nowMs: 0, motifCount: 12 };
      for (let i = 0; i < 60 * 120; i++) {
        if (withRandomize && i % 97 === 0) {
          model = reduce(model, { t: 'cmd', name: i % 2 ? 'randomize' : 'mutate' }, env).model;
        }
        s.step();
      }
      return s.shown();
    };
    expect(run(true)).toEqual(run(false));
  });
});

describe('autopilot (B7.5)', () => {
  const ctx = (o: Partial<AutopilotContext> = {}, sess: Partial<Session> = {}, opts: Partial<LookOptions> = {}): AutopilotContext => ({
    options: { ...defaultOptions(), ...opts }, session: { ...defaultSession(), ...sess }, presets: emptyPresets(), currentPreset: null, ...o,
  });

  test('driftT advances at (0.5 + energy) × dt and stops when frozen', () => {
    const ap = new Autopilot(1);
    for (let i = 0; i < 60; i++) ap.step(DT, 0, { ...idleFrame(), energy: 0.5 }, ctx());
    expect(ap.driftT).toBeCloseTo(1, 9);
    for (let i = 0; i < 60; i++) ap.step(DT, 0, { ...idleFrame(), energy: 0.5 }, ctx({}, { frozen: true }));
    expect(ap.driftT).toBeCloseTo(1, 9);
  });

  test('hue jumps every N beats, by hueJumpAmt, at least 400 ms apart', () => {
    const ap = new Autopilot(1);
    const c = ctx({}, {}, { hueJumpEvery: 1, hueJumpAmt: 0.25 });
    const jumps: number[] = [];
    let last = 0;
    for (let i = 0; i < 600; i++) {
      const o = ap.step(DT, i % 12 === 0 ? 1 : 0, idleFrame(), c); // a beat every 0.2 s
      if (o.hueOffset !== last) { jumps.push(i); last = o.hueOffset; }
    }
    expect(jumps.length).toBeGreaterThan(10);
    for (let k = 1; k < jumps.length; k++) expect((jumps[k] - jumps[k - 1]) * DT).toBeGreaterThanOrEqual(0.4 - 1e-9);
    expect(ap.hueOffset).toBeGreaterThanOrEqual(0);
    expect(ap.hueOffset).toBeLessThan(1);
    const off = new Autopilot(1);
    for (let i = 0; i < 600; i++) off.step(DT, 1, idleFrame(), ctx());
    expect(off.hueOffset).toBe(0);
  });

  test('preset cycle recalls a random non-empty preset that is not the current one', () => {
    let presets = emptyPresets();
    for (const slot of [2, 5, 9]) presets = savePreset(presets, defaultLook(), 0, slot).presets;
    const ap = new Autopilot(4);
    const c = ctx({ presets, currentPreset: 5 }, { presetCycleMin: 2 });
    const recalls: number[] = [];
    for (let i = 0; i < 60 * 60 * 20 + 60; i++) {
      const o = ap.step(DT, 0, idleFrame(), c);
      if (o.recall !== null) recalls.push(o.recall);
    }
    expect(recalls.length).toBe(10);
    for (const r of recalls) expect([2, 9]).toContain(r);
    const none = new Autopilot(4);
    let any = false;
    for (let i = 0; i < 60 * 60 * 3; i++) any ||= none.step(DT, 0, idleFrame(), ctx({ presets }, { presetCycleMin: 0 })).recall !== null;
    expect(any).toBe(false);
  });
});
