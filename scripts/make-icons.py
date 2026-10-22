"""
Generate the extension icons (16 / 48 / 128 px).

Kept in the repo so the icons are reproducible instead of mystery binaries.
Pure ASCII on purpose: this file gets edited on Windows consoles of all kinds.

Usage:
    python scripts/make-icons.py
"""

import os
from PIL import Image, ImageDraw

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public")
SS = 8  # supersampling factor -> draw big, downscale for clean edges
BASE = 128

# Brand blue, matching the family used by the sibling extension.
TOP = (76, 141, 255)
BOTTOM = (24, 79, 200)


def rounded_gradient(size: int) -> Image.Image:
    """Vertical gradient inside a rounded square (Chrome extension icon shape)."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    grad = Image.new("RGBA", (1, size))
    gd = ImageDraw.Draw(grad)
    for y in range(size):
        t = y / max(1, size - 1)
        c = tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3))
        gd.point((0, y), fill=(c[0], c[1], c[2], 255))
    grad = grad.resize((size, size))

    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=round(size * 0.22), fill=255
    )
    img.paste(grad, (0, 0), mask)
    return img


def draw_glyph(img: Image.Image) -> Image.Image:
    """Magnifying glass with a check mark inside the lens."""
    size = img.size[0]
    d = ImageDraw.Draw(img)
    white = (255, 255, 255, 255)

    s = size / BASE  # glyph coordinates are authored against a 128 grid
    cx, cy, r = 58 * s, 54 * s, 30 * s
    stroke = max(1, round(9 * s))

    # lens ring
    d.ellipse(
        [cx - r, cy - r, cx + r, cy + r], outline=white, width=stroke
    )
    # handle
    d.line(
        [(cx + r * 0.72, cy + r * 0.72), (100 * s, 96 * s)],
        fill=white,
        width=stroke + round(2 * s),
    )
    # round caps / joins on the handle
    d.ellipse(
        [100 * s - (stroke + round(2 * s)) / 2, 96 * s - (stroke + round(2 * s)) / 2,
         100 * s + (stroke + round(2 * s)) / 2, 96 * s + (stroke + round(2 * s)) / 2],
        fill=white,
    )
    # check mark inside the lens
    d.line(
        [(cx - 13 * s, cy + 1 * s), (cx - 3 * s, cy + 11 * s), (cx + 15 * s, cy - 12 * s)],
        fill=white,
        width=max(1, round(7 * s)),
        joint="curve",
    )
    for px, py in ((cx - 13 * s, cy + 1 * s), (cx - 3 * s, cy + 11 * s), (cx + 15 * s, cy - 12 * s)):
        rr = max(1, round(7 * s)) / 2
        d.ellipse([px - rr, py - rr, px + rr, py + rr], fill=white)
    return img


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    for px in (16, 48, 128):
        big = rounded_gradient(BASE * SS)
        draw_glyph(big)
        icon = big.resize((px, px), Image.LANCZOS)
        path = os.path.normpath(os.path.join(OUT_DIR, "icon-%d.png" % px))
        icon.save(path, "PNG")
        print("wrote %s (%d bytes)" % (path, os.path.getsize(path)))


if __name__ == "__main__":
    main()
