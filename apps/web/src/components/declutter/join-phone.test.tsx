// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { JoinPage } from '@/app/(declutter)/declutter/join/join';
const state = vi.hoisted(() => ({ signup: vi.fn(), push: vi.fn() }));
vi.mock('@/lib/session', () => ({ signUp: state.signup }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: state.push }), useSearchParams: () => new URLSearchParams() }));
afterEach(() => { cleanup(); state.signup.mockReset(); state.push.mockReset(); });

it('creates an account from a country and local number and blocks invalid changes', async () => {
  state.signup.mockResolvedValue({ sent: true });
  render(<JoinPage />);
  for (const [label, value] of [['Full name', 'Ada Seller'], ['Email address', 'ada@example.com'], ['City, town or area', 'Yaba']] as const) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
  fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'GB' } });
  fireEvent.change(screen.getByLabelText('Local phone number'), { target: { value: '07400 123456' } });
  fireEvent.change(screen.getByLabelText('State'), { target: { value: 'Lagos' } });
  fireEvent.change(screen.getByLabelText('How do you plan to use DASH?'), { target: { value: 'mainly_buying' } });
  fireEvent.change(screen.getByLabelText('How did you hear about us?'), { target: { value: 'search' } });
  fireEvent.click(screen.getByLabelText(/I confirm that I am 18/));
  fireEvent.click(document.getElementById('join-terms')!);
  const submit = screen.getByRole('button', { name: 'Create my account' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(false);
  fireEvent.change(screen.getByLabelText('Local phone number'), { target: { value: '07400' } });
  expect(submit.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Local phone number'), { target: { value: '07400 123456' } });
  fireEvent.click(submit);
  await waitFor(() => expect(state.signup).toHaveBeenCalled());
  expect(state.signup.mock.calls[0]![0].phone).toBe('+447400123456');
  await waitFor(() => expect(state.push).toHaveBeenCalled());
});
