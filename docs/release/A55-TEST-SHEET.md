# Samsung A55 — manual test sheet

Tick each box only after you have seen it happen on the phone. Write down
anything that differs, with the time, so it can be matched to the server log.
Use **Paystack test mode** only; no real card is ever used.

## 0. Setup (once)

**On the PC** (`C:\Users\admin\Desktop\dash-app`):

1. In `.env`: `API_HOST=0.0.0.0`, `PUBLIC_WEB_URL=http://<PC-LAN-IP>:3000`,
   and the Paystack/Brevo values from `ENVIRONMENT.md`. Find the LAN IP with
   `ipconfig` (IPv4 address of the Wi-Fi adapter, e.g. `192.168.1.23`).
2. `npm run db:push && npm run db:seed` (development data on this PC only).
3. `npm run dev` — starts the API on :4000 and the website on :3000.
4. When Windows asks about Node.js, allow **Private networks** only.
5. On the phone's browser, open `http://<PC-LAN-IP>:4000/health` — it must
   answer. If not, the phone cannot reach the PC; fix that first.

**The app:** a debug APK built with
`EXPO_PUBLIC_API_URL=http://<PC-LAN-IP>:4000` (ask Claude to build it for your
IP, or see `SIGNING.md` for building). Debug builds may use `http://` on
your Wi-Fi; release builds require HTTPS.

**Accounts you need:** two email inboxes you can open on the phone (customer
and rider), and the founder staff account with its authenticator app, for
approvals on the website (`http://<PC-LAN-IP>:3000/ops/partners`).

## 1. Install

- [ ] 1.1 Fresh install: uninstall any DASH, install the APK. It opens without crashing.
- [ ] 1.2 Upgrade: install a newer APK over the old one. You stay signed in; your cart is still there.

## 2. Registration and email code

- [ ] 2.1 Sign in → "New to DASH? Create an account". Submit the empty form: every problem is shown at once.
- [ ] 2.2 Phone field shows: "Phone added · Verification not currently required during early access." No tick, no "verified" anywhere.
- [ ] 2.3 Fill it in, submit. A 6-digit code arrives in the inbox (Brevo). Note how long it took.
- [ ] 2.4 Enter a **wrong** code → "not valid or has expired". You are not signed in.
- [ ] 2.5 Tap "Send a new code". Enter the **first** code → refused. Enter the **new** code → signed in.
- [ ] 2.6 Register again with the **same** email → the screen says the same as before ("check your email"); nothing reveals the account exists; your account is unchanged.
- [ ] 2.7 Wait until a code expires (5 minutes), then enter it → refused.
- [ ] 2.8 Five wrong codes in a row → "Too many incorrect attempts. Request a new code."
- [ ] 2.9 Close the app during the code step, reopen → sign in with a code instead; it works.

## 3. Sign in, sign out, session

- [ ] 3.1 Sign out → Sign in with a code → signed in.
- [ ] 3.2 Close the app completely, reopen → still signed in, no "Sign in" flash.
- [ ] 3.3 Airplane mode, reopen the app → it does not claim you are signed out; it retries when back online.
- [ ] 3.4 A phone number cannot be used to sign in (codes go by email only).

## 4. Browse and cart

- [ ] 4.1 Home → Shops → a store → a product with options. Prices match the store.
- [ ] 4.2 Search for a product (2+ letters) → results; nonsense → an empty state, not an error.
- [ ] 4.3 Add items; change quantity; remove one. Try adding from a second store → the app explains one store per cart.
- [ ] 4.4 Close the app, reopen → the cart is still there.

## 5. Address and location

- [ ] 5.1 Checkout with no address → the new-address form. Tap "Use my current location" → Android asks for location → **Deny** → the app explains, nothing breaks.
- [ ] 5.2 Tap again → Allow → "Location found". Fill the street and phone, save. The address is selected.
- [ ] 5.3 Deny with "Don't ask again", tap again → the app offers "Open Settings".

## 6. Checkout and Paystack (test mode)

- [ ] 6.1 The summary shows items, delivery fee, service fee and total. There is no cash or wallet option.
- [ ] 6.2 Tap Pay → Paystack's page opens in the browser. Pay with a Paystack **test success** card.
- [ ] 6.3 Return to DASH → the order screen checks payment and shows "Payment confirmed"; status becomes placed. The delivery PIN is shown.
- [ ] 6.4 New order → on Paystack, **close the page without paying**, return → "Payment not finished", with Open Paystack / Check payment. Nothing is marked paid.
- [ ] 6.5 New order → Paystack **test decline** card → return → "did not go through", "Pay again" offered. Pay again with the success card → confirmed. Only **one** charge appears in the Paystack test dashboard for that order.
- [ ] 6.6 During payment, close the DASH app completely; pay; reopen DASH → Orders → the order → it checks and shows the truth.
- [ ] 6.7 Tap Pay twice quickly → only one order is created.
- [ ] 6.8 Airplane mode at the moment you tap Pay → a clear error; turn Wi-Fi back on, tap Pay → only one order exists.

## 7. Vendor (website)

- [ ] 7.1 On the website, sign in with a third inbox and open `/vendor/apply`. Apply (capture the location at the store). The page shows "Pending admin approval"; `/vendor` refuses access.
- [ ] 7.2 Founder at `/ops/partners` → asked for the authenticator code → Approve. The vendor console now opens for that account without signing in again.
- [ ] 7.3 The paid order from 6.2 appears in the vendor console → Accept → set preparation time → Mark preparing → Ready.
- [ ] 7.4 Suspend the vendor at `/ops/partners` (reason required) → the vendor console refuses at once; the store disappears from the app. Reinstate → works again.

## 8. Rider

- [ ] 8.1 With the second account: Account → "Become a DASH rider" → apply. The account shows "Pending admin approval"; "Switch to Rider" is **not** offered.
- [ ] 8.2 Founder approves at `/ops/partners`. In the app, Account → Switch to Rider appears.
- [ ] 8.3 Go Online → Android asks for location (foreground) → allow. "Online". Deny instead → the app stays Offline and says why.
- [ ] 8.4 When an order is being prepared nearby, an offer opens with a countdown. Decline → it goes away. Next offer → Accept → the job opens with the customer's address (not shown before accepting).
- [ ] 8.5 Two riders online, both accept the same offer at the same moment → one gets it; the other is told someone else took it.
- [ ] 8.6 Navigate to the shop (Google Maps opens) → "arrived at the shop" → "picked up" → "start the delivery" → "arrived at the customer".
- [ ] 8.7 On the customer phone, the order shows each step. The rider's name and vehicle appear while on the way.
- [ ] 8.8 Rider enters a wrong PIN → refused. The customer's PIN → Delivered. The customer's order shows delivered.
- [ ] 8.9 Put the rider app in the background for 20 minutes while online → the rider stops being offered orders (no background tracking). Reopen → reports again.
- [ ] 8.10 Close the rider app while online, reopen → it resumes Online from the server's record.

## 9. Cancellation and refunds

- [ ] 9.1 Cancel a paid order before the shop accepts → the app says the full amount is owed back and is returned after review through Paystack. It never says "refunded".
- [ ] 9.2 Cancel an unpaid order → "No payment was taken".

## 10. Permissions, network, lifecycle

- [ ] 10.1 Settings → Apps → DASH → Permissions: only Location is listed (no camera, contacts, storage, notifications).
- [ ] 10.2 Slow/unstable Wi-Fi: loading states appear; nothing shows a success that did not happen.
- [ ] 10.3 Rotate, lock and unlock during checkout and during a delivery → no crash, no duplicate order.
- [ ] 10.4 Every button you tried did something or explained why it cannot yet. Write down any that did nothing.

## 11. Account deletion

- [ ] 11.1 Account → Delete account → read the summary → Delete my account → a code arrives → enter it → "scheduled" with a date 14 days ahead.
- [ ] 11.2 "Keep my account" → the deletion is cancelled.
- [ ] 11.3 On the website `/delete-account`, signed in → the same works there.

## 12. At the end

- [ ] No crashes. If there was one, note the time and what you did.
- [ ] Take the store screenshots from real screens during this run (Play needs 2–8).
