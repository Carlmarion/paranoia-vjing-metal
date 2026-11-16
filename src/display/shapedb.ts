// IndexedDB store of drawn shapes (B3): database `ferro`, object store `shapes` keyed by `id`.
// Strokes are stored as structured clones (Float32Array inside).
import type { ShapeDB } from './library';
import type { DrawnShape } from '../shared/strokes';

const DB_NAME = 'ferro';
const STORE = 'shapes';

const done = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });

/** Opens the database, or returns null when IndexedDB is unavailable (private window, blocked storage). */
export async function openShapeDB(): Promise<ShapeDB | null> {
  let db: IDBDatabase;
  try {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'id' }); };
    db = await done(req);
  } catch {
    return null;
  }
  const store = (mode: IDBTransactionMode): IDBObjectStore => db.transaction(STORE, mode).objectStore(STORE);
  return {
    loadAll: () => done(store('readonly').getAll() as IDBRequest<DrawnShape[]>),
    put: async (shape) => { await done(store('readwrite').put(shape)); },
    delete: async (id) => { await done(store('readwrite').delete(id)); },
  };
}
