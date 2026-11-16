// B9 — the Display's state owner. `reduce` is a pure reducer (Model, message) → Model; effects that
// belong to other subsystems (sequencer commands, input restart, state broadcast) are returned, not run.
import { GROUPS, PARAMS, type Group, type ParamId } from '../shared/params';
import type { ControlMsg } from '../shared/protocol';
import {
  BANDS, CALIB_RANGES, HOLD_BEATS, HUE_JUMP_AMT_RANGE, HUE_JUMP_EVERY, MELT_MODES, MORPH_BEATS, ORDERS,
  PRESET_CYCLE_MIN, PRESET_SLOTS, REACT_RANGE, SESSION_RANGES, STORAGE_KEYS, THR_RANGE,
  defaultState, fallbackLook, loadPersisted, migratePresets, safeSet, serialiseCalib, serialiseLook,
  serialisePresets, type Calib, type Look, type LookOptions, type Session, type State, type StorageLike,
} from '../shared/state';
import { clamp, type Rng } from '../shared/math';
import type { SeqCommand } from './sequencer';
import {
  UNDO_FADE_S, cloneLook, deletePreset, fadeLook, importPresets, mutate, popUndo, pushUndo, randomize,
  renamePreset, resetLook, savePreset, startFade, stepFade, type Fade,
} from './presets';

export interface Model {
  state: State;
  /** Running crossfade towards state.look, or null. */
  fade: Fade | null;
  /** Undo ring (B8), newest last. */
  undo: Look[];
  /** Slot last saved or recalled. */
  currentPreset: number | null;
}

export interface Env {
  /** The presets PRNG stream: streamRng(seed, 'presets'). */
  rng: Rng;
  nowMs: number;
  motifCount: number;
}

export type Effect =
  | { t: 'seq'; cmd: SeqCommand } // forward to sequencer.command()
  | { t: 'sendState' } // reply to hello with a state message now
  | { t: 'restartInput' }; // calib.deviceId changed

export interface Result { model: Model; effects: Effect[]; }

// ---------- boot ----------

export interface Boot {
  model: Model;
  /** No presets in storage: fetch public/presets/default.json and pass it to withDefaultPresets. */
  needDefaultPresets: boolean;
}

/** Initial Model from localStorage (null storage, missing or corrupt values → defaults). */
export function initialModel(seed: number, storage: StorageLike | null): Boot {
  const saved = loadPersisted(storage);
  const state = defaultState(seed);
  if (saved.look) state.look = saved.look;
  if (saved.calib) state.calib = saved.calib;
  if (saved.presets) state.presets = saved.presets;
  return { model: { state, fade: null, undo: [], currentPreset: null }, needDefaultPresets: saved.presets === null };
}

/** Installs the default.json presets (parsed JSON). */
export function withDefaultPresets(model: Model, json: unknown): Model {
  return { ...model, state: { ...model.state, presets: migratePresets(json) } };
}

// ---------- per frame ----------

/** Advance the crossfade by dt. Returns the same Model when nothing is fading. */
export function tick(model: Model, dt: number): Model {
  return model.fade ? { ...model, fade: stepFade(model.fade, dt) } : model;
}

const FALLBACK = fallbackLook();

/** The Look to modulate and render: fallback, else the crossfade towards state.look. */
export function renderLook(model: Model): Look {
  return model.state.session.fallback ? FALLBACK : fadeLook(model.fade, model.state.look);
}

/** Write back session fields from the sequencer (SeqOutput.sessionPatch). */
export function patchSession(model: Model, patch: Partial<Session> | null): Model {
  if (!patch || Object.keys(patch).length === 0) return model;
  return { ...model, state: { ...model.state, session: { ...model.state.session, ...patch } } };
}

/** Recall a preset with a crossfade of `dur` seconds (session.xfade from the dashboard, 8 s from the preset cycle). */
export function recallPreset(model: Model, slot: number, dur: number): Model {
  const p = Number.isInteger(slot) ? model.state.presets[slot] : undefined;
  if (!p) return model;
  return { ...changeLook(model, cloneLook(p.look), dur), currentPreset: slot };
}

/** Replace the Look with undo + crossfade. */
function changeLook(model: Model, look: Look, dur: number): Model {
  return {
    ...model,
    undo: pushUndo(model.undo, model.state.look),
    fade: startFade(fadeLook(model.fade, model.state.look), dur), // from what the live Look shows now
    state: { ...model.state, look },
  };
}

// ---------- reducer ----------

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isGroup = (v: unknown): v is Group => GROUPS.includes(v as Group);
const isSlot = (v: unknown): v is number => isNum(v) && Number.isInteger(v) && v >= 0 && v < PRESET_SLOTS;
const PARAM_SET = new Set<string>(PARAMS.map((p) => p.id));

function setLook(model: Model, look: Look): Model {
  return { ...model, state: { ...model.state, look } };
}

function setParam(model: Model, id: unknown, field: unknown, value: unknown): Model {
  if (typeof id !== 'string' || !PARAM_SET.has(id)) return model;
  const def = PARAMS.find((p) => p.id === id)!;
  const pid = id as ParamId;
  const cur = model.state.look.params[pid];
  let next = cur;
  switch (field) {
    case 'base': if (isNum(value)) next = { ...cur, base: clamp(value, def.min, def.max) }; break;
    case 'react': if (isNum(value)) next = { ...cur, react: clamp(value, REACT_RANGE[0], REACT_RANGE[1]) }; break;
    case 'thr': if (isNum(value)) next = { ...cur, thr: clamp(value, THR_RANGE[0], THR_RANGE[1]) }; break;
    case 'band': if (BANDS.includes(value as never)) next = { ...cur, band: value as typeof cur.band }; break;
    case 'lock': if (typeof value === 'boolean') next = { ...cur, lock: value }; break;
  }
  if (next === cur) return model;
  const look = model.state.look;
  return setLook(model, { ...look, params: { ...look.params, [pid]: next } });
}

function setOption(model: Model, key: unknown, value: unknown): Model {
  const o = model.state.look.options;
  let v: LookOptions[keyof LookOptions] | undefined;
  switch (key) {
    case 'meltMode': if (MELT_MODES.includes(value as never)) v = value as LookOptions['meltMode']; break;
    case 'mirrorX': case 'mirrorY': if (typeof value === 'boolean') v = value; break;
    case 'hueJumpEvery': if (HUE_JUMP_EVERY.includes(value as never)) v = value as LookOptions['hueJumpEvery']; break;
    case 'hueJumpAmt': if (isNum(value)) v = clamp(value, HUE_JUMP_AMT_RANGE[0], HUE_JUMP_AMT_RANGE[1]); break;
    case 'holdBeats': if (HOLD_BEATS.includes(value as never)) v = value as LookOptions['holdBeats']; break;
    case 'morphBeats': if (MORPH_BEATS.includes(value as never)) v = value as LookOptions['morphBeats']; break;
  }
  if (v === undefined) return model;
  return setLook(model, { ...model.state.look, options: { ...o, [key as keyof LookOptions]: v } });
}

function setSession(model: Model, key: unknown, value: unknown, env: Env): Model {
  let v: Session[keyof Session] | undefined;
  switch (key) {
    case 'autopilot': case 'reactMaster': case 'xfade': case 'holdPos': {
      const r = SESSION_RANGES[key];
      if (isNum(value)) v = clamp(value, r[0], r[1]);
      break;
    }
    case 'autoAdvance': case 'frozen': case 'fallback': case 'blackout': case 'meltHold':
      if (typeof value === 'boolean') v = value;
      break;
    case 'order': if (ORDERS.includes(value as never)) v = value as Session['order']; break;
    case 'presetCycleMin': if (PRESET_CYCLE_MIN.includes(value as never)) v = value as Session['presetCycleMin']; break;
    case 'queued':
      if (value === null) v = null;
      else if (isNum(value) && Number.isInteger(value) && value >= 0 && value < env.motifCount) v = value;
      break;
  }
  if (v === undefined) return model;
  return patchSession(model, { [key as keyof Session]: v });
}

function setCalib(model: Model, key: unknown, value: unknown): { model: Model; effects: Effect[] } {
  const c = model.state.calib;
  if (key === 'deviceId') {
    if (value !== null && typeof value !== 'string') return { model, effects: [] };
    if (value === c.deviceId) return { model, effects: [] };
    return { model: { ...model, state: { ...model.state, calib: { ...c, deviceId: value } } }, effects: [{ t: 'restartInput' }] };
  }
  if (typeof key !== 'string' || !(key in CALIB_RANGES) || !isNum(value)) return { model, effects: [] };
  const r = CALIB_RANGES[key as keyof typeof CALIB_RANGES];
  const calib: Calib = { ...c, [key]: clamp(value, r[0], r[1]) };
  return { model: { ...model, state: { ...model.state, calib } }, effects: [] };
}

function cmd(model: Model, name: unknown, arg: unknown, env: Env): Result {
  const s = model.state;
  const xfade = s.session.xfade;
  const none = (m: Model = model): Result => ({ model: m, effects: [] });
  const group = isGroup(arg) ? arg : undefined;
  switch (name) {
    case 'next': case 'prev': case 'random':
      return { model, effects: [{ t: 'seq', cmd: { name } }] };
    case 'goto':
      if (!isNum(arg) || !Number.isInteger(arg) || arg < 0 || arg >= env.motifCount) return none();
      return { model, effects: [{ t: 'seq', cmd: { name: 'goto', index: arg } }] };
    case 'queue':
      return none(setSession(model, 'queued', arg ?? null, env));
    case 'randomize':
      return none(changeLook(model, randomize(s.look, env.rng, group), xfade));
    case 'mutate':
      return none(changeLook(model, mutate(s.look, env.rng, group), xfade));
    case 'reset':
      return none(changeLook(model, resetLook(s.look, group), xfade));
    case 'undo': {
      const { ring, look } = popUndo(model.undo);
      if (!look) return none();
      const m = changeLook(model, look, UNDO_FADE_S);
      return none({ ...m, undo: ring });
    }
    case 'savePreset': {
      const r = savePreset(s.presets, s.look, env.nowMs, isSlot(arg) ? arg : undefined);
      if (r.slot === null) return none();
      return none({ ...model, state: { ...s, presets: r.presets }, currentPreset: r.slot });
    }
    case 'loadPreset':
      return none(isSlot(arg) ? recallPreset(model, arg, xfade) : model);
    case 'deletePreset': {
      if (!isSlot(arg) || !s.presets[arg]) return none();
      return none({
        ...model, state: { ...s, presets: deletePreset(s.presets, arg) },
        currentPreset: model.currentPreset === arg ? null : model.currentPreset,
      });
    }
    case 'renamePreset': {
      const a = arg as { slot?: unknown; name?: unknown } | null;
      if (!a || !isSlot(a.slot) || typeof a.name !== 'string' || !s.presets[a.slot]) return none();
      return none({ ...model, state: { ...s, presets: renamePreset(s.presets, a.slot, a.name) } });
    }
    case 'importPresets':
      return none({ ...model, state: { ...s, presets: importPresets(s.presets, arg) } });
    default:
      return none();
  }
}

/**
 * Applies one Control → Display message. Unknown or malformed messages return the same Model (by reference),
 * so `next.model !== model` means "state or fade changed".
 */
export function reduce(model: Model, msg: unknown, env: Env): Result {
  if (!msg || typeof msg !== 'object') return { model, effects: [] };
  const m = msg as Partial<ControlMsg> & Record<string, unknown>;
  switch (m.t) {
    case 'hello': return { model, effects: [{ t: 'sendState' }] };
    case 'setParam': return { model: setParam(model, m.id, m.field, m.value), effects: [] };
    case 'setOption': return { model: setOption(model, m.key, m.value), effects: [] };
    case 'setSession': return { model: setSession(model, m.key, m.value, env), effects: [] };
    case 'setCalib': return setCalib(model, m.key, m.value);
    case 'cmd': return cmd(model, m.name, m.arg, env);
    default: return { model, effects: [] };
  }
}

// ---------- persistence (B3) ----------

export const LOOK_SAVE_INTERVAL_MS = 1000;

/** Call every frame with the current state; writes presets/calib on change, the Look at most once per second. */
export class Persister {
  private presets: State['presets'] | null = null;
  private calib: Calib | null = null;
  private look: Look | null = null;
  private lookSavedAt = -Infinity;

  constructor(private readonly storage: StorageLike | null) {}

  update(state: State, nowMs: number): void {
    if (state.presets !== this.presets) {
      if (this.presets !== null) safeSet(this.storage, STORAGE_KEYS.presets, serialisePresets(state.presets));
      this.presets = state.presets;
    }
    if (state.calib !== this.calib) {
      if (this.calib !== null) safeSet(this.storage, STORAGE_KEYS.calib, serialiseCalib(state.calib));
      this.calib = state.calib;
    }
    if (state.look !== this.look && nowMs - this.lookSavedAt >= LOOK_SAVE_INTERVAL_MS) {
      if (this.look !== null) safeSet(this.storage, STORAGE_KEYS.look, serialiseLook(state.look));
      this.look = state.look;
      this.lookSavedAt = nowMs;
    }
  }
}

