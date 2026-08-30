# DASH APP

An on-demand delivery platform for Nigeria — food, groceries, pharmacy,
essentials, and package delivery — built as a multi-sided marketplace serving
customers, riders, vendors, operations, support, and finance.

Original product and implementation. Not derived from any existing platform's
code, assets, or copy.

> **Status: working, incomplete.** You can browse, order, pay (through a mock
> adapter), and watch a vendor accept it — end to end, in a browser. Dispatch
> does not yet reach a rider, no external integration has been tested against a
> live service, and there is no CI. `docs/PROGRESS.md` is the honest account of
> what works, what is stubbed, and what has not been started — read it before
> assuming any capability exists.

---

## Requirements

- Node.js 22 or newer (built and tested on 24.19)
- npm 10 or newer

That is the whole list. No Docker, no pnpm, no local PostgreSQL — see
[ADR-0003](docs/DECISIONS.md) for why local development uses SQLite and what the
production path to PostgreSQL + PostGIS looks like.

## Getting started

```bash
npm run setup
```

That installs, creates the database, and seeds a fictional Lagos. Then:

```bash
npm run dev
```

The web app is on http://127.0.0.1:3000 and the API on http://127.0.0.1:4000.
Sign-in details for every seeded role are in `docs/PROGRESS.md`.

## Repository layout

```
dash-app/
├── apps/
│   ├── api/             # Fastify API — auth, ordering, dispatch, finance
│   └── web/             # Next.js — customer, vendor, rider, ops surfaces
├── packages/
│   ├── db/              # Prisma schema, seed, ledger posting
│   └── domain/          # Pure business core — no I/O, no framework, no clock
│       └── src/
│           ├── money/         Branded integer kobo, exact percentage math
│           ├── geo/           Distance, serviceability, GPS validation
│           ├── permissions/   Roles, permissions, step-up, object-level scope
│           ├── orders/        Order state machine and cancellation policy
│           ├── pricing/       Explained quotes, surge, discounts, settlement
│           ├── dispatch/      Rider scoring and offer rounds
│           ├── ledger/        Double-entry, append-only money ledger
│           └── ports/         Adapter interfaces for every external service
└── docs/                # Decisions, progress, and the honest limitations list
```

## The rules this codebase is built on

These are not style preferences. Each one prevents a specific class of failure
that is expensive to recover from once real money and real riders are involved.

| Rule | Why |
|---|---|
| **Money is integer kobo, never a float** | `0.1 + 0.2 !== 0.3`. A branded `Kobo` type means a raw `number` cannot become a price by accident. |
| **No mutable balance columns** | Balances are derived by summing an append-only double-entry ledger. A transaction that does not sum to zero is rejected before it is written, so a bug cannot create or destroy money. |
| **Every client is untrusted** | Role, price, fee, discount, order state, vendor id, rider id, coordinates, and balance are all derived server-side. A request body claiming `role: super_admin` changes nothing. |
| **Permission ≠ ownership** | "May you accept vendor orders?" and "is this order yours?" are separate checks, and both must pass. A cross-tenant probe returns *Not found*, never *Forbidden* — a 403 confirms the record exists. |
| **Pricing and dispatch are deterministic and explained** | Every quote and every assignment records the rule version and each factor that contributed, so it can be reconstructed and defended months later. |
| **No AI/ML claims without a trained model** | These are rules engines. They record the inputs and outcomes a model would need, and say so plainly. |
| **An adapter is not an integration** | Payments, maps, SMS, and storage are interfaces with offline implementations. Nothing is described as working until it has been run against a real sandbox. |

## Money, specifically

`₦1,500.00` is stored as the integer `150000`. Every monetary value carries a
branded `Kobo` type:

```ts
import { naira, percentOf, formatNaira } from '@dash/domain/money';

const basket = naira(5000);              // 500000 kobo
const commission = percentOf(basket, 1800); // 18%, exact integer arithmetic
formatNaira(commission);                 // "₦900.00"
```

Commission rates are basis points (`1800` = 18%), not floats, because they are
configured by humans in an admin UI and stored in a database, and an integer
cannot drift.

## Testing

```bash
npm test                 # 249 unit tests
npx vitest run --coverage packages/domain
node scripts/smoke.mjs   # 48 end-to-end checks against a running API
```

~97% statement coverage on the domain core, with thresholds enforced in
`vitest.config.ts` so a regression fails rather than quietly eroding.

The suite is deliberately adversarial in the places that matter — cross-tenant
access sweeps, self-promotion attempts, GPS spoofing, discount stacking, promo
codes gamed to dodge fees, and money-conservation checks across randomised
orders.

`scripts/smoke.mjs` needs a running API and a seeded database. It places a real
order and probes the authorization boundaries, including price tampering,
cross-tenant reads, step-up enforcement, and unsigned webhooks.

## Documentation

| File | Contents |
|---|---|
| [`docs/PROGRESS.md`](docs/PROGRESS.md) | What works, what is stubbed, what is not started, bugs found |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Every significant architecture choice, its cost, and how to reverse it |

## Licence and legal

Nigeria data-protection and consumer-law obligations have not been reviewed by
qualified counsel. No document in this repository is legal advice.
