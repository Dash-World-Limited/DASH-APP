/**
 * The Declutters lockup.
 *
 * Set, not drawn. DASH World's logo is an existing asset and this is not it —
 * it is a wordmark in the site's own display face, which is the right thing for
 * a sub-brand: it inherits the parent's typography and its gold without
 * pretending to be the parent's mark.
 *
 * The gold dot is the only gold on most pages. Restraint is what makes it read
 * as a brand accent rather than as decoration.
 */
export function DeclutterWordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`flex items-baseline gap-1.5 ${className}`}>
      <span className="dcl-display text-[1.05rem] tracking-tight text-[var(--ink)] sm:text-lg">
        DASH
      </span>
      <span className="dcl-display text-[1.05rem] tracking-tight text-[var(--primary)] sm:text-lg">
        Declutters
      </span>
      <span
        aria-hidden
        className="mb-[3px] h-[5px] w-[5px] rounded-full bg-[var(--dcl-gold)]"
      />
    </span>
  );
}
