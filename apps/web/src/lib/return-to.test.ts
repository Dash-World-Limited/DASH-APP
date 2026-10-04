/**
 * Where a sign-in is allowed to send somebody afterwards.
 *
 * These are the open-redirect cases. A sign-in page that honours whatever
 * `next` says lets an attacker send a link carrying the real DASH domain that
 * lands the victim on a copy of this site asking for their code — the domain in
 * front of them is genuine, which is exactly what makes it work.
 *
 * Every case below is a real technique rather than a variation on one.
 */

import { describe, expect, it } from 'vitest';
import { safeReturnTo, signInHref } from './return-to';

describe('safeReturnTo', () => {
  it('keeps a marketplace path', () => {
    expect(safeReturnTo('/declutter')).toBe('/declutter');
    expect(safeReturnTo('/declutter/sell')).toBe('/declutter/sell');
    expect(safeReturnTo('/declutter/iphone-13-pro-dcl-abc123')).toBe(
      '/declutter/iphone-13-pro-dcl-abc123',
    );
  });

  it('keeps a query string on an allowed path', () => {
    expect(safeReturnTo('/declutter?category=cars-vehicles')).toBe('/declutter?category=cars-vehicles');
  });

  it('refuses an absolute URL to another site', () => {
    expect(safeReturnTo('https://evil.example/dash')).toBe('/declutter');
    expect(safeReturnTo('http://evil.example')).toBe('/declutter');
  });

  it('refuses a protocol-relative URL', () => {
    // `//evil.example` is a valid URL to another host that happens to start
    // with a slash, which is what a naive "must start with /" check misses.
    expect(safeReturnTo('//evil.example')).toBe('/declutter');
    expect(safeReturnTo('//evil.example/declutter')).toBe('/declutter');
  });

  it('refuses a backslash, which some browsers resolve as a slash', () => {
    expect(safeReturnTo('/\\evil.example')).toBe('/declutter');
    expect(safeReturnTo('/declutter\\@evil.example')).toBe('/declutter');
  });

  it('refuses somewhere else in this application', () => {
    // Auth here belongs to the marketplace. Bouncing anybody into the
    // operations console or the rider app because a query parameter said so is
    // not a journey this page should be able to complete.
    expect(safeReturnTo('/ops/declutter')).toBe('/declutter');
    expect(safeReturnTo('/rider')).toBe('/declutter');
    expect(safeReturnTo('/wallet')).toBe('/declutter');
  });

  it('refuses a path that merely starts with the right letters', () => {
    expect(safeReturnTo('/declutterings-elsewhere')).toBe('/declutter');
    expect(safeReturnTo('/declutter-evil')).toBe('/declutter');
  });

  it('falls back when there is nothing to fall back from', () => {
    expect(safeReturnTo(null)).toBe('/declutter');
    expect(safeReturnTo(undefined)).toBe('/declutter');
    expect(safeReturnTo('')).toBe('/declutter');
  });

  it('refuses a scheme that is not http', () => {
    expect(safeReturnTo('javascript:alert(1)')).toBe('/declutter');
    expect(safeReturnTo('data:text/html,<script>')).toBe('/declutter');
  });
});

describe('signInHref', () => {
  it('carries an allowed target', () => {
    expect(signInHref('/declutter/sell')).toBe(
      `/declutter/signin?next=${encodeURIComponent('/declutter/sell')}`,
    );
  });

  it('drops a hostile one rather than passing it along', () => {
    expect(signInHref('https://evil.example')).toBe('/declutter/signin');
  });

  it('omits the parameter entirely for the default', () => {
    expect(signInHref('/declutter')).toBe('/declutter/signin');
  });
});
