"""The S rebalance: corrections of the measured S, for David to choose between.

The measured S is what the boards show (a refit with slanted terminals moved
no board's error; see README.md). What the boards cannot say is whether that S
is the S David wants. Measured against the rest of the mark it has two
imbalances, and each option below corrects one, both, or neither. Every option
is a defined operation on the measured parameters, not a drawing:

    measured           the live mark, unchanged
    symmetric          the S made point-symmetric (it maps onto itself turned
                       180 degrees): both bowls the width of their mean, both
                       arms and both hooks the same, the spine centred
    lighter            the three horizontals thinned equally, the spine kept
                       centred, until the S carries the same ink per unit of
                       width as the H beside it; outline, width and verticals
                       unchanged
    lighter-symmetric  both

Only the S changes. D, A, H, the bar in the A, the colours and the spacing are
the measured ones in every option.

    python s_rebalance.py sheet            # writes s-rebalance-options.png and prints the numbers
    python s_rebalance.py apply <option>   # after David approves: emits that option as the app geometry

`apply measured` puts the measured S back. Needs Python 3 with Pillow.
"""
import json, sys

from PIL import Image, ImageChops, ImageDraw, ImageFont

from derive_wordmark import HERE, MEASUREMENTS, emit, outlines

SHEET = HERE / 's-rebalance-options.png'
GROUND, GRAPHITE, BRONZE, INK_MUTED = (248, 247, 242), (29, 29, 29), (177, 133, 70), (96, 96, 96)


def symmetric(p):
    """Point-symmetric about the S's own centre (derivation in README.md)."""
    q = dict(p)
    left, right = min(p['ucx'] - p['uax'], p['lcx'] - p['lax']), max(p['ucx'] + p['uax'], p['lcx'] + p['lax'])
    cx, a = (left + right) / 2, (p['uax'] + p['lax']) / 2
    top, bottom = p['ucy'] - p['uay'], p['syb']
    cy = (top + bottom) / 2
    # The model needs the spine's join strictly left of the ring centres; a
    # twentieth of a unit is far below what any screen shows.
    q.update(ucx=cx, lcx=cx, uax=a, lax=a, sxs=cx - 0.05)
    # The spine is [UO bottom - ssp, UO bottom] at the join; centre it on cy.
    q['ucy'] = (cy + p['ssp'] / 2 + top) / 2
    q['uay'] = (cy + p['ssp'] / 2 - top) / 2
    arm = (p['stop'] + p['sbot']) / 2
    q['stop'] = q['sbot'] = arm
    hook = ((p['scu'] - (top + p['stop'])) + ((bottom - p['sbot']) - p['scl'])) / 2
    q['scu'], q['scl'] = top + arm + hook, bottom - arm - hook
    return q


def lighter(p, d):
    """Each horizontal `d` thinner: the counters grow, the spine stays centred,
    and the hooks keep their length. The outline does not move."""
    q = dict(p)
    q['stop'] -= d
    q['sbot'] -= d
    q['ssp'] -= d
    q['ucy'] -= d / 4  # upper ring's bottom (the spine's lower edge) up d/2, its top fixed
    q['uay'] -= d / 4
    q['scu'] -= d
    q['scl'] += d
    return q


# ---------------------------------------------------------------- measuring the options

S = 8  # pixels per cap-height unit when measuring


def masks(mark, scale=S, pad=2):
    """(graphite, S, H+bar) masks and the offset, all in one frame."""
    o = outlines(mark)
    W, H = int((mark['h3'] + 2 * pad) * scale), int((100.2 + 2 * pad) * scale)

    def fill(contours):
        m = Image.new('1', (W, H), 0)
        for c in contours:
            t = Image.new('1', (W, H), 0)
            ImageDraw.Draw(t).polygon([((x + pad) * scale, (y + pad) * scale) for x, y in c], fill=1)
            m = ImageChops.logical_xor(m, t)
        return m

    return fill(o['graphite']), fill([o['bronze'][0]]), fill(o['bronze'][1:])


def ink(m):
    return m.histogram()[-1] if m.mode == 'L' else m.convert('L').histogram()[255]


def measures(mark):
    _, s_mask, _ = masks(mark)
    h_only = Image.new('1', s_mask.size, 0)
    o = outlines(mark)
    ImageDraw.Draw(h_only).polygon([((x + 2) * S, (y + 2) * S) for x, y in o['bronze'][1]], fill=1)
    box = s_mask.getbbox()
    s_crop = s_mask.crop(box)
    s_width = box[2] - box[0]
    h_width = (mark['h3'] - mark['h0']) * S
    turned = s_crop.rotate(180)
    both = ImageChops.logical_and(s_crop, turned)
    either = ImageChops.logical_or(s_crop, turned)
    return {
        's_ink_per_width': ink(s_crop) / (s_width * 100 * S),
        'h_ink_per_width': ink(h_only) / (h_width * 100 * S),
        'symmetry_iou': ink(both) / ink(either),
        'arms': (mark['stop'], mark['ssp'], mark['sbot']),
    }


def match_h(p, build):
    """The thinning at which the S's ink per unit width equals the H's."""
    lo, hi = 0.0, 8.0
    for _ in range(18):
        mid = (lo + hi) / 2
        m = measures(build(p, mid))
        if m['s_ink_per_width'] > m['h_ink_per_width']:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def options():
    m = json.loads(MEASUREMENTS.read_text(encoding='utf-8'))
    p = m['mark']
    d_lighter = match_h(p, lighter)
    d_both = match_h(p, lambda q, d: symmetric(lighter(q, d)))
    return m, {
        'measured': (p, 'The live mark: the S as measured from the boards.'),
        'symmetric': (symmetric(p), 'Point-symmetric; same weight.'),
        'lighter': (lighter(p, d_lighter), f'Horizontals {d_lighter:.1f} units thinner; same outline.'),
        'lighter-symmetric': (symmetric(lighter(p, d_both)), f'Both: symmetric, horizontals {d_both:.1f} thinner.'),
    }


# ---------------------------------------------------------------- the comparison sheet

def draw_mark(mark, cap_px, colours=(GRAPHITE, BRONZE), ground=GROUND):
    scale = cap_px / 100
    ss = max(1, int(round(8 / max(scale, 0.01))))  # supersample small sizes
    k = scale * ss
    o = outlines(mark)
    W, H = int((mark['h3'] + 4) * k), int(104 * k)
    im = Image.new('RGB', (W, H), ground)
    for group, colour, evenodd in (('graphite', colours[0], True), ('bronze', colours[1], False)):
        m = Image.new('1', (W, H), 0)
        for c in o[group]:
            t = Image.new('1', (W, H), 0)
            ImageDraw.Draw(t).polygon([((x + 2) * k, (y + 2) * k) for x, y in c], fill=1)
            m = ImageChops.logical_xor(m, t) if evenodd else ImageChops.logical_or(m, t)
        im.paste(colour, (0, 0), m.convert('L'))
    return im.resize((max(1, W // ss), max(1, H // ss)), Image.LANCZOS)


def font(size):
    for name in ('DejaVuSans.ttf', 'Arial.ttf', 'LiberationSans-Regular.ttf'):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def cmd_sheet():
    m, opts = options()
    rows = []
    for name, (mark, blurb) in opts.items():
        q = measures(mark)
        print(f"{name:18} S ink/width {q['s_ink_per_width']:.3f} (H {q['h_ink_per_width']:.3f})  "
              f"symmetry IoU {q['symmetry_iou']:.3f}  arms/spine/bottom "
              + '/'.join(f'{v:.1f}' for v in q['arms']))
        big = draw_mark(mark, 120)
        header = draw_mark(mark, 63)  # 24 pt letters on a 2.625x phone: the Home header
        small = draw_mark(mark, 24)
        dark = draw_mark(mark, 63, colours=((244, 241, 234), BRONZE), ground=(14, 15, 17))
        rows.append((name, blurb, q, big, header, small, dark))
    row = lambda r: r[4].width + 20 + r[6].width + 20 + r[5].width
    stats = {r[0]: f"S ink per unit width {r[2]['s_ink_per_width']:.3f} (the H: {r[2]['h_ink_per_width']:.3f}) · "
                   f"overlap with itself turned 180°: {r[2]['symmetry_iou']:.3f} · arm / spine / arm "
                   + ' / '.join(f'{v:.1f}' for v in r[2]['arms']) for r in rows}
    text_width = max(ImageDraw.Draw(Image.new('RGB', (1, 1))).textlength(t, font=font(15)) for t in stats.values())
    W = 40 + int(max(max(max(r[3].width, row(r)) for r in rows), text_width)) + 40
    H = 90 + sum(56 + r[3].height + 12 + r[4].height + 38 for r in rows)
    sheet = Image.new('RGB', (W, H), (255, 255, 255))
    d = ImageDraw.Draw(sheet)
    d.text((40, 24), 'The S rebalance: options for David', fill=GRAPHITE, font=font(26))
    d.text((40, 58), 'Only the S differs. D, A, H, the bar, the colours and the spacing are the measured ones.', fill=INK_MUTED, font=font(15))
    y = 90
    for name, blurb, q, big, header, small, dark in rows:
        d.text((40, y), f'{name} — {blurb}', fill=GRAPHITE, font=font(19))
        d.text((40, y + 26), stats[name], fill=INK_MUTED, font=font(15))
        y += 56
        sheet.paste(big, (40, y))
        y += big.height + 12
        sheet.paste(header, (40, y))
        sheet.paste(dark, (60 + header.width, y))
        sheet.paste(small, (80 + header.width + dark.width, y + (header.height - small.height) // 2))
        if name == 'measured':
            d.text((40, y + header.height + 6), 'large · Home header (24 pt), light and dark · 24 px', fill=INK_MUTED, font=font(13))
        y += header.height + 38
    sheet.save(SHEET, optimize=True)
    print('wrote', SHEET.name)


def cmd_apply(name):
    m, opts = options()
    if name not in opts:
        sys.exit(f'unknown option {name!r}; one of: {", ".join(opts)}')
    mark, blurb = opts[name]
    note = None if name == 'measured' else (
        f"The S is the approved '{name}' rebalance of the measured S ({blurb}), made by\n"
        " * docs/design/boards/2026-09-13/wordmark/s_rebalance.py.")
    emit(mark, m['colours'], s_note=note)
    print('applied', name)


if __name__ == '__main__':
    args = sys.argv[1:] or ['sheet']
    if args[0] == 'sheet':
        cmd_sheet()
    elif args[0] == 'apply' and len(args) == 2:
        cmd_apply(args[1])
    else:
        sys.exit(__doc__)
