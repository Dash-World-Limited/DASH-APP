# iOS functional parity continuation

Continue the existing `ios/first-native-build` history after verified checkpoint
`36edeb5`. Native compilation/startup and signed-out welcome/sign-in/registration
navigation already passed. Do not restart foundations or modify the APK checkout.

## Staging account boundary

The owner confirmed `https://staging.dashworldng.com` as the staging API origin.
The iOS simulator workflow pins that public origin and does not inherit a possibly
production repository API variable. Read-only checks returned health/readiness
200 and unauthenticated `/v1/auth/me`401. No OTP was requested, account created,
order placed, availability changed or payment initiated on the deployed service.

`packages/db/src/seed.ts` defines fictional Customers (`amaka@dashapp.test`,
`segun@dashapp.test`, `fatima@dashapp.test`) and approved Riders
(`musa@dashapp.test`, `grace@dashapp.test`, `kunle@dashapp.test`,
`peter@dashapp.test`). These are seed definitions, not confirmation of deployed
accounts or usable inboxes. The Asaba setup script references seeded identities;
the staging-admin bootstrap only creates staff access. Neither script was run.
Do not reseed staging or try the development staff password against it.

Owner next action: use the existing staging admin access to confirm a dedicated
Customer and an approved Rider with verified, owner-controlled test inboxes.
Check approval through `/v1/admin/rider-applications` using the normal admin UI
or authorized session. Rider decisions use the existing permission-gated
`/v1/admin/riders/:id/decision` route. Ensure the Rider has the intended test
service zone and a safe test vendor/catalogue. Share only non-secret identifiers;
enter OTPs privately, and disable/redact screenshots, device logs and UI-command
recordings during authentication. Never publish OTPs, auth headers, cookies or
real profile data as CI artifacts. No reusable staging credentials were supplied.

## Functional coverage and next checks

| Area | Code/contract coverage | Still requires real iOS verification |
| --- | --- | --- |
| Customer session | Real provider/client/session tests gate navigation until `/auth/me`, preserve restore retry, clear expired viewer and discard stale refresh/account responses | Email delivery/OTP, native cookie persistence across termination, SecureStore restore, expiry/offline/recovery on simulator/device |
| Customer orders | Existing shared server-backed catalogue/cart/quote/orders/tracking/cancellation architecture retained | Saved address, quote, test order, matching/tracking/history/cancel/retry with dedicated staging data |
| Rider | Existing approved-role gating, availability, offer/accept, pickup/delivery PIN and GPS/resume flow retained; existing tests pass | Approved staging login, online/offline, offers, acceptance, arrival/pickup/start/complete, earnings/history, resume/offline recovery |
| Location/maps | Foreground-only configuration; bounded address GPS lookup; contract tests for refused permission, unavailable fix and approximate accuracy | Native MapLibre tiles/markers, simulated location, denied/restricted/approximate vs precise, Settings recovery and coordinates through checkout |
| Push | Existing APNs-to-FCM safeguard and notification-open routing tests retained | Real iOS token provider, Apple/Firebase configuration, permission/token refresh and foreground/background delivery on a signed physical phone |
| Payment return | Existing web `/pay/complete` emits `dash://orders`; iOS receives warm/cold URLs only inside authenticated navigation; ignores payment-status/order parameters; protects active Rider delivery | Actual Paystack test-mode success/cancel/failure and cold/warm browser returns with the staging account |
| Lifecycle | Shared request refresh and foreground resume/poll paths retained; stale-session race regression tests added | Active order across suspension, network loss/recovery, permission changes, identity/session expiry, notification opens |
| Distribution | Staging ID `com.dashworldng.dash.staging`, production `com.dashworldng.dash`; iOS buildNumber follows existing DASH_VERSION_CODE; native configuration contract checks generated CFBundleVersion | Apple team, registered identifiers/capabilities, profiles, signed archive/device/TestFlight, privacy/export declarations |

These unit/component tests substitute HTTP/device boundaries. They do not prove
live staging authentication, payment settlement, native cookies or APNs delivery.
The existing optional `npm run e2e:journey` uses a disposable local SQLite/API and
fictional data; it is backend journey evidence only, not an iOS device journey.

## Payment and lifecycle limits

The callback merely opens the signed-in Customer Orders tab. The server remains
the only payment authority. Tracking checks a pending payment on resume and
mount; Wallet checks pending card setup on resume/reopen. No URL creates an
order, settles a payment, grants a role or chooses another customer's order.
The callback does not include an order ID, so it cannot reopen a specific order.
Android's existing link behavior is deliberately unchanged by this iOS fix.
No universal links/associated domains are configured; browser callbacks rely on
the existing custom scheme. There is no Google Sign-In in the mobile client.

Location updates and polling are foreground features. iOS can suspend the app;
neither JavaScript timers nor a foreground location watch guarantee background
tracking/offers. Background GPS, background delivery and guaranteed rider offers
are not enabled or claimed. Do not add Always location/background modes just to
make a parity checklist green.

## Push and signed-device owner boundary

The backend uses FCM registration tokens. Expo's native iOS token is APNs and is
intentionally not registered. Before enabling delivery, register the correct
Apple bundle ID in the staging Firebase project, select a real iOS FCM client
integration (or separately implement APNs delivery), and configure APNs via the
owner's secure Firebase/Apple tooling. Do not send private keys to chat or Git.
Then validate actual signed-device permission, token refresh/logout, account and
Customer/Rider routing, foreground suppression and background notification opens.
Simulator success is not proof of APNs delivery.

Generated staging entitlements currently contain `aps-environment=development`
from the notification plugin. A signed target must have matching Apple team,
identifier, push capability and provisioning; review the resolved entitlement
for its actual development/distribution profile. The unsigned simulator ZIP is
not installable on a physical phone. No signing credentials were created or
requested. No associated-domains entitlement was invented.

Owner next action for physical testing: confirm Apple Developer team access and
the staging bundle identifier in Apple Developer, register the test device or
choose TestFlight, and arrange signing in secure build tooling. Before a release,
review privacy/location disclosures, encryption/export answers and App Store
Connect metadata. Increment `DASH_VERSION_CODE` for each upload; it now also
sets iOS `buildNumber`. Review production configuration separately: the current
shared production preflight still requires Android Google-services configuration.
Do not weaken Android production guards or claim signed-production readiness
until that platform-specific configuration and Apple/Firebase setup are complete.

Use `IOS_SIMULATOR.md` for locked native reproduction. Retain the history secret
gate, private-file hygiene and locked dependencies for every new native build.
The native signed-out test also opens `dash://orders` warm and cold to prove that
the URL cannot bypass authentication. Authenticated native routing still needs
the owner-provided staging accounts above.
