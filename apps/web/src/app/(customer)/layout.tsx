import type { ReactNode } from 'react';

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
 */
export default function CustomerLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-[var(--surface)]">
      {/* Reserves the navigation *and* whatever the system draws below it, so
          the last row of a list stays reachable on a gesture-navigation phone. */}
      <div className="pad-for-bottom-nav">{children}</div>
      <BottomNav />
    </div>
  );
}
