// @vitest-environment jsdom
/**
 * The Super Admin support centre: the inbox with who each conversation
 * belongs to and what is unread, the Customer/Rider filter, opening and
 * replying, and the controls staff without the permissions never see. The
 * server authorises every call; these tests pin what the page asks for.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  fetch: vi.fn(),
  signedIn: true,
  permissions: new Set<string>(['support:case:read', 'support:case:write']),
}));

vi.mock('@/lib/session', () => ({
  authedFetch: state.fetch,
  useHasSession: () => state.signedIn,
  usePermissions: () => ({ loaded: true, permissions: state.permissions }),
}));

const stepUp = vi.hoisted(() => ({ run: async <T,>(action: () => Promise<T>) => action(), prompt: null }));
vi.mock('@/components/StepUpPrompt', () => ({ useStepUp: () => stepUp }));

const { SupportCentre } = await import('./SupportCentre');

const customer = {
  id: 'case_c',
  code: 'SUP-AAA111',
  status: 'open',
  audience: 'customer',
  account: { role: 'customer', identityId: 'identity_c', profileId: 'customer_c', name: 'Chioma Customer', email: 'chioma@example.com', phone: null, accountStatus: 'active', riderStatus: null },
  unread: 2,
  lastMessage: { from: 'account', preview: 'Where is my order?', createdAt: '2026-10-14T09:00:00.000Z' },
  createdAt: '2026-10-14T08:00:00.000Z',
  updatedAt: '2026-10-14T09:00:00.000Z',
};
const rider = {
  ...customer,
  id: 'case_r',
  code: 'SUP-BBB222',
  audience: 'rider',
  account: { role: 'rider', identityId: 'identity_r', profileId: 'rider_r', name: 'Rafiu Rider', email: 'rafiu@example.com', phone: '+2348000000002', accountStatus: 'active', riderStatus: 'approved' },
  unread: 0,
  lastMessage: { from: 'staff', preview: 'We reset the code.', createdAt: '2026-10-14T09:30:00.000Z' },
};

function thread(messages: unknown[] = [{ id: 'm1', from: 'account', staffName: null, body: 'Where is my order?', readAt: '2026-10-14T09:10:00.000Z', createdAt: '2026-10-14T09:00:00.000Z' }]) {
  return {
    conversation: { id: customer.id, code: customer.code, status: 'open', audience: 'customer', account: customer.account, createdAt: customer.createdAt, updatedAt: customer.updatedAt, firstRespondedAt: null },
    messages,
  };
}

function serve(routes: Record<string, unknown> = {}) {
  state.fetch.mockImplementation(async (url: string, options?: { method?: string }) => {
    const key = `${options?.method ?? 'GET'} ${url.split('?')[0]}`;
    if (key in routes) return routes[key];
    if (key === 'GET /v1/admin/support/conversations') {
      const audience = new URLSearchParams(url.split('?')[1]).get('audience');
      const conversations = [customer, rider].filter((entry) => audience === 'all' || entry.audience === audience);
      return { conversations, unreadTotal: conversations.reduce((total, entry) => total + entry.unread, 0) };
    }
    if (key === `GET /v1/admin/support/conversations/${customer.id}`) return thread();
    throw new Error(`unexpected ${key}`);
  });
}

beforeEach(() => {
  state.fetch.mockReset();
  state.signedIn = true;
  state.permissions = new Set(['support:case:read', 'support:case:write']);
});
afterEach(cleanup);

describe('the support inbox', () => {
  it('lists customer and rider conversations with who they are and what is unread', async () => {
    serve();
    render(<SupportCentre />);
    const list = await screen.findByRole('region', { name: 'Conversations' });
    await within(list).findByText('Chioma Customer');
    expect(within(list).getByText('Rafiu Rider')).toBeTruthy();
    expect(within(list).getByLabelText('2 unread')).toBeTruthy();
    expect(within(list).getByText('DASH: We reset the code.')).toBeTruthy();
    expect(screen.getByTestId('support-unread-total').textContent).toContain('2');
    expect(state.fetch).toHaveBeenCalledWith('/v1/admin/support/conversations?audience=all&status=open&limit=100');
  });

  it('filters customers and riders apart', async () => {
    serve();
    render(<SupportCentre />);
    await screen.findAllByText('Chioma Customer');
    fireEvent.click(screen.getByRole('button', { name: 'Riders' }));
    await waitFor(() => expect(state.fetch).toHaveBeenCalledWith('/v1/admin/support/conversations?audience=rider&status=open&limit=100'));
    const list = screen.getByRole('region', { name: 'Conversations' });
    await waitFor(() => expect(within(list).queryByText('Chioma Customer')).toBeNull());
    expect(within(list).getByText('Rafiu Rider')).toBeTruthy();
  });

  it('opens a conversation showing the account, and sends a reply', async () => {
    serve({ [`POST /v1/admin/support/conversations/${customer.id}/messages`]: { message: { id: 'm2' } } });
    render(<SupportCentre />);
    fireEvent.click(await screen.findByRole('button', { name: /Chioma Customer/ }));

    const opened = await screen.findByTestId('support-thread');
    const details = within(opened).getByTestId('support-account');
    expect(details.textContent).toContain('chioma@example.com');
    expect(details.textContent).toContain('identity_c');
    expect(details.textContent).toContain('Customer');
    expect(within(opened).getByText('Where is my order?')).toBeTruthy();

    const send = within(opened).getByRole<HTMLButtonElement>('button', { name: 'Send reply' });
    expect(send.disabled).toBe(true);
    fireEvent.change(within(opened).getByLabelText('Reply to Chioma Customer'), { target: { value: '  Your rider is 5 minutes away.  ' } });
    fireEvent.click(send);
    await waitFor(() =>
      expect(state.fetch).toHaveBeenCalledWith(`/v1/admin/support/conversations/${customer.id}/messages`, { method: 'POST', body: { body: 'Your rider is 5 minutes away.' } }),
    );
    await waitFor(() => expect((within(opened).getByLabelText('Reply to Chioma Customer') as HTMLTextAreaElement).value).toBe(''));
  });

  it('resolves a conversation', async () => {
    serve({ [`POST /v1/admin/support/conversations/${customer.id}/status`]: { status: 'resolved' } });
    render(<SupportCentre />);
    fireEvent.click(await screen.findByRole('button', { name: /Chioma Customer/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mark resolved' }));
    await waitFor(() =>
      expect(state.fetch).toHaveBeenCalledWith(`/v1/admin/support/conversations/${customer.id}/status`, { method: 'POST', body: { status: 'resolved' } }),
    );
  });

  it('keeps the reply box away from staff who can only read', async () => {
    state.permissions = new Set(['support:case:read']);
    serve();
    render(<SupportCentre />);
    fireEvent.click(await screen.findByRole('button', { name: /Chioma Customer/ }));
    await screen.findByTestId('support-thread');
    expect(screen.queryByRole('button', { name: 'Send reply' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark resolved' })).toBeNull();
    expect(screen.getByText('This account can read conversations but not reply.')).toBeTruthy();
  });

  it('shows nothing to accounts without the support permission, or signed out', async () => {
    state.permissions = new Set(['finance:ledger:read']);
    render(<SupportCentre />);
    expect(screen.getByText('No access to support conversations')).toBeTruthy();
    expect(state.fetch).not.toHaveBeenCalled();
    cleanup();

    state.signedIn = false;
    render(<SupportCentre />);
    expect(screen.getByText('Staff sign-in required')).toBeTruthy();
    expect(state.fetch).not.toHaveBeenCalled();
  });

  it('says so when the inbox cannot load, and retries', async () => {
    state.fetch.mockRejectedValueOnce(new Error('offline'));
    render(<SupportCentre />);
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load support conversations.');
    serve();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findAllByText('Chioma Customer');
  });
});
