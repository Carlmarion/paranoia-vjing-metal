// B7.1–B7.4 — motif state machine. Pure logic (no DOM/GL/audio); owns its own PRNG stream.
import { LIVE_LAYER, type AudioFrame } from '../shared/protocol';
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
  | { name: 'goto'; index: number }
  | { name: 'live'; on: boolean } // B7.6
  | { name: 'finish'; layer: number }
  | { name: 'replay'; layer: number; fromBlank: boolean };

export type SeqPhase = 'hold' | 'morph' | 'meltHold';

/** B7.6: who owns the live layer right now. */
type Mode = 'off' | 'live' | 'replay';

export interface SeqContext {
  /** Layers of the enabled shapes, in library order (B12.3): what random, sequential and auto-advance choose from. */
  pool: readonly number[];
  /** True for every layer that holds a shape (goto and queued reach those, in the pool or not). */
  exists(layer: number): boolean;
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
  /** B12.6: while a replay melts into the live layer, the drawn shape and the reveal progress 0…1. */
  replay: { layer: number; q: number } | null;
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
  private started = false;
  private stepped = false;
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
  private mode: Mode = 'off';
  /** The shape the projector showed when live or replay began (B7.6); null before the melt has started. */
  private liveFrom: number | null = null;
  /** The drawn shape a replay lands on. */
  private replayLayer = 0;
  private sinceOnset = NO_ONSET_S; // virtual clock runs from boot
  private virtAcc = 0;
  private readonly rng: Rng;

  constructor(seed: number, holdBeats = 32, start = 0) {
    this.rng = streamRng(seed, 'sequencer');
    this.a = this.b = start;
    this.recent = [start];
    this.remaining = holdBeats;
  }

  /**
   * B7.3: next/prev/random/goto start a morph now, or speed up the running one and run afterwards.
   * B7.6: while live or replaying, only live(false) and finish are accepted.
   */
  command(cmd: SeqCommand): void {
    if (this.mode !== 'off' && cmd.name !== 'finish' && !(cmd.name === 'live' && !cmd.on && this.mode === 'live')) return;
    if (cmd.name === 'live') {
      if (cmd.on) { this.mode = 'live'; this.liveFrom = null; } else this.mode = 'off';
    } else if (cmd.name === 'replay') {
      this.mode = 'replay';
      this.liveFrom = null;
      this.replayLayer = cmd.layer;
    } else if (cmd.name === 'finish') {
      this.mode = 'off';
    }
    this.pending = cmd;
  }

  /** A shape was deleted (B12.3): drop its layer from the history, the recent list and the pending command. */
  forget(layer: number): void {
    const drop = (arr: number[]): void => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] === layer) arr.splice(i, 1); };
    drop(this.history);
    drop(this.recent);
    const p = this.pending;
    if (p && ((p.name === 'goto' && p.index === layer) || (p.name === 'finish' && p.layer === layer))) this.pending = null;
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
    if (!this.started) this.start(ctx);

    // B7.4 melt hold
    if (session.meltHold && this.mode === 'off') {
      if (this.phase !== 'meltHold') {
        if (this.phase === 'hold') {
          this.b = this.chooseNext(ctx, patch) ?? this.a;
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
      if (this.remaining === 0 && session.autoAdvance && this.mode === 'off') {
        const target = this.chooseNext(ctx, patch);
        if (target !== null && target !== this.a) this.startMorph(target, ctx, beatPeriod);
        else this.remaining = ctx.options.holdBeats; // nothing else to show: wait another hold
      }
    }

    if (this.phase === 'morph') {
      if (wasHold) return this.out(0, beats, patch); // a new morph starts exactly on A
      if (this.pending) this.rate = Math.max(this.rate, (1 - this.p) / SPEEDUP_S);
      this.p = Math.min(1, this.p + this.rate * dt);
      if (this.p >= 1) {
        const out = this.out(1, beats, patch); // land exactly on B this frame
        this.finishMorph(ctx);
        if (this.mode === 'replay' && this.a === LIVE_LAYER) this.land(this.replayLayer, ctx); // B7.6: the reveal is complete
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
    const revealing = this.mode === 'replay' && this.phase === 'morph' && this.b === LIVE_LAYER;
    return {
      motifA: this.a,
      motifB: inHold ? this.a : this.b,
      morphT,
      phase: this.phase,
      holdRemaining: inHold ? this.remaining : 0,
      beats,
      sessionPatch: Object.keys(patch).length ? patch : null,
      replay: revealing ? { layer: this.replayLayer, q: morphT === 1 ? 1 : this.p } : null,
    };
  }

  /** Swap the shown layer without a morph: the two layers hold the same picture (B7.6 finish, replay end). */
  private land(layer: number, ctx: SeqContext): void {
    this.a = this.b = layer;
    this.recent.push(layer);
    while (this.recent.length > RECENT_SIZE) this.recent.shift();
    this.mode = 'off';
    this.phase = 'hold';
    this.p = 0;
    this.rate = 0;
    this.remaining = ctx.options.holdBeats;
  }

  private startMorph(target: number, ctx: SeqContext, beatPeriod: number): void {
    this.b = target;
    this.p = 0;
    this.rate = 1 / (ctx.options.morphBeats * beatPeriod);
    this.phase = 'morph';
  }

  private finishMorph(ctx: SeqContext): void {
    const touchesLive = this.a === LIVE_LAYER || this.b === LIVE_LAYER; // the drawing never enters the history (B7.6)
    if (this.b !== this.a && !this.poppingPrev && !touchesLive) {
      this.history.push(this.a);
      if (this.history.length > HISTORY_SIZE) this.history.shift();
    }
    this.poppingPrev = false;
    this.a = this.b;
    if (this.a !== LIVE_LAYER) {
      this.recent.push(this.a);
      while (this.recent.length > RECENT_SIZE) this.recent.shift();
    }
    this.phase = 'hold';
    this.p = 0;
    this.rate = 0;
    this.remaining = ctx.options.holdBeats;
  }

  private runCommand(cmd: SeqCommand, ctx: SeqContext, beatPeriod: number, patch: Partial<Session>): void {
    let target: number | null = null;
    switch (cmd.name) {
      case 'next': target = this.chooseNext(ctx, patch); break;
      case 'random': target = this.chooseRandom(ctx.pool); break;
      case 'goto':
        if (Number.isInteger(cmd.index) && ctx.exists(cmd.index)) target = cmd.index;
        break;
      case 'live':
        if (cmd.on) { this.liveFrom = this.a; target = LIVE_LAYER; } else target = this.liveFrom;
        break;
      case 'replay':
        this.liveFrom = this.a;
        if (cmd.fromBlank) this.a = LIVE_LAYER; // melt from the empty live layer: the drawing appears on black
        this.startMorph(LIVE_LAYER, ctx, beatPeriod);
        return;
      case 'finish':
        if (this.a === LIVE_LAYER) { this.land(cmd.layer, ctx); return; } // the live layer holds the same picture
        target = cmd.layer;
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

  /**
   * The start layer may be unchecked. On the first frame nothing is on screen yet, so it is swapped for the first
   * pooled shape. If the pool is still empty then (drawn shapes still loading), the first time it is not, the hold
   * ends at once and auto-advance melts to a pooled shape.
   */
  private start(ctx: SeqContext): void {
    const firstFrame = !this.stepped;
    this.stepped = true;
    if (ctx.pool.length === 0) return;
    this.started = true;
    if (ctx.pool.includes(this.a) || this.phase !== 'hold') return;
    if (firstFrame) {
      this.a = this.b = ctx.pool[0];
      this.recent.splice(0, this.recent.length, this.a);
    } else {
      this.remaining = 0;
    }
  }

  /** Target choice (B7.2): queued if set, else by order, from the pool. Null when there is nothing to choose. */
  private chooseNext(ctx: SeqContext, patch: Partial<Session>): number | null {
    const q = ctx.session.queued;
    if (q !== null && Number.isInteger(q) && ctx.exists(q)) {
      patch.queued = null;
      return q;
    }
    const pool = ctx.pool;
    if (ctx.session.order === 'sequential') {
      if (pool.length === 0) return null;
      const i = pool.indexOf(this.a);
      return pool[(i + 1) % pool.length]; // i = −1 (A outside the pool) → the first
    }
    return this.chooseRandom(pool);
  }

  /** Never one of the last 3 shown; relax to "not the current" when the pool has ≤ 4 shapes. */
  private chooseRandom(pool: readonly number[]): number | null {
    if (pool.length === 0) return null;
    const avoid = pool.length <= 4 ? [this.a] : this.recent;
    let cands = pool.filter((l) => !avoid.includes(l));
    if (cands.length === 0) cands = pool.filter((l) => l !== this.a);
    if (cands.length === 0) return null;
    return cands[randInt(this.rng, cands.length)];
  }
}
