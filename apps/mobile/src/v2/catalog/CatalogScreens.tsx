import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, TextInput, View } from 'react-native';
import { formatNairaCompact, type Kobo } from '@dash/domain/money';

import { api, ApiError } from '../../api';
import { useCart } from '../../features/CartProvider';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, space, touchTarget } from '../../theme/tokens';
import { Icon, type IconName } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import type { ServiceId } from '../artwork/CategoryArtwork';
import { CategoryPhoto } from '../artwork/CategoryPhoto';
import type { AppRoute } from '../navigation/model';

/**
 * A merchant as the DASH API reports it.
 *
 * `rating` and `eta` are nullable on purpose. A vendor the server has no
 * ratings for has no rating, and one with no branch estimate has no ETA — the
 * screen says "New" and "Nearby" rather than printing a number nobody
 * measured. `accent` is the category's colour, not the merchant's: it is
 * chosen by which of the six services the card sits under, so it carries no
 * claim about the business.
 */
interface Merchant {
  id: string;
  name: string;
  description: string;
  rating: string | null;
  eta: string | null;
  accent: string;
}

interface Product {
  id: string;
  name: string;
  price: string;
  description: string;
  badge?: string;
  available?: boolean;
}

/**
 * What a catalogue screen knows right now.
 *
 * There is deliberately no "preview" arm carrying stand-in merchants. A build
 * with no `EXPO_PUBLIC_API_URL` is `not-connected` and says so; a reachable
 * server with nothing to show is `ready` with an empty list and says that.
 * Neither invents a business, a rating or a delivery time.
 */
type Feed<T> =
  | { status: 'not-connected' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: T };

interface ApiVendorSummary {
  slug: string;
  name: string;
  description: string;
  rating: { average: number; count: number };
  branch: { estimatedMinutes: number } | null;
}

interface ApiVendorDetail {
  slug: string;
  name: string;
  description: string;
  ratingAverage: number;
  categories: Array<{
    items: Array<{
      id: string;
      name: string;
      description: string;
      price: number;
      condition: string | null;
      isAvailable: boolean;
    }>;
  }>;
}

const SERVICE_COPY: Record<ServiceId, { title: string; intro: string; search: string }> = {
  food: { title: 'Food', intro: 'Restaurants and kitchens delivering around you.', search: 'Search meals and restaurants' },
  shops: { title: 'Shops', intro: 'New electronics, fashion and home essentials.', search: 'Search shops and products' },
  pharmacy: { title: 'Pharmacy', intro: 'Health and personal-care essentials from verified pharmacies.', search: 'Search pharmacy essentials' },
  'local-market': { title: 'Local Market', intro: 'Fresh produce and everyday ingredients from nearby sellers.', search: 'Search the local market' },
  declutter: { title: 'Declutter', intro: 'Pre-owned items with clear condition and seller information.', search: 'Search declutter listings' },
  logistics: { title: 'Logistics', intro: 'Send packages by bike, car or van with upfront quotes.', search: 'What are you sending?' },
};

export function CategoryDashboard({ id, onBack, onPush }: { id: string; onBack: () => void; onPush: (route: AppRoute) => void }) {
  const service = isServiceId(id) ? id : 'food';
  const copy = SERVICE_COPY[service];
  const { palette } = useTheme();
  const { state, reload } = useMerchantList(service);
  const merchants = state.status === 'ready' ? state.data : [];
  return (
    <CatalogPage>
      <BackHeader title={copy.title} onBack={onBack} cart={() => onPush({ name: 'customer.cart' })} />
      <View style={{ minHeight: 132, borderRadius: radius.xl, backgroundColor: palette.accentSoft, padding: space.lg, flexDirection: 'row', alignItems: 'center', overflow: 'hidden' }}>
        <View style={{ flex: 1, gap: space.xs }}><Text variant="title">{copy.title}</Text><Text variant="caption" tone="muted">{copy.intro}</Text></View>
        <CategoryPhoto id={service} size={112} accessibilityLabel={`${copy.title} category photo`} />
      </View>
      {service === 'logistics' ? (
        <LogisticsNotYet />
      ) : (
        <>
          <SearchShell label={copy.search} />
          {state.status === 'ready' ? (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><Text variant="heading">Near you</Text></View>
          ) : null}
          {merchants.map((merchant) => <MerchantCard key={merchant.id} merchant={merchant} service={service} onPress={() => onPush({ name: 'customer.store', params: { category: service, id: merchant.id } })} />)}
          {state.status === 'ready' && merchants.length === 0 ? (
            <View style={{ minHeight: 220, alignItems: 'center', justifyContent: 'center', gap: space.sm, padding: space.lg }}>
              <View style={{ width: 70, height: 70, borderRadius: 24, backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name="storefront-outline" size={34} color={palette.accent} /></View>
              <Text variant="heading" align="center">No {copy.title.toLowerCase()} merchants yet</Text>
              <Text variant="caption" tone="muted" align="center">DASH has not opened this category in your area. It appears here as soon as a seller is live.</Text>
            </View>
          ) : null}
          <FeedState state={state} subject={`${copy.title.toLowerCase()} merchants`} onRetry={reload} />
        </>
      )}
    </CatalogPage>
  );
}

/**
 * Logistics has no merchants to list: it is a quote for a journey, and the
 * booking flow (pickup, destination, package details) is its own milestone.
 * Listing invented couriers here was the old behaviour and is what this
 * replaces.
 */
function LogisticsNotYet() {
  const { palette } = useTheme();
  return (
    <View style={{ minHeight: 240, alignItems: 'center', justifyContent: 'center', gap: space.sm, padding: space.lg }}>
      <View style={{ width: 70, height: 70, borderRadius: 24, backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name="truck-outline" size={34} color={palette.accent} /></View>
      <Text variant="heading" align="center">Logistics booking is not open yet</Text>
      <Text variant="caption" tone="muted" align="center">Sending a package needs pickup, destination and package details, and a quote priced by DASH. That flow arrives with the logistics milestone.</Text>
    </View>
  );
}

export function Storefront({ category, merchantId, onBack, onPush }: { category: string; merchantId: string; onBack: () => void; onPush: (route: AppRoute) => void }) {
  const service = isServiceId(category) ? category : 'food';
  const { state, reload } = useStorefront(service, merchantId);
  const merchant = state.status === 'ready' ? state.data.merchant : null;
  const products = state.status === 'ready' ? state.data.products : [];
  return (
    <CatalogPage>
      <BackHeader title={merchant?.name ?? SERVICE_COPY[service].title} onBack={onBack} cart={() => onPush({ name: 'customer.cart' })} />
      {merchant ? (
        <>
          <View style={{ minHeight: 174, borderRadius: radius.xl, backgroundColor: merchant.accent, padding: space.xl, justifyContent: 'flex-end', overflow: 'hidden' }}>
            <View style={{ position: 'absolute', right: -16, top: -10, opacity: 0.96 }}><CategoryPhoto id={service} size={168} accessibilityLabel={`${SERVICE_COPY[service].title} store photo`} /></View>
            <View style={{ maxWidth: '67%' }}><Text variant="title" style={{ color: '#15171A' }}>{merchant.name}</Text><Text variant="caption" style={{ color: '#33312D' }}>{merchant.description}</Text></View>
          </View>
          {/* Only the chips the server actually filled. "New" is a fact about
              an unrated vendor; a number here would not be. */}
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <InfoChip icon="star" text={merchant.rating ?? 'New'} />
            {merchant.eta ? <InfoChip icon="clock-outline" text={merchant.eta} /> : null}
            <InfoChip icon="bike-fast" text="Delivery" />
          </View>
          <Text variant="heading">Available now</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
            {products.map((product) => <ProductCard key={product.id} product={product} service={service} onPress={() => onPush({ name: 'customer.product', params: { category: service, store: merchant.id, id: product.id } })} />)}
          </View>
          {products.length === 0 ? <Notice icon="storefront-outline" text="This merchant has nothing listed right now." /> : null}
        </>
      ) : null}
      <FeedState state={state} subject="this store" onRetry={reload} />
    </CatalogPage>
  );
}

export function ProductDetail({ category, merchantId, productId, onBack, onCart }: { category: string; merchantId: string; productId: string; onBack: () => void; onCart: () => void }) {
  const service = isServiceId(category) ? category : 'food';
  const { state, reload } = useStorefront(service, merchantId);
  // The item asked for, and no substitute. Showing the store's first item
  // under another item's name is how a customer buys the wrong thing.
  const product = state.status === 'ready' ? state.data.products.find((item) => item.id === productId) ?? null : null;
  const { palette } = useTheme();
  const { dispatch, refusalFor } = useCart();
  const [quantity, setQuantity] = useState(1);
  const optionTitle = service === 'shops' ? 'Storage' : service === 'food' ? 'Portion' : null;
  const optionValues = service === 'shops' ? ['128 GB', '256 GB', '512 GB'] : service === 'food' ? ['Regular', 'Large'] : [];
  const [selectedOption, setSelectedOption] = useState(optionValues[0] ?? '');

  const addToCart = () => {
    if (!product || product.available === false) return;
    const action = {
      merchantSlug: merchantId,
      productId: product.id,
      quantity,
      options: optionTitle ? { [optionTitle.toLowerCase()]: selectedOption } : undefined,
    } as const;
    if (refusalFor(merchantId) === 'different_merchant') {
      Alert.alert(
        'Start a new cart?',
        'DASH keeps one merchant per order. Replacing the cart removes items from the other store.',
        [
          { text: 'Keep current cart', style: 'cancel' },
          { text: 'Replace cart', style: 'destructive', onPress: () => { dispatch({ type: 'replaceWith', ...action }); onCart(); } },
        ],
      );
      return;
    }
    dispatch({ type: 'add', ...action });
    onCart();
  };
  if (!product) {
    return (
      <CatalogPage>
        <BackHeader title="Item details" onBack={onBack} cart={onCart} />
        {state.status === 'ready'
          ? <Notice icon="alert-circle-outline" text="This item is no longer listed by the merchant." />
          : <FeedState state={state} subject="this item" onRetry={reload} />}
      </CatalogPage>
    );
  }
  return (
    <CatalogPage>
      <BackHeader title="Item details" onBack={onBack} cart={onCart} />
      <View style={{ height: 280, borderRadius: radius.xl, backgroundColor: palette.surfaceMuted, alignItems: 'center', justifyContent: 'center' }}><CategoryPhoto id={service} size={238} accessibilityLabel={`${SERVICE_COPY[service].title} product photo`} /></View>
      {product.badge ? <View style={{ alignSelf: 'flex-start', backgroundColor: palette.accentSoft, paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill }}><Text variant="micro" tone="accent">{product.badge}</Text></View> : null}
      <Text variant="title">{product.name}</Text>
      <Text variant="heading" tone="accent">{product.price}</Text>
      <Text tone="muted">{product.description}</Text>
      {optionTitle ? <OptionRow title={optionTitle} options={optionValues} selected={selectedOption} onSelect={setSelectedOption} /> : null}
      {service === 'declutter' ? <Notice icon="shield-check-outline" text="Condition, defects and seller verification must be disclosed before checkout." /> : null}
      <QuantityControl value={quantity} onChange={setQuantity} />
      <PrimaryButton label={product.available === false ? 'Currently unavailable' : `Add ${quantity} to cart`} onPress={addToCart} disabled={product.available === false} />
    </CatalogPage>
  );
}

export function CartScreen({ onBack, onCheckout }: { onBack: () => void; onCheckout: () => void }) {
  const { palette } = useTheme();
  const { cart, count, dispatch } = useCart();
  // The cart holds slugs and ids only, so the merchant's own storefront is
  // what turns a line into a name and a price. Until it loads — or on a build
  // with no API — a line shows its identifiers and says the price is the
  // server's, which is true at checkout either way.
  const { state: storefront } = useStorefront('shops', cart.merchantSlug ?? '');
  const catalogue = storefront.status === 'ready' ? storefront.data : null;
  return (
    <CatalogPage>
      <BackHeader title="Your cart" onBack={onBack} />
      {cart.lines.length === 0 ? (
        <View style={{ minHeight: 220, alignItems: 'center', justifyContent: 'center', gap: space.sm }}><View style={{ width: 72, height: 72, borderRadius: 24, backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name="cart-outline" size={34} color={palette.accent} /></View><Text variant="heading">Your cart is empty</Text><Text tone="muted" align="center">Choose an item from a restaurant, shop, pharmacy or market seller.</Text></View>
      ) : (
        <>
          <Notice icon="storefront-outline" text={`${count} item${count === 1 ? '' : 's'} from ${merchantLabel(cart.merchantSlug, catalogue?.merchant.name ?? null)}. One merchant is kept per order.`} />
          {cart.lines.map((line) => {
            const product = catalogue?.products.find((item) => item.id === line.productId);
            return (
              <View key={line.key} style={{ padding: space.lg, gap: space.md, borderRadius: radius.lg, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line }}>
                <View style={{ flexDirection: 'row', gap: space.md, alignItems: 'center' }}>
                  <View style={{ width: 68, height: 68, borderRadius: radius.md, overflow: 'hidden', backgroundColor: palette.surfaceMuted, alignItems: 'center', justifyContent: 'center' }}><CategoryPhoto id="shops" size={64} accessibilityLabel={`${product?.name ?? 'Cart item'} photo`} /></View>
                  <View style={{ flex: 1, gap: 2 }}><Text variant="label" weight="bold">{product?.name ?? 'Item'}</Text><Text variant="caption" tone="accent">{product?.price ?? 'Price confirmed at checkout'}</Text>{Object.values(line.options).length ? <Text variant="micro" tone="muted">{Object.values(line.options).join(' · ')}</Text> : null}</View>
                  <Pressable onPress={() => dispatch({ type: 'remove', key: line.key })} accessibilityRole="button" accessibilityLabel={`Remove ${product?.name ?? 'item'}`} hitSlop={10}><Icon name="delete-outline" color={palette.danger} /></Pressable>
                </View>
                <QuantityControl value={line.quantity} onChange={(quantity) => dispatch({ type: 'setQuantity', key: line.key, quantity })} compact />
              </View>
            );
          })}
          <Notice icon="shield-check-outline" text="Delivery fees, discounts and the payable total are calculated and signed by the DASH quote endpoint at checkout." />
          <PrimaryButton label="Review checkout" onPress={onCheckout} />
        </>
      )}
      <PrimaryButton label="Continue browsing" onPress={onBack} secondary={cart.lines.length > 0} />
    </CatalogPage>
  );
}

export function CustomerSearchScreen({ onBack, onPush }: { onBack: () => void; onPush: (route: AppRoute) => void }) {
  const { palette } = useTheme();
  const [query, setQuery] = useState('');
  const { state, reload } = useCustomerSearch(query);
  const results = state.status === 'ready' ? state.data : [];
  return (
    <CatalogPage>
      <BackHeader title="Search DASH" onBack={onBack} />
      <View style={{ minHeight: 52, borderRadius: radius.md, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.surface, flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md, gap: space.sm }}>
        <Icon name="magnify" color={palette.textMuted} />
        <TextInput autoFocus value={query} onChangeText={setQuery} placeholder="Food, shops, products…" placeholderTextColor={palette.textSubtle} accessibilityLabel="Search DASH" style={{ flex: 1, color: palette.text, fontFamily: 'Manrope_500Medium', fontSize: 15 }} />
        {query ? <Pressable onPress={() => setQuery('')} accessibilityRole="button" accessibilityLabel="Clear search"><Icon name="close-circle" color={palette.textMuted} /></Pressable> : null}
      </View>
      {query.trim().length >= 2 && state.status === 'ready' ? <Text variant="heading">{`${results.length} result${results.length === 1 ? '' : 's'}`}</Text> : null}
      {results.map((entry) => (
        <Pressable key={entry.id} onPress={() => onPush(entry.route)} accessibilityRole="button" style={({ pressed }) => ({ minHeight: 78, padding: space.md, borderRadius: radius.lg, flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: pressed ? palette.surfaceMuted : palette.surface, borderWidth: 1, borderColor: palette.line })}>
          <View style={{ width: 58, height: 58, borderRadius: radius.md, overflow: 'hidden', backgroundColor: palette.surfaceMuted }}><CategoryPhoto id={entry.service} size={56} accessibilityLabel={`${entry.title} photo`} /></View>
          <View style={{ flex: 1 }}><Text variant="label" weight="bold">{entry.title}</Text><Text variant="caption" tone="muted">{entry.subtitle}</Text></View><Icon name="chevron-right" color={palette.accent} />
        </Pressable>
      ))}
      {state.status === 'ready' && query.trim().length < 2 ? (
        <View style={{ minHeight: 190, alignItems: 'center', justifyContent: 'center', gap: space.sm }}><Icon name="magnify" size={36} color={palette.textMuted} /><Text variant="heading" align="center">Search DASH</Text><Text variant="caption" tone="muted" align="center">Type at least two letters to search merchants and items.</Text></View>
      ) : null}
      {state.status === 'ready' && query.trim().length >= 2 && results.length === 0 ? <View style={{ minHeight: 190, alignItems: 'center', justifyContent: 'center', gap: space.sm }}><Icon name="magnify-close" size={36} color={palette.textMuted} /><Text variant="heading">No matching result</Text><Text variant="caption" tone="muted">Try a merchant or item name.</Text></View> : null}
      <FeedState state={state} subject="search results" onRetry={reload} />
    </CatalogPage>
  );
}

function MerchantCard({ merchant, service, onPress }: { merchant: Merchant; service: ServiceId; onPress: () => void }) {
  const { palette } = useTheme();
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Open ${merchant.name}`} style={({ pressed }) => ({ borderRadius: radius.lg, overflow: 'hidden', backgroundColor: pressed ? palette.sand : palette.surface, borderWidth: 1, borderColor: palette.line })}><View style={{ height: 126, backgroundColor: merchant.accent, alignItems: 'flex-end', justifyContent: 'center', paddingRight: space.xl }}><CategoryPhoto id={service} size={126} accessibilityLabel={`${merchant.name} photo`} /></View><View style={{ padding: space.md, gap: 3 }}><Text variant="bodyStrong">{merchant.name}</Text><Text variant="caption" tone="muted">{merchant.description}</Text><View style={{ flexDirection: 'row', gap: space.md, marginTop: space.xs }}><Text variant="micro">★ {merchant.rating}</Text><Text variant="micro" tone="muted">{merchant.eta}</Text></View></View></Pressable>;
}

function ProductCard({ product, service, onPress }: { product: Product; service: ServiceId; onPress: () => void }) {
  const { palette } = useTheme();
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Open ${product.name}`} style={{ width: '47.8%', gap: space.sm }}><View style={{ height: 150, borderRadius: radius.lg, backgroundColor: palette.surfaceMuted, alignItems: 'center', justifyContent: 'center' }}><CategoryPhoto id={service} size={126} accessibilityLabel={`${product.name} preview`} />{product.badge ? <View style={{ position: 'absolute', top: space.sm, left: space.sm, borderRadius: radius.pill, backgroundColor: palette.surface, paddingHorizontal: space.sm, paddingVertical: 3 }}><Text variant="micro" tone="accent">{product.badge}</Text></View> : null}</View><Text variant="label" weight="bold" numberOfLines={2}>{product.name}</Text><Text variant="caption" tone="accent">{product.price}</Text></Pressable>;
}

function CatalogPage({ children }: { children: ReactNode }) {
  const { palette } = useTheme();
  return <ScrollView style={{ flex: 1, backgroundColor: palette.background }} contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: space.xxxl, gap: space.lg }} showsVerticalScrollIndicator={false}>{children}</ScrollView>;
}

function BackHeader({ title, onBack, cart }: { title: string; onBack: () => void; cart?: () => void }) {
  const { palette } = useTheme();
  return <View style={{ minHeight: 54, flexDirection: 'row', alignItems: 'center' }}><Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Go back" style={{ width: touchTarget, height: touchTarget, alignItems: 'center', justifyContent: 'center' }}><Icon name="arrow-left" color={palette.text} /></Pressable><Text variant="appBar" style={{ flex: 1 }} numberOfLines={1}>{title}</Text>{cart ? <Pressable onPress={cart} accessibilityRole="button" accessibilityLabel="Open cart" style={{ width: touchTarget, height: touchTarget, alignItems: 'center', justifyContent: 'center' }}><Icon name="cart-outline" color={palette.text} /></Pressable> : null}</View>;
}

function SearchShell({ label }: { label: string }) {
  const { palette } = useTheme();
  return <View style={{ minHeight: 50, borderRadius: radius.md, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md, gap: space.sm }}><Icon name="magnify" color={palette.textMuted} /><Text variant="caption" tone="muted" style={{ flex: 1 }}>{label}</Text><Icon name="tune-variant" color={palette.text} /></View>;
}

function InfoChip({ icon, text }: { icon: IconName; text: string }) {
  const { palette } = useTheme();
  return <View style={{ flex: 1, minHeight: 54, borderRadius: radius.md, backgroundColor: palette.surfaceMuted, alignItems: 'center', justifyContent: 'center', gap: 2 }}><Icon name={icon} size={17} color={palette.accent} /><Text variant="micro" align="center">{text}</Text></View>;
}

function OptionRow({ title, options, selected, onSelect }: { title: string; options: readonly string[]; selected: string; onSelect: (value: string) => void }) {
  const { palette } = useTheme();
  return <View style={{ gap: space.sm }}><Text variant="label" weight="bold">{title}</Text><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>{options.map((option) => <Pressable key={option} onPress={() => onSelect(option)} accessibilityRole="radio" accessibilityState={{ selected: option === selected }} style={{ minHeight: 42, justifyContent: 'center', paddingHorizontal: space.md, borderRadius: radius.pill, backgroundColor: option === selected ? palette.inverse : palette.surface, borderWidth: 1, borderColor: option === selected ? palette.inverse : palette.line }}><Text variant="caption" tone={option === selected ? 'onInverse' : 'default'}>{option}</Text></Pressable>)}</View></View>;
}

function QuantityControl({ value, onChange, compact = false }: { value: number; onChange: (value: number) => void; compact?: boolean }) {
  const { palette } = useTheme();
  return <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: compact ? 'flex-end' : 'space-between', gap: space.md }}>
    {!compact ? <Text variant="label" weight="bold">Quantity</Text> : null}
    <View style={{ flexDirection: 'row', alignItems: 'center', borderRadius: radius.pill, backgroundColor: palette.surfaceMuted, overflow: 'hidden' }}>
      <Pressable onPress={() => onChange(Math.max(compact ? 0 : 1, value - 1))} accessibilityRole="button" accessibilityLabel="Decrease quantity" style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><Icon name="minus" color={palette.text} /></Pressable>
      <Text variant="label" weight="bold" align="center" style={{ minWidth: 28 }}>{value}</Text>
      <Pressable onPress={() => onChange(Math.min(20, value + 1))} accessibilityRole="button" accessibilityLabel="Increase quantity" style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><Icon name="plus" color={palette.text} /></Pressable>
    </View>
  </View>;
}

function Notice({ icon, text }: { icon: IconName; text: string }) {
  const { palette } = useTheme();
  return <View style={{ flexDirection: 'row', gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: palette.accentSoft }}><Icon name={icon} color={palette.accent} /><Text variant="caption" style={{ flex: 1 }}>{text}</Text></View>;
}

function PrimaryButton({ label, onPress, disabled = false, secondary = false }: { label: string; onPress: () => void; disabled?: boolean; secondary?: boolean }) {
  const { palette } = useTheme();
  return <Pressable disabled={disabled} onPress={onPress} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} style={({ pressed }) => ({ minHeight: 52, borderRadius: radius.md, opacity: disabled ? 0.55 : 1, backgroundColor: secondary ? (pressed ? palette.surfaceMuted : palette.surface) : (pressed ? palette.accentPressed : palette.accent), borderWidth: secondary ? 1 : 0, borderColor: palette.line, alignItems: 'center', justifyContent: 'center' })}><Text variant="label" tone={secondary ? 'default' : 'onAccent'} weight="bold">{label}</Text></Pressable>;
}

/**
 * What a screen shows instead of a list, whenever there is no list to show.
 *
 * Each arm names the actual situation rather than blaming the person: a build
 * with no API origin is a build problem, an unreachable server is a network
 * problem, and an empty category is simply empty.
 */
function FeedState({ state, subject, onRetry }: { state: Feed<unknown>; subject: string; onRetry?: () => void }) {
  const { palette } = useTheme();
  if (state.status === 'ready') return null;
  if (state.status === 'loading') {
    return (
      <View style={{ minHeight: 220, alignItems: 'center', justifyContent: 'center', gap: space.sm }}>
        <ActivityIndicator color={palette.accent} />
        <Text variant="caption" tone="muted">Loading {subject}…</Text>
      </View>
    );
  }
  const notConnected = state.status === 'not-connected';
  return (
    <View style={{ minHeight: 220, alignItems: 'center', justifyContent: 'center', gap: space.sm, padding: space.lg }}>
      <View style={{ width: 70, height: 70, borderRadius: 24, backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={notConnected ? 'cloud-off-outline' : 'alert-circle-outline'} size={34} color={palette.accent} />
      </View>
      <Text variant="heading" align="center">{notConnected ? 'Not connected to DASH' : `Could not load ${subject}`}</Text>
      <Text variant="caption" tone="muted" align="center">
        {notConnected
          ? 'This build has no DASH API address, so there are no merchants to show. It is a build setting (EXPO_PUBLIC_API_URL), not something to fix on the phone.'
          : state.status === 'error'
            ? state.message
            : ''}
      </Text>
      {!notConnected && onRetry ? <PrimaryButton label="Try again" onPress={onRetry} secondary /> : null}
    </View>
  );
}

/** The one place a failed catalogue request becomes something to read. */
function feedError(caught: unknown): Feed<never> {
  return { status: 'error', message: caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.' };
}

/**
 * A rating only when the server has actually counted one. A vendor with no
 * ratings gets `null`, never "0.0" and never a borrowed number.
 */
function ratingLabel(rating: { average: number; count: number } | null | undefined): string | null {
  if (!rating || rating.count <= 0 || !Number.isFinite(rating.average)) return null;
  return rating.average.toFixed(1);
}

function useMerchantList(service: ServiceId): { state: Feed<readonly Merchant[]>; reload: () => void } {
  const [state, setState] = useState<Feed<readonly Merchant[]>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!api.configured) {
      setState({ status: 'not-connected' });
      return;
    }
    setState({ status: 'loading' });
    const controller = new AbortController();
    const query = service === 'declutter' ? 'category=declutter' : `service=${service === 'local-market' ? 'local_market' : service}`;
    api.request<{ vendors: ApiVendorSummary[] }>(`/v1/vendors?${query}&limit=20`, { auth: false, signal: controller.signal })
      .then(({ vendors }) => {
        setState({
          status: 'ready',
          data: vendors.map((vendor) => ({
            id: vendor.slug,
            name: vendor.name,
            description: vendor.description,
            rating: ratingLabel(vendor.rating),
            eta: vendor.branch ? `${vendor.branch.estimatedMinutes} min estimate` : null,
            accent: serviceAccent(service),
          })),
        });
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setState(feedError(caught));
      });
    return () => controller.abort();
  }, [service, attempt]);
  return { state, reload: () => setAttempt((value) => value + 1) };
}

interface StorefrontData {
  merchant: Merchant;
  products: readonly Product[];
}

function useStorefront(service: ServiceId, merchantId: string): { state: Feed<StorefrontData>; reload: () => void } {
  const [state, setState] = useState<Feed<StorefrontData>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!api.configured) {
      setState({ status: 'not-connected' });
      return;
    }
    if (!merchantId) {
      setState({ status: 'error', message: 'No merchant was selected.' });
      return;
    }
    setState({ status: 'loading' });
    const controller = new AbortController();
    api.request<{ vendor: ApiVendorDetail }>(`/v1/vendors/${encodeURIComponent(merchantId)}`, { auth: false, signal: controller.signal })
      .then(({ vendor }) => {
        const items = vendor.categories.flatMap((category) => category.items);
        setState({
          status: 'ready',
          data: {
            merchant: {
              id: vendor.slug,
              name: vendor.name,
              description: vendor.description,
              // The detail endpoint sends an average with no count, so a zero
              // is indistinguishable from "never rated". Both show as no
              // rating, which is the honest reading of either.
              rating: Number.isFinite(vendor.ratingAverage) && vendor.ratingAverage > 0 ? vendor.ratingAverage.toFixed(1) : null,
              eta: null,
              accent: serviceAccent(service),
            },
            products: items.map((item) => ({
              id: item.id,
              name: item.name,
              description: item.description,
              price: formatNairaCompact(item.price as Kobo),
              badge: item.condition ? conditionLabel(item.condition) : item.isAvailable ? undefined : 'Unavailable',
              available: item.isAvailable,
            })),
          },
        });
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setState(feedError(caught));
      });
    return () => controller.abort();
  }, [merchantId, service, attempt]);
  return { state, reload: () => setAttempt((value) => value + 1) };
}

function serviceAccent(service: ServiceId): string {
  return service === 'food' ? '#D88F67' : service === 'shops' ? '#87A9CC' : service === 'pharmacy' ? '#83B998' : service === 'local-market' ? '#D6A552' : service === 'declutter' ? '#B89CC8' : '#8FA987';
}

function conditionLabel(value: string): string {
  return value.replace('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
}

function isServiceId(value: string): value is ServiceId {
  return value === 'food' || value === 'shops' || value === 'pharmacy' || value === 'local-market' || value === 'declutter' || value === 'logistics';
}


/**
 * The cart stores a merchant slug and nothing else — names and prices belong
 * to the server, so the cart cannot go stale against them. Until the store
 * loads, the slug read back as words is the most the app honestly knows.
 */
function merchantLabel(slug: string | null, live: string | null): string {
  if (live) return live;
  if (!slug) return 'this merchant';
  return slug.replace(/-/g, ' ');
}

interface SearchHit {
  id: string;
  service: ServiceId;
  title: string;
  subtitle: string;
  route: AppRoute;
}

/** `GET /v1/search`, which answers with approved vendors and available items. */
interface ApiSearchResponse {
  vendors: Array<{ id: string; name: string; slug: string; category: string; ratingAverage: number; serviceCategory: string | null }>;
  items: Array<{ id: string; name: string; price: number; vendor: { id: string; name: string; slug: string } }>;
}

/**
 * The API's `serviceCategory` in the client's spelling. The server uses
 * `local_market`; the six category screens use `local-market`. A vendor whose
 * category maps to neither (Declutter is persisted as a legacy vendor row)
 * falls back to Shops, which is where its storefront renders.
 */
function serviceIdFor(serviceCategory: string | null): ServiceId {
  if (serviceCategory === 'local_market') return 'local-market';
  return isServiceId(serviceCategory ?? '') ? (serviceCategory as ServiceId) : 'shops';
}

/**
 * Search asks the server and shows what comes back. There is no local index
 * to fall back on: an app that answers "Urban Bites" to a search when no such
 * merchant exists is worse than one that says it cannot search yet.
 *
 * The server needs two characters, and the keystrokes are debounced, so
 * typing a word is one request rather than one per letter.
 */
function useCustomerSearch(query: string): { state: Feed<readonly SearchHit[]>; reload: () => void } {
  const [state, setState] = useState<Feed<readonly SearchHit[]>>({ status: 'ready', data: [] });
  const [attempt, setAttempt] = useState(0);
  const needle = query.trim();
  useEffect(() => {
    if (!api.configured) {
      setState({ status: 'not-connected' });
      return;
    }
    if (needle.length < 2) {
      setState({ status: 'ready', data: [] });
      return;
    }
    setState({ status: 'loading' });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.request<ApiSearchResponse>(`/v1/search?q=${encodeURIComponent(needle)}&limit=15`, { auth: false, signal: controller.signal })
        .then((response) => {
          const vendors: SearchHit[] = response.vendors.map((vendor) => {
            const service = serviceIdFor(vendor.serviceCategory);
            return {
              id: `vendor-${vendor.slug}`,
              service,
              title: vendor.name,
              subtitle: SERVICE_COPY[service].title,
              route: { name: 'customer.store', params: { category: service, id: vendor.slug } },
            };
          });
          const items: SearchHit[] = response.items.map((item) => ({
            id: `item-${item.id}`,
            service: 'shops',
            title: item.name,
            subtitle: `${item.vendor.name} · ${formatNairaCompact(item.price as Kobo)}`,
            route: { name: 'customer.product', params: { category: 'shops', store: item.vendor.slug, id: item.id } },
          }));
          setState({ status: 'ready', data: [...vendors, ...items] });
        })
        .catch((caught: unknown) => {
          if (controller.signal.aborted) return;
          setState(feedError(caught));
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [needle, attempt]);
  return { state, reload: () => setAttempt((value) => value + 1) };
}
