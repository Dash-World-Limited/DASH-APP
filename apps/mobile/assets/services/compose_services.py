"""Compose the six service photographs as one consistent set.

Each cut-out is trimmed to its subject, scaled so every subject carries the
same visual weight (equal opaque area, capped by the frame), stood on a shared
baseline, and given a soft contact shadow so nothing floats. Output frames are
88:72, the service tile's image box, at 5x (440 x 360).
"""
import math, sys
from PIL import Image, ImageDraw, ImageFilter

SRC, OUT = sys.argv[1], sys.argv[2]
NAMES = ['food', 'shops', 'pharmacy', 'local-market', 'declutter', 'logistics']
W, H = 440, 360
BOX_W, BOX_H = 404, 318   # the largest a subject may be
BASELINE = 342            # every subject stands here

items = {}
for n in NAMES:
    im = Image.open(f'{SRC}/{n}.png').convert('RGBA')
    im = im.crop(im.split()[3].point(lambda v: 255 if v > 6 else 0).getbbox())
    area = sum(im.split()[3].histogram()[v] * v for v in range(256)) / 255
    items[n] = (im, area)

# Equal opaque area, as large as the most constrained subject allows, but let
# a subject that cannot reach it (a wide, shallow plate) stay at its own cap.
caps = {n: min(BOX_W / im.width, BOX_H / im.height) for n, (im, _) in items.items()}
target = sorted(area * caps[n] ** 2 for n, (_, area) in items.items())[1]   # second-smallest cap
for n, (im, area) in items.items():
    s = min(math.sqrt(target / area), caps[n])
    sub = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    frame = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    # contact shadow: a soft ellipse under the subject's footprint
    shadow = Image.new('L', (W, H), 0)
    sw, sh = sub.width * 0.78, max(10, sub.width * 0.075)
    cx, cy = W / 2, BASELINE - sh * 0.18
    ImageDraw.Draw(shadow).ellipse([cx - sw / 2, cy - sh / 2, cx + sw / 2, cy + sh / 2], fill=70)
    shadow = shadow.filter(ImageFilter.GaussianBlur(sh * 0.9))
    frame.paste((20, 16, 10, 255), (0, 0), shadow)
    frame.alpha_composite(sub, (round((W - sub.width) / 2), BASELINE - sub.height))
    frame.save(f'{OUT}/{n}.png', optimize=True)
    print(f'{n:13} subject {sub.width}x{sub.height}  opaque area {area * s * s / (W * H):.2f} of frame')
