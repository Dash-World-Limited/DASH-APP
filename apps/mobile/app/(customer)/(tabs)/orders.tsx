/**
 * Orders — the customer's history, from the server.
 *
 * Active orders first, then past ones. Every row opens the order screen,
 * which is where payment is checked and progress is followed. Nothing here is
 * fixture data: a build that is not connected to a server, or a person who is
 * not signed in, is told so rather than shown sample orders.
 *
 * Refreshed whenever the tab gains focus and when the app returns to the
 * foreground, so the list is never older than the last look at it.
 */

import { formatNairaCompact } from '@dash/domain/money';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Pressable, View } from 'react-native';

import { api } from '../../../src/api';
import { ApiError } from '../../../src/api/errors';
import { isActiveOrder, listOrders, type OrderSummary } from '../../../src/data/orders';
import { useAuth } from '../../../src/features/AuthProvider';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { radius, space } from '../../../src/theme/tokens';
import { Card, EmptyState, ErrorState, Screen, Skeleton, StatusPill, Text } from '../../../src/ui';

export default function Orders() {
  const router = useRouter();
  const auth = useAuth();
  const [orders, setOrders] = useState<OrderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const signedIn = auth.state === 'authenticated';

  const load = useCallback(async () => {
    if (!signedIn) return;
    try {
      setOrders(await listOrders(api, 'all'));
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Your orders could not load.');
    }
  }, [signedIn]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void load();
    });
    return () => subscription.remove();
  }, [load]);

  const header = (
    <Text variant="title" style={{ paddingHorizontal: space.gutter, paddingTop: space.md }} accessibilityRole="header">
      Orders
    </Text>
  );

  if (!auth.configured) {
    return (
      <Screen>
        {header}
        <EmptyState icon="cloud-off-outline" title="Not connected" body="This build is not connected to a DASH server, so it has no orders to show." />
      </Screen>
    );
  }
  if (auth.state === 'restoring') {
    return (
      <Screen>
        {header}
        <View style={{ padding: space.gutter, gap: space.md }}>
          <Skeleton style={{ height: 76, borderRadius: radius.md }} />
          <Skeleton style={{ height: 76, borderRadius: radius.md }} />
        </View>
      </Screen>
    );
  }
  if (!signedIn) {
    return (
      <Screen>
        {header}
        <EmptyState icon="receipt-text-outline" title="Sign in to see your orders" body="Your orders follow your account." action="Sign in" onAction={() => router.push('/sign-in')} />
      </Screen>
    );
  }
  if (error && !orders) {
    return (
      <Screen>
        {header}
        <View style={{ padding: space.gutter }}>
          <ErrorState title="Orders could not load" message={error} onRetry={() => void load()} />
        </View>
      </Screen>
    );
  }
  if (!orders) {
    return (
      <Screen>
        {header}
        <View style={{ padding: space.gutter, gap: space.md }} accessibilityLabel="Loading your orders">
          <Skeleton style={{ height: 76, borderRadius: radius.md }} />
          <Skeleton style={{ height: 76, borderRadius: radius.md }} />
        </View>
      </Screen>
    );
  }
  if (orders.length === 0) {
    return (
      <Screen>
        {header}
        <EmptyState
          icon="receipt-text-outline"
          title="No orders yet"
          body="When you place an order, you can follow it here from the shop to your door."
          action="Browse Shops"
          onAction={() => router.push('/shops')}
        />
      </Screen>
    );
  }

  const active = orders.filter((order) => isActiveOrder(order.status));
  const past = orders.filter((order) => !isActiveOrder(order.status));

  return (
    <Screen testID="orders">
      {header}
      <View style={{ paddingHorizontal: space.gutter, paddingTop: space.md, gap: space.lg }}>
        {active.length > 0 ? <Section title="Active" orders={active} /> : null}
        {past.length > 0 ? <Section title="Past" orders={past} /> : null}
      </View>
    </Screen>
  );
}

function Section({ title, orders }: { title: string; orders: OrderSummary[] }) {
  return (
    <View style={{ gap: space.sm }}>
      <Text variant="heading">{title}</Text>
      {orders.map((order) => (
        <OrderRow key={order.id} order={order} />
      ))}
    </View>
  );
}

function OrderRow({ order }: { order: OrderSummary }) {
  const router = useRouter();
  const { palette } = useTheme();
  const items = order.items.map((item) => `${item.quantity} × ${item.nameSnapshot}`).join(', ');
  return (
    <Pressable
      onPress={() => router.push(`/order/${order.id}`)}
      accessibilityRole="button"
      accessibilityLabel={`${order.vendor.name}, ${order.statusLabel}, ${formatNairaCompact(order.total)}`}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.sm, minHeight: 44 }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="bodyStrong" weight="bold" numberOfLines={1}>
              {order.vendor.name}
            </Text>
            <Text variant="caption" tone="muted" numberOfLines={1}>
              {items}
            </Text>
            <Text variant="caption" style={{ color: palette.textMuted }}>
              {new Date(order.createdAt).toLocaleDateString()} · {formatNairaCompact(order.total)}
            </Text>
          </View>
          <StatusPill label={order.statusLabel} tone={order.status === 'cancelled' || order.status === 'rejected' ? 'danger' : order.status === 'delivered' ? 'success' : 'accent'} />
        </View>
      </Card>
    </Pressable>
  );
}
