// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AccountPhoneEditor } from './AccountPhoneEditor';
const fetch = vi.hoisted(() => vi.fn());
const invalidate = vi.hoisted(() => vi.fn());
vi.mock('@/lib/session', () => ({ authedFetch: fetch, invalidateMe: invalidate }));
afterEach(() => { cleanup(); fetch.mockReset(); });

it('edits an account contact with the shared control and saves only E.164', async () => {
  fetch.mockResolvedValue({ saved: true });
  render(<AccountPhoneEditor initialPhone="+2348012345678" />);
  expect(screen.queryByLabelText('Local phone number')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Edit contact number' }));
  expect((screen.getByLabelText('Country') as HTMLSelectElement).value).toBe('NG');
  fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'GB' } });
  expect((screen.getByRole('button', { name: 'Save number' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Local phone number'), { target: { value: '07400 123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save number' }));
  await screen.findByRole('status');
  expect(fetch).toHaveBeenCalledWith('/v1/account/phone', { method: 'PATCH', body: { phone: '+447400123456' } });
  expect(invalidate).toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Edit contact number' }));
  expect((screen.getByLabelText('Country') as HTMLSelectElement).value).toBe('GB');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('preserves edits and allows retry after a failed save', async () => {
  fetch.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ saved: true });
  render(<AccountPhoneEditor initialPhone="+2348012345678" />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit contact number' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save number' }));
  await screen.findByRole('alert');
  expect((screen.getByLabelText('Country') as HTMLSelectElement).value).toBe('NG');
  fireEvent.click(screen.getByRole('button', { name: 'Save number' }));
  await screen.findByRole('status');
});
