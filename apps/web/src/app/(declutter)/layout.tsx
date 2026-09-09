import type { ReactNode } from 'react';
import { Archivo } from 'next/font/google';

import { DeclutterHeader } from '@/components/declutter/DeclutterHeader';
import { DeclutterFooter } from '@/components/declutter/DeclutterFooter';

/**
 * The DASH World Declutters website.
 *
 * Its own route group, and that is the whole point of this file.
 *
 * These pages first shipped under `(customer)`, which meant they inherited that
 * group's layout — the DASH APP customer bottom navigation with Home, Search,
 * Orders, Wallet and Account, plus the app header and its Basket. Nothing
 * failed and no URL changed, so it was invisible until somebody looked at the
 * page. It was wrong: a stranger arriving from a shared WhatsApp link is on a
 * public marketplace website, not inside a delivery app, and offering them a
 * Wallet and a Basket for an item that is not bought through a basket is a
 * promise the product does not keep.
 *
 * There is one marketplace and one source of truth. There are two frontends
 * over it: this website, and — later — DASH APP's own Declutter section reading
 * the same API behind the app shell. Route groups do not appear in URLs, so
 * `/declutter`, `/declutter/[slug]` and `/declutter/sell` are exactly the paths
 * they always were; only what wraps them changed.
 *
 * The admin console at `/ops/declutter` is unaffected and stays in the Ops
 * infrastructure where it belongs.
 */

/**
 * Archivo, loaded here rather than at the root.
 *
 * It is the display face on dashworldng.com, so a visitor arriving from the
 * main site meets the same headline voice. Scoped to this layout because DASH
 * APP does not use it and should not pay to download it — `next/font` only
 * preloads a face on the routes whose layout declares it.
 */
const archivo = Archivo({
  subsets: ['latin'],
  weight: ['600', '700', '800'],
  display: 'swap',
  variable: '--font-archivo',
});

export default function DeclutterSiteLayout({ children }: { children: ReactNode }) {
  return (
    <div
      // `data-surface` re-points the semantic tokens for this subtree only. The
      // rest of the application keeps its own surface, and nothing here is a
      // colour class that would have to be found and changed later.
      data-surface="declutter"
      className={`${archivo.variable} flex min-h-dvh flex-col`}
    >
      <DeclutterHeader />
      {/* No bottom navigation, so no reserved space for one. The footer is the
          end of the page, the way a website ends. */}
      <div className="min-w-0 flex-1">{children}</div>
      <DeclutterFooter />
    </div>
  );
}
