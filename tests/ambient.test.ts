import { describe, expect, test } from 'vitest';
import { AMBIENT_BANDS, AMBIENT_ENV, ambientLook, ambientRestore, migrateAmbientStash } from '../src/display/ambient';
import { cloneLook, mutate, randomize, resetLook } from '../src/display/presets';
import { PARAMS } from '../src/shared/params';
import { ENV_GROUPS, defaultLook } from '../src/shared/state';
import { mulberry32 } from '../src/shared/math';

const CALMED = ['zoom', 'thickness', 'spikeAmp', 'brightness', 'glow', 'grain'];

describe('ambientLook (design §6.1)', () => {
  test('on the default Look it zeroes exactly the low, beat and high reactions and sets the envelopes', () => {
    const l = defaultLook();
    const { look, stash } = ambientLook(l);
    for (const def of PARAMS) {
      if (CALMED.includes(def.id)) expect(look.params[def.id].react).toBe(0);
      else expect(look.params[def.id]).toEqual(l.params[def.id]);
    }
    expect(look.params.warpAmt.react).toBe(l.params.warpAmt.react);
    expect(look.params.waveAmt.react).toBe(l.params.waveAmt.react);
    expect(look.params.waveSpeed.react).toBe(l.params.waveSpeed.react);
    for (const g of ENV_GROUPS) expect(look.env[g]).toEqual(AMBIENT_ENV);
    expect(Object.keys(stash.react).sort()).toEqual([...CALMED].sort());
    expect(stash.react.zoom).toEqual({ react: l.params.zoom.react, band: 'low' });
    for (const g of ENV_GROUPS) expect(stash.env[g]).toEqual(l.env[g]);
    expect(l).toEqual(defaultLook()); // input untouched
  });

  test('restore gives the original back', () => {
    const l = defaultLook();
    l.env.line = { attack: 0.2, sustain: 0.7, decay: 3, release: 6 };
    const { look, stash } = ambientLook(l);
    expect(ambientRestore(look, stash)).toEqual(l);
  });

  test('restore keeps hand edits: an edited react, a changed band, an edited envelope', () => {
    const l = defaultLook();
    const { look, stash } = ambientLook(l);
    const edited = cloneLook(look);
    edited.params.zoom.react = 0.2;
    edited.params.thickness.band = 'mid';
    edited.env.colour = { attack: 1, sustain: 1, decay: 1, release: 1 };
    const back = ambientRestore(edited, stash);
    expect(back.params.zoom.react).toBe(0.2);
    expect(back.params.thickness).toEqual(edited.params.thickness);
    expect(back.env.colour).toEqual(edited.env.colour);
    expect(back.params.glow.react).toBe(l.params.glow.react);
    expect(back.env.shape).toEqual(l.env.shape);
  });

  test('merge: a group reset while calm keeps what other groups are owed', () => {
    const l = defaultLook();
    const first = ambientLook(l);
    const reset = resetLook(first.look, 'colour');
    const second = ambientLook(reset, first.stash);
    expect(second.stash.react.zoom).toEqual(first.stash.react.zoom);
    expect(second.stash.react.thickness).toEqual(first.stash.react.thickness);
    expect(second.stash.env.shape).toEqual(first.stash.env.shape);
    expect(second.stash.env.line).toEqual(first.stash.env.line);
    expect(second.look.params.glow.react).toBe(0);
    expect(ambientRestore(second.look, second.stash).params.zoom.react).toBe(l.params.zoom.react);
  });

  test('merge drops the entry of a param that arrives on a mid band', () => {
    const first = ambientLook(defaultLook());
    const moved = cloneLook(first.look);
    moved.params.zoom.band = 'mid';
    expect(ambientLook(moved, first.stash).stash.react.zoom).toBeUndefined();
  });
});

describe('migrateAmbientStash', () => {
  test('rejects anything that is not a stash', () => {
    for (const v of [undefined, null, 'x', 3, { react: 3 }, { react: {}, env: 3 }]) expect(migrateAmbientStash(v)).toBeNull();
  });

  test('round-trips a real stash through JSON, dropping bad entries', () => {
    const { stash } = ambientLook(defaultLook());
    expect(migrateAmbientStash(JSON.parse(JSON.stringify(stash)))).toEqual(stash);
    const dirty = JSON.parse(JSON.stringify(stash));
    dirty.react.nope = { react: 1, band: 'low' };
    dirty.react.zoom.band = 'bass';
    dirty.env.inner = { attack: 1 };
    const clean = migrateAmbientStash(dirty);
    expect(clean?.react.zoom).toBeUndefined();
    expect(Object.keys(clean?.react ?? {})).not.toContain('nope');
    expect(Object.keys(clean?.env ?? {})).not.toContain('inner');
  });
});

describe('randomize and mutate while ambient (design §6.3)', () => {
  test('randomize leaves no reaction on low, beat or high', () => {
    for (let seed = 0; seed < 100; seed++) {
      const out = randomize(ambientLook(defaultLook()).look, mulberry32(seed), undefined, true);
      for (const def of PARAMS) if (AMBIENT_BANDS.has(out.params[def.id].band)) expect(out.params[def.id].react).toBe(0);
    }
  });

  test('mutate keeps a calmed reaction at 0 and still moves a re-added one', () => {
    const l = ambientLook(defaultLook()).look;
    l.params.glow.react = 0.3;
    const m = mutate(l, mulberry32(4), undefined, true);
    expect(m.params.zoom.react).toBe(0);
    expect(m.params.glow.react).not.toBe(0.3);
  });
});
