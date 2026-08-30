/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // The domain package is shipped as TypeScript source, not built output, so
  // Next has to compile it rather than treating it as a prebuilt dependency.
  transpilePackages: ['@dash/domain'],

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
