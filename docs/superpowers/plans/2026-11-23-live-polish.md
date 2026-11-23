# Live Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add zoom limits with a sound "stop", a per-group reaction envelope, an Ambient mode, and a colour strip to the ferro VJ app.

**Architecture:** All new maths lives in small pure modules (`reach.ts`, `envelope.ts`, `colour.ts`, additions to `sdf.ts` and `presets.ts`) with vitest tests written first. `modulation.ts` gains two stages (envelope after the gate, stop after all values). The store stays a pure reducer; the Display owns all state and the Control only sends messages and draws what `state` and `meters` report.

**Tech Stack:** TypeScript, Vite, WebGL2, vitest, eslint (with the local `eslint-plugin-gandalf`). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-23-live-polish-design.md` (called "the design" below; `§` numbers refer to it). The product spec is `SPEC.md`; each piece amends it.

## Global Constraints

- Every formula, range and constant comes from the design; copy values verbatim (`GLOW_CUTOFF = 0.08`, `AMBIENT_FADE_S = 5`, `AMBIENT_ENV = { attack: 0.3, sustain: 0.5, decay: 2, release: 4 }`, zoom row `log 0.5…3`, react `0.034`, driftAmp `0.023`, `reactScale 0.5`).
- Existing Looks and presets must render as before: neutral envelope returns its input exactly; a v1 Look keeps the same zoom push at its base.
- No shader change (`src/display/shader.frag` is untouched).
- Pure modules have no DOM access; time constants always use `dt`.
- Before every commit: `npm run check` and `npm run lint` pass, then run the `/gandalf` skill and fix what it flags (project rule). If `/gandalf` recommends a new ESLint rule, write it before going on.
- Each piece lands its own `SPEC.md` amendment in the same commit series, never before the code.
- Commit messages end with the `Co-Authored-By` line the session provides. Work on branch `feat/drawing-tool`.
- Run tests with `npx vitest run tests/<file>`; the whole suite with `npm run check`.

## Review Focus

1. **Window with zero or tiny size** (minimised, mid-resize): reach must return finite numbers and zones `[1, 1]`, never `NaN` (Task 2).
2. **Empty shape** (blank live layer, radius 0) and **glow 0** (`ln(0)`): fill is 0 or finite, limit is the range max (Task 2).
3. **A long frame** (`dt` of 1 s or more after the tab was hidden) and `dt = 0`: envelope output and charge stay in 0…1, no overshoot (Task 5).
4. **Importing or recalling an old (v1, no `env`) preset while Ambient is lit:** it is migrated, calmed, and Off still restores it (Task 9).
5. **Colour handles dragged onto each other or exactly opposite:** params stay in range and the handle does not flip sides between two drags (Task 10).

---

## File map

| File | Change |
|---|---|
| `src/shared/params.ts` | zoom row, `reactScale` |
| `src/shared/state.ts` | `Look.v`, `Look.env`, `Env`, `EnvGroup`, `Session.zoomStop`, `Session.ambient`, migrations, `STORAGE_KEYS.ambient` |
| `src/shared/sdf.ts` | `inkRadius` |
| `src/shared/math.ts` | `hsv2rgb` |
| `src/shared/colour.ts` (new) | handle ↔ param maths, live span |
| `src/shared/protocol.ts` | `setEnv`, `ambient` cmd, `MetersMsg` additions |
| `src/shared/keys.ts` | key `A` |
| `src/display/reach.ts` (new) | fill, limit, stop |
| `src/display/envelope.ts` (new) | envelope step, test curve |
| `src/display/modulation.ts` | envelope stage, stop stage, rest values, zones, env meters |
| `src/display/presets.ts` | env in clone/lerp/reset, `reactScale`, ambient transform, tagged undo |
| `src/display/store.ts` | `setEnv`, `zoomStop`, ambient command and rules, stash persistence |
| `src/display/main.ts` | radius per layer, geometry to `modulate`, meters fields |
| `src/control/ui.ts` | `Slider.setZones` |
| `src/control/envelope.ts` (new) | envelope editor widget |
| `src/control/huestrip.ts` (new) | colour strip widget |
| `src/control/main.ts`, `control.css` | wiring, toggles, top-bar `AMBIENT` |
| `SPEC.md`, `README.md` | amendments |

---

## Piece 1 — Zoom limits (design §4)

### Task 1: Zoom range, Look version, react migration

**Files:** Modify `src/shared/params.ts`, `src/shared/state.ts`, `src/display/presets.ts`. Test `tests/presets.test.ts`, `tests/defaultPresets.test.ts`, new `tests/state.test.ts`.

**Interfaces — Produces:**
- `ParamDef.reactScale?: number`; zoom row `row('zoom', 'shape', 'log', 0.5, 3, 0.85, 'low', 0.034, 0.15, 0.023, 120, [0.7, 1.0])` with `reactScale: 0.5`.
- `Look.v: 2`; `LOOK_VERSION = 2`; `migrateZoomReact(reactOld: number, base: number): number` (design §4.1 formula).

- [ ] **Step 1: Failing tests** in `tests/state.test.ts`:

```ts
test('v1 Look keeps the same zoom push at its base', () => {
  for (const [base, react] of [[0.85, 0.06], [0.7, 0.5], [1.2, -0.3], [0.5, 0]] as const) {
    const look = migrateLook({ params: { zoom: { base, react, band: 'low', thr: 0, lock: false } } });
    const z = paramDef('zoom');
    const pushed = fromNorm(z, clamp01(toNorm(z, base) + look.params.zoom.react));
    const old = clamp(base + react * 0.9, 0.5, 1.4);
    expect(pushed).toBeCloseTo(Math.max(old, 0.5), 2);
    expect(look.v).toBe(2);
  }
});
test('a v2 Look is not converted again', () => {
  const once = migrateLook({ params: { zoom: { base: 0.85, react: 0.06, band: 'low', thr: 0, lock: false } } });
  expect(migrateLook(JSON.parse(serialiseLook(once))).params.zoom.react).toBe(once.params.zoom.react);
});
```
  In `tests/presets.test.ts`: randomize over 200 seeds never gives zoom `react > 0.3`; mutate's zoom react step has about half the spread of another param's.

- [ ] **Step 2:** Run `npx vitest run tests/state.test.ts tests/presets.test.ts` — expect FAIL.
- [ ] **Step 3:** Implement. `row()` takes an optional trailing options object for `reactScale`. `migrateLook` applies `migrateZoomReact` when `v` is missing or `< 2`, and always returns `v: 2`. `defaultLook`, `cloneLook`, `lerpLook`, `randomize`, `mutate`, `resetLook` carry `v`. Randomize uses `RANDOM_REACT_MAX × (def.reactScale ?? 1)`; mutate uses `MUTATE_SD.react × (def.reactScale ?? 1)`.
- [ ] **Step 4:** `npm run check` — fix any existing test that hard-codes the old zoom range (e.g. in `tests/modulation.test.ts`, `tests/defaultPresets.test.ts`) by computing from `paramDef('zoom')`.
- [ ] **Step 5:** `/gandalf`, then commit `Zoom: log range 0.5–3, Look v2 react migration`.

### Task 2: `inkRadius` and `reach.ts`

**Files:** Modify `src/shared/sdf.ts`. Create `src/display/reach.ts`. Test `tests/sdf.test.ts`, new `tests/reach.test.ts`.

**Interfaces — Produces:**
```ts
// sdf.ts
export function inkRadius(half: Uint16Array, cell: number): number;   // motif units; 0 for a blank layer
// reach.ts
export const GLOW_CUTOFF = 0.08;
export interface ReachIn {
  zoom: number; mirrorShift: number; mirrorX: boolean; mirrorY: boolean; tiltX: number; tiltY: number;
  thickness: number; spikeAmp: number; warpAmt: number; glow: number; glowWidth: number; brightness: number;
  meltBulge: number;            // meltK / 4 during a fuse melt, else 0
  radius: number; ax: number; ay: number;
}
export function fill(i: ReachIn): { ink: number; glow: number };
/** Value of `param` in [min, max] where fill[kind] reaches 1 (bisection, 24 steps); max if never, min if always. */
export function limit(i: ReachIn, param: 'zoom' | 'mirrorShift', kind: 'ink' | 'glow', min: number, max: number): number;
/** Design §4.4. */
export function stop(hand: number, full: number, lim: number): number;
```

- [ ] **Step 1: Failing tests.**
  - `sdf`: bake a disc mask of radius 0.5 with `bakeMask` → `inkRadius` within 0.01 of 0.5; `inkRadius(blankHalf(64), 64) === 0`.
  - `reach` with `base = { zoom: 1, mirrorShift: 0, mirrorX: false, mirrorY: false, tiltX: 0, tiltY: 0, thickness: 0, spikeAmp: 0, warpAmt: 0, glow: 0, glowWidth: 0.12, brightness: 1, meltBulge: 0, radius: 0.8, ax: 16 / 9, ay: 1 }`:
    - `fill(base).ink` is `0.8`; with `zoom: 1.25` it is `1`.
    - `mirrorShift: 0.3` changes nothing without a mirror; with `mirrorY: true`, ink is `1.1`.
    - `tiltY: 0.2` raises ink above `0.8`.
    - `glow: 0.5` gives `glow > ink`; `glow: 0` gives `glow === ink`.
    - `limit(base, 'zoom', 'ink', 0.5, 3)` is `1.25` within 1e-3; with `ax: 1, ay: 1` it is the same; with `ay: 2` (tall window) it is higher, never lower.
    - `stop(0.9, 1.2, 1.0) === 1.0`; `stop(1.1, 1.2, 1.0) === 1.1`; `stop(0.9, 0.7, 1.0) === 0.7`.
    - **Review Focus 1, 2:** `radius: 0` → `fill` is `{ ink: 0, glow: 0 }`-finite and `limit` is `3`; `ax: NaN` or `ax: 0, ay: 0` → every result is finite and `limit` is `3`.
- [ ] **Step 2:** Run both test files — expect FAIL.
- [ ] **Step 3:** Implement per design §4.2 and §4.3. A float16 texel is ink when its sign bit is set or it is zero. Guard non-finite or non-positive `ax`, `ay` by treating fill as 0.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** `/gandalf`, commit `Reach: ink radius, window fill, limits, stop`.

### Task 3: The stop and the zones in the Display

**Files:** Modify `src/display/modulation.ts`, `src/shared/state.ts`, `src/shared/protocol.ts`, `src/display/store.ts`, `src/display/main.ts`. Test `tests/modulation.test.ts`, `tests/store.test.ts`.

**Interfaces:**
- Consumes: Task 2's `fill`, `limit`, `stop`, `inkRadius`.
- Produces:
```ts
// modulation.ts
export interface Geom { radius: number; ax: number; ay: number; morphing: boolean; }
export function modulate(m, look, session, frame, driftT, dt, geom?: Geom): void;   // no geom → no stop, zones [1, 1]
// Modulation gains
rest: Float32Array;                                   // values with base + drift only
zones: { zoom: [number, number]; mirrorShift: [number, number] };   // normalised [orange, red]
// state.ts
Session.zoomStop: boolean;                            // default true; accepted by setSession
// protocol.ts MetersMsg
zones: { zoom: [number, number]; mirrorShift: [number, number] };
```

- [ ] **Step 1: Failing tests** (`tests/modulation.test.ts`), with `geom = { radius: 0.8, ax: 1, ay: 1, morphing: false }` and a Look with thickness, spikes, warp, glow react at 0:
  - zoom base 1.0, react +1 on `low`, `low: 1`: value is `1.25` within 1e-3 with the stop on, and the unstopped value with `zoomStop: false`.
  - zoom base 1.5 (hand past red), same sound: value is exactly `1.5`.
  - react −1: value below base, unchanged by the stop.
  - `mirrorY: true`, mirrorShift base 0, react +1: stops where ink fill is 1 with zoom at its hand value.
  - `zones.zoom[1]` equals `toNorm(zoom, 1.25)` within 1e-3 and does not change when `low` goes 0 → 1.
  - no mirror → `zones.mirrorShift` is `[1, 1]`.
  - `session.fallback: true` → no stop.
  - `tests/store.test.ts`: `setSession zoomStop false` is applied; a non-boolean is ignored.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement the order of design §4.4 (mirrorShift first with zoom at hand, then zoom) and the zones of §4.5 (other params from `rest`). `meltBulge = look.options.meltMode === 1 && geom.morphing ? meltK / 4 : 0`.
- [ ] **Step 4:** In `main.ts`: keep `const radius = new Float32Array(MAX_LAYERS)`; fill the baked layers from `atlas` (a `Uint16Array` view per layer) when it loads; wrap the library's `upload` dep so each upload also sets `radius[layer] = inkRadius(half, cell)`. Each frame pass `{ radius: morphT > 0 && morphT < 1 ? max(radius[A], radius[B]) : radius[A], ax: w / min(w, h), ay: h / min(w, h), morphing }` (layer 0 in fallback). Add `zones` to the meters message.
- [ ] **Step 5:** `npm run check`, `/gandalf`, commit `Stop: sound and drift cannot push zoom or mirror shift past the window`.

### Task 4: Zones on the dashboard, stop toggle, SPEC

**Files:** Modify `src/control/ui.ts`, `src/control/main.ts`, `src/control/control.css`, `SPEC.md`.

- [ ] **Step 1:** `Slider.setZones(orangeU: number, redU: number): void` paints the track background: green to `orangeU`, orange to `redU`, red after (CSS custom properties on the track; quiet colours, the thumb and tick stay the brightest). `setZones(1, 1)` shows a plain track.
- [ ] **Step 2:** In `applyMeters`, call `setZones` on the `zoom` and `mirrorShift` base sliders from `m.zones`.
- [ ] **Step 3:** Add a `stop` checkbox row in the Performance block wired to `setSession('zoomStop', …)`, reflected in `applyState`.
- [ ] **Step 4:** Amend `SPEC.md`: B3 (`v`, `zoomStop`), B4.1 (stop), B4.2 (zoom row, `reactScale`, new subsection for reach), B8 (randomize/mutate scale), B9 (`zones`), B10 (zones, stop toggle), C2 (new tests), D3 ("shape leaves the window → watch the red zone; stop on").
- [ ] **Step 5:** `npm run check && npm run lint`. Run `npm run dev`, open `http://localhost:5173/?src=synth` and `/control.html`: drag zoom to 3 (the shape fills the window, zones visible, the hand is free); with zoom just under red, confirm the kick's tick stops at the red edge; toggle stop off and see it pass. Turn mirror Y on and check the mirrorShift zones appear.
- [ ] **Step 6:** `/gandalf`, commit `Dashboard: zoom and mirror-shift zones, stop toggle; SPEC`.

---

## Piece 2 — Envelope (design §5)

### Task 5: `envelope.ts` and `Look.env`

**Files:** Create `src/display/envelope.ts`. Modify `src/shared/state.ts`, `src/display/presets.ts`. Test new `tests/envelope.test.ts`, `tests/state.test.ts`, `tests/presets.test.ts`.

**Interfaces — Produces:**
```ts
// state.ts
export type EnvGroup = 'shape' | 'line' | 'colour';
export const ENV_GROUPS: EnvGroup[];
export interface Env { attack: number; sustain: number; decay: number; release: number; }
export const ENV_RANGES: { attack: [0, 2]; sustain: [0, 1]; decay: [0.05, 10]; release: [0, 20] };
export function neutralEnv(): Env;                 // { attack: 0, sustain: 1, decay: 1, release: 0 }
export function isEnvGroup(g: unknown): g is EnvGroup;
// Look gains: env: Record<EnvGroup, Env>
// envelope.ts
export interface EnvState { c: number; y: number; }            // start { c: 1, y: 0 }
export function envStep(s: EnvState, g: number, env: Env, dt: number): void;   // design §5.2, mutates s
/** The response to "full on for the sustain section, then off", sampled for drawing. Uses envStep. */
export function envCurve(env: Env, samplesPerSection: number): { attack: Float32Array; sustain: Float32Array; release: Float32Array };
```

- [ ] **Step 1: Failing tests** (`tests/envelope.test.ts`):
  - neutral: for random `g` sequences and `dt` in `{0, 1/120, 1/30, 1}`, `y === g` exactly.
  - `{ attack: 0.5, sustain: 1, decay: 1, release: 0 }`, `g = 1`: after 0.5 s `y` is `1 − 1/e` within 0.01.
  - `{ attack: 0, sustain: 0.4, decay: 1, release: 0 }`, `g = 1` for 10 s: `y` starts at 1 and ends within 0.01 of 0.4.
  - `{ attack: 0, sustain: 1, decay: 1, release: 2 }`: `g = 1` then 0; after 2 s `y` is `1/e` within 0.01.
  - `{ attack: 0, sustain: 0.3, decay: 0.3, release: 4 }`: a 0.1 s hit, 1 s quiet, a second 0.1 s hit → second peak lower than the first; after 60 s quiet a third hit peaks within 1% of the first.
  - same input at 30 and 120 fps → `y` within 2%.
  - **Review Focus 3:** `dt = 5` and `dt = 0` with any settings in range keep `c` and `y` in 0…1 and finite.
  - `tests/state.test.ts`: a Look without `env` migrates to neutral for all three groups; out-of-range numbers are clamped.
  - `tests/presets.test.ts`: `lerpLook` endpoints exact and midpoint linear for env; `cloneLook` deep-copies env; randomize and mutate leave env alone; `resetLook(look, 'line')` resets only line's env; full reset all three.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement. `defaultLook` and `fallbackLook` use neutral env.
- [ ] **Step 4:** `npm run check`.
- [ ] **Step 5:** `/gandalf`, commit `Envelope: attack, sustain (fatigue), release per group, in the Look`.

### Task 6: Envelope in the modulation, `setEnv`, live meters

**Files:** Modify `src/display/modulation.ts`, `src/display/store.ts`, `src/shared/protocol.ts`, `src/display/main.ts`. Test `tests/modulation.test.ts`, `tests/store.test.ts`.

**Interfaces:**
- Consumes: Task 5's `envStep`, `Env`, `EnvGroup`, `ENV_RANGES`.
- Produces:
```ts
// protocol.ts
| { t: 'setEnv'; group: EnvGroup; key: keyof Env; value: number }      // ControlMsg
MetersMsg.env: Record<EnvGroup, { level: number; stage: 0 | 1 | 2 | 3 }>
// Modulation gains
envC: Float32Array; envY: Float32Array;       // per param; c starts at 1
envLead: Record<EnvGroup, { level: number; stage: 0 | 1 | 2 | 3 }>;
```

- [ ] **Step 1: Failing tests:**
  - with default (neutral) Looks every existing modulation test still passes, and the values over a 600-frame random audio run equal a run of the pre-change formula (`u_base + drift + react × gate`).
  - shape env `{ release: 2 }`: zoom with react on `low`, `low` 1 → 0: the value is still above base 1 s later; `waveAmt` (inner) with the same sound is back at base immediately.
  - `envLead.shape` reports the highest `y` among shape params with `react ≠ 0` and a band; stage is 1 while rising, 2 holding, 3 falling, 0 idle (design §5.4).
  - store: `setEnv` clamps to `ENV_RANGES`; an unknown group, key or non-number returns the same model by reference.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement: in `modulate`, params in `ENV_GROUPS` use `y` in place of the gate; the stop of Task 3 runs after. Add `env` to the meters message.
- [ ] **Step 4:** `npm run check`, `/gandalf`, commit `Modulation: envelope stage for shape, line and colour`.

### Task 7: Envelope editor on the dashboard, SPEC

**Files:** Create `src/control/envelope.ts`. Modify `src/control/main.ts`, `src/control/control.css`, `SPEC.md`.

**Interfaces — Produces:**
```ts
export class EnvEditor {
  readonly mini: HTMLCanvasElement;      // goes in the panel header
  readonly el: HTMLDivElement;           // the editor body, hidden until opened
  constructor(o: { onInput(key: keyof Env, value: number): void; onReset(key: keyof Env): void });
  set(env: Env): void;                                   // from a state message; ignored for the dot being dragged
  setLive(level: number, stage: 0 | 1 | 2 | 3): void;    // from a meters message
  toggle(): void;
}
```

- [ ] **Step 1:** Build the widget on a canvas, following design §5.4 exactly: the curve comes from `envCurve` (never an approximation); three sections split by thin yellow vertical markers; dots A (x → attack), S (x → decay, y → sustain), R (x → release); each dot's travel covers its full range; shift-drag is ×0.1; double-click resets that dot to neutral; values printed small under the axis; soft fill under the curve; the live dot sits on the section given by `stage` at height `level`, brightness following `level`, and is hidden at stage 0. The mini canvas (about 64×18 px) shows the same curve and live dot, no handles.
- [ ] **Step 2:** In `main.ts`, for the shape, line and colour panels: put `mini` and a `▾` button in the header before the spacer; the editor body under the header; send `setEnv` through the existing `queueSend` throttle; call `set` in `applyState` and `setLive` in `applyMeters`.
- [ ] **Step 3:** Amend `SPEC.md`: B3 (`Env`, `Look.env`), B4.1 (envelope stage and formula), B8 (lerp, reset, randomize rules), B9 (`setEnv`, `env` meters), B10 (editor), C2, D3 ("too jumpy on slow music → open the group's curve: lower sustain, lengthen release").
- [ ] **Step 4:** `npm run check && npm run lint`. In the running app with `?src=synth`: open the shape curve, drag R right and watch zoom linger after each kick; drag S down and watch the kicks weaken; the live dot moves along the curve; a reload keeps the settings; an old preset still looks as before.
- [ ] **Step 5:** `/gandalf`, commit `Dashboard: envelope editor with live dot; SPEC`.

---

## Piece 3 — Ambient mode (design §6)

### Task 8: Ambient transform, restore, tagged undo

**Files:** Modify `src/display/presets.ts`. Test `tests/presets.test.ts`.

**Interfaces — Produces:**
```ts
export const AMBIENT_FADE_S = 5;
export const AMBIENT_ENV: Env;                       // { attack: 0.3, sustain: 0.5, decay: 2, release: 4 }
export const AMBIENT_BANDS: ReadonlySet<Band>;       // low, beat, high
export interface AmbientStash {
  react: Partial<Record<ParamId, { react: number; band: Band }>>;
  env: Partial<Record<EnvGroup, Env>>;
}
export function ambientLook(look: Look, prev?: AmbientStash | null): { look: Look; stash: AmbientStash };   // design §6.1, merge rules included
export function ambientRestore(look: Look, stash: AmbientStash): Look;                                       // design §6.3 "Off"
export function migrateAmbientStash(v: unknown): AmbientStash | null;                                        // null when not a valid stash
export interface UndoEntry { look: Look; ambient: boolean; }
export function pushUndo(ring: readonly UndoEntry[], look: Look, ambient: boolean): UndoEntry[];
export function popUndo(ring: readonly UndoEntry[]): { ring: UndoEntry[]; entry: UndoEntry | null };
export function randomize(look: Look, rng: Rng, group?: Group, ambient?: boolean): Look;   // ambient: react 0 on AMBIENT_BANDS afterwards
export function mutate(look: Look, rng: Rng, group?: Group, ambient?: boolean): Look;      // ambient: skip react where it is 0 on AMBIENT_BANDS
```

- [ ] **Step 1: Failing tests:**
  - on the default Look: `ambientLook` zeroes exactly zoom, thickness, spikeAmp, brightness, glow, grain (bands low, beat, high) and leaves warpAmt, waveAmt, waveSpeed; all three envs equal `AMBIENT_ENV`; the stash holds the six reacts with their bands and the three old envs.
  - `ambientRestore(ambientLook(l).look, stash)` deep-equals `l`.
  - restore keeps a param whose react was edited to 0.2, skips a param whose band changed, keeps an env that was edited.
  - merge: calm the default Look, `resetLook(calm, 'colour')`, pass through `ambientLook(reset, stash)` → the new stash still holds zoom and thickness and the shape and line envs; restoring gives zoom's react back.
  - merge drops the entry of a param that arrives with band `mid`.
  - `migrateAmbientStash` returns null for `undefined`, `'x'`, `{ react: 3 }`; round-trips a real stash through JSON.
  - randomize with `ambient: true` over 100 seeds: no param on `AMBIENT_BANDS` has `react ≠ 0`; mutate with `ambient: true` leaves a zero react on a `low` param at 0 and still moves a re-added one.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement; update `store.ts` call sites of `pushUndo` / `popUndo` to compile (pass `false` for now).
- [ ] **Step 4:** `npm run check`, `/gandalf`, commit `Ambient: Look transform, stash merge, restore, tagged undo`.

### Task 9: Ambient in the store, persistence, key, button, SPEC

**Files:** Modify `src/display/store.ts`, `src/shared/state.ts`, `src/shared/protocol.ts`, `src/shared/keys.ts`, `src/control/main.ts`, `src/control/control.css`, `SPEC.md`. Test `tests/store.test.ts`.

**Interfaces:**
- Consumes: everything Task 8 produces.
- Produces: `Session.ambient: boolean` (default false; not settable through `setSession`); `Model.ambientStash: AmbientStash | null`; `Model.undo: UndoEntry[]`; `CmdName` gains `'ambient'`; `STORAGE_KEYS.ambient = 'ferro.ambient.v1'`; `Persisted.ambient: AmbientStash | null`; `keyAction('a')` → `{ t: 'cmd', name: 'ambient' }`.

- [ ] **Step 1: Failing tests** (`tests/store.test.ts`):
  - `cmd ambient` on: `session.ambient` true, a fade of 5 s regardless of `session.xfade`, the Look calmed, the stash set, one undo entry tagged `ambient: false`.
  - `cmd ambient` again: ambient false, stash null, fade 5 s, the Look deep-equals the original.
  - on → raise zoom react by hand → off: zoom keeps the hand value; the others return.
  - while on: `loadPreset`, `recallPreset` (the cycle path) and `reset` produce calmed Looks and ambient stays true; `reset` of one group keeps the other groups' stash (off restores them).
  - while on: undo of an entry tagged `ambient: true` applies it as is (a hand re-added react survives); undo of the pre-ambient entry comes out calmed.
  - while on: `randomize` leaves `AMBIENT_BANDS` reacts at 0.
  - `savePreset` while on stores the calm Look; no preset and no `State` field contains the stash.
  - `setSession ambient true` is ignored.
  - persistence: `Persister` writes `ferro.ambient.v1` when the stash changes and writes `null` when it clears; `initialModel` with a stored valid stash boots with `ambient: true` and that stash; a corrupt value boots with ambient off.
  - **Review Focus 4:** while on, `importPresets` of a v1 file (no `env`, no `v`) then `loadPreset` of an imported slot → Look is v2, calmed; off restores the migrated preset's reacts.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement in the reducer. `changeLook` takes the ambient flag for `pushUndo`. One helper applies "transform if ambient" to recall, reset and pre-ambient undo entries so the three paths cannot diverge.
- [ ] **Step 4:** Dashboard: an `Ambient` button in the Performance block (class `on` while lit), `AMBIENT` in the top bar next to `LIVE`, key `A` through the existing key handler.
- [ ] **Step 5:** Amend `SPEC.md`: B3 (`ambient`, the `ferro.ambient.v1` key), B8 (new "Ambient" subsection with the rules of design §6), B9 (`ambient` cmd), B10 (button, key table, top bar), C2, D3 ("music turns ambient → `A`"), D4 runbook (a reload keeps Ambient).
- [ ] **Step 6:** `npm run check && npm run lint`. In the running app: press `A` and watch the kick reactions fade out over 5 s and the curves change to long tails; raise one react by hand; press `A` again and check everything else returns over 5 s; press `A`, reload the Display, check `AMBIENT` is still lit and `A` restores.
- [ ] **Step 7:** `/gandalf`, commit `Ambient mode: 5 s calm-down, give-back, survives reload; SPEC`.

---

## Piece 4 — Colour strip (design §7)

### Task 10: Colour maths and `hueOffset` in the meters

**Files:** Create `src/shared/colour.ts`. Modify `src/shared/math.ts`, `src/shared/protocol.ts`, `src/display/main.ts`. Test new `tests/colour.test.ts`.

**Interfaces — Produces:**
```ts
// math.ts
export function hsv2rgb(h: number, s: number, v: number): [number, number, number];   // same formula as shader.frag, 0…1
// colour.ts
export const CORE_REF_DEPTH = 0.03;
export interface Handles { glow: number; core: number; }                    // turns, 0…1
export function handlesFromParams(hue: number, hueDepth: number): Handles;
export function paramsFromHandles(h: Handles, prevDepth: number): { hue: number; hueDepth: number };
export function liveSpan(hueEff: number, hueDepthEff: number, thicknessEff: number, hueOffset: number): { from: number; length: number };  // from = live glow; length signed, |length| ≤ 1
// protocol.ts MetersMsg
hueOffset: number;      // 0 in fallback
```

- [ ] **Step 1: Failing tests:**
  - `hsv2rgb(0, 1, 1)` is red, `(1/3, 1, 1)` green, `(2/3, 1, 1)` blue, `(x, 0, 1)` white.
  - `handlesFromParams(0.55, 0.35)` → glow `0.48`, core `0.655`.
  - round trip for 500 random `(hue, hueDepth)` with `|hueDepth| < 1`: `paramsFromHandles(handlesFromParams(…))` returns them within 1e-9 (hue modulo 1).
  - for every pair of handle positions on a 0.05 grid, `hueDepth` is within −1…1 and `hue` within 0…1.
  - moving `core` keeps `handlesFromParams(result).glow` equal to the given glow, and the reverse.
  - **Review Focus 5:** handles exactly opposite (arc 0.5): the sign of `hueDepth` follows `prevDepth`, so two successive calls do not flip; handles equal → `hueDepth` 0.
  - `liveSpan(0.55, 0.35, 0, 0)` → from `0.48`, length `0.175`; thickness `0.06` gives length `0.385`; `hueOffset 0.25` shifts `from` by 0.25; `hueDepth 1` with thickness `0.07` caps length at 1.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement per design §7.2. Send `hueOffset` in the meters message (the value passed to the renderer).
- [ ] **Step 4:** `npm run check`, `/gandalf`, commit `Colour: handle maths, live span, hueOffset in meters`.

### Task 11: Colour strip on the dashboard, SPEC, README, milestone

**Files:** Create `src/control/huestrip.ts`. Modify `src/control/main.ts`, `src/control/control.css`, `SPEC.md`, `README.md`.

**Interfaces — Produces:**
```ts
export class HueStrip {
  readonly el: HTMLDivElement;
  constructor(o: { onInput(hue: number, hueDepth: number): void });
  set(hue: number, hueDepth: number): void;                         // base values from state; ignored while dragging
  setLive(span: { from: number; length: number }, sat: number): void;
}
```

- [ ] **Step 1:** Build the strip per design §7.2: the wheel 0…1 drawn with `hsv2rgb` at the live `sat`; two handles (label them `glow` and `core`); dragging one keeps the other in place, dragging between them moves both; handles and bracket wrap around the ends (draw a wrapped span as two pieces); the live bracket is a bright outline over the span, the handles are thin lines. Shift-drag is ×0.1.
- [ ] **Step 2:** In `main.ts`: place the strip at the top of the colour panel, above the rows. `onInput` sends two `setParam` messages (`hue.base`, `hueDepth.base`) through `queueSend`. `set` from `applyState`; `setLive` from `applyMeters` using `liveSpan` with the effective values (convert `m.values` with `fromNorm`) and `m.hueOffset`. The `hue` and `hueDepth` rows stay unchanged.
- [ ] **Step 3:** Amend `SPEC.md`: B9 (`hueOffset`), B10 (strip), C2, and a plain-words note under B5 step 10 explaining what `hue`, `hueDepth` and `hueSpace` do. Add milestone **M8 — Live polish (1 h)** in D2: one techno track and one ambient track; look at the zones and the stop at zoom 1–3 on the three largest shapes, the envelope on each group, `A` in and out, the strip against the projected colours; note which constants to retune (`GLOW_CUTOFF`, `AMBIENT_ENV`, the zoom max). Update `README.md` with a short "Live controls" section (zones and stop, curves, `A`, the strip).
- [ ] **Step 4:** `npm run check && npm run lint`. In the running app: the handles sit on the colours the projector shows at rest; the bracket stretches on kicks and slides with autopilot; turn on hue jumps and watch the bracket jump; drag each handle and check only that colour moves.
- [ ] **Step 5:** `/gandalf`, commit `Dashboard: colour strip; SPEC M8, README`. Push the branch.
