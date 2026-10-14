/**
 * In-app support chat between customers, riders and the DASH team.
 *
 * Each person sees only their own conversation, in the role they wrote as;
 * the team sees every conversation, who it belongs to and in what role, what
 * is unread, and can reply; every reply is audited; and nobody without a
 * support permission can open the team's inbox.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, type Actor, type World } from './world.js';

let context: TestContext;
let world: World;
let customerA: Actor;
let customerB: Actor;
let riderA: Actor;
let support: Actor;
let finance: Actor;
let admin: Actor;

beforeAll(async () => {
  context = await createTestContext({ SUPPORT_WHATSAPP_E164: '+2348000001234' });
  world = await buildWorld(context.prisma);
  customerA = await actAs(context, world.customerA.email);
  customerB = await actAs(context, world.customerB.email);
  riderA = await actAs(context, world.riderA.email);
  support = await actAs(context, world.support.email);
  finance = await actAs(context, world.finance.email);
  admin = await actAs(context, world.admin.email);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

const call = (actor: Actor | null, method: 'GET' | 'POST', url: string, payload?: object) =>
  context.app.inject({ method, url, ...(actor ? { headers: actor.headers } : {}), ...(payload ? { payload } : {}) });

const write = (actor: Actor, as: 'customer' | 'rider', body: string) => call(actor, 'POST', '/v1/support/chat/messages', { as, body });

interface Inbox {
  conversations: Array<{
    id: string;
    audience: 'customer' | 'rider';
    unread: number;
    status: string;
    account: { role: string; name: string | null; email: string | null; identityId: string } | null;
    lastMessage: { from: string; preview: string } | null;
  }>;
  unreadTotal: number;
}

describe('support channels', () => {
  it('offers the configured official WhatsApp number to anyone', async () => {
    const response = await call(null, 'GET', '/v1/support/channels');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ whatsapp: '+2348000001234', chat: true });
  });
});

describe('a customer or rider writing to DASH', () => {
  it('starts with no conversation', async () => {
    expect((await call(customerA, 'GET', '/v1/support/chat?as=customer')).json()).toEqual({ conversation: null, messages: [] });
  });

  it('keeps a conversation per person and role', async () => {
    expect((await write(customerA, 'customer', 'Where is my order DASH-AB12CD?')).statusCode).toBe(200);
    expect((await write(customerA, 'customer', 'It was due an hour ago.')).statusCode).toBe(200);
    expect((await write(riderA, 'rider', 'The pickup code at Mama Put is not working.')).statusCode).toBe(200);
    expect((await write(customerB, 'customer', 'Can I change my delivery address?')).statusCode).toBe(200);

    const mine = (await call(customerA, 'GET', '/v1/support/chat?as=customer')).json<{ conversation: { code: string }; messages: Array<{ from: string; body: string }> }>();
    expect(mine.conversation.code).toMatch(/^SUP-/);
    expect(mine.messages.map((message) => [message.from, message.body])).toEqual([
      ['me', 'Where is my order DASH-AB12CD?'],
      ['me', 'It was due an hour ago.'],
    ]);

    const riderView = (await call(riderA, 'GET', '/v1/support/chat?as=rider')).json<{ messages: Array<{ body: string }> }>();
    expect(riderView.messages.map((message) => message.body)).toEqual(['The pickup code at Mama Put is not working.']);
    expect(JSON.stringify(riderView)).not.toContain('DASH-AB12CD');

    const other = (await call(customerB, 'GET', '/v1/support/chat?as=customer')).json<{ messages: Array<{ body: string }> }>();
    expect(JSON.stringify(other)).not.toContain('DASH-AB12CD');
  });

  it('is refused for a role the account does not have, and when signed out', async () => {
    expect((await call(customerA, 'GET', '/v1/support/chat?as=rider')).statusCode).toBe(403);
    expect((await write(customerA, 'rider', 'Pretending to be a rider')).statusCode).toBe(403);
    expect((await call(null, 'GET', '/v1/support/chat?as=customer')).statusCode).toBe(401);
    expect((await call(null, 'POST', '/v1/support/chat/messages', { as: 'customer', body: 'hi' })).statusCode).toBe(401);
  });

  it('refuses an empty, overlong or malformed message', async () => {
    for (const payload of [
      { as: 'customer', body: '   ' },
      { as: 'customer', body: 'x'.repeat(2_001) },
      { as: 'customer' },
      { as: 'staff', body: 'hello' },
      { as: 'customer', body: 'hello', caseId: 'someone-else' },
    ]) {
      expect((await call(customerA, 'POST', '/v1/support/chat/messages', payload)).statusCode).toBe(400);
    }
  });
});

describe('the DASH team’s inbox', () => {
  it('is closed to anyone without a support permission', async () => {
    for (const actor of [customerA, riderA, finance]) {
      expect((await call(actor, 'GET', '/v1/admin/support/conversations')).statusCode).toBe(403);
    }
    expect((await call(null, 'GET', '/v1/admin/support/conversations')).statusCode).toBe(401);
  });

  it('lists conversations with who they belong to, their role, and what is unread', async () => {
    const response = await call(support, 'GET', '/v1/admin/support/conversations');
    expect(response.statusCode).toBe(200);
    const inbox = response.json<Inbox>();
    expect(inbox.conversations).toHaveLength(3);
    expect(inbox.unreadTotal).toBe(4);

    const customer = inbox.conversations.find((entry) => entry.account?.email === world.customerA.email)!;
    expect(customer).toMatchObject({ audience: 'customer', unread: 2, status: 'open', account: { role: 'customer', identityId: world.customerA.identityId } });
    expect(customer.lastMessage).toMatchObject({ from: 'account', preview: 'It was due an hour ago.' });

    const rider = inbox.conversations.find((entry) => entry.audience === 'rider')!;
    expect(rider).toMatchObject({ unread: 1, account: { role: 'rider', email: world.riderA.email } });
  });

  it('filters customer and rider conversations apart', async () => {
    const riders = (await call(support, 'GET', '/v1/admin/support/conversations?audience=rider')).json<Inbox>();
    expect(riders.conversations.map((entry) => entry.audience)).toEqual(['rider']);
    const customers = (await call(support, 'GET', '/v1/admin/support/conversations?audience=customer')).json<Inbox>();
    expect(customers.conversations.every((entry) => entry.audience === 'customer')).toBe(true);
    expect(customers.conversations).toHaveLength(2);
  });

  it('marks a conversation read when the team opens it', async () => {
    const inbox = (await call(support, 'GET', '/v1/admin/support/conversations?audience=customer')).json<Inbox>();
    const id = inbox.conversations.find((entry) => entry.account?.email === world.customerA.email)!.id;
    const opened = await call(support, 'GET', `/v1/admin/support/conversations/${id}`);
    expect(opened.statusCode).toBe(200);
    const conversation = opened.json<{ conversation: { audience: string; account: { role: string } }; messages: Array<{ from: string; readAt: string | null }> }>();
    expect(conversation.conversation).toMatchObject({ audience: 'customer', account: { role: 'customer' } });
    expect(conversation.messages.every((message) => message.from === 'account' && message.readAt !== null)).toBe(true);

    const after = (await call(support, 'GET', '/v1/admin/support/conversations')).json<Inbox>();
    expect(after.conversations.find((entry) => entry.id === id)?.unread).toBe(0);
    expect(after.unreadTotal).toBe(2);
  });

  it('lets the team reply, audited, and the customer sees it as from DASH', async () => {
    const inbox = (await call(support, 'GET', '/v1/admin/support/conversations?audience=customer')).json<Inbox>();
    const id = inbox.conversations.find((entry) => entry.account?.email === world.customerA.email)!.id;

    const reply = await call(support, 'POST', `/v1/admin/support/conversations/${id}/messages`, { body: 'Sorry about that — your rider is 5 minutes away.' });
    expect(reply.statusCode).toBe(200);
    expect(await context.prisma.auditLog.count({ where: { action: 'support.chat.replied', resourceId: id } })).toBe(1);

    expect((await call(customerA, 'GET', '/v1/support/chat/unread?as=customer')).json()).toEqual({ unread: 1 });
    const seen = (await call(customerA, 'GET', '/v1/support/chat?as=customer')).json<{ messages: Array<{ from: string; body: string }> }>();
    expect(seen.messages.at(-1)).toMatchObject({ from: 'dash', body: 'Sorry about that — your rider is 5 minutes away.' });
    expect(JSON.stringify(seen)).not.toMatch(/staffName|actorId/);
    expect((await call(customerA, 'GET', '/v1/support/chat/unread?as=customer')).json()).toEqual({ unread: 0 });
  });

  it('lets a super admin answer from the web admin too', async () => {
    const inbox = (await call(admin, 'GET', '/v1/admin/support/conversations?audience=rider')).json<Inbox>();
    const id = inbox.conversations[0]!.id;
    expect((await call(admin, 'POST', `/v1/admin/support/conversations/${id}/messages`, { body: 'We have reset the code.' })).statusCode).toBe(200);
    const riderView = (await call(riderA, 'GET', '/v1/support/chat?as=rider')).json<{ messages: Array<{ from: string }> }>();
    expect(riderView.messages.map((message) => message.from)).toEqual(['me', 'dash']);
  });

  it('resolves, and reopens when the person writes again', async () => {
    const inbox = (await call(support, 'GET', '/v1/admin/support/conversations?audience=customer')).json<Inbox>();
    const id = inbox.conversations.find((entry) => entry.account?.email === world.customerB.email)!.id;
    expect((await call(support, 'POST', `/v1/admin/support/conversations/${id}/status`, { status: 'resolved' })).statusCode).toBe(200);
    expect((await call(support, 'GET', '/v1/admin/support/conversations?status=resolved')).json<Inbox>().conversations.map((entry) => entry.id)).toEqual([id]);

    await write(customerB, 'customer', 'One more thing…');
    const reopened = (await call(support, 'GET', `/v1/admin/support/conversations/${id}`)).json<{ conversation: { status: string } }>();
    expect(reopened.conversation.status).toBe('open');
    expect(await context.prisma.supportCase.count({ where: { category: 'in_app_chat', customerId: world.customerB.customerId } })).toBe(1);
  });

  it('refuses replies from staff who can only read, and anything outside chat cases', async () => {
    const inbox = (await call(support, 'GET', '/v1/admin/support/conversations')).json<Inbox>();
    const id = inbox.conversations[0]!.id;
    for (const actor of [finance, customerA, riderA]) {
      expect((await call(actor, 'POST', `/v1/admin/support/conversations/${id}/messages`, { body: 'hi' })).statusCode).toBe(403);
    }
    expect((await call(support, 'POST', `/v1/admin/support/conversations/${id}/messages`, { body: '' })).statusCode).toBe(400);
    expect((await call(support, 'GET', '/v1/admin/support/conversations/no-such-case')).statusCode).toBe(404);
  });
});
