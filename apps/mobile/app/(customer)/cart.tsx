/**
 * Your Cart — the Customer board, screen 5.
 *
 * The lines the customer chose, a note for the shop, and the order summary.
 * The summary is a quote: items, delivery fee, service fee and total all come
 * from it, and this screen adds nothing up. In staging the quote is the fixture
 * module's; wired, it is POST /v1/orders/quote, the only place a fee is
 * decided.
 *
 * Proceed to Checkout opens the checkout that the next checkpoint builds.
 */

import { formatNairaCompact } from '@dash/domain/money';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { TextInput, View } from 'react-native';

import { SampleDataNote } from '../../src/commerce/Promotions';
import { productById, stagingQuote } from '../../src/data/staging';
import { useCart } from '../../src/features/CartProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { fontFamily, radius, space, typeScale } from '../../src/theme/tokens';
import { ActionFooter, AppBar, Button, Card, Divider, EmptyState, Icon, IconButton, QuantityStepper, Screen, Text } from '../../src/ui';

export default function CartScreen() {
  const router = useRouter();
  const { palette } = useTheme();
  const { cart, count, dispatch } = useCart();
  const [note, setNote] = useState('');
  const quote = useMemo(() => stagingQuote(cart.lines), [cart.lines]);

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
        {cart.lines.map((line) => {
          const product = productById(line.productId);
          if (!product) return null;
          const optionText = product.optionGroups
            .map((group) => group.options.find((o) => o.id === line.options[group.id])?.label)
            .filter(Boolean)
            .reverse()
            .join(', ');
          return (
            <View key={line.key} style={{ flexDirection: 'row', gap: space.md }}>
              <View style={{ width: 76, height: 76, borderRadius: radius.md, backgroundColor: palette.surfaceMuted, overflow: 'hidden' }}>
                <Image source={product.image} style={{ width: '100%', height: '100%' }} contentFit="contain" />
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
        <SampleDataNote />
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
