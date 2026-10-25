# DASH Content Studio V1 — engineering handoff

Date: 25 October 2026. Branch: `feature/dash-content-studio-v1`.

Base: `aff3a076480c2580597f94f10fcd667ab25b8d36`, the fetched tip of
`origin/feature/post-accept-cancellation`. This is the explicitly requested
tested staging baseline, not the unrelated local UI branch or `main`.
Use `git rev-parse HEAD` for the committed implementation revision; the delivered
handoff also records the final hash and complete changed-file inventory.

## Completed scope

The existing Fastify API, Prisma/PostgreSQL persistence, staff password/MFA
sessions, role permissions, audit helper, private StoragePort and DASH web design
assets are reused. There is no new backend, authentication platform or AI Studio.

`/admin/content` supplies an isolated editorial shell with overview counts,
recent activity, content filters, editor, media upload/library, preview,
publish/unpublish confirmation, schedules, revision history and publication
rollback. The operational console links to it, but does not wrap its UI.

The controlled content types are banner, promotion, announcement, featured
vendor, vendor presentation, category artwork, collection, FAQ, policy and
campaign. Supported placements are `home.hero`, `home.promotions`,
`home.announcements`, `home.featured`, `category.artwork`, `vendor.presentation`,
`help`, and `legal`. Type/placement combinations are validated centrally.
Service-category targets use the repository's six-service taxonomy, not a new
list of assumed merchant categories. Vendor targets are existing Vendor IDs.

### Persistence and publication invariants

Only three additive models are introduced:

| Model | Purpose |
| --- | --- |
| `ContentEntry` | Working draft, optimistic version, creator/updater IDs and timestamps, pointer to the current published revision |
| `ContentRevision` | Immutable full snapshot for each save/publication/unpublication/rollback; actor ID, sequence, timestamp, foreign keys to media |
| `ContentMedia` | Private storage key, original filename/title/alt text, sanitized image dimensions/type/size, uploader and upload time, archive state |

Both SQLite and generated PostgreSQL schemas carry the same models. Both have
`20261025000000_content_studio/migration.sql`. The migrations only create the
three tables, their indexes and foreign keys. They do not alter existing tables,
rename data, change pricing, or require a destructive backfill.

Every edit creates a new history snapshot, and changes only the working draft.
Publication creates a new immutable revision and changes the live pointer in
the same serializable transaction as its audit record. Revision numbers include
draft saves and publishing actions. `version` is required for edits and actions;
stale/concurrent writes return 409. The two generated Prisma clients have
different error constructors, so conflict handling intentionally matches the
provider-neutral P2034/P2002 codes. A real PostgreSQL publish race verifies this.

Rollback can use only a publication belonging to the same entry. It creates a
new published revision and restores the working copy to that snapshot. It does
not rewrite history. Unpublishing removes the live pointer and retains history.

Images must be still JPEG, PNG or WebP, at most 8 MiB, 8000 pixels per edge and
25 megapixels. Sharp validates the declared format, decodes, rotates, downsizes
to fit 2400 pixels and re-encodes to fresh WebP without upload metadata. SVG,
scripts, animated images, invalid base64, corrupt raster and MIME spoofing are
rejected. Keys use the existing random private-storage naming pattern.

Archive is intentionally conservative: any saved revision reference, including
a draft or old publication, prevents archiving. There is no hard-delete endpoint
and no garbage collection in V1. A failed DB/audit write after object upload
attempts to remove the orphaned object. All referenced media have foreign keys.
Archive/reference races use the same serializable transaction boundary.

The existing local signed-file route allows embedding only the
`content-studio/` prefix across origins. All other local object prefixes retain
the existing same-site resource policy. Signature, expiry, byte-sniffing and
nosniff/CSP checks remain in force. S3 still uses existing private signed URLs;
no bucket policy or infrastructure was changed.

### Permissions

`content:manage` is the sole new permission. V1 grants it only through the
existing `super_admin` bundle, which includes every permission. No vendor,
rider, customer, marketing, support, dispatch, finance or platform-admin role
was newly granted access. All editorial paths have a common server-side guard,
including reads, previews/history, reference lookup, media and writes.
UI gating is additional; it is never the authorization boundary.

No staff-role provisioning or authentication flow was changed. Editorial staff
without Super Admin access will need an intentionally designed focused role in
a later change. Do not casually grant an operational role Studio permissions.

## API contract

All editorial responses use `private, no-store`. They include internal metadata
only after `content:manage` authorization.

| Method and path | Behavior |
| --- | --- |
| GET `/v1/admin/content/config` | Types, placements and service-category choices |
| GET `/v1/admin/content/vendors?search=...` | Bounded vendor ID/name/category lookup (50 results) |
| GET `/v1/admin/content/dashboard` | Counts and recent editorial activity |
| GET `/v1/admin/content/entries` | Cursor pagination, 100 per page; type/status/placement/vendorId/categoryId filters |
| POST `/v1/admin/content/entries` | Validate content and create private draft/history; 201 |
| GET `/v1/admin/content/entries/:id` | Draft plus live publication metadata |
| PUT `/v1/admin/content/entries/:id` | Save `{ version, content }` as a new draft revision |
| GET `/v1/admin/content/entries/:id/history?before=...` | Descending history, 50 per page |
| POST `/v1/admin/content/entries/:id/publish` | Publish saved draft with `{ version }` |
| POST `/v1/admin/content/entries/:id/unpublish` | Remove live pointer with `{ version }` |
| POST `/v1/admin/content/entries/:id/rollback` | Restore own previous publication with `{ version, revisionId }` |
| GET `/v1/admin/content/media` | Cursor pagination, 50 per page, preview URLs and revision reference counts |
| POST `/v1/admin/content/media` | `{ filename, title, alt, contentType, data }`, canonical base64; 201 |
| POST `/v1/admin/content/media/:id/archive` | Archive only an unused asset |
| GET `/v1/content?placement=home.hero` | Public, published-only, versioned presentation feed |

The public response is `{ schemaVersion: 1, version, items }`. Each item contains
only ID/revision, type/placement, display title/body/label, app destination,
priority/featured state, vendor/category target and resolved image/logo metadata.
It excludes drafts, internal names, storage keys, editor identities and audit
data. The query selects live revisions rather than loading and serializing a
draft-bearing entry. Invisible and out-of-schedule entries are excluded.

Public cache TTL is at most 30 seconds and is shortened at the next schedule
boundary. Start is inclusive and end is exclusive. Image URLs last one hour;
clients must refresh URLs when their response cache expires even if the content
version has not changed. Unpublished cached content can remain visible for at
most the response TTL; a previously issued signed image URL remains usable
until its own expiry. Editorial artwork is not a confidential document store.

V1 enforces a maximum of 500 concurrently published entries to keep the bounded
feed complete. At the limit, new publications receive a 409 with instructions
to unpublish an unused item. Priority sorts ascending, with ID as a stable tie
breaker. Clients choose the first supported hero. Internal list filters apply
within each cursor page; callers must follow `nextCursor` to exhaust a filtered
scan. The Studio UI loads all pages before applying its filters.

If a Studio query fails, the public endpoint returns an uncached empty V1
contract (`version: unavailable`) and logs the failure. A storage-signing failure
returns a null image, not a catalogue error. No transactional route imports or
waits for Studio data.

## Actual frontend integration

The existing web `/home` now mounts the optional `HomePromotion` component.
It fetches only `home.hero`, independently of serviceability/vendor requests,
with a 2.5-second timeout. It accepts supported V1 banner/campaign components,
validates app destinations and image URLs, and ignores malformed/newer data.
It renders nothing while loading, for empty/error data, or after image failure;
the existing home navigation and catalogue remain the fallback.

The end-to-end browser check used fictional local fixtures: authenticated
upload, draft save and preview in Studio, then an API-published hero visibly
rendered on `/home` together with existing search, sections and vendors. Screenshots
were delivered separately. Staff password/MFA and both editorial screens were
exercised in the browser. Responsive CSS is included; physical tablet/mobile QA
remains. The browser viewport override did not take effect, so it is not claimed
as mobile-device evidence.

**Not connected yet:** native Expo home, Android-shell device QA, category tiles,
featured vendor/store lists, vendor storefront cover/logo/badges, promotional
carousels, FAQ/help and legal consumers. The models/editor/public contract
support these, but they are not silently treated as implemented integrations.
Do not derive catalogue eligibility, pricing, inventory, opening hours or order
availability from Studio. Apply future vendor overrides only to vendors already
returned by the existing eligible catalogue.

## Validation performed

Commands below run from the repository root with Node 24.19.0 / npm 11.17.0.

- `npm ci --no-audit --no-fund` and `npm ci --prefix apps/mobile --no-audit --no-fund`.
- `node node_modules/tsx/dist/cli.mjs scripts/sync-postgres-schema.mjs`.
- `node node_modules/prisma/build/index.js generate --schema packages/db/prisma/schema.prisma`.
- Prisma `migrate diff --from-schema-datamodel <baseline> --to-schema-datamodel <new> --script` for both dialects generated the additive migrations.
- `node node_modules/vitest/vitest.mjs run --maxWorkers=2`: 174 files; 3,211 passed, one inherited Windows failure in `client-resolution.test.ts` (renaming a loaded DLL directory). All other suites passed, including orders, payments/ledger, dispatch/rider, vendor, cancellation, auth, permissions, catalogue, schema sync and migration parity. Duration: 931.40 seconds.
- Fixed the Windows test to move only the generated `index.js`, preserving the real missing-module failure and restoring it in `finally`.
- Final focused command: `node node_modules/vitest/vitest.mjs run packages/db/src/client-resolution.test.ts apps/api/src/__tests__/content.test.ts apps/web/src/components/content/HomePromotion.test.tsx apps/web/src/app/admin/content/page.test.tsx packages/domain/src/content/content.test.ts --maxWorkers=2`: **36 passed**, five files (26 new Studio checks plus 10 existing client-resolution checks). This reruns the failed suite and the final Studio implementation. The full 174-file run was not repeated after that targeted test fix.
- `npm run typecheck`: all five projects clean (domain, DB, API, web, mobile).
- `npm run lint`: clean.
- `npm run build`: API and web production builds passed, including `/admin/content`; repeated after final changes.
- `npm run check:postgres` against a disposable local PostgreSQL 16/PostGIS container: **17 passed, 0 failed**; complete migration replay, clean status, zero drift and PostGIS parity. Initial readiness attempt refused to migrate until the container was reachable; the retry passed.
- `PG_CHECK_URL=<fresh migrated loopback dash_verify DB> node --import tsx scripts/content-postgres-check.mjs`: passed actual permission denial, concurrent publish (200/409), no partial revision, draft isolation and unpublish. This script writes test fixtures; use a fresh migrated database each run.
- `npm run check:secrets`: 11 checks passed; repeated with staged new files included. No `.env`, real credentials, generated clients, test DBs, test images or preview configuration are committed.
- `git diff --check`: clean.

Expected dependency warnings remain: Fastify's existing request-logging
deprecation, Next's middleware convention and Edge-runtime import warnings,
plus existing npm deprecation notices. No forced dependency upgrade was used.

## Next engineer's exact tasks

1. Review this branch against **aff3a07 / feature/post-accept-cancellation**, not
   an old `main`. Run normal CI on the final commit; do not auto-merge either
   branch. The local checkout used for this work is isolated from the original
   `Desktop/dash-app` UI branch.
2. Stage with the existing API/web environment and storage credentials. Apply
   `npm run db:pg:migrate`, generate `npm run db:pg:generate` (and SQLite client
   for the repository's static types where required), build, then release the
   API/web artifacts through the existing staging process. Back up the target
   normally. Do not run a reset or seed fictional fixtures into staging.
3. Smoke-test existing staff MFA, authorization denial for customer/vendor/rider,
   upload on the configured real storage, draft not public, preview/publish,
   stale-version conflict, rollback, schedule expiry and unpublish.
4. Confirm `/home` on staging sees the banner without a rebuild, and still
   browses with an empty feed, blocked content request and failed image. Verify
   the site's CORS, image policies and signed-URL lifetime on its actual domains.
5. Perform tablet/mobile/device visual QA, especially long editor forms, media
   picker, UTC schedule input and Android-shell compatibility.
6. Add native Expo consumption through the same optional V1 feed; preserve
   existing native presentation as the default. Then connect category artwork,
   featured vendor lists and vendor cover/logo overrides one surface at a time.
7. If non-Super-Admin editorial staff are required, add a focused staff role and
   matching existing-session sign-in routing intentionally, with denial tests.
8. Expand the media workflow only when needed: editable alt/title with explicit
   revision semantics, reference navigation, storage quotas, orphan cleanup and
   retention policy. Actor IDs currently appear directly in activity/history.
9. Add richer collection membership or legal acknowledgement integration only
   as separately scoped work. The V1 collection is a presentation card and
   title/body policies do not change customer legal acceptance flows.

The branch is ready for engineering review. Merge/release should wait for normal
CI on the final commit and the staging smoke checks above. No production
deployment or merge was performed. Rolling back the API/web release can leave
the additive tables in place; do not drop Studio history as a routine rollback.
