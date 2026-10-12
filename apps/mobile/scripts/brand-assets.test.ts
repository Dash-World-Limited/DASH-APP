/**
 * The launcher icon, splash and store images are the measured wordmark, in
 * the approved inks, inside every platform's safe area — and never out of
 * date with the geometry the app itself draws.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import appConfig, { SPLASH_MARK_WIDTH_DP } from '../app.config';
import { palettes } from '../src/theme/tokens';
import { ASSETS, BRONZE, decodePng, encodePng, GRAPHITE, GROUND } from './brand-assets';

const REPO = resolve(__dirname, '..', '..', '..');
const MOBILE = resolve(__dirname, '..');
const read = (path: string) => decodePng(readFileSync(join(REPO, path)));
const asset = (name: string) => ASSETS.find((a) => a.path.endsWith(name))!;

describe('brand images', () => {
  it('use the Light ground and the wordmark inks from the theme', () => {
    expect(GROUND).toBe(palettes.light.background);
    expect(GRAPHITE).toBe(palettes.light.wordmark.lead);
    expect(BRONZE).toBe(palettes.light.wordmark.bronze);
  });

  it('match a fresh render of the current wordmark geometry, pixel for pixel', () => {
    for (const { path, render } of ASSETS) {
      const committed = read(path);
      const fresh = decodePng(encodePng(render()));
      expect([committed.width, committed.height], path).toEqual([fresh.width, fresh.height]);
      // Run `npm run brand:assets` after the wordmark geometry changes.
      expect(committed.raw.equals(fresh.raw), `${path} is out of date`).toBe(true);
    }
  });

  it('are the formats the stores take', () => {
    // iOS rejects an app icon with an alpha channel; Play wants a 32-bit icon
    // and a feature graphic without alpha.
    expect(read('apps/mobile/assets/brand/icon.png')).toMatchObject({ width: 1024, height: 1024, colourType: 2 });
    expect(read('docs/release/store-assets/play-icon-512.png')).toMatchObject({ width: 512, height: 512, colourType: 6 });
    expect(read('docs/release/store-assets/feature-graphic-1024x500.png')).toMatchObject({
      width: 1024,
      height: 500,
      colourType: 2,
    });
    for (const name of ['adaptive-icon.png', 'adaptive-icon-monochrome.png', 'splash-icon.png']) {
      expect(read(`apps/mobile/assets/brand/${name}`).colourType, name).toBe(6);
    }
  });

  it('keep every inked pixel of the adaptive icon inside the 66 dp safe circle of its 108 dp canvas', () => {
    for (const name of ['adaptive-icon.png', 'adaptive-icon-monochrome.png']) {
      const image = asset(name).render();
      const safe = ((66 / 108) * image.width) / 2;
      let outside = 0;
      for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
          if (image.pixels[(y * image.width + x) * 4 + 3]! === 0) continue;
          if (Math.hypot(x + 0.5 - image.width / 2, y + 0.5 - image.height / 2) > safe) outside += 1;
        }
      }
      expect(outside, name).toBe(0);
    }
  });

  it('size the splash mark so Android 12+ does not crop it to its 192 dp circle', () => {
    const splash = read('apps/mobile/assets/brand/splash-icon.png');
    // expo-splash-screen fits the image `imageWidth` dp wide ("contain").
    const halfWidth = SPLASH_MARK_WIDTH_DP / 2;
    const halfHeight = (SPLASH_MARK_WIDTH_DP * splash.height) / splash.width / 2;
    expect(Math.hypot(halfWidth, halfHeight)).toBeLessThan(96);
  });

  it('are what the app configuration points at, with one light splash for every phone', () => {
    const config = appConfig({ config: {} } as Parameters<typeof appConfig>[0]);
    const files = [
      config.icon,
      config.android?.adaptiveIcon?.foregroundImage,
      config.android?.adaptiveIcon?.monochromeImage,
    ];
    const splash = config.plugins?.find((p) => Array.isArray(p) && p[0] === 'expo-splash-screen') as
      | [string, { image: string; imageWidth: number; backgroundColor: string; dark?: unknown }]
      | undefined;
    expect(splash).toBeDefined();
    files.push(splash![1].image);
    for (const file of files) {
      expect(file).toBeTruthy();
      expect(existsSync(join(MOBILE, file!)), file).toBe(true);
    }
    expect(splash![1]).toMatchObject({ imageWidth: SPLASH_MARK_WIDTH_DP, backgroundColor: GROUND });
    expect(splash![1].dark).toBeUndefined();
    expect(config.android?.adaptiveIcon?.backgroundColor).toBe(GROUND);
  });
});
