// Control window (B10): a remote for the Display. Holds no state of its own — every control shows the
// last `state` message, except a slider that is under the pointer.
import './control.css';
import { PARAMS, GROUPS, fromNorm, toNorm, type Band, type Group, type ParamDef } from '../shared/params';
import {
  BANDS, HOLD_BEATS, MORPH_BEATS, HUE_JUMP_EVERY, MELT_MODES, ORDERS, PRESET_CYCLE_MIN, PRESET_SLOTS,
  REACT_RANGE, THR_RANGE, HUE_JUMP_AMT_RANGE, SESSION_RANGES, CALIB_RANGES,
  defaultSession, defaultCalib, defaultOptions, serialisePresets, parseJson,
  type Session, type Calib, type LookOptions, type MeltMode, type HoldBeats, type MorphBeats, type HueJumpEvery, type Order,
} from '../shared/state';
import { bandValue, createBroadcastTransport, type ControlMsg, type StateMsg, type MetersMsg } from '../shared/protocol';
import { keyAction, isTyping } from '../shared/keys';
import { h, button, lin, row, fmt, Slider, Seg, Meter, type Mapping } from './ui';

const OFFLINE_AFTER_MS = 1000;
const HELLO_EVERY_MS = 1000;
const CLICK_DELAY_MS = 250; // single click (queue) waits this long so a double-click (goto) can cancel it
const LEVEL_FLOOR_DB = -60;

// ---------- transport ----------

const transport = createBroadcastTransport();
const send = (msg: ControlMsg): void => transport.send(msg);

/** Slider input: latest message per key, flushed once per animation frame. */
const pending = new Map<string, ControlMsg>();
const queueSend = (key: string, msg: ControlMsg): void => { pending.set(key, msg); };
function flushPending(): void {
  if (pending.size === 0) return;
  for (const msg of pending.values()) send(msg);
  pending.clear();
}

let last: StateMsg | null = null;
let meters: MetersMsg | null = null;
let metersDirty = false;
let lastMetersAt = -Infinity;

const setSession = (key: keyof Session, value: Session[keyof Session]): void => send({ t: 'setSession', key, value });
const toggleSession = (key: 'autoAdvance' | 'frozen' | 'fallback' | 'blackout' | 'meltHold'): void => {
  if (last) setSession(key, !last.state.session[key]);
};
const cmd = (name: Extract<ControlMsg, { t: 'cmd' }>['name'], arg?: unknown): void =>
  send(arg === undefined ? { t: 'cmd', name } : { t: 'cmd', name, arg });

// ---------- DOM skeleton ----------

const app = document.getElementById('app') ?? document.body;
document.body.classList.add('nostate');
const top = h('header', 'topbar', undefined, app);
const cols = h('main', 'cols', undefined, app);
const left = h('section', 'col left', undefined, cols);
const centre = h('section', 'col centre', undefined, cols);
const right = h('section', 'col right', undefined, cols);

/** A numeric slider bound to a value range, with a readout. */
interface NumCtl { slider: Slider; out: HTMLSpanElement | null; map: Mapping; set(v: number): void; }
function numSlider(
  parent: HTMLElement, label: string, map: Mapping, key: string,
  toMsg: (v: number) => ControlMsg, resetValue: number, opts: { readout?: boolean; cls?: string; unit?: string } = {},
): NumCtl {
  const r = row(label, parent, opts.cls ?? '');
  const unit = opts.unit ?? '';
  let out: HTMLSpanElement | null = null;
  const slider = new Slider({
    onInput: (u) => {
      const v = map.fromU(u);
      if (out) out.textContent = fmt(v) + unit;
      queueSend(key, toMsg(v));
    },
    onReset: () => queueSend(key, toMsg(resetValue)),
  });
  r.appendChild(slider.el);
  if (opts.readout !== false) out = h('span', 'num', '', r);
  return {
    slider, out, map,
    set(v) {
      slider.set(map.toU(v));
      if (out && !slider.dragging) out.textContent = fmt(v) + unit;
    },
  };
}

function toggleBtn(label: string, onClick: () => void, parent: HTMLElement, cls = ''): HTMLButtonElement {
  return button(label, () => onClick(), parent, `toggle ${cls}`.trim());
}

// ---------- top bar ----------

const status = h('span', 'status', 'DISPLAY OFFLINE', top);
const errorEl = h('span', 'err', '', top);
const fpsEl = h('span', 'stat', 'fps —', top);
const levelBox = h('span', 'mgroup', undefined, top);
h('span', 'mlbl', 'in', levelBox);
const levelMeter = new Meter('level', levelBox);
const clipLed = h('span', 'led clip', undefined, levelBox);
clipLed.title = 'clip';
const bandMeters: Record<'low' | 'mid' | 'high' | 'energy', Meter> = {} as never;
for (const b of ['low', 'mid', 'high', 'energy'] as const) {
  const g = h('span', 'mgroup', undefined, top);
  h('span', 'mlbl', b === 'energy' ? 'nrg' : b, g);
  bandMeters[b] = new Meter('', g);
}
const beatLed = h('span', 'led beat', undefined, top);
const bpmEl = h('span', 'stat', '— bpm', top);
h('span', 'spacer', undefined, top);
const freezeBtn = toggleBtn('Freeze', () => toggleSession('frozen'), top);
const fallbackBtn = toggleBtn('Fallback', () => toggleSession('fallback'), top);
const blackoutBtn = toggleBtn('Blackout', () => toggleSession('blackout'), top, 'danger');

// ---------- left: shapes ----------

h('h2', '', 'Shapes', left);
const thumbGrid = h('div', 'thumbs', undefined, left);
let thumbs: HTMLDivElement[] = [];
let clickTimer = 0;

function buildThumbs(count: number): void {
  thumbGrid.replaceChildren();
  thumbs = [];
  for (let i = 0; i < count; i++) {
    const t = h('div', 'thumb', undefined, thumbGrid);
    const img = h('img', '', undefined, t);
    img.src = `${import.meta.env.BASE_URL}sdf/thumbs/${String(i + 1).padStart(2, '0')}.png`;
    img.alt = String(i + 1);
    img.draggable = false;
    h('span', 'tnum', String(i + 1), t);
    t.addEventListener('click', () => {
      window.clearTimeout(clickTimer);
      clickTimer = window.setTimeout(() => cmd('queue', i), CLICK_DELAY_MS);
    });
    t.addEventListener('dblclick', () => {
      window.clearTimeout(clickTimer);
      cmd('goto', i);
    });
    thumbs.push(t);
  }
}

const navRow = h('div', 'btnrow', undefined, left);
button('Prev', () => cmd('prev'), navRow);
button('Next', () => cmd('next'), navRow);
button('Random', () => cmd('random'), navRow);

const morphRow = row('morph', left);
const morphBar = new Meter('morph', morphRow);
const holdEl = h('span', 'num wide', '—', morphRow);

const autoRow = row('advance', left);
const autoBtn = toggleBtn('auto', () => toggleSession('autoAdvance'), autoRow);
const orderSeg = new Seg<Order>(ORDERS, ['random', 'seq'], (v) => setSession('order', v), autoRow);

const holdSeg = new Seg<HoldBeats>(HOLD_BEATS, HOLD_BEATS.map(String), (v) => send({ t: 'setOption', key: 'holdBeats', value: v }), row('hold beats', left));
const morphSeg = new Seg<MorphBeats>(MORPH_BEATS, MORPH_BEATS.map(String), (v) => send({ t: 'setOption', key: 'morphBeats', value: v }), row('morph beats', left));
const meltSeg = new Seg<MeltMode>(MELT_MODES, ['blend', 'fuse', 'spatial'], (v) => send({ t: 'setOption', key: 'meltMode', value: v }), row('melt', left));

const mirrorRow = row('mirror', left);
const mirrorXBtn = toggleBtn('X', () => { if (last) send({ t: 'setOption', key: 'mirrorX', value: !last.state.look.options.mirrorX }); }, mirrorRow);
const mirrorYBtn = toggleBtn('Y', () => { if (last) send({ t: 'setOption', key: 'mirrorY', value: !last.state.look.options.mirrorY }); }, mirrorRow);

const hueEverySeg = new Seg<HueJumpEvery>(HUE_JUMP_EVERY, HUE_JUMP_EVERY.map((v) => (v === 0 ? 'off' : String(v))),
  (v) => send({ t: 'setOption', key: 'hueJumpEvery', value: v }), row('hue jump', left));
const hueAmt = numSlider(left, 'jump amt', lin(...HUE_JUMP_AMT_RANGE), 'o:hueJumpAmt',
  (v) => ({ t: 'setOption', key: 'hueJumpAmt', value: v }), defaultOptions().hueJumpAmt);

const meltHoldRow = row('melt hold', left);
const meltHoldBtn = toggleBtn('hold', () => toggleSession('meltHold'), meltHoldRow);
const holdPos = numSlider(left, '', lin(...SESSION_RANGES.holdPos), 's:holdPos',
  (v) => ({ t: 'setSession', key: 'holdPos', value: v }), defaultSession().holdPos, { cls: 'scrub', readout: false });

// ---------- centre: param groups ----------

interface ParamRow { def: ParamDef; base: Slider; react: Slider; thr: Slider; band: HTMLSelectElement; lock: HTMLInputElement; }
const reactMap = lin(...REACT_RANGE);
const thrMap = lin(...THR_RANGE);
const paramRows: ParamRow[] = [];
const rowBands: Band[] = PARAMS.map((p) => p.band);

function paramRow(def: ParamDef, parent: HTMLElement): ParamRow {
  const r = h('div', 'prow', undefined, parent);
  h('span', 'lbl', def.id, r);
  const id = def.id;
  const k = (f: string): string => `p:${id}:${f}`;
  const base = new Slider({
    tick: true,
    onInput: (u) => queueSend(k('base'), { t: 'setParam', id, field: 'base', value: fromNorm(def, u) }),
    onReset: () => queueSend(k('base'), { t: 'setParam', id, field: 'base', value: def.def }),
  });
  const react = new Slider({
    detent: reactMap.toU(0),
    onInput: (u) => queueSend(k('react'), { t: 'setParam', id, field: 'react', value: reactMap.fromU(u) }),
    onReset: () => queueSend(k('react'), { t: 'setParam', id, field: 'react', value: def.react }),
  });
  const band = h('select', 'band');
  for (const b of BANDS) { const o = h('option', '', b, band); o.value = b; }
  band.addEventListener('change', () => {
    send({ t: 'setParam', id, field: 'band', value: band.value as Band });
    band.blur();
  });
  const thr = new Slider({
    bar: true,
    onInput: (u) => queueSend(k('thr'), { t: 'setParam', id, field: 'thr', value: thrMap.fromU(u) }),
    onReset: () => queueSend(k('thr'), { t: 'setParam', id, field: 'thr', value: def.thr }),
  });
  const lock = h('input', 'lock');
  lock.type = 'checkbox';
  lock.title = 'lock';
  lock.addEventListener('change', () => {
    send({ t: 'setParam', id, field: 'lock', value: lock.checked });
    lock.blur();
  });
  r.append(base.el, react.el, band, thr.el, lock);
  return { def, base, react, thr, band, lock };
}

for (const g of GROUPS) {
  const panel = h('div', 'panel', undefined, centre);
  const head = h('div', 'phead', undefined, panel);
  h('h2', '', g, head);
  h('span', 'spacer', undefined, head);
  button('Randomize', () => cmd('randomize', g), head);
  button('Mutate', () => cmd('mutate', g), head);
  button('Reset', () => cmd('reset', g), head);
  const cols = h('div', 'prow pcols', undefined, panel);
  for (const c of ['', 'base', 'react', 'band', 'thr', 'lk']) h('span', '', c, cols);
  for (const def of PARAMS) if (def.group === (g as Group)) paramRows[PARAMS.indexOf(def)] = paramRow(def, panel);
}

// ---------- right: performance ----------

h('h2', '', 'Presets', right);
const presetGrid = h('div', 'presets', undefined, right);
const presetBtns: HTMLButtonElement[] = [];
for (let i = 0; i < PRESET_SLOTS; i++) {
  const b = button('', (e) => {
    if (e.shiftKey) cmd('savePreset', i);
    else if (last?.state.presets[i]) cmd('loadPreset', i);
  }, presetGrid, 'preset');
  b.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (last?.state.presets[i]) openPresetMenu(i, e.clientX, e.clientY);
  });
  presetBtns.push(b);
}
const presetRow = h('div', 'btnrow', undefined, right);
button('Save', () => cmd('savePreset'), presetRow);
h('span', 'hint', 'shift-click = overwrite · right-click = rename', presetRow);

// rename / delete popover (inline, never a blocking dialog)
const menu = h('div', 'menu', undefined, document.body);
const menuName = h('input', '', undefined, menu);
menuName.type = 'text';
menuName.maxLength = 40;
const menuBtns = h('div', 'btnrow', undefined, menu);
let menuSlot = -1;
const closeMenu = (): void => { menu.classList.remove('open'); menuSlot = -1; menuName.blur(); };
const doRename = (): void => {
  if (menuSlot >= 0) cmd('renamePreset', { slot: menuSlot, name: menuName.value.trim() || 'preset' });
  closeMenu();
};
button('Rename', doRename, menuBtns);
button('Delete', () => { if (menuSlot >= 0) cmd('deletePreset', menuSlot); closeMenu(); }, menuBtns, 'danger');
button('Cancel', closeMenu, menuBtns);
menuName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doRename();
  else if (e.key === 'Escape') closeMenu();
});
window.addEventListener('pointerdown', (e) => {
  if (menuSlot >= 0 && !menu.contains(e.target as Node)) closeMenu();
});
function openPresetMenu(slot: number, x: number, y: number): void {
  menuSlot = slot;
  menuName.value = last?.state.presets[slot]?.name ?? '';
  menu.style.left = `${Math.min(x, window.innerWidth - 240)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 90)}px`;
  menu.classList.add('open');
  menuName.focus();
  menuName.select();
}

const lookRow = h('div', 'btnrow', undefined, right);
button('Randomize all', () => cmd('randomize'), lookRow);
button('Mutate all', () => cmd('mutate'), lookRow);
button('Undo', () => cmd('undo'), lookRow);
button('Reset all', () => cmd('reset'), lookRow, 'danger');

h('h2', '', 'Performance', right);
const ds = defaultSession();
const sessSliders = {
  autopilot: numSlider(right, 'autopilot', lin(...SESSION_RANGES.autopilot), 's:autopilot', (v) => ({ t: 'setSession', key: 'autopilot', value: v }), ds.autopilot),
  reactMaster: numSlider(right, 'reactMaster', lin(...SESSION_RANGES.reactMaster), 's:reactMaster', (v) => ({ t: 'setSession', key: 'reactMaster', value: v }), ds.reactMaster),
  xfade: numSlider(right, 'xfade', lin(...SESSION_RANGES.xfade), 's:xfade', (v) => ({ t: 'setSession', key: 'xfade', value: v }), ds.xfade, { unit: 's' }),
};
const cycleRow = row('cycle', right);
const cycleSel = h('select', '', undefined, cycleRow);
for (const m of PRESET_CYCLE_MIN) { const o = h('option', '', m === 0 ? 'off' : `${m} min`, cycleSel); o.value = String(m); }
cycleSel.addEventListener('change', () => { setSession('presetCycleMin', Number(cycleSel.value)); cycleSel.blur(); });

const fileRow = h('div', 'btnrow', undefined, right);
button('Export', exportPresets, fileRow);
const fileInput = h('input', 'hidden');
fileInput.type = 'file';
fileInput.accept = 'application/json,.json';
button('Import', () => fileInput.click(), fileRow);
const fileMsg = h('span', 'hint', '', fileRow);
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  fileInput.value = '';
  if (!f) return;
  void f.text().then((text) => {
    const parsed = parseJson(text);
    if (parsed === undefined) { fileMsg.textContent = 'import: not JSON'; return; }
    cmd('importPresets', parsed);
    fileMsg.textContent = `imported ${f.name}`;
  });
});

function exportPresets(): void {
  if (!last) { fileMsg.textContent = 'no state yet'; return; }
  const d = new Date();
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const name = `ferro-presets-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.json`;
  const url = URL.createObjectURL(new Blob([serialisePresets(last.state.presets)], { type: 'application/json' }));
  const a = h('a');
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  fileMsg.textContent = name;
}

// calibration
const calib = h('details', 'calib', undefined, right);
h('summary', '', 'Calibration', calib);
const devRow = row('input', calib);
const devSel = h('select', 'dev', undefined, devRow);
let devKey = '';
devSel.addEventListener('change', () => { send({ t: 'setCalib', key: 'deviceId', value: devSel.value || null }); devSel.blur(); });
const dc = defaultCalib();
type CalibNum = keyof typeof CALIB_RANGES;
const calibUnits: Record<CalibNum, string> = { inputGain: '×', onsetK: '', smooth: '', floorDb: ' dB', gainDecay: ' s', refractoryMs: ' ms' };
const calibSliders = {} as Record<CalibNum, NumCtl>;
for (const key of Object.keys(CALIB_RANGES) as CalibNum[]) {
  calibSliders[key] = numSlider(calib, key, lin(CALIB_RANGES[key][0], CALIB_RANGES[key][1]), `c:${key}`,
    (v) => ({ t: 'setCalib', key, value: v }), dc[key], { unit: calibUnits[key] });
}
const rawRow = row('raw dB', calib, 'rawrow');
const rawEls = ['low', 'mid', 'high', 'all'].map((b) => {
  const s = h('span', 'raw', '', rawRow);
  h('span', 'mlbl', b, s);
  return h('span', 'num', '—', s);
});

// ---------- state → DOM ----------

function setOn(el: HTMLElement, on: boolean): void { el.classList.toggle('on', on); }

function applyState(msg: StateMsg): void {
  const { look, session, calib: c, presets } = msg.state;
  document.body.classList.remove('nostate');

  for (const r of paramRows) {
    const ps = look.params[r.def.id as keyof typeof look.params];
    const i = PARAMS.indexOf(r.def);
    r.base.set(toNorm(r.def, ps.base));
    r.base.el.title = `${r.def.id} ${fmt(ps.base)}`;
    r.react.set(reactMap.toU(ps.react));
    r.react.el.title = `react ${fmt(ps.react)}`;
    r.thr.set(thrMap.toU(ps.thr));
    r.thr.el.title = `thr ${fmt(ps.thr)}`;
    if (document.activeElement !== r.band) r.band.value = ps.band;
    r.lock.checked = ps.lock;
    rowBands[i] = ps.band;
  }

  const o: LookOptions = look.options;
  holdSeg.set(o.holdBeats);
  morphSeg.set(o.morphBeats);
  meltSeg.set(o.meltMode);
  hueEverySeg.set(o.hueJumpEvery);
  hueAmt.set(o.hueJumpAmt);
  setOn(mirrorXBtn, o.mirrorX);
  setOn(mirrorYBtn, o.mirrorY);

  setOn(freezeBtn, session.frozen);
  setOn(fallbackBtn, session.fallback);
  setOn(blackoutBtn, session.blackout);
  setOn(autoBtn, session.autoAdvance);
  setOn(meltHoldBtn, session.meltHold);
  orderSeg.set(session.order);
  holdPos.set(session.holdPos);
  sessSliders.autopilot.set(session.autopilot);
  sessSliders.reactMaster.set(session.reactMaster);
  sessSliders.xfade.set(session.xfade);
  if (document.activeElement !== cycleSel) cycleSel.value = String(session.presetCycleMin);

  presets.forEach((p, i) => {
    const b = presetBtns[i];
    const text = p ? `${i + 1} ${p.name}` : `${i + 1}`;
    if (b.textContent !== text) b.textContent = text;
    b.classList.toggle('empty', !p);
  });

  applyCalib(c, msg.devices);

  const count = msg.manifest?.count ?? 0;
  if (count !== thumbs.length) buildThumbs(count);
}

function applyCalib(c: Calib, devices: StateMsg['devices']): void {
  const key = devices.map((d) => `${d.deviceId}\u0000${d.label}`).join('\u0001');
  if (key !== devKey) {
    devKey = key;
    devSel.replaceChildren();
    const def = h('option', '', 'default input', devSel);
    def.value = '';
    devices.forEach((d, i) => { const o = h('option', '', d.label || `input ${i + 1}`, devSel); o.value = d.deviceId; });
  }
  if (document.activeElement !== devSel) devSel.value = c.deviceId ?? '';
  for (const k of Object.keys(calibSliders) as CalibNum[]) calibSliders[k].set(c[k]);
}

function applyMeters(m: MetersMsg): void {
  const a = m.audio;
  fpsEl.textContent = `${Math.round(m.fps)} fps`;
  levelMeter.set((a.levelDb - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB);
  setOn(clipLed, a.clip);
  bandMeters.low.set(a.low);
  bandMeters.mid.set(a.mid);
  bandMeters.high.set(a.high);
  bandMeters.energy.set(a.energy);
  beatLed.style.opacity = String(0.15 + 0.85 * Math.min(1, a.beat));
  bpmEl.textContent = a.beatPeriod > 0 && Number.isFinite(a.beatPeriod) ? `${Math.round(60 / a.beatPeriod)} bpm` : '— bpm';
  errorEl.textContent = m.error ?? '';

  for (let i = 0; i < paramRows.length; i++) {
    const r = paramRows[i];
    r.base.setTick(m.values[i] ?? 0);
    r.thr.setBar(thrMap.toU(bandValue(rowBands[i], a)));
  }

  const queued = last?.state.session.queued ?? null;
  for (let i = 0; i < thumbs.length; i++) {
    const cl = thumbs[i].classList;
    cl.toggle('a', i === m.motifA);
    cl.toggle('b', i === m.motifB && m.motifB !== m.motifA);
    cl.toggle('q', i === queued);
  }
  morphBar.set(m.morphT);
  holdEl.textContent = m.holdRemaining > 0 ? `hold ${Math.ceil(m.holdRemaining)}` : m.morphT > 0 ? 'morphing' : '—';

  for (let i = 0; i < 4; i++) rawEls[i].textContent = Number.isFinite(a.rawDb[i]) ? a.rawDb[i].toFixed(0) : '—';
}

// ---------- wiring ----------

transport.onMessage((msg) => {
  if (msg.t === 'state') {
    last = msg;
    applyState(msg);
  } else if (msg.t === 'meters') {
    meters = msg;
    metersDirty = true;
    lastMetersAt = performance.now();
  }
});

let offline = true;
function checkOnline(): void {
  const off = performance.now() - lastMetersAt > OFFLINE_AFTER_MS;
  if (off === offline) return;
  offline = off;
  status.textContent = off ? 'DISPLAY OFFLINE' : 'DISPLAY';
  status.classList.toggle('ok', !off);
  document.body.classList.toggle('offline', off);
}
window.setInterval(checkOnline, 200);
window.setInterval(() => { if (offline) send({ t: 'hello' }); }, HELLO_EVERY_MS);

function frame(): void {
  flushPending();
  if (metersDirty && meters) { metersDirty = false; applyMeters(meters); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.addEventListener('keydown', (e) => {
  if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
  const a = keyAction(e.key, last?.state.session ?? null);
  if (a?.kind !== 'msg') return;
  e.preventDefault();
  (document.activeElement as HTMLElement | null)?.blur?.(); // a focused button must not also get the Space
  send(a.msg);
});

send({ t: 'hello' });
