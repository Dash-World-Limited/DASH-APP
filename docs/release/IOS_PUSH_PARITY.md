# iOS push readiness — 23 October 2026

The release-candidate branch adds an optional native iOS FCM token/refresh bridge
to the existing registration architecture. Its Firebase client is validated by
exact bundle and explicit project pin; Android autolinking/token behavior stays
on Expo. Credential-free iOS generation remains supported. Real configured SDK
compilation, APNs delivery and signed-device behavior still require owner setup.
See [IOS_RELEASE_CANDIDATE.md](IOS_RELEASE_CANDIDATE.md) for the current source,
configuration gates and precise remaining integration/device boundaries.

The record below is historical and describes the earlier accepted checkpoint.

# Historical iOS push parity checkpoint — 19 October 2026

Audit started from clean `ios/first-native-build` at
`5e5cc05b1917c20af4ea4d54de7f336994bf71a3`. Its accepted native build/startup
and signed-out navigation results remain the baseline. This checkpoint does
**not** enable iOS push registration or prove Apple/Firebase delivery.

## Existing architecture, audited before editing

| Area | Existing implementation | iOS gap / status |
| --- | --- | --- |
| Device registration | `src/data/devices.ts` uses the authenticated `POST /v1/devices` and `DELETE /v1/devices`. The server binds identity from the session, enforces app ID, replaces tokens and links the session for logout. | Backend already accepts `platform: ios`. Client registration is intentionally Android-only and sends `platform: android`; do not enable it until a real iOS FCM token provider exists. |
| Token acquisition | `src/v2/push/pushRegistration.ts` gets Android FCM tokens through Expo. | Expo's iOS native token is APNs, not FCM. No iOS Firebase messaging SDK, Apple client configuration or FCM token bridge is installed/wired. The APNs-to-FCM rejection remains. |
| Refresh / resume | `usePushNotifications.ts` subscribes to Expo token events, syncs after sign-in/preference changes and retries on resume; successful registrations throttle resume sync to 15 minutes. | An iOS Firebase **FCM** token-refresh subscription is still needed with the real SDK; Expo's APNs token event alone is insufficient. Pending token/preference events were dropped by the running guard; this checkpoint coalesces and drains them, cancelling queued work when identity changes. |
| Foreground | Expo notification handler and existing `showInForeground` suppress updates already visible in the app. | Installed Expo SDK 57 exposes direct-FCM/APNs custom data in `trigger.payload`, while remote `content.data` reads the Expo-service `userInfo["body"]` wrapper. The old reader missed that payload. Corrected without changing the sender or creating another handler. |
| Background / cold open | APNs/FCM displays alert notifications; Expo supplies live responses and the cached response that launched the app. There is no separate background order/payment authority. | Corrected raw iOS payload reading and cached-response lifecycle races. No silent/data-only background execution or killed-app delivery is claimed. |
| Navigation | Existing `readPushData`, `notificationTarget` and `openPushTarget` validate identifiers, require an authenticated viewer/approved Rider and protect active Rider deliveries. Screens fetch authoritative state from existing authenticated APIs. | A Customer tap could switch away before initial Rider assignment restoration completed. Added actual restoration readiness to the existing provider and an iOS-only navigation guard; a confirmed empty workload/completed delivery does not remain blocked. |
| Permission / settings | Existing per-install ask-once policy, per-account preference and permission reads on resume. Android creates its four notification channels. | iOS deliberately does not prompt for unavailable FCM registration. Removed the contradictory iOS Rider claim that essential pushes would still arrive; Android text and test controls remain unchanged. |
| Logout | Session provider calls device unregistration before API logout; server logout also revokes the linked device. Stored previous-token key supports future replacement. | Added iOS cached-tap clearing independently of FCM/API configuration. A native cache failure does not skip server unregistration or block logout. |
| Sender / native config | Existing Firebase Admin sender already includes `notification`, custom identifier `data`, and APNs collapse/priority headers. Expo notifications supplies push entitlement configuration. | No parallel sender, Expo push service, backend/schema/seed change, new SDK dependency, signing profile or permission was added. Entitlements in an unsigned simulator do not establish signed-device readiness. |

Local native-source evidence for the payload mismatch:
`apps/mobile/node_modules/expo-notifications/ios/ExpoNotifications/Notifications/NotificationRecords.swift`:
`NotificationTriggerRecord` exposes remote `request.content.userInfo` as `payload`;
`NotificationContentRecord.serializedNotificationData` returns only
`userInfo["body"]` for a remote trigger. DASH's existing FCM sender supplies custom
identifiers at the top level. The corrected reader uses this existing Expo record
and passes it through the existing identifier/role validation.

## Real source behavior changed

- Direct-FCM iOS notification data now reaches the existing foreground and tap
  routing functions through `trigger.payload`. Local triggers are not interpreted
  as remote payloads. Android keeps its existing content/remote-message paths.
- Subscribe to live taps before reading the cached cold response. A newer warm
  tap wins, and an unmounted reader cannot consume/clear a response intended for
  the next authenticated mount.
- Keep a working Rider face during initial assignment restoration, including
  when `/auth/me` already says `on_delivery` but detail has not loaded. Successful
  empty/completed restoration releases that temporary guard. Existing approved
  role and active-delivery protections remain.
- Re-read token/preference values once after changes received during an existing
  registration. Discard queued work when the account changes/unmounts. Passive
  resume throttling and Android's permission/registration contract remain.
- Clear the iOS cached notification response on explicit logout, even when the
  build has no FCM token/API configuration. Keep server token cleanup independent.

Regression tests exercise these boundaries with native/HTTP substitutes. They
are not notifications delivered through Apple/Firebase and do not prove a real
token, permission grant or delivery. No live service was asked to register a
token or send a notification.

## Exact owner integration boundary

Owner confirmed the staging Firebase Apple app and local client-file path are
**not confirmed**. The expected staging bundle is `com.dashworldng.dash.staging`;
no local `apps/mobile/GoogleService-Info.plist`, configured iOS client path or
installed iOS FCM SDK was found at the expected integration points. An ignored
generated project is not proof of Firebase setup; do not search for or invent
another project's credentials.

Required next inputs/actions:

1. Owner confirms/registers the **Apple app for this exact staging bundle** in
   the Firebase project used by the existing staging FCM backend, then provides
   the local ignored path to its downloaded **client** `GoogleService-Info.plist`.
   It is not an Admin service-account key. Do not commit the plist or paste its
   contents into chat. Existing ignores/private-file gates remain in force.
2. With that identified client, wire a real iOS native FCM SDK/token provider into
   the **existing** `deviceToken`/registration/refresh path, set the existing
   registration platform to iOS only for that real provider, and connect its FCM
   token refresh events. Validate project/bundle configuration and preserve the
   existing Android native dependencies and behavior. Do not add a speculative
   SDK/framework configuration or a stub token provider before this boundary is
   resolved. Source integration is still required; this is not credentials-only.
3. Owner arranges Apple Developer team/bundle push capability, matching signing
   and provisioning, and configures APNs authentication securely in Firebase.
   APNs `.p8` keys, signing keys/profiles and Admin JSON never belong in this
   repository, the mobile binary or chat. Reuse existing server FCM setup.
4. On a signed iPhone, demonstrate real FCM token registration/rotation/logout;
   permission denial/settings recovery; foreground presentation; background
   alert/tap; warm and cold opens; session restore/expiry; and Customer/Rider
   navigation during a real active delivery. Keep credentials and personal data
   out of public logs/screenshots. Until then, real delivery remains unverified.

Official integration references:
[Firebase Apple FCM setup](https://firebase.google.com/docs/cloud-messaging/ios/get-started),
[Expo push-service integration](https://docs.expo.dev/guides/using-push-notifications-services/),
[React Native Firebase setup](https://rnfirebase.io/).

Next confirmed code-level iOS gap: **native FCM token acquisition/refresh and
platform registration are still missing**. Complete that integration against
the owner-confirmed Apple client before claiming iOS push capability. Payload
and routing compatibility alone do not enable notification delivery.
