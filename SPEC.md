# FERRO — live sound-reactive visuals

Spec v2.1, 12 Nov 2026. Supersedes `party-visuals-spec.md`. The repo `paranoia-vjing-metal` is the project root (the `ferro/` folder in B1).
Show: **Thu 19 Nov 2026**. Feature freeze: **Mon 16 Nov, evening**.

**How to use this file**
- Parts A–C are for the building agent. Build the whole project in one pass, in the order of section C1, without asking questions. Every decision is already made here; where something is truly unspecified, choose the simplest option and list it in `README.md` under "Decisions".
- Part D is for Carl: what to test, when, what to look at, which knob fixes which symptom.

---

# PART A — Product

## A1. What it is

A browser app that renders 10–12 hand-drawn Lisbon door-ironwork motifs as flat, vivid, glowing line shapes on black, and **melts** continuously from one motif into the next. The in-between shapes of the melt are the main attraction. Sound from the DJ mixer modulates every effect. The piece runs alone for hours; a mouse-driven dashboard on the laptop screen lets Carl push thresholds and amounts, randomize, and save sweet spots as presets during the show.

## A2. Two windows, one machine

| Window | URL | Screen | Role |
|---|---|---|---|
| **Display** | `/` | Projector (HDMI, extended desktop) | Owns ALL state, audio, autopilot and rendering. Runs correctly with no dashboard open. |
| **Control** | `/control.html` | Laptop screen | Remote control. Holds no state of its own. Can be closed and reopened at any time. |

They talk over `BroadcastChannel('ferro')` (same origin, same Chrome profile, no server). A second computer is out of scope; keep the channel behind a small `Transport` interface so a WebSocket could replace it later.

## A3. Hard constraints

- Zero runtime dependencies. Raw WebGL2, Web Audio, DOM. No three.js, no UI library.
- One fragment shader, one pass, exactly 2 texture samples per pixel. No raymarching, no 3D, no bevel lighting.
- 60 fps at 1920×1080 on integrated graphics.
- No network at runtime.
- Chrome only (latest stable).
- Flash safety: by default, no full-screen luminance or hue jump more often than 3 times per second (see B6.3, B6.4 and B7.5). `calib.refractoryMs` can go below the cap; that is Carl's call during testing.

## A4. Stack (exact)

| Layer | Tool | Notes |
|---|---|---|
| Runtime | Chrome, WebGL2, Web Audio API, BroadcastChannel, Screen Wake Lock | — |
| Language | TypeScript, strict mode | — |
| Build | Vite, multi-page (`index.html`, `control.html`) | Latest stable at install time |
| Tests | Vitest | Pure logic only |
| Bake | Python ≥ 3.10 with `numpy`, `scipy`, `Pillow` | In `.venv` |
| Node | ≥ 20 | — |
| Drawing | GIMP | 2048×2048 black-on-white PNG |

`package.json` scripts: `dev`, `build`, `preview`, `test`, `check` (= `tsc --noEmit && vitest run`), `bake` (runs the Python bake on `art/png`, or on `art/placeholders` if `art/png` is empty).

## A5. Hardware chain

```
DJ mixer REC/BOOTH out → cable → Focusrite inputs 1–2 (set to LINE, not INST)
  → USB → laptop → Chrome (Display window) → HDMI → projector
```

---

# PART B — Technical spec

## B1. Repo layout

```
ferro/
  SPEC.md  README.md
  package.json  tsconfig.json  vite.config.ts  .gitignore
  index.html            Display page
  control.html          Control page
  art/
    png/                real motifs: 01.png … 12.png
    placeholders/       generated test motifs (committed)
  tools/
    requirements.txt
    bake_sdf.py
    make_placeholders.py
  public/
    sdf/                atlas.bin, manifest.json, thumbs/NN.png  (generated, committed)
    presets/default.json
    test-audio/         local DJ-set excerpts (gitignored)
  src/
    shared/
      params.ts         THE param table (single source of truth)
      state.ts          types, defaults, serialise, migrate
      protocol.ts       message types + Transport (BroadcastChannel)
      math.ts           clamp, lerp, smoothstep, mulberry32, valueNoise1D, gaussian
    display/
      main.ts           boot, frame loop, keys, wake lock, context loss
      gl.ts             program, fullscreen triangle, R16F array texture
      shader.vert
      shader.frag
      audio/
        input.ts        sources: line-in, file, synth
        dsp.ts          pure functions (bands, envelopes, autogain, onset, bpm)
        analyser.ts     AnalyserNode → dsp → AudioFrame
      modulation.ts     effective value of every param, phase integration
      sequencer.ts      motif state machine
      autopilot.ts      drift time, hue jumps, preset cycle
      presets.ts        store, crossfade, randomize, mutate, undo
      store.ts          owns State; applies messages; broadcasts
      debug.ts          on-screen overlay
    control/
      main.ts           boot, transport, render loop
      ui.ts             DOM builders
      control.css
  tests/
    dsp.test.ts  modulation.test.ts  sequencer.test.ts  presets.test.ts  store.test.ts
```

## B2. Motif assets

### B2.1 Drawing contract (input)
- Square PNG, 2048×2048 preferred (any square size accepted and rescaled). Grayscale, flattened.
- Ink is black (< 128), background white.
- Motif inside the central 80%. Strokes ≥ 40 px, gaps ≥ 30 px, round caps and joins.
- Ink coverage 10–25%, and within ±25% of the median coverage of the whole set (similar ink weight across motifs keeps every melt pair balanced). Centroid within 5% of the centre.

### B2.2 `tools/bake_sdf.py`
```
python tools/bake_sdf.py <in_dir> public/sdf [--cell 512]
```
1. Read PNGs sorted by filename. Resize to 2048×2048 (Lanczos) if needed. `ink = pixel < 128`.
2. `d_px = edt(~ink) − edt(ink)` using `scipy.ndimage.distance_transform_edt`. Negative inside the ink.
3. Convert to **motif units**: the cell spans −1…+1, so `d = d_px / 1024`. Do NOT clamp.
4. Downsample to `cell × cell` by block mean.
5. Write `atlas.bin`: little-endian **float16**, shape `[count][cell][cell]`, row 0 = top of the image.
6. Write `thumbs/NN.png`: 160×160, white ink on transparent.
7. Write `manifest.json`:
```json
{ "version": 1, "count": 12, "cell": 512, "dtype": "float16", "origin": "top-left",
  "motifs": [ { "id": 0, "file": "01.png", "coverage": 0.27, "centroid": [0.5, 0.5], "warnings": [] } ] }
```
8. Validate and print warnings (also stored per motif): coverage outside 0.10–0.25; coverage more than ±25% from the set's median; ink inside the outer 10% margin; centroid off by more than 0.05; strokes thinner than 40 px (`scipy.ndimage.binary_opening(ink, structure=disk of diameter 40)` removes more than 2% of the ink); grey pixels (values between 16 and 239) above 1% of the image.

Max 16 motifs. Must finish in under 60 s for 12.

### B2.3 `tools/make_placeholders.py`
Generates 12 motifs into `art/placeholders/` with Pillow, obeying B2.1 except where stroke weight is the variable: 4 designs, (1) ring with a cross, (2) four C-scrolls in a square frame, (3) half-circle fan with 7 radial bars, (4) diamond lattice in a frame, each drawn at 3 round-capped stroke weights, thin (40 px), medium (70 px) and thick (100 px). Bake warnings on some of them are expected: they exist to test how melts behave between different ink weights. Run it and the bake during the build so the app works before any real drawing exists.

### B2.4 Texture
Upload as one `TEXTURE_2D_ARRAY`:
```ts
gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R16F, cell, cell, count, 0, gl.RED, gl.HALF_FLOAT, new Uint16Array(buffer));
```
`LINEAR` min and mag, `CLAMP_TO_EDGE`, no mipmaps. (Linear filtering of half-float textures is core in WebGL2; do not use R32F, which needs an extension to filter.)

## B3. State model (`src/shared/state.ts`)

```ts
type Band = 'none' | 'low' | 'mid' | 'high' | 'energy' | 'beat';

interface ParamState { base: number; react: number; band: Band; thr: number; lock: boolean; }

// A Look is what a preset stores.
interface Look {
  params: Record<ParamId, ParamState>;
  options: {
    meltMode: 0 | 1 | 2;          // 0 blend, 1 fuse, 2 spatial
    mirrorX: boolean; mirrorY: boolean;
    hueJumpEvery: 0 | 1 | 2 | 4 | 8 | 16;   // beats; 0 = off
    hueJumpAmt: number;           // 0…0.5 turns
    holdBeats: 16 | 32 | 64 | 128;
    morphBeats: 4 | 8 | 16 | 32 | 64;
  };
}

// Session: live performance state. Never stored in presets.
interface Session {
  autopilot: number;      // 0…1, default 0.5
  reactMaster: number;    // 0…2, default 1
  xfade: number;          // seconds, 0…8, default 3
  autoAdvance: boolean;   // default true
  order: 'random' | 'sequential';
  presetCycleMin: 0 | 2 | 5 | 10;   // auto-recall a random preset every N minutes; 0 = off
  frozen: boolean; fallback: boolean; blackout: boolean;
  meltHold: boolean; holdPos: number;   // manual melt scrub, 0…1
  queued: number | null;                // motif queued as next
}

// Calibration: venue-dependent. Never stored in presets.
interface Calib {
  deviceId: string | null;
  inputGain: number;   // 0…4, default 1
  onsetK: number;      // 0.5…4, default 1.5
  smooth: number;      // 0.25…4, default 1
  floorDb: number;     // −90…−30, default −60: auto-gain floor and silence threshold (B6.3)
  gainDecay: number;   // 4…60 s, default 20: auto-gain peak decay (B6.3)
  refractoryMs: number; // 150…600, default 340: minimum gap between onsets (B6.3)
}

interface Preset { name: string; savedAt: number; look: Look; }

interface State { look: Look; session: Session; calib: Calib; presets: (Preset | null)[]; /* 16 slots */ seed: number; }
```

Persistence (all `localStorage` access in try/catch; the app must work with storage unavailable):
- `ferro.presets.v1` → presets array. If absent, load `public/presets/default.json`.
- `ferro.calib.v1` → Calib.
- `ferro.look.v1` → last Look, saved at most once per second, restored at boot.

## B4. Parameters (`src/shared/params.ts`)

One table generates: the shader `#define` indices, the default Look, the dashboard rows, and the randomize ranges. Adding a param means adding one row and using `P(NAME)` in the shader.

### B4.1 Modulation formula (the threshold control)

For each param, every frame:
```
u_base = toNorm(base)                                  // 0…1 on the param's scale
gate   = thr >= 1 ? 0 : max(0, bandValue − thr) / (1 − thr)   // bandValue in 0…1; band 'none' → 0
drift  = lock ? 0 : session.autopilot × driftAmp × (valueNoise1D(i × 37.1 + driftT / driftPeriod) × 2 − 1)
u      = u_base + drift + session.reactMaster × react × gate
value  = fromNorm(scale == 'wrap' ? fract(u) : clamp01(u))
```
- `react` ∈ −1…+1: at +1 a full-scale band swings the param across its whole range.
- `thr` ∈ 0…0.95: the band level below which nothing happens. This is the threshold knob.
- `scale`: `lin`, `log` (`fromNorm(u) = min × (max/min)^u`), or `wrap` (hue).
- `driftT` advances at `(0.5 + energy) × dt`. `frozen` stops it.
- `lock` excludes a param from drift, randomize and mutate.
- A `—` in the driftPeriod column means the param has no drift (its driftAmp is 0).
- `bandValue` for `beat` is the beat pulse (B6.4); for `energy` it is `energy30`.

### B4.2 The table

Units: motif space, the cell is −1…+1. A typical stroke half-width is 0.02–0.05.

| id | group | scale | min | max | default | band | react | thr | driftAmp | driftPeriod s | rand range |
|---|---|---|---|---|---|---|---|---|---|---|---|
| zoom | shape | lin | 0.5 | 1.4 | 0.85 | low | 0.06 | 0.15 | 0.04 | 120 | 0.7–1.0 |
| rotation | shape | lin | −0.25 | 0.25 | 0 | none | 0 | 0 | 0.15 | 240 | −0.1–0.1 |
| tiltX | shape | lin | −0.4 | 0.4 | 0 | none | 0 | 0 | 0.2 | 90 | −0.2–0.2 |
| tiltY | shape | lin | −0.4 | 0.4 | 0 | none | 0 | 0 | 0.2 | 110 | −0.2–0.2 |
| mirrorShift | shape | lin | 0 | 0.6 | 0 | none | 0 | 0 | 0.1 | 150 | 0–0.4 |
| warpAmt | shape | lin | 0 | 0.15 | 0.01 | mid | 0.3 | 0.2 | 0.1 | 60 | 0–0.06 |
| warpScale | shape | log | 0.5 | 8 | 2 | none | 0 | 0 | 0.15 | 200 | 1–5 |
| warpSpeed | shape | lin | 0 | 1 | 0.15 | none | 0 | 0 | 0 | — | 0.05–0.5 |
| meltK | melt | log | 0.01 | 0.3 | 0.08 | none | 0 | 0 | 0.1 | 130 | 0.03–0.2 |
| meltNoise | melt | lin | 0 | 2 | 0.8 | none | 0 | 0 | 0.1 | 180 | 0.2–1.5 |
| meltNoiseScale | melt | log | 0.5 | 8 | 2.5 | none | 0 | 0 | 0 | — | 1–6 |
| linger | melt | lin | 0 | 1 | 0.5 | none | 0 | 0 | 0 | — | 0–1 |
| thickness | line | lin | −0.02 | 0.06 | 0 | low | 0.25 | 0.1 | 0.08 | 75 | −0.01–0.02 |
| spikeAmp | line | lin | 0 | 0.08 | 0 | high | 0.5 | 0.3 | 0.1 | 50 | 0–0.03 |
| spikeFreq | line | log | 4 | 80 | 28 | none | 0 | 0 | 0.1 | 170 | 10–60 |
| spikeSharp | line | lin | 1 | 8 | 4 | none | 0 | 0 | 0 | — | 2–6 |
| spikeSpeed | line | lin | 0 | 2 | 0.3 | none | 0 | 0 | 0 | — | 0.1–1 |
| waveAmt | inner | lin | 0 | 1 | 0.4 | mid | 0.3 | 0.2 | 0.15 | 80 | 0.1–0.9 |
| waveFreq | inner | log | 5 | 400 | 40 | none | 0 | 0 | 0.15 | 210 | 10–300 |
| waveSpeed | inner | lin | −4 | 4 | 0.5 | energy | 0.2 | 0 | 0.1 | 140 | −2–2 |
| waveSharp | inner | lin | 0 | 1 | 0.2 | none | 0 | 0 | 0.1 | 100 | 0–0.8 |
| ripple | inner | lin | 0 | 1 | 0 | none | 0 | 0 | 0.1 | 160 | 0–0.5 |
| hue | colour | wrap | 0 | 1 | 0.55 | none | 0 | 0 | 0.5 | 240 | 0–1 |
| hueDepth | colour | lin | −1 | 1 | 0.35 | none | 0 | 0 | 0.1 | 190 | −0.8–0.8 |
| hueSpace | colour | lin | −1 | 1 | 0.1 | none | 0 | 0 | 0.1 | 220 | −0.5–0.5 |
| sat | colour | lin | 0 | 1 | 0.9 | none | 0 | 0 | 0 | — | 0.7–1 |
| brightness | colour | lin | 0.25 | 1.5 | 1 | beat | 0.15 | 0 | 0 | — | not randomized |
| glow | colour | lin | 0 | 1 | 0.15 | low | 0.3 | 0.2 | 0.1 | 85 | 0–0.5 |
| glowWidth | colour | log | 0.02 | 0.4 | 0.12 | none | 0 | 0 | 0.1 | 125 | 0.04–0.3 |
| grain | colour | lin | 0 | 0.3 | 0.04 | high | 0.3 | 0.3 | 0 | — | 0–0.12 |

30 params → `uniform float uP[30];`. `params.ts` exports the GLSL header (`#define P_ZOOM 0` …, `#define P(n) uP[P_##n]`) that `gl.ts` prepends to the fragment source.

`waveFreq` is in cycles per motif unit. At 1080p the Nyquist limit is about 230, so values above that alias on purpose: this is the moiré effect.

### B4.3 Phases
A speed param that changes over time must not be multiplied by time (it jumps). `modulation.ts` integrates three phases each frame and uploads them: `uWarpPhase += warpSpeed × dt`, `uSpikePhase += spikeSpeed × dt`, `uWavePhase += waveSpeed × dt`. Wrap each at 1000.

## B5. Shader (`shader.frag`, `#version 300 es`)

```glsl
precision highp float; precision highp sampler2DArray;
uniform sampler2DArray uSdf;
uniform float uP[30];
uniform vec2  uRes;
uniform float uMotifA, uMotifB, uMorphT;      // layer indices, eased morph 0…1
uniform int   uMeltMode; uniform bool uMirrorX, uMirrorY;
uniform float uWarpPhase, uSpikePhase, uWavePhase, uHueOffset, uMaster, uFrame;
```

Pipeline, in this order:

```glsl
// 1. Screen space: short side spans −1…+1
vec2 s = (gl_FragCoord.xy - 0.5 * uRes) / (0.5 * min(uRes.x, uRes.y));
vec2 p = s;

// 2. Tilt (perspective skew), mirror, rotate, zoom
p /= max(1.0 + P(TILTX) * p.x + P(TILTY) * p.y, 0.25);
if (uMirrorX) p.x = abs(p.x) - P(MIRRORSHIFT);
if (uMirrorY) p.y = abs(p.y) - P(MIRRORSHIFT);
p = rot(P(ROTATION) * TAU) * p / P(ZOOM);

// 3. Warp (2-octave value-noise fbm, output 0…1)
vec2 q = p * P(WARPSCALE) + uWarpPhase;
p += P(WARPAMT) * (vec2(fbm(q), fbm(q + 17.3)) * 2.0 - 1.0);

// 4. Sample both motifs. Keep a valid distance outside the cell.
float sdf(vec2 p, float layer) {
  vec2 c = clamp(p, -1.0, 1.0);
  vec2 uv = vec2(c.x, -c.y) * 0.5 + 0.5;          // atlas origin is top-left
  return texture(uSdf, vec3(uv, layer)).r + length(p - c);
}

// 5. Melt
float t = uMorphT;
if (uMeltMode == 2)
  t = clamp(t * (1.0 + P(MELTNOISE)) - P(MELTNOISE) * fbm(p * P(MELTNOISESCALE)), 0.0, 1.0);
float d = mix(dA, dB, t);                           // modes 0 and 2
if (uMeltMode == 1) {                               // fuse: A → smooth union → B
  float dU = smin(dA, dB, P(MELTK));
  d = t < 0.5 ? mix(dA, dU, smoothstep(0.0, 0.5, t)) : mix(dU, dB, smoothstep(0.5, 1.0, t));
}
// smin(a,b,k): float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25;

// 6. Line: thickness, spikes
d -= P(THICKNESS);
d -= P(SPIKEAMP) * pow(vnoise(p * P(SPIKEFREQ) + uSpikePhase), P(SPIKESHARP));

// 7. Mask (never call smoothstep with edge0 > edge1)
float aa = clamp(fwidth(d), 1e-4, 0.02);
float mask = 1.0 - smoothstep(-aa, aa, d);

// 8. Inner waves, travelling along the depth of the line
float wv = 0.5 + 0.5 * sin(TAU * (d * P(WAVEFREQ) - uWavePhase));
float e  = mix(0.5, 0.01, P(WAVESHARP));
wv = smoothstep(0.5 - e, 0.5 + e, wv);
float inner = mix(1.0, wv, P(WAVEAMT));

// 9. Outer glow, optionally rippled by the same waves
float g = exp(-max(d, 0.0) / P(GLOWWIDTH)) * P(GLOW) * mix(1.0, wv, P(RIPPLE));

// 10. Colour
float h = P(HUE) + uHueOffset - clamp(d, -0.1, 0.02) * 10.0 * P(HUEDEPTH) + length(s) * 0.5 * P(HUESPACE);
vec3 rgb = hsv2rgb(vec3(fract(h), P(SAT), 1.0));
float lum = mask * inner + (1.0 - mask) * g;
vec3 col = rgb * lum * P(BRIGHTNESS);

// 11. Grain (keeps the background black), master fade
col += (hash(gl_FragCoord.xy + uFrame) - 0.5) * P(GRAIN) * (0.15 + lum);
fragColor = vec4(clamp(col, 0.0, 1.0) * uMaster, 1.0);
```

Notes:
- Noise is hash-based, no textures. `vnoise` and `fbm` return 0…1.
- Draw one fullscreen triangle. Canvas size = CSS size × `min(devicePixelRatio, 1)` × `?scale=` (default 1).
- On shader compile or link failure: keep the previous program, show the error in the debug overlay, and send it to the Control window. Never show a blank screen.
- `uMaster` fades 1 → 0 over 1 s on blackout, and back.

## B6. Audio (`src/display/audio/`)

### B6.1 Sources (`input.ts`)
- `?src=in` (default): line-in.
```ts
navigator.mediaDevices.getUserMedia({ audio: {
  deviceId: calib.deviceId ? { exact: calib.deviceId } : undefined,
  echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 } })
```
  All three processing flags must be false, or Chrome flattens the dynamics. Do not connect the input to `destination` (no playback, no feedback).
- `?src=file&f=<name>`: loops `public/test-audio/<name>` through the same analyser AND to the speakers.
- `?src=synth`: built-in generator: kick (sine 55 Hz, 120 ms decay) on every beat at 126 BPM, noise hat on off-beats, a 220 Hz pad that fades in and out over 16 s. Lets the whole app be tested with no audio file.
- The AudioContext starts on the first click or keypress in the Display window.
- Device list via `enumerateDevices()` is sent to the Control window; selecting a device restarts the input.

### B6.2 Analyser
`AnalyserNode`, `fftSize = 2048`, `smoothingTimeConstant = 0`. It down-mixes to mono itself. Each frame: `getFloatFrequencyData` (dB) → `mag = 10^(dB/20) × calib.inputGain`; `getFloatTimeDomainData` → input peak for the level meter. Bin width = `sampleRate / 2048`; read `sampleRate` from the context, never assume it.

### B6.3 `dsp.ts` (pure, unit-tested, all time constants use `dt`)
- **Bands:** RMS of `mag` over bins in low 30–150 Hz, mid 150–2500 Hz, high 2500–12000 Hz, and all 30–12000 Hz.
- **Auto-gain per band:** `peak = max(raw, peak × exp(−dt / calib.gainDecay))`, `peak = max(peak, floor)` with `floor = 10^(calib.floorDb / 20)`, `norm = min(raw / peak, 1)`. The floor stops silence from being amplified into noise. Both values are set against real signal in M1.
- **Envelope per band:** `y += (x − y) × (1 − exp(−dt / τ))`, τ = attack when rising, release × `calib.smooth` when falling. Low 10 / 250 ms, mid 25 / 350 ms, high 5 / 150 ms.
- **Onset:** `flux = Σ max(0, mag_t − mag_{t−1})` over bins 30–200 Hz, divided by the low band's peak. Keep 1.5 s of flux history. Onset when `flux > mean + calib.onsetK × std` AND `flux > 0.05` AND at least `calib.refractoryMs` since the last onset (default 340 ms: tracks kicks up to 176 BPM and keeps beats under 3 per second).
- **BPM (display and morph timing only):** median of the last 12 inter-onset intervals, each folded into the single octave 0.375–0.75 s (80–160 BPM) by doubling or halving. Default 0.5 s when unknown.
- **energy30:** all-band RMS normalised by its own peak (decay 60 s), then EMA with τ = 30 s. Initial value 0.5.
- **silent:** all-band raw RMS below `floor` for 3 s.

### B6.4 Output
```ts
interface AudioFrame {
  low: number; mid: number; high: number; energy: number;   // 0…1
  beat: number;        // pulse: 1 at onset, × exp(−dt / 0.15) after
  onset: boolean; beatCount: number; beatPeriod: number;    // seconds
  silent: boolean; levelDb: number; clip: boolean;          // clip = time-domain peak > 0.98
  rawDb: [number, number, number, number];                   // low, mid, high, all: raw band RMS in dB, for calibration
}
```
At the default 340 ms refractory, beats are capped at 2.9 per second.

## B7. Sequencer and autopilot

### B7.1 Beat units
Everything counts in beats. A real onset is one beat. When `silent`, or no onset for 3 s, a virtual clock ticks one beat every 0.5 s. So the piece keeps moving in silence.

### B7.2 States
- **HOLD(A):** `remaining = holdBeats`, minus 1 per beat. At 0 (if `autoAdvance` and not `frozen` and not `meltHold`) → MORPH.
- **MORPH(A → B):** `progress += dt / (morphBeats × beatPeriod)`, with `beatPeriod` sampled when the morph starts. At 1 → A = B, HOLD.
- Target choice: `queued` if set; else `random` (seeded, never one of the last 3 shown; relax to "not the current" when count ≤ 4) or `sequential`.
- Eased value sent to the shader:
```
S(x)    = x² (3 − 2x)
smooth  = S(p)
plateau = p < 0.5 ? 0.5 × S(2p) : 0.5 + 0.5 × S(2p − 1)   // at rest at 0, 0.5 and 1: dwells on the in-between shape
uMorphT = mix(smooth, plateau, linger)
```
Both curves have zero speed at p = 0 and p = 1, so a morph starts and lands without a jolt. The mapping p → uMorphT is strictly increasing for every `linger`, so it can be inverted (B7.4).

### B7.3 Commands
`next`, `prev` (history stack of 32), `random`, `goto(i)` start a morph now. `queue(i)` only sets `queued`. If a morph is already running, the command is stored and the running morph is sped up to finish within 1 s; never pop.

### B7.4 Melt hold
`meltHold = true` pauses the sequencer and sets `uMorphT = holdPos` directly (no easing). If entered during HOLD, pick B first. Entering melt hold during a MORPH sets `holdPos` to the current `uMorphT`, so nothing jumps. Leaving melt hold resumes the morph at the progress `p` whose eased value equals `holdPos` (invert the curve of B7.2 by bisection, 20 iterations), so `uMorphT` stays continuous.

### B7.5 Autopilot (`autopilot.ts`)
- Advances `driftT` (B4.1).
- **Hue jumps:** every `hueJumpEvery` beats, `uHueOffset += hueJumpAmt` (instant). Minimum 400 ms between jumps.
- **Randomness:** one mulberry32 stream per subsystem (sequencer, autopilot, presets), each seeded from `seed` plus a fixed offset. Randomize and mutate never shift the sequencer's motif order.
- **Preset cycle:** every `presetCycleMin` minutes, recall a random non-empty preset (not the current one) with an 8 s crossfade.
- `frozen`: stops drift, sequencer, hue jumps and preset cycle. Audio reactivity continues.
- `fallback`: renders a constant safe Look (the table defaults, motif 0, `react` zero except zoom and brightness), ignoring the live Look without modifying it.

## B8. Presets, randomize, undo (`presets.ts`)

- **16 slots.** `save(slot?)` writes the current Look to the given slot, or the first empty one, named `HH:MM:SS`. `rename`, `delete`.
- **Recall** crossfades over `session.xfade` seconds: `base`, `react` and `thr` interpolate in normalised space (hue takes the shortest way round); `band`, `lock` and all `options` switch at the start.
- **Default Look options:** `meltMode` 1 (fuse), `mirrorX` false, `mirrorY` false, `hueJumpEvery` 0, `hueJumpAmt` 0.25, `holdBeats` 32, `morphBeats` 16.
- **Randomize(group?)** for every unlocked param (optionally only one group): `base` uniform in the rand range (log-uniform for log params); `react` uniform in 0…0.6, sign positive; `band` = table default with probability 0.5, else uniform among low, mid, high, beat, energy; `thr` uniform in 0…0.5. Options: `meltMode` uniform; `mirrorX`, `mirrorY` true with probability 0.25 each. Never touches `brightness`, `holdBeats`, `morphBeats`, `hueJumpEvery`.
- **Mutate:** for every unlocked param, `base_norm += N(0, 0.08)`, `react += N(0, 0.1)`, `thr += N(0, 0.05)`, all clamped. Options unchanged. This is the tool for walking around a sweet spot.
- **Reset(group?)**: back to table defaults.
- **Undo:** ring of 30 Looks, pushed before randomize, mutate, reset and recall. Undo crossfades over 1 s.
- Randomize and mutate also crossfade over `session.xfade`.
- **Export** downloads `ferro-presets-YYYYMMDD-HHMM.json`. **Import** validates and merges into empty slots.
- All randomness uses the seeded PRNG.

## B9. Protocol (`src/shared/protocol.ts`)

```ts
// Control → Display
{ t: 'hello' }
{ t: 'setParam', id: ParamId, field: 'base' | 'react' | 'band' | 'thr' | 'lock', value }
{ t: 'setOption', key, value }  { t: 'setSession', key, value }  { t: 'setCalib', key, value }
{ t: 'cmd', name: 'next' | 'prev' | 'random' | 'goto' | 'queue' | 'randomize' | 'mutate' | 'reset' | 'undo'
              | 'savePreset' | 'loadPreset' | 'deletePreset' | 'renamePreset' | 'importPresets', arg? }

// Display → Control
{ t: 'state', state: State, manifest, devices }                    // on hello, and ≤ 10×/s after changes
{ t: 'meters', audio: AudioFrame, values: number[30],              // effective param values, normalised
  motifA, motifB, morphT, holdRemaining, fps, error?: string }     // 20×/s; doubles as heartbeat
```
`store.ts` is a reducer `(State, message) → State`, unit-tested. The Display is the only writer. The Control never keeps a value it has not received back in a `state` message, except while a slider is being dragged.

## B10. Control dashboard (`control.html`)

Dark, low-luminance UI (the laptop must not light the room): background `#0b0b0d`, text `#9a9aa2`, one accent. Rows ≥ 28 px high. Mouse only.

**Top bar:** connection status (`DISPLAY OFFLINE` in red if no `meters` for 1 s) · fps · input level meter with clip LED · low, mid, high, energy meters · beat LED · BPM · buttons Freeze, Fallback, Blackout.

**Left column: shapes**
- Thumbnail grid. Current A = solid outline, morph target B = accent outline, queued = dashed.
- Click = queue. Double-click = go now. Buttons Prev, Next, Random.
- Morph progress bar and beats remaining in the hold.
- `autoAdvance` toggle, `order`, `holdBeats`, `morphBeats`.
- Melt mode (3 buttons), mirror X, mirror Y, hue jump every, hue jump amount.
- Melt hold toggle with a wide scrub slider (`holdPos`).

**Centre: one panel per group** (shape, melt, line, inner, colour). Header has Randomize, Mutate and Reset for that group. One row per param:

`label` · **base** slider · **react** slider (−1…+1, centre detent) · **band** select · **thr** slider · **lock** checkbox

- A moving tick on the base slider shows the live effective value from `meters.values`. This is the main feedback for tuning thresholds.
- A thin bar under the thr slider shows the chosen band's live level, so the threshold can be set against the signal.
- Double-click a slider = reset to default. Shift-drag = fine (×0.1). Mouse wheel = step.
- Slider input is sent at most once per animation frame.

**Right column: performance**
- 16 preset slots (click = recall, shift-click = overwrite, right-click = rename or delete). Save button.
- Randomize all, Mutate all, Undo, Reset all.
- Sliders: `autopilot`, `reactMaster`, `xfade`. Select: `presetCycleMin`.
- Export, Import.
- Collapsible **Calibration**: input device, `inputGain` (0…4), `onsetK` (0.5…4), `smooth` (0.25…4), `floorDb` (−90…−30), `gainDecay` (4…60 s), `refractoryMs` (150…600), and a live readout of `rawDb` per band.

**Keys** (both windows; the Control forwards them as commands). Keys are ignored while a text field has focus. In the Display, the keypress that starts the AudioContext does only that.

| Key | Action | Key | Action |
|---|---|---|---|
| Space | Next motif | R | Randomize all |
| ← / → | Prev / next | M | Mutate all |
| H | Melt hold | Z | Undo |
| F | Freeze | S | Save preset |
| B | Fallback | 1–9 | Recall preset |
| K | Blackout | D | Debug overlay (Display) |
| Enter | Fullscreen (Display) | | |

## B11. Display window (`index.html`)

- Boot: load manifest and atlas → compile shader → start the loop immediately with the virtual beat clock → show a small "click to start audio" hint until the AudioContext runs.
- `navigator.wakeLock.request('screen')`, re-requested on `visibilitychange`.
- Cursor hidden after 2 s without movement.
- `webglcontextlost`: `preventDefault()`, rebuild everything on `webglcontextrestored`.
- Debug overlay (D): meters, raw band levels in dB, beat flash, BPM, fps, sequencer state, seed, device name, last error.
- Soak log: every 60 s push `{ t, fpsAvg, fpsMin, heapMB, motif, beatCount }` to an array (max 600 entries); downloadable as JSON from the overlay.
- `?seed=<n>` sets the PRNG seed (default: the date as YYYYMMDD).

---

# PART C — Build instructions for the agent

## C1. Order

1. Scaffold: Vite multi-page, TypeScript strict, Vitest, scripts, `.gitignore`.
2. `tools/`: `make_placeholders.py`, `bake_sdf.py`. Run both. Commit `public/sdf/`.
3. `shared/`: `math.ts`, `params.ts`, `state.ts`, `protocol.ts`.
4. `dsp.ts` with tests first, then `input.ts` and `analyser.ts`.
5. `modulation.ts`, `sequencer.ts`, `autopilot.ts`, `presets.ts`, `store.ts`, each with tests first.
6. `gl.ts`, shaders, `display/main.ts`, `debug.ts`.
7. `control/`.
8. `public/presets/default.json`: 6 presets written by hand from the table (Calm, Pulse, Thorns, Moiré, Kaleido, Peak), each clearly different.
9. `README.md`: install, bake, run, show-day launch command, "Decisions", "Not verified".

## C2. Required unit tests

- **dsp:** envelope converges to within 5% at 30 fps and 144 fps; auto-gain output stays in 0…1 for input scaled ×0.01 and ×100; a synthetic 126 BPM kick train yields 126 ± 3 onsets per minute; a synthetic 190 BPM kick train never yields more than 3 onsets in any 1 s window; intervals of 0.25 s, 0.5 s and 1.0 s all fold to 0.5 s; white noise yields < 10 onsets per minute; silence sets `silent` after 3 s and keeps all bands at 0.
- **modulation:** `thr` gates correctly (band below thr → no change; band = 1 → full `react`); log and wrap scales; `lock` removes drift; output always inside min…max.
- **sequencer:** same seed + same beat stream → same motif sequence; no motif repeats within 3 transitions (count ≥ 5); in silence a morph still starts after `holdBeats × 0.5 s`; `uMorphT` is continuous: at 60 fps no frame changes it by more than 0.05, including when a command arrives during a morph and when melt hold is entered or left at any position; the eased curve has `uMorphT = 0.5` at `p = 0.5` for every `linger`, zero speed at `p = 0` and `p = 1`, and is strictly increasing; inverting it returns `p` within 1e-4.
- **presets:** save → export → import round-trip is identical; randomize and mutate never change locked params and never leave rand or min…max ranges; crossfade endpoints are exact; undo restores the previous Look; hue interpolates the short way.
- **store:** every message type; unknown messages are ignored; a corrupt `localStorage` value falls back to defaults.

## C3. Definition of done

- [ ] `npm run check` passes. `npm run build` succeeds with no warnings about missing assets.
- [ ] `npm run bake` produces `atlas.bin`, `manifest.json`, thumbs.
- [ ] `/?src=synth` renders the placeholder motifs melting, reacting to the synthetic kick, with no console errors.
- [ ] Closing and reopening `/control.html` does not disturb the Display.
- [ ] Every param in the table has a dashboard row and a visible effect.
- [ ] Zero runtime dependencies in `package.json`.

If a headless browser is available, use it to confirm the shader compiles and the page logs no errors. If not, say so under "Not verified" in the README. Do not claim visual results you have not seen.

## C4. Rules

- No features beyond this spec. No refactors for elegance.
- Comment the shader sections with the step numbers of B5.
- Keep every pure function free of DOM, GL and Web Audio so it can be tested.

---

# PART D — Carl's test and calibration plan

The agent builds; you test. Each milestone has a pass condition. Do not move on until it passes.

## D1. Timeline

| Day | Work | Your hours |
|---|---|---|
| Thu 12 | Launch the agent on this spec. M0. Draw motif 01 and bake it. | 2.5 |
| Fri 13 | Fix loop on whatever M0 exposed. M1 (audio). M2 (effect audit). | 4 |
| Sat 14 | Draw motifs 02–12. | 5 |
| Sun 15 | M3 (melt pairs). M4 (sweet-spot hunt). | 4.5 |
| Mon 16 | Finish M4. Start M5 (soak). **Feature freeze.** | 2 |
| Tue 17 | Fix only what the soak found. Buffer. | 1 |
| Wed 18 | M6 (venue). | 2 |
| Thu 19 | Show. No code changes. | — |

About 21 h. A one-pass build will have bugs: Friday's first 1–2 h are reserved for them.

## D2. Milestones

**M0 — Boot (30 min).** `npm i`, `npm run bake`, `npm run dev`. Open `/?src=synth` and `/control.html`.
- Look at: shapes melt; the kick moves zoom and thickness; every slider row does something; meters move; closing the dashboard changes nothing.
- Pass: no console errors, 60 fps.

**M1 — Audio calibration (1 h).** Put 3 excerpts of real DJ sets in `public/test-audio/` (one house, one techno, one slow or ambient). Open `/?src=file&f=<name>`.
- First, with the music stopped, read the raw dB levels in the debug overlay, then play the quietest passage. Set `floorDb` between the two (about 10 dB above the silent reading).
- Look at: the three band meters move independently, and each reaches the top on a loud passage; the beat LED lands on kicks; on a breakdown the low meter drops and beats stop; BPM is plausible.
- Pass: beats are right on at least 2 of 3 tracks without touching the knobs between them.

**M2 — Effect audit (2 h).** Reset all, autopilot 0. For each effect: raise base alone, then set react and thr against the live band bar.
- Look at: the slider's full range is useful (if the top third is ugly or the bottom third invisible, change min and max in `params.ts`); the effect reads from 3 m away; warp and spikes do not turn the shape to mush at half range.
- Pass: every row has a range you would actually use. Write down the range changes and apply them in one batch.

**M3 — Real motifs (1.5 h).** Bake the 12 drawings. Fix every bake warning by redrawing.
- Look at: use melt hold and scrub slowly through each neighbouring pair in all 3 melt modes. Thin motifs vanishing mid-melt mean unequal ink coverage.
- Pass: no pair pops or slides sideways; the mid-point of each pair is a shape worth looking at.

**M4 — Sweet-spot hunt (3–4 h).** Autopilot 0.3, real music. Loop: Randomize → lock the rows you like → Mutate a few times → Save.
- Target: 10–12 presets across three energy levels (calm, groove, peak), named.
- Pass: with `presetCycleMin = 5` and autopilot 0.5, ten minutes pass without a moment you would be embarrassed by.

**M5 — Soak (30 min active, 3–4 h unattended).** `npm run build && npm run preview`, fullscreen, a long mix as the file source, preset cycle on.
- Look at afterwards: the soak log (fps minimum, heap growth), laptop temperature, whether the screen slept.
- Pass: fps minimum ≥ 55, heap flat (within 20%), no stall.

**M6 — Venue (2 h).** Real mixer, real projector.
- Gain staging: Focusrite on LINE, gain so the dashboard level meter peaks around −12 to −6 dB on the loudest track and the clip LED never lights. Then `inputGain` stays near 1.
- Projector: check black level and edges. Adjust `brightness`, `sat`, `thickness`, `glow` for the room and overwrite the presets that need it.
- Pass: 15 minutes of a real set, hands off, looks right from the back of the room.

## D3. Symptom → knob

| Symptom | Fix |
|---|---|
| Beats miss the kicks | Lower `onsetK` (1.0–1.2) |
| A band never reaches the top of its meter | Lower `floorDb` |
| Quiet music counts as silence, or silence makes the meters twitch | Set `floorDb` between the silent and the quiet readings |
| Breakdowns look as busy as drops | Raise `gainDecay` |
| Beats fire on everything | Raise `onsetK` (2–2.5) |
| Everything jitters | Raise `smooth`; raise `thr` on the jittery rows |
| Nothing reacts in quiet passages | Lower `thr`; that is also correct behaviour, so check on a full track first |
| Reaction always saturated | Raise `thr` first, then lower `react` |
| Constant strobing | Lower `react` on `brightness`; raise `hueJumpEvery` |
| Shapes turn to mush | Lower `warpAmt`, `spikeAmp`; raise `warpScale` |
| Lines too thin on the projector | Raise `thickness` base to 0.01–0.02 |
| Melt looks like a crossfade | Use melt mode fuse; raise `linger`; raise `meltK` |
| Too busy overall | Lower `reactMaster` to 0.6; autopilot 0.3 |
| Too static | Raise autopilot; shorten `holdBeats` |
| Level meter clipping | Lower the Focusrite gain, never `inputGain` |
| Display froze or looks wrong | `Z` (undo), then `B` (fallback), then reload the Display window |

## D4. Show-day runbook

1. Laptop on mains. Disable sleep, screensaver, notifications, night mode, automatic updates.
2. Display settings: **extended**, not mirrored. Projector at its native resolution.
3. Mixer REC or BOOTH out → Focusrite 1–2. Check the Focusrite is on LINE.
4. `npm run build && npm run preview`.
5. Launch Chrome with throttling off (these switches stop Chrome from slowing a window it thinks is hidden):
```
chrome --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding http://localhost:4173/
```
6. Drag that window to the projector, click once (starts audio, allow the microphone), press Enter (fullscreen).
7. Open `http://localhost:4173/control.html` in a second window on the laptop screen. Check the level meter and beat LED.
8. Load a calm preset. Set `presetCycleMin` and autopilot as rehearsed.
9. Never minimise the Display window. Emergency keys: `Z`, `B`, `K`.
10. Bring: spare HDMI cable and adapter, spare audio cable, charger, the exported presets JSON on a USB stick.
