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

## Show day

```sh
npm run build && npm run preview
chrome --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding http://localhost:4173/
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

**Tooling**
- TypeScript is pinned to 6.0, because typescript-eslint does not support 7 yet.

## Not verified

- **Rendering:** checked in headless Chrome (SwiftShader) only. The shader compiles, `/?src=synth` renders the placeholder motifs, and no console errors appear. Not yet seen: real-GPU frame rate, the morphs over time, and the reaction to music.
- **Audio:** the Web Audio paths (`input.ts`, `analyser.ts`) are only type-checked. Line-in, file playback and the synth have not been heard or measured.
- **Thresholds:** the default `floorDb` (−60 dB) is a guess until M1.
