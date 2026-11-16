// Worker-backed BakeService (B12.4): one job in flight; a newer request with the same key replaces a waiting one.
import type { BakeService } from './library';
import type { BakeReply, BakeRequest } from './bake.worker';
import type { Stroke } from '../shared/strokes';

interface Job { key: string; strokes: Stroke[]; resolve(half: Uint16Array | null): void; }

export class WorkerBaker implements BakeService {
  private readonly worker: Worker;
  private readonly waiting = new Map<string, Job>(); // FIFO by insertion
  private busy: { job: number; resolve(half: Uint16Array | null): void } | null = null;
  private nextJob = 1;

  constructor(private readonly cell: number) {
    this.worker = new Worker(new URL('./bake.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<BakeReply>) => {
      if (!this.busy || e.data.job !== this.busy.job) return;
      if (e.data.error) console.warn('ferro bake', e.data.error);
      this.busy.resolve(e.data.half);
      this.busy = null;
      this.pump();
    };
    this.worker.onerror = (e) => {
      console.warn('ferro bake worker', e.message);
      this.busy?.resolve(null);
      this.busy = null;
      this.pump();
    };
  }

  bake(key: string, strokes: Stroke[]): Promise<Uint16Array | null> {
    return new Promise((resolve) => {
      const old = this.waiting.get(key);
      if (old) { old.resolve(null); this.waiting.delete(key); }
      this.waiting.set(key, { key, strokes, resolve });
      this.pump();
    });
  }

  private pump(): void {
    if (this.busy) return;
    const next = this.waiting.values().next();
    if (next.done) return;
    const j = next.value;
    this.waiting.delete(j.key);
    const job = this.nextJob++;
    this.busy = { job, resolve: j.resolve };
    const req: BakeRequest = { job, strokes: j.strokes, cell: this.cell };
    this.worker.postMessage(req);
  }
}
