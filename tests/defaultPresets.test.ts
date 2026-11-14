import { describe, expect, test } from 'vitest';
import json from '../public/presets/default.json';
import { migratePresets } from '../src/shared/state';

describe('public/presets/default.json', () => {
  test('loads 6 named presets that differ from each other', () => {
    const presets = migratePresets(json).filter((p) => p !== null);
    expect(presets.map((p) => p.name)).toEqual(['Calm', 'Pulse', 'Thorns', 'Moiré', 'Kaleido', 'Peak']);
    const keys = new Set(presets.map((p) => JSON.stringify(p.look)));
    expect(keys.size).toBe(6);
  });
});
