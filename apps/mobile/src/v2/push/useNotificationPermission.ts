/**
 * Whether Android is letting DASH show notifications at all, re-read whenever
 * the app comes back to the foreground — the person may have just changed it
 * in Android's settings. Null while it is being read, and on the web build.
 */

import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';

import { notificationPermission } from './pushRegistration';

export function useNotificationPermission(): { granted: boolean } | null {
  const [state, setState] = useState<{ granted: boolean } | null>(null);

  useEffect(() => {
    // The web build has no push, and nothing to say about Android.
    if (Platform.OS !== 'android' && Platform.OS !== 'ios') return;
    let alive = true;
    const read = () => {
      notificationPermission().then(
        (permission) => {
          if (alive) setState({ granted: permission.granted });
        },
        () => undefined,
      );
    };
    read();
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') read();
    });
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);

  return state;
}
