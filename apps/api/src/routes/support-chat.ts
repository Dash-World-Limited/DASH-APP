/**
 * In-app support chat: customers and riders talking to the DASH team.
 *
 * Built on the existing support-case model rather than beside it. A
 * conversation is a SupportCase in category `in_app_chat`, owned by exactly one
 * customer or one rider; each message is a SupportAction — `message` from the
 * customer or rider, `reply` from staff. So support staff see these alongside
 * every other case, account deletion already clears what a customer wrote,
 * and the data export already includes it.
 *
 * One conversation per person per role, reopened when they write again. A
 * person who is both a customer and a rider has two, and staff always see
 * which one they are answering.
 *
 * Read state: a message's `readAt` is when the other side opened the
 * conversation. Staff names are never shown to customers or riders.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { generateReference } from '@dash/domain/crypto';
import { writeAudit } from '@dash/db';
import { ApiError } from '../http/errors.js';
import { actorOf, requireAuth, requirePermission } from '../http/context.js';

export const SUPPORT_CHAT_CATEGORY = 'in_app_chat';
const BODY_MAX = 2_000;
/** The first answer the team aims for once a conversation opens or reopens. */
const FIRST_RESPONSE_MS = 2 * 60 * 60_000;

type Audience = 'customer' | 'rider';

const audienceSchema = z.enum(['customer', 'rider']);
const bodySchema = z.string().trim().min(1, 'Write a message first.').max(BODY_MAX);

interface Owner {
  audience: Audience;
  where: { customerId: string } | { riderId: string };
  create: { customerId: string } | { riderId: string };
}

function ownerOf(request: FastifyRequest, audience: Audience): Owner {
  const actor = actorOf(request);
  if (audience === 'customer') {
    if (!actor.customerId) throw ApiError.forbidden('This account has no customer profile.');
    return { audience, where: { customerId: actor.customerId }, create: { customerId: actor.customerId } };
  }
  if (!actor.riderId) throw ApiError.forbidden('This account is not a rider account.');
  return { audience, where: { riderId: actor.riderId }, create: { riderId: actor.riderId } };
}

export async function registerSupportChatRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, config } = app.services;

  // -------------------------------------------------------------------------
  // GET /v1/support/channels — how to reach DASH, for the Help screens
  //
  // Public: someone who cannot sign in needs it most. WhatsApp appears only
  // when the deployment has an official number configured.
  // -------------------------------------------------------------------------
  app.get('/v1/support/channels', async () => ({
    whatsapp: config.SUPPORT_WHATSAPP_E164 ?? null,
    chat: true,
  }));

  async function conversationFor(owner: Owner) {
    return prisma.supportCase.findFirst({
      where: { category: SUPPORT_CHAT_CATEGORY, ...owner.where },
      orderBy: { createdAt: 'asc' },
      select: { id: true, code: true, status: true, createdAt: true },
    });
  }

  // -------------------------------------------------------------------------
  // GET /v1/support/chat?as=customer|rider — the caller's own conversation
  //
  // Opening it marks the team's replies read.
  // -------------------------------------------------------------------------
  app.get('/v1/support/chat', { preHandler: requireAuth }, async (request, reply) => {
    const { as } = z.object({ as: audienceSchema }).parse(request.query);
    const owner = ownerOf(request, as);
    reply.header('cache-control', 'no-store');

    const conversation = await conversationFor(owner);
    if (!conversation) return { conversation: null, messages: [] };

    await prisma.supportAction.updateMany({
      where: { caseId: conversation.id, kind: 'reply', readAt: null },
      data: { readAt: new Date() },
    });
    const messages = await prisma.supportAction.findMany({
      where: { caseId: conversation.id, kind: { in: ['message', 'reply'] }, isInternal: false },
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: { id: true, kind: true, body: true, readAt: true, createdAt: true },
    });
    return {
      conversation,
      messages: messages.map((message) => ({
        id: message.id,
        from: message.kind === 'message' ? ('me' as const) : ('dash' as const),
        body: message.body ?? '',
        readAt: message.readAt,
        createdAt: message.createdAt,
      })),
    };
  });

  // -------------------------------------------------------------------------
  // GET /v1/support/chat/unread?as= — replies the caller has not opened yet
  // -------------------------------------------------------------------------
  app.get('/v1/support/chat/unread', { preHandler: requireAuth }, async (request) => {
    const { as } = z.object({ as: audienceSchema }).parse(request.query);
    const owner = ownerOf(request, as);
    const conversation = await conversationFor(owner);
    if (!conversation) return { unread: 0 };
    return {
      unread: await prisma.supportAction.count({ where: { caseId: conversation.id, kind: 'reply', readAt: null } }),
    };
  });

  // -------------------------------------------------------------------------
  // POST /v1/support/chat/messages — write to the DASH team
  // -------------------------------------------------------------------------
  app.post(
    '/v1/support/chat/messages',
    { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const actor = actorOf(request);
      const body = z.object({ as: audienceSchema, body: bodySchema }).strict().parse(request.body);
      const owner = ownerOf(request, body.as);

      const message = await prisma.$transaction(async (tx) => {
        const existing = await tx.supportCase.findFirst({
          where: { category: SUPPORT_CHAT_CATEGORY, ...owner.where },
          orderBy: { createdAt: 'asc' },
          select: { id: true, status: true },
        });
        const dueAt = new Date(Date.now() + FIRST_RESPONSE_MS);
        const conversationId = existing
          ? existing.id
          : (
              await tx.supportCase.create({
                data: {
                  code: generateReference('SUP'),
                  ...owner.create,
                  subject: owner.audience === 'rider' ? 'Rider in-app support chat' : 'Customer in-app support chat',
                  category: SUPPORT_CHAT_CATEGORY,
                  firstResponseDueAt: dueAt,
                },
                select: { id: true },
              })
            ).id;

        // Writing again reopens a conversation the team had resolved, and
        // touching it moves it to the top of the team's inbox.
        await tx.supportCase.update({
          where: { id: conversationId },
          data:
            existing && existing.status !== 'open'
              ? { status: 'open', resolvedAt: null, firstResponseDueAt: dueAt, firstRespondedAt: null }
              : { updatedAt: new Date() },
        });

        return tx.supportAction.create({
          data: { caseId: conversationId, actorId: actor.identityId, kind: 'message', body: body.body },
          select: { id: true, body: true, readAt: true, createdAt: true },
        });
      });

      return { message: { id: message.id, from: 'me' as const, body: message.body ?? '', readAt: message.readAt, createdAt: message.createdAt } };
    },
  );

  // =========================================================================
  // The DASH team's inbox
  // =========================================================================

  // -------------------------------------------------------------------------
  // GET /v1/admin/support/conversations?audience=&status=
  // -------------------------------------------------------------------------
  app.get(
    '/v1/admin/support/conversations',
    { preHandler: requirePermission('support:case:read') },
    async (request, reply) => {
      const query = z
        .object({
          audience: z.enum(['customer', 'rider', 'all']).default('all'),
          status: z.enum(['open', 'resolved', 'all']).default('all'),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        })
        .parse(request.query);

      const cases = await prisma.supportCase.findMany({
        where: {
          category: SUPPORT_CHAT_CATEGORY,
          ...(query.audience === 'customer' ? { customerId: { not: null } } : {}),
          ...(query.audience === 'rider' ? { riderId: { not: null } } : {}),
          ...(query.status === 'all' ? {} : { status: query.status }),
        },
        orderBy: { updatedAt: 'desc' },
        take: query.limit,
        select: { id: true, code: true, status: true, customerId: true, riderId: true, createdAt: true, updatedAt: true },
      });
      const ids = cases.map((entry) => entry.id);

      const [unread, latest, people] = await Promise.all([
        prisma.supportAction.groupBy({
          by: ['caseId'],
          where: { caseId: { in: ids }, kind: 'message', readAt: null },
          _count: { _all: true },
        }),
        Promise.all(
          ids.map((caseId) =>
            prisma.supportAction.findFirst({
              where: { caseId, kind: { in: ['message', 'reply'] }, isInternal: false },
              orderBy: { createdAt: 'desc' },
              select: { caseId: true, kind: true, body: true, createdAt: true },
            }),
          ),
        ),
        accountsFor(cases),
      ]);
      const unreadByCase = new Map(unread.map((row) => [row.caseId, row._count._all]));
      const latestByCase = new Map(latest.filter((row) => row !== null).map((row) => [row!.caseId, row!]));

      reply.header('cache-control', 'no-store');
      return {
        conversations: cases.map((entry) => {
          const last = latestByCase.get(entry.id);
          return {
            id: entry.id,
            code: entry.code,
            status: entry.status,
            audience: entry.riderId ? ('rider' as const) : ('customer' as const),
            account: people.get(entry.id) ?? null,
            unread: unreadByCase.get(entry.id) ?? 0,
            lastMessage: last
              ? { from: last.kind === 'message' ? 'account' : 'staff', preview: (last.body ?? '').slice(0, 140), createdAt: last.createdAt }
              : null,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
          };
        }),
        unreadTotal: unread.reduce((total, row) => total + row._count._all, 0),
      };
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/admin/support/conversations/:id — open one; marks it read
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/v1/admin/support/conversations/:id',
    { preHandler: requirePermission('support:case:read') },
    async (request, reply) => {
      const entry = await prisma.supportCase.findFirst({
        where: { id: request.params.id, category: SUPPORT_CHAT_CATEGORY },
        select: { id: true, code: true, status: true, customerId: true, riderId: true, createdAt: true, updatedAt: true, firstRespondedAt: true },
      });
      if (!entry) throw ApiError.notFound();

      await prisma.supportAction.updateMany({
        where: { caseId: entry.id, kind: 'message', readAt: null },
        data: { readAt: new Date() },
      });
      const messages = await prisma.supportAction.findMany({
        where: { caseId: entry.id, kind: { in: ['message', 'reply'] }, isInternal: false },
        orderBy: { createdAt: 'asc' },
        take: 500,
        select: { id: true, kind: true, body: true, actorId: true, readAt: true, createdAt: true },
      });
      const staffIds = [...new Set(messages.filter((message) => message.kind === 'reply').map((message) => message.actorId))];
      const staff = await prisma.identity.findMany({ where: { id: { in: staffIds } }, select: { id: true, displayName: true } });
      const staffName = new Map(staff.map((person) => [person.id, person.displayName]));

      reply.header('cache-control', 'no-store');
      return {
        conversation: {
          ...entry,
          customerId: undefined,
          riderId: undefined,
          audience: entry.riderId ? ('rider' as const) : ('customer' as const),
          account: (await accountsFor([entry])).get(entry.id) ?? null,
        },
        messages: messages.map((message) => ({
          id: message.id,
          from: message.kind === 'message' ? ('account' as const) : ('staff' as const),
          staffName: message.kind === 'reply' ? staffName.get(message.actorId) ?? 'DASH Support' : null,
          body: message.body ?? '',
          readAt: message.readAt,
          createdAt: message.createdAt,
        })),
      };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/admin/support/conversations/:id/messages — reply
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/admin/support/conversations/:id/messages',
    {
      preHandler: requirePermission('support:case:write'),
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request) => {
      const actor = actorOf(request);
      const body = z.object({ body: bodySchema }).strict().parse(request.body);
      const entry = await prisma.supportCase.findFirst({
        where: { id: request.params.id, category: SUPPORT_CHAT_CATEGORY },
        select: { id: true, firstRespondedAt: true },
      });
      if (!entry) throw ApiError.notFound();

      const message = await prisma.$transaction(async (tx) => {
        await tx.supportCase.update({
          where: { id: entry.id },
          data: { status: 'open', resolvedAt: null, ...(entry.firstRespondedAt ? {} : { firstRespondedAt: new Date() }) },
        });
        return tx.supportAction.create({
          data: { caseId: entry.id, actorId: actor.identityId, kind: 'reply', body: body.body },
          select: { id: true, body: true, readAt: true, createdAt: true },
        });
      });

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'support.chat.replied',
        resourceType: 'support_case',
        resourceId: entry.id,
        // The length, not the words: the conversation itself is the record.
        after: { messageId: message.id, length: body.body.length },
        ipAddress: request.ip,
        requestId: request.id,
      });

      return { message: { id: message.id, from: 'staff' as const, body: message.body ?? '', readAt: message.readAt, createdAt: message.createdAt } };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/admin/support/conversations/:id/status — resolve or reopen
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/admin/support/conversations/:id/status',
    { preHandler: requirePermission('support:case:write') },
    async (request) => {
      const actor = actorOf(request);
      const body = z.object({ status: z.enum(['open', 'resolved']) }).strict().parse(request.body);
      const entry = await prisma.supportCase.findFirst({
        where: { id: request.params.id, category: SUPPORT_CHAT_CATEGORY },
        select: { id: true, status: true },
      });
      if (!entry) throw ApiError.notFound();

      await prisma.supportCase.update({
        where: { id: entry.id },
        data: { status: body.status, resolvedAt: body.status === 'resolved' ? new Date() : null },
      });
      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'support.chat.status_changed',
        resourceType: 'support_case',
        resourceId: entry.id,
        before: { status: entry.status },
        after: { status: body.status },
        ipAddress: request.ip,
        requestId: request.id,
      });
      return { status: body.status };
    },
  );

  /** Who each conversation belongs to: name, contact, role and account state. */
  async function accountsFor(cases: ReadonlyArray<{ id: string; customerId: string | null; riderId: string | null }>) {
    const customerIds = cases.flatMap((entry) => (entry.customerId ? [entry.customerId] : []));
    const riderIds = cases.flatMap((entry) => (entry.riderId ? [entry.riderId] : []));
    const [customers, riders] = await Promise.all([
      prisma.customer.findMany({
        where: { id: { in: customerIds } },
        select: { id: true, identity: { select: { id: true, displayName: true, email: true, phone: true, status: true } } },
      }),
      prisma.rider.findMany({
        where: { id: { in: riderIds } },
        select: { id: true, status: true, identity: { select: { id: true, displayName: true, email: true, phone: true, status: true } } },
      }),
    ]);
    const customerById = new Map(customers.map((row) => [row.id, row]));
    const riderById = new Map(riders.map((row) => [row.id, row]));

    const out = new Map<
      string,
      { role: Audience; identityId: string; profileId: string; name: string | null; email: string | null; phone: string | null; accountStatus: string; riderStatus: string | null }
    >();
    for (const entry of cases) {
      if (entry.riderId) {
        const rider = riderById.get(entry.riderId);
        if (rider) {
          out.set(entry.id, {
            role: 'rider',
            identityId: rider.identity.id,
            profileId: rider.id,
            name: rider.identity.displayName,
            email: rider.identity.email,
            phone: rider.identity.phone,
            accountStatus: rider.identity.status,
            riderStatus: rider.status,
          });
        }
      } else if (entry.customerId) {
        const customer = customerById.get(entry.customerId);
        if (customer) {
          out.set(entry.id, {
            role: 'customer',
            identityId: customer.identity.id,
            profileId: customer.id,
            name: customer.identity.displayName,
            email: customer.identity.email,
            phone: customer.identity.phone,
            accountStatus: customer.identity.status,
            riderStatus: null,
          });
        }
      }
    }
    return out;
  }
}
