# Rider experience — v1.0

12 October 2026, branch `claude/dash-app-production-release`. What the rider
sees, where every value comes from, what the map can and cannot do, and what
happened to the `chatgpt/a55-rider-polish` branch.

## One live workspace

Before this pass the rider moved between five separate pages (online, offer,
delivery, route, complete), each with its own map and layout. The online
page asked the rider to press "Check for orders now" even though the app
already polls, and offered "Preview an incoming order". Rider Home showed
hard-coded figures ("Today's Earnings", "Current Zone"). The route page drew
a road-like line that no routing service had computed, and customer
tracking did the same.

Now every rider route (`rider.online`, `.offer`, `.delivery`, `.route`,
`.complete`) renders one screen, `RiderWorkspace`
(`apps/mobile/src/v2/rider/RiderScreens.tsx`). The map fills the screen. A
top bar shows **ONLINE / ON DELIVERY / OFFLINE** and the GPS chip. The panel
underneath follows the rider's real state, in this order:

| State | Panel | Primary action |
|---|---|---|
| Delivery just completed | Delivery complete | Find the next order / Done |
| Delivery in progress | Journey: step bar, where to go, pickup code, customer contact, items | The one action that moves the order on; the PIN at the end |
| Offline | You're offline | Go online |
| Online, no GPS fix yet | Getting your GPS fix… | Go offline |
| Online, offer open | New delivery offer with countdown | Accept delivery / Decline |
| Online, waiting | Searching for nearby orders (radar, "Dispatch checked Ns ago", small Refresh link) | Go offline |

Accepting an offer doesn't open a new page. The same screen becomes the
journey, and the map re-frames on the shop. After collection it re-frames
on the drop-off.

Outside the workspace (Rider Home, Orders, History, Earnings, chat), an open
offer shows as a bronze banner with its seconds left. Tapping it opens the
workspace. Offers last about thirty seconds, so the rider can't miss one by
being on the wrong tab.

## Where every value comes from

| On screen | Source | Honest about |
|---|---|---|
| ONLINE / OFFLINE | `POST /v1/rider/availability` result | Server refuses offline while on a delivery; shown as an error |
| GPS chip ("GPS live ±8 m" / "GPS 45s ago") | This phone's last fix and its reported accuracy | Live ≤ 30 s, otherwise shown stale with a warning |
| "Dispatch checked 4s ago" | Last successful `GET /v1/rider/offers` | Real time of the real poll (every 8 s, and on return to the app) |
| Offer countdown | Server `expiresAt` against the phone clock | Ring empties against the offer's own window; button disables at 0 |
| Distance to pickup | Server `pickupDistanceMetres` | Straight line — labelled as such |
| "about N min" to pickup | Server `pickupEtaSeconds` | Dispatch estimate (straight line × detour factor ÷ vehicle speed), shown as "about" |
| Trip distance, item count, ready time | Server order fields | Ready time only if the shop gave one |
| Drop-off before acceptance | Server `dropoffArea`, coarsened to ~100 m | Customer name, phone and exact address not sent until acceptance |
| "1.2 km away · straight line" during the journey | Haversine from this phone's fix | Straight line, never a road distance |
| Pickup code | Delivery detail from the server | Visible only while awaiting collection |
| Customer contact | Delivery address `contactPhone` after acceptance | Rider calls customer; customer never gets the rider's number |
| Rider Home "Owed to you" | `GET /v1/rider/earnings` (payout ledger) | Hidden if it can't be loaded; nothing invented |

There are no sample orders, simulated riders, invented demand or invented
places. The production bundle check (`scripts/release-verify.ts`) rejects
the old preview fixtures (`preview-offer`, `preview-delivery`, "Urban
Bites", …). In the production bundle exported for this pass, "Check for
orders now", "Preview an incoming order", "Today's Earnings" and "Current
Zone" each occur zero times.

## Staying online

The GPS watch only fires after 5 m of movement. A rider parked outside a
restaurant produced no fixes, so dispatch treated their position as stale
after two minutes. The server's fifteen-minute online lease, which only
position reports renew, then lapsed. Online riders now also take a real
GPS fix whenever none has been uploaded for 20 s (`LOCATION_HEARTBEAT_MS`
in `RiderFlowProvider.tsx`). That matches the twenty-second reporting the
API expects. A phone that can't get a fix reports nothing, and the GPS
chip goes stale.

Location is **foreground only**: no background location and no foreground
service, as declared for Play. With the screen off, Android stops location,
so the rider gets no offers. The searching panel tells the rider to keep
DASH open with the screen on. A keep-awake option, or a
foreground-service location mode, would be a v1.1 product decision with
Play-declaration consequences.

The offer countdown compares the server's `expiresAt` with the **phone's
clock**. Android's automatic date and time keeps them within a second or
two. A phone set more than about thirty seconds fast would see each offer
as already expired. If that turns up in the field, the fix is to measure
the server clock offset from the API response's `Date` header.

## Map and routing

**Today:** MapLibre shows the rider's live position and the destination pin,
joined by a dashed **straight bearing line**. It's a direction, not a
route: DASH has no routing provider, so the app never draws anything that
looks like roads. The **Navigate** button hands the destination to the
rider's own maps app (`geo:` intent on Android, Apple Maps on iOS) for
turn-by-turn. Customer tracking uses the same straight line from the
rider's last reported position. The fabricated wiggly route
(`interpolateRoute`) is deleted. A production build must set
`EXPO_PUBLIC_MAP_STYLE_URL`; without it the map is replaced by a plain
fallback that says why.

**A real routing provider would need:**

- **A provider.** Self-hosted OSRM, Valhalla or GraphHopper on OpenStreetMap
  (no per-request fee; Lagos road coverage and one-way data should be
  checked first), or a hosted API (Mapbox Directions, Google Routes:
  per-request cost and terms that limit display on non-Google maps).
- **Server-side requests.** The API asks for the route when an offer is made
  (true pickup ETA), on acceptance and on collection, and caches the
  polyline on the delivery. Phones never call the provider directly, so no
  key ships in the app.
- **Re-routing** when the rider's reported position leaves the route by more
  than a threshold, with a rate limit.
- **Privacy.** The customer's exact coordinates go to the provider only after
  acceptance. A hosted provider is a new data recipient and must be added to
  the Data Safety answers and the privacy policy.
- **Fallback.** If the provider fails, keep today's straight line and
  Navigate hand-off.
- **Attribution and licence.** ODbL attribution for OSM-derived routes.

## `chatgpt/a55-rider-polish` triage

The branch has 18 commits not in this branch, from merge-base `67e720c`. The
last staging APK (run 57, 5 October) was built from it, so A55 results from
that APK describe that branch, not this one. **Nothing from it was merged or
cherry-picked.** Where an idea was right, it was rebuilt here against the
current architecture.

| Commit(s) | What | Verdict | Why |
|---|---|---|---|
| `a224436` rebuild online workspace and live feedback | Restyled online page: "Looking for nearby orders…", "Ready for the next delivery", offer callout; kept "Check for orders now" and "Preview an incoming order" | **OBSOLETE** | Superseded by `RiderWorkspace`. Its ideas (live area, a visible offer callout, a searching state) are in the new screen without the manual-check button or the preview |
| `b8de3b9`, `fd759fa`, `6a0de5b`, `15fb8fc`, `ece186b`, `d5d9516`, `2091e6e`, `fab1dc2`, `21b79f6`, `00eab26`, tones part of `1f1bf9b` | DASH tones: `expo-audio` + `expo-asset`, four WAV files, `Vibration` on offers | **DEFER — v1.1** | New native dependencies late in the release; `expo-audio` is likely to add `RECORD_AUDIO`, which the production permission allowlist rejects; `VIBRATE` is deliberately blocked. An offer sound is worth having: add it in its own reviewed change, with a manifest check |
| Calling part of `1f1bf9b` | API returns the **rider's personal phone** to the customer; customer gets "Call rider" | **DEFER — needs a privacy decision** | Reverses the documented rule ("never their phone number") and changes the Data Safety answers. Order chat already connects customer and rider. If wanted, prefer masked or relayed calling, and add a test that pins the rule |
| `e786d9e`, `4ae3eb9`, `3616703` (+ `ci/a55-release-trigger-*.txt`) | Edits to `mobile-release-apk.yml` (push trigger, stripped comments) and trigger files | **OBSOLETE** | The staging workflow on this branch is kept as is; release builds are dispatched, not triggered by files |
| `f6eb7a3`, `89a2bf5`, `c29fe17` | `a55-final-check.yml` | **OBSOLETE** | Repo CI and `release-verify.ts` cover this |
| `a55-polish-assets.yml`, `a55-polish-code.yml`, `a55-audio-lint-fix.yml` | Workflows with `contents: write` that generate code with Python and `git push` | **REJECTED** | Self-modifying release workflows are not acceptable in a signed-release repository |

## What still needs a phone

See section 4 of `A55-PRODUCTION-ACCEPTANCE.md`. GPS behaviour, MapLibre
rendering with the production style, the `geo:` hand-off, the keyboard over
the PIN field and a stationary rider staying online past fifteen minutes
can't be proven in CI.
