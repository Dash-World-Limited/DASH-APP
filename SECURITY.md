# Security

What DASH APP defends against today, how, and what is still open.

**Scope:** this describes `v0.1.0-mvp`, a local development MVP. It has never
been deployed, never handled real money, and never held real personal data. Do
not read any control below as production-hardened until it is listed under
[Verified](#verified) — most are implemented but only tested locally.

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
| `POST /v1/auth/otp/request` | 5 / 10 min | Sends SMS. Costs money, and can be weaponised to spam a stranger's phone. |
| `POST /v1/auth/otp/verify` | 10 / 10 min | Brute-forcing a 6-digit code. |
| `POST /v1/auth/login` | 10 / 15 min | Credential stuffing. |
| `POST /v1/rider/deliveries/:id/complete` | 8 / 10 min | A 4-digit PIN is only 10,000 possibilities; the attempt limit is what makes it meaningful. |
| `POST /v1/vendor/orders/:id/verify-pickup` | 10 / 5 min | Same reasoning. |
| `POST /v1/webhooks/payments` | 600 / min | Providers retry aggressively; still bounded. |

### No user enumeration

- `POST /v1/auth/otp/request` returns an identical response whether or not the
  number has an account.
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
- either JWT secret still holds the `.env.example` placeholder
- the two JWT secrets are equal
- `DATABASE_URL` is SQLite
- `PAYMENT_PROVIDER=mock`
- `STORAGE_PROVIDER=local`
- `QUEUE_PROVIDER=memory`
- Paystack is selected without a secret key or webhook secret

The process exits with a readable list of what is wrong. It does not warn and
continue.

The seed script independently refuses to run against `NODE_ENV=production`.

---

## Verified

Controls actually exercised by an automated check, not merely written:

| Control | Where |
|---|---|
| Client-supplied prices ignored; server reprices from DB | `smoke.mjs` |
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
| No endpoint edits or deletes a ledger entry | `finance.test.ts` |
| An invalid checkout leaves no partial financial state | `finance.test.ts` |
| An admin acting on a vendor order is recorded as ops, not the vendor | `staff.test.ts` |

---

## Open — known gaps

Ordered by severity. Each is tracked in [`ROADMAP.md`](ROADMAP.md).

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

7. **In-memory queue loses jobs on restart.** Correctly rejected in production
    by config, but it means dispatch has no durability story yet.
8. **No SSRF allowlist.** No user-controlled outbound URLs exist today, so
    there is nothing to exploit — but the guard should exist before the first
    provider callback URL does.
9. **No backup or restore procedure**, because there is no deployment.
10. **No incident-response runbook.**

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
