import { TRUST_PROMISES } from '@/lib/declutter';

/**
 * What DASH actually promises, spelled out.
 *
 * Four claims, each one a thing the system genuinely enforces and each one
 * checkable: a human approves every listing, sellers pass identity
 * verification, the price is set once from market evidence, and there is no
 * negotiation anywhere in the product.
 *
 * There is no review count here, no "trusted by thousands", no live activity
 * ticker. The marketplace has just launched; inventing social proof would make
 * every other sentence on the page worth doubting, and these four claims are
 * strong enough on their own precisely because they are true.
 *
 * `DASH ValueChecked` is deliberately not among them. It will belong here when
 * a live valuation provider has actually run and a human has authorised the
 * result — and not one day before.
 */
export function TrustBand() {
  return (
    <section
      aria-labelledby="trust-heading"
      className="border-y border-[var(--line)] bg-[var(--surface-sunken)]"
    >
      <div className="mx-auto w-full max-w-[1240px] px-5 py-16 sm:px-8 sm:py-20">
        <p className="dcl-eyebrow">Why this is not a classifieds board</p>
        <h2 id="trust-heading" className="dcl-display mt-4 max-w-2xl text-3xl sm:text-4xl">
          Somebody at DASH stands behind every item here.
        </h2>

        <ul className="mt-12 grid gap-px overflow-hidden rounded-[var(--radius-card)] border border-[var(--line)] bg-[var(--line)] sm:grid-cols-2 lg:grid-cols-4">
          {TRUST_PROMISES.map((promise, index) => (
            <li key={promise.title} className="bg-[var(--surface)] p-6">
              <p
                aria-hidden
                className="dcl-display text-sm text-[var(--dcl-gold)]"
              >
                {String(index + 1).padStart(2, '0')}
              </p>
              <h3 className="mt-3 text-base font-bold text-[var(--ink)]">{promise.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-[var(--ink-muted)]">{promise.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
