/**
 * One-time bootstrap for the first real DASH Super Admin on staging.
 *
 * Secrets are read from environment variables and never logged. The script is
 * intentionally narrow: it refuses every database except dashdb_staging,
 * refuses to overwrite an existing identity, and refuses to create a second
 * active non-test Super Admin.
 *
 * First sign-in then completes MFA enrollment through /admin/signin. No TOTP
 * secret or recovery code is created here.
 */

import { PrismaClient } from '@prisma/client';
import { hashPassword } from '@dash/domain/crypto';

const prisma = new PrismaClient();

const STAFF_ROLES = [
  'support_agent',
  'dispatcher',
  'finance_analyst',
  'marketing_manager',
  'city_manager',
  'declutter_moderator',
  'declutter_admin',
  'platform_admin',
  'super_admin',
];

function required(name) {
  const value = (process.env[name] ?? '').trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function main() {
  if (process.env.DASH_BOOTSTRAP_SUPER_ADMIN !== 'YES') {
    throw new Error('Safety stop: set DASH_BOOTSTRAP_SUPER_ADMIN=YES for this one-time operation');
  }

  const databaseUrl = required('DATABASE_URL');
  let databaseName = '';
  try {
    databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');
  } catch {
    throw new Error('Safety stop: DATABASE_URL is not a valid PostgreSQL URL');
  }
  if (databaseName !== 'dashdb_staging') {
    throw new Error(`Safety stop: expected dashdb_staging, got ${databaseName || '(unknown)'}`);
  }

  if (process.env.SUPER_ADMIN_EMAIL_VERIFIED !== 'YES') {
    throw new Error(
      'Safety stop: confirm you control the mailbox, then set SUPER_ADMIN_EMAIL_VERIFIED=YES',
    );
  }

  const email = required('SUPER_ADMIN_EMAIL').toLowerCase();
  const displayName = required('SUPER_ADMIN_DISPLAY_NAME');
  const password = required('SUPER_ADMIN_PASSWORD');

  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('SUPER_ADMIN_EMAIL is not a valid email address');
  if (email.endsWith('@dashapp.test')) throw new Error('Refusing a fictional @dashapp.test Super Admin address');
  if (password.length < 14) throw new Error('Use a Super Admin password of at least 14 characters');

  const [sameEmail, realSuperAdmin] = await Promise.all([
    prisma.identity.findUnique({
      where: { email },
      select: { id: true },
    }),
    prisma.identityRole.findFirst({
      where: {
        role: 'super_admin',
        identity: {
          status: 'active',
          email: { not: null, notIn: ['admin@dashapp.test'] },
        },
      },
      select: { identity: { select: { email: true } } },
    }),
  ]);

  if (sameEmail) {
    throw new Error('Safety stop: that email already belongs to a DASH identity; use a dedicated admin address');
  }
  if (realSuperAdmin?.identity.email) {
    throw new Error('Safety stop: a real active Super Admin already exists; bootstrap is no longer the right tool');
  }

  const passwordHash = await hashPassword(password);
  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    const identity = await tx.identity.create({
      data: {
        email,
        emailVerifiedAt: now,
        displayName,
        passwordHash,
        status: 'active',
        roles: { create: { role: 'super_admin' } },
      },
      select: { id: true },
    });

    const seededStaff = await tx.identity.findMany({
      where: {
        email: { endsWith: '@dashapp.test' },
        roles: { some: { role: { in: STAFF_ROLES } } },
      },
      select: { id: true },
    });
    const seededIds = seededStaff.map((row) => row.id);

    if (seededIds.length > 0) {
      await tx.identity.updateMany({
        where: { id: { in: seededIds } },
        data: { status: 'suspended' },
      });
      await tx.session.updateMany({
        where: { identityId: { in: seededIds }, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'staging_real_admin_bootstrap' },
      });
    }

    return { identityId: identity.id, suspendedSeededStaff: seededIds.length };
  });

  console.log('DASH staging Super Admin bootstrap completed.');
  console.log(`Created privileged identity: ${result.identityId}`);
  console.log(`Suspended fictional staff identities: ${result.suspendedSeededStaff}`);
  console.log('Next: sign in at /admin/signin and complete authenticator enrollment.');
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
