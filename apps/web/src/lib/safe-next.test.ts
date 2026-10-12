import { describe, expect, it } from 'vitest';

import { safeNext } from './safe-next';

describe('the post-sign-in destination', () => {
  it('keeps a same-site path', () => {
    expect(safeNext('/delete-account')).toBe('/delete-account');
    expect(safeNext('/orders/abc?x=1')).toBe('/orders/abc?x=1');
  });

  it('refuses anything that could leave the site', () => {
    for (const hostile of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', 'evil.example']) {
      expect(safeNext(hostile), hostile).toBe('/browse');
    }
  });

  it('falls back when there is nothing', () => {
    expect(safeNext(null)).toBe('/browse');
    expect(safeNext('')).toBe('/browse');
  });
});
