/**
 * The customer role that goes with a customer profile.
 *
 * Every consumer permission — adding an address, placing an order, reading
 * one's own orders, deleting one's own account — is granted by the `customer`
 * role row, not by the existence of a `Customer` profile. Signup created the
 * profile and never the role, so every account made through the real signup
 * form could sign in and browse but not save an address or order. The test
 * fixtures create the role directly, which is why no suite noticed; the
 * end-to-end run against a live API did.
 *
 * Granted where an account becomes real (email verification) and, for
 * accounts verified before this existed, at their next code sign-in. Only an
 * identity that has a customer profile receives it, so a staff identity
 * without one is never made a customer by signing in.
 *
 * Idempotent: asks before writing, and a concurrent second grant collides on
 * the role's unique constraint and is treated as already done.
 */

import type { PrismaClient } from '@dash/db';

type Db = Pick<PrismaClient, 'customer' | 'identityRole'>;

/** True when the role was granted by this call. */
export async function ensureCustomerRole(db: Db, identityId: string): Promise<boolean> {
  const profile = await db.customer.findUnique({ where: { identityId }, select: { id: true } });
  if (!profile) return false;

  const existing = await db.identityRole.findFirst({ where: { identityId, role: 'customer' }, select: { id: true } });
  if (existing) return false;

  try {
    await db.identityRole.create({ data: { identityId, role: 'customer' } });
    return true;
  } catch {
    // A concurrent sign-in granted it first.
    return false;
  }
}
