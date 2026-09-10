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

> **The API and the web must be same-site.** The API sends
> `Cross-Origin-Resource-Policy: same-site`, so item photographs are blocked if
> the two are on unrelated domains. `declutters.dashworldng.com` +
> `api.dashworldng.com` is fine. This was hit in development and is not
> theoretical.

---

## 1. Environment — API

### Required, always

| Variable | Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Turns on every boot guard below |
| `DATABASE_URL` | `postgresql://…` | PostgreSQL 15+ with PostGIS |
| `API_PORT` | e.g. `4000` | |
| `PUBLIC_WEB_URL` | `https://declutters.dashworldng.com` | CORS allowlist. A wrong value blocks every browser call |
| `JWT_ACCESS_SECRET` | 32+ random bytes | Boot refuses a development value |
| `REFRESH_TOKEN_PEPPER` | 32+ random bytes | |
| `ENCRYPTION_KEYS` / `ENCRYPTION_ACTIVE_KEY` | per `docs/` key custody | KYC envelope encryption |
| `REDIS_URL`, `RATE_LIMIT_REDIS` | Redis connection | Production refuses per-process rate limits |

### Storage — required

| Variable | Value |
|---|---|
| `STORAGE_PROVIDER` | `s3` |
| `S3_BUCKET` | e.g. `dash-declutters-prod` |
| `S3_REGION` | e.g. `eu-west-1` |
| `S3_ENDPOINT` | *only* for a non-AWS S3-compatible provider |
| `S3_FORCE_PATH_STYLE` | `true` only for those providers |

Production refuses to start on `STORAGE_PROVIDER=local`, and refuses `s3`
without a bucket and region.

### Email — required

| Variable | Value |
|---|---|
| `EMAIL_PROVIDER` | `ses` |
| `SES_REGION` | the region the identity is verified in |
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
| `NEXT_PUBLIC_API_URL` | `https://api.dashworldng.com` | **Read at build time.** Changing it needs a rebuild |
| `NEXT_PUBLIC_SITE_ORIGIN` | `https://declutters.dashworldng.com` | Canonicals, Open Graph, sitemap |
| `NEXT_PUBLIC_DECLUTTER_INDEXABLE` | `false` | **Leave false.** See §7 |

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
npm run db:generate
npm run build
```

Then run `apps/api` and `apps/web` under a supervisor. Neither holds state in
memory that matters, so both can be restarted freely.

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

- **No live AI valuation.** `VALUECHECK_PROVIDER=local` is the deterministic
  adapter. No listing says `DASH ValueChecked`; the domain refuses to emit it.
- **No delivery, for anything.** Items are collected or handed over directly.
  Cars are `direct_only` and can never enter a rider queue.
- **No payments.** Nothing on Declutters takes money.
- **No seller portal.** Verification and submission happen with the Declutters
  team on WhatsApp, and the sell page says so.
- **No admin screen for the email suppression list.** Clearing an entry is a
  database update.
