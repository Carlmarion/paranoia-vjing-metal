// Design §6: Ambient mode — calm the kick-driven reactions, lengthen the tails, and give everything back. Pure.
import { PARAMS, type Band, type ParamId } from '../shared/params';
import { BANDS, ENV_GROUPS, ENV_KEYS, migrateEnv, type Env, type EnvGroup, type Look } from '../shared/state';
import { AMBIENT_BANDS, cloneLook } from './presets';

export { AMBIENT_BANDS };

export const AMBIENT_FADE_S = 5;
export const AMBIENT_ENV: Env = { attack: 0.3, sustain: 0.5, decay: 2, release: 4 };

/** What Ambient took away, to give back when it ends. Lives in the Model and localStorage, never in a preset. */
export interface AmbientStash {
  react: Partial<Record<ParamId, { react: number; band: Band }>>;
  env: Partial<Record<EnvGroup, Env>>;
}

export const isAmbientEnv = (e: Env): boolean => ENV_KEYS.every((k) => e[k] === AMBIENT_ENV[k]);

/**
 * Calms `look` and returns what it took. With `prev` (a Look arriving while Ambient is on), merges: a param calmed
 * now writes its entry; a param already at 0 on the same band keeps its old entry; anything else is dropped.
 * An envelope already at AMBIENT_ENV keeps its old entry; any other is stashed and replaced.
 */
export function ambientLook(look: Look, prev: AmbientStash | null = null): { look: Look; stash: AmbientStash } {
  const out = cloneLook(look);
  const stash: AmbientStash = { react: {}, env: {} };
  for (const def of PARAMS) {
    const ps = out.params[def.id];
    const old = prev?.react[def.id];
    if (AMBIENT_BANDS.has(ps.band) && ps.react !== 0) {
      stash.react[def.id] = { react: ps.react, band: ps.band };
      ps.react = 0;
    } else if (old && ps.react === 0 && ps.band === old.band) {
      stash.react[def.id] = { ...old };
    }
  }
  for (const g of ENV_GROUPS) {
    if (isAmbientEnv(out.env[g])) {
      const old = prev?.env[g];
      if (old) stash.env[g] = { ...old };
    } else {
      stash.env[g] = out.env[g];
      out.env[g] = { ...AMBIENT_ENV };
    }
  }
  return { look: out, stash };
}

/** Design §6.3 "Off": put back what is untouched since Ambient took it; keep every hand edit. */
export function ambientRestore(look: Look, stash: AmbientStash): Look {
  const out = cloneLook(look);
  for (const def of PARAMS) {
    const e = stash.react[def.id];
    const ps = out.params[def.id];
    if (e && ps.react === 0 && ps.band === e.band) ps.react = e.react;
  }
  for (const g of ENV_GROUPS) {
    const e = stash.env[g];
    if (e && isAmbientEnv(out.env[g])) out.env[g] = { ...e };
  }
  return out;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const PARAM_IDS = new Set<string>(PARAMS.map((p) => p.id));

/** A stored stash, validated; null when it is not one. Bad entries are dropped. */
export function migrateAmbientStash(v: unknown): AmbientStash | null {
  if (!isObj(v) || !isObj(v.react) || !isObj(v.env)) return null;
  const out: AmbientStash = { react: {}, env: {} };
  for (const [id, e] of Object.entries(v.react)) {
    if (!PARAM_IDS.has(id) || !isObj(e)) continue;
    if (typeof e.react !== 'number' || !Number.isFinite(e.react) || !BANDS.includes(e.band as Band)) continue;
    out.react[id as ParamId] = { react: Math.max(-1, Math.min(1, e.react)), band: e.band as Band };
  }
  for (const g of ENV_GROUPS) if (isObj(v.env[g])) out.env[g] = migrateEnv(v.env[g]);
  return out;
}
