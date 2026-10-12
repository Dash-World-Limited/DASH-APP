# DASH APP product foundation

**Status:** locked product contract · 13 September 2026

This document is the source of truth for client navigation and business-domain
boundaries. A new mockup, copy pass, or implementation must not silently
replace these decisions.

## Official service order

| Position | Permanent id | Visible label | Business kind |
|---:|---|---|---|
| 1 | food | FOOD | Merchant commerce |
| 2 | shops | SHOPS | Merchant commerce |
| 3 | pharmacy | PHARMACY | Merchant commerce |
| 4 | local_market | LOCAL MARKET | Merchant commerce |
| 5 | declutter | DECLUTTER | Peer marketplace |
| 6 | logistics | LOGISTICS | Shipment request |

The order is an API, analytics and navigation contract. Do not alphabetise it.
Do not use Essentials, Groceries, Restaurants, Parcel, More or Delivery as
top-level category labels.

## Home navigation

- The permanent home grid shows all six services equally in a two-column,
  three-row reading order: FOOD / SHOPS, PHARMACY / LOCAL MARKET,
  DECLUTTER / LOGISTICS.
- A large promotional hero may swipe through all six services in the same
  order and includes progress dots.
- The hero is campaign content, not the permanent category navigation.
- Declutter must be visible and memorable, but the app must never look like a
  Declutter-only product.

## Client topology

- Customer: genuine React Native / Expo mobile app.
- Rider: separate genuine React Native / Expo mobile app.
- Vendor: web operations app with app-like interaction and responsive layout.
- Admin, support and finance: protected web operations app.
- Native apps call the API directly. A WebView wrapper is not an acceptable
  substitute.

## Brand guardrails

- Never redraw, stretch, crop or reinterpret official DASH World logo geometry.
  Use a marked placeholder until the approved asset is available.
- Core palette: Warm Ivory #FAF8F2, Soft Ash #E8EAED, Graphite #0B0D10,
  Dash Gold #D4AF37 and Slate #64748B.
- Emerald #13A86B and Coral #EF5B5B are status colours, not dominant brand
  backgrounds.
- Blue is not part of this product direction.
- When website text is needed, use www.dashworldng.com.

## Compatibility with current data

| Existing Vendor.category | Public service id |
|---|---|
| restaurant | food |
| grocery | shops |
| retail | shops |
| pharmacy | pharmacy |
| market | local_market |

These mappings are compatibility rules, not a reason to expose legacy names in
new navigation. Existing values remain readable until measured client usage
shows the compatibility filter can be retired.

## Domain boundaries

The existing Order aggregate is a merchant order. It requires a vendor and
branch and contains food/vendor preparation and cancellation rules. Keep it
that way.

Declutter needs its own listing, seller, offer/purchase, inspection, dispute and
handoff rules. Logistics needs its own shipment request, package, sender,
recipient, quotation, chain-of-custody and proof-of-delivery rules. Either may
eventually create a shared fulfilment job, but neither is stored as a fake
restaurant order.

## Migration discipline

1. Add new tables, columns and endpoints before changing readers.
2. Keep permanent ids stable; visible copy is separate.
3. Never reinterpret historical rows in place.
4. Backfill in bounded, resumable batches with counts and reconciliation.
5. Dual-read or dual-write only for a documented transition window.
6. Observe the cutover before removing old paths in a later release.
7. Every migration needs rollback criteria, tests on an empty database and a
   rehearsal against a production-shaped copy.

No schema migration is required for the first taxonomy foundation because the
compatibility layer reads existing Vendor.category values.
