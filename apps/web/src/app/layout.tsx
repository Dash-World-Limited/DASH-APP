import type { Metadata, Viewport } from 'next';
import { Manrope } from 'next/font/google';
import './globals.css';

/**
 * Manrope, self-hosted by Next at build time.
 *
 * Loaded through `next/font` rather than a stylesheet link so the files are
 * served from our own origin: no request to a third party on first paint, no
 * layout shift while a webfont arrives, and nothing for a network-blocked
 * handset to fail to fetch.
 */
const manrope = Manrope({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-manrope',
});

export const metadata: Metadata = {
  title: 'DASH APP — delivery across Lagos',
  description:
    'Food, groceries, pharmacy and parcels delivered across Lagos. Order in minutes, track every step.',
  // The app is not public and must never be indexed while it is a development
  // build serving fictional vendors.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  /**
   * Lets the page reach under the system bars — and, more to the point, makes
   * `env(safe-area-inset-*)` report real numbers.
   *
   * Android 15 forces every app to draw edge-to-edge and the shell targets SDK
   * 36, so the WebView already starts at y=0 underneath the status bar whether
   * we ask for it or not. Without `cover`, though, the insets all resolve to
   * `0px`, so the CSS written to avoid the status bar quietly does nothing and
   * the header sits under the clock. That is the defect this fixes: the safe
   * area was being read, but the browser was never told there was one.
   */
  viewportFit: 'cover',
  // Zoom is NOT disabled. Locking it out breaks the app for anyone who needs
  // to enlarge text, which is a real accessibility failure and not a
  // stylistic choice.
  themeColor: '#0b1424',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-NG" className={manrope.variable}>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-[var(--ink)] focus:px-4 focus:py-2 focus:text-[var(--ink-inverted)]"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
