// Drawing modal (B12.1): one round brush, eraser, light smoothing, symmetry, ghost, undo/redo, live mode.
// A modal over the dashboard, never a new window. Closing never loses a drawing: it saves (or finishes when live).
import { drawStrokes, inkMask } from '../shared/raster';
import {
  MAX_POINTS, SYMMETRIES, inkWarnings, maskStats, pointCount, smoothPoint, symmetrize, type Stroke, type Symmetry,
} from '../shared/strokes';
import type { ControlMsg, Manifest } from '../shared/protocol';
import { isTyping } from '../shared/keys';
import type { ShapeClient } from './shapeclient';
import { button, h } from './ui';

const UNDO_DEPTH = 200;
const LIVE_SEND_MS = 100; // ≤ 10×/s
const HEARTBEAT_MS = 1000; // ≥ 1×/s while live (B12.5 safety net)
const STATS_PX = 256; // ink readout resolution
const GHOST_ALPHA = 0.25;
const SAFE = 0.1; // the safe area is the central 80% (B2.1)
const SYM_LABEL: Record<Symmetry, string> = { free: 'free', x: 'X', y: 'Y', xy: 'XY', r4: 'R4', r6: 'R6', r8: 'R8' };

export interface DrawHost {
  send(m: ControlMsg): void;
  client: ShapeClient;
  manifest(): Manifest | null;
  /** Layer on the projector now (meters.motifA). */
  currentLayer(): number;
}

/** What the modal opens on: a new drawing (no id), or a saved shape to edit. */
export interface DrawDoc { id?: string; name: string; strokes: Stroke[]; }

/** `readback`: the canvas is read with getImageData every change (the ink readout). */
const canvas2d = (c: HTMLCanvasElement, readback = false): CanvasRenderingContext2D => {
  const ctx = c.getContext('2d', { willReadFrequently: readback });
  if (!ctx) throw new Error('2D canvas unavailable');
  return ctx;
};

export class DrawModal {
  private readonly root: HTMLDivElement;
  private readonly view: HTMLCanvasElement;
  private readonly stage: HTMLDivElement;
  private readonly ink = document.createElement('canvas'); // committed strokes, transparent background
  private readonly work = document.createElement('canvas'); // ink + the stroke in progress
  private readonly ghost = document.createElement('canvas');
  private readonly stats = document.createElement('canvas');
  private readonly nameEl: HTMLInputElement;
  private readonly symBtns = new Map<Symmetry, HTMLButtonElement>();
  private readonly ghostSel: HTMLSelectElement;
  private readonly brushBtn: HTMLButtonElement;
  private readonly eraserBtn: HTMLButtonElement;
  private readonly liveBtn: HTMLButtonElement;
  private readonly saveBtn: HTMLButtonElement;
  private readonly inkEl: HTMLSpanElement;
  private readonly warnEl: HTMLSpanElement;
  private readonly countEl: HTMLSpanElement;
  private readonly msgEl: HTMLSpanElement;

  private doc: DrawDoc | null = null;
  private strokes: Stroke[] = [];
  private undoStack: Stroke[][] = [];
  private redoStack: Stroke[][] = [];
  private group = 0;
  private sym: Symmetry = 'free';
  private erase = false;
  private live = false;
  private displayLive = false;
  /** A when LIVE went on: the "current" ghost stays on it while live (B12.2). */
  private liveFrom = -1;
  private stroke: { pts: number[]; last: [number, number] } | null = null;
  private px = 0; // canvas backing size
  private ghostKey = '';
  private ghostToken = 0;
  private lastLiveSend = 0;
  private liveTimer = 0;
  private heartbeat = 0;

  constructor(private readonly host: DrawHost) {
    this.root = h('div', 'draw', undefined, document.body);
    const top = h('div', 'dtop', undefined, this.root);
    this.nameEl = h('input', 'dname', undefined, top);
    this.nameEl.type = 'text';
    this.nameEl.maxLength = 40;
    this.nameEl.placeholder = 'name';
    const symRow = h('div', 'seg dsym', undefined, top);
    for (const m of SYMMETRIES) this.symBtns.set(m, button(SYM_LABEL[m], () => this.setSym(m), symRow));
    h('span', 'mlbl', 'ghost', top);
    this.ghostSel = h('select', 'dghost', undefined, top);
    this.ghostSel.addEventListener('change', () => { this.ghostSel.blur(); this.updateGhost(); });
    const tools = h('div', 'seg dtools', undefined, top);
    this.brushBtn = button('brush', () => this.setErase(false), tools);
    this.eraserBtn = button('eraser', () => this.setErase(true), tools);
    button('undo', () => this.undo(), top);
    button('redo', () => this.redo(), top);
    button('clear', () => this.clear(), top, 'danger');

    const mid = h('div', 'dmid', undefined, this.root);
    this.stage = h('div', 'dstage', undefined, mid);
    this.view = h('canvas', 'dcanvas', undefined, this.stage);
    const side = h('div', 'dside', undefined, mid);
    this.liveBtn = button('', () => this.toggleLive(), side, 'dlive');
    h('span', 'dot', undefined, this.liveBtn);
    h('span', '', 'LIVE', this.liveBtn);
    this.saveBtn = button('Save', () => this.close(), side, 'dsave');
    button('Close ✕', () => this.close(), side);
    h('span', 'hint', 'Z undo · ⇧Z redo · B brush · E eraser · M symmetry · L live · Esc close', side);

    const bottom = h('div', 'dbottom', undefined, this.root);
    this.inkEl = h('span', 'stat', '', bottom);
    this.warnEl = h('span', 'dwarn', '', bottom);
    this.countEl = h('span', 'hint', '', bottom);
    this.msgEl = h('span', 'err', '', bottom);

    this.stats.width = this.stats.height = STATS_PX;
    this.view.addEventListener('pointerdown', (e) => this.down(e));
    this.view.addEventListener('pointermove', (e) => this.move(e));
    this.view.addEventListener('pointerup', () => this.up());
    this.view.addEventListener('pointerleave', () => this.up());
    window.addEventListener('resize', () => { if (this.doc) this.layout(); });
  }

  get isOpen(): boolean { return this.doc !== null; }

  /** Always opens in not-live mode (B12.1). */
  open(doc: DrawDoc): void {
    this.doc = doc;
    this.strokes = doc.strokes.slice();
    this.undoStack = [];
    this.redoStack = [];
    this.group = this.strokes.reduce((g, s) => Math.max(g, s.group), 0);
    this.live = false;
    this.stroke = null;
    this.nameEl.value = doc.name;
    this.msgEl.textContent = '';
    this.setErase(false);
    this.setSym(this.sym);
    this.fillGhostOptions();
    this.root.classList.add('open');
    this.showLive();
    this.layout();
    this.changed(false);
  }

  /** Save (or finish when live) and close. An empty canvas saves nothing (B12.1 closing rules). */
  close(): void {
    const doc = this.doc;
    if (!doc) return;
    this.up();
    const name = this.nameEl.value.trim() || doc.name;
    const base = { ...(doc.id !== undefined ? { id: doc.id } : {}), name, strokes: this.strokes };
    if (this.live) this.host.send({ t: 'liveFinish', ...base });
    else if (this.strokes.length) this.host.send({ t: 'shapeSave', ...base });
    this.stopLive();
    this.doc = null;
    this.nameEl.blur();
    this.root.classList.remove('open');
  }

  /** From each `state` message: the Display ended live on its own (safety net, reload) → back to not-live. */
  onSessionLive(live: boolean): void {
    const ended = this.displayLive && !live;
    this.displayLive = live;
    if (ended && this.live) {
      this.stopLive();
      this.msgEl.textContent = 'the projector left live mode';
      this.showLive();
    }
  }

  onLibrary(): void { if (this.doc) this.fillGhostOptions(); }
  onCurrent(): void { if (this.doc && this.ghostSel.value === 'current' && !this.live) this.updateGhost(); }
  onError(text: string): void { if (this.doc) this.msgEl.textContent = text; }

  /** Modal keys (B12.1). Returns true when the key was used. */
  key(e: KeyboardEvent): boolean {
    if (isTyping(e.target)) {
      if (e.key === 'Escape' || e.key === 'Enter') (e.target as HTMLElement).blur();
      return e.key === 'Escape' || e.key === 'Enter';
    }
    switch (e.key) {
      case 'z': this.undo(); return true;
      case 'Z': this.redo(); return true;
      case 'b': case 'B': this.setErase(false); return true;
      case 'e': case 'E': this.setErase(true); return true;
      case 'm': case 'M': this.setSym(SYMMETRIES[(SYMMETRIES.indexOf(this.sym) + 1) % SYMMETRIES.length]); return true;
      case 'l': case 'L': this.toggleLive(); return true;
      case 'Escape': this.close(); return true;
      default: return false;
    }
  }

  // ---------- drawing ----------

  private toMotif(e: PointerEvent): [number, number] {
    const r = this.view.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * 2 - 1, 1 - ((e.clientY - r.top) / r.height) * 2];
  }

  private copies(): number { return symmetrize(new Float32Array(2), this.sym).length; }

  private down(e: PointerEvent): void {
    if (e.button !== 0 || !this.doc) return;
    e.preventDefault();
    if (pointCount(this.strokes) + this.copies() > MAX_POINTS) { this.msgEl.textContent = 'point limit reached'; return; }
    const p = this.toMotif(e);
    this.stroke = { pts: [p[0], p[1]], last: p };
    this.render();
    this.sendLive();
  }

  private move(e: PointerEvent): void {
    const s = this.stroke;
    if (!s) return;
    const minDist = 2 / this.view.getBoundingClientRect().width; // 1 canvas px
    for (const ev of e.getCoalescedEvents?.() ?? [e]) {
      const p = smoothPoint(s.last, this.toMotif(ev), minDist);
      if (!p) continue;
      if (pointCount(this.strokes) + (s.pts.length / 2 + 1) * this.copies() > MAX_POINTS) {
        this.msgEl.textContent = 'point limit reached';
        break;
      }
      s.pts.push(p[0], p[1]);
      s.last = p;
    }
    this.render();
    this.sendLive();
  }

  private up(): void {
    const made = this.current();
    this.stroke = null;
    if (made.length === 0) return;
    this.apply([...this.strokes, ...made]);
  }

  /** The stroke under the mouse, multiplied by the symmetry (B12.1). */
  private current(): Stroke[] {
    if (!this.stroke) return [];
    const group = this.group + 1;
    return symmetrize(new Float32Array(this.stroke.pts), this.sym).map((pts) => ({ pts, erase: this.erase, group }));
  }

  // ---------- undo / redo / clear (one step per group) ----------

  private apply(next: Stroke[]): void {
    this.undoStack.push(this.strokes);
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
    this.redoStack = [];
    this.strokes = next;
    this.group = next.reduce((g, s) => Math.max(g, s.group), this.group);
    this.changed(true);
  }

  private undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.strokes);
    this.strokes = prev;
    this.changed(true);
  }

  private redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.strokes);
    this.strokes = next;
    this.changed(true);
  }

  private clear(): void {
    if (this.strokes.length) this.apply([]);
  }

  // ---------- live (B12.5) ----------

  private toggleLive(): void {
    if (!this.doc) return;
    if (this.live) {
      this.stopLive();
      this.host.send({ t: 'live', on: false });
    } else {
      this.live = true;
      this.liveFrom = this.host.currentLayer();
      this.msgEl.textContent = '';
      this.host.send({ t: 'live', on: true, strokes: this.all() });
      this.heartbeat = window.setInterval(() => this.sendLive(true), HEARTBEAT_MS);
    }
    this.showLive();
    this.updateGhost();
  }

  private stopLive(): void {
    this.live = false;
    window.clearInterval(this.heartbeat);
    window.clearTimeout(this.liveTimer);
    this.liveTimer = 0;
  }

  /** The drawing as the projector should show it: committed strokes plus the one under the mouse. */
  private all(): Stroke[] { return [...this.strokes, ...this.current()]; }

  /** liveStrokes at most 10×/s, the last change always sent (trailing). */
  private sendLive(force = false): void {
    if (!this.live) return;
    const wait = LIVE_SEND_MS - (performance.now() - this.lastLiveSend);
    if (force || wait <= 0) {
      window.clearTimeout(this.liveTimer);
      this.liveTimer = 0;
      this.lastLiveSend = performance.now();
      this.host.send({ t: 'liveStrokes', strokes: this.all() });
    } else if (!this.liveTimer) {
      this.liveTimer = window.setTimeout(() => { this.liveTimer = 0; this.sendLive(true); }, wait);
    }
  }

  private showLive(): void {
    this.liveBtn.classList.toggle('on', this.live);
    this.saveBtn.textContent = this.live ? 'Finish' : 'Save';
    this.root.classList.toggle('live', this.live);
  }

  // ---------- tool state ----------

  private setSym(m: Symmetry): void {
    this.sym = m;
    for (const [k, b] of this.symBtns) b.classList.toggle('on', k === m);
    this.render();
  }

  private setErase(on: boolean): void {
    this.erase = on;
    this.brushBtn.classList.toggle('on', !on);
    this.eraserBtn.classList.toggle('on', on);
  }

  // ---------- ghost (B12.2) ----------

  private fillGhostOptions(): void {
    const keep = this.ghostSel.value || 'current';
    this.ghostSel.replaceChildren();
    const opt = (value: string, label: string): void => { const o = h('option', '', label, this.ghostSel); o.value = value; };
    opt('current', 'current');
    opt('none', 'none');
    for (const s of this.host.client.library?.shapes ?? []) opt(s.key, s.drawn ? s.name : `#${s.layer + 1}`);
    this.ghostSel.value = [...this.ghostSel.options].some((o) => o.value === keep) ? keep : 'current';
    this.ghostKey = '';
    this.updateGhost();
  }

  private updateGhost(): void {
    const choice = this.ghostSel.value;
    const layer = choice === 'current' ? (this.live ? this.liveFrom : this.host.currentLayer())
      : choice === 'none' ? -1 : this.host.client.byKey(choice)?.layer ?? -1;
    const meta = this.host.client.byLayer(layer);
    const key = meta ? `${meta.key}@${this.host.client.library?.version ?? 0}` : 'none';
    if (key === this.ghostKey) return;
    this.ghostKey = key;
    const token = ++this.ghostToken;
    const g = canvas2d(this.ghost);
    g.clearRect(0, 0, this.ghost.width, this.ghost.height);
    this.render();
    if (!meta) return;
    if (meta.drawn) {
      void this.host.client.strokes(meta.key.slice(6)).then((m) => {
        if (!m || token !== this.ghostToken) return;
        drawStrokes(g, m.strokes, this.ghost.width);
        this.render();
      });
      return;
    }
    const manifest = this.host.manifest();
    if (!manifest) return;
    void this.host.client.bakedMask(meta.layer, manifest).then((r) => {
      if (!r || token !== this.ghostToken) return;
      const small = document.createElement('canvas');
      small.width = small.height = r.size;
      const sctx = canvas2d(small);
      const img = sctx.createImageData(r.size, r.size);
      for (let i = 0; i < r.mask.length; i++) if (r.mask[i]) { img.data.set([255, 255, 255, 255], i * 4); }
      sctx.putImageData(img, 0, 0);
      g.imageSmoothingEnabled = true;
      g.drawImage(small, 0, 0, this.ghost.width, this.ghost.height);
      this.render();
    });
  }

  // ---------- rendering ----------

  private layout(): void {
    const r = this.stage.getBoundingClientRect();
    const css = Math.max(100, Math.floor(Math.min(r.width, r.height)));
    this.view.style.width = this.view.style.height = `${css}px`;
    const px = Math.round(css * Math.min(devicePixelRatio || 1, 2));
    if (px === this.px) { this.render(); return; }
    this.px = px;
    for (const c of [this.view, this.ink, this.work, this.ghost]) c.width = c.height = px;
    this.ghostKey = '';
    this.updateGhost();
    this.redrawInk();
    this.render();
  }

  private redrawInk(): void {
    const c = canvas2d(this.ink);
    c.clearRect(0, 0, this.px, this.px);
    drawStrokes(c, this.strokes, this.px);
  }

  private render(): void {
    if (!this.px) return;
    const v = canvas2d(this.view);
    v.globalAlpha = 1;
    v.fillStyle = '#000';
    v.fillRect(0, 0, this.px, this.px);
    v.globalAlpha = GHOST_ALPHA;
    v.drawImage(this.ghost, 0, 0);
    v.globalAlpha = 1;
    const w = canvas2d(this.work);
    w.clearRect(0, 0, this.px, this.px);
    w.drawImage(this.ink, 0, 0);
    drawStrokes(w, this.current(), this.px);
    v.drawImage(this.work, 0, 0);
    v.strokeStyle = '#2a2a30';
    v.lineWidth = 1;
    v.strokeRect(this.px * SAFE + 0.5, this.px * SAFE + 0.5, this.px * (1 - 2 * SAFE), this.px * (1 - 2 * SAFE));
  }

  /** After the committed strokes changed: ink canvas, readout, live. */
  private changed(send: boolean): void {
    this.redrawInk();
    this.render();
    const s = canvas2d(this.stats, true);
    s.clearRect(0, 0, STATS_PX, STATS_PX);
    drawStrokes(s, this.strokes, STATS_PX);
    const st = maskStats(inkMask(s.getImageData(0, 0, STATS_PX, STATS_PX).data, STATS_PX), STATS_PX);
    this.inkEl.textContent = `ink ${Math.round(st.coverage * 100)}%`;
    this.warnEl.textContent = inkWarnings(st).join(' · ');
    this.countEl.textContent = `${new Set(this.strokes.map((x) => x.group)).size} strokes · ${pointCount(this.strokes)} pts`;
    if (send) this.sendLive();
  }
}
