// On-screen debug overlay (SPEC B11) and the soak log.
import type { AudioFrame } from '../shared/protocol';

export interface DebugInfo {
  audio: AudioFrame;
  fps: number;
  phase: string;
  motifA: number;
  motifB: number;
  morphT: number;
  holdRemaining: number;
  seed: number;
  device: string;
  error: string | null;
}

export interface SoakEntry { t: number; fpsAvg: number; fpsMin: number; heapMB: number; motif: number; beatCount: number; }

const SOAK_EVERY_S = 60;
const SOAK_MAX = 600;

const bar = (v: number): string => '█'.repeat(Math.round(Math.max(0, Math.min(1, v)) * 20)).padEnd(20, '·');

export class Debug {
  readonly el: HTMLDivElement;
  private readonly text: HTMLPreElement;
  visible = false;
  readonly soak: SoakEntry[] = [];
  private soakT = 0;
  private soakFrames = 0;
  private soakTime = 0;
  private soakMinFps = Infinity;

  constructor() {
    this.el = document.createElement('div');
    this.el.style.cssText =
      'position:fixed;left:8px;top:8px;z-index:10;display:none;background:rgba(0,0,0,.75);color:#9f9;' +
      'font:12px/1.35 ui-monospace,Menlo,monospace;padding:8px 10px;border-radius:4px;pointer-events:auto';
    this.text = document.createElement('pre');
    this.text.style.margin = '0';
    const btn = document.createElement('button');
    btn.textContent = 'download soak log';
    btn.style.cssText = 'margin-top:6px;font:inherit;background:#222;color:#9f9;border:1px solid #444;cursor:pointer';
    btn.onclick = () => this.download();
    this.el.append(this.text, btn);
    document.body.append(this.el);
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? 'block' : 'none';
  }

  /** Call every frame: accumulates the soak log; renders text only when visible. */
  update(dt: number, info: DebugInfo, elapsedS: number): void {
    this.soakFrames++;
    this.soakTime += dt;
    if (dt > 0) this.soakMinFps = Math.min(this.soakMinFps, 1 / dt);
    this.soakT += dt;
    if (this.soakT >= SOAK_EVERY_S) {
      const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
      const entry: SoakEntry = {
        t: Math.round(elapsedS),
        fpsAvg: +(this.soakFrames / this.soakTime).toFixed(1),
        fpsMin: +this.soakMinFps.toFixed(1),
        heapMB: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : -1,
        motif: info.motifA,
        beatCount: info.audio.beatCount,
      };
      this.soak.push(entry);
      if (this.soak.length > SOAK_MAX) this.soak.shift();
      console.info('ferro soak', entry);
      this.soakT = this.soakFrames = this.soakTime = 0;
      this.soakMinFps = Infinity;
    }
    if (!this.visible) return;
    const a = info.audio;
    const db = (v: number): string => v.toFixed(1).padStart(6);
    this.text.textContent = [
      `low    ${bar(a.low)} ${a.low.toFixed(2)}`,
      `mid    ${bar(a.mid)} ${a.mid.toFixed(2)}`,
      `high   ${bar(a.high)} ${a.high.toFixed(2)}`,
      `energy ${bar(a.energy)} ${a.energy.toFixed(2)}`,
      `beat   ${a.beat > 0.5 ? '●' : '○'}  count ${a.beatCount}  bpm ${(60 / a.beatPeriod).toFixed(0)}${a.silent ? '  SILENT' : ''}`,
      `raw dB low ${db(a.rawDb[0])}  mid ${db(a.rawDb[1])}  high ${db(a.rawDb[2])}  all ${db(a.rawDb[3])}`,
      `level ${db(a.levelDb)} dB${a.clip ? '  CLIP' : ''}`,
      `fps ${info.fps.toFixed(0)}`,
      `seq ${info.phase}  ${info.motifA} → ${info.motifB}  t ${info.morphT.toFixed(2)}  hold ${info.holdRemaining.toFixed(0)}`,
      `seed ${info.seed}  input ${info.device}`,
      info.error ? `ERROR ${info.error}` : '',
    ].join('\n');
  }

  private download(): void {
    const blob = new Blob([JSON.stringify(this.soak, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ferro-soak-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
}
