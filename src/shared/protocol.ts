// Messages between Display and Control (B9) and the Transport that carries them.
import type { ParamId, Band } from './params';
import type { State, LookOptions, Session, Calib } from './state';

/** B6.4 */
export interface AudioFrame {
  low: number; mid: number; high: number; energy: number; // 0…1
  beat: number; // pulse: 1 at onset, × exp(−dt / 0.15) after
  onset: boolean;
  beatCount: number;
  beatPeriod: number; // seconds
  silent: boolean;
  levelDb: number;
  clip: boolean;
  rawDb: [number, number, number, number]; // low, mid, high, all
}

/** public/sdf/manifest.json (B2.2) */
export interface ManifestMotif {
  id: number; file: string; coverage: number; centroid: [number, number]; warnings: string[];
}
export interface Manifest {
  version: number; count: number; cell: number; dtype: string; origin: string;
  motifs: ManifestMotif[];
}

export interface DeviceInfo { deviceId: string; label: string; }

export type ParamField = 'base' | 'react' | 'band' | 'thr' | 'lock';

export type CmdName =
  | 'next' | 'prev' | 'random' | 'goto' | 'queue'
  | 'randomize' | 'mutate' | 'reset' | 'undo'
  | 'savePreset' | 'loadPreset' | 'deletePreset' | 'renamePreset' | 'importPresets';

// Control → Display
export type ControlMsg =
  | { t: 'hello' }
  | { t: 'setParam'; id: ParamId; field: ParamField; value: number | Band | boolean }
  | { t: 'setOption'; key: keyof LookOptions; value: number | boolean }
  | { t: 'setSession'; key: keyof Session; value: number | boolean | string | null }
  | { t: 'setCalib'; key: keyof Calib; value: number | string | null }
  | { t: 'cmd'; name: CmdName; arg?: unknown };

// Display → Control
export interface StateMsg { t: 'state'; state: State; manifest: Manifest | null; devices: DeviceInfo[]; }
export interface MetersMsg {
  t: 'meters';
  audio: AudioFrame;
  values: number[]; // 30 effective param values, normalised 0…1
  motifA: number; motifB: number; morphT: number; holdRemaining: number; fps: number;
  error?: string;
}
export type DisplayMsg = StateMsg | MetersMsg;

export type Msg = ControlMsg | DisplayMsg;

/** Kept small so a WebSocket could replace BroadcastChannel later. */
export interface Transport {
  send(msg: Msg): void;
  /** Returns an unsubscribe function. */
  onMessage(handler: (msg: Msg) => void): () => void;
  close(): void;
}

export const CHANNEL_NAME = 'ferro';

export function createBroadcastTransport(name: string = CHANNEL_NAME): Transport {
  const ch = new BroadcastChannel(name);
  const handlers = new Set<(msg: Msg) => void>();
  ch.onmessage = (e: MessageEvent) => {
    const msg = e.data as unknown;
    if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') return;
    for (const h of handlers) h(msg as Msg);
  };
  return {
    send(msg) {
      try { ch.postMessage(msg); } catch (err) { console.warn('ferro transport send failed', err); }
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    close() {
      handlers.clear();
      ch.close();
    },
  };
}
