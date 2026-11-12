import { describe, expect, test } from 'vitest';
import {
  cloneLook, exportFilename, exportPresets, fadeLook, importPresets, lerpLook, mutate, popUndo, presetName, pushUndo,
  randomize, renamePreset, deletePreset, resetLook, savePreset, startFade, stepFade, UNDO_SIZE,
} from '../src/display/presets';
import { GROUPS, PARAMS, paramDef } from '../src/shared/params';
import { defaultLook, defaultOptions, emptyPresets, migratePresets, type Look } from '../src/shared/state';
import { mulberry32 } from '../src/shared/math';

const NOW = new Date(2026, 10, 19, 21, 5, 9).getTime();

function lookedUp(): Look {
  const l = defaultLook();
  l.params.zoom.base = 1.2;
  l.params.hue = { base: 0.1, react: -0.4, band: 'mid', thr: 0.3, lock: true };
  l.options.meltMode = 2;
  l.options.holdBeats = 64;
  return l;
}

describe('slots', () => {
  test('save writes the first empty slot, named HH:MM:SS', () => {
    const r = savePreset(emptyPresets(), lookedUp(), NOW);
    expect(r.slot).toBe(0);
    expect(r.presets[0]?.name).toBe('21:05:09');
    expect(r.presets[0]?.savedAt).toBe(NOW);
    expect(presetName(NOW)).toMatch(/^\d\d:\d\d:\d\d$/);
    const r2 = savePreset(r.presets, defaultLook(), NOW, 7);
    expect(r2.slot).toBe(7);
    expect(savePreset(r2.presets, defaultLook(), NOW).slot).toBe(1);
  });

  test('a full bank refuses a save without a slot', () => {
    let p = emptyPresets();
    for (let i = 0; i < 16; i++) p = savePreset(p, defaultLook(), NOW).presets;
    expect(savePreset(p, defaultLook(), NOW).slot).toBeNull();
  });

  test('saved Look is a copy', () => {
    const look = lookedUp();
    const r = savePreset(emptyPresets(), look, NOW);
    look.params.zoom.base = 0.6;
    expect(r.presets[0]?.look.params.zoom.base).toBe(1.2);
  });

  test('rename and delete', () => {
    const p = savePreset(emptyPresets(), lookedUp(), NOW).presets;
    expect(renamePreset(p, 0, 'Calm')[0]?.name).toBe('Calm');
    expect(deletePreset(p, 0)[0]).toBeNull();
  });
});

describe('export / import', () => {
  test('save → export → import round-trip is identical', () => {
    let p = emptyPresets();
    p = savePreset(p, lookedUp(), NOW).presets;
    p = savePreset(p, randomize(defaultLook(), mulberry32(1)), NOW + 1000, 5).presets;
    const text = exportPresets(p);
    const back = importPresets(emptyPresets(), JSON.parse(text));
    expect(back[0]).toEqual(p[0]);
    expect(back[1]).toEqual(p[5]); // merged into the first empty slots
    expect(importPresets(emptyPresets(), text)[0]).toEqual(p[0]); // a JSON string works too
    expect(migratePresets(JSON.parse(text))).toEqual(p);
  });

  test('import merges into empty slots only and ignores invalid data', () => {
    const p = savePreset(emptyPresets(), lookedUp(), NOW).presets;
    const incoming = { version: 1, presets: [{ name: 'x', savedAt: 1, look: {} }, 42, null, 'nope'] };
    const out = importPresets(p, incoming);
    expect(out[0]).toEqual(p[0]);
    expect(out[1]?.name).toBe('x');
    expect(out[1]?.look).toEqual(defaultLook()); // a partial Look is completed from the table
    expect(out.filter(Boolean).length).toBe(2);
    expect(importPresets(p, '{not json')).toEqual(p);
    expect(importPresets(p, { presets: 'x' })).toEqual(p);
  });

  test('export filename', () => {
    expect(exportFilename(new Date(2026, 10, 19, 21, 5))).toBe('ferro-presets-20261119-2105.json');
  });
});

function expectInRanges(look: Look, base: Look, opts: { rand: boolean }) {
  for (const def of PARAMS) {
    const p = look.params[def.id];
    expect(p.base).toBeGreaterThanOrEqual(def.min - 1e-9);
    expect(p.base).toBeLessThanOrEqual(def.max + 1e-9);
    expect(p.react).toBeGreaterThanOrEqual(-1);
    expect(p.react).toBeLessThanOrEqual(1);
    expect(p.thr).toBeGreaterThanOrEqual(0);
    expect(p.thr).toBeLessThanOrEqual(0.95);
    if (base.params[def.id].lock) expect(p).toEqual(base.params[def.id]);
    else if (opts.rand && def.rand) {
      expect(p.base).toBeGreaterThanOrEqual(def.rand[0] - 1e-9);
      expect(p.base).toBeLessThanOrEqual(def.rand[1] + 1e-9);
      expect(p.react).toBeGreaterThanOrEqual(0);
      expect(p.react).toBeLessThanOrEqual(0.6);
      expect(p.thr).toBeLessThanOrEqual(0.5);
    }
  }
}

describe('randomize', () => {
  test('never changes locked params and never leaves the rand ranges', () => {
    const rng = mulberry32(3);
    for (let k = 0; k < 300; k++) {
      const base = defaultLook();
      for (const def of PARAMS) base.params[def.id].lock = rng() < 0.3;
      const group = k % 2 ? GROUPS[k % GROUPS.length] : undefined;
      const out = randomize(base, rng, group);
      expectInRanges(out, base, { rand: true });
      if (group) for (const def of PARAMS) if (def.group !== group) expect(out.params[def.id]).toEqual(base.params[def.id]);
      expect(out.params.brightness).toEqual(base.params.brightness);
      expect(out.options.holdBeats).toBe(base.options.holdBeats);
      expect(out.options.morphBeats).toBe(base.options.morphBeats);
      expect(out.options.hueJumpEvery).toBe(base.options.hueJumpEvery);
      for (const def of PARAMS) {
        const b = out.params[def.id].band;
        if (b !== def.band) expect(['low', 'mid', 'high', 'beat', 'energy']).toContain(b);
      }
    }
  });

  test('log params are drawn log-uniformly', () => {
    const rng = mulberry32(8);
    const d = paramDef('waveFreq'); // rand 10…300
    let below = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) if (randomize(defaultLook(), rng, 'inner').params.waveFreq.base < Math.sqrt(10 * 300)) below++;
    expect(below / n).toBeGreaterThan(0.45);
    expect(below / n).toBeLessThan(0.55);
    expect(d.scale).toBe('log');
  });

  test('is deterministic for a seed and does not mutate its input', () => {
    const base = defaultLook();
    const snapshot = cloneLook(base);
    expect(randomize(base, mulberry32(5))).toEqual(randomize(base, mulberry32(5)));
    expect(base).toEqual(snapshot);
  });
});

describe('mutate', () => {
  test('never changes locked params, never leaves min…max, options unchanged', () => {
    const rng = mulberry32(4);
    let look = lookedUp();
    for (const def of PARAMS) look.params[def.id].lock = rng() < 0.3;
    const locked = cloneLook(look);
    for (let k = 0; k < 500; k++) {
      const next = mutate(look, rng);
      expectInRanges(next, locked, { rand: false });
      expect(next.options).toEqual(look.options);
      look = next;
    }
  });

  test('moves unlocked params by small steps', () => {
    const a = defaultLook();
    const b = mutate(a, mulberry32(1));
    const moved = PARAMS.filter((d) => a.params[d.id].base !== b.params[d.id].base).length;
    expect(moved).toBeGreaterThan(20);
  });
});

describe('reset', () => {
  test('back to table defaults, per group or all; lock flags kept', () => {
    const l = lookedUp();
    l.options.mirrorX = true;
    const g = resetLook(l, 'shape');
    expect(g.params.zoom.base).toBe(0.85);
    expect(g.params.hue).toEqual(l.params.hue);
    expect(g.options.mirrorX).toBe(true);
    const all = resetLook(l);
    expect(all.params.hue).toEqual({ ...defaultLook().params.hue, lock: true });
    expect(all.options).toEqual(defaultOptions());
  });
});

describe('crossfade', () => {
  test('endpoints are exact', () => {
    const a = lookedUp();
    const b = randomize(defaultLook(), mulberry32(9));
    expect(lerpLook(a, b, 0)).toBe(a);
    expect(lerpLook(a, b, 1)).toBe(b);
    let f = startFade(a, 3);
    expect(fadeLook(f, b)).toEqual(a);
    for (let i = 0; i < 3 * 60 + 1; i++) f = stepFade(f, 1 / 60);
    expect(f).toBeNull();
    expect(fadeLook(f, b)).toBe(b);
    expect(startFade(a, 0)).toBeNull();
  });

  test('base/react/thr interpolate in normalised space; band, lock and options switch at the start', () => {
    const a = defaultLook();
    const b = cloneLook(a);
    b.params.warpScale.base = 8; // log 0.5…8: norm 0.5 → 1
    b.params.zoom = { base: 1.4, react: 1, band: 'beat', thr: 0.9, lock: true };
    b.options.meltMode = 0;
    const m = lerpLook(a, b, 0.5);
    expect(m.params.warpScale.base).toBeCloseTo(0.5 * Math.pow(16, 0.75), 9);
    expect(m.params.zoom.react).toBeCloseTo((0.06 + 1) / 2, 9);
    expect(m.params.zoom.thr).toBeCloseTo((0.15 + 0.9) / 2, 9);
    const early = lerpLook(a, b, 0.01);
    expect(early.params.zoom.band).toBe('beat');
    expect(early.params.zoom.lock).toBe(true);
    expect(early.options.meltMode).toBe(0);
  });

  test('hue interpolates the short way', () => {
    const a = defaultLook();
    const b = defaultLook();
    a.params.hue.base = 0.9;
    b.params.hue.base = 0.1;
    const mid = lerpLook(a, b, 0.5).params.hue.base;
    expect(Math.min(mid, 1 - mid)).toBeCloseTo(0, 9);
    const q = lerpLook(a, b, 0.25).params.hue.base;
    expect(q).toBeCloseTo(0.95, 9);
    const back = lerpLook(b, a, 0.25).params.hue.base;
    expect(back).toBeCloseTo(0.05, 9);
  });
});

describe('undo', () => {
  test('restores the previous Look; ring holds 30', () => {
    const a = lookedUp();
    let ring = pushUndo([], a);
    const { ring: r2, look } = popUndo(ring);
    expect(look).toBe(a);
    expect(r2).toEqual([]);
    for (let i = 0; i < 40; i++) ring = pushUndo(ring, defaultLook());
    expect(ring.length).toBe(UNDO_SIZE);
    expect(popUndo([]).look).toBeNull();
  });
});
