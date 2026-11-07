/**
 * The notification switch's state: read from this phone's storage for the
 * signed-in account, written straight back when it is flipped, and put back
 * as it was if the write fails. A saved change is signalled to the push
 * registration, which tells DASH; the hook itself never touches the
 * notification permission.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';

import { readNotificationPreference, writeNotificationPreference } from '../../features/notificationPreference';
import { pushPreferenceChanged } from '../push/preferenceSignal';

export interface NotificationPreferenceState {
  /** Null while it is being read. */
  enabled: boolean | null;
  loadFailed: boolean;
  saving: boolean;
  error: string | null;
  setEnabled(next: boolean): Promise<void>;
  retry(): void;
}

export function useNotificationPreference(identityId: string | null | undefined): NotificationPreferenceState {
  const [enabled, setEnabledState] = useState<boolean | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Answers for an account that is no longer the one on screen are dropped.
  const generation = useRef(0);
  const inFlight = useRef(false);

  const load = useCallback(() => {
    const mine = ++generation.current;
    setEnabledState(null);
    setLoadFailed(false);
    setError(null);
    readNotificationPreference(AsyncStorage, identityId).then(
      (value) => {
        if (generation.current === mine) setEnabledState(value);
      },
      () => {
        if (generation.current === mine) setLoadFailed(true);
      },
    );
  }, [identityId]);

  useEffect(() => {
    load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  const setEnabled = useCallback(
    async (next: boolean) => {
      // One write at a time, and none before the stored value is known.
      if (enabled === null || inFlight.current || next === enabled) return;
      inFlight.current = true;
      const previous = enabled;
      setEnabledState(next);
      setSaving(true);
      setError(null);
      try {
        await writeNotificationPreference(AsyncStorage, identityId, next);
        // DASH hears the new choice at once, and turning it on asks Android
        // for permission if it has not been given.
        pushPreferenceChanged(next);
      } catch {
        setEnabledState(previous);
        setError('Your choice could not be saved on this phone. Please try again.');
      } finally {
        inFlight.current = false;
        setSaving(false);
      }
    },
    [enabled, identityId],
  );

  return { enabled, loadFailed, saving, error, setEnabled, retry: load };
}
