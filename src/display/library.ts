// Shape library (B12.3–B12.6): drawn shapes and their texture layers, the pool, live drawing and replay.
// Owns IndexedDB, the bake workers and the GL uploads (all injected, so it is tested with fakes); reports back to
// the store with InternalMsg and to the Control with library / shapeStrokes / shapeError messages.
import {
  LIVE_LAYER, type DisplayMsg, type LibraryMsg, type LiveMsg, type ShapeKey, type ShapeMeta, type ShapeMsg,
} from '../shared/protocol';
import {
  MAX_POINTS, parseShapes, parseStrokes, pathLength, pointCount, sliceStrokes, type DrawnShape, type Stroke,
} from '../shared/strokes';
import { blankHalf } from '../shared/sdf';
import { STORAGE_KEYS, parseJson, safeGet, safeSet, type StorageLike } from '../shared/state';
import type { InternalMsg, ShapeLookup } from './store';

/** Drawn shapes, keyed by id. Infrastructure: IndexedDB in the app, a Map in tests. */
export interface ShapeDB {
  loadAll(): Promise<DrawnShape[]>;
  put(shape: DrawnShape): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Strokes → float16 cell. A newer request with the same key replaces a waiting one, which resolves null. */
export interface BakeService {
  bake(key: string, strokes: Stroke[]): Promise<Uint16Array | null>;
}

export interface LibraryDeps {
  cell: number;
  bakedCount: number;
  /** Display names of the baked shapes (manifest file names). */
  bakedNames: string[];
  /** null: no IndexedDB, shapes last for the session. */
  db: ShapeDB | null;
  /** One worker per purpose (B12.4). */
  bake: { library: BakeService; live: BakeService };
  upload(layer: number, half: Uint16Array): void;
  /** 160 px thumbnail as a PNG data URL. */
  thumb(strokes: Stroke[]): string | null;
  storage: StorageLike | null;
  send(msg: DisplayMsg): void;
  emit(msg: InternalMsg): void;
  newId(): string;
  /** Wall-clock ms (timestamps, safety net, replay throttle). */
  now(): number;
}

/** What the sequencer shows this frame (SeqOutput subset). */
export interface FrameView {
  motifA: number;
  motifB: number;
  replay: { layer: number; q: number } | null;
}

/** The unchecked shape keys stored in `ferro.pool.v1` (B12.3); empty when missing or corrupt. */
export function storedDisabled(storage: StorageLike | null): Set<string> {
  const saved = parseJson(safeGet(storage, STORAGE_KEYS.pool));
  return new Set(Array.isArray(saved) ? saved.filter((k): k is string => typeof k === 'string') : []);
}

/** B12.5 safety net: live ends on its own after this long without liveStrokes. */
export const LIVE_TIMEOUT_MS = 3000;
/** B12.6: a replay re-bakes at most 10×/s. */
export const REPLAY_BAKE_MS = 100;
const NAME_MAX = 40;

interface Drawn { shape: DrawnShape; layer: number; thumb: string | null; }

const drawnKey = (id: string): ShapeKey => `drawn:${id}`;
const cleanName = (v: unknown): string => (typeof v === 'string' ? v.trim().slice(0, NAME_MAX) : '');
const hasInk = (strokes: readonly Stroke[]): boolean => strokes.some((s) => !s.erase);
const hms = (ms: number): string => {
  const d = new Date(ms);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
};

/** A row from IndexedDB, validated (a corrupt row is dropped). */
function validRow(v: unknown): DrawnShape | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Partial<DrawnShape>;
  const strokes = parseStrokes(r.strokes);
  if (typeof r.id !== 'string' || !strokes || typeof r.createdAt !== 'number') return null;
  const createdAt = r.createdAt;
  return { id: r.id, name: cleanName(r.name) || 'shape', createdAt, updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : createdAt, strokes };
}

export class Library implements ShapeLookup {
  private readonly drawn = new Map<string, Drawn>(); // creation order
  /** Layers of deleted shapes still on screen: cleared and freed once the projector has moved away (B12.3). */
  private readonly dying = new Set<number>();
  private disabled = new Set<string>();
  private version = 0;
  private persistent: boolean;
  private readonly blank: Uint16Array;
  private readonly ops = new Set<Promise<unknown>>();

  /** The live pipeline's own phase (accepting strokes, safety net armed); session.live is the store's view of it. */
  private liveOn = false;
  private liveAt = 0;
  private liveStrokes: Stroke[] = [];
  /** Every live-layer bake gets a number; only a newer one than what is shown may upload (finish fences them). */
  private liveSeq = 0;
  private liveShown = 0;

  private replay: { layer: number; strokes: Stroke[]; len: number; bakedAt: number; q: number } | null = null;

  constructor(private readonly d: LibraryDeps) {
    this.persistent = d.db !== null;
    this.blank = blankHalf(d.cell);
    this.disabled = storedDisabled(d.storage); // at once: the pool is right before IndexedDB answers
  }

  // ---------- boot ----------

  async boot(): Promise<void> {
    let rows: DrawnShape[] = [];
    if (this.d.db) {
      try { rows = await this.d.db.loadAll(); } catch { this.persistent = false; }
    }
    const shapes = rows.map(validRow).filter((s): s is DrawnShape => s !== null).sort((a, b) => a.createdAt - b.createdAt);
    for (const shape of shapes) {
      const layer = this.freeLayer();
      if (layer === null) break;
      this.drawn.set(shape.id, { shape, layer, thumb: this.d.thumb(shape.strokes) });
      this.bakeInto(shape.id, layer, shape.strokes);
    }
    this.disabled = new Set([...this.disabled].filter((k) => this.keyExists(k))); // drop keys of shapes that are gone
    this.persistPool();
    this.changed();
  }

  /** Resolves when every pending bake, upload and database write has settled (tests). */
  async idle(): Promise<void> {
    while (this.ops.size) await Promise.all([...this.ops]);
  }

  // ---------- lookups (ShapeLookup, SeqContext) ----------

  isShape(layer: number): boolean {
    return (Number.isInteger(layer) && layer >= 0 && layer < this.d.bakedCount) || this.byLayer(layer) !== undefined;
  }

  drawnLayer(key: unknown): number | null {
    if (typeof key !== 'string' || !key.startsWith('drawn:')) return null;
    return this.drawn.get(key.slice(6))?.layer ?? null;
  }

  /** Layers of the enabled shapes in library order: baked first, then drawn in creation order. */
  pool(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.d.bakedCount; i++) if (!this.disabled.has(`baked:${i}`)) out.push(i);
    for (const [id, e] of this.drawn) if (!this.disabled.has(drawnKey(id))) out.push(e.layer);
    return out;
  }

  get free(): number {
    return LIVE_LAYER - this.d.bakedCount - this.drawn.size - this.dying.size;
  }

  meta(): LibraryMsg {
    const shapes: ShapeMeta[] = [];
    for (let i = 0; i < this.d.bakedCount; i++) {
      const key: ShapeKey = `baked:${i}`;
      shapes.push({ key, layer: i, name: this.d.bakedNames[i] ?? String(i + 1), enabled: !this.disabled.has(key), thumb: null, drawn: false });
    }
    for (const [id, e] of this.drawn) {
      const key = drawnKey(id);
      shapes.push({ key, layer: e.layer, name: e.shape.name, enabled: !this.disabled.has(key), thumb: e.thumb, drawn: true });
    }
    return { t: 'library', version: this.version, shapes, free: this.free, persistent: this.persistent };
  }

  // ---------- messages (B9) ----------

  handle(msg: ShapeMsg | LiveMsg): void {
    switch (msg.t) {
      case 'shapeSave': this.save(msg.id, msg.name, msg.strokes); break;
      case 'shapeDelete': this.remove(msg.id); break;
      case 'shapeRename': this.rename(msg.id, msg.name); break;
      case 'shapeEnable': this.enable(msg.key, msg.enabled); break;
      case 'shapeDuplicate': this.duplicate(msg.id); break;
      case 'shapeGet': this.get(msg.id); break;
      case 'shapesImport': this.importShapes(msg.shapes); break;
      case 'live':
        if (msg.on) this.liveStart(msg.strokes); else this.liveOn = false;
        break;
      case 'liveStrokes': this.liveUpdate(msg.strokes); break;
      case 'liveFinish': this.finish(msg.id, msg.name, msg.strokes); break;
    }
  }

  /** Per frame: the live safety net, freeing deleted layers once off screen, and replay bakes. */
  frame(view: FrameView): void {
    if (this.liveOn && this.d.now() - this.liveAt >= LIVE_TIMEOUT_MS) {
      this.finish(undefined, `live ${hms(this.d.now())}`, this.liveStrokes);
    }
    for (const layer of this.dying) {
      if (layer === view.motifA || layer === view.motifB) continue;
      this.d.upload(layer, this.blank);
      this.dying.delete(layer);
    }
    this.replayFrame(view.replay);
  }

  /** After a GL context restore: every drawn shape and the live drawing are baked and uploaded again. */
  reuploadAll(): void {
    for (const [id, e] of this.drawn) this.bakeInto(id, e.layer, e.shape.strokes);
    if (this.liveOn) this.bakeLive(this.liveStrokes);
  }

  // ---------- shapes ----------

  private save(id: string | undefined, name: unknown, raw: unknown, onBaked?: (layer: number, half: Uint16Array) => void): Drawn | null {
    const strokes = parseStrokes(raw);
    if (!strokes) return this.fail('bad shape');
    if (pointCount(strokes) > MAX_POINTS) return this.fail('shape too big');
    const existing = id !== undefined ? this.drawn.get(id) : undefined;
    const now = this.d.now();
    let entry: Drawn;
    if (existing) {
      entry = { ...existing, shape: { ...existing.shape, name: cleanName(name) || existing.shape.name, strokes, updatedAt: now } };
    } else {
      const layer = this.freeLayer();
      if (layer === null) return this.fail('library full');
      entry = { layer, thumb: null, shape: { id: this.d.newId(), name: cleanName(name) || 'shape', createdAt: now, updatedAt: now, strokes } };
    }
    entry.thumb = this.d.thumb(strokes);
    this.drawn.set(entry.shape.id, entry);
    this.dbPut(entry.shape);
    this.bakeInto(entry.shape.id, entry.layer, strokes, onBaked);
    this.changed();
    return entry;
  }

  private remove(id: string): void {
    const e = this.drawn.get(id);
    if (!e) return;
    this.drawn.delete(id);
    this.dying.add(e.layer);
    if (this.disabled.delete(drawnKey(id))) this.persistPool();
    if (this.d.db && this.persistent) this.track(this.d.db.delete(id));
    this.d.emit({ t: 'shapeGone', layer: e.layer });
    this.changed();
  }

  private rename(id: string, name: string): void {
    const e = this.drawn.get(id);
    const n = cleanName(name);
    if (!e || !n) return;
    e.shape = { ...e.shape, name: n, updatedAt: this.d.now() };
    this.dbPut(e.shape);
    this.changed();
  }

  private enable(key: string, enabled: boolean): void {
    if (!this.keyExists(key) || typeof enabled !== 'boolean') return;
    if (enabled) this.disabled.delete(key); else this.disabled.add(key);
    this.persistPool();
    this.changed();
  }

  private duplicate(id: string): void {
    const src = this.drawn.get(id);
    if (!src) return;
    const copy = this.save(undefined, `${src.shape.name} copy`, src.shape.strokes);
    if (copy) this.d.send({ t: 'shapeStrokes', id: copy.shape.id, name: copy.shape.name, strokes: copy.shape.strokes, duplicateOf: id });
  }

  private get(id: string): void {
    const e = this.drawn.get(id);
    if (!e) { this.fail('unknown shape'); return; }
    this.d.send({ t: 'shapeStrokes', id, name: e.shape.name, strokes: e.shape.strokes });
  }

  private importShapes(v: unknown): void {
    let added = 0;
    let skipped = 0;
    for (const s of parseShapes(v)) {
      if (this.free > 0 && this.save(undefined, s.name, s.strokes)) added++; else skipped++;
    }
    if (skipped) this.fail(`imported ${added}, skipped ${skipped} (library full)`);
  }

  // ---------- live (B12.5) ----------

  private liveStart(raw: unknown): void {
    this.liveOn = true;
    this.liveUpdate(raw);
  }

  private liveUpdate(raw: unknown): void {
    if (!this.liveOn) return;
    const strokes = parseStrokes(raw);
    this.liveAt = this.d.now(); // even a malformed update proves the dashboard is alive
    if (!strokes) return;
    this.liveStrokes = strokes;
    this.bakeLive(strokes);
  }

  /** Save the drawing, then put the same picture in its layer and the live layer, then tell the store. */
  private finish(id: string | undefined, name: unknown, raw: unknown): void {
    this.liveOn = false;
    this.liveShown = ++this.liveSeq; // fence: no earlier live bake may land after this
    const strokes = parseStrokes(raw) ?? [];
    if (!hasInk(strokes)) { this.d.emit({ t: 'liveAbort' }); return; }
    const saved = this.save(id, name, strokes, (layer, half) => {
      this.d.upload(LIVE_LAYER, half);
      this.d.emit({ t: 'liveDone', layer });
    });
    if (!saved) this.d.emit({ t: 'liveAbort' });
  }

  private bakeLive(strokes: Stroke[]): void {
    const seq = ++this.liveSeq;
    this.track(this.d.bake.live.bake('live', strokes).then((half) => {
      if (!half || seq <= this.liveShown) return;
      this.liveShown = seq;
      this.d.upload(LIVE_LAYER, half);
    }));
  }

  // ---------- replay (B12.6) ----------

  private replayFrame(r: FrameView['replay']): void {
    if (!r) { this.replay = null; return; }
    if (!this.replay || this.replay.layer !== r.layer) {
      const strokes = this.byLayer(r.layer)?.shape.strokes ?? [];
      this.replay = { layer: r.layer, strokes, len: pathLength(strokes), bakedAt: -Infinity, q: 0 };
      this.liveShown = ++this.liveSeq; // the live layer starts blank, at once
      this.d.upload(LIVE_LAYER, this.blank);
    }
    const p = this.replay;
    const now = this.d.now();
    if (r.q > p.q && (r.q >= 1 || now - p.bakedAt >= REPLAY_BAKE_MS)) {
      p.bakedAt = now;
      p.q = r.q;
      this.bakeLive(sliceStrokes(p.strokes, r.q * p.len));
    }
  }

  // ---------- internals ----------

  private bakeInto(id: string, layer: number, strokes: Stroke[], onBaked?: (layer: number, half: Uint16Array) => void): void {
    this.track(this.d.bake.library.bake(`layer:${layer}`, strokes).then((half) => {
      if (!half || this.drawn.get(id)?.layer !== layer) return; // deleted meanwhile
      this.d.upload(layer, half);
      onBaked?.(layer, half);
    }));
  }

  private byLayer(layer: number): Drawn | undefined {
    for (const e of this.drawn.values()) if (e.layer === layer) return e;
    return undefined;
  }

  private freeLayer(): number | null {
    const used = new Set<number>(this.dying);
    for (const e of this.drawn.values()) used.add(e.layer);
    for (let l = this.d.bakedCount; l < LIVE_LAYER; l++) if (!used.has(l)) return l;
    return null;
  }

  private keyExists(key: string): boolean {
    if (key.startsWith('drawn:')) return this.drawn.has(key.slice(6));
    const m = /^baked:(\d+)$/.exec(key);
    return m !== null && Number(m[1]) < this.d.bakedCount;
  }

  private dbPut(shape: DrawnShape): void {
    if (!this.d.db || !this.persistent) return;
    this.track(this.d.db.put(shape).catch(() => {
      this.persistent = false;
      this.changed();
    }));
  }

  private persistPool(): void {
    safeSet(this.d.storage, STORAGE_KEYS.pool, JSON.stringify([...this.disabled]));
  }

  private changed(): void {
    this.version++;
    this.d.send(this.meta());
  }

  private fail(text: string): null {
    this.d.send({ t: 'shapeError', text });
    return null;
  }

  private track(p: Promise<unknown>): void {
    const q: Promise<unknown> = p.catch((e: unknown) => { console.warn('ferro library', e); }).finally(() => { this.ops.delete(q); });
    this.ops.add(q);
  }
}
