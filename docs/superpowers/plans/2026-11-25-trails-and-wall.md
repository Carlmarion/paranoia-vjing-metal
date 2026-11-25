# Trails and the Wall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Echo trails (three sliders) and a wall of delayed cells (four options), on a new render path: scene → off-screen buffer → show.

**Architecture:** Pure maths in `src/display/trails.ts` and `src/display/wall.ts` (vitest). `gl.ts` gains two ping-pong float targets, one scene draw per cell and a show pass with grain and master. `main.ts` computes the trail uniforms from `dt`, records a 6 s history of frame inputs, and tells the renderer when to clear.

**Tech Stack:** TypeScript, WebGL2 (`EXT_color_buffer_float`), vitest, eslint.

**Spec:** `docs/superpowers/specs/2026-11-25-trails-and-wall-design.md`

## Global Constraints

- `trail = 0` and a 1×1 wall give today's picture (≤ 2/255 per channel on a repeatable frame).
- Old Looks and presets get table defaults and a 1×1 wall; no Look version bump.
- Fallback (`B`) forces decay 0 and a 1×1 wall with no delay.
- Decay, push and twist are per second, from `dt`.
- Constants: `TRAIL_MAX_S = 6`, `PUSH_RATE = 1.5`, `TWIST_RATE = 0.25`, `WALL_MAX = 8`, `WALL_HISTORY_S = 6`, `wallDelay` 0…1 s (default 0.12).
- Checks per task: `npx tsc --noEmit && npx vitest run` (the bake-budget timing test may fail while the dev server runs) and `./node_modules/.bin/eslint src tests`. `/gandalf` before each commit.

## Review Focus

- Blackout → draw in ▶ with trails and wall on: clean black, no old echoes, no late cells showing the old shape.
- Window resize and WebGL context restore with trails on: buffers reallocated and black, no GL errors.
- No `EXT_color_buffer_float`: RGBA8 targets, echoes still reach black.
- A preset recall that changes `wallCols`/`wallRows` mid-history: no out-of-range cell, no crash.
- Mutate all on an old Look never moves `trail`; Randomize all never moves `trail` or the wall options.

---

### Task 1: Trails sliders and maths

**Files:** Modify `src/shared/params.ts`, `src/display/presets.ts`; create `src/display/trails.ts`, `tests/trails.test.ts`; modify `tests/presets.test.ts` and any test that hard-codes five groups or 32 params.

**Interfaces — Produces:**
- `Group` gains `'trails'`; `GROUPS` ends with `'trails'`; rows `trail` (lin 0…1, def 0, band none, no drift, `rand: null`), `push` (lin −1…1, def 0, rand `[-0.3, 0.3]`), `twist` (lin −1…1, def 0, rand `[-0.1, 0.1]`).
- `trails.ts`: `TRAIL_MAX_S`, `PUSH_RATE`, `TWIST_RATE`; `trailDecay(trail: number, dt: number): number`; `trailMatrix(push: number, twist: number, dt: number): [number, number, number, number]` (column-major mat2 taking a pixel's aspect-correct position this frame to where it was last frame: rotation by `−twist × TWIST_RATE × dt` turns, scale `exp(−push × PUSH_RATE × dt)`).
- `ZERO_BASES` gains `trail`, `push`, `twist`. `mutate(look, rng, group?, ambient?)`: when `group` is undefined, params with `id === 'trail'` keep their base (export `MUTATE_ALL_SKIP: readonly ParamId[] = ['trail']`).

- [ ] Tests first (`tests/trails.test.ts`): `trailDecay(0, dt) === 0`; `trailDecay(1, 6) ≈ e⁻¹`; `trailDecay(t, a) × trailDecay(t, b) ≈ trailDecay(t, a + b)`; `trailMatrix(0, 0, dt)` is the identity; two half-steps multiplied equal one full step; positive push gives a scale below 1 (the old picture is sampled nearer the centre, so echoes move outward). In `tests/presets.test.ts`: Zero zeroes the three bases; 200 Mutate-all rounds leave `trail.base` at 0 and a trails-group Mutate moves it; 200 Randomize-all rounds leave `trail.base` at 0; an old Look JSON without the three ids migrates to defaults.
- [ ] Run, see them fail; implement; run green; lint; gandalf; commit `Trails: sliders, group and maths`.

### Task 2: Render path and trails on screen

**Files:** Modify `src/display/gl.ts`, `src/display/shader.frag`, `src/display/main.ts`; create `src/display/show.frag`.

**Interfaces — Consumes:** Task 1's `trailDecay`, `trailMatrix`, `PARAM_INDEX.trail/push/twist`.

**Produces:**
- `FrameUniforms` loses `res`, `master`, `frame`; they move to `ShowUniforms { master: number; frame: number; grain: number }`.
- `interface CellDraw { rect: [x: number, y: number, w: number, h: number]; u: FrameUniforms }`
- `interface TrailUniforms { decay: number; m: [number, number, number, number] }`
- `Renderer.resize(w: number, h: number): void` (allocates both targets when the size changes, clears them), `Renderer.clear(): void` (both targets to black), `Renderer.draw(cells: readonly CellDraw[], trail: TrailUniforms, show: ShowUniforms): void`.
- Scene shader: `uniform vec2 uOrigin, uScreen; uniform sampler2D uPrev; uniform float uTrailDecay, uFloor; uniform mat2 uTrailM;` screen space from `gl_FragCoord.xy − uOrigin`; output `vec4(max(col, echo.rgb), max(lum, echo.a))` where `echo = max(texture(uPrev, uv) × uTrailDecay − uFloor, 0)` and is 0 outside `0…1`; `uv` from the window-centred, short-side-normalised position times `uTrailM`. `uFloor` is `1/255` on RGBA8 targets, else 0. `col` stays clamped to 0…1 before the max.
- Show shader: spec §4.4; grain is passed as a uniform (`uGrain`), not `uP`.
- `main.ts`: `renderer.resize` in `resize()`; `renderer.clear()` every frame while `master === 0`, when a `replay` effect has `fromBlank`, and on the frame `session.fallback` changes; in fallback `decay = 0`.

- [ ] Implement. `tsc`, vitest, lint.
- [ ] Verify in headless Chrome (`/?src=synth`): no console or GL errors; the shape renders; with `trail` 0.8 and `push` 0.5 sent over the BroadcastChannel, echoes are visible in a screenshot. Same-picture check: screenshot of a frozen frame at `grain` 0 on `HEAD~` and on the new build, max channel difference ≤ 2. If a repeatable frame can't be had, record a `Ruling:` with what was compared instead.
- [ ] gandalf; commit `Render path: scene buffer, echoes, show pass`.

### Task 3: Wall maths, options, history

**Files:** Create `src/display/wall.ts`, `tests/wall.test.ts`; modify `src/shared/state.ts`, `src/shared/math.ts` (`STREAM_OFFSET.wall = 4`), `src/display/store.ts` (`setOption`), `tests/state.test.ts`, `tests/store.test.ts`.

**Produces:**
- `state.ts`: `WALL_MAX = 8`, `WALL_WAVES = [0, 1, 2, 3, 4] as const`, `type WallWave`, `WALL_DELAY_RANGE = [0, 1] as const`; `LookOptions` gains `wallCols: number; wallRows: number; wallWave: WallWave; wallDelay: number` (defaults 1, 1, 0, 0.12); `migrateOptions` validates them (integers 1…`WALL_MAX`). `setOption` accepts the four keys with the same validation.
- `wall.ts`:
  - `WALL_HISTORY_S = 6`
  - `cellRects(w: number, h: number, cols: number, rows: number): [number, number, number, number][]` — row-major from the **top** row; `y` in GL pixels (origin bottom-left); edges at `floor(i × w / cols)`.
  - `cellSteps(cols: number, rows: number, wave: WallWave, seed: number): number[]` — spec §6.3, same order as `cellRects`.
  - `cellDelays(steps: readonly number[], delay: number): number[]` — `step × delay`, scaled so the max is ≤ `WALL_HISTORY_S`.
  - `class History<T> { constructor(spanS: number); push(t: number, v: T): void; at(t: number): T | null; clear(): void }` — `at(t)` returns the newest entry with time ≤ `t`, else the oldest, else `null`; `push` drops entries older than `spanS` before the newest.

- [ ] Tests first: rects tile 1000×563 at 3×2 and 7×8 with no gap or overlap (sum of areas, shared edges); steps for each wave on 3×2 and 4×4 (rows: `[0,1,2,3,4,5]`; snake 3×2: `[0,1,2,5,4,3]`; centre 4×4: corners 1, middle four 0; centre 3×3: middle 0, others 1; diagonal 3×2: `[0,1,2,1,2,3]`); random is a permutation of `0…n−1`, equal for the same seed, different for cols×rows swapped sizes or another seed; delays `[0, 0.12, 0.24]` for steps `[0,1,2]`; 64 steps × 1 s are scaled so the max is 6; History returns newest ≤ t, oldest when too short, null when empty, and forgets entries older than its span; options migrate (missing → defaults, 0 / 9 / 2.5 / `'x'` → default); `setOption` rejects the same.
- [ ] Fail, implement, green, lint, gandalf; commit `Wall: options, cell maths, history`.

### Task 4: Wall on screen

**Files:** Modify `src/display/main.ts`, `src/display/presets.ts` (nothing if Reset already uses `defaultOptions`), `src/control/main.ts`, `src/control/control.css`.

**Consumes:** Task 2's `Renderer.draw(cells, …)`, Task 3's `wall.ts` and options.

- [ ] `main.ts`: each frame build the current `FrameUniforms`; when the wall is larger than 1×1 and not in fallback, `history.push(now, copy)` (copy `params`), and each cell uses `history.at(now − delay) ?? current`; otherwise one cell with the current inputs. `history.clear()` wherever `renderer.clear()` is called and when the wall returns to 1×1. Steps are recomputed only when cols, rows or wave change. `geomOf` uses the cell size (`canvas.width / cols`, `canvas.height / rows`) for `ax`, `ay` (test in `tests/modulation.test.ts` only if the logic leaves `main.ts`; otherwise extract `cellAspect(w, h, cols, rows): { ax: number; ay: number }` into `wall.ts` with a test).
- [ ] Dashboard: a `wall` row under `mirror`: `cols` and `rows` as `Seg` over 1…8 or −/+ steppers (builder's choice, must fit the left column), `wave` as `Seg` with labels `rows · snake · centre · diag · rand`, `delay` as a `numSlider` over `WALL_DELAY_RANGE` (unit `s`). The `trails` panel appears from `GROUPS` with no envelope arrow.
- [ ] Verify in headless Chrome: 3×2 wall renders six shapes; with `wallDelay` 0.5 and a `next`, a screenshot mid-melt shows cells at different melt stages; blackout → `replay` shows no old shape in any cell.
- [ ] gandalf; commit `Wall: delayed cells on screen, dashboard row`.

### Task 5: Docs

- [ ] Amend `SPEC.md` per spec §9 and `README.md` (Live controls: Trails, Wall). Commit `Spec and README: trails and the wall`.
