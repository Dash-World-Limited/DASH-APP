import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { formatNairaCompact, type Kobo } from '@dash/domain/money';

import { api, ApiError } from '../../api';
import { refundTone } from '../../data/orders';
import { MapShell } from '../../rider/MapShell';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, space } from '../../theme/tokens';
import { Icon } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import { useAppSession } from '../auth/AppSessionProvider';
import { BackHeader, Card, Empty, Notice, OrderPage } from './parts';

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
  branch: { name: string; address: string; latitude: number; longitude: number };
  address: { line1: string; landmark: string | null; instructions: string | null; latitude: number; longitude: number } | null;
  statusEvents: Array<{ toStatus: string; createdAt: string }>;
  rider: { name: string | null; vehicleType: string; latitude: number | null; longitude: number | null; reportedAt: string | null; isStale: boolean } | null;
  /**
   * Refunds owed on this order, worded by the server. Optional because an
   * older server omits the field entirely — which reads as "no refunds", not
   * as an error.
   */
  refunds?: Array<{ amount: Kobo; status: string; label: string; body: string; refundedAt: string | null; createdAt: string }>;
}

export function CustomerOrdersScreen({ onTrack, onAccount }: { onTrack: (id: string) => void; onAccount: () => void }) {
  const { palette } = useTheme();
  const auth = useAppSession();
  const [segment, setSegment] = useState<'active' | 'past'>('active');
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [busy, setBusy] = useState(api.configured);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!api.configured || auth.state !== 'authenticated') return;
    setBusy(true);
    setError(null);
    try {
      const response = await api.request<{ orders: OrderSummary[] }>(`/v1/orders?status=${segment}&limit=20`);
      setOrders(response.orders);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load your orders.');
    } finally {
      setBusy(false);
    }
  }, [auth.state, segment]);

  useEffect(() => {
    if (!api.configured) {
      setBusy(false);
      return;
    }
    void load();
  }, [load, segment]);

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
      {!busy && orders.map((order) => <OrderCard key={order.id} order={order} onPress={segment === 'active' ? () => onTrack(order.id) : undefined} />)}
    </OrderPage>
  );
}

export function CustomerTrackingScreen({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const { palette } = useTheme();
  const auth = useAppSession();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [busy, setBusy] = useState(api.configured);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!api.configured || auth.state !== 'authenticated') return;
    // No id means nothing to ask about — reached only if a route arrives
    // without params, and a request to /v1/orders/ would just 404.
    if (!orderId) {
      setBusy(false);
      setError('No order was selected.');
      return;
    }
    setBusy(true);
    try {
      const response = await api.request<{ order: OrderDetail }>(`/v1/orders/${encodeURIComponent(orderId)}`);
      setOrder(response.order);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not refresh this delivery.');
    } finally {
      setBusy(false);
    }
  }, [auth.state, orderId]);

  useEffect(() => {
    void load();
    if (!api.configured || auth.state !== 'authenticated') return;
    const timer = setInterval(() => void load(), 12_000);
    return () => clearInterval(timer);
  }, [auth.state, load]);

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

  return (
    <ScrollView style={{ flex: 1, backgroundColor: palette.background }} contentContainerStyle={{ paddingBottom: space.xxxl }}>
      <View style={{ paddingHorizontal: space.gutter }}><BackHeader title={`Order ${order.code}`} onBack={onBack} /></View>
      {showMap ? (
        <MapShell route={interpolateRoute(rider, destination)} rider={rider} destination={destination} routeColor={palette.map.routeToCustomer} height={350} destinationIcon="home" accessibilityLabel="Live delivery route to your address" />
      ) : (
        <View style={{ marginHorizontal: space.gutter }}><Notice icon="map-clock-outline" text={order.status === 'delivered' ? 'This delivery is complete, so rider location is no longer shared.' : 'The live map appears after a rider is assigned and has reported a current location.'} /></View>
      )}
      <View style={{ padding: space.gutter, gap: space.lg }}>
        {!api.configured ? <Notice icon="flask-outline" text="Interactive tracking preview. The real screen polls the protected order endpoint and uses only server-accepted rider coordinates." /> : null}
        <View><Text variant="title">{order.statusLabel}</Text><Text variant="caption" tone="muted">{order.vendor.name} · {order.items.reduce((total, item) => total + item.quantity, 0)} items</Text></View>
        {order.rider ? <Card><View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}><View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: palette.inverse, alignItems: 'center', justifyContent: 'center' }}><Icon name="moped" color={palette.textOnInverse} /></View><View style={{ flex: 1 }}><Text variant="label" weight="bold">{order.rider.name ?? 'Your DASH rider'}</Text><Text variant="caption" tone={order.rider.isStale ? 'muted' : 'success'}>{order.rider.isStale ? 'Location temporarily delayed' : 'Location updated recently'}</Text></View></View></Card> : null}
        <ProgressTimeline current={order.status} />
        <RefundSection refunds={order.refunds} />
        {order.address ? <Card><Text variant="micro" tone="muted">Delivering to</Text><Text variant="label" weight="bold">{order.address.line1}</Text>{order.address.landmark ? <Text variant="caption" tone="muted">{order.address.landmark}</Text> : null}</Card> : null}
        {error ? <Notice icon="alert-circle-outline" text={error} danger /> : null}
      </View>
    </ScrollView>
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

function OrderCard({ order, onPress }: { order: OrderSummary; onPress?: () => void }) {
  const { palette } = useTheme();
  const content = <><View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space.md }}><View style={{ flex: 1 }}><Text variant="label" weight="bold">{order.vendor.name}</Text><Text variant="micro" tone="muted">{order.code} · {new Date(order.createdAt).toLocaleDateString()}</Text></View><Text variant="caption" tone={order.status === 'delivered' ? 'success' : 'accent'} weight="bold">{order.statusLabel}</Text></View><Text variant="caption" tone="muted">{order.items.map((item) => `${item.quantity}× ${item.nameSnapshot}`).join(' · ')}</Text><View style={{ flexDirection: 'row', alignItems: 'center' }}><Text variant="label" weight="bold" style={{ flex: 1 }}>{formatNairaCompact(order.total as Kobo)}</Text>{onPress ? <><Text variant="caption" tone="accent" weight="bold">Track order</Text><Icon name="chevron-right" color={palette.accent} /></> : null}</View></>;
  const style = { padding: space.lg, gap: space.md, borderRadius: radius.lg, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line } as const;
  return onPress ? <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Track ${order.code}`} style={style}>{content}</Pressable> : <View style={style}>{content}</View>;
}

function ProgressTimeline({ current }: { current: string }) {
  const { palette } = useTheme();
  const steps = ['Order confirmed', 'Preparing', 'Rider assigned', 'On the way', 'Delivered'];
  const index = current === 'delivered' ? 4 : current === 'en_route' || current === 'arrived' ? 3 : current.startsWith('rider_') || current === 'picked_up' ? 2 : current === 'preparing' || current === 'ready' ? 1 : 0;
  return <Card><Text variant="label" weight="bold">Delivery progress</Text>{steps.map((step, position) => <View key={step} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}><View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: position <= index ? palette.success : palette.surfaceMuted, alignItems: 'center', justifyContent: 'center' }}>{position <= index ? <Icon name="check" size={14} color="#FFFFFF" /> : null}</View><Text variant="caption" tone={position <= index ? 'default' : 'muted'} weight={position === index ? 'bold' : 'medium'}>{step}</Text></View>)}</Card>;
}

function interpolateRoute(start: { latitude: number; longitude: number }, end: { latitude: number; longitude: number }) {
  return Array.from({ length: 7 }, (_, index) => {
    const amount = index / 6;
    return { latitude: start.latitude + (end.latitude - start.latitude) * amount + (index === 2 ? 0.001 : 0), longitude: start.longitude + (end.longitude - start.longitude) * amount - (index === 4 ? 0.0012 : 0) };
  });
}
