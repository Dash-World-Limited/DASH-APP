/**
 * DASH ValueCheck — AI-assisted item valuation, reviewed and authorised by DASH.
 *
 * A bounded DASH product whose first consumer is DASH World Declutters, not a
 * feature of it. Nothing in this module imports from `declutter/`, and a test
 * asserts that, because the same engine is meant to serve a standalone
 * ValueCheck site, DASH APP, internal tooling and eventually external callers.
 *
 *   * `contract`      — request, result, provider port, validation, and the
 *                       evidence-derived confidence ceiling.
 *   * `policy`        — the authority model, configurable risk policy,
 *                       escalation, pricing decisions and seller acceptance.
 *   * `deterministic` — the local adapter used in development and tests, which
 *                       identifies itself as not-live and always will.
 *
 * Three ideas are kept apart on purpose: a **valuation** is not a **listing**
 * and neither is a **sale**. Somebody should be able to value an item without
 * creating a listing, and valuing one must never confer authority to publish.
 */

export * from './contract.js';
export * from './policy.js';
export * from './deterministic.js';
