'use client';

/**
 * Receiving pushes on the handset, and what a tap does.
 *
 * The notification is a prompt, never a payload. It says an offer exists and
 * carries its id; the app then re-reads `/v1/rider/offers` through the
 * authorized route, where the caller is known and the projection rules apply.
 * So a tap grants nothing a rider could not already have asked for — which is
 * what makes it safe for the notification itself to have travelled through
 * Google's infrastructure and sat on a lock screen.
 *
 * It is also why nothing here trusts the notification's contents. The id is
 * used to decide *where to look*, never as the offer itself: an offer that was
 * taken by another rider, expired, or belongs to somebody else simply will not
 * come back from the refetch, and the screen shows what the server says rather
 * than what the notification claimed.
 *
 * The plugin is optional at runtime. Push needs a Firebase configuration to
 * build into the shell at all, so on the web client and on any build without it
 * these functions no-op rather than throw — the app runs identically, it just
 * relies on the socket while it is open. See lib/geolocation.ts, which handles
 * the same "native capability may not be present" problem the same way.
 */

export interface PushRegistration {
  token: string;
  platform: 'android' | 'ios' | 'web';
}

/** Data a DASH notification carries. Identifiers only, all strings. */
export interface PushData {
  type?: string;
  offerId?: string;
  orderId?: string;
  expiresAt?: string;
}

interface PushPlugin {
  register?: () => Promise<void>;
  requestPermissions?: () => Promise<{ receive?: string }>;
  checkPermissions?: () => Promise<{ receive?: string }>;
  addListener?: (
    event: string,
    handler: (payload: unknown) => void,
  ) => Promise<{ remove: () => Promise<void> }>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: { PushNotifications?: PushPlugin };
}

function capacitor(): CapacitorGlobal | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor ?? null;
}

/** Whether this build can receive pushes at all. */
export function pushAvailable(): boolean {
  const cap = capacitor();
  return Boolean(cap?.isNativePlatform?.() && cap.Plugins?.PushNotifications);
}

/**
 * Where a notification should take the rider.
 *
 * Pure, and the only place the notification's contents influence navigation.
 * An unrecognised or malformed notification resolves to `null` and is ignored
 * rather than followed: the app will not navigate somewhere because a message
 * from outside asked it to.
 */
export function deepLinkTarget(data: PushData | null | undefined): string | null {
  if (!data || typeof data !== 'object') return null;

  switch (data.type) {
    case 'rider_offer':
      // Always the rider screen itself, never a URL from the payload. The
      // offer id is not in the path because the screen re-reads the whole
      // offer list anyway — and a route built from untrusted input is a route
      // an attacker chooses.
      return '/rider';
    default:
      return null;
  }
}

/**
 * Ask for permission and hand the resulting token to the server.
 *
 * Safe to call repeatedly — on sign-in, on resume, and whenever the platform
 * rotates a token. The server treats registration as idempotent and rebinds a
 * token that has changed hands, so the client does not have to track what it
 * previously sent.
 */
export async function registerForPush(
  send: (registration: PushRegistration) => Promise<void>,
): Promise<{ registered: boolean; reason?: string }> {
  const plugin = capacitor()?.Plugins?.PushNotifications;
  if (!pushAvailable() || !plugin) {
    return { registered: false, reason: 'not-available' };
  }

  try {
    const status = (await plugin.checkPermissions?.()) ?? {};
    let granted = status.receive === 'granted';
    if (!granted) {
      const asked = (await plugin.requestPermissions?.()) ?? {};
      granted = asked.receive === 'granted';
    }
    if (!granted) return { registered: false, reason: 'permission-denied' };

    // The token arrives asynchronously on the `registration` event rather than
    // as a return value, which is why this resolves on the listener.
    const token = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 15_000);
      void plugin.addListener?.('registration', (payload) => {
        clearTimeout(timer);
        const value = (payload as { value?: string } | null)?.value;
        resolve(typeof value === 'string' ? value : null);
      });
      void plugin.register?.();
    });

    if (!token) return { registered: false, reason: 'no-token' };

    await send({
      token,
      platform: (capacitor()?.getPlatform?.() as PushRegistration['platform']) ?? 'android',
    });
    return { registered: true };
  } catch (error) {
    return { registered: false, reason: String((error as Error)?.message ?? error) };
  }
}

/**
 * Run a handler when a rider taps a notification.
 *
 * The handler receives a route, not the notification, so nothing downstream can
 * be tempted to read the payload for anything but navigation.
 */
export async function onNotificationTap(
  navigate: (route: string) => void,
): Promise<() => void> {
  const plugin = capacitor()?.Plugins?.PushNotifications;
  if (!pushAvailable() || !plugin?.addListener) return () => undefined;

  const handle = await plugin.addListener('pushNotificationActionPerformed', (payload) => {
    const data = (payload as { notification?: { data?: PushData } } | null)?.notification?.data;
    const target = deepLinkTarget(data);
    if (target) navigate(target);
  });

  return () => void handle.remove();
}
