# Push notifications (Android, FCM) — how they work and what David sets up

DASH sends Android push notifications through **Firebase Cloud Messaging
(FCM, HTTP v1 API)** so customers and riders hear about orders, offers,
messages and support replies while the app is in the background or closed.
Polling and realtime inside the app are unchanged; push covers the time the
app is not on screen.

Nothing in this repository contains a Firebase credential. Two Firebase files
exist, and both are supplied outside the repo:

| File | What it is | Where it goes | Secret? |
|---|---|---|---|
| `google-services.json` | Firebase's **client** configuration for the Android app | Build time only: GitHub secret `GOOGLE_SERVICES_JSON_BASE64` → written to the runner's temp dir → `GOOGLE_SERVICES_JSON` → `app.config.ts` | Not a credential (it ships inside every APK), but kept out of git anyway |
| Firebase **service-account** JSON | The **server** credential that lets the API send pushes | Only on the API host, outside the repo: `GOOGLE_APPLICATION_CREDENTIALS=/path/to/file` | **Yes — private key.** Never in the repo, the app, a GitHub secret for the app, a chat or an email |

## How it works

1. After sign-in, the app creates its Android notification channels, asks
   Android for notification permission **once** (Android 13+; older Android
   grants it), gets the device's FCM token, and registers it with
   `POST /v1/devices` together with the phone's **Notifications** switch for
   that account. It re-registers when FCM rotates the token (naming the old
   token so the server retires it), when the switch changes, and on return
   to the app (at most every 15 minutes). Signing out unregisters the phone
   first, and the server also clears the token when the session ends.
2. When something happens, the API writes a **push intent** (identifiers
   only) to the transactional outbox **in the same database transaction** as
   the change. If the change rolls back, no push is owed. If Redis or FCM is
   down, the outbox and queue retry later. The order, message, reply or
   refund never waits on, or fails because of, a push.
3. A queue worker reads current state, picks the recipient, checks their
   account is active and their phone's switch, claims the event in the
   durable idempotency store (so a retried job never sends twice), and sends
   through FCM. Tokens FCM reports dead are cleared. Failures are logged as
   counts and reasons only: never a token, a name, or message text.

### What is sent, to whom

| Event | Who | Title (lock-screen text) | Android channel | Sent when switch is OFF? | Tap opens |
|---|---|---|---|---|---|
| New delivery offer | The offered rider | New delivery offer | Delivery offers (max) | **Yes**: the rider chose to be Online | Rider live workspace (shows the offer) |
| Shop accepted the order | Customer | Order accepted | Order updates | No | Order tracking |
| Rider assigned | Customer | Rider on the way | Order updates | No | Order tracking |
| Order picked up | Customer | Order picked up | Order updates | No | Order tracking |
| Rider arrived at drop-off | Customer | Your rider has arrived | Order updates | No | Order tracking |
| Delivered | Customer | Order delivered | Order updates | No | Order tracking |
| Order cancelled | Customer | Order cancelled | Order updates | No | Order tracking |
| Order cancelled | The rider carrying it | Delivery cancelled | Order updates | **Yes**: they are carrying it | Rider orders |
| Shop could not take the order | Customer | Order not accepted | Order updates | No | Order tracking |
| Order chat message | The *other* participant | New message from your rider / customer | Messages | No | Order chat (customer: on top of tracking) |
| DASH Support reply | The conversation's owner, in the role they wrote as | DASH Support replied | Messages | No | Support chat (customer or rider) |
| Refund completed (confirmed with Paystack) | Customer | Refund completed | Payments and account | No | Order tracking |
| Unpaid order closed by reconciliation | Customer | Order cancelled | Payments and account | No | Order tracking |

"Rider arrived at the shop" and "en route" are deliberately not pushed:
they arrive seconds after "picked up" and would buzz the customer twice for
one moment. Statuses that a newer pushed status has already overtaken are
dropped, so a slow queue never shows "picked up" after "arrived".

A push **never** contains a name, address, phone number, amount, bank
detail, card detail or the words of a message. Its data is a type, which
side of the app it is for, and an order, offer or support conversation id.
This is enforced by an allowlist (`packages/domain/src/push`) and checked
again just before sending.

While the app is open, a push is shown as a banner **unless** the screen in
front of the person already shows it (the same order chat, the same order's
tracking, the support chat, or any rider screen for an offer, since the rider
face already shows a live offer banner).

## What David must do (in this order)

### 1. Firebase project and Android apps

1. Go to <https://console.firebase.google.com> and create (or open) the DASH
   Firebase project. Google Analytics is **not** needed; leave it off.
2. **Add app → Android** three times, with these package names exactly:
   - `com.dashworldng.dash` (production)
   - `com.dashworldng.dash.staging` (staging APKs)
   - `com.dashworldng.dash.dev` (development builds, optional)

   No SHA-1 certificate is needed for push.
3. After all apps are added, open **Project settings → General → Your apps**
   and **download `google-services.json`**. One file covers every app in the
   project. The build checks that it contains the package being built.
4. In <https://console.cloud.google.com> for the same project, confirm
   **Firebase Cloud Messaging API (V1)** is **Enabled** (APIs & Services).
   The legacy FCM API is not used and does not need enabling.

### 2. GitHub secret for the app builds

Base64-encode the file without line wraps and store it as a GitHub Actions
secret named **`GOOGLE_SERVICES_JSON_BASE64`** (repository secret, or in the
`production` environment for the production workflow):

```sh
base64 -w0 google-services.json        # Linux
base64 -i google-services.json | tr -d '\n'   # macOS
```

- **Staging APK** (`mobile-release-apk.yml`): optional. Without the secret
  the APK builds and runs, but cannot receive push. With it, the job checks
  the file registers `com.dashworldng.dash.staging`.
- **Production AAB** (`mobile-production-aab.yml`): **required**. The job
  refuses to start without it and checks the file registers
  `com.dashworldng.dash`.

EAS is not used to build DASH (GitHub Actions runs `expo prebuild` and
Gradle), so no EAS credentials are needed for push. If an EAS build is ever
used instead, upload `google-services.json` as an EAS **file** environment
variable named `GOOGLE_SERVICES_JSON`; `app.config.ts` reads the same name.

For a local development build, put the file at
`apps/mobile/google-services.json` (git-ignored) and set
`GOOGLE_SERVICES_JSON=$PWD/apps/mobile/google-services.json` before
`expo prebuild` / `expo run:android`.

### 3. Server credential for the API (staging and production hosts)

1. Firebase console → **Project settings → Service accounts → Firebase Admin
   SDK → Generate new private key**. This downloads a JSON key for the
   `firebase-adminsdk-…` service account, which can send FCM messages. (A
   custom service account with the **Firebase Cloud Messaging API Admin**
   role also works.)
2. Copy it to the API host **outside the repository**, readable only by the
   API's service user, for example:
   `/etc/dash/firebase-service-account.json` with mode `600`.
3. Set in the API environment, then restart the API:

   ```
   PUSH_PROVIDER=fcm
   GOOGLE_APPLICATION_CREDENTIALS=/etc/dash/firebase-service-account.json
   ```

   In production the API refuses to start with `PUSH_PROVIDER=console`, or
   with `fcm` and no `GOOGLE_APPLICATION_CREDENTIALS`.
4. The key must come from the **same Firebase project** as
   `google-services.json`. A key from another project gets every token
   rejected.
5. Treat the key like a password: never paste it into chat, email, a ticket
   or the repository. If it leaks, delete it under **Service accounts** and
   generate a new one.

There are no new API environment variables beyond these two existing ones.

### 4. Database migration

Apply `20261017000000_push_notifications` (SQLite and PostgreSQL versions) on
staging, then production, **before** deploying the API build that needs it.
It is additive: `Device.pushEnabled` (default on) and
`Order.pushNotifiedStatus`, backfilled from each order's current status so no
existing order sends a late push.

### 5. Play Console

`DATA-SAFETY.md` now declares the push token under **Device or other IDs**
(collected, optional, app functionality). Update the Data Safety form to
match before the next upload.

## Physical-device acceptance checklist

Use a staging APK built **after** step 2, and a staging API set up as in
steps 3 and 4. Use two phones (customer and rider), or one phone plus the web
for the vendor and Super Admin. Tick each line. "Background" means pressed
Home; "closed" means swiped away from Recents.

**Registration and permission**
- [ ] Fresh install, sign in as a customer: Android 13+ shows the
      notification prompt **once**. Allow it.
- [ ] Sign out and in again: no second prompt.
- [ ] Android Settings → Apps → DASH (staging) → Notifications shows
      four categories: Delivery offers, Order updates, Messages, Payments
      and account.

**Customer order updates**
- [ ] Place an order, background the app. Vendor accepts on the web: one
      "Order accepted" notification. Tap it: the app opens that order's
      tracking.
- [ ] Close the app. Rider marks the order picked up: "Order picked up"
      arrives. Tap it: the app cold-starts on that order's tracking.
- [ ] Rider marks "arrived": "Your rider has arrived". Complete delivery:
      "Order delivered".
- [ ] Rider-arrived-at-shop and en-route produce **no** notification.
- [ ] Each event produces exactly **one** notification; an order's
      notifications replace each other in the tray rather than stacking.

**Rider**
- [ ] Rider online, app in background (within the location freshness
      window): a new offer shows "New delivery offer". Tap it: the live
      workspace opens on the offer.
- [ ] Rider carrying an order, customer cancels (or ops cancels): rider
      gets "Delivery cancelled".

**Order chat**
- [ ] Customer sends a message while the rider's app is in the background:
      rider gets "New message from your customer". Tap: the delivery chat
      opens. The notification does **not** show the message text.
- [ ] Reverse direction: customer gets "New message from your rider". Tap:
      tracking with the chat on top; Back returns to tracking.
- [ ] With the chat for that order open on screen, a new message shows
      **no** banner (the chat updates itself).

**Support**
- [ ] Customer writes in Help → Chat with DASH, closes the app. Super Admin
      replies at `/admin/support`: "DASH Support replied". Tap: the customer
      support chat opens.
- [ ] Same for a rider (Profile → Help → Chat): the reply opens the rider
      support chat.

**Notifications switch (Batch 1 setting)**
- [ ] Customer: Account → Notifications OFF. Order updates and chat
      messages no longer arrive. Turn ON: they arrive again. The switch
      keeps its value after restarting the app.
- [ ] Rider: switch OFF. Offers and "Delivery cancelled" **still** arrive;
      chat and support replies do not.
- [ ] Deny the Android prompt (or turn DASH off in Android settings), then
      open Notifications: the screen says Android is blocking DASH and
      offers **Open phone settings**.

**Accounts and roles**
- [ ] Sign out, then trigger an order update for that account: the phone
      receives **nothing**.
- [ ] Sign in as a different account on the same phone: only the new
      account's notifications arrive.
- [ ] An account that is both customer and rider, on the rider face with no
      delivery in progress: tapping a customer notification switches to the
      customer face and opens the order. With a delivery in progress, the
      tap leaves the rider on the delivery.
- [ ] Uninstall and reinstall, sign in: notifications arrive again.

**Lock screen**
- [ ] On the lock screen, no notification shows a name, address, phone
      number, amount, PIN, bank detail or message text.

## Still needed before production

- Steps 1–5 above are owner actions. Without the service-account key on the
  API and `PUSH_PROVIDER=fcm`, a production API will not start; without
  `GOOGLE_SERVICES_JSON_BASE64`, the production AAB workflow will not start.
- The permissions FCM adds (`POST_NOTIFICATIONS`, `WAKE_LOCK`,
  `com.google.android.c2dm.permission.RECEIVE`) are allowlisted for the
  production manifest check. The first push-enabled staging APK should be
  checked on a device to confirm nothing else was merged in.
- Offers while the rider app is **closed** depend on dispatch still seeing
  the rider as eligible. Rider location is foreground-only, so offers to a
  rider whose app has been closed for longer than the location freshness
  window will not be made. That is dispatch behaviour, intentionally
  unchanged here.
