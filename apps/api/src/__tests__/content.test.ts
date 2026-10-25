import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import type { ContentInput, PublishedContent } from '@dash/domain/content';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, type Actor, type World } from './world.js';

let ctx: TestContext;
let world: World;
let admin: Actor;
let assetId: string;
const BASE = '/v1/admin/content';
const content = (extra: Partial<ContentInput> = {}) => ({
  internalName: 'Private editorial working name',
  type: 'announcement',
  placement: 'home.announcements',
  title: 'Live announcement',
  body: 'A little news',
  ...extra,
});
const call = (
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: unknown,
  actor = admin,
) =>
  ctx.app.inject({
    method,
    url,
    headers: actor.headers,
    ...(payload ? { payload } : {}),
  });
const feed = async () =>
  (
    await ctx.app.inject({ method: 'GET', url: '/v1/content' })
  ).json<PublishedContent>();
const create = async (extra: Partial<ContentInput> = {}) => {
  const response = await call('POST', `${BASE}/entries`, content(extra));
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string; version: number; draft: ContentInput }>();
};

beforeAll(async () => {
  ctx = await createTestContext();
  world = await buildWorld(ctx.prisma);
  admin = await actAs(ctx, world.admin.email);
  const bytes = await sharp({
    create: { width: 30, height: 20, channels: 3, background: '#eab44d' },
  })
    .png()
    .toBuffer();
  const response = await call('POST', `${BASE}/media`, {
    filename: 'hero.png',
    title: 'Home campaign',
    alt: 'DASH gold artwork',
    contentType: 'image/png',
    data: bytes.toString('base64'),
  });
  expect(response.statusCode, response.body).toBe(201);
  assetId = response.json<{ id: string }>().id;
});
afterAll(async () => {
  await ctx?.close();
});

describe('Content Studio security and publishing', () => {
  it('returns an empty published contract before content exists', async () => {
    expect((await feed()).items).toEqual([]);
  });
  it('denies every editorial path to customers, vendors, riders and unrelated staff', async () => {
    for (const identity of [
      world.customerA.email,
      world.vendorA.ownerEmail,
      world.riderA.email,
      world.support.email,
      world.dispatcher.email,
      world.finance.email,
    ]) {
      const actor = await actAs(ctx, identity);
      for (const path of [
        '/dashboard',
        '/entries',
        '/media',
        '/config',
        '/vendors',
      ])
        expect(
          (await call('GET', BASE + path, undefined, actor)).statusCode,
        ).toBe(403);
      expect(
        (await call('POST', `${BASE}/entries`, content(), actor)).statusCode,
      ).toBe(403);
      expect(
        (
          await call(
            'PUT',
            `${BASE}/entries/c1234567890123456789012345`,
            { version: 1, content: content() },
            actor,
          )
        ).statusCode,
      ).toBe(403);
      for (const action of ['publish', 'unpublish', 'rollback'])
        expect(
          (
            await call(
              'POST',
              `${BASE}/entries/c1234567890123456789012345/${action}`,
              { version: 1 },
              actor,
            )
          ).statusCode,
        ).toBe(403);
      expect((await call('POST', `${BASE}/media`, {}, actor)).statusCode).toBe(
        403,
      );
      expect(
        (
          await call(
            'POST',
            `${BASE}/media/c1234567890123456789012345/archive`,
            {},
            actor,
          )
        ).statusCode,
      ).toBe(403);
    }
    expect(
      (await ctx.app.inject({ method: 'GET', url: `${BASE}/entries` }))
        .statusCode,
    ).toBe(401);
  });
  it('keeps draft edits and metadata out of the public response, supports rollback and unpublish', async () => {
    const entry = await create();
    expect((await feed()).items.some((i) => i.id === entry.id)).toBe(false);
    const publish = await call('POST', `${BASE}/entries/${entry.id}/publish`, {
      version: 1,
    });
    expect(publish.statusCode, publish.body).toBe(200);
    const publishedId = publish.json<{ publishedRevisionId: string }>()
      .publishedRevisionId;
    const live = await feed();
    expect(live.items.find((i) => i.id === entry.id)?.title).toBe(
      'Live announcement',
    );
    const json = JSON.stringify(live);
    for (const privateValue of [
      'Private editorial working name',
      world.admin.identityId,
      'publishedRevisionId',
      'storageKey',
      'actorId',
      'draft',
    ])
      expect(json).not.toContain(privateValue);
    const edit = await call('PUT', `${BASE}/entries/${entry.id}`, {
      version: 2,
      content: content({ title: 'Unfinished private changes' }),
    });
    expect(edit.statusCode, edit.body).toBe(200);
    expect((await feed()).items.find((i) => i.id === entry.id)?.title).toBe(
      'Live announcement',
    );
    expect(
      (
        await call('POST', `${BASE}/entries/${entry.id}/publish`, {
          version: 2,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await call('POST', `${BASE}/entries/${entry.id}/publish`, {
          version: 3,
        })
      ).statusCode,
    ).toBe(200);
    expect((await feed()).version).not.toBe(live.version);
    expect(
      (
        await call('POST', `${BASE}/entries/${entry.id}/rollback`, {
          version: 4,
          revisionId: publishedId,
        })
      ).statusCode,
    ).toBe(200);
    expect((await feed()).items.find((i) => i.id === entry.id)?.title).toBe(
      'Live announcement',
    );
    expect(
      (
        await call('POST', `${BASE}/entries/${entry.id}/unpublish`, {
          version: 5,
        })
      ).statusCode,
    ).toBe(200);
    expect((await feed()).items.find((i) => i.id === entry.id)).toBeUndefined();
    const history = (
      await call('GET', `${BASE}/entries/${entry.id}/history`)
    ).json<{ revisions: { action: string }[] }>();
    expect(history.revisions.map((r) => r.action)).toEqual([
      'unpublish',
      'rollback',
      'publish',
      'draft',
      'publish',
      'draft',
    ]);
    expect(
      await ctx.prisma.auditLog.count({
        where: { resourceId: entry.id, identityId: world.admin.identityId },
      }),
    ).toBe(6);
  });
  it('rejects stale saves and rollback across entries without partial revision writes', async () => {
    const a = await create();
    const b = await create();
    const publish = await call('POST', `${BASE}/entries/${b.id}/publish`, {
      version: 1,
    });
    expect(
      (
        await call('POST', `${BASE}/entries/${a.id}/rollback`, {
          version: 1,
          revisionId: publish.json<{ publishedRevisionId: string }>()
            .publishedRevisionId,
        })
      ).statusCode,
    ).toBe(404);
    const edit = await call('PUT', `${BASE}/entries/${a.id}`, {
      version: 1,
      content: content({ title: 'New draft' }),
    });
    expect(edit.statusCode).toBe(200);
    expect(
      (
        await call('PUT', `${BASE}/entries/${a.id}`, {
          version: 1,
          content: content({ title: 'Lost update' }),
        })
      ).statusCode,
    ).toBe(409);
    expect(
      await ctx.prisma.contentRevision.count({ where: { entryId: a.id } }),
    ).toBe(2);
  });
  it('supports scheduling, visibility, order, placement filtering and missing-image fallback', async () => {
    const now = Date.now();
    const future = await create({
      title: 'Future',
      startsAt: new Date(now + 10000).toISOString(),
    });
    const ended = await create({
      title: 'Ended',
      endsAt: new Date(now - 10000).toISOString(),
    });
    const hidden = await create({ title: 'Hidden', visible: false });
    const hero = await create({
      type: 'banner',
      placement: 'home.hero',
      mediaId: assetId,
      title: 'Hero',
      position: 1,
    });
    for (const e of [future, ended, hidden, hero])
      expect(
        (await call('POST', `${BASE}/entries/${e.id}/publish`, { version: 1 }))
          .statusCode,
      ).toBe(200);
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/content?placement=home.hero',
    });
    const live = response.json<PublishedContent>();
    expect(live.items.map((i) => i.title)).toEqual(['Hero']);
    expect(live.items[0]?.image?.alt).toBe('DASH gold artwork');
    expect(response.headers['cache-control']).toMatch(/public, max-age=[0-9]+/);
    const all = await feed();
    expect(
      all.items.some((i) => ['Future', 'Ended', 'Hidden'].includes(i.title)),
    ).toBe(false);
    const sign = vi
      .spyOn(ctx.app.services.storage, 'signedUrl')
      .mockRejectedValue(new Error('Storage offline'));
    expect(
      (await feed()).items.find((i) => i.id === hero.id)?.image,
    ).toBeNull();
    sign.mockRestore();
  });
  it('fails open to empty presentation if content database queries fail', async () => {
    const query = vi
      .spyOn(ctx.prisma.contentEntry, 'findMany')
      .mockRejectedValueOnce(new Error('Database unavailable'));
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/content',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      schemaVersion: 1,
      version: 'unavailable',
      items: [],
    });
    expect(response.headers['cache-control']).toBe('no-store');
    query.mockRestore();
  });
  it('validates destinations, targets, type/placement combinations and schedules', async () => {
    for (const extra of [
      { href: 'javascript:alert(1)' },
      { href: '//evil.test' },
      { href: '/home?redirect=evil' },
      { type: 'free_html' },
      { placement: 'legal' },
      { type: 'vendor_presentation', placement: 'vendor.presentation' },
      {
        type: 'category_artwork',
        placement: 'category.artwork',
        categoryId: 'restaurants',
      },
      { endsAt: '2026-01-01T00:00:00Z', startsAt: '2026-02-01T00:00:00Z' },
    ]) {
      expect(
        (await call('POST', `${BASE}/entries`, { ...content(), ...extra }))
          .statusCode,
      ).toBe(400);
    }
    expect(
      (
        await call(
          'POST',
          `${BASE}/entries`,
          content({ vendorId: 'c1234567890123456789012345' }),
        )
      ).statusCode,
    ).toBe(400);
    const noImage = await create({ type: 'banner', placement: 'home.hero' });
    expect(
      (
        await call('POST', `${BASE}/entries/${noImage.id}/publish`, {
          version: 1,
        })
      ).statusCode,
    ).toBe(400);
  });
  it('keeps vendor operational data intact while publishing an override', async () => {
    const before = await ctx.prisma.vendor.findUniqueOrThrow({
      where: { id: world.vendorA.vendorId },
    });
    const entry = await create({
      type: 'vendor_presentation',
      placement: 'vendor.presentation',
      vendorId: before.id,
      mediaId: assetId,
      logoMediaId: assetId,
      featured: true,
    });
    expect(
      (
        await call('POST', `${BASE}/entries/${entry.id}/publish`, {
          version: 1,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      await ctx.prisma.vendor.findUniqueOrThrow({ where: { id: before.id } }),
    ).toEqual(before);
  });
});

describe('Media integrity', () => {
  it('serves editorial images across web origins only through a valid signed URL', async () => {
    const asset = await ctx.prisma.contentMedia.findUniqueOrThrow({
      where: { id: assetId },
    });
    const url = await ctx.app.services.storage.signedUrl(asset.storageKey, 60);
    const response = await ctx.app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/webp');
    expect(response.headers['cross-origin-resource-policy']).toBe(
      'cross-origin',
    );
    const invalid = url.replace(
      /signature=[a-f0-9]+/,
      `signature=${'0'.repeat(64)}`,
    );
    expect(
      (await ctx.app.inject({ method: 'GET', url: invalid })).statusCode,
    ).toBe(404);
  });
  it('refuses SVG, corrupt raster, MIME spoofing and over-size uploads', async () => {
    for (const upload of [
      {
        contentType: 'image/svg+xml',
        data: Buffer.from('<svg><script>alert(1)</script></svg>').toString(
          'base64',
        ),
      },
      {
        contentType: 'image/png',
        data: Buffer.from('not a png').toString('base64'),
      },
      {
        contentType: 'image/jpeg',
        data: (
          await sharp({
            create: { width: 1, height: 1, channels: 3, background: 'red' },
          })
            .png()
            .toBuffer()
        ).toString('base64'),
      },
      {
        contentType: 'image/png',
        data: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64'),
      },
    ])
      expect(
        (
          await call('POST', `${BASE}/media`, {
            filename: 'bad.png',
            title: 'Bad',
            alt: 'Bad',
            ...upload,
          })
        ).statusCode,
      ).toBe(400);
  });
  it('prevents archiving assets referenced by drafts, publications or retained history', async () => {
    expect(
      (await call('POST', `${BASE}/media/${assetId}/archive`)).statusCode,
    ).toBe(409);
    const bytes = await sharp({
      create: { width: 1, height: 1, channels: 3, background: 'blue' },
    })
      .png()
      .toBuffer();
    const asset = await call('POST', `${BASE}/media`, {
      filename: 'unused.png',
      title: 'Unused',
      alt: 'Blue',
      contentType: 'image/png',
      data: bytes.toString('base64'),
    });
    const id = asset.json<{ id: string }>().id;
    expect((await call('POST', `${BASE}/media/${id}/archive`)).statusCode).toBe(
      200,
    );
    expect(
      (await call('POST', `${BASE}/entries`, content({ mediaId: id })))
        .statusCode,
    ).toBe(400);
    const library = (await call('GET', `${BASE}/media`)).json<{
      assets: { id: string; references: number; contentType: string }[];
    }>();
    expect(
      library.assets.find((a) => a.id === assetId)?.references,
    ).toBeGreaterThan(0);
    expect(library.assets.find((a) => a.id === assetId)?.contentType).toBe(
      'image/webp',
    );
  });
});
