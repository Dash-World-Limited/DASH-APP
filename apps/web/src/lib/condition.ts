'use client';

/**
 * Readable form of a Declutter listing's condition.
 *
 * Kept apart from the section plumbing because it is about an *item*, not a
 * section: the shared seller page renders it whenever a listing has one, which
 * today means Declutter and tomorrow may mean anything second-hand.
 */
export function conditionLabel(condition: string | null | undefined): string | null {
  if (!condition) return null;
  return (
    { new: 'New', like_new: 'Like new', good: 'Good', fair: 'Fair' }[condition] ??
    condition.replace(/_/g, ' ')
  );
}
