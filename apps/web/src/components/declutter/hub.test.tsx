// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { SellerItemWorkspace } from './SellerHub';
import { HubChat, HubInbox } from './HubChat';
import { OpsItemWorkspace } from './OpsHub';
import { hubFixture } from './hub-fixture';
const state = vi.hoisted(() => ({ session: 'authenticated', fetch: vi.fn() }));
vi.mock('@/lib/session', () => ({
  useSessionState: () => state.session,
  useMe: () => ({ me: null }),
  usePermissions: () => ({
    loaded: true,
    permissions: new Set([
      'declutter:submission:read',
      'declutter:submission:write',
      'declutter:pricing:decide',
      'declutter:pricing:authorize',
      'declutter:listing:publish',
    ]),
  }),
  authedFetch: state.fetch,
  signOut: vi.fn(),
}));
beforeEach(() => {
  state.session = 'authenticated';
  state.fetch.mockReset();
});
afterEach(cleanup);
function itemFetch(item = hubFixture()) {
  state.fetch.mockImplementation(async (url: string) =>
    url.endsWith('/valuecheck')
      ? {
          submission: {
            ...item,
            attributes: {},
            seller: {
              displayName: 'Ada',
              kycStatus: 'verified',
              sellerType: 'individual',
            },
            photoCount: 1,
            openFraudFlags: 0,
            escalationReasons: [],
            submittedPriceConsentAt: null,
            submittedPriceConsentKobo: null,
          },
          comparables: [],
          valuation: null,
          decisions: [],
        }
      : url.includes('/conversations/')
        ? {
            conversation: {
              id: 'chat-1',
              status: 'open',
              submissionId: item.id,
            },
            messages: [],
          }
        : { item, sellerId: 'seller-1', fraudFlags: [] },
  );
}
it('keeps a private item page signed out and returns sign-in to that exact item', () => {
  state.session = 'unauthenticated';
  render(<SellerItemWorkspace submissionId="private-item" />);
  expect(
    screen.getByRole('link', { name: 'Sign in' }).getAttribute('href'),
  ).toBe(
    '/declutter/signin?next=%2Fdeclutter%2Faccount%2Fitems%2Fprivate-item',
  );
  expect(state.fetch).not.toHaveBeenCalled();
  expect(screen.queryByText('Reading chair')).toBeNull();
});
it.each(['accept', 'decline'])(
  'renders both prices and sends the current price for %s',
  async (response) => {
    itemFetch();
    render(<SellerItemWorkspace submissionId="item-1" />);
    await screen.findByRole('heading', { name: 'Your price decision' });
    expect(screen.getByText(/₦15,000/)).toBeTruthy();
    expect(screen.getAllByText(/₦10,000/).length).toBeGreaterThan(0);
    fireEvent.click(
      screen.getByRole('button', {
        name: response === 'accept' ? /Accept ₦10,000/ : 'Decline',
      }),
    );
    await waitFor(() =>
      expect(state.fetch).toHaveBeenCalledWith(
        '/v1/declutter/submissions/item-1/price-response',
        expect.objectContaining({
          body: expect.objectContaining({ response, priceKobo: 1_000_000 }),
        }),
      ),
    );
    expect(
      screen
        .getByRole('link', { name: 'Chat with DASH about this price' })
        .getAttribute('href'),
    ).toBe('#chat');
  },
);
it('shows accepted exact-price consent without another accept/decline prompt and never renders private fields', async () => {
  const item = {
    ...hubFixture({
      preConsented: true,
      priceAcceptanceValid: true,
      valueCheckStatus: 'seller_accepted',
      actions: [],
    }),
    adminNotes: 'PRIVATE-NOTE',
    seller: {
      name: 'Ada',
      kycStatus: 'verified',
      address: 'PRIVATE-ADDRESS',
      nationalId: 'PRIVATE-ID',
    },
  };
  itemFetch(item);
  const { container } = render(<SellerItemWorkspace submissionId="item-1" />);
  await screen.findByText(/exact-price pre-consent was honoured/);
  expect(screen.queryByRole('button', { name: /Accept ₦/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
  expect(container.textContent).not.toContain('PRIVATE-');
  expect(container.querySelector('[class*="lg:grid-cols-2"]')).toBeTruthy();
});
it('replaces selected photos through a proposed update and submits only after uploading', async () => {
  const item = hubFixture();
  itemFetch(item);
  state.fetch.mockImplementation(async (url: string) =>
    url.endsWith('/updates') ? { updateId: 'update-1' } : { item },
  );
  render(<SellerItemWorkspace submissionId="item-1" />);
  await screen.findByRole('heading', { name: 'Improve your item' });
  fireEvent.click(screen.getByRole('button', { name: 'Update photos & details' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Keep photo 1/ }));
  fireEvent.change(screen.getByLabelText('New / replacement photos'), {
    target: {
      files: [new File(['photo'], 'daylight.png', { type: 'image/png' })],
    },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Submit changes for review' }),
  );
  await screen.findByText(
    /Your changes were submitted and are awaiting DASH review/,
  );
  const urls = state.fetch.mock.calls.map(([u]) => u);
  expect(urls.indexOf('/v1/declutter/updates/update-1/photos')).toBeLessThan(
    urls.indexOf('/v1/declutter/updates/update-1/submit'),
  );
  const draft = state.fetch.mock.calls.find(
    ([u]) => u === '/v1/declutter/account/items/item-1/updates',
  )!;
  expect(draft[1].body.keepPhotoIds).toEqual([]);
  expect(draft[1].body.title).toBe('Reading chair');
});
it('keeps failed chat text and reuses the same idempotency key on retry', async () => {
  let failed = false;
  state.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/messages') && !failed) {
      failed = true;
      throw new Error('Temporary connection error');
    }
    return {
      conversation: { id: 'chat-1', status: 'open', submissionId: 'item-1' },
      messages: [],
    };
  });
  render(<HubChat conversationId="chat-1" />);
  fireEvent.change(screen.getByLabelText('Message'), {
    target: { value: 'Please explain the price.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await screen.findByText(/Your message is kept below/);
  fireEvent.click(screen.getByRole('button', { name: 'Retry send' }));
  await waitFor(() =>
    expect(
      (screen.getByLabelText('Message') as HTMLTextAreaElement).value,
    ).toBe(''),
  );
  const sends = state.fetch.mock.calls.filter(([u]) => u.endsWith('/messages'));
  expect(sends).toHaveLength(2);
  expect(sends[0]![1].body.clientMessageId).toBe(
    sends[1]![1].body.clientMessageId,
  );
  expect(sends[1]![1].body.senderType).toBeUndefined();
});
it('links the staff inbox to the exact item and supports pricing/unread filters', async () => {
  state.fetch.mockResolvedValue({
    conversations: [
      {
        id: 'chat-1',
        status: 'open',
        sellerName: 'Ada Seller',
        submissionId: 'item-1',
        title: 'Reading chair',
        code: 'DCL-001',
        workflowStatus: 'Price decision required',
        priceState: 'seller_acceptance_pending',
        lastMessage: 'Why was it changed?',
        updatedAt: '2026-10-11',
        unreadCount: 1,
      },
    ],
  });
  render(<HubInbox staff />);
  await screen.findByText('Why was it changed?');
  fireEvent.click(screen.getByRole('button', { name: 'Pricing' }));
  expect(screen.getByText('Why was it changed?')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Ada Seller/ }));
  expect(
    screen.getByRole('link', { name: 'Manage item' }).getAttribute('href'),
  ).toBe('/ops/declutter/items/item-1');
});
it('wires Approve & Publish to the protected backend action and shows real blockers', async () => {
  itemFetch();
  render(<OpsItemWorkspace submissionId="item-1" />);
  await screen.findByText('Seller price decision is required');
  expect(screen.getByRole('button', { name: 'Approve & Publish' })).toBeTruthy();
  const fetchExisting = state.fetch.getMockImplementation()!;
  state.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/approve-publish'))
      throw new Error('Mandatory item checks are still outstanding.');
    return fetchExisting(url);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Approve & Publish' }));
  await screen.findByText('Mandatory item checks are still outstanding.');
  expect(state.fetch).toHaveBeenCalledWith(
    '/v1/admin/declutter/submissions/item-1/approve-publish',
    { method: 'POST', body: {} },
  );
});

it('keeps the pending DASH proposal distinct from the ValueCheck recommendation when Super Admin authorises', async () => {
  const item = hubFixture();
  state.fetch.mockImplementation(
    async (url: string, _options?: { method?: string }) => {
      if (url.endsWith('/valuecheck'))
        return {
          ...{ comparables: [], decisions: [] },
          submission: {
            ...item,
            valueCheckStatus: 'super_admin_approval_pending',
            proposedPriceKobo: 1_000_000,
            attributes: {},
            seller: {
              displayName: 'Ada',
              kycStatus: 'verified',
              sellerType: 'individual',
            },
            photoCount: 1,
            openFraudFlags: 0,
            escalationReasons: [],
          },
          valuation: {
            recommendedPriceKobo: 1_500_000,
            warnings: [],
            factors: [],
            confidenceBasisPoints: 8000,
          },
        };
      return { item, sellerId: 'seller-1', fraudFlags: [] };
    },
  );
  render(<OpsItemWorkspace submissionId="item-1" />);
  await screen.findByRole('button', { name: 'Authorise' });
  expect((screen.getByLabelText('Price (₦)') as HTMLInputElement).value).toBe(
    '10000',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Authorise' }));
  await waitFor(() =>
    expect(state.fetch).toHaveBeenCalledWith(
      '/v1/admin/declutter/submissions/item-1/authorize',
      { method: 'POST', body: { kind: 'approved' } },
    ),
  );
});

it('resolves signed API photo paths through the existing Declutters image helper', async () => {
  const item = hubFixture();
  item.photos[0]!.url = '/v1/files/real-photo?signature=test';
  itemFetch(item);
  render(<SellerItemWorkspace submissionId="item-1" />);
  const photo = await screen.findByAltText('Reading chair — main photo');
  expect(photo.getAttribute('src')).toBe(
    'https://api.dashworldng.com/v1/files/real-photo?signature=test',
  );
});
