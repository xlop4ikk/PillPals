"""Generate PNG icons (192x192 and 512x512) for the PWA using only stdlib."""
import math
import struct
import zlib
import os

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "icons")


def write_png(path, width, height, pixels):
    """pixels: list of rows, each row list of (r,g,b,a) tuples."""
    raw = bytearray()
    for row in pixels:
        raw.append(0)  # filter type 0
        for (r, g, b, a) in row:
            raw += bytes((r, g, b, a))
    compressed = zlib.compress(bytes(raw), 9)

    def chunk(tag, data):
        c = tag + data
        crc = zlib.crc32(c) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + c + struct.pack(">I", crc)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png = sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", compressed) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def lerp(a, b, t):
    return int(a + (b - a) * t)


def blend(bg, fg, t):
    return tuple(lerp(bg[i], fg[i], t) for i in range(4))


def make_icon(size):
    """Draw a rounded-square background (mint) with a smiling pill capsule."""
    bg_top = (255, 224, 178, 255)      # warm peach
    bg_bot = (176, 244, 222, 255)      # mint
    cap_orange = (255, 138, 80, 255)
    cap_white = (255, 255, 255, 255)
    eye = (40, 30, 30, 255)
    cheek = (255, 150, 150, 255)

    pixels = []
    cx, cy = size / 2, size / 2
    # capsule geometry: horizontal capsule
    cap_w = size * 0.62
    cap_h = size * 0.30
    radius = cap_h / 2
    left = cx - cap_w / 2
    right = cx + cap_w / 2
    top = cy - cap_h / 2
    bottom = cy + cap_h / 2

    # rounded background corner radius
    corner = size * 0.22

    for y in range(size):
        row = []
        for x in range(size):
            # rounded square background
            # distance from nearest corner
            in_corner = False
            dx = dy = 0
            margin = corner
            if x < margin and y < margin:
                dx, dy = margin - x, margin - y
                in_corner = True
            elif x >= size - margin and y < margin:
                dx, dy = x - (size - margin - 1), margin - y
                in_corner = True
            elif x < margin and y >= size - margin:
                dx, dy = margin - x, y - (size - margin - 1)
                in_corner = True
            elif x >= size - margin and y >= size - margin:
                dx, dy = x - (size - margin - 1), y - (size - margin - 1)
                in_corner = True
            if in_corner and (dx * dx + dy * dy) > margin * margin:
                row.append((0, 0, 0, 0))
                continue

            # vertical gradient background
            t = y / size
            pix = blend(bg_top, bg_bot, t)

            # capsule shape: horizontal stadium
            # inside if within vertical bounds and within horizontal stadium
            in_cap = False
            if top <= y <= bottom:
                if left + radius <= x <= right - radius:
                    in_cap = True
                else:
                    # check end caps
                    if x < left + radius:
                        ex, ey = left + radius, cy
                    else:
                        ex, ey = right - radius, cy
                    if (x - ex) ** 2 + (y - ey) ** 2 <= radius * radius:
                        in_cap = True

            if in_cap:
                # left half orange, right half white
                if x < cx:
                    pix = cap_orange
                else:
                    pix = cap_white
                # subtle shading near top/bottom
                shade = abs(y - cy) / radius
                if shade > 0.7:
                    pix = blend(pix, (0, 0, 0, 255), (shade - 0.7) * 0.4)

                # face: eyes + smile on the orange (left) half
                eye_off_x = size * 0.10
                eye_y = cy - size * 0.02
                eye_r = size * 0.022
                # left eye
                if (x - (cx - eye_off_x)) ** 2 + (y - eye_y) ** 2 <= eye_r * eye_r:
                    pix = eye
                # right eye (wink: a short line) -> draw as small dash
                wink_x = cx + size * 0.02
                if abs(y - eye_y) <= size * 0.008 and abs(x - (cx + eye_off_x * 0.55)) <= size * 0.035:
                    pix = eye
                # smile
                smile_cx = cx - size * 0.05
                smile_cy = cy + size * 0.06
                smile_r = size * 0.07
                d = math.sqrt((x - smile_cx) ** 2 + (y - smile_cy) ** 2)
                if abs(d - smile_r) < size * 0.012 and y > smile_cy:
                    pix = eye
                # cheeks
                cheek_off = size * 0.13
                if (x - (cx - cheek_off)) ** 2 + (y - (cy + size * 0.02)) ** 2 <= (size * 0.025) ** 2:
                    pix = blend(pix, cheek, 0.5)

            row.append(pix)
        pixels.append(row)
    return pixels


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (192, 512):
        px = make_icon(size)
        write_png(os.path.join(OUT_DIR, f"icon-{size}.png"), size, size, px)
        print("wrote", size)


if __name__ == "__main__":
    main()
