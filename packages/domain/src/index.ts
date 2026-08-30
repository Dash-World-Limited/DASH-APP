/**
 * @dash/domain — the pure business core of DASH APP.
 *
 * Nothing in this package touches a database, a network, or a clock it did not
 * receive as an argument. That is deliberate: pricing, dispatch, permissions,
 * the order state machine, and the ledger are the parts that must be provably
 * correct, so they are kept free of I/O and tested exhaustively.
 */

export * from './money/index.js';
export * from './crypto/index.js';
export * from './geo/index.js';
export * from './permissions/index.js';
export * from './orders/index.js';
export * from './pricing/index.js';
export * from './dispatch/index.js';
export * from './pay/index.js';
export * from './ledger/index.js';
export * from './ports/index.js';
