/**
 * Post-seed integrity check for CI.
 *
 * The seed already asserts that every ledger transaction balances before it
 * reports success, so a green seed is most of the story. This re-checks the
 * written rows independently — the seed could balance its in-memory drafts and
 * still write them wrongly — and confirms the world it created is actually
 * usable rather than merely present.
 *
 *   node scripts/ci-verify-seed.mjs
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}`);
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
  }
}

async function main() {
  console.log('\nSeed verification\n' + '='.repeat(46));

  // --- The world exists ------------------------------------------------------
  const counts = {
    cities: await prisma.city.count(),
    zones: await prisma.zone.count(),
    vendors: await prisma.vendor.count(),
    items: await prisma.menuItem.count(),
    customers: await prisma.customer.count(),
    riders: await prisma.rider.count(),
    orders: await prisma.order.count(),
    promotions: await prisma.promotion.count(),
  };

  check('a city was seeded', counts.cities >= 1, counts);
  check('service zones were seeded', counts.zones >= 4, counts);
  check('vendors were seeded', counts.vendors >= 4, counts);
  check('catalogue items were seeded', counts.items >= 20, counts);
  check('customers and riders were seeded', counts.customers >= 3 && counts.riders >= 4, counts);
  check('orders across the lifecycle were seeded', counts.orders >= 5, counts);
  check('promotions were seeded', counts.promotions >= 3, counts);

  // --- Every ledger transaction balances -------------------------------------
  // The invariant the whole money design rests on. Checked against the rows as
  // written, not against the drafts the seed built.
  const entries = await prisma.ledgerEntry.findMany({
    select: { amount: true, transactionId: true },
  });

  const sums = new Map();
  for (const entry of entries) {
    sums.set(entry.transactionId, (sums.get(entry.transactionId) ?? 0) + entry.amount);
  }
  const unbalanced = [...sums.entries()].filter(([, sum]) => sum !== 0);

  check('ledger transactions were written', sums.size > 0, { transactions: sums.size });
  check(
    'every ledger transaction sums to zero',
    unbalanced.length === 0,
    unbalanced.slice(0, 5).map(([id, sum]) => ({ id, driftKobo: sum })),
  );

  // --- Money is stored as integers -------------------------------------------
  // A float would mean something upstream bypassed the Kobo type.
  const nonInteger = entries.filter((entry) => !Number.isInteger(entry.amount));
  check('every ledger amount is an integer number of kobo', nonInteger.length === 0, nonInteger.slice(0, 3));

  const orders = await prisma.order.findMany({ select: { total: true, itemsSubtotal: true } });
  const floatOrders = orders.filter(
    (order) => !Number.isInteger(order.total) || !Number.isInteger(order.itemsSubtotal),
  );
  check('every order total is an integer number of kobo', floatOrders.length === 0, floatOrders.slice(0, 3));

  // --- No development secret leaked into seeded data -------------------------
  // The seed password is fictional, but it must never be stored in clear.
  const identities = await prisma.identity.findMany({
    select: { passwordHash: true },
    where: { passwordHash: { not: null } },
  });
  const plaintext = identities.filter((identity) => !identity.passwordHash?.startsWith('s1$'));
  check(
    'every seeded password is hashed, never stored in clear',
    identities.length > 0 && plaintext.length === 0,
    { withPassword: identities.length, suspicious: plaintext.length },
  );

  // --- Zones are usable geometry ---------------------------------------------
  const zones = await prisma.zone.findMany({
    select: { slug: true, polygon: true, minLatitude: true, maxLatitude: true },
  });
  const badGeometry = zones.filter((zone) => {
    try {
      const ring = JSON.parse(zone.polygon);
      return !Array.isArray(ring) || ring.length < 3 || zone.minLatitude >= zone.maxLatitude;
    } catch {
      return true;
    }
  });
  check('every zone has a parseable polygon and a sane bounding box', badGeometry.length === 0, badGeometry);

  console.log('\n' + '='.repeat(46));
  if (failures > 0) {
    console.log(`  ${failures} check(s) failed\n`);
    process.exitCode = 1;
  } else {
    console.log('  All checks passed\n');
  }
}

main()
  .catch((error) => {
    console.error('\nSeed verification crashed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
