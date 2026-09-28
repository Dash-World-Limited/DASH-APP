/**
 * One order: its payment, its progress, and what to do next.
 *
 * Payment. While an order is `payment_pending` this screen asks the server to
 * check with Paystack — when it opens, whenever the app comes back to the
 * foreground (the customer returning from Paystack's page), and when the
 * customer taps Check payment. It never decides for itself: the outcome is
 * the server's, worded by `describeOutcome`. "Pay again" is offered only when
 * the server says the payment did not go through or was not finished.
 *
 * Progress. The status, its history and the rider come from the server, which
 * is asked again every fifteen seconds while the order is moving and the app
 * is in the foreground — and immediately after the app is reopened, so an
 * interrupted session lands on the truth.
 *
 * The delivery PIN was returned once at checkout and is read from this
 * phone's secure store; the server never repeats it.
 */

import { formatNairaCompact } from '@dash/domain/money';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, View } from 'react-native';

import { api } from '../../../src/api';
import { ApiError } from '../../../src/api/errors';
import {
  cancelOrder,
  describeOutcome,
  getOrder,
  isActiveOrder,
  quoteRows,
  refundTone,
  retryPayment,
  verifyPayment,
  type OrderDetailResult,
  type PaymentOutcome,
} from '../../../src/data/orders';
import { recallOrder, rememberOrder, type RememberedOrder } from '../../../src/features/orderMemory';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { radius, space } from '../../../src/theme/tokens';
import { AppBar, Button, Card, Divider, ErrorState, Icon, Screen, Skeleton, StatusPill, Text } from '../../../src/ui';

const POLL_MS = 15_000;

const describeError = (error: unknown): string =>
  error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';

export default function OrderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { palette } = useTheme();

  const [detail, setDetail] = useState<OrderDetailResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [memory, setMemory] = useState<RememberedOrder>({});
  const [outcome, setOutcome] = useState<PaymentOutcome | null>(null);
  const [checking, setChecking] = useState(false);
  const [payProblem, setPayProblem] = useState<string | null>(null);
  const [cancelNotice, setCancelNotice] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const statusRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const result = await getOrder(api, id);
      setDetail(result);
      statusRef.current = result.order.status;
      setLoadError(null);
    } catch (error) {
      setLoadError(describeError(error));
    }
  }, [id]);

  /** Ask the server (which asks Paystack) whether this order is paid. */
  const check = useCallback(async () => {
    if (!id || statusRef.current !== 'payment_pending') return;
    setChecking(true);
    setPayProblem(null);
    try {
      const result = await verifyPayment(api, id);
      setOutcome(result.payment.outcome);
      await load();
    } catch (error) {
      setPayProblem(describeError(error));
    } finally {
      setChecking(false);
    }
  }, [id, load]);

  useEffect(() => {
    if (!id) return;
    void recallOrder(id).then(setMemory);
    void load().then(() => check());
  }, [id, load, check]);

  // Back from Paystack's page, or reopened after being closed: check now.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      if (statusRef.current === 'payment_pending') void check();
      else void load();
    });
    return () => subscription.remove();
  }, [check, load]);

  // Keep a moving order current while the screen is open and the app is up.
  useEffect(() => {
    const timer = setInterval(() => {
      if (AppState.currentState === 'active' && statusRef.current && isActiveOrder(statusRef.current)) void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  async function payAgain() {
    if (!id) return;
    setBusy(true);
    setPayProblem(null);
    try {
      const result = await retryPayment(api, id);
      if (result.payment.status === 'captured') {
        await load();
        return;
      }
      if (result.payment.authorizationUrl) {
        await rememberOrder(id, { authorizationUrl: result.payment.authorizationUrl });
        setMemory((current) => ({ ...current, authorizationUrl: result.payment.authorizationUrl }));
        setOutcome(null);
        await Linking.openURL(result.payment.authorizationUrl);
      }
    } catch (error) {
      setPayProblem(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!id) return;
    setBusy(true);
    try {
      const result = await cancelOrder(api, id);
      setCancelNotice(result.refund?.explanation ?? 'Your order was cancelled.');
      setConfirmingCancel(false);
      await load();
    } catch (error) {
      setCancelNotice(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  if (loadError && !detail) {
    return (
      <Screen>
        <AppBar title="Order" back />
        <View style={{ padding: space.gutter }}>
          <ErrorState title="This order could not load" message={loadError} onRetry={() => void load()} />
        </View>
      </Screen>
    );
  }
  if (!detail) {
    return (
      <Screen>
        <AppBar title="Order" back />
        <View style={{ padding: space.gutter, gap: space.md }} accessibilityLabel="Loading your order">
          <Skeleton style={{ height: 90, borderRadius: radius.md }} />
          <Skeleton style={{ height: 200, borderRadius: radius.md }} />
        </View>
      </Screen>
    );
  }

  const { order, cancellation } = detail;
  const awaitingPayment = order.status === 'payment_pending';
  const said = outcome ? describeOutcome(outcome) : null;
  const canPayAgain = awaitingPayment && (said?.canRetry ?? false);
  const moving = isActiveOrder(order.status) && !awaitingPayment;

  return (
    <Screen testID="order">
      <AppBar title={`Order ${order.code}`} back onBack={() => (router.canGoBack() ? router.back() : router.replace('/orders'))} />
      <View style={{ paddingHorizontal: space.gutter, paddingTop: space.md, gap: space.lg }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text variant="title" style={{ flex: 1 }} accessibilityRole="header">
            {order.vendor.name}
          </Text>
          <StatusPill label={order.statusLabel} tone={order.status === 'cancelled' || order.status === 'rejected' ? 'danger' : order.status === 'delivered' ? 'success' : 'accent'} />
        </View>

        {awaitingPayment ? (
          <Card testID="payment-panel">
            <View style={{ gap: space.md }}>
              <Text variant="heading">{said?.title ?? 'Waiting for payment'}</Text>
              <Text variant="caption" tone="muted" accessibilityLiveRegion="polite">
                {said?.body ??
                  'Finish paying on Paystack’s page. When you come back, DASH checks with Paystack before your order goes to the shop.'}
              </Text>
              {memory.authorizationUrl && !said ? (
                <Button label="Open Paystack" leadingIcon="open-in-new" onPress={() => void Linking.openURL(memory.authorizationUrl!)} />
              ) : null}
              <Button variant="outline" label="Check payment" leadingIcon="refresh" onPress={() => void check()} busy={checking} testID="check-payment" />
              {canPayAgain ? <Button label="Pay again" onPress={() => void payAgain()} busy={busy} /> : null}
              {payProblem ? (
                <Text variant="caption" style={{ color: palette.danger }} accessibilityLiveRegion="polite">
                  {payProblem}
                </Text>
              ) : null}
            </View>
          </Card>
        ) : null}

        {moving && memory.deliveryPin ? (
          <Card tone="sand" testID="delivery-pin">
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
              <Icon name="lock-outline" size={24} color={palette.text} />
              <View style={{ flex: 1 }}>
                <Text variant="caption" tone="muted">
                  Delivery PIN — read it to your rider at the door
                </Text>
                <Text variant="title" weight="extrabold" accessibilityLabel={`Delivery PIN ${memory.deliveryPin.split('').join(' ')}`}>
                  {memory.deliveryPin}
                </Text>
              </View>
            </View>
          </Card>
        ) : null}

        {(order.refunds ?? []).map((refund, index) => (
          <Card key={`${refund.createdAt}-${index}`} testID="refund">
            <View style={{ gap: space.sm }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm }}>
                <Text variant="bodyStrong" weight="bold" style={{ flex: 1 }}>
                  Refund of {formatNairaCompact(refund.amount)}
                </Text>
                <StatusPill label={refund.label} tone={refundTone(refund.status)} />
              </View>
              <Text variant="caption" tone="muted" accessibilityLiveRegion="polite">
                {refund.body}
              </Text>
            </View>
          </Card>
        ))}

        {order.rider && moving ? (
          <Card testID="rider">
            <Text variant="bodyStrong" weight="bold">
              {order.rider.name ?? 'Your rider'} · {order.rider.vehicleType.replace('_', ' ')}
            </Text>
            <Text variant="caption" tone="muted">
              {order.rider.isStale ? 'Last location is not current — the rider’s signal may have dropped.' : 'On the way.'}
            </Text>
          </Card>
        ) : null}

        <Card>
          <Text variant="heading" style={{ marginBottom: space.sm }}>
            Progress
          </Text>
          {order.statusEvents.map((event, index) => (
            <View key={`${event.toStatus}-${index}`} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
              <Text variant="caption">{event.toStatus.replace(/_/g, ' ')}</Text>
              <Text variant="caption" tone="muted">
                {new Date(event.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </Text>
            </View>
          ))}
        </Card>

        <Card>
          <Text variant="heading" style={{ marginBottom: space.sm }}>
            Receipt
          </Text>
          {order.items.map((item, index) => (
            <View key={`${item.nameSnapshot}-${index}`} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
              <Text variant="caption" style={{ flex: 1 }}>
                {item.quantity} × {item.nameSnapshot}
              </Text>
              <Text variant="caption">{formatNairaCompact(item.lineTotal)}</Text>
            </View>
          ))}
          <View style={{ marginVertical: space.sm }}>
            <Divider />
          </View>
          {quoteRows(order)
            .filter((row) => row.label !== 'Items')
            .map((row) => (
              <View key={row.label} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
                <Text variant="caption" tone="muted">
                  {row.label}
                </Text>
                <Text variant="caption">
                  {row.negative ? '−' : ''}
                  {formatNairaCompact(row.amount)}
                </Text>
              </View>
            ))}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: space.xs }}>
            <Text variant="bodyStrong" weight="bold">
              Total
            </Text>
            <Text variant="bodyStrong" weight="extrabold">
              {formatNairaCompact(order.total)}
            </Text>
          </View>
        </Card>

        {cancelNotice ? (
          <Text variant="caption" tone="muted" accessibilityLiveRegion="polite">
            {cancelNotice}
          </Text>
        ) : null}

        {cancellation.allowed && order.status !== 'cancelled' ? (
          confirmingCancel ? (
            <Card>
              <View style={{ gap: space.sm }}>
                <Text variant="caption">{cancellation.explanation}</Text>
                <View style={{ flexDirection: 'row', gap: space.sm }}>
                  <Button variant="outline" label="Keep order" onPress={() => setConfirmingCancel(false)} style={{ flex: 1 }} />
                  <Button variant="inverse" label="Cancel order" onPress={() => void cancel()} busy={busy} style={{ flex: 1 }} />
                </View>
              </View>
            </Card>
          ) : (
            <Button variant="outline" label="Cancel order" onPress={() => setConfirmingCancel(true)} />
          )
        ) : null}
        <View style={{ height: space.xl }} />
      </View>
    </Screen>
  );
}
