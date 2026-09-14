"""Derive the DASH wordmark vector from the approved 13 September boards.

There is no master file for the mark, only the AI-rendered boards, where the
wordmark appears four times (Customer and Rider board footers, and the two Home
headers) at 13-27 px cap height. Tracing pixels that small gives wobbly edges,
and drawing the letters by eye is exactly what the brand rule forbids. So the
letters are *measured*: each is modelled as geometry (straight edges,
superellipse bowls), the model is rendered and anti-aliased at the board's own
scale, and its parameters are solved until it reproduces the board's pixels.
The four measurements are then averaged (weighted by size) into one mark.

    python derive_wordmark.py fit    # ~5 min: measure every board instance
    python derive_wordmark.py emit   # write the app geometry (native and web) and SVG masters

Needs Python 3 with Pillow. Run from anywhere; paths are resolved from here.
See README.md in this folder for the method and the results.
"""
import json, math, random, sys
from multiprocessing import Pool
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
BOARDS = HERE.parent
REPO = BOARDS.parents[3]
MOBILE = REPO / 'apps' / 'mobile'
MEASUREMENTS = HERE / 'measurements.json'

# name: (board file, crop box, graphite ink, bronze ink). Background is read from the crop's edges.
INSTANCES = {
    'rider-footer':    ('rider.png',    (40, 1025, 205, 1078), (14, 14, 16), (180, 129, 60)),
    'customer-footer': ('customer.png', (20, 1220, 170, 1272), (18, 18, 20), (178, 126, 56)),
    'rider-home':      ('rider.png',    (128, 46, 222, 76),    (14, 14, 16), (180, 129, 60)),
    'customer-home':   ('customer.png', (85, 58, 165, 86),     (18, 18, 20), (178, 126, 56)),
    # The Vendor board is reference only; measured as a cross-check, never averaged in.
    'vendor-footer':   ('vendor.png',   (40, 1040, 200, 1080), (12, 12, 12), (176, 121, 48)),
}
SOURCES = ['rider-footer', 'customer-footer', 'rider-home', 'customer-home']
F = 6  # supersampling factor

# ---------------------------------------------------------------- pixels -> coverage

def unmix(name):
    """Per-pixel graphite and bronze coverage (0..1): each pixel is modelled as
    background*(1-a-b) + graphite*a + bronze*b and solved by least squares."""
    board, box, dk, gd = INSTANCES[name]
    im = Image.open(BOARDS / board).convert('RGB').crop(box)
    W, H = im.size
    edge = [im.getpixel((x, 0)) for x in range(W)] + [im.getpixel((x, H - 1)) for x in range(W)]
    bg = tuple(sorted(c[i] for c in edge)[len(edge) // 2] for i in range(3))
    u = [dk[i] - bg[i] for i in range(3)]; v = [gd[i] - bg[i] for i in range(3)]
    uu = sum(x * x for x in u); vv = sum(x * x for x in v); uv = sum(u[i] * v[i] for i in range(3))
    det = uu * vv - uv * uv
    A, B = [], []
    for y in range(H):
        ra, rb = [], []
        for x in range(W):
            r = [im.getpixel((x, y))[i] - bg[i] for i in range(3)]
            ur = sum(u[i] * r[i] for i in range(3)); vr = sum(v[i] * r[i] for i in range(3))
            a = min(1, max(0, (ur * vv - vr * uv) / det)); b = min(1, max(0, (vr * uu - ur * uv) / det))
            if a + b > 1: s = a + b; a /= s; b /= s
            ra.append(a); rb.append(b)
        A.append(ra); B.append(rb)
    return W, H, A, B

# ---------------------------------------------------------------- the model

def superellipse(cx, cy, ax, ay, n, a0=0.0, a1=2 * math.pi, steps=160):
    return [se(cx, cy, ax, ay, n, a0 + (a1 - a0) * i / steps) for i in range(steps + 1)]

def se(cx, cy, ax, ay, n, t):
    c, s = math.cos(t), math.sin(t)
    return (cx + ax * math.copysign(abs(c) ** (2 / n), c), cy + ay * math.copysign(abs(s) ** (2 / n), s))

def _g(x, cx, ax, n):
    u = min(1.0, abs((x - cx) / ax)) if ax > 0 else 1.0
    return (1 - u ** n) ** (1 / n)

def d_outline(p, T, B):
    """D: square on the left, superellipse bowl on the right; counter likewise."""
    my = (T + B) / 2
    outer = [(p['x0'], T), (p['xc'], T)] + superellipse(p['xc'], my, p['Rx'], (B - T) / 2, p['nD'], -math.pi / 2, math.pi / 2)[1:-1] + [(p['xc'], B), (p['x0'], B)]
    ix0, it, ib = p['x0'] + p['stem'], T + p['bar'], B - p['bar']
    inner = [(ix0, it), (p['xci'], it)] + superellipse(p['xci'], my, p['rx'], (ib - it) / 2, p['nD2'], -math.pi / 2, math.pi / 2)[1:-1] + [(p['xci'], ib), (ix0, ib)]
    return outer, inner

def a_outline(p, T, B):
    """A: open, no crossbar, flat-topped; its counter is a notch from the baseline."""
    return [(p['al'], B), (p['atl'], T), (p['atr'], T), (p['ar'], B)], [(p['ail'], B), (p['aix'], p['aiy']), (p['air'], B)]

def h_outline(p, T, B):
    return [(p['h0'], T), (p['h1'], T), (p['h1'], p['hb0']), (p['h2'], p['hb0']), (p['h2'], T), (p['h3'], T),
            (p['h3'], B), (p['h2'], B), (p['h2'], p['hb1']), (p['h1'], p['hb1']), (p['h1'], B), (p['h0'], B)]

def bar_rect(p):
    gy0, gy1 = sorted((p['gy0'], p['gy1'])); gx0, gx1 = sorted((p['gx0'], p['gx1']))
    return [(gx0, gy0), (gx1, gy0), (gx1, gy1), (gx0, gy1)]

def s_geometry(p):
    """S: two stacked superellipse rings sharing the spine.

    The upper ring gives the top arm, the upper-left bowl and the spine left of
    the join x = sxs; the lower ring gives the spine right of the join, the
    lower-right bowl and the bottom arm. The lower ring's vertical geometry is
    solved so both spine edges meet exactly at the join, so there is no step.
    Each ring's opening is cut away below/above a horizontal terminal cut, which
    leaves the short hooks the boards show at both terminals."""
    n, ni, tv, xs = p['sn'], p['sni'], p['stv'], p['sxs']
    ucx, ucy, uax, uay = p['ucx'], p['ucy'], p['uax'], p['uay']
    ui_top, ui_bot = ucy - uay + p['stop'], ucy + uay - p['ssp']
    UO = (ucx, ucy, uax, uay, n)
    UI = (ucx, (ui_top + ui_bot) / 2, uax - tv, (ui_bot - ui_top) / 2, ni)
    y_spine_top = UI[1] + UI[3] * _g(xs, ucx, UI[2], ni)
    y_spine_bot = ucy + uay * _g(xs, ucx, uax, n)
    lcx, lax, yb = p['lcx'], p['lax'], p['syb']
    g = _g(xs, lcx, lax, n); lay = (yb - y_spine_top) / (1 + g)
    gi = _g(xs, lcx, lax - tv, ni); b = yb - p['sbot']; a = (2 * y_spine_bot - b * (1 - gi)) / (1 + gi)
    LO = (lcx, yb - lay, lax, lay, n)
    LI = (lcx, (a + b) / 2, lax - tv, (b - a) / 2, ni)
    return UO, UI, LO, LI

def render_masks(p, W, H, s=F):
    """Binary high-resolution masks (graphite, bronze)."""
    T, B = p['T'], p['B']
    size = (int(W * s), int(H * s))
    def poly(draw, pts, fill): draw.polygon([(x * s, y * s) for x, y in pts], fill=fill)
    dark = Image.new('L', size, 0); dd = ImageDraw.Draw(dark)
    o, i = d_outline(p, T, B); poly(dd, o, 255); poly(dd, i, 0)
    a = Image.new('L', size, 0); ad = ImageDraw.Draw(a)
    o, i = a_outline(p, T, B); poly(ad, o, 255); poly(ad, i, 0)
    dark = ImageChops.lighter(dark, a)
    gold = Image.new('L', size, 0); gdr = ImageDraw.Draw(gold)
    poly(gdr, h_outline(p, T, B), 255)
    UO, UI, LO, LI = s_geometry(p)
    big, e, xs = 1000, 0.02, p['sxs']
    cuts = [[(xs + e, p['scu']), (big, p['scu']), (big, big), (xs + e, big)],
            [(xs - e, p['scl']), (-big, p['scl']), (-big, -big), (xs - e, -big)]]
    for (ro, ri), cut in (((UO, UI), cuts[0]), ((LO, LI), cuts[1])):
        r = Image.new('L', size, 0); rd = ImageDraw.Draw(r)
        poly(rd, superellipse(*ro[:4], ro[4], steps=240), 255); poly(rd, superellipse(*ri[:4], ri[4], steps=240), 0); poly(rd, cut, 0)
        gold = ImageChops.lighter(gold, r)
    bar = Image.new('L', size, 0); poly(ImageDraw.Draw(bar), bar_rect(p), 255)
    gold = ImageChops.lighter(gold, ImageChops.subtract(bar, a))  # the graphite A sits over the bar
    return dark, gold

def render(p, W, H):
    out = []
    for m in render_masks(p, W, H):
        if p['blur'] > 0.05: m = m.filter(ImageFilter.GaussianBlur(p['blur'] * F))
        out.append(m.resize((W, H), Image.BOX))
    return out

def loss(p, obs, W, H):
    pd, pg = render(p, W, H); od, og = obs
    return sum((a - b) * (a - b) for a, b in zip(pd.tobytes(), od)) + sum((a - b) * (a - b) for a, b in zip(pg.tobytes(), og))

# ---------------------------------------------------------------- solving

STEP = {'nD': .2, 'nD2': .2, 'sn': .2, 'sni': .2, 'blur': .1}
XS = {'x0', 'xc', 'xci', 'al', 'atl', 'atr', 'ar', 'ail', 'aix', 'air', 'gx0', 'gx1', 'ucx', 'lcx', 'sxs', 'h0', 'h1', 'h2', 'h3'}
YS = {'aiy', 'gy0', 'gy1', 'ucy', 'syb', 'scu', 'scl', 'hb0', 'hb1', 'T', 'B'}
WX = {'Rx', 'stem', 'rx', 'uax', 'lax', 'stv'}
WY = {'bar', 'uay', 'stop', 'ssp', 'sbot'}
# A rough starting shape in rider-footer pixels; the solver does the measuring.
START = dict(x0=12, xc=30, Rx=14, nD=2.6, stem=8, bar=7, xci=27, rx=8, nD2=2.6,
             al=43, atl=57, atr=65, ar=80, ail=51, aix=61, aiy=22, air=72, gx0=56, gx1=63, gy0=28, gy1=31,
             ucx=94.75, ucy=20.4, uax=13.95, uay=7.6, stop=5.8, ssp=5.5, stv=7.0, lcx=95, lax=14, syb=39.3, sbot=6.8,
             sxs=95, scu=20.2, scl=31.3, sn=3.0, sni=3.0, h0=115, h1=123, h2=139, h3=147, hb0=24, hb1=30, T=12, B=39, blur=0.4)
START_BOX = (12, 147, 12, 39)

def solve(p, obs, W, H, rounds=300, seed=1):
    """Pattern search: nudge one parameter at a time, keep what lowers the error."""
    rnd = random.Random(seed); keys = list(p); steps = {k: STEP.get(k, 0.8) for k in keys}
    best = loss(p, obs, W, H)
    for _ in range(rounds):
        improved = False; rnd.shuffle(keys)
        for k in keys:
            for sign in (1, -1):
                q = dict(p); q[k] = p[k] + sign * steps[k]
                if q['blur'] < 0 or min(q['nD'], q['nD2'], q['sn'], q['sni']) < 1.2: continue
                e = loss(q, obs, W, H)
                if e < best: best, p, improved = e, q, True; break
        if not improved:
            for k in steps: steps[k] *= 0.5
            if max(steps.values()) < 0.004: break
    return p, math.sqrt(best / (2 * W * H)) / 255

def rescale(ref, rb, b):
    (rx0, rx1, rT, rB), (x0, x1, T, B) = rb, b
    sx = (x1 - x0) / (rx1 - rx0); sy = (B - T) / (rB - rT); p = {}
    for k, v in ref.items():
        p[k] = x0 + (v - rx0) * sx if k in XS else T + (v - rT) * sy if k in YS else v * sx if k in WX else v * sy if k in WY else v
    return p

def ink_box(A, B, W, H):
    xs = [x for x in range(W) for y in range(H) if A[y][x] + B[y][x] > .5]
    ys = [y for y in range(H) for x in range(W) if A[y][x] + B[y][x] > .5]
    return (min(xs) - .5, max(xs) + .5, min(ys) - .5, max(ys) + .5)

def measure(args):
    name, ref = args
    W, H, A, B = unmix(name)
    obs = (bytes(round(255 * v) for r in A for v in r), bytes(round(255 * v) for r in B for v in r))
    box = ink_box(A, B, W, H)
    p = rescale(ref[0], ref[1], box) if ref else rescale(START, START_BOX, box)
    p, rms = solve(p, obs, W, H, seed=len(name))
    return name, {'params_px': p, 'rms': rms, 'size': [W, H], 'ink_box': box}

def to_cap_units(p):
    s = 100 / (p['B'] - p['T']); q = {}
    for k, v in p.items():
        q[k] = (v - p['x0']) * s if k in XS else (v - p['T']) * s if k in YS else v * s if k in WX | WY else v
    q['gy0'], q['gy1'] = sorted((q['gy0'], q['gy1'])); q['gx0'], q['gx1'] = sorted((q['gx0'], q['gx1']))
    return q

def interior_colours(fits):
    """Median board colour of pixels well inside the fitted letters."""
    G, D = [], []
    for name in SOURCES:
        board, box, _, _ = INSTANCES[name]; im = Image.open(BOARDS / board).convert('RGB').crop(box)
        p = fits[name]['params_px']; W, H = fits[name]['size']
        dm, gm = (m.resize((W, H), Image.BOX) for m in render_masks(p, W, H, s=8))
        for y in range(1, H - 1):
            for x in range(1, W - 1):
                nb = [(x + i, y + j) for i in (-1, 0, 1) for j in (-1, 0, 1)]
                if all(gm.getpixel(q) == 255 for q in nb): G.append(im.getpixel((x, y)))
                if all(dm.getpixel(q) == 255 for q in nb): D.append(im.getpixel((x, y)))
    med = lambda L: '#%02X%02X%02X' % tuple(sorted(v[i] for v in L)[len(L) // 2] for i in range(3))
    return {'graphite': med(D), 'bronze': med(G), 'pixels': {'graphite': len(D), 'bronze': len(G)}}

def cmd_fit():
    fits = dict([measure(('rider-footer', None))])
    ref = (fits['rider-footer']['params_px'], fits['rider-footer']['ink_box'])
    with Pool(4) as pool:
        fits.update(pool.map(measure, [(n, ref) for n in INSTANCES if n != 'rider-footer']))
    units = {n: to_cap_units(f['params_px']) for n, f in fits.items()}
    w = {n: fits[n]['params_px']['B'] - fits[n]['params_px']['T'] for n in SOURCES}
    keys = [k for k in units['rider-footer'] if k not in ('blur', 'T', 'B')]
    mark = {'T': 0.0, 'B': 100.0}; spread = {}
    for k in keys:
        m = sum(units[n][k] * w[n] for n in SOURCES) / sum(w.values())
        mark[k] = m; spread[k] = math.sqrt(sum((units[n][k] - m) ** 2 * w[n] for n in SOURCES) / sum(w.values()))
    out = {'about': 'Wordmark geometry in cap-height units (cap = 100), measured from the 13 September boards by derive_wordmark.py.',
           'mark': mark, 'spread_between_boards': spread, 'colours': interior_colours(fits),
           'instances': {n: {'rms_coverage_error': f['rms'], 'cap_height_px': w.get(n, fits[n]['params_px']['B'] - fits[n]['params_px']['T']),
                             'used_in_mark': n in SOURCES, 'params_px': f['params_px']} for n, f in fits.items()}}
    MEASUREMENTS.write_text(json.dumps(out, indent=1), encoding='utf-8')
    for n, f in fits.items(): print(f"{n:16} rms {f['rms']:.4f}")
    print('colours', out['colours'])

# ---------------------------------------------------------------- vector output

TOL = 0.01  # 1/10,000 of the cap height

def _bisect(f, lo, hi, target):
    flo = f(lo) - target
    for _ in range(80):
        mid = (lo + hi) / 2; fm = f(mid) - target
        if (fm < 0) == (flo < 0): lo, flo = mid, fm
        else: hi = mid
    return (lo + hi) / 2

def _arc(e, t0, t1, steps=720):
    return [se(*e[:4], e[4], t0 + (t1 - t0) * i / steps) for i in range(steps + 1)]

def _dp(pts, tol=TOL):
    if len(pts) < 3: return pts
    (x0, y0), (x1, y1) = pts[0], pts[-1]; dx, dy = x1 - x0, y1 - y0; L = math.hypot(dx, dy) or 1e-12
    dmax, idx = 0, 0
    for i in range(1, len(pts) - 1):
        d = abs(dy * (pts[i][0] - x0) - dx * (pts[i][1] - y0)) / L
        if d > dmax: dmax, idx = d, i
    if dmax <= tol: return [pts[0], pts[-1]]
    return _dp(pts[:idx + 1], tol)[:-1] + _dp(pts[idx:], tol)

def outlines(P):
    """Closed contours in cap units: graphite (D, A) and bronze (S, H, bar)."""
    d_outer = [(P['x0'], 0.0)] + _dp(_arc((P['xc'], 50.0, P['Rx'], 50.0, P['nD']), -math.pi / 2, math.pi / 2)) + [(P['x0'], 100.0)]
    it_, ib_ = P['bar'], 100 - P['bar']
    d_inner = [(P['x0'] + P['stem'], it_)] + _dp(_arc((P['xci'], 50.0, P['rx'], (ib_ - it_) / 2, P['nD2']), -math.pi / 2, math.pi / 2)) + [(P['x0'] + P['stem'], ib_)]
    a_outer, a_inner = a_outline(P, 0.0, 100.0)
    bar = bar_rect(P)
    for y in (bar[0][1], bar[2][1]):   # the bar floats inside the counter, clear of both legs
        f = (100 - y) / (100 - P['aiy'])
        assert P['ail'] + f * (P['aix'] - P['ail']) < bar[0][0] and bar[1][0] < P['air'] - f * (P['air'] - P['aix'])
    UO, UI, LO, LI = s_geometry(P); xs, scu, scl = P['sxs'], P['scu'], P['scl']
    assert xs < UO[0] and xs < LO[0] and scu < LO[1] - LO[3] and scl > UO[1] + UO[3]
    X = lambda e: (lambda t: se(*e[:4], e[4], t)[0]); Y = lambda e: (lambda t: se(*e[:4], e[4], t)[1]); pi = math.pi
    t1 = _bisect(Y(UO), -pi / 2, 0, scu)                  # UO right side at the upper cut
    t2 = _bisect(X(UO), -1.5 * pi, -pi, xs)               # UO underside at the join
    t3 = _bisect(X(LI), -pi, -pi / 2, xs)                 # LI top at the join
    t4 = _bisect(Y(LI), pi / 2, pi, scl) if scl > LI[1] else _bisect(Y(LI), pi, 1.5 * pi, scl)
    t5 = _bisect(Y(LO), pi / 2, pi, scl) if scl > LO[1] else _bisect(Y(LO), pi, 1.5 * pi, scl)
    t6 = _bisect(X(LO), -pi, -pi / 2, xs)                 # LO top at the join
    t7 = _bisect(X(UI), pi / 2, pi, xs)                   # UI floor at the join
    t8 = _bisect(Y(UI), 1.5 * pi, 2 * pi, scu) if scu < UI[1] else _bisect(Y(UI), 0, pi / 2, scu)
    s = _dp(_arc(UO, t1, t2)) + _dp(_arc(LI, t3, t4))[1:] + _dp(_arc(LO, t5, t6)) + _dp(_arc(UI, t7, t8))[1:]
    assert math.dist(se(*UO[:4], UO[4], t2), se(*LI[:4], LI[4], t3)) < 1e-3
    assert math.dist(se(*LO[:4], LO[4], t6), se(*UI[:4], UI[4], t7)) < 1e-3
    return {'graphite': [d_outer, d_inner, a_outer, a_inner], 'bronze': [s, h_outline(P, 0.0, 100.0), bar]}

def _d(contours):
    return ''.join('M' + 'L'.join(f'{x:.2f} {y:.2f}' for x, y in c) + 'Z' for c in contours)

def cmd_emit():
    m = json.loads(MEASUREMENTS.read_text(encoding='utf-8'))
    o = outlines(m['mark'])
    pts = [pt for group in o.values() for c in group for pt in c]
    x0, x1 = min(x for x, _ in pts), max(x for x, _ in pts); y0, y1 = min(y for _, y in pts), max(y for _, y in pts)
    vb = [round(x0, 2), round(y0, 2), round(x1 - x0, 2), round(y1 - y0, 2)]
    graphite, bronze = _d(o['graphite']), _d(o['bronze'])
    c = m['colours']
    (MOBILE / 'assets' / 'brand').mkdir(parents=True, exist_ok=True)
    for fname, lead in (('dash-wordmark.svg', c['graphite']), ('dash-wordmark-on-dark.svg', '#F4F1EA')):
        (MOBILE / 'assets' / 'brand' / fname).write_text(
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{" ".join(map(str, vb))}">'
            f'<title>DASH</title><path fill="{lead}" fill-rule="evenodd" d="{graphite}"/><path fill="{c["bronze"]}" d="{bronze}"/></svg>\n',
            encoding='utf-8')
    ts = f'''/**
 * DASH wordmark outlines. GENERATED by
 * docs/design/boards/2026-09-13/wordmark/derive_wordmark.py; do not edit by hand.
 *
 * Measured from the director-approved boards (see the README beside that
 * script). Units: cap height = 100. `graphite` is the D and the open A
 * (even-odd: the counters are holes); `bronze` is the S, the H and the bar in
 * the A's counter. Colours live in the theme tokens, not here.
 */

export const WORDMARK_VIEWBOX = '{" ".join(map(str, vb))}';

/** Width over height of the mark. */
export const WORDMARK_ASPECT = {vb[2] / vb[3]:.4f};

export const WORDMARK_GRAPHITE_PATH =
  '{graphite}';

export const WORDMARK_BRONZE_PATH =
  '{bronze}';
'''
    # One geometry, two apps: the native client and the web (Vendor console,
    # sign-in, header) draw the same measured outlines.
    (MOBILE / 'src' / 'brand' / 'wordmarkGeometry.ts').write_text(ts, encoding='utf-8')
    web = REPO / 'apps' / 'web' / 'src' / 'components' / 'brand'
    web.mkdir(parents=True, exist_ok=True)
    (web / 'wordmarkGeometry.ts').write_text(ts, encoding='utf-8')
    print('viewBox', vb, 'aspect', round(vb[2] / vb[3], 4), 'path bytes', len(graphite) + len(bronze))

if __name__ == '__main__':
    {'fit': cmd_fit, 'emit': cmd_emit}[sys.argv[1] if len(sys.argv) > 1 else 'emit']()
