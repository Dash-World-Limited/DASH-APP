# Samsung A55 — production acceptance checklist

For the **production** build (`com.dashworldng.dash`), installed the way
customers will get it. Record build, device and result at the top; mark each
line ✅ / ❌ with a note, and stop on any ❌ in sections 1–5.

| | |
|---|---|
| AAB | `DASH-<version>-<code>-<sha>.aab` from the production workflow (record its SHA-256) |
| Installed from | Play **internal testing** track (preferred: tests Play App Signing and split APKs) — or `bundletool build-apks --connected-device` from the same AAB |
| Device | Samsung A55, Android version: ___ , One UI: ___ |
| API | production origin: ___ (must not be staging) |
| Tester / date | |

The production app installs beside the staging app (`…dash.staging`); they
do not share data. Use a fresh email address for section 1.

## 1. Install and first launch
- [ ] Launcher shows the DASH icon (not the Android default); long-press → app info says **DASH**, version name and code match the AAB
- [ ] Android 13+ themed icons on: the monochrome DASH mark is used
- [ ] Splash: DASH wordmark on the ivory ground, no Expo/React logo, no white flash
- [ ] Lands on the DASH welcome/sign-in screen, not Home
- [ ] No "Development code" ever appears on the sign-in screen

## 2. Account
- [ ] Create account: all fields validate; Terms and Privacy open from the form and show the **approved** versions with version and date
- [ ] The emailed 6-digit code arrives (from the production sender) and signs you in
- [ ] Sign out, sign back in by emailed code
- [ ] **Cold restore:** force-stop, reopen → still signed in without a code
- [ ] Airplane mode, reopen → "Could not reach DASH" with Try again; turn network on, Try again → signed in

## 3. Customer
- [ ] Home: wordmark (S not clipped, not crowding the A), your initials, six categories
- [ ] Each category opens; real merchants only, or an honest empty state — no invented businesses, ratings or delivery times
- [ ] Search (2+ letters) returns real merchants/items
- [ ] Store → product → add to cart; cart survives an app restart; second merchant prompts "start a new cart"
- [ ] Checkout: add an address (location permission prompt appears **only now**, foreground only), server quote rows shown
- [ ] **Paystack test payment** → return to DASH → "Check payment" confirms → order on the tracking screen
- [ ] Close Paystack without paying → order shows "not finished"; "Pay again" works; nothing is double-charged
- [ ] Tracking updates through vendor and rider steps; delivery PIN shown only while active
- [ ] Cancel an eligible order → server's refund wording; refund stays "pending" until it really is refunded
- [ ] Wallet tab: balance and transactions are the server's (₦0 and empty is correct for a new account)
- [ ] **Order chat** (after a rider is assigned): customer → rider and rider → customer messages both arrive; keyboard does not cover the composer

## 4. Rider
- [ ] Apply to ride from Account; status shows pending; Rider face stays locked until approved
- [ ] After approval: switch to Rider; header shows your **first name only**, no greeting
- [ ] Go online (location prompt, foreground only); map shows your position; go offline
- [ ] Receive an offer, accept; delivery screen shows the **pickup code**; the vendor console accepts it
- [ ] Mark arrived → picked up (code disappears) → on the way → arrived → enter the customer's PIN → complete
- [ ] Earnings and history show the completed delivery
- [ ] Switch back to Customer and back again repeatedly — no crash

## 5. Declutters
- [ ] Declutter category opens the live feed
- [ ] The listings match the website's Declutters marketplace (same items, prices, availability), newest first
- [ ] A listing opens with its photos and details
- [ ] Known limit: the app shows the 40 newest; with more than 40 live listings, the oldest appear only on the website

## 6. Account deletion and legal
- [ ] Account → Terms of Service and Privacy Policy open in-app
- [ ] Account → Delete my account → confirm → scheduled with a date; cancel → kept

## 7. Appearance and resilience
- [ ] Light and Dark (Account → Appearance) — every screen readable in both; status bar legible
- [ ] Airplane mode mid-checkout and mid-delivery: honest errors, recovers when back online, no duplicate order
- [ ] Rotate / split-screen / back gesture on every screen: no crash, back behaves
- [ ] Logcat (`adb logcat -b crash`) empty after the whole pass

## 8. Permissions (Settings → Apps → DASH → Permissions)
- [ ] Only **Location** is listed, "Allow only while using the app" — no background location, camera, microphone, storage, or nearby devices

Sign-off: ____________________ (David)  Date: __________
