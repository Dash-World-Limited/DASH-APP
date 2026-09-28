/**
 * The launcher icon, splash image and Play Store images, drawn from the DASH
 * wordmark geometry.
 *
 * Every image here is the measured mark (`src/brand/wordmarkGeometry.ts`, the
 * same outlines the app draws) in the approved graphite and bronze on the
 * Light ground. Nothing is typed, traced or redrawn: the outlines are filled
 * directly, so when the geometry changes — David's master SVG, or an approved
 * S rebalance — running this again is the whole of the update.
 *
 *     npm run brand:assets              # write every image
 *     npm run brand:assets -- --check   # exit 1 if any image is out of date
 *
 * No dependencies: a scanline rasteriser with exact horizontal coverage and
 * 16 sub-rows per pixel, and a PNG writer on node:zlib. `--check` compares
 * decoded pixels, so a different zlib producing different bytes is not drift.
 *
 * ## Sizes
 *
 * - `icon.png` 1024² opaque: iOS, and Android launchers older than 8.0
 *   (minSdk is 24). The mark spans 72% of the width.
 * - `adaptive-icon.png` 1024² transparent: the Android 8+ foreground on a
 *   108 dp canvas. Launchers may crop to any shape inside the central 66 dp
 *   circle, so the mark's corners stay well inside it (560 px wide ≈ 59 dp).
 * - `adaptive-icon-monochrome.png`: the same silhouette in one ink, for
 *   Android 13 themed icons, which recolour it.
 * - `splash-icon.png`: the mark alone, trimmed, for expo-splash-screen. The
 *   plugin centres it `imageWidth` dp wide in a 288 dp canvas that Android 12+
 *   crops to a 192 dp circle, so app.config.ts keeps `imageWidth` under 188.
 * - `docs/release/store-assets/play-icon-512.png` (32-bit PNG) and
 *   `feature-graphic-1024x500.png` (24-bit PNG, no alpha), Play's formats.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

import { WORDMARK_BRONZE_PATH, WORDMARK_GRAPHITE_PATH, WORDMARK_VIEWBOX } from '../src/brand/wordmarkGeometry';

const MOBILE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(MOBILE, '..', '..');

/** The Light palette's ground and the wordmark's inks (`src/theme/tokens.ts`; a test holds them equal). */
export const GROUND = '#F8F7F2';
export const GRAPHITE = '#1D1D1D';
export const BRONZE = '#B18546';

type Rgb = readonly [number, number, number];
type Point = readonly [number, number];

export function hex(colour: string): Rgb {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colour);
  if (!m) throw new Error(`not a #RRGGBB colour: ${colour}`);
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}

/** `M x y L x y … Z` contours, the only commands the generated geometry uses. */
export function contours(d: string): Point[][] {
  return d
    .split('Z')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      if (!c.startsWith('M')) throw new Error(`unexpected path command in "${c.slice(0, 12)}"`);
      return c
        .slice(1)
        .split('L')
        .map((pair) => {
          const [x, y] = pair.trim().split(/\s+/).map(Number);
          if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`bad point "${pair}"`);
          return [x!, y!] as const;
        });
    });
}

const [VB_X, VB_Y, VB_W, VB_H] = WORDMARK_VIEWBOX.split(/\s+/).map(Number) as [number, number, number, number];

/**
 * Even-odd coverage (0..1 per pixel) of `polys`, mapped by `scale` and offset
 * `(ox, oy)` from viewBox units to pixels.
 */
export function coverage(polys: Point[][], width: number, height: number, scale: number, ox: number, oy: number): Float32Array {
  const SUB = 16;
  const out = new Float32Array(width * height);
  const edges: [number, number, number, number][] = [];
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const ax = (a[0] - VB_X) * scale + ox, ay = (a[1] - VB_Y) * scale + oy;
      const bx = (b[0] - VB_X) * scale + ox, by = (b[1] - VB_Y) * scale + oy;
      if (ay !== by) edges.push(ay < by ? [ax, ay, bx, by] : [bx, by, ax, ay]);
    }
  }
  const xs: number[] = [];
  for (let py = 0; py < height; py++) {
    for (let s = 0; s < SUB; s++) {
      const y = py + (s + 0.5) / SUB;
      xs.length = 0;
      for (const [x0, y0, x1, y1] of edges) {
        if (y >= y0 && y < y1) xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
      }
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) addSpan(out, py * width, width, xs[i]!, xs[i + 1]!, 1 / SUB);
    }
  }
  return out;
}

/** Adds `weight` × the exact horizontal overlap of [a, b) to each pixel of one row. */
function addSpan(out: Float32Array, row: number, width: number, a: number, b: number, weight: number): void {
  const left = Math.max(0, a), right = Math.min(width, b);
  if (right <= left) return;
  const first = Math.floor(left), last = Math.floor(right);
  if (first === last) {
    out[row + first]! += (right - left) * weight;
    return;
  }
  out[row + first]! += (first + 1 - left) * weight;
  for (let x = first + 1; x < last; x++) out[row + x]! += weight;
  if (last < width) out[row + last]! += (right - last) * weight;
}

export interface Image {
  readonly width: number;
  readonly height: number;
  /** RGBA, straight alpha. */
  readonly pixels: Uint8Array;
  readonly alpha: boolean;
}

/**
 * The mark `markWidth` px wide, centred, on `ground` (or transparent). `inks`
 * overrides the colours, as the monochrome icon does.
 */
export function drawMark(
  width: number,
  height: number,
  markWidth: number,
  options: { ground?: string | null; inks?: { lead: string; bronze: string }; opaqueAlpha?: boolean } = {},
): Image {
  const scale = markWidth / VB_W;
  const ox = (width - markWidth) / 2;
  const oy = (height - VB_H * scale) / 2;
  const lead = coverage(contours(WORDMARK_GRAPHITE_PATH), width, height, scale, ox, oy);
  const bronze = coverage(contours(WORDMARK_BRONZE_PATH), width, height, scale, ox, oy);
  const inkLead = hex(options.inks?.lead ?? GRAPHITE);
  const inkBronze = hex(options.inks?.bronze ?? BRONZE);
  const ground = options.ground === undefined ? GROUND : options.ground;
  const bg = ground ? hex(ground) : null;
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    // The two inks never overlap (the bar floats clear of the A), so their
    // coverages add; "over" either way gives the same result.
    const a = Math.min(1, lead[i]!), b = Math.min(1, bronze[i]!);
    const cover = Math.min(1, a + b);
    let r = 0, g = 0, bl = 0;
    if (cover > 0) {
      r = (inkLead[0] * a + inkBronze[0] * b) / (a + b);
      g = (inkLead[1] * a + inkBronze[1] * b) / (a + b);
      bl = (inkLead[2] * a + inkBronze[2] * b) / (a + b);
    }
    if (bg) {
      pixels[i * 4] = Math.round(bg[0] * (1 - cover) + r * cover);
      pixels[i * 4 + 1] = Math.round(bg[1] * (1 - cover) + g * cover);
      pixels[i * 4 + 2] = Math.round(bg[2] * (1 - cover) + bl * cover);
      pixels[i * 4 + 3] = 255;
    } else {
      pixels[i * 4] = Math.round(r);
      pixels[i * 4 + 1] = Math.round(g);
      pixels[i * 4 + 2] = Math.round(bl);
      pixels[i * 4 + 3] = Math.round(cover * 255);
    }
  }
  return { width, height, pixels, alpha: !bg || options.opaqueAlpha === true };
}

// ---------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** 8-bit RGBA (colour type 6), or RGB (type 2) for an opaque image. */
export function encodePng(image: Image): Buffer {
  const channels = image.alpha ? 4 : 3;
  const raw = Buffer.alloc((image.width * channels + 1) * image.height);
  for (let y = 0; y < image.height; y++) {
    const row = y * (image.width * channels + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < image.width; x++) {
      const src = (y * image.width + x) * 4;
      raw.set(image.pixels.subarray(src, src + channels), row + 1 + x * channels);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = image.alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array()),
  ]);
}

/** Size, colour type and unfiltered pixel rows of a PNG this script wrote. */
export function decodePng(png: Buffer): { width: number; height: number; colourType: number; raw: Buffer } {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let offset = 8;
  let width = 0, height = 0, colourType = 0;
  const data: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      colourType = body[9]!;
    } else if (type === 'IDAT') {
      data.push(body);
    }
    offset += 12 + length;
  }
  return { width, height, colourType, raw: inflateSync(Buffer.concat(data)) };
}

// ---------------------------------------------------------------- the images

export interface Asset {
  /** From the repository root. */
  readonly path: string;
  readonly render: () => Image;
}

export const ASSETS: readonly Asset[] = [
  { path: 'apps/mobile/assets/brand/icon.png', render: () => drawMark(1024, 1024, 737) },
  { path: 'apps/mobile/assets/brand/adaptive-icon.png', render: () => drawMark(1024, 1024, 560, { ground: null }) },
  {
    path: 'apps/mobile/assets/brand/adaptive-icon-monochrome.png',
    render: () => drawMark(1024, 1024, 560, { ground: null, inks: { lead: '#000000', bronze: '#000000' } }),
  },
  // Trimmed to the mark with a hair of margin, so `imageWidth` is the mark's width.
  { path: 'apps/mobile/assets/brand/splash-icon.png', render: () => drawMark(1216, 244, 1200, { ground: null }) },
  // Play asks for a 32-bit PNG: RGBA, fully opaque.
  { path: 'docs/release/store-assets/play-icon-512.png', render: () => drawMark(512, 512, 369, { opaqueAlpha: true }) },
  { path: 'docs/release/store-assets/feature-graphic-1024x500.png', render: () => drawMark(1024, 500, 532) },
];

function main(): void {
  const check = process.argv.includes('--check');
  const stale: string[] = [];
  for (const asset of ASSETS) {
    const png = encodePng(asset.render());
    const file = join(REPO, asset.path);
    if (check) {
      let current: ReturnType<typeof decodePng> | null = null;
      try {
        current = decodePng(readFileSync(file));
      } catch {
        current = null;
      }
      const fresh = decodePng(png);
      if (!current || current.width !== fresh.width || current.height !== fresh.height || !current.raw.equals(fresh.raw)) {
        stale.push(asset.path);
      }
    } else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, png);
      console.warn(`wrote ${asset.path} (${(png.length / 1024).toFixed(0)} KB)`);
    }
  }
  if (check) {
    if (stale.length) {
      console.error(`Out of date with the wordmark geometry — run \`npm run brand:assets\`:\n  ${stale.join('\n  ')}`);
      process.exit(1);
    }
    console.warn('Brand images match the wordmark geometry.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
