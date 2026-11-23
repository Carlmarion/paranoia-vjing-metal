# Live polish: zoom limits, envelope, ambient mode, colour strip

Date: 2026-11-23. Branch: `feat/drawing-tool`. Amends `SPEC.md` (sections named below).

This doc stands alone: a builder can plan from it and the code without the conversation that produced it.

## 1. Intent

Playing the piece live showed four problems that only show up live:

1. **Zoom.** At high zoom the shape or its glow leaves the browser window, and nothing on the dashboard says when. Carl wants *more* zoom (enough to fill the window), not less, and wants to see the danger before it happens.
2. **Ambient music.** The reactions are tuned for fast, repetitive techno. On ambient tracks they are jumpy. Reactions need a shape in time: a sharp start, a sag while the sound continues, a lingering tail, and weaker repeat hits during that tail (like retinal persistence).
3. **A quick way into ambient.** When the music turns ambient, Carl needs one button that calms everything over 5 seconds, after which he re-adds reactions by hand.
4. **Colour.** The `hue`, `hueDepth` and `hueSpace` sliders don't show what colours will come out. Carl can't predict the result.

## 2. Goals, non-goals, anti-goals

**Goals**
- Zoom up to 3×. Zoom and mirror-shift sliders show green / orange / red zones that follow the real picture.
- The hand is never limited. Sound and autopilot can't push **zoom or mirror shift** past the red line ("the stop"). Other effects (a thickness kick, tilt drift) can still nudge a line that already sits at the edge over it; the stop does not pull zoom below the hand to make room.
- One envelope per group for shape, line and colour, edited by dragging three dots on a curve, with a live dot showing where the effect is now.
- An Ambient button: 5 s fade, removes kick, beat and high reactions, sets long tails, gives everything back when pressed again.
- A colour strip showing the at-rest colours as two handles and the colours on screen now as a bracket.
- Every existing preset looks the same after the update, until Carl touches the new controls.

**Non-goals**
- No envelope for the melt and inner groups.
- No per-slider envelope; settings are per group.
- No shader change for colour. The line getting thicker still shifts the core colour: Carl called this a happy accident and wants it kept.
- No automatic detection of ambient music.
- "The zone" is the browser window only. No custom projection surface or mask.

**Anti-goals**
- A zoom limit that blocks the hand.
- Zones that pump with spin or flicker with every kick.
- An envelope picture that is decoration: the curve must be the real response, drawn by the same function that runs on the Display.

## 3. Approaches

Each piece had one sensible approach; the alternatives and why they lost:

| Piece | Chosen | Rejected |
|---|---|---|
| Zoom range | `log` scale 0.5…3, with a per-Look migration of `react` | Keeping `lin` and widening to 3: every preset's kick push would get 2.8× stronger, and the push would feel smaller at high zoom. |
| Shape reach | A bounding **radius** of the ink per layer, measured from the SDF on every texture upload | A bounding box: the zones would pump as the shape spins. Measuring in the Python bake: drawn and live shapes never pass through it. |
| Envelope | A stage in `modulation.ts` after the threshold gate; settings per group in the Look; running state per param in `Modulation` | Per-param settings (62 more controls). Changing the band envelopes in `dsp.ts` (they are shared by all groups, and melt and inner must stay as they are). |
| Fatigue | A "charge" that drains under input and refills in quiet, which is also the sustain stage of the curve | A separate fatigue control: two boxes describing one behaviour. |
| Ambient | A Look transform + the existing crossfade (5 s) + a stash in the `Model` | Per-group react multipliers in the session: Carl re-adds reactions slider by slider, and a multiplier at 0 would hide his edits. |
| Colour | Dashboard-only strip that reads and writes `hue` and `hueDepth` | A two-colour palette in the shader: it would remove the thickness-colour coupling Carl wants to keep. |

## 4. Piece 1 — Zoom limits (SPEC B4.2, B4.1, B9, B10)

### 4.1 Zoom range and migration

- `zoom` row becomes: scale `log`, min 0.5, max 3, default 0.85, band low, react **0.034**, thr 0.15, driftAmp **0.023**, driftPeriod 120, rand 0.7–1.0. (0.034 and 0.023 give the same on-screen push as today's 0.06 and 0.04 at zoom 0.85.)
- `base` is stored in real units, so stored zoom values stay valid.
- `ParamDef` gets an optional `reactScale` (default 1; **0.5 for zoom**). Randomize draws react in `0…RANDOM_REACT_MAX × reactScale`, and mutate uses `MUTATE_SD.react × reactScale`. Without it, a random react of 0.6 on the log scale would be a ×2.9 zoom kick.
- `react` is in normalised units, so stored values must be converted. `Look` gets a version field `v: 2`. `migrateLook` on a Look without `v` (or `v < 2`) converts zoom's react so the push at that Look's base stays the same:

```
push  = react_old × 0.9                      // old lin range 1.4 − 0.5
react = sign(push) × |ln(max(base + push, 0.05) / base)| / ln(6)     // new log range ln(3 / 0.5)
```
  clamped to −1…1. `serialiseLook` and presets write `v: 2`. `public/presets/default.json` goes through `migratePresets` at load, so it needs no hand edit. `PRESETS_FILE_VERSION` stays 1 (the version lives in each Look).

### 4.2 Ink radius per layer

- New pure function in `src/shared/sdf.ts`: `inkRadius(half: Uint16Array, cell: number): number`. It returns the largest distance from the cell centre, in motif units (cell spans −1…+1), of any texel whose SDF is ≤ 0 (float16 sign bit set, or zero). Blank layer → 0.
- `display/main.ts` keeps `radius: Float32Array(MAX_LAYERS)`. It is filled from `atlas.bin` at load for the baked layers and updated inside the `upload(layer, half)` dep on **every** upload, so drawn shapes, re-bakes, the live layer and replays are always current.
- The radius used for a frame is `R = morphT is 0 ? radius[A] : max(radius[A], radius[B])`. In fallback, `radius[0]`.

### 4.3 Reach

New pure module `src/display/reach.ts`, unit-tested. All in the shader's screen units (the window's short side spans −1…+1). Window half-extents: `ax = w / min(w, h)`, `ay = h / min(w, h)`.

The shader order is tilt → mirror → rotate → zoom → warp. Working outward from the shape:

```
grow   = max(thickness, 0) + spikeAmp + warpAmt × √2          // motif units
       + (meltMode is fuse and 0 < morphT < 1 ? meltK / 4 : 0)   // the smooth union bulges by up to k/4
Rink   = R + grow
Rglow  = Rink + max(0, glowWidth × ln(glow × brightness / 0.08))   // glow visible above 8% luminance

for Rx in (Rink, Rglow):
  ρ  = zoom × Rx
  ex = ρ + (mirrorX ? mirrorShift : 0)        // mirror shift is added after zoom: it does not scale with it
  ey = ρ + (mirrorY ? mirrorShift : 0)
  T  = |tiltX| × ex + |tiltY| × ey
  k  = 1 / max(1 − T, 0.05)                   // tilt pushes the far side outward
  fill = max(ex × k / ax, ey × k / ay)
```

- `fillInk ≥ 1` means the line touches the window edge: **red**. `fillGlow ≥ 1` with `fillInk < 1`: **orange**. Otherwise **green**.
- Rotation and spin do not appear: a radius is the same at every angle. This is deliberately conservative (a square shape upright reaches less than its radius).
- `fill` rises monotonically with zoom and with mirrorShift, so `limit(param)` = the value where `fill = 1`, found by bisection (24 steps) over the param's range; returns the range max when never reached, the min when always exceeded.

### 4.4 The stop

Applied in `modulate`, after every param's value is computed, when `session.zoomStop` is true (new Session field, default **true**, toggle in the dashboard's Performance block; not active in fallback).

For a param `x` with hand value `x_hand = fromNorm(clamp01(u_base))` and full value `x_full` (hand + drift + envelope × react):

```
x_final = x_full <= x_hand ? x_full : max(x_hand, min(x_full, x_limit))
```

So the sound and drift can only move outward up to the red line; if the hand is already past it, they add nothing outward; inward motion (negative react) is untouched.

The stop never moves a value below the hand, and it acts on zoom and mirrorShift only. Known consequence, accepted: the radius is a safe-side estimate, and three of the twelve baked shapes have a radius near 1.0, so with the default Look (zoom 0.85, kick to about 0.90) the stop trims the top of the kick on those shapes by a few percent. Turning the stop off restores today's values exactly.

Order, fixed: (1) `mirrorShift` (only when a mirror is on), with `x_limit` computed from `fillInk` using zoom at its **hand** value; (2) `zoom`, with `x_limit` from `fillInk` using the final mirrorShift. All other params use this frame's final values. `m.values` and `m.norm` hold the stopped values.

### 4.5 Zones on the dashboard

- `MetersMsg` gets `zones: { zoom: [number, number]; mirrorShift: [number, number] }`: the normalised slider positions where orange and red start (1 = never).
- Zones are computed with the **other** params at rest (base + drift, no sound), so they don't flicker with the kick. They move with the shape on screen, the melt, mirror toggles, the hand, and window resizes.
- `Slider` gets `setZones(orangeU, redU)`: the track background is green up to orange, orange up to red, red after. Quiet colours; the thumb and the live tick stay the brightest things on the row. The existing live tick already shows where the sound puts the value.
- With no mirror on, the mirrorShift row shows no zones.

## 5. Piece 2 — Envelope (SPEC B3, B4.1, B8, B9, B10)

### 5.1 Settings

```ts
type EnvGroup = 'shape' | 'line' | 'colour';
interface Env { attack: number; sustain: number; decay: number; release: number; }
// Look gains: env: Record<EnvGroup, Env>
```

| Field | Range | Neutral | Meaning |
|---|---|---|---|
| attack | 0…2 s | 0 | time constant of the rise |
| sustain | 0…1 | 1 | level the effect sags to while the sound continues (1 = no fatigue) |
| decay | 0.05…10 s | 1 | how fast it sags, and how fast it recovers |
| release | 0…20 s | 0 | time constant of the tail |

With the neutral values the envelope returns its input exactly, so old Looks render as before.

### 5.2 Per-frame update

New pure module `src/display/envelope.ts`, unit-tested. Per param in the three groups, state `c` (charge, starts 1) and `y` (output, starts 0), held in `Modulation` as two `Float32Array(PARAM_COUNT)`. `g` is the gate value 0…1 from B4.1.

```
// fatigue: the charge drains under input and refills in quiet
target = 1 − (1 − sustain) × g
τc     = target < c ? decay : max(decay, release)     // refilling takes at least as long as the tail
c     += (target − c) × (1 − exp(−dt / τc))
x      = g × c

// attack / release
τ  = x > y ? attack : release
y  = τ <= 0 ? x : y + (x − y) × (1 − exp(−dt / τ))
```

B4.1 becomes `u = u_base + drift + reactMaster × react × y` for shape, line and colour; melt and inner keep `gate` directly. A sustained sound gives sharp start → sag to `sustain` → tail. Repeat hits inside the tail land weaker because the charge has not refilled.

### 5.3 Where the settings live and what touches them

- In the Look, so presets carry them. `migrateLook` fills missing `env` with neutral values (clamped to the ranges). `cloneLook` deep-copies it.
- `lerpLook` interpolates the four numbers linearly, so a crossfade lengthens tails gradually.
- Randomize and mutate never touch `env`. Reset (group) sets that group's env to neutral; Reset all, all three. Undo covers it because it is part of the Look.
- `fallbackLook` is neutral.
- New message: `{ t: 'setEnv', group: EnvGroup, key: keyof Env, value: number }`, clamped in the store.

### 5.4 Dashboard

In the header of the shape, line and colour panels: a **mini curve** (about 64×18 px) and an arrow. The arrow opens the editor under the header; closed by default.

```
 shape  [╱▔╲▁▁╲ ] ▾                    Randomize  Mutate  Reset

 1 ┤  A●
   │  ╱ ╲
   │ ╱   ╲___S●______
   │╱                ╲___R●
 0 ┼──┆────┆─────────┆────→
      attack  sustain   release
```

- **The curve is real:** it is drawn by running `envelope.ts` on a test input (full on, then off). No hand-drawn approximation.
- **Three dots:** A (drag sideways: attack), S (sideways: decay, up/down: sustain), R (sideways: release). Each dot's travel covers its full range. Double-click a dot resets it to neutral. Shift-drag is fine, as on the sliders.
- **Three sections** separated by thin yellow vertical markers. Each section has its own time scale (the ranges differ by 10×); the current values are printed small under the axis (`0.3 s · 50% / 2 s · 4 s`).
- **Live dot:** `MetersMsg` gets `env: Record<EnvGroup, { level: number; stage: 0 | 1 | 2 | 3 }>` for the param with the highest `y` in the group among those with `react ≠ 0` and a band. Stage: 0 idle, 1 rising (`x > y` and `y < 0.95 × x`), 2 holding, 3 falling. The dot sits on the matching section of the curve at height `level`, and its brightness follows `level`. It also runs on the mini curve.
- A soft fill under the curve. No other decoration.

## 6. Piece 3 — Ambient mode (SPEC B3, B8, B9, B10, B11)

### 6.1 The transform

`ambientLook(look)` (pure, in `presets.ts`) returns the transformed Look and a stash:

- every param with band `low`, `beat` or `high` and `react ≠ 0` gets `react = 0`; the stash records `{ id → { react, band } }`;
- each envelope that is not already `AMBIENT_ENV` becomes `AMBIENT_ENV = { attack: 0.3, sustain: 0.5, decay: 2, release: 4 }`; the stash records the old one for that group.

`ambientLook(look, prevStash?)` **merges** when a stash already exists (a Look arriving while Ambient is on). Per param: if the incoming param is calmed by this call, its entry is written; else if the incoming param has react 0 and the same band as an existing entry, that entry is kept; else the entry is dropped. Per group: an incoming env equal to `AMBIENT_ENV` keeps the existing entry; otherwise the incoming env is stashed. So a group Reset while on never loses what another group is owed.

`AMBIENT_FADE_S = 5`, independent of `session.xfade`.

### 6.2 State

- `session.ambient: boolean` (default false, not persisted, never in a preset).
- `model.ambientStash` (in the `Model`, next to `undo`): `{ react: Partial<Record<ParamId, { react: number; band: Band }>>; env: Partial<Record<EnvGroup, Env>> } | null`.
- The stash is written to localStorage (`ferro.ambient.v1`) whenever it changes and removed when Ambient goes off. At boot, a valid stored stash sets `ambient = true` and restores the stash, so a Display reload mid-set keeps Ambient lit and can still give everything back. A corrupt value is ignored.
- Each entry of the undo ring records whether it was pushed while Ambient was on.
- New command `{ t: 'cmd', name: 'ambient' }` toggles. Button in the Performance block, lit while on; key **A**; the top bar shows `AMBIENT` while on.

### 6.3 Behaviour

- **On:** transform the live Look, crossfade 5 s (`changeLook`, which pushes undo), store the stash, `ambient = true`.
- **Off:** for each stashed param whose react is still exactly 0 and whose band is still the stashed band, put the stashed react back; for each group whose env still equals `AMBIENT_ENV`, put the stashed env back. Anything Carl changed meanwhile is kept. Crossfade 5 s, clear the stash, `ambient = false`.
- **While on:**
  - Manual edits are free. This is how reactions are re-added.
  - **Preset recall** (by hand or by the cycle) and **Reset** pass through the transform (merging into the stash, 6.1) before they are applied. Ambient ends only with the button.
  - **Undo:** an entry pushed while Ambient was on is applied as it is, so reactions Carl re-added by hand come back untouched. An entry from before Ambient passes through the transform. Consequence: Undo right after pressing Ambient changes nothing visible.
  - With Ambient off, an entry pushed while it was on is applied as it is (a calm Look).
  - **Randomize:** afterwards, every param whose band is `low`, `beat` or `high` gets `react = 0`.
  - **Mutate:** leaves `react` alone on params with one of those bands whose react is 0.
  - **Save preset** saves the Look as it is: an ambient preset.
- Fallback is unaffected (it ignores the live Look).

## 7. Piece 4 — Colour strip (SPEC B9, B10)

### 7.1 What the shader does today (unchanged)

```
h = hue + hueOffset − clamp(d, −0.1, 0.02) × 10 × hueDepth + |s| × 0.5 × hueSpace
```
`d` is the distance to the line edge (negative inside). So the glow (d ≥ 0.02) has colour `hue − 0.2 × hueDepth`, and a point at depth `k` inside the line has `hue + 10 × k × hueDepth`.

### 7.2 The strip

At the top of the colour panel: a horizontal bar showing the colour wheel 0…1 at the current effective `sat` (using the shader's `hsv2rgb`, ported to `shared/math.ts`), with:

- **Two handles**, the at-rest colours at the screen centre:
  - glow `G = hue − 0.2 × hueDepth`
  - core `C = hue + 0.3 × hueDepth` (reference depth 0.03, a typical line half-width)
- **Handle ↔ params, one-to-one:** `hueDepth = 2 × arc(G → C)` where `arc` is the signed shortest way round (−0.5…0.5, so hueDepth stays in −1…1); `hue = fract(G + 0.2 × hueDepth)`. Dragging one handle keeps the other in place; dragging the bar between them moves both (changes `hue` only). Each drag sends `setParam` for `hue.base` and `hueDepth.base`. The handles wrap around the ends.
- **Live bracket:** the span on screen now, from live glow to live core, using the effective values from `meters.values` (hue, hueDepth, thickness) and a new `hueOffset` field in `MetersMsg`:
  - live glow = `hue_eff + hueOffset − 0.2 × hueDepth_eff`
  - live core = `hue_eff + hueOffset + 10 × clamp(0.03 + thickness_eff, 0, 0.1) × hueDepth_eff`
  
  It stretches on kicks (thickness), slides with autopilot drift and jumps with hue jumps. Capped at one full turn.
- `hueSpace` is not drawn on the strip (it varies across the screen); its row stays as is.

### 7.3 The rows

The `hue` and `hueDepth` rows **stay**, under the strip: they carry react, band, thr and lock, and the base sliders remain as fine control. The strip and the rows show the same state.

## 8. Protocol and state summary

```ts
// Look
v: 2
env: Record<EnvGroup, Env>
// Session
zoomStop: boolean      // default true
ambient: boolean       // default false
// Model
ambientStash: { react: Partial<Record<ParamId, { react: number; band: Band }>>; env: Partial<Record<EnvGroup, Env>> } | null   // also in localStorage `ferro.ambient.v1`
// ParamDef
reactScale?: number    // zoom: 0.5
// Control → Display
{ t: 'setEnv', group, key, value }
{ t: 'cmd', name: 'ambient' }
{ t: 'setSession', key: 'zoomStop', value: boolean }
// MetersMsg additions
zones: { zoom: [number, number]; mirrorShift: [number, number] }
env: Record<EnvGroup, { level: number; stage: 0 | 1 | 2 | 3 }>
hueOffset: number
```

## 9. Tests (vitest, written first)

- **sdf:** `inkRadius` of a known disc and of a blank cell.
- **reach:** fill grows with zoom and with mirrorShift; mirror shift is ignored without a mirror; tilt raises it; the limit found by bisection gives `fill = 1` within 1e-3; a wider window never gives a lower zoom limit than a square one.
- **modulation / stop:** with the stop on, sound never raises zoom past the limit; with the hand past the limit the value equals the hand value; negative react still pulls in; stop off = today's values.
- **envelope:** neutral settings return the input exactly for any `dt`; a step input rises with `attack`, sags to `sustain`, tails with `release`; a second hit inside the tail peaks lower than the first and a hit after a long quiet peaks the same; results are the same at 30 and 120 fps within 2%.
- **state / presets:** a v1 Look migrates with the same zoom push at its base (within 1%); missing `env` → neutral; `lerpLook` endpoints exact with env; randomize and mutate leave env alone; reset restores neutral.
- **store / ambient:** on zeroes exactly the low, beat and high reacts and sets the envelopes; off restores untouched ones and keeps edited ones, and skips a param whose band changed; recall and reset while on come out transformed; a group reset while on keeps the other groups' stash, and off still restores them; undo while on keeps a hand re-added reaction and calms a pre-ambient entry; randomize while on leaves those reacts at 0; the stash survives a reload and a corrupt stored stash is ignored; the stash never appears in saved presets or state messages' presets.
- **colour:** handles → params → handles round-trips; hueDepth stays in range for every handle pair; dragging one handle leaves the other's colour unchanged.

## 10. Build order

One piece at a time, each with its `SPEC.md` amendment, tests, `npm run check`, `npm run lint`, a look in the running app with `?src=synth`, and a `/gandalf` pass before its commit:

1. Zoom limits (4)
2. Envelope (5)
3. Ambient (6) — needs 2
4. Colour strip (7)

`SPEC.md` gets a new milestone note for a live test of all four with an ambient track and a techno track.

## 11. Left to the builder

- Exact pixel sizes, colours and CSS of the zones, the envelope editor and the strip, within the rules above (quiet zones, yellow markers, the curve drawn by the real function).
- Closed form instead of bisection for the limits, if simpler.
- How the envelope editor scales time inside each section.
- Where exactly the Ambient and Stop controls sit in the Performance block.

## 12. Calls made by Claude, for Carl to check

- Zoom becomes a log slider (each step feels like the same amount of zoom).
- The stop also holds back autopilot drift and mirror shift, not only the kick.
- Glow counts as "touching" at 8% brightness.
- The zones use a circle around the shape, so they err on the safe side.
- Envelope settings are saved in presets; Randomize and Mutate leave them alone.
- Refilling the charge takes at least as long as the tail.
- Ambient setting: attack 0.3 s, sustain 50%, decay 2 s, release 4 s.
- While Ambient is lit, recalled presets and Reset come out calmed; only the button leaves Ambient. Ambient survives a Display reload.
- The stop is on by default and trims the top of the kick slightly on the three biggest shapes.
- Randomize and Mutate give zoom half the reaction of other sliders, because zoom now has a much wider range.
- The `hue` and `hueDepth` rows stay under the strip.
- Ambient key: **A**.
