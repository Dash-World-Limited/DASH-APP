/**
 * Checkout — address, the server's price, and payment through Paystack.
 *
 * What this screen does not do is as important as what it does:
 *
 * - It never adds up a total. Every amount shown is the server's quote for
 *   this basket to this address, and the server prices the order again from
 *   its own data when it is placed.
 * - It never decides a payment went through. It opens Paystack's checkout and
 *   hands over to the order screen, which asks the server — and the server
 *   asks Paystack.
 * - It offers one way to pay: Paystack (card, bank transfer or USSD on
 *   Paystack's own page). Cash and wallet do not exist yet, so they are not
 *   shown at all.
 *
 * Each "Pay" tap carries one idempotency key, reused if the tap is retried,
 * so a slow network cannot place two orders.
 */

import { formatNairaCompact } from '@dash/domain/money';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, View } from 'react-native';

import { api } from '../../src/api';
import { ApiError } from '../../src/api/errors';
import { merchantBySlug } from '../../src/data/staging';
import { loadStorefront } from '../../src/data/useCatalog';
import {
  createAddress,
  listAddresses,
  newIdempotencyKey,
  placeOrder,
  quoteRows,
  requestQuote,
  type Address,
  type QuoteResult,
} from '../../src/data/orders';
import { useAuth } from '../../src/features/AuthProvider';
import { useCart } from '../../src/features/CartProvider';
import { currentLocation, openAppSettings } from '../../src/features/deviceLocation';
import { rememberOrder } from '../../src/features/orderMemory';
import { useTheme } from '../../src/theme/ThemeProvider';
import { radius, space } from '../../src/theme/tokens';
import { ActionFooter, AppBar, Button, Card, Divider, EmptyState, ErrorState, Icon, Screen, Skeleton, Text, TextField } from '../../src/ui';

const describeError = (error: unknown): string =>
  error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';

export default function Checkout() {
  const router = useRouter();
  const auth = useAuth();
  const { cart, count, dispatch } = useCart();

  const slug = cart.merchantSlug;
  const fixture = slug !== null && merchantBySlug(slug) !== undefined;

  if (!auth.configured) {
    return (
      <Screen>
        <AppBar title="Checkout" back />
        <EmptyState
          icon="cloud-off-outline"
          title="This build cannot place orders"
          body="It is not connected to a DASH server, so it shows sample shops only. Nothing can be ordered or paid for here."
        />
      </Screen>
    );
  }
  if (count === 0 || slug === null) {
    return (
      <Screen>
        <AppBar title="Checkout" back />
        <EmptyState icon="cart-outline" title="Your cart is empty" body="Add something from a shop first." action="Browse Shops" onAction={() => router.replace('/shops')} />
      </Screen>
    );
  }
  if (fixture) {
    return (
      <Screen>
        <AppBar title="Checkout" back />
        <EmptyState
          icon="storefront-outline"
          title="Sample shop"
          body="This cart is from a sample shop, which cannot take orders. Clear it and shop from a live store."
          action="Clear cart"
          onAction={() => dispatch({ type: 'clear' })}
        />
      </Screen>
    );
  }
  if (auth.state === 'restoring') {
    return (
      <Screen>
        <AppBar title="Checkout" back />
        <View style={{ padding: space.gutter, gap: space.md }} accessibilityLabel="Checking your sign-in">
          <Skeleton style={{ height: 80, borderRadius: radius.md }} />
          <Skeleton style={{ height: 160, borderRadius: radius.md }} />
        </View>
      </Screen>
    );
  }
  if (auth.state !== 'authenticated') {
    return (
      <Screen>
        <AppBar title="Checkout" back />
        <EmptyState
          icon="account-lock-outline"
          title="Sign in to check out"
          body="Your cart is kept. Sign in with the code we email you, then come back here to pay."
          action="Sign in"
          onAction={() => router.push('/sign-in')}
        />
      </Screen>
    );
  }
  return <SignedInCheckout merchantSlug={slug} />;
}

function SignedInCheckout({ merchantSlug }: { merchantSlug: string }) {
  const router = useRouter();
  const { palette } = useTheme();
  const { viewer } = useAuth();
  const { cart, dispatch } = useCart();

  const [branchId, setBranchId] = useState<string | null>(null);
  const [addresses, setAddresses] = useState<Address[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);

  const [instructions, setInstructions] = useState('');
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const attemptKey = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [store, saved] = await Promise.all([loadStorefront(merchantSlug, true), listAddresses(api)]);
      if (!store.branchId) throw new ApiError(409, 'no_branch', 'This shop is not taking orders right now.');
      setBranchId(store.branchId);
      setAddresses(saved);
      setSelected((current) => current ?? saved.find((a) => a.isDefault)?.id ?? saved[0]?.id ?? null);
      setAdding(saved.length === 0);
    } catch (error) {
      setLoadError(describeError(error));
    }
  }, [merchantSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  // Re-quote whenever the address or the basket changes. The basket cannot
  // change on this screen, but the key keeps a stale quote from ever showing.
  const basketKey = JSON.stringify(cart.lines);
  useEffect(() => {
    if (!branchId || !selected) return;
    let live = true;
    setQuoting(true);
    setQuoteError(null);
    requestQuote(api, { branchId, cart, addressId: selected })
      .then((result) => live && setQuote(result))
      .catch((error: unknown) => {
        if (!live) return;
        setQuote(null);
        setQuoteError(describeError(error));
      })
      .finally(() => live && setQuoting(false));
    return () => {
      live = false;
    };
    // `cart` is represented by basketKey, so a new cart object with the same
    // lines does not re-quote.
  }, [branchId, selected, basketKey]);

  async function pay() {
    if (!branchId || !selected || !quote) return;
    setPaying(true);
    setPayError(null);
    attemptKey.current ??= newIdempotencyKey();
    try {
      const placed = await placeOrder(api, {
        branchId,
        cart,
        addressId: selected,
        instructions: instructions.trim() || undefined,
        idempotencyKey: attemptKey.current,
      });
      attemptKey.current = null;
      await rememberOrder(placed.order.id, { deliveryPin: placed.deliveryPin, authorizationUrl: placed.payment.authorizationUrl });
      // The order now exists on the server; the basket has done its job.
      dispatch({ type: 'clear' });
      router.replace(`/order/${placed.order.id}`);
      if (placed.payment.authorizationUrl) {
        void Linking.openURL(placed.payment.authorizationUrl).catch(() => undefined);
      }
    } catch (error) {
      // A definitive refusal means the next tap is a new attempt; a network
      // failure keeps the key, because the order may exist already.
      if (!(error instanceof ApiError && error.isNetwork)) attemptKey.current = null;
      setPayError(describeError(error));
    } finally {
      setPaying(false);
    }
  }

  if (loadError) {
    return (
      <Screen>
        <AppBar title="Checkout" back />
        <View style={{ padding: space.gutter }}>
          <ErrorState title="Checkout could not load" message={loadError} onRetry={() => void load()} />
        </View>
      </Screen>
    );
  }

  const canPay = Boolean(quote) && !quoting && !paying && Boolean(selected);

  return (
    <Screen
      testID="checkout"
      footer={
        <ActionFooter>
          <Button
            label={quote ? `Pay ${formatNairaCompact(quote.quote.total)} with Paystack` : 'Pay with Paystack'}
            onPress={() => void pay()}
            disabled={!canPay}
            busy={paying}
            testID="pay"
            accessibilityHint="Opens Paystack's secure checkout in your browser"
          />
        </ActionFooter>
      }
    >
      <AppBar title="Checkout" back />
      <View style={{ paddingHorizontal: space.gutter, paddingTop: space.md, gap: space.lg }}>
        <Text variant="heading">Deliver to</Text>
        {addresses === null ? (
          <Skeleton style={{ height: 72, borderRadius: radius.md }} />
        ) : (
          <View style={{ gap: space.sm }} accessibilityRole="radiogroup">
            {addresses.map((address) => {
              const active = address.id === selected;
              return (
                <Card key={address.id} tone={active ? 'sand' : 'surface'}>
                  <Button
                    variant="outline"
                    label={`${address.label ? `${address.label} · ` : ''}${address.line1}`}
                    leadingIcon={active ? 'radiobox-marked' : 'radiobox-blank'}
                    onPress={() => setSelected(address.id)}
                    accessibilityHint={active ? 'Selected' : 'Deliver here'}
                  />
                </Card>
              );
            })}
            {adding ? (
              <NewAddressForm
                defaultPhone={viewer?.identity.phone ?? ''}
                onSaved={async (id) => {
                  setAdding(false);
                  await load();
                  setSelected(id);
                }}
                onCancel={addresses.length > 0 ? () => setAdding(false) : undefined}
              />
            ) : (
              <Button variant="outline" leadingIcon="plus" label="Add a new address" onPress={() => setAdding(true)} />
            )}
          </View>
        )}

        <Divider />

        <Card testID="checkout-summary">
          <Text variant="heading" style={{ marginBottom: space.md }}>
            Order summary
          </Text>
          {quoting ? (
            <Skeleton style={{ height: 96, borderRadius: radius.sm }} />
          ) : quoteError ? (
            <Text variant="caption" style={{ color: palette.danger }} accessibilityLiveRegion="polite">
              {quoteError}
            </Text>
          ) : quote ? (
            <>
              {quoteRows(quote.quote).map((row) => (
                <View key={row.label} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
                  <Text variant="caption" tone="muted">
                    {row.label}
                  </Text>
                  <Text variant="caption" weight="semibold">
                    {row.negative ? '−' : ''}
                    {formatNairaCompact(row.amount)}
                  </Text>
                </View>
              ))}
              <View style={{ marginVertical: space.sm }}>
                <Divider />
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text variant="bodyStrong" weight="bold">
                  Total
                </Text>
                <Text variant="bodyStrong" weight="extrabold" testID="checkout-total">
                  {formatNairaCompact(quote.quote.total)}
                </Text>
              </View>
              <Text variant="caption" tone="muted" style={{ marginTop: space.sm }}>
                About {quote.estimatedDeliveryMinutes} minutes to your door.
              </Text>
            </>
          ) : (
            <Text variant="caption" tone="muted">
              Choose an address to see your total.
            </Text>
          )}
        </Card>

        <TextField
          label="Note for the shop and rider (optional)"
          value={instructions}
          onChangeText={setInstructions}
          placeholder="e.g. gate code, no pepper"
          maxLength={280}
        />

        <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' }}>
          <Icon name="shield-check-outline" size={20} color={palette.textMuted} />
          <Text variant="caption" tone="muted" style={{ flex: 1 }}>
            You pay on Paystack&apos;s secure page — card, bank transfer or USSD. DASH never sees your card. Your order goes to the
            shop only after Paystack confirms the payment to DASH.
          </Text>
        </View>

        {payError ? (
          <Text variant="caption" style={{ color: palette.danger }} accessibilityLiveRegion="polite">
            {payError}
          </Text>
        ) : null}
      </View>
    </Screen>
  );
}

function NewAddressForm({
  defaultPhone,
  onSaved,
  onCancel,
}: {
  defaultPhone: string;
  onSaved: (id: string) => Promise<void> | void;
  onCancel: (() => void) | undefined;
}) {
  const { palette } = useTheme();
  const [line1, setLine1] = useState('');
  const [landmark, setLandmark] = useState('');
  const [phone, setPhone] = useState(defaultPhone);
  const [point, setPoint] = useState<{ latitude: number; longitude: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationProblem, setLocationProblem] = useState<{ message: string; settings: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function locate() {
    setLocating(true);
    setLocationProblem(null);
    const result = await currentLocation();
    setLocating(false);
    if (result.ok) setPoint({ latitude: result.latitude, longitude: result.longitude });
    else setLocationProblem({ message: result.message, settings: result.reason === 'denied' && !result.canAskAgain });
  }

  const phoneOk = /^\+[1-9]\d{7,14}$/.test(phone.trim());
  const ready = line1.trim().length >= 3 && phoneOk && point !== null;

  async function save() {
    if (!point) return;
    setSaving(true);
    setError(null);
    try {
      const created = await createAddress(api, {
        line1: line1.trim(),
        landmark: landmark.trim() || undefined,
        contactPhone: phone.trim(),
        latitude: point.latitude,
        longitude: point.longitude,
        isDefault: true,
      });
      await onSaved(created.id);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card testID="new-address">
      <View style={{ gap: space.md }}>
        <Text variant="bodyStrong" weight="bold">
          New address
        </Text>
        <Button
          variant={point ? 'secondary' : 'primary'}
          leadingIcon="crosshairs-gps"
          label={point ? 'Location found — find it again' : 'Use my current location'}
          onPress={() => void locate()}
          busy={locating}
          accessibilityHint="Asks for your location so the rider can find you"
        />
        {locationProblem ? (
          <View style={{ gap: space.xs }}>
            <Text variant="caption" style={{ color: palette.danger }} accessibilityLiveRegion="polite">
              {locationProblem.message}
            </Text>
            {locationProblem.settings ? <Button variant="outline" label="Open Settings" onPress={openAppSettings} /> : null}
          </View>
        ) : null}
        <TextField label="Street address" value={line1} onChangeText={setLine1} placeholder="House number and street" maxLength={200} />
        <TextField label="Landmark (optional)" value={landmark} onChangeText={setLandmark} placeholder="e.g. opposite the filling station" maxLength={120} />
        <TextField
          label="Phone for the rider"
          value={phone}
          onChangeText={setPhone}
          placeholder="+234…"
          keyboardType="phone-pad"
          error={phone.length > 0 && !phoneOk ? 'Include the country code, e.g. +234…' : null}
        />
        {error ? (
          <Text variant="caption" style={{ color: palette.danger }} accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          {onCancel ? <Button variant="outline" label="Cancel" onPress={onCancel} style={{ flex: 1 }} /> : null}
          <Button label="Save address" onPress={() => void save()} disabled={!ready || saving} busy={saving} style={{ flex: 1 }} />
        </View>
      </View>
    </Card>
  );
}
