'use client';

import { useEffect, useState, type KeyboardEvent } from 'react';

export type PromoSlide = {
  id: string;
  title: string;
  image: string;
  alt: string;
  status?: string;
  href?: string;
};

// Runtime public manifest: edit/reorder records and replace artwork without
// rebuilding the component. Destinations are optional and never inferred.
export const CAMPAIGN_MANIFEST = '/declutter/promos/campaigns.json';
export function parseCampaigns(value: unknown): PromoSlide[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error('No campaigns');
  const ids = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object')
      throw new Error('Invalid campaign');
    const s = entry as Record<string, unknown>;
    if (
      typeof s.id !== 'string' ||
      !s.id.trim() ||
      ids.has(s.id) ||
      typeof s.title !== 'string' ||
      !s.title.trim() ||
      typeof s.alt !== 'string' ||
      !s.alt.trim() ||
      typeof s.image !== 'string' ||
      !/^\/declutter\/promos\/[\w-]+\.(png|jpe?g|webp)$/.test(s.image) ||
      (s.status !== undefined && typeof s.status !== 'string') ||
      (s.href !== undefined &&
        (typeof s.href !== 'string' ||
          !/^(https:\/\/[^\s]+|\/(?!\/)[^\s]*)$/.test(s.href)))
    )
      throw new Error('Invalid campaign');
    ids.add(s.id);
    return {
      id: s.id,
      title: s.title,
      image: s.image,
      alt: s.alt,
      ...(s.status !== undefined ? { status: s.status as string } : {}),
      ...(s.href !== undefined ? { href: s.href as string } : {}),
    };
  });
}

export function DeclutterPromoCarousel() {
  const [slides, setSlides] = useState<PromoSlide[]>([]);
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [desktop, setDesktop] = useState(false);
  const [visible, setVisible] = useState(true);
  const [error, setError] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const screen = window.matchMedia('(min-width: 1024px)');
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const resize = () => setDesktop(screen.matches);
    const reduce = () => setPaused(motion.matches);
    const visibility = () => setVisible(!document.hidden);
    resize();
    reduce();
    visibility();
    screen.addEventListener('change', resize);
    motion.addEventListener('change', reduce);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      screen.removeEventListener('change', resize);
      motion.removeEventListener('change', reduce);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);

  useEffect(() => {
    if (!desktop) return;
    const controller = new AbortController();
    setError(false);
    void fetch(CAMPAIGN_MANIFEST, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Campaigns unavailable');
        return parseCampaigns(await response.json());
      })
      .then((campaigns) => {
        setSlides(campaigns);
        setActive(0);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [desktop, attempt]);

  const rotating =
    desktop && visible && !paused && !hovered && !focused && slides.length > 1;
  useEffect(() => {
    if (!rotating) return;
    const timer = window.setInterval(
      () => setActive((i) => (i + 1) % slides.length),
      6500,
    );
    return () => window.clearInterval(timer);
  }, [rotating, slides.length]);
  useEffect(() => setImageError(false), [active, slides]);

  function select(index: number) {
    setActive((index + slides.length) % slides.length);
    setPaused(true);
  }
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget || !slides.length) return;
    const next =
      event.key === 'ArrowRight'
        ? active + 1
        : event.key === 'ArrowLeft'
          ? active - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? slides.length - 1
              : null;
    if (next !== null) {
      event.preventDefault();
      select(next);
    }
  }
  const slide = slides[active];
  const control =
    'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[var(--line-strong)] bg-[var(--dcl-glass-strong)] text-[var(--ink)] hover:bg-[var(--primary-soft)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]';

  return (
    <div
      role="region"
      aria-roledescription="carousel"
      aria-label="DASH World campaigns"
      tabIndex={0}
      onKeyDown={keyboard}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
      }}
      className="min-w-0 overflow-hidden rounded-[var(--radius-card)] border border-[var(--line)] bg-[var(--dcl-glass)] p-3 shadow-sm backdrop-blur-xl xl:p-4"
    >
      <div aria-live={rotating ? 'off' : 'polite'} aria-atomic="true">
        {slide ? (
          <div
            role="group"
            aria-roledescription="slide"
            aria-label={`${active + 1} of ${slides.length}: ${slide.title}`}
          >
            <div className="flex min-h-12 flex-wrap items-center justify-between gap-2 px-1 pb-3">
              <h2 className="text-sm font-bold text-[var(--ink)]">
                {slide.title}
              </h2>
              {slide.status && (
                <span className="rounded-full border border-[var(--line)] bg-[var(--dcl-glass-strong)] px-3 py-1 text-xs font-semibold text-[var(--ink-muted)]">
                  {slide.status}
                </span>
              )}
            </div>
            <div className="flex h-[480px] items-center justify-center overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface-sunken)] xl:h-[540px]">
              {imageError ? (
                <p
                  role="alert"
                  className="px-6 text-center text-sm text-[var(--ink-muted)]"
                >
                  This campaign artwork could not load. Please refresh or view
                  another campaign.
                </p>
              ) : slide.href ? (
                <a
                  href={slide.href}
                  className="flex h-full w-full items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
                  aria-label={`Explore ${slide.title}`}
                >
                  {/* Original campaign artwork must remain uncropped. */}
                  <img
                    src={slide.image}
                    alt={slide.alt}
                    className="h-full w-full object-contain"
                    decoding="async"
                    onError={() => setImageError(true)}
                  />
                </a>
              ) : (
                <img
                  src={slide.image}
                  alt={slide.alt}
                  className="h-full w-full object-contain"
                  decoding="async"
                  onError={() => setImageError(true)}
                />
              )}
            </div>
          </div>
        ) : (
          <div
            className="flex h-[540px] flex-col items-center justify-center gap-4 px-6 text-center text-sm text-[var(--ink-muted)]"
            role="status"
          >
            {error ? (
              <>
                Campaign graphics are temporarily unavailable.
                <button
                  type="button"
                  onClick={() => setAttempt((i) => i + 1)}
                  className="min-h-11 rounded-full border border-[var(--line-strong)] px-5 font-semibold"
                >
                  Try again
                </button>
              </>
            ) : (
              'Loading DASH campaigns…'
            )}
          </div>
        )}
      </div>
      {slides.length > 1 && (
        <div className="mt-3 flex flex-wrap items-center justify-center gap-1">
          <button
            type="button"
            aria-label="Previous campaign"
            className={control}
            onClick={() => select(active - 1)}
          >
            <span aria-hidden="true">←</span>
          </button>
          <div
            role="group"
            aria-label="Choose a campaign"
            className="flex items-center"
          >
            {slides.map((campaign, index) => (
              <button
                key={campaign.id}
                type="button"
                aria-label={`Show ${campaign.title}`}
                aria-current={index === active ? 'true' : undefined}
                onClick={() => select(index)}
                className="flex h-11 w-8 items-center justify-center rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
              >
                <span
                  aria-hidden="true"
                  className={`h-2 rounded-full ${index === active ? 'w-5 bg-[var(--primary)]' : 'w-2 bg-[var(--ink-muted)]'}`}
                />
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-label="Next campaign"
            className={control}
            onClick={() => select(active + 1)}
          >
            <span aria-hidden="true">→</span>
          </button>
          <button
            type="button"
            aria-label={
              paused ? 'Play campaign rotation' : 'Pause campaign rotation'
            }
            aria-pressed={paused}
            className={control}
            onClick={() => setPaused((p) => !p)}
          >
            <span aria-hidden="true">{paused ? '▶' : 'Ⅱ'}</span>
          </button>
        </div>
      )}
    </div>
  );
}
