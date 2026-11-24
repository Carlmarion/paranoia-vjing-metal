// Design §5.4: the envelope editor (one per shape, line and colour panel) and its mini curve for the header.
// The curve is drawn by `envCurve`, the same code the Display runs: never an approximation.
// Each hit the Display reports spawns a thin trigger line that travels along the timeline (like grains in a granulator).
import { envCurve, type EnvCurve, type EnvSpans } from '../shared/envelope';
import { ENV_RANGES, neutralEnv, type Env } from '../shared/state';
import { clamp01 } from '../shared/math';
import { h } from './ui';

/** Each section's axis spans its parameter's full range, on a square-root time scale. */
const SPANS: EnvSpans = { attack: ENV_RANGES.attack[1], sustain: ENV_RANGES.decay[1], release: ENV_RANGES.release[1] };
const SAMPLES = 64;
const MINI_SAMPLES = 16;
const HIT_PX = 12;
const FINE = 0.1;
const EDITOR_H = 110;
const MINI_W = 64;
const MINI_H = 18;
const PAD = { l: 6, r: 6, t: 8, b: 20 };

const COL = {
  curve: '#b4b4bc', fill: 'rgba(199, 136, 58, 0.12)', marker: '#c9b23a', axis: '#26262c',
  dot: '#e2e2e8', hit: '199, 136, 58', text: '#5c5c64',
};
/** A trigger line fades with this time constant (s); it is dropped below MIN_ALPHA or past the sustain section. */
const HIT_FADE_S = 3;
const HIT_ALPHA = 0.85;
const MIN_ALPHA = 0.03;
const MAX_LINES = 200;
/** Hits per second are counted over this window. */
const RATE_WINDOW_S = 3;

type Dot = 'A' | 'S' | 'R';
type Section = 'attack' | 'sustain' | 'release';
const SECTIONS: Section[] = ['attack', 'sustain', 'release'];

/** Time value ↔ 0…1 position inside its section (square-root axis). */
const toPos = (t: number, span: number): number => Math.sqrt(clamp01(t / span));
const fromPos = (p: number, span: number): number => span * clamp01(p) ** 2;

export interface EnvEditorOpts {
  onInput(key: keyof Env, value: number): void;
  onReset(key: keyof Env): void;
}

export class EnvEditor {
  readonly mini: HTMLCanvasElement;
  readonly el: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly values: HTMLDivElement;
  private env: Env = neutralEnv();
  private stateEnv: Env = neutralEnv();
  private curve: EnvCurve;
  private miniCurve: EnvCurve;
  /** Birth times (performance.now() ms) of the trigger lines, oldest first. */
  private hits: number[] = [];
  private raf = 0;
  private readonly rateEl: HTMLSpanElement;
  private drag: { dot: Dot; lastX: number; lastY: number; px: number; py: number } | null = null;
  private open = false;

  constructor(private readonly o: EnvEditorOpts) {
    this.mini = h('canvas', 'env-mini');
    this.mini.width = MINI_W * devicePixelRatio;
    this.mini.height = MINI_H * devicePixelRatio;
    this.mini.title = 'reaction envelope: click to edit';
    this.mini.addEventListener('click', () => this.toggle());
    this.el = h('div', 'env-editor hidden');
    this.canvas = h('canvas', 'env-canvas', undefined, this.el);
    const foot = h('div', 'env-foot', undefined, this.el);
    this.values = h('div', 'env-values', label(this.env), foot);
    h('span', 'spacer', undefined, foot);
    this.rateEl = h('span', 'env-rate', '0.0 hits/s', foot);
    this.curve = envCurve(this.env, SAMPLES, SPANS);
    this.miniCurve = envCurve(this.env, MINI_SAMPLES, SPANS);
    this.bindPointer();
    new ResizeObserver(() => this.draw()).observe(this.el);
    this.drawMini();
  }

  get isOpen(): boolean { return this.open; }

  toggle(): void {
    this.open = !this.open;
    this.el.classList.toggle('hidden', !this.open);
    this.draw();
  }

  /** From a state message; ignored while a dot is being dragged. */
  set(env: Env): void {
    this.stateEnv = { ...env };
    if (!this.drag) this.show(this.stateEnv);
  }

  /** From a meters message: `n` hits since the previous one, each spawning a trigger line. */
  addHits(n: number): void {
    if (!(n > 0)) return;
    const now = performance.now();
    for (let i = 0; i < n; i++) this.hits.push(now);
    if (this.hits.length > MAX_LINES) this.hits.splice(0, this.hits.length - MAX_LINES);
    if (!this.raf) this.raf = requestAnimationFrame(this.animate);
  }

  private readonly animate = (): void => {
    const now = performance.now();
    const life = Math.min(SPANS.attack + SPANS.sustain, HIT_FADE_S * Math.log(HIT_ALPHA / MIN_ALPHA)) * 1000;
    while (this.hits.length && now - this.hits[0] > life) this.hits.shift();
    const recent = this.hits.filter((t) => now - t <= RATE_WINDOW_S * 1000).length;
    this.rateEl.textContent = `${(recent / RATE_WINDOW_S).toFixed(1)} hits/s`;
    this.draw();
    this.drawMini();
    this.raf = this.hits.length ? requestAnimationFrame(this.animate) : 0;
  };

  private show(env: Env): void {
    const same = (Object.keys(env) as (keyof Env)[]).every((k) => env[k] === this.env[k]);
    if (same) return;
    this.env = { ...env };
    this.curve = envCurve(this.env, SAMPLES, SPANS);
    this.miniCurve = envCurve(this.env, MINI_SAMPLES, SPANS);
    this.values.textContent = label(env);
    this.draw();
    this.drawMini();
  }

  // ---------- geometry ----------

  private plot(): { x0: number; w: number; y0: number; h: number; third: number } {
    const w = this.canvas.width / devicePixelRatio - PAD.l - PAD.r;
    const hh = EDITOR_H - PAD.t - PAD.b;
    return { x0: PAD.l, w, y0: PAD.t, h: hh, third: w / 3 };
  }

  private dotPos(dot: Dot): { x: number; y: number } {
    const p = this.plot();
    const e = this.env;
    if (dot === 'A') return { x: p.x0 + toPos(e.attack, SPANS.attack) * p.third, y: p.y0 };
    if (dot === 'S') return { x: p.x0 + p.third + toPos(e.decay, SPANS.sustain) * p.third, y: p.y0 + (1 - e.sustain) * p.h };
    return { x: p.x0 + 2 * p.third + toPos(e.release, SPANS.release) * p.third, y: p.y0 + p.h };
  }

  // ---------- pointer ----------

  private bindPointer(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      const dot = this.hit(e);
      if (!dot || e.button !== 0) return;
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      const at = this.dotPos(dot);
      this.drag = { dot, lastX: e.clientX, lastY: e.clientY, px: at.x, py: at.y };
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.drag) { c.style.cursor = this.hit(e) ? 'grab' : 'default'; return; }
      const d = this.drag;
      const k = e.shiftKey ? FINE : 1;
      d.px += (e.clientX - d.lastX) * k;
      d.py += (e.clientY - d.lastY) * k;
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      this.dragTo(d.dot, d.px, d.py);
    });
    const end = (): void => {
      if (!this.drag) return;
      this.drag = null;
      this.show(this.stateEnv);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('lostpointercapture', end);
    c.addEventListener('dblclick', (e) => {
      const dot = this.hit(e);
      if (dot === 'A') this.o.onReset('attack');
      if (dot === 'S') { this.o.onReset('sustain'); this.o.onReset('decay'); }
      if (dot === 'R') this.o.onReset('release');
    });
  }

  private hit(e: MouseEvent): Dot | null {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best: Dot | null = null, bestD = HIT_PX;
    for (const dot of ['A', 'S', 'R'] as Dot[]) {
      const p = this.dotPos(dot);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d <= bestD) { best = dot; bestD = d; }
    }
    return best;
  }

  private dragTo(dot: Dot, x: number, y: number): void {
    const p = this.plot();
    const pos = (section: number): number => (x - p.x0 - section * p.third) / p.third;
    const next = { ...this.env };
    if (dot === 'A') next.attack = fromPos(pos(0), SPANS.attack);
    if (dot === 'S') {
      next.decay = Math.max(ENV_RANGES.decay[0], fromPos(pos(1), SPANS.sustain));
      next.sustain = clamp01(1 - (y - p.y0) / p.h);
    }
    if (dot === 'R') next.release = fromPos(pos(2), SPANS.release);
    for (const k of Object.keys(next) as (keyof Env)[]) if (next[k] !== this.env[k]) this.o.onInput(k, next[k]);
    this.show(next);
  }

  // ---------- drawing ----------

  private draw(): void {
    if (!this.open) return;
    const c = this.canvas;
    const cssW = Math.max(120, this.el.clientWidth);
    if (c.width !== Math.round(cssW * devicePixelRatio)) {
      c.width = Math.round(cssW * devicePixelRatio);
      c.height = Math.round(EDITOR_H * devicePixelRatio);
      c.style.width = `${cssW}px`;
      c.style.height = `${EDITOR_H}px`;
    }
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    g.clearRect(0, 0, cssW, EDITOR_H);
    const p = this.plot();
    const pts = curvePoints(this.curve, p.x0, p.y0, p.third, p.h);

    g.strokeStyle = COL.axis;
    g.beginPath(); g.moveTo(p.x0, p.y0 + p.h + 0.5); g.lineTo(p.x0 + p.w, p.y0 + p.h + 0.5); g.stroke();

    g.fillStyle = COL.fill;
    g.beginPath(); g.moveTo(p.x0, p.y0 + p.h);
    for (const [x, y] of pts) g.lineTo(x, y);
    g.lineTo(p.x0 + p.w, p.y0 + p.h); g.closePath(); g.fill();

    g.strokeStyle = COL.curve; g.lineWidth = 1.5;
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.stroke();

    g.strokeStyle = COL.marker; g.lineWidth = 1;
    for (const s of [1, 2]) {
      const x = Math.round(p.x0 + s * p.third) + 0.5;
      g.beginPath(); g.moveTo(x, p.y0 - 4); g.lineTo(x, p.y0 + p.h + 4); g.stroke();
    }
    g.fillStyle = COL.text; g.font = '10px ui-monospace, Menlo, monospace';
    SECTIONS.forEach((s, i) => g.fillText(s, p.x0 + i * p.third + 4, EDITOR_H - 6));

    for (const dot of ['A', 'S', 'R'] as Dot[]) {
      const d = this.dotPos(dot);
      g.strokeStyle = COL.dot; g.lineWidth = 1.5; g.fillStyle = '#111114';
      g.beginPath(); g.arc(d.x, d.y, 4.5, 0, Math.PI * 2); g.fill(); g.stroke();
    }
    drawHits(g, this.curve, this.hits, p.x0, p.y0, p.third, p.h, 1);
  }

  private drawMini(): void {
    const g = this.mini.getContext('2d');
    if (!g) return;
    g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    g.clearRect(0, 0, MINI_W, MINI_H);
    const third = MINI_W / 3, top = 2, hh = MINI_H - 4;
    g.strokeStyle = COL.curve; g.lineWidth = 1;
    g.beginPath();
    curvePoints(this.miniCurve, 0, top, third, hh).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.stroke();
    drawHits(g, this.miniCurve, this.hits, 0, top, third, hh, 1);
  }
}

function sec(t: number): string { return t < 1 ? `${Math.round(t * 1000)} ms` : `${t.toFixed(1)} s`; }

function label(e: Env): string {
  return `attack ${sec(e.attack)} · sustain ${Math.round(e.sustain * 100)}% over ${sec(e.decay)} · release ${sec(e.release)}`;
}

/** Curve samples → canvas points, each section across its own third. */
function curvePoints(c: EnvCurve, x0: number, y0: number, third: number, hh: number): [number, number][] {
  const pts: [number, number][] = [[x0, y0 + hh]];
  SECTIONS.forEach((s, si) => {
    const arr = c[s];
    for (let i = 0; i < arr.length; i++) pts.push([x0 + (si + (i + 1) / arr.length) * third, y0 + (1 - arr[i]) * hh]);
  });
  return pts;
}

/**
 * Trigger lines: a hit of age t sits where the curve is t seconds after its start, on the same square-root
 * time axis (through attack, then sustain), as a thin line from the baseline up to the curve, fading with age.
 */
function drawHits(
  g: CanvasRenderingContext2D, c: EnvCurve, hits: readonly number[],
  x0: number, y0: number, third: number, hh: number, width: number,
): void {
  const now = performance.now();
  g.lineWidth = width;
  for (const born of hits) {
    const age = (now - born) / 1000;
    const alpha = HIT_ALPHA * Math.exp(-age / HIT_FADE_S);
    if (alpha < MIN_ALPHA) continue;
    const inAttack = age < SPANS.attack;
    const section: Section = inAttack ? 'attack' : 'sustain';
    const t = inAttack ? age : age - SPANS.attack;
    const span = inAttack ? SPANS.attack : SPANS.sustain;
    if (t > span) continue;
    const pos = toPos(t, span);
    const arr = c[section];
    const level = arr[Math.min(arr.length - 1, Math.max(0, Math.round(pos * arr.length) - 1))];
    const x = Math.round(x0 + (SECTIONS.indexOf(section) + pos) * third) + 0.5;
    g.strokeStyle = `rgba(${COL.hit}, ${alpha})`;
    g.beginPath(); g.moveTo(x, y0 + hh); g.lineTo(x, y0 + (1 - level) * hh); g.stroke();
  }
}
