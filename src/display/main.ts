// Display window (SPEC B11): owns all state, audio, autopilot and rendering.
import { PARAM_INDEX } from '../shared/params';
import { clamp, streamRng } from '../shared/math';
import { dateSeed, getStorage } from '../shared/state';
import { createBroadcastTransport, type DeviceInfo, type Manifest, type Msg } from '../shared/protocol';
import { keyAction, isTyping } from '../shared/keys';
import { Renderer } from './gl';
import { Debug } from './debug';
import { Analyser } from './audio/analyser';
import { idleFrame } from './audio/dsp';
import { listDevices, openInput, parseSource, type AudioInput } from './audio/input';
import { initialModel, patchSession, Persister, recallPreset, reduce, renderLook, tick, withDefaultPresets, type Model } from './store';
import { Sequencer } from './sequencer';
import { Autopilot, PRESET_CYCLE_FADE_S } from './autopilot';
import { createModulation, modulate } from './modulation';

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
  const r = reduce(model, msg, { rng: presetsRng, nowMs: Date.now(), motifCount: manifest?.count ?? 1 });
  model = r.model;
  for (const e of r.effects) {
    if (e.t === 'seq') seq.command(e.cmd);
    else if (e.t === 'sendState') sendState();
    else if (e.t === 'restartInput') void openSource();
  }
}

transport.onMessage((msg: Msg) => {
  if (msg.t === 'state' || msg.t === 'meters') return; // another Display; ignore
  apply(msg);
});

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
  const count = manifest?.count ?? 1;

  model = tick(model, dt);
  const s0 = model.state;
  const so = seq.step(dt, audio, { count, options: s0.look.options, session: s0.session, linger: lastLinger });
  model = patchSession(model, so.sessionPatch);
  const ap = autopilot.step(dt, so.beats, audio, {
    options: model.state.look.options, session: model.state.session,
    presets: model.state.presets, currentPreset: model.currentPreset,
  });
  if (ap.recall !== null) model = recallPreset(model, ap.recall, PRESET_CYCLE_FADE_S);
  const look = renderLook(model);
  const session = model.state.session;
  modulate(mod, look, session, audio, ap.driftT, dt);
  lastLinger = mod.values[PARAM_INDEX.linger];

  const target = session.blackout ? 0 : 1;
  master = clamp(master + Math.sign(target - master) * (dt / BLACKOUT_FADE_S), 0, 1);

  const fb = session.fallback;
  const motifA = fb ? 0 : so.motifA;
  const motifB = fb ? 0 : so.motifB;
  const morphT = fb ? 0 : so.morphT;

  resize();
  if (renderer) {
    renderer.draw({
      params: mod.values, res: [canvas.width, canvas.height],
      motifA, motifB, morphT,
      meltMode: look.options.meltMode, mirrorX: look.options.mirrorX, mirrorY: look.options.mirrorY,
      warpPhase: mod.warpPhase, spikePhase: mod.spikePhase, wavePhase: mod.wavePhase,
      hueOffset: fb ? 0 : ap.hueOffset, master, frame: frameNo++,
    });
  }
  persister.update(model.state, nowMs);

  const error = fatal ?? renderer?.error ?? audioError ?? (renderer ? null : 'WebGL context lost');
  if (model.state !== lastSentState && nowMs - lastStateSendMs >= STATE_SEND_MS) sendState();
  if (nowMs - lastMetersMs >= METERS_SEND_MS) {
    lastMetersMs = nowMs;
    transport.send({
      t: 'meters', audio, values: Array.from(mod.norm), motifA, motifB, morphT,
      holdRemaining: so.holdRemaining, fps, ...(error ? { error } : {}),
    });
  }
  debug.update(dt, {
    audio, fps, phase: so.phase, motifA, motifB, morphT, holdRemaining: so.holdRemaining,
    seed, device: input?.label ?? 'none', error,
  }, (nowMs - startMs) / 1000);
}

// ---------- boot ----------

async function boot(): Promise<void> {
  const b = initialModel(seed, storage);
  model = b.model;
  seq = new Sequencer(seed, model.state.look.options.holdBeats);
  booted = true;
  persister.update(model.state, performance.now());
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
      initRenderer();
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
