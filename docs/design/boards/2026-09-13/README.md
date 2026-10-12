# DASH mobile boards — director-approved, 13 September 2026

The visual source of truth for the native Customer and Rider apps. Reproduce
them faithfully; where an implementation constraint or a product rule forces a
difference, report it rather than reinterpreting the design.

| File | Board | Scope |
|---|---|---|
| `customer.png` | Customer — Home, Shops, Storefront, Product, Cart, Checkout, Payment, Order Placed, Live Tracking, Delivered | native app |
| `rider.png` | Rider — Home, Online, Incoming Order, Order Details, Pickup Route, Verify Pickup, On Delivery, Delivery Complete, Earnings, Profile & Settings | native app |
| `vendor.png` | Vendor — Home, Orders, Order Detail, Catalog, Add Product, Inventory, Analytics, Promotions, Reviews & Support, Profile & Settings | **reference only** — Vendor is web-first; no native Vendor app is planned |

Navigation, as drawn:

- Customer: **Home · Orders · Wallet · Support**; the profile is reached from
  the avatar on Home.
- Rider: **Home · Earnings · Orders · Inbox · Profile**.

The boards are AI-rendered mock-ups. They fix composition, hierarchy, colour,
spacing and card language; they do not fix exact pixel sizes, a typeface, or
the content of any figure shown in them. Colour tokens were sampled from these
files — see `apps/mobile/src/theme/tokens.ts`.

Differences made in implementation, and why, are listed in
`apps/mobile/README.md` under "Deliberate differences from the boards".
