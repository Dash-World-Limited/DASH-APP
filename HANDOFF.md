# Handoff — `v0.1.0-mvp`

Everything needed to pick this up cold. Read this first, then
[`ARCHITECTURE.md`](ARCHITECTURE.md), then
[`docs/DECISIONS.md`](docs/DECISIONS.md).

---

## Milestone reference

| | |
|---|---|
| **Tag** | `v0.1.0-mvp` |
| **Commit** | `6d536234828ac4f362764a79f8a6488ca305fa3d` (short: `6d53623`) |
| **Date** | 2026-08-30 |
| **Branch** | `main` |
| **Scope** | Local MVP. Complete order lifecycle, no external integration, never deployed. |

> The hash is recorded here by the commit *after* the tag — a commit cannot
> contain its own hash. The tag points at `6d53623`; this line just saves you
> the lookup.

```bash
git show v0.1.0-mvp --stat | head -30   # what the milestone contains
git rev-parse v0.1.0-mvp                # exact commit hash
```

---

## Requirements

- Node.js 22+ (built and tested on **24.19.0**)
- npm 10+ (built on **11.17.0**)

That is the whole list. No Docker, no pnpm, no local PostgreSQL — see ADR-0003
for why local development uses SQLite and what the path to PostgreSQL + PostGIS
looks like.

---

## Commands

### First run

```bash
npm run setup
```

Installs, generates the Prisma client, creates the SQLite database, and seeds a
fictional Lagos. Equivalent to:

```bash
npm install
npm run db:generate
npm run db:push
npm run db:seed
```

If `npm install` warns about unapproved install scripts, approve the three that
are needed — Prisma downloads its query engine in a postinstall step:

```bash
npm approve-scripts prisma @prisma/client @prisma/engines esbuild
```

### Environment

```bash
cp .env.example .env
```

Then generate two **different** secrets — the API refuses to start if they match,
because a shared secret would let a refresh token verify as an access token:

```bash
node -e "console.log('JWT_ACCESS_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log('JWT_REFRESH_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))"
```

### Daily

| Command | What it does |
|---|---|
| `npm run dev` | API on `:4000` and web on `:3000`, prefixed output, Ctrl-C stops both |
| `npm run dev:api` | API only |
| `npm run dev:web` | Web only |
| `npm test` | 268 unit tests |
| `npm run lint` | ESLint across all workspaces |
| `npm run typecheck` | `tsc --build` across project references |
| `npm run db:seed` | Wipe and reseed (safe to re-run; refuses in production) |
| `npm run db:studio` | Prisma Studio |
| `npm run build` | Production build of every workspace |

### Verification

```bash
npm test                          # 268 unit tests
npx vitest run --coverage packages/domain
npm run dev:api                   # then, in a second terminal:
node scripts/smoke.mjs            # 48 checks — journey + authorization probes
node scripts/dispatch-check.mjs   # 20 checks — dispatch loop through PIN delivery
```

Both scripts need a **running API and a seeded database**. They are not
automated tests and are not wired into CI — that is Phase 1 work.

### Stopping a stuck server (Windows)

`pkill` does not work here. Kill by port:

```powershell
Get-NetTCPConnection -LocalPort 4000 -State Listen | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }
```

---

## Test totals at this tag

| Suite | Count | Result | Needs |
|---|---|---|---|
| Unit (`npm test`) | 268 across 8 files | all passing | nothing |
| Smoke (`scripts/smoke.mjs`) | 48 checks | all passing | running API + seed |
| Dispatch (`scripts/dispatch-check.mjs`) | 20 checks | all passing | running API + seed |

**Domain coverage:** 93.98% statements · 94.77% branches · 94.25% functions.
Thresholds enforced in `vitest.config.ts` at 80/75/80/80.

Lint clean. Typecheck clean across all four workspaces. Web production build
succeeds (11 routes, ~113 kB first load).

---

## Seed accounts

**Every account below is fictional.** Phone numbers use a reserved-style
`+234 700` block that cannot ring a real handset. No real person's details, and
no real business's catalogue or branding, appear anywhere in this repository.

Staff and vendors sign in with a password. Customers and riders sign in with an
OTP, which in development is printed to the API console **and** returned in the
response body as `devCode` while `DEV_EXPOSE_OTP=true`. Production refuses to
boot with that flag set.

### Password accounts — all use `DashDev!2026`

| Role | Email |
|---|---|
| Super admin | `admin@dashapp.test` |
| Dispatcher (Lagos) | `ops@dashapp.test` |
| Support agent | `support@dashapp.test` |
| Finance analyst | `finance@dashapp.test` |
| City manager (Lagos) | `city@dashapp.test` |
| Vendor owner | `iya-kemi-kitchen@dashapp.test` |
| Vendor owner | `suya-republic@dashapp.test` |
| Vendor owner | `freshcart-grocers@dashapp.test` |
| Vendor owner | `carewell-pharmacy@dashapp.test` |

### OTP accounts

| Role | Phone | Notes |
|---|---|---|
| Customer — Amaka Okoye | `+2347000000201` | Has an active **Dash+** membership (free delivery, half service fee, surge-exempt) |
| Customer — Segun Adeyemi | `+2347000000202` | |
| Customer — Fatima Bello | `+2347000000203` | |
| Rider — Musa Ibrahim | `+2347000000301` | Motorcycle, **Victoria Island zone only** |
| Rider — Grace Eze | `+2347000000302` | Motorcycle, Lekki Phase 1 |
| Rider — Kunle Balogun | `+2347000000303` | Bicycle, **Yaba/Surulere** — use this one for Iya Kemi Kitchen orders |
| Rider — Peter Obi-Nwosu | `+2347000000304` | Car, Ikeja, starts offline |

> **Gotcha that will cost you an hour.** Each seeded rider is permitted in
> exactly one zone. A rider who is online and nearby but not zone-permitted for
> the vendor is correctly refused the offer and dispatch escalates. The worker
> logs `exclusionsByReason` — read it before assuming the engine is broken.

### Seeded world

1 city (Lagos) · 4 zones (Victoria Island & Ikoyi, Lekki Phase 1, Ikeja &
Maryland, Yaba & Surulere) · 4 fictional vendors · 20 catalogue items ·
3 customers · 4 riders · 5 orders across the lifecycle · 3 promotions
(`DASH10`, `FREERIDE`, `KITCHEN500`) · 5 feature flags · a balanced ledger.

The seed verifies every ledger transaction balances before it reports success.

---

## Mock integrations — nothing here talks to a real service

| Port | Default | Config value | Production target | Ever tested live? |
|---|---|---|---|---|
| Payments | Deterministic mock | `PAYMENT_PROVIDER=mock` | Paystack | **No** |
| Maps / routing | Haversine + detour factor | `MAPS_PROVIDER=local` | Google / Mapbox / PostGIS | **No** |
| SMS | Logs to console | `SMS_PROVIDER=console` | Termii / Twilio | **No** |
| Email | Logs to console | `EMAIL_PROVIDER=console` | SMTP | **No** |
| Push | Logs to console | `PUSH_PROVIDER=console` | FCM / APNs | **No** |
| Storage | `./.storage` on disk | `STORAGE_PROVIDER=local` | S3 / MinIO | **No** |
| Queue | In-process, retries + backoff | `QUEUE_PROVIDER=memory` | Redis + BullMQ | **No** |

The API prints its adapter line at boot:

```
DASH APP API on http://127.0.0.1:4000  [payments=mock  maps=local  sms=console  storage=local  queue=memory]
Payments are MOCKED. No real money moves in this configuration.
```

If that banner says `payments=mock`, **no card has ever been charged.** Do not
describe any of these as working until it has run against a real sandbox with a
signature test, an idempotency test, and a failure-path test.

The mock payment adapter is deterministic and driven by the order reference: a
reference containing `fail` declines, one containing `pending` stays unresolved,
everything else captures. It verifies webhook signatures too — a check that only
runs in production is a check that has never been tested.

---

## Architectural decisions in force

Full reasoning, costs, and reversal paths in
[`docs/DECISIONS.md`](docs/DECISIONS.md). Summary:

| ADR | Decision | Why | Reversible? |
|---|---|---|---|
| 0001 | npm workspaces, not pnpm + Turborepo | pnpm not installed; npm 11 workspaces suffice at this size | Easily — additive |
| 0002 | Fastify + Zod, not NestJS | ~4× denser routes; Zod schemas shared with the web app and tests; domain logic is framework-free so DI has little to manage | Costly — one-way-ish door |
| 0003 | SQLite dev, PostgreSQL + PostGIS production | No Docker or Postgres on the target machine; `npm run setup` works on a clean machine | Yes — schema written for it |
| 0004 | One Next.js app with route groups, not five apps | One dev server, one auth client; route groups give real layout separation | Yes — mechanical |
| 0005 | Adapter ports for every external dependency | Whole platform runs offline; honesty is structural | n/a |
| 0006 | Integer kobo, append-only double-entry ledger | Float money and mutable balances are the hardest defects to recover from | No — foundational |
| 0007 | Deterministic, explainable pricing/dispatch/pay | No trained model exists; records the features one would need | n/a |

### Rules a contributor must not break

1. **Money is integer kobo.** No floats, no `Decimal`, no currency math in the
   database.
2. **No mutable balance columns.** Balances are summed from `LedgerEntry`.
   Corrections are reversing transactions.
3. **The client never sends a price, role, or permission.** All derived
   server-side.
4. **Permission and ownership are separate checks.** Both must pass. Cross-tenant
   denial returns 404, never 403.
5. **`packages/domain` has no I/O.** No database, no network, no ambient clock.
6. **An adapter is not an integration.** Nothing is described as working until a
   sandbox test proves it.

---

## Known limitations at this tag

Full list in [`docs/PROGRESS.md`](docs/PROGRESS.md#known-limitations-honest-list).
The ones that will bite first:

### Blocking production
- **Refresh token is in `sessionStorage`, not an httpOnly cookie.** Readable by
  any script on the origin. The biggest weakness in the system. *Next milestone.*
- **No CSRF protection.** Not exploitable today (pure Bearer auth, no cookie
  session) but mandatory the moment cookies land.
- **No CI.** Nothing prevents a regression reaching `main`.
- **No automated API integration tests.** The script suites cannot gate a merge.

### Operational
- **In-memory queue loses jobs on restart.** A second API instance would run its
  own dispatch worker and double-offer, so this blocks horizontal scale.
  Correctly rejected in production by config.
- **SQLite is dev-only.** No concurrent writers, no PostGIS. The geo path tests a
  city's zones in process — fine at Lagos scale (tens), not national.
- **No websockets.** Tracking, the vendor queue, and the ops board poll.
- **Rider pay is estimated at reservation.** No rider exists when payment is
  captured, so the reservation assumes a motorcycle and a zero approach leg. The
  true-up on delivery corrects it, but the reserved figure is an estimate.

### Modelled but not built
Admin MFA (TOTP), vendor/rider onboarding flows, catalogue management UI, support
agent workspace, finance settlement console, ratings write path, account deletion
and export, batched dispatch, scheduled orders, package delivery, events
ticketing.

### Legal
Nigerian data-protection (NDPA 2023) and consumer-law obligations have **not**
been reviewed by counsel. No document in this repository is legal advice.

---

## Where to look

| I want to… | Go to |
|---|---|
| Understand the shape | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Know why something is the way it is | [`docs/DECISIONS.md`](docs/DECISIONS.md) |
| See what works vs. what is stubbed | [`docs/PROGRESS.md`](docs/PROGRESS.md) |
| Understand the security posture | [`SECURITY.md`](SECURITY.md) |
| Know what is next | [`ROADMAP.md`](ROADMAP.md) |
| Change pricing | `packages/domain/src/pricing/` — bump `PRICING_RULE_VERSION` |
| Change rider pay | `packages/domain/src/pay/` — bump `RIDER_PAY_RULE_VERSION` |
| Change dispatch scoring | `packages/domain/src/dispatch/` — bump `DISPATCH_RULE_VERSION` |
| Add a permission | `packages/domain/src/permissions/` — add to `PERMISSIONS`, then a role |
| Add an endpoint | `apps/api/src/routes/` — guard with `requirePermission`, scope with `requireScope` |
| Add a screen | `apps/web/src/app/` |

### Ten bugs found while building

Documented with cause and fix in
[`docs/PROGRESS.md`](docs/PROGRESS.md#bugs-found-and-fixed-while-building).
Worth reading before changing money code — two of them were caught only because
the double-entry ledger refused to write, and one only by a randomised property
test.
