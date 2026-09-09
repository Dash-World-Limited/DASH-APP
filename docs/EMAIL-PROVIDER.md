# Transactional email: what exists, and what SES needs

Written before any SES work, so the decision is made with the real picture. No
AWS SDK has been added and no SES adapter has been written.

---

## 1. What already exists

**The interface.** `EmailPort` in `packages/domain/src/ports/index.ts`:

```ts
interface EmailPort {
  readonly providerName: string;
  readonly isLive: boolean;
  send(input: {
    to: string;
    subject: string;
    html: string;
    text: string;
    reference: string;
  }): Promise<DeliveryReceipt>;
}
```

It has been there since before this milestone. `isLive` is the honesty flag the
rest of the codebase uses to distinguish an adapter from an integration, and
`reference` is a caller-supplied tag (`email_verify_<identityId>`,
`signup_phone_conflict`) that a provider's message metadata can carry.

**The only implementation** is `ConsoleEmailAdapter` — logs the subject and text,
returns an accepted receipt, `isLive = false`. Nothing is delivered.

**A defect found and fixed during this milestone.** `EMAIL_PROVIDER` was
declared as `z.enum(['console', 'smtp'])`, classified as production-required,
and refused in production when set to `console` — and then *never read*. The
service constructed `ConsoleEmailAdapter` unconditionally. A production
deployment could set `EMAIL_PROVIDER=smtp`, satisfy every guard, boot cleanly,
and write every verification code to stdout while believing it was sending
email. Nobody would find out until a user said the code never arrived.

The wiring now reads the value and **throws at startup** for any provider it has
no adapter for. Since there is no SMTP adapter and no SES adapter, both values
currently refuse to start. That is deliberate: a service that cannot send email
should fail loudly, not quietly log.

**The consequence for this milestone:** email verification works in development
and cannot work in production until an adapter exists. That is the single
largest blocker to real signups.

---

## 2. What SES will require in code

- **Dependency:** `@aws-sdk/client-sesv2`. v2 rather than v1 — it carries the
  suppression-list and account-level APIs that matter for reputation, and v1 is
  effectively frozen.
- **Adapter:** `SesEmailAdapter implements EmailPort`, `isLive = true`,
  `providerName = 'ses'`, mapping `send()` onto `SendEmailCommand` with both the
  text and HTML bodies already supplied by every call site.
- **Config:** add `'ses'` to the `EMAIL_PROVIDER` enum and a branch in
  `createEmailAdapter`.
- **Classification:** every new variable needs a row in
  `apps/api/src/secrets/classification.ts`, or the boot-time secret audit fails.

Roughly a day, most of it the failure paths: a throttle, a rejected address, a
suppressed recipient, and a bounce that must not be retried.

---

## 3. Environment variables

| Variable | Example | Notes |
|---|---|---|
| `EMAIL_PROVIDER` | `ses` | |
| `AWS_REGION` | `eu-west-1` | SES is regional; the identity must be verified in *this* region |
| `AWS_ACCESS_KEY_ID` | — | Prefer an instance role and omit both keys |
| `AWS_SECRET_ACCESS_KEY` | — | Secret. Classify as such |
| `EMAIL_FROM_ADDRESS` | `no-reply@notify.dashworldng.com` | Must be a verified identity |
| `EMAIL_FROM_NAME` | `DASH World` | What the recipient sees |
| `EMAIL_REPLY_TO` | `admin@dashworldng.com` | **Must be a real monitored inbox** — see below |
| `SES_CONFIGURATION_SET` | `dash-transactional` | Optional, strongly recommended: how bounces and complaints get back to you |

IAM needs only `ses:SendEmail` on the identity, plus
`ses:GetAccountSendingEnabled` if you want a startup check.

---

## 4. Which domain should send

**Recommended: a dedicated subdomain,** e.g. `notify.dashworldng.com`.

Transactional mail and anything marketing must not share a sending reputation.
If a campaign ever gets complaints on `dashworldng.com` itself, verification
codes start landing in spam and people cannot get into their accounts — the
failure looks like a broken product, not a mail problem, and it is very hard to
diagnose from inside the app.

For the same reason the marketplace itself should probably live on
`declutters.dashworldng.com`, but these are independent decisions: the sending
domain does not have to match the site domain, and recipients are far more
tolerant of `no-reply@notify.dashworldng.com` than of a mismatched envelope.

Set a **custom MAIL FROM** of `bounce.notify.dashworldng.com` so SPF aligns on
your own domain rather than on `amazonses.com`.

### The Reply-To is load-bearing

The phone-conflict email says *"reply to this email and a person will look at
it."* That sentence is the only route a genuine user has when their phone number
is already registered to somebody else — the one case this system deliberately
refuses to resolve automatically. If `EMAIL_REPLY_TO` points at an unmonitored
mailbox, that person has no way through at all. **Whoever monitors it needs to
know what an identity conflict is and who can resolve it.**

---

## 5. What must be configured outside the codebase

1. **Verify the domain** in SES, in the region you will send from.
2. **DKIM**: enable Easy DKIM and publish the three CNAME records.
3. **SPF**: publish a TXT record for the custom MAIL FROM subdomain including
   `amazonses.com`, plus the MX record SES asks for.
4. **DMARC**: start at `p=none` with a reporting address, and only tighten to
   `quarantine` once reports are clean. Going straight to `p=reject` on a new
   domain is how the first day of real signups produces silence.
5. **Leave the SES sandbox.** Until you do, SES will only deliver to addresses
   you have verified individually — which looks exactly like working email right
   up to the moment a real customer signs up. Request production access early;
   approval is not instant.
6. **Sending quota**: check the daily cap and per-second rate against the signup
   volume you expect.
7. **Configuration set + SNS topic** for bounces and complaints, and something
   that consumes it. A hard bounce that keeps being retried is what gets a
   sending domain suspended.
8. **Monitor the complaint rate.** Above roughly 0.1% SES will intervene.

---

## 6. Development and test behaviour

Unchanged and deterministic.

- Development uses `ConsoleEmailAdapter`; codes print to the API console.
- `DEV_EXPOSE_OTP` additionally returns the code in the HTTP response, guarded
  twice: `NODE_ENV` must not be production, and `config.ts` refuses to start a
  production process with the flag set at all.
- Tests substitute their own `EmailPort` and assert on what would have been
  sent — subject, recipient, reference and body — which is how the enumeration
  behaviour is tested at all: the "you already have an account" message is
  checked to go to the mailbox and not to the HTTP caller.

No test and no local run has ever sent a real email, and none can.
