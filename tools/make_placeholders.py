"""Generate the 12 placeholder motifs into art/placeholders/ (SPEC B2.3).

4 ironwork designs x 3 round-capped stroke weights (40 / 70 / 100 px).
Numbering is design-major: the same design appears thin, medium, thick in
consecutive files.
  01-03  ring with a cross
  04-06  four C-scrolls in a square frame
  07-09  half-circle fan with 7 radial bars
  10-12  diamond lattice in a frame

Each design is a set of connected centre-line polylines (like welded bar
stock). Every polyline is drawn with ImageDraw.line(width=w) and a disc of
diameter w is stamped on every vertex, which gives round caps and round
joins. Output is pure black on white (no anti-aliasing), 2048x2048, ink
inside the central 80%, ink centroid shifted onto the image centre.

Usage: python tools/make_placeholders.py [out_dir]
"""

import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

SIZE = 2048
C = SIZE / 2
WEIGHTS = (40, 70, 100)


def arc(cx, cy, r, a0_deg, a1_deg, step_deg=1.0):
    """Polyline along a circle arc, angles in degrees, y axis pointing down."""
    n = max(2, int(math.ceil(abs(a1_deg - a0_deg) / step_deg)) + 1)
    return [
        (cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a)))
        for a in np.linspace(a0_deg, a1_deg, n)
    ]


def square(h):
    return [(-h, -h), (h, -h), (h, h), (-h, h), (-h, -h)]


def ring_with_cross():
    r_out, r_in = 680, 360
    return [
        arc(0, 0, r_out, 0, 360),
        arc(0, 0, r_in, 0, 360),
        [(-r_out, 0), (r_out, 0)],
        [(0, -r_out), (0, r_out)],
    ]


def c_scrolls_in_frame():
    h = 700  # frame half-side
    r = 250  # scroll radius
    d = h - r  # scroll centre offset on each axis: scroll touches two frame sides
    hub = math.hypot(d, d) - r  # central ring touches every scroll
    lines = [square(h), arc(0, 0, hub, 0, 360)]
    for k in range(4):
        rot = 90 * k
        ca, sa = math.cos(math.radians(rot)), math.sin(math.radians(rot))
        cx, cy = d * ca - d * sa, d * sa + d * ca  # (d, d) rotated by rot
        # Gap of the C centred at 135 deg (local), i.e. facing a neighbouring
        # scroll; the arc passes through 0 deg and 90 deg (frame contacts) and
        # 225 deg (hub contact). Ends curl inward with a small hook.
        a0, a1 = 135 + 40 + rot, 135 + 320 + rot
        lines.append(arc(cx, cy, r, a0, a1))
        for a_end, sign in ((a0, -1), (a1, 1)):
            ex = cx + (r - 90) * math.cos(math.radians(a_end))
            ey = cy + (r - 90) * math.sin(math.radians(a_end))
            lines.append(arc(ex, ey, 90, a_end, a_end + sign * 200))
    return lines


def half_circle_fan():
    R, r_mid, r_hub = 740, 450, 150
    lines = [
        arc(0, 0, R, 180, 360),
        arc(0, 0, r_mid, 180, 360),
        arc(0, 0, r_hub, 180, 360),
        [(-R, 0), (R, 0)],
    ]
    for i in range(7):
        a = math.radians(180 + 180 * (i + 1) / 8)
        lines.append([(r_hub * math.cos(a), r_hub * math.sin(a)), (R * math.cos(a), R * math.sin(a))])
    return lines


def diamond_lattice_in_frame():
    h = 660
    lines = [square(h)]
    for k in (-660, 0, 660):
        # x + y = k and x - y = k, clipped to the square [-h, h]^2
        lo, hi = max(-h, k - h), min(h, k + h)
        lines.append([(lo, k - lo), (hi, k - hi)])
        lines.append([(lo, lo - k), (hi, hi - k)])
    return lines


DESIGNS = (ring_with_cross, c_scrolls_in_frame, half_circle_fan, diamond_lattice_in_frame)


def render(lines, w, dx=0.0, dy=0.0):
    img = Image.new("L", (SIZE, SIZE), 255)
    draw = ImageDraw.Draw(img)
    rad = w / 2
    for line in lines:
        pts = [(C + x + dx, C + y + dy) for x, y in line]
        draw.line(pts, fill=0, width=w, joint="curve")
        for x, y in pts:
            draw.ellipse((x - rad, y - rad, x + rad, y + rad), fill=0)
    return img


def ink_stats(img):
    ink = np.asarray(img) < 128
    ys, xs = np.nonzero(ink)
    return ink.mean(), xs.mean() + 0.5, ys.mean() + 0.5, ink


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "art/placeholders")
    out.mkdir(parents=True, exist_ok=True)
    lo, hi = int(SIZE * 0.1), int(SIZE * 0.9)
    n = 0
    for design in DESIGNS:
        lines = design()
        for w in WEIGHTS:
            n += 1
            # Two passes: measure the ink centroid, then re-render shifted so
            # it sits on the image centre (matters for the half-circle fan).
            _, cx, cy, _ = ink_stats(render(lines, w))
            img = render(lines, w, C - cx, C - cy)
            cov, cx, cy, ink = ink_stats(img)
            inside = not (ink[:lo].any() or ink[hi:].any() or ink[:, :lo].any() or ink[:, hi:].any())
            name = f"{n:02d}.png"
            img.save(out / name)
            print(
                f"{name} {design.__name__:26s} w={w:3d} coverage={cov:.3f} "
                f"centroid=({cx / SIZE:.3f},{cy / SIZE:.3f}) inside80={inside}"
            )


if __name__ == "__main__":
    main()
