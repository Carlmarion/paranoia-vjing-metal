import { beforeEach, describe, expect, test } from 'vitest';
import { Library, type BakeService, type LibraryDeps, type ShapeDB } from '../src/display/library';
import { LIVE_LAYER, MAX_LAYERS, type DisplayMsg, type LibraryMsg } from '../src/shared/protocol';
import { STORAGE_KEYS, type StorageLike } from '../src/shared/state';
import type { InternalMsg } from '../src/display/store';
import type { DrawnShape, Stroke } from '../src/shared/strokes';

const CELL = 4;
const st = (x: number, erase = false, group = 0): Stroke => ({ pts: new Float32Array([x, 0, x + 0.1, 0]), erase, group });

class MemDB implements ShapeDB {
  rows = new Map<string, DrawnShape>();
  fail = false;
  async loadAll() { if (this.fail) throw new Error('no idb'); return [...this.rows.values()]; }
  async put(s: DrawnShape) { if (this.fail) throw new Error('no idb'); this.rows.set(s.id, s); }
  async delete(id: string) { this.rows.delete(id); }
}

/** Resolves every bake at once with a cell whose first value encodes the stroke count (+1). */
class InstantBaker implements BakeService {
  calls: { key: string; n: number }[] = [];
  async bake(key: string, strokes: Stroke[]): Promise<Uint16Array | null> {
    this.calls.push({ key, n: strokes.length });
    return new Uint16Array(CELL * CELL).fill(strokes.length + 1);
  }
}

class MemStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
}

interface Rig {
  lib: Library; db: MemDB; libBaker: InstantBaker; liveBaker: InstantBaker; storage: MemStorage;
  uploads: { layer: number; v: number }[]; sent: DisplayMsg[]; emitted: InternalMsg[]; clock: { t: number };
  lastLibrary(): LibraryMsg;
}

function rig(opts: { bakedCount?: number; db?: MemDB; storage?: MemStorage } = {}): Rig {
  const db = opts.db ?? new MemDB();
  const storage = opts.storage ?? new MemStorage();
  const libBaker = new InstantBaker();
  const liveBaker = new InstantBaker();
  const uploads: Rig['uploads'] = [];
  const sent: DisplayMsg[] = [];
  const emitted: InternalMsg[] = [];
  const clock = { t: 1_000_000 };
  let n = 0;
  const deps: LibraryDeps = {
    cell: CELL, bakedCount: opts.bakedCount ?? 12, bakedNames: Array.from({ length: opts.bakedCount ?? 12 }, (_, i) => `0${i + 1}`),
    db, bake: { library: libBaker, live: liveBaker },
    upload: (layer, half) => uploads.push({ layer, v: half[0] }),
    thumb: () => 'data:thumb', storage,
    send: (m) => sent.push(m), emit: (m) => emitted.push(m),
    newId: () => `id${++n}`, now: () => clock.t,
  };
  const lib = new Library(deps);
  return {
    lib, db, libBaker, liveBaker, storage, uploads, sent, emitted, clock,
    lastLibrary: () => sent.filter((m): m is LibraryMsg => m.t === 'library').at(-1)!,
  };
}

const BLANK_V = 0x4000; // float16 bits of +2

describe('library (B12.3)', () => {
  let r: Rig;
  beforeEach(async () => { r = rig(); await r.lib.boot(); });

  test('boot: baked shapes first, every free layer blank-free, library sent', () => {
    const m = r.lastLibrary();
    expect(m.shapes.map((s) => s.key)).toEqual(Array.from({ length: 12 }, (_, i) => `baked:${i}`));
    expect(m.free).toBe(MAX_LAYERS - 1 - 12);
    expect(m.persistent).toBe(true);
    expect(r.lib.pool()).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });

  test('save assigns the lowest free layer, bakes, uploads, persists and bumps version', async () => {
    const v0 = r.lastLibrary().version;
    r.lib.handle({ t: 'shapeSave', name: 'Fan', strokes: [st(0), st(0.2)] });
    await r.lib.idle();
    const m = r.lastLibrary();
    expect(m.version).toBeGreaterThan(v0);
    const s = m.shapes.at(-1)!;
    expect(s).toMatchObject({ key: 'drawn:id1', layer: 12, name: 'Fan', enabled: true, thumb: 'data:thumb', drawn: true });
    expect(r.uploads.at(-1)).toEqual({ layer: 12, v: 3 });
    expect(r.db.rows.get('id1')?.strokes).toHaveLength(2);
    expect(r.lib.isShape(12)).toBe(true);
    expect(r.lib.drawnLayer('drawn:id1')).toBe(12);
    expect(r.lib.drawnLayer('baked:3')).toBeNull();
    expect(r.lib.pool()).toContain(12);
  });

  test('save with an id updates in place: same layer, re-baked', async () => {
    r.lib.handle({ t: 'shapeSave', name: 'A', strokes: [st(0)] });
    await r.lib.idle();
    r.lib.handle({ t: 'shapeSave', id: 'id1', name: 'A2', strokes: [st(0), st(0.1), st(0.2)] });
    await r.lib.idle();
    expect(r.lastLibrary().shapes.filter((s) => s.drawn)).toHaveLength(1);
    expect(r.lastLibrary().shapes.at(-1)?.name).toBe('A2');
    expect(r.uploads.at(-1)).toEqual({ layer: 12, v: 4 });
  });

  test('delete frees the layer only once it is off screen, and tells the store', async () => {
    r.lib.handle({ t: 'shapeSave', name: 'A', strokes: [st(0)] });
    r.lib.handle({ t: 'shapeEnable', key: 'drawn:id1', enabled: false });
    await r.lib.idle();
    r.lib.handle({ t: 'shapeDelete', id: 'id1' });
    await r.lib.idle();
    expect(r.emitted).toContainEqual({ t: 'shapeGone', layer: 12 });
    expect(r.lib.isShape(12)).toBe(false);
    expect(r.lastLibrary().shapes.some((s) => s.key === 'drawn:id1')).toBe(false);
    expect(r.db.rows.has('id1')).toBe(false);
    expect(JSON.parse(r.storage.data.get(STORAGE_KEYS.pool) ?? '[]')).not.toContain('drawn:id1');
    // still on screen as A: not cleared, not reusable
    r.lib.frame({ motifA: 12, motifB: 12, replay: null });
    r.lib.handle({ t: 'shapeSave', name: 'B', strokes: [st(0)] });
    await r.lib.idle();
    expect(r.lastLibrary().shapes.at(-1)?.layer).toBe(13);
    expect(r.uploads.filter((u) => u.layer === 12 && u.v === BLANK_V)).toHaveLength(0);
    r.lib.frame({ motifA: 13, motifB: 13, replay: null });
    expect(r.uploads.at(-1)).toEqual({ layer: 12, v: BLANK_V });
  });

  test('a full library refuses a save with shapeError', async () => {
    for (let i = 0; i < MAX_LAYERS - 1 - 12; i++) r.lib.handle({ t: 'shapeSave', name: `s${i}`, strokes: [st(0)] });
    await r.lib.idle();
    expect(r.lastLibrary().free).toBe(0);
    r.lib.handle({ t: 'shapeSave', name: 'one too many', strokes: [st(0)] });
    expect(r.sent.at(-1)).toEqual({ t: 'shapeError', text: 'library full' });
  });

  test('the pool: unchecking removes a shape from random choice, and survives a reload', async () => {
    r.lib.handle({ t: 'shapeEnable', key: 'baked:3', enabled: false });
    expect(r.lib.pool()).not.toContain(3);
    expect(r.lastLibrary().shapes[3].enabled).toBe(false);
    const again = rig({ storage: r.storage });
    await again.lib.boot();
    expect(again.lib.pool()).not.toContain(3);
    expect(again.lib.isShape(3)).toBe(true);
  });

  test('at boot, disabled keys of shapes that no longer exist are dropped', async () => {
    const storage = new MemStorage();
    storage.setItem(STORAGE_KEYS.pool, JSON.stringify(['baked:2', 'drawn:gone', 'baked:99']));
    const x = rig({ storage });
    await x.lib.boot();
    expect(JSON.parse(storage.getItem(STORAGE_KEYS.pool)!)).toEqual(['baked:2']);
  });

  test('drawn shapes reload from the database in creation order and are baked', async () => {
    r.lib.handle({ t: 'shapeSave', name: 'first', strokes: [st(0)] });
    r.clock.t += 10;
    r.lib.handle({ t: 'shapeSave', name: 'second', strokes: [st(0), st(0.1)] });
    await r.lib.idle();
    const again = rig({ db: r.db });
    await again.lib.boot();
    await again.lib.idle();
    expect(again.lastLibrary().shapes.filter((s) => s.drawn).map((s) => s.name)).toEqual(['first', 'second']);
    expect(again.uploads).toContainEqual({ layer: 13, v: 3 });
  });

  test('without IndexedDB the library still works for the session and says so', async () => {
    const db = new MemDB();
    db.fail = true;
    const x = rig({ db });
    await x.lib.boot();
    expect(x.lastLibrary().persistent).toBe(false);
    x.lib.handle({ t: 'shapeSave', name: 'tmp', strokes: [st(0)] });
    await x.lib.idle();
    expect(x.lastLibrary().shapes.at(-1)?.name).toBe('tmp');
  });

  test('rename, get, duplicate', async () => {
    r.lib.handle({ t: 'shapeSave', name: 'Fan', strokes: [st(0)] });
    await r.lib.idle();
    r.lib.handle({ t: 'shapeRename', id: 'id1', name: '  Rosette  ' });
    expect(r.lastLibrary().shapes.at(-1)?.name).toBe('Rosette');
    r.lib.handle({ t: 'shapeGet', id: 'id1' });
    expect(r.sent.at(-1)).toMatchObject({ t: 'shapeStrokes', id: 'id1', name: 'Rosette' });
    r.lib.handle({ t: 'shapeDuplicate', id: 'id1' });
    await r.lib.idle();
    expect(r.sent.find((m) => m.t === 'shapeStrokes' && m.duplicateOf === 'id1')).toMatchObject({ id: 'id2', name: 'Rosette copy' });
    expect(r.lastLibrary().shapes.at(-1)).toMatchObject({ key: 'drawn:id2', layer: 13 });
  });

  test('import skips shapes that would not fit and says how many', async () => {
    const shapes = Array.from({ length: MAX_LAYERS }, (_, i) => ({ name: `i${i}`, strokes: [{ pts: [0, 0], erase: false, group: 0 }] }));
    r.lib.handle({ t: 'shapesImport', shapes: { shapes } });
    await r.lib.idle();
    expect(r.lastLibrary().free).toBe(0);
    expect(r.sent.some((m) => m.t === 'shapeError' && /skipped 13/.test(m.text))).toBe(true);
  });

  test('a shape over the point limit is refused', () => {
    r.lib.handle({ t: 'shapeSave', name: 'huge', strokes: [{ pts: new Float32Array(40002), erase: false, group: 0 }] });
    expect(r.sent.at(-1)).toEqual({ t: 'shapeError', text: 'shape too big' });
  });
});

describe('live (B12.5)', () => {
  let r: Rig;
  beforeEach(async () => { r = rig(); await r.lib.boot(); });

  test('live strokes are baked into the live layer, latest wins', async () => {
    r.lib.handle({ t: 'live', on: true, strokes: [st(0)] });
    r.lib.handle({ t: 'liveStrokes', strokes: [st(0), st(0.1)] });
    await r.lib.idle();
    expect(r.liveBaker.calls.every((c) => c.key === 'live')).toBe(true);
    expect(r.uploads.filter((u) => u.layer === LIVE_LAYER).at(-1)?.v).toBe(3);
  });

  test('finish saves once, uploads the same picture to the shape layer and the live layer, then tells the store', async () => {
    r.lib.handle({ t: 'live', on: true, strokes: [st(0)] });
    r.lib.handle({ t: 'liveFinish', name: 'Live one', strokes: [st(0), st(0.1)] });
    await r.lib.idle();
    const tail = r.uploads.slice(-2);
    expect(tail).toEqual(expect.arrayContaining([{ layer: 12, v: 3 }, { layer: LIVE_LAYER, v: 3 }]));
    expect(r.emitted.at(-1)).toEqual({ t: 'liveDone', layer: 12 });
    expect(r.lastLibrary().shapes.at(-1)?.name).toBe('Live one');
  });

  test('a stale live bake never lands after finish', async () => {
    const slow: { resolve: (v: Uint16Array) => void }[] = [];
    r.liveBaker.bake = (key: string, strokes: Stroke[]) => {
      r.liveBaker.calls.push({ key, n: strokes.length });
      return new Promise<Uint16Array | null>((resolve) => slow.push({ resolve }));
    };
    r.lib.handle({ t: 'live', on: true, strokes: [st(0)] });
    r.lib.handle({ t: 'liveFinish', name: 'x', strokes: [st(0), st(0.1)] });
    await new Promise((res) => setTimeout(res, 0)); // the finish bake (instant baker) settles; the live bake is still held
    expect(r.emitted.at(-1)).toEqual({ t: 'liveDone', layer: 12 });
    slow.forEach((s) => s.resolve(new Uint16Array(CELL * CELL).fill(99)));
    await r.lib.idle();
    expect(r.uploads.some((u) => u.v === 99)).toBe(false);
  });

  test('finish with no ink aborts and saves nothing', async () => {
    r.lib.handle({ t: 'live', on: true, strokes: [] });
    r.lib.handle({ t: 'liveFinish', name: 'x', strokes: [st(0, true)] });
    await r.lib.idle();
    expect(r.emitted.at(-1)).toEqual({ t: 'liveAbort' });
    expect(r.lastLibrary().shapes.some((s) => s.drawn)).toBe(false);
  });

  test('safety net: 3 s without liveStrokes finishes with the last strokes; it never fires when not live', async () => {
    r.lib.handle({ t: 'live', on: true, strokes: [st(0)] });
    r.clock.t += 2900;
    r.lib.frame({ motifA: LIVE_LAYER, motifB: LIVE_LAYER, replay: null });
    expect(r.emitted).toHaveLength(0);
    r.clock.t += 200;
    r.lib.frame({ motifA: LIVE_LAYER, motifB: LIVE_LAYER, replay: null });
    await r.lib.idle();
    expect(r.emitted.at(-1)).toEqual({ t: 'liveDone', layer: 12 });
    expect(r.lastLibrary().shapes.at(-1)?.name).toMatch(/^live \d\d:\d\d:\d\d$/);
    const n = r.emitted.length;
    r.clock.t += 10_000;
    r.lib.frame({ motifA: 12, motifB: 12, replay: null });
    expect(r.emitted).toHaveLength(n);
  });

  test('safety net with an empty canvas melts back instead', async () => {
    r.lib.handle({ t: 'live', on: true, strokes: [] });
    r.clock.t += 3100;
    r.lib.frame({ motifA: LIVE_LAYER, motifB: LIVE_LAYER, replay: null });
    await r.lib.idle();
    expect(r.emitted.at(-1)).toEqual({ t: 'liveAbort' });
  });
});

describe('replay (B12.6)', () => {
  test('clears the live layer at once, then bakes a growing prefix at most 10×/s', async () => {
    const r = rig();
    await r.lib.boot();
    const strokes = Array.from({ length: 10 }, (_, i) => st(i / 10 - 0.5, false, i));
    r.lib.handle({ t: 'shapeSave', name: 'R', strokes });
    await r.lib.idle();
    r.uploads.length = 0;
    r.lib.frame({ motifA: 5, motifB: LIVE_LAYER, replay: { layer: 12, q: 0 } });
    expect(r.uploads).toEqual([{ layer: LIVE_LAYER, v: BLANK_V }]);
    const counts: number[] = [];
    for (let i = 1; i <= 60; i++) {
      r.clock.t += 1000 / 60;
      r.lib.frame({ motifA: 5, motifB: LIVE_LAYER, replay: { layer: 12, q: i / 60 } });
      await r.lib.idle();
    }
    for (const c of r.liveBaker.calls) counts.push(c.n);
    expect(counts.length).toBeLessThanOrEqual(11);
    expect(counts.at(-1)).toBe(10); // q = 1: the whole drawing
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
  });
});
