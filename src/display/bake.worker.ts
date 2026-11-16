// Bake worker (B12.4): strokes → mask on an OffscreenCanvas → signed distance field → float16 cell.
// Runs off the main thread so the projector never stalls.
import { drawStrokes, inkMask } from '../shared/raster';
import { bakeMask } from '../shared/sdf';
import type { Stroke } from '../shared/strokes';

export interface BakeRequest { job: number; strokes: Stroke[]; cell: number; }
export interface BakeReply { job: number; half: Uint16Array | null; error?: string; }

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

function bake(strokes: Stroke[], cell: number): Uint16Array {
  const size = 2 * cell;
  if (!canvas || canvas.width !== size) {
    canvas = new OffscreenCanvas(size, size);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  if (!ctx) throw new Error('OffscreenCanvas 2D unavailable');
  ctx.clearRect(0, 0, size, size);
  drawStrokes(ctx, strokes, size);
  return bakeMask(inkMask(ctx.getImageData(0, 0, size, size).data, size), size);
}

const post = (self as unknown as { postMessage(m: BakeReply, transfer: Transferable[]): void }).postMessage.bind(self);

self.onmessage = (e: MessageEvent<BakeRequest>) => {
  const { job, strokes, cell } = e.data;
  try {
    const half = bake(strokes, cell);
    post({ job, half }, [half.buffer]);
  } catch (err) {
    post({ job, half: null, error: err instanceof Error ? err.message : String(err) }, []);
  }
};
