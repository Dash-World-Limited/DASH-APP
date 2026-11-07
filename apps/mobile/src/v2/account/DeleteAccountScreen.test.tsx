// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  request: vi.fn(),
  configured: true,
  state: 'authenticated',
  buttons: [] as { text: string; onPress?: () => void }[],
  routes: {} as Record<string, (path: string, options: MockOptions) => unknown>,
}));
interface MockOptions { method?: string; body?: unknown; headers?: Record<string, string>; }
vi.mock('react-native', () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TextInput: (props: { value?: string; onChangeText?: (value: string) => void; accessibilityLabel?: string; testID?: string; maxLength?: number; placeholder?: string }) => (
    <input
      aria-label={props.accessibilityLabel}
      data-testid={props.testID}
      value={props.value ?? ''}
      maxLength={props.maxLength}
      placeholder={props.placeholder}
      onChange={(event) => props.onChangeText?.((event.target as HTMLInputElement).value)}
    />
  ),
  ActivityIndicator: () => <span>Loading</span>,
  Alert: { alert: (_: string, __: string, buttons: typeof h.buttons) => { h.buttons = buttons; } },
}));
vi.mock('../../api', () => ({
  api: { get configured() { return h.configured; }, request: (...args: unknown[]) => h.request(...args) },
  ApiError: class extends Error {
    status: number;
    code: string;
    constructor(status = 500, code = 'error', message = 'Something went wrong.') {
      super(message);
      this.status = status;
      this.code = code;
    }
    get isNetwork() { return this.status === 0; }
  },
}));
vi.mock('../auth/AppSessionProvider', () => ({ useAppSession: () => ({ state: h.state, viewer: { identity: { id: 'customer-a', email: 'ada@example.com' } } }) }));
vi.mock('../../theme/ThemeProvider', () => ({ useTheme: () => ({ palette: {} }) }));
vi.mock('../../ui/Text', () => ({ Text: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
vi.mock('../orders/parts', () => {
  const Box = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  const Button = ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => <button disabled={disabled} onClick={onPress}>{label}</button>;
  return { OrderPage: Box, Card: Box, BackHeader: () => null, Empty: ({ title }: { title: string }) => <p>{title}</p>, Notice: ({ text }: { text: string }) => <p>{text}</p>, PrimaryCheckoutButton: Button, SecondaryButton: Button };
});
import { ApiError } from '../../api';
import { DeleteAccountScreen } from './DeleteAccountScreen';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
/** What the mocked server currently holds, so a GET after a POST reflects it. */
let serverDeletion: unknown;

const otpOk = { expiresInSeconds: 300, resendAfterSeconds: 0 };
const scheduled = { deletion: { status: 'scheduled', requestedAt: '2026-10-23T10:00:00Z', scheduledPurgeAt: '2026-11-23T10:00:00Z', cancellable: true } };

beforeEach(() => {
  h.request.mockReset();
  h.routes = {};
  serverDeletion = null;
  h.request.mockImplementation((path: unknown, options: MockOptions) => {
    const key = `${options?.method ?? 'GET'} ${path}`;
    const fn = h.routes[key];
    if (fn) return fn(path as string, options);
    return { deletion: null };
  });
  h.routes['GET /v1/account/deletion'] = () => ({ deletion: serverDeletion });
  h.buttons = [];
  h.configured = true;
  h.state = 'authenticated';
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); });

const render = async () => { await act(async () => root.render(<DeleteAccountScreen onBack={() => undefined} onAccount={() => undefined} />)); };
const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const click = async (text: string) => {
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent === text);
  expect(button).toBeTruthy();
  await act(async () => button!.click());
};
const pressAlert = async (index: number) => { await act(async () => h.buttons[index]!.onPress!()); };
const setInput = async (label: string, value: string) => {
  const input = container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  expect(input).toBeTruthy();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const posts = (path: string) => h.request.mock.calls.filter(([p, options]) => p === path && (options as MockOptions | undefined)?.method === 'POST');
const startDeletion = async () => { await click('Delete my DASH account'); await pressAlert(1); };

describe('existing in-app account deletion contract', () => {
  it.each(['unauthenticated', 'restoring'])('cannot read or delete while %s', async (state) => {
    h.state = state;
    await render();
    expect(h.request).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Sign in first');
  });
  it('does not send a request from an unconfigured build', async () => {
    h.configured = false;
    await render();
    expect(h.request).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Not connected');
  });
  it('requires the explicit destructive confirmation and accepts cancellation', async () => {
    await render();
    await click('Delete my DASH account');
    expect(posts('/v1/account/deletion')).toHaveLength(0);
    expect(h.buttons.map((b) => b.text)).toEqual(['Keep my account', 'Schedule deletion']);
    h.buttons[0]!.onPress?.();
    expect(posts('/v1/account/deletion')).toHaveLength(0);
  });
  it('sends the code, verifies it, then posts deletion with the required idempotency key and shows its scheduled state', async () => {
    h.routes['POST /v1/auth/otp/request'] = () => otpOk;
    h.routes['POST /v1/auth/otp/verify'] = () => ({ steppedUp: true });
    h.routes['POST /v1/account/deletion'] = () => { serverDeletion = scheduled.deletion; return scheduled; };
    await render();
    await setInput('Reason for deleting your account', 'Too expensive');
    await startDeletion();
    await settle();
    expect(posts('/v1/auth/otp/request')).toHaveLength(1);
    expect(posts('/v1/auth/otp/request')[0]![1].body).toEqual({ email: 'ada@example.com', purpose: 'step_up' });
    expect(container.textContent).toContain('Code sent to');
    await setInput('Deletion confirmation code', '123456');
    await click('Confirm deletion');
    await settle();
    expect(posts('/v1/auth/otp/verify')).toHaveLength(1);
    expect(posts('/v1/auth/otp/verify')[0]![1].body).toEqual({ email: 'ada@example.com', code: '123456', purpose: 'step_up' });
    expect(posts('/v1/account/deletion')).toHaveLength(1);
    expect(posts('/v1/account/deletion')[0]![1].headers?.['Idempotency-Key']).toEqual(expect.any(String));
    expect(posts('/v1/account/deletion')[0]![1].headers['Idempotency-Key'].length).toBeGreaterThan(8);
    expect(posts('/v1/account/deletion')[0]![1].body).toEqual({ reason: 'Too expensive' });
    expect(container.textContent).toContain('Deletion is scheduled');
    expect(container.textContent).not.toContain('already deleted');
  });
  it('shows server policy errors without claiming deletion was scheduled', async () => {
    await render();
    h.request.mockRejectedValue(new Error('active order'));
    await click('Delete my DASH account');
    await pressAlert(1);
    await settle();
    expect(container.textContent).not.toContain('Deletion is scheduled');
    expect(container.textContent).toContain('Something went wrong');
  });
  it('reuses the same key after an ambiguous network failure', async () => {
    h.routes['POST /v1/auth/otp/request'] = () => otpOk;
    h.routes['POST /v1/auth/otp/verify'] = () => ({ steppedUp: true });
    h.routes['POST /v1/account/deletion'] = () => Promise.reject(new ApiError(0, 'network', 'Could not reach DASH.'));
    await render();
    await startDeletion();
    await settle();
    await setInput('Deletion confirmation code', '123456');
    await click('Confirm deletion');
    await settle();
    expect(posts('/v1/account/deletion')).toHaveLength(1);
    expect(container.textContent).toContain('Code sent to');
    await setInput('Deletion confirmation code', '123456');
    await click('Confirm deletion');
    await settle();
    expect(posts('/v1/account/deletion')).toHaveLength(2);
    expect(posts('/v1/account/deletion')[0]![1].headers?.['Idempotency-Key']).toBeTruthy();
    expect(posts('/v1/account/deletion')[1]![1].headers).toEqual(posts('/v1/account/deletion')[0]![1].headers);
  });
  it('uses the existing cancellation endpoint and reloads server state', async () => {
    h.request.mockResolvedValueOnce(scheduled).mockResolvedValueOnce({}).mockResolvedValueOnce({ deletion: null });
    await render();
    await click('Cancel deletion and keep my account');
    expect(h.request).toHaveBeenCalledWith('/v1/account/deletion', { method: 'DELETE' });
    expect(container.textContent).not.toContain('Deletion is scheduled');
  });
});

describe('step-up OTP flow', () => {
  it('keeps a wrong code on the code stage, shows the error, and posts no deletion', async () => {
    h.routes['POST /v1/auth/otp/request'] = () => otpOk;
    h.routes['POST /v1/auth/otp/verify'] = () => Promise.reject(new ApiError(400, 'invalid_code', 'That code is wrong or has expired.'));
    await render();
    await startDeletion();
    await settle();
    await setInput('Deletion confirmation code', '999999');
    await click('Confirm deletion');
    await settle();
    expect(posts('/v1/auth/otp/verify')).toHaveLength(1);
    expect(posts('/v1/account/deletion')).toHaveLength(0);
    expect(container.textContent).toContain('That code is wrong or has expired.');
    expect(container.textContent).toContain('Code sent to');
    const input = container.querySelector('input[aria-label="Deletion confirmation code"]') as HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('offers a resend after an expired code', async () => {
    h.routes['POST /v1/auth/otp/request'] = () => otpOk;
    h.routes['POST /v1/auth/otp/verify'] = () => Promise.reject(new ApiError(400, 'invalid_code', 'That code is wrong or has expired.'));
    await render();
    await startDeletion();
    await settle();
    await setInput('Deletion confirmation code', '999999');
    await click('Confirm deletion');
    await settle();
    const resend = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Resend code') as HTMLButtonElement;
    expect(resend).toBeTruthy();
    expect(resend.disabled).toBe(false);
    await act(async () => resend.click());
    await settle();
    expect(posts('/v1/auth/otp/request')).toHaveLength(2);
  });

  it('returns to the code stage and reuses the same key when the step-up expires on the deletion POST', async () => {
    h.routes['POST /v1/auth/otp/request'] = () => otpOk;
    h.routes['POST /v1/auth/otp/verify'] = () => ({ steppedUp: true });
    let attempts = 0;
    h.routes['POST /v1/account/deletion'] = () => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new ApiError(403, 'step_up_expired', 'Please confirm it is you again.'));
      serverDeletion = scheduled.deletion;
      return scheduled;
    };
    await render();
    await startDeletion();
    await settle();
    await setInput('Deletion confirmation code', '123456');
    await click('Confirm deletion');
    await settle();
    expect(posts('/v1/account/deletion')).toHaveLength(1);
    expect(container.textContent).toContain('Confirm it is you — enter the fresh code we emailed.');
    expect(container.textContent).toContain('Code sent to');
    await setInput('Deletion confirmation code', '654321');
    await click('Confirm deletion');
    await settle();
    expect(posts('/v1/account/deletion')).toHaveLength(2);
    expect(posts('/v1/account/deletion')[0]![1].headers).toEqual(posts('/v1/account/deletion')[1]![1].headers);
    expect(container.textContent).toContain('Deletion is scheduled');
  });

  it('shows a wait message on 409 and keeps the same key', async () => {
    h.routes['POST /v1/auth/otp/request'] = () => otpOk;
    h.routes['POST /v1/auth/otp/verify'] = () => ({ steppedUp: true });
    h.routes['POST /v1/account/deletion'] = () => Promise.reject(new ApiError(409, 'conflict', 'That changed while you were looking at it.'));
    await render();
    await startDeletion();
    await settle();
    await setInput('Deletion confirmation code', '123456');
    await click('Confirm deletion');
    await settle();
    expect(container.textContent).toContain('already being processed');
    const key = posts('/v1/account/deletion')[0]![1].headers['Idempotency-Key'];
    await setInput('Deletion confirmation code', '123456');
    await click('Confirm deletion');
    await settle();
    expect(posts('/v1/account/deletion')).toHaveLength(2);
    expect(posts('/v1/account/deletion')[1]![1].headers['Idempotency-Key']).toBe(key);
  });

  it('sends one deletion POST on a double tap', async () => {
    h.routes['POST /v1/auth/otp/request'] = () => otpOk;
    h.routes['POST /v1/auth/otp/verify'] = () => ({ steppedUp: true });
    h.routes['POST /v1/account/deletion'] = () => { serverDeletion = scheduled.deletion; return scheduled; };
    await render();
    await startDeletion();
    await settle();
    await setInput('Deletion confirmation code', '123456');
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Confirm deletion')!;
    await act(async () => { button.click(); button.click(); });
    await settle();
    expect(posts('/v1/account/deletion')).toHaveLength(1);
  });

  it('clears the key on success so a later fresh request gets a different key', async () => {
    h.routes['POST /v1/auth/otp/request'] = () => otpOk;
    h.routes['POST /v1/auth/otp/verify'] = () => ({ steppedUp: true });
    h.routes['POST /v1/account/deletion'] = () => { serverDeletion = scheduled.deletion; return scheduled; };
    h.routes['DELETE /v1/account/deletion'] = () => { serverDeletion = null; return {}; };
    await render();
    await startDeletion();
    await settle();
    await setInput('Deletion confirmation code', '123456');
    await click('Confirm deletion');
    await settle();
    const firstKey = posts('/v1/account/deletion')[0]![1].headers['Idempotency-Key'];
    expect(container.textContent).toContain('Deletion is scheduled');
    await click('Cancel deletion and keep my account');
    await settle();
    expect(container.textContent).not.toContain('Deletion is scheduled');
    await startDeletion();
    await settle();
    await setInput('Deletion confirmation code', '654321');
    await click('Confirm deletion');
    await settle();
    expect(posts('/v1/account/deletion')).toHaveLength(2);
    expect(posts('/v1/account/deletion')[1]![1].headers['Idempotency-Key']).not.toBe(firstKey);
  });

  it('shows a legal hold without claiming deletion was scheduled', async () => {
    h.routes['POST /v1/auth/otp/request'] = () => otpOk;
    h.routes['POST /v1/auth/otp/verify'] = () => ({ steppedUp: true });
    h.routes['POST /v1/account/deletion'] = () => Promise.reject(new ApiError(400, 'legal_hold', 'An open order must finish before this account can be deleted.'));
    await render();
    await startDeletion();
    await settle();
    await setInput('Deletion confirmation code', '123456');
    await click('Confirm deletion');
    await settle();
    expect(container.textContent).toContain('An open order must finish before this account can be deleted.');
    expect(container.textContent).not.toContain('Deletion is scheduled');
  });

  it('does not offer cancellation when the deletion is not cancellable', async () => {
    h.request.mockResolvedValue({ deletion: { status: 'scheduled', requestedAt: '2026-10-23T10:00:00Z', scheduledPurgeAt: '2026-11-23T10:00:00Z', cancellable: false } });
    await render();
    await settle();
    expect(container.textContent).not.toContain('Cancel deletion');
    expect(container.textContent).toContain('Delete my DASH account');
  });

  it('shows a held deletion distinctly, with cancellation', async () => {
    h.request.mockResolvedValue({ deletion: { status: 'held', requestedAt: '2026-10-23T10:00:00Z', scheduledPurgeAt: '2026-11-23T10:00:00Z', cancellable: true } });
    await render();
    await settle();
    expect(container.textContent).toContain('Deletion is scheduled');
    expect(container.textContent).toContain('on hold while an open dispute is resolved');
    expect(container.textContent).toContain('Cancel deletion');
  });

  it('accepts digits only, at most six, and keeps confirm disabled until six digits', async () => {
    h.routes['POST /v1/auth/otp/request'] = () => otpOk;
    await render();
    await startDeletion();
    await settle();
    const input = container.querySelector('input[aria-label="Deletion confirmation code"]') as HTMLInputElement;
    await setInput('Deletion confirmation code', '12ab34-56');
    expect(input.value).toBe('123456');
    await setInput('Deletion confirmation code', '123');
    const confirm = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Confirm deletion') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await setInput('Deletion confirmation code', '123456');
    expect(confirm.disabled).toBe(false);
  });

  it('returns to idle from the code stage without sending anything, keeping the reason', async () => {
    h.routes['POST /v1/auth/otp/request'] = () => otpOk;
    await render();
    await setInput('Reason for deleting your account', 'Just leaving');
    await startDeletion();
    await settle();
    expect(container.textContent).toContain('Code sent to');
    await click('Back');
    await settle();
    expect(container.textContent).not.toContain('Code sent to');
    expect(container.textContent).toContain('Delete my DASH account');
    expect(posts('/v1/auth/otp/verify')).toHaveLength(0);
    expect(posts('/v1/account/deletion')).toHaveLength(0);
    const reason = container.querySelector('input[aria-label="Reason for deleting your account"]') as HTMLInputElement;
    expect(reason.value).toBe('Just leaving');
  });
});
