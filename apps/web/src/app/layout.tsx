import type { Metadata, Viewport } from 'next';
import './globals.css';

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
  // Zoom is NOT disabled. Locking it out breaks the app for anyone who needs
  // to enlarge text, which is a real accessibility failure and not a
  // stylistic choice.
  themeColor: '#0b0d10',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-NG">
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-graphite-900 focus:px-4 focus:py-2 focus:text-white"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
