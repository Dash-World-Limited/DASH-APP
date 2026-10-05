/**
 * Checkout — the address, the server's price, and payment through Paystack.
 *
 * This is the old app's checkout, ported into v2's screens. The rules it
 * keeps are the ones that made the original worth keeping:
 *
 * - **It never adds up a total.** Every amount is the server's quote for this
 *   basket to this address, and the server prices the order again from its
 *   own data when it is placed.
 * - **It never decides a payment succeeded.** It opens Paystack's page and
 *   hands over to the tracking screen, which asks the server — and the server
 *   asks Paystack.
 * - **One way to pay.** Paystack, which covers card, transfer and USSD on its
 *   own page. Cash and wallet do not exist, so they are not offered.
 * - **One idempotency key per attempt**, reused when a tap is retried after a
 *   network failure, so a slow connection cannot place two orders.
 *
 * The work is all in src/data/orders.ts, which survived the Expo Router
 * deletion with its tests. This file is the screen over it.
 */

import { formatNairaCompact } from '@dash/domain/money';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, TextInput, View } from 'react-native';
import { useAudioPlayer } from 'expo-audio';

import { api, ApiError } from '../../api';
import {
  createAddress,
  listAddresses,
  newIdempotencyKey,
  placeOrder,
  quoteRows,
  requestQuote,
  type Address,
  type QuoteResult,
} from '../../data/orders';
import { useCart } from '../../features/CartProvider';
import { currentLocation } from '../../features/deviceLocation';
import { rememberOrder } from '../../features/orderMemory';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, space } from '../../theme/tokens';
import { Icon } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import { useAppSession } from '../auth/AppSessionProvider';
import { BackHeader, Card, Empty, Notice, OrderPage, PrimaryCheckoutButton, SecondaryButton } from './parts';

const describeError = (error: unknown): string =>
  error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';

/** `/v1/vendors/:slug`, for the branch the order is placed against. */
interface VendorBranches {
  vendor: {
    name: string;
    branches: Array<{ id: string; name: string; supportsDelivery: boolean }>;
  };
}

export function CustomerCheckoutScreen({ onBack, onAccount, onTrack }: { onBack: () => void; onAccount: () => void; onTrack: (id: string) => void }) {
  const auth = useAppSession();
  const { cart, count } = useCart();
  const slug = cart.merchantSlug;

  if (!api.configured) {
    return (
      <OrderPage>
        <BackHeader title="Checkout" onBack={onBack} />
        <Empty
          icon="cloud-off-outline"
          title="This build cannot place orders"
          body="It has no DASH API address, so nothing can be ordered or paid for here. That is a build setting (EXPO_PUBLIC_API_URL), not something to fix on the phone."
        />
      </OrderPage>
    );
  }
  if (count === 0 || slug === null) {
    return (
      <OrderPage>
        <BackHeader title="Checkout" onBack={onBack} />
        <Empty icon="cart-outline" title="Your cart is empty" body="Add something from a merchant first." action="Go back" onPress={onBack} />
      </OrderPage>
    );
  }
  if (auth.state === 'restoring') {
    return (
      <OrderPage>
        <BackHeader title="Checkout" onBack={onBack} />
        <View style={{ minHeight: 200, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel="Checking your sign-in"><ActivityIndicator /></View>
      </OrderPage>
    );
  }
  if (auth.state !== 'authenticated') {
    return (
      <OrderPage>
        <BackHeader title="Checkout" onBack={onBack} />
        <Empty
          icon="account-lock-outline"
          title="Sign in to check out"
          body="Your cart is kept. Sign in with the code we email you, then come back here to pay."
          action="Open account"
          onPress={onAccount}
        />
      </OrderPage>
    );
  }
  return <SignedInCheckout merchantSlug={slug} onBack={onBack} onTrack={onTrack} />;
}

function SignedInCheckout({ merchantSlug, onBack, onTrack }: { merchantSlug: string; onBack: () => void; onTrack: (id: string) => void }) {
  const { palette } = useTheme();
  const { viewer } = useAppSession();
  const { cart, dispatch } = useCart();
  // Metro resolves bundled WAV assets statically; require is the supported asset reference here.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const orderPlacedTone = useAudioPlayer(require('../../../assets/sounds/order-placed.wav'));

  const [branchId, setBranchId] = useState<string | null>(null);
  const [merchantName, setMerchantName] = useState<string | null>(null);
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
      const [store, saved] = await Promise.all([
        api.request<VendorBranches>(`/v1/vendors/${encodeURIComponent(merchantSlug)}`, { auth: false }),
        listAddresses(api),
      ]);
      const branch = store.vendor.branches.find((item) => item.supportsDelivery) ?? store.vendor.branches[0];
      if (!branch) throw new ApiError(409, 'no_branch', 'This merchant is not taking orders right now.');
      setBranchId(branch.id);
      setMerchantName(store.vendor.name);
      setAddresses(saved);
      setSelected((current) => current ?? saved.find((item) => item.isDefault)?.id ?? saved[0]?.id ?? null);
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
      .finally(() => {
        if (live) setQuoting(false);
      });
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
      void orderPlacedTone.seekTo(0).then(() => orderPlacedTone.play()).catch(() => undefined);
      // The order now exists on the server; the basket has done its job.
      dispatch({ type: 'clear' });
      onTrack(placed.order.id);
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
      <OrderPage>
        <BackHeader title="Checkout" onBack={onBack} />
        <Empty icon="alert-circle-outline" title="Checkout could not load" body={loadError} action="Try again" onPress={() => void load()} />
      </OrderPage>
    );
  }

  const canPay = Boolean(quote) && !quoting && !paying && Boolean(selected);

  return (
    <OrderPage testID="checkout-v2">
      <BackHeader title="Checkout" onBack={onBack} />

      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <Icon name="storefront-outline" color={palette.accent} />
          <View style={{ flex: 1 }}>
            <Text variant="micro" tone="muted">Merchant</Text>
            <Text variant="label" weight="bold">{merchantName ?? merchantSlug.replace(/-/g, ' ')}</Text>
          </View>
        </View>
      </Card>

      <Text variant="heading">Deliver to</Text>
      {addresses === null ? (
        <View style={{ minHeight: 72, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator /></View>
      ) : (
        <View style={{ gap: space.sm }} accessibilityRole="radiogroup">
          {addresses.map((address) => {
            const active = address.id === selected;
            const label = `${address.label ? `${address.label} · ` : ''}${address.line1}`;
            // One Pressable carrying the radio role, rather than a button
            // nested inside a radio — which reads as two controls.
            return (
              <Pressable
                key={address.id}
                onPress={() => setSelected(address.id)}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                accessibilityLabel={label}
                style={{ minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, borderRadius: radius.lg, borderWidth: 1, borderColor: active ? palette.accent : palette.line, backgroundColor: active ? palette.accentSoft : palette.surface }}
              >
                <Icon name={active ? 'radiobox-marked' : 'radiobox-blank'} color={active ? palette.accent : palette.textMuted} />
                <View style={{ flex: 1, paddingVertical: space.sm }}>
                  <Text variant="caption" weight="bold">{label}</Text>
                  {address.landmark ? <Text variant="micro" tone="muted">{address.landmark}</Text> : null}
                </View>
              </Pressable>
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
            <SecondaryButton label="Add another address" onPress={() => setAdding(true)} />
          )}
        </View>
      )}

      <Card>
        <Text variant="label" weight="bold">Delivery instructions (optional)</Text>
        <TextInput
          value={instructions}
          onChangeText={setInstructions}
          placeholder="Gate colour, landmark, who to call…"
          placeholderTextColor={palette.textSubtle}
          accessibilityLabel="Delivery instructions"
          multiline
          style={{ minHeight: 48, color: palette.text, fontFamily: 'Manrope_400Regular', fontSize: 14 }}
        />
      </Card>

      {/* The server's price, row by row. Nothing here is computed on the phone. */}
      <Card>
        <Text variant="label" weight="bold">What you pay</Text>
        {quoting ? <View style={{ minHeight: 60, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator /></View> : null}
        {quoteError ? <Notice icon="alert-circle-outline" text={quoteError} danger /> : null}
        {quote && !quoting ? (
          <>
            {quoteRows(quote.quote).map((row) => (
              <View key={row.label} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text variant="caption" tone="muted">{row.label}</Text>
                <Text variant="caption">{row.negative ? '−' : ''}{formatNairaCompact(row.amount)}</Text>
              </View>
            ))}
            <View style={{ height: 1, backgroundColor: palette.line }} />
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text variant="label" weight="bold">Total</Text>
              <Text variant="label" weight="bold">{formatNairaCompact(quote.quote.total)}</Text>
            </View>
            <Text variant="micro" tone="muted">
              Ready in about {quote.estimatedPrepMinutes} min · delivered in about {quote.estimatedDeliveryMinutes} min. Both are the server's estimates, not promises.
            </Text>
          </>
        ) : null}
      </Card>

      <Notice icon="shield-check-outline" text="Payment opens Paystack's secure page in your browser. DASH never sees your card details, and this app never confirms a payment itself." />
      {payError ? <Notice icon="alert-circle-outline" text={payError} danger /> : null}

      <PrimaryCheckoutButton
        label={quote ? `Pay ${formatNairaCompact(quote.quote.total)} with Paystack` : 'Pay with Paystack'}
        onPress={() => void pay()}
        disabled={!canPay}
        busy={paying}
      />
    </OrderPage>
  );
}

/**
 * A first address, or another one. The coordinates matter: the server quotes
 * a delivery fee from them, so an address with no location cannot be priced.
 */
function NewAddressForm({ defaultPhone, onSaved, onCancel }: { defaultPhone: string; onSaved: (id: string) => Promise<void> | void; onCancel?: () => void }) {
  const { palette } = useTheme();
  const [line1, setLine1] = useState('');
  const [landmark, setLandmark] = useState('');
  const [phone, setPhone] = useState(defaultPhone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const position = await currentLocation();
      if (!position.ok) {
        setError(position.message);
        return;
      }
      const created = await createAddress(api, {
        line1: line1.trim(),
        landmark: landmark.trim() || undefined,
        contactPhone: phone.trim(),
        latitude: position.latitude,
        longitude: position.longitude,
        isDefault: true,
      });
      await onSaved(created.id);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  const field = (label: string, value: string, onChange: (next: string) => void, placeholder: string, keyboard: 'default' | 'phone-pad' = 'default') => (
    <View style={{ gap: space.xs }}>
      <Text variant="micro" tone="muted">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={palette.textSubtle}
        accessibilityLabel={label}
        keyboardType={keyboard}
        style={{ minHeight: 46, borderRadius: radius.md, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.surface, paddingHorizontal: space.md, color: palette.text, fontFamily: 'Manrope_400Regular', fontSize: 14 }}
      />
    </View>
  );

  return (
    <Card>
      <Text variant="label" weight="bold">Add a delivery address</Text>
      {field('Street address', line1, setLine1, '12 Admiralty Way')}
      {field('Landmark (optional)', landmark, setLandmark, 'Near the second gate')}
      {field('Contact phone', phone, setPhone, '0803 000 0000', 'phone-pad')}
      <Notice icon="crosshairs-gps" text="Saving uses your current location as this address's position, which is what the delivery fee is quoted from. Stand at the address when you save it." />
      {error ? <Notice icon="alert-circle-outline" text={error} danger /> : null}
      <PrimaryCheckoutButton label={busy ? 'Saving…' : 'Save address'} onPress={() => void save()} disabled={busy || line1.trim().length === 0 || phone.trim().length === 0} busy={busy} />
      {onCancel ? <SecondaryButton label="Cancel" onPress={onCancel} disabled={busy} /> : null}
    </Card>
  );
}
