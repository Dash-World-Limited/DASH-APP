/**
 * Product Detail — the Customer board, screen 4.
 *
 * The photograph leads, then the name and the price, the description, the
 * options, and — always reachable at the foot — quantity and Add to Cart.
 *
 * The price shown is the product's price, formatted. Nothing is multiplied by
 * the quantity here: what a customer pays for several, with options, fees and
 * any promotion, is the quote's job, and the cart shows the quote.
 *
 * STAGING DATA. Galleries, colour and storage options and product ratings are
 * not served yet — see the gaps noted in data/models.ts.
 */

import { formatNairaCompact } from '@dash/domain/money';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Share, View } from 'react-native';

import { SampleDataNote } from '../../../src/commerce/Promotions';
import { productById } from '../../../src/data/staging';
import { useAddToCart } from '../../../src/features/useAddToCart';
import { useSaved } from '../../../src/features/saved';
import { formatRating } from '../../../src/lib/format';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { radius, space } from '../../../src/theme/tokens';
import { ActionFooter, AppBar, Button, Chip, EmptyState, Icon, IconButton, QuantityStepper, Screen, Text } from '../../../src/ui';

export default function ProductDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { palette } = useTheme();
  const add = useAddToCart();
  const { isSaved, toggle } = useSaved();
  const product = productById(id ?? '');

  const [view, setView] = useState(0);
  const [quantity, setQuantity] = useState(1);
  const [choices, setChoices] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (product?.optionGroups ?? []).map((group) => [group.id, group.defaultOption ?? group.options[0]?.id ?? '']),
    ),
  );

  if (!product) {
    return (
      <Screen>
        <AppBar />
        <EmptyState icon="package-variant-closed" title="Product not found" body="It may have sold out or been removed by the shop." action="Go back" onAction={() => router.back()} />
      </Screen>
    );
  }

  const saved = isSaved(`product:${product.id}`);
  const addToCart = (): void =>
    add({
      merchantSlug: product.merchantSlug,
      productId: product.id,
      quantity,
      options: choices,
      onAdded: () => router.push('/cart'),
    });

  return (
    <Screen
      testID="product-detail"
      footer={
        <ActionFooter>
          <View style={{ flexDirection: 'row', gap: space.md, alignItems: 'center' }}>
            <QuantityStepper value={quantity} onChange={setQuantity} itemName={product.name} />
            <Button label="Add to Cart" onPress={addToCart} style={{ flex: 1 }} testID="add-to-cart" />
          </View>
        </ActionFooter>
      }
    >
      <AppBar
        right={
          <>
            <IconButton
              icon={saved ? 'heart' : 'heart-outline'}
              color={saved ? palette.danger : palette.text}
              label={saved ? `Remove ${product.name} from saved` : `Save ${product.name}`}
              onPress={() => toggle(`product:${product.id}`)}
            />
            <IconButton
              icon="export-variant"
              label={`Share ${product.name}`}
              onPress={() => void Share.share({ message: `${product.name} on DASH — www.dashworldng.com` }).catch(() => undefined)}
            />
          </>
        }
      />

      <View style={{ paddingHorizontal: space.gutter, gap: space.lg }}>
        <View style={{ height: 290, borderRadius: radius.lg, backgroundColor: palette.surface, overflow: 'hidden' }}>
          <Image
            source={product.gallery[view] ?? product.image}
            style={{ width: '100%', height: '100%' }}
            contentFit="contain"
            accessibilityLabel={`${product.name}, photo ${view + 1} of ${product.gallery.length}`}
          />
        </View>

        {product.gallery.length > 1 ? (
          <View style={{ flexDirection: 'row', gap: space.sm }} accessibilityRole="tablist" accessibilityLabel="Photos">
            {product.gallery.slice(1).map((source, index) => {
              const selected = view === index + 1 || (view === 0 && index === 0);
              return (
                <Pressable
                  key={index}
                  onPress={() => setView(index + 1)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`Photo ${index + 2}`}
                  style={{
                    flex: 1,
                    height: 70,
                    borderRadius: radius.md,
                    backgroundColor: palette.surfaceMuted,
                    borderWidth: selected ? 2 : 0,
                    borderColor: palette.accent,
                    overflow: 'hidden',
                  }}
                >
                  <Image source={source} style={{ width: '100%', height: '100%' }} contentFit="contain" />
                </Pressable>
              );
            })}
          </View>
        ) : null}

        <View style={{ gap: space.xs }}>
          <Text variant="title" accessibilityRole="header">
            {product.name}
          </Text>
          <Text variant="display">{formatNairaCompact(product.price)}</Text>
          {product.rating ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Icon name="star" size={16} color={palette.rating} />
              <Text variant="caption" weight="semibold">
                {formatRating(product.rating.average)}
              </Text>
              <Text variant="caption" tone="muted">
                ({product.rating.count} reviews)
              </Text>
            </View>
          ) : null}
        </View>

        <Text variant="body" tone="muted">
          {product.description}
        </Text>

        {product.optionGroups.map((group) => {
          const chosen = group.options.find((o) => o.id === choices[group.id]);
          return (
            <View key={group.id} style={{ gap: space.sm }}>
              <Text variant="label">
                {group.label}
                {group.kind === 'swatch' && chosen ? <Text variant="label" tone="muted" weight="medium">{`: ${chosen.label}`}</Text> : null}
              </Text>
              <View style={{ flexDirection: 'row', gap: space.sm }}>
                {group.options.map((option) =>
                  group.kind === 'swatch' ? (
                    <Pressable
                      key={option.id}
                      onPress={() => setChoices((c) => ({ ...c, [group.id]: option.id }))}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: choices[group.id] === option.id }}
                      accessibilityLabel={option.label}
                      hitSlop={6}
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 18,
                        padding: 3,
                        borderWidth: 2,
                        borderColor: choices[group.id] === option.id ? palette.accent : 'transparent',
                      }}
                    >
                      <View style={{ flex: 1, borderRadius: 14, backgroundColor: option.swatch, borderWidth: 1, borderColor: palette.line }} />
                    </Pressable>
                  ) : (
                    <Chip
                      key={option.id}
                      label={option.label}
                      selected={choices[group.id] === option.id}
                      onPress={() => setChoices((c) => ({ ...c, [group.id]: option.id }))}
                    />
                  ),
                )}
              </View>
            </View>
          );
        })}
        <SampleDataNote />
      </View>
    </Screen>
  );
}
