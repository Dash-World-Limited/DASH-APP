import Link from 'next/link';
import { Card, Wordmark } from '@/components/ui';

/**
 * Landing page.
 *
 * Also acts as the entry point to each role's surface, because in development
 * there is no other way to reach the vendor or ops consoles.
 */

const SURFACES = [
  {
    href: '/browse',
    title: 'Order something',
    description: 'Browse nearby vendors, build a basket, and track it to your door.',
    role: 'Customer',
  },
  {
    href: '/vendor',
    title: 'Vendor console',
    description: 'Take orders, set preparation times, and manage what is in stock.',
    role: 'Vendor',
  },
  {
    href: '/rider',
    title: 'Rider app',
    description: 'Go online, accept offers, and complete deliveries with a PIN.',
    role: 'Rider',
  },
  {
    href: '/ops',
    title: 'Operations',
    description: 'Live dispatch board, zone controls, and the money ledger.',
    role: 'Staff',
  },
];

export default function HomePage() {
  return (
    <main id="main" className="mx-auto max-w-5xl px-5 py-16">
      <header className="mb-14">
        <Wordmark className="text-3xl" />
        <h1 className="mt-8 max-w-2xl text-4xl font-extrabold leading-[1.1] tracking-tight sm:text-5xl">
          Six services.
          <br />
          <span className="text-gold-500">One DASH.</span>
        </h1>
        <p className="mt-5 max-w-xl text-lg text-graphite-600">
          FOOD, SHOPS, PHARMACY, LOCAL MARKET, DECLUTTER and LOGISTICS — one trusted place for
          what your day needs.
        </p>
      </header>

      <div
        role="note"
        className="mb-10 rounded-[var(--radius-card)] border border-gold-400/40 bg-gold-50 px-5 py-4"
      >
        <p className="text-sm font-semibold text-gold-600">Development build</p>
        <p className="mt-1 text-sm text-graphite-600">
          Every vendor, product, rider and customer here is fictional. Payments run through a mock
          adapter — no card is ever charged and no money moves.
        </p>
      </div>

      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-graphite-400">
        Choose a surface
      </h2>
      <ul className="grid gap-4 sm:grid-cols-2">
        {SURFACES.map((surface) => (
          <Card as="li" key={surface.href} className="transition-shadow hover:shadow-lg">
            <Link href={surface.href} className="block p-6">
              <span className="text-xs font-semibold uppercase tracking-wide text-gold-600">
                {surface.role}
              </span>
              <h3 className="mt-2 text-xl font-bold">{surface.title}</h3>
              <p className="mt-2 text-sm text-graphite-600">{surface.description}</p>
            </Link>
          </Card>
        ))}
      </ul>

      <footer className="mt-16 border-t pt-8 text-sm text-graphite-400">
        <p>
          DASH APP is an original build. It is not affiliated with, and copies no assets from, any
          existing delivery platform.
        </p>
      </footer>
    </main>
  );
}
