# Declutters seller hub and item workspace

The seller hub extends the existing Declutters marketplace, seller, submission,
pricing, listing snapshots, KYC and Ops systems. It does not introduce another
account or marketplace. No production deployment is part of this change.

## Screens

- `/declutter/account`: identity and verification status, six summary cards,
  action centre, grouped item cards, main photo, reference/date, both prices,
  progress, unread badges, item/chat/listing links and existing phone editor.
- `/declutter/account/items/[submissionId]`: seller-owned details and photographs,
  nine-stage progress, next action, price acceptance/decline, safe activity and
  price history, publication link/date, text chat and proposed item updates.
- `/declutter/account/messages`: general account support and item conversations.
- `/ops/declutter/items/[submissionId]`: seller and item context, existing KYC
  review drawer and ValueCheck/pricing workspace, safety/item decisions, blockers,
  proposed changes, protected final actions and chat.
- `/ops/declutter/inbox`: unread/open/pricing/action/resolved filters, seller/item
  references, price/workflow context, replies and resolve/reopen controls.
- `/ops/declutter/updates`: proposed changes queue, also surfaced on Ops dashboard.

## Additive persistence

Both Prisma dialects contain migration `20261011010000_seller_hub`.
It adds `DeclutterConversation`, `DeclutterMessage`,
`DeclutterSubmissionUpdate`, `DeclutterUpdatePhoto`, and
`DeclutterHubNotification`. Submission review timestamps, final approval and
content revision fields are additive. Existing rows and live listing snapshots
are retained. No reset or destructive table replacement is required.

Conversations have a seller owner, optional submission, unique scope, nullable
assigned staff identity and open/resolved state. Message sender identity/type
come from authentication. The unique conversation/sender/client-message key
protects retries, including concurrent uniqueness conflicts. Existing staff
permissions govern chat; future assignments do not require redesigning tables.

Updates hold complete proposed title/description/condition/photo snapshots.
Only one active draft/pending update is allowed per item. Approval is transactional,
checks the base content revision, applies to the existing submission and live
listing, preserves price and publication data, and records audit/activity events.
Rejection or requests for changes retain the approved snapshot and safe feedback.

## API surface

All seller routes authenticate and enforce ownership server-side. A foreign item,
conversation, photo or update returns no private data. Seller responses explicitly
project safe fields; KYC identifiers/documents/address/phone/social handle and
internal staff notes never enter hub responses.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/v1/declutter/hub` | Seller dashboard and unread totals |
| GET | `/v1/declutter/account/items/:id` | Owned item workspace |
| POST | `/v1/declutter/account/items/:id/updates` | Create proposed update draft |
| POST | `/v1/declutter/updates/:id/photos` | Upload replacement/new photo |
| POST | `/v1/declutter/updates/:id/submit` | Submit draft for review |
| POST | `/v1/declutter/updates/:id/discard` | Discard draft |
| GET | `/v1/admin/declutter/submissions/:id/workspace` | Unified Ops context |
| POST | `/v1/admin/declutter/submissions/:id/checks` | Record safety/item review |
| POST | `/v1/admin/declutter/submissions/:id/fully-approve` | Gated final approval |
| POST | `/v1/admin/declutter/submissions/:id/partner-approval` | Record required source approval |
| POST | `/v1/admin/declutter/fraud-flags/:id/resolve` | Protected, reasoned dismissal |
| GET | `/v1/admin/declutter/updates` | Pending update queue |
| POST | `/v1/admin/declutter/updates/:id/review` | Approve/reject/request changes |

Seller and admin namespaces each expose GET/POST `/conversations`, GET
`/unread-count`, GET `/conversations/:id`, POST `/conversations/:id/messages`,
and POST `/conversations/:id/read`. Admin additionally exposes POST
`/conversations/:id/status`. Message history returns the latest 100 messages in
chronological order, with `nextCursor`; `?before=<cursor>` loads older history.

Existing pricing-decision, authorisation, seller price-response and publication
endpoints are reused. ValueCheck context now supplies the actual DASH proposal
separately from the valuation recommendation, so Super Admin authorises the
price shown in the form.

## Workflow and security

Successful backend mutations reconcile recorded facts into the next real stage.
GET requests and navigation do not advance workflow. Verification completion
releases a complete item into safety review; incomplete details remain a gate.
Failed reviews can request seller information through chat and safe feedback.

Fully Approved requires existing Super Admin price-authority and publication
permissions plus existing MFA step-up. It validates KYC, active fraud flags,
safety/item review, ValueCheck, authorised price, matching current seller
acceptance, content/photos/location/category, source partner approval where
required, and pending updates. Legacy already-approved items retain their
existing recognised review state; current price/KYC/fraud/update gates still
apply. The old generic transition route cannot manufacture a new approved state.
Publication rechecks facts inside the transaction and preserves snapshot safety.

Exact submitted-price consent retains its existing first-authorisation rules:
valid explicit consent plus exactly matching DASH price auto-accepts. Changed
prices and legacy/no-consent submissions require seller acceptance. Auto-accepted
items receive no unnecessary price-action email. Declining does not publish;
the item retains a clear status and direct chat path.

## Notifications and refresh

Price-action and inactive-view staff-message notifications use the existing DASH
email branding and durable notification-delivery idempotency. Price intents are
committed with authorisation; staff message intents are committed with messages.
Retries cannot create duplicate message/price emails. Failed intents remain for
retry; obsolete prices and already-read messages are suppressed. Emails escape
dynamic HTML, include a short message preview, and deep-link to the exact item
or account support conversation. An active seller chat heartbeat suppresses email.

UI polling is every 15 seconds while visible. Notification retry runs every
30 seconds while the API is running. This is text support with shared staff read
state; individual staff assignment management, push/socket realtime, attachments
and calls are intentionally not implemented.

## Validation and release preparation

Final relevant regression: **542 tests passed in 30 files**. This includes 25 new
hub API tests, 10 web hub tests, 12 domain hub tests, updated account/journey
tests, existing Declutters/ValueCheck/KYC/pricing/publication tests and session,
cross-origin CSRF and deployment middleware regressions.

Both Prisma clients generated; both schemas validated; PostgreSQL schema parity
passed. Applying the additive SQLite migration to the previous schema preserved
legacy item/price/consent data and produced no semantic schema difference.
Domain, DB, API and web typechecks passed. API and web production builds passed.
Changed TypeScript files passed ESLint. The web build used
`NEXT_PUBLIC_API_URL=https://api.dashworldng.com`; client chunks contain that URL
and no local development API base.

An isolated real-browser run proved submission → dashboard → checks/ValueCheck/
changed-price authorisation with real MFA → captured branded price email → chat/
Ops unread inbox/reply → seller acceptance → Fully Approved → publication → live
photo replacement → pending Ops update → protected approval. Uploaded photos
decoded successfully; desktop/mobile had no horizontal overflow or page errors.
Business routes, database, storage, ownership and workflow were real. Email used
a capture adapter and ValueCheck used the repository's local deterministic adapter.
Exact-price auto-acceptance through publication is separately proven by API tests.

Before any separately authorised release:

1. Apply the PostgreSQL additive migration on a staging copy and verify constraints
   and legacy data, then generate the intended production Prisma client. No live
   PostgreSQL migration was executed during this work.
2. Build web with the production public API value. Keep host-only auth cookies;
   existing CSRF bootstrap/refresh architecture is unchanged.
3. Configure API `PUBLIC_WEB_URL=https://declutters.dashworldng.com` for CORS and
   notification links. Retain the existing Declutters deployment profile, private
   S3 storage, transactional email/sender configuration and ValueCheck configuration.
4. Verify actual Brevo/SES delivery and deep links, production S3 photo replacement,
   real ValueCheck evidence, customer OTP/session restoration across the two hosts,
   MFA and concurrent PostgreSQL review/publish/message retries in staging.
5. Monitor queued notification attempts and API uptime. Queue delivery needs a
   running API process; no external notification worker was introduced.

No production deployment or merge is authorised by this document. PR #8 remains
the existing launch PR. PR #9 must never be merged.
