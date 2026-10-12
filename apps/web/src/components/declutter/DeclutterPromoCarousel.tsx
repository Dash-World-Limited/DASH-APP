'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type PromoSlide = {
  kicker: string;
  title: string;
  body: string;
  cta: string;
  href: string;
  status: string;
};

const slides: PromoSlide[] = [
  {
    kicker: 'DASH WORLD',
    title: 'DASH App',
    body: 'Everything you need. One DASH.',
    cta: 'Coming December',
    href: 'https://dashworldng.com',
    status: 'Coming December',
  },
  {
    kicker: 'DASH WORLD',
    title: 'DASH AI',
    body: 'Practical AI for real work.',
    cta: 'Coming December',
    href: 'https://dashworldng.com',
    status: 'Coming December',
  },
  {
    kicker: 'DASH WORLD',
    title: 'DASH AI Studio',
    body: 'Create faster. Publish smarter.',
    cta: 'Coming Soon',
    href: 'https://dashworldng.com',
    status: 'Coming Soon',
  },
  {
    kicker: 'DASH WORLD',
    title: 'DASH Clock',
    body: 'Attendance and workforce management, simplified.',
    cta: 'Explore',
    href: 'https://clock.dashworldng.com',
    status: 'Available',
  },
  {
    kicker: 'DASH WORLD',
    title: 'DASH Club',
    body: 'A social and community space for access, updates and connection.',
    cta: 'Coming Soon',
    href: 'https://dashworldng.com',
    status: 'Coming Soon',
  },
];

export function DeclutterPromoCarousel() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setActive((current) => (current + 1) % slides.length);
    }, 6500);

    return () => window.clearInterval(timer);
  }, []);

  const slide = slides[active];

  return (
    <div className="relative min-h-[430px] overflow-hidden rounded-[var(--radius-card)] border border-[var(--line)] bg-[var(--dcl-glass)] p-8 shadow-sm backdrop-blur-xl lg:p-10">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full opacity-60 blur-[100px]"
        style={{ background: 'radial-gradient(circle, rgba(44,91,255,0.55), transparent 68%)' }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-20 -left-20 h-64 w-64 rounded-full opacity-35 blur-[90px]"
        style={{ background: 'radial-gradient(circle, rgba(212,175,55,0.35), transparent 68%)' }}
      />

      <div className="relative flex min-h-[350px] flex-col justify-between">
        <div>
          <div className="flex items-center justify-between gap-4">
            <p className="text-[0.68rem] font-black uppercase tracking-[0.28em] text-[var(--dcl-gold)]">{slide.kicker}</p>
            <span className="rounded-full border border-[var(--line)] bg-[var(--dcl-glass-strong)] px-3 py-1.5 text-[0.68rem] font-bold text-[var(--ink-muted)]">
              {slide.status}
            </span>
          </div>

          <div className="mt-14 max-w-md">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--primary)]">Featured by Dash World</p>
            <h2 className="dcl-display mt-3 text-5xl leading-none text-[var(--ink)]">{slide.title}</h2>
            <p className="mt-5 max-w-sm text-xl leading-snug text-[var(--ink-muted)]">{slide.body}</p>
          </div>
        </div>

        <div className="mt-10 flex items-end justify-between gap-6">
          <Link
            href={slide.href}
            className="inline-flex min-h-11 items-center rounded-full bg-[var(--primary)] px-6 text-sm font-bold text-[var(--on-primary)] transition-colors hover:bg-[var(--primary-hover)]"
          >
            {slide.cta}
          </Link>

          <div className="flex items-center gap-2" aria-label="Promotional slides">
            {slides.map((promo, index) => (
              <button
                key={promo.title}
                type="button"
                aria-label={`Show ${promo.title}`}
                aria-current={index === active ? 'true' : undefined}
                onClick={() => setActive(index)}
                className={`h-2 rounded-full transition-all ${index === active ? 'w-7 bg-[var(--primary)]' : 'w-2 bg-[var(--line)]'}`}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
