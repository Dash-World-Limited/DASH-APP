import { afterAll, beforeAll, expect, it } from 'vitest';
import { seedDeclutterTaxonomy } from '@dash/db';
import type { EmailPort } from '@dash/domain/ports';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, type Actor, type World } from './world.js';
import { deliverHubNotifications } from '../declutter/hub.js';
import { useIntegrationTimeouts } from './timeouts.js';
useIntegrationTimeouts();
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let context: TestContext;
let world: World;
let seller: Actor;
let stranger: Actor;
let admin: Actor;
let staff: Actor;
let sellerId: string;
const sent: Parameters<EmailPort['send']>[0][] = [];
let failDelivery = false;
const email: EmailPort = {
  providerName: 'capture',
  isLive: false,
  async send(m) {
    if (failDelivery) throw new Error('Unavailable');
    sent.push(m);
    return { accepted: true, providerMessageId: `hub-${sent.length}` };
  },
};
beforeAll(async () => {
  context = await createTestContext({}, { email });
  world = await buildWorld(context.prisma);
  await seedDeclutterTaxonomy(context.prisma);
  await context.prisma.identityRole.create({
    data: { identityId: world.support.identityId, role: 'declutter_admin' },
  });
  seller = await actAs(context, world.customerA.email);
  stranger = await actAs(context, world.customerB.email);
  admin = await actAs(context, world.admin.email);
  staff = await actAs(context, world.support.email);
  sellerId = (
    await context.prisma.declutterSeller.create({
      data: {
        customerId: world.customerA.customerId,
        displayName: 'Ada <Seller>',
        kycStatus: 'verified',
        verifiedAt: new Date(),
        socialHandle: 'PRIVATE-HANDLE',
        addressLine: 'PRIVATE-ADDRESS',
        adminNotes: 'PRIVATE-NOTES',
      },
    })
  ).id;
  await elevate();
}, 180_000);
afterAll(async () => {
  await context?.close();
});
async function elevate(value: Date | null = new Date()) {
  await context.prisma.session.updateMany({
    where: { identityId: world.admin.identityId, revokedAt: null },
    data: { steppedUpAt: value },
  });
}
async function post(
  actor: Actor | null,
  url: string,
  payload: Record<string, unknown> = {},
  expected = 200,
) {
  const r = await context.app.inject({
    method: 'POST',
    url,
    payload,
    ...(actor ? { headers: actor.headers } : {}),
  });
  expect(r.statusCode, `${url}: ${r.body}`).toBe(expected);
  return r.json();
}
async function get(actor: Actor | null, url: string, expected = 200) {
  const r = await context.app.inject({
    method: 'GET',
    url,
    ...(actor ? { headers: actor.headers } : {}),
  });
  expect(r.statusCode, `${url}: ${r.body}`).toBe(expected);
  return r.json();
}
async function submit(consent = false) {
  const tax = await get(null, '/v1/declutter/taxonomy');
  const location =
    tax.locations.find((l: { slug: string }) => l.slug === 'lagos-lekki') ??
    tax.locations[0];
  const { submission } = await post(
    seller,
    '/v1/declutter/submissions',
    {
      title: 'Reading chair <script>bad()</script>',
      description: 'A sturdy chair with honest photographs.',
      categoryKey: 'home-furniture',
      condition: 'good',
      locationSlug: location.slug,
      expectedPriceKobo: 1_500_000,
      preAuthorizePrice: consent,
    },
    201,
  );
  await post(
    seller,
    `/v1/declutter/submissions/${submission.id}/photos`,
    { data: PNG, contentType: 'image/png', role: 'front' },
    201,
  );
  await post(seller, `/v1/declutter/submissions/${submission.id}/complete`);
  return submission.id as string;
}
async function checks(id: string) {
  await post(admin, `/v1/admin/declutter/submissions/${id}/checks`, {
    kind: 'safety',
    passed: true,
  });
  await post(admin, `/v1/admin/declutter/submissions/${id}/checks`, {
    kind: 'item',
    passed: true,
  });
}
async function authorize(id: string, price: number) {
  await post(admin, `/v1/admin/declutter/submissions/${id}/valuecheck`);
  await post(admin, `/v1/admin/declutter/submissions/${id}/pricing-decision`, {
    kind: 'approved',
    escalate: true,
  });
  const s = await context.prisma.declutterSubmission.findUniqueOrThrow({
    where: { id },
  });
  await post(
    admin,
    `/v1/admin/declutter/submissions/${id}/authorize`,
    s.finalPriceKobo === price
      ? { kind: 'approved' }
      : {
          kind: 'adjusted',
          priceKobo: price,
          reason: 'Human review of the item condition and market evidence.',
        },
  );
}
let journeyId: string;
let liveListingId: string;
it('proves submission → dashboard → recorded checks → changed-price email → chat → seller acceptance → Fully Approved → live', async () => {
  journeyId = await submit();
  const id = journeyId;
  const dashboard = await get(seller, '/v1/declutter/hub');
  expect(dashboard.items.some((i: { id: string }) => i.id === id)).toBe(true);
  const before = await context.prisma.declutterSubmission.findUniqueOrThrow({
    where: { id },
  });
  const detail = await get(seller, `/v1/declutter/account/items/${id}`);
  expect(detail.item.progress[0].state).toBe('completed');
  expect(JSON.stringify(detail)).not.toContain('PRIVATE-');
  await get(admin, `/v1/admin/declutter/submissions/${id}/workspace`);
  await get(admin, `/v1/admin/declutter/submissions/${id}/valuecheck`);
  const after = await context.prisma.declutterSubmission.findUniqueOrThrow({
    where: { id },
  });
  expect(after.status).toBe(before.status);
  expect(after.updatedAt).toEqual(before.updatedAt);
  await checks(id);
  expect(
    (
      await context.prisma.declutterSubmission.findUniqueOrThrow({
        where: { id },
      })
    ).status,
  ).toBe('valuation_pending');
  await authorize(id, 1_000_000);
  const priceMail = sent.find((m) => m.reference === `price:${id}:1`);
  expect(priceMail?.html).toContain(`/declutter/account/items/${id}`);
  expect(priceMail?.html).toContain('Review &amp; approve price');
  expect(priceMail?.html).toContain('15,000');
  expect(priceMail?.html).toContain('10,000');
  expect(priceMail?.html).toContain('&lt;script&gt;');
  expect(priceMail?.html).not.toContain('<script>bad');
  await deliverHubNotifications(context.app);
  expect(sent.filter((m) => m.reference === `price:${id}:1`)).toHaveLength(1);
  const offer = (await get(seller, `/v1/declutter/account/items/${id}`)).item;
  expect(offer.expectedPriceKobo).toBe(1_500_000);
  expect(offer.authorizedPriceKobo).toBe(1_000_000);
  expect(offer.actions[0].label).toBe('Price decision required');
  await post(
    admin,
    `/v1/admin/declutter/submissions/${id}/fully-approve`,
    {},
    422,
  );
  const { conversationId } = await post(
    seller,
    '/v1/declutter/conversations',
    { submissionId: id },
    201,
  );
  await post(seller, `/v1/declutter/conversations/${conversationId}/messages`, {
    body: 'Why was the price changed?',
    clientMessageId: 'seller-question-001',
  });
  const inbox = await get(admin, '/v1/admin/declutter/conversations');
  expect(
    inbox.conversations.find((c: { id: string }) => c.id === conversationId)
      .unreadCount,
  ).toBe(1);
  await post(admin, `/v1/admin/declutter/conversations/${conversationId}/read`);
  const reply = await post(
    admin,
    `/v1/admin/declutter/conversations/${conversationId}/messages`,
    {
      body: 'We reviewed the condition <script>unsafe</script>. Happy to help.',
      clientMessageId: 'admin-reply-001',
    },
  );
  await post(
    admin,
    `/v1/admin/declutter/conversations/${conversationId}/messages`,
    {
      body: 'We reviewed the condition <script>unsafe</script>. Happy to help.',
      clientMessageId: 'admin-reply-001',
    },
  );
  expect(
    sent.filter((m) => m.reference === `message:${reply.messageId}`),
  ).toHaveLength(1);
  expect(
    sent.find((m) => m.reference === `message:${reply.messageId}`)?.html,
  ).not.toContain('<script>unsafe');
  expect((await get(seller, '/v1/declutter/unread-count')).unreadCount).toBe(1);
  const messages = await get(
    seller,
    `/v1/declutter/conversations/${conversationId}`,
  );
  expect(messages.messages).toHaveLength(2);
  expect(messages.messages[1].senderType).toBe('staff');
  await post(seller, `/v1/declutter/conversations/${conversationId}/read`);
  expect((await get(seller, '/v1/declutter/unread-count')).unreadCount).toBe(0);
  await post(seller, `/v1/declutter/submissions/${id}/price-response`, {
    response: 'accept',
    priceKobo: 1_000_000,
  });
  expect(
    (await get(seller, `/v1/declutter/account/items/${id}`)).item.blockers,
  ).toEqual([]);
  await elevate(null);
  await post(
    admin,
    `/v1/admin/declutter/submissions/${id}/fully-approve`,
    {},
    403,
  );
  await elevate();
  await post(
    staff,
    `/v1/admin/declutter/submissions/${id}/fully-approve`,
    {},
    403,
  );
  await post(admin, `/v1/admin/declutter/submissions/${id}/fully-approve`);
  const published = await post(
    admin,
    `/v1/admin/declutter/submissions/${id}/publish`,
    {},
    201,
  );
  liveListingId = published.listing.id;
  const live = (await get(seller, `/v1/declutter/account/items/${id}`)).item;
  expect(live.status).toBe('Live');
  expect(live.progress.at(-1).state).toBe('completed');
  expect(live.listing.slug).toBe(published.listing.slug);
  await get(null, `/v1/declutter/listings/${published.listing.slug}`);
});
it('proves replacement photos remain proposed until an authorised update approval applies them to the existing live listing', async () => {
  const old = await context.prisma.declutterListing.findUniqueOrThrow({
    where: { id: liveListingId },
    include: { photos: true },
  });
  const { updateId } = await post(
    seller,
    `/v1/declutter/account/items/${journeyId}/updates`,
    {
      title: 'Better reading chair',
      description: 'The same chair photographed in daylight.',
      condition: 'good',
      keepPhotoIds: [],
    },
    201,
  );
  const newPNG = Buffer.concat([
    Buffer.from(PNG, 'base64'),
    Buffer.from('daylight'),
  ]).toString('base64');
  await post(
    seller,
    `/v1/declutter/updates/${updateId}/photos`,
    { data: newPNG, contentType: 'image/png', role: 'front' },
    201,
  );
  await post(seller, `/v1/declutter/updates/${updateId}/submit`);
  await post(seller, `/v1/declutter/updates/${updateId}/submit`);
  expect(
    (
      await context.prisma.declutterListing.findUniqueOrThrow({
        where: { id: liveListingId },
        include: { photos: true },
      })
    ).photos[0]!.storageKey,
  ).toBe(old.photos[0]!.storageKey);
  const workspace = await get(
    admin,
    `/v1/admin/declutter/submissions/${journeyId}/workspace`,
  );
  expect(workspace.item.updates[0].status).toBe('pending');
  expect(workspace.item.title).toBe(old.title);
  await post(
    admin,
    `/v1/admin/declutter/submissions/${journeyId}/fully-approve`,
    {},
    422,
  );
  await post(
    staff,
    `/v1/admin/declutter/updates/${updateId}/review`,
    { decision: 'approved' },
    403,
  );
  await post(admin, `/v1/admin/declutter/updates/${updateId}/review`, {
    decision: 'approved',
  });
  await post(admin, `/v1/admin/declutter/updates/${updateId}/review`, {
    decision: 'approved',
  });
  const updated = await context.prisma.declutterListing.findUniqueOrThrow({
    where: { id: liveListingId },
    include: { photos: true },
  });
  expect(updated.title).toBe('Better reading chair');
  expect(updated.priceKobo).toBe(old.priceKobo);
  expect(updated.photos[0]!.storageKey).not.toBe(old.photos[0]!.storageKey);
  expect(updated.revision).toBe(2);
  const item = (await get(seller, `/v1/declutter/account/items/${journeyId}`))
    .item;
  expect(item.updates[0].status).toBe('approved');
  expect(
    item.history.some(
      (e: { label: string }) => e.label === 'Item update approved',
    ),
  ).toBe(true);
});
it.each(['rejected', 'changes_requested'])(
  'keeps approved content when an update is %s and allows another update',
  async (decision) => {
    const item = (await get(seller, `/v1/declutter/account/items/${journeyId}`))
      .item;
    const { updateId } = await post(
      seller,
      `/v1/declutter/account/items/${journeyId}/updates`,
      {
        title: 'Proposed title',
        description: 'Proposed descriptive details.',
        condition: 'fair',
        keepPhotoIds: item.photos.map((p: { id: string }) => p.id),
      },
      201,
    );
    await post(seller, `/v1/declutter/updates/${updateId}/submit`);
    await post(admin, `/v1/admin/declutter/updates/${updateId}/review`, {
      decision,
      sellerMessage: 'Please use clearer, accurate item details.',
    });
    expect(
      (await get(seller, `/v1/declutter/account/items/${journeyId}`)).item
        .title,
    ).toBe(item.title);
  },
);
it.each([true, false])(
  'proves exact price with consent %s, including email suppression and tracker completion',
  async (consent) => {
    const id = await submit(consent);
    await checks(id);
    await authorize(id, 1_500_000);
    const item = (await get(seller, `/v1/declutter/account/items/${id}`)).item;
    expect(item.priceAcceptanceValid).toBe(consent);
    expect(
      item.progress.find((p: { key: string }) => p.key === 'seller_price')
        .state,
    ).toBe(consent ? 'completed' : 'action_required');
    expect(sent.filter((m) => m.reference === `price:${id}:1`)).toHaveLength(
      consent ? 0 : 1,
    );
    if (consent) {
      await post(admin, `/v1/admin/declutter/submissions/${id}/fully-approve`);
      await post(
        admin,
        `/v1/admin/declutter/submissions/${id}/publish`,
        {},
        201,
      );
    } else {
      await post(
        admin,
        `/v1/admin/declutter/submissions/${id}/fully-approve`,
        {},
        422,
      );
      await post(seller, `/v1/declutter/submissions/${id}/price-response`, {
        response: 'decline',
        priceKobo: 1_500_000,
      });
      const declined = (await get(seller, `/v1/declutter/account/items/${id}`))
        .item;
      expect(declined.status).toBe('Price declined');
      expect(declined.next).toContain('Chat with DASH');
      await post(
        admin,
        `/v1/admin/declutter/submissions/${id}/publish`,
        {},
        422,
      );
    }
  },
);
it('does not email an actively viewed chat, supports shared staff read state, and reopens resolved chats', async () => {
  const { conversationId } = await post(
    seller,
    '/v1/declutter/conversations',
    { submissionId: journeyId },
    201,
  );
  await post(
    admin,
    `/v1/admin/declutter/conversations/${conversationId}/status`,
    { status: 'resolved' },
  );
  await post(seller, `/v1/declutter/conversations/${conversationId}/messages`, {
    body: 'I need help again',
    clientMessageId: 'reopen-001',
  });
  expect(
    (await get(admin, `/v1/admin/declutter/conversations/${conversationId}`))
      .conversation.status,
  ).toBe('open');
  await post(seller, `/v1/declutter/conversations/${conversationId}/read`);
  const message = await post(
    staff,
    `/v1/admin/declutter/conversations/${conversationId}/messages`,
    { body: 'We can help.', clientMessageId: 'active-reply-001' },
  );
  expect(
    sent.filter((m) => m.reference === `message:${message.messageId}`),
  ).toHaveLength(0);
  expect(
    (
      await get(seller, `/v1/declutter/conversations/${conversationId}`)
    ).messages.some((m: { id: string }) => m.id === message.messageId),
  ).toBe(true);
});
it('keeps a failed email intent for retry and deduplicates successful delivery', async () => {
  failDelivery = true;
  const id = await submit();
  await checks(id);
  await authorize(id, 1_000_000);
  const n = await context.prisma.declutterHubNotification.findUniqueOrThrow({
    where: { eventKey: `price:${id}:1` },
  });
  expect(n.deliveredAt).toBeNull();
  failDelivery = false;
  await deliverHubNotifications(context.app);
  await deliverHubNotifications(context.app);
  expect(sent.filter((m) => m.reference === `price:${id}:1`)).toHaveLength(1);
});
it('cannot spoof an admin sender or reference another seller’s item', async () => {
  const { conversationId } = await post(
    seller,
    '/v1/declutter/conversations',
    { submissionId: journeyId },
    201,
  );
  await post(
    seller,
    `/v1/declutter/conversations/${conversationId}/messages`,
    {
      body: 'Spoof',
      clientMessageId: 'spoof-001',
      senderType: 'staff',
      senderIdentityId: world.admin.identityId,
    },
    400,
  );
  await post(
    stranger,
    '/v1/declutter/conversations',
    { submissionId: journeyId },
    404,
  );
});
it.each(['item', 'chat', 'updates', 'photos', 'submit', 'read', 'messages'])(
  'blocks another seller and signed-out access to %s',
  async (kind) => {
    const item = (await get(seller, `/v1/declutter/account/items/${journeyId}`))
      .item;
    const { conversationId } = await post(
      seller,
      '/v1/declutter/conversations',
      { submissionId: journeyId },
      201,
    );
    const { updateId } = await post(
      seller,
      `/v1/declutter/account/items/${journeyId}/updates`,
      {
        title: 'Secure update',
        description: 'Only the owner can propose this.',
        condition: 'good',
      },
      201,
    ).catch(async () => ({
      updateId: (
        await context.prisma.declutterSubmissionUpdate.findFirstOrThrow({
          where: { activeKey: journeyId },
        })
      ).id,
    }));
    const url =
      kind === 'item'
        ? `/v1/declutter/account/items/${journeyId}`
        : kind === 'chat'
          ? `/v1/declutter/conversations/${conversationId}`
          : kind === 'updates'
            ? `/v1/declutter/account/items/${journeyId}/updates`
            : ['photos', 'submit'].includes(kind)
              ? `/v1/declutter/updates/${updateId}/${kind}`
              : `/v1/declutter/conversations/${conversationId}/${kind}`;
    const read = ['item', 'chat'].includes(kind);
    for (const [actor, status] of [
      [stranger, 404],
      [null, 401],
    ] as const) {
      if (read) await get(actor, url, status);
      else
        await post(
          actor,
          url,
          kind === 'updates'
            ? {
                title: 'No access',
                description: 'Not your item update.',
                condition: 'good',
                keepPhotoIds: item.photos.map((p: { id: string }) => p.id),
              }
            : kind === 'messages'
              ? { body: 'Not yours', clientMessageId: 'not-yours-001' }
              : {},
          status,
        );
    }
  },
);
it.each([
  'safety',
  'item',
  'valuation',
  'verification',
  'fraud',
  'partner',
  'acceptance',
])('Fully Approved preserves the %s gate', async (gate) => {
  const id = await submit(true);
  await checks(id);
  await authorize(id, 1_500_000);
  if (gate === 'safety')
    await context.prisma.declutterSubmission.update({
      where: { id },
      data: { safetyReviewedAt: null },
    });
  if (gate === 'item')
    await context.prisma.declutterSubmission.update({
      where: { id },
      data: { itemReviewedAt: null },
    });
  if (gate === 'valuation')
    await context.prisma.declutterValuation.deleteMany({
      where: { submissionId: id },
    });
  if (gate === 'verification')
    await context.prisma.declutterSeller.update({
      where: { id: sellerId },
      data: { kycStatus: 'pending' },
    });
  if (gate === 'fraud')
    await context.prisma.declutterFraudFlag.create({
      data: {
        submissionId: id,
        kind: 'identity_mismatch',
        severity: 'high',
        detail: 'Test blocker',
      },
    });
  if (gate === 'partner')
    await context.prisma.declutterSubmission.update({
      where: { id },
      data: { partnerApprovalRequired: true },
    });
  if (gate === 'acceptance')
    await context.prisma.declutterSubmission.update({
      where: { id },
      data: { sellerAcceptedVersion: 0 },
    });
  await post(
    admin,
    `/v1/admin/declutter/submissions/${id}/fully-approve`,
    {},
    422,
  );
  await post(admin, `/v1/admin/declutter/submissions/${id}/publish`, {}, 422);
  if (gate === 'verification')
    await context.prisma.declutterSeller.update({
      where: { id: sellerId },
      data: { kycStatus: 'verified' },
    });
});
it('loads newest messages first without losing access to older conversation history', async () => {
  const { conversationId } = await post(
    seller,
    '/v1/declutter/conversations',
    {},
    201,
  );
  await context.prisma.declutterMessage.createMany({
    data: Array.from({ length: 105 }, (_, index) => ({
      id: `history-${String(index).padStart(3, '0')}`,
      conversationId,
      senderIdentityId: world.customerA.identityId,
      senderType: 'seller',
      body: `History ${index}`,
      clientMessageId: `history-${index}`,
      createdAt: new Date(1700000000000 + index * 1000),
    })),
  });
  const recent = await get(
    seller,
    `/v1/declutter/conversations/${conversationId}`,
  );
  expect(recent.messages).toHaveLength(100);
  expect(recent.messages.at(-1).body).toBe('History 104');
  expect(recent.messages[0].body).toBe('History 5');
  const older = await get(
    seller,
    `/v1/declutter/conversations/${conversationId}?before=${recent.nextCursor}`,
  );
  expect(older.messages).toHaveLength(5);
  expect(older.messages[0].body).toBe('History 0');
  expect(older.nextCursor).toBeNull();
  await get(
    stranger,
    `/v1/declutter/conversations/${conversationId}?before=${recent.nextCursor}`,
    404,
  );
});

it('does not let the legacy transition dropdown manufacture approval without the protected gates', async () => {
  const id = await submit();
  await checks(id);
  await authorize(id, 1_000_000);
  await post(
    admin,
    `/v1/admin/declutter/submissions/${id}/transition`,
    { to: 'approved' },
    403,
  );
  expect(
    (await context.prisma.declutterSubmission.findUniqueOrThrow({ where: { id } })).fullyApprovedAt,
  ).toBeNull();
});
