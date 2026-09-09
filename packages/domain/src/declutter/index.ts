/**
 * DASH World Declutters — the pure domain.
 *
 * A curated, admin-controlled, fixed-price second-hand marketplace. What makes
 * it different from a classifieds board is that nothing reaches the public
 * without a named human deciding it should, and the rules that guarantee that
 * live here rather than in the routes that happen to call them.
 *
 * Three modules:
 *
 *   * `lifecycle` — the submission, listing and contact-request state machines.
 *   * `identity`  — seller KYC name matching, which is a people problem rather
 *                   than a string problem.
 *
 * Valuation is deliberately absent: DASH ValueCheck is its own product, lives
 * in `@dash/domain/valuecheck`, and knows nothing about listings or sellers.
 *
 * Nothing here touches a database, a network or a clock it was not handed.
 */

export * from './lifecycle.js';
export * from './identity.js';
export * from './taxonomy.js';
export * from './seller.js';
