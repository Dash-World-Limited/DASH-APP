# DASH APP

An on-demand delivery platform for Nigeria — food, groceries, pharmacy,
essentials, and package delivery — built as a multi-sided marketplace serving
customers, riders, vendors, operations, support, and finance.

Original product and implementation. Not derived from any existing platform's
code, assets, or copy.

> **Status: `v0.1.0-mvp` — a working local MVP.**
>
> A complete order runs end to end: browse → customise → sign in → pay (mock
> adapter) → vendor accepts → dispatch offers a rider → PIN handover → delivered
> → rider paid → ledger balanced.
>
> **No integration has been tested against a live service** and nothing has been
> deployed. CI, cookie-based authentication, and CSRF protection have landed
> since the tag. [`HANDOFF.md`](HANDOFF.md) and
> [`docs/PROGRESS.md`](docs/PROGRESS.md) are the honest account of what works and
> what does not — read one of them before assuming any capability exists.

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

Installs, creates the database, and seeds a fictional Lagos. Then:

```bash
npm run dev
```

Web on http://127.0.0.1:3000, API on http://127.0.0.1:4000. Sign-in details for
every seeded role are in [`HANDOFF.md`](HANDOFF.md#seed-accounts) — all accounts
are fictional.

## Repository layout

```
dash-app/
├── apps/
│   ├── api/             # Fastify API — 51 endpoints, auth, dispatch worker
│   └── web/             # Next.js — customer, vendor, rider, ops surfaces
├── packages/
│   ├── db/              # Prisma schema (46 models), seed, ledger posting
│   └── domain/          # Pure business core — no I/O, no framework, no clock
│       └── src/
│           ├── money/         Branded integer kobo, exact percentage math
│           ├── geo/           Distance, serviceability, GPS validation
│           ├── crypto/        scrypt hashing, CSPRNG codes and tokens
│           ├── permissions/   Roles, permissions, step-up, object-level scope
│           ├── orders/        Order state machine and cancellation policy
│           ├── pricing/       Explained quotes, surge, discounts, settlement
│           ├── pay/           Rider pay: distance, waiting, vehicle, surge share
│           ├── dispatch/      Rider scoring and offer rounds
│           ├── ledger/        Double-entry, append-only money ledger
│           └── ports/         Adapter interfaces for every external service
├── scripts/             # dev runner, smoke test, dispatch check
└── docs/                # Decisions and the running progress log
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
| **Pricing, dispatch, and pay are deterministic and explained** | Every quote, assignment, and payment records the rule version and each factor that contributed, so it can be reconstructed and defended months later. |
| **No AI/ML claims without a trained model** | These are rules engines. They record the inputs and outcomes a model would need, and say so plainly. |
| **An adapter is not an integration** | Payments, maps, SMS, and storage are interfaces with offline implementations. Nothing is described as working until it has been run against a real sandbox. |

## Money, specifically

`₦1,500.00` is stored as the integer `150000`. Every monetary value carries a
branded `Kobo` type:

```ts
import { naira, percentOf, formatNaira } from '@dash/domain/money';

const basket = naira(5000);                 // 500000 kobo
const commission = percentOf(basket, 1800); // 18%, exact integer arithmetic
formatNaira(commission);                    // "₦900.00"
```

Commission rates are basis points (`1800` = 18%), not floats, because they are
configured by humans in an admin UI and stored in a database, and an integer
cannot drift.

## Testing

```bash
npm test                          # 502 tests (299 domain + 203 API)
npx vitest run --coverage packages/domain

npm run dev:api                   # then, in a second terminal:
node scripts/smoke.mjs            # 48 checks — journey + authorization probes
node scripts/dispatch-check.mjs   # 20 checks — dispatch through PIN delivery
```

~94% statement coverage on the domain core, with thresholds enforced in
`vitest.config.ts` so a regression fails rather than quietly eroding. The API
integration tests need no running server — they drive a real Fastify instance
with `inject()` against a temporary SQLite file.

The suite is deliberately adversarial in the places that matter — cross-tenant
access sweeps, self-promotion attempts, GPS spoofing, price tampering, discount
stacking, promo codes gamed to dodge fees, replayed webhooks, and
money-conservation checks across randomised orders.

The two script suites need a running API and a seeded database, and are not part
of the CI gate. Everything `npm test` runs is.

## Documentation

| File | Contents |
|---|---|
| [`HANDOFF.md`](HANDOFF.md) | **Start here.** Commands, seed accounts, mocks, limitations |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How it fits together and why |
| [`SECURITY.md`](SECURITY.md) | Threat model, implemented controls, open gaps |
| [`ROADMAP.md`](ROADMAP.md) | What is next, in order, and what is deliberately not |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Every architecture choice, its cost, its reversal path |
| [`docs/API_MATRIX.md`](docs/API_MATRIX.md) | Every business endpoint: permission, ownership rule, transition, coverage |
| [`docs/PROGRESS.md`](docs/PROGRESS.md) | What works, what is stubbed, seventeen bugs found and fixed |

## Licence and legal

Nigerian data-protection (NDPA 2023) and consumer-law obligations have not been
reviewed by qualified counsel. No document in this repository is legal advice.
