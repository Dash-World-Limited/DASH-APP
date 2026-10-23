# First signed-iPhone QA — record real results

Use a signed **staging** build, legitimate dedicated Customer/approved Rider identities, an isolated serviceable order/vendor and positively confirmed Paystack test mode. Record exact SHA, app variant/bundle, version/build, iPhone model/iOS, signing/APNs environment and case evidence. Start each case as NOT RUN; never infer PASS from simulator/unit tests. Keep OTPs, tokens, delivery PINs, precise addresses and payment details out of artifacts.

| Case | Required observation |
| --- | --- |
| Install / launch | Signed build installs, correct DASH name/icon/splash, reaches usable app without crash. |
| OTP login | Real email OTP succeeds; authenticated identity/role is correct. Expiry/error remains recoverable. |
| Location permission | Deny, grant and Settings recovery work without an endless spinner or forced access. |
| Real GPS | A physical location fix and serviceability come from the device/server, not simulated coordinates. |
| Manual address fallback | With GPS denied/unavailable, select/save a legitimate staging delivery address and reload it. |
| Customer order | Browse real staging catalogue, cart/quote/checkout, create one test order; server totals/status remain authoritative. |
| Paystack test checkout | Actual browser opens; success, cancel and failure return correctly. Verify payment through server/provider evidence, not URL status. No live card/money. |
| Background / resume | During order/chat/payment, background then resume; state refreshes without stale response overwrite. |
| Force-close / reopen | Session/order restoration works after termination; real warm/cold payment returns open correct Orders context. |
| Customer / Rider chat | Both directions deliver against the same real order; keyboard/composer works on iPhone. |
| Push foreground | Real Apple/Firebase push arrives; existing visible order/chat is not announced twice. |
| Push background | Real alert arrives while suspended; tap routes once to authenticated server-backed order/chat/support as applicable. |
| Push terminated | Genuine OS notification opens a closed app, waits for session restoration and routes once. Do not substitute simulator injection. |
| Tap / deep link protection | Duplicate/malformed/unrelated links do nothing unsafe. Signed-out/expired sessions cannot bypass auth or replay into another account. Active/restoring Rider stays protected. |
| Call Rider | Correct dialer opens; unavailable calling shows the existing fallback. Do not place an unsolicited call. |
| Order completion | Approved test Rider/vendor completes normal progression; Customer status synchronizes. Keep PIN private. |
| Rider rating | Rate the completed test delivery once; displayed result comes from backend. |
| Logout / login | Device unregistration/notification-cache cleanup occurs; old tokens/intents cannot identify the next account. Test actual FCM rotation/re-registration. |
| Notification preference | Toggle off/on, deny permission, Settings recovery and resume; server preference matches intended account. Essential Rider policy is verified through real notifications. |
| Account deletion | Profile entry visible; cancel confirmation sends no POST. On a disposable staging identity, confirm schedule with idempotent retries, inspect actual server date, then cancel during cooling-off. Active order blocks per server policy. Never purge a personal/production account. |
| Haptics | Check only controls that actually use haptics. This source baseline has no haptics module/Vibration calls; record N/A where no behavior exists. Do not invent feedback to fill the checklist. |

Also inspect configured Firebase/Apple SDK privacy manifests and App Store Connect privacy answers before distribution. Physical QA completion and release approval are separate recorded decisions.
