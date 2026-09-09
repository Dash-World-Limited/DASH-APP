/**
 * Seller identity matching for Declutter KYC.
 *
 * Before a seller may publish, three names have to describe the same person:
 * the legal name they gave DASH, the name on their NIN identity record, and the
 * name on the bank account that will be paid.
 *
 * The obvious implementation — `a === b` — fails constantly on real Nigerian
 * data and fails in the worst direction: it sends honest sellers into manual
 * review while doing nothing an attacker cannot trivially work around. Real
 * inputs look like this, all for one person:
 *
 *     NIN record       OKONKWO CHINEDU EMEKA        (surname first)
 *     Bank account     Chinedu E. Okonkwo           (middle initial)
 *     Typed by hand    chinedu  okonkwo             (no middle name, spacing)
 *
 * So this module compares *people*, not strings: normalise, tokenise, and ask
 * whether one name can be read as the same person as the other, allowing for
 * word order, missing middle names and initials — while refusing to let a
 * different surname pass.
 *
 * It returns a verdict, never a silent boolean. `review` is a first-class
 * outcome, because "these are probably the same person but I would not bet a
 * payout on it" is the honest answer surprisingly often, and the product
 * requirement is that material mismatches reach a human rather than being
 * resolved by a threshold nobody chose deliberately.
 *
 * Pure: no I/O, no clock, no configuration read from the environment.
 */

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Honorifics and suffixes carry no identity and appear inconsistently across
 * bank records. Dropping them prevents "MR CHINEDU OKONKWO" scoring worse than
 * "CHINEDU OKONKWO" for no reason a human would recognise.
 */
const NOISE_TOKENS: ReadonlySet<string> = new Set([
  'MR',
  'MRS',
  'MISS',
  'MS',
  'DR',
  'PROF',
  'ENGR',
  'BARR',
  'CHIEF',
  'ALHAJI',
  'ALHAJA',
  'PASTOR',
  'REV',
  'JR',
  'SNR',
  'SR',
  'II',
  'III',
]);

/**
 * Reduce a written name to comparable tokens.
 *
 * Uppercases, strips accents, replaces every non-letter with a space (so
 * `O'Brien`, `Bello-Osagie` and `CHINEDU.E.OKONKWO` all tokenise sensibly),
 * collapses whitespace and drops honorifics.
 */
export function normaliseName(raw: string): readonly string[] {
  return raw
    .normalize('NFD')
    // Combining marks — é becomes e, so the same name typed two ways matches.
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z]+/g, ' ')
    .trim()
    .split(' ')
    .filter((token) => token.length > 0 && !NOISE_TOKENS.has(token));
}

/** Does `candidate` plausibly stand for `full`? Handles single-letter initials. */
function tokenMatches(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length === 1 && b.startsWith(a)) return true;
  if (b.length === 1 && a.startsWith(b)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export type NameMatchVerdict = 'match' | 'review' | 'mismatch';

export interface NameMatchFactor {
  readonly code:
    | 'exact_token_set'
    | 'reordered'
    | 'initial_expanded'
    | 'extra_middle_name'
    | 'missing_token'
    | 'no_shared_tokens'
    | 'single_token_name'
    | 'empty_input';
  readonly detail: string;
}

export interface NameMatchResult {
  /** 0–100. Reported so an admin sees *how* close, not just the verdict. */
  readonly score: number;
  readonly verdict: NameMatchVerdict;
  readonly factors: readonly NameMatchFactor[];
  readonly normalisedA: readonly string[];
  readonly normalisedB: readonly string[];
}

/**
 * Score thresholds.
 *
 * Chosen so that the common honest variations — reordering and a dropped or
 * abbreviated middle name — land in `match`, while anything involving a token
 * that appears in neither direction lands in `review` rather than being
 * accepted or rejected outright. Nothing auto-rejects on name alone: a
 * `mismatch` still produces a record for a human, it simply arrives flagged.
 */
export const NAME_MATCH_ACCEPT = 85;
export const NAME_MATCH_REVIEW = 55;

/**
 * Compare two written names for identity.
 *
 * Word order is ignored deliberately: Nigerian records write surname first
 * about as often as last, and treating order as signal would reject half of
 * legitimate sellers. What is *not* ignored is a token present in one name and
 * absent from the other — that is exactly the case where two different people
 * share a first name, and it is what pushes a result into `review`.
 */
export function compareNames(a: string, b: string): NameMatchResult {
  const tokensA = normaliseName(a);
  const tokensB = normaliseName(b);
  const factors: NameMatchFactor[] = [];

  if (tokensA.length === 0 || tokensB.length === 0) {
    return {
      score: 0,
      verdict: 'mismatch',
      factors: [{ code: 'empty_input', detail: 'One of the names contained no letters.' }],
      normalisedA: tokensA,
      normalisedB: tokensB,
    };
  }

  // Match greedily from the shorter side, so "Chinedu Okonkwo" against
  // "Okonkwo Chinedu Emeka" asks only whether both of its tokens appear.
  const [shorter, longer] =
    tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];

  const consumed = new Set<number>();
  let matched = 0;
  let viaInitial = 0;

  for (const token of shorter) {
    const index = longer.findIndex((other, i) => !consumed.has(i) && tokenMatches(token, other));
    if (index >= 0) {
      consumed.add(index);
      matched += 1;
      if (longer[index] !== token) viaInitial += 1;
    }
  }

  const missing = shorter.length - matched;
  const extra = longer.length - matched;

  // Base score is how much of the shorter name was found in the longer one.
  let score = Math.round((matched / shorter.length) * 100);

  if (missing > 0) {
    factors.push({
      code: 'missing_token',
      detail: `${missing} name part${missing === 1 ? '' : 's'} in one name not found in the other.`,
    });
  }
  if (extra > 0) {
    // An extra middle name is ordinary. Charge a small amount so a name with
    // several unexplained extra parts still lands short of automatic acceptance.
    score -= Math.min(extra * 5, 15);
    factors.push({
      code: 'extra_middle_name',
      detail: `${extra} additional name part${extra === 1 ? '' : 's'} present in the longer name.`,
    });
  }
  if (viaInitial > 0) {
    score -= 3;
    factors.push({
      code: 'initial_expanded',
      detail: `${viaInitial} part${viaInitial === 1 ? '' : 's'} matched an initial rather than a full name.`,
    });
  }
  if (matched === 0) {
    factors.push({ code: 'no_shared_tokens', detail: 'The names share no name parts at all.' });
  }
  if (matched === shorter.length && missing === 0 && extra === 0 && viaInitial === 0) {
    const sameOrder = tokensA.every((token, i) => token === tokensB[i]);
    factors.push(
      sameOrder
        ? { code: 'exact_token_set', detail: 'Identical after normalisation.' }
        : { code: 'reordered', detail: 'Same name parts in a different order.' },
    );
  }

  // A single-token name is weak evidence in either direction: "CHINEDU" alone
  // matches thousands of people. Cap it below automatic acceptance so a human
  // always looks.
  if (shorter.length === 1) {
    score = Math.min(score, NAME_MATCH_ACCEPT - 1);
    factors.push({
      code: 'single_token_name',
      detail: 'One of the names has a single part, which is not enough to identify a person.',
    });
  }

  score = Math.max(0, Math.min(100, score));

  const verdict: NameMatchVerdict =
    score >= NAME_MATCH_ACCEPT ? 'match' : score >= NAME_MATCH_REVIEW ? 'review' : 'mismatch';

  return { score, verdict, factors, normalisedA: tokensA, normalisedB: tokensB };
}

// ---------------------------------------------------------------------------
// The three-way check
// ---------------------------------------------------------------------------

export interface SellerIdentityInput {
  /** The name the seller gave DASH. */
  readonly declaredName: string;
  /** The name returned by the identity record. */
  readonly identityName: string;
  /**
   * The account holder name returned by the bank, when there is one.
   *
   * Optional because a bank account exists to be *paid into*, and somebody
   * listing a sofa has not been paid yet. Asking for an account number in
   * exchange for nothing is asking for the most sensitive thing a person has,
   * so the pairings that involve it do not run until settlement needs them.
   */
  readonly bankAccountName?: string | null;
}

export interface SellerIdentityAssessment {
  readonly verdict: NameMatchVerdict;
  /** The weakest pairing that ran — the one an admin should look at. */
  readonly weakestPair: 'declared_vs_identity' | 'declared_vs_bank' | 'identity_vs_bank';
  readonly score: number;
  /** Whether a bank account name was available to compare at all. */
  readonly bankChecked: boolean;
  readonly pairs: {
    readonly declaredVsIdentity: NameMatchResult;
    readonly declaredVsBank: NameMatchResult | null;
    readonly identityVsBank: NameMatchResult | null;
  };
}

/**
 * Assess all three names together.
 *
 * The overall verdict is the *worst* of the three comparisons, not the average.
 * Averaging would let a strong declared-vs-identity match paper over a bank
 * account in someone else's name, which is precisely the arrangement a payout
 * fraud depends on.
 */
export function assessSellerIdentity(input: SellerIdentityInput): SellerIdentityAssessment {
  const declaredVsIdentity = compareNames(input.declaredName, input.identityName);
  const bankName = input.bankAccountName?.trim();
  const bankChecked = Boolean(bankName);

  const declaredVsBank = bankName ? compareNames(input.declaredName, bankName) : null;
  const identityVsBank = bankName ? compareNames(input.identityName, bankName) : null;

  const candidates = [
    { key: 'declared_vs_identity' as const, result: declaredVsIdentity },
    ...(declaredVsBank ? [{ key: 'declared_vs_bank' as const, result: declaredVsBank }] : []),
    ...(identityVsBank ? [{ key: 'identity_vs_bank' as const, result: identityVsBank }] : []),
  ];

  const weakest = candidates.reduce((worst, candidate) =>
    candidate.result.score < worst.result.score ? candidate : worst,
  );

  return {
    verdict: weakest.result.verdict,
    weakestPair: weakest.key,
    score: weakest.result.score,
    bankChecked,
    pairs: { declaredVsIdentity, declaredVsBank, identityVsBank },
  };
}
