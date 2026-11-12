"""Bake motif PNGs into a signed-distance atlas (SPEC B2.2).

    python tools/bake_sdf.py <in_dir> <out_dir> [--cell 512]

Outputs in <out_dir>:
  atlas.bin       little-endian float16, shape [count][cell][cell], row 0 = top.
                  Signed distance in motif units (cell spans -1..+1, so
                  d = d_px / 1024), negative inside the ink, not clamped.
  thumbs/NN.png   160x160, white ink on transparent.
  manifest.json   see SPEC B2.2.

Validation problems are printed and stored per motif; they never abort the
bake. Only unusable input (no PNGs, more than 16, bad --cell) is an error.
"""

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

SIZE = 2048
HALF = SIZE / 2  # pixels per motif unit
MAX_MOTIFS = 16
THUMB = 160
MARGIN = int(round(SIZE * 0.10))
# Thin-stroke check: morphological opening by a disk of diameter 40 px,
# done exactly with Euclidean distance transforms (erode: edt(ink) > r,
# dilate: edt(~eroded) <= r). r = 19.5 is the largest disk on the pixel
# grid narrower than 40 px, so a stroke drawn at 40 px passes and anything
# thinner loses its ink. Literal binary_opening costs ~4 s per image.
OPEN_R = 19.5


def load_gray(path):
    """Grayscale uint8 array of the PNG as read (alpha flattened onto white)."""
    im = Image.open(path)
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        im = im.convert("RGBA")
        bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
        im = Image.alpha_composite(bg, im)
    im = im.convert("L")
    return im


def analyse(path, cell):
    src = load_gray(path)
    warnings = []
    w, h = src.size
    if w != h:
        warnings.append(f"not square ({w}x{h}); stretched to {SIZE}x{SIZE}")
    src_px = np.asarray(src)
    grey = float(((src_px >= 16) & (src_px <= 239)).mean())
    if grey > 0.01:
        warnings.append(f"grey pixels {grey:.1%} of the image (max 1%)")

    im = src if src.size == (SIZE, SIZE) else src.resize((SIZE, SIZE), Image.LANCZOS)
    ink = np.asarray(im) < 128
    n_ink = int(ink.sum())
    coverage = n_ink / ink.size

    if n_ink == 0 or n_ink == ink.size:
        warnings.append("no ink" if n_ink == 0 else "image is all ink")
        d = np.full((SIZE, SIZE), 2.0 if n_ink == 0 else -2.0, dtype=np.float64)
        centroid = [0.5, 0.5]
    else:
        e_in = ndi.distance_transform_edt(ink)
        d = (ndi.distance_transform_edt(~ink) - e_in) / HALF
        ys, xs = np.nonzero(ink)
        centroid = [float((xs.mean() + 0.5) / SIZE), float((ys.mean() + 0.5) / SIZE)]

        if ink[:MARGIN].any() or ink[-MARGIN:].any() or ink[:, :MARGIN].any() or ink[:, -MARGIN:].any():
            warnings.append("ink inside the outer 10% margin")
        off = float(np.hypot(centroid[0] - 0.5, centroid[1] - 0.5))
        if off > 0.05:
            warnings.append(f"centroid off centre by {off:.3f} (max 0.05)")
        opened = ndi.distance_transform_edt(~(e_in > OPEN_R)) <= OPEN_R
        lost = 1.0 - (opened & ink).sum() / n_ink
        if lost > 0.02:
            warnings.append(f"strokes thinner than 40 px: opening removes {lost:.1%} of the ink (max 2%)")

    f = SIZE // cell
    sdf = d.reshape(cell, f, cell, f).mean(axis=(1, 3))

    alpha = Image.fromarray((ink * 255).astype(np.uint8), "L").resize((THUMB, THUMB), Image.BOX)
    thumb = Image.new("RGBA", (THUMB, THUMB), (255, 255, 255, 0))
    thumb.putalpha(alpha)

    return {"coverage": coverage, "centroid": centroid, "warnings": warnings, "sdf": sdf, "thumb": thumb}


def main():
    ap = argparse.ArgumentParser(description="Bake motif PNGs into an SDF atlas.")
    ap.add_argument("in_dir")
    ap.add_argument("out_dir")
    ap.add_argument("--cell", type=int, default=512)
    args = ap.parse_args()
    t0 = time.time()

    if args.cell <= 0 or SIZE % args.cell:
        sys.exit(f"error: --cell must divide {SIZE} (got {args.cell})")
    files = sorted(p for p in Path(args.in_dir).iterdir() if p.suffix.lower() == ".png")
    if not files:
        sys.exit(f"error: no PNG files in {args.in_dir}")
    if len(files) > MAX_MOTIFS:
        sys.exit(f"error: {len(files)} PNGs in {args.in_dir}, max is {MAX_MOTIFS}")

    # Pass 1: per-motif analysis. Pass 2 needs the whole set's median coverage.
    results = [analyse(p, args.cell) for p in files]
    median = float(np.median([r["coverage"] for r in results]))
    for r in results:
        c = r["coverage"]
        if not 0.10 <= c <= 0.25:
            r["warnings"].append(f"coverage {c:.3f} outside 0.10-0.25")
        if median > 0 and abs(c - median) > 0.25 * median:
            r["warnings"].append(f"coverage {c:.3f} more than 25% from the set median {median:.3f}")

    out = Path(args.out_dir)
    thumbs = out / "thumbs"
    thumbs.mkdir(parents=True, exist_ok=True)
    for stale in thumbs.glob("*.png"):
        stale.unlink()

    np.stack([r["sdf"] for r in results]).astype("<f2").tofile(out / "atlas.bin")
    motifs = []
    for i, (p, r) in enumerate(zip(files, results)):
        r["thumb"].save(thumbs / f"{i + 1:02d}.png")
        motifs.append(
            {
                "id": i,
                "file": p.name,
                "coverage": round(r["coverage"], 4),
                "centroid": [round(v, 4) for v in r["centroid"]],
                "warnings": r["warnings"],
            }
        )
        for w in r["warnings"]:
            print(f"warning: {p.name}: {w}")
    manifest = {
        "version": 1,
        "count": len(files),
        "cell": args.cell,
        "dtype": "float16",
        "origin": "top-left",
        "motifs": motifs,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    n_warn = sum(len(m["warnings"]) for m in motifs)
    print(f"baked {len(files)} motifs ({args.cell}x{args.cell}) from {args.in_dir} -> {out} "
          f"with {n_warn} warnings in {time.time() - t0:.1f} s")


if __name__ == "__main__":
    main()
