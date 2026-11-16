// The Control's view of the shape library (B12): the last `library` message, stroke requests by id (edit, ghost,
// export, PNG), and the baked atlas for ghosts of baked shapes. Holds no state the Display doesn't send.
import { fromHalf } from '../shared/sdf';
import { drawStrokes } from '../shared/raster';
import type { ControlMsg, LibraryMsg, Manifest, ShapeMeta, ShapeStrokesMsg } from '../shared/protocol';
import type { Stroke } from '../shared/strokes';

const STROKES_TIMEOUT_MS = 3000;
/** PNG export size (B2.1). */
export const PNG_PX = 2048;

export class ShapeClient {
  library: LibraryMsg | null = null;
  private readonly waits = new Map<string, ((m: ShapeStrokesMsg | null) => void)[]>();
  private atlas: Promise<Uint16Array | null> | null = null;

  constructor(
    private readonly send: (m: ControlMsg) => void,
    /** A duplicate was made: open the copy in the drawing tool. */
    private readonly onDuplicate: (m: ShapeStrokesMsg) => void,
  ) {}

  onStrokes(m: ShapeStrokesMsg): void {
    if (m.duplicateOf !== undefined) { this.onDuplicate(m); return; }
    const list = this.waits.get(m.id);
    if (!list) return;
    this.waits.delete(m.id);
    for (const r of list) r(m);
  }

  /** The strokes of a drawn shape, or null (unknown, or the Display didn't answer in time). */
  strokes(id: string): Promise<ShapeStrokesMsg | null> {
    return new Promise((resolve) => {
      const list = this.waits.get(id) ?? [];
      list.push(resolve);
      this.waits.set(id, list);
      if (list.length === 1) this.send({ t: 'shapeGet', id });
      window.setTimeout(() => {
        const l = this.waits.get(id);
        if (!l?.includes(resolve)) return;
        l.splice(l.indexOf(resolve), 1);
        if (l.length === 0) this.waits.delete(id);
        resolve(null);
      }, STROKES_TIMEOUT_MS);
    });
  }

  byLayer(layer: number): ShapeMeta | undefined {
    return this.library?.shapes.find((s) => s.layer === layer);
  }

  byKey(key: string): ShapeMeta | undefined {
    return this.library?.shapes.find((s) => s.key === key);
  }

  /** Mask (d ≤ 0) of a baked layer from sdf/atlas.bin, fetched once on first use (B12.2). Row 0 = top. */
  async bakedMask(layer: number, manifest: Manifest): Promise<{ size: number; mask: Uint8Array } | null> {
    this.atlas ??= fetch(`${import.meta.env.BASE_URL}sdf/atlas.bin`)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((b) => (b ? new Uint16Array(b) : null))
      .catch(() => null);
    const atlas = await this.atlas;
    const n = manifest.cell * manifest.cell;
    if (!atlas || layer < 0 || layer >= manifest.count || atlas.length < (layer + 1) * n) return null;
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = fromHalf(atlas[layer * n + i]) <= 0 ? 1 : 0;
    return { size: manifest.cell, mask };
  }
}

/** 2048 px black-on-white PNG of a drawing, per B2.1, ready for art/png/ and `npm run bake`. */
export function strokesToPng(strokes: Stroke[]): Promise<Blob | null> {
  const ink = document.createElement('canvas');
  ink.width = ink.height = PNG_PX;
  const ictx = ink.getContext('2d');
  const out = document.createElement('canvas');
  out.width = out.height = PNG_PX;
  const octx = out.getContext('2d');
  if (!ictx || !octx) return Promise.resolve(null);
  drawStrokes(ictx, strokes, PNG_PX, '#000');
  octx.fillStyle = '#fff';
  octx.fillRect(0, 0, PNG_PX, PNG_PX);
  octx.drawImage(ink, 0, 0);
  return new Promise((resolve) => out.toBlob((b) => resolve(b), 'image/png'));
}
