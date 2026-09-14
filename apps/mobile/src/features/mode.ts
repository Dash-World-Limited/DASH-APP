/**
 * Customer or Rider — one account, two faces.
 *
 * Every consumer identity is a Customer; an approved rider also has the Rider
 * face, and switches between them inside the same session. Nothing is signed
 * out or exchanged when they do — the whole point of one identity holding both
 * capabilities is that there is nothing to swap.
 *
 * Whether the switch is *offered* is decided here, and it is only ever a
 * decision about what to draw: every rider route on the server authorises
 * against the caller's own identity, and a customer-only account is refused
 * whether or not this button exists.
 *
 * Pure: tested directly.
 */

export type AppMode = 'customer' | 'rider';

export const MODE_STORAGE_KEY = 'dash.mode.v1';

export function hrefForMode(mode: AppMode): '/' | '/rider' {
  return mode === 'rider' ? '/rider' : '/';
}

export function parseMode(raw: unknown): AppMode {
  return raw === 'rider' ? 'rider' : 'customer';
}

/**
 * The remembered face, and whether the app still owes a launch redirect to it.
 *
 * Every launch opens at `/`, the Customer face. `launchFace` is 'rider' when
 * the app was closed on the Rider face and has not yet arrived back there; the
 * Customer layout redirects on it, once. It is a launch-time fact, not a
 * reaction to `mode`: an interactive switch clears it before navigating, so a
 * switch button's own navigation can never be followed by a second one. One
 * user action must produce one navigation, or Android Fabric can try to mount
 * the same native view under two parents (the A55 "child already has a
 * parent" crash).
 */
export interface ModeState {
  mode: AppMode;
  launchFace: 'rider' | null;
  ready: boolean;
}

export type ModeEvent =
  /** The saved mode has been read (or could not be: `stored` is then null). */
  | { type: 'loaded'; stored: unknown }
  /** The person switched faces. */
  | { type: 'switched'; to: AppMode }
  /** A face's layout has mounted. */
  | { type: 'arrived'; face: AppMode };

export const INITIAL_MODE_STATE: ModeState = { mode: 'customer', launchFace: null, ready: false };

export function modeReducer(state: ModeState, event: ModeEvent): ModeState {
  switch (event.type) {
    case 'loaded': {
      if (state.ready) return state; // a late read never overrides a choice already made
      const mode = parseMode(event.stored);
      return { mode, launchFace: mode === 'rider' ? 'rider' : null, ready: true };
    }
    case 'switched':
      return { ...state, mode: event.to, launchFace: null };
    case 'arrived':
      return state.launchFace === event.face ? { ...state, launchFace: null } : state;
  }
}

export interface RiderCapability {
  /** The server's rider status for this identity, when it has one. */
  riderStatus: 'approved' | 'pending' | 'rejected' | 'suspended' | null;
}

/**
 * Offer Rider mode?
 *
 * In a production build, only to an identity the server has approved. In
 * development and staging builds the switch is always shown, because this
 * checkpoint does not yet sign anyone in on the device and the Rider screens
 * must be reviewable — the build variant is compiled in, so a production
 * binary cannot take the shortcut.
 */
export function riderModeOffered(
  variant: 'development' | 'staging' | 'production',
  capability: RiderCapability | null,
): boolean {
  if (variant !== 'production') return true;
  return capability?.riderStatus === 'approved';
}
