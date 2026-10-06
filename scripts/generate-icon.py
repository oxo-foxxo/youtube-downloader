"""Generate the Videorix desktop icon using only the Python standard library."""

import binascii
import math
import struct
import zlib
from pathlib import Path

SIZE = 512
SAMPLES = 2
GREEN = (98, 202, 60)
DARK = (21, 59, 12)


def segment_distance(x, y, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    length = dx * dx + dy * dy
    position = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / length))
    return math.hypot(x - (x1 + position * dx), y - (y1 + position * dy))


def inside_rounded_rect(x, y):
    dx = max(abs(x - 16) - 7, 0)
    dy = max(abs(y - 16) - 7, 0)
    return math.hypot(dx, dy) <= 9


def inside_arrow(x, y):
    segments = (
        (16, 7, 16, 19),
        (11, 14, 16, 19),
        (16, 19, 21, 14),
        (8, 22, 8, 25),
        (8, 25, 24, 25),
        (24, 25, 24, 22),
    )
    return min(segment_distance(x, y, *segment) for segment in segments) <= 1.25


def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', binascii.crc32(kind + data))


rows = bytearray()
for py in range(SIZE):
    rows.append(0)
    for px in range(SIZE):
        green_samples = 0
        dark_samples = 0
        for sy in range(SAMPLES):
            for sx in range(SAMPLES):
                x = (px + (sx + 0.5) / SAMPLES) * 32 / SIZE
                y = (py + (sy + 0.5) / SAMPLES) * 32 / SIZE
                if inside_rounded_rect(x, y):
                    green_samples += 1
                    if inside_arrow(x, y):
                        dark_samples += 1
        total = SAMPLES * SAMPLES
        alpha = round(255 * green_samples / total)
        dark_mix = dark_samples / green_samples if green_samples else 0
        rows.extend(
            (
                round(GREEN[0] * (1 - dark_mix) + DARK[0] * dark_mix),
                round(GREEN[1] * (1 - dark_mix) + DARK[1] * dark_mix),
                round(GREEN[2] * (1 - dark_mix) + DARK[2] * dark_mix),
                alpha,
            )
        )

header = struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0)
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(rows, 9)) + chunk(b'IEND', b'')
destination = Path(__file__).resolve().parents[1] / 'build' / 'icon.png'
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_bytes(png)
print(destination)
