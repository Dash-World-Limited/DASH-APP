import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Linking, Platform, Pressable, ScrollView, View } from 'react-native';
import { formatNaira, formatNairaCompact, type Kobo } from '@dash/domain/money';

import { api, ApiError } from '../../api';
import {
  cancelOrder,
  describeOutcome,
  isActiveOrder,
  quoteRows,
  refundTone,
  retryPayment,
  verifyPayment,
  type OrderRider,
  type PaymentOutcome,
  type RiderRatingState,
} from '../../data/orders';
import { riderCallUrl } from '../../features/delivery';
import { recallOrder, rememberOrder, type RememberedOrder } from '../../features/orderMemory';
import { MapShell } from '../../rider/MapShell';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, space } from '../../theme/tokens';
import { Icon } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import { useAppSession } from '../auth/AppSessionProvider';
import { BackHeader, Card, Empty, Notice, OrderPage, PrimaryCheckoutButton, SecondaryButton } from './parts';
import { RateRiderCard } from './RateRiderCard';

interface OrderSummary {
  id: string;
  code: string;
  status: string;
  statusLabel: string;
  phase: string;
  total: number;
  createdAt: string;
  vendor: { name: string; slug: string; category: string };
  items: Array<{ nameSnapshot: string; quantity: number }>;
}

interface OrderDetail extends OrderSummary {
  /** Frozen at checkout: the receipt never reads today's menu or prices. */
  items: Array<{ nameSnapshot: string; quantity: number; priceSnapshot: Kobo; lineTotal: Kobo }>;
  itemsSubtotal: Kobo;
  discountTotal: Kobo;
  deliveryFee: Kobo;
  serviceFee: Kobo;
  smallOrderFee: Kobo;
  surgeAmount: Kobo;
  tax: Kobo;
  tip: Kobo;
  total: Kobo;
  branch: { name: string; address: string; latitude: number; longitude: number };
  address: { line1: string; landmark: string | null; instructions: string | null; latitude: number; longitude: number } | null;
  statusEvents: Array<{ toStatus: string; createdAt: string }>;
  rider: OrderRider | null;
  /**
   * Refunds owed on this order, worded by the server. Optional because an
   * older server omits the field entirely — which reads as "no refunds", not
   * as an error.
   */
  refunds?: Array<{ amount: Kobo; status: string; label: string; body: string; refundedAt: string | null; createdAt: string }>;
  /** Rating the rider who delivered it. Optional: older servers omit it. */
  riderRating?: RiderRatingState | null;
}

export function CustomerOrdersScreen({ onTrack, onAccount }: { onTrack: (id: string) => void; onAccount: () => void }) {
  const { palette } = useTheme();
  const auth = useAppSession();
  const [segment, setSegment] = useState<'active' | 'past'>('active');
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [busy, setBusy] = useState(api.configured);
  const [error, setError] = useState<string | null>(null);
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    if (!api.configured || auth.state !== 'authenticated') return;
    const generation = ++loadGeneration.current;
    // A suspended iOS request must not replace a newer resume/segment read.
    // Android retains its existing request/result behavior.
    const current = () => Platform.OS !== 'ios' || generation === loadGeneration.current;
    setBusy(true);
    setError(null);
    try {
      const response = await api.request<{ orders: OrderSummary[] }>(`/v1/orders?status=${segment}&limit=20`);
      if (current()) setOrders(response.orders);
    } catch (caught) {
      if (current()) setError(caught instanceof ApiError ? caught.message : 'Could not load your orders.');
    } finally {
      if (current()) setBusy(false);
    }
  }, [auth.state, segment]);

  useEffect(() => {
    if (!api.configured) {
      setBusy(false);
      return;
    }
    void load();
    return () => { if (Platform.OS === 'ios') loadGeneration.current += 1; };
  }, [load, segment]);

  useEffect(() => {
    if (Platform.OS !== 'ios' || !api.configured || auth.state !== 'authenticated') return;
    let backgrounded = AppState.currentState === 'background';
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'background') backgrounded = true;
      if (next !== 'active' || !backgrounded) return;
      backgrounded = false;
      // The list stays mounted while iOS suspends DASH. Read server-owned
      // state again, including after an offline load or browser round-trip.
      void load();
    });
    return () => subscription.remove();
  }, [auth.state, load]);

  return (
    <OrderPage>
      <View style={{ height: 54, justifyContent: 'center' }}><Text variant="title">Orders</Text></View>
      <View style={{ flexDirection: 'row', padding: 4, borderRadius: radius.md, backgroundColor: palette.surfaceMuted }}>
        {(['active', 'past'] as const).map((item) => <Pressable key={item} onPress={() => setSegment(item)} accessibilityRole="tab" accessibilityState={{ selected: item === segment }} style={{ flex: 1, minHeight: 40, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: item === segment ? palette.inverse : 'transparent' }}><Text variant="caption" weight="bold" tone={item === segment ? 'onInverse' : 'muted'}>{item === 'active' ? 'Active' : 'History'}</Text></Pressable>)}
      </View>
      {!api.configured ? <Empty icon="cloud-off-outline" title="Not connected to DASH" body="This build has no DASH API address, so there is no order history to load. That is a build setting (EXPO_PUBLIC_API_URL), not something to fix on the phone." /> : null}
      {api.configured && auth.state !== 'authenticated' ? <Empty icon="account-lock-outline" title="Sign in to see your orders" body="Order history belongs to your secured customer account." action="Open account" onPress={onAccount} /> : null}
      {busy ? <View style={{ minHeight: 180, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={palette.accent} /></View> : null}
      {error ? <Notice icon="alert-circle-outline" text={error} danger /> : null}
      {!busy && api.configured && auth.state === 'authenticated' && orders.length === 0 ? <Empty icon="receipt-text-outline" title={segment === 'active' ? 'No active delivery' : 'No past orders'} body={segment === 'active' ? 'Once an order is placed, its progress appears here.' : 'Completed and cancelled orders stay here.'} /> : null}
      {/* Past orders open too: their receipt, and for a delivered one, rating the rider. */}
      {!busy && orders.map((order) => <OrderCard key={order.id} order={order} past={segment === 'past'} onPress={() => onTrack(order.id)} />)}
    </OrderPage>
  );
}

export function CustomerTrackingScreen({ orderId, onBack, onChat }: { orderId: string; onBack: () => void; onChat: (orderId: string) => void }) {
  const { palette } = useTheme();
  const auth = useAppSession();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [cancellation, setCancellation] = useState<{ allowed: boolean; explanation: string } | null>(null);
  const [busy, setBusy] = useState(api.configured);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<PaymentOutcome | null>(null);
  const [checking, setChecking] = useState(false);
  const [payProblem, setPayProblem] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [cancelNotice, setCancelNotice] = useState<string | null>(null);
  const [callProblem, setCallProblem] = useState<string | null>(null);
  const [memory, setMemory] = useState<RememberedOrder>({});
  // The poll and the AppState listener need the current status without
  // re-subscribing every time it changes.
  const statusRef = useRef<string | null>(null);
  // iOS suspension can finish an older read after a resume/poll has replaced it.
  const loadGeneration = useRef(0);
  const checkGeneration = useRef(0);

  const load = useCallback(async () => {
    if (!api.configured || auth.state !== 'authenticated') return;
    // No id means nothing to ask about — reached only if a route arrives
    // without params, and a request to /v1/orders/ would just 404.
    if (!orderId) {
      setBusy(false);
      setError('No order was selected.');
      return;
    }
    const generation = ++loadGeneration.current;
    const current = () => Platform.OS !== 'ios' || generation === loadGeneration.current;
    try {
      const response = await api.request<{ order: OrderDetail; cancellation?: { allowed: boolean; explanation: string } }>(
        `/v1/orders/${encodeURIComponent(orderId)}`,
      );
      if (!current()) return false;
      setOrder(response.order);
      setCancellation(response.cancellation ?? null);
      statusRef.current = response.order.status;
      setError(null);
      return true;
    } catch (caught) {
      if (current()) setError(caught instanceof ApiError ? caught.message : 'Could not refresh this delivery.');
      return false;
    } finally {
      if (current()) setBusy(false);
    }
  }, [auth.state, orderId]);

  /**
   * Ask the server — which asks Paystack — whether this order is paid. The
   * app never decides this for itself, and only ever asks about an order the
   * server still calls `payment_pending`.
   */
  const check = useCallback(async () => {
    if (!orderId || statusRef.current !== 'payment_pending') return;
    const generation = ++checkGeneration.current;
    const detailGeneration = loadGeneration.current;
    const current = () => Platform.OS !== 'ios' || generation === checkGeneration.current;
    // A later detail read can supersede this verification even without another check.
    const mayApply = () => current() && (Platform.OS !== 'ios' || detailGeneration === loadGeneration.current);
    setChecking(true);
    setPayProblem(null);
    try {
      const result = await verifyPayment(api, orderId);
      if (!mayApply()) return;
      setOutcome(result.payment.outcome);
      await load();
    } catch (caught) {
      if (mayApply()) setPayProblem(caught instanceof ApiError ? caught.message : 'Could not check this payment.');
    } finally {
      if (current()) setChecking(false);
    }
  }, [orderId, load]);

  useEffect(() => {
    if (!orderId) return;
    let live = true;
    void recallOrder(orderId).then((value) => {
      if (Platform.OS !== 'ios' || live) setMemory(value);
    });
    void load().then((loaded) => {
      if (Platform.OS !== 'ios' || (live && loaded)) return check();
    });
    return () => {
      live = false;
      if (Platform.OS !== 'ios') return;
      // Invalidate suspended work before an order change, logout or return to Orders.
      loadGeneration.current += 1;
      checkGeneration.current += 1;
    };
  }, [orderId, load, check]);

  // Back from Paystack's page, or reopened after being closed: check now.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      if (statusRef.current === 'payment_pending') void check();
      else void load();
    });
    return () => subscription.remove();
  }, [check, load]);

  useEffect(() => {
    if (!api.configured || auth.state !== 'authenticated') return;
    const timer = setInterval(() => {
      if (AppState.currentState === 'active' && statusRef.current && isActiveOrder(statusRef.current)) void load();
    }, 12_000);
    return () => clearInterval(timer);
  }, [auth.state, load]);

  const payAgain = async () => {
    if (!orderId) return;
    setActing(true);
    setPayProblem(null);
    try {
      const result = await retryPayment(api, orderId);
      if (result.payment.status === 'captured') {
        await load();
        return;
      }
      if (result.payment.authorizationUrl) {
        await rememberOrder(orderId, { authorizationUrl: result.payment.authorizationUrl });
        setOutcome(null);
        await Linking.openURL(result.payment.authorizationUrl);
      }
    } catch (caught) {
      setPayProblem(caught instanceof ApiError ? caught.message : 'Could not start a new payment.');
    } finally {
      setActing(false);
    }
  };

  const cancel = () => {
    Alert.alert('Cancel this order?', cancellation?.explanation ?? 'This cannot be undone.', [
      { text: 'Keep my order', style: 'cancel' },
      {
        text: 'Cancel order',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            setActing(true);
            try {
              const result = await cancelOrder(api, orderId);
              setCancelNotice(result.refund?.explanation ?? 'Your order was cancelled.');
              await load();
            } catch (caught) {
              setCancelNotice(caught instanceof ApiError ? caught.message : 'Could not cancel this order.');
            } finally {
              setActing(false);
            }
          })();
        },
      },
    ]);
  };

  if (busy && !order) return <OrderPage><BackHeader title="Track order" onBack={onBack} /><View style={{ minHeight: 300, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={palette.accent} /></View></OrderPage>;
  if (!order) {
    return (
      <OrderPage>
        <BackHeader title="Track order" onBack={onBack} />
        {!api.configured
          ? <Empty icon="cloud-off-outline" title="Not connected to DASH" body="This build has no DASH API address, so there is no order to track." />
          : <Empty icon="map-marker-off-outline" title="Tracking unavailable" body={error ?? 'We could not load this order.'} />}
      </OrderPage>
    );
  }

  const destination = order.address ? { latitude: order.address.latitude, longitude: order.address.longitude } : null;
  const rider = order.rider?.latitude != null && order.rider.longitude != null ? { latitude: order.rider.latitude, longitude: order.rider.longitude } : null;
  const showMap = destination && rider && !['delivered', 'cancelled', 'rejected', 'refunded'].includes(order.status);
  // Only the rider assigned to this order, only while they are working it.
  const callUrl = riderCallUrl(order);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: palette.background }} contentContainerStyle={{ paddingBottom: space.xxxl }}>
      <View style={{ paddingHorizontal: space.gutter }}><BackHeader title={`Order ${order.code}`} onBack={onBack} /></View>
      {showMap ? (
        <MapShell directLine rider={rider} destination={destination} routeColor={palette.map.routeToCustomer} height={350} destinationIcon="home" destinationKind="dropoff" accessibilityLabel="Your rider's last reported position and your address" />
      ) : (
        <View style={{ marginHorizontal: space.gutter }}><Notice icon="map-clock-outline" text={order.status === 'delivered' ? 'This delivery is complete, so rider location is no longer shared.' : 'The live map appears after a rider is assigned and has reported a current location.'} /></View>
      )}
      <View style={{ padding: space.gutter, gap: space.lg }}>
        <View><Text variant="title">{order.statusLabel}</Text><Text variant="caption" tone="muted">{order.vendor.name} · {order.items.reduce((total, item) => total + item.quantity, 0)} items</Text></View>
        {order.rider ? <Card><View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}><View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: palette.inverse, alignItems: 'center', justifyContent: 'center' }}><Icon name="moped" color={palette.textOnInverse} /></View><View style={{ flex: 1 }}><Text variant="label" weight="bold">{order.rider.name ?? 'Your DASH rider'}</Text><Text variant="caption" tone={order.rider.isStale ? 'muted' : 'success'}>{order.rider.isStale ? 'Location temporarily delayed' : 'Location updated recently'}</Text></View></View></Card> : null}
        {callUrl ? (
          <PrimaryCheckoutButton
            label={`Call ${order.rider?.name ?? 'your rider'}`}
            onPress={() => {
              setCallProblem(null);
              void Linking.openURL(callUrl).catch(() => setCallProblem(`Your phone could not start the call. Dial ${callUrl.slice(4)} instead.`));
            }}
          />
        ) : null}
        {callProblem ? <Notice icon="phone-alert-outline" text={callProblem} danger /> : null}
        {order.rider ? <SecondaryButton label="Message your rider" onPress={() => onChat(order.id)} /> : null}
        {order.riderRating ? <RateRiderCard orderId={order.id} state={order.riderRating} /> : null}
        <PaymentSection
          status={order.status}
          outcome={outcome}
          checking={checking}
          acting={acting}
          problem={payProblem}
          onCheck={() => void check()}
          onPayAgain={() => void payAgain()}
        />
        <ProgressTimeline current={order.status} />
        <Receipt order={order} />
        {/* Shown once, from the placement response, to read to the rider at
            the door. It is never fetched again. */}
        {memory.deliveryPin && isActiveOrder(order.status) ? (
          <View style={{ padding: space.lg, borderRadius: radius.lg, backgroundColor: palette.inverse, alignItems: 'center', gap: space.xs }}>
            <Text variant="micro" tone="onInverse">DELIVERY PIN</Text>
            <Text variant="display" tone="onInverse" accessibilityLabel={`Delivery PIN ${memory.deliveryPin.split('').join(' ')}`}>{memory.deliveryPin}</Text>
            <Text variant="micro" tone="onInverse">Share only when the order reaches you</Text>
          </View>
        ) : null}
        <RefundSection refunds={order.refunds} />
        {cancelNotice ? <Notice icon="information-outline" text={cancelNotice} /> : null}
        {cancellation?.allowed && !cancelNotice ? (
          <>
            <Text variant="micro" tone="muted">{cancellation.explanation}</Text>
            <SecondaryButton label={acting ? 'Working…' : 'Cancel this order'} onPress={cancel} disabled={acting} />
          </>
        ) : null}
        {order.address ? <Card><Text variant="micro" tone="muted">Delivering to</Text><Text variant="label" weight="bold">{order.address.line1}</Text>{order.address.landmark ? <Text variant="caption" tone="muted">{order.address.landmark}</Text> : null}</Card> : null}
        {error ? <Notice icon="alert-circle-outline" text={error} danger /> : null}
      </View>
    </ScrollView>
  );
}

/**
 * Payment, while the server still calls the order `payment_pending`.
 *
 * The app decides nothing here. "Check payment" asks the server, which asks
 * Paystack, and the answer is worded by `describeOutcome` — tested in
 * src/data/orders.ts — so only `captured` reads as success. "Pay again" is
 * offered only where that wording says a retry is the right move, which is
 * what keeps a customer from paying twice for an order that is merely slow
 * to settle.
 */
function PaymentSection({
  status,
  outcome,
  checking,
  acting,
  problem,
  onCheck,
  onPayAgain,
}: {
  status: string;
  outcome: PaymentOutcome | null;
  checking: boolean;
  acting: boolean;
  problem: string | null;
  onCheck: () => void;
  onPayAgain: () => void;
}) {
  const { palette } = useTheme();
  if (status !== 'payment_pending' && !outcome) return null;
  const said = outcome ? describeOutcome(outcome) : null;
  // A newer server order status can supersede an earlier retryable check.
  // Do not offer another payment on iOS or invent a replacement payment outcome.
  if (Platform.OS === 'ios' && status !== 'payment_pending' && said?.canRetry) return null;
  const tone = said?.tone === 'success' ? palette.success : said?.tone === 'problem' ? palette.danger : palette.accent;
  return (
    <Card>
      <Text variant="label" weight="bold">Payment</Text>
      {said ? (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <Icon name={said.tone === 'success' ? 'check-decagram-outline' : said.tone === 'waiting' ? 'clock-outline' : 'alert-circle-outline'} color={tone} size={18} />
            <Text variant="label" weight="bold" style={{ flex: 1, color: tone }}>{said.title}</Text>
          </View>
          <Text variant="caption" tone="muted">{said.body}</Text>
        </>
      ) : (
        <Text variant="caption" tone="muted">This order is waiting for payment. If you have already paid, check below — do not pay again.</Text>
      )}
      {problem ? <Notice icon="alert-circle-outline" text={problem} danger /> : null}
      {status === 'payment_pending' ? <SecondaryButton label={checking ? 'Checking…' : 'Check payment'} onPress={onCheck} disabled={checking || acting} /> : null}
      {said?.canRetry ? <PrimaryCheckoutButton label={acting ? 'Opening Paystack…' : 'Pay again'} onPress={onPayAgain} disabled={acting || checking} busy={acting} /> : null}
    </Card>
  );
}

/**
 * Money owed back, in the server's words.
 *
 * The wording and the state are both the server's: `label` and `body` come
 * down with the refund, and `refundTone` (tested in src/data/orders.ts) is
 * the only thing that decides what reads as settled. Nothing here says
 * "refunded" on its own — that word appears only once Paystack has confirmed
 * the money went back, which is why a pending refund stays bronze rather
 * than green.
 */
/** What was bought, at the prices paid, as the order froze it at checkout. */
function Receipt({ order }: { order: OrderDetail }) {
  const { palette } = useTheme();
  const rows = quoteRows(order);
  return (
    <Card>
      <Text variant="label" weight="bold">Your order</Text>
      {order.items.map((item, index) => (
        <View key={`${item.nameSnapshot}-${index}`} style={{ flexDirection: 'row', gap: space.sm }}>
          <Text variant="caption" tone="accent">{item.quantity}×</Text>
          <Text variant="caption" style={{ flex: 1 }}>{item.nameSnapshot}</Text>
          <Text variant="caption">{formatNaira(item.lineTotal)}</Text>
        </View>
      ))}
      <View style={{ height: 1, backgroundColor: palette.line }} />
      {rows.map((row) => (
        <View key={row.label} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text variant="caption" tone="muted">{row.label}</Text>
          <Text variant="caption" tone="muted">{row.negative ? '−' : ''}{formatNaira(row.amount)}</Text>
        </View>
      ))}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text variant="label" weight="bold">Total</Text>
        <Text variant="label" weight="bold">{formatNaira(order.total)}</Text>
      </View>
      <Text variant="micro" tone="muted">Order {order.code} · placed {new Date(order.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</Text>
    </Card>
  );
}

function RefundSection({ refunds }: { refunds: OrderDetail['refunds'] }) {
  const { palette } = useTheme();
  if (!refunds || refunds.length === 0) return null;
  const toneColour = { success: palette.success, danger: palette.danger, accent: palette.accent } as const;
  return (
    <Card>
      <Text variant="label" weight="bold">Refund</Text>
      {refunds.map((refund, index) => {
        const tone = refundTone(refund.status);
        return (
          <View key={`${refund.createdAt}-${index}`} style={{ gap: space.xs }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <Icon name={tone === 'success' ? 'check-decagram-outline' : tone === 'danger' ? 'alert-circle-outline' : 'clock-outline'} color={toneColour[tone]} size={18} />
              <Text variant="label" weight="bold" style={{ flex: 1, color: toneColour[tone] }}>{refund.label}</Text>
              <Text variant="label" weight="bold">{formatNairaCompact(refund.amount)}</Text>
            </View>
            <Text variant="caption" tone="muted">{refund.body}</Text>
            {refund.refundedAt ? <Text variant="micro" tone="muted">Returned {new Date(refund.refundedAt).toLocaleDateString()}</Text> : null}
          </View>
        );
      })}
    </Card>
  );
}

function OrderCard({ order, onPress, past = false }: { order: OrderSummary; onPress?: () => void; past?: boolean }) {
  const { palette } = useTheme();
  const content = <><View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space.md }}><View style={{ flex: 1 }}><Text variant="label" weight="bold">{order.vendor.name}</Text><Text variant="micro" tone="muted">{order.code} · {new Date(order.createdAt).toLocaleDateString()}</Text></View><Text variant="caption" tone={order.status === 'delivered' ? 'success' : 'accent'} weight="bold">{order.statusLabel}</Text></View><Text variant="caption" tone="muted">{order.items.map((item) => `${item.quantity}× ${item.nameSnapshot}`).join(' · ')}</Text><View style={{ flexDirection: 'row', alignItems: 'center' }}><Text variant="label" weight="bold" style={{ flex: 1 }}>{formatNairaCompact(order.total as Kobo)}</Text>{onPress ? <><Text variant="caption" tone="accent" weight="bold">{past ? 'View order' : 'Track order'}</Text><Icon name="chevron-right" color={palette.accent} /></> : null}</View></>;
  const style = { padding: space.lg, gap: space.md, borderRadius: radius.lg, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line } as const;
  return onPress ? <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${past ? 'View' : 'Track'} ${order.code}`} style={style}>{content}</Pressable> : <View style={style}>{content}</View>;
}

function ProgressTimeline({ current }: { current: string }) {
  const { palette } = useTheme();
  const steps = ['Order confirmed', 'Preparing', 'Rider assigned', 'On the way', 'Delivered'];
  const index = current === 'delivered' ? 4 : current === 'en_route' || current === 'arrived' ? 3 : current.startsWith('rider_') || current === 'picked_up' ? 2 : current === 'preparing' || current === 'ready' ? 1 : 0;
  return <Card><Text variant="label" weight="bold">Delivery progress</Text>{steps.map((step, position) => <View key={step} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}><View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: position <= index ? palette.success : palette.surfaceMuted, alignItems: 'center', justifyContent: 'center' }}>{position <= index ? <Icon name="check" size={14} color="#FFFFFF" /> : null}</View><Text variant="caption" tone={position <= index ? 'default' : 'muted'} weight={position === index ? 'bold' : 'medium'}>{step}</Text></View>)}</Card>;
}
