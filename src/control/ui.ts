// Small DOM widgets for the Control dashboard (B10). Built once, updated in place.
import { clamp01 } from '../shared/math';

/** Tiny element factory. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string, parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  if (parent) parent.appendChild(el);
  return el;
}

export function button(label: string, onClick: (e: MouseEvent) => void, parent?: HTMLElement, cls = ''): HTMLButtonElement {
  const b = h('button', `btn ${cls}`.trim(), label, parent);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}


/** value ↔ 0…1 mapping for a slider */
export interface Mapping { toU(v: number): number; fromU(u: number): number; }
export const lin = (lo: number, hi: number): Mapping => ({
  toU: (v) => (v - lo) / (hi - lo),
  fromU: (u) => lo + u * (hi - lo),
});

export interface SliderOpts {
  /** Called with the new 0…1 position on drag / click / wheel. */
  onInput(u: number): void;
  /** Double-click. */
  onReset(): void;
  /** wheel step in 0…1 units (default 0.01) */
  step?: number;
  /** 0…1 position of a centre detent (snaps within ±0.025 while dragging) */
  detent?: number;
  tick?: boolean;
  bar?: boolean;
  cls?: string;
}

const RELEASE_HOLD_MS = 400;

/**
 * Pointer slider working in 0…1. `set()` (from a state message) is ignored while the slider is
 * under the pointer; after release the last received state is shown again.
 * Shift-drag = fine (×0.1), wheel = step, double-click = reset.
 */
export class Slider {
  readonly el: HTMLDivElement;
  private readonly fill: HTMLDivElement;
  private readonly thumb: HTMLDivElement;
  private readonly tickEl: HTMLDivElement | null;
  private readonly barEl: HTMLDivElement | null;
  private u = 0;
  private stateU = 0;
  private raw = 0;
  private drag: { lastX: number; width: number } | null = null;
  private releaseTimer = 0;

  constructor(private readonly o: SliderOpts) {
    const el = h('div', `slider ${o.cls ?? ''}`.trim());
    this.el = el;
    const track = h('div', 'sl-track', undefined, el);
    if (o.detent !== undefined) h('div', 'sl-detent', undefined, track).style.left = `${o.detent * 100}%`;
    this.fill = h('div', 'sl-fill', undefined, track);
    this.tickEl = o.tick ? h('div', 'sl-tick', undefined, track) : null;
    this.thumb = h('div', 'sl-thumb', undefined, track);
    this.barEl = o.bar ? h('div', 'sl-bar', undefined, h('div', 'sl-barwrap', undefined, el)) : null;

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const r = track.getBoundingClientRect();
      this.drag = { lastX: e.clientX, width: Math.max(1, r.width) };
      window.clearTimeout(this.releaseTimer);
      el.classList.add('active');
      this.raw = e.shiftKey ? this.u : clamp01((e.clientX - r.left) / r.width);
      this.input(this.raw, true);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const dx = e.clientX - this.drag.lastX;
      this.drag.lastX = e.clientX;
      if (dx === 0) return;
      this.raw = clamp01(this.raw + (dx / this.drag.width) * (e.shiftKey ? 0.1 : 1));
      this.input(this.raw, true);
    });
    const end = (): void => {
      if (!this.drag) return;
      this.drag = null;
      el.classList.remove('active');
      this.holdThenShowState();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
    el.addEventListener('dblclick', () => o.onReset());
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const d = e.deltaY !== 0 ? -Math.sign(e.deltaY) : Math.sign(e.deltaX);
      if (d === 0) return;
      this.input(this.u + d * (o.step ?? 0.01) * (e.shiftKey ? 0.1 : 1), false);
      this.holdThenShowState();
    }, { passive: false });
  }

  get dragging(): boolean { return this.drag !== null; }

  /** Value received from a state message. */
  set(u: number): void {
    this.stateU = clamp01(u);
    if (!this.drag) this.render(this.stateU);
  }

  /** Live effective value (0…1). */
  setTick(u: number): void {
    if (this.tickEl) this.tickEl.style.left = `${clamp01(u) * 100}%`;
  }

  /** Live level bar (0…1). */
  setBar(u: number): void {
    if (this.barEl) this.barEl.style.transform = `scaleX(${clamp01(u)})`;
  }

  private input(u: number, snap: boolean): void {
    let v = clamp01(u);
    const d = this.o.detent;
    if (snap && d !== undefined && Math.abs(v - d) < 0.025) v = d;
    this.render(v);
    this.o.onInput(v);
  }

  private holdThenShowState(): void {
    window.clearTimeout(this.releaseTimer);
    this.releaseTimer = window.setTimeout(() => { if (!this.drag) this.render(this.stateU); }, RELEASE_HOLD_MS);
  }

  private render(u: number): void {
    this.u = u;
    const d = this.o.detent;
    if (d !== undefined) {
      const lo = Math.min(u, d);
      this.fill.style.left = `${lo * 100}%`;
      this.fill.style.width = `${Math.abs(u - d) * 100}%`;
    } else {
      this.fill.style.width = `${u * 100}%`;
    }
    this.thumb.style.left = `${u * 100}%`;
  }
}

/** Row of mutually exclusive buttons. */
export class Seg<T extends string | number> {
  readonly el: HTMLDivElement;
  private readonly btns: HTMLButtonElement[] = [];

  constructor(private readonly values: readonly T[], labels: readonly string[], onPick: (v: T) => void, parent?: HTMLElement) {
    this.el = h('div', 'seg', undefined, parent);
    values.forEach((v, i) => this.btns.push(button(labels[i], () => onPick(v), this.el)));
  }

  set(v: T): void {
    this.values.forEach((x, i) => this.btns[i].classList.toggle('on', x === v));
  }
}

/** Horizontal level meter (fill via scaleX). */
export class Meter {
  readonly el: HTMLDivElement;
  private readonly fill: HTMLDivElement;
  constructor(cls = '', parent?: HTMLElement) {
    this.el = h('div', `meter ${cls}`.trim(), undefined, parent);
    this.fill = h('div', 'meter-fill', undefined, this.el);
  }
  set(u: number): void { this.fill.style.transform = `scaleX(${clamp01(u)})`; }
}

/** Labelled control row. */
export function row(label: string, parent: HTMLElement, cls = ''): HTMLDivElement {
  const r = h('div', `row ${cls}`.trim(), undefined, parent);
  h('span', 'lbl', label, r);
  return r;
}

export function fmt(v: number): string {
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
}
