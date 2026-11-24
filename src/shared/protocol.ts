// Messages between Display and Control (B9) and the Transport that carries them.
import type { ParamId, Band } from './params';
import type { State, LookOptions, Session, Calib, Env, EnvGroup } from './state';
import type { Stroke } from './strokes';

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

/** bandValue (B4.1): 'none' → 0, 'beat' → beat pulse, 'energy' → energy30. */
export function bandValue(band: Band, frame: AudioFrame): number {
  switch (band) {
    case 'low': return frame.low;
    case 'mid': return frame.mid;
    case 'high': return frame.high;
    case 'energy': return frame.energy;
    case 'beat': return frame.beat;
    default: return 0;
  }
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

/** Texture layers (B2.4): baked atlas first, drawn shapes after, the live layer last. */
export const MAX_LAYERS = 64;
export const LIVE_LAYER = MAX_LAYERS - 1;

export type ParamField = 'base' | 'react' | 'band' | 'thr' | 'lock';

export type CmdName =
  | 'next' | 'prev' | 'random' | 'goto' | 'queue'
  | 'randomize' | 'mutate' | 'reset' | 'undo'
  | 'savePreset' | 'loadPreset' | 'deletePreset' | 'renamePreset' | 'importPresets'
  | 'replay' // arg: the ShapeKey of a drawn shape (B12.6)
  | 'ambient'; // toggles Ambient mode (design §6)

/** Stable identity of a library shape (B12.3); layers are for the shader and the sequencer only. */
export type ShapeKey = `baked:${number}` | `drawn:${string}`;

/** What the Control sees of the library (no strokes). */
export interface ShapeMeta {
  key: ShapeKey;
  layer: number;
  name: string;
  enabled: boolean;
  /** PNG data URL for drawn shapes; null for baked ones (their thumbs are files in sdf/thumbs/). */
  thumb: string | null;
  drawn: boolean;
}

/** Shape library and live drawing (B12, B9). Strokes travel as structured clones (Float32Array inside). */
export type ShapeMsg =
  | { t: 'shapeSave'; id?: string; name: string; strokes: Stroke[] }
  | { t: 'shapeDelete'; id: string }
  | { t: 'shapeRename'; id: string; name: string }
  | { t: 'shapeEnable'; key: ShapeKey; enabled: boolean }
  | { t: 'shapeDuplicate'; id: string }
  | { t: 'shapeGet'; id: string }
  | { t: 'shapesImport'; shapes: unknown };

export type LiveMsg =
  | { t: 'live'; on: true; strokes: Stroke[] }
  | { t: 'live'; on: false }
  | { t: 'liveStrokes'; strokes: Stroke[] }
  | { t: 'liveFinish'; id?: string; name: string; strokes: Stroke[] };

// Control → Display
export type ControlMsg =
  | { t: 'hello' }
  | { t: 'setParam'; id: ParamId; field: ParamField; value: number | Band | boolean }
  | { t: 'setOption'; key: keyof LookOptions; value: number | boolean }
  | { t: 'setSession'; key: keyof Session; value: number | boolean | string | null }
  | { t: 'setCalib'; key: keyof Calib; value: number | string | null }
  | { t: 'cmd'; name: CmdName; arg?: unknown }
  | { t: 'setEnv'; group: EnvGroup; key: keyof Env; value: number }
  | ShapeMsg
  | LiveMsg;

// Display → Control
export interface StateMsg { t: 'state'; state: State; manifest: Manifest | null; devices: DeviceInfo[]; }
export interface MetersMsg {
  t: 'meters';
  audio: AudioFrame;
  values: number[]; // PARAM_COUNT effective param values, normalised 0…1
  motifA: number; motifB: number; morphT: number; holdRemaining: number; fps: number;
  /** Design §4.5: normalised [orange, red] starts on the zoom and mirrorShift sliders (1 = never). */
  zones: { zoom: [number, number]; mirrorShift: [number, number] };
  /** Design §5.4: per envelope group, the hits since the previous meters message (one trigger line each). */
  envHits: Record<EnvGroup, number>;
  error?: string;
}
/** `free`: empty layer slots; `persistent`: false when IndexedDB is unavailable (shapes last for the session only). */
export interface LibraryMsg { t: 'library'; version: number; shapes: ShapeMeta[]; free: number; persistent: boolean; }
/** Answer to shapeGet, and after shapeDuplicate (`duplicateOf` = the original's id, `id` = the copy). */
export interface ShapeStrokesMsg { t: 'shapeStrokes'; id: string; name: string; strokes: Stroke[]; duplicateOf?: string; }
export interface ShapeErrorMsg { t: 'shapeError'; text: string; }
export type DisplayMsg = StateMsg | MetersMsg | LibraryMsg | ShapeStrokesMsg | ShapeErrorMsg;

/** Messages the Display only sends to Control windows: a Display ignores them (another Display's traffic). */
export const DISPLAY_MSG_TYPES: ReadonlySet<string> = new Set(['state', 'meters', 'library', 'shapeStrokes', 'shapeError']);

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
