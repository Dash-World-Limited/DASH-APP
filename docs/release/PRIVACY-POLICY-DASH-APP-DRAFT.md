# DASH Privacy Policy — DRAFT

> **Status: draft, not published, not legally reviewed.** Written by Claude
> from what the DASH app and API actually do (commit `04a8e04` onward). It
> must be approved by David — ideally after review by a qualified Nigerian
> lawyer against the NDPA 2023 — before it is published or seeded as a
> `LegalDocument`. The currently published policy (`seed-legal.ts`,
> `privacy-policy`) covers **only** DASH World Declutters and does not
> describe the DASH delivery app; Google Play requires the policy linked
> from the listing to describe the app.
>
> Publishing a new version: add it to `packages/db/src/seed-legal.ts` as a
> **new version** (never rewrite a published version — acceptances point at
> it) and run `npm run db:seed:reference` against the target database.

---

**DASH World Limited** ("DASH", "we") operates the DASH app and website.
This policy explains what we collect when you use DASH to order from shops,
restaurants, pharmacies and markets, or to work as a DASH rider, and what we
do with it.

## 1. What we collect

1.1 **Account details:** your full name, email address and phone number. We
verify your email address by sending it a code. **We do not currently verify
your phone number**; we never describe it as verified.

1.2 **Profile answers at signup:** your state, city or area, how you plan to
use DASH and how you heard about us. No decision about you depends on them.
We ask you to confirm you are 18 or older; we do not ask for your date of
birth.

1.3 **Delivery addresses:** the street address, an optional landmark and
instructions, a contact phone for the rider, and the map position of the
address.

1.4 **Your location, when you choose:** if you tap "Use my current location"
while adding an address, the app reads your phone's position once, to place
the address. It does not track you.

1.5 **Riders' location while online:** if you are an approved rider and go
online, the app sends your position to DASH about every 20 seconds, only
while you are online **and the app is open**. It stops when you go offline
or put the app away. There is no background tracking. We keep the detailed
trail for 90 days, then keep only a coarse (about 1 km) version.

1.6 **Orders:** what you ordered, from whom, prices and fees, delivery
status and times, notes you add, and the delivery PIN (stored only as a
secure hash).

1.7 **Payments:** you pay on Paystack's own secure page. **We never receive
your card details.** We receive from Paystack whether the payment succeeded,
its amount and reference.

1.8 **Vendor and rider applications:** business or vehicle details you give
when you apply, and the decision we make.

1.9 **Technical records:** our servers record requests (including IP
address) for security, fraud prevention and to investigate faults. The app
contains no advertising or analytics tracking.

## 2. Who sees it

2.1 **The shop** receives your order and, where it needs it, what it needs to
prepare it.

2.2 **Your rider**, after accepting your order, sees your delivery address,
landmark, instructions and the contact phone for the address — never before
accepting. While your order is on its way, you see your rider's name,
vehicle type and position.

2.3 **Service providers** who work for us: Paystack (payments), Brevo
(sending our emails), and our hosting providers. They may use your data only
to provide their service to us.

2.4 We do not sell your data. We share it with authorities only when the law
requires it.

## 3. Why we use it

To create and secure your account; to take, prepare, deliver and support
your orders; to take payment and handle refunds; to dispatch riders and pay
them; to prevent fraud and abuse; to meet legal and accounting obligations;
and, only if you opt in, to send you offers.

## 4. How long we keep it

Sign-in sessions, one-time codes and similar records are deleted after
short periods (days to weeks). Riders' detailed location history is coarsened
after 90 days. Records of orders, payments, refunds and our accounts are kept
as the law requires for financial records.

## 5. Deleting your account

In the app: **Account → Delete account**, confirmed with a code sent to your
email. On the web: **[public URL]/delete-account**. Deletion takes effect
after 14 days, and you can cancel before then. We then delete your sessions,
devices, codes and saved cart, and anonymise your name, email, phone,
addresses, delivery notes and review comments. Order, payment and refund
records are kept for accounting, no longer linked to you. An account under
an open legal or payment dispute is held until it is resolved.

## 6. Your rights

You can ask for a copy of your data, ask us to correct it, or ask us to
delete it, by writing to [privacy contact email].

## 7. Security

Data between the app and our servers is encrypted in transit. Sensitive
details such as vendors' bank accounts are encrypted at rest. Staff access
is protected by two-factor authentication and recorded in an audit log.

## 8. Changes

We will tell you in the app before a change to this policy affects you.

[Contact: DASH World Limited, address, email]
