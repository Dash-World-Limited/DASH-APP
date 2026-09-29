import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { formatNairaCompact, type Kobo } from '@dash/domain/money';

import { api, ApiError } from '../../api';
import { useCart } from '../../features/CartProvider';
import { MapShell } from '../../rider/MapShell';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, space, touchTarget } from '../../theme/tokens';
import { Icon, type IconName } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import { useAppSession } from '../auth/AppSessionProvider';

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
}

const PREVIEW_ACTIVE: OrderSummary = {
  id: 'preview-order-active',
  code: 'DASH782910',
  status: 'en_route',
  statusLabel: 'On the way to you',
  phase: 'delivery',
  total: 18_400_00,
  createdAt: new Date().toISOString(),
  vendor: { name: 'Urban Bites', slug: 'urban-bites', category: 'restaurant' },
  items: [{ nameSnapshot: 'Spicy Chicken Burger', quantity: 1 }, { nameSnapshot: 'French Fries (Large)', quantity: 1 }],
};

const PREVIEW_PAST: OrderSummary[] = [
  { ...PREVIEW_ACTIVE, id: 'preview-order-past-1', code: 'DASH710842', status: 'delivered', statusLabel: 'Delivered', phase: 'complete', total: 12_800_00, createdAt: new Date(Date.now() - 86_400_000).toISOString() },
  { ...PREVIEW_ACTIVE, id: 'preview-order-past-2', code: 'DASH692015', status: 'delivered', statusLabel: 'Delivered', phase: 'complete', total: 9_600_00, vendor: { name: 'Wellspring Pharmacy', slug: 'wellspring', category: 'pharmacy' }, createdAt: new Date(Date.now() - 4 * 86_400_000).toISOString() },
];

export function CustomerCheckoutScreen({ onBack, onAccount, onTrack }: { onBack: () => void; onAccount: () => void; onTrack: (id: string) => void }) {
  const { palette } = useTheme();
  const auth = useAppSession();
  const { cart, count, dispatch } = useCart();
  const [placing, setPlacing] = useState(false);

  if (cart.lines.length === 0) {
    return <OrderPage><BackHeader title="Checkout" onBack={onBack} /><Empty icon="cart-outline" title="Your cart is empty" body="Add an item before checking out." action="Go back" onPress={onBack} /></OrderPage>;
  }

  const placePreview = () => {
    setPlacing(true);
    setTimeout(() => {
      dispatch({ type: 'clear' });
      setPlacing(false);
      onTrack(PREVIEW_ACTIVE.id);
    }, 500);
  };

  return (
    <OrderPage>
      <BackHeader title="Checkout" onBack={onBack} />
      {!api.configured ? <Notice icon="flask-outline" text="Interactive checkout preview. It creates no charge and sends no real order." /> : null}
      <Card><View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}><Icon name="storefront-outline" color={palette.accent} /><View style={{ flex: 1 }}><Text variant="micro" tone="muted">Merchant</Text><Text variant="label" weight="bold">{cart.merchantSlug?.replace(/-/g, ' ') ?? 'DASH merchant'}</Text></View><Text variant="caption" tone="muted">{count} item{count === 1 ? '' : 's'}</Text></View></Card>
      <Card><Text variant="label" weight="bold">Delivery address</Text><View style={{ flexDirection: 'row', gap: space.md, alignItems: 'center' }}><Icon name="map-marker-outline" color={palette.accent} /><View style={{ flex: 1 }}><Text variant="caption">Chevron Drive, Lekki</Text><Text variant="micro" tone="muted">Preview address · choose a saved address when signed in</Text></View></View></Card>
      <Card><Text variant="label" weight="bold">Payment</Text><View style={{ flexDirection: 'row', gap: space.md, alignItems: 'center' }}><Icon name="credit-card-outline" color={palette.accent} /><View style={{ flex: 1 }}><Text variant="caption">Payment authorization comes from the server</Text><Text variant="micro" tone="muted">The app never invents fees or payable totals.</Text></View></View></Card>
      {api.configured && auth.state !== 'authenticated' ? <Empty icon="account-lock-outline" title="Sign in to continue" body="Your secured account, address and payment method are required." action="Open account" onPress={onAccount} /> : null}
      {!api.configured ? <PrimaryCheckoutButton label={placing ? 'Placing preview order…' : 'Place preview order'} disabled={placing} onPress={placePreview} /> : null}
      {api.configured && auth.state === 'authenticated' ? <Notice icon="map-marker-alert-outline" text="Select a verified saved address before requesting the server-owned quote and payment authorization." /> : null}
    </OrderPage>
  );
}

export function CustomerOrdersScreen({ onTrack, onAccount }: { onTrack: (id: string) => void; onAccount: () => void }) {
  const { palette } = useTheme();
  const auth = useAppSession();
  const [segment, setSegment] = useState<'active' | 'past'>('active');
  const [orders, setOrders] = useState<OrderSummary[]>(api.configured ? [] : [PREVIEW_ACTIVE]);
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
      setOrders(segment === 'active' ? [PREVIEW_ACTIVE] : PREVIEW_PAST);
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
      {!api.configured ? <Notice icon="flask-outline" text="Interactive preview orders. Live history appears after the staging API is connected and you sign in." /> : null}
      {api.configured && auth.state !== 'authenticated' ? <Empty icon="account-lock-outline" title="Sign in to see your orders" body="Order history belongs to your secured customer account." action="Open account" onPress={onAccount} /> : null}
      {busy ? <View style={{ minHeight: 180, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={palette.accent} /></View> : null}
      {error ? <Notice icon="alert-circle-outline" text={error} danger /> : null}
      {!busy && (!api.configured || auth.state === 'authenticated') && orders.length === 0 ? <Empty icon="receipt-text-outline" title={segment === 'active' ? 'No active delivery' : 'No past orders'} body={segment === 'active' ? 'Once an order is placed, its progress appears here.' : 'Completed and cancelled orders stay here.'} /> : null}
      {!busy && orders.map((order) => <OrderCard key={order.id} order={order} onPress={segment === 'active' ? () => onTrack(order.id) : undefined} />)}
    </OrderPage>
  );
}

export function CustomerTrackingScreen({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const { palette } = useTheme();
  const auth = useAppSession();
  const [order, setOrder] = useState<OrderDetail | null>(() => api.configured ? null : previewDetail());
  const [busy, setBusy] = useState(api.configured);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!api.configured || auth.state !== 'authenticated') return;
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
  if (!order) return <OrderPage><BackHeader title="Track order" onBack={onBack} /><Empty icon="map-marker-off-outline" title="Tracking unavailable" body={error ?? 'We could not load this order.'} /></OrderPage>;

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
        {!api.configured ? <View style={{ padding: space.lg, borderRadius: radius.lg, backgroundColor: palette.inverse, alignItems: 'center', gap: space.xs }}><Text variant="micro" tone="onInverse">DELIVERY PIN</Text><Text variant="display" tone="onInverse">2468</Text><Text variant="micro" tone="onInverse">Share only when the order reaches you</Text></View> : null}
        {order.address ? <Card><Text variant="micro" tone="muted">Delivering to</Text><Text variant="label" weight="bold">{order.address.line1}</Text>{order.address.landmark ? <Text variant="caption" tone="muted">{order.address.landmark}</Text> : null}</Card> : null}
        {error ? <Notice icon="alert-circle-outline" text={error} danger /> : null}
      </View>
    </ScrollView>
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

function previewDetail(): OrderDetail {
  return {
    ...PREVIEW_ACTIVE,
    branch: { name: 'Urban Bites', address: '12 Admiralty Way, Lekki Phase 1', latitude: 6.4474, longitude: 3.4722 },
    address: { line1: 'Chevron Drive, Lekki', landmark: 'Near the second gate', instructions: 'Please call when you arrive.', latitude: 6.4384, longitude: 3.5262 },
    statusEvents: [],
    rider: { name: 'Daniel', vehicleType: 'motorcycle', latitude: 6.4412, longitude: 3.505, reportedAt: new Date().toISOString(), isStale: false },
  };
}

function OrderPage({ children }: { children: ReactNode }) {
  const { palette } = useTheme();
  return <ScrollView style={{ flex: 1, backgroundColor: palette.background }} contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: space.xxxl, gap: space.lg }} showsVerticalScrollIndicator={false}>{children}</ScrollView>;
}

function BackHeader({ title, onBack }: { title: string; onBack: () => void }) {
  const { palette } = useTheme();
  return <View style={{ minHeight: 54, flexDirection: 'row', alignItems: 'center' }}><Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Go back" style={{ width: touchTarget, height: touchTarget, alignItems: 'center', justifyContent: 'center' }}><Icon name="arrow-left" color={palette.text} /></Pressable><Text variant="appBar">{title}</Text></View>;
}

function Card({ children }: { children: ReactNode }) {
  const { palette } = useTheme();
  return <View style={{ padding: space.lg, gap: space.md, borderRadius: radius.lg, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line }}>{children}</View>;
}

function Notice({ icon, text, danger = false }: { icon: IconName; text: string; danger?: boolean }) {
  const { palette } = useTheme();
  return <View style={{ flexDirection: 'row', gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: danger ? palette.dangerSoft : palette.accentSoft }}><Icon name={icon} color={danger ? palette.danger : palette.accent} /><Text variant="caption" style={{ flex: 1, color: danger ? palette.danger : palette.text }}>{text}</Text></View>;
}

function Empty({ icon, title, body, action, onPress }: { icon: IconName; title: string; body: string; action?: string; onPress?: () => void }) {
  const { palette } = useTheme();
  return <View style={{ minHeight: 250, alignItems: 'center', justifyContent: 'center', gap: space.sm, padding: space.xl }}><View style={{ width: 68, height: 68, borderRadius: 22, backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name={icon} size={32} color={palette.accent} /></View><Text variant="heading" align="center">{title}</Text><Text variant="caption" tone="muted" align="center">{body}</Text>{action && onPress ? <Pressable onPress={onPress} style={{ minHeight: 46, justifyContent: 'center', paddingHorizontal: space.xl, borderRadius: radius.md, backgroundColor: palette.accent }}><Text variant="caption" tone="onAccent" weight="bold">{action}</Text></Pressable> : null}</View>;
}

function PrimaryCheckoutButton({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  const { palette } = useTheme();
  return <Pressable disabled={disabled} onPress={onPress} accessibilityRole="button" accessibilityState={{ disabled }} style={({ pressed }) => ({ minHeight: 52, borderRadius: radius.md, opacity: disabled ? 0.55 : 1, backgroundColor: pressed ? palette.accentPressed : palette.accent, alignItems: 'center', justifyContent: 'center' })}><Text variant="label" tone="onAccent" weight="bold">{label}</Text></Pressable>;
}

function interpolateRoute(start: { latitude: number; longitude: number }, end: { latitude: number; longitude: number }) {
  return Array.from({ length: 7 }, (_, index) => {
    const amount = index / 6;
    return { latitude: start.latitude + (end.latitude - start.latitude) * amount + (index === 2 ? 0.001 : 0), longitude: start.longitude + (end.longitude - start.longitude) * amount - (index === 4 ? 0.0012 : 0) };
  });
}
