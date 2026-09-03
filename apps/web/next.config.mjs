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

export default nextConfig;
