/**
 * Your Cart — the Customer board, screen 5.
 *
 * The lines the customer chose, a note for the shop, and the order summary.
 * The summary is a quote: items, delivery fee, service fee and total all come
 * from it, and this screen adds nothing up. In staging the quote is the fixture
 * module's. With a live shop the lines come from its storefront, and the quote
 * is POST /v1/orders/quote, which needs a signed-in customer and a delivery
 * address, both arriving with checkout; until then the summary says where the
 * total will come from rather than adding one up on the phone.
 *
 * Proceed to Checkout opens the checkout that the next checkpoint builds.
 */

import { formatNairaCompact } from '@dash/domain/money';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { TextInput, View } from 'react-native';

import { ProductArt } from '../../src/commerce/Placeholders';
import { SampleDataNote } from '../../src/commerce/Promotions';
import { stagingQuote } from '../../src/data/staging';
import { useCartProducts } from '../../src/data/useCatalog';
import { useCart } from '../../src/features/CartProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { fontFamily, radius, space, typeScale } from '../../src/theme/tokens';
import { ActionFooter, AppBar, Button, Card, Divider, EmptyState, ErrorState, Icon, IconButton, QuantityStepper, Screen, Skeleton, Text } from '../../src/ui';

export default function CartScreen() {
  const router = useRouter();
  const { palette } = useTheme();
  const { cart, count, dispatch } = useCart();
  const [note, setNote] = useState('');
  const products = useCartProducts(cart.merchantSlug);
  const live = products.live;
  const quote = useMemo(() => (live ? null : stagingQuote(cart.lines)), [live, cart.lines]);

  if (cart.lines.length === 0) {
    return (
      <Screen>
        <AppBar title="Your Cart" />
        <EmptyState
          icon="cart-outline"
          title="Your cart is empty"
          body="Find something you like in a shop and it will wait for you here."
          action="Browse Shops"
          onAction={() => router.replace('/shops')}
        />
      </Screen>
    );
  }

  return (
    <Screen
      testID="cart"
      footer={
        <ActionFooter>
          <Button label="Proceed to Checkout" onPress={() => router.push('/checkout')} testID="proceed-to-checkout" />
        </ActionFooter>
      }
    >
      <AppBar
        title="Your Cart"
        right={
          // The board draws the cart glyph here as a status — you are already in
          // the cart — so it is a count, not a button that goes nowhere.
          <View accessible accessibilityLabel={`${count} item${count === 1 ? '' : 's'} in cart`} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="cart-outline" size={24} color={palette.text} />
            <View style={{ position: 'absolute', top: 4, right: 2, minWidth: 18, height: 18, paddingHorizontal: 4, borderRadius: 9, backgroundColor: palette.accent, alignItems: 'center', justifyContent: 'center' }}>
              <Text variant="micro" tone="onAccent">
                {count > 9 ? '9+' : String(count)}
              </Text>
            </View>
          </View>
        }
      />
      <View style={{ paddingHorizontal: space.gutter, paddingTop: space.md, gap: space.lg }}>
        {products.status === 'loading' ? (
          <View style={{ gap: space.md }} accessibilityLabel="Loading your cart">
            {cart.lines.map((line) => (
              <Skeleton key={line.key} style={{ height: 76, borderRadius: 12 }} />
            ))}
          </View>
        ) : products.status === 'error' ? (
          <ErrorState title="Your cart could not load" message={products.error ?? 'Please try again.'} onRetry={products.retry} />
        ) : null}

        {cart.lines.map((line) => {
          if (products.status !== 'ready') return null;
          const product = products.data?.get(line.productId);
          if (!product) {
            // The shop removed it since it was added: say so, and let it go.
            return (
              <View key={line.key} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                <Icon name="package-variant-remove" size={24} color={palette.textSubtle} />
                <Text variant="caption" tone="muted" style={{ flex: 1 }}>
                  An item in your cart is no longer available from this shop.
                </Text>
                <IconButton icon="delete-outline" label="Remove unavailable item" onPress={() => dispatch({ type: 'remove', key: line.key })} />
              </View>
            );
          }
          const optionText = product.optionGroups
            .map((group) => group.options.find((o) => o.id === line.options[group.id])?.label)
            .filter(Boolean)
            .reverse()
            .join(', ');
          return (
            <View key={line.key} style={{ flexDirection: 'row', gap: space.md }}>
              <View style={{ width: 76, height: 76, borderRadius: radius.md, backgroundColor: palette.surfaceMuted, overflow: 'hidden' }}>
                <ProductArt product={product} style={{ width: '100%', height: '100%' }} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="label" weight="bold" numberOfLines={1}>
                  {product.name}
                </Text>
                {optionText ? (
                  <Text variant="caption" tone="muted" numberOfLines={1}>
                    {optionText}
                  </Text>
                ) : null}
                <Text variant="label" weight="bold">
                  {formatNairaCompact(product.price)}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.xs }}>
                  <QuantityStepper
                    value={line.quantity}
                    onChange={(quantity) => dispatch({ type: 'setQuantity', key: line.key, quantity })}
                    itemName={product.name}
                  />
                  <IconButton icon="delete-outline" label={`Remove ${product.name}`} onPress={() => dispatch({ type: 'remove', key: line.key })} />
                </View>
              </View>
            </View>
          );
        })}

        <Divider />

        <View style={{ flexDirection: 'row', gap: space.md, alignItems: 'flex-start' }}>
          <Icon name="note-text-outline" size={22} color={palette.text} />
          <View style={{ flex: 1 }}>
            <Text variant="label">Add a note (optional)</Text>
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="e.g. preferred time, extra instructions..."
              placeholderTextColor={palette.textSubtle}
              maxLength={200}
              multiline
              accessibilityLabel="Note for the shop"
              style={{ fontFamily: fontFamily.medium, fontSize: typeScale.caption.fontSize, color: palette.text, paddingVertical: space.xs }}
            />
          </View>
        </View>

        {quote ? (
        <Card>
          <Text variant="heading" style={{ marginBottom: space.md }}>
            Order Summary
          </Text>
          <SummaryRow label={`Items (${quote.itemCount})`} value={formatNairaCompact(quote.itemsTotal)} />
          <SummaryRow label="Delivery Fee" value={formatNairaCompact(quote.deliveryFee)} />
          <SummaryRow label="Service Fee" value={formatNairaCompact(quote.serviceFee)} />
          <View style={{ marginVertical: space.sm }}>
            <Divider />
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text variant="bodyStrong" weight="bold">
              Total
            </Text>
            <Text variant="bodyStrong" weight="extrabold" testID="cart-total">
              {formatNairaCompact(quote.total)}
            </Text>
          </View>
        </Card>
        ) : (
          <Card testID="cart-summary-pending">
            <Text variant="heading" style={{ marginBottom: space.sm }}>
              Order Summary
            </Text>
            <SummaryRow label="Items" value={String(count)} />
            <Text variant="caption" tone="muted" style={{ marginTop: space.sm }}>
              Your total, delivery fee and service fee are worked out by DASH when you check out, for your address. This
              screen never adds up what you pay.
            </Text>
          </Card>
        )}
        {live ? null : <SampleDataNote />}
      </View>
    </Screen>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant="caption" weight="semibold">
        {value}
      </Text>
    </View>
  );
}
