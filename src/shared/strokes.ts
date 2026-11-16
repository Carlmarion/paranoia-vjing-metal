// Strokes (B12): the drawing tool's data, pure functions only (no DOM).
// Coordinates are motif units: the square canvas spans −1…+1, y up, like the shader.

/** Brush diameter in motif units: the thick placeholder weight, 100 px at 2048 (B12.1). */
export const BRUSH = 100 / 1024;
/** A shape holds at most this many points (B12.1). */
export const MAX_POINTS = 20000;

export interface Stroke {
  /** x0, y0, x1, y1, … */
  pts: Float32Array;
  erase: boolean;
  /** Undo step: the copies made by one symmetric hand stroke share it. */
  group: number;
}

export interface DrawnShape { id: string; name: string; createdAt: number; updatedAt: number; strokes: Stroke[]; }

export type Symmetry = 'free' | 'x' | 'y' | 'xy' | 'r4' | 'r6' | 'r8';
export const SYMMETRIES: readonly Symmetry[] = ['free', 'x', 'y', 'xy', 'r4', 'r6', 'r8'];

// ---------- validation (strokes arrive over the channel, from IndexedDB or from a file) ----------

/** One stroke from unknown data (`pts` as Float32Array or a plain number array), or null if malformed. */
function parseStroke(v: unknown): Stroke | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { pts?: unknown; erase?: unknown; group?: unknown };
  const src = o.pts instanceof Float32Array ? o.pts : Array.isArray(o.pts) ? o.pts : null;
  if (!src || src.length < 2 || src.length % 2 !== 0) return null;
  if (typeof o.erase !== 'boolean' || typeof o.group !== 'number' || !Number.isFinite(o.group)) return null;
  const pts = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const n = src[i] as unknown;
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    pts[i] = n;
  }
  return { pts, erase: o.erase, group: o.group };
}

/** A stroke list from unknown data, or null if anything in it is malformed. */
export function parseStrokes(v: unknown): Stroke[] | null {
  if (!Array.isArray(v)) return null;
  const out: Stroke[] = [];
  for (const s of v) {
    const p = parseStroke(s);
    if (!p) return null;
    out.push(p);
  }
  return out;
}

/** Shapes from an export file (`{ shapes: [...] }` or a bare array); broken entries are skipped. */
export function parseShapes(v: unknown): { name: string; strokes: Stroke[] }[] {
  const arr = Array.isArray(v) ? v : v && typeof v === 'object' && Array.isArray((v as { shapes?: unknown }).shapes)
    ? (v as { shapes: unknown[] }).shapes : [];
  const out: { name: string; strokes: Stroke[] }[] = [];
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue;
    const { name, strokes } = e as { name?: unknown; strokes?: unknown };
    const parsed = parseStrokes(strokes);
    if (typeof name === 'string' && parsed) out.push({ name, strokes: parsed });
  }
  return out;
}

// ---------- smoothing ----------

/**
 * Light smoothing: the stored point is the mean of the raw point and the previous stored point.
 * Returns null (drop) when the raw point is closer than `minDist` to the previous stored point.
 */
export function smoothPoint(prev: readonly [number, number] | null, raw: readonly [number, number], minDist: number): [number, number] | null {
  if (!prev) return [raw[0], raw[1]];
  if (Math.hypot(raw[0] - prev[0], raw[1] - prev[1]) < minDist) return null;
  return [(raw[0] + prev[0]) / 2, (raw[1] + prev[1]) / 2];
}

// ---------- symmetry ----------

type Xf = (x: number, y: number) => [number, number];

function rotations(n: number): Xf[] {
  const out: Xf[] = [];
  for (let k = 0; k < n; k++) {
    const c = Math.cos((2 * Math.PI * k) / n);
    const s = Math.sin((2 * Math.PI * k) / n);
    out.push((x, y) => [c * x - s * y, s * x + c * y]);
  }
  return out;
}

const IDENTITY: Xf = (x, y) => [x, y];
const MIRROR_X: Xf = (x, y) => [-x, y];
const MIRROR_Y: Xf = (x, y) => [x, -y];
const MIRROR_XY: Xf = (x, y) => [-x, -y];

const TRANSFORMS: Record<Symmetry, Xf[]> = {
  free: [IDENTITY],
  x: [IDENTITY, MIRROR_X],
  y: [IDENTITY, MIRROR_Y],
  xy: [IDENTITY, MIRROR_X, MIRROR_Y, MIRROR_XY],
  r4: rotations(4),
  r6: rotations(6),
  r8: rotations(8),
};

/** One hand stroke → its symmetric copies (the first is the stroke itself). */
export function symmetrize(pts: Float32Array, mode: Symmetry): Float32Array[] {
  return TRANSFORMS[mode].map((f) => {
    const out = new Float32Array(pts.length);
    for (let i = 0; i < pts.length; i += 2) {
      const [x, y] = f(pts[i], pts[i + 1]);
      out[i] = x;
      out[i + 1] = y;
    }
    return out;
  });
}

// ---------- lengths and slicing (replay, B12.6) ----------

export function pointCount(strokes: readonly Stroke[]): number {
  let n = 0;
  for (const s of strokes) n += s.pts.length / 2;
  return n;
}

function strokeLength(pts: Float32Array): number {
  let l = 0;
  for (let i = 2; i < pts.length; i += 2) l += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  return l;
}

/** Consecutive strokes sharing a group id, in drawing order. */
function groups(strokes: readonly Stroke[]): Stroke[][] {
  const out: Stroke[][] = [];
  for (const s of strokes) {
    const g = out[out.length - 1];
    if (g && g[0].group === s.group) g.push(s); else out.push([s]);
  }
  return out;
}

/** Copies of one group grow together, so a group counts once: its longest stroke. */
export function groupLength(group: readonly Stroke[]): number {
  let l = 0;
  for (const s of group) l = Math.max(l, strokeLength(s.pts));
  return l;
}

/** Ink path length of a stroke list (eraser strokes count like ink). */
export function pathLength(strokes: readonly Stroke[]): number {
  let l = 0;
  for (const g of groups(strokes)) l += groupLength(g);
  return l;
}

/** The first `len` of a stroke's polyline (at least its first point). */
function cutStroke(s: Stroke, len: number): Stroke {
  const p = s.pts;
  let acc = 0;
  for (let i = 2; i < p.length; i += 2) {
    const seg = Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
    if (acc + seg >= len) {
      const t = seg > 0 ? (len - acc) / seg : 0;
      const out = new Float32Array(i + 2);
      out.set(p.subarray(0, i));
      out[i] = p[i - 2] + (p[i] - p[i - 2]) * t;
      out[i + 1] = p[i - 1] + (p[i + 1] - p[i - 1]) * t;
      return { ...s, pts: out };
    }
    acc += seg;
  }
  return s;
}

/** The drawing as it was when `len` of its path had been drawn (B12.6). */
export function sliceStrokes(strokes: readonly Stroke[], len: number): Stroke[] {
  if (len <= 0) return [];
  if (len >= pathLength(strokes)) return strokes.slice();
  const out: Stroke[] = [];
  let remaining = len;
  for (const g of groups(strokes)) {
    const gl = groupLength(g);
    if (gl <= remaining) {
      out.push(...g);
      remaining -= gl;
      continue;
    }
    for (const s of g) out.push(cutStroke(s, remaining));
    break;
  }
  return out;
}

// ---------- ink readout (B12.1, B2.1) ----------

export interface MaskStats {
  /** Ink fraction 0…1. */
  coverage: number;
  /** [x, y] from the top-left, 0…1 (as in the bake manifest). */
  centroid: [number, number];
  /** Some ink lies in the outer 10% margin. */
  inMargin: boolean;
}

/** `mask`: size × size, row 0 = top, non-zero = ink. */
export function maskStats(mask: Uint8Array, size: number): MaskStats {
  const lo = size * 0.1;
  const hi = size * 0.9;
  let n = 0, sx = 0, sy = 0;
  let inMargin = false;
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) {
      if (!mask[row + x]) continue;
      n++;
      sx += x + 0.5;
      sy += y + 0.5;
      if (x < lo || x >= hi || y < lo || y >= hi) inMargin = true;
    }
  }
  if (n === 0) return { coverage: 0, centroid: [0.5, 0.5], inMargin: false };
  return { coverage: n / (size * size), centroid: [sx / n / size, sy / n / size], inMargin };
}

export const COVERAGE_RANGE: readonly [number, number] = [0.1, 0.25];
export const CENTROID_TOLERANCE = 0.05;

/** The B2.1 warnings that apply to a drawing (empty drawing: none). */
export function inkWarnings(st: MaskStats): string[] {
  if (st.coverage === 0) return [];
  const w: string[] = [];
  if (st.coverage < COVERAGE_RANGE[0]) w.push('little ink');
  if (st.coverage > COVERAGE_RANGE[1]) w.push('a lot of ink');
  if (st.inMargin) w.push('ink near the edge');
  if (Math.hypot(st.centroid[0] - 0.5, st.centroid[1] - 0.5) > CENTROID_TOLERANCE) w.push('off centre');
  return w;
}
