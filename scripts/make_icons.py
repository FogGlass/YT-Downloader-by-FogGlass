"""Generate the YT Downloader icon set without any third-party imaging library.

The mark is a rounded squircle carrying a diagonal indigo/violet gradient with a
white download glyph. Coverage is computed from signed distance fields, so every
size is anti-aliased from the same vector definition instead of being resampled.

Outputs (into src-tauri/icons):
    32x32.png, 128x128.png, 128x128@2x.png, icon.png, icon.ico
"""

from __future__ import annotations

import math
import os
import struct
import zlib

OUT_DIRS = [
    r"E:\DeepSeek Harness Workspace\YTDownloader\src-tauri\icons",
    r"E:\DeepSeek Harness Workspace\YTDownloader\public",
]

# Brand gradient, sampled from the app's accent ramp.
GRADIENT_TOP = (0x82, 0x74, 0xFF)
GRADIENT_BOTTOM = (0x4B, 0x3F, 0xD8)


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return low if value < low else high if value > high else value


def mix(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return (
        int(round(a[0] + (b[0] - a[0]) * t)),
        int(round(a[1] + (b[1] - a[1]) * t)),
        int(round(a[2] + (b[2] - a[2]) * t)),
    )


def sd_rounded_box(px: float, py: float, cx: float, cy: float, hw: float, hh: float, r: float) -> float:
    qx = abs(px - cx) - (hw - r)
    qy = abs(py - cy) - (hh - r)
    ox = max(qx, 0.0)
    oy = max(qy, 0.0)
    return math.hypot(ox, oy) + min(max(qx, qy), 0.0) - r


def sd_triangle(px: float, py: float, ax: float, ay: float, bx: float, by: float, cx: float, cy: float) -> float:
    def edge(x0, y0, x1, y1):
        ex, ey = x1 - x0, y1 - y0
        vx, vy = px - x0, py - y0
        t = clamp((vx * ex + vy * ey) / (ex * ex + ey * ey)) if (ex or ey) else 0.0
        return math.hypot(vx - ex * t, vy - ey * t)

    d = min(edge(ax, ay, bx, by), edge(bx, by, cx, cy), edge(cx, cy, ax, ay))
    # Inside test: consistent winding for the triangle below.
    c1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax)
    c2 = (cx - bx) * (py - by) - (cy - by) * (px - bx)
    c3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx)
    inside = (c1 >= 0 and c2 >= 0 and c3 >= 0) or (c1 <= 0 and c2 <= 0 and c3 <= 0)
    return -d if inside else d


def render(size: int) -> bytearray:
    """Render one RGBA tile of `size` x `size` pixels."""
    s = float(size)
    pixels = bytearray(size * size * 4)

    # Geometry as fractions of the tile.
    inset = 0.035 * s
    box_r = 0.225 * s
    shaft = (0.5 * s, 0.442 * s, 0.0605 * s, 0.150 * s, 0.0605 * s)
    head = (
        0.5 * s - 0.196 * s, 0.520 * s,
        0.5 * s + 0.196 * s, 0.520 * s,
        0.5 * s, 0.756 * s,
    )
    bar = (0.5 * s, 0.848 * s, 0.212 * s, 0.0465 * s, 0.0465 * s)

    for y in range(size):
        py = y + 0.5
        for x in range(size):
            px = x + 0.5

            # Background squircle.
            d_bg = sd_rounded_box(px, py, 0.5 * s, 0.5 * s, 0.5 * s - inset, 0.5 * s - inset, box_r)
            cov_bg = clamp(0.5 - d_bg)

            # Glyph union.
            d_shaft = sd_rounded_box(px, py, shaft[0], shaft[1], shaft[2], shaft[3], shaft[4])
            d_head = sd_triangle(px, py, *head)
            d_bar = sd_rounded_box(px, py, bar[0], bar[1], bar[2], bar[3], bar[4])
            d_glyph = min(d_shaft, d_head, d_bar)
            cov_glyph = clamp(0.5 - d_glyph) * cov_bg

            if cov_bg <= 0.0 and cov_glyph <= 0.0:
                continue

            t = clamp(((px - inset) + (py - inset)) / (2.0 * (s - 2.0 * inset)))
            base = mix(GRADIENT_TOP, GRADIENT_BOTTOM, t * 0.92 + 0.04)

            # Gentle top-left sheen so the tile reads as a physical surface.
            sheen = clamp(1.0 - (px + py) / (1.15 * s)) * 14.0
            r = clamp(base[0] + sheen, 0, 255)
            g = clamp(base[1] + sheen, 0, 255)
            b = clamp(base[2] + sheen * 0.7, 0, 255)

            # Composite the white glyph over the gradient.
            r = r + (255.0 - r) * cov_glyph
            g = g + (255.0 - g) * cov_glyph
            b = b + (255.0 - b) * cov_glyph

            index = (y * size + x) * 4
            pixels[index] = int(round(r))
            pixels[index + 1] = int(round(g))
            pixels[index + 2] = int(round(b))
            pixels[index + 3] = int(round(cov_bg * 255.0))

    return pixels


def png_bytes(size: int, pixels: bytearray) -> bytes:
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)  # filter type 0
        raw.extend(pixels[y * stride : (y + 1) * stride])

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def dib_bytes(size: int, pixels: bytearray) -> bytes:
    """32-bit bottom-up BMP payload with the mandatory AND mask."""
    header = struct.pack("<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    body = bytearray()
    for y in range(size - 1, -1, -1):
        for x in range(size):
            index = (y * size + x) * 4
            r, g, b, a = pixels[index], pixels[index + 1], pixels[index + 2], pixels[index + 3]
            body.extend((b, g, r, a))
    mask_stride = ((size + 31) // 32) * 4
    body.extend(b"\x00" * (mask_stride * size))
    return header + bytes(body)


def write_ico(path: str, sizes: list[int]) -> None:
    images = []
    for size in sizes:
        pixels = render(size)
        blob = png_bytes(size, pixels) if size >= 128 else dib_bytes(size, pixels)
        images.append((size, blob))

    out = bytearray(struct.pack("<HHH", 0, 1, len(images)))
    offset = 6 + 16 * len(images)
    for size, blob in images:
        out.extend(
            struct.pack(
                "<BBBBHHII",
                0 if size >= 256 else size,
                0 if size >= 256 else size,
                0,
                0,
                1,
                32,
                len(blob),
                offset,
            )
        )
        offset += len(blob)
    for _, blob in images:
        out.extend(blob)

    with open(path, "wb") as handle:
        handle.write(bytes(out))


def main() -> None:
    for directory in OUT_DIRS:
        os.makedirs(directory, exist_ok=True)

    icons = OUT_DIRS[0]
    public = OUT_DIRS[1]

    for size, name in ((32, "32x32.png"), (128, "128x128.png"), (256, "128x128@2x.png"), (512, "icon.png")):
        data = png_bytes(size, render(size))
        with open(os.path.join(icons, name), "wb") as handle:
            handle.write(data)
        print(f"wrote {name} ({len(data)} bytes)")

    write_ico(os.path.join(icons, "icon.ico"), [16, 24, 32, 48, 64, 128, 256])
    print("wrote icon.ico")

    with open(os.path.join(public, "icon.png"), "wb") as handle:
        handle.write(png_bytes(256, render(256)))
    print("wrote public/icon.png")


if __name__ == "__main__":
    main()
