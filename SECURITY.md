# Security

What DASH APP defends against today, how, and what is still open.

**Scope:** this describes the `main` line — `v0.1.0-mvp` plus the untagged
Milestones A–G, E (account deletion and data export), and II (the
PostgreSQL/PostGIS and Redis production path). It has never been deployed, never
handled real money, never held real personal data, and **no adapter has been run
against a real external provider**. Do not read any control below as
production-hardened until it is listed under [Verified](#verified) — most are
implemented but only tested locally.

**One section is not on `main`.** [Secret handling](#secret-handling) and the
Milestone III rows in [Verified](#verified) describe work on the branch
`claude/milestone-iii-secret-management`, which has **not been merged, tagged, or
deployed**. Those parts are marked where they appear.

Nigerian data-protection (NDPA 2023) and consumer-law obligations have **not**
been reviewed by qualified counsel. Nothing here is legal advice.

---

## Reporting a vulnerability

This is a pre-release project with no public deployment. If you find something,
open an issue in the repository or contact the maintainer directly. Please do
not open a public issue for anything affecting money movement or authentication
until it has been discussed.

---

## Threat model

Who we assume is hostile, and what they are after.

| Actor | Wants | Primary defence |
|---|---|---|
| A customer | Free or cheap food; someone else's order details | Server-side repricing; object-level scope checks |
| A rider | Pay for deliveries not made; another rider's earnings | Delivery PIN; GPS plausibility checks; scope checks |
| A vendor | A competitor's orders, prices, or volumes | Tenant scoping; 404-not-403 on cross-tenant probes |
| A support agent | Quiet self-enrichment via credits and refunds | Step-up auth; four-eyes on high-risk actions; audit log |
| An outsider | Account takeover; free orders; the customer list | Rate limits; no user enumeration; hashed tokens |
| A compromised dependency | Anything | Least privilege; no secrets in source; redacted logs |

The assumption throughout: **every client is hostile, including our own apps.**
The web app is a convenience layer over an API that must be safe on its own.

---

## Implemented controls

### Authentication

- **Passwords** — scrypt (N=16384, r=8, p=1), 16-byte random salt embedded in a
  versioned `s1$salt$hash` string. Argon2id would be stronger but needs a native
  module this environment cannot build; the version tag makes migrating a matter
  of re-hashing on next successful login.
- **OTP** — CSPRNG-generated via `randomInt`, hashed with the same scrypt
  construction, single-use, 5-minute expiry, 5-attempt limit. Requesting a new
  code invalidates any outstanding one.
- **Tokens** — access tokens are JWTs (HS256, 15 min), returned in the response
  body and held in memory by the client only. Refresh tokens are opaque 256-bit
  random values stored only as a SHA-256 digest. Plain SHA-256 rather than
  scrypt is deliberate: a refresh token already has full entropy, so there is no
  dictionary to attack and a slow KDF would add latency for nothing.
- **The refresh token lives in a `HttpOnly`, `Secure`, `SameSite=Lax` cookie**
  scoped to `/v1/auth`, so script cannot read it and the browser never attaches
  a 30-day credential to an order read or a file upload. It is never returned in
  a response body — asserted by a test that greps the raw body for it.
- **CSRF** — double-submit. A separate non-HttpOnly cookie is echoed back in an
  `X-CSRF-Token` header, compared in constant time, and reissued on every
  rotation. Enforced only on state-changing requests that actually carry the
  refresh cookie; a pure Bearer request has no ambient credential to ride on.
- **Separate secrets and audiences** for access and refresh tokens. If one
  secret signed both, a refresh token would verify as an access token — a full
  bypass. `config.ts` refuses to start if the two secrets are equal.
- **Refresh rotation with reuse detection** — every refresh mints a new token and
  retires the old one. Presenting a retired token revokes the whole session
  family, forward and backward through the `previousSessionId` chain. Losing a
  session is far cheaper than leaving a stolen one live.
- **Revocation is immediate.** `authenticate()` rebuilds the actor from the
  database on every request, so a revoked session or a removed role takes effect
  at once rather than after the access token expires.

### Administrator MFA

Staff roles cannot obtain a session with a password alone.

- **TOTP (RFC 6238)** via `otplib` — SHA-1 HMAC, 6 digits, 30-second period, the
  parameters every authenticator app supports. No cryptography is hand-written:
  the library provides the algorithm and `node:crypto` provides the primitives.
- **Two-stage login.** The password stage returns a short-lived, single-use,
  opaque challenge — no access token, no refresh cookie, no CSRF token. The
  session is minted only after the second factor. A stolen intermediate token
  cannot be refreshed, cannot reach a business endpoint, and expires in five
  minutes.
- **Which roles.** All seven staff roles: `super_admin`, `platform_admin`,
  `finance_analyst`, `support_agent`, `city_manager`, `dispatcher`, and
  `marketing_manager`. `assertMfaPolicyCoversStepUp()` fails a test if a role
  ever gains a step-up permission without also requiring MFA. Customers, riders,
  and vendor users are deliberately excluded — their blast radius is their own
  account, and changing that needs a product decision.
- **Enrolment proves possession.** The secret lands in `mfaPendingCipher` and
  only becomes live once a valid code is submitted, so a half-finished enrolment
  can never authenticate. Starting a new enrolment cannot lock anyone out of a
  working authenticator either.
- **The secret is encrypted at rest** with AES-256-GCM, bound to the owning
  identity as additional authenticated data. A row copied to another identity
  fails to decrypt rather than silently working. It is returned exactly once, at
  enrolment, and never appears in any later read, audit entry, or log.
- **Replay is blocked.** The accepted TOTP time step is recorded, and a code is
  only valid for a step strictly greater than the last one. The same six digits
  cannot be used twice even inside the 30 seconds they are displayed for. A
  replayed code is reported identically to a wrong one.
- **Recovery codes** — ten per batch, 78 bits each from a rejection-sampled
  CSPRNG over an alphabet with no confusable glyphs. Shown once, stored as
  SHA-256 hashes, single-use (enforced by an `updateMany` guarded on
  `usedAt: null`, so two simultaneous redemptions cannot both win). Regenerating
  voids every unused code from earlier batches and requires a fresh step-up.
- **Disabling MFA** requires a fresh step-up, wipes the secret and every
  recovery code, revokes every session including the caller's, and writes a
  high-signal audit event. The role still requires MFA afterwards, so the
  account returns to needing enrolment rather than being let in on a password.
- **Bounded.** Five attempts per challenge, spent before the code is checked so
  a dropped connection cannot buy extra tries; a five-minute challenge window;
  and per-route rate limits on every MFA endpoint.

Production refuses to start with `MFA_ENABLED=false`, and refuses to start with
MFA enabled but no `ENCRYPTION_KEY` — MFA without a key is not "MFA off", it is
MFA that fails at enrolment in front of a user.

### Vendor payout details

The account a vendor is paid into redirects every future settlement without
touching a ledger entry, so nothing looks wrong until a vendor reports a missing
payment. It is treated accordingly.

- **Write-only.** No route returns the account number in clear, and no
  permission would allow one. `decryptPayoutDetailsForSettlement()` exists for
  the payout job Codex will build — it decrypts, hands the value to the
  provider, and never returns it to a caller.
- **Encrypted with the same AES-256-GCM envelope as the TOTP secret**, bound to
  the vendor id as additional authenticated data. A row copied between vendors
  fails to decrypt rather than silently redirecting someone else's money. The
  account *name* is encrypted too — it is personal data, and pairing it with a
  bank is the combination worth protecting.
- **Masked everywhere else.** Reads return the bank name and last four digits:
  enough for a vendor to recognise their own account, useless to anyone else.
  The audit trail records the mask on both sides of a change, never the number.
- **`vendor:payout:write` is owner-only and step-up gated.** Vendor managers and
  staff do not hold it, and neither does any ops or finance role — this is the
  vendor's own banking, not the platform's to edit.
- **Validated.** Ten-digit NUBAN, checked before storage. An account number with
  a typo is money sent to a stranger.
- **Fails closed.** With no encryption key configured, the write is refused
  rather than falling back to plaintext.

**Step-up here is phone OTP, not TOTP.** `vendor_owner` appears in
`STEP_UP_WITHOUT_MFA` with a written reason: requiring an authenticator app to
change a bank account would push small vendors off the platform, and the blast
radius is only their own settlements. `assertMfaPolicyCoversStepUp()` fails a
test if any *other* role gains a step-up permission without requiring MFA, so
this exemption cannot quietly become a pattern.

### Authorization

- **60 explicit permissions, 12 roles.** Code asks *"may this actor do this
  thing?"*, never *"what is this actor?"*. Deny by default.
- **Permission ≠ ownership.** `assertPermission()` and `assertScope()` are
  separate and both must pass.
- **Cross-tenant probes return 404, not 403.** A 403 confirms the record exists.
  The scope check throws with the literal message `Not found.`
- **Step-up authentication** for anything that moves money, changes who can do
  what, deletes an account, or exports data in bulk. Valid for 15 minutes. A
  super admin with every permission still cannot approve a refund without it —
  asserted in `scripts/smoke.mjs`.
- **Four-eyes** required on settlement approval, payout approval, manual ledger
  adjustments, and role edits.
- **Client-supplied roles are ignored.** `buildActor()` recomputes permissions
  from the identity's role rows. A `permissions` field in a request body is
  discarded — asserted in `permissions.test.ts`.

### Input and output

- Every request body, query, and param validated with Zod at the boundary.
- One error shape everywhere: `{ error: { code, message, requestId } }`. Public
  messages are safe; stacks, constraint names, and which record failed a scope
  check go to the log against `requestId` and never cross the wire.
- Validation errors return field paths and messages but **never the received
  value** — a rejected password must not echo back.
- Cursor pagination with hard caps on every list endpoint.
- `bodyLimit` 1 MB.

### Money integrity

- Double-entry ledger, append-only. `assertBalanced()` rejects any transaction
  whose entries do not sum to zero, before the write.
- Idempotency keys required on order creation, payment capture, refunds, and
  payouts. Replaying a key returns the original result rather than acting twice.
- Refunds cannot exceed the captured amount.
- `GET /v1/finance/ledger/integrity` re-verifies the whole ledger on demand.
- No mutable balance columns anywhere.

### Rate limiting

Global 300/min, keyed by identity when authenticated and by IP when not — keying
anonymous traffic by IP alone would let one signed-in user exhaust the budget for
everyone behind the same NAT. Tighter per-route limits where abuse is cheap:

| Route | Limit | Why |
|---|---|---|
| `POST /v1/auth/otp/request` | 5 / 10 min per client, and per destination: one code per 60 s, 5 per hour | Sends SMS or email. Costs money, and can be weaponised to spam a stranger's phone or inbox; the per-destination limit holds even against rotating IPs. |
| `POST /v1/auth/otp/verify` | 10 / 10 min | Brute-forcing a 6-digit code. |
| `POST /v1/auth/login` | 10 / 15 min | Credential stuffing. |
| `POST /v1/rider/deliveries/:id/complete` | 8 / 10 min | A 4-digit PIN is only 10,000 possibilities; the attempt limit is what makes it meaningful. |
| `POST /v1/vendor/orders/:id/verify-pickup` | 10 / 5 min | Same reasoning. |
| `POST /v1/webhooks/payments` | 600 / min | Providers retry aggressively; still bounded. |

### No user enumeration

- `POST /v1/auth/otp/request` returns an identical response whether or not the
  number or address has an account — including when the per-destination
  throttle holds the request, and when the email or SMS provider refuses the
  message (SES in sandbox refuses unverified recipients). A failed delivery
  retires its code and is logged by provider and error name only, never with
  the message body, which is the code. `resendAfterSeconds` in the response is
  the configured constant, never account-dependent.
- `POST /v1/auth/login` compares against a decoy hash when the account does not
  exist, so response time does not reveal which emails are registered, and
  returns the same message for a wrong password and a missing account.

### Webhooks

1. Verify the signature before parsing anything meaningful.
2. Store the raw event keyed on `(provider, eventId)` — the unique constraint is
   what enforces replay protection.
3. Re-verify the payment with the provider rather than trusting the body.
4. Reject an amount that does not match the payment record.
5. **Answer 200 to a hostile request.** Returning 401 would tell someone probing
   the endpoint that their signature was the only thing wrong.

Even the mock adapter verifies a signature, because a check that only runs in
production is a check that has never been tested.

### Privacy

- Rider location is collected **only while the rider is online**. Going offline
  stops it, and the API rejects points from an offline rider.
- Implausible GPS jumps are rejected and recorded with the implied speed, not
  silently dropped — a repeated pattern is evidence.
- Delivery-proof coordinates are coarsened to 4 dp (~11 m) before storage: enough
  to show the rider was at the address, not enough to build a movement history.
- A rider is shown a **coarsened drop-off area** (3 dp) before accepting an
  offer, and the exact address only after.
- Vendors see the customer's **first name only** — no phone number, no full
  address. The rider needs those; the kitchen does not.
- The delivery PIN is returned exactly once, at checkout, and never appears in
  any subsequent order read — asserted in `scripts/smoke.mjs`.
- Audit-log payloads pass through `redact()`, which strips ~17 sensitive key
  names at any nesting depth. The audit log is one of the widest-read tables in
  the system, so redaction happens at the write, not the read.
- Pino redacts `authorization`, `cookie`, `idempotency-key`, `password`, `code`,
  and `refreshToken` from all request logging.

### Uploads

MIME allowlist (JPEG, PNG, WebP, PDF), 8 MB cap, empty files rejected. Object
keys are 24 random bytes and are **never** derived from a user-supplied
filename, so a filename cannot traverse a path or collide across tenants. Path
resolution refuses anything escaping the base directory. Signed URLs carry an
HMAC-shaped digest over key and expiry.

### Account deletion and data export

- **Deletion is a scheduled state machine, not an instant drop.**
  `scheduled → held | cancelled | completed`, one request per identity, behind a
  fresh step-up. A cooling-off window (default 14 days) precedes finalisation,
  and the owner — or staff, on their behalf — can cancel any time before it
  closes, or while it is `held`.
- **A deletion cannot erase what the ledger sums over.** Finalisation deletes
  credentials and drafts and **anonymises everything else in place**: orders,
  payments, refunds, settlements, and every ledger entry survive with their ids
  and amounts unchanged; only fields that name a person clear. The delete /
  anonymise / retain rule for all 24 model classes lives in
  `packages/domain/src/account`, at 100% test coverage.
- **Legal holds are checked twice.** An active order, an unresolved refund or
  dispute, an open safety/fraud case, or a negative wallet balance defers the
  request — named, so the person can act on it. Checked when the request is
  opened *and again at finalisation*, because a customer can acquire any of them
  during the two-week window; a hold found at the last moment parks the request
  in `held` and it resumes automatically once the matter clears.
- **Finalisation is idempotent and single-transaction.** An `anonymisedAt`
  marker, a claimed request row, and set-to-constant writes mean a concurrent or
  repeated run is a no-op and writes no second audit entry. Every session is
  gone afterwards, so the account's tokens stop working immediately.
- **The export download is a stateless signed capability.** An HMAC over the
  request id and an expiry (default 24 h), issued only to the authenticated
  owner and **single-use**. The archive is read *before* the row is marked
  delivered, under a short exclusive lease: two near-simultaneous downloads
  cannot both win (guarded `downloadCount: 0` commit), and a transient
  object-storage read failure returns a retryable `503` leaving the row
  untouched, so an outage never burns the one download. A bad token and a wrong
  id return the same 404.
- **Expiry cannot evict a live download.** The row stays `ready` while a
  download runs — the lease marks it busy, not the status — so both expiry paths
  (the expired-link branch and the maintenance sweep) require that no live lease
  is held. A reader who took its lease before the deadline finishes and commits;
  expiry waits for the lease to lapse, which is bounded, so a crashed download
  cannot pin an archive open.
- **No archive can be stranded.** Every path that removes one — download,
  expiry, build failure — transitions the row first, then deletes, and clears
  `storageKey` only once the delete is confirmed. A failed delete keeps the key,
  so the row is a tracked orphan the maintenance sweep retries; nulling it would
  discard the only reference to the bytes.
- **The export build is claimed atomically.** Exactly one worker moves a request
  to `building` under its own claim id before it reads any subject data or writes
  a blob; a losing worker does nothing. Every subsequent write — promotion,
  failure, and the max-attempts give-up — is pinned to the exact claim the worker
  observed, so a row another worker has since reclaimed is never overwritten and
  its blob never deleted. A blob written before a later DB failure is dropped,
  and a claim that goes stale is reclaimed or failed by maintenance.
- **The archive is scoped to the subject.** Every relation is filtered by the
  requester's own ids; it never contains another user's data, internal risk
  scoring, or staff records, and its manifest says so.
- **Audit entries carry counts only** — never an email, a phone number, a
  coordinate, or the free-text deletion reason.

### Production boot guards

`apps/api/src/config.ts` refuses to start when `NODE_ENV=production` and any of
the following hold:

- `DEV_EXPOSE_OTP` is true
- either JWT secret still holds a `.env.example` placeholder, or is too
  low-entropy to be worth having
- `DATABASE_URL` is SQLite
- `PAYMENT_PROVIDER=mock`, `MAPS_PROVIDER=local`, `SMS_PROVIDER=console`,
  `EMAIL_PROVIDER=console`, `PUSH_PROVIDER=console`, `STORAGE_PROVIDER=local`,
  `QUEUE_PROVIDER=memory`, or `GEO_ZONES_PROVIDER=local`
- `MFA_ENABLED` is false, or `ENCRYPTION_KEY` is absent
- `RATE_LIMIT_ENABLED` is false, or `RATE_LIMIT_REDIS` is false
- `PUBLIC_WEB_URL` is plain HTTP
- a selected provider's required credential is missing — Paystack without a
  secret key or webhook secret, Google without an API key, Mapbox without a
  token, Redis-backed queueing without a URL

And in **every** environment, not only production:

- the two JWT secrets are equal — that would make a refresh token verify as an
  access token, a full authentication bypass invisible until someone tries it
- `MFA_ENABLED=true` with no encryption key
- any malformed encryption key material
- any ambiguous keyring: a key id the envelope format cannot carry, one id that
  is both active and retired, the same material under two ids, a duplicate
  retired id, or retired keys with no active key
  (see [`docs/KEY_MANAGEMENT.md`](docs/KEY_MANAGEMENT.md#what-boot-refuses))
- a retention period above its policy ceiling, or an out-of-range deletion or
  export window

The process exits with a readable list of **every** problem at once — a
one-error-per-restart boot loop is a miserable way to configure a service. The
message names the variables that failed and never their values. It does not warn
and continue.

The seed script independently refuses to run against `NODE_ENV=production`.

### Secret handling

> **On a branch, not on `main`.** Everything in this section is Milestone III,
> which lives on `claude/milestone-iii-secret-management` and has **not been
> merged, tagged, or deployed**. A clone of `main` has none of it.

Every configuration variable is classified secret or non-secret in
`apps/api/src/secrets/classification.ts`. That table is the source of truth for
log redaction, the leak regression tests, and the `.env.example` placeholder
gate — one list rather than four that drift.

Secrets reach the process through **runtime environment injection**, and the
application does not know what populated the environment
([ADR-0011](docs/DECISIONS.md#adr-0011--runtime-environment-injection-as-the-secret-source-contract)).
**No managed secret store is integrated**, because no deployment platform has
been chosen; the contract and the guardrails around it are what exist.

Redaction operates in two ways, because neither alone is sufficient:

| Layer | Catches | Where |
|---|---|---|
| **By key name**, matched as a fragment of the normalised key | `apiKey`, `jwtAccessSecret`, `PAYSTACK_WEBHOOK_SECRET`, `databaseUrl` — one entry covers every spelling | `@dash/domain/redaction`, used by the audit log, the error-tracker seam, and metric tags |
| **By shape, inside free text** | The password in `postgresql://dash:pw@db:5432` — no key name reaches inside a sentence, and this is exactly what a Prisma or ioredis connection failure puts in its own message | Pino's `err` serializer and log-method hook, the configuration error message, the verification scripts |

Applied at: configuration errors thrown at boot, request and boot logs
(including every child logger), the readiness endpoint, the error-reporting
port, and metric tags. `apps/api/src/__tests__/secrets.test.ts` asserts all four
by **iterating the classification table**, so classifying a new secret extends
the coverage rather than requiring a new test.

Repository hygiene is gated by `npm run check:secrets`, which checks every
secret in `.env.example` individually by the shape of its value — provider key
prefixes such as `sk_live_`, `AKIA`, and `whsec_` are refused there even as
placeholders, because a fake key wearing a real prefix is indistinguishable from
a leaked one to a scanner or a reviewer. It also refuses committed key files,
dumps, and backups, which carry no pattern `gitleaks` would match.

### Realtime sockets

A WebSocket is a long-lived, unauthenticated TCP stream that browsers will open
cross-site with the user's ambient credentials attached. Every control here
exists because one of those three properties breaks an assumption the HTTP API
was allowed to make.

| Threat | Control |
|---|---|
| **Data leaking past the API's projection rules** | A frame carries `{topics, subject, version, eventId, occurredAt}` and nothing else. The client re-reads through the ordinary authorized route, so the field-level rules — vendor sees a first name and no phone, rider position only while the order is active, PIN to nobody — apply to realtime automatically and cannot drift. Asserted by a test that enumerates the frame's keys. ([ADR-0013](docs/DECISIONS.md#adr-0013--realtime-carries-notifications-not-data)) |
| **Cross-site WebSocket hijacking** | Upgrades are not subject to CORS and carry cookies. The socket authenticates from a frame, so an attacker's page has nothing to send; and `Origin` is checked against the same allowlist CORS uses. |
| **Credentials in URLs and logs** | No token in the query string and no cookie authentication. The access token travels in an `authenticate` frame over the established TLS connection. |
| **Authority outliving the session** | A socket is closed when the token that authenticated it expires, so socket authority is never staler than an HTTP request's. A sweep re-reads the session on a timer and closes sockets whose session was revoked, suspended, or expired — one query per session, not per socket. A lookup failure keeps sockets rather than disconnecting everyone; the expiry bound needs no database. |
| **Stale authorization on a live socket** | Re-authentication clears the connection's subscriptions and returns `resync`, so their ownership checks are re-run rather than assumed. The sweep additionally drops any subscription `canSubscribe` no longer allows — a dispatcher moved between cities, a vendor manager removed from the vendor. |
| **Resource existence disclosure** | A refused topic is always `not_found`, whether the order does not exist or exists and belongs to someone else — the same choice `assertScope` makes by returning 404 rather than 403. Tested by asserting the refusal for a real order and an invented id are byte-identical. |
| **Subscription widening** | Topic names are `kind:id` with the id constrained to the cuid alphabet, matched by exact string equality everywhere. No globbing exists anywhere in the system. `order:*`, `order:a:b`, and a traversal are all refused, and topic names arriving over the broadcast channel are **re-parsed** rather than trusted. |
| **Unauthenticated sockets as a resource** | Closed after 10s without an `authenticate` frame. The upgrade is an ordinary HTTP GET and is rate-limited per IP; once authenticated, an identity is capped at 10 concurrent sockets. |
| **Frames bypassing the rate limiter** | `@fastify/rate-limit` sees the upgrade and nothing after it. Each connection carries its own frame budget (60 per 10s) and is closed when it exceeds it. |
| **Memory exhaustion** | Frames are capped at 4KB, enforced by `ws` before assembly and again before `JSON.parse` is given anything to allocate; 50 topics per frame; 200 subscriptions per socket; and a client that stops reading is closed once its buffer passes 256KB rather than being buffered indefinitely. |
| **Untrusted input on internal channels** | The broadcast channel is shared infrastructure that more than one deployment may point at. Every notification is re-validated on arrival — id, subject, topic names, and a version that must be a non-negative safe integer — and anything malformed is dropped and counted, never logged verbatim. |
| **A client trusting the wire** | The browser client's refresh callback receives `{reason, subjects}` — a reason and identifiers, and no field from the frame. There is no shape a component could render even by mistake, which is a stronger guarantee than remembering not to. A rendered-component test pushes a frame carrying a status, a total, a phone number and a delivery PIN, and asserts none of it appears in the document. |
| **Compression side channels** | `permessage-deflate` is disabled. Mixing attacker-influenced identifiers with server data in a compressed stream is the shape of CRIME/BREACH, and these frames are far too small for compression to pay. |

**Delivery is at-least-once and unordered, and neither is a security property
being wished away.** A duplicate causes a re-read of state that is already
current; a stale notification causes a re-read of state that is newer than it
claimed. `Order.revision` is monotonic per order so a client can drop the stale
one, and the hub admits an event id once per connection so a redelivery never
becomes two frames.

---

## Verified

Controls actually exercised by an automated check, not merely written:

| Control | Where |
|---|---|
| Client-supplied prices ignored; server reprices from DB | `smoke.mjs` |
| Realtime frames carry no order data (keys enumerated) | `realtime.test.ts` |
| Cross-customer, cross-vendor, cross-rider, cross-city socket subscriptions refused as `not_found` | `realtime.test.ts` |
| A refused real order and an invented id are indistinguishable | `realtime.test.ts` |
| Cross-origin socket upgrade refused | `realtime.test.ts` |
| Refresh token replayed as a socket credential refused | `realtime.test.ts` |
| Socket closed when its session is revoked | `realtime.test.ts`, `realtime-hub.test.ts` |
| Subscriptions dropped when the actor loses the role behind them | `realtime-hub.test.ts` |
| Crafted topic names (`order:*`, traversal, oversized) refused | `realtime.test.ts`, `realtime.test.ts` (domain) |
| Malformed broadcast payloads dropped, never delivered | `realtime.test.ts`, `realtime-outbox.test.ts` |
| Per-socket frame budget and per-identity connection cap enforced | `realtime.test.ts` |
| Slow consumer closed rather than buffered indefinitely | `realtime-hub.test.ts` |
| Realtime notification payloads refused if they carry personal data | `realtime-outbox.test.ts` |
| A hostile frame's fields never reach the DOM; the screen renders the authorized read | `useLive.test.tsx` |
| A client ignores a frame naming a topic it never subscribed to | `useLive.test.tsx`, `realtime.test.ts` (web) |
| Duplicate and stale notifications do not roll a screen backwards | `useLive.test.tsx` |
| A screen stays correct with no WebSocket at all | `useLive.test.tsx` |
| Cross-instance fan-out, prefix isolation, and rejection of crafted broadcasts, against a real Redis | `npm run check:redis` (14/14) |
| Cross-tenant vendor access returns 404 with `Not found.` | `smoke.mjs` |
| Customer cannot reach ops, vendor, or audit endpoints | `smoke.mjs` |
| Super admin still needs step-up for a refund | `smoke.mjs` |
| Wrong password and missing account are indistinguishable | `smoke.mjs` |
| OTP request reveals nothing about whether a number is registered | `smoke.mjs` |
| Delivery PIN never echoed back in an order payload | `smoke.mjs` |
| Vendor never sees the customer's phone number | `smoke.mjs` |
| Unsigned webhook answered 200, does nothing | `smoke.mjs` |
| Replayed idempotency key does not double-charge | `smoke.mjs` |
| Forged and absent tokens rejected | `smoke.mjs` |
| Implausible GPS jump rejected | `dispatch-check.mjs` |
| Exact address hidden until the offer is accepted | `dispatch-check.mjs` |
| Wrong delivery PIN cannot complete a delivery | `dispatch-check.mjs` |
| Ledger balances after a full delivery | both |
| A staff password alone yields no session, no cookie, no token | `mfa.test.ts`, `smoke.mjs` |
| An unconfirmed enrolment cannot authenticate | `mfa.test.ts` |
| A TOTP code cannot be replayed, and reads identically to a wrong one | `mfa.test.ts` |
| The TOTP secret is encrypted, identity-bound, and absent from every read | `mfa.test.ts` |
| A recovery code works exactly once; regeneration voids the rest | `mfa.test.ts` |
| Disabling MFA revokes every session and still demands MFA next time | `mfa.test.ts` |
| A newly privileged account is challenged at its next sign-in | `mfa.test.ts` |
| Ciphertext will not move between vendors, fields, or keys | `envelope.test.ts` |
| Bank details are never stored, logged, or returned in clear | `payout.test.ts` |
| The retention job never touches ledger, audit, order, or webhook records | `retention.test.ts` |
| Old rider locations are coarsened, converge, and survive concurrent runs | `retention.test.ts` |
| Retention output and audit entries contain counts, never rows | `retention.test.ts` |
| Account deletion needs a fresh step-up; cancellation does not | `account-deletion.test.ts` |
| A legal hold (open order, dispute, safety case, debt) defers deletion | `account-deletion.test.ts` |
| A hold acquired *during* the cooling-off window still blocks finalisation, then resumes when it clears | `account-deletion.test.ts` |
| Finalisation anonymises the identity but leaves orders, payments, and every ledger entry intact | `account-deletion.test.ts` |
| Repeated and concurrent finalisation anonymise once and write one audit entry | `account-deletion.test.ts` |
| A cancellation racing finalisation is resolved deterministically, both ways | `account-deletion.test.ts` |
| A finalised account's live sessions stop working immediately | `account-deletion.test.ts` |
| The staff deletion path needs its own permission, a reason, and an on-behalf-of audit entry | `account-deletion.test.ts` |
| Deletion and export audit entries carry counts only, never PII | `account-deletion.test.ts` |
| An export archive contains the requester's data and no other customer's | `account-export.test.ts` |
| The export download is single-use; a second attempt and a concurrent one are refused | `account-export.test.ts` |
| A wrong-owner, garbage, or wrong-request download token returns 404 and consumes nothing | `account-export.test.ts` |
| An expired export link is refused and its archive is deleted | `account-export.test.ts` |
| A storage read failure returns a retryable 503 and does not consume the download | `account-export.test.ts` |
| A failed archive delete is retried by the maintenance orphan sweep | `account-export.test.ts` |
| A failed delete while expiring a link, or during the expiry sweep, keeps the blob reference and a later sweep cleans it | `account-export.test.ts` |
| A max-attempt give-up cannot fail a build another worker reclaimed after the read | `account-export.test.ts` |
| A live download lease blocks expiry and archive deletion; the reader still commits exactly once | `account-export.test.ts` |
| Expiry proceeds once a download lease has gone stale | `account-export.test.ts` |
| Concurrent export builds: exactly one worker claims, writes a blob, and wins | `account-export.test.ts` |
| A DB failure after a build write cleans up the blob; a stale claim is reclaimed or failed | `account-export.test.ts` |
| A build failure marks the request failed without wedging the queue | `account-export.test.ts` |
| Readiness discloses dependency status but no provider, host, or secret | `observability.test.ts` |
| Liveness stays up when the database is unreachable | `observability.test.ts` |
| Credentials, personal data, and coordinates never reach an error tracker | `observability.test.ts` |
| Metrics tags carry no ids or personal data | `observability.test.ts` |
| Redirecting settlements needs owner role plus a fresh step-up | `payout.test.ts` |
| A tampered or wrong-key payout record fails rather than decrypting | `payout.test.ts` |
| A record under a retired key still opens and is flagged for rotation | `payout.test.ts` |
| Cross-tenant scope denial across 500 probed ids | `permissions.test.ts` |
| Injected `permissions` field discarded | `permissions.test.ts` |
| Unknown role fails closed | `permissions.test.ts` |
| Refresh token never appears in a response body | `auth.test.ts` |
| Refresh cookie is HttpOnly, SameSite, path-scoped | `auth.test.ts` |
| A refresh token in the request body is ignored | `auth.test.ts` |
| Reuse detection revokes the whole session family | `auth.test.ts` |
| An attacker who redeems the stolen token first is also cut off | `auth.test.ts` |
| Reuse clears the cookies rather than looping on a dead token | `auth.test.ts` |
| CSRF rejected: missing header, mismatched token, missing cookie | `auth.test.ts` |
| A simulated cross-site forgery is blocked and does not lock the victim out | `auth.test.ts` |
| CSRF token rotates on every refresh | `auth.test.ts` |
| Logout kills the session server-side, not just the client | `auth.test.ts` |
| Access token invalidated immediately on logout, not at expiry | `auth.test.ts` |
| Concurrent sessions stay independent; reuse on one does not revoke another | `auth.test.ts` |
| One user cannot revoke another user's session | `auth.test.ts` |
| A refresh token is not accepted as an access token | `auth.test.ts` |
| Production refuses every mock adapter | `config.test.ts` |
| Production refuses `DEV_EXPOSE_OTP` | `config.test.ts` |
| Production refuses placeholder and low-entropy secrets | `config.test.ts` |
| Production refuses identical access/refresh secrets | `config.test.ts` |
| Production refuses disabled rate limiting | `config.test.ts` |
| Config errors never echo a secret value | `config.test.ts` |

The rows below are **Milestone III, on an unmerged branch** — they do not hold
for a clone of `main`:

| Control | Where |
|---|---|
| No classified secret reaches a config error, for **any** secret and **any** fault | `secrets.test.ts` |
| No classified secret reaches the real server logger, or a child logger | `secrets.test.ts` |
| A connection-string password is stripped from an error message, stack, and cause chain | `secrets.test.ts` |
| No classified secret reaches `/health/ready`, including when a dependency is down | `secrets.test.ts` |
| Secret-shaped field names an exact-match list would miss are redacted | `secrets.test.ts`, `redaction.test.ts` |
| Every variable classified secret is caught by the redaction vocabulary | `secrets.test.ts` |
| Every variable classified public survives redaction | `secrets.test.ts` |
| A rotated key leaves old rows readable and new rows on the new key | `key-rotation.test.ts` |
| Re-encryption moves payout **and** TOTP columns, and is idempotent | `key-rotation.test.ts` |
| Key destruction is gated on a survey that finds no row under an old key | `key-rotation.test.ts` |
| A key that is not held fails closed, naming the key id and no key material | `key-rotation.test.ts` |
| Every ambiguous keyring configuration is refused at boot | `key-rotation.test.ts`, `check:keys` |
| A key id the envelope format cannot carry is refused before it writes a row | `key-rotation.test.ts`, `envelope.test.ts` |
| A database restored without its key, or without its retired keys, is unrecoverable | `check:keys` |
| A staging key cannot read a production row | `check:keys` |
| `.env.example` holds no credential-shaped value, per variable | `check:secrets` |
| No key file, dump, or backup is tracked in git | `check:secrets` |
| Login and OTP rate limits actually fire | `ratelimit.test.ts` |
| Cross-customer order read and cancel return 404 | `orders.test.ts` |
| A client-supplied price is ignored at quote and checkout | `orders.test.ts` |
| A customer cannot price a delivery to another customer's address | `orders.test.ts` |
| Cross-vendor accept/reject/progress/pickup return 404 | `vendor.test.ts` |
| A vendor never sees the customer's phone number or full address | `vendor.test.ts` |
| A suspended vendor disappears from ordering | `vendor.test.ts` |
| Cross-rider offer response and delivery access return 404 | `dispatch.test.ts` |
| The exact drop-off address is withheld until an offer is accepted | `dispatch.test.ts` |
| Two riders accepting the same offer yields exactly one winner | `dispatch.test.ts` |
| A wrong delivery PIN cannot complete a delivery | `dispatch.test.ts` |
| Cross-city reassign and surge return 404 | `staff.test.ts` |
| Every ledger transaction sums to zero after every money operation | `finance.test.ts` |
| A refund cannot exceed the captured amount cumulatively | `finance.test.ts` |
| A duplicate refund or compensation posts no second effect | `finance.test.ts` |
| A refund becomes `refunded` only when Paystack reports it processed, for this payment, amount and currency | `refund-confirmation.test.ts` |
| One Paystack refund cannot settle two refunds; concurrent confirmations settle once | `refund-confirmation.test.ts` |
| A refund webhook body is never evidence — Paystack is asked | `refund-confirmation.test.ts` |
| A person-entered refund id never reaches a Paystack URL unless it is digits | `paystack-adapter.test.ts`, `refund-confirmation.test.ts` |
| No endpoint edits or deletes a ledger entry | `finance.test.ts` |
| An invalid checkout leaves no partial financial state | `finance.test.ts` |
| An admin acting on a vendor order is recorded as ops, not the vendor | `staff.test.ts` |

---

## Open — known gaps

Ordered by severity. Each is tracked in [`ROADMAP.md`](ROADMAP.md).

### High

1. **`npm audit` fails, and CI's dependency job is red.** Not introduced by this
   work — every advisory is in a pre-existing transitive dependency, and
   advisories publish against unchanged trees, so a previously green run turns
   red with no code change.

   As of 28 September 2026: **17 vulnerabilities — 2 critical, 5 high, 10
   moderate.** The four root advisories below account for all the critical
   and high ones; the rest are packages that merely depend on a vulnerable one.
   The six moderates added since the previous count (11) are one new root
   advisory, `uuid` (missing buffer bounds check in v3/v5/v6 when the caller
   supplies a buffer), reached through `firebase-admin` →
   `@google-cloud/storage` → `gaxios` / `teeny-request` / `retry-request`. The
   API uses only `firebase-admin/app` and `/messaging` and never calls `uuid`
   itself. `npm audit fix` (no `--force`) clears that chain within semver
   ranges, but it re-resolves about 800 packages, the AWS SDK among them, and
   still leaves every high and critical finding; it was tried and reverted
   rather than shipped without its own verification pass.

   | Root advisory | Sev | Reached via | Where it runs | Also flags |
   |---|---|---|---|---|
   | `deepmerge-ts` (stack exhaustion on recursive graphs) | High | `prisma` → `@prisma/config` | Prisma CLI, at `db:generate` / `db:push` | `@prisma/config`, `prisma` |
   | `postcss` (XSS via unescaped `</style>`; arbitrary `.map` read via `sourceMappingURL`, ×3) | High | `next` (pins it internally) | Next build | `next` |
   | `vite` (path traversal in optimised-deps `.map` handling; `launch-editor` NTLMv2 disclosure on Windows) | High | `vitest` | Test runner | `vite-node` |
   | `@vitest/mocker` (arbitrary file read/execute) | Critical | `vitest` | **Only when the Vitest UI server is listening** — this repository never starts it | `vitest`, `@vitest/coverage-v8` |

   **None is reachable in the deployed runtime path.** The API ships
   `@prisma/client`, not the `prisma` CLI; PostCSS runs at build time, not per
   request; Vite and Vitest are test-only, and the critical one additionally
   needs a UI server that is never started.

   That is a reachability argument, not a dismissal — it is why these are not
   treated as an incident, and it is *not* a reason to stop tracking them.

   Remediation was attempted and reverted: npm `overrides` for `postcss` and
   `deepmerge-ts` register but do not displace Next's internally pinned copy,
   and `npm audit fix --force` means major upgrades of Next and Vitest that
   need their own verification pass.

   **The gate has deliberately not been weakened to make it pass.** No
   suppression, no severity downgrade, no ignore list, no `--omit=dev`, no
   `continue-on-error`, and no major upgrade forced through purely to turn CI
   green. The dependency job stays red until the findings are actually resolved.

   **Status: unresolved, pending an owner decision.** These are *not* accepted
   risks, and no time-bounded exception has been granted — the original build
   specification allows release on unresolved high findings only with a
   documented, time-bounded exception, and granting one is an owner decision,
   not an engineering one. Until that decision is taken, the correct reading of
   this section is "known, analysed, and still open". The routes forward are:

   - wait for upstream patch releases that do not require a major bump;
   - schedule the Next and Vitest major upgrades with a full re-verification
     pass of their own; or
   - the owner grants an explicit, documented, time-bounded exception, which
     would be recorded here as such.

### Medium

1. **No DAST, and no container or infrastructure scanning.** CodeQL (SAST),
   dependency review, `npm audit`, and `gitleaks` all run in CI. There are no
   container or IaC files to scan yet. Authenticated DAST needs a deployed
   staging target, which does not exist — the handoff plan is in
   `docs/RUNBOOKS.md`.
2b. **The public catalogue and webhook replay paths are script-only.**
   `/v1/vendors`, `/v1/search`, and the webhook amount-mismatch and replay
   branches are covered by `scripts/smoke.mjs`, which needs a running server and
   is not part of the CI gate.
### Lower

7. **The in-memory queue loses jobs on restart.** It remains the development
    default and is refused in production by config. Milestone II added the
    Redis/BullMQ path that replaces it, verified against a real Redis 7
    (8/8 checks) but not yet deployed, so the durability story exists in code
    and has never run anywhere real.
8. **No SSRF allowlist.** No user-controlled outbound URLs exist today, so
    there is nothing to exploit — but the guard should exist before the first
    provider callback URL does.
9. **Backup and restore are documented but unrehearsed.** The procedure is in
    `docs/RUNBOOKS.md` §3 and the key half of it is rehearsed against synthetic
    material by `npm run check:keys`. **No real backup has ever been created and
    no restore has ever been performed**, because there is no deployment. A
    procedure that has never been executed is a hypothesis.
10. **No secret store, and no deployment platform chosen.** The application side
    of secret management is done — classification, redaction, boot validation,
    key custody, and rotation, all locally verified — and the contract is
    runtime environment injection (ADR-0011). What does not exist is the
    platform that performs the injection, the production secrets themselves, and
    the break-glass role, whose holder and authoriser are open owner decisions.
11. **The incident-response runbook has never been exercised.** `docs/RUNBOOKS.md`
    §1 documents severity, first fifteen minutes, credential and key rotation,
    payment incidents, and the post-incident review. None of it has been
    rehearsed, and there is no on-call rota to rehearse it with.

---

## Deliberate non-goals at this stage

- **No live payment integration.** Adapters are mocks by design until the
  authentication work below them is production-grade. Wiring a real gateway to a
  system whose refresh tokens sit in `sessionStorage` would be the wrong order.
- **No production deployment.** Nothing here has been hardened for a public
  network.
- **No real personal data, ever, in development.** Every seeded account is
  fictional and phone numbers use a reserved-style `+234 700` block that cannot
  ring a real handset.
