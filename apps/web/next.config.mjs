import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';

/**
 * Development and production builds must not share an output directory.
 *
 * They did, and it cost a physical test round. `next dev` and `next build`
 * both wrote to `.next`, so running a production build while the dev server
 * was serving a handset replaced the manifests underneath it. The HTML kept
 * rendering — the dev server still answered — but every asset URL it had
 * already handed out stopped resolving, and the app appeared on the phone as
 * unstyled raw HTML: default blue links, bulleted lists, the visually-hidden
 * "Skip to content" link suddenly visible because the stylesheet carrying
 * `sr-only` was a 404.
 *
 * What made it expensive is that nothing failed. The build reported success,
 * the dev server reported 200s for pages, and the damage showed up only on a
 * device, looking exactly like a CSS bug in whatever had been committed most
 * recently.
 *
 * Splitting the directories makes the collision unrepresentable rather than
 * merely discouraged, which is the same reasoning as the unique constraint on
 * push tokens: a rule you have to remember is one you will eventually forget
 * while concentrating on something else.
 *
 * Keyed on the phase Next itself reports, not on inspecting `argv` or
 * `NODE_ENV`. `next dev`, `next build` and `next start` each announce which
 * they are, so `next start` naturally reads the directory `next build` wrote —
 * they share a phase-default and only the development server is moved aside.
 */
const DEV_DIST_DIR = '.next-dev';
const PRODUCTION_DIST_DIR = '.next';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // The domain package is shipped as TypeScript source, not built output, so
  // Next has to compile it rather than treating it as a prebuilt dependency.
  transpilePackages: ['@dash/domain'],

  /**
   * Let the bundler follow TypeScript's `.js` import specifiers.
   *
   * `packages/domain` is compiled with `moduleResolution: NodeNext`, where a
   * relative import of a sibling module must be written with the extension it
   * will have *after* compilation — `./protocol.js` for `protocol.ts`. Node and
   * Vitest both understand that. Webpack, resolving the same file as source,
   * looks for a `protocol.js` that does not exist and fails.
   *
   * This mapping is the standard fix, and it applies to the whole package
   * rather than to one module: `pricing` imports `../money/index.js`, `mfa`
   * imports `../permissions/index.js`, and every one of those would fail the
   * same way. Milestone V is simply the first time the web app imported
   * anything from `@dash/domain` at all, which is why `transpilePackages` was
   * already configured but this was not.
   */
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },

  /**
   * `/browse` became `/home` when the customer shell arrived.
   *
   * Redirected rather than removed: the old path is in test scripts, in
   * bookmarks, and on at least one handset that is mid-test. `/browse/[slug]`
   * is deliberately untouched — vendor pages keep the URL they have always
   * had, and only the index moved.
   */
  async redirects() {
    return [{ source: '/browse', destination: '/home', permanent: false }];
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
        ],
      },
    ];
  },
};

/**
 * Next calls this with the phase it is running in, so the choice is made from
 * what Next says it is doing rather than from a guess about the command line.
 */
export default (phase) => ({
  ...nextConfig,
  distDir: phase === PHASE_DEVELOPMENT_SERVER ? DEV_DIST_DIR : PRODUCTION_DIST_DIR,
});
