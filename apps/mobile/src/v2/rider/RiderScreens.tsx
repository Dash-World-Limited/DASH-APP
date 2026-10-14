/**
 * The rider's screens.
 *
 * The heart of it is one live workspace: the map fills the screen, and the
 * panel beneath it changes with the rider's real state — offline, finding a
 * GPS fix, searching, an offer arriving, the delivery journey, and the handover.
 * Accepting an offer does not open another page; the same screen becomes the
 * journey, and each step's one action moves the order on. Every value shown
 * comes from the server or the phone's own GPS: there are no sample orders,
 * no invented demand, and no drawn routes, because DASH has no routing
 * provider — the map shows a straight bearing and hands directions to the
 * rider's own navigation app.
 *
 * Orders and history are ordinary list screens below the workspace.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from 'react-native';

import { api, ApiError } from '../../api';
import { secondsLeft } from '../../features/offer';
import { CountdownRing } from '../../rider/CountdownRing';
import { MapShell } from '../../rider/MapShell';
import { RouteStops } from '../../rider/RouteStops';
import { useTheme } from '../../theme/ThemeProvider';
import { elevation, radius, space, touchTarget } from '../../theme/tokens';
import { Icon, type IconName } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import {
  JOURNEY_STEPS,
  externalNavigationUrl,
  formatAgo,
  formatDistance,
  formatEta,
  gpsFreshness,
  journeyStage,
  offerWindowSeconds,
  pickupCodeVisible,
  straightLineMetres,
  type JourneyStage,
} from './journey';
import { type Coordinate, type DeliveryStatus, type RiderDelivery, type RiderOffer, useRiderFlow } from './RiderFlowProvider';

interface RiderHistoryItem {
  id: string;
  code: string;
  status: 'delivered';
  deliveredAt: string | null;
  branch: { name: string };
}

/**
 * GET /v1/rider/history/:id — a completed delivery as the order froze it at
 * placement: the address it went to and the items, whatever has changed since.
 */
interface ApiHistoryDelivery {
  id: string;
  code: string;
  status: DeliveryStatus;
  deliveredAt: string | null;
  vendorName: string;
  branch: { name: string; address: string };
  deliveryAddress: { line1: string; landmark: string | null; instructions: string | null } | null;
  items: readonly { name: string; quantity: number }[];
}

// ---------------------------------------------------------------- workspace

/**
 * The live rider workspace. Every rider route that used to be its own page —
 * online, offer, delivery, navigation, completion — renders this, and the
 * panel follows the state rather than the route.
 */
export function RiderWorkspace({ onBack, onChat }: { onBack: () => void; onChat: (orderId: string) => void }) {
  const { palette } = useTheme();
  const flow = useRiderFlow();
  const delivery = flow.delivery;
  const activeDelivery = delivery && delivery.status !== 'delivered' ? delivery : null;
  const offer = activeDelivery ? null : flow.offer;
  const stage = activeDelivery ? journeyStage(activeDelivery.status) : null;

  // Where the map points: the shop before collection, the customer after, or
  // the offered shop while an offer is open. Nothing while searching.
  const target: { point: Coordinate; kind: 'pickup' | 'dropoff' } | null = activeDelivery && stage?.target
    ? stage.target === 'pickup'
      ? { point: { latitude: activeDelivery.branch.latitude, longitude: activeDelivery.branch.longitude }, kind: 'pickup' }
      : { point: { latitude: activeDelivery.address.latitude, longitude: activeDelivery.address.longitude }, kind: 'dropoff' }
    : offer
      ? { point: { latitude: offer.order.pickup.latitude, longitude: offer.order.pickup.longitude }, kind: 'pickup' }
      : null;
  // The map frames its bounds once per destination; a new destination is a new frame.
  const mapKey = target ? `${target.kind}:${target.point.latitude},${target.point.longitude}` : 'searching';

  let panel: ReactNode;
  if (delivery?.status === 'delivered') panel = <CompletedPanel delivery={delivery} />;
  else if (activeDelivery && stage) panel = <JourneyPanel delivery={activeDelivery} stage={stage} onChat={onChat} />;
  else if (!flow.online) panel = <OfflinePanel />;
  else if (!flow.riderPosition) panel = <LocatingPanel />;
  else if (offer) panel = <OfferPanel key={offer.id} offer={offer} />;
  else panel = <SearchingPanel />;

  return (
    <View testID="rider-workspace-v2" style={{ flex: 1, backgroundColor: palette.background }}>
      <View style={{ flex: 1 }}>
        {flow.riderPosition ? (
          <MapShell
            key={mapKey}
            height="fill"
            rider={flow.riderPosition}
            destination={target?.point}
            destinationKind={target?.kind}
            destinationIcon={target?.kind === 'dropoff' ? 'home' : 'storefront-outline'}
            directLine={Boolean(target)}
            followRider={!target}
            routeColor={target?.kind === 'dropoff' ? palette.map.routeToCustomer : palette.map.routeToPickup}
            accessibilityLabel={target ? `Your live position and the ${target.kind === 'pickup' ? 'shop' : 'drop-off'}` : 'Your live position'}
          />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.surfaceMuted }}>
            <Icon name={flow.online ? 'crosshairs-question' : 'map-marker-off-outline'} size={44} color={palette.textSubtle} />
          </View>
        )}
        <WorkspaceTopBar onBack={onBack} onDelivery={Boolean(activeDelivery)} />
      </View>
      {panel}
    </View>
  );
}

function WorkspaceTopBar({ onBack, onDelivery }: { onBack: () => void; onDelivery: boolean }) {
  const { palette } = useTheme();
  const flow = useRiderFlow();
  const state = onDelivery ? 'delivery' : flow.online ? 'online' : 'offline';
  const pill = {
    online: { label: 'ONLINE', background: palette.successSoft, color: palette.success },
    delivery: { label: 'ON DELIVERY', background: palette.accentSoft, color: palette.accent },
    offline: { label: 'OFFLINE', background: palette.surface, color: palette.textMuted },
  }[state];
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', top: space.md, left: space.md, right: space.md, flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
      <Pressable
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel="Back to rider home"
        style={{ width: touchTarget, height: touchTarget, borderRadius: touchTarget / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.surface, ...elevation.floating }}
      >
        <Icon name="arrow-left" color={palette.text} />
      </Pressable>
      <View
        accessible
        accessibilityLabel={`Status: ${pill.label.toLowerCase()}`}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: space.md, height: 36, borderRadius: radius.pill, backgroundColor: pill.background, ...elevation.floating }}
      >
        <PulseDot color={pill.color} active={state !== 'offline'} />
        <Text variant="micro" weight="bold" style={{ color: pill.color }}>{pill.label}</Text>
      </View>
      <View style={{ flex: 1 }} />
      {flow.online || onDelivery ? <GpsChip /> : null}
    </View>
  );
}

/** How fresh the phone's own GPS fix is, ticking each second. Dispatch only offers to fresh positions. */
function GpsChip() {
  const { palette } = useTheme();
  const flow = useRiderFlow();
  const now = useNow(1_000);
  const freshness = gpsFreshness(flow.positionUpdatedAt, now);
  const accuracy = flow.positionAccuracyMetres !== null ? ` ±${Math.round(flow.positionAccuracyMetres)} m` : '';
  const label = freshness === 'none' ? 'Locating…' : freshness === 'live' ? `GPS live${accuracy}` : `GPS ${formatAgo(flow.positionUpdatedAt, now) ?? ''}`;
  const color = freshness === 'live' ? palette.success : freshness === 'stale' ? palette.rating : palette.textMuted;
  return (
    <View
      accessible
      accessibilityLabel={freshness === 'live' ? 'GPS position is live' : freshness === 'stale' ? 'GPS position is out of date' : 'Finding GPS position'}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space.md, height: 36, borderRadius: radius.pill, backgroundColor: palette.surface, ...elevation.floating }}
    >
      <Icon name={freshness === 'none' ? 'crosshairs-question' : 'crosshairs-gps'} size={16} color={color} />
      <Text variant="micro" weight="bold" style={{ color }}>{label}</Text>
    </View>
  );
}

/**
 * An open offer, wherever the rider is outside the workspace. Offers are
 * polled the whole time a rider is online, and one lasts about thirty
 * seconds, so a rider checking Earnings or Orders must still see it arrive.
 */
export function RiderOfferBanner({ onOpen }: { onOpen: () => void }) {
  const { palette } = useTheme();
  const flow = useRiderFlow();
  const now = useNow(500);
  const offer = flow.delivery && flow.delivery.status !== 'delivered' ? null : flow.offer;
  if (!offer) return null;
  const seconds = secondsLeft(offer.expiresAt, now);
  if (seconds <= 0) return null;
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`New delivery offer from ${offer.order.pickup.name}, ${seconds} seconds left. Open to review.`}
      style={({ pressed }) => ({ marginHorizontal: space.gutter, marginTop: space.sm, padding: space.md, borderRadius: radius.lg, flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: pressed ? palette.accentPressed : palette.accent, ...elevation.floating })}
    >
      <Icon name="bell-ring-outline" color={palette.onAccent} />
      <View style={{ flex: 1 }}>
        <Text variant="micro" tone="onAccent" weight="bold">NEW DELIVERY OFFER</Text>
        <Text variant="label" tone="onAccent" weight="bold" numberOfLines={1}>{offer.order.pickup.name} · {formatDistance(offer.pickupDistanceMetres)} away</Text>
      </View>
      <Text variant="heading" tone="onAccent">{seconds}s</Text>
      <Icon name="chevron-right" color={palette.onAccent} />
    </Pressable>
  );
}

// ---------------------------------------------------------------- panels

/** The sheet under the map: scrolling content, and a footer that never scrolls away. */
function Sheet({ children, footer, tone = 'surface' }: { children: ReactNode; footer?: ReactNode; tone?: 'surface' | 'accent' }) {
  const { palette } = useTheme();
  const accent = tone === 'accent';
  return (
    <View
      style={{
        maxHeight: '62%',
        borderTopLeftRadius: radius.xl,
        borderTopRightRadius: radius.xl,
        backgroundColor: palette.surface,
        borderTopWidth: accent ? 3 : 1,
        borderColor: accent ? palette.accent : palette.line,
        ...elevation.floating,
      }}
    >
      <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, marginTop: space.sm, backgroundColor: palette.line }} />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        {children}
      </ScrollView>
      {footer ? <View style={{ paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.sm }}>{footer}</View> : null}
    </View>
  );
}

function OfflinePanel() {
  const flow = useRiderFlow();
  return (
    <Sheet footer={<PrimaryButton label={flow.busy ? 'Going online…' : 'Go online'} icon="power" busy={flow.busy} disabled={flow.busy} onPress={() => void flow.goOnline()} />}>
      <PanelHeading icon="power-sleep" title="You’re offline" body="Go online to share your live position with DASH and receive delivery offers near you." />
      {flow.error ? <ErrorNotice message={flow.error} /> : null}
    </Sheet>
  );
}

function LocatingPanel() {
  const { palette } = useTheme();
  const flow = useRiderFlow();
  return (
    <Sheet footer={<GoOfflineButton />}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <ActivityIndicator color={palette.accent} />
        <View style={{ flex: 1 }}>
          <Text variant="heading">Getting your GPS fix…</Text>
          <Text variant="caption" tone="muted">DASH only offers you work once it knows where you are. Keep Location on; open sky helps.</Text>
        </View>
      </View>
      {flow.error ? <ErrorNotice message={flow.error} /> : null}
    </Sheet>
  );
}

/**
 * Waiting for work. Dispatch is asked automatically every few seconds, so the
 * rider has nothing to press; "Refresh" is there for impatience, not need.
 * Nothing here suggests demand that does not exist.
 */
function SearchingPanel() {
  const { palette } = useTheme();
  const flow = useRiderFlow();
  const now = useNow(1_000);
  const checked = formatAgo(flow.offersCheckedAt, now);
  const stale = gpsFreshness(flow.positionUpdatedAt, now) === 'stale';
  return (
    <Sheet footer={<GoOfflineButton />}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
        <Radar />
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="heading">Searching for nearby orders</Text>
          <Text variant="caption" tone="muted">Offers appear here on their own — there is nothing to press. Keep DASH open with the screen on while you wait.</Text>
        </View>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text variant="micro" tone="muted">{checked ? `Dispatch checked ${checked}` : 'Contacting dispatch…'}</Text>
        <Pressable onPress={() => void flow.findOffers()} accessibilityRole="button" accessibilityLabel="Check for offers now" hitSlop={12} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Icon name="refresh" size={16} color={palette.accent} />
          <Text variant="micro" tone="accent" weight="bold">Refresh</Text>
        </Pressable>
      </View>
      {stale ? <WarningNotice message="Your GPS position is out of date, so dispatch may not offer you work. Check that Location is on and DASH is open." /> : null}
      {flow.error ? <ErrorNotice message={flow.error} /> : null}
    </Sheet>
  );
}

/**
 * A real offer from dispatch. Everything the rider needs to decide, and
 * nothing the server has not sent: the drop-off is an approximate area until
 * acceptance, and the customer is not named.
 */
function OfferPanel({ offer }: { offer: RiderOffer }) {
  const { palette } = useTheme();
  const flow = useRiderFlow();
  const now = useNow(500);
  const open = secondsLeft(offer.expiresAt, now) > 0;
  const windowSeconds = offerWindowSeconds(offer.expiresAt, flow.offerSeenAt ?? now);
  const eta = formatEta(offer.pickupEtaSeconds);
  const readyAt = offer.order.estimatedReadyAt ? new Date(offer.order.estimatedReadyAt) : null;

  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(`New delivery offer from ${offer.order.pickup.name}`);
  }, [offer.order.pickup.name]);

  return (
    <Sheet
      tone="accent"
      footer={
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <View style={{ flex: 1 }}>
            <SecondaryButton label="Decline" disabled={flow.busy} onPress={() => void flow.respondToOffer(false)} />
          </View>
          <View style={{ flex: 2 }}>
            <PrimaryButton
              label={flow.busy ? 'Accepting…' : open ? 'Accept delivery' : 'Offer expired'}
              icon="check-circle-outline"
              busy={flow.busy}
              disabled={flow.busy || !open}
              onPress={() => void flow.respondToOffer(true)}
            />
          </View>
        </View>
      }
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Icon name="bell-ring-outline" size={16} color={palette.accent} />
            <Text variant="micro" tone="accent" weight="bold">NEW DELIVERY OFFER · {offer.order.code}</Text>
          </View>
          <Text variant="title" numberOfLines={2}>{offer.order.pickup.name}</Text>
          <Text variant="caption" tone="muted" numberOfLines={2}>{offer.order.pickup.address}</Text>
        </View>
        <CountdownRing expiresAt={offer.expiresAt} windowSeconds={windowSeconds} size={72} onExpire={() => flow.expireOffer(offer.id)} />
      </View>
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <Metric icon="map-marker-radius-outline" value={formatDistance(offer.pickupDistanceMetres)} label={eta ? `to pickup · ${eta}` : 'to pickup'} />
        <Metric icon="map-marker-distance" value={formatDistance(offer.order.tripDistanceMetres)} label="trip" />
        <Metric icon="package-variant" value={String(offer.order.itemCount)} label={offer.order.itemCount === 1 ? 'item' : 'items'} />
      </View>
      {readyAt && !Number.isNaN(readyAt.getTime()) ? (
        <Text variant="caption" tone="muted">The shop expects it ready around {readyAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.</Text>
      ) : null}
      <InfoNotice
        icon="shield-lock-outline"
        message={offer.order.dropoffArea
          ? 'Drop-off: approximate area only. The customer’s name, phone and exact address are shown after you accept.'
          : 'This order has no delivery address to show yet.'}
      />
      <Text variant="micro" tone="muted">Distances are straight-line estimates; the road trip will be longer.</Text>
      {flow.error ? <ErrorNotice message={flow.error} /> : null}
    </Sheet>
  );
}

/**
 * The accepted delivery, start to finish, on one screen. The step bar says
 * where the rider is in it, the destination card says where to go, and the
 * footer holds the one action that moves the order on — the delivery PIN at
 * the end.
 */
function JourneyPanel({ delivery, stage, onChat }: { delivery: RiderDelivery; stage: JourneyStage; onChat: (orderId: string) => void }) {
  const { palette } = useTheme();
  const flow = useRiderFlow();
  const [pin, setPin] = useState('');
  const toPickup = stage.target === 'pickup';
  const destination = toPickup
    ? { latitude: delivery.branch.latitude, longitude: delivery.branch.longitude }
    : { latitude: delivery.address.latitude, longitude: delivery.address.longitude };
  const destinationName = toPickup ? delivery.branch.name : delivery.address.line1;
  const away = flow.riderPosition ? formatDistance(straightLineMetres(flow.riderPosition, destination)) : null;
  const itemCount = delivery.items.reduce((total, item) => total + item.quantity, 0);
  const action = stage.action;

  const footer = action?.kind === 'pin' ? (
    <>
      <TextInput
        value={pin}
        onChangeText={(value) => setPin(value.replace(/\D/g, '').slice(0, 4))}
        keyboardType="number-pad"
        maxLength={4}
        placeholder="Customer’s 4-digit PIN"
        placeholderTextColor={palette.textSubtle}
        accessibilityLabel="Delivery PIN"
        style={{ minHeight: 60, borderRadius: radius.md, borderWidth: 2, borderColor: palette.textSubtle, color: palette.text, textAlign: 'center', fontSize: 26, letterSpacing: 10, fontFamily: 'Manrope_700Bold' }}
      />
      <PrimaryButton
        label={flow.busy ? 'Completing…' : action.label}
        icon="check-decagram-outline"
        busy={flow.busy}
        disabled={flow.busy || pin.length !== 4}
        onPress={() => void flow.complete(pin)}
      />
    </>
  ) : action?.kind === 'progress' ? (
    <PrimaryButton label={flow.busy ? 'Updating…' : action.label} icon="arrow-right-circle-outline" busy={flow.busy} disabled={flow.busy} onPress={() => void flow.progress(action.to)} />
  ) : null;

  return (
    <Sheet footer={footer}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text variant="label" weight="bold">Order {delivery.code}</Text>
        <View style={{ paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill, backgroundColor: palette.accentSoft }}>
          <Text variant="micro" tone="accent" weight="bold">{stage.label}</Text>
        </View>
      </View>
      <StepBar step={stage.step} />

      <View style={{ padding: space.md, gap: space.sm, borderRadius: radius.lg, backgroundColor: palette.surfaceMuted }}>
        <Text variant="micro" tone="muted" weight="bold">{toPickup ? 'PICK UP FROM' : 'DELIVER TO'}</Text>
        <Text variant="heading" numberOfLines={2}>{destinationName}</Text>
        <Text variant="caption" tone="muted" numberOfLines={2}>{toPickup ? delivery.branch.address : delivery.address.landmark ?? ' '}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          {away ? <Text variant="caption" weight="bold" style={{ flex: 1 }}>{away} away · straight line</Text> : <View style={{ flex: 1 }} />}
          <Pressable
            onPress={() => void Linking.openURL(externalNavigationUrl(destination, destinationName, Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web')).catch(() => undefined)}
            accessibilityRole="button"
            accessibilityLabel={`Navigate to ${destinationName} in your maps app`}
            style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: touchTarget, paddingHorizontal: space.md, borderRadius: radius.md, backgroundColor: pressed ? palette.accentPressed : palette.accent })}
          >
            <Icon name="navigation-variant-outline" size={18} color={palette.onAccent} />
            <Text variant="caption" tone="onAccent" weight="bold">Navigate</Text>
          </Pressable>
        </View>
      </View>

      <Text variant="body">{stage.instruction}</Text>

      {pickupCodeVisible(delivery.status) && delivery.pickupCode ? (
        <View style={{ padding: space.md, borderRadius: radius.lg, borderWidth: 2, borderColor: palette.accent, flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <Icon name="storefront-check-outline" size={28} color={palette.accent} />
          <View style={{ flex: 1 }}>
            <Text variant="micro" tone="muted" weight="bold">PICKUP CODE — TELL THE SHOP</Text>
            <Text variant="display" style={{ letterSpacing: 6 }} accessibilityLabel={`Pickup code ${delivery.pickupCode.split('').join(' ')}`}>{delivery.pickupCode}</Text>
          </View>
        </View>
      ) : null}

      {toPickup ? (
        <Text variant="caption" tone="muted">Then deliver to {delivery.address.line1}{delivery.address.landmark ? `, ${delivery.address.landmark}` : ''}.</Text>
      ) : null}
      {!toPickup && delivery.address.instructions ? <InfoNotice icon="message-text-outline" message={delivery.address.instructions} /> : null}

      <View style={{ flexDirection: 'row', gap: space.sm }}>
        {delivery.address.contactPhone ? (
          <View style={{ flex: 1 }}>
            <SecondaryButton label="Call customer" icon="phone-outline" onPress={() => void Linking.openURL(`tel:${delivery.address.contactPhone?.replace(/\s/g, '') ?? ''}`)} />
          </View>
        ) : null}
        <View style={{ flex: 1 }}>
          <SecondaryButton label="Chat in DASH" icon="message-text-outline" onPress={() => onChat(delivery.id)} />
        </View>
      </View>

      <View style={{ gap: space.xs }}>
        <Text variant="label" weight="bold">{itemCount} {itemCount === 1 ? 'item' : 'items'}</Text>
        {delivery.items.map((item, index) => (
          <View key={`${item.name}-${index}`} style={{ flexDirection: 'row', gap: space.sm }}>
            <Text variant="caption" tone="accent" weight="bold">{item.quantity}×</Text>
            <Text variant="caption" style={{ flex: 1 }}>{item.name}</Text>
          </View>
        ))}
      </View>
      {flow.error ? <ErrorNotice message={flow.error} /> : null}
    </Sheet>
  );
}

function CompletedPanel({ delivery }: { delivery: RiderDelivery }) {
  const { palette } = useTheme();
  const flow = useRiderFlow();
  return (
    <Sheet footer={<PrimaryButton label={flow.online ? 'Find the next order' : 'Done'} icon="radar" onPress={flow.clearCompletedDelivery} />}>
      <View style={{ alignItems: 'center', gap: space.sm, paddingVertical: space.md }}>
        <View style={{ width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.successSoft }}>
          <Icon name="check-decagram" size={34} color={palette.success} />
        </View>
        <Text variant="title" align="center">Delivery complete</Text>
        <Text variant="caption" tone="muted" align="center">Order {delivery.code} was handed over. It is in your history, and its earnings appear in Earnings once DASH records them.</Text>
      </View>
    </Sheet>
  );
}

function GoOfflineButton() {
  const flow = useRiderFlow();
  return <SecondaryButton label={flow.busy ? 'Updating…' : 'Go offline'} icon="power" disabled={flow.busy} onPress={() => void flow.goOffline()} />;
}

// ---------------------------------------------------------------- lists

export function RiderOrdersScreen({ onOpen, onOpenHistory }: { onOpen: () => void; onOpenHistory: (orderId: string) => void }) {
  const flow = useRiderFlow();
  const [history, setHistory] = useState<RiderHistoryItem[]>([]);
  const [historyBusy, setHistoryBusy] = useState(api.configured);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    if (!api.configured) {
      setHistoryBusy(false);
      return;
    }
    let cancelled = false;
    setHistoryBusy(true);
    void api.request<{ deliveries: RiderHistoryItem[] }>('/v1/rider/history')
      .then((response) => {
        if (!cancelled) {
          setHistory(response.deliveries);
          setHistoryError(null);
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          setHistoryError(caught instanceof ApiError ? caught.message : 'Could not load completed deliveries.');
        }
      })
      .finally(() => {
        if (!cancelled) setHistoryBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [flow.delivery?.status]);

  return (
    <RiderPage>
      <View style={{ height: 54, justifyContent: 'center' }}><Text variant="title">Orders</Text></View>
      <Text variant="heading">Active delivery</Text>
      {flow.delivery && flow.delivery.status !== 'delivered' ? (
        <ActionCard icon="bike-fast" title={flow.delivery.code} body={`${flow.delivery.branch.name} · ${journeyStage(flow.delivery.status).label}`} action="Open delivery" onPress={onOpen} />
      ) : <Empty icon="bike-fast" title="No active delivery" body="An accepted delivery appears here until handover is complete." compact />}
      <Text variant="heading">History</Text>
      {historyBusy ? <ActivityIndicator /> : null}
      {history.map((item) => (
        <HistoryCard
          key={item.id}
          code={item.code}
          merchant={item.branch.name}
          status="Delivered"
          onPress={() => onOpenHistory(item.id)}
        />
      ))}
      {historyError ? <ErrorNotice message={historyError} /> : null}
      {!historyBusy && history.length === 0 && !historyError ? <Empty icon="clipboard-text-clock-outline" title="No completed deliveries yet" body="Completed deliveries will appear here after handover." compact /> : null}
    </RiderPage>
  );
}

export function RiderHistoryDetailScreen({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const [delivery, setDelivery] = useState<ApiHistoryDelivery | null>(null);
  const [busy, setBusy] = useState(api.configured);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api.configured || !orderId) {
      setBusy(false);
      return;
    }
    let cancelled = false;
    setBusy(true);
    void api.request<{ delivery: ApiHistoryDelivery }>(`/v1/rider/history/${encodeURIComponent(orderId)}`)
      .then((response) => {
        if (cancelled) return;
        setDelivery(response.delivery);
        setError(null);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof ApiError ? caught.message : 'Could not load this delivery.');
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  if (busy) {
    return <RiderPage><RiderHeader title="Delivery details" onBack={onBack} /><ActivityIndicator /></RiderPage>;
  }

  if (!delivery) {
    return <RiderPage><RiderHeader title="Delivery details" onBack={onBack} />{error ? <ErrorNotice message={error} /> : <Empty icon="clipboard-text-clock-outline" title="Delivery not found" body="This completed delivery could not be loaded." />}</RiderPage>;
  }

  return (
    <RiderPage>
      <RiderHeader title="Delivery details" onBack={onBack} />
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View><Text variant="micro" tone="muted">Order</Text><Text variant="heading">{delivery.code}</Text></View>
        <StatusPill status={delivery.status} />
      </View>
      <Card>
        <RouteStops
          pickup={{ title: `${delivery.vendorName} · ${delivery.branch.name}`, detail: delivery.branch.address }}
          dropoff={{ title: delivery.deliveryAddress?.line1 ?? 'Drop-off address not recorded', detail: delivery.deliveryAddress?.landmark ?? null }}
        />
      </Card>
      <Card>
        <Text variant="label" weight="bold">Order items ({delivery.items.reduce((total, item) => total + item.quantity, 0)})</Text>
        {delivery.items.map((item, index) => <View key={`${item.name}-${index}`} style={{ flexDirection: 'row', gap: space.sm }}><Text variant="caption" tone="accent">{item.quantity}×</Text><Text variant="caption" style={{ flex: 1 }}>{item.name}</Text></View>)}
      </Card>
      {delivery.deliveredAt ? <Text variant="caption" tone="muted">Delivered {new Date(delivery.deliveredAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</Text> : null}
      {delivery.deliveryAddress?.instructions ? <InfoNotice icon="message-text-outline" message={delivery.deliveryAddress.instructions} /> : null}
      <Empty icon="check-decagram-outline" title="Delivery completed" body="This completed job is kept in your delivery history." compact />
    </RiderPage>
  );
}

// ---------------------------------------------------------------- pieces

/** Re-render on an interval, for countdowns and "4s ago". Kept inside the small components that need it. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduce).catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => subscription.remove();
  }, []);
  return reduce;
}

/** A looping 0→1 value for pulses. Still when the rider has asked for reduced motion. */
function usePulse(active: boolean, durationMs: number): Animated.Value {
  const value = useRef(new Animated.Value(0)).current;
  const reduceMotion = useReduceMotion();
  useEffect(() => {
    if (!active || reduceMotion) {
      value.setValue(0);
      return;
    }
    const loop = Animated.loop(Animated.timing(value, { toValue: 1, duration: durationMs, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [active, durationMs, reduceMotion, value]);
  return value;
}

function PulseDot({ color, active }: { color: string; active: boolean }) {
  const pulse = usePulse(active, 1_600);
  return (
    <View style={{ width: 10, height: 10, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View
        style={{
          position: 'absolute',
          width: 10,
          height: 10,
          borderRadius: 5,
          backgroundColor: color,
          opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
          transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] }) }],
        }}
      />
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
    </View>
  );
}

/** The searching mark: rings widening from a rider glyph. It means "dispatch is being asked", and nothing more. */
function Radar() {
  const { palette } = useTheme();
  const pulse = usePulse(true, 2_200);
  const ring = (offset: number) => {
    const phase = Animated.modulo(Animated.add(pulse, offset), 1);
    return (
      <Animated.View
        style={{
          position: 'absolute',
          width: 64,
          height: 64,
          borderRadius: 32,
          borderWidth: 2,
          borderColor: palette.accent,
          opacity: phase.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }),
          transform: [{ scale: phase.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }) }],
        }}
      />
    );
  };
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 64, height: 64, alignItems: 'center', justifyContent: 'center' }}>
      {ring(0)}
      {ring(0.5)}
      <View style={{ width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.accentSoft }}>
        <Icon name="moped" size={20} color={palette.accent} />
      </View>
    </View>
  );
}

function StepBar({ step }: { step: number }) {
  const { palette } = useTheme();
  return (
    <View accessible accessibilityLabel={`Step ${Math.min(step + 1, JOURNEY_STEPS.length)} of ${JOURNEY_STEPS.length}: ${JOURNEY_STEPS[Math.min(step, JOURNEY_STEPS.length - 1)]}`} style={{ gap: space.xs }}>
      <View style={{ flexDirection: 'row', gap: 4 }}>
        {JOURNEY_STEPS.map((name, index) => (
          <View key={name} style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: index < step ? palette.success : index === step ? palette.accent : palette.line }} />
        ))}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text variant="micro" tone="muted">{JOURNEY_STEPS[0]}</Text>
        <Text variant="micro" tone="muted">{JOURNEY_STEPS[JOURNEY_STEPS.length - 1]}</Text>
      </View>
    </View>
  );
}

function PanelHeading({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  const { palette } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
      <View style={{ width: 52, height: 52, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.surfaceMuted }}>
        <Icon name={icon} size={26} color={palette.textMuted} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="heading">{title}</Text>
        <Text variant="caption" tone="muted">{body}</Text>
      </View>
    </View>
  );
}

function RiderPage({ children }: { children: ReactNode }) {
  const { palette } = useTheme();
  return <ScrollView style={{ flex: 1, backgroundColor: palette.background }} contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: space.xxxl, gap: space.lg }} showsVerticalScrollIndicator={false}>{children}</ScrollView>;
}

function RiderHeader({ title, onBack }: { title: string; onBack: () => void }) {
  const { palette } = useTheme();
  return <View style={{ minHeight: 54, flexDirection: 'row', alignItems: 'center' }}><Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Go back" style={{ width: touchTarget, height: touchTarget, alignItems: 'center', justifyContent: 'center' }}><Icon name="arrow-left" color={palette.text} /></Pressable><Text variant="appBar" style={{ flex: 1 }}>{title}</Text></View>;
}

function Card({ children }: { children: ReactNode }) {
  const { palette } = useTheme();
  return <View style={{ padding: space.lg, gap: space.md, borderRadius: radius.lg, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line }}>{children}</View>;
}

function InfoNotice({ icon, message }: { icon: IconName; message: string }) {
  const { palette } = useTheme();
  return <View style={{ flexDirection: 'row', gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: palette.accentSoft }}><Icon name={icon} color={palette.accent} /><Text variant="caption" style={{ flex: 1 }}>{message}</Text></View>;
}

function WarningNotice({ message }: { message: string }) {
  const { palette } = useTheme();
  return <View style={{ flexDirection: 'row', gap: space.sm, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: palette.rating }}><Icon name="crosshairs-question" color={palette.rating} /><Text variant="caption" style={{ flex: 1 }}>{message}</Text></View>;
}

function ErrorNotice({ message }: { message: string }) {
  const { palette } = useTheme();
  return <View style={{ flexDirection: 'row', gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: palette.dangerSoft }}><Icon name="alert-circle-outline" color={palette.danger} /><Text variant="caption" style={{ flex: 1, color: palette.danger }}>{message}</Text></View>;
}

function Empty({ icon, title, body, compact = false }: { icon: IconName; title: string; body: string; compact?: boolean }) {
  const { palette } = useTheme();
  return <View style={{ minHeight: compact ? 170 : 250, alignItems: 'center', justifyContent: 'center', gap: space.sm, padding: space.lg }}><View style={{ width: 68, height: 68, borderRadius: 22, backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name={icon} size={32} color={palette.accent} /></View><Text variant="heading" align="center">{title}</Text><Text variant="caption" tone="muted" align="center">{body}</Text></View>;
}

function ActionCard({ icon, title, body, action, onPress }: { icon: IconName; title: string; body: string; action: string; onPress: () => void }) {
  const { palette } = useTheme();
  return <Pressable onPress={onPress} accessibilityRole="button" style={{ padding: space.lg, gap: space.sm, borderRadius: radius.lg, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line }}><View style={{ flexDirection: 'row', gap: space.md, alignItems: 'center' }}><View style={{ width: 46, height: 46, borderRadius: 16, backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name={icon} color={palette.accent} /></View><View style={{ flex: 1 }}><Text variant="label" weight="bold">{title}</Text><Text variant="caption" tone="muted">{body}</Text></View><Icon name="chevron-right" color={palette.accent} /></View><Text variant="caption" tone="accent" weight="bold">{action}</Text></Pressable>;
}

function HistoryCard({ code, merchant, status, onPress }: { code: string; merchant: string; status: string; onPress?: () => void }) {
  const { palette } = useTheme();
  const content = <><View style={{ width: 44, height: 44, borderRadius: 16, backgroundColor: palette.successSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name="check-decagram-outline" color={palette.success} /></View><View style={{ flex: 1 }}><Text variant="label" weight="bold">{code}</Text><Text variant="caption" tone="muted">{merchant}</Text></View><Text variant="micro" tone="success" weight="bold">{status}</Text>{onPress ? <Icon name="chevron-right" color={palette.accent} /> : null}</>;
  const style = { minHeight: 76, padding: space.md, borderRadius: radius.lg, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, flexDirection: 'row' as const, alignItems: 'center' as const, gap: space.md };
  return onPress ? <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Open details for ${code}`} style={style}>{content}</Pressable> : <View style={style}>{content}</View>;
}

function Metric({ icon, value, label }: { icon: IconName; value: string; label: string }) {
  const { palette } = useTheme();
  return <View style={{ flex: 1, minHeight: 82, padding: space.sm, borderRadius: radius.md, backgroundColor: palette.surfaceMuted, alignItems: 'center', justifyContent: 'center', gap: 2 }}><Icon name={icon} size={18} color={palette.accent} /><Text variant="label" weight="bold">{value}</Text><Text variant="micro" tone="muted" align="center">{label}</Text></View>;
}

function PrimaryButton({ label, icon, onPress, disabled = false, busy = false }: { label: string; icon: IconName; onPress: () => void; disabled?: boolean; busy?: boolean }) {
  const { palette } = useTheme();
  return <Pressable disabled={disabled} onPress={onPress} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, busy }} style={({ pressed }) => ({ minHeight: 54, borderRadius: radius.md, opacity: disabled && !busy ? 0.5 : 1, backgroundColor: pressed ? palette.accentPressed : palette.accent, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm, paddingHorizontal: space.md })}>{busy ? <ActivityIndicator color={palette.onAccent} /> : <Icon name={icon} color={palette.onAccent} />}<Text variant="label" tone="onAccent" weight="bold">{label}</Text></Pressable>;
}

function SecondaryButton({ label, onPress, disabled = false, icon }: { label: string; onPress: () => void; disabled?: boolean; icon?: IconName }) {
  const { palette } = useTheme();
  return <Pressable disabled={disabled} onPress={onPress} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} style={({ pressed }) => ({ minHeight: 50, borderRadius: radius.md, opacity: disabled ? 0.5 : 1, backgroundColor: pressed ? palette.surfaceMuted : palette.surface, borderWidth: 1, borderColor: palette.line, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.md })}>{icon ? <Icon name={icon} size={18} color={palette.text} /> : null}<Text variant="caption" weight="bold">{label}</Text></Pressable>;
}

function StatusPill({ status }: { status: DeliveryStatus }) {
  const { palette } = useTheme();
  return <View style={{ paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill, backgroundColor: status === 'delivered' ? palette.successSoft : palette.accentSoft }}><Text variant="micro" style={{ color: status === 'delivered' ? palette.success : palette.accent }} weight="bold">{journeyStage(status).label}</Text></View>;
}
