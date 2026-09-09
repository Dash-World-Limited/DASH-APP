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
 *   * `valuation` — the DASH ValueCheck boundary: structured request, validated
 *                   result, human decision.
 *
 * Nothing here touches a database, a network or a clock it was not handed.
 */

export * from './lifecycle.js';
export * from './identity.js';
export * from './valuation.js';
export * from './taxonomy.js';
