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
| Test notification (button in staging and development builds) | Only the person who asked, on their own phones | DASH test notification | Payments and account | **Yes**: they asked for it | Opens DASH |

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

## Staging configuration (confirmed 16 October 2026)

| Item | Value |
|---|---|
| Firebase project | DASH APP LAUNCH |
| Project ID | `dash-app-a49c2` |
| Project number | 312353427916 |
| Android app | DASH APP Staging |
| Package (application id) | `com.dashworldng.dash.staging`, which **matches** the staging build: `apps/mobile/app.config.ts` builds `APP_VARIANT=staging` as `com.dashworldng.dash.staging` |
| Firebase Android app ID | `1:312353427916:android:d583f23c4db20bee5e4d69` |
| FCM API (V1) | Enabled |
| Legacy FCM API | Disabled (DASH does not use it) |
| `google-services.json` | Downloaded and verified (David) |
| Service-account key | **Not yet generated** |

None of these values is a secret. Only the service-account key is.

Only the staging Android app is registered. Production
(`com.dashworldng.dash`) and development (`com.dashworldng.dash.dev`) apps
are **not** registered and need David's approval first. That includes the
choice between a separate production Firebase project (recommended: it keeps
production's key and phones wholly apart from staging) and a second app in
this project. The separate Dash AI Firebase project is not used for any of
this.

## How staging is kept off production phones

Four independent locks. Any one of them on its own stops a staging push from
reaching someone using the production app:

1. **Separate databases.** A phone registers with the API its build points
   at. The staging API only knows phones running the staging build.
2. **App-id lock (`PUSH_APP_IDS`).** The staging API accepts registrations
   only from `com.dashworldng.dash.staging`, and sends only to devices
   recorded with that id. A production build, the legacy Android shell, or a
   client that does not say which build it is, is refused (403).
3. **Project lock (`FCM_PROJECT_ID`).** At startup the API checks that its
   service-account key belongs to `dash-app-a49c2` and refuses to start
   otherwise. A staging API cannot be run on a production key, a Dash AI key,
   or any other project's key.
4. **Build lock.** The staging APK workflow refuses a `google-services.json`
   that is not for project `dash-app-a49c2` or does not register
   `com.dashworldng.dash.staging`.

Firebase itself adds a fifth: a token can only be sent to with a key from the
project that issued it.

## What David must do (in this order)

### 1. Put `google-services.json` where the build reads it

It is not in the repository and must never be committed (it is git-ignored).

**For staging APKs built by GitHub Actions** (the usual path):

1. Base64-encode it without line wraps:

   ```sh
   base64 -w0 google-services.json                 # Linux
   base64 -i google-services.json | tr -d '\n'     # macOS
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("google-services.json"))   # Windows PowerShell
   ```
2. GitHub → `Dash-World-Limited/DASH-APP` → **Settings → Secrets and
   variables → Actions → New repository secret**:
   - Name: **`GOOGLE_SERVICES_JSON_BASE64`**
   - Value: the base64 text.
3. Run **Mobile arm64 release APK** on `claude/dash-app-production-release`
   (after this PR is merged), or on this PR's branch for a test build. The log
   step "Provide the Firebase client configuration" must say:
   `Push-enabled staging build: google-services.json is Firebase project dash-app-a49c2 and registers com.dashworldng.dash.staging.`

**For a local build on your PC** (optional):
`apps/mobile/google-services.json`, plus `GOOGLE_SERVICES_JSON` set to its
full path, before `expo prebuild` / `expo run:android`.

**Production, later:** add the production file as a secret with the **same
name in the `production` environment** (Settings → Environments →
production). An environment secret overrides the repository secret for the
production workflow only. Set the repository variable
`DASH_PRODUCTION_FIREBASE_PROJECT_ID` to the production project so that
build is pinned too.

EAS is not used, so no EAS credential is needed. The app uses its native FCM
token, not an Expo push token.

### 2. Generate the server key, on your laptop

1. <https://console.firebase.google.com> → project **DASH APP LAUNCH**
   (`dash-app-a49c2`). Check the project name at the top before you continue;
   **not** the Dash AI project.
2. ⚙ **Project settings → Service accounts → Firebase Admin SDK →
   Generate new private key → Generate key**. A file named like
   `dash-app-a49c2-firebase-adminsdk-….json` downloads.
3. Treat it as a password. Do not email it, paste it into chat, put it in
   GitHub or a ticket, or copy it into the app.

### 3. Install it on the staging API host

Run on the staging server (adjust `dash` to the user the API runs as):

```sh
# copy it up from the laptop (any secure method; scp shown)
scp dash-app-a49c2-firebase-adminsdk-*.json <you>@<staging-host>:/tmp/fcm-key.json

# on the server: outside the repository, readable only by the API's user
sudo install -d -m 750 -o root -g dash /etc/dash
sudo install -m 600 -o dash -g dash /tmp/fcm-key.json /etc/dash/firebase-service-account.json
shred -u /tmp/fcm-key.json        # or rm, if shred is not available
```

Then delete the downloaded copy from the laptop, or move it into your
password manager.

### 4. Set the staging API environment

In the staging API's environment (where its other secrets, such as
`DATABASE_URL`, are set):

```
PUSH_PROVIDER=fcm
GOOGLE_APPLICATION_CREDENTIALS=/etc/dash/firebase-service-account.json
FCM_PROJECT_ID=dash-app-a49c2
PUSH_APP_IDS=com.dashworldng.dash.staging
```

With `PUSH_PROVIDER=fcm`, the API refuses to start, naming the variable,
when any of the other three is missing or malformed, **in every environment**
(connected staging runs with `NODE_ENV=development`). It also refuses to
start if the key is not a service account of `dash-app-a49c2`.

### 5. Apply the migrations, then restart the API

Apply `20261017000000_push_notifications` and `20261018000000_push_app_ids`
(both additive), deploy the API build containing this PR, and restart it.
Then check its startup log for:

```
push: Firebase Cloud Messaging configured   {"project":"dash-app-a49c2","apps":["com.dashworldng.dash.staging"]}
push: Firebase credential verified          {"project":"dash-app-a49c2"}
```

`push: Firebase credential could not be verified` means Google refused the
key; its `reason` is the error code (see Troubleshooting). Nothing from the
key file is ever logged.

### 6. Play Console (before a store upload)

`DATA-SAFETY.md` now declares the push token under **Device or other IDs**
(collected, optional, app functionality). Update the Data Safety form to
match before the next upload.

## Testing on the Samsung Galaxy A55

Use a staging APK built **after** step 1, against the staging API after steps
2–5.

1. **Install** the new APK. If an older staging APK is installed, install
   over it; DASH keeps your sign-in.
2. **Sign in.** Android shows "Allow DASH (staging) to send you
   notifications?" once. Tap **Allow**.
3. **Samsung battery settings, for reliable testing:** Settings → Apps →
   DASH (staging) → Battery → **Unrestricted**. Also check Settings → Battery
   → Background usage limits: DASH must not be under "Sleeping apps" or "Deep
   sleeping apps", or Samsung may hold notifications while the phone sleeps.
4. **Check the categories:** Settings → Apps → DASH (staging) → Notifications
   shows Delivery offers, Order updates, Messages, Payments and account. All
   should be on.
5. **Test notification, app in the background:** in DASH, open
   Account (customer) or Profile (rider) → **Notifications → Send a test
   notification**. The app says it will arrive in about 10 seconds. Press
   Home or lock the phone. "DASH test notification" should arrive.
   - If the app instead says the service **is not connected to Firebase**,
     the staging API is still on `PUSH_PROVIDER=console`. Recheck step 4.
   - If it says **No phone is registered**, notifications were not allowed or
     the APK was built without the Firebase file. Recheck step 1 and the
     notification permission.
6. **Test notification, app closed:** tap Send again, then swipe DASH away
   from Recents. It should still arrive. Tap it: DASH opens.
7. **Real events:** run the full checklist below: order updates, offers,
   chat, support replies, the Notifications switch, and sign-out.

Do not count a step as passed until the notification is seen on the phone.
A "queued" or "sent" answer from the server is not proof of delivery.

## Troubleshooting

| What you see | Meaning | Fix |
|---|---|---|
| API will not start: `FCM_PROJECT_ID`, `PUSH_APP_IDS` or `GOOGLE_APPLICATION_CREDENTIALS` named | A required push variable is missing or malformed | Set it as in step 4 |
| API will not start: "key belongs to project …" | The key is from another Firebase project | Generate the key in DASH APP LAUNCH (step 2) |
| Log: credential could not be verified, `reason` `app/invalid-credential` | Key revoked, deleted, or the file is not the full key | Generate a new key; replace the file |
| Test: "not connected to Firebase" | API is on `PUSH_PROVIDER=console` | Step 4 |
| Test: "No phone is registered" | The app never registered: permission denied, or no Firebase file in the build | Allow notifications; rebuild the APK with the secret |
| App: "cannot receive notifications from this DASH service" (403 on registration) | The build's package is not in the API's `PUSH_APP_IDS` | Install the staging build; check `PUSH_APP_IDS` |
| Test reason: `messaging/mismatched-credential` | Firebase's "sender ID mismatch": the APK's `google-services.json` and the server key are from different projects | Use the same project (`dash-app-a49c2`) for both |
| Test reason: `messaging/third-party-auth-error` or `messaging/authentication-error` | Google rejected the key for sending | Check FCM API (V1) is enabled; regenerate the key |
| Test reason: `messaging/registration-token-not-registered` | That phone's token is dead (app reinstalled or data cleared) | DASH clears it automatically; open the app so it registers again |
| Server says sent, phone shows nothing | Usually Samsung battery limits, or the channel is turned off | Testing step 3; check the four categories are on |

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

- **Staging:** steps 1–5 above are owner actions. The only staging item not
  yet done is the service-account key (steps 2–4). Until it is configured,
  the staging API sends no real push (`PUSH_PROVIDER=console`), and the
  in-app test says so.
- **Production** needs its own approved Firebase app (or project), its own
  key on the production API with `FCM_PROJECT_ID` and
  `PUSH_APP_IDS=com.dashworldng.dash`, and the production
  `GOOGLE_SERVICES_JSON_BASE64` environment secret. Without them a production
  API will not start with FCM, and the production AAB workflow will not
  start.
- The permissions FCM adds (`POST_NOTIFICATIONS`, `WAKE_LOCK`,
  `com.google.android.c2dm.permission.RECEIVE`) are allowlisted for the
  production manifest check. The first push-enabled staging APK should be
  checked on a device to confirm nothing else was merged in.
- Offers while the rider app is **closed** depend on dispatch still seeing
  the rider as eligible. Rider location is foreground-only, so offers to a
  rider whose app has been closed for longer than the location freshness
  window will not be made. That is dispatch behaviour, intentionally
  unchanged here.
