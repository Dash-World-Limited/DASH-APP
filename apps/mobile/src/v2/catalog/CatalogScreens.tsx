import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, Pressable, ScrollView, TextInput, View } from 'react-native';
import { formatNairaCompact, type Kobo } from '@dash/domain/money';

import { api } from '../../api';
import { useCart } from '../../features/CartProvider';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, space, touchTarget } from '../../theme/tokens';
import { Icon, type IconName } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import type { ServiceId } from '../artwork/CategoryArtwork';
import { CategoryPhoto } from '../artwork/CategoryPhoto';
import type { AppRoute } from '../navigation/model';

interface Merchant {
  id: string;
  name: string;
  description: string;
  rating: string;
  eta: string;
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

const MERCHANTS: Record<ServiceId, readonly Merchant[]> = {
  food: [
    { id: 'urban-bites', name: 'Urban Bites', description: 'Rice, grills and everyday favourites', rating: '4.8', eta: '25–35 min', accent: '#D88F67' },
    { id: 'mamas-kitchen', name: 'Mama’s Kitchen', description: 'Nigerian soups and swallows', rating: '4.7', eta: '30–40 min', accent: '#E3B85F' },
    { id: 'chop-corner', name: 'Chop Corner', description: 'Quick meals and combos', rating: '4.6', eta: '20–30 min', accent: '#9EB47C' },
  ],
  shops: [
    { id: 'tech-world', name: 'TechWorld', description: 'Phones, audio and accessories', rating: '4.9', eta: '35–50 min', accent: '#87A9CC' },
    { id: 'style-hub', name: 'StyleHub', description: 'Fashion and everyday style', rating: '4.7', eta: '40–55 min', accent: '#C0A0CD' },
    { id: 'home-essentials', name: 'Home Essentials', description: 'Useful things for every room', rating: '4.8', eta: '35–50 min', accent: '#91AD8A' },
  ],
  pharmacy: [
    { id: 'wellspring', name: 'Wellspring Pharmacy', description: 'Wellness and personal care', rating: '4.9', eta: '20–35 min', accent: '#83B998' },
    { id: 'carepoint', name: 'CarePoint Pharmacy', description: 'Trusted everyday health essentials', rating: '4.8', eta: '25–40 min', accent: '#8CB9B0' },
  ],
  'local-market': [
    { id: 'fresh-basket', name: 'Fresh Basket', description: 'Vegetables, fruit and pantry staples', rating: '4.7', eta: '30–45 min', accent: '#D48C63' },
    { id: 'market-square', name: 'Market Square Seller', description: 'Measured and packed to order', rating: '4.6', eta: '35–50 min', accent: '#D6A552' },
  ],
  declutter: [
    { id: 'home-reset', name: 'Home Reset Finds', description: 'Furniture and home items', rating: '4.8', eta: 'Arrange delivery', accent: '#B89CC8' },
    { id: 'second-life-tech', name: 'Second Life Tech', description: 'Inspected pre-owned devices', rating: '4.7', eta: 'Arrange delivery', accent: '#8EA8C4' },
  ],
  logistics: [
    { id: 'bike-delivery', name: 'Bike Delivery', description: 'Documents and small packages', rating: 'Live quote', eta: 'Same day', accent: '#8FA987' },
    { id: 'car-van', name: 'Car & Van Delivery', description: 'Larger items and careful handling', rating: 'Live quote', eta: 'Scheduled', accent: '#D2A45C' },
  ],
};

const PRODUCTS: Record<ServiceId, readonly Product[]> = {
  food: [
    { id: 'jollof-chicken', name: 'Jollof Rice & Chicken', price: '₦5,500', description: 'Smoky jollof rice with grilled chicken.', badge: 'Popular' },
    { id: 'egusi-swallow', name: 'Egusi Soup & Swallow', price: '₦6,200', description: 'Rich egusi soup with your choice of swallow.' },
    { id: 'grill-combo', name: 'DASH Grill Combo', price: '₦8,900', description: 'Chicken, plantain, slaw and pepper sauce.' },
  ],
  shops: [
    { id: 'iphone-15-pro', name: 'iPhone 15 Pro', price: '₦1,250,000', description: 'Brand-new device with selectable storage.', badge: 'Featured' },
    { id: 'wireless-buds', name: 'Wireless Earbuds', price: '₦185,000', description: 'Noise cancellation and charging case.' },
    { id: 'home-lamp', name: 'Minimal Table Lamp', price: '₦38,500', description: 'Warm light for bedside or workspace.' },
  ],
  pharmacy: [
    { id: 'first-aid-kit', name: 'Home First Aid Kit', price: '₦24,500', description: 'Everyday first-aid essentials in one case.' },
    { id: 'vitamin-c', name: 'Vitamin C', price: '₦8,900', description: 'Daily wellness supplement.' },
    { id: 'personal-care', name: 'Personal Care Pack', price: '₦16,500', description: 'Care essentials packed together.' },
  ],
  'local-market': [
    { id: 'tomato-basket', name: 'Fresh Tomato Basket', price: '₦12,000', description: 'Freshly selected and packed.' },
    { id: 'pepper-mix', name: 'Pepper Mix', price: '₦6,500', description: 'Tomato, pepper and onion mix.' },
    { id: 'fruit-box', name: 'Seasonal Fruit Box', price: '₦18,000', description: 'A practical mix of fresh fruit.' },
  ],
  declutter: [
    { id: 'reading-chair', name: 'Accent Reading Chair', price: '₦95,000', description: 'Clean fabric chair with light signs of use.', badge: 'Good' },
    { id: 'used-phone', name: 'Pre-owned Smartphone', price: '₦220,000', description: 'Inspected device; battery and condition disclosed.', badge: 'Like new' },
    { id: 'bookshelf', name: 'Compact Bookshelf', price: '₦45,000', description: 'Sturdy shelf suitable for a small room.', badge: 'Fair' },
  ],
  logistics: [
    { id: 'small-package', name: 'Small Package', price: 'Get quote', description: 'Bike delivery for documents and small parcels.' },
    { id: 'large-item', name: 'Large Item', price: 'Get quote', description: 'Car or van delivery for larger items.' },
  ],
};

export function CategoryDashboard({ id, onBack, onPush }: { id: string; onBack: () => void; onPush: (route: AppRoute) => void }) {
  const service = isServiceId(id) ? id : 'food';
  const copy = SERVICE_COPY[service];
  const { palette } = useTheme();
  const { merchants, live } = useMerchantList(service);
  return (
    <CatalogPage>
      <BackHeader title={copy.title} onBack={onBack} cart={() => onPush({ name: 'customer.cart' })} />
      <View style={{ minHeight: 132, borderRadius: radius.xl, backgroundColor: palette.accentSoft, padding: space.lg, flexDirection: 'row', alignItems: 'center', overflow: 'hidden' }}>
        <View style={{ flex: 1, gap: space.xs }}><Text variant="title">{copy.title}</Text><Text variant="caption" tone="muted">{copy.intro}</Text></View>
        <CategoryPhoto id={service} size={112} accessibilityLabel={`${copy.title} category photo`} />
      </View>
      <SearchShell label={copy.search} />
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><Text variant="heading">Near you</Text><Text variant="caption" tone="accent">See all</Text></View>
      {merchants.map((merchant) => <MerchantCard key={merchant.id} merchant={merchant} service={service} onPress={() => onPush({ name: 'customer.store', params: { category: service, id: merchant.id } })} />)}
      <DataSourceNote live={live} />
    </CatalogPage>
  );
}

export function Storefront({ category, merchantId, onBack, onPush }: { category: string; merchantId: string; onBack: () => void; onPush: (route: AppRoute) => void }) {
  const service = isServiceId(category) ? category : 'food';
  const { merchant, products, live } = useStorefront(service, merchantId);
  const { palette } = useTheme();
  return (
    <CatalogPage>
      <BackHeader title={merchant?.name ?? SERVICE_COPY[service].title} onBack={onBack} cart={() => onPush({ name: 'customer.cart' })} />
      <View style={{ minHeight: 174, borderRadius: radius.xl, backgroundColor: merchant?.accent ?? palette.accentSoft, padding: space.xl, justifyContent: 'flex-end', overflow: 'hidden' }}>
        <View style={{ position: 'absolute', right: -16, top: -10, opacity: 0.96 }}><CategoryPhoto id={service} size={168} accessibilityLabel={`${SERVICE_COPY[service].title} store photo`} /></View>
        <View style={{ maxWidth: '67%' }}><Text variant="title" style={{ color: '#15171A' }}>{merchant?.name}</Text><Text variant="caption" style={{ color: '#33312D' }}>{merchant?.description}</Text></View>
      </View>
      <View style={{ flexDirection: 'row', gap: space.sm }}><InfoChip icon="star" text={merchant?.rating ?? 'New'} /><InfoChip icon="clock-outline" text={merchant?.eta ?? 'Nearby'} /><InfoChip icon="bike-fast" text="Delivery" /></View>
      <Text variant="heading">Available now</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
        {products.map((product) => <ProductCard key={product.id} product={product} service={service} onPress={() => onPush({ name: 'customer.product', params: { category: service, store: merchant?.id ?? '', id: product.id } })} />)}
      </View>
      <DataSourceNote live={live} />
    </CatalogPage>
  );
}

export function ProductDetail({ category, merchantId, productId, onBack, onCart }: { category: string; merchantId: string; productId: string; onBack: () => void; onCart: () => void }) {
  const service = isServiceId(category) ? category : 'food';
  const { products } = useStorefront(service, merchantId);
  const product = products.find((item) => item.id === productId) ?? products[0];
  const { palette } = useTheme();
  const { dispatch, refusalFor } = useCart();
  const [quantity, setQuantity] = useState(1);
  const optionTitle = service === 'shops' ? 'Storage' : service === 'food' ? 'Portion' : null;
  const optionValues = service === 'shops' ? ['128 GB', '256 GB', '512 GB'] : service === 'food' ? ['Regular', 'Large'] : [];
  const [selectedOption, setSelectedOption] = useState(optionValues[0] ?? '');

  const addToCart = () => {
    if (!product || product.available === false) return;
    if (product.price === 'Get quote') {
      Alert.alert('Logistics quote', 'Pickup, destination and package details are collected in the logistics booking milestone.');
      return;
    }
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
  return (
    <CatalogPage>
      <BackHeader title="Item details" onBack={onBack} cart={onCart} />
      <View style={{ height: 280, borderRadius: radius.xl, backgroundColor: palette.surfaceMuted, alignItems: 'center', justifyContent: 'center' }}><CategoryPhoto id={service} size={238} accessibilityLabel={`${SERVICE_COPY[service].title} product photo`} /></View>
      {product?.badge ? <View style={{ alignSelf: 'flex-start', backgroundColor: palette.accentSoft, paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill }}><Text variant="micro" tone="accent">{product.badge}</Text></View> : null}
      <Text variant="title">{product?.name}</Text>
      <Text variant="heading" tone="accent">{product?.price}</Text>
      <Text tone="muted">{product?.description}</Text>
      {optionTitle ? <OptionRow title={optionTitle} options={optionValues} selected={selectedOption} onSelect={setSelectedOption} /> : null}
      {service === 'declutter' ? <Notice icon="shield-check-outline" text="Condition, defects and seller verification must be disclosed before checkout." /> : null}
      {product?.price !== 'Get quote' ? <QuantityControl value={quantity} onChange={setQuantity} /> : null}
      <PrimaryButton label={product?.available === false ? 'Currently unavailable' : product?.price === 'Get quote' ? 'Start delivery quote' : `Add ${quantity} to cart`} onPress={addToCart} disabled={product?.available === false} />
    </CatalogPage>
  );
}

export function CartScreen({ onBack, onCheckout }: { onBack: () => void; onCheckout: () => void }) {
  const { palette } = useTheme();
  const { cart, count, dispatch } = useCart();
  return (
    <CatalogPage>
      <BackHeader title="Your cart" onBack={onBack} />
      {cart.lines.length === 0 ? (
        <View style={{ minHeight: 220, alignItems: 'center', justifyContent: 'center', gap: space.sm }}><View style={{ width: 72, height: 72, borderRadius: 24, backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name="cart-outline" size={34} color={palette.accent} /></View><Text variant="heading">Your cart is empty</Text><Text tone="muted" align="center">Choose an item from a restaurant, shop, pharmacy or market seller.</Text></View>
      ) : (
        <>
          <Notice icon="storefront-outline" text={`${count} item${count === 1 ? '' : 's'} from ${merchantLabel(cart.merchantSlug)}. One merchant is kept per order.`} />
          {cart.lines.map((line) => {
            const product = findPreviewProduct(line.productId);
            return (
              <View key={line.key} style={{ padding: space.lg, gap: space.md, borderRadius: radius.lg, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line }}>
                <View style={{ flexDirection: 'row', gap: space.md, alignItems: 'center' }}>
                  <View style={{ width: 68, height: 68, borderRadius: radius.md, overflow: 'hidden', backgroundColor: palette.surfaceMuted, alignItems: 'center', justifyContent: 'center' }}><CategoryPhoto id={product?.service ?? 'shops'} size={64} accessibilityLabel={`${product?.name ?? 'Cart item'} photo`} /></View>
                  <View style={{ flex: 1, gap: 2 }}><Text variant="label" weight="bold">{product?.name ?? 'DASH item'}</Text><Text variant="caption" tone="accent">{product?.price ?? 'Price confirmed by server'}</Text>{Object.values(line.options).length ? <Text variant="micro" tone="muted">{Object.values(line.options).join(' · ')}</Text> : null}</View>
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
  const results = useMemo(() => searchPreview(query), [query]);
  return (
    <CatalogPage>
      <BackHeader title="Search DASH" onBack={onBack} />
      <View style={{ minHeight: 52, borderRadius: radius.md, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.surface, flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md, gap: space.sm }}>
        <Icon name="magnify" color={palette.textMuted} />
        <TextInput autoFocus value={query} onChangeText={setQuery} placeholder="Food, shops, products…" placeholderTextColor={palette.textSubtle} accessibilityLabel="Search DASH" style={{ flex: 1, color: palette.text, fontFamily: 'Manrope_500Medium', fontSize: 15 }} />
        {query ? <Pressable onPress={() => setQuery('')} accessibilityRole="button" accessibilityLabel="Clear search"><Icon name="close-circle" color={palette.textMuted} /></Pressable> : null}
      </View>
      {!query.trim() ? <Notice icon="magnify" text="Search across all six DASH categories. Results below are interactive development data until the API URL is configured." /> : null}
      <Text variant="heading">{query.trim() ? `${results.length} result${results.length === 1 ? '' : 's'}` : 'Popular now'}</Text>
      {results.map((entry) => (
        <Pressable key={`${entry.service}-${entry.kind}-${entry.id}`} onPress={() => onPush(entry.route)} accessibilityRole="button" style={({ pressed }) => ({ minHeight: 78, padding: space.md, borderRadius: radius.lg, flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: pressed ? palette.surfaceMuted : palette.surface, borderWidth: 1, borderColor: palette.line })}>
          <View style={{ width: 58, height: 58, borderRadius: radius.md, overflow: 'hidden', backgroundColor: palette.surfaceMuted }}><CategoryPhoto id={entry.service} size={56} accessibilityLabel={`${entry.title} photo`} /></View>
          <View style={{ flex: 1 }}><Text variant="label" weight="bold">{entry.title}</Text><Text variant="caption" tone="muted">{entry.subtitle}</Text></View><Icon name="chevron-right" color={palette.accent} />
        </Pressable>
      ))}
      {query.trim() && results.length === 0 ? <View style={{ minHeight: 190, alignItems: 'center', justifyContent: 'center', gap: space.sm }}><Icon name="magnify-close" size={36} color={palette.textMuted} /><Text variant="heading">No matching result</Text><Text variant="caption" tone="muted">Try a category, shop or product name.</Text></View> : null}
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

function DataSourceNote({ live }: { live: boolean }) {
  const { palette } = useTheme();
  return <View style={{ flexDirection: 'row', gap: space.sm, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: palette.line }}><Icon name={live ? 'cloud-check-outline' : 'flask-outline'} color={live ? palette.success : palette.textMuted} size={18} /><Text variant="micro" tone={live ? 'success' : 'muted'} style={{ flex: 1 }}>{live ? 'Live merchants, availability and prices from the DASH API.' : 'Interface preview. Configure EXPO_PUBLIC_API_URL to load the live DASH catalogue.'}</Text></View>;
}

function useMerchantList(service: ServiceId): { merchants: readonly Merchant[]; live: boolean } {
  const [state, setState] = useState<{ merchants: readonly Merchant[]; live: boolean }>({ merchants: MERCHANTS[service], live: false });
  useEffect(() => {
    setState({ merchants: MERCHANTS[service], live: false });
    if (!api.configured || service === 'logistics') return;
    const controller = new AbortController();
    const query = service === 'declutter' ? 'category=declutter' : `service=${service === 'local-market' ? 'local_market' : service}`;
    api.request<{ vendors: ApiVendorSummary[] }>(`/v1/vendors?${query}&limit=20`, { auth: false, signal: controller.signal })
      .then(({ vendors }) => {
        if (vendors.length === 0) return;
        setState({
          live: true,
          merchants: vendors.map((vendor) => ({
            id: vendor.slug,
            name: vendor.name,
            description: vendor.description,
            rating: vendor.rating.average.toFixed(1),
            eta: vendor.branch ? `${vendor.branch.estimatedMinutes} min estimate` : 'See store',
            accent: serviceAccent(service),
          })),
        });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [service]);
  return state;
}

function useStorefront(service: ServiceId, merchantId: string): { merchant: Merchant | undefined; products: readonly Product[]; live: boolean } {
  const fallbackMerchant = MERCHANTS[service].find((item) => item.id === merchantId) ?? MERCHANTS[service][0];
  const [state, setState] = useState<{ merchant: Merchant | undefined; products: readonly Product[]; live: boolean }>({ merchant: fallbackMerchant, products: PRODUCTS[service], live: false });
  useEffect(() => {
    const preview = MERCHANTS[service].find((item) => item.id === merchantId) ?? MERCHANTS[service][0];
    setState({ merchant: preview, products: PRODUCTS[service], live: false });
    if (!api.configured || !merchantId || service === 'logistics') return;
    const controller = new AbortController();
    api.request<{ vendor: ApiVendorDetail }>(`/v1/vendors/${encodeURIComponent(merchantId)}`, { auth: false, signal: controller.signal })
      .then(({ vendor }) => {
        const items = vendor.categories.flatMap((category) => category.items);
        setState({
          live: true,
          merchant: {
            id: vendor.slug,
            name: vendor.name,
            description: vendor.description,
            rating: vendor.ratingAverage.toFixed(1),
            eta: 'Live availability',
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
        });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [merchantId, service]);
  return state;
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

function findPreviewProduct(productId: string): (Product & { service: ServiceId }) | undefined {
  for (const service of Object.keys(PRODUCTS) as ServiceId[]) {
    const product = PRODUCTS[service].find((item) => item.id === productId);
    if (product) return { ...product, service };
  }
  return undefined;
}

function merchantLabel(slug: string | null): string {
  if (!slug) return 'this merchant';
  for (const service of Object.keys(MERCHANTS) as ServiceId[]) {
    const merchant = MERCHANTS[service].find((item) => item.id === slug);
    if (merchant) return merchant.name;
  }
  return slug.replace(/-/g, ' ');
}

function searchPreview(query: string): Array<{ id: string; service: ServiceId; kind: 'merchant' | 'product'; title: string; subtitle: string; route: AppRoute }> {
  const needle = query.trim().toLowerCase();
  const entries: Array<{ id: string; service: ServiceId; kind: 'merchant' | 'product'; title: string; subtitle: string; route: AppRoute }> = [];
  for (const service of Object.keys(MERCHANTS) as ServiceId[]) {
    for (const merchant of MERCHANTS[service]) {
      entries.push({ id: merchant.id, service, kind: 'merchant', title: merchant.name, subtitle: `${SERVICE_COPY[service].title} · ${merchant.description}`, route: { name: 'customer.store', params: { category: service, id: merchant.id } } });
    }
    const store = MERCHANTS[service][0];
    for (const product of PRODUCTS[service]) {
      entries.push({ id: product.id, service, kind: 'product', title: product.name, subtitle: `${SERVICE_COPY[service].title} · ${product.price}`, route: { name: 'customer.product', params: { category: service, store: store?.id ?? '', id: product.id } } });
    }
  }
  const filtered = needle ? entries.filter((entry) => `${entry.title} ${entry.subtitle}`.toLowerCase().includes(needle)) : entries.filter((entry) => entry.kind === 'product');
  return filtered.slice(0, needle ? 20 : 8);
}
