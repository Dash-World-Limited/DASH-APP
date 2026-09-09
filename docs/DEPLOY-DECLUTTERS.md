# Deploying DASH World Declutters

What has to be true before the public marketplace is reachable from
`dashworldng.com`, in the order it has to be done. Nothing here has been run
against production — this is the checklist, not a record of a deployment.

---

## 1. What is being deployed

Three things, and only the first two are new infrastructure.

| Piece | What it is | Where it runs |
|---|---|---|
| **API** (`apps/api`) | Fastify. Serves the public marketplace endpoints, the admin console's endpoints, and item photographs. | Node 22+, one process, needs the database |
| **Web** (`apps/web`) | Next.js 15. Serves `/declutter`, `/declutter/[slug]`, `/declutter/sell`, plus the existing DASH APP routes. | Node 22+, `next start` |
| **dashworldng.com** | The existing static marketing site. Gains a nav link, a homepage section and a footer link. | Unchanged hosting |

The static site is already deployed the way it always was. It is the entry
point, not the marketplace.

---

## 2. The decision that has to be made first: where Declutters lives

The marketing site links to `/declutter`. That resolves in one of two ways, and
this choice drives three environment variables.

### Option A — same domain, reverse proxy (what the links assume)

`dashworldng.com/declutter` → the Next app.

Requires the marketing site's host to proxy that path to the Node process.
On Apache with `mod_proxy` enabled:

```apache
ProxyPreserveHost On
ProxyPass        /declutter  http://127.0.0.1:3000/declutter
ProxyPassReverse /declutter  http://127.0.0.1:3000/declutter
ProxyPass        /_next      http://127.0.0.1:3000/_next
ProxyPassReverse /_next      http://127.0.0.1:3000/_next
```

`/_next` matters as much as `/declutter`: without it the pages render unstyled,
because every stylesheet and script is served from that path.

**Check `mod_proxy` is actually available before choosing this.** Shared cPanel
hosting frequently does not enable it, and finding that out on launch day is the
expensive way to learn it.

### Option B — subdomain (recommended if there is any doubt)

`declutters.dashworldng.com` → the Next app, on its own host.

Then:

1. Point an A or CNAME record at the Node host.
2. Change the two marketplace links in the static site. They are the only
   occurrences of `href="/declutter"` and `href="/declutter/sell"`, in the
   header nav, the homepage `#declutters` section and the footer, on all seven
   pages.
3. Set `NEXT_PUBLIC_SITE_ORIGIN=https://declutters.dashworldng.com`.

**Either way, the API and the web app must be same-site.** The API sends
`Cross-Origin-Resource-Policy: same-site`, so item photographs are blocked if
the two are on unrelated hosts. `dashworldng.com` + `api.dashworldng.com` is
fine; `dashworldng.com` + some other domain entirely is not. This was hit in
development and is not a theoretical concern.

---

## 3. Environment

### API

| Variable | Value | Why |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | SQLite is development only |
| `API_PORT` | e.g. `4000` | |
| `PUBLIC_WEB_URL` | The web origin from step 2 | CORS allowlist; a wrong value blocks every browser call |
| `STORAGE_PROVIDER` | `s3` | **Required.** The boot guard refuses to start production on `local`, correctly: local disk storage is lost on redeploy, and it would take every item photograph with it |
| S3 credentials | per the provider | |
| `VALUECHECK_PROVIDER` | `local` | The only value. It is the deterministic adapter, and no listing claims otherwise |

### Web

| Variable | Value | Why |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | The API origin | Read at build time — a rebuild is needed to change it |
| `NEXT_PUBLIC_SITE_ORIGIN` | The public origin from step 2 | Canonical URLs, Open Graph, sitemap |
| `NEXT_PUBLIC_DECLUTTER_INDEXABLE` | `false` until launch is approved, then `true` | Below |

**Indexing is off by default and switching it on is a deliberate act.** Until it
is `true`, `robots.txt` is `Disallow: /`, the sitemap is empty and every page
carries `noindex`. Turn it on only when there is real inventory: an empty
marketplace indexed on day one is the version of the site Google keeps.

---

## 4. Database

```bash
npm run db:pg:migrate          # prisma migrate deploy against PostgreSQL
```

Then seed the reference data — geography and the ten categories, including Cars
& Vehicles. `seedDeclutterTaxonomy` is idempotent and safe to re-run; it upserts
and does not touch operational fields such as a location's `cityId`.

Migrations are checked in for both SQLite and PostgreSQL. The PostgreSQL schema
is generated from the authored SQLite one and `npm run db:pg:sync -- --check`
fails if it is stale.

---

## 5. Build and start

```bash
npm ci
npm run db:generate
npm run build          # both workspaces
```

Then run `apps/api` (`node dist` or `tsx src/main.ts` under a process manager)
and `apps/web` (`npm run start --workspace @dash/web`, port 3000).

Both need to survive a restart. Neither holds state in memory that matters, so
any supervisor will do.

---

## 6. The static site

Upload the contents of the marketing site folder as before. The changed files
are `index.html`, `work.html`, `services.html`, `pricing.html`, `process.html`,
`protection.html` and `dash-app.html` — a nav link, a footer link, and on
`index.html` a `#declutters` section between Dash App and the closing call to
action. No CSS or JavaScript changed, and `index.predeclutters.html` is a
rollback copy of the previous homepage.

---

## 7. Before announcing it

- [ ] At least one real listing published, with real photographs of the actual
      item. The hero is built from live listings and an empty marketplace looks
      broken in a way an empty page does not.
- [ ] Open a listing on a phone, on mobile data, and confirm the photographs
      load. This is the check that catches a storage or `same-site`
      misconfiguration, and it cannot be done from a desktop on the office wifi.
- [ ] Paste a listing link into WhatsApp and confirm the preview shows the item,
      its price and a photograph.
- [ ] Confirm `/robots.txt` says what you expect for the state you are in.
- [ ] Confirm an admin can reach `/ops/declutter`, and that a signed-out visitor
      gets nothing there.
- [ ] Sign in as a buyer and send one contact request end to end.
- [ ] Set `NEXT_PUBLIC_DECLUTTER_INDEXABLE=true` and rebuild, last.

---

## 8. What is deliberately not deployed

- **No live AI valuation.** `VALUECHECK_PROVIDER=local` is the deterministic
  adapter. No listing says `DASH ValueChecked`, the domain refuses to emit that
  badge, and a test enumerates every combination to prove it.
- **No delivery, for anything.** Declutters items are collected or handed over
  directly. Cars are `direct_only` in the taxonomy and can never enter a rider
  queue.
- **No payments.** Nothing on Declutters takes money yet.
- **No seller portal.** Verification and item submission are completed with the
  Declutters team on WhatsApp, and the sell page says so plainly.
