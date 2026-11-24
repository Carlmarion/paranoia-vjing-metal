# FERRO

Live, sound-reactive visuals: hand-drawn Lisbon door-ironwork motifs, rendered as glowing lines on black, melting from one motif into the next. `SPEC.md` is the source of truth.

## Install

```sh
npm i
python3 -m venv .venv && .venv/bin/pip install -r tools/requirements.txt
```

Needs Node ≥ 20 and Python ≥ 3.10.

## Bake the motifs

Drawings go in `art/png/01.png … 12.png` (rules in SPEC B2.1). Then:

```sh
npm run bake
```

With no PNG in `art/png/`, the bake uses `art/placeholders/` (regenerate those with `.venv/bin/python tools/make_placeholders.py`). The bake prints warnings but never stops on them. Output goes to `public/sdf/` and is committed.

## Run

```sh
npm run dev                         # http://localhost:5173
```

| URL | What |
|---|---|
| `/?src=synth` | Built-in 126 BPM test signal, no audio file needed |
| `/?src=file&f=set.mp3` | Loops `public/test-audio/set.mp3` (gitignored) through the analysis and the speakers |
| `/` | Line-in (the Focusrite). Pick the device in the dashboard's Calibration panel |
| `/control.html` | The dashboard, in a second window |

Other query params: `?seed=<n>` (default: today as YYYYMMDD), `?scale=0.75` (render scale).

Click or press a key once in the Display window to start the audio. That first press does nothing else. `D` shows the debug overlay (meters, raw dB, BPM, sequencer, soak-log download).

## Drawing tool

In the dashboard, press **Draw** (or `P`). The modal always opens in not-live mode.

- One round brush, the thick placeholder weight (100 px at 2048). `E` eraser, `B` brush.
- Symmetry: `free · X · Y · XY · R4 · R6 · R8` (`M` cycles). One hand stroke draws every copy; undo removes them together.
- Ghost: a faint shape under the canvas to trace over. "current" follows the projector.
- `Z` undo, `Shift+Z` redo. Closing (`Esc`, Close, Save) always saves a non-empty drawing; clear the canvas first to leave without saving.
- **LIVE** (`L`): the projector melts into your drawing and follows the mouse. **Finish** keeps it on screen and turns auto-advance off: restart the flow by hand. If the dashboard closes while live, the projector finishes on its own after 3 s.
- Tiles: the checkbox keeps a shape in or out of random choice. Drawn shapes have edit ✎, duplicate ⧉, draw in ▶ (replays the drawing stroke by stroke; from blackout it appears on black), PNG ⤓ and delete ✕.
- Drawn shapes live in this Chrome profile (IndexedDB). **Export shapes** saves them to JSON; a tile's PNG goes in `art/png/` to bake it for good.

## Live controls

- **Zoom zones:** the zoom and mirror-shift sliders are coloured green, orange (the glow touches the window edge), red (the line does). **Zoom stop** (on by default) keeps the kick and the autopilot from pushing past red; your hand is never limited.
- **Envelopes:** the small curve in the shape, line and colour headers opens an attack / sustain / release editor. A = how fast an effect rises, S = how far it sags while the sound goes on (fatigue), R = how long it lingers. Each trigger draws a thin line along the curve; `hits/s` shows how often the group fires.
- **Ambient** (`A`): calms everything driven by the kick, the beat and the highs over 5 s and lengthens the tails. Re-add reactions by hand; `A` again gives the rest back. Survives a Display reload.
- **Colour strip** (top of the colour panel): drag **glow** and **core** to set the two at-rest colours; drag between them to move both. The bright bracket shows the colours on screen right now.

## Show day

`npm run preview` serves on **5173**, the same address as `npm run dev`, so the presets, calibration and drawn shapes made during the week are there on the night. Stop `npm run dev` first (both use the port).

```sh
npm run build && npm run preview
chrome --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding http://localhost:5173/
```

The full runbook is in SPEC D4.

## Checks

```sh
npm run check    # tsc + vitest
npm run lint
```

## Decisions

These are choices the spec left open, or interpretations made while building.

**Bake**
- Placeholder files are grouped by design: 01–03 ring + cross, 04–06 C-scrolls, 07–09 fan, 10–12 lattice, each thin (40 px), medium (70 px) and thick (100 px).
- The thin-stroke check is a morphological opening built from distance transforms. It uses a disk of 39 px diameter, so strokes drawn at 40 px pass and strokes of 38 px or less are flagged. A literal `binary_opening` took about 4 s per image.
- The centroid is stored as `[x, y]` from the top-left, in 0–1. The grey-pixel check runs before any resize. A blank image gets a warning and a constant SDF. Hard errors (exit 1) are limited to: no PNGs, more than 16 PNGs, or a `--cell` that doesn't divide 2048.

**Audio**
- An onset also needs `flux > mean × (1 + 8/3 × onsetK)`, which is ×5 at the default `onsetK`. Without it, white noise produced about 120 onsets/min. With it, noise gives about 3/min and a 126 BPM kick still gives 126/min. The condition scales with `onsetK`, so "lower `onsetK`" still means "more beats".
- `levelDb` and `clip` are measured before `inputGain`, for gain staging on the Focusrite. `rawDb` is measured after it, because that is what `floorDb` is compared with.
- The virtual beat clock (one beat every 0.5 s in silence) lives in the sequencer, not in the DSP.
- The synth source plays silently: it feeds the analyser only. The file source also plays on the speakers.

**Sequencer and presets**
- A morph outputs exactly 0 on its first frame and exactly 1 on its landing frame.
- Melt hold entered during HOLD picks B with the normal target rule and starts at 0.
- `frozen` records commands but doesn't advance anything until it is lifted.
- `queued` is used by `next` and auto-advance, and ignored by `random` and `goto`.
- Crossfades always aim at the live Look, so slider edits during a fade land in the target.
- Randomize changes options only when it runs on all groups. Reset keeps lock flags. Mutate includes `brightness` and clamps hue.
- Saving to a full bank without naming a slot does nothing.
- `public/presets/default.json` stores partial Looks: anything a preset leaves out comes from the table defaults.

**Rendering**
- GLSL ES has no `##` token pasting, so `params.ts` emits one macro per param (`#define P_ZOOM uP[0]`). SPEC B4.2 and B5 are amended to match.
- The warp and spike phases are never wrapped, because a wrap made the shape jump. The shader hash is an integer hash, which stays exact however large the phases grow. The wave phase wraps at 1000. SPEC B4.3 is amended to match.
- Grain uses a per-frame offset of `(127, 311) × frame`, so the noise doesn't drift diagonally.

**Drawing tool (B12)**
- `strokes.ts`, `sdf.ts` and `raster.ts` are in `src/shared/`: the Control (modal, ghost, PNG) and the Display (bake worker, thumbnails) use the same code.
- Infrastructure is split out of `library.ts` so it is tested with fakes: `baker.ts` (one worker per purpose, the newest request per key replaces a waiting one), `shapedb.ts` (IndexedDB). The dashboard side is `draw.ts` (modal), `shapes.ts` (grid), `shapeclient.ts` (stroke requests, baked ghosts, PNG).
- The distance transform skips rows and columns that are all ink or all empty; a worst-case 1024² ring bakes in about 46 ms in Node.
- Replay: the copies of one symmetric stroke grow together, as they were drawn. SPEC B12.6 is amended to match.
- `liveFinish` arriving after live already ended (the safety net fired first) is kept as a plain save, so a drawing is never lost.
- A deleted shape's layer is not reused until it has been cleared (it stays visible until the projector moves away), so `free` also counts those layers as taken.
- Escape, Close and Save do the same thing, by the closing rules: save (or finish when live) and close.

**Tooling**
- TypeScript is pinned to 6.0, because typescript-eslint does not support 7 yet.

## Not verified

- **Rendering:** checked in headless Chrome (SwiftShader) only. The shader compiles, `/?src=synth` renders the placeholder motifs, and no console errors appear. Not yet seen: real-GPU frame rate, the morphs over time, and the reaction to music.
- **Audio:** the Web Audio paths (`input.ts`, `analyser.ts`) are only type-checked. Line-in, file playback and the synth have not been heard or measured.
- **Thresholds:** the default `floorDb` (−60 dB) is a guess until M1.
- **Drawing tool:** driven in headless Chrome (SwiftShader) only: modal, R6 symmetry, undo/redo per group, live melt into the drawing, mid-stroke updates, Finish, edit and re-save, the safety net, and replay from blackout. Not yet felt with a real mouse, not measured on the show laptop: the bake budget (≤ 60 ms) in the worker including the canvas raster, and the projector's fps while drawing live.
