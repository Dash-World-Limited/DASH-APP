/**
 * Real PostgreSQL publication/concurrency smoke check, after check:postgres.
 * Writes fictional API-test fixtures only to a loopback dash_verify database.
 * Run with: PG_CHECK_URL=... node --import tsx scripts/content-postgres-check.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { checkDatabaseName } from '../packages/db/src/postgres-check-guard.ts';
import { createTestContext } from '../apps/api/src/__tests__/harness.ts';
import { actAs, buildWorld } from '../apps/api/src/__tests__/world.ts';

const url = process.env.PG_CHECK_URL;
const safe = url ? checkDatabaseName(url) : { safe: false };
if (
  !url ||
  !safe.safe ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)
) {
  throw new Error(
    'PG_CHECK_URL must name a loopback dash_verify database. Run check:postgres there first.',
  );
}
const { PrismaClient } = createRequire(import.meta.url)(
  '../packages/db/prisma/postgres/.client/index.js',
);
const postgres = new PrismaClient({ datasources: { db: { url } } });
const original = await createTestContext({}, { prisma: postgres });
const context = { ...original, prisma: postgres };
try {
  const world = await buildWorld(postgres);
  const editor = await actAs(context, world.admin.email);
  const vendor = await actAs(context, world.vendorA.ownerEmail);
  const base = '/v1/admin/content';
  const content = {
    internalName: 'Postgres verification',
    type: 'announcement',
    placement: 'home.announcements',
    title: 'Published on PostgreSQL',
  };
  const call = (method, path, payload, actor = editor) =>
    context.app.inject({
      method,
      url: path,
      headers: actor.headers,
      ...(payload ? { payload } : {}),
    });
  const created = await call('POST', `${base}/entries`, content);
  assert.equal(created.statusCode, 201, created.body);
  const entry = created.json();
  assert.equal(
    (
      await call(
        'POST',
        `${base}/entries/${entry.id}/publish`,
        { version: 1 },
        vendor,
      )
    ).statusCode,
    403,
  );
  const racing = await Promise.all([
    call('POST', `${base}/entries/${entry.id}/publish`, { version: 1 }),
    call('POST', `${base}/entries/${entry.id}/publish`, { version: 1 }),
  ]);
  assert.deepEqual(
    racing.map((r) => r.statusCode).sort(),
    [200, 409],
    racing.map((r) => r.body).join('\n'),
  );
  assert.equal(
    await postgres.contentRevision.count({ where: { entryId: entry.id } }),
    2,
  );
  const before = (
    await context.app.inject({ method: 'GET', url: '/v1/content' })
  ).json();
  assert.equal(
    before.items.find((i) => i.id === entry.id)?.title,
    content.title,
  );
  const edited = await call('PUT', `${base}/entries/${entry.id}`, {
    version: 2,
    content: { ...content, title: 'Unpublished PostgreSQL draft' },
  });
  assert.equal(edited.statusCode, 200, edited.body);
  const after = (
    await context.app.inject({ method: 'GET', url: '/v1/content' })
  ).json();
  assert.equal(
    after.items.find((i) => i.id === entry.id)?.title,
    content.title,
  );
  assert.equal(
    JSON.stringify(after).includes('Unpublished PostgreSQL draft'),
    false,
  );
  assert.equal(
    (
      await call('POST', `${base}/entries/${entry.id}/unpublish`, {
        version: 3,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await context.app.inject({ method: 'GET', url: '/v1/content' }))
      .json()
      .items.some((i) => i.id === entry.id),
    false,
  );
  console.log(
    'PASS PostgreSQL: permission denial, atomic concurrent publish (200/409), no partial revisions, draft isolation, unpublish.',
  );
} finally {
  await original.close();
  await postgres.$disconnect();
}
