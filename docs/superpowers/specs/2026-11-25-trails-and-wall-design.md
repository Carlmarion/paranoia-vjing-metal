# Trails and the wall

Date: 2026-11-25. Branch: `feat/drawing-tool`. Amends `SPEC.md` (sections named in §9).

This doc stands alone: a builder can plan from it and the code without the conversation that produced it.

## 1. Intent

Ferro draws one flat, glowing line shape on black and melts it into the next. Every frame is drawn from scratch, so the picture has no memory, no depth and no multiplication. Carl judges the piece "good, not great" and wants a few additions that make people say "wow" without flooding the dashboard.

Two additions were chosen:

1. **Trails.** Each frame is drawn over a faded, slightly moved copy of the last one. The shape leaves echoes behind it: smoke, a tunnel, a spiral.
2. **The wall.** The shape is repeated as a grid of cells. Each cell is a little later than the one before it, so a kick, and the melt itself, travels across the wall as a wave.

Both need the same change underneath: the picture is drawn into an off-screen buffer first, then shown. That change is designed once here, for both.

## 2. Goals, non-goals, anti-goals

**Goals**
- Three sliders for trails (`trail`, `push`, `twist`) in a new `trails` group. They behave like every other slider: react, band, threshold, presets, lock, mutate.
- A wall of 1–8 columns by 1–8 rows, with a delay per cell and five wave patterns. The melt travels on the wave too.
- With `trail` at 0 and the wall at 1×1, the picture is the same as today (§8).
- Every existing preset looks the same after the update, until Carl touches the new controls.
- Two phases, each usable on its own: (1) the new render path and trails, (2) the wall.

**Non-goals**
- No bloom, no colour split, no kaleidoscope beyond the existing mirrors, no MIDI, no preview in the dashboard. These are noted for a later version. The show pass (§4.4) is where bloom would go, behind one `bloom` slider in the colour group.
- No envelope for the `trails` group (it is already a memory).
- Ambient does not change the trail sliders' base values.
- No brick or offset layouts for the wall, and no per-cell shapes: all cells show the same shape, at different moments.

**Anti-goals**
- A dashboard that needs explaining. No new kind of control: sliders, steppers and one segmented switch.
- A slower or less safe show. The emergency keys keep working as today, and Fallback (`B`) bypasses everything in this doc.
- Trails that never fade to black, or that turn the picture into a white blob.

## 3. Approaches

**Trails**
- **A. Feedback buffer (chosen).** Keep last frame's picture in a texture; each frame is `max(new picture, moved old picture × decay)`. One extra texture read per pixel. Echoes keep the colour they were drawn in.
- **B. Draw the shape several times at past moments.** No buffer, but each echo costs a full shape evaluation, so 8 echoes cost 8× the frame, and the echoes are discrete copies, not smoke.
- **C. Trails in the distance field** (remember the shape's past positions as distances). Fits the "melt" idea but can't remember colour and needs a second buffer format. Too much for the gain.

**Wall**
- **A. One draw per cell from a history of past frames (chosen).** The Display keeps the last 16 s of frame inputs in memory. Each cell is drawn with its own viewport and the inputs from `now − its delay`. Everything is late together: reactions, phases, colour, and the melt. The shader only needs to know where its cell is. At most 64 small draws that together cover the same pixels as one full-screen draw.
- **B. Tile inside the shader and read past values from a history texture.** One draw, but every pixel reads all ~35 values from a texture, and the shader's parameter macros must all change. More risk, more GPU work, no visible gain.
- **C. Delay only a "pulse" value per cell.** Simple, but the melt can't travel, and that is the part Carl liked most.

## 4. The render path

### 4.1 Passes

Today: one shader draws straight to the canvas. New:

1. **Scene pass.** The existing shader draws into the off-screen buffer `cur`, once per cell (one cell = the whole buffer when the wall is 1×1). It also reads the previous buffer `prev` for the trails (§5).
2. **Show pass.** A small second shader copies `cur` to the canvas and applies **grain** and the **master fade** (blackout). These two move out of the scene shader: grain must not pile up in the echoes, and a blackout must stay clean.
3. `cur` and `prev` swap.

### 4.2 Buffers

- Two textures the size of the canvas (so `?scale=` applies as today), `RGBA16F`, linear filtering, clamp to edge. Needs `EXT_color_buffer_float`.
- **RGB** = the picture before grain and master. **Alpha** = the luminance `lum` the scene shader computed (the grain needs it: `grain × (0.15 + lum)` as today).
- **No float extension:** use `RGBA8` and subtract `1/255` from the faded echo each frame (`max(prev × decay − 1/255, 0)`), so echoes still reach black.
- **Resize, context restore, first frame:** allocate again and clear to black.
- **Cleared to black, and the wall history emptied (§6.4):**
  - on every frame while the master fade is at 0 (the scene keeps drawing during blackout, so a single clear would fill up again);
  - when a replay starts from blackout (`fromBlank`): the store releases blackout at once, so the master may never reach 0; the clear is an event from that command, not a renderer state;
  - on the frame Fallback turns on, and on the frame it turns off.
  This keeps SPEC B7.6 true: the drawing appears on black, with no old echoes and no late cells still showing the old shape.

### 4.3 Scene shader changes

- New uniforms: `uOrigin` (the cell's lower-left pixel), `uRes` becomes the **cell** size, `uScreen` (buffer size), `uPrev` (sampler), `uTrailDecay` (float), `uTrailM` (mat2).
- Screen space is computed from `gl_FragCoord.xy − uOrigin` and the cell size, so each cell is a small screen: tilt, mirrors, zoom and `hueSpace` are per cell.
- Sections 1–10 of the shader are otherwise untouched. Section 11 (grain, master) is removed; the output is `vec4(max(col, echo), max(lum, echoLum))` (§5.2).

### 4.4 Show shader

`out = clamp(buf.rgb + grainNoise × P_GRAIN × (0.15 + buf.a), 0, 1) × uMaster`, with the same noise function and per-frame offset as today. It needs `uP` (for grain), `uFrame`, `uMaster` and the buffer.

### 4.5 Fallback

While `session.fallback` is on: `uTrailDecay = 0` and the wall is 1×1 with no delay, whatever the Look says. The path through the buffer stays (one code path), but nothing in it can linger or repeat.

## 5. Trails

### 5.1 Sliders

A new group `trails`, shown as a panel after `colour`. Rows in the param table (35 params in total):

| id | scale | min | max | default | band | react | drift | randomize |
|---|---|---|---|---|---|---|---|---|
| `trail` | lin | 0 | 1 | 0 | none | 0 | none | never (`null`) |
| `push` | lin | −1 | 1 | 0 | none | 0 | none | −0.3…0.3 |
| `twist` | lin | −1 | 1 | 0 | none | 0 | none | −0.1…0.1 |

- `trail` is never randomized, so Randomize all can't switch trails on. `push` and `twist` are, which is harmless while `trail` is 0.
- **Mutate all skips `trail`** (today `mutate` moves every unlocked base, which would switch trails on in old Looks about every second press). The trails panel's own Mutate does move it: pressing it is touching the new controls. `push` and `twist` are mutated as usual.
- The group has Randomize, Mutate and Reset like the others, and no envelope arrow.
- **Zero** sets the bases of all three to 0 (add them to `ZERO_BASES`).
- **Ambient** leaves the bases alone. A reaction on `low`, `beat` or `high` is calmed like any other.
- Old Looks and presets have no entry for these ids and get the table defaults (`migrateLook` already does this), so no Look version bump.

### 5.2 Maths

Per second, computed on the Display from the frame's `dt`, so the look doesn't depend on frame rate. Pure functions in a new `src/display/trails.ts`:

- **Decay.** `τ = TRAIL_MAX_S × trail²` seconds; `decay = τ > 0 ? exp(−dt / τ) : 0`. `TRAIL_MAX_S = 6`.
- **Move.** Each frame the old picture is scaled by `k = exp(push × PUSH_RATE × dt)` and turned by `a = twist × TWIST_RATE × dt` turns, about the centre of the window. `PUSH_RATE = 1.5` per second, `TWIST_RATE = 0.25` turns per second. Positive `push` sends echoes outward. The shader gets the inverse as `uTrailM`, in aspect-correct space, to find where each pixel was last frame.
- **Combine.** `echo = prev(where this pixel was) × decay`, black when that point is outside the window (not the clamped edge). Output `max(new, echo)` per channel, and the same for alpha. `max` keeps colours pure; adding would burn to white.
- The trail values used are the **current** ones for the whole window, also when the wall delays its cells: the echoes move across the whole wall, not per cell.

`TRAIL_MAX_S`, `PUSH_RATE`, `TWIST_RATE` and the combine rule are named constants. They are guesses until seen on the projector (§8).

### 5.3 What trails don't touch

- Zoom zones and the zoom stop are about the live line only. Echoes pushed outward are meant to leave the window.
- Meters, the colour strip and the envelope editors show the live values, as today.

## 6. The wall

### 6.1 Controls

Four new Look options (saved in presets, default = off):

| option | values | default |
|---|---|---|
| `wallCols` | 1…8 | 1 |
| `wallRows` | 1…8 | 1 |
| `wallWave` | `0` rows · `1` snake · `2` centre · `3` diagonal · `4` random | 0 |
| `wallDelay` | 0…1 s per step | 0.12 |

- Dashboard: a `wall` row under the mirror row: two steppers (`cols`, `rows`), a segmented switch for the wave, a slider for the delay.
- Like the other options they jump (no crossfade) when a preset is recalled, and Randomize all does not change them. Reset all puts them back to default. **Zero leaves them alone**, like the mirrors.
- 1×1 is exactly "no wall".

### 6.2 Cells

- Cell edges are at `floor(i × W / cols)` and `floor(j × H / rows)`, so the cells tile the buffer with no gap when the size doesn't divide evenly.
- The shape is sized to each cell's short side, as it is to the window's short side today.
- Glow or line reaching a cell edge is cut there. That is accepted: the cells are tiles.

### 6.3 Steps and delays

Each cell gets a whole-number **step**; its delay is `step × wallDelay`. Row 0 is the top row, column 0 the left one.

| wave | step of cell (col, row) |
|---|---|
| rows | `row × cols + col` (reading order) |
| snake | as rows, but odd rows run right to left |
| centre | ring number: `max(|col − (cols−1)/2|, |row − (rows−1)/2|)`, rounded down, so the middle is first |
| diagonal | `col + row` |
| random | a shuffle of `0…cells−1`, fixed for a given seed, `cols` and `rows`; its own random stream (`streamRng(seed, 'wall')`), never one of the existing streams |

If the largest delay would pass `WALL_HISTORY_S = 16` s, all delays are scaled down so the last cell is 16 s late.

### 6.4 History

- A new `src/display/wall.ts` keeps a ring of the frame inputs (`FrameUniforms`, copied, with the time they were made) covering the last 16 s. It records only while the wall is larger than 1×1, and has a `clear()` used by §4.2.
- A cell draws with the newest snapshot that is at least its delay old; when history is shorter than that, the oldest one.
- Everything in the snapshot is late together: slider values, phases, tilt, hue offset, the two shape layers and the melt position. So the next shape sweeps across the wall cell by cell.
- **Not delayed:** the trail values (§5.2), grain and master (show pass), meters and everything the dashboard shows, the sequencer, and the contents of the shape layers. A late cell that still points at a layer whose drawing has since changed (live drawing, a deleted shape) shows what the layer holds now. Live drawing therefore appears in all cells at once. Accepted.

### 6.5 Zones and the stop

With a wall, the line is cut at the **cell** edge, so the zoom and mirror-shift zones and the zoom stop are measured against the cell (its width and height in short-side units) instead of the window. At 1×1 they are the same thing.

## 7. What's left to the builder

- Whether the scene and feedback are one shader (chosen here) or two passes, if one turns out cleaner.
- How the history stores snapshots (array of objects, or one flat typed array).
- Exact CSS of the `wall` row and the `trails` panel.
- How to get a repeatable frame for the same-picture check (§8).

## 8. Checks

**Automated (vitest, pure modules)**
- `trails.ts`: decay is 0 at `trail = 0`; two half-steps equal one full step (frame-rate independence) for decay, scale and turn; the matrix is the identity at `push = twist = 0`.
- `wall.ts`: cell rectangles tile the buffer exactly for sizes that don't divide; steps for each wave on a 3×2 and a 4×4 wall; the random wave is a permutation and repeats for the same seed; delays are capped at 16 s; history returns the right snapshot, and the oldest when too short.
- Presets: an old Look gets the trail defaults and a 1×1 wall; Zero zeroes the trail bases and keeps the wall; Randomize all never changes `trail` or the wall options; Mutate all never changes `trail`, the trails-group Mutate does.
- Zones use the cell size when the wall is on.

**Same picture.** On a repeatable frame with `trail = 0` and a 1×1 wall, a screenshot before and after the change differs by at most 2/255 per channel.

**On the projector (Carl)**
- Trails: does `trail` at full feel long enough, are `push` and `twist` in a useful range, does `max` look right or too thin. The constants in §5.2 are tuned here.
- Wall: SPEC A3 (60 fps at 1920×1080 on the show laptop) binds the wall and the trails. If 8×8 doesn't hold it, the largest wall is lowered (the 1…8 limit is one constant) until it does; the render scale is not touched. The melt sweeping across the wall reads as a wave.
- Blackout, then **draw in ▶**: the shape appears on clean black, no old echoes.
- Fallback (`B`) with trails and wall on: a single plain shape at once.

## 9. SPEC.md sections to amend

A3 (the frame-rate rule covers trails and wall), B3 (options, 35 params), B4.2 (param table, `trails` group), B4.4 (zones against the cell), B5 (passes, buffers, uniforms, show shader), B7 and B7.6 (what the wall delays; clean black on replay), B8 (Zero, Randomize, Mutate, Reset), B10 (trails panel, wall row), C2 (unit tests), C3 (checklist), D2 (a milestone for the projector checks).
