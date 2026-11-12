// State model (B3): types, defaults, serialise, migrate, safe storage.
import { PARAMS, PARAM_IDS, type Band, type ParamDef, type ParamId } from './params';
import { clamp } from './math';

export type { Band } from './params';

export interface ParamState { base: number; react: number; band: Band; thr: number; lock: boolean; }

export type MeltMode = 0 | 1 | 2;
export type HueJumpEvery = 0 | 1 | 2 | 4 | 8 | 16;
export type HoldBeats = 16 | 32 | 64 | 128;
export type MorphBeats = 4 | 8 | 16 | 32 | 64;

export interface LookOptions {
  meltMode: MeltMode; // 0 blend, 1 fuse, 2 spatial
  mirrorX: boolean;
  mirrorY: boolean;
  hueJumpEvery: HueJumpEvery; // beats; 0 = off
  hueJumpAmt: number; // 0…0.5 turns
  holdBeats: HoldBeats;
  morphBeats: MorphBeats;
}

/** A Look is what a preset stores. */
export interface Look { params: Record<ParamId, ParamState>; options: LookOptions; }

export type Order = 'random' | 'sequential';
export type PresetCycleMin = 0 | 2 | 5 | 10;

/** Live performance state. Never stored in presets. */
export interface Session {
  autopilot: number; // 0…1
  reactMaster: number; // 0…2
  xfade: number; // seconds 0…8
  autoAdvance: boolean;
  order: Order;
  presetCycleMin: PresetCycleMin;
  frozen: boolean;
  fallback: boolean;
  blackout: boolean;
  meltHold: boolean;
  holdPos: number; // 0…1
  queued: number | null;
}

/** Venue-dependent. Never stored in presets. */
export interface Calib {
  deviceId: string | null;
  inputGain: number; // 0…4
  onsetK: number; // 0.5…4
  smooth: number; // 0.25…4
  floorDb: number; // −90…−30
  gainDecay: number; // 4…60 s
  refractoryMs: number; // 150…600
}

export interface Preset { name: string; savedAt: number; look: Look; }

export const PRESET_SLOTS = 16;

export interface State {
  look: Look;
  session: Session;
  calib: Calib;
  presets: (Preset | null)[]; // 16 slots
  seed: number;
}

// ---------- allowed values / ranges (shared with the reducer and the dashboard) ----------

export const BANDS: Band[] = ['none', 'low', 'mid', 'high', 'energy', 'beat'];
export const MELT_MODES: MeltMode[] = [0, 1, 2];
export const HUE_JUMP_EVERY: HueJumpEvery[] = [0, 1, 2, 4, 8, 16];
export const HOLD_BEATS: HoldBeats[] = [16, 32, 64, 128];
export const MORPH_BEATS: MorphBeats[] = [4, 8, 16, 32, 64];
export const ORDERS: Order[] = ['random', 'sequential'];
export const PRESET_CYCLE_MIN: PresetCycleMin[] = [0, 2, 5, 10];

export const REACT_RANGE: [number, number] = [-1, 1];
export const THR_RANGE: [number, number] = [0, 0.95];
export const HUE_JUMP_AMT_RANGE: [number, number] = [0, 0.5];

export const SESSION_RANGES = {
  autopilot: [0, 1], reactMaster: [0, 2], xfade: [0, 8], holdPos: [0, 1],
} as const satisfies Partial<Record<keyof Session, readonly [number, number]>>;

export const CALIB_RANGES = {
  inputGain: [0, 4], onsetK: [0.5, 4], smooth: [0.25, 4], floorDb: [-90, -30],
  gainDecay: [4, 60], refractoryMs: [150, 600],
} as const satisfies Partial<Record<keyof Calib, readonly [number, number]>>;

// ---------- defaults ----------

export function defaultParamState(def: ParamDef): ParamState {
  return { base: def.def, react: def.react, band: def.band, thr: def.thr, lock: false };
}

export function defaultOptions(): LookOptions {
  return { meltMode: 1, mirrorX: false, mirrorY: false, hueJumpEvery: 0, hueJumpAmt: 0.25, holdBeats: 32, morphBeats: 16 };
}

export function defaultLook(): Look {
  const params = {} as Record<ParamId, ParamState>;
  for (const def of PARAMS) params[def.id] = defaultParamState(def);
  return { params, options: defaultOptions() };
}

/** B7.5 fallback: table defaults, react zero except zoom and brightness. */
export function fallbackLook(): Look {
  const look = defaultLook();
  for (const id of PARAM_IDS) {
    if (id !== 'zoom' && id !== 'brightness') look.params[id].react = 0;
  }
  return look;
}

export function defaultSession(): Session {
  return {
    autopilot: 0.5, reactMaster: 1, xfade: 3, autoAdvance: true, order: 'random', presetCycleMin: 0,
    frozen: false, fallback: false, blackout: false, meltHold: false, holdPos: 0, queued: null,
  };
}

export function defaultCalib(): Calib {
  return { deviceId: null, inputGain: 1, onsetK: 1.5, smooth: 1, floorDb: -60, gainDecay: 20, refractoryMs: 340 };
}

export function emptyPresets(): (Preset | null)[] {
  return new Array<Preset | null>(PRESET_SLOTS).fill(null);
}

export function defaultState(seed: number): State {
  return { look: defaultLook(), session: defaultSession(), calib: defaultCalib(), presets: emptyPresets(), seed };
}

/** `?seed=` default: the date as YYYYMMDD. */
export function dateSeed(d: Date): number {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

// ---------- validation / migration (unknown JSON → typed, missing fields → defaults) ----------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, lo: number, hi: number, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d;
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
function oneOf<T>(v: unknown, allowed: readonly T[], d: T): T {
  return allowed.includes(v as T) ? (v as T) : d;
}

export function migrateParamState(v: unknown, def: ParamDef): ParamState {
  const d = defaultParamState(def);
  if (!isObj(v)) return d;
  return {
    base: num(v.base, def.min, def.max, d.base),
    react: num(v.react, REACT_RANGE[0], REACT_RANGE[1], d.react),
    band: oneOf(v.band, BANDS, d.band),
    thr: num(v.thr, THR_RANGE[0], THR_RANGE[1], d.thr),
    lock: bool(v.lock, d.lock),
  };
}

export function migrateOptions(v: unknown): LookOptions {
  const d = defaultOptions();
  if (!isObj(v)) return d;
  return {
    meltMode: oneOf(v.meltMode, MELT_MODES, d.meltMode),
    mirrorX: bool(v.mirrorX, d.mirrorX),
    mirrorY: bool(v.mirrorY, d.mirrorY),
    hueJumpEvery: oneOf(v.hueJumpEvery, HUE_JUMP_EVERY, d.hueJumpEvery),
    hueJumpAmt: num(v.hueJumpAmt, HUE_JUMP_AMT_RANGE[0], HUE_JUMP_AMT_RANGE[1], d.hueJumpAmt),
    holdBeats: oneOf(v.holdBeats, HOLD_BEATS, d.holdBeats),
    morphBeats: oneOf(v.morphBeats, MORPH_BEATS, d.morphBeats),
  };
}

/** Any partial Look → full Look. Missing params/options take table defaults. */
export function migrateLook(v: unknown): Look {
  const src = isObj(v) ? v : {};
  const params = {} as Record<ParamId, ParamState>;
  const p = isObj(src.params) ? src.params : {};
  for (const def of PARAMS) params[def.id] = migrateParamState(p[def.id], def);
  return { params, options: migrateOptions(src.options) };
}

export function migratePreset(v: unknown): Preset | null {
  if (!isObj(v) || !isObj(v.look)) return null;
  return {
    name: typeof v.name === 'string' ? v.name.slice(0, 40) : 'preset',
    savedAt: typeof v.savedAt === 'number' && Number.isFinite(v.savedAt) ? v.savedAt : 0,
    look: migrateLook(v.look),
  };
}

/** Accepts `{ version, presets: [...] }` or a bare array. Always returns 16 slots. */
export function migratePresets(v: unknown): (Preset | null)[] {
  const arr = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.presets) ? v.presets : [];
  const out = emptyPresets();
  for (let i = 0; i < PRESET_SLOTS && i < arr.length; i++) out[i] = migratePreset(arr[i]);
  return out;
}

export function migrateCalib(v: unknown): Calib {
  const d = defaultCalib();
  if (!isObj(v)) return d;
  const r = CALIB_RANGES;
  return {
    deviceId: typeof v.deviceId === 'string' ? v.deviceId : null,
    inputGain: num(v.inputGain, r.inputGain[0], r.inputGain[1], d.inputGain),
    onsetK: num(v.onsetK, r.onsetK[0], r.onsetK[1], d.onsetK),
    smooth: num(v.smooth, r.smooth[0], r.smooth[1], d.smooth),
    floorDb: num(v.floorDb, r.floorDb[0], r.floorDb[1], d.floorDb),
    gainDecay: num(v.gainDecay, r.gainDecay[0], r.gainDecay[1], d.gainDecay),
    refractoryMs: num(v.refractoryMs, r.refractoryMs[0], r.refractoryMs[1], d.refractoryMs),
  };
}

// ---------- serialise ----------

export const PRESETS_FILE_VERSION = 1;

/** Presets file / storage format: `{ version: 1, presets: (Preset|null)[16] }`. */
export function serialisePresets(presets: (Preset | null)[]): string {
  return JSON.stringify({ version: PRESETS_FILE_VERSION, presets });
}
export function serialiseLook(look: Look): string { return JSON.stringify(look); }
export function serialiseCalib(calib: Calib): string { return JSON.stringify(calib); }

/** JSON.parse that never throws. */
export function parseJson(text: string | null): unknown {
  if (text == null) return undefined;
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

// ---------- safe storage ----------

export const STORAGE_KEYS = { presets: 'ferro.presets.v1', calib: 'ferro.calib.v1', look: 'ferro.look.v1' } as const;

/** The subset of `Storage` we use, injectable for tests. */
export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; }

/** `window.localStorage`, or null when unavailable or when touching it throws. */
export function getStorage(): StorageLike | null {
  try {
    const s = globalThis.localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

export function safeGet(storage: StorageLike | null, key: string): string | null {
  if (!storage) return null;
  try { return storage.getItem(key); } catch { return null; }
}

export function safeSet(storage: StorageLike | null, key: string, value: string): boolean {
  if (!storage) return false;
  try { storage.setItem(key, value); return true; } catch { return false; }
}

export interface Persisted { look: Look | null; calib: Calib | null; presets: (Preset | null)[] | null; }

/** Reads the three keys. A missing or corrupt value comes back as null (caller uses defaults). */
export function loadPersisted(storage: StorageLike | null): Persisted {
  const look = parseJson(safeGet(storage, STORAGE_KEYS.look));
  const calib = parseJson(safeGet(storage, STORAGE_KEYS.calib));
  const presets = parseJson(safeGet(storage, STORAGE_KEYS.presets));
  const presetsOk = Array.isArray(presets) || (isObj(presets) && Array.isArray(presets.presets));
  return {
    look: isObj(look) && isObj(look.params) ? migrateLook(look) : null,
    calib: isObj(calib) ? migrateCalib(calib) : null,
    presets: presetsOk ? migratePresets(presets) : null,
  };
}

