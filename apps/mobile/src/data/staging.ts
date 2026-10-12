/**
 * STAGING FIXTURES — sample data, not DASH activity.
 *
 * Every merchant, product, price, rating, earning and route in this file is
 * sample content taken from the director-approved boards, so the screens can
 * be judged against them before the backend serves these fields. None of it is
 * real, and screens that draw from here say so (see `SampleDataNote`).
 *
 * The photographs are cropped from the boards themselves — interim artwork of
 * the approved content, soft at device resolution, to be replaced by master
 * assets and by merchants' own uploads. See assets/staging/README.md.
 *
 * Nothing in the app may treat a value from this file as authoritative. The
 * cart's quote below stands in for the server's; the live app asks
 * /v1/orders/quote, which is the only place a fee is decided.
 */

import { add, multiply, naira, type Kobo } from '@dash/domain/money';

import storeHero from '../../assets/staging/customer/store-techworld-hero.png';
import catElectronics from '../../assets/staging/customer/cat-electronics.png';
import catFashion from '../../assets/staging/customer/cat-fashion.png';
import catHomeLiving from '../../assets/staging/customer/cat-home-living.png';
import airpods from '../../assets/staging/customer/product-airpods-pro-2.png';
import galaxy from '../../assets/staging/customer/product-galaxy-s24.png';
import iphoneHero from '../../assets/staging/customer/product-iphone-15-pro-hero.png';
import iphone from '../../assets/staging/customer/product-iphone-15-pro.png';
import iphoneView1 from '../../assets/staging/customer/product-iphone-15-pro-view-1.png';
import iphoneView2 from '../../assets/staging/customer/product-iphone-15-pro-view-2.png';
import iphoneView3 from '../../assets/staging/customer/product-iphone-15-pro-view-3.png';
import macbook from '../../assets/staging/customer/product-macbook-air-m3.png';
import homeEssentialsCover from '../../assets/staging/customer/shop-homeessentials-cover.png';
import homeEssentialsLogo from '../../assets/staging/customer/shop-homeessentials-logo.png';
import styleHubCover from '../../assets/staging/customer/shop-stylehub-cover.png';
import styleHubLogo from '../../assets/staging/customer/shop-stylehub-logo.png';
import techWorldCover from '../../assets/staging/customer/shop-techworld-cover.png';
import techWorldLogo from '../../assets/staging/customer/shop-techworld-logo.png';
import riderAvatar from '../../assets/staging/rider/avatar-rider.png';
import urbanBites from '../../assets/staging/rider/merchant-urban-bites.png';
import urbanBites2 from '../../assets/staging/rider/merchant-urban-bites-2.png';

import type {
  MerchantModel,
  ProductModel,
  QuoteModel,
  RiderJobModel,
  RiderOfferModel,
  RiderProfileModel,
  RiderTodayModel,
  ShopCategoryModel,
} from './models';

// --- Customer: Shops ---------------------------------------------------------

export const SHOP_CATEGORIES: readonly ShopCategoryModel[] = [
  { id: 'all', label: 'All', image: null },
  { id: 'electronics', label: 'Electronics', image: catElectronics },
  { id: 'fashion', label: 'Fashion', image: catFashion },
  { id: 'home-living', label: 'Home & Living', image: catHomeLiving },
];

const TECHWORLD: MerchantModel = {
  slug: 'techworld',
  name: 'TechWorld',
  descriptor: 'Electronics & Gadgets',
  cover: techWorldCover,
  logo: techWorldLogo,
  rating: { average: 4.8, count: 1200 },
  eta: { min: 20, max: 35 },
};

const STYLEHUB: MerchantModel = {
  slug: 'stylehub',
  name: 'StyleHub',
  descriptor: 'Fashion & Accessories',
  cover: styleHubCover,
  logo: styleHubLogo,
  rating: { average: 4.7, count: 860 },
  eta: { min: 25, max: 40 },
};

const HOME_ESSENTIALS: MerchantModel = {
  slug: 'homeessentials',
  name: 'HomeEssentials',
  descriptor: 'Home & Living',
  cover: homeEssentialsCover,
  logo: homeEssentialsLogo,
  rating: { average: 4.6, count: 540 },
  eta: { min: 30, max: 45 },
};

/**
 * The boards title these "Featured Shops" and "Popular Near You". In the
 * wired app neither may be invented: featured is an editorial choice
 * operations makes, and "popular" needs order counts the API would have to
 * serve. Until then the sections are sample content.
 */
export const FEATURED_SHOPS: readonly MerchantModel[] = [TECHWORLD, STYLEHUB, HOME_ESSENTIALS];
export const POPULAR_NEAR_YOU: readonly MerchantModel[] = [HOME_ESSENTIALS];

export const STOREFRONT_HERO = { techworld: storeHero } as const;

export const PRODUCTS: readonly ProductModel[] = [
  {
    id: 'iphone-15-pro',
    merchantSlug: 'techworld',
    name: 'iPhone 15 Pro',
    price: naira(1_250_000),
    image: iphone,
    gallery: [iphoneHero, iphoneView1, iphoneView2, iphoneView3],
    description:
      'Titanium. So strong. So light. So Pro. Experience the next generation of iPhone with powerful performance and a stunning display.',
    rating: { average: 4.8, count: 320 },
    optionGroups: [
      {
        id: 'colour',
        label: 'Colour',
        kind: 'swatch',
        options: [
          { id: 'natural-titanium', label: 'Natural Titanium', swatch: '#4A4843' },
          { id: 'white-titanium', label: 'White Titanium', swatch: '#D9D7D2' },
          { id: 'black-titanium', label: 'Black Titanium', swatch: '#2B2B2D' },
        ],
      },
      {
        id: 'storage',
        label: 'Storage',
        kind: 'chip',
        options: [
          { id: '128gb', label: '128GB' },
          { id: '256gb', label: '256GB' },
          { id: '512gb', label: '512GB' },
        ],
        defaultOption: '256gb',
      },
    ],
    shelf: 'phones',
  },
  {
    id: 'galaxy-s24',
    merchantSlug: 'techworld',
    name: 'Samsung Galaxy S24',
    price: naira(980_000),
    image: galaxy,
    gallery: [galaxy],
    description: 'Samsung Galaxy S24 — sample listing for the staging storefront.',
    rating: null,
    optionGroups: [],
    shelf: 'phones',
  },
  {
    id: 'macbook-air-m3',
    merchantSlug: 'techworld',
    name: 'MacBook Air M3',
    price: naira(1_850_000),
    image: macbook,
    gallery: [macbook],
    description: 'MacBook Air M3 — sample listing for the staging storefront.',
    rating: null,
    optionGroups: [],
    shelf: 'laptops',
  },
  {
    id: 'airpods-pro-2',
    merchantSlug: 'techworld',
    name: 'AirPods Pro (2nd Gen)',
    price: naira(420_000),
    image: airpods,
    gallery: [airpods],
    description: 'AirPods Pro (2nd generation) — sample listing for the staging storefront.',
    rating: null,
    optionGroups: [{ id: 'colour', label: 'Colour', kind: 'swatch', options: [{ id: 'white', label: 'White', swatch: '#F2F2F0' }] }],
    shelf: 'accessories',
  },
];

export const STOREFRONT_SHELVES = [
  { id: 'all', label: 'All' },
  { id: 'phones', label: 'Phones' },
  { id: 'laptops', label: 'Laptops' },
  { id: 'accessories', label: 'Accessories' },
] as const;

export function merchantBySlug(slug: string): MerchantModel | undefined {
  return FEATURED_SHOPS.find((m) => m.slug === slug) ?? POPULAR_NEAR_YOU.find((m) => m.slug === slug);
}

export function productById(id: string): ProductModel | undefined {
  return PRODUCTS.find((p) => p.id === id);
}

/**
 * Stands in for POST /v1/orders/quote in staging. The fees are the board's
 * sample figures, not DASH's pricing — the server decides those.
 */
export function stagingQuote(lines: readonly { productId: string; quantity: number }[]): QuoteModel {
  let itemsTotal: Kobo = naira(0);
  let itemCount = 0;
  for (const line of lines) {
    const product = productById(line.productId);
    if (!product) continue;
    itemsTotal = add(itemsTotal, multiply(product.price, line.quantity));
    itemCount += line.quantity;
  }
  const deliveryFee = itemCount > 0 ? naira(2_500) : naira(0);
  const serviceFee = itemCount > 0 ? naira(1_500) : naira(0);
  return { itemCount, itemsTotal, deliveryFee, serviceFee, total: add(itemsTotal, deliveryFee, serviceFee) };
}

// --- Rider -------------------------------------------------------------------

export const RIDER_PROFILE: RiderProfileModel = {
  firstName: 'Daniel',
  avatar: riderAvatar,
  rating: 4.9,
  trips: 128,
};

export const RIDER_TODAY: RiderTodayModel = {
  earnings: naira(25_400),
  trips: 12,
  rating: 4.9,
  completion: 100,
};

export const RIDER_ZONE = { name: 'Lekki & Victoria Island', region: 'Lagos, Nigeria' } as const;

const URBAN_BITES = { latitude: 6.4474, longitude: 3.4722 };
const RIDER_NOW = { latitude: 6.4406, longitude: 3.4623 };

/** Built relative to a clock so the countdown always starts full in staging. */
export function stagingOffer(now: Date = new Date()): RiderOfferModel {
  return {
    id: 'staging-offer-1',
    expiresAt: new Date(now.getTime() + 30_000).toISOString(),
    windowSeconds: 30,
    pickupDistanceMetres: 1_200,
    order: {
      code: 'DASH782910',
      pickup: {
        name: 'Urban Bites',
        address: 'Lekki Phase 1',
        coordinate: URBAN_BITES,
        kind: 'Restaurant',
        rating: { average: 4.6, count: 320 },
        image: urbanBites,
      },
      // An area, as the server sends it. No person, no street.
      dropoffArea: { coordinate: { latitude: 6.44, longitude: 3.527 }, label: 'Chevron, Lekki' },
      tripDistanceMetres: 4_800,
      itemCount: 3,
    },
    estimatedEarnings: naira(1_800),
  };
}

export const STAGING_JOB: RiderJobModel = {
  id: 'staging-job-1',
  code: 'DASH782910',
  merchant: {
    name: 'Urban Bites',
    address: '12 Admiralty Way, Lekki Phase 1',
    phone: '+2348000000000',
    coordinate: URBAN_BITES,
    image: urbanBites2,
    rating: { average: 4.6, count: 320 },
  },
  dropoff: {
    line1: 'Chevron Drive, Lekki',
    landmark: null,
    instructions: null,
    contactPhone: '+2348000000001',
    coordinate: { latitude: 6.4384, longitude: 3.5262 },
  },
  customer: { displayName: 'Emma A.', rating: { average: 4.8, orders: 46 } },
  items: [
    { name: 'Spicy Chicken Burger', quantity: 1 },
    { name: 'French Fries (Large)', quantity: 1 },
    { name: 'Iced Lemon Tea', quantity: 1 },
  ],
  pickupNote: 'Ask for the order at the pickup counter. Order is already paid.',
  routeToPickup: [
    RIDER_NOW,
    { latitude: 6.4413, longitude: 3.4631 },
    { latitude: 6.4432, longitude: 3.4664 },
    { latitude: 6.4455, longitude: 3.4671 },
    { latitude: 6.4462, longitude: 3.4702 },
    URBAN_BITES,
  ],
  etaToPickupMinutes: 5,
  distanceToPickupMetres: 1_200,
};

export const RIDER_POSITION = RIDER_NOW;

/** Recent trips on the Earnings board. Sample figures — earnings are not served yet. */
export const RIDER_RECENT_TRIPS: readonly { id: string; merchant: string; time: string; earned: Kobo }[] = [
  { id: 't1', merchant: 'Urban Bites', time: '10:24 AM', earned: naira(1_800) },
  { id: 't2', merchant: 'The Daily Kitchen', time: '9:56 AM', earned: naira(1_650) },
  { id: 't3', merchant: 'Grill House', time: '9:12 AM', earned: naira(2_000) },
  { id: 't4', merchant: 'Green Bowl', time: '8:40 AM', earned: naira(1_500) },
  { id: 't5', merchant: 'Café 7', time: '8:05 AM', earned: naira(1_600) },
];

export const RIDER_ONLINE_TIME = '8h 24m';

/** Sample totals per period, so the Earnings period switch has something to switch. */
export const RIDER_EARNINGS_BY_PERIOD = {
  today: { label: "Today's Earnings", earnings: naira(25_400), trips: 12, onlineTime: '8h 24m', rating: 4.9 },
  week: { label: "This Week's Earnings", earnings: naira(142_600), trips: 68, onlineTime: '46h 10m', rating: 4.9 },
  month: { label: "This Month's Earnings", earnings: naira(598_300), trips: 287, onlineTime: '191h 35m', rating: 4.8 },
} as const;

/** The bars on the "Live Activity" card: relative demand, 0-1. Sample only. */
export const RIDER_LIVE_ACTIVITY: readonly number[] = [0.35, 0.55, 0.3, 0.7, 0.45, 0.6, 0.4, 0.8, 0.5, 0.65, 0.9, 0.55];
