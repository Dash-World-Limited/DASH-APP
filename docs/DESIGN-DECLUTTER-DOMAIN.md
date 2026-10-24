# Declutter as a first-class domain

**Status:** design only. No migration, no API, no UI. Nothing in this document has
been implemented.
**Written against:** `b3bb481` (fulfilment language), branch
`claude/milestone-vi-v1-experience`.
**Supersedes in intent:** the seed comment at `packages/db/src/seed.ts:339`, which
states plainly that V1 Declutter "deliberately reuses the vendor and catalogue
models rather than growing a second commerce engine". That was the right call for
proving rider logistics. It is the wrong shape for a marketplace, and this
document says why and what replaces it.

---

## 0. The recommendation, in one paragraph

**Split the transaction from the logistics.** Introduce two new first-class
entities — `DeclutterListing` and `DeclutterDeal` — and keep `Order` as what it
already is: the record of a physical fulfilment leg. For a restaurant, order and
transaction are the same object because agreement is instantaneous. For
Declutter they are not: agreement is a process with inspection, negotiation and
reservation in it, and none of that is logistics. So the deal owns agreement, the
order owns movement, and an `Order` is **materialised only at the moment the deal
is ready and the buyer has chosen DASH Delivery or Self Pickup**. This reuses the
proven dispatch engine untouched, never invents a second one, and makes the
absence of `preparing` a structural fact rather than a naming convention.

The single hardest consequence, called out early because it is the thing most
likely to be argued about: **`Order.vendorId` and `Order.branchId` must become
nullable**, guarded by a database check constraint. The alternative — minting a
throwaway `Vendor` and `Branch` for every private individual who sells a sofa —
is how the vendor table, commission reporting and the vendor console all get
quietly poisoned. Section 5 argues this in full.

---

## 1. Current-model audit

### 1.1 What Declutter is today

Declutter is a **presentation filter over the general commerce engine**. There is
no Declutter code path; there is a category string.

| Concern | Where it lives today |
| --- | --- |
| Section identity | `Vendor.category === 'declutter'` (`schema.prisma:590`) |
| Section grouping | `SECTIONS` table, `apps/web/src/lib/sections.ts:58` |
| A listing | `MenuItem`, with `condition` nullable (`schema.prisma:762`) |
| Listing grouping | `MenuCategory`, per vendor |
| Listing photo | `MenuItem.imageKey` — **exactly one** |
| Availability | `MenuItem.isAvailable`, plus `ItemStock.quantity` per branch |
| Buying | `Cart` → `Order`, 17 statuses, `packages/domain/src/orders/index.ts` |
| Language | `vocabulary.ts`, added at `b3bb481` |
| Screen | `apps/web/src/app/(customer)/declutter/page.tsx` — 21 lines, delegates to `SectionPage` |
| Seed | `dash-declutter-lagos`, one approved vendor, `packages/db/src/seed.ts:486` |

### 1.2 What already fits, and should not be re-invented

These are load-bearing and correct. The design below preserves all of them.

- **`condition`** — `new | like_new | good | fair`, already on the item, already
  with a schema comment explaining that overloading `description` would make the
  data unqueryable and untrue. The new listing model keeps these exact four
  strings so no translation table is ever needed.
- **Money as integer kobo.** Stated at `schema.prisma:21`: always `Int`, never
  Decimal, never Float. Non-negotiable and inherited wholesale.
- **The dispatch engine.** `DispatchOffer`, `eligibilityMode`, the fresh/grace
  distinction, the acceptance-side revalidation, the outbox-driven
  `dispatch.find_rider` job. Physically proven. **Nothing here touches it.**
- **`OrderStatusEvent`.** A denormalised current status on the row plus an
  append-only event log beside it. This is the house pattern for lifecycle, and
  Section 7 reuses it rather than inventing a different one for moderation.
- **`Order.mode`** — already `delivery | pickup | vendor_delivery`. Self Pickup
  does not need a new concept; it needs an existing one to be reachable.
- **`vocabulary.ts`.** It already anticipates this work. Its comment on the
  Declutter `preparing` string says the real lifecycle "does not exist yet, and
  language implying any of it would describe a flow the app cannot carry out."
  That placeholder is what this document removes.

### 1.3 The gaps — what the current model structurally cannot express

Not opinions. Each is a thing the schema makes impossible.

1. **More than one photo.** `MenuItem.imageKey` is a single nullable string. A
   second-hand marketplace with one photo per item is not a marketplace. Adding
   `imageKey2..imageKey6` would be the wrong fix.
2. **Per-listing location.** Location lives on `Branch`. A vendor has branches; a
   private seller has an address. Two people in different parts of Lagos cannot
   sell through one vendor and have their items filter correctly by area.
3. **Listing moderation.** `Vendor.status` is KYB — it approves the *seller*.
   There is no state on `MenuItem` at all, so there is nowhere to express
   "approved, then edited, and now awaiting re-review".
4. **Buyer interest that is not a purchase.** The only way a buyer can signal
   anything today is `Cart` → checkout. There is no expression of "I am
   interested, let us talk" that does not move money.
5. **Inspection.** No state exists between wanting an item and paying for it.
6. **Exclusive reservation.** `ItemStock.quantity` decrements on order
   acceptance. For a unique item, exclusivity is needed *before* that, at the
   moment two buyers are both mid-conversation.
7. **Fulfilment chosen after agreement.** `Order.mode` is fixed at checkout
   (`apps/api/src/routes/orders.ts:52`). The target journey chooses Self Pickup
   or DASH Delivery *after* the deal is agreed and the seller says ready.
8. **A lifecycle without `preparing`.** `preparing` is not decoration — it is the
   dispatch trigger (`apps/api/src/routes/vendor.ts:361`: "`preparing` is the ONE
   trigger for normal rider dispatch"). Any Declutter flow that reaches a rider
   through today's path *must* pass through `preparing`. The fake state and the
   dispatch mechanism are the same fact.

### 1.4 The dispatch trigger, precisely

This is the most important mechanical detail in the audit.

- `accepted → preparing`, made in `routes/vendor.ts`, enqueues
  `dispatch.find_rider` through the transactional outbox. Idempotency is keyed on
  that transition, and `assertTransition` refuses `preparing → preparing`, so a
  double-tapped button cannot produce two rounds.
- The worker reads the pickup point at `apps/api/src/workers/dispatch.ts:181` as
  **`order.branch.latitude` / `order.branch.longitude`**, directly.
- Two other call sites exist already and are documented as exceptions: ops
  reassignment (`routes/admin.ts`) and the worker's own re-rounding.

Two consequences for this design. First, a Declutter delivery cannot dispatch
without a pickup coordinate that does not come from a `Branch` — that line is the
exact place the indirection has to go. Second, adding a **third guarded call site**
for the same outbox job is reuse, consistent with how ops reassignment already
works; it is not a second dispatch engine.

---

## 2. Proposed entities and relationships

### 2.1 Naming — the alternatives, and why these

The brief asked for names to be compared, not accepted.

| Candidate | Verdict |
| --- | --- |
| `DeclutterListing` | **Chosen.** "Listing" is the marketplace term of art, it is what the seller thinks they created, and it is not a `MenuItem`. |
| `MarketplaceItem` | Rejected. Reads as inventory, and DASH already has `MenuItem`; two "item" models invite confusion at every call site. |
| `DeclutterDeal` | **Chosen.** Short, and "deal" is what a buyer and seller in Nigeria actually call the thing they are negotiating. |
| `MarketplaceTransaction` | Rejected. "Transaction" already means something specific and financial in this codebase — `LedgerTransaction` — and a deal that ends in self-pickup with cash may never produce one. Reusing the word would be actively misleading. |
| `Negotiation` | Rejected. Implies bidding, which V1 does not have. |
| `Delivery` (new model) | Rejected. `Order` already *is* the delivery record, with `DispatchOffer`, `DeliveryProof`, PIN hashes and the rider relation hanging off it. A parallel `Delivery` would fork the proven engine — the one outcome the brief forbids. |

The `Declutter` prefix is deliberate. These models are not general marketplace
infrastructure yet, and a name that overpromises invites the next vertical to
attach itself to a model that was never designed for it.

### 2.2 The models

Shapes, not migration syntax. Field names indicative.

```
DeclutterListing
  id, slug
  sellerCustomerId        -> Customer          (always: a seller is a person)
  sellerVendorId          -> Vendor?           (set only for curated/partner sellers)
  cityId, zoneId?                              (feed filtering)
  pickupAddressId         -> Address           (where a rider would collect)
  areaLabel               String               (human: "Lekki", "Okpanam Road")
  title, description
  categoryKey             String               (taxonomy, not MenuCategory)
  condition               String               (new | like_new | good | fair)
  askingPriceKobo         Int                  (integer kobo. always.)
  moderationStatus        String               (§7)
  availability            String               (§3)
  activeDealId            String? @unique      (the reservation lock — §6)
  publishedAt?, soldAt?, archivedAt?
  revision                Int                  (same reason Order has one)
  createdAt, updatedAt

DeclutterPhoto
  id, listingId, storageKey, position, width, height
  @@unique([listingId, position])              // 1..6, position 0 is the cover

DeclutterListingEvent                          // append-only, mirrors OrderStatusEvent
  id, listingId, fromStatus, toStatus
  actorType (seller | ops | system), actorId, reasonCode?, note?, createdAt

DeclutterDeal
  id, code                                     // human reference, like Order.code
  listingId  -> DeclutterListing
  buyerCustomerId -> Customer
  status                  String               (§4)
  agreedPriceKobo         Int?                 (may differ from asking price)
  fulfilmentChoice        String?              (self_pickup | dash_delivery)
  reservedUntil           DateTime?
  orderId                 String? @unique      (materialised at the boundary — §5)
  cancelledBy?, cancellationReason?
  revision                Int
  createdAt, agreedAt?, readyAt?, completedAt?, cancelledAt?
  @@unique([listingId, buyerCustomerId])       // one open deal per buyer per listing

DeclutterDealEvent                             // append-only, same shape as above

Order  (existing, modified)
  vendorId   String?    <- becomes nullable
  branchId   String?    <- becomes nullable
  pickupAddressId String?                      (used when branchId is null)
  declutterDealId String? @unique
  // CHECK: (vendorId IS NOT NULL AND branchId IS NOT NULL) XOR (declutterDealId IS NOT NULL)
```

### 2.3 What is deliberately *not* modelled

- **No `DeclutterSeller` model.** A seller is a `Customer` who has listed
  something. Inventing a parallel identity would fork account, auth and support.
- **No messaging model.** Inspection happens on WhatsApp, by phone, by video
  call. The brief says video call is a contact method, not stored media. V1
  records *that* contact was made and when — never its content.
- **No bidding, no offers table.** `agreedPriceKobo` is a single number written
  once when the deal is agreed. Negotiation happens off-platform in V1.
- **No new `Delivery` model.** See §2.1.

---

## 3. Listing lifecycle

Two orthogonal axes, deliberately kept as two columns rather than one blended
status. Collapsing them is how a listing ends up "sold" because a moderator
rejected an edit.

**`moderationStatus`** — is Dash World willing to show this?
`draft → pending_review → approved → (rejected | suspended)`

**`availability`** — is the thing still buyable?
`available → reserved → sold`, plus `withdrawn` (seller pulled it) and
`expired`.

A listing is publicly visible if and only if
`moderationStatus === 'approved' && availability === 'available'`.
Reserved listings stay visible but are not actionable — hiding them makes a busy
marketplace look empty, and a returning buyer needs to see why they cannot act.

Transitions worth naming:

| From | To | Trigger | Note |
| --- | --- | --- | --- |
| `available` | `reserved` | Deal reaches `agreed` | Sets `activeDealId` — §6 |
| `reserved` | `available` | Reservation expires or deal cancels | Clears `activeDealId` |
| `reserved` | `sold` | Deal reaches `completed` | The **only** path to `sold` |
| `available` | `sold` | Seller marks "sold elsewhere" | Off-platform sale, §6 |
| `approved` | `pending_review` | Material edit — §7 | Availability unaffected |

**A listing never becomes `sold` because a buyer expressed interest.** The only
writer of `sold` is deal completion, and the state machine refuses every other
path. This is the invariant the brief asked for, stated as a rule the code can
enforce.

---

## 4. Deal lifecycle

```
                    buyer taps Interested
                              │
                              ▼
                        interested ──────────────┐
                              │                  │
              seller acknowledges                │
                              ▼                  │
                        in_contact ──────────────┤
                              │                  │  buyer or seller
                     both agree terms            │  walks away, or
                              ▼                  │  expiry
                          agreed ────────────────┤
                    (listing → reserved)         │
                              │                  │
                seller confirms item ready       │
                              ▼                  │
                          ready ─────────────────┤
                              │                  │
              buyer picks fulfilment             │
                    ┌─────────┴─────────┐        │
                    ▼                   ▼        │
            self_pickup           dash_delivery  │
                    │                   │        │
                    │            (Order materialised, §5)
                    │                   │        │
                    └─────────┬─────────┘        │
                              ▼                  ▼
                         completed           cancelled
                    (listing → sold)   (listing → available)
```

**Seven states:** `interested`, `in_contact`, `agreed`, `ready`, `self_pickup`,
`dash_delivery`, `completed`, `cancelled`.

Deliberate decisions:

- **`interested` is not exclusive.** Many buyers may hold an `interested` deal on
  one listing simultaneously. This is the direct answer to "a listing should not
  become sold merely because somebody clicked Interested" — interest costs
  nothing and locks nothing.
- **`in_contact` is a real state, not a UI hint.** It records that the seller
  acknowledged, which is the moment the buyer stops waiting. It is also the state
  the brief warns about: **acknowledging interest must never dispatch a rider**,
  and here it structurally cannot, because no `Order` exists yet.
- **No `inspection_pending`.** Inspection is not a state the platform can observe
  — it happens on WhatsApp or in someone's living room. A state DASH cannot
  verify is a state that will be wrong. `in_contact` covers the whole period
  between acknowledgement and agreement, and the UI can say "arranging
  inspection" without the server pretending to know.
- **`agreed` is the exclusivity point,** not `ready`. The moment terms are agreed
  the item must stop being sellable to anyone else.
- **`ready` is the seller's confirmation,** and it is the precondition for
  fulfilment choice. Not before: a buyer choosing delivery for an item the seller
  has not confirmed is how a rider gets sent to an empty house.
- **There is no `preparing`, and there is no state that means it.** The gap
  between `agreed` and `ready` is the seller finding and checking the item, and
  it is called `agreed`.

---

## 5. The delivery handoff boundary

This is the join between the new domain and the proven engine, and it is one
transaction in one place.

### 5.1 What happens

When a deal in `ready` receives a fulfilment choice, in a single transaction:

**Self Pickup**
1. Deal → `self_pickup`.
2. Materialise `Order { mode: 'pickup', status: 'ready', declutterDealId, pickupAddressId }`.
3. **No dispatch job is enqueued.** Self Pickup bypasses the rider engine
   entirely, as the brief requires.
4. On handover confirmation, deal → `completed`, listing → `sold`.

**DASH Delivery**
1. Deal → `dash_delivery`.
2. Materialise `Order { mode: 'delivery', status: 'ready', declutterDealId, pickupAddressId, addressId }`.
3. Enqueue `dispatch.find_rider` on the outbox, keyed on the deal id.
4. From here the order is an ordinary order: `ready → rider_assigned →
   picked_up → en_route → delivered`, exactly the proven path, with the same
   offers, the same fresh/grace eligibility, the same acceptance revalidation and
   the same PIN.
5. On `delivered`, deal → `completed`, listing → `sold`.

### 5.2 Why the order is created at `ready` and not earlier

`ready` already means, in the existing machine, "the goods exist and are waiting
for a rider". For a kitchen that is true after cooking. For Declutter it is true
the moment the seller confirms. Creating the order in `ready` means:

- `preparing` is never entered, so the fake state cannot exist even by accident;
- the brief's requested path `ready → rider_assigned → …` is used verbatim;
- there is no window in which a Declutter order sits in a state describing work
  nobody is doing.

The dispatch enqueue moves from being *derived from a status transition* to being
*an explicit act at the commitment point*. Restaurants commit at
`accepted → preparing`; Declutter commits when the seller says ready and the
buyer chose delivery. Both enqueue the same job through the same outbox with the
same idempotency discipline. **The trigger should be extracted into one named
domain function** so that "when do we spend a rider?" continues to have exactly
one answer in one file, which is the property `routes/vendor.ts:361` currently
protects with a comment.

### 5.3 The nullable-vendor decision

`Order.vendorId` and `Order.branchId` are currently `String`, non-null. A private
seller has neither. Three options were considered.

| Option | Consequence |
| --- | --- |
| **(a)** Mint a `Vendor` + `Branch` per seller | Thousands of one-item vendors. Commission, KYB, the vendor console, `@@index([category])` and every vendor report become wrong or meaningless. Rejected. |
| **(b)** A parallel `Delivery` model beside `Order` | Forks `DispatchOffer`, `DeliveryProof`, PIN handling, ops tooling. Explicitly forbidden by the brief. Rejected. |
| **(c)** Make both nullable, add a check constraint | **Recommended.** |

Option (c) with:

```sql
CHECK ((vendor_id IS NOT NULL AND branch_id IS NOT NULL) <> (declutter_deal_id IS NOT NULL))
```

An order is either a vendor order or a declutter order, never both, never
neither. The database refuses anything else.

The migration is safe in a way worth stating: making a column nullable does not
touch existing rows, and Prisma will regenerate `vendorId: string | null`, so
**the TypeScript compiler enumerates every call site that assumed non-null**. The
work is bounded and discoverable rather than a hunt.

The pickup coordinate needs one indirection: `workers/dispatch.ts:181` reads
`order.branch.latitude` directly and must instead read through a single accessor
that returns the branch's coordinate for vendor orders and the pickup address's
for declutter orders. That is one function and one call site.

---

## 6. Concurrency and inventory invariants

Declutter items are singular. Everything here exists to stop one physical object
being sold twice.

### 6.1 The lock

`DeclutterListing.activeDealId String? @unique`.

A unique constraint on a nullable column is the whole mechanism: at most one deal
may hold a listing, enforced by the database, not by application logic that can
race. Reserving is `UPDATE … SET active_deal_id = $deal WHERE id = $listing AND
active_deal_id IS NULL`. The loser of a race updates zero rows and is told the
item is reserved.

Around it: agreement runs inside a transaction that takes `SELECT … FOR UPDATE`
on the listing row, so the availability check and the lock cannot be separated by
another transaction.

### 6.2 The invariants

1. A listing has **at most one deal** in `agreed`, `ready`, `self_pickup` or
   `dash_delivery` at any time.
2. A listing has **any number** of deals in `interested` or `in_contact`.
   Interest is free and non-exclusive.
3. `availability = 'sold'` is written **only** by deal completion.
4. A deal may reach `completed` **only** from `self_pickup` or `dash_delivery`.
   There is no path from `agreed` straight to `completed`, because that would
   mean an item changed hands with no recorded fulfilment.
5. An `Order` exists for a deal **only** in `self_pickup`, `dash_delivery` or
   `completed`. `Order.declutterDealId` is unique, so a deal can never
   materialise two orders.
6. Cancelling any deal holding the lock releases it in the same transaction.

### 6.3 The named cases from the brief

| Case | Behaviour |
| --- | --- |
| Two buyers express interest | Both succeed. Two `interested` deals. No lock taken. |
| Two buyers try to reserve simultaneously | Conditional update; one wins, one is told "just reserved". |
| Seller accepts one buyer | That deal → `agreed`, takes the lock. Others stay `interested` and are notified the item is reserved — **not** cancelled, because reservations expire. |
| Reservation expires | Worker clears `activeDealId`, deal → `cancelled(reason: expired)`, listing → `available`. Other interested buyers are notified it is available again. |
| Seller marks sold outside DASH | Listing → `sold` with `soldOffPlatform`. All open deals → `cancelled`. Requires the lock to be free or held by the deal being completed. |
| Buyer cancels before agreement | Deal → `cancelled`. No lock was held. Listing untouched. |
| Buyer cancels after reservation | Deal → `cancelled`, lock released, listing → `available`. |
| Delivery requested then cancelled | If no rider is assigned: cancel the order, deal returns to `ready`, buyer may re-choose. If a rider is assigned, the **existing** order cancellation policy governs — Declutter does not get its own rules for a rider already en route. |

### 6.4 Reservation expiry

`reservedUntil` on the deal, swept by a worker. Use the existing
`MaintenanceLease` pattern rather than a new scheduler. An expiring reservation
must be idempotent: two workers sweeping the same deal must produce one
cancellation, one lock release, one notification.

---

## 7. Moderation model

**Both, and the codebase already says so.** `Order` carries `status` on the row
*and* an append-only `OrderStatusEvent` log beside it. Moderation is the same
problem, so it takes the same shape:

- **`DeclutterListing.moderationStatus`** — current state, denormalised on the
  row. Required, because a public feed filters on it and you cannot filter a feed
  by walking a history table.
- **`DeclutterListingEvent`** — append-only history: who, when, from, to, reason
  code, note. Required, because "why was this rejected" and "who approved it"
  must survive the next edit, and because a moderation decision is exactly the
  kind of thing an ops audit asks about later.

Neither alone is sufficient. Deriving current state from history is slow and
invites disagreement; keeping only current state throws away the answer to every
dispute.

### 7.1 Material edits

Editing any of **title, description, price, photos, category, condition,
location** on an `approved` listing returns it to `pending_review`.

Not material, and therefore no re-review: marking sold, withdrawing, relisting an
unchanged listing, or the seller changing their own contact details, which are
account data rather than listing content.

### 7.2 The edit visibility problem

If an approved listing goes dark the moment its price is edited, sellers learn
not to edit, and the marketplace fills with stale prices — a worse outcome than
the risk being guarded against.

**Recommendation:** keep the approved content public while the edit is reviewed,
by versioning the listing content — an approved version the public reads and a
pending version only the seller and moderators see. On approval the pending
version is promoted; on rejection it is discarded and the live listing is
untouched.

This costs one concept. It is deferrable to V2 if V1 needs to be smaller, in
which case a material edit takes the listing out of the feed until re-approved
and the seller must be told that clearly *before* they save.

---

## 8. API changes

API-first, and the same endpoints must be able to serve the future
`declutter.dashworldng.com` storefront. That is why reads are anonymous-capable
and why nothing below assumes an app session.

### 8.1 New

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/declutter/listings` | Public feed. Filters: city, area, category, condition, price range, text. Cursor paginated. Returns approved + available/reserved only. |
| `GET` | `/v1/declutter/listings/:id` | Public. Reserved items visible, marked, not actionable. |
| `GET` | `/v1/declutter/taxonomy` | Categories, conditions, areas. Cacheable. Server-owned so areas can be added without a deploy. |
| `POST` | `/v1/declutter/listings` | Seller creates a draft. Idempotency key. |
| `PATCH` | `/v1/declutter/listings/:id` | Material edit → re-review (§7). |
| `POST` | `/v1/declutter/listings/:id/submit` | `draft`/`rejected` → `pending_review`. |
| `POST` | `/v1/declutter/listings/:id/withdraw` | Seller pulls it. |
| `POST` | `/v1/declutter/listings/:id/sold-elsewhere` | Off-platform sale. |
| `POST` | `/v1/declutter/photos/sign` | Signed direct upload. Image bytes never proxy through the API. |
| `POST` | `/v1/declutter/listings/:id/interest` | Creates a deal in `interested`. Rate limited. |
| `POST` | `/v1/declutter/deals/:id/acknowledge` | Seller → `in_contact`. **Must not dispatch anything.** |
| `POST` | `/v1/declutter/deals/:id/agree` | → `agreed`, takes the lock, sets `agreedPriceKobo`. |
| `POST` | `/v1/declutter/deals/:id/ready` | Seller confirms → `ready`. |
| `POST` | `/v1/declutter/deals/:id/fulfilment` | `{ choice: self_pickup \| dash_delivery }`. **The boundary — §5.** |
| `POST` | `/v1/declutter/deals/:id/complete` | Self-pickup handover. Delivery completes via the order. |
| `POST` | `/v1/declutter/deals/:id/cancel` | Either party, with reason. |
| `GET` | `/v1/declutter/me/listings` | Seller dashboard, by status. |
| `GET` | `/v1/declutter/me/deals` | Both sides. |
| `GET` | `/v1/admin/declutter/queue` | Moderation queue, oldest first. |
| `POST` | `/v1/admin/declutter/listings/:id/approve` | |
| `POST` | `/v1/admin/declutter/listings/:id/reject` | Mandatory reason code, optional note shown to the seller. |
| `POST` | `/v1/admin/declutter/listings/:id/suspend` | Takedown. |

### 8.2 Changed

- `GET /v1/orders/:id` and the tracking payload gain an optional
  `declutterDeal` reference so the tracking screen can link back.
- Order creation must reject a body carrying `declutterDealId`. Declutter orders
  are materialised server-side at the boundary and are never client-created.

### 8.3 Contract rules carried over unchanged

- Money is integer kobo everywhere, including `agreedPriceKobo`.
- Out-of-scope access returns **404, never 403** — a 403 confirms the record
  exists.
- The client may request a transition; it never sets `status` or `availability`
  directly.
- Every state-changing endpoint is idempotency-keyed.

---

## 9. Frontend surface map

Screens and the states each must render. No implementation, and no visual
redesign — but each is named so the redesign has a list.

| Surface | States it must express |
| --- | --- |
| Declutter browse | grid, filters (city/area/category/condition/price), empty, loading, reserved badge, sold badge |
| Listing detail | photo gallery 1–6, condition, area, price, seller block, Interested action, reserved (not actionable), sold, own-listing view |
| Seller profile | public listings, member since, partner badge where applicable |
| Interested / contact | pending acknowledgement, acknowledged, contact method revealed |
| Deal status (buyer) | interested, in contact, agreed, awaiting seller ready, choose fulfilment, in delivery, completed, cancelled |
| Deal status (seller) | new interest, acknowledged, agree terms, confirm ready, awaiting buyer choice, handover, completed |
| Fulfilment choice | the Self Pickup vs DASH Delivery decision, with the delivery quote shown before commitment |
| Seller ready confirmation | single decisive action; the precondition for everything downstream |
| Delivery handoff | reuses the **existing** tracking screen — this is the point of §5 |
| Completed / sold | receipt-style summary, review prompt |
| Post a listing | photos-first multi-step, draft save per step, submitted-for-review confirmation |
| Seller dashboard | live, pending review, rejected with reason, reserved, sold, drafts |
| Moderation console | queue, review with all photos, approve/reject with reason, edit diff |

Design-system notes, recorded now and implemented later: strong product
photography with a consistent aspect ratio and a stable placeholder so the grid
does not jump; Liquid Glass reserved for sheets, navigation and action bars, not
for cards; fluid transitions between deal states because the deal screen is
returned to repeatedly and should feel continuous. **Declutter must not read as a
restaurant menu with different nouns** — the unit is an item with a seller, not a
dish in a category.

---

## 10. Migration strategy

The existing Declutter vendor is proven rider-test infrastructure. It stays until
the replacement is proven, and the two coexist.

**Phase 1 — additive only.** New models, new tables, no changes to `Order`. Seed
gains declutter listings alongside the existing declutter vendor. Existing rider
tests, seed data and customer navigation are untouched. Nothing is removed.

**Phase 2 — the boundary.** `Order.vendorId`/`branchId` become nullable with the
check constraint; `pickupAddressId` and `declutterDealId` are added; the pickup
coordinate accessor replaces the direct `order.branch` read in the dispatch
worker. Vendor orders behave identically — this is the phase where the full gate
suite matters most, because it touches the hot path.

**Phase 3 — the deal path.** Deal lifecycle, fulfilment boundary, self-pickup.
The first end-to-end Declutter delivery runs through the real engine. The old
declutter vendor still works and is still the rider test fixture.

**Phase 4 — the new surfaces.** Browse, listing detail, post flow, dashboards,
moderation console read from `DeclutterListing`. The section page switches over.

**Phase 5 — retirement.** Once a Declutter deal has completed end to end through
both fulfilment choices, the seeded `dash-declutter-lagos` vendor is either
converted to a curated partner seller (`sellerVendorId` set) or removed. **Only
then** does `verticalOf('declutter')` stop needing its `preparing` placeholder,
and the `vocabulary.ts` comment that describes it as a placeholder is deleted
along with the placeholder.

What must eventually be replaced: `MenuItem` as the Declutter listing,
`MenuCategory` as its taxonomy, and `Cart`/checkout as the Declutter buying path.
What can remain indefinitely: the vendor model for **curated partner** sellers,
which is a genuine business relationship with commission and KYB, not a
workaround.

---

## 11. V1 versus later

**V1**
Listings with 1–6 photos, condition, category, area, asking price. Moderation
with approve/reject and reasons. Interest → contact → agree → reserve → ready.
Both fulfilment choices, with DASH Delivery through the existing engine. Exclusive
reservation with expiry. Seller dashboard, moderation console, browse, detail.

**Deferred, with the reason**
- **Versioned listing edits** (§7.2) — real improvement, not required to launch.
- **In-app messaging** — WhatsApp and phone already work, and a message store is a
  moderation surface of its own.
- **Payments and escrow for Declutter** — the open question below.
- **Ratings for private sellers** — reputation without volume is noise.
- **Video** — explicitly out per the brief.
- **Bidding / offers** — `agreedPriceKobo` is written once.
- **Saved searches and alerts** — the strongest reason for someone to install the
  app, so worth building deliberately rather than early.

**The open question this design does not settle:** does money move through DASH
for a Declutter deal, or do buyer and seller settle between themselves? The
design supports both — `Order` carries payments if there are any, and completes
without them if there are not — but the answer changes whether escrow, refunds
and dispute handling are V1 concerns. It needs deciding before Phase 3, not
before Phase 1.

---

## 12. Adversarial test cases

Grouped by the invariant each attacks. Assertions are on invariants, not on
HTTP 200.

**Exclusivity**
1. Two buyers `agree` on one listing concurrently → exactly one deal holds
   `activeDealId`; the other receives a conflict; the listing has exactly one
   reservation.
2. Buyer B agrees while buyer A's reservation is expiring in the same instant →
   no interleaving leaves the listing both `reserved` and unlocked.
3. Deal cancelled and re-agreed in rapid succession → `activeDealId` ends
   consistent with the deal's own state.
4. Two workers sweep the same expired reservation → one cancellation, one
   release, one notification.

**The dispatch boundary — the heart of the brief**
5. Seller acknowledges interest → **no `DispatchOffer` row exists, no outbox job
   is enqueued.** Asserted directly against both tables.
6. Deal reaches `ready` with `self_pickup` → an order exists with `mode: 'pickup'`
   and **no dispatch job**.
7. Deal reaches `ready` with `dash_delivery` → exactly one `dispatch.find_rider`
   job; the order is in `ready`; **the order was never in `preparing`** — asserted
   over the whole `OrderStatusEvent` history, not just current status.
8. The fulfilment endpoint called twice with the same idempotency key → one order,
   one dispatch job.
9. Fulfilment chosen on a deal not in `ready` → refused, no order.
10. A Declutter order is force-transitioned toward `preparing` → the state machine
    or a guard refuses it.

**Sold-once**
11. Deal completes → listing `sold`, `activeDealId` cleared, all other open deals
    on that listing closed.
12. Attempt to agree a new deal on a `sold` listing → refused.
13. Seller marks sold-elsewhere while a deal is in `dash_delivery` → refused, or
    resolved by an explicit ops path; never a silent double-sale.
14. Interest expressed on a `sold` listing → refused.

**Moderation**
15. Material edit to an approved listing → `pending_review`, and a
    `DeclutterListingEvent` records it.
16. Non-material change (mark sold) → moderation status unchanged.
17. Rejected listing is not in the public feed and returns 404 to a stranger by
    id — **not 403.**
18. A seller reading another seller's draft → 404.

**Order-model integrity**
19. Insert an order with neither vendor nor deal → check constraint rejects it.
20. Insert an order with both → rejected.
21. Two orders referencing one deal → unique constraint rejects the second.
22. Every existing vendor-order test still passes with the nullable columns —
    the regression gate for Phase 2.

**Money**
23. Prices round-trip as integer kobo through listing, deal and order with no
    float arithmetic anywhere in the path.
24. `agreedPriceKobo` differing from `askingPriceKobo` is preserved exactly on
    the order and the receipt.

**Cancellation**
25. Buyer cancels pre-agreement → no lock was held, listing untouched.
26. Buyer cancels post-reservation → lock released, listing `available`.
27. Delivery cancelled before rider assignment → deal returns to `ready`, buyer
    may re-choose.
28. Delivery cancelled after rider assignment → the existing order cancellation
    policy applies unchanged; Declutter introduces no special case for a rider
    already carrying goods.

---

## Appendix — what this document changes about `vocabulary.ts`

`vocabulary.ts` currently maps Declutter's `preparing` to "Processing your order"
and says in a comment that this is a placeholder because the real lifecycle does
not exist.

Under this design, **a Declutter order never enters `preparing`**, so the
placeholder becomes unreachable rather than merely unsatisfying. At Phase 5 the
Declutter entries in `PREPARING`, `TIMELINE_PREPARING` and
`vendorStartActionLabel` should be removed, and the Declutter customer timeline
replaced with one describing the deal: *interested → agreed → ready → on the way
/ ready to collect → completed*. That timeline is a property of the deal, not the
order, and belongs beside it.
