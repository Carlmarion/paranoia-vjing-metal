// B6.2 — AnalyserNode → dsp → AudioFrame.
import type { AudioFrame } from '../../shared/protocol';
import type { Calib } from '../../shared/state';
import { createDsp, dbToLin, dspStep, type DspState } from './dsp';

export const FFT_SIZE = 2048;

export class Analyser {
  readonly node: AnalyserNode;
  private readonly db: Float32Array<ArrayBuffer>;
  private readonly mag: Float32Array;
  private readonly time: Float32Array<ArrayBuffer>;
  private readonly binHz: number;
  private dsp: DspState = createDsp();
  private source: AudioNode | null = null;

  constructor(ctx: BaseAudioContext) {
    this.node = ctx.createAnalyser();
    this.node.fftSize = FFT_SIZE;
    this.node.smoothingTimeConstant = 0;
    this.db = new Float32Array(this.node.frequencyBinCount);
    this.mag = new Float32Array(this.node.frequencyBinCount);
    this.time = new Float32Array(FFT_SIZE);
    this.binHz = ctx.sampleRate / FFT_SIZE; // never assume the sample rate
  }

  /** Feed from a source node (replaces the previous one). The analyser is never connected onward. */
  attach(source: AudioNode): void {
    this.detach();
    source.connect(this.node);
    this.source = source;
  }

  detach(): void {
    if (this.source) {
      try { this.source.disconnect(this.node); } catch { /* already disconnected */ }
      this.source = null;
    }
  }

  /** Call once per animation frame. */
  read(dt: number, calib: Calib): AudioFrame {
    this.node.getFloatFrequencyData(this.db);
    for (let i = 0; i < this.db.length; i++) this.mag[i] = dbToLin(this.db[i]) * calib.inputGain;
    this.node.getFloatTimeDomainData(this.time);
    let peak = 0;
    for (let i = 0; i < this.time.length; i++) {
      const a = Math.abs(this.time[i]);
      if (a > peak) peak = a;
    }
    return dspStep(this.dsp, this.mag, peak, dt, calib, this.binHz);
  }

  /** Forget auto-gain peaks, flux history and BPM (e.g. after a device change). */
  reset(): void {
    this.dsp = createDsp();
  }
}
