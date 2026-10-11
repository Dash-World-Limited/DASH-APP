// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DeclutterAccount } from '@/app/(declutter)/declutter/account/account';
import { DeclutterHeader } from './DeclutterHeader';
import { hubFixture, hubSummary } from './hub-fixture';

const state = vi.hoisted(() => ({ session: 'authenticated', fetch: vi.fn(), signOut: vi.fn() }));
vi.mock('@/lib/session', () => ({
  useSessionState: () => state.session,
  useMe: () => ({ loaded: true, me: { identity: { displayName: 'Ada Seller', email: 'ada@example.com', phone: 'PRIVATE-PHONE' } } }),
  authedFetch: state.fetch, signOut: state.signOut,
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/declutter/account' }));
beforeEach(() => { state.session = 'authenticated'; state.fetch.mockReset(); state.signOut.mockReset().mockResolvedValue(undefined); });
afterEach(cleanup);

it('provides signed-out sign-in and signup links that return to the Declutters account', () => {
  state.session = 'unauthenticated';
  render(<DeclutterAccount />);
  expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/declutter/signin?next=%2Fdeclutter%2Faccount');
  expect(screen.getByRole('link', { name: 'Create account' }).getAttribute('href')).toBe('/declutter/join?next=%2Fdeclutter%2Faccount');
  expect(state.fetch).not.toHaveBeenCalled();
  expect(screen.queryByText('ada@example.com')).toBeNull();
});

it('links desktop and mobile Account to the marketplace account and closes the menu accessibly', () => {
  render(<DeclutterHeader />);
  expect(screen.getByRole('link', { name: 'Account' }).getAttribute('href')).toBe('/declutter/account');
  const menu = screen.getByRole('button', { name: 'Menu' });
  expect(menu.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(menu);
  for (const link of screen.getAllByRole('link', { name: 'Account' })) expect(link.getAttribute('href')).toBe('/declutter/account');
  expect(document.body.style.overflow).toBe('hidden');
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(document.body.style.overflow).toBe('');
});

it('keeps sign-in hidden while restoring', () => {
  state.session = 'restoring';
  render(<><DeclutterHeader /><DeclutterAccount /></>);
  expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();
  expect(state.fetch).not.toHaveBeenCalled();
});

it('renders safe status groups and existing manage/listing links, ignoring all KYC/admin fields', async () => {
  state.fetch.mockResolvedValue({
    ...hubSummary(['Draft', 'Verification required', 'Under review', 'Changes requested', 'Approved', 'Live', 'Sold'].map((status, i) => hubFixture({ id: `s${i}`, code: `DCL-${i}`, title: `Item ${i}`, status, actions: [], listing: status === 'Live' ? {slug:'live-item',publishedAt:'2026-10-10',priceKobo:10000,availability:'available'} : null }))),
    seller: { kycStatus: 'rejected', canSubmit: true, socialHandle: 'PRIVATE-SOCIAL', addressLine: 'PRIVATE-ADDRESS', nationalId: 'PRIVATE-ID', documents: ['PRIVATE-DOCUMENT'], adminNotes: 'PRIVATE-NOTE', rejectionReason: 'PRIVATE-REASON' },
  });
  const { container } = render(<DeclutterAccount />);
  await screen.findByRole('region', { name: 'Live' });
  expect(screen.getByText('Ada Seller')).toBeTruthy();
  expect(screen.getByText('ada@example.com')).toBeTruthy();
  for (const label of ['Draft', 'Verification required', 'Under review', 'Changes requested', 'Approved', 'Live', 'Sold']) expect(screen.getByRole('region', { name: label })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Update verification' }).getAttribute('href')).toBe('/declutter/seller/verify');
  expect(screen.getByRole('link', { name: 'View listing' }).getAttribute('href')).toBe('/declutter/live-item');
  expect(screen.getAllByRole('link', { name: 'Manage item' })[0]?.getAttribute('href')).toBe('/declutter/account/items/s0');
  expect(container.textContent).not.toContain('PRIVATE-');
  expect(container.querySelector('[class*="xl:grid-cols-6"]')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  expect(state.signOut).toHaveBeenCalledTimes(1);
});

it.each(['unverified', 'pending', 'verified', 'suspended'])('shows an appropriate %s verification state', async (status) => {
  state.fetch.mockResolvedValue({ ...hubSummary(), seller: { kycStatus: status, canSubmit: status !== 'suspended' } });
  render(<DeclutterAccount />);
  await screen.findByText('No items yet');
  expect(!!screen.queryByRole('link', { name: 'Verify seller profile' })).toBe(status === 'unverified');
  expect(!!screen.queryByRole('link', { name: 'Contact DASH support' })).toBe(status === 'suspended');
  expect(!!screen.queryByRole('link', { name: 'Sell another item' })).toBe(status !== 'suspended');
});
