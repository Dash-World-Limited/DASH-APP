/**
 * Order-scoped customer ↔ rider chat.
 *
 * Participants are never accepted from the client. The order is the source of
 * truth: its customer and currently assigned rider are the only identities
 * allowed to read or send messages. A wrong order id and an out-of-scope order
 * both look like 404s, so the endpoint cannot be used to enumerate conversations.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../http/errors.js';
import { actorOf, requireAuth } from '../http/context.js';

const messageSchema = z.object({
  body: z.string().trim().min(1, 'Write a message first.').max(1000, 'Keep messages under 1000 characters.'),
});

const CLOSED_STATUSES = new Set(['delivered', 'cancelled', 'rejected', 'refunded']);

async function participantFor(request: FastifyRequest, orderId: string) {
  const actor = actorOf(request);
  const order = await request.services.prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, customerId: true, riderId: true, status: true },
  });
  if (!order) throw ApiError.notFound();

  // Chat starts only after dispatch has assigned a real rider. Never create a
  // conversation with an empty/synthetic rider id.
  if (!order.riderId) {
    throw ApiError.unprocessable('Chat becomes available when a rider is assigned.');
  }

  if (actor.customerId === order.customerId) {
    return { actor, order, role: 'customer' as const };
  }
  if (actor.riderId === order.riderId) {
    return { actor, order, role: 'rider' as const };
  }

  throw ApiError.notFound();
}

export async function registerChatRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app.services;

  app.get<{ Params: { orderId: string } }>(
    '/v1/orders/:orderId/chat',
    { preHandler: requireAuth },
    async (request) => {
      const { orderId } = request.params;
      const { actor, order } = await participantFor(request, orderId);

      const conversation = await prisma.orderConversation.findUnique({
        where: { orderId },
        select: {
          id: true,
          messages: {
            orderBy: { createdAt: 'asc' },
            take: 200,
            select: {
              id: true,
              senderIdentityId: true,
              senderRole: true,
              body: true,
              readAt: true,
              createdAt: true,
            },
          },
        },
      });

      if (!conversation) {
        return { orderId, canSend: !CLOSED_STATUSES.has(order.status), messages: [] };
      }

      // Opening the thread marks the other participant's messages as read.
      await prisma.chatMessage.updateMany({
        where: {
          conversationId: conversation.id,
          senderIdentityId: { not: actor.identityId },
          readAt: null,
        },
        data: { readAt: new Date() },
      });

      return {
        orderId,
        canSend: !CLOSED_STATUSES.has(order.status),
        messages: conversation.messages.map((message) => ({
          id: message.id,
          senderRole: message.senderRole,
          body: message.body,
          mine: message.senderIdentityId === actor.identityId,
          readAt: message.readAt,
          createdAt: message.createdAt,
        })),
      };
    },
  );

  app.post<{ Params: { orderId: string } }>(
    '/v1/orders/:orderId/chat/messages',
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { orderId } = request.params;
      const { actor, order, role } = await participantFor(request, orderId);
      if (CLOSED_STATUSES.has(order.status)) {
        throw ApiError.conflict('This delivery is complete. The conversation is now read-only.');
      }

      const body = messageSchema.parse(request.body);

      const conversation = await prisma.orderConversation.upsert({
        where: { orderId },
        update: {},
        create: { orderId },
        select: { id: true },
      });

      const message = await prisma.chatMessage.create({
        data: {
          conversationId: conversation.id,
          senderIdentityId: actor.identityId,
          senderRole: role,
          body: body.body,
        },
        select: {
          id: true,
          senderRole: true,
          body: true,
          readAt: true,
          createdAt: true,
        },
      });

      return reply.status(201).send({ ...message, mine: true });
    },
  );
}
