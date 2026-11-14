// B8 — preset slots, crossfade, randomize, mutate, reset, undo, export/import. Pure.
import { PARAMS, fromNorm, toNorm, type Band, type Group, type ParamId } from '../shared/params';
import {
  PRESET_SLOTS, REACT_RANGE, THR_RANGE, defaultOptions, defaultParamState, migratePresets, serialisePresets,
  type Look, type ParamState, type Preset,
} from '../shared/state';
import { clamp, clamp01, fract, gaussian, randInt, type Rng } from '../shared/math';

export const UNDO_SIZE = 30;
export const UNDO_FADE_S = 1;

export function cloneLook(l: Look): Look {
  const params = {} as Record<ParamId, ParamState>;
  for (const def of PARAMS) params[def.id] = { ...l.params[def.id] };
  return { params, options: { ...l.options } };
}

// ---------- slots ----------

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `HH:MM:SS` local time. */
export function presetName(nowMs: number): string {
  const d = new Date(nowMs);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

const validSlot = (slot: unknown): slot is number =>
  typeof slot === 'number' && Number.isInteger(slot) && slot >= 0 && slot < PRESET_SLOTS;

/** Writes `look` to `slot`, or to the first empty one. Returns the slot used (null when full / invalid). */
export function savePreset(
  presets: readonly (Preset | null)[], look: Look, nowMs: number, slot?: number,
): { presets: (Preset | null)[]; slot: number | null } {
  const target = slot === undefined ? presets.findIndex((p) => p === null) : slot;
  if (!validSlot(target)) return { presets: [...presets], slot: null };
  const out = [...presets];
  out[target] = { name: presetName(nowMs), savedAt: nowMs, look: cloneLook(look) };
  return { presets: out, slot: target };
}

export function renamePreset(presets: readonly (Preset | null)[], slot: number, name: string): (Preset | null)[] {
  const p = validSlot(slot) ? presets[slot] : null;
  if (!p) return [...presets];
  const out = [...presets];
  out[slot] = { ...p, name: name.slice(0, 40) };
  return out;
}

export function deletePreset(presets: readonly (Preset | null)[], slot: number): (Preset | null)[] {
  const out = [...presets];
  if (validSlot(slot)) out[slot] = null;
  return out;
}

// ---------- export / import ----------

export function exportPresets(presets: readonly (Preset | null)[]): string {
  return serialisePresets([...presets]);
}

/** `ferro-presets-YYYYMMDD-HHMM.json` */
export function exportFilename(d: Date): string {
  return `ferro-presets-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.json`;
}

/** Validates `data` (parsed JSON or a JSON string) and merges its presets into the empty slots, in order. */
export function importPresets(presets: readonly (Preset | null)[], data: unknown): (Preset | null)[] {
  let parsed = data;
  if (typeof data === 'string') {
    try { parsed = JSON.parse(data) as unknown; } catch { return [...presets]; }
  }
  const incoming = migratePresets(parsed).filter((p): p is Preset => p !== null);
  const out = [...presets];
  for (let i = 0; i < out.length && incoming.length; i++) if (out[i] === null) out[i] = incoming.shift() ?? null;
  return out;
}

// ---------- crossfade ----------

/** Linear interpolation in normalised space; hue (wrap) the short way; band/lock/options from b. */
export function lerpLook(a: Look, b: Look, k: number): Look {
  if (k <= 0) return a;
  if (k >= 1) return b;
  const params = {} as Record<ParamId, ParamState>;
  for (const def of PARAMS) {
    const pa = a.params[def.id];
    const pb = b.params[def.id];
    const ua = toNorm(def, pa.base);
    const ub = toNorm(def, pb.base);
    let u: number;
    if (def.scale === 'wrap') {
      let d = ub - ua;
      d -= Math.round(d);
      u = fract(ua + d * k);
    } else {
      u = ua + (ub - ua) * k;
    }
    params[def.id] = {
      base: fromNorm(def, u),
      react: pa.react + (pb.react - pa.react) * k,
      thr: pa.thr + (pb.thr - pa.thr) * k,
      band: pb.band,
      lock: pb.lock,
    };
  }
  return { params, options: b.options };
}

/** A crossfade from `from` towards the live target (state.look). */
export interface Fade { from: Look; elapsed: number; dur: number; }

/** `from` is what is on screen now (renderLook). dur ≤ 0 → no fade. */
export function startFade(from: Look, dur: number): Fade | null {
  return dur > 0 ? { from, elapsed: 0, dur } : null;
}

/** Advance once per frame; returns null when done. */
export function stepFade(f: Fade | null, dt: number): Fade | null {
  if (!f) return null;
  const elapsed = f.elapsed + dt;
  return elapsed >= f.dur ? null : { ...f, elapsed };
}

export function fadeLook(f: Fade | null, target: Look): Look {
  return f ? lerpLook(f.from, target, f.elapsed / f.dur) : target;
}

// ---------- randomize / mutate / reset ----------

const RANDOM_BANDS: Band[] = ['low', 'mid', 'high', 'beat', 'energy'];
export const RANDOM_REACT_MAX = 0.6;
export const RANDOM_THR_MAX = 0.5;

/** B8 randomize. Options are randomized only for a full (no-group) randomize. */
export function randomize(look: Look, rng: Rng, group?: Group): Look {
  const out = cloneLook(look);
  for (const def of PARAMS) {
    const ps = out.params[def.id];
    if (ps.lock || !def.rand || (group && def.group !== group)) continue;
    const [lo, hi] = def.rand;
    ps.base = def.scale === 'log' ? lo * Math.pow(hi / lo, rng()) : lo + (hi - lo) * rng();
    ps.react = rng() * RANDOM_REACT_MAX;
    ps.band = rng() < 0.5 ? def.band : RANDOM_BANDS[randInt(rng, RANDOM_BANDS.length)];
    ps.thr = rng() * RANDOM_THR_MAX;
  }
  if (!group) {
    out.options.meltMode = randInt(rng, 3) as 0 | 1 | 2;
    out.options.mirrorX = rng() < 0.25;
    out.options.mirrorY = rng() < 0.25;
  }
  return out;
}

export const MUTATE_SD = { base: 0.08, react: 0.1, thr: 0.05 } as const;

/** B8 mutate: small gaussian steps around the current Look. Options unchanged. */
export function mutate(look: Look, rng: Rng, group?: Group): Look {
  const out = cloneLook(look);
  for (const def of PARAMS) {
    const ps = out.params[def.id];
    if (ps.lock || (group && def.group !== group)) continue;
    ps.base = fromNorm(def, clamp01(toNorm(def, ps.base) + gaussian(rng) * MUTATE_SD.base));
    ps.react = clamp(ps.react + gaussian(rng) * MUTATE_SD.react, REACT_RANGE[0], REACT_RANGE[1]);
    ps.thr = clamp(ps.thr + gaussian(rng) * MUTATE_SD.thr, THR_RANGE[0], THR_RANGE[1]);
  }
  return out;
}

/** Back to table defaults (lock flags kept). Full reset also restores default options. */
export function resetLook(look: Look, group?: Group): Look {
  const out = cloneLook(look);
  for (const def of PARAMS) {
    if (group && def.group !== group) continue;
    out.params[def.id] = { ...defaultParamState(def), lock: out.params[def.id].lock };
  }
  if (!group) out.options = defaultOptions();
  return out;
}

// ---------- undo ----------

export function pushUndo(ring: readonly Look[], look: Look): Look[] {
  const out = [...ring, look];
  return out.length > UNDO_SIZE ? out.slice(out.length - UNDO_SIZE) : out;
}

export function popUndo(ring: readonly Look[]): { ring: Look[]; look: Look | null } {
  if (ring.length === 0) return { ring: [], look: null };
  return { ring: ring.slice(0, -1), look: ring[ring.length - 1] };
}
