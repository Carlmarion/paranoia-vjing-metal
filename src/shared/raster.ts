// Strokes → pixels (B12.4). One function draws the modal's ink, the ghost, the thumbnails, the PNG export and the
// bake worker's mask, so all of them agree. Works on any CanvasRenderingContext2D or OffscreenCanvasRenderingContext2D.
import { BRUSH, type Stroke } from './strokes';

/** The subset of a 2D context `drawStrokes` uses. */
export interface StrokeCtx {
  globalCompositeOperation: GlobalCompositeOperation;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
}

/** Motif units (−1…+1, y up) → canvas pixels (0…size, row 0 at the top, like the atlas). */
export function toPx(x: number, y: number, size: number): [number, number] {
  return [((x + 1) / 2) * size, ((1 - y) / 2) * size];
}

/** A one-point stroke becomes this tiny segment, so its round caps draw a dot in every browser. */
const DOT_PX = 0.01;

/**
 * Paints the strokes in order with the round brush: ink in `color`, eraser strokes with `destination-out`
 * (so the canvas should start transparent). Consecutive strokes of the same kind share one path.
 */
export function drawStrokes(ctx: StrokeCtx, strokes: readonly Stroke[], size: number, color = '#fff'): void {
  ctx.lineWidth = (BRUSH * size) / 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  let i = 0;
  while (i < strokes.length) {
    const erase = strokes[i].erase;
    ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    ctx.beginPath();
    for (; i < strokes.length && strokes[i].erase === erase; i++) {
      const p = strokes[i].pts;
      const [x0, y0] = toPx(p[0], p[1], size);
      ctx.moveTo(x0, y0);
      if (p.length < 4) ctx.lineTo(x0 + DOT_PX, y0);
      for (let k = 2; k < p.length; k += 2) {
        const [x, y] = toPx(p[k], p[k + 1], size);
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
}

/** RGBA pixels (size × size) → ink mask: 1 where alpha ≥ 128. */
export function inkMask(rgba: Uint8ClampedArray, size: number): Uint8Array {
  const n = size * size;
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) m[i] = rgba[i * 4 + 3] >= 128 ? 1 : 0;
  return m;
}
