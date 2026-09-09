/**
 * Seed a fictional Lagos.
 *
 * Every vendor, product, person, and phone number here is invented. No real
 * business's catalogue, branding, or menu has been copied, and no real person's
 * details appear. Phone numbers use the +234 700 reserved-style block so they
 * cannot ring a real handset.
 *
 * Run with: npm run db:seed  (idempotent — safe to re-run)
 */

import { PrismaClient } from '@prisma/client';
import { hashPassword, hashOtp, generateReference, generatePin } from '@dash/domain/crypto';
import { ensureRidersAreCustomers } from './rider-customer.js';
import { seedDeclutterTaxonomy } from './seed-declutter.js';
import { naira } from '@dash/domain/money';
import { boundingBoxOf, parsePolygon } from '@dash/domain/geo';
import { buildOrderCapture } from '@dash/domain/ledger';
import { buildQuote, computeSettlement, type PricingRules } from '@dash/domain/pricing';
import { assembleKeyring, encrypt, type Keyring } from '@dash/domain/envelope';

const prisma = new PrismaClient();

/** Fixed so re-seeding produces stable, comparable data. */
const SEED_NOW = new Date('2026-08-30T12:00:00.000Z');

/** The single password for every seeded staff account. Development only. */
const DEV_PASSWORD = 'DashDev!2026';

/**
 * A fixed, obviously-fake TOTP secret shared by every seeded staff account.
 *
 * Add it to an authenticator app once and every development staff sign-in
 * works, across reseeds. This is a development convenience and nothing more:
 * `main()` refuses to run against NODE_ENV=production, and a real enrolment
 * generates a fresh random secret per identity.
 */
const DEV_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

function minutesFromMidnight(hour: number, minute = 0): number {
  return hour * 60 + minute;
}

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('Refusing to seed a production database.');
  }

  console.warn('Seeding DASH APP development data…\n');

  // -------------------------------------------------------------------------
  // Wipe. Order matters — children before parents.
  // -------------------------------------------------------------------------
  await prisma.$transaction([
    prisma.ledgerEntry.deleteMany(),
    prisma.ledgerTransaction.deleteMany(),
    prisma.paymentWebhook.deleteMany(),
    prisma.refund.deleteMany(),
    prisma.payment.deleteMany(),
    prisma.deliveryProof.deleteMany(),
    prisma.dispatchOffer.deleteMany(),
    prisma.orderStatusEvent.deleteMany(),
    prisma.orderItem.deleteMany(),
    prisma.review.deleteMany(),
    prisma.order.deleteMany(),
    prisma.cartItem.deleteMany(),
    prisma.cart.deleteMany(),
    prisma.supportAction.deleteMany(),
    prisma.supportCase.deleteMany(),
    prisma.promotionRedemption.deleteMany(),
    prisma.promotion.deleteMany(),
    prisma.subscription.deleteMany(),
    prisma.itemStock.deleteMany(),
    prisma.modifier.deleteMany(),
    prisma.modifierGroup.deleteMany(),
    prisma.menuItem.deleteMany(),
    prisma.menuCategory.deleteMany(),
    prisma.operatingHour.deleteMany(),
    prisma.branch.deleteMany(),
    prisma.vendorDocument.deleteMany(),
    prisma.vendorUser.deleteMany(),
    prisma.vendor.deleteMany(),
    prisma.riderLocation.deleteMany(),
    prisma.riderDocument.deleteMany(),
    prisma.rider.deleteMany(),
    prisma.address.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.legalAcceptance.deleteMany(),
    prisma.legalDocument.deleteMany(),
    prisma.auditLog.deleteMany(),
    prisma.otpChallenge.deleteMany(),
    prisma.session.deleteMany(),
    prisma.device.deleteMany(),
    prisma.identityRole.deleteMany(),
    prisma.identity.deleteMany(),
    prisma.pricingRule.deleteMany(),
    prisma.zone.deleteMany(),
    prisma.city.deleteMany(),
    prisma.featureFlag.deleteMany(),
    prisma.idempotencyKey.deleteMany(),
  ]);

  const passwordHash = await hashPassword(DEV_PASSWORD);

  // Staff roles require a second factor, so the seed needs the same keyring the
  // API uses. Without a key the accounts are still created — they simply arrive
  // unenrolled and must enrol on first sign-in, which is the real flow anyway.
  //
  // This is the one place outside `apps/api/src/config.ts` that reads secret
  // material from the environment, and it is deliberate: `@dash/db` sits below
  // `apps/api`, so it cannot call `loadConfig`. What it must not do is apply
  // *weaker* rules than the API does — it used to build the keyring by hand and
  // skipped the key-id check entirely, which meant an id the envelope format
  // cannot carry would be refused at API boot and accepted here, seeding rows
  // the API could never read. `assembleKeyring` is the same function the API
  // configuration calls, so the two cannot disagree again.
  //
  // Retired keys are not read: the seed only ever writes new values, and it
  // writes them with the active key.
  const encryptionKey = process.env['ENCRYPTION_KEY'];
  const keyring: Keyring | null = encryptionKey
    ? assembleKeyring({
        activeKey: encryptionKey,
        activeKeyId: process.env['ENCRYPTION_KEY_ID'] ?? 'k1',
      })
    : null;

  // -------------------------------------------------------------------------
  // City and zones
  // -------------------------------------------------------------------------
  const lagos = await prisma.city.create({
    data: {
      slug: 'lagos',
      name: 'Lagos',
      country: 'NG',
      currency: 'NGN',
      timezone: 'Africa/Lagos',
      detourFactor: 1.4,
      centreLatitude: 6.5244,
      centreLongitude: 3.3792,
      isLive: true,
    },
  });

  /**
   * Four service zones, drawn as simple polygons over real Lagos geography.
   * Coordinates are GeoJSON order: [longitude, latitude].
   */
  const zoneDefinitions = [
    {
      slug: 'victoria-island',
      name: 'Victoria Island & Ikoyi',
      ring: [
        [3.395, 6.415],
        [3.455, 6.415],
        [3.455, 6.462],
        [3.395, 6.462],
      ],
      surge: 1.0,
    },
    {
      slug: 'lekki-phase-1',
      name: 'Lekki Phase 1',
      ring: [
        [3.455, 6.425],
        [3.510, 6.425],
        [3.510, 6.470],
        [3.455, 6.470],
      ],
      surge: 1.25,
    },
    {
      slug: 'ikeja',
      name: 'Ikeja & Maryland',
      ring: [
        [3.320, 6.575],
        [3.390, 6.575],
        [3.390, 6.640],
        [3.320, 6.640],
      ],
      surge: 1.0,
    },
    {
      slug: 'yaba-surulere',
      name: 'Yaba & Surulere',
      ring: [
        [3.335, 6.485],
        [3.390, 6.485],
        [3.390, 6.535],
        [3.335, 6.535],
      ],
      surge: 1.0,
    },
  ];

  const zones = [];
  for (const definition of zoneDefinitions) {
    const polygon = parsePolygon(definition.ring);
    const box = boundingBoxOf(polygon);
    zones.push(
      await prisma.zone.create({
        data: {
          cityId: lagos.id,
          name: definition.name,
          slug: definition.slug,
          polygon: JSON.stringify(definition.ring),
          minLatitude: box.minLatitude,
          maxLatitude: box.maxLatitude,
          minLongitude: box.minLongitude,
          maxLongitude: box.maxLongitude,
          surgeMultiplier: definition.surge,
          isActive: true,
        },
      }),
    );
  }
  const [viZone, lekkiZone, ikejaZone, yabaZone] = zones;
  if (!viZone || !lekkiZone || !ikejaZone || !yabaZone) throw new Error('Zone seed failed');

  const pricingRules: PricingRules = {
    currency: 'NGN',
    baseDeliveryFee: naira(400),
    includedMetres: 2000,
    perKilometreFee: naira(120),
    perMinuteFee: naira(0),
    minimumDeliveryFee: naira(300),
    maximumDeliveryFee: naira(3500),
    serviceFeeBasisPoints: 500,
    serviceFeeCap: naira(500),
    smallOrderThreshold: naira(2000),
    smallOrderFee: naira(200),
    taxBasisPoints: 0,
    maximumSurgeMultiplier: 2.0,
  };

  await prisma.pricingRule.create({
    data: {
      cityId: lagos.id,
      version: '2026.08.1',
      baseDeliveryFee: pricingRules.baseDeliveryFee,
      includedMetres: pricingRules.includedMetres,
      perKilometreFee: pricingRules.perKilometreFee,
      perMinuteFee: pricingRules.perMinuteFee,
      minimumDeliveryFee: pricingRules.minimumDeliveryFee,
      maximumDeliveryFee: pricingRules.maximumDeliveryFee,
      serviceFeeBasisPoints: pricingRules.serviceFeeBasisPoints,
      serviceFeeCap: pricingRules.serviceFeeCap,
      smallOrderThreshold: pricingRules.smallOrderThreshold,
      smallOrderFee: pricingRules.smallOrderFee,
      taxBasisPoints: pricingRules.taxBasisPoints,
      maximumSurgeMultiplier: pricingRules.maximumSurgeMultiplier,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    },
  });

  // -------------------------------------------------------------------------
  // Staff
  // -------------------------------------------------------------------------
  async function createStaff(
    email: string,
    displayName: string,
    role: string,
    cityId?: string,
  ): Promise<string> {
    const identity = await prisma.identity.create({
      data: {
        email,
        displayName,
        passwordHash,
        roles: { create: { role, cityId: cityId ?? null } },
      },
      select: { id: true },
    });

    // Pre-enrol against a fixed, obviously-fake development secret so the admin
    // console is reachable without walking enrolment on every reseed. Add
    // DEV_TOTP_SECRET to an authenticator once and every staff account works.
    //
    // Done as a second write because the envelope is bound to the identity that
    // owns it, so the id has to exist first. Production enrolment is the real
    // flow; nothing here weakens it, and this seed refuses to run against
    // NODE_ENV=production.
    if (keyring) {
      await prisma.identity.update({
        where: { id: identity.id },
        data: {
          mfaSecretCipher: encrypt(DEV_TOTP_SECRET, keyring, {
            purpose: 'mfa_totp_secret',
            subjectId: identity.id,
          }),
          mfaEnrolledAt: SEED_NOW,
        },
      });
    }

    return identity.id;
  }

  const superAdminId = await createStaff('admin@dashapp.test', 'Ada Superuser', 'super_admin');
  await createStaff('ops@dashapp.test', 'Tunde Dispatcher', 'dispatcher', lagos.id);
  await createStaff('support@dashapp.test', 'Chidinma Support', 'support_agent');
  await createStaff('finance@dashapp.test', 'Bola Finance', 'finance_analyst');
  await createStaff('city@dashapp.test', 'Emeka CityManager', 'city_manager', lagos.id);

  // -------------------------------------------------------------------------
  // Vendors — all fictional
  // -------------------------------------------------------------------------
  interface SeedItem {
    name: string;
    description: string;
    price: number; // naira
    prepMinutes?: number;
    modifiers?: { group: string; min: number; max: number; options: [string, number][] }[];
    /** Declutter listings only. Null on everything a kitchen makes to order. */
    condition?: string;
    /**
     * A real HTTPS image URL for sample data.
     *
     * Stored in `imageKey`, which is named for its eventual life as a storage
     * key. The client resolves either — see lib/images.ts — so seeded sample
     * data does not need migrating on the day real uploads land.
     */
    imageUrl?: string;
  }
  interface SeedVendor {
    name: string;
    slug: string;
    category: string;
    description: string;
    commission: number;
    zone: typeof viZone;
    latitude: number;
    longitude: number;
    address: string;
    minimumOrder: number;
    prepMinutes: number;
    categories: { name: string; items: SeedItem[] }[];
  }

  /**
   * Declutter — curated resale, not a peer-to-peer marketplace.
   *
   * V1 deliberately reuses the vendor and catalogue models rather than growing
   * a second commerce engine: a Declutter seller is an approved vendor whose
   * category is `declutter`, its listings are ordinary menu items, and the
   * basket, checkout, dispatch and delivery that carry a plate of jollof carry
   * a second-hand laptop unchanged. What makes it Declutter is the category and
   * the fact that each item carries a `condition`.
   *
   * "Curated" is not a flag either — it is what `status: 'approved'` on the
   * vendor already means. There is no public listing form, no seller
   * onboarding, no escrow and no bidding in this milestone, so nothing here
   * needs a model that could express them.
   *
   * The images are real HTTPS URLs on `imageKey`. Sample data only; see
   * lib/images.ts for how the client resolves either shape.
   */
  /**
   * One seller for each remaining section, so a fresh seed produces a world
   * where every front door opens onto something.
   *
   * DASH has five equal sections — Shops, Restaurants, Local Market, Pharmacy,
   * Declutter — and the first two of those had no vendors at all: `retail` and
   * `market` existed as categories with nothing in them. A section that opens
   * onto an empty state reads as a broken app rather than as an honest "none
   * near you yet", and makes the whole hierarchy untestable.
   *
   * Fictional, like every other seeded vendor. These are test fixtures, not a
   * claim that any real trader has been onboarded.
   */
  const sectionVendors: SeedVendor[] = [
    {
      name: 'Lagos Home & Electronics',
      slug: 'lagos-home-electronics',
      category: 'retail',
      description: 'Small appliances, gadgets and home basics.',
      commission: 1500,
      zone: viZone,
      latitude: 6.4372,
      longitude: 3.4246,
      address: '3 Awolowo Road, Ikoyi',
      minimumOrder: 0,
      prepMinutes: 20,
      categories: [
        {
          name: 'Electronics',
          items: [
            { name: 'Standing fan, 18 inch', description: 'Three speeds, oscillating.', price: 42_000 },
            { name: 'LED bulb, 4-pack', description: 'Warm white, 9W each.', price: 6_500 },
          ],
        },
        {
          name: 'Home',
          items: [
            { name: 'Stainless cookware set', description: 'Five pieces with lids.', price: 58_000 },
            { name: 'Cotton bed sheet set', description: 'Queen size, two pillowcases.', price: 24_000 },
          ],
        },
        {
          name: 'Beauty',
          items: [
            { name: 'Shea body butter, 250g', description: 'Unscented, locally made.', price: 7_500 },
          ],
        },
        {
          name: 'Fashion',
          items: [
            { name: 'Canvas tote bag', description: 'Heavy cotton, screen printed.', price: 9_000 },
          ],
        },
      ],
    },
    {
      name: 'Mile 12 Fresh Produce',
      slug: 'mile-12-fresh-produce',
      category: 'market',
      description: 'Produce bought the same morning.',
      commission: 1500,
      zone: viZone,
      latitude: 6.4427,
      longitude: 3.4246,
      address: 'Stall 42, Mile 12 Market',
      minimumOrder: 2_000,
      prepMinutes: 20,
      categories: [
        {
          name: 'Vegetables',
          items: [
            { name: 'Ugu (fluted pumpkin), bunch', description: 'Cut fresh this morning.', price: 1_200 },
            { name: 'Tomatoes, basket', description: 'Ripe, for stew.', price: 9_500 },
            { name: 'Scotch bonnet, cup', description: 'Hot. Sold by the cup.', price: 1_800 },
          ],
        },
        {
          name: 'Grains',
          items: [
            { name: 'Ofada rice, 5kg', description: 'Local, stone-picked.', price: 14_500 },
            { name: 'Brown beans, 5kg', description: 'Oloyin variety.', price: 12_000 },
          ],
        },
        {
          name: 'Spices',
          items: [
            { name: 'Ground crayfish, 200g', description: 'Dried and milled.', price: 4_500 },
            { name: 'Locust beans (iru), pack', description: 'Wrapped fresh.', price: 1_500 },
          ],
        },
      ],
    },
    {
      name: 'Oyingbo Meat & Fish',
      slug: 'oyingbo-meat-fish',
      category: 'market',
      description: 'Butchery and fresh fish, cut to order.',
      commission: 1500,
      zone: viZone,
      latitude: 6.4482,
      longitude: 3.4246,
      address: 'Row C, Oyingbo Market',
      minimumOrder: 3_000,
      prepMinutes: 20,
      categories: [
        {
          name: 'Meat',
          items: [
            { name: 'Goat meat, 1kg', description: 'Cut to order, bone in.', price: 8_500 },
            { name: 'Beef shank, 1kg', description: 'Good for pepper soup.', price: 7_200 },
          ],
        },
        {
          name: 'Fish',
          items: [
            { name: 'Fresh tilapia, 1kg', description: 'Cleaned and scaled.', price: 6_800 },
            { name: 'Smoked catfish, whole', description: 'Dried over firewood.', price: 5_200 },
          ],
        },
        {
          name: 'Spices',
          items: [
            { name: 'Uziza seeds, 100g', description: 'For pepper soup.', price: 2_200 },
          ],
        },
      ],
    },
  ];

  const declutterVendor: SeedVendor = {
    name: 'DASH Declutter Lagos',
    slug: 'dash-declutter-lagos',
    category: 'declutter',
    description: 'Checked, cleaned and photographed second-hand from trusted Lagos sellers.',
    commission: 1200,
    zone: viZone,
    latitude: 6.4305,
    longitude: 3.4246,
    address: '14 Adeola Odeku Street, Victoria Island',
    minimumOrder: 0,
    prepMinutes: 20,
    categories: [
      {
        name: 'Phones',
        items: [
          {
            name: 'iPhone 12 Pro 128GB',
            description: 'Battery health 89%. Screen flawless, light scuffs on the frame. Boxed.',
            price: 385_000,
            condition: 'good',
            imageUrl: 'https://images.unsplash.com/photo-1603891128711-11b4b03bb138?w=800&q=80',
          },
          {
            name: 'Samsung Galaxy S21',
            description: 'Single owner, always cased. Includes charger and a spare case.',
            price: 245_000,
            condition: 'like_new',
            imageUrl: 'https://images.unsplash.com/photo-1610945415295-d9bbf067e59c?w=800&q=80',
          },
        ],
      },
      {
        name: 'Laptops & Electronics',
        items: [
          {
            name: 'MacBook Air M1 256GB',
            description: '112 charge cycles. Keyboard and trackpad perfect. Charger included.',
            price: 620_000,
            condition: 'like_new',
            imageUrl: 'https://images.unsplash.com/photo-1611186871348-b1ce696e52c9?w=800&q=80',
          },
          {
            name: 'Sony WH-1000XM4 Headphones',
            description: 'Noise cancelling intact. Earpads replaced last month. Case included.',
            price: 135_000,
            condition: 'good',
            imageUrl: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800&q=80',
          },
        ],
      },
      {
        name: 'Furniture',
        items: [
          {
            name: 'Three-seater fabric sofa',
            description: 'Charcoal grey, foam still firm. Small mark on the left arm, photographed.',
            price: 180_000,
            condition: 'good',
            imageUrl: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800&q=80',
          },
          {
            name: 'Solid oak dining table',
            description: 'Seats six. Refinished top, no wobble. Chairs not included.',
            price: 145_000,
            condition: 'good',
            imageUrl: 'https://images.unsplash.com/photo-1533090161767-e6ffed986c88?w=800&q=80',
          },
        ],
      },
      {
        name: 'Home Appliances',
        items: [
          {
            name: 'LG 7kg washing machine',
            description: 'Front loader, serviced in June. All cycles tested before listing.',
            price: 210_000,
            condition: 'good',
            imageUrl: 'https://images.unsplash.com/photo-1626806787461-102c1bfaaea1?w=800&q=80',
          },
          {
            name: 'Nespresso coffee machine',
            description: 'Descaled and boxed. Barely used — a gift that never got going.',
            price: 55_000,
            condition: 'like_new',
            imageUrl: 'https://images.unsplash.com/photo-1585515320310-259814833e62?w=800&q=80',
          },
        ],
      },
      {
        name: 'Fashion',
        items: [
          {
            name: 'Leather weekend bag',
            description: 'Full grain, patina starting. Straps and zips sound.',
            price: 48_000,
            condition: 'good',
            imageUrl: 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=800&q=80',
          },
          {
            name: 'Wool overcoat, size 40',
            description: 'Navy, dry cleaned. Worn for one Harmattan season.',
            price: 62_000,
            condition: 'like_new',
            imageUrl: 'https://images.unsplash.com/photo-1591047139829-d91aecb6caea?w=800&q=80',
          },
        ],
      },
      {
        name: 'Other',
        items: [
          {
            name: 'Yamaha acoustic guitar',
            description: 'New strings fitted. Two small dings on the body, tone unaffected.',
            price: 78_000,
            condition: 'good',
            imageUrl: 'https://images.unsplash.com/photo-1510915361894-db8b60106cb1?w=800&q=80',
          },
          {
            name: 'Peloton-style exercise bike',
            description: 'Resistance smooth, screen not included. Collected clean.',
            price: 155_000,
            condition: 'fair',
            imageUrl: 'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=800&q=80',
          },
        ],
      },
    ],
  };

  const vendorDefinitions: SeedVendor[] = [
    {
      name: 'Iya Kemi Kitchen',
      slug: 'iya-kemi-kitchen',
      category: 'restaurant',
      description: 'Home-style Nigerian cooking, served hot all day.',
      commission: 1800,
      zone: yabaZone,
      latitude: 6.5095,
      longitude: 3.3711,
      address: '14 Herbert Macaulay Way, Yaba',
      minimumOrder: 1500,
      prepMinutes: 25,
      categories: [
        {
          name: 'Rice & Swallow',
          items: [
            {
              name: 'Party Jollof Rice',
              description: 'Smoky party-style jollof with fried plantain.',
              price: 3500,
              prepMinutes: 20,
              modifiers: [
                {
                  group: 'Choose your protein',
                  min: 1,
                  max: 1,
                  options: [
                    ['Grilled chicken', 1200],
                    ['Fried fish', 1500],
                    ['Beef', 1000],
                    ['No protein', 0],
                  ],
                },
                {
                  group: 'Extras',
                  min: 0,
                  max: 3,
                  options: [
                    ['Extra plantain', 500],
                    ['Coleslaw', 400],
                    ['Moi moi', 700],
                  ],
                },
              ],
            },
            {
              name: 'Ofada Rice & Ayamase',
              description: 'Local ofada rice with green pepper sauce.',
              price: 4200,
              prepMinutes: 25,
            },
            {
              name: 'Pounded Yam & Egusi',
              description: 'Smooth pounded yam with melon seed soup.',
              price: 4800,
              prepMinutes: 30,
            },
          ],
        },
        {
          name: 'Sides & Drinks',
          items: [
            { name: 'Puff Puff (6 pieces)', description: 'Sweet fried dough.', price: 800 },
            { name: 'Chapman', description: 'Chilled house Chapman.', price: 1200 },
            { name: 'Bottled Water', description: '50cl still water.', price: 300 },
          ],
        },
      ],
    },
    {
      name: 'Suya Republic',
      slug: 'suya-republic',
      category: 'restaurant',
      description: 'Charcoal-grilled suya and peppered meats.',
      commission: 2000,
      zone: viZone,
      latitude: 6.4295,
      longitude: 3.4234,
      address: '9 Adeola Odeku Street, Victoria Island',
      minimumOrder: 2000,
      prepMinutes: 20,
      categories: [
        {
          name: 'From the Grill',
          items: [
            {
              name: 'Beef Suya Platter',
              description: 'Spiced beef skewers with onions and yaji.',
              price: 5000,
              modifiers: [
                {
                  group: 'Spice level',
                  min: 1,
                  max: 1,
                  options: [
                    ['Mild', 0],
                    ['Medium', 0],
                    ['Very hot', 0],
                  ],
                },
              ],
            },
            { name: 'Peppered Chicken Wings', description: 'Eight wings, house pepper.', price: 4500 },
            { name: 'Grilled Croaker Fish', description: 'Whole fish with sides.', price: 7500, prepMinutes: 30 },
          ],
        },
      ],
    },
    {
      name: 'FreshCart Grocers',
      slug: 'freshcart-grocers',
      category: 'grocery',
      description: 'Everyday groceries and fresh produce, delivered.',
      commission: 1200,
      zone: lekkiZone,
      latitude: 6.4478,
      longitude: 3.4723,
      address: '3 Admiralty Way, Lekki Phase 1',
      minimumOrder: 3000,
      prepMinutes: 35,
      categories: [
        {
          name: 'Produce',
          items: [
            { name: 'Tomatoes (1kg)', description: 'Fresh plum tomatoes.', price: 1800 },
            { name: 'Red Onions (1kg)', description: 'Firm red onions.', price: 1500 },
            { name: 'Sweet Plantain (bunch)', description: 'Ripe plantain, five fingers.', price: 2200 },
          ],
        },
        {
          name: 'Pantry',
          items: [
            { name: 'Long Grain Rice (5kg)', description: 'Parboiled long grain.', price: 9500 },
            { name: 'Vegetable Oil (2L)', description: 'Pure vegetable oil.', price: 6800 },
            { name: 'Garri (2kg)', description: 'Fine white garri.', price: 2400 },
          ],
        },
      ],
    },
    {
      name: 'CareWell Pharmacy',
      slug: 'carewell-pharmacy',
      category: 'pharmacy',
      description: 'Registered community pharmacy. Over-the-counter essentials.',
      commission: 1000,
      zone: ikejaZone,
      latitude: 6.6018,
      longitude: 3.3515,
      address: '22 Allen Avenue, Ikeja',
      minimumOrder: 1000,
      prepMinutes: 15,
      categories: [
        {
          name: 'Over the counter',
          items: [
            { name: 'Paracetamol 500mg (16 tablets)', description: 'Pain and fever relief.', price: 900 },
            { name: 'Oral Rehydration Salts (10 sachets)', description: 'Rehydration therapy.', price: 1500 },
            { name: 'Antiseptic Liquid (250ml)', description: 'Wound and surface antiseptic.', price: 2100 },
          ],
        },
        {
          name: 'Personal care',
          items: [
            { name: 'Adult Toothbrush', description: 'Soft bristle.', price: 700 },
            { name: 'Hand Sanitiser (100ml)', description: '70% alcohol gel.', price: 1300 },
          ],
        },
      ],
    },
  ];

  const createdVendors = [];
  // Declutter joins the same list, so it is created by the same loop and gets
  // the same branch, hours, stock and modifiers as every other vendor.
  vendorDefinitions.push(...sectionVendors, declutterVendor);

  for (const definition of vendorDefinitions) {
    const vendor = await prisma.vendor.create({
      data: {
        cityId: lagos.id,
        name: definition.name,
        slug: definition.slug,
        description: definition.description,
        category: definition.category,
        status: 'approved',
        approvedAt: SEED_NOW,
        approvedBy: superAdminId,
        commissionBasisPoints: definition.commission,
        bankName: 'Demo Bank PLC',
        bankAccountLast4: '4417',
        ratingAverage: 4.4,
        ratingCount: 128,
      },
    });

    const branch = await prisma.branch.create({
      data: {
        vendorId: vendor.id,
        zoneId: definition.zone.id,
        name: `${definition.name} — Main`,
        address: definition.address,
        phone: '+2347000000101',
        latitude: definition.latitude,
        longitude: definition.longitude,
        state: 'open',
        minimumOrder: naira(definition.minimumOrder),
        defaultPrepMinutes: definition.prepMinutes,
        supportsDelivery: true,
        supportsPickup: true,
      },
    });

    // Open 08:00–22:00 every day.
    for (let day = 0; day < 7; day += 1) {
      await prisma.operatingHour.create({
        data: {
          branchId: branch.id,
          dayOfWeek: day,
          opensAtMinute: minutesFromMidnight(8),
          closesAtMinute: minutesFromMidnight(22),
        },
      });
    }

    // Vendor owner account.
    const ownerIdentity = await prisma.identity.create({
      data: {
        email: `${definition.slug}@dashapp.test`,
        displayName: `${definition.name} Owner`,
        passwordHash,
        // Vendor roles do not require a second factor (see MFA_REQUIRED_ROLES),
        // so there is deliberately no enrolment here.
        roles: { create: { role: 'vendor_owner', vendorId: vendor.id } },
      },
    });
    await prisma.vendorUser.create({
      data: {
        vendorId: vendor.id,
        identityId: ownerIdentity.id,
        role: 'vendor_owner',
        acceptedAt: SEED_NOW,
      },
    });

    for (const [categoryIndex, categoryDefinition] of definition.categories.entries()) {
      const category = await prisma.menuCategory.create({
        data: {
          vendorId: vendor.id,
          name: categoryDefinition.name,
          sortOrder: categoryIndex,
        },
      });

      for (const [itemIndex, itemDefinition] of categoryDefinition.items.entries()) {
        const item = await prisma.menuItem.create({
          data: {
            vendorId: vendor.id,
            categoryId: category.id,
            name: itemDefinition.name,
            description: itemDefinition.description,
            price: naira(itemDefinition.price),
            prepMinutes: itemDefinition.prepMinutes ?? 15,
            sortOrder: itemIndex,
            requiresAgeCheck: false,
            ...(itemDefinition.condition ? { condition: itemDefinition.condition } : {}),
            ...(itemDefinition.imageUrl ? { imageKey: itemDefinition.imageUrl } : {}),
          },
        });

        await prisma.itemStock.create({
          data: {
            itemId: item.id,
            branchId: branch.id,
            // Groceries and pharmacy track finite stock; kitchens cook to order.
            quantity:
              definition.category === 'grocery' || definition.category === 'pharmacy' ? 40 : null,
            isAvailable: true,
          },
        });

        for (const [groupIndex, groupDefinition] of (itemDefinition.modifiers ?? []).entries()) {
          const group = await prisma.modifierGroup.create({
            data: {
              itemId: item.id,
              name: groupDefinition.group,
              minSelect: groupDefinition.min,
              maxSelect: groupDefinition.max,
              sortOrder: groupIndex,
            },
          });
          for (const [optionIndex, [optionName, delta]] of groupDefinition.options.entries()) {
            await prisma.modifier.create({
              data: {
                groupId: group.id,
                name: optionName,
                priceDelta: naira(delta),
                sortOrder: optionIndex,
              },
            });
          }
        }
      }
    }

    createdVendors.push({ vendor, branch, definition });
  }

  // -------------------------------------------------------------------------
  // Customers
  // -------------------------------------------------------------------------
  const customerDefinitions = [
    {
      phone: '+2347000000201',
      name: 'Amaka Okoye',
      email: 'amaka@dashapp.test',
      address: { line1: '12 Bourdillon Road, Ikoyi', latitude: 6.4478, longitude: 3.4361 },
    },
    {
      phone: '+2347000000202',
      name: 'Segun Adeyemi',
      email: 'segun@dashapp.test',
      address: { line1: '7 Admiralty Way, Lekki Phase 1', latitude: 6.4462, longitude: 3.4701 },
    },
    {
      phone: '+2347000000203',
      name: 'Fatima Bello',
      email: 'fatima@dashapp.test',
      address: { line1: '5 Opebi Road, Ikeja', latitude: 6.5921, longitude: 3.3547 },
    },
  ];

  const createdCustomers = [];
  for (const definition of customerDefinitions) {
    const identity = await prisma.identity.create({
      data: {
        phone: definition.phone,
        email: definition.email,
        displayName: definition.name,
        roles: { create: { role: 'customer' } },
      },
    });
    const customer = await prisma.customer.create({
      data: {
        identityId: identity.id,
        referralCode: generateReference('DASH', 6).replace('DASH-', 'REF'),
        marketingOptIn: true,
      },
    });
    const address = await prisma.address.create({
      data: {
        customerId: customer.id,
        label: 'Home',
        line1: definition.address.line1,
        contactPhone: definition.phone,
        latitude: definition.address.latitude,
        longitude: definition.address.longitude,
        isDefault: true,
      },
    });
    createdCustomers.push({ identity, customer, address });
  }

  // Give the first customer a Dash+ membership.
  const firstCustomer = createdCustomers[0];
  if (firstCustomer) {
    await prisma.subscription.create({
      data: {
        customerId: firstCustomer.customer.id,
        plan: 'dash_plus',
        status: 'active',
        freeDeliveryMinimumSubtotal: naira(3000),
        serviceFeeDiscountBasisPoints: 5000,
        surgeExempt: true,
        pricePerPeriod: naira(2500),
        periodDays: 30,
        currentPeriodEnd: new Date(SEED_NOW.getTime() + 30 * 86_400_000),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Riders
  // -------------------------------------------------------------------------
  const riderDefinitions = [
    {
      phone: '+2347000000301',
      name: 'Musa Ibrahim',
      vehicle: 'motorcycle',
      latitude: 6.4305,
      longitude: 3.4250,
      availability: 'idle',
      zone: viZone,
    },
    {
      phone: '+2347000000302',
      name: 'Grace Eze',
      vehicle: 'motorcycle',
      latitude: 6.4490,
      longitude: 3.4710,
      availability: 'idle',
      zone: lekkiZone,
    },
    {
      phone: '+2347000000303',
      name: 'Kunle Balogun',
      vehicle: 'bicycle',
      latitude: 6.5100,
      longitude: 3.3720,
      availability: 'idle',
      zone: yabaZone,
    },
    {
      phone: '+2347000000304',
      name: 'Peter Obi-Nwosu',
      vehicle: 'car',
      latitude: 6.6030,
      longitude: 3.3520,
      availability: 'offline',
      zone: ikejaZone,
    },
  ];

  const createdRiders = [];
  for (const definition of riderDefinitions) {
    const identity = await prisma.identity.create({
      data: {
        phone: definition.phone,
        displayName: definition.name,
        roles: { create: { role: 'rider' } },
      },
    });
    const rider = await prisma.rider.create({
      data: {
        identityId: identity.id,
        status: 'approved',
        approvedAt: SEED_NOW,
        approvedBy: superAdminId,
        vehicleType: definition.vehicle,
        vehiclePlate: 'LAG-000XY',
        availability: definition.availability,
        lastLatitude: definition.latitude,
        lastLongitude: definition.longitude,
        // Relative to the real clock, not to `SEED_NOW`.
        //
        // Everything else here is pinned to `SEED_NOW` so a reseed produces
        // identical data. Location freshness cannot be: dispatch excludes any
        // rider whose last position is more than
        // `maximumLocationAgeSeconds` (120) old, measured against the actual
        // time the engine runs. Pinned to a fixed date, every seeded rider is
        // permanently `location_stale`, dispatch escalates every order to
        // manual, and **no rider can ever receive an offer in local
        // development** — which makes the entire rider journey untestable from
        // a fresh seed. It reads as "dispatch is broken" rather than "the seed
        // is stale", which is what made it worth a comment this long.
        locationReportedAt: new Date(Date.now() - 15_000),
        // Relative to the real clock for the same reason as the position
        // above: a seeded rider described as online must hold a live Online
        // lease, or acceptance refuses them as `not_online`.
        onlineUntil: new Date(Date.now() + 900_000),
        qualityScore: 88,
        lastAssignedAt: new Date(SEED_NOW.getTime() - 900_000),
        canCarryCash: true,
        cashFloatCap: naira(20_000),
        allowedZoneIds: JSON.stringify([definition.zone.id]),
      },
    });
    createdRiders.push({ identity, rider });
  }

  // Every rider is also a customer.
  //
  // Reconciled by the same function that repairs an existing database rather
  // than by nested `create` here, so a fresh seed and a live repair cannot
  // drift apart — and so this invariant has exactly one implementation to
  // test. See rider-customer.ts.
  const repair = await ensureRidersAreCustomers(prisma);
  console.warn(
    `  riders given the customer capability: ${repair.profilesCreated} profile(s), ` +
      `${repair.rolesGranted} role(s), ${repair.addressesCreated} address(es)`,
  );

  // -------------------------------------------------------------------------
  // Promotions
  // -------------------------------------------------------------------------
  await prisma.promotion.createMany({
    data: [
      {
        code: 'DASH10',
        name: '10% off your order',
        kind: 'percentage_off_items',
        basisPoints: 1000,
        maximumDiscount: naira(1500),
        fundedBy: 'platform',
        minimumSubtotal: naira(2000),
        perCustomerQuota: 3,
        startsAt: new Date('2026-01-01T00:00:00Z'),
        endsAt: new Date('2026-12-31T23:59:59Z'),
        isActive: true,
      },
      {
        code: 'FREERIDE',
        name: 'Free delivery on us',
        kind: 'free_delivery',
        fundedBy: 'platform',
        minimumSubtotal: naira(4000),
        perCustomerQuota: 1,
        firstOrderOnly: true,
        startsAt: new Date('2026-01-01T00:00:00Z'),
        isActive: true,
      },
      {
        code: 'KITCHEN500',
        name: '₦500 off at Iya Kemi Kitchen',
        kind: 'fixed_off_items',
        amount: naira(500),
        fundedBy: 'vendor',
        minimumSubtotal: naira(3000),
        perCustomerQuota: 5,
        startsAt: new Date('2026-01-01T00:00:00Z'),
        isActive: true,
      },
    ],
  });

  // -------------------------------------------------------------------------
  // Feature flags
  // -------------------------------------------------------------------------
  await prisma.featureFlag.createMany({
    data: [
      { key: 'package_delivery', description: 'Send a parcel across the city', isEnabled: false, rolloutPercent: 0 },
      { key: 'events_ticketing', description: 'Event discovery and ticketing', isEnabled: false, rolloutPercent: 0 },
      { key: 'scheduled_orders', description: 'Order now, deliver later', isEnabled: true, rolloutPercent: 100 },
      { key: 'cash_on_delivery', description: 'Pay the rider in cash', isEnabled: true, rolloutPercent: 100 },
      { key: 'batched_dispatch', description: 'Stack compatible deliveries', isEnabled: false, rolloutPercent: 0 },
    ],
  });

  // -------------------------------------------------------------------------
  // Orders across the lifecycle, with matching ledger entries
  // -------------------------------------------------------------------------
  const kitchen = createdVendors[0];
  const suya = createdVendors[1];
  const grocer = createdVendors[2];
  if (!kitchen || !suya || !grocer) throw new Error('Vendor seed failed');

  interface OrderPlan {
    label: string;
    vendor: typeof kitchen;
    customer: (typeof createdCustomers)[number];
    rider?: (typeof createdRiders)[number];
    status: string;
    items: { name: string; price: number; quantity: number }[];
    distanceMetres: number;
    capture: boolean;
  }

  const c0 = createdCustomers[0];
  const c1 = createdCustomers[1];
  const c2 = createdCustomers[2];
  const r0 = createdRiders[0];
  const r1 = createdRiders[1];
  if (!c0 || !c1 || !c2 || !r0 || !r1) throw new Error('Customer/rider seed failed');

  const orderPlans: OrderPlan[] = [
    {
      label: 'delivered last night',
      vendor: kitchen,
      customer: c0,
      rider: r0,
      status: 'delivered',
      items: [{ name: 'Party Jollof Rice', price: 3500, quantity: 2 }],
      distanceMetres: 5200,
      capture: true,
    },
    {
      label: 'waiting for the vendor',
      vendor: suya,
      customer: c1,
      status: 'placed',
      items: [{ name: 'Beef Suya Platter', price: 5000, quantity: 1 }],
      distanceMetres: 3100,
      capture: true,
    },
    {
      label: 'in the kitchen',
      vendor: kitchen,
      customer: c2,
      status: 'preparing',
      items: [{ name: 'Pounded Yam & Egusi', price: 4800, quantity: 1 }],
      distanceMetres: 7400,
      capture: true,
    },
    {
      label: 'rider en route',
      vendor: grocer,
      customer: c1,
      rider: r1,
      status: 'en_route',
      items: [
        { name: 'Long Grain Rice (5kg)', price: 9500, quantity: 1 },
        { name: 'Vegetable Oil (2L)', price: 6800, quantity: 1 },
      ],
      distanceMetres: 2600,
      capture: true,
    },
    {
      label: 'cancelled by the customer',
      vendor: suya,
      customer: c0,
      status: 'cancelled',
      items: [{ name: 'Peppered Chicken Wings', price: 4500, quantity: 1 }],
      distanceMetres: 4100,
      capture: false,
    },
  ];

  let orderCount = 0;
  for (const plan of orderPlans) {
    const itemsSubtotal = naira(
      plan.items.reduce((total, item) => total + item.price * item.quantity, 0),
    );

    const quote = buildQuote({
      rules: pricingRules,
      mode: 'delivery',
      itemsSubtotal,
      trip: {
        distanceMetres: plan.distanceMetres,
        durationMinutes: Math.round((plan.distanceMetres / 1000) * 3.5),
        distanceSource: 'haversine_with_detour_factor',
      },
    });

    const order = await prisma.order.create({
      data: {
        code: generateReference('DASH'),
        customerId: plan.customer.customer.id,
        vendorId: plan.vendor.vendor.id,
        branchId: plan.vendor.branch.id,
        addressId: plan.customer.address.id,
        zoneId: plan.vendor.branch.zoneId,
        riderId: plan.rider?.rider.id ?? null,
        status: plan.status,
        mode: 'delivery',
        itemsSubtotal: quote.itemsSubtotal,
        discountTotal: quote.discountTotal,
        deliveryFee: quote.deliveryFee,
        serviceFee: quote.serviceFee,
        smallOrderFee: quote.smallOrderFee,
        surgeAmount: quote.surgeAmount,
        tax: quote.tax,
        tip: quote.tip,
        walletApplied: quote.walletCreditApplied,
        total: quote.total,
        vendorFundedDiscount: quote.vendorFundedDiscount,
        platformFundedDiscount: quote.platformFundedDiscount,
        // The item/delivery split lives in the stored quote JSON rather than in
        // its own columns — settlement reads it from there.
        quoteBreakdown: JSON.stringify(quote),
        pricingRuleVersion: quote.ruleVersion,
        distanceMetres: plan.distanceMetres,
        durationMinutes: Math.round((plan.distanceMetres / 1000) * 3.5),
        distanceSource: 'haversine_with_detour_factor',
        pickupCodeHash: await hashOtp(generatePin(4)),
        deliveryPinHash: await hashOtp(generatePin(4)),
        placedAt: new Date(SEED_NOW.getTime() - 3_600_000),
        acceptedAt: plan.status === 'placed' ? null : new Date(SEED_NOW.getTime() - 3_300_000),
        deliveredAt: plan.status === 'delivered' ? new Date(SEED_NOW.getTime() - 1_800_000) : null,
        cancelledAt: plan.status === 'cancelled' ? new Date(SEED_NOW.getTime() - 3_000_000) : null,
        cancellationReason: plan.status === 'cancelled' ? 'Customer changed their mind' : null,
        items: {
          create: plan.items.map((item) => ({
            nameSnapshot: item.name,
            priceSnapshot: naira(item.price),
            quantity: item.quantity,
            lineTotal: naira(item.price * item.quantity),
          })),
        },
        statusEvents: {
          create: [
            {
              fromStatus: null,
              toStatus: 'placed',
              actorType: 'system',
              createdAt: new Date(SEED_NOW.getTime() - 3_600_000),
            },
            {
              fromStatus: 'placed',
              toStatus: plan.status,
              actorType: plan.status === 'cancelled' ? 'customer' : 'vendor',
              createdAt: new Date(SEED_NOW.getTime() - 3_000_000),
            },
          ],
        },
      },
    });

    if (plan.capture) {
      const settlement = computeSettlement({
        quote,
        commissionBasisPoints: plan.vendor.definition.commission,
        riderDeliveryPay: naira(600),
      });

      await prisma.payment.create({
        data: {
          orderId: order.id,
          provider: 'mock',
          providerReference: `mock_${order.code}`,
          amount: quote.total,
          method: 'card',
          status: 'captured',
          idempotencyKey: `seed_capture_${order.id}`,
          capturedAt: new Date(SEED_NOW.getTime() - 3_500_000),
        },
      });

      const draft = buildOrderCapture({
        orderId: order.id,
        idempotencyKey: `seed_ledger_${order.id}`,
        actorId: 'system',
        occurredAt: new Date(SEED_NOW.getTime() - 3_500_000),
        cashReceived: quote.total,
        walletApplied: quote.walletCreditApplied,
        customerId: plan.customer.customer.id,
        vendorId: plan.vendor.vendor.id,
        vendorPayable: settlement.vendorPayable,
        riderPayable: settlement.riderPayable,
        riderId: plan.rider?.rider.id,
        platformRevenue: settlement.platformRevenue,
        taxCollected: settlement.taxCollected,
        platformFundedItemDiscount: quote.platformFundedItemDiscount,
      });

      await prisma.ledgerTransaction.create({
        data: {
          kind: draft.kind,
          idempotencyKey: draft.idempotencyKey,
          referenceType: draft.referenceType,
          referenceId: draft.referenceId,
          actorId: draft.actorId,
          occurredAt: draft.occurredAt,
          entries: {
            create: draft.entries.map((entry) => ({
              accountKind: entry.accountKind,
              ownerId: entry.ownerId ?? null,
              amount: entry.amount,
              memo: entry.memo,
            })),
          },
        },
      });
    }

    orderCount += 1;
  }

  // -------------------------------------------------------------------------
  // A support case tied to the cancelled order
  // -------------------------------------------------------------------------
  const cancelledOrder = await prisma.order.findFirst({ where: { status: 'cancelled' } });
  if (cancelledOrder) {
    await prisma.supportCase.create({
      data: {
        code: generateReference('CASE'),
        customerId: cancelledOrder.customerId,
        orderId: cancelledOrder.id,
        subject: 'Refund not received for cancelled order',
        category: 'refund',
        priority: 'high',
        status: 'open',
        firstResponseDueAt: new Date(SEED_NOW.getTime() + 3_600_000),
        actions: {
          create: [
            {
              actorId: 'system',
              kind: 'note',
              body: 'Order cancelled before the vendor accepted. Eligible for a full refund.',
              isInternal: true,
            },
          ],
        },
      },
    });
  }

  // -------------------------------------------------------------------------
  // Verify what we just wrote
  // -------------------------------------------------------------------------
  const entries = await prisma.ledgerEntry.findMany({ select: { amount: true, transactionId: true } });
  const byTransaction = new Map<string, number>();
  for (const entry of entries) {
    byTransaction.set(entry.transactionId, (byTransaction.get(entry.transactionId) ?? 0) + entry.amount);
  }
  const unbalanced = [...byTransaction.entries()].filter(([, sum]) => sum !== 0);
  if (unbalanced.length > 0) {
    throw new Error(`Seed produced ${unbalanced.length} unbalanced ledger transaction(s)`);
  }

  const counts = {
    cities: await prisma.city.count(),
    zones: await prisma.zone.count(),
    vendors: await prisma.vendor.count(),
    items: await prisma.menuItem.count(),
    customers: await prisma.customer.count(),
    riders: await prisma.rider.count(),
    orders: orderCount,
    ledgerTransactions: byTransaction.size,
    promotions: await prisma.promotion.count(),
  };

  // Declutter geography and categories. Reference data, upserted rather than
  // recreated, and deliberately absent from the wipe above: it is keyed by
  // slug, listings will point at it, and losing it on every reseed would be a
  // habit that breaks the first time it meets production.
  const declutter = await seedDeclutterTaxonomy(prisma);

  console.warn('Seed complete.\n');
  console.warn(`  ${counts.cities} city, ${counts.zones} zones`);
  console.warn(
    `  Declutter: ${declutter.locations} locations, ${declutter.categories} categories`,
  );
  console.warn(`  ${counts.vendors} vendors, ${counts.items} catalogue items`);
  console.warn(`  ${counts.customers} customers, ${counts.riders} riders`);
  console.warn(`  ${counts.orders} orders, ${counts.ledgerTransactions} ledger transactions (all balanced)`);
  console.warn(`  ${counts.promotions} promotions\n`);
  console.warn('Development sign-in — these accounts are fictional and local only:');
  console.warn(`  Super admin    admin@dashapp.test      ${DEV_PASSWORD}`);
  console.warn(`  Dispatcher     ops@dashapp.test        ${DEV_PASSWORD}`);
  console.warn(`  Support        support@dashapp.test    ${DEV_PASSWORD}`);
  console.warn(`  Finance        finance@dashapp.test    ${DEV_PASSWORD}`);
  console.warn(`  Vendor owner   iya-kemi-kitchen@dashapp.test  ${DEV_PASSWORD}`);
  console.warn('');
  if (keyring) {
    console.warn('');
    console.warn('  Staff accounts require an authenticator code (TOTP). In development');
    console.warn('  every staff account shares this fixed, fake secret:');
    console.warn(`      ${DEV_TOTP_SECRET}`);
    console.warn('  Add it to any authenticator app as "DASH APP (dev)".');
  } else {
    console.warn('');
    console.warn('  No ENCRYPTION_KEY is set, so staff were seeded WITHOUT MFA enrolment.');
    console.warn('  They will be asked to enrol on first sign-in.');
  }
  console.warn('');
  console.warn('Customers and riders sign in by OTP. In development the code is');
  console.warn('printed to the API console; production never exposes it.');
  console.warn(`  Customer  ${customerDefinitions[0]?.phone}`);
  console.warn(`  Rider     ${riderDefinitions[0]?.phone}\n`);
}

main()
  .catch((error: unknown) => {
    console.error('\nSeed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
