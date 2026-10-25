import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import sharp, { type OutputInfo } from 'sharp';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { writeAudit, type ContentMedia } from '@dash/db';
import {
  contentSchema,
  contentIsVisible,
  CONTENT_PLACEMENTS,
  CONTENT_TYPES,
  type ContentInput,
  type PublicContentItem,
} from '@dash/domain/content';
import { SERVICE_CATEGORIES } from '@dash/domain/services';
import { actorOf, requirePermission } from '../http/context.js';
import { ApiError } from '../http/errors.js';

const idSchema = z.object({ id: z.string().cuid() });
const editSchema = z
  .object({ version: z.number().int().positive(), content: contentSchema })
  .strict();
const actionSchema = z
  .object({
    version: z.number().int().positive(),
    revisionId: z.string().cuid().optional(),
  })
  .strict();
const uploadSchema = z
  .object({
    filename: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .refine(
        (value) =>
          !value.includes('/') &&
          !value.includes('\\') &&
          [...value].every((char) => char.charCodeAt(0) >= 32),
        'Use a filename without path separators or control characters.',
      ),
    title: z.string().trim().min(1).max(120),
    alt: z.string().trim().min(1).max(300),
    contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    data: z
      .string()
      .min(4)
      .max(11_184_812)
      .refine(
        (value) => value.length % 4 === 0 && !/[^A-Za-z0-9+/=]/.test(value),
        'Use base64 image data.',
      ),
  })
  .strict();
type Tx = Prisma.TransactionClient;

export async function registerContentRoutes(
  app: FastifyInstance,
): Promise<void> {
  const { prisma, storage } = app.services;
  const audit = (
    tx: Tx,
    request: FastifyRequest,
    action: string,
    id: string,
    before: unknown,
    after: unknown,
  ) =>
    writeAudit(tx, {
      identityId: actorOf(request).identityId,
      action: `content.${action}`,
      resourceType: 'ContentEntry',
      resourceId: id,
      before,
      after,
      requestId: request.id,
      ipAddress: request.ip,
    });
  // Serializability also protects media archive vs publication races. Conflicts
  // roll back the complete change; editors reload before retrying.
  async function transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: 'Serializable',
      });
    } catch (error) {
      if (
        // SQLite and PostgreSQL have separate generated clients in this repo.
        // Their error constructors differ; match the provider-neutral code.
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string' &&
        ['P2034', 'P2002'].includes(error.code)
      )
        throw ApiError.conflict(
          'Content changed concurrently. Reload and try again.',
        );
      throw error;
    }
  }
  async function validateReferences(tx: Tx, data: ContentInput) {
    for (const id of [data.mediaId, data.logoMediaId].filter(
      (id): id is string => !!id,
    )) {
      const media = await tx.contentMedia.findUnique({ where: { id } });
      if (!media || media.archivedAt)
        throw ApiError.badRequest('Choose an active Studio media asset.');
    }
    if (
      data.vendorId &&
      !(await tx.vendor.findUnique({
        where: { id: data.vendorId },
        select: { id: true },
      }))
    )
      throw ApiError.badRequest('Vendor does not exist.');
  }
  async function mediaImage(
    media: ContentMedia | null,
  ): Promise<PublicContentItem['image']> {
    if (!media || media.archivedAt) return null;
    try {
      return {
        url: await storage.signedUrl(media.storageKey, 3600),
        alt: media.alt,
        width: media.width,
        height: media.height,
      };
    } catch {
      return null;
    } // A failed image must not hide the content or catalogue.
  }

  await app.register(
    async (admin) => {
      admin.addHook('preHandler', requirePermission('content:manage'));
      admin.addHook('onSend', async (_request, reply, payload) => {
        reply.header('Cache-Control', 'private, no-store');
        return payload;
      });

      admin.get('/config', async () => ({
        types: CONTENT_TYPES,
        placements: CONTENT_PLACEMENTS,
        categories: SERVICE_CATEGORIES,
      }));
      admin.get('/vendors', async (request) => {
        const { search } = z
          .object({ search: z.string().trim().max(80).default('') })
          .parse(request.query);
        return {
          vendors: await prisma.vendor.findMany({
            where: { name: { contains: search } },
            select: { id: true, name: true, category: true },
            orderBy: { name: 'asc' },
            take: 50,
          }),
        };
      });
      admin.get('/entries', async (request) => {
        const query = z
          .object({
            cursor: z.string().cuid().optional(),
            type: z.enum(CONTENT_TYPES).optional(),
            status: z.enum(['draft', 'published']).optional(),
            placement: z.enum(CONTENT_PLACEMENTS).optional(),
            vendorId: z.string().cuid().optional(),
            categoryId: z.string().max(40).optional(),
          })
          .parse(request.query);
        // Filter in SQL via pointer for status; presentation filters are validated
        // JSON snapshots (portable across the existing SQLite/Postgres schemas).
        const entries = await prisma.contentEntry.findMany({
          where: query.status
            ? {
                publishedRevisionId:
                  query.status === 'published' ? { not: null } : null,
              }
            : {},
          include: { publishedRevision: true },
          orderBy: { id: 'asc' },
          take: 100,
          ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        });
        return {
          entries: entries
            .map((entry) => ({
              ...entry,
              draft: contentSchema.parse(JSON.parse(entry.draft)),
            }))
            .filter(
              ({ draft }) =>
                (!query.type || draft.type === query.type) &&
                (!query.placement || draft.placement === query.placement) &&
                (!query.vendorId || draft.vendorId === query.vendorId) &&
                (!query.categoryId || draft.categoryId === query.categoryId),
            ),
          nextCursor: entries.length === 100 ? entries.at(-1)?.id : null,
        };
      });
      admin.get('/dashboard', async () => {
        const [drafts, published, media, recentlyUpdated, recentlyPublished] =
          await Promise.all([
            prisma.contentEntry.count({ where: { publishedRevisionId: null } }),
            prisma.contentEntry.count({
              where: { publishedRevisionId: { not: null } },
            }),
            prisma.contentMedia.count({ where: { archivedAt: null } }),
            prisma.contentEntry.findMany({
              orderBy: { updatedAt: 'desc' },
              take: 5,
              select: {
                id: true,
                draft: true,
                updatedAt: true,
                updatedBy: true,
              },
            }),
            prisma.contentRevision.findMany({
              where: { action: { in: ['publish', 'rollback'] } },
              orderBy: { createdAt: 'desc' },
              take: 5,
            }),
          ]);
        return { drafts, published, media, recentlyUpdated, recentlyPublished };
      });
      admin.get('/entries/:id', async (request) => {
        const { id } = idSchema.parse(request.params);
        const entry = await prisma.contentEntry.findUnique({
          where: { id },
          include: { publishedRevision: true },
        });
        if (!entry) throw ApiError.notFound();
        return {
          ...entry,
          draft: contentSchema.parse(JSON.parse(entry.draft)),
        };
      });
      admin.get('/entries/:id/history', async (request) => {
        const { id } = idSchema.parse(request.params);
        if (
          !(await prisma.contentEntry.findUnique({
            where: { id },
            select: { id: true },
          }))
        )
          throw ApiError.notFound();
        const { before } = z
          .object({ before: z.coerce.number().int().positive().optional() })
          .parse(request.query);
        return {
          revisions: await prisma.contentRevision.findMany({
            where: {
              entryId: id,
              ...(before ? { number: { lt: before } } : {}),
            },
            orderBy: { number: 'desc' },
            take: 50,
          }),
        };
      });
      admin.post('/entries', async (request, reply) => {
        const data = contentSchema.parse(request.body);
        const entry = await transaction(async (tx) => {
          await validateReferences(tx, data);
          const actorId = actorOf(request).identityId;
          const entry = await tx.contentEntry.create({
            data: {
              draft: JSON.stringify(data),
              createdBy: actorId,
              updatedBy: actorId,
            },
          });
          await tx.contentRevision.create({
            data: {
              entryId: entry.id,
              number: 1,
              action: 'draft',
              payload: entry.draft,
              actorId,
              mediaId: data.mediaId,
              logoMediaId: data.logoMediaId,
            },
          });
          await audit(tx, request, 'created', entry.id, null, { version: 1 });
          return entry;
        });
        return reply.code(201).send({ ...entry, draft: data });
      });
      admin.put('/entries/:id', async (request) => {
        const { id } = idSchema.parse(request.params);
        const { version, content } = editSchema.parse(request.body);
        return transaction(async (tx) => {
          await validateReferences(tx, content);
          const changed = await tx.contentEntry.updateMany({
            where: { id, version },
            data: {
              draft: JSON.stringify(content),
              version: { increment: 1 },
              updatedBy: actorOf(request).identityId,
            },
          });
          if (!changed.count)
            throw ApiError.conflict(
              'Content changed or no longer exists. Reload before saving.',
            );
          await tx.contentRevision.create({
            data: {
              entryId: id,
              number: version + 1,
              action: 'draft',
              payload: JSON.stringify(content),
              actorId: actorOf(request).identityId,
              mediaId: content.mediaId,
              logoMediaId: content.logoMediaId,
            },
          });
          await audit(
            tx,
            request,
            'draft_saved',
            id,
            { version },
            { version: version + 1 },
          );
          const entry = await tx.contentEntry.findUniqueOrThrow({
            where: { id },
          });
          return { ...entry, draft: content };
        });
      });
      for (const action of ['publish', 'unpublish', 'rollback'] as const) {
        admin.post(`/entries/:id/${action}`, { preHandler: requirePermission('content:publish') }, async (request) => {
          const { id } = idSchema.parse(request.params);
          const body = actionSchema.parse(request.body);
          return transaction(async (tx) => {
            const entry = await tx.contentEntry.findUnique({ where: { id } });
            if (!entry) throw ApiError.notFound();
            let payload = entry.draft;
            if (action === 'rollback') {
              if (!body.revisionId)
                throw ApiError.badRequest('Select a published revision.');
              const revision = await tx.contentRevision.findFirst({
                where: {
                  id: body.revisionId,
                  entryId: id,
                  action: { in: ['publish', 'rollback'] },
                },
              });
              if (!revision) throw ApiError.notFound();
              payload = revision.payload;
            }
            const data = contentSchema.parse(JSON.parse(payload));
            await validateReferences(tx, data);
            if (
              action !== 'unpublish' &&
              !entry.publishedRevisionId &&
              (await tx.contentEntry.count({
                where: { publishedRevisionId: { not: null } },
              })) >= 500
            ) {
              throw ApiError.conflict(
                'The V1 feed supports 500 published items. Unpublish an unused item first.',
              );
            }
            if (
              action !== 'unpublish' &&
              ['banner', 'promotion', 'campaign', 'category_artwork'].includes(
                data.type,
              ) &&
              !data.mediaId
            )
              throw ApiError.badRequest('Select an image before publishing.');
            const changed = await tx.contentEntry.updateMany({
              where: { id, version: body.version },
              data: {
                version: { increment: 1 },
                updatedBy: actorOf(request).identityId,
                ...(action === 'rollback' ? { draft: payload } : {}),
              },
            });
            if (!changed.count)
              throw ApiError.conflict(
                'Content changed. Reload before publishing.',
              );
            const revision = await tx.contentRevision.create({
              data: {
                entryId: id,
                number: body.version + 1,
                action,
                payload,
                actorId: actorOf(request).identityId,
                mediaId: data.mediaId,
                logoMediaId: data.logoMediaId,
              },
            });
            const updated = await tx.contentEntry.update({
              where: { id },
              data: {
                publishedRevisionId:
                  action === 'unpublish' ? null : revision.id,
              },
            });
            await audit(
              tx,
              request,
              action,
              id,
              { publishedRevisionId: entry.publishedRevisionId },
              {
                publishedRevisionId: updated.publishedRevisionId,
                version: updated.version,
              },
            );
            return {
              ...updated,
              draft: contentSchema.parse(JSON.parse(updated.draft)),
            };
          });
        });
      }
      admin.get('/media', async (request) => {
        const { cursor } = z
          .object({ cursor: z.string().cuid().optional() })
          .parse(request.query);
        const assets = await prisma.contentMedia.findMany({
          orderBy: { id: 'asc' },
          take: 50,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          include: {
            _count: { select: { imageRevisions: true, logoRevisions: true } },
          },
        });
        return {
          assets: await Promise.all(
            assets.map(async (asset) => ({
              ...asset,
              image: await mediaImage(asset),
              references:
                asset._count.imageRevisions + asset._count.logoRevisions,
            })),
          ),
          nextCursor: assets.length === 50 ? assets.at(-1)?.id : null,
        };
      });
      admin.post(
        '/media',
        { bodyLimit: 12 * 1024 * 1024 },
        async (request, reply) => {
          const data = uploadSchema.parse(request.body);
          const bytes = Buffer.from(data.data, 'base64');
          if (bytes.toString('base64') !== data.data)
            throw ApiError.badRequest('Use valid base64 image data.');
          if (!bytes.length || bytes.length > 8 * 1024 * 1024)
            throw ApiError.badRequest('Images must be under 8 MB.');
          let image: { data: Buffer; info: OutputInfo };
          try {
            const decoder = sharp(bytes, {
              failOn: 'warning',
              limitInputPixels: 25_000_000,
            });
            const metadata = await decoder.metadata();
            if (
              `image/${metadata.format === 'jpeg' ? 'jpeg' : metadata.format}` !==
                data.contentType ||
              !metadata.width ||
              !metadata.height ||
              metadata.width > 8000 ||
              metadata.height > 8000 ||
              (metadata.pages ?? 1) > 1
            )
              throw new Error('Unsupported image');
            image = await decoder
              .rotate()
              .resize({
                width: 2400,
                height: 2400,
                fit: 'inside',
                withoutEnlargement: true,
              })
              .webp({ quality: 85 })
              .toBuffer({ resolveWithObject: true });
          } catch {
            throw ApiError.badRequest(
              'Use a valid, still JPEG, PNG or WebP up to 8000 × 8000 and 25 megapixels.',
            );
          }
          const stored = await storage.put({
            body: image.data,
            contentType: 'image/webp',
            prefix: 'content-studio',
          });
          try {
            const asset = await transaction(async (tx) => {
              const asset = await tx.contentMedia.create({
                data: {
                  storageKey: stored.key,
                  filename: data.filename,
                  title: data.title,
                  alt: data.alt,
                  contentType: 'image/webp',
                  bytes: stored.sizeBytes,
                  width: image.info.width,
                  height: image.info.height,
                  uploadedBy: actorOf(request).identityId,
                },
              });
              await audit(tx, request, 'media_uploaded', asset.id, null, {
                title: asset.title,
                bytes: asset.bytes,
              });
              return asset;
            });
            return reply
              .code(201)
              .send({ ...asset, image: await mediaImage(asset) });
          } catch (error) {
            await storage.delete(stored.key).catch(() => undefined);
            throw error;
          }
        },
      );
      admin.post('/media/:id/archive', async (request) => {
        const { id } = idSchema.parse(request.params);
        return transaction(async (tx) => {
          const asset = await tx.contentMedia.findUnique({ where: { id } });
          if (!asset) throw ApiError.notFound();
          if (
            await tx.contentRevision.count({
              where: { OR: [{ mediaId: id }, { logoMediaId: id }] },
            })
          )
            throw ApiError.conflict(
              'This asset is retained by content history. Upload a replacement instead.',
            );
          await tx.contentMedia.update({
            where: { id },
            data: { archivedAt: new Date() },
          });
          await audit(tx, request, 'media_archived', id, null, {
            archived: true,
          });
          return { archived: true };
        });
      });
    },
    { prefix: '/v1/admin/content' },
  );

  app.get('/v1/content', async (request, reply) => {
    const { placement } = z
      .object({ placement: z.enum(CONTENT_PLACEMENTS).optional() })
      .parse(request.query);
    try {
      // Only immutable live revisions are selected. The public query never
      // selects draft text, actor identities, audit data or object keys.
      const entries = await prisma.contentEntry.findMany({
        where: { publishedRevisionId: { not: null } },
        select: {
          id: true,
          publishedRevision: {
            select: {
              number: true,
              payload: true,
              media: true,
              logoMedia: true,
            },
          },
        },
        orderBy: { id: 'asc' },
        take: 500,
      });
      const now = new Date();
      const items: PublicContentItem[] = [];
      for (const entry of entries) {
        const revision = entry.publishedRevision;
        if (!revision) continue;
        const parsed = contentSchema.safeParse(JSON.parse(revision.payload));
        if (
          !parsed.success ||
          !contentIsVisible(parsed.data, now) ||
          (placement && parsed.data.placement !== placement)
        )
          continue;
        const data = parsed.data;
        items.push({
          id: entry.id,
          revision: revision.number,
          type: data.type,
          placement: data.placement,
          title: data.title,
          body: data.body,
          href: data.href,
          label: data.label,
          featured: data.featured,
          position: data.position,
          vendorId: data.vendorId,
          categoryId: data.categoryId,
          image: await mediaImage(revision.media),
          logo: await mediaImage(revision.logoMedia),
        });
      }
      items.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
      const version = createHash('sha256')
        .update(
          JSON.stringify(
            items.map(({ image: _image, logo: _logo, ...item }) => item),
          ),
        )
        .digest('hex')
        .slice(0, 24);
      // Do not serve stale content across a scheduling boundary. Images are
      // private signed objects; the response's TTL is far below URL lifetime.
      const boundaries = entries.flatMap(({ publishedRevision: r }) => {
        if (!r) return [];
        const data = contentSchema.parse(JSON.parse(r.payload));
        return [data.startsAt, data.endsAt]
          .filter((v): v is string => !!v)
          .map((v) => new Date(v).getTime() - now.getTime())
          .filter((v) => v > 0);
      });
      const ttl = Math.max(
        0,
        Math.min(30, ...boundaries.map((ms) => Math.floor(ms / 1000))),
      );
      return reply
        .header('Cache-Control', `public, max-age=${ttl}`)
        .send({ schemaVersion: 1, version, items });
    } catch (error) {
      request.log.warn(
        { err: error },
        'Content unavailable; serving presentation fallback',
      );
      return reply
        .header('Cache-Control', 'no-store')
        .send({ schemaVersion: 1, version: 'unavailable', items: [] });
    }
  });
}
