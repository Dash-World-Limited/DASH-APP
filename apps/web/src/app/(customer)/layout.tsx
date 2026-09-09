import type { ReactNode } from 'react';

import { AppHeader } from '@/components/AppHeader';
import { BottomNav } from '@/components/BottomNav';

/**
 * The customer shell.
 *
 * A route group, so every screen inside keeps the URL it already had —
 * `/browse/[slug]`, `/orders`, `/basket` are unchanged — while gaining the
 * navigation that makes them feel like one app rather than a set of pages.
 * Existing links and anything already open on a test handset keep working.
 *
 * The padding at the bottom is not decoration: the navigation is fixed, so
 * without it the last item of every list sits underneath it and cannot be
 * reached.
 *
 * The header and the navigation are rendered here rather than by each screen.
 * They were pasted into all thirteen customer pages — and into each page's
 * loading and error branches besides, so a screen with three states carried
 * three copies — which made the shell something a new screen had to remember to
 * opt into. A screen should describe itself; the shell should be what it is
 * placed inside.
 */
export default function CustomerLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-[var(--surface)]">
      <AppHeader />
      {/* Reserves the navigation *and* whatever the system draws below it, so
          the last row of a list stays reachable on a gesture-navigation phone. */}
      <div className="pad-for-bottom-nav">{children}</div>
      <BottomNav />
    </div>
  );
}
