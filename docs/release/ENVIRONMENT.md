# Environment for the release candidate — what David enters, and where

Nothing here is a secret. It names the variables and where they go; the
values are entered by David and never pasted into chat, commits, issues or
screenshots.

## Where secrets live

| Where | File / place | Committed? |
|---|---|---|
| This PC, for local testing | `C:\Users\admin\Desktop\dash-app\.env` | **Never** — `.gitignore` excludes it; `npm run check:secrets` fails if it is tracked |
| Staging / production server | the host's environment (not a file in the repo) | Never |
| Android release signing | environment of the shell that runs the build (see `SIGNING.md`) | Never |

`.env.example` (committed) lists every variable with an empty value and an
explanation. Copy a line from it into `.env` and fill in the value.

## Paystack (test mode)

| Variable | Value | Notes |
|---|---|---|
| `PAYMENT_PROVIDER` | `paystack` | `mock` settles nothing and is refused in production |
| `PAYSTACK_SECRET_KEY` | your **test** secret key, `sk_test_…` | Paystack Dashboard → Settings → API Keys & Webhooks. A `sk_live_…` key is refused unless `NODE_ENV=production` **and** `PAYSTACK_ALLOW_LIVE=true` |
| `PAYSTACK_ALLOW_LIVE` | `false` | Leave `false` for all of this work |
| `PAYSTACK_WEBHOOK_SECRET` | *(leave empty)* | Paystack signs webhooks with the secret key; any different value is refused at boot |
| `PAYSTACK_CALLBACK_URL` | *(optional)* | Defaults to `PUBLIC_WEB_URL/pay/complete` |

In the Paystack dashboard (test mode), set the **Test Webhook URL** to
`<your API origin>/v1/webhooks/payments`. Paystack must be able to reach it
over the internet; a PC on home Wi-Fi cannot receive webhooks, which is fine —
the app's "Check payment", the `/pay/complete` page and the reconciliation
job each settle a payment without the webhook.

Test cards: use Paystack's published **test** cards from its documentation.
No real card is ever charged in test mode.

## Brevo (transactional email)

| Variable | Value | Notes |
|---|---|---|
| `EMAIL_PROVIDER` | `brevo` | `console` only prints codes to the API log |
| `BREVO_API_KEY` | your Brevo API v3 key, `xkeysib-…` | Brevo → SMTP & API → API keys |
| `EMAIL_FROM_ADDRESS` | a sender **verified in that Brevo account** | Brevo → Senders, domains & dedicated IPs. Unverified senders are refused |
| `EMAIL_FROM_NAME` | `DASH World` (or as you prefer) | |
| `EMAIL_REPLY_TO` | a mailbox someone reads | The identity-conflict email tells people to reply to it |
| `BREVO_WEBHOOK_TOKEN` | a long random value you generate: `openssl rand -base64 32` | Lets Brevo report bounces and spam complaints (below). Empty means none is ever acted on |

**Bounces and complaints (do this before launch).** Without it, DASH keeps
mailing addresses that bounce or complain, Brevo's view of the sender
worsens, and eventually sign-in codes stop arriving for everybody. In Brevo →
Transactional → Settings → Webhooks, add a webhook:

- URL: `https://<your API host>/v1/webhooks/brevo-events`
- Events: **Hard bounce**, **Invalid email**, **Marked as spam** (others are
  accepted and ignored)
- Authentication: **Bearer token**, the same value as `BREVO_WEBHOOK_TOKEN`
  (Basic auth with that value as the password also works)

A hard bounce or invalid address stops all mail to it; a spam complaint stops
only non-essential mail, never a sign-in code. A soft bounce or a Brevo
"blocked" changes nothing. This has been tested against simulated Brevo events
only.

SES is optional and not needed for the release.

## SMS

| Variable | Value |
|---|---|
| `SMS_ENABLED` | `false` — no SMS is sent, phones stay unverified, no SMS provider is needed |

## Push notifications (FCM)

| Variable | Where | Value |
|---|---|---|
| `PUSH_PROVIDER` | API host | `fcm` |
| `GOOGLE_APPLICATION_CREDENTIALS` | API host | Path to the Firebase service-account JSON, stored outside the repository (mode `600`) |
| `GOOGLE_SERVICES_JSON_BASE64` | GitHub Actions secret | Base64 of `google-services.json` from the Firebase console, for app builds |

Step-by-step setup, and the device checklist, are in
[`PUSH_NOTIFICATIONS.md`](PUSH_NOTIFICATIONS.md).

## Checking a configuration without starting anything

`npm run dev:api` refuses to start on a misconfiguration and names the
variable — never its value. A Paystack or Brevo mistake is caught at boot in
every environment, not only production.

## After entering real test credentials

Tell Claude the variables are set (not their values). The next step is a
real test-mode run: one Paystack test checkout end to end, and one real
verification email to an approved inbox. Until that run has happened, both
integrations are **adapter-tested against simulated providers only**.
