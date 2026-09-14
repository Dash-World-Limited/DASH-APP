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
 * Live when the build has an API: the product comes from its shop's
 * storefront (`GET /v1/vendors/:slug`, cached from the storefront the customer
 * just browsed), with the shop's modifier groups as options and each option's
 * price difference shown, never added up here. Product ratings and galleries
 * do not exist in the API, so they are simply absent. Without an API the
 * staging fixtures are drawn and the foot of the screen says so.
 */

import { formatNairaCompact, type Kobo } from '@dash/domain/money';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Share, View } from 'react-native';

import { ProductArt } from '../../../src/commerce/Placeholders';
import { SampleDataNote } from '../../../src/commerce/Promotions';
import { useProduct } from '../../../src/data/useCatalog';
import { useAddToCart } from '../../../src/features/useAddToCart';
import { useSaved } from '../../../src/features/saved';
import { formatRating } from '../../../src/lib/format';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { radius, space } from '../../../src/theme/tokens';
import { ActionFooter, AppBar, Button, Chip, EmptyState, ErrorState, Icon, IconButton, QuantityStepper, Screen, Skeleton, Text } from '../../../src/ui';

export default function ProductDetail() {
  const { id, store } = useLocalSearchParams<{ id: string; store?: string }>();
  const router = useRouter();
  const { palette } = useTheme();
  const add = useAddToCart();
  const { isSaved, toggle } = useSaved();
  const loaded = useProduct(id, store);
  const product = loaded.data?.product ?? null;

  const [view, setView] = useState(0);
  const [quantity, setQuantity] = useState(1);
  const [choices, setChoices] = useState<Record<string, string>>({});
  // Each group starts on its default, once the product has arrived.
  useEffect(() => {
    if (!product) return;
    setChoices(Object.fromEntries(product.optionGroups.map((group) => [group.id, group.defaultOption ?? group.options[0]?.id ?? ''])));
  }, [product]);

  if (!product) {
    return (
      <Screen>
        <AppBar />
        {loaded.status === 'loading' ? (
          <View style={{ paddingHorizontal: space.gutter, gap: space.lg }} accessibilityLabel="Loading product">
            <Skeleton style={{ height: 290, borderRadius: 16 }} />
            <Skeleton style={{ width: 220, height: 24 }} />
            <Skeleton style={{ width: 120, height: 30 }} />
          </View>
        ) : loaded.status === 'error' && !loaded.notFound ? (
          <ErrorState title="This product could not load" message={loaded.error ?? 'Please try again.'} onRetry={loaded.retry} />
        ) : (
          <EmptyState icon="package-variant-closed" title="Product not found" body="It may have sold out or been removed by the shop." action="Go back" onAction={() => router.back()} />
        )}
      </Screen>
    );
  }

  const available = product.available !== false;

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
            <Button
              label={available ? 'Add to Cart' : 'Unavailable right now'}
              onPress={addToCart}
              disabled={!available}
              style={{ flex: 1 }}
              testID="add-to-cart"
            />
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
          {product.gallery.length > 0 ? (
            <Image
              source={product.gallery[view] ?? product.image}
              style={{ width: '100%', height: '100%' }}
              contentFit="contain"
              accessibilityLabel={`${product.name}, photo ${view + 1} of ${product.gallery.length}`}
            />
          ) : (
            <ProductArt product={product} style={{ width: '100%', height: '100%' }} />
          )}
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

        {product.description ? (
          <Text variant="body" tone="muted">
            {product.description}
          </Text>
        ) : null}

        {product.optionGroups.map((group) => {
          const chosen = group.options.find((o) => o.id === choices[group.id]);
          return (
            <View key={group.id} style={{ gap: space.sm }}>
              <Text variant="label">
                {group.label}
                {group.kind === 'swatch' && chosen ? <Text variant="label" tone="muted" weight="medium">{`: ${chosen.label}`}</Text> : null}
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
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
                      label={option.priceDelta ? `${option.label} +${formatNairaCompact(option.priceDelta as Kobo)}` : option.label}
                      selected={choices[group.id] === option.id}
                      onPress={() => setChoices((c) => ({ ...c, [group.id]: option.id }))}
                    />
                  ),
                )}
              </View>
            </View>
          );
        })}
        {loaded.live && store ? null : <SampleDataNote />}
      </View>
    </Screen>
  );
}
