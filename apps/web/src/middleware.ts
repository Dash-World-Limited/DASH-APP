import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * What this deployment is allowed to serve.
 *
 * One Next application contains two products. DASH APP's customer shell, vendor
 * console, rider app and dispatch board live here alongside the DASH World
 * Declutters marketplace, and on `declutters.dashworldng.com` only the second of
 * those should exist.
 *
 * The API side of this is settled by capabilities: a Declutters deployment never
 * registers the order, vendor, rider, payment or device routes, so they answer
 * 404. Without the same boundary on the web, the marketplace host would still
 * serve `/vendor`, `/rider`, `/orders`, `/wallet` and the development landing
 * page that lists every internal surface by name — pages that would render, then
 * fail against an API that no longer has those endpoints. A visitor would see a
 * broken DASH APP rather than no DASH APP, and a stranger reading the landing
 * page would be handed a directory of the internal consoles.
 *
 * Refusing in middleware rather than per page is deliberate. A check inside each
 * route is a check somebody adding the next route forgets; this one holds for
 * every path, including ones that do not exist yet.
 *
 * ## Why this is not a security boundary
 *
 * It is a deployment boundary, and the difference matters. Every one of these
 * pages is already useless without a session and a server-side permission check,
 * and the API enforces both — nothing here is the thing standing between a
 * stranger and somebody's order. What this removes is reachable surface that
 * cannot work on this deployment, and the information leak of advertising the
 * internal consoles on a public marketplace domain.
 */

/**
 * The prefixes the Declutters deployment serves.
 *
 * Three groups, each for a different reason:
 *
 *   * **`/declutter`** — the marketplace itself, which is the point of the
 *     deployment. Includes its own sign-in, verification, terms and privacy.
 *   * **`/ops/declutter`** — the team's working console: seller verification,
 *     the submission queue, pricing. Without it there is nobody able to approve
 *     a listing, so the marketplace would have nothing to show. Note that `/ops`
 *     itself — the delivery dispatch board — is *not* included.
 *   * **`/signin`** — how a staff member authenticates. The marketplace's own
 *     `/declutter/signin` is the customer's email-code flow; an administrator
 *     signs in with phone, password and TOTP, and that lives here. Removing it
 *     would lock the team out of the console above.
 */
const DECLUTTERS_PREFIXES: readonly string[] = ['/declutter', '/ops/declutter', '/signin'];

/**
 * Paths that belong to no product and must never be refused.
 *
 * `/_next` is every stylesheet, script and font the marketplace itself loads —
 * blocking it serves unstyled HTML, which is precisely the failure a previous
 * milestone spent a physical test round diagnosing. The rest are conventional
 * root files a crawler or a browser asks for by fixed name.
 */
const INFRASTRUCTURE_PREFIXES: readonly string[] = ['/_next', '/__nextjs'];

const INFRASTRUCTURE_FILES: readonly string[] = [
  '/robots.txt',
  '/sitemap.xml',
  '/favicon.ico',
  '/manifest.webmanifest',
  '/apple-touch-icon.png',
];

/** Does `pathname` sit at or below `prefix`, without matching a longer name? */
function isUnder(pathname: string, prefix: string): boolean {
  // `/declutterings` must not match `/declutter`. Equality or a following
  // slash, never a bare `startsWith`.
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * May the Declutters deployment serve this path?
 *
 * Exported for its own tests: the decision is the part worth proving, and it is
 * a pure function of the path.
 */
export function isDeclutterPath(pathname: string): boolean {
  if (INFRASTRUCTURE_FILES.includes(pathname)) return true;
  if (INFRASTRUCTURE_PREFIXES.some((prefix) => isUnder(pathname, prefix))) return true;
  return DECLUTTERS_PREFIXES.some((prefix) => isUnder(pathname, prefix));
}

/**
 * The body served in place of a DASH APP page.
 *
 * A blank 404 is correct but unkind to somebody following a stale link, so this
 * says where the site actually is. It is deliberately one paragraph of inline
 * HTML rather than a rendered page: middleware cannot render the application's
 * own 404, and a second designed error surface is not worth maintaining for a
 * path that should never be requested.
 */
const NOT_HERE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Not found</title></head>
<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#10131a;color:#e8eaf0;font:16px/1.5 system-ui,sans-serif">
<main style="max-width:28rem;padding:2rem;text-align:center">
<h1 style="margin:0 0 .75rem;font-size:1.25rem">This page is not on this site</h1>
<p style="margin:0 0 1.5rem;color:#9aa3b5">You have reached DASH World Declutters, which only hosts the marketplace.</p>
<a href="/declutter" style="color:#4da3ff">Go to DASH World Declutters</a>
</main></body></html>`;

/**
 * Read once, at module scope, from the running process's environment.
 *
 * Verified rather than assumed, because the assumption was wrong. `next build`
 * inlines `process.env` references into *client* bundles, so the natural guess is
 * that middleware works the same way and the profile is frozen at build time. It
 * is not: the compiled middleware keeps the `process.env.DEPLOYMENT_PROFILE`
 * reference and evaluates it when the module loads. One build artifact started
 * twice, once with the variable and once without, serves `/vendor` as 404 and as
 * 200 respectively.
 *
 * So this is a supervisor setting, and no rebuild is needed to change it — unlike
 * the `NEXT_PUBLIC_*` variables alongside it in the runbook, which genuinely are
 * fixed at build time. Module scope rather than per request because the value
 * cannot change while the process lives.
 */
const isDeclutterDeployment = process.env.DEPLOYMENT_PROFILE === 'declutters';

export function middleware(request: NextRequest): NextResponse {
  if (!isDeclutterDeployment) return NextResponse.next();

  const { pathname } = request.nextUrl;

  // The root is the marketplace here. `next.config.mjs` already redirects it for
  // the public hostname; doing it again without a host condition covers reaching
  // the instance by any other name — its Lightsail DNS name, its address, a
  // health-check probe — each of which would otherwise be served the DASH APP
  // landing page and its list of internal consoles.
  if (pathname === '/') {
    return NextResponse.redirect(new URL('/declutter', request.url));
  }

  if (isDeclutterPath(pathname)) return NextResponse.next();

  return new NextResponse(NOT_HERE, {
    status: 404,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Nothing about this deployment's shape should be cached by an
      // intermediary, and none of it should be indexed.
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
  });
}

export const config = {
  /**
   * Everything except the asset pipeline.
   *
   * `/_next` is excluded here as well as allowed above, so that the common case
   * never runs the middleware at all. The allowance remains because a matcher is
   * easy to edit and an unstyled site is an expensive way to find out.
   */
  matcher: ['/((?!_next/static|_next/image).*)'],
};
