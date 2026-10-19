/**
 * Push notifications for the signed-in person, wired to the app's navigation.
 *
 * - Registers this phone with DASH after sign-in, on return to the
 *   foreground, when FCM rotates the token, and when the Notifications switch
 *   changes (see ./pushRegistration).
 * - Decides whether a push that arrives while the app is open is shown: not
 *   when the screen in front of the person already shows it.
 * - Opens the right screen when a push is tapped — including the tap that
 *   launched a closed app, which is held until the signed-in account is
 *   known, and dropped if nobody is signed in.
 *
 * Polling and realtime keep working exactly as before; push only covers the
 * time the app is not on screen.
 */

import * as Notifications from 'expo-notifications';
import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';

import { api } from '../../api';
import { notificationTarget, readPushData, showInForeground, type PushData, type PushTarget } from '../../features/pushNotifications';
import { useAppSession } from '../auth/AppSessionProvider';
import type { AppFace, AppRoute } from '../navigation/model';
import { onPushPreferenceChanged } from './preferenceSignal';
import { pushDataOf, syncPushRegistration, type SyncOutcome } from './pushRegistration';

/** Coming back to the app re-registers at most this often once registered. */
const RESUME_SYNC_MS = 15 * 60_000;

/** Taps already acted on, across remounts, so one tap never navigates twice. */
const handledTaps = new Set<string>();

/** The web build exists for design review only and has no push. */
const native = Platform.OS === 'android' || Platform.OS === 'ios';

export function usePushNotifications(input: { current: { face: AppFace; route: AppRoute }; onOpen: (target: PushTarget) => void }): void {
  const { state, viewer } = useAppSession();
  const identityId = state === 'authenticated' ? (viewer?.identity.id ?? null) : null;

  const current = useRef(input.current);
  current.current = input.current;
  const onOpen = useRef(input.onOpen);
  onOpen.current = input.onOpen;
  const pendingTap = useRef<PushData | null>(null);

  // While the app is open: show a push unless the screen already shows it.
  useEffect(() => {
    if (!native) return;
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const show = showInForeground(readPushData(pushDataOf(notification)), current.current);
        return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
      },
    });
    return () => Notifications.setNotificationHandler(null);
  }, []);

  // Registration, for whoever is signed in now.
  useEffect(() => {
    if (!native || !api.configured || !identityId) return;
    let last: { outcome: SyncOutcome; at: number } | null = null;
    let running = false;
    let disposed = false;
    let pending: { reason: 'token' | 'preference'; userAsked: boolean } | null = null;
    const sync = (reason: 'start' | 'resume' | 'token' | 'preference', userAsked = false) => {
      if (disposed) return;
      if (running) {
        // A token rotation or preference change can land during permission,
        // token lookup or HTTP registration. Re-read the latest values once
        // afterward instead of dropping the change until a later resume.
        if (reason === 'token' || reason === 'preference') {
          pending = { reason, userAsked: userAsked || (pending?.userAsked ?? false) };
        }
        return;
      }
      if (reason === 'resume' && last?.outcome === 'registered' && Date.now() - last.at < RESUME_SYNC_MS) return;
      running = true;
      syncPushRegistration(api, { identityId, userAsked })
        .then((outcome) => {
          last = { outcome, at: Date.now() };
        })
        .catch(() => {
          // A failed registration is retried on the next resume; push is
          // never a reason for the app itself to fail.
          last = null;
        })
        .finally(() => {
          running = false;
          const next = pending;
          pending = null;
          if (next) sync(next.reason, next.userAsked);
        });
    };

    sync('start');
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') sync('resume');
    });
    const tokens = Notifications.addPushTokenListener(() => sync('token'));
    const preference = onPushPreferenceChanged((enabled) => sync('preference', enabled));
    return () => {
      disposed = true;
      pending = null;
      appState.remove();
      tokens.remove();
      preference();
    };
  }, [identityId]);

  // Taps: the one that opened the app, and any while it runs.
  useEffect(() => {
    if (!native) return;
    let alive = true;
    let receivedLiveResponse = false;
    const take = (response: Notifications.NotificationResponse | null) => {
      if (!alive || !response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
      const id = response.notification.request.identifier;
      if (handledTaps.has(id)) return;
      handledTaps.add(id);
      pendingTap.current = readPushData(pushDataOf(response.notification));
      void Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
      deliver();
    };
    // Listen first. A user tap while the cached cold-start read is pending
    // must win; a late response after AuthGate unmounts must remain available
    // to the next authenticated mount, rather than being marked as handled.
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      receivedLiveResponse = true;
      take(response);
    });
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (!receivedLiveResponse) take(response);
    }, () => undefined);
    return () => { alive = false; subscription.remove(); };
    // `deliver` reads refs only, so it needs no dependency.
  }, []);

  const session = useRef({ state, viewer });
  session.current = { state, viewer };

  function deliver() {
    const tap = pendingTap.current;
    if (!tap) return;
    const { state: now, viewer: who } = session.current;
    if (now === 'restoring' || (now === 'authenticated' && !who)) return; // wait for the account
    pendingTap.current = null;
    if (now !== 'authenticated' || !who) return; // signed out: nothing to open
    const target = notificationTarget(tap, { customerId: who.customerId, riderStatus: who.riderStatus });
    if (target) onOpen.current(target);
  }

  // A tap that arrived before the account was known is delivered once it is.
  useEffect(() => {
    deliver();
  }, [state, viewer]);
}
