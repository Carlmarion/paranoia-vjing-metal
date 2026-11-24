// Display window (SPEC B11): owns all state, audio, autopilot and rendering.
import { PARAM_INDEX } from '../shared/params';
import { clamp, streamRng } from '../shared/math';
import { ENV_GROUPS, dateSeed, getStorage } from '../shared/state';
import { DISPLAY_MSG_TYPES, MAX_LAYERS, createBroadcastTransport, type DeviceInfo, type Manifest, type MetersMsg, type Msg } from '../shared/protocol';
import { inkRadius } from '../shared/sdf';
import { drawStrokes } from '../shared/raster';
import type { Stroke } from '../shared/strokes';
import { keyAction, isTyping } from '../shared/keys';
import { Renderer } from './gl';
import { Debug } from './debug';
import { Analyser } from './audio/analyser';
import { idleFrame } from './audio/dsp';
import { listDevices, openInput, parseSource, type AudioInput } from './audio/input';
import {
  initialModel, patchSession, Persister, recallPreset, reduce, renderLook, tick, withDefaultPresets, type Model, type ShapeLookup,
} from './store';
import { Library, storedDisabled } from './library';
import { WorkerBaker } from './baker';
import { openShapeDB } from './shapedb';
import { Sequencer } from './sequencer';
import { Autopilot, PRESET_CYCLE_FADE_S } from './autopilot';
import { createModulation, modulate, type Geom } from './modulation';

const STATE_SEND_MS = 100; // ≤ 10×/s
const METERS_SEND_MS = 50; // 20×/s
const CURSOR_HIDE_MS = 2000;
const BLACKOUT_FADE_S = 1;

const q = new URLSearchParams(location.search);
const seedParam = Number(q.get('seed'));
const seed = q.has('seed') && Number.isFinite(seedParam) ? Math.trunc(seedParam) : dateSeed(new Date());
const scaleParam = Number(q.get('scale') ?? 1);
const renderScale = clamp(Number.isFinite(scaleParam) && scaleParam > 0 ? scaleParam : 1, 0.25, 2);
const source = parseSource(location.search);

const canvas = document.getElementById('c') as HTMLCanvasElement;
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: false });
const debug = new Debug();
const hint = document.createElement('div');
hint.textContent = 'click to start audio';
hint.style.cssText = 'position:fixed;right:12px;bottom:10px;color:#555;font:12px ui-monospace,Menlo,monospace;pointer-events:none';
document.body.append(hint);

const transport = createBroadcastTransport();
const storage = getStorage();
const persister = new Persister(storage);
const presetsRng = streamRng(seed, 'presets');

let model!: Model; // assigned in boot()
let booted = false;
let manifest: Manifest | null = null;
let atlas: ArrayBuffer | null = null;
let renderer: Renderer | null = null;
let library: Library | null = null; // created once the manifest is known (B12.3)
/** Until the library is up (IndexedDB can be slow or blocked), the baked shapes still work on their own. */
const bakedOnly: ShapeLookup = {
  isShape: (l) => Number.isInteger(l) && l >= 0 && l < (manifest?.count ?? 0),
  drawnLayer: () => null,
};
/** Design §4.2: ink radius per texture layer, kept current on every upload. */
const radius = new Float32Array(MAX_LAYERS);
function measureAtlas(buf: ArrayBuffer, m: Manifest): void {
  const n = m.cell * m.cell;
  for (let l = 0; l < m.count && l < MAX_LAYERS; l++) radius[l] = inkRadius(new Uint16Array(buf, l * n * 2, n), m.cell);
}
function uploadLayer(layer: number, half: Uint16Array): void {
  if (manifest && layer >= 0 && layer < MAX_LAYERS) radius[layer] = inkRadius(half, manifest.cell);
  renderer?.uploadLayer(layer, half);
}
/** The hits counted since the last meters message; resets the counters. */
function takeHits(): MetersMsg['envHits'] {
  const out = { ...mod.envHits };
  for (const g of ENV_GROUPS) mod.envHits[g] = 0;
  return out;
}
function geomOf(motifA: number, motifB: number, morphT: number): Geom {
  const morphing = morphT > 0 && morphT < 1;
  const short = Math.min(canvas.width, canvas.height);
  return {
    radius: morphing ? Math.max(radius[motifA] ?? 0, radius[motifB] ?? 0) : radius[motifA] ?? 0,
    ax: canvas.width / short, ay: canvas.height / short, morphing,
  };
}
/** Before the library is up: the baked shapes, minus the ones unchecked in storage. */
const bakedPool = (): number[] => {
  const off = storedDisabled(storage);
  return Array.from({ length: manifest?.count ?? 0 }, (_, i) => i).filter((i) => !off.has(`baked:${i}`));
};
let fatal: string | null = null;
let audioError: string | null = null;

let actx: AudioContext | null = null;
let analyser: Analyser | null = null;
let input: AudioInput | null = null;
let devices: DeviceInfo[] = [];

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const assetUrl = (p: string): string => `${import.meta.env.BASE_URL}${p}`;

async function fetchJson(path: string): Promise<unknown> {
  const res = await fetch(assetUrl(path));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

// ---------- audio ----------

async function openSource(): Promise<void> {
  if (!actx || !analyser) return;
  input?.stop();
  input = null;
  analyser.detach();
  analyser.reset();
  try {
    input = await openInput(actx, source, model.state.calib.deviceId);
    analyser.attach(input.node);
    audioError = null;
  } catch (e) {
    audioError = `audio: ${errMsg(e)}`;
  }
  devices = await listDevices();
  sendState();
}

function setupAudio(): void {
  try {
    actx = new AudioContext();
    analyser = new Analyser(actx);
    actx.onstatechange = () => { hint.style.display = actx?.state === 'running' ? 'none' : 'block'; };
    hint.style.display = actx.state === 'running' ? 'none' : 'block';
    void openSource();
  } catch (e) {
    audioError = `audio: ${errMsg(e)}`;
  }
}

/** Resume the AudioContext on a gesture. Returns true if this gesture was consumed for that. */
function resumeAudio(): boolean {
  if (actx && actx.state !== 'running') {
    void actx.resume();
    return true;
  }
  return false;
}

// ---------- messages ----------

let lastSentState: unknown = null;
let lastStateSendMs = -Infinity;

function sendState(): void {
  if (!booted) return;
  transport.send({ t: 'state', state: model.state, manifest, devices });
  lastSentState = model.state;
  lastStateSendMs = performance.now();
}

function apply(msg: unknown): void {
  if (!booted) return;
  const r = reduce(model, msg, { rng: presetsRng, nowMs: Date.now(), shapes: library ?? bakedOnly });
  model = r.model;
  for (const e of r.effects) {
    if (e.t === 'seq') seq.command(e.cmd);
    else if (e.t === 'seqForget') seq.forget(e.layer);
    else if (e.t === 'library') library?.handle(e.msg);
    else if (e.t === 'sendState') { sendState(); if (library) transport.send(library.meta()); }
    else if (e.t === 'restartInput') void openSource();
  }
}

transport.onMessage((msg: Msg) => {
  if (DISPLAY_MSG_TYPES.has(msg.t)) return; // another Display's traffic; ignore
  apply(msg);
});

// ---------- shape library (B12) ----------

const THUMB_PX = 160;
const thumbCanvas = document.createElement('canvas');
thumbCanvas.width = thumbCanvas.height = THUMB_PX;

/** White ink on transparent, like the bake's thumbs. */
function renderThumb(strokes: Stroke[]): string | null {
  const ctx = thumbCanvas.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, THUMB_PX, THUMB_PX);
  drawStrokes(ctx, strokes, THUMB_PX);
  return thumbCanvas.toDataURL('image/png');
}

async function startLibrary(m: Manifest): Promise<void> {
  library = new Library({
    cell: m.cell,
    bakedCount: m.count,
    bakedNames: m.motifs.map((x) => x.file.replace(/\.png$/i, '')),
    db: await openShapeDB(),
    bake: { library: new WorkerBaker(m.cell), live: new WorkerBaker(m.cell) },
    upload: uploadLayer,
    thumb: renderThumb,
    storage,
    send: (msg) => transport.send(msg),
    emit: (msg) => apply(msg),
    newId: () => crypto.randomUUID(),
    now: () => Date.now(),
  });
  await library.boot();
}

// ---------- input: keys, cursor, wake lock ----------

addEventListener('keydown', (e) => {
  if (isTyping(e.target)) return;
  if (resumeAudio()) { e.preventDefault(); return; } // the starting keypress does only that
  const act = keyAction(e.key, booted ? model.state.session : null);
  if (!act) return;
  e.preventDefault();
  if (act.kind === 'msg') apply(act.msg);
  else if (act.name === 'debug') debug.toggle();
  else if (act.name === 'fullscreen') void document.documentElement.requestFullscreen?.().catch(() => undefined);
});
addEventListener('pointerdown', () => { resumeAudio(); });

let cursorTimer = 0;
addEventListener('mousemove', () => {
  document.body.style.cursor = '';
  clearTimeout(cursorTimer);
  cursorTimer = window.setTimeout(() => { document.body.style.cursor = 'none'; }, CURSOR_HIDE_MS);
});

let wakeLock: WakeLockSentinel | null = null;
async function requestWakeLock(): Promise<void> {
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch { wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (!wakeLock || wakeLock.released)) void requestWakeLock();
});

// ---------- GL lifecycle ----------

function initRenderer(): void {
  if (!gl || !atlas || !manifest) return;
  renderer = new Renderer(gl);
  try {
    renderer.init(atlas, manifest);
    library?.reuploadAll(); // after a context restore, drawn shapes are uploaded again
  } catch (e) {
    fatal = `gl: ${errMsg(e)}`;
  }
}
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); renderer = null; });
canvas.addEventListener('webglcontextrestored', () => { initRenderer(); });

function resize(): void {
  const k = Math.min(devicePixelRatio || 1, 1) * renderScale;
  const w = Math.max(1, Math.floor(canvas.clientWidth * k));
  const h = Math.max(1, Math.floor(canvas.clientHeight * k));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

// ---------- frame loop ----------

let seq!: Sequencer; // created in boot() from the restored Look
const autopilot = new Autopilot(seed);
const mod = createModulation();
let lastLinger = 0.5;
let master = 1;
let frameNo = 0;
let lastMs = performance.now();
const startMs = lastMs;
let fps = 60;
let lastMetersMs = -Infinity;

function frame(nowMs: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(Math.max((nowMs - lastMs) / 1000, 0), 0.1);
  lastMs = nowMs;
  if (dt > 0) fps += (1 / dt - fps) * 0.05;

  const running = actx?.state === 'running';
  const audio = running && analyser ? analyser.read(dt, model.state.calib) : idleFrame();

  model = tick(model, dt);
  const s0 = model.state;
  const shapes = library ?? bakedOnly;
  const so = seq.step(dt, audio, {
    pool: library?.pool() ?? bakedPool(), exists: (l) => shapes.isShape(l), options: s0.look.options, session: s0.session, linger: lastLinger,
  });
  model = patchSession(model, so.sessionPatch);
  library?.frame(so);
  const ap = autopilot.step(dt, so.beats, audio, {
    options: model.state.look.options, session: model.state.session,
    presets: model.state.presets, currentPreset: model.currentPreset,
  });
  if (ap.recall !== null) model = recallPreset(model, ap.recall, PRESET_CYCLE_FADE_S);
  const look = renderLook(model);
  const session = model.state.session;
  const fb = session.fallback;
  const motifA = fb ? 0 : so.motifA;
  const motifB = fb ? 0 : so.motifB;
  const morphT = fb ? 0 : so.morphT;

  resize();
  modulate(mod, look, session, audio, ap.driftT, dt, geomOf(motifA, motifB, morphT));
  lastLinger = mod.values[PARAM_INDEX.linger];

  const target = session.blackout ? 0 : 1;
  master = clamp(master + Math.sign(target - master) * (dt / BLACKOUT_FADE_S), 0, 1);

  if (renderer) {
    renderer.draw({
      params: mod.values, res: [canvas.width, canvas.height],
      motifA, motifB, morphT,
      meltMode: look.options.meltMode, mirrorX: look.options.mirrorX, mirrorY: look.options.mirrorY,
      warpPhase: mod.warpPhase, spikePhase: mod.spikePhase, wavePhase: mod.wavePhase, spinPhase: mod.spinPhase, tilt: mod.tilt,
      hueOffset: fb ? 0 : ap.hueOffset, master, frame: frameNo++,
    });
  }
  persister.update(model.state, nowMs, model.ambientStash);

  const error = fatal ?? renderer?.error ?? audioError ?? (renderer ? null : 'WebGL context lost');
  if (model.state !== lastSentState && nowMs - lastStateSendMs >= STATE_SEND_MS) sendState();
  if (nowMs - lastMetersMs >= METERS_SEND_MS) {
    lastMetersMs = nowMs;
    transport.send({
      t: 'meters', audio, values: Array.from(mod.norm), motifA, motifB, morphT,
      holdRemaining: so.holdRemaining, fps, zones: mod.zones, envHits: takeHits(), hueOffset: fb ? 0 : ap.hueOffset, ...(error ? { error } : {}),
    });
  }
  debug.update(dt, {
    audio, fps, phase: so.phase, motifA, motifB, morphT, holdRemaining: so.holdRemaining,
    seed, device: input?.label ?? 'none', error, live: model.state.session.live,
  }, (nowMs - startMs) / 1000);
}

// ---------- boot ----------

async function boot(): Promise<void> {
  const b = initialModel(seed, storage);
  model = b.model;
  seq = new Sequencer(seed, model.state.look.options.holdBeats);
  booted = true;
  persister.update(model.state, performance.now(), model.ambientStash);
  if (b.needDefaultPresets) {
    try { model = withDefaultPresets(model, await fetchJson('presets/default.json')); } catch (e) { console.warn(e); }
  }
  if (!gl) {
    fatal = 'WebGL2 is not available';
  } else {
    try {
      manifest = (await fetchJson('sdf/manifest.json')) as Manifest;
      const res = await fetch(assetUrl('sdf/atlas.bin'));
      if (!res.ok) throw new Error(`sdf/atlas.bin: HTTP ${res.status}`);
      atlas = await res.arrayBuffer();
      measureAtlas(atlas, manifest);
      initRenderer();
      void startLibrary(manifest).catch((e: unknown) => { console.error('library', e); });
    } catch (e) {
      fatal = `assets: ${errMsg(e)}`;
    }
  }
  if (fatal) { console.error(fatal); if (!debug.visible) debug.toggle(); }
  if (renderer?.error) console.error(renderer.error);
  setupAudio();
  void requestWakeLock();
  sendState();
  requestAnimationFrame(frame);
}

void boot();
