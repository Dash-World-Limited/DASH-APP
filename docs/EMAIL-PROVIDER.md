# Transactional email: SES

**Status: the adapter is written and tested against a stub. No real message has
ever been sent, and no AWS account has been configured.** Section 5 is the list
of things only you can do.

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

**Two implementations now.** `ConsoleEmailAdapter` — logs the subject and text,
`isLive = false`, nothing delivered, development only — and `SesEmailAdapter`,
described in section 2.

**A defect found and fixed on the way here.** `EMAIL_PROVIDER` was declared as
`z.enum(['console', 'smtp'])`, classified as production-required, and refused in
production when set to `console` — and then *never read*. The service
constructed `ConsoleEmailAdapter` unconditionally. A production deployment could
set `EMAIL_PROVIDER=smtp`, satisfy every guard, boot cleanly, and write every
verification code to stdout while believing it was sending email. Nobody would
find out until a user said the code never arrived.

The wiring now reads the value and **throws at startup** for any provider it has
no adapter for. That is deliberate: a service that cannot send email should fail
loudly, not quietly log.

---

## 2. The adapter, as built

`apps/api/src/adapters/ses.ts` — `SesEmailAdapter implements EmailPort`,
`providerName = 'ses'`, `isLive = true`, using `@aws-sdk/client-sesv2`.

Three decisions in it are worth knowing, because they are the ones that would be
tempting to undo:

- **It never falls back.** A rejected message throws `EmailDeliveryError`. There
  is no downgrade to a console log, because that is exactly the failure this
  milestone had to fix elsewhere — a service believing it sends email while
  writing codes to stdout is worse than one that is plainly broken.
- **It never carries the body or the address.** The body of a verification email
  *is* the one-time code, so an error containing it hands every account to
  anyone who can read the logs. The error carries the recipient's *domain* only,
  which is what answers "is their mail provider rejecting us".
- **It says whether a retry could help.** A rejected message, a suspended
  account or paused sending fails identically forever; a throttle does not.

Credentials come from the SDK's default chain, so an instance role works and no
key need exist in the environment.

`EMAIL_PROVIDER` is now `console | ses`. **`smtp` was removed from the enum**
rather than left in place: it was never implemented, and a value that validates
with no adapter behind it is how a deployment boots believing it sends email.

10 tests cover the command shape and every failure path, with a stub client. No
test touches AWS.

## 3. Environment variables

| Variable | Example | Notes |
|---|---|---|
| `EMAIL_PROVIDER` | `ses` | `console` is refused in production |
| `SES_REGION` | `eu-west-1` | SES is regional; the identity must be verified in **this** region |
| `EMAIL_FROM_ADDRESS` | `no-reply@notify.dashworldng.com` | Must be a verified identity |
| `EMAIL_FROM_NAME` | `DASH World` | Defaults to `DASH World` |
| `EMAIL_REPLY_TO` | `admin@dashworldng.com` | **Must be monitored** — see below |
| `SES_CONFIGURATION_SET` | `dash-transactional` | Optional, strongly recommended |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | — | Only if not using an instance role |

The first three plus `EMAIL_REPLY_TO` are checked **at boot** when
`EMAIL_PROVIDER=ses`. A missing sender is otherwise not discovered until
somebody tries to create an account, and by then it looks like a broken signup
form. All five are classified in `apps/api/src/secrets/classification.ts`.

IAM needs `ses:SendEmail` on the identity, and nothing else.

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
7. **Configuration set + SNS topic** for bounces and complaints. The consumer
   exists: `POST /v1/webhooks/email-events`. Create the configuration set, an
   SNS topic, and an HTTPS subscription pointing at that path, then set
   `SES_EVENT_TOPIC_ARN` so notifications from any other topic are refused.
   Confirming the subscription is automatic and happens only after the
   signature proves AWS sent it. A hard bounce that keeps being retried is what
   gets a sending domain suspended.
8. **Monitor the complaint rate.** Above roughly 0.1% SES will intervene.

---

## 6. Bounces and complaints

`POST /v1/webhooks/email-events` receives SNS notifications and writes to
`EmailSuppression`. Every send goes through a wrapper that consults it, so the
list is enforced rather than merely recorded.

Nothing is trusted before the SNS signature verifies: the signed string is
rebuilt from the message's own fields, the certificate URL must be an Amazon SNS
HTTPS endpoint (parsed, not pattern-matched), the signature is checked against
that certificate, and stale messages are refused. Without the URL check a
forgery would simply point at a certificate the attacker owns — the endpoint
would be a public form for suppressing any address, which stops one named person
receiving the code that opens their account.

| Event | Effect |
|---|---|
| Permanent bounce | Nothing may be sent to that address again |
| Complaint | Marketing stops; verification and sign-in codes continue |
| Soft bounce | Nothing suppressed |

A complaint deliberately does not stop transactional mail. Somebody who marked a
newsletter as spam has not asked to be locked out of their own account.

Suppression only ever tightens, notifications are idempotent on the SNS message
id, and a cleared suppression is kept rather than deleted.

**Not built:** there is no admin screen for the suppression list. Clearing an
entry is a database update today.

---

## 7. Development and test behaviour

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
