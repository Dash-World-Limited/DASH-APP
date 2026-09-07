'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppHeader } from '@/components/AppHeader';
import { ModeSwitch } from '@/components/ModeSwitch';
import { MenuButton, SideDrawer } from '@/components/SideDrawer';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingBlock,
  formatDistance,
  formatNaira,
} from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { authedFetch, useHasSession, useMe } from '@/lib/session';
import { onNotificationTap, pushAvailable, registerForPush } from '@/lib/push';
import { liveLabel, useLive } from '@/lib/useLive';
import { describeBridge, ensurePermission, geolocationAvailability, getFix } from '@/lib/geolocation';
import {
  diagnosticsEnabled,
  isOfferNoLongerAvailable,
  shouldReportLocation,
  toScreenAvailability,
  type RiderAvailability,
  type ScreenAvailability,
} from '@/lib/rider';

/**
 * Rider app.
 *
 * Rendered on the dark "field" surface: it is read outdoors, in sun, one-handed,
 * often in a hurry. Large targets, high contrast, and very little to read.
 */

/**
 * How often a working rider reports a position, and how soon after a failure.
 *
 * The server treats a position older than 120 seconds as stale and excludes
 * the rider from dispatch, so the healthy cycle has to be comfortably inside
 * that even if one attempt is lost. The two failure delays are shorter because
 * both failures they cover are recoverable: an acquisition that did not finish
 * in time usually finishes on the next try, and a refusal from the server is
 * measured against elapsed time and so resolves itself by waiting.
 */
const REPORT_INTERVAL_MS = 20_000;
const RETRY_INTERVAL_MS = 10_000;
const REJECTED_RETRY_MS = 5_000;

interface Offer {
  id: string;
  expiresAt: string;
  pickupEtaSeconds: number;
  pickupDistanceMetres: number;
  order: {
    code: string;
    pickup: { name: string; address: string; latitude: number; longitude: number };
    dropoffArea: { latitude: number; longitude: number } | null;
    tripDistanceMetres: number | null;
    itemCount: number;
    estimatedReadyAt: string | null;
  };
}

interface Delivery {
  id: string;
  code: string;
  status: string;
  mode: string;
  contactless: boolean;
  instructions: string | null;
  distanceMetres: number | null;
  estimatedReadyAt: string | null;
  vendor: { name: string };
  branch: { name: string; address: string; phone: string | null; latitude: number; longitude: number };
  address: {
    line1: string;
    landmark: string | null;
    instructions: string | null;
    contactPhone: string;
    latitude: number;
    longitude: number;
  } | null;
  items: { nameSnapshot: string; quantity: number }[];
}

interface Earnings {
  balanceOwed: number;
  completedDeliveries: number;
  recentEntries: { amount: number; memo: string; at: string }[];
}

type Availability = ScreenAvailability;

export default function RiderPage() {
  const [availability, setAvailability] = useState<Availability>('offline');
  /**
   * The rider's state as the *server* holds it, kept apart from the one the
   * control displays.
   *
   * These are two different questions. The control can only express the three
   * states a rider may choose, so displaying the server's `on_delivery`
   * requires folding it into `idle`. Reporting must not be decided by that
   * fold: it happens to agree today, which is precisely what makes it
   * dangerous — a later decision to show `on_delivery` as its own state would
   * have switched off tracking mid-delivery as a side effect of a display
   * change. The reporting loop reads this value instead.
   */
  const [serverAvailability, setServerAvailability] = useState<RiderAvailability>('offline');
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  /**
   * What this rider is carrying, read from the server.
   *
   * Deliberately not derived from the accept response. An accepted offer
   * leaves the pending list immediately — correctly — and if the only record
   * of the assignment were React state, the trip would vanish on a refresh,
   * a reconnect, or an app restart, with no way to get it back.
   */
  const [deliveries, setDeliveries] = useState<Delivery[] | null>(null);
  const [completionPin, setCompletionPin] = useState('');
  const [completionError, setCompletionError] = useState<string | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  /** An expected, non-fatal outcome worth telling the rider about. */
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  /**
   * Whether the server actually accepted the last position report.
   *
   * Not cosmetic: dispatch refuses any rider whose last accepted fix is over
   * two minutes old, so a rider whose reports are being rejected is invisible
   * to dispatch while appearing perfectly online to themselves.
   */
  const [locationHealthy, setLocationHealthy] = useState<boolean | null>(null);
  /**
   * A plain record of what the location path actually did.
   *
   * Temporary, and deliberately blunt. Every failure in this chain so far has
   * been silent, and each one cost a round of physical testing to find. Until
   * the handset is confirmed working this states each step in order.
   */
  const [geo, setGeo] = useState<{
    capacitor: string;
    platform: string;
    plugin: string;
    permission: string;
    fix: string;
    sent: string;
    server: string;
  }>({
    capacitor: '…',
    platform: '…',
    plugin: '…',
    permission: '…',
    fix: '…',
    sent: '…',
    server: '…',
  });
  /** Timestamp of the reading already reported, so a repeat can be spotted. */
  const lastTakenAt = useRef<string | undefined>(undefined);
  const signedIn = useHasSession();
  const { me } = useMe();

  const load = useCallback(async (): Promise<void> => {
    if (!signedIn) return;
    try {
      const [offerResult, earningsResult, deliveryResult] = await Promise.all([
        authedFetch<{ offers: Offer[] }>('/v1/rider/offers'),
        authedFetch<Earnings>('/v1/rider/earnings'),
        authedFetch<{ deliveries: Delivery[] }>('/v1/rider/deliveries'),
      ]);
      setOffers(offerResult.offers);
      setEarnings(earningsResult);
      setDeliveries(deliveryResult.deliveries);
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught
          : new ApiRequestError(0, 'unknown', 'Could not load your work.'),
      );
      setOffers([]);
    }
  }, [signedIn]);

  /**
   * Answer a dispatch offer.
   *
   * An offer is a race with a thirty-second clock: it can expire, another
   * rider can take it, and a rider can tap twice. The server refuses all three
   * with 409, which is the correct answer and not a malfunction — but both
   * buttons used to call the API as a floating promise with no `catch`, so a
   * rider tapping an offer that had just lapsed got a full-screen developer
   * error over an otherwise healthy app.
   *
   * Whatever the outcome, the recovery is the same and unconditional: re-read
   * the server's own view. That clears the stale offer, and — the part that
   * matters most — restores Current Delivery if this rider does in fact own
   * the order, so an accepted trip can never be lost to a failed response.
   *
   * Only the expected refusals are treated as routine. Anything else still
   * surfaces as an error, because a rider tapping Accept on a dead server must
   * not be met with silence.
   */
  const respondToOffer = useCallback(
    async (offerId: string, accept: boolean): Promise<void> => {
      try {
        await authedFetch(`/v1/rider/offers/${offerId}/respond`, {
          method: 'POST',
          body: { accept },
        });
        setNotice(null);
        setError(null);
      } catch (caught) {
        if (caught instanceof ApiRequestError && isOfferNoLongerAvailable(caught)) {
          setNotice('That offer was taken or expired before your tap landed.');
        } else {
          setError(
            caught instanceof ApiRequestError
              ? caught
              : new ApiRequestError(0, 'unknown', 'Could not respond to that offer.'),
          );
        }
      } finally {
        await load();
      }
    },
    [load],
  );

  /**
   * Offers, pushed.
   *
   * This is the screen where the difference is not a nicety. A dispatch offer
   * expires in thirty seconds, so a six-second poll spends up to a fifth of the
   * window before the rider has even seen the job — and a rider who never sees
   * it is recorded as having ignored it.
   *
   * The rider's own topic is the only place this can arrive: an offered rider
   * has no relationship to the order yet, so the server would refuse them the
   * order topic outright. They are told on `rider:<their own id>`, and answer
   * it by re-reading their own offer list.
   *
   * Their GPS position deliberately stays on its own twenty-second timer below.
   * Position changes every few seconds per rider and is written *by* this
   * client, not read by it — pushing it through a notify-then-re-read design
   * would multiply it by the number of watchers to tell this screen something
   * it already knows.
   */
  const { status } = useLive({
    topics: me?.riderId ? [`rider:${me.riderId}`] : [],
    load,
    pollMs: 6_000,
    // A rider mid-delivery is `on_delivery`, not `idle`, and must keep
    // receiving updates about the job they are already on.
    enabled: signedIn && (availability === 'idle' || (deliveries?.length ?? 0) > 0),
  });

  /**
   * Recover the rider's working state from the server.
   *
   * `availability` used to live only in this component, set by the button and
   * nowhere else, so relaunching the app reset it to `offline` in the UI while
   * the server still had the rider working. Both the offer subscription and
   * the GPS reporting loop are gated on it, so both stopped — silently, with
   * the rider's own screen looking entirely normal and dispatch unable to see
   * them at all.
   */
  useEffect(() => {
    if (!me) return;
    const server = me.riderAvailability;
    if (!server) return;
    // `on_delivery` is a working state the rider cannot select; for this
    // screen's purposes it behaves as online. See lib/rider.ts — this mapping
    // is what keeps location reporting alive during a delivery.
    setServerAvailability(server as RiderAvailability);
    setAvailability(toScreenAvailability(server as RiderAvailability));
  }, [me]);

  const setOnline = async (next: Availability): Promise<void> => {
    setBusy(true);
    try {
      await authedFetch('/v1/rider/availability', {
        method: 'POST',
        body: { availability: next },
      });
      setAvailability(next);
      // A state the rider selected is also a state the server now holds.
      setServerAvailability(next);
      await load();
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught
          : new ApiRequestError(0, 'unknown', 'Could not change your status.'),
      );
    } finally {
      setBusy(false);
    }
  };

  /**
   * Register this handset for offer notifications, and act on a tap.
   *
   * Runs once a rider is signed in, not before: asking for notification
   * permission is an interruption, and it should arrive while a rider is
   * looking at their own screen rather than while they browse as a customer.
   *
   * Everything here no-ops without the native shell, so the web client and any
   * build with no Firebase configuration behave exactly as before. The socket
   * already reaches an app that is open; push only adds the case where it is
   * not. A tap re-reads through `load`, so the screen shows what the server
   * says rather than what the notification claimed — and an offer that expired
   * or was taken simply does not come back.
   */
  useEffect(() => {
    if (!signedIn || !pushAvailable()) return;

    let stop: (() => void) | undefined;

    void registerForPush(async ({ token, platform }) => {
      await authedFetch('/v1/devices', {
        method: 'POST',
        body: { pushToken: token, platform },
      });
    }).catch(() => undefined);

    void onNotificationTap(() => {
      void load();
    }).then((remove) => {
      stop = remove;
    });

    return () => stop?.();
  }, [signedIn, load]);

  /**
   * Report the rider's position.
   *
   * Only while they are actually working. The fix comes from the native
   * plugin inside the Android shell and from `navigator.geolocation` in a
   * browser — see lib/geolocation.ts for why the web API cannot be used on the
   * shell's insecure origin.
   */
  useEffect(() => {
    // The server's own state, not the screen's. `on_delivery` is reachable
    // here and is a reporting state; `offline` and `on_break` are not.
    if (!shouldReportLocation(serverAvailability)) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const bridge = describeBridge();
    const available = geolocationAvailability();
    setGeo((g) => ({
      ...g,
      capacitor: bridge.capacitor ? 'yes' : 'NO',
      platform: bridge.capacitor
        ? `${bridge.platform} (native: ${bridge.native ? 'yes' : 'no'})`
        : `browser (secure context: ${available.secureContext ? 'yes' : 'NO'})`,
      plugin: bridge.geolocationPlugin ? 'available' : 'NOT available',
    }));

    /**
     * Book the next cycle, replacing any cycle already booked.
     *
     * This used to be a 20s `setInterval` with a separate retry timer layered
     * on top, so a struggling handset ran both at once and asked the platform
     * for a position more often than intended — which makes an acquisition
     * timeout more likely, not less, because each request holds the receiver.
     * One timer, rescheduled at the end of every attempt, cannot overlap.
     */
    const scheduleNext = (ms: number): void => {
      if (timer) clearTimeout(timer);
      if (cancelled) return;
      timer = setTimeout(() => void report(), ms);
    };

    /**
     * Ask for a position, send it, and record what happened at each step.
     *
     * `/v1/rider/location` can answer **200 with `accepted: false`** — the
     * anti-spoofing rule refuses a fix implying an impossible speed, and the
     * offline rule refuses one from a rider who is not working. That used to be
     * swallowed by `.catch(() => undefined)`, so the app believed it was
     * reporting while the server held nothing and dispatch excluded the rider
     * as `location_stale`. A refusal is recoverable — the rule is relative to
     * elapsed time — so it retries sooner rather than waiting the full cycle.
     */
    const report = async (): Promise<void> => {
      if (cancelled) return;

      const permission = await ensurePermission();
      if (cancelled) return;
      setGeo((g) => ({ ...g, permission: permission.state }));

      if (!permission.granted) {
        setLocationHealthy(false);
        setGeo((g) => ({ ...g, fix: 'not requested', sent: 'no', server: '—' }));
        // Not permanent: the rider may grant it in Settings and come back.
        scheduleNext(REPORT_INTERVAL_MS);
        return;
      }

      const result = await getFix(lastTakenAt.current);
      if (cancelled) return;

      // The platform gave back the reading we already sent and would not
      // produce a newer one. Sending it again cannot move the server's
      // freshness clock, so wait for the platform rather than spend a request.
      if (result.duplicate) {
        setGeo((g) => ({ ...g, fix: 'unchanged since last report', sent: 'skipped' }));
        scheduleNext(RETRY_INTERVAL_MS);
        return;
      }

      if (!result.ok || !result.fix) {
        setLocationHealthy(false);
        setGeo((g) => ({
          ...g,
          fix: `FAILED (${result.source}): ${result.error ?? 'unknown'}`,
          sent: 'no',
          server: '—',
        }));
        scheduleNext(RETRY_INTERVAL_MS);
        return;
      }

      setGeo((g) => ({
        ...g,
        fix: `acquired via ${result.source}${result.degraded ? ' (coarse)' : ''}${
          result.fix?.accuracy ? ` (±${Math.round(result.fix.accuracy)}m)` : ''
        }`,
        sent: 'sending…',
      }));

      try {
        const response = await authedFetch<{ accepted: boolean; reason?: string }>(
          '/v1/rider/location',
          {
            method: 'POST',
            body: {
              latitude: result.fix.latitude,
              longitude: result.fix.longitude,
              accuracy: result.fix.accuracy,
              // The platform's own timestamp, never this moment. A cached
              // reading is genuinely older, and the server derives both
              // staleness and plausible speed from this field — substituting
              // "now" would renew freshness against a reading that is not
              // fresh. `Fix.takenAt` is required, so there is nothing to
              // substitute: a reading without one never gets this far.
              recordedAt: result.fix.takenAt,
            },
          },
        );
        if (cancelled) return;

        if (response?.accepted) {
          lastTakenAt.current = result.fix.takenAt;
          setLocationHealthy(true);
          setGeo((g) => ({ ...g, sent: 'yes', server: 'accepted' }));
          scheduleNext(REPORT_INTERVAL_MS);
          return;
        }

        setLocationHealthy(false);
        setGeo((g) => ({
          ...g,
          sent: 'yes',
          server: `REJECTED: ${response?.reason ?? 'no reason given'}`,
        }));
        scheduleNext(REJECTED_RETRY_MS);
      } catch (caught) {
        if (cancelled) return;
        setLocationHealthy(false);
        setGeo((g) => ({
          ...g,
          sent: 'failed',
          server: caught instanceof ApiRequestError ? `${caught.status}: ${caught.message}` : 'request failed',
        }));
        scheduleNext(REJECTED_RETRY_MS);
      }
    };

    void report();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [serverAvailability]);

  /**
   * The next step of the delivery, according to the server's own status.
   *
   * Driven by `delivery.status` rather than local state, so a rider who
   * reopens the app mid-trip sees the step they are actually on. `arrived` is
   * the end of the progress chain — completing needs the customer's PIN and is
   * handled separately below.
   */
  const nextStep = (
    status: string,
  ): { to: string; label: string } | null => {
    switch (status) {
      case 'rider_assigned':
        return { to: 'rider_arrived', label: "I'm at the vendor" };
      case 'rider_arrived':
        return { to: 'picked_up', label: 'Picked up the order' };
      case 'picked_up':
        return { to: 'en_route', label: 'On my way' };
      case 'en_route':
        return { to: 'arrived', label: "I'm at the customer" };
      default:
        return null;
    }
  };

  const progress = async (id: string, to: string): Promise<void> => {
    setBusy(true);
    try {
      await authedFetch(`/v1/rider/deliveries/${id}/progress`, { method: 'POST', body: { to } });
      await load();
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught
          : new ApiRequestError(0, 'unknown', 'Could not update the delivery.'),
      );
    } finally {
      setBusy(false);
    }
  };

  const complete = async (id: string): Promise<void> => {
    const pin = completionPin.trim();
    if (!/^\d{4}$/.test(pin)) {
      setCompletionError('Enter the 4-digit code the customer reads out.');
      return;
    }
    setBusy(true);
    setCompletionError(null);
    try {
      await authedFetch(`/v1/rider/deliveries/${id}/complete`, { method: 'POST', body: { pin } });
      setCompletionPin('');
      await load();
    } catch (caught) {
      setCompletionError(
        caught instanceof ApiRequestError ? caught.message : 'That code was not accepted.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (!signedIn) {
    return (
      <div data-surface="field" className="min-h-screen">
        <AppHeader variant="staff" />
        <main id="main" className="mx-auto max-w-2xl px-5 py-12">
          <EmptyState
            title="Sign in to start riding"
            description="Use the phone number on your rider account."
            action={
              <Link href="/signin?next=/rider">
                <Button>Sign in</Button>
              </Link>
            }
          />
        </main>
      </div>
    );
  }

  return (
    <div data-surface="field" className="min-h-screen">
      <AppHeader variant="staff" />
      <main id="main" className="mx-auto max-w-2xl px-5 py-8">
        {/*
          Menu top-left, as a rider expects and as the map-first layout will
          need: on a screen that becomes mostly map, account controls cannot
          keep taking a card's worth of space in the flow.
        */}
        <div className="mb-4 flex items-center gap-2">
          <MenuButton onClick={() => setMenuOpen(true)} label="Rider menu" />
          <span className="text-sm font-semibold text-[var(--ink-muted)]">Rider</span>
        </div>

        {/* --- Online toggle -------------------------------------------------- */}
        <Card className="p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm text-[var(--ink-muted)]">You are</p>
              <p className="mt-0.5 text-2xl font-extrabold">
                {availability === 'idle'
                  ? 'Online'
                  : availability === 'on_break'
                    ? 'On a break'
                    : 'Offline'}
              </p>
            </div>
            <Badge
              tone={
                availability !== 'idle' ? 'neutral' : locationHealthy === false ? 'warning' : 'success'
              }
            >
              {availability !== 'idle'
                ? 'Not taking offers'
                : locationHealthy === false
                  ? 'Location not confirmed'
                  : 'Taking offers'}
            </Badge>
          </div>

          {/*
            Location diagnostics — development and test builds only.
            See `diagnosticsEnabled` in lib/rider.ts: the condition is a
            build-time constant, so a production bundle drops this block
            rather than hiding it. Every failure in this chain has been silent
            at least once, and each cost a round of physical testing to find.
          */}
          {diagnosticsEnabled() && availability === 'idle' ? (
            <dl className="mt-4 space-y-1 rounded-lg border border-[var(--line)] p-3 font-mono text-[11px] leading-relaxed">
              {(
                [
                  ['Capacitor', geo.capacitor],
                  ['platform', geo.platform],
                  ['geo plugin', geo.plugin],
                  ['permission', geo.permission],
                  ['gps fix', geo.fix],
                  ['sent', geo.sent],
                  ['server', geo.server],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="flex gap-2">
                  <dt className="w-20 shrink-0 text-[var(--ink-muted)]">{label}</dt>
                  <dd className="break-all">{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          {/*
            One control, not three.
            
            Going online is the decision a rider makes constantly; taking a
            break and going offline are rarer and were competing for the same
            space and weight. The primary toggle stays on the screen where a
            thumb can reach it, and the two secondary states move into the
            menu with the rest of the account-level controls.
          */}
          <Button
            size="lg"
            className="mt-5 w-full"
            disabled={busy}
            onClick={() => void setOnline(availability === 'idle' ? 'offline' : 'idle')}
          >
            {availability === 'idle' ? 'Go offline' : 'Go online'}
          </Button>

          {availability === 'idle' ? (
            <>
              <p className="mt-4 text-xs text-[var(--ink-muted)]" aria-live="polite">
                {status === 'live'
                  ? 'Offers arrive the moment they are made.'
                  : liveLabel(status, 6_000)}
              </p>
              <p className="mt-2 text-xs text-[var(--ink-muted)]">
                Your location is shared while you are online so orders can be matched to you, and
                stops the moment you go offline.
              </p>
            </>
          ) : null}
        </Card>

        {error ? (
          <div className="mt-4">
            <ErrorState
              message={error.message}
              requestId={error.requestId}
              onRetry={() => void load()}
            />
          </div>
        ) : null}

        {/* --- Active delivery ------------------------------------------------ */}
        {deliveries && deliveries.length > 0 ? (
          <section className="mt-8">
            <h2 className="text-lg font-bold">Current delivery</h2>
            <div className="mt-3 space-y-4">
              {deliveries.map((delivery) => {
                const step = nextStep(delivery.status);
                return (
                  <Card key={delivery.id} className="p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="font-mono font-bold">{delivery.code}</h3>
                        <p className="mt-0.5 text-sm text-[var(--ink-muted)]">
                          {delivery.vendor.name}
                        </p>
                      </div>
                      <Badge tone="gold">{delivery.status.replace(/_/g, ' ')}</Badge>
                    </div>

                    <dl className="mt-4 space-y-2 border-t pt-4 text-sm">
                      <div>
                        <dt className="text-[var(--ink-muted)]">Pick up from</dt>
                        <dd className="font-medium">{delivery.branch.name}</dd>
                        <dd className="text-[var(--ink-muted)]">{delivery.branch.address}</dd>
                      </div>
                      {delivery.address ? (
                        <div>
                          <dt className="text-[var(--ink-muted)]">Deliver to</dt>
                          <dd className="font-medium">{delivery.address.line1}</dd>
                          {delivery.address.landmark ? (
                            <dd className="text-[var(--ink-muted)]">{delivery.address.landmark}</dd>
                          ) : null}
                        </div>
                      ) : null}
                      <div>
                        <dt className="text-[var(--ink-muted)]">Items</dt>
                        <dd>
                          {delivery.items
                            .map((item) => `${item.quantity}x ${item.nameSnapshot}`)
                            .join(', ')}
                        </dd>
                      </div>
                    </dl>

                    {step ? (
                      <Button
                        size="lg"
                        className="mt-5 w-full"
                        disabled={busy}
                        onClick={() => void progress(delivery.id, step.to)}
                      >
                        {step.label}
                      </Button>
                    ) : (
                      <div className="mt-5">
                        <Field
                          label="Customer's delivery code"
                          htmlFor={`pin-${delivery.id}`}
                          error={completionError ?? undefined}
                        >
                          <Input
                            id={`pin-${delivery.id}`}
                            value={completionPin}
                            onChange={(event) =>
                              setCompletionPin(event.target.value.replace(/\D/g, '').slice(0, 4))
                            }
                            inputMode="numeric"
                            autoComplete="off"
                            placeholder="0000"
                            className="text-center font-mono text-2xl tracking-[0.4em]"
                          />
                        </Field>
                        <Button
                          size="lg"
                          className="mt-3 w-full"
                          disabled={busy || completionPin.length !== 4}
                          onClick={() => void complete(delivery.id)}
                        >
                          Complete delivery
                        </Button>
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          </section>
        ) : null}

        {/* --- Offers --------------------------------------------------------- */}
        <section className="mt-8">
          <h2 className="text-lg font-bold">Delivery offers</h2>
          {notice ? (
            <p className="mt-2 text-sm text-[var(--ink-muted)]">{notice}</p>
          ) : null}
          <div className="mt-3">
            {availability !== 'idle' ? (
              <EmptyState
                title="You are not online"
                description="Go online to start receiving delivery offers."
              />
            ) : offers === null ? (
              <LoadingBlock label="Checking for offers" />
            ) : offers.length === 0 ? (
              <EmptyState
                title="No offers right now"
                description="Stay online and offers will appear here as orders come in."
              />
            ) : (
              <ul className="space-y-3">
                {offers.map((offer) => (
                  <Card as="li" key={offer.id} className="border-gold-400 p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-mono text-sm text-[var(--ink-muted)]">
                          {offer.order.code}
                        </p>
                        <h3 className="mt-1 text-lg font-bold">{offer.order.pickup.name}</h3>
                        <p className="text-sm text-[var(--ink-muted)]">
                          {offer.order.pickup.address}
                        </p>
                      </div>
                      <OfferCountdown expiresAt={offer.expiresAt} />
                    </div>

                    <dl className="mt-4 grid grid-cols-3 gap-3 border-t pt-4 text-sm">
                      <div>
                        <dt className="text-[var(--ink-muted)]">To pickup</dt>
                        <dd className="mt-0.5 font-bold">
                          {formatDistance(offer.pickupDistanceMetres)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[var(--ink-muted)]">Trip</dt>
                        <dd className="mt-0.5 font-bold">
                          {formatDistance(offer.order.tripDistanceMetres)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[var(--ink-muted)]">Items</dt>
                        <dd className="mt-0.5 font-bold">{offer.order.itemCount}</dd>
                      </div>
                    </dl>

                    <div className="mt-5 flex gap-2">
                      <Button
                        variant="ghost"
                        size="lg"
                        className="flex-1"
                        onClick={() => void respondToOffer(offer.id, false)}
                      >
                        Decline
                      </Button>
                      <Button
                        size="lg"
                        className="flex-[2]"
                        onClick={() => void respondToOffer(offer.id, true)}
                      >
                        Accept
                      </Button>
                    </div>
                  </Card>
                ))}
              </ul>
            )}
          </div>
        </section>

        <SideDrawer open={menuOpen} onClose={() => setMenuOpen(false)} title="Rider">
          <div className="rounded-[var(--radius-card)] bg-[var(--surface-sunken)] p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
              Status
            </p>
            <p className="mt-1 font-bold">
              {availability === 'idle'
                ? 'Online — taking offers'
                : availability === 'on_break'
                  ? 'On a break'
                  : 'Offline'}
            </p>
          </div>

          {/*
            The states the main screen no longer carries. A break is not the
            same as going offline — it keeps the rider working but stops new
            offers — and it belongs where it can be explained rather than
            competing with the primary toggle for a thumb.
          */}
          <div className="mt-5 space-y-2">
            <Button
              variant="ghost"
              size="lg"
              className="w-full"
              disabled={busy || availability === 'on_break'}
              onClick={() => {
                setMenuOpen(false);
                void setOnline('on_break');
              }}
            >
              Take a break
            </Button>
            <Button
              variant="ghost"
              size="lg"
              className="w-full"
              disabled={busy || availability === 'offline'}
              onClick={() => {
                setMenuOpen(false);
                void setOnline('offline');
              }}
            >
              Go offline
            </Button>
          </div>

          {/* Back to the customer side of the same account. */}
          <div className="mt-6">
            <ModeSwitch to="customer" />
          </div>
        </SideDrawer>

        {/* --- Earnings ------------------------------------------------------- */}
        {earnings ? (
          <section className="mt-8">
            <h2 className="text-lg font-bold">Earnings</h2>
            <Card className="mt-3 p-5">
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-[var(--ink-muted)]">Owed to you</span>
                <span className="text-2xl font-extrabold tabular-nums">
                  {formatNaira(earnings.balanceOwed)}
                </span>
              </div>
              <p className="mt-1 text-sm text-[var(--ink-muted)]">
                {earnings.completedDeliveries} deliveries completed
              </p>

              {earnings.recentEntries.length > 0 ? (
                <ul className="mt-4 space-y-1.5 border-t pt-4">
                  {earnings.recentEntries.slice(0, 5).map((entry, index) => (
                    <li key={index} className="flex justify-between text-sm">
                      <span className="capitalize text-[var(--ink-muted)]">
                        {entry.memo.replace(/_/g, ' ')}
                      </span>
                      <span className="font-semibold tabular-nums">
                        {formatNaira(entry.amount)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Card>
          </section>
        ) : null}
      </main>
    </div>
  );
}

/** Counts an offer down to its expiry. Offers time out after 30 seconds. */
function OfferCountdown({ expiresAt }: { expiresAt: string }) {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000)),
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setRemaining(Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  return (
    <div
      className={`shrink-0 rounded-xl px-3 py-2 text-center ${
        remaining <= 10 ? 'bg-coral-400 text-white' : 'bg-gold-400 text-graphite-900'
      }`}
    >
      <span className="block text-xl font-extrabold tabular-nums">{remaining}</span>
      <span className="block text-[10px] font-semibold uppercase">sec</span>
    </div>
  );
}
