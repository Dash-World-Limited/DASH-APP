/**
 * The deterministic local ValueCheck adapter.
 *
 * Development and tests need a valuation engine that answers instantly, costs
 * nothing, never touches the network, and — most importantly — returns the same
 * answer for the same item every time. A test that asserts on a number is
 * worthless if a model can decide differently tomorrow.
 *
 * It is honest about what it is. `isLive` is false and `providerName` says
 * `local-deterministic`, both of which travel with every result and are stored
 * on the row. Nothing may present its output as live AI, and the admin console
 * shows the provider beside the number for exactly that reason.
 *
 * ## What it actually does
 *
 * Simple, explicable arithmetic over the evidence: the median of whatever
 * comparables exist, moved by condition, declared defects, included
 * accessories and age. It is not pretending to be clever. Its job is to
 * exercise every downstream path — validation, confidence reconciliation,
 * escalation, approval, seller acceptance — with a result that is structurally
 * indistinguishable from a real one.
 *
 * Pure apart from the clock, which is injected rather than read, so a caller
 * that wants a fixed timestamp gets one.
 */

import {
  assessEvidence,
  reconcileConfidence,
  type ValuationFactor,
  type ValuationPort,
  type ValuationRequest,
  type ValuationResult,
} from './contract.js';

/** What a second-hand item of each condition is worth against its comparables. */
const CONDITION_MULTIPLIER: Readonly<Record<string, number>> = {
  new: 1,
  like_new: 0.9,
  good: 0.78,
  fair: 0.6,
};

const ALGORITHM_VERSION = 'valuecheck-local-1';

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

export interface DeterministicOptions {
  /** Injected so a test can pin the timestamp. */
  readonly now?: () => Date;
}

export class DeterministicValuationAdapter implements ValuationPort {
  readonly providerName = 'local-deterministic';
  readonly modelVersion = ALGORITHM_VERSION;
  /** Never true. This is arithmetic, and calling it AI would be a lie. */
  readonly isLive = false;

  private readonly now: () => Date;

  constructor(options: DeterministicOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async value(request: ValuationRequest): Promise<ValuationResult> {
    const factors: ValuationFactor[] = [];

    const observed = request.comparables
      .map((comparable) => comparable.soldPriceKobo ?? comparable.askingPriceKobo)
      .filter((value): value is number => typeof value === 'number' && value > 0);

    // Confirmed sales, where there are any, describe the market better than
    // asking prices do — so they set the base on their own rather than being
    // averaged in with hopes.
    const confirmed = request.comparables
      .map((comparable) => comparable.soldPriceKobo)
      .filter((value): value is number => typeof value === 'number' && value > 0);

    let base: number;
    if (confirmed.length > 0) {
      base = median(confirmed);
      factors.push({ label: 'Confirmed sale prices', direction: 'neutral', weight: 'high' });
    } else if (observed.length > 0) {
      // Asking prices run above what things actually fetch. Discounting them
      // is more honest than treating a hope as a transaction.
      base = Math.round(median(observed) * 0.92);
      factors.push({ label: 'Asking prices only', direction: 'lowers', weight: 'medium' });
    } else if (request.expectedPriceKobo && request.expectedPriceKobo > 0) {
      base = Math.round(request.expectedPriceKobo * 0.85);
      factors.push({
        label: 'No market evidence; anchored on the owner’s expectation',
        direction: 'neutral',
        weight: 'low',
      });
    } else {
      // Nothing to work from at all. A tiny, obviously-provisional number with
      // floor confidence, rather than a confident guess.
      base = 100_000;
      factors.push({ label: 'No evidence of any kind', direction: 'neutral', weight: 'low' });
    }

    const conditionMultiplier = CONDITION_MULTIPLIER[request.condition] ?? 0.7;
    factors.push({
      label: `Condition: ${request.condition.replace(/_/g, ' ')}`,
      direction: conditionMultiplier >= 0.9 ? 'neutral' : 'lowers',
      weight: 'high',
    });

    const cosmetic = request.declaredDefects.filter((defect) => defect.kind === 'cosmetic').length;
    const functional = request.declaredDefects.filter((defect) => defect.kind === 'functional').length;
    // Capped: five scratches do not make a phone worthless, and an uncapped
    // penalty would produce nonsense on a heavily-described item.
    const defectPenalty = Math.min(cosmetic * 0.05 + functional * 0.12, 0.45);
    if (defectPenalty > 0) {
      factors.push({
        label: `${cosmetic + functional} declared defect${cosmetic + functional === 1 ? '' : 's'}`,
        direction: 'lowers',
        weight: functional > 0 ? 'high' : 'medium',
      });
    }

    const accessoryBonus = Math.min(request.includedAccessories.length * 0.02, 0.08);
    if (accessoryBonus > 0) {
      factors.push({ label: 'Accessories included', direction: 'raises', weight: 'low' });
    }

    const agePenalty = Math.min(((request.ageMonths ?? 0) / 6) * 0.01, 0.3);
    if (agePenalty > 0) {
      factors.push({ label: 'Age', direction: 'lowers', weight: 'medium' });
    }

    const multiplier = Math.max(
      conditionMultiplier * (1 - defectPenalty) * (1 + accessoryBonus) * (1 - agePenalty),
      0.05,
    );

    const recommended = Math.max(Math.round(base * multiplier), 1);
    const low = Math.max(Math.round(recommended * 0.9), 1);
    const high = Math.max(Math.round(recommended * 1.12), recommended);

    const draft: ValuationResult = {
      estimatedLowKobo: low,
      estimatedHighKobo: high,
      recommendedPriceKobo: recommended,
      // A deliberately unremarkable starting point. The evidence assessment
      // below is what actually decides how confident this can be.
      confidenceBasisPoints: 7_000,
      factors,
      warnings: [],
      reasoning: buildReasoning(request, confirmed.length, observed.length),
      evidenceSummary:
        `${request.comparables.length} comparable(s), ${confirmed.length} confirmed sale(s), ` +
        `${request.photos.length} photograph(s), ${request.declaredDefects.length} declared defect(s).`,
      providerName: this.providerName,
      modelVersion: this.modelVersion,
      algorithmVersion: ALGORITHM_VERSION,
      isLive: false,
      producedAt: this.now().toISOString(),
    };

    // The same reconciliation a live provider's answer goes through: a stated
    // confidence never survives contact with thin evidence.
    return reconcileConfidence(draft, assessEvidence(request));
  }
}

function buildReasoning(
  request: ValuationRequest,
  confirmedCount: number,
  observedCount: number,
): string {
  const parts: string[] = [];
  if (confirmedCount > 0) {
    parts.push(`Anchored on ${confirmedCount} confirmed sale price(s).`);
  } else if (observedCount > 0) {
    parts.push(
      `Anchored on ${observedCount} asking price(s), discounted because an asking price is not a sale.`,
    );
  } else {
    parts.push('No comparable market evidence was available.');
  }
  parts.push(`Adjusted for ${request.condition.replace(/_/g, ' ')} condition.`);
  if (request.declaredDefects.length > 0) {
    parts.push(`${request.declaredDefects.length} declared defect(s) reduce the figure.`);
  }
  parts.push(
    'Produced by the local deterministic adapter — arithmetic over declared evidence, not a live model.',
  );
  return parts.join(' ');
}
