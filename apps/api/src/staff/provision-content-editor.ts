/** Operator-only persistence helper. Not registered as an HTTP endpoint. */
import { hashPassword } from '@dash/domain/crypto';
import type { PrismaClient } from '@dash/db';

export function assertContentEditorStagingTarget(databaseUrl: string | undefined): void {
  const url = new URL(databaseUrl ?? '');
  if (!/^postgres(ql)?:$/.test(url.protocol) || url.pathname !== '/dashdb_staging') {
    throw new Error('Content editor provisioning requires the confirmed dashdb_staging PostgreSQL database.');
  }
}

export async function provisionContentEditor(
  prisma: PrismaClient,
  input: { email: string; displayName: string; password: string },
): Promise<{ id: string }> {
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid email.');
  if (!displayName || displayName.length > 100) throw new Error('Display name must contain 1–100 characters.');
  if (input.password.length < 14 || input.password.length > 256) throw new Error('Password must contain 14–256 characters.');
  const passwordHash = await hashPassword(input.password);
  const { writeAudit } = await import('@dash/db');
  return prisma.$transaction(async (tx) => {
    // LOWER works in both supported databases and rejects legacy mixed-case identities too.
    const existing = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Identity" WHERE LOWER("email") = ${email} LIMIT 1
    `;
    if (existing.length) throw new Error('An identity already exists for that email. No changes made.');
    const identity = await tx.identity.create({
      data: {
        email, displayName, passwordHash, status: 'active', emailVerifiedAt: new Date(),
        roles: { create: { role: 'content_editor' } },
      },
      select: { id: true },
    });
    await writeAudit(tx, {
      action: 'staff.content_editor.provision', resourceType: 'identity', resourceId: identity.id,
      after: { role: 'content_editor', mechanism: 'operator_cli' },
    });
    return identity;
  }, { isolationLevel: 'Serializable' });
}
