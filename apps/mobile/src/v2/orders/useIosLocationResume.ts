import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';

/** Settings can change location access while iOS suspends DASH. A permission
 * dialog only makes it inactive: that must not trigger another location read. */
export function useIosLocationResume(onResume: () => void): void {
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    let backgrounded = AppState.currentState === 'background';
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') backgrounded = true;
      if (state !== 'active' || !backgrounded) return;
      backgrounded = false;
      onResume();
    });
    return () => subscription.remove();
  }, [onResume]);
}
