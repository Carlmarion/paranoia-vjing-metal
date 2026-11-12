// B7.5 — drift time, hue jumps, preset cycle. Pure logic; owns its own PRNG stream.
import type { AudioFrame } from '../shared/protocol';
import type { LookOptions, Preset, Session } from '../shared/state';
import { fract, randInt, streamRng, type Rng } from '../shared/math';

export const HUE_JUMP_MIN_GAP_S = 0.4;
export const PRESET_CYCLE_FADE_S = 8;

export interface AutopilotContext {
  options: LookOptions;
  session: Session;
  presets: readonly (Preset | null)[];
  /** Slot last recalled, or null. */
  currentPreset: number | null;
}

export interface AutopilotOutput {
  /** Drift time for modulation (B4.1). */
  driftT: number;
  /** uHueOffset, 0…1. */
  hueOffset: number;
  /** Preset slot to recall now with an 8 s crossfade, or null. */
  recall: number | null;
}

export class Autopilot {
  driftT = 0;
  hueOffset = 0;
  private beatAcc = 0;
  private sinceJump = Infinity;
  private cycleT = 0;
  private readonly rng: Rng;

  constructor(seed: number) {
    this.rng = streamRng(seed, 'autopilot');
  }

  /** @param beats from SeqOutput.beats (real onsets + virtual clock) */
  step(dt: number, beats: number, frame: AudioFrame, ctx: AutopilotContext): AutopilotOutput {
    const { session, options } = ctx;
    let recall: number | null = null;
    this.sinceJump += dt;

    if (!session.frozen) {
      // Drift time: (0.5 + energy) × dt
      this.driftT += (0.5 + frame.energy) * dt;

      // Hue jumps: every hueJumpEvery beats, ≥ 400 ms apart, only on a beat
      if (options.hueJumpEvery === 0) {
        this.beatAcc = 0;
      } else if (beats > 0) {
        this.beatAcc += beats;
        if (this.beatAcc >= options.hueJumpEvery && this.sinceJump >= HUE_JUMP_MIN_GAP_S) {
          this.hueOffset = fract(this.hueOffset + options.hueJumpAmt);
          this.beatAcc = 0;
          this.sinceJump = 0;
        }
      }

      // Preset cycle
      if (session.presetCycleMin === 0) {
        this.cycleT = 0;
      } else {
        this.cycleT += dt;
        if (this.cycleT >= session.presetCycleMin * 60) {
          this.cycleT = 0;
          const cands: number[] = [];
          ctx.presets.forEach((p, i) => { if (p && i !== ctx.currentPreset) cands.push(i); });
          if (cands.length) recall = cands[randInt(this.rng, cands.length)];
        }
      }
    }
    return { driftT: this.driftT, hueOffset: this.hueOffset, recall };
  }
}
