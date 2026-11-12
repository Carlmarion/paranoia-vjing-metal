// B7.1–B7.4 — motif state machine. Pure logic (no DOM/GL/audio); owns its own PRNG stream.
import type { AudioFrame } from '../shared/protocol';
import type { LookOptions, Session } from '../shared/state';
import { randInt, streamRng, type Rng } from '../shared/math';

// ---------- B7.2 easing ----------

const S = (x: number) => x * x * (3 - 2 * x);

/** p (linear morph progress 0…1) → uMorphT. Strictly increasing for every linger. */
export function easeMorph(p: number, linger: number): number {
  const x = p <= 0 ? 0 : p >= 1 ? 1 : p;
  const smooth = S(x);
  const plateau = x < 0.5 ? 0.5 * S(2 * x) : 0.5 + 0.5 * S(2 * x - 1);
  return smooth + (plateau - smooth) * linger;
}

/** Inverse of easeMorph by bisection (20 iterations, B7.4). */
export function invertMorph(y: number, linger: number): number {
  if (y <= 0) return 0;
  if (y >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (easeMorph(mid, linger) < y) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------- types ----------

export type SeqCommand =
  | { name: 'next' }
  | { name: 'prev' }
  | { name: 'random' }
  | { name: 'goto'; index: number };

export type SeqPhase = 'hold' | 'morph' | 'meltHold';

export interface SeqContext {
  /** Motif count from the manifest. */
  count: number;
  options: LookOptions;
  session: Session;
  /** Effective `linger` (0…1). Main passes last frame's modulated value. */
  linger: number;
}

export interface SeqOutput {
  motifA: number;
  motifB: number;
  /** uMorphT */
  morphT: number;
  phase: SeqPhase;
  /** Beats left in HOLD (0 outside HOLD). */
  holdRemaining: number;
  /** Beats this frame: real onset + virtual clock ticks (B7.1). Feed to the autopilot. */
  beats: number;
  /** Session fields the Display must write back (queued consumed, holdPos on melt-hold entry). */
  sessionPatch: Partial<Session> | null;
}

export const VIRTUAL_BEAT_S = 0.5;
export const NO_ONSET_S = 3;
export const HISTORY_SIZE = 32;
export const RECENT_SIZE = 3;
export const SPEEDUP_S = 1;

// ---------- the machine ----------

export class Sequencer {
  phase: SeqPhase = 'hold';
  a = 0;
  b = 0;
  /** Linear morph progress 0…1. */
  p = 0;
  /** Progress per second; 0 = not yet sampled (melt hold entered from HOLD). */
  rate = 0;
  remaining: number;
  pending: SeqCommand | null = null;
  readonly history: number[] = [];
  readonly recent: number[];
  lastMorphT = 0;
  /** The running morph came from `prev`: don't push its source back onto the history. */
  private poppingPrev = false;
  private sinceOnset = NO_ONSET_S; // virtual clock runs from boot
  private virtAcc = 0;
  private readonly rng: Rng;

  constructor(seed: number, holdBeats = 32, start = 0) {
    this.rng = streamRng(seed, 'sequencer');
    this.a = this.b = start;
    this.recent = [start];
    this.remaining = holdBeats;
  }

  /** B7.3: next/prev/random/goto start a morph now, or speed up the running one and run afterwards. */
  command(cmd: SeqCommand): void {
    this.pending = cmd;
  }

  step(dt: number, frame: AudioFrame, ctx: SeqContext): SeqOutput {
    // B7.1 beat units (runs even when frozen)
    this.sinceOnset = frame.onset ? 0 : this.sinceOnset + dt;
    const virtual = frame.silent || this.sinceOnset >= NO_ONSET_S;
    let beats = frame.onset ? 1 : 0;
    if (virtual) {
      this.virtAcc += dt;
      while (this.virtAcc >= VIRTUAL_BEAT_S) { beats++; this.virtAcc -= VIRTUAL_BEAT_S; }
    } else {
      this.virtAcc = 0;
    }
    const beatPeriod = virtual ? VIRTUAL_BEAT_S : frame.beatPeriod;
    const patch: Partial<Session> = {};
    const { session, linger } = ctx;

    // B7.4 melt hold
    if (session.meltHold) {
      if (this.phase !== 'meltHold') {
        if (this.phase === 'hold') {
          this.b = this.chooseNext(ctx, patch);
          this.p = 0;
          this.rate = 0;
          patch.holdPos = 0;
        } else {
          patch.holdPos = this.lastMorphT;
        }
        this.phase = 'meltHold';
        return this.out(patch.holdPos, beats, patch);
      }
      return this.out(session.holdPos, beats, patch);
    }
    if (this.phase === 'meltHold') {
      this.phase = 'morph';
      this.p = invertMorph(session.holdPos, linger);
      if (this.rate === 0) this.rate = 1 / (ctx.options.morphBeats * beatPeriod);
    }

    if (session.frozen) return this.out(this.phase === 'morph' ? easeMorph(this.p, linger) : 0, beats, patch);

    const wasHold = this.phase === 'hold';
    if (this.phase === 'hold' && this.pending) {
      const cmd = this.pending;
      this.pending = null;
      this.runCommand(cmd, ctx, beatPeriod, patch);
    }
    if (this.phase === 'hold') {
      this.remaining = Math.max(0, this.remaining - beats);
      if (this.remaining === 0 && session.autoAdvance) {
        this.startMorph(this.chooseNext(ctx, patch), ctx, beatPeriod);
      }
    }

    if (this.phase === 'morph') {
      if (wasHold) return this.out(0, beats, patch); // a new morph starts exactly on A
      if (this.pending) this.rate = Math.max(this.rate, (1 - this.p) / SPEEDUP_S);
      this.p = Math.min(1, this.p + this.rate * dt);
      if (this.p >= 1) {
        const out = this.out(1, beats, patch); // land exactly on B this frame
        this.finishMorph(ctx);
        return out;
      }
      return this.out(easeMorph(this.p, linger), beats, patch);
    }
    return this.out(0, beats, patch);
  }

  // ---------- internals ----------

  private out(morphT: number, beats: number, patch: Partial<Session>): SeqOutput {
    this.lastMorphT = morphT;
    const inHold = this.phase === 'hold';
    return {
      motifA: this.a,
      motifB: inHold ? this.a : this.b,
      morphT,
      phase: this.phase,
      holdRemaining: inHold ? this.remaining : 0,
      beats,
      sessionPatch: Object.keys(patch).length ? patch : null,
    };
  }

  private startMorph(target: number, ctx: SeqContext, beatPeriod: number): void {
    this.b = target;
    this.p = 0;
    this.rate = 1 / (ctx.options.morphBeats * beatPeriod);
    this.phase = 'morph';
  }

  private finishMorph(ctx: SeqContext): void {
    if (this.b !== this.a && !this.poppingPrev) {
      this.history.push(this.a);
      if (this.history.length > HISTORY_SIZE) this.history.shift();
    }
    this.poppingPrev = false;
    this.a = this.b;
    this.recent.push(this.a);
    while (this.recent.length > RECENT_SIZE) this.recent.shift();
    this.phase = 'hold';
    this.p = 0;
    this.rate = 0;
    this.remaining = ctx.options.holdBeats;
  }

  private runCommand(cmd: SeqCommand, ctx: SeqContext, beatPeriod: number, patch: Partial<Session>): void {
    let target: number | null = null;
    switch (cmd.name) {
      case 'next': target = this.chooseNext(ctx, patch); break;
      case 'random': target = this.chooseRandom(ctx.count); break;
      case 'goto':
        if (Number.isInteger(cmd.index) && cmd.index >= 0 && cmd.index < ctx.count) target = cmd.index;
        break;
      case 'prev': {
        const h = this.history.pop();
        if (h !== undefined) { target = h; this.poppingPrev = true; }
        break;
      }
    }
    if (target === null || target === this.a) { this.poppingPrev = false; return; }
    this.startMorph(target, ctx, beatPeriod);
  }

  /** Target choice (B7.2): queued if set, else by order. */
  private chooseNext(ctx: SeqContext, patch: Partial<Session>): number {
    const q = ctx.session.queued;
    if (q !== null && Number.isInteger(q) && q >= 0 && q < ctx.count) {
      patch.queued = null;
      return q;
    }
    if (ctx.session.order === 'sequential') return ctx.count > 0 ? (this.a + 1) % ctx.count : 0;
    return this.chooseRandom(ctx.count);
  }

  /** Never one of the last 3 shown; relax to "not the current" when count ≤ 4. */
  private chooseRandom(count: number): number {
    if (count <= 1) return this.a;
    const avoid = count <= 4 ? [this.a] : this.recent;
    const cands: number[] = [];
    for (let i = 0; i < count; i++) if (!avoid.includes(i)) cands.push(i);
    if (cands.length === 0) for (let i = 0; i < count; i++) if (i !== this.a) cands.push(i);
    return cands[randInt(this.rng, cands.length)];
  }
}
