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
The rider screens are one live workspace (see `RIDER-EXPERIENCE.md`). Use a
real test order from the vendor console. Never judge an empty map as broken
when no orders exist. Keep **Automatic date and time** on: the offer
countdown compares the server's deadline with the phone's clock.
- [ ] Apply to ride from Account; status shows pending; Rider face stays locked until approved
- [ ] After approval: switch to Rider; header shows your **first name only**, no greeting; Rider Home shows no invented figures ("Owed to you" is the payout ledger's, or absent)
- [ ] Go online (location prompt, foreground only): the map fills the screen with your position; the top bar says **ONLINE** with a pulsing dot; the GPS chip reads "GPS live ±N m"
- [ ] Searching panel: radar animates, "Dispatch checked Ns ago" keeps counting up from 0–8 s; no "Check for orders now" button (only a small Refresh link)
- [ ] **Stationary for 20+ minutes** (phone on a table, DASH open, screen on): still ONLINE, GPS chip stays live, an offer still arrives afterwards
- [ ] Location turned off while online: GPS chip goes stale and the panel warns; turn it back on and it recovers
- [ ] Receive an offer: bronze panel, countdown ring from about 30, shop name and address, distance to pickup (+ "about N min" if shown), trip distance, item count; **no customer name, phone or exact address**
- [ ] While on Rider Home / Orders, an offer shows the bronze **NEW DELIVERY OFFER** banner with seconds left; tapping it opens the workspace
- [ ] Let one offer run out: Accept disables at 0 and the panel returns to searching (and does not reappear on the next poll)
- [ ] Decline one offer: returns to searching
- [ ] Accept: the **same screen** becomes the journey (no page jump); map re-frames on the shop with a dashed straight line; top bar says **ON DELIVERY**
- [ ] **Pickup code** shown; the vendor console accepts it
- [ ] **Navigate** opens Google Maps (or the chosen maps app) with the shop as destination; return to DASH and the journey is unchanged
- [ ] "I've arrived at the shop" → "I have the order" (code disappears) → "Start trip to customer" (map re-frames on the drop-off; customer name/address, Call customer, Chat in DASH now shown) → "I've arrived at drop-off"
- [ ] PIN field: number keypad opens and the field and Complete button stay **above the keyboard**; a wrong PIN shows the server's error; the right PIN completes
- [ ] Delivery complete panel → "Find the next order" returns to searching
- [ ] During a delivery no Go offline control is offered (workspace or Rider Home); going offline while idle works
- [ ] Force-stop mid-delivery and reopen: the delivery and pickup code are restored at the right step
- [ ] Android's reduce/remove-animations setting on (Accessibility): radar and pulse stop, everything still readable
- [ ] Earnings and history show the completed delivery
- [ ] Switch back to Customer and back again repeatedly — no crash
- [ ] Customer tracking map: rider position and home pin joined by a dashed straight line (no wiggly route)

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
