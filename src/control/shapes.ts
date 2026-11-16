// Shapes column (B10, B12.3): the whole library in a scrolling grid, with the pool checkbox on every tile and
// edit / duplicate / draw in / PNG / delete on drawn ones. Click = queue, double-click = go now.
import type { CmdName, ControlMsg, LibraryMsg, ShapeKey, ShapeMeta, ShapeStrokesMsg } from '../shared/protocol';
import { parseJson } from '../shared/state';
import { parseStrokes } from '../shared/strokes';
import { ShapeClient, strokesToPng } from './shapeclient';
import type { DrawDoc } from './draw';
import { button, clock, download, fileStamp, h } from './ui';

export interface ShapeActions {
  queue(layer: number): void;
  goto(layer: number): void;
  enable(key: ShapeKey, enabled: boolean): void;
  edit(id: string): void;
  duplicate(id: string): void;
  replay(key: ShapeKey): void;
  png(id: string): void;
  remove(id: string): void;
}

const CLICK_DELAY_MS = 250; // a single click (queue) waits this long so a double-click (goto) can cancel it
const idOf = (key: ShapeKey): string => key.slice(6);

export class ShapeGrid {
  readonly el: HTMLDivElement;
  private tiles = new Map<number, HTMLDivElement>(); // by layer
  private version = -1;
  private clickTimer = 0;
  private full = false;
  private readonly confirm: HTMLDivElement;
  private readonly confirmText: HTMLSpanElement;
  private confirmId: string | null = null;

  constructor(parent: HTMLElement, private readonly act: ShapeActions) {
    this.el = h('div', 'thumbs', undefined, parent);
    this.confirm = h('div', 'menu', undefined, document.body);
    this.confirmText = h('span', '', '', this.confirm);
    const row = h('div', 'btnrow', undefined, this.confirm);
    button('Delete', () => { if (this.confirmId) this.act.remove(this.confirmId); this.closeConfirm(); }, row, 'danger');
    button('Cancel', () => this.closeConfirm(), row);
    window.addEventListener('pointerdown', (e) => {
      if (this.confirmId && !this.confirm.contains(e.target as Node)) this.closeConfirm();
    });
  }

  /** Rebuild the tiles when the library changed. */
  render(lib: LibraryMsg, bakedThumb: (layer: number) => string): void {
    if (lib.version === this.version) return;
    this.version = lib.version;
    this.full = lib.free <= 0;
    this.el.replaceChildren();
    this.tiles.clear();
    lib.shapes.forEach((s, i) => this.tiles.set(s.layer, this.tile(s, i, s.thumb ?? bakedThumb(s.layer))));
  }

  /** Outline the current A, the morph target B and the queued shape. */
  mark(a: number, b: number, queued: number | null): void {
    for (const [layer, t] of this.tiles) {
      t.classList.toggle('a', layer === a);
      t.classList.toggle('b', layer === b && b !== a);
      t.classList.toggle('q', layer === queued);
    }
  }

  private tile(s: ShapeMeta, index: number, src: string): HTMLDivElement {
    const t = h('div', `thumb${s.enabled ? '' : ' off'}`, undefined, this.el);
    t.title = s.name;
    const img = h('img', '', undefined, t);
    img.src = src;
    img.alt = s.name;
    img.draggable = false;
    h('span', 'tnum', s.drawn ? s.name : String(index + 1), t);
    const box = h('input', 'pool', undefined, t);
    box.type = 'checkbox';
    box.checked = s.enabled;
    box.title = 'in the random pool';
    box.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('dblclick', (e) => e.stopPropagation());
    box.addEventListener('change', () => { this.act.enable(s.key, box.checked); box.blur(); });
    if (s.drawn) this.tools(t, s);
    t.addEventListener('click', () => {
      window.clearTimeout(this.clickTimer);
      this.clickTimer = window.setTimeout(() => this.act.queue(s.layer), CLICK_DELAY_MS);
    });
    t.addEventListener('dblclick', () => {
      window.clearTimeout(this.clickTimer);
      this.act.goto(s.layer);
    });
    return t;
  }

  private tools(t: HTMLDivElement, s: ShapeMeta): void {
    const id = idOf(s.key);
    const bar = h('div', 'ttools', undefined, t);
    const tool = (label: string, title: string, fn: () => void, cls = ''): HTMLButtonElement => {
      const b = button(label, (e) => { e.stopPropagation(); fn(); }, bar, `tbtn ${cls}`.trim());
      b.title = title;
      b.addEventListener('dblclick', (e) => e.stopPropagation());
      return b;
    };
    tool('✎', 'edit', () => this.act.edit(id));
    tool('⧉', 'duplicate', () => this.act.duplicate(id)).disabled = this.full;
    tool('▶', 'draw in (replay)', () => this.act.replay(s.key));
    tool('⤓', 'PNG for art/png', () => this.act.png(id));
    tool('✕', 'delete', () => this.openConfirm(id, s.name, t), 'danger');
  }

  private openConfirm(id: string, name: string, near: HTMLElement): void {
    this.confirmId = id;
    this.confirmText.textContent = `Delete ${name}?`;
    const r = near.getBoundingClientRect();
    this.confirm.style.left = `${Math.min(r.left, window.innerWidth - 240)}px`;
    this.confirm.style.top = `${Math.min(r.bottom + 4, window.innerHeight - 80)}px`;
    this.confirm.classList.add('open');
  }

  private closeConfirm(): void {
    this.confirmId = null;
    this.confirm.classList.remove('open');
  }
}

export interface ShapesHost {
  send(m: ControlMsg): void;
  cmd(name: CmdName, arg?: unknown): void;
  openDraw(doc: DrawDoc): void;
}

const bakedThumb = (layer: number): string => `${import.meta.env.BASE_URL}sdf/thumbs/${String(layer + 1).padStart(2, '0')}.png`;
const fileName = (name: string): string => name.replace(/[\\/:*?"<>|]/g, '_');

/** The whole shapes column (B10): header, grid, navigation + Draw, shape files (B12.7). */
export class ShapesColumn {
  readonly client: ShapeClient;
  private readonly info: HTMLSpanElement;
  private readonly grid: ShapeGrid;
  private readonly drawBtn: HTMLButtonElement;

  constructor(parent: HTMLElement, private readonly host: ShapesHost) {
    const head = h('div', 'shead', undefined, parent);
    h('h2', '', 'Shapes', head);
    this.info = h('span', 'hint', '', head);
    this.client = new ShapeClient(host.send, (m) => host.openDraw({ id: m.id, name: m.name, strokes: m.strokes }));
    this.grid = new ShapeGrid(parent, {
      queue: (layer) => host.cmd('queue', layer),
      goto: (layer) => host.cmd('goto', layer),
      enable: (key, enabled) => host.send({ t: 'shapeEnable', key, enabled }),
      edit: (id) => { void this.client.strokes(id).then((m) => { if (m) host.openDraw({ id, name: m.name, strokes: m.strokes }); }); },
      duplicate: (id) => host.send({ t: 'shapeDuplicate', id }),
      replay: (key) => host.cmd('replay', key),
      png: (id) => { void this.exportPng(id); },
      remove: (id) => host.send({ t: 'shapeDelete', id }),
    });

    const nav = h('div', 'btnrow', undefined, parent);
    button('Prev', () => host.cmd('prev'), nav);
    button('Next', () => host.cmd('next'), nav);
    button('Random', () => host.cmd('random'), nav);
    this.drawBtn = button('Draw', () => this.openNew(), nav, 'drawbtn');
    this.drawBtn.title = 'open the drawing tool (P)';

    const files = h('div', 'btnrow', undefined, parent);
    button('Export shapes', () => { void this.exportShapes(); }, files);
    const input = h('input', 'hidden');
    input.type = 'file';
    input.accept = 'application/json,.json';
    button('Import shapes', () => input.click(), files);
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      input.value = '';
      if (f) void this.importShapes(f);
    });
  }

  onLibrary(msg: LibraryMsg): void {
    this.client.library = msg;
    this.grid.render(msg, bakedThumb);
    this.drawBtn.disabled = msg.free <= 0;
    this.drawBtn.title = msg.free <= 0 ? 'library full' : 'open the drawing tool (P)';
    this.info.textContent = `${msg.free} free${msg.persistent ? '' : " · shapes won't be saved"}`;
  }

  onStrokes(msg: ShapeStrokesMsg): void {
    const strokes = parseStrokes(msg.strokes);
    if (strokes) this.client.onStrokes({ ...msg, strokes });
  }

  onError(text: string): void { this.info.textContent = text; }

  mark(a: number, b: number, queued: number | null): void { this.grid.mark(a, b, queued); }

  /** Draw button and `P`: a new drawing, unless the library is full (B12.1). */
  openNew(): void {
    if ((this.client.library?.free ?? 0) <= 0) { this.info.textContent = 'library full'; return; }
    this.host.openDraw({ name: `drawing ${clock()}`, strokes: [] });
  }

  private async exportPng(id: string): Promise<void> {
    const m = await this.client.strokes(id);
    const blob = m ? await strokesToPng(m.strokes) : null;
    if (!m || !blob) { this.info.textContent = 'PNG failed'; return; }
    download(`${fileName(m.name)}.png`, blob);
  }

  /** B12.7: every drawn shape (strokes as plain arrays) and the unchecked keys. */
  private async exportShapes(): Promise<void> {
    const lib = this.client.library;
    if (!lib) return;
    const shapes: { name: string; strokes: { pts: number[]; erase: boolean; group: number }[] }[] = [];
    for (const s of lib.shapes.filter((x) => x.drawn)) {
      const m = await this.client.strokes(s.key.slice(6));
      if (m) shapes.push({ name: m.name, strokes: m.strokes.map((x) => ({ pts: Array.from(x.pts), erase: x.erase, group: x.group })) });
    }
    const disabled = lib.shapes.filter((x) => !x.enabled).map((x) => x.key);
    const name = `ferro-shapes-${fileStamp()}.json`;
    download(name, new Blob([JSON.stringify({ version: 1, shapes, disabled })], { type: 'application/json' }));
    this.info.textContent = `${shapes.length} shapes → ${name}`;
  }

  private async importShapes(f: File): Promise<void> {
    const parsed = parseJson(await f.text());
    if (parsed === undefined) { this.info.textContent = 'import: not JSON'; return; }
    this.host.send({ t: 'shapesImport', shapes: parsed });
    this.info.textContent = `importing ${f.name}`;
  }
}
