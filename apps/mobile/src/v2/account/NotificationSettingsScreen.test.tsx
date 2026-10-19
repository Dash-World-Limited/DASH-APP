// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ os: 'ios' }));
vi.mock('react-native', () => ({
  Platform: { get OS() { return h.os; } },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ActivityIndicator: () => null,
  Linking: { openSettings: vi.fn() },
}));
vi.mock('../../api', () => ({ api: {}, ApiError: class extends Error {}, buildVariant: 'production' }));
vi.mock('../../theme/ThemeProvider', () => ({ useTheme: () => ({ palette: {} }) }));
vi.mock('../../ui/Icon', () => ({ Icon: () => null }));
vi.mock('../../ui/Text', () => ({ Text: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
vi.mock('../../ui/Controls', () => ({ Toggle: () => null }));
vi.mock('../../ui/Display', () => ({ ErrorState: () => null }));
vi.mock('../auth/AppSessionProvider', () => ({ useAppSession: () => ({ viewer: { identity: { id: 'test_identity' } } }) }));
vi.mock('../push/useNotificationPermission', () => ({ useNotificationPermission: () => ({ granted: true }) }));
vi.mock('./useNotificationPreference', () => ({
  useNotificationPreference: () => ({ enabled: true, loadFailed: false, error: null }),
}));
vi.mock('../orders/parts', () => {
  const Box = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return { OrderPage: Box, Card: Box, BackHeader: () => null, SecondaryButton: () => null, Notice: ({ text }: { text: string }) => <p>{text}</p> };
});
import { NotificationSettingsScreen } from './NotificationSettingsScreen';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; });

describe('Rider notification capability copy', () => {
  it.each(['ios', 'android'])('%s reports its real current push capability', async (os) => {
    h.os = os;
    const container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root!.render(<NotificationSettingsScreen audience="rider" onBack={() => undefined} />));
    if (os === 'ios') {
      expect(container.textContent).toContain('Push notifications are not available in this iOS build yet');
      expect(container.textContent).not.toContain('still reach you while you are online');
    } else {
      expect(container.textContent).toContain('still reach you while you are online');
      expect(container.textContent).not.toContain('Push notifications are not available in this iOS build yet');
    }
  });
});
