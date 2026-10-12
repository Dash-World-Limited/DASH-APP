/**
 * The rider's foreground location permission: read without any UI, asked for
 * only when it is missing, and never asked for twice at once.
 *
 * Why this exists: on Android, expo-location's
 * `requestForegroundPermissionsAsync` always hands the request to the system's
 * permission activity (expo-modules-core's PermissionsService calls
 * `Activity.requestPermissions` without checking for an existing grant). With
 * the permission already granted that activity answers at once and closes, but
 * it still pauses and resumes DASH's activity. expo-location removes and
 * re-registers its GPS callbacks on that pause and resume, and React Native
 * reports the app going to the background and back to `active`. The rider flow
 * used to request on every return to `active`, so each request caused the
 * next. On a Samsung A55 the app cycled between MainActivity and
 * GrantPermissionsActivity with GPS registrations churning, which looked like
 * a crash and reload.
 *
 * Every caller now reads the permission first (`getForegroundPermissionsAsync`
 * shows nothing). Only `ensure`, used when the rider taps Go online, may open
 * the system dialog, and only when the permission is missing and Android still
 * allows asking. Concurrent callers share one in-flight call, so overlapping
 * lifecycle events cannot stack permission activities.
 *
 * Foreground only: nothing here asks for background location.
 */

export interface ForegroundPermissionApi {
  getForegroundPermissionsAsync(): Promise<{ granted: boolean; canAskAgain: boolean }>;
  requestForegroundPermissionsAsync(): Promise<{ granted: boolean }>;
}

export interface ForegroundPermission {
  /** Whether DASH may use location now. Never shows anything. */
  check(): Promise<boolean>;
  /** As `check`, but asks the rider once if the permission is missing and can still be asked for. */
  ensure(): Promise<boolean>;
}

export function createForegroundPermission(location: ForegroundPermissionApi): ForegroundPermission {
  let pending: { promise: Promise<boolean>; mayAsk: boolean } | null = null;

  const start = (mayAsk: boolean): Promise<boolean> => {
    const promise = (async () => {
      const current = await location.getForegroundPermissionsAsync();
      if (current.granted) return true;
      if (!mayAsk || !current.canAskAgain) return false;
      return (await location.requestForegroundPermissionsAsync()).granted;
    })();
    const entry = { promise, mayAsk };
    pending = entry;
    // Registered before any caller's continuation, so `pending` is clear by
    // the time a waiting `ensure` decides whether to ask.
    promise
      .finally(() => {
        if (pending === entry) pending = null;
      })
      .catch(() => undefined);
    return promise;
  };

  const access = (mayAsk: boolean): Promise<boolean> => {
    if (!pending) return start(mayAsk);
    if (pending.mayAsk || !mayAsk) return pending.promise;
    // A silent check is under way. Let it finish, and ask only if it found
    // no grant; `access` joins any request another caller started meanwhile.
    return pending.promise.then(
      (granted) => granted || access(true),
      () => access(true),
    );
  };

  return {
    check: () => access(false),
    ensure: () => access(true),
  };
}
