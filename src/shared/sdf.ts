// In-browser bake (B12.4): ink mask → signed distance field in motif units → 2×2 downsample → float16.
// Pure (no DOM), so it runs in the bake worker and in tests. Same result as tools/bake_sdf.py.

/** Distance of an empty cell, in motif units: farther than anything inside the −1…+1 cell. */
export const BLANK_D = 2;

const INF = 1e20;

/**
 * Felzenszwalb–Huttenlocher 1D squared distance transform: `d[q] = min_p (q − p)² + f[p]` over n values.
 * Scratch arrays are passed in to avoid allocations.
 */
function edt1d(f: Float32Array, n: number, d: Float32Array, v: Int32Array, z: Float32Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    const fq = f[q] + q * q;
    let s: number;
    for (;;) {
      const p = v[k];
      s = (fq - (f[p] + p * p)) / (2 * q - 2 * p);
      if (s > z[k] || k === 0) break;
      k--;
    }
    if (s <= z[k]) { // k === 0 and the new parabola wins everywhere
      v[0] = q;
      z[1] = INF;
      continue;
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k];
    d[q] = (q - p) * (q - p) + f[p];
  }
}

/** Squared Euclidean distance (px²) from every pixel to the nearest pixel where `mask[i] !== 0` equals `wantInk`. */
function edtSquared(mask: Uint8Array, size: number, wantInk: boolean): Float32Array {
  const g = new Float32Array(size * size);
  for (let i = 0; i < g.length; i++) g[i] = (mask[i] !== 0) === wantInk ? 0 : INF;
  const col = new Float32Array(size);
  const d = new Float32Array(size);
  const v = new Int32Array(size);
  const z = new Float32Array(size + 1);
  // A line with no site stays INF and a line of only sites stays 0: both skip the transform (most of the margin).
  for (let x = 0; x < size; x++) { // columns, gathered into a contiguous buffer (cache-friendly)
    let sites = 0;
    for (let y = 0; y < size; y++) { const c = g[y * size + x]; col[y] = c; if (c === 0) sites++; }
    if (sites === 0 || sites === size) continue;
    edt1d(col, size, d, v, z);
    for (let y = 0; y < size; y++) g[y * size + x] = d[y];
  }
  for (let y = 0; y < size; y++) { // rows
    const row = g.subarray(y * size, (y + 1) * size);
    let zeros = 0;
    for (let x = 0; x < size; x++) if (row[x] === 0) zeros++;
    if (zeros === size) continue;
    edt1d(row, size, d, v, z);
    row.set(d);
  }
  return g;
}

/**
 * `mask`: size × size, row 0 = top, non-zero = ink. Returns the signed distance in motif units
 * (the cell spans −1…+1, so 1 px = 2 / size): negative inside the ink, not clamped.
 */
export function signedField(mask: Uint8Array, size: number): Float32Array {
  let ink = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) ink++;
  if (ink === 0) return new Float32Array(size * size).fill(BLANK_D);
  if (ink === mask.length) return new Float32Array(size * size).fill(-BLANK_D);
  const toInk = edtSquared(mask, size, true); // background pixels: distance to the ink
  const toBg = edtSquared(mask, size, false); // ink pixels: distance to the background
  const k = 2 / size;
  const out = new Float32Array(size * size);
  // A background pixel is 0 from the background and an ink pixel 0 from the ink: one root per pixel.
  for (let i = 0; i < out.length; i++) out[i] = mask[i] ? -Math.sqrt(toBg[i]) * k : Math.sqrt(toInk[i]) * k;
  return out;
}

/** size × size → size/2 × size/2 by 2×2 mean. */
export function downsample2(f: Float32Array, size: number): Float32Array {
  const h = size / 2;
  const out = new Float32Array(h * h);
  for (let y = 0; y < h; y++) {
    const r0 = 2 * y * size;
    const r1 = r0 + size;
    for (let x = 0; x < h; x++) {
      const c = 2 * x;
      out[y * h + x] = (f[r0 + c] + f[r0 + c + 1] + f[r1 + c] + f[r1 + c + 1]) / 4;
    }
  }
  return out;
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** float32 → IEEE half bits, round to nearest even. */
export function toHalf(v: number): number {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0); // inf / nan
  const e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00; // overflow → inf
  if (e <= 0) { // subnormal half (or zero)
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    const half = mant >>> shift;
    const rest = mant & ((1 << shift) - 1);
    const mid = 1 << (shift - 1);
    return sign | (half + (rest > mid || (rest === mid && (half & 1)) ? 1 : 0));
  }
  const half = (e << 10) | (mant >>> 13);
  const rest = mant & 0x1fff;
  return sign | (half + (rest > 0x1000 || (rest === 0x1000 && (half & 1)) ? 1 : 0)); // carry into exp is correct
}

/** IEEE half bits → number. */
export function fromHalf(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >>> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 0x1f) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

export function toHalfArray(f: Float32Array): Uint16Array {
  const out = new Uint16Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = toHalf(f[i]);
  return out;
}

/** The whole pipeline: R × R mask → (R/2)² float16 cell, ready for texSubImage3D. */
export function bakeMask(mask: Uint8Array, size: number): Uint16Array {
  return toHalfArray(downsample2(signedField(mask, size), size));
}

/** A cell × cell layer far from any line (+2 everywhere): what every unfilled layer holds. */
export function blankHalf(cell: number): Uint16Array {
  return new Uint16Array(cell * cell).fill(toHalf(BLANK_D));
}
