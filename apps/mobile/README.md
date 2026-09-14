# DASH — native Customer and Rider app

React Native · TypeScript · Expo SDK 57 development builds · Expo Router.

One app, two faces of one account: every consumer identity is a **Customer**,
and an approved rider also has the **Rider** face, switched from the profile.
`apps/api` is the backend and this app is a new *client* of its rules — rider
assignment, location freshness, auth and money are decided on the server and
never re-implemented here. Vendor and operations stay on the web (`apps/web`).

The visual source of truth is the director-approved boards in
[`docs/design/boards/2026-09-13`](../../docs/design/boards/2026-09-13/README.md).
Where this app differs from them, the difference is listed under
[Deliberate differences](#deliberate-differences-from-the-boards).

---

## Checkpoint status (updated 14 September)

Honest labels, per the brief: **visual** = built to the board with staging
fixtures · **wired** = talks to the real API · **device** = proven on a handset.

| Screen | Board | Visual | Wired | Device |
|---|---|:-:|:-:|:-:|
| Customer Home | Customer 1 | ✅ measured wordmark, photographed services | service list ✅ (bundled six if the answer is empty, malformed or collapsed) | ⏳ |
| Sign in (email code) | — | ✅ | ✅ `/v1/auth/otp/request`, `/otp/verify`, `/auth/me`; restore on launch | ⏳ needs a build pointed at a reachable API |
| Profile & Settings (Customer) | — | ✅ | ✅ signed-in name, email, Sign out | ⏳ |
| Shops landing | Customer 2 | ✅ fixtures | — | ⏳ |
| Shop storefront | Customer 3 | ✅ fixtures | — | ⏳ |
| Product detail | Customer 4 | ✅ fixtures | — | ⏳ |
| Cart | Customer 5 | ✅ fixtures (quote stands in for `/v1/orders/quote`) | — | ⏳ |
| Checkout → Delivered | Customer 6–10 | designed "next checkpoint" state | — | — |
| Rider Home | Rider 1 | ✅ fixtures | — | ⏳ |
| Online / looking | Rider 2 | ✅ fixtures | — | ⏳ |
| Incoming order | Rider 3 | ✅ fixtures (privacy rule applied) | — | ⏳ |
| Order details | Rider 4 | ✅ fixtures | — | ⏳ |
| Pickup route (map shell) | Rider 5 | ✅ native map; fallback without a key | — | ⏳ |
| Earnings | Rider 9 | ✅ fixtures | — | ⏳ |
| Profile & Settings, Appearance | Rider 10 | ✅ Light/Dark works and persists | — | ⏳ |
| Verify pickup, On delivery, Delivered | Rider 6–8 | not in this checkpoint | — | — |

Every other tap lands on a designed screen that says what it will do and what
it waits on (`src/ui/ComingScreen.tsx`) — there are no dead controls.

**Verified so far:** typecheck, lint, 77 unit tests, arm64 debug APKs built
and inspected (embedded bundle, arm64 only), and the flows driven in the web
build at A55 metrics, including sign-in against a local API (request, wrong
code, right code, restore on a cold start, sign-out, Back from settings on
both faces). **Not yet verified on the A55:** the Customer/Rider switch
after the stabilization fix, sign-in and the Android cookie jar (no build has
yet pointed at a reachable API), and the native map with a key.

**Navigation rule.** The root layout is a `Slot`, not a stack, so the two faces
never share one native stack (the source of the Android Fabric "child already
has a parent" crash). A screen shared by both faces must therefore live inside
each face's own stack (see `app/(customer)/settings` and `app/rider/settings`);
a root-level screen would replace the whole face and Back would have nowhere to
go. Face switches are one navigation, owned by the switch buttons; the only
other redirect is the one-time launch redirect for a remembered rider
(`modeReducer` in `src/features/mode.ts`).

---

## Running it

```bash
npm ci --prefix apps/mobile
```

**On a device (the product).** A development build is a real app binary with
the dev client inside; JavaScript is then served to it.

```bash
cd apps/mobile && npx expo run:android
```

Needs the Android SDK and a JDK 17–21 (the repo's `.tooling/jdk-21*` works).
iOS needs a Mac: `npx expo run:ios`. Afterwards, `npm start` serves JavaScript.

**Design review in a browser** (not the product — no native map, no native
fonts pipeline, no device lifecycle):

```bash
cd apps/mobile && npm run web
```

### Configuration

Read at build time by `app.config.ts`; nothing is hard-coded.

| Variable | Meaning | Default |
|---|---|---|
| `APP_VARIANT` | `development` · `staging` · `production`; each installs as its own app | `development` |
| `EXPO_PUBLIC_API_URL` | The API origin, e.g. the staging API | none — the app uses staging fixtures, and Sign in says the build is not connected |
| `GOOGLE_MAPS_ANDROID_API_KEY` | Android map tiles. Compiled into the APK and restricted by package signature | none — Android shows a designed "map needs a key" fallback |

Identifiers: `com.dashworldng.dash` (+`.dev` / `.staging`). The production id is
permanent once published and needs director confirmation first.

**Maps key.** Create an Android key in Google Cloud with the *Maps SDK for
Android* enabled, restricted to Android apps: package `com.dashworldng.dash.dev`
(and `.staging` / the production id when they exist) with the signing
certificate's SHA-1. Debug builds are signed with the standard React Native
debug keystore, SHA-1 `5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25`;
release builds need the upload/app-signing key's SHA-1 instead. Supply it as
`GOOGLE_MAPS_ANDROID_API_KEY` in the build environment, never in the repo.

**Email codes.** Sign-in is by emailed code because SMS is off for V1. While
Amazon SES is in sandbox it delivers only to verified recipient addresses, so
testers' addresses must be verified in SES, and each account's email must be
verified in DASH. The server's answer is the same for every address, so the app
never says whether an account exists.

---

## How it is built

```
app/                    Expo Router — files are routes
  _layout.tsx           fonts, theme, remembered mode, cart; holds the splash until all are known
  (customer)/           the Customer face (group — no URL segment)
    (tabs)/             Home · Orders · Wallet · Support  (Customer board)
      (home)/           a stack inside the Home tab: Home, Shops, service screens
    store/[slug]  product/[id]  cart  checkout  account  search  notifications
  rider/                the Rider face, under /rider
    (tabs)/             Home · Earnings · Orders · Inbox · Profile  (Rider board)
    offer/[id]          incoming offer — full-screen modal
    job/[id]  route/[id]
  settings/[section]    account settings shared by both faces
src/
  theme/                tokens (Light + Dark), appearance, ThemeProvider
  ui/                   primitives: Text, Button, IconButton, AppBar, Screen, Card,
                        Chip, SegmentedControl, SearchField, Toggle, QuantityStepper,
                        StatusPill, Avatar, ListRow, Skeleton, Empty/Error/Offline, TabBar
  commerce/             ServiceTile, merchant cards, ProductCard, PromoCard, CategoryBubble
  rider/                CountdownRing, RouteStops, MapShell (.native / web fallback)
  api/                  client, session, errors — dependencies injected, tested
  data/                 view models, the six-service presentation, STAGING fixtures
  features/             cart, quick-add, offer clock, mode, saved — pure logic, tested
assets/brand/           SVG masters of the DASH wordmark, light and dark (see below)
assets/fonts/           the Naira-sign faces (Manrope has no ₦)
assets/staging/         interim imagery cropped from the boards (see its README)
```

**Why a standalone project, not an npm workspace.** React Native refuses to run
unless React matches its renderer exactly; Expo SDK 57 pins React 19.2.3 and
the web app has 19.2.8. In one workspace one of them breaks. So `apps/mobile`
has its own lockfile, and shares only *source* with the monorepo — Metro
bundles `packages/domain` through a `file:` link (see `metro.config.js`).

**Tokens.** Every colour was sampled from the board pixels, not judged by eye;
screens never name a hex value (a test enforces it, with a listed allowlist of
exceptions and reasons). Dark mode is architecturally complete — same keys,
tested — but its values are a derivation: the boards are Light only.

**Auth, natively, with no backend change.** The refresh token stays an
HttpOnly cookie in the OS HTTP cookie store; JavaScript never sees it. The CSRF
value the server returns in the body is kept in SecureStore and echoed in
`x-csrf-token` on refresh and logout. The access token lives in memory. A cold
start that cannot reach the server stays `restoring` — never a flash of
"Sign in". Device verification of the cookie store is pending.

**Money.** Integer kobo throughout (`@dash/domain/money`). The app formats; it
never computes a fee or total. The cart shows a quote.

---

## Deliberate differences from the boards

Each is a place where following the drawing would have broken a rule; each is
reported for a director decision rather than silently decided.

1. **Incoming offer: no customer name.** The board shows "Emma A., Chevron
   Drive" before acceptance. The API deliberately sends only a coarsened
   drop-off *area* until the rider accepts; the offer model has no customer
   fields at all. The screen shows the area and "Exact address after you
   accept".
2. **Primary button contrast.** White on the approved bronze is 3.9:1, short
   of WCAG AA (4.5:1) for 15–16pt labels. Built as approved; `#946A2B` reaches
   4.8:1 and is a one-line token change.
3. **"Go Offline" on the Online screen.** The board has no way off that screen;
   a rider must always be one tap from stopping.
4. **"Preview an incoming order"** (development and staging builds only): the
   real trigger is a push from dispatch, not connected in this checkpoint.
5. **"View Cart" bar on the storefront** once something is in the cart — the
   board shows the empty state, which has no route to the cart.
6. **Omitted**: an unexplained icon at the top-right of the Pickup Route board.
7. **Sample-data line** at the foot of fixture screens, so staging prices and
   ratings are never mistaken for real ones.

## Interim assets

- **Wordmark (locked brand requirement)**: a vector *measured* from the four
  appearances of the mark on the Customer and Rider boards. Each letter was
  fitted as geometry to the board pixels and the four measurements were
  averaged. No letter was drawn by eye, and "DASH" is never typed. It renders
  sharp at every density, and the Home headers use the boards' letter height
  of 24 pt. The method, numbers and a side-by-side check against the boards
  are in
  [`docs/design/boards/2026-09-13/wordmark`](../../docs/design/boards/2026-09-13/wordmark/README.md).
  The Dark variant changes only the graphite letters, to off-white, and is not
  yet approved. Needed: the master SVG, an approved dark version, and
  confirmation of the small bronze bar in the A (on four of five board
  appearances).
- **Imagery**: cropped from the boards. Needed: master illustrations for the six
  services, and merchant photography via catalogue upload.
- **₦**: Inter's Naira sign, subset per weight (OFL, licence in `assets/fonts`).
