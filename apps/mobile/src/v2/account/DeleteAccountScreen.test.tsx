// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  request: vi.fn(), configured: true, state: 'authenticated',
  buttons: [] as { text: string; onPress?: () => void }[],
}));
vi.mock('react-native', () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TextInput: () => null, ActivityIndicator: () => <span>Loading</span>,
  Alert: { alert: (_: string, __: string, buttons: typeof h.buttons) => { h.buttons = buttons; } },
}));
vi.mock('../../api', () => ({ api: { get configured() { return h.configured; }, request: (...args: unknown[]) => h.request(...args) }, ApiError: class extends Error {} }));
vi.mock('../auth/AppSessionProvider', () => ({ useAppSession: () => ({ state: h.state, viewer: { identity: { id: 'customer-a' } } }) }));
vi.mock('../../theme/ThemeProvider', () => ({ useTheme: () => ({ palette: {} }) }));
vi.mock('../../ui/Text', () => ({ Text: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
vi.mock('../orders/parts', () => {
  const Box = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  const Button = ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => <button disabled={disabled} onClick={onPress}>{label}</button>;
  return { OrderPage: Box, Card: Box, BackHeader: () => null, Empty: ({ title }: { title: string }) => <p>{title}</p>, Notice: ({ text }: { text: string }) => <p>{text}</p>, PrimaryCheckoutButton: Button, SecondaryButton: Button };
});
import { DeleteAccountScreen } from './DeleteAccountScreen';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { h.request.mockReset(); h.request.mockResolvedValue({ deletion: null }); h.buttons = []; h.configured = true; h.state = 'authenticated'; container = document.createElement('div'); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); });
const render = async () => { await act(async () => root.render(<DeleteAccountScreen onBack={() => undefined} onAccount={() => undefined} />)); };
const click = async (text: string) => { const button = [...container.querySelectorAll('button')].find(b => b.textContent === text); expect(button).toBeTruthy(); await act(async () => button!.click()); };
const posts = () => h.request.mock.calls.filter(([, options]) => options?.method === 'POST');
const scheduled = { deletion: { status: 'pending', requestedAt: '2026-10-23T10:00:00Z', scheduledPurgeAt: '2026-11-23T10:00:00Z', cancellable: true } };

describe('existing in-app account deletion contract', () => {
  it.each(['unauthenticated', 'restoring'])('cannot read or delete while %s', async state => { h.state = state; await render(); expect(h.request).not.toHaveBeenCalled(); expect(container.textContent).toContain('Sign in first'); });
  it('does not send a request from an unconfigured build', async () => { h.configured = false; await render(); expect(h.request).not.toHaveBeenCalled(); expect(container.textContent).toContain('Not connected'); });
  it('requires the explicit destructive confirmation and accepts cancellation', async () => {
    await render(); await click('Delete my DASH account');
    expect(posts()).toHaveLength(0);
    expect(h.buttons.map(b => b.text)).toEqual(['Keep my account', 'Schedule deletion']);
    h.buttons[0]!.onPress?.(); expect(posts()).toHaveLength(0);
  });
  it('sends the existing API the required idempotency key and shows its scheduled state', async () => {
    await render(); h.request.mockResolvedValue(scheduled); await click('Delete my DASH account'); await act(async () => h.buttons[1]!.onPress!());
    expect(posts()).toHaveLength(1);
    expect(posts()[0]![1].headers?.['Idempotency-Key']).toEqual(expect.any(String));
    expect(posts()[0]![1].headers['Idempotency-Key'].length).toBeGreaterThan(8);
    expect(container.textContent).toContain('Deletion is scheduled'); expect(container.textContent).not.toContain('already deleted');
  });
  it('shows server policy errors without claiming deletion was scheduled', async () => {
    await render(); h.request.mockRejectedValue(new Error('active order'));
    await click('Delete my DASH account'); await act(async () => h.buttons[1]!.onPress!());
    expect(container.textContent).not.toContain('Deletion is scheduled');
    expect(container.textContent).toContain('Something went wrong');
  });
  it('reuses the same key after an ambiguous network failure', async () => {
    await render(); h.request.mockRejectedValue(new Error('lost response'));
    await click('Delete my DASH account'); await act(async () => h.buttons[1]!.onPress!());
    await click('Delete my DASH account'); await act(async () => h.buttons[1]!.onPress!());
    expect(posts()).toHaveLength(2);
    expect(posts()[0]![1].headers?.['Idempotency-Key']).toBeTruthy();
    expect(posts()[1]![1].headers).toEqual(posts()[0]![1].headers);
  });
  it('uses the existing cancellation endpoint and reloads server state', async () => { h.request.mockResolvedValueOnce(scheduled).mockResolvedValueOnce({}).mockResolvedValueOnce({ deletion: null }); await render(); await click('Cancel deletion and keep my account'); expect(h.request).toHaveBeenCalledWith('/v1/account/deletion', { method: 'DELETE' }); expect(container.textContent).not.toContain('Deletion is scheduled'); });
});
