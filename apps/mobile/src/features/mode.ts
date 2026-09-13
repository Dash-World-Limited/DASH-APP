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

export function parseMode(raw: unknown): AppMode {
  return raw === 'rider' ? 'rider' : 'customer';
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
