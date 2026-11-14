import { describe, expect, test } from 'vitest';
import {
  Persister, initialModel, patchSession, recallPreset, reduce, renderLook, tick, withDefaultPresets, type Env, type Model,
} from '../src/display/store';
import { savePreset } from '../src/display/presets';
import {
  STORAGE_KEYS, defaultCalib, defaultLook, defaultSession, fallbackLook, serialiseCalib, serialiseLook, serialisePresets,
  type StorageLike,
} from '../src/shared/state';
import { mulberry32 } from '../src/shared/math';

const NOW = new Date(2026, 10, 19, 22, 0, 0).getTime();
const env = (): Env => ({ rng: mulberry32(1), nowMs: NOW, motifCount: 12 });

class MemStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
}
const throwing: StorageLike = {
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceeded'); },
};

const fresh = (): Model => initialModel(20261119, null).model;
const apply = (m: Model, ...msgs: unknown[]): Model => msgs.reduce<Model>((acc, msg) => reduce(acc, msg, env()).model, m);

describe('boot and storage', () => {
  test('no storage → defaults and a request for default presets', () => {
    const b = initialModel(7, null);
    expect(b.model.state.look).toEqual(defaultLook());
    expect(b.model.state.session).toEqual(defaultSession());
    expect(b.model.state.calib).toEqual(defaultCalib());
    expect(b.model.state.seed).toBe(7);
    expect(b.model.state.presets).toHaveLength(16);
    expect(b.needDefaultPresets).toBe(true);
  });

  test('a corrupt localStorage value falls back to defaults', () => {
    const s = new MemStorage();
    s.setItem(STORAGE_KEYS.look, '{"params": oops');
    s.setItem(STORAGE_KEYS.calib, 'null');
    s.setItem(STORAGE_KEYS.presets, '"hello"');
    const b = initialModel(1, s);
    expect(b.model.state.look).toEqual(defaultLook());
    expect(b.model.state.calib).toEqual(defaultCalib());
    expect(b.needDefaultPresets).toBe(true);
  });

  test('wrong-typed fields inside a stored value fall back per field', () => {
    const s = new MemStorage();
    s.setItem(STORAGE_KEYS.calib, JSON.stringify({ onsetK: 'x', floorDb: -200, refractoryMs: 200 }));
    s.setItem(STORAGE_KEYS.look, JSON.stringify({ params: { zoom: { base: 99, band: 'bass' } }, options: { holdBeats: 7 } }));
    const st = initialModel(1, s).model.state;
    expect(st.calib).toEqual({ ...defaultCalib(), floorDb: -90, refractoryMs: 200 });
    expect(st.look.params.zoom).toEqual({ ...defaultLook().params.zoom, base: 1.4 });
    expect(st.look.options.holdBeats).toBe(32);
  });

  test('storage that throws is treated as unavailable', () => {
    const b = initialModel(1, throwing);
    expect(b.model.state.look).toEqual(defaultLook());
    const p = new Persister(throwing);
    expect(() => { p.update(b.model.state, 0); p.update(apply(b.model, { t: 'setCalib', key: 'onsetK', value: 2 }).state, 5000); }).not.toThrow();
  });

  test('valid stored values are restored', () => {
    const s = new MemStorage();
    const look = defaultLook();
    look.params.glow.base = 0.42;
    const presets = savePreset(new Array(16).fill(null), look, NOW).presets;
    s.setItem(STORAGE_KEYS.look, serialiseLook(look));
    s.setItem(STORAGE_KEYS.calib, serialiseCalib({ ...defaultCalib(), deviceId: 'abc', inputGain: 2 }));
    s.setItem(STORAGE_KEYS.presets, serialisePresets(presets));
    const b = initialModel(1, s);
    expect(b.model.state.look).toEqual(look);
    expect(b.model.state.calib.deviceId).toBe('abc');
    expect(b.model.state.presets).toEqual(presets);
    expect(b.needDefaultPresets).toBe(false);
  });

  test('withDefaultPresets installs default.json', () => {
    const m = withDefaultPresets(fresh(), { version: 1, presets: [{ name: 'Calm', savedAt: 0, look: { params: { glow: { base: 0.3 } } } }] });
    expect(m.state.presets[0]?.name).toBe('Calm');
    expect(m.state.presets[0]?.look.params.glow.base).toBe(0.3);
    expect(m.state.presets[0]?.look.params.zoom).toEqual(defaultLook().params.zoom);
  });

  test('Persister writes presets and calib on change, the Look at most once per second', () => {
    const s = new MemStorage();
    const p = new Persister(s);
    let m = fresh();
    p.update(m.state, 0);
    expect(s.data.size).toBe(0);
    m = apply(m, { t: 'setCalib', key: 'onsetK', value: 2 });
    p.update(m.state, 10);
    expect(JSON.parse(s.getItem(STORAGE_KEYS.calib)!).onsetK).toBe(2);
    m = apply(m, { t: 'setParam', id: 'glow', field: 'base', value: 0.5 });
    p.update(m.state, 1500);
    expect(JSON.parse(s.getItem(STORAGE_KEYS.look)!).params.glow.base).toBe(0.5);
    m = apply(m, { t: 'setParam', id: 'glow', field: 'base', value: 0.6 });
    p.update(m.state, 1600);
    expect(JSON.parse(s.getItem(STORAGE_KEYS.look)!).params.glow.base).toBe(0.5);
    p.update(m.state, 2600);
    expect(JSON.parse(s.getItem(STORAGE_KEYS.look)!).params.glow.base).toBe(0.6);
    m = apply(m, { t: 'cmd', name: 'savePreset' });
    p.update(m.state, 2700);
    expect(JSON.parse(s.getItem(STORAGE_KEYS.presets)!).presets[0].look.params.glow.base).toBe(0.6);
  });
});

describe('messages', () => {
  test('hello asks for a state broadcast and changes nothing', () => {
    const m = fresh();
    const r = reduce(m, { t: 'hello' }, env());
    expect(r.model).toBe(m);
    expect(r.effects).toEqual([{ t: 'sendState' }]);
  });

  test('unknown or malformed messages are ignored', () => {
    const m = fresh();
    for (const msg of [
      null, 42, 'next', {}, { t: 'nope' }, { t: 'state' }, { t: 'meters' },
      { t: 'setParam', id: 'nope', field: 'base', value: 1 }, { t: 'setParam', id: 'zoom', field: 'colour', value: 1 },
      { t: 'setParam', id: 'zoom', field: 'base', value: 'big' }, { t: 'setParam', id: 'zoom', field: 'band', value: 'bass' },
      { t: 'setParam', id: 'zoom', field: 'lock', value: 1 },
      { t: 'setOption', key: 'meltMode', value: 3 }, { t: 'setOption', key: 'nope', value: 1 },
      { t: 'setOption', key: 'holdBeats', value: 33 }, { t: 'setSession', key: 'nope', value: 1 },
      { t: 'setSession', key: 'presetCycleMin', value: 3 }, { t: 'setSession', key: 'queued', value: 12 },
      { t: 'setSession', key: 'order', value: 'shuffle' }, { t: 'setCalib', key: 'nope', value: 1 },
      { t: 'setCalib', key: 'onsetK', value: NaN }, { t: 'setCalib', key: 'deviceId', value: 5 },
      { t: 'cmd', name: 'explode' }, { t: 'cmd', name: 'goto', arg: 99 }, { t: 'cmd', name: 'loadPreset', arg: 3 },
      { t: 'cmd', name: 'deletePreset', arg: 3 }, { t: 'cmd', name: 'renamePreset', arg: { slot: 3, name: 'x' } },
      { t: 'cmd', name: 'undo' }, { t: 'cmd', name: 'loadPreset', arg: 99 },
    ]) {
      const r = reduce(m, msg, env());
      expect(r.model, JSON.stringify(msg)).toBe(m);
      expect(r.effects).toEqual([]);
    }
  });

  test('setParam: every field, clamped to its range', () => {
    const m = apply(fresh(),
      { t: 'setParam', id: 'zoom', field: 'base', value: 9 },
      { t: 'setParam', id: 'zoom', field: 'react', value: -3 },
      { t: 'setParam', id: 'zoom', field: 'thr', value: 2 },
      { t: 'setParam', id: 'zoom', field: 'band', value: 'beat' },
      { t: 'setParam', id: 'zoom', field: 'lock', value: true });
    expect(m.state.look.params.zoom).toEqual({ base: 1.4, react: -1, thr: 0.95, band: 'beat', lock: true });
    expect(m.state.look.params.rotation).toEqual(defaultLook().params.rotation);
  });

  test('setOption: every key', () => {
    const m = apply(fresh(),
      { t: 'setOption', key: 'meltMode', value: 2 }, { t: 'setOption', key: 'mirrorX', value: true },
      { t: 'setOption', key: 'mirrorY', value: true }, { t: 'setOption', key: 'hueJumpEvery', value: 8 },
      { t: 'setOption', key: 'hueJumpAmt', value: 0.9 }, { t: 'setOption', key: 'holdBeats', value: 128 },
      { t: 'setOption', key: 'morphBeats', value: 4 });
    expect(m.state.look.options).toEqual({ meltMode: 2, mirrorX: true, mirrorY: true, hueJumpEvery: 8, hueJumpAmt: 0.5, holdBeats: 128, morphBeats: 4 });
  });

  test('setSession: every key', () => {
    const m = apply(fresh(),
      { t: 'setSession', key: 'autopilot', value: 3 }, { t: 'setSession', key: 'reactMaster', value: 1.5 },
      { t: 'setSession', key: 'xfade', value: 20 }, { t: 'setSession', key: 'autoAdvance', value: false },
      { t: 'setSession', key: 'order', value: 'sequential' }, { t: 'setSession', key: 'presetCycleMin', value: 5 },
      { t: 'setSession', key: 'frozen', value: true }, { t: 'setSession', key: 'fallback', value: true },
      { t: 'setSession', key: 'blackout', value: true }, { t: 'setSession', key: 'meltHold', value: true },
      { t: 'setSession', key: 'holdPos', value: -1 }, { t: 'setSession', key: 'queued', value: 4 });
    expect(m.state.session).toEqual({
      autopilot: 1, reactMaster: 1.5, xfade: 8, autoAdvance: false, order: 'sequential', presetCycleMin: 5,
      frozen: true, fallback: true, blackout: true, meltHold: true, holdPos: 0, queued: 4,
    });
    expect(apply(m, { t: 'setSession', key: 'queued', value: null }).state.session.queued).toBeNull();
  });

  test('setCalib: every key, clamped; a device change restarts the input', () => {
    const m = apply(fresh(),
      { t: 'setCalib', key: 'inputGain', value: 9 }, { t: 'setCalib', key: 'onsetK', value: 0.1 },
      { t: 'setCalib', key: 'smooth', value: 2 }, { t: 'setCalib', key: 'floorDb', value: -45 },
      { t: 'setCalib', key: 'gainDecay', value: 100 }, { t: 'setCalib', key: 'refractoryMs', value: 100 });
    expect(m.state.calib).toEqual({ deviceId: null, inputGain: 4, onsetK: 0.5, smooth: 2, floorDb: -45, gainDecay: 60, refractoryMs: 150 });
    const r = reduce(m, { t: 'setCalib', key: 'deviceId', value: 'focusrite' }, env());
    expect(r.model.state.calib.deviceId).toBe('focusrite');
    expect(r.effects).toEqual([{ t: 'restartInput' }]);
    expect(reduce(r.model, { t: 'setCalib', key: 'deviceId', value: 'focusrite' }, env()).effects).toEqual([]);
  });

  test('sequencer commands are returned as effects; queue sets session.queued', () => {
    const m = fresh();
    for (const name of ['next', 'prev', 'random'] as const) {
      const r = reduce(m, { t: 'cmd', name }, env());
      expect(r.model).toBe(m);
      expect(r.effects).toEqual([{ t: 'seq', cmd: { name } }]);
    }
    expect(reduce(m, { t: 'cmd', name: 'goto', arg: 3 }, env()).effects).toEqual([{ t: 'seq', cmd: { name: 'goto', index: 3 } }]);
    const q = reduce(m, { t: 'cmd', name: 'queue', arg: 6 }, env());
    expect(q.model.state.session.queued).toBe(6);
    expect(q.effects).toEqual([]);
  });

  test('randomize / mutate / reset crossfade over xfade and push undo; undo restores over 1 s', () => {
    const m0 = apply(fresh(), { t: 'setSession', key: 'xfade', value: 2 });
    const look0 = m0.state.look;
    const m1 = apply(m0, { t: 'cmd', name: 'randomize' });
    expect(m1.state.look).not.toEqual(look0);
    expect(m1.fade?.dur).toBe(2);
    expect(m1.undo.at(-1)).toBe(look0);
    expect(renderLook(m1)).toEqual(look0); // the fade starts from what was on screen
    const m2 = apply(m1, { t: 'cmd', name: 'mutate', arg: 'colour' });
    expect(m2.undo).toHaveLength(2);
    for (const k of ['zoom', 'tiltX'] as const) expect(m2.state.look.params[k]).toEqual(m1.state.look.params[k]);
    const m3 = apply(m2, { t: 'cmd', name: 'reset', arg: 'shape' });
    expect(m3.state.look.params.zoom).toEqual(defaultLook().params.zoom);
    const u = apply(m3, { t: 'cmd', name: 'undo' });
    expect(u.state.look).toBe(m2.state.look);
    expect(u.fade?.dur).toBe(1);
    expect(u.undo).toHaveLength(2);
  });

  test('presets: save, load (crossfade), rename, delete, import', () => {
    let m = apply(fresh(), { t: 'setParam', id: 'glow', field: 'base', value: 0.7 }, { t: 'cmd', name: 'savePreset' });
    expect(m.state.presets[0]?.name).toBe('22:00:00');
    expect(m.state.presets[0]?.look.params.glow.base).toBe(0.7);
    m = apply(m, { t: 'cmd', name: 'savePreset', arg: 4 }, { t: 'setParam', id: 'glow', field: 'base', value: 0.1 });
    expect(m.state.presets[4]).not.toBeNull();
    const loaded = apply(m, { t: 'cmd', name: 'loadPreset', arg: 0 });
    expect(loaded.state.look.params.glow.base).toBe(0.7);
    expect(loaded.currentPreset).toBe(0);
    expect(loaded.fade?.dur).toBe(3);
    expect(renderLook(loaded).params.glow.base).toBeCloseTo(0.1, 9);
    let f = loaded;
    for (let i = 0; i < 90; i++) f = tick(f, 1 / 60);
    expect(renderLook(f).params.glow.base).toBeCloseTo(0.4, 6); // halfway
    for (let i = 0; i < 91; i++) f = tick(f, 1 / 60);
    expect(f.fade).toBeNull();
    expect(renderLook(f)).toBe(f.state.look);
    m = apply(m, { t: 'cmd', name: 'renamePreset', arg: { slot: 4, name: 'Peak' } });
    expect(m.state.presets[4]?.name).toBe('Peak');
    m = apply(m, { t: 'cmd', name: 'deletePreset', arg: 4 });
    expect(m.state.presets[4]).toBeNull();
    m = apply(m, { t: 'cmd', name: 'importPresets', arg: { version: 1, presets: [{ name: 'In', savedAt: 1, look: {} }] } });
    expect(m.state.presets[1]?.name).toBe('In');
  });

  test('a setParam during a fade goes to the target and shows up', () => {
    let m = apply(fresh(), { t: 'cmd', name: 'randomize' });
    for (let i = 0; i < 60; i++) m = tick(m, 1 / 60);
    m = apply(m, { t: 'setParam', id: 'sat', field: 'base', value: 0.2 });
    for (let i = 0; i < 200; i++) m = tick(m, 1 / 60);
    expect(renderLook(m).params.sat.base).toBe(0.2);
  });
});

describe('display-side writes', () => {
  test('patchSession applies sequencer patches; null keeps the Model', () => {
    const m = fresh();
    expect(patchSession(m, null)).toBe(m);
    expect(patchSession(m, { queued: null, holdPos: 0.3 }).state.session.holdPos).toBe(0.3);
  });

  test('recallPreset uses the given duration (preset cycle: 8 s)', () => {
    const m = apply(fresh(), { t: 'cmd', name: 'savePreset' });
    const r = recallPreset(m, 0, 8);
    expect(r.fade?.dur).toBe(8);
    expect(recallPreset(m, 5, 8)).toBe(m);
  });

  test('fallback renders the safe Look without touching the live one', () => {
    const m = apply(fresh(), { t: 'cmd', name: 'randomize' }, { t: 'setSession', key: 'fallback', value: true });
    expect(renderLook(m)).toEqual(fallbackLook());
    expect(renderLook(m).params.zoom.react).toBe(0.06);
    expect(renderLook(m).params.glow.react).toBe(0);
    expect(m.state.look).not.toEqual(fallbackLook());
  });
});
