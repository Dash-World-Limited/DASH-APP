import { afterEach, describe, expect, it, vi } from 'vitest';

import { isDeclutterPath } from './middleware';

/**
 * The deployment boundary on the web side.
 *
 * Two things are proved separately, because they fail differently. The path
 * decision is a pure function and is tested directly and exhaustively against
 * every route this application actually has. The middleware wrapper is tested
 * through a real `NextRequest`, once per profile, because the thing worth
 * proving there is that the profile is consulted at all — a boundary that
 * refuses nothing on the wrong profile, or refuses everything on the right one,
 * would both pass a test of the predicate alone.
 */

/**
 * Every page in `apps/web/src/app`, split by whether Declutters serves it.
 *
 * Listed literally rather than globbed. A glob would silently absorb a new
 * route into whichever list the pattern happened to match, and the question
 * "which product does this page belong to?" is exactly the one a person adding
 * a page must answer.
 */
const DASH_APP_ONLY = [
  '/',
  '/home',
  '/market',
  '/basket',
  '/browse',
  '/browse/mama-ngozi',
  '/orders',
  '/orders/ord_123',
  '/wallet',
  '/account',
  '/search',
  '/pharmacy',
  '/restaurants',
  '/shops',
  '/vendor',
  '/rider',
  '/ops',
] as const;

const DECLUTTERS = [
  '/declutter',
  '/declutter/sell',
  '/declutter/account',
  '/declutter/join',
  '/declutter/signin',
  '/declutter/verify',
  '/declutter/terms',
  '/declutter/privacy',
  '/declutter/iphone-13-pro-lekki-abc123',
  '/ops/declutter',
  '/signin',
] as const;

describe('which paths a Declutters deployment serves', () => {
  it.each(DECLUTTERS)('serves %s', (pathname) => {
    expect(isDeclutterPath(pathname)).toBe(true);
  });

  it.each(DASH_APP_ONLY.filter((p) => p !== '/'))('does not serve %s', (pathname) => {
    expect(isDeclutterPath(pathname)).toBe(false);
  });

  it('does not serve the dispatch board even though it serves the console beneath it', () => {
    // `/ops` is the delivery dispatch board and the money ledger. `/ops/declutter`
    // is the marketplace's own queue. One prefix is allowed and its parent is not,
    // which is the case a careless `startsWith` gets wrong in the other direction.
    expect(isDeclutterPath('/ops')).toBe(false);
    expect(isDeclutterPath('/ops/declutter')).toBe(true);
    expect(isDeclutterPath('/ops/declutter/anything')).toBe(true);
  });

  it('does not let a longer name borrow an allowed prefix', () => {
    // The failure a bare `startsWith` produces. `/declutter-admin` is not under
    // `/declutter`, and if it were ever added as a DASH APP route it would be
    // served by accident.
    expect(isDeclutterPath('/declutterings')).toBe(false);
    expect(isDeclutterPath('/declutter-admin')).toBe(false);
    expect(isDeclutterPath('/signin-as-admin')).toBe(false);
    expect(isDeclutterPath('/opsdeclutter')).toBe(false);
  });

  it('serves the asset pipeline, because blocking it serves unstyled HTML', () => {
    expect(isDeclutterPath('/_next/static/chunks/main.js')).toBe(true);
    expect(isDeclutterPath('/_next/image')).toBe(true);
  });

  it('serves the fixed root files a crawler asks for by name', () => {
    // robots.txt in particular: the deployment must be able to say `Disallow: /`
    // while indexing is off, and a 404 there is not the same statement.
    expect(isDeclutterPath('/robots.txt')).toBe(true);
    expect(isDeclutterPath('/sitemap.xml')).toBe(true);
    expect(isDeclutterPath('/favicon.ico')).toBe(true);
  });
});

/**
 * Load the middleware with a given profile in the environment.
 *
 * The profile is read at module scope, mirroring how Next inlines it at build
 * time, so each case needs a fresh module registry rather than a mutated global.
 */
async function loadMiddleware(profile: string | undefined) {
  vi.resetModules();
  if (profile === undefined) delete process.env.DEPLOYMENT_PROFILE;
  else process.env.DEPLOYMENT_PROFILE = profile;
  const { middleware } = await import('./middleware');
  const { NextRequest } = await import('next/server');
  return (pathname: string) =>
    middleware(new NextRequest(new URL(pathname, 'https://declutters.dashworldng.com')));
}

describe('the middleware', () => {
  const original = process.env.DEPLOYMENT_PROFILE;

  afterEach(() => {
    if (original === undefined) delete process.env.DEPLOYMENT_PROFILE;
    else process.env.DEPLOYMENT_PROFILE = original;
  });

  it('refuses a DASH APP page on the Declutters deployment', async () => {
    const request = await loadMiddleware('declutters');
    for (const pathname of ['/vendor', '/rider', '/ops', '/orders', '/wallet', '/market']) {
      const response = request(pathname);
      expect(response.status, pathname).toBe(404);
      expect(response.headers.get('x-robots-tag'), pathname).toBe('noindex');
    }
  });

  it('tells the visitor where the site is instead of returning a blank 404', async () => {
    const request = await loadMiddleware('declutters');
    const body = await request('/wallet').text();
    expect(body).toContain('/declutter');
    expect(body).toContain('noindex');
  });

  it('serves the marketplace and the console', async () => {
    const request = await loadMiddleware('declutters');
    for (const pathname of ['/declutter', '/declutter/sell', '/ops/declutter', '/signin']) {
      // `NextResponse.next()` is a 200 carrying the internal continue header
      // rather than a body; what matters is that it is not the 404 above.
      expect(request(pathname).status, pathname).toBe(200);
    }
  });

  it('sends the root to the marketplace whatever hostname was used', async () => {
    // The `next.config.mjs` redirect is scoped to the public hostname. Reaching
    // the instance by its Lightsail name or its address would otherwise serve the
    // DASH APP landing page, which lists every internal console by name.
    const request = await loadMiddleware('declutters');
    const response = request('/');
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/declutter');
  });

  it('refuses nothing on the full platform, including the Declutters pages', async () => {
    // The guarantee that this milestone changed nothing for DASH APP's own
    // deployment. Both products are served there, as before.
    const request = await loadMiddleware('full');
    for (const pathname of [...DASH_APP_ONLY, ...DECLUTTERS]) {
      expect(request(pathname).status, pathname).toBe(200);
    }
  });

  it('refuses nothing when no profile is set', async () => {
    // Absent configuration must not silently switch a DASH APP deployment into
    // the marketplace-only shape. The API defaults the other way — to the
    // strictest guards — because there the risk is a fake provider going
    // unnoticed; here the risk is pages disappearing, so absent means unchanged.
    const request = await loadMiddleware(undefined);
    expect(request('/vendor').status).toBe(200);
    expect(request('/').status).toBe(200);
  });
});
