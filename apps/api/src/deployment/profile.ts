/**
 * Which parts of DASH a deployment actually runs.
 *
 * One codebase serves two products. DASH APP is a delivery platform: it charges
 * cards, dispatches riders, geocodes addresses and sends SMS codes. DASH World
 * Declutters is a marketplace: it takes no payment, delivers nothing, has no
 * concept of a rider, and authenticates by email.
 *
 * Until now production insisted on all of it. The boot guards refuse a mock
 * payment provider, a local geo adapter, a console SMS adapter and a console
 * push adapter — correctly, because each of those silently does nothing while
 * claiming to charge a card or send a code. But that made a Declutters-only
 * production deployment impossible: it would have to be handed Paystack keys it
 * will never use, an SMS provider it will never call, and a maps key for
 * addresses it never geocodes, just to satisfy checks about features it does
 * not run.
 *
 * The fix is not to relax the guards. It is to say out loud which capabilities
 * a deployment has, and then to hold that statement to three consequences:
 *
 *   1. **A guard applies only to a capability that is on.** No check is
 *      weakened; the ones about switched-off features simply do not apply.
 *   2. **A disabled capability gets an adapter that throws.** Not a mock, not a
 *      console stub. If code ever reaches a disabled capability that is a bug,
 *      and it should fail loudly in the logs rather than quietly do nothing.
 *   3. **Routes belonging to a disabled capability are never registered.** They
 *      answer 404, because the honest response to "charge my card" on a
 *      deployment that cannot charge cards is that the endpoint does not exist.
 *
 * Together those mean a Declutters deployment cannot perform a fake payment,
 * cannot pretend to send an SMS, and cannot quietly accept an order it will
 * never fulfil — which is a stronger position than the one the strict guards
 * gave us, not a weaker one.
 */

export const DEPLOYMENT_PROFILES = ['full', 'declutters'] as const;
export type DeploymentProfile = (typeof DEPLOYMENT_PROFILES)[number];

/**
 * The capabilities a deployment can have.
 *
 * Named for what a user could do, not for the adapter behind it: `payments`
 * rather than `paystack`, `maps` rather than `google`. A capability outlives the
 * provider implementing it.
 */
export const CAPABILITIES = [
  /** Charging cards, refunds, payment webhooks. */
  'payments',
  /** Sending SMS, which today means phone one-time codes. */
  'sms',
  /** Push notifications to a device. */
  'push',
  /** Geocoding, routing and delivery-zone containment. */
  'maps',
  /** Vendor catalogue, baskets, orders, rider dispatch. */
  'delivery',
  /** Personal-data export archives. */
  'dataExport',
  /** Transactional email. Required by both profiles. */
  'email',
  /** Object storage for photographs and documents. Required by both. */
  'storage',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * What each profile runs.
 *
 * `declutters` is the smaller set, and every exclusion is a thing the
 * marketplace genuinely does not do:
 *
 *   * **payments** — DASH does not take money on Declutters. A buyer and a
 *     seller settle between themselves after an introduction, which is exactly
 *     what the Terms say.
 *   * **sms** — signup and sign-in are by email code. The phone number is
 *     collected and deliberately unverified.
 *   * **push** — there is no Declutters app to notify.
 *   * **maps** — listings are shown by area and state. Nothing is geocoded,
 *     routed, or measured for distance; the product forbids showing a distance
 *     at all.
 *   * **delivery** — nothing is dispatched. Cars are `direct_only` and every
 *     other item is collected or handed over directly.
 *   * **dataExport** — the export archive adapter still writes to local disk,
 *     so an archive built in production would be lost on the next deploy.
 *     Rather than offer a download that quietly disappears, the capability is
 *     off and the endpoints do not exist. Account *deletion* is unaffected: it
 *     needs no archive, and the Privacy Policy promises it.
 */
const PROFILE_CAPABILITIES: Readonly<Record<DeploymentProfile, readonly Capability[]>> = {
  full: [...CAPABILITIES],
  declutters: ['email', 'storage'],
};

const CAPABILITY_SETS: Readonly<Record<DeploymentProfile, ReadonlySet<Capability>>> = {
  full: new Set(PROFILE_CAPABILITIES.full),
  declutters: new Set(PROFILE_CAPABILITIES.declutters),
};

export function capabilitiesFor(profile: DeploymentProfile): ReadonlySet<Capability> {
  return CAPABILITY_SETS[profile];
}

export function hasCapability(profile: DeploymentProfile, capability: Capability): boolean {
  return CAPABILITY_SETS[profile].has(capability);
}

export function isDeploymentProfile(value: string): value is DeploymentProfile {
  return (DEPLOYMENT_PROFILES as readonly string[]).includes(value);
}

/**
 * Raised when code reaches a capability this deployment does not have.
 *
 * It should never be caught and turned into a soft outcome. Reaching a disabled
 * adapter means something is wired wrongly, and the point of throwing is that
 * the wiring mistake is visible instead of presenting as a payment that never
 * arrived or a code nobody received.
 */
export class CapabilityDisabledError extends Error {
  constructor(readonly capability: Capability) {
    super(
      `The "${capability}" capability is disabled on this deployment. ` +
        'Nothing was done. This is a wiring error, not a runtime condition.',
    );
    this.name = 'CapabilityDisabledError';
  }
}
