# Audit — fulfilment language across the five sections

Status: **audit only, nothing implemented.** Requested 8 September 2026, after
the rider swipe-away / FCM wake / cold-start restore / fresh-location acceptance
flow passed physically end to end.

The question: `Preparing` is restaurant language, and it is now shown to
customers buying a sofa, a prescription and a basket of tomatoes.

---

## 1. Every user-visible occurrence

Restaurant-centric language reaches users through **four** surfaces, and only
one of them is a single point.

### Server-generated, one function — the good case

`customerLabel(status)` in `packages/domain/src/orders/index.ts` produces every
customer-facing status string. It is called twice in `routes/orders.ts` (the
list and the detail) and rendered in three places on the web.

| Status | Current label | Restaurant-centric? |
|---|---|---|
| `preparing` | **"Being prepared"** | **yes — the main offender** |
| `ready` | "Ready for pickup" | no, but "pickup" reads oddly for delivery |
| `rider_assigned` | "Rider on the way to vendor" | no |
| `placed` | "Sent to vendor" | no |
| everything else | — | no |

Because this is one pure function, **the whole customer side can be made
vertical-aware in one place.**

### Hardcoded in the client — three places

| File | What | Problem |
|---|---|---|
| `(customer)/orders/[id]/page.tsx:66` | `PHASES` timeline: `{ key: 'preparing', label: 'Preparing' }` | duplicates the server's vocabulary, and diverges from it |
| `vendor/page.tsx:290` | button **"Start preparing"** | wrong verb for four of five sections |
| `vendor/page.tsx:305` | button "Mark ready for pickup" | acceptable, slightly off for Declutter |

### A leak worth fixing regardless of verticals

`vendor/page.tsx:194` renders the status chip as:

```tsx
{order.status.replace(/_/g, ' ')}
```

That prints the **raw backend status** to vendors — "preparing", "rider
assigned", "vendor reviewing". It exposes internal state names, it will drift
the moment a status is renamed, and it is the one place a vendor sees language
nobody wrote for them. Independent of this audit, it should use a label
function.

### Already vertical-neutral — leave alone

The rider screen's step labels are about **logistics**, not merchandise, and
read correctly for every section:

> "I'm at the vendor" · "Picked up the order" · "On my way" · "I'm at the customer"

That is the right instinct and worth preserving: the rider's language should
stay operational and identical across verticals, because the rider's job *is*
identical. Only the customer and vendor need vertical vocabulary.

### One false positive

`basket/page.tsx:398` — "Preparing your total…" is about computing a quote, not
fulfilment. Harmless, but it collides with the word we are about to make
meaningful, and "Working out your total…" costs nothing.

---

## 2. What can become vertical-aware with no backend change

**All of the shared verticals.** The state machine, dispatch, the outbox, the
rider flow and the acceptance gate are untouched — this is a presentation
mapping over the same `preparing` status.

```
customerLabel(status)  →  customerLabel(status, category)
```

Proposed vocabulary:

| Section | `accepted` | `preparing` | `ready` |
|---|---|---|---|
| Restaurants | Order confirmed | **Preparing your order** | Ready for pickup |
| Shops | Order confirmed | **Picking & packing** | Ready for pickup |
| Pharmacy | Order confirmed | **Pharmacy processing order** | Ready for pickup |
| Local Market | Order confirmed | **Sourcing your items** | Packed and ready |
| Declutter | *(see §4 — different domain)* | | |

From `ready` onward all five converge, because from there it genuinely is the
same job:

> Ready for pickup → Rider assigned → Picked up → On the way → Delivered

**One dependency:** `vendor.category` is currently **not** selected in either
order projection (`routes/orders.ts` selects `id, name, slug` only). Two
one-line additions.

Vendor-side verbs map the same way: *Start preparing* becomes *Start picking*
for Shops, *Start processing* for Pharmacy, *Start sourcing* for Local Market.

On Pharmacy specifically — the direction is right and worth stating in the
code: **"Pharmacy processing order"**, never "Preparing your medicine". The
first describes handling a prescription; the second implies compounding, which
is a regulated activity DASH does not perform and must not appear to.

---

## 3. Components and screens involved

| Layer | File | Change |
|---|---|---|
| Domain | `packages/domain/src/orders/index.ts` | `customerLabel(status, category)`; keep `phaseOf` as-is |
| API | `apps/api/src/routes/orders.ts` | add `category` to two vendor selects |
| Customer | `(customer)/orders/[id]/page.tsx` | timeline labels from the server, not a local array |
| Customer | `(customer)/orders/page.tsx` | already renders `statusLabel` — no change |
| Vendor | `vendor/page.tsx` | vertical-aware action verbs; **stop printing raw status** |
| Vendor | `components/vendor-dialogs.tsx` | reject/verify copy — check for restaurant assumptions |
| Rider | `app/rider/page.tsx` | **no change** — deliberately vertical-neutral |

---

## 4. Where Declutter genuinely needs a different domain

It is not a labelling problem. The proposed flow contains states the order
machine has no equivalent for:

```
Listing available → Buyer interested → Inspection / video call / physical
verification → Deal agreed / reserved → Seller confirms ready →
[ Self pickup | DASH Delivery ] → Collected/Delivered → Sold/Completed
```

Three structural mismatches, in order of seriousness:

1. **`preparing` triggers dispatch.** A Declutter seller acknowledging buyer
   interest would send a rider to collect a sofa that has not been inspected,
   agreed or paid for. The requirement that "seller acknowledging buyer interest
   must never dispatch a rider" is *incompatible* with reusing the current
   status, because dispatch is bound to that transition.
2. **Delivery is optional.** Self-pickup means an order that completes without
   ever entering rider logistics. Today every order assumes a delivery leg.
3. **Inventory is singular.** A second-hand sofa is one item that becomes
   unavailable when reserved. `MenuItem`/`ItemStock` model repeatable stock.

**Only the last leg maps** — once a deal is agreed and DASH Delivery is chosen,
`ready → rider_assigned → picked_up → en_route → delivered` fits unchanged, and
should be reused rather than rebuilt.

**On the current implementation:** the Declutter seller and its twelve listings
were built to exercise rider logistics, and have done so — the passing
swipe-away test ran against `DASH Declutter Lagos`. That was their purpose.
They should not be mistaken for the marketplace domain, and the historical
shape must not define the eventual one.

---

## 5. Now versus deferred

### Now — small, safe, no state-machine change

1. `customerLabel(status, category)` and the two projection additions.
2. Vendor action verbs per vertical.
3. **The raw-status leak** in the vendor console — a bug independent of this work.
4. Timeline labels sourced from the server so client and server cannot diverge.
5. "Preparing your total…" → "Working out your total…".

Declutter keeps restaurant language for now. It is honest interim behaviour, it
is what the rider tests run against, and changing it before the domain exists
would mean writing language for a flow that does not yet work that way.

### Deferred — needs its own design first

6. The Declutter domain: listing lifecycle, inspection, reservation, self-pickup
   versus delivery, and single-item inventory. This wants a design document of
   its own, the way the offer-grace work did, before any code.
7. The full visual redesign.
8. Removing `preparing` from Declutter — a consequence of (6), not a precursor.

---

## 6. How these screens fit the DASH design direction

Recorded now so the frontend surface area is not rediscovered each time.

| Screen | Role | Direction |
|---|---|---|
| Customer order tracking | **richest** | The hero of the customer experience: live map, spring/morph transitions between phases, a strong status moment on each change. Status language is the headline — it must read naturally per vertical, because this is the screen people watch. |
| Customer orders list | rich | Image-led cards, phase as a coloured state, glass only on the floating nav. |
| Customer basket / checkout | transactional | **Light, high-contrast surfaces.** Readability outranks effect where money is concerned; glass belongs on navigation, not on totals. |
| Vendor console | premium business software | Dense, calm, information-first. Vertical-aware verbs matter most here — this is where a pharmacist reads instructions written for a restaurant. Restrained motion. |
| Rider | operational | Same DNA, maximum legibility: large targets, high contrast, minimal chrome. Motion reserved for the offer arrival — the one moment that must interrupt. |
| Ops / Admin | most restrained | Information-dense, effectively no decoration. |

Two constraints this audit imposes on that work:

- **Status language is server-generated.** Any redesign must keep rendering
  `statusLabel` rather than re-deriving vocabulary in the client, or the
  divergence the `PHASES` array already shows will multiply across screens.
- **The rider's language stays vertical-neutral.** Whatever the customer sees,
  the rider's job is the same in all five sections, and their screen should not
  make them think otherwise mid-shift.
