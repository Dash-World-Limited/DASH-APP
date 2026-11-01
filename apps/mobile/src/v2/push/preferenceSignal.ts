/**
 * The Notifications switch changed on this phone. The push registration
 * listens, so the server hears the new choice at once — and, when the switch
 * was just turned on, Android is asked for permission if it has not granted
 * it. Plain JavaScript, so the settings screen can signal without loading the
 * notifications module itself.
 */

type Listener = (enabled: boolean) => void;

const listeners = new Set<Listener>();

export function onPushPreferenceChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function pushPreferenceChanged(enabled: boolean): void {
  for (const listener of listeners) listener(enabled);
}
