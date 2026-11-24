// Design §7.2: the colour strip at the top of the colour panel. The colour wheel laid flat, two handles for the
// at-rest colours (glow and core: they set hue and hueDepth), and a bright bracket over the colours on screen now.
// Under it, the hit lane: two markers where a full hit takes glow and core; dragging them sets the hue and
// hueDepth reactions.
import {
  handlesFromParams, hitParams, paramsFromHandles, reactsFromHit, type Handles, type HuePair,
} from '../shared/colour';
import { clamp01, fract, hsv2rgb } from '../shared/math';
import { h } from './ui';

const STRIP_H = 22;
const LABEL_H = 12;
const LANE_H = 12;
const HIT_PX = 8;
const FINE = 0.1;
const COL = { handle: '#f2f2f6', outline: '#0b0b0d', bracket: '#ffffff', label: '#9a9aa2', ghost: 'rgba(242, 242, 246, 0.55)' };

type Grab = 'glow' | 'core' | 'both' | 'hitGlow' | 'hitCore';

export interface HueStripOpts {
  /** Rest colours dragged: new hue and hueDepth bases. */
  onInput(hue: number, hueDepth: number): void;
  /** Hit markers dragged: new hue and hueDepth reacts. */
  onReact(react: HuePair): void;
}

export class HueStrip {
  readonly el: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private handles: Handles = { glow: 0, core: 0 };
  private depth = 0;
  private state = { hue: 0, depth: 0 };
  private react: HuePair = { hue: 0, hueDepth: 0 };
  private master = 1;
  private hit: Handles | null = null;
  private hitDepth = 0;
  private span = { from: 0, length: 0 };
  private sat = 1;
  private wheel: { sat: number; width: number; img: ImageData } | null = null;
  private drag: { grab: Grab; lastX: number } | null = null;

  constructor(private readonly o: HueStripOpts) {
    this.el = h('div', 'huestrip');
    this.canvas = h('canvas', 'huestrip-canvas', undefined, this.el);
    this.canvas.title = 'drag glow or core to change a colour; drag between them to move both; drag the markers below to set where a hit takes them';
    this.bindPointer();
    new ResizeObserver(() => this.draw()).observe(this.el);
  }

  /** Base values, reacts and reactMaster from a state message; ignored while dragging. */
  set(hue: number, hueDepth: number, react: HuePair = this.react, reactMaster: number = this.master): void {
    this.state = { hue, depth: hueDepth };
    this.react = { ...react };
    this.master = reactMaster;
    if (this.drag) return;
    this.depth = hueDepth;
    this.handles = handlesFromParams(hue, hueDepth);
    this.updateHit();
    this.draw();
  }

  /** The hit markers follow the rest colours and the reacts; hidden when reactMaster is 0. */
  private updateHit(): void {
    if (!(this.master > 0)) { this.hit = null; return; }
    const p = hitParams({ hue: this.state.hue, hueDepth: this.depth }, this.react, this.master);
    this.hitDepth = p.hueDepth;
    this.hit = handlesFromParams(p.hue, p.hueDepth);
  }

  /** The colours on screen now (glow → core) and the live saturation. */
  setLive(span: { from: number; length: number }, sat: number): void {
    if (span.from === this.span.from && span.length === this.span.length && sat === this.sat) return;
    this.span = span;
    this.sat = sat;
    this.draw();
  }

  // ---------- pointer ----------

  private bindPointer(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const grab = this.grabAt(e.clientX, e.clientY);
      if (!grab) return;
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      this.drag = { grab, lastX: e.clientX };
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.drag) { c.style.cursor = this.grabAt(e.clientX, e.clientY) ? 'ew-resize' : 'default'; return; }
      const dTurns = ((e.clientX - this.drag.lastX) / Math.max(1, c.clientWidth)) * (e.shiftKey ? FINE : 1);
      this.drag.lastX = e.clientX;
      if (dTurns !== 0) this.move(this.drag.grab, dTurns);
    });
    const end = (): void => {
      if (!this.drag) return;
      this.drag = null;
      this.set(this.state.hue, this.state.depth);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('lostpointercapture', end);
  }

  private move(grab: Grab, d: number): void {
    if (grab === 'hitGlow' || grab === 'hitCore') { this.moveHit(grab, d); return; }
    const next = { ...this.handles };
    if (grab !== 'core') next.glow = fract(next.glow + d);
    if (grab !== 'glow') next.core = fract(next.core + d);
    const p = paramsFromHandles(next, this.depth);
    this.handles = next;
    this.depth = p.hueDepth;
    this.state = { hue: p.hue, depth: p.hueDepth };
    this.o.onInput(p.hue, p.hueDepth);
    this.updateHit();
    this.draw();
  }

  private moveHit(grab: 'hitGlow' | 'hitCore', d: number): void {
    if (!this.hit) return;
    const next = { ...this.hit };
    if (grab === 'hitGlow') next.glow = fract(next.glow + d);
    else next.core = fract(next.core + d);
    const p = paramsFromHandles(next, this.hitDepth);
    const react = reactsFromHit({ hue: this.state.hue, hueDepth: this.depth }, p, this.master);
    if (!react) return;
    this.react = react;
    this.hit = next;
    this.hitDepth = p.hueDepth;
    this.o.onReact(react);
    this.draw();
  }

  /** In the hit lane: the nearest marker. In the strip: a handle within HIT_PX (wrapping), else the span between. */
  private grabAt(clientX: number, clientY: number): Grab | null {
    const r = this.canvas.getBoundingClientRect();
    const u = (clientX - r.left) / Math.max(1, r.width);
    const px = (a: number): number => Math.min(Math.abs(u - a), 1 - Math.abs(u - a)) * r.width;
    if (clientY - r.top > LABEL_H + STRIP_H + 2) {
      if (!this.hit) return null;
      const dg = px(this.hit.glow), dc = px(this.hit.core);
      if (Math.min(dg, dc) > HIT_PX * 1.5) return null;
      return dg <= dc ? 'hitGlow' : 'hitCore';
    }
    const dg = px(this.handles.glow), dc = px(this.handles.core);
    if (Math.min(dg, dc) <= HIT_PX) return dg <= dc ? 'glow' : 'core';
    const start = this.depth >= 0 ? this.handles.glow : this.handles.core;
    const len = fract((this.depth >= 0 ? this.handles.core : this.handles.glow) - start);
    return fract(u - start) <= len ? 'both' : null;
  }

  // ---------- drawing ----------

  private draw(): void {
    const c = this.canvas;
    const w = Math.max(60, Math.floor(this.el.clientWidth));
    const H = LABEL_H + STRIP_H + LANE_H + 4;
    const dpr = devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(H * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${H}px`;
    }
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.putImageData(this.wheelImage(c.width, Math.round(STRIP_H * dpr)), 0, Math.round(LABEL_H * dpr));
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    // live bracket: the colours on screen now
    g.strokeStyle = COL.bracket; g.lineWidth = 1.5;
    const start = this.span.length >= 0 ? this.span.from : fract(this.span.from + this.span.length);
    for (const [a, b] of pieces(start, Math.abs(this.span.length))) {
      g.strokeRect(a * w + 0.75, LABEL_H + 0.75, Math.max(1.5, (b - a) * w - 1.5), STRIP_H - 1.5);
    }

    this.drawHit(g, w);

    // handles: the at-rest colours
    g.font = '9px ui-monospace, Menlo, monospace';
    g.textBaseline = 'top';
    for (const [name, u] of [['glow', this.handles.glow], ['core', this.handles.core]] as const) {
      const x = Math.round(u * w) + 0.5;
      g.strokeStyle = COL.outline; g.lineWidth = 4;
      g.beginPath(); g.moveTo(x, LABEL_H - 2); g.lineTo(x, LABEL_H + STRIP_H + 2); g.stroke();
      g.strokeStyle = COL.handle; g.lineWidth = 2;
      g.beginPath(); g.moveTo(x, LABEL_H - 2); g.lineTo(x, LABEL_H + STRIP_H + 2); g.stroke();
      g.fillStyle = COL.label;
      const tw = g.measureText(name).width;
      g.fillText(name, Math.min(Math.max(0, x - tw / 2), w - tw), 0);
    }
  }

  /** Hit markers: a faint dashed line in the strip and a triangle in the lane below, per colour. */
  private drawHit(g: CanvasRenderingContext2D, w: number): void {
    if (!this.hit) return;
    const laneTop = LABEL_H + STRIP_H + 3;
    for (const [name, u] of [['glow', this.hit.glow], ['core', this.hit.core]] as const) {
      const x = Math.round(u * w) + 0.5;
      g.strokeStyle = COL.ghost; g.lineWidth = 1; g.setLineDash([2, 2]);
      g.beginPath(); g.moveTo(x, LABEL_H); g.lineTo(x, LABEL_H + STRIP_H); g.stroke();
      g.setLineDash([]);
      g.fillStyle = name === 'core' ? COL.handle : COL.outline;
      g.strokeStyle = COL.handle; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, laneTop); g.lineTo(x - 5, laneTop + 8); g.lineTo(x + 5, laneTop + 8); g.closePath(); g.fill(); g.stroke();
    }
    g.fillStyle = COL.label;
    g.font = '9px ui-monospace, Menlo, monospace';
    g.textBaseline = 'top';
    g.fillText('hit', 0, laneTop);
  }

  /** The wheel at the live saturation, cached per width and saturation. */
  private wheelImage(width: number, height: number): ImageData {
    const sat = Math.round(clamp01(this.sat) * 100) / 100;
    if (this.wheel && this.wheel.sat === sat && this.wheel.width === width && this.wheel.img.height === height) return this.wheel.img;
    const img = new ImageData(width, height);
    for (let x = 0; x < width; x++) {
      const [r, gg, b] = hsv2rgb((x + 0.5) / width, sat, 1);
      for (let y = 0; y < height; y++) {
        const i = (y * width + x) * 4;
        img.data[i] = r * 255; img.data[i + 1] = gg * 255; img.data[i + 2] = b * 255; img.data[i + 3] = 255;
      }
    }
    this.wheel = { sat, width, img };
    return img;
  }
}

/** [start, start + len] on a wheel 0…1, split where it wraps. */
function pieces(start: number, len: number): [number, number][] {
  if (len >= 1) return [[0, 1]];
  const end = start + len;
  return end <= 1 ? [[start, end]] : [[start, 1], [0, end - 1]];
}
