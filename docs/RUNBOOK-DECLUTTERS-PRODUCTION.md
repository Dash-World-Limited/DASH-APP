# DASH World Declutters — production runbook

**Status: nothing has been deployed. No AWS resource has been created by this
repository, no DNS record has been changed, and the PostgreSQL migration history
has never been applied to a real PostgreSQL server.**

This is the sequence, the exact environment, how to tell it is working, and how
to undo it. It is written to be followed once, slowly, with the site behind a
signup gate until SES production access lands.

---

## 0. What is being deployed

| Piece | What it is | Needs |
|---|---|---|
| **API** (`apps/api`) | Fastify. Marketplace endpoints, admin endpoints, photograph serving, signup, bounce webhook. | Node 22+, PostgreSQL, S3, SES |
| **Web** (`apps/web`) | Next.js 15. Serves `/declutter/*` plus the existing DASH APP routes. | Node 22+, the API |
| **dashworldng.com** | The existing static marketing site. Already deployed; gains two link changes. | Unchanged hosting |

Target: **`declutters.dashworldng.com`**, with the API on its own host under the
same registrable domain.

**Decided 10 September 2026:** everything runs in **eu-west-1 (Ireland)**, where
the SES identity `notify.dashworldng.com` is verified.

| Piece | Where |
|---|---|
| API and web Node processes, Redis | **Lightsail** instance |
| PostgreSQL | **Amazon RDS**, Single-AZ, encrypted |
| Object storage | **S3** — `dash-declutters-prod-media`, private |
| Transactional email | **SES** — `notify.dashworldng.com` |

Lightsail for the compute because this is one marketplace at launch volume: a
flat monthly price and no VPC or security-group work to get wrong. Redis lives
on the same instance, since Lightsail has no managed Redis and production
refuses per-process rate limits.

**The database is RDS rather than Lightsail's managed PostgreSQL, for two
reasons.** The cheapest Lightsail managed tier does not encrypt data at rest,
and this database holds government identity evidence for every verified seller —
application-level envelope encryption protects the identity numbers, but the
storage underneath them should be encrypted too. And PostGIS support on Lightsail
managed databases is not documented clearly enough to depend on, while on RDS it
is a supported extension. The API's production guards require
`GEO_ZONES_PROVIDER=postgis` for DASH APP's delivery zones, so a database that
cannot install PostGIS cannot run this service at all — even though Declutters
itself uses no geography.

Lightsail and RDS reach each other over **Lightsail VPC peering**, which joins
the Lightsail VPC to the region's default VPC. The database is therefore never
publicly accessible: nothing reaches it from the internet, and migrations run
from the Lightsail instance rather than from a laptop.

> **The API and the web must be same-site.** The API sends
> `Cross-Origin-Resource-Policy: same-site`, so item photographs are blocked if
> the two are on unrelated domains. `declutters.dashworldng.com` +
> `api.dashworldng.com` is fine. This was hit in development and is not
> theoretical.

---

## 1. Environment — API

### The deployment profile — set this first

| Variable | Value |
|---|---|
| `DEPLOYMENT_PROFILE` | `declutters` |

This is the variable that makes a marketplace-only deployment possible, and it
must be set deliberately. It defaults to `full`, so a deployment that forgets it
gets DASH APP's complete set of production guards rather than the relaxed ones.

A profile is a set of **capabilities**. `apps/api/src/deployment/profile.ts` owns
the table:

| Capability | `full` | `declutters` | What is switched off means |
|---|---|---|---|
| `email` | on | **on** | SES. Required, live, guarded |
| `storage` | on | **on** | S3. Required, live, guarded |
| `payments` | on | off | `DisabledPaymentAdapter` throws on every call. `POST /v1/webhooks/paystack` is not registered |
| `delivery` | on | off | Catalogue, orders, vendor and rider routes are not registered |
| `sms` | on | off | `DisabledSmsAdapter` throws. Declutters authenticates by email code |
| `push` | on | off | `DisabledPushAdapter` throws. `POST /v1/devices` is not registered |
| `maps` | on | off | Routing and geocoding throw. Zone containment still works, because PostGIS answers it from the database |
| `realtime` | on | off | No WebSocket is served. Every topic the protocol accepts is an order, vendor, rider or city — all delivery |
| `dataExport` | on | off | `/v1/account/export*` is not registered. Deletion stays available |

**Switched off means unreachable, not mocked.** A disabled capability gets an
adapter whose every method throws `CapabilityDisabledError`, and its routes are
never registered, so they answer `404`. That distinction is the whole point: the
reason production refuses `PAYMENT_PROVIDER=mock` is that a mock reports a
successful charge and settles nothing. Relaxing the guard while leaving the mock
wired would have reproduced exactly the failure the guard existed to prevent.
Refusing to answer at all cannot be mistaken for success.

What stays strict on `declutters`: PostgreSQL (no SQLite), PostGIS, Redis-backed
rate limiting, a durable queue, S3, SES, and every secret-strength check. The
five guards that no longer apply — payments, maps, SMS, push and realtime fan-out
— are the five whose subject does not exist on this deployment.

**Nothing about realtime needs to be set.** `REALTIME_ENABLED` defaults to on and
`REALTIME_BROADCAST` defaults to in-memory, which production refuses — so before
realtime was a capability, following this runbook exactly got you refused at boot
over a variable it never mentioned. Setting `REALTIME_ENABLED=true` is not a way
round it either: the socket closes immediately with the "disabled" code whatever
the flag says.

What this does **not** change: the `full` profile. Every guard there behaves
exactly as it did before, and `apps/api/src/__tests__/deployment-profile.test.ts`
asserts that a `full` production boot still refuses all four.

### Required, always

| Variable | Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Turns on every boot guard below |
| `DATABASE_URL` | `postgresql://…` | RDS PostgreSQL 16, PostGIS installed, private endpoint |
| `API_PORT` | e.g. `4000` | |
| `PUBLIC_WEB_URL` | `https://declutters.dashworldng.com` | CORS allowlist. A wrong value blocks every browser call |
| `JWT_ACCESS_SECRET` | 32+ random bytes | Boot refuses a development value, and refuses it if it equals the refresh secret |
| `JWT_REFRESH_SECRET` | 32+ random bytes | Must differ from `JWT_ACCESS_SECRET` |
| `ENCRYPTION_KEY` | base64 or hex 32 bytes | KYC envelope encryption. See `docs/` key custody. `ENCRYPTION_KEY_ID` defaults to `k1`; `ENCRYPTION_KEYS_RETIRED` only during a rotation |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis on the same Lightsail instance |
| `RATE_LIMIT_ENABLED` | `true` | Production refuses `false` |
| `RATE_LIMIT_REDIS` | `true` | Production refuses per-process counters: they multiply the real limit by the instance count |
| `QUEUE_PROVIDER` | `redis` | Production refuses `memory` — it loses jobs on restart |
| `GEO_ZONES_PROVIDER` | `postgis` | Required in production even here. Declutters never asks a geography question, but the guard is DASH APP's and PostGIS must be installed for boot to pass |
| `VALUECHECK_PROVIDER` | `local` | The only value. No live AI provider is connected — which is why no listing may be publicly labelled *DASH ValueChecked* |

### Storage — required

| Variable | Value |
|---|---|
| `STORAGE_PROVIDER` | `s3` |
| `S3_BUCKET` | `dash-declutters-prod-media` |
| `S3_REGION` | `eu-west-1` |
| `S3_ENDPOINT` | *only* for a non-AWS S3-compatible provider |
| `S3_FORCE_PATH_STYLE` | `true` only for those providers |

Production refuses to start on `STORAGE_PROVIDER=local`, and refuses `s3`
without a bucket and region.

### Email — required

| Variable | Value |
|---|---|
| `EMAIL_PROVIDER` | `ses` |
| `SES_REGION` | `eu-west-1` |
| `EMAIL_FROM_ADDRESS` | `no-reply@notify.dashworldng.com` |
| `EMAIL_FROM_NAME` | `DASH World` |
| `EMAIL_REPLY_TO` | `admin@dashworldng.com` — **must be monitored** |
| `SES_CONFIGURATION_SET` | e.g. `dash-transactional` |
| `SES_EVENT_TOPIC_ARN` | the SNS topic bounce/complaint notifications arrive on |

Production refuses `console`. There is no silent fallback: an unknown provider
is a startup failure.

### The gate — set until SES production access is granted

| Variable | Value |
|---|---|
| `SIGNUP_ALLOWLIST` | the addresses verified in the SES console, comma-separated |

Inside the sandbox SES delivers only to individually verified addresses and
silently drops the rest. Without this, signup accepts anybody, creates their
account, and sends a code that never arrives — leaving them stuck with an
account they can never open and no way to know why. **Clear it only after
production access is granted.**

### Credentials

The AWS SDK resolves these itself. Prefer an instance role and set nothing. If
that is impossible, set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. Note
that `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` are **never read** — they are
classified only so an audit notices them.

---

## 2. Environment — Web

| Variable | Value | Notes |
|---|---|---|
| `DEPLOYMENT_PROFILE` | `declutters` | Read by `apps/web/src/middleware.ts` **at runtime**, unlike the three below |
| `NEXT_PUBLIC_API_URL` | `https://api.dashworldng.com` | **Read at build time.** Changing it needs a rebuild |
| `NEXT_PUBLIC_SITE_ORIGIN` | `https://declutters.dashworldng.com` | Canonicals, Open Graph, sitemap |
| `NEXT_PUBLIC_DECLUTTER_INDEXABLE` | `false` | **Leave false.** See §7 |

**The three `NEXT_PUBLIC_*` variables are read when `next build` runs**, not when
the process starts: Next inlines them into the bundle, so setting them only in the
supervisor has no effect and changing one means rebuilding.

`DEPLOYMENT_PROFILE` is the exception, and it was worth checking rather than
assuming. The compiled middleware keeps the `process.env` reference and reads it
when the process starts, which was confirmed by starting one build artifact twice:
with the variable `/vendor` answers 404, without it 200. So the profile is a
supervisor setting and needs no rebuild — though setting it in both places is
harmless and keeps the two halves of the deployment described the same way.

### What the web profile removes

One Next application holds both products. Without a boundary the marketplace host
would also serve DASH APP's customer shell, vendor console, rider app and
dispatch board — pages that would render and then fail against an API that no
longer has those endpoints, so a visitor would see a *broken* DASH APP rather
than no DASH APP. The landing page is worse: it is a development surface that
lists every internal console by name.

With `DEPLOYMENT_PROFILE=declutters` the deployment serves exactly:

| Path | Why |
|---|---|
| `/declutter/**` | The marketplace, including its own sign-in, verification, terms and privacy |
| `/ops/declutter/**` | The team's console: seller verification, submission queue, pricing. Without it nobody can approve a listing, so there would be nothing to show |
| `/signin` | How a staff member authenticates for that console. `/declutter/signin` is the customer's email-code flow, which is a different thing |
| `/_next/**`, `/robots.txt`, `/sitemap.xml`, `/favicon.ico` | Assets and fixed root files. Blocking `/_next` serves unstyled HTML |

Everything else answers `404` with `X-Robots-Tag: noindex` and one line pointing
at `/declutter`. `/` redirects to `/declutter` for **any** hostname, because the
`next.config.mjs` redirect is scoped to the public name — reaching the instance
by its Lightsail DNS name would otherwise serve the landing page.

Note that `/ops` itself — the dispatch board and the money ledger — is **not**
served, while `/ops/declutter` beneath it is.

> This is a deployment boundary, not a security boundary. Every one of those
> pages already requires a session and a server-side permission check, and the
> API enforces both. What it removes is surface that cannot work here, and the
> leak of advertising the internal consoles on a public marketplace domain.

---

## 3. Database

```bash
npm run db:pg:migrate          # prisma migrate deploy
npm run db:pg:migrate:status   # must report no pending migrations
```

Then the reference data, all idempotent and safe to re-run:

- `seedDeclutterTaxonomy` — 23 locations, 10 categories including Cars &
  Vehicles. Upserts on the natural key; never touches an id a listing points at.
- `seedLegalDocuments` — Terms and Privacy at version `2026-09-09`. Refuses to
  write a future-dated document.

**Do not run `npm run db:seed`.** That is the development seed: it deletes and
recreates fictional vendors, riders and orders.

> **Gate: `npm run check:postgres` has never been run.** Nothing in `npm test`
> proves the PostgreSQL path, because it runs on SQLite. That script migrates a
> throwaway PostgreSQL database from zero, checks for drift, and verifies
> PostGIS containment against the in-process adapter. Run it against a
> **throwaway** database before touching production. Until it passes, the
> PostgreSQL path is implemented and unverified.

---

## 4. Build and run

```bash
npm ci
npm run db:pg:generate
npm run build
```

`db:pg:generate` rather than `db:generate`: the PostgreSQL client is the one this
deployment needs. `npm run build` builds the web app; the API runs from source
through `tsx`.

**`NEXT_PUBLIC_*` is read at build time.** Set the web variables from §2 in the
environment of `npm run build`, not only in the supervisor. A rebuild is required
to change any of them.

Then run both under a supervisor. Neither holds state in memory that matters, so
both can be restarted freely.

### The API

Every variable from §1 must be in its environment, starting with the profile:

```bash
NODE_ENV=production DEPLOYMENT_PROFILE=declutters npm run start --workspace @dash/api
```

### The web app

```bash
NODE_ENV=production npm run start --workspace @dash/web
```

### Confirming the profile took effect

Two checks, because a missing `DEPLOYMENT_PROFILE` does not fail quietly — it
fails loudly at boot, refusing `PAYMENT_PROVIDER`, `MAPS_PROVIDER`,
`SMS_PROVIDER` and `PUSH_PROVIDER` by name. If the API is running at all, the
profile was accepted. What is worth confirming is that the disabled surface is
genuinely absent:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.dashworldng.com/v1/orders
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.dashworldng.com/v1/devices
curl -s -o /dev/null -w '%{http_code}\n' https://api.dashworldng.com/v1/account/export
```

All three must answer `404`. A `401` would mean the route is still mounted and
only authentication stands between a caller and a feature this deployment cannot
perform.

The web side is a separate switch, read at build time:

```bash
curl -s -o /dev/null -w '%{http_code}
' https://declutters.dashworldng.com/vendor
curl -s -o /dev/null -w '%{http_code}
' https://declutters.dashworldng.com/ops
curl -s -o /dev/null -w '%{http_code}
' https://declutters.dashworldng.com/ops/declutter
```

`404`, `404`, `200`. A `200` on either of the first two means the web process does
not have `DEPLOYMENT_PROFILE=declutters` in its environment — check the
supervisor unit, not the build.

---

## 5. Health checks

| Endpoint | Meaning | Use for |
|---|---|---|
| `GET /health` | The process is up | Liveness |
| `GET /health/ready` | Dependencies answer | Readiness / load balancer |

`/health/ready` checks the database, the queue when Redis is configured, and
**storage** when the adapter can answer for itself — so a wrong bucket or a
missing credential fails the probe instead of waiting for the first seller to
photograph an item. It returns 503 when anything is down, names dependencies by
role rather than by technology, and never explains a failure: it is
unauthenticated, and the detail belongs in the log.

**A green readiness check does not mean email works.** Nothing probes SES.

### After deploying, before announcing

- [ ] `/health/ready` returns 200 with `database`, `queue` and `storage` ok
- [ ] `curl https://api.dashworldng.com/v1/declutter/taxonomy` returns 10 categories
- [ ] `curl https://api.dashworldng.com/v1/legal/terms-of-service` returns version
      `2026-09-09` and contains no "PLACEHOLDER"
- [ ] `https://declutters.dashworldng.com/` redirects to `/declutter`
- [ ] `https://declutters.dashworldng.com/robots.txt` says `Disallow: /`
- [ ] `/vendor` returns 404 and `/ops/declutter` returns 200 — the web build
      picked up the profile
- [ ] Open a listing **on a phone, on mobile data** and confirm the photograph
      loads. This is the check that catches a storage or same-site
      misconfiguration, and it cannot be done from a desktop on office wifi.

---

## 6. The static site

Two links change when Declutters moves to a subdomain. They are currently
relative (`/declutter`, `/declutter/sell`) and appear in the header nav, the
`#declutters` homepage section and the footer, across all seven pages.

Replace with `https://declutters.dashworldng.com/declutter` and
`…/declutter/sell`. `index.predeclutters.html` is the rollback copy of the
previous homepage.

---

## 7. Indexing stays off

`NEXT_PUBLIC_DECLUTTER_INDEXABLE=false` means `robots.txt` is `Disallow: /`, the
sitemap is empty, and every page carries `noindex`.

Turn it on only when there is real inventory and signup is open. An empty
marketplace indexed on day one is the version a search engine keeps.

---

## 8. Rollback

Everything below is reversible, and in this order.

### The web app or the API misbehaves

Redeploy the previous build. Neither holds state; there is nothing to unwind.

### Storage is misconfigured

Fix `S3_BUCKET` / `S3_REGION` and restart. Objects already written are
unaffected — keys are stored on the row, not derived.

**Do not** switch `STORAGE_PROVIDER` back to `local` to "get running again".
Production refuses it, and that refusal is correct: photographs written to local
disk vanish on the next deploy.

### Email is misconfigured

The service refuses to start rather than sending nothing quietly. Fix the
variables and restart. To stop new signups without a rollback, set
`SIGNUP_ALLOWLIST` to a single internal address.

### A bad release reached the database

Migrations here are additive — new tables and nullable columns. No deployed
migration drops a column or a table, so the previous release runs against the
newer schema unchanged. **Roll the application back and leave the database
alone.**

Down-migrations are deliberately not provided. A generated `DROP COLUMN` run
under pressure is how data is lost; if a schema change genuinely has to be
reversed, it is a new forward migration written deliberately.

### Take the marketplace down without taking DASH APP down

Point `declutters.dashworldng.com` at a holding page. The API keeps serving the
app, and no data changes.

---

## 9. What is deliberately not deployed

Each of these is a capability switched off by `DEPLOYMENT_PROFILE=declutters`,
not a feature that merely happens to be unused. Its adapter throws and its routes
return `404`, so none of it can half-work.

- **No live AI valuation.** `VALUECHECK_PROVIDER=local` is the deterministic
  adapter. No listing says `DASH ValueChecked`; the domain refuses to emit it.
- **No delivery, for anything.** Items are collected or handed over directly.
  Cars are `direct_only` and can never enter a rider queue.
- **No payments.** Nothing on Declutters takes money.
- **No seller portal.** Verification and submission happen with the Declutters
  team on WhatsApp, and the sell page says so.
- **No realtime sockets.** Every topic the protocol carries is an order, a
  vendor, a rider or a city. The marketplace has no live surface.
- **No DASH APP web pages.** The customer shell, vendor console, rider app and
  dispatch board answer 404 on this host.
- **No admin screen for the email suppression list.** Clearing an entry is a
  database update.
