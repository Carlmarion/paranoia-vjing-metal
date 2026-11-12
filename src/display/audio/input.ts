// B6.1 — audio sources: line-in, looping file, built-in synth.
import type { DeviceInfo } from '../../shared/protocol';

export type SourceKind = 'in' | 'file' | 'synth';
export interface SourceSpec { kind: SourceKind; file: string | null; }

export interface AudioInput {
  /** Connect this to the analyser. */
  node: AudioNode;
  label: string;
  stop(): void;
}

/** `?src=in` (default) | `?src=file&f=<name>` | `?src=synth` */
export function parseSource(search: string): SourceSpec {
  const q = new URLSearchParams(search);
  const src = q.get('src');
  if (src === 'synth') return { kind: 'synth', file: null };
  if (src === 'file' && q.get('f')) return { kind: 'file', file: q.get('f') };
  return { kind: 'in', file: null };
}

export async function openInput(ctx: AudioContext, spec: SourceSpec, deviceId: string | null): Promise<AudioInput> {
  if (spec.kind === 'synth') return openSynth(ctx);
  if (spec.kind === 'file' && spec.file) return openFile(ctx, spec.file);
  return openLineIn(ctx, deviceId);
}

export async function listDevices(): Promise<DeviceInfo[]> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `input ${i + 1}` }));
  } catch {
    return [];
  }
}

async function openLineIn(ctx: AudioContext, deviceId: string | null): Promise<AudioInput> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2,
    },
  });
  const node = ctx.createMediaStreamSource(stream);
  // Not connected to destination: no playback, no feedback.
  const track = stream.getAudioTracks()[0];
  return {
    node,
    label: track?.label ?? 'line-in',
    stop() {
      node.disconnect();
      for (const t of stream.getTracks()) t.stop();
    },
  };
}

async function openFile(ctx: AudioContext, name: string): Promise<AudioInput> {
  const res = await fetch(`test-audio/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`test-audio/${name}: HTTP ${res.status}`);
  const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  node.loop = true;
  node.connect(ctx.destination); // file source also plays on the speakers
  node.start();
  return {
    node,
    label: `file: ${name}`,
    stop() {
      try { node.stop(); } catch { /* already stopped */ }
      node.disconnect();
    },
  };
}

const SYNTH_BPM = 126;
const LOOKAHEAD_S = 0.15;
const TICK_MS = 25;

/** Kick (55 Hz sine, 120 ms decay) every beat at 126 BPM, noise hat on off-beats, 220 Hz pad over 16 s. */
function openSynth(ctx: AudioContext): AudioInput {
  const bus = ctx.createGain();
  bus.gain.value = 1;

  // Pad: gain = 0.05 + 0.05 × sin(2π t / 16) → fades in and out over 16 s.
  const pad = ctx.createOscillator();
  pad.frequency.value = 220;
  const padGain = ctx.createGain();
  padGain.gain.value = 0.05;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 1 / 16;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0.05;
  lfo.connect(lfoDepth).connect(padGain.gain);
  pad.connect(padGain).connect(bus);
  pad.start();
  lfo.start();

  const noise = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.06), ctx.sampleRate);
  const ch = noise.getChannelData(0);
  for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
  const hatFilter = ctx.createBiquadFilter();
  hatFilter.type = 'highpass';
  hatFilter.frequency.value = 7000;
  hatFilter.connect(bus);

  const period = 60 / SYNTH_BPM;
  let next = ctx.currentTime + 0.05;

  const kick = (t: number) => {
    const o = ctx.createOscillator();
    o.frequency.value = 55;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.setTargetAtTime(0, t, 0.03); // ≈ −35 dB after 120 ms
    o.connect(g).connect(bus);
    o.start(t);
    o.stop(t + 0.25);
    o.onended = () => g.disconnect();
  };
  const hat = (t: number) => {
    const s = ctx.createBufferSource();
    s.buffer = noise;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.25, t);
    g.gain.setTargetAtTime(0, t, 0.012);
    s.connect(g).connect(hatFilter);
    s.start(t);
    s.onended = () => g.disconnect();
  };

  const timer = setInterval(() => {
    while (next < ctx.currentTime + LOOKAHEAD_S) {
      kick(next);
      hat(next + period / 2);
      next += period;
    }
  }, TICK_MS);

  return {
    node: bus,
    label: 'synth',
    stop() {
      clearInterval(timer);
      pad.stop();
      lfo.stop();
      bus.disconnect();
    },
  };
}
