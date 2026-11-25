// THE param table (SPEC B4.2). Single source of truth for the shader header,
// the default Look, the dashboard rows and the randomize ranges.

export type Band = 'none' | 'low' | 'mid' | 'high' | 'energy' | 'beat';
export type Scale = 'lin' | 'log' | 'wrap';
export type Group = 'shape' | 'melt' | 'line' | 'inner' | 'colour' | 'trails';

export interface ParamDef {
  id: string;
  group: Group;
  scale: Scale;
  min: number;
  max: number;
  def: number;
  band: Band;
  react: number;
  thr: number;
  driftAmp: number;
  /** seconds; null = no drift */
  driftPeriod: number | null;
  /** null = never randomized */
  rand: [number, number] | null;
  /** Scales randomize's and mutate's react amounts (default 1). Zoom's wide log range needs less. */
  reactScale?: number;
}

const row = (
  id: string, group: Group, scale: Scale, min: number, max: number, def: number,
  band: Band, react: number, thr: number, driftAmp: number, driftPeriod: number | null,
  rand: [number, number] | null,
  extra: { reactScale?: number } = {},
): ParamDef => ({ id, group, scale, min, max, def, band, react, thr, driftAmp, driftPeriod, rand, ...extra });

export const PARAMS = [
  row('zoom', 'shape', 'log', 0.5, 3, 0.85, 'low', 0.034, 0.15, 0.023, 120, [0.7, 1.0], { reactScale: 0.5 }),
  row('rotation', 'shape', 'lin', -0.25, 0.25, 0, 'none', 0, 0, 0.15, 240, [-0.1, 0.1]),
  row('spin', 'shape', 'lin', -6, 6, 0, 'none', 0, 0, 0, null, [-2, 2]),
  row('tiltAmt', 'shape', 'lin', 0, 0.4, 0, 'none', 0, 0, 0.2, 90, [0, 0.2]),
  row('tiltAngle', 'shape', 'wrap', 0, 1, 0, 'none', 0, 0, 0.1, 200, [0, 1]),
  row('tiltSpeed', 'shape', 'lin', -6, 6, 0, 'none', 0, 0, 0, null, [-1, 1]),
  row('mirrorShift', 'shape', 'lin', 0, 0.6, 0, 'none', 0, 0, 0.1, 150, [0, 0.4]),
  row('warpAmt', 'shape', 'lin', 0, 0.15, 0.01, 'mid', 0.3, 0.2, 0.1, 60, [0, 0.06]),
  row('warpScale', 'shape', 'log', 0.5, 8, 2, 'none', 0, 0, 0.15, 200, [1, 5]),
  row('warpSpeed', 'shape', 'lin', 0, 1, 0.15, 'none', 0, 0, 0, null, [0.05, 0.5]),
  row('meltK', 'melt', 'log', 0.01, 0.3, 0.08, 'none', 0, 0, 0.1, 130, [0.03, 0.2]),
  row('meltNoise', 'melt', 'lin', 0, 2, 0.8, 'none', 0, 0, 0.1, 180, [0.2, 1.5]),
  row('meltNoiseScale', 'melt', 'log', 0.5, 8, 2.5, 'none', 0, 0, 0, null, [1, 6]),
  row('linger', 'melt', 'lin', 0, 1, 0.5, 'none', 0, 0, 0, null, [0, 1]),
  row('thickness', 'line', 'lin', -0.02, 0.06, 0, 'low', 0.25, 0.1, 0.08, 75, [-0.01, 0.02]),
  row('spikeAmp', 'line', 'lin', 0, 0.08, 0, 'high', 0.5, 0.3, 0.1, 50, [0, 0.03]),
  row('spikeFreq', 'line', 'log', 4, 80, 28, 'none', 0, 0, 0.1, 170, [10, 60]),
  row('spikeSharp', 'line', 'lin', 1, 8, 4, 'none', 0, 0, 0, null, [2, 6]),
  row('spikeSpeed', 'line', 'lin', 0, 2, 0.3, 'none', 0, 0, 0, null, [0.1, 1]),
  row('waveAmt', 'inner', 'lin', 0, 1, 0.4, 'mid', 0.3, 0.2, 0.15, 80, [0.1, 0.9]),
  row('waveFreq', 'inner', 'log', 5, 400, 40, 'none', 0, 0, 0.15, 210, [10, 300]),
  row('waveSpeed', 'inner', 'lin', -4, 4, 0.5, 'energy', 0.2, 0, 0.1, 140, [-2, 2]),
  row('waveSharp', 'inner', 'lin', 0, 1, 0.2, 'none', 0, 0, 0.1, 100, [0, 0.8]),
  row('ripple', 'inner', 'lin', 0, 1, 0, 'none', 0, 0, 0.1, 160, [0, 0.5]),
  row('hue', 'colour', 'wrap', 0, 1, 0.55, 'none', 0, 0, 0.5, 240, [0, 1]),
  row('hueDepth', 'colour', 'lin', -1, 1, 0.35, 'none', 0, 0, 0.1, 190, [-0.8, 0.8]),
  row('hueSpace', 'colour', 'lin', -1, 1, 0.1, 'none', 0, 0, 0.1, 220, [-0.5, 0.5]),
  row('sat', 'colour', 'lin', 0, 1, 0.9, 'none', 0, 0, 0, null, [0.7, 1]),
  row('brightness', 'colour', 'lin', 0.25, 1.5, 1, 'beat', 0.15, 0, 0, null, null),
  row('glow', 'colour', 'lin', 0, 1, 0.15, 'low', 0.3, 0.2, 0.1, 85, [0, 0.5]),
  row('glowWidth', 'colour', 'log', 0.02, 0.4, 0.12, 'none', 0, 0, 0.1, 125, [0.04, 0.3]),
  row('grain', 'colour', 'lin', 0, 0.3, 0.04, 'high', 0.3, 0.3, 0, null, [0, 0.12]),
  // trails (design 2026-11-25 §5): `trail` is never randomized, so Randomize can't switch trails on
  row('trail', 'trails', 'lin', 0, 1, 0, 'none', 0, 0, 0, null, null),
  row('push', 'trails', 'lin', -1, 1, 0, 'none', 0, 0, 0, null, [-0.3, 0.3]),
  row('twist', 'trails', 'lin', -1, 1, 0, 'none', 0, 0, 0, null, [-0.1, 0.1]),
] as const satisfies readonly ParamDef[];

export type ParamId = (typeof PARAMS)[number]['id'];
export const PARAM_COUNT = PARAMS.length;
export const PARAM_IDS: ParamId[] = PARAMS.map((p) => p.id);
export const PARAM_INDEX: Record<ParamId, number> = Object.fromEntries(
  PARAMS.map((p, i) => [p.id, i]),
) as Record<ParamId, number>;
export const GROUPS: Group[] = ['shape', 'melt', 'line', 'inner', 'colour', 'trails'];

export function paramDef(id: ParamId): ParamDef {
  return PARAMS[PARAM_INDEX[id]];
}

/** value on the param's scale → 0…1 */
export function toNorm(def: ParamDef, value: number): number {
  if (def.scale === 'log') return Math.log(value / def.min) / Math.log(def.max / def.min);
  return (value - def.min) / (def.max - def.min);
}

/** 0…1 → value on the param's scale */
export function fromNorm(def: ParamDef, u: number): number {
  if (def.scale === 'log') return def.min * Math.pow(def.max / def.min, u);
  return def.min + u * (def.max - def.min);
}

/** GLSL header: `#define P_ZOOM uP[0]` … (GLSL ES has no ## pasting). */
export const GLSL_HEADER: string =
  `#define PARAM_COUNT ${PARAM_COUNT}\n` +
  PARAMS.map((p, i) => `#define P_${p.id.toUpperCase()} uP[${i}]`).join('\n') +
  '\n';
