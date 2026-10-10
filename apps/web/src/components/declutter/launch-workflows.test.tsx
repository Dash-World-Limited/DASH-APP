// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DeclutterHeader } from './DeclutterHeader';
import { ItemSubmissionForm } from './ItemSubmissionForm';
import { SellerVerificationPage } from '@/app/(declutter)/declutter/seller/verify/seller-verification';

const state = vi.hoisted(() => ({ signedIn: false, fetch: vi.fn() }));
vi.mock('@/lib/session', () => ({ useHasSession: () => state.signedIn, useSessionState: () => state.signedIn ? 'authenticated' : 'unauthenticated', authedFetch: state.fetch }));
vi.mock('next/navigation', () => ({ usePathname: () => '/declutter/sell' }));
beforeEach(() => { state.signedIn = false; state.fetch.mockReset(); });
afterEach(cleanup);

it('lets a new visitor create an account from desktop and mobile navigation', () => {
  render(<DeclutterHeader />);
  expect(screen.getByRole('link', { name: 'Create account' }).getAttribute('href')).toBe('/declutter/join?next=%2Fdeclutter%2Fsell');
  expect(screen.getByRole('link', { name: 'Sign in' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getAllByRole('link', { name: 'Create account' })).toHaveLength(2);
  expect(screen.getAllByRole('link', { name: 'Sign in' })).toHaveLength(2);
});

it('uploads private identity evidence and submits the social handle in its own field', async () => {
  state.signedIn = true;
  const seller = { id: 'seller-ui', displayName: 'Ada', kycStatus: 'rejected', rejectionReason: 'Replace ID', socialHandle: '@old_handle' };
  state.fetch.mockImplementation(async (url) => url.endsWith('/verification') ? { seller: { ...seller, kycStatus: 'pending' } } : { seller });
  render(<SellerVerificationPage />);
  await screen.findByLabelText('Legal name');
  expect((screen.getByLabelText('Social handle (optional)') as HTMLInputElement).value).toBe('@old_handle');
  for (const [label, value] of [['Legal name', 'Ada Seller'], ['Name on ID', 'Ada Seller'], ['ID number', '12345678901'], ['Local phone number', '08012345678'], ['Private address', '14 Example Road'], ['Social handle (optional)', '@ada_seller']] as const) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
  fireEvent.change(screen.getByLabelText('ID file'), { target: { files: [new File(['private fixture'], 'id.png', { type: 'image/png' })] } });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Submit for verification' }));
  await screen.findByText('Verification received');
  const calls = state.fetch.mock.calls;
  const verification = calls.find(([url]) => url.endsWith('/verification'));
  expect(verification?.[1].body.socialHandle).toBe('@ada_seller');
  expect(verification?.[1].body.phoneE164).toBe('+2348012345678');
  expect(verification?.[1].body.addressLine).toBe('14 Example Road');
  expect(calls.findIndex(([url]) => url.endsWith('/documents'))).toBeLessThan(calls.findIndex(([url]) => url.endsWith('/verification')));
  expect(calls.some(([url]) => url.endsWith('/verification/complete'))).toBe(true);
});

it('finishes an item only after all photos upload and reports pending email honestly', async () => {
  state.fetch.mockImplementation(async (url) => {
    if (url.endsWith('/taxonomy')) return { categories: [{ key: 'phones-tablets', name: 'Phones' }], locations: [{ slug: 'lagos-lekki', label: 'Lekki' }] };
    if (url.endsWith('/complete')) return { notified: false };
    return { submission: { id: 'item-ui', code: 'DCL-UI', title: 'Phone', status: 'kyc_pending' } };
  });
  render(<ItemSubmissionForm kycStatus="unverified" />);
  await screen.findByText('Phones');
  fireEvent.change(screen.getByLabelText('Item title'), { target: { value: 'Phone' } });
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'A real phone with charger.' } });
  fireEvent.change(screen.getByLabelText(/Choose photos/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' }), new File(['two'], 'two.png', { type: 'image/png' })] } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit item to DASH' }));
  await waitFor(() => expect(screen.getByText(/Email confirmation is pending/)).toBeTruthy());
  const mutationUrls = state.fetch.mock.calls.map(([url]) => url).filter(url => url !== '/v1/declutter/taxonomy');
  expect(mutationUrls).toEqual(['/v1/declutter/submissions', '/v1/declutter/submissions/item-ui/photos', '/v1/declutter/submissions/item-ui/photos', '/v1/declutter/submissions/item-ui/complete']);
});
