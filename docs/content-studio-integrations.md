# DASH Content Studio — native and web integrations

Branch: `feature/dash-content-studio-v1` (continued in place).
Previous HEAD: `6457a684fa5ceb97753a6a7d03ec075bc7f908ba`.
Date: 25 October 2026.

## Completed integrations

| Presentation | Expo Android / iOS shared client | Web |
| --- | --- | --- |
| `home.hero` | Existing customer-home campaign slot; complete original campaign falls back on empty/error/unsupported feed or failed image | Home banner, now using the shared validated feed |
| `category.artwork` | Six home service tiles and merchant category dashboard artwork | Home section tiles and merchant section headers |
| `home.featured` vendors | Promotes/orders only vendors already returned by the category's existing catalogue query | Promotes/orders only vendors in the existing home/section catalogue results |
| `vendor.presentation` | Category merchant cards and returned vendor storefront: cover, optional logo, editorial label, featured flag | Home/section vendor cards and returned vendor storefront: cover, optional logo, editorial label, featured flag |
| `home.promotions` | Controlled image cards below the existing home campaign slot | Controlled image cards on home |
| `home.announcements` | Bounded title/body notices on customer home | Bounded title/body notices on home |
| `home.featured` collections | Controlled image/title/body cards with existing app destinations | Controlled image/title/body cards with existing app destinations |

Android and iOS compile the same components and call the same existing public
V1 `/v1/content` endpoint. There is no platform-specific backend or auth path.
Native home has no normal vendor rail to decorate, so it does not invent one
from Studio records. Native featured vendors operate on actual category-list
results. The Declutter marketplace and Logistics booking remain their existing
separate domains; their home service tiles can receive category art, but this
change does not turn marketplace listings or logistics into merchant records.

The native catalogue previously discarded the API vendor ID while keeping the
slug as its navigation ID. It now retains `vendorId` alongside that slug for
presentation matching only. Navigation/cart still use the original slug and
the original data. A binding test uses deliberately different IDs and slugs.

## Safety and fallback contract

`@dash/domain/content/presentation` is the shared pure consumer boundary. It:

- accepts only envelope `schemaVersion: 1` and skips malformed or future items
  independently, without discarding other valid items;
- validates bounded display fields, known types/placements, service IDs,
  destinations, and safe HTTP(S)/local signed image URLs;
- removes unknown operational fields rather than merging them into vendors;
- resolves local `/v1/files/...` image paths against the configured API origin;
- sorts supported slots by published priority and ID;
- only permutes the existing catalogue array, preserving each original object,
  name, closed/busy state, prices, minimums and other operational properties;
- never fetches missing vendors, adds a vendor from a Studio target, or uses an
  editorial title as an operational vendor name.

Both platform hooks return an empty array immediately and load independently
from catalogue/auth/customer operations. Public requests omit credentials and
do not go through the session-refresh client. The **2500 ms deadline covers
both the request and body**, using a race as well as abort. A fetch/body that
ignores AbortSignal still cannot delay the UI's optional-content result. Hook
unmount aborts the request and prevents late updates.

No loading/error UI is inserted into browsing for Studio failures. Existing
category art is supplied as the native image fallback; web removes an optional
failed image. Failed native hero images restore the complete existing rotating
campaign. Vendor identity panels and original catalogue data remain present
even if all editorial images fail. Replacement image URLs get fresh failure
state. Editorial labels remain distinct from Open/Closed/Busy indicators.

Home discovery is bounded to two announcements and four promotional/collection
cards. A `featured_vendor` record is never rendered as an independent discovery
card: it must first match a returned catalogue vendor. Image-less promotional
or collection cards are omitted. Titles/bodies are plain text. Destinations
map to existing customer screens only, never auth, rider, checkout or scripts.

The feed refreshes when the relevant screen/page mounts; this change does not
add polling, persistent offline CMS caches, or background work. Existing app
versions continue using their presentation. Native clients need one normal
application release containing these integrations; subsequent Studio edits do
not require a new binary and appear on the next screen entry/load.

## Verification

All commands run from the repository root unless noted.

| Check | Exact result |
| --- | --- |
| `node node_modules/vitest/vitest.mjs run apps/mobile packages/domain/src/content apps/web/src/components/content apps/web/src/app/admin/content/page.test.tsx apps/api/src/__tests__/content.test.ts --maxWorkers=2 --reporter=json --outputFile=../integration-regression-final.json` | **448 passed, 0 failed, 0 skipped**, 44 files |
| Mobile subset within that final run | **399 passed, 0 failed**, all 37 mobile test files |
| Earlier mobile-only run (before two additional native binding tests) | **397 passed, 0 failed** |
| Earlier focused shared/native/web presentation run | **46 passed, 0 failed**, six files |
| `npm run typecheck` | All five workspaces clean: domain, DB, API, web, mobile |
| `npm run lint` | Passed, 0 errors |
| `npm run build` | API TypeScript build and Next web production build passed |
| `node node_modules/expo/bin/cli export --platform android --platform ios --max-workers 2 --output-dir '../../../../integration-native-export'` from `apps/mobile` | Android and iOS Hermes bundles both exported; 1014 modules per platform, approximately 2.8 MB each |

The final regression includes the requested native empty feed, failed request,
malformed data, failed image, valid hero and unsupported/newer content cases;
request/body deadlines; cancellation; image fallback/reset; category mapping;
vendor scope and immutable operational data; and real native/web catalogue
component bindings. It also reruns all existing mobile suites and the Studio
backend/UI tests. It is not a claim that the entire repository suite ran again.

Both mobile exports are intermediate verification artifacts only, subsequently
placed under the task's `work/integration-native-export` directory. They were
not deployed. No APK/AAB/IPA was built, signed, installed, or uploaded. Physical
Android/iOS device QA has not been performed in this Windows environment.

No database model, migration, API route, auth, storage or permission change was
needed. Database migration checks were therefore not rerun in this continuation.
The existing V1 migration history remains unchanged. Existing Next middleware
and Fastify logging deprecation warnings remain; no dependency versions changed
and no forced audit fix was used.

## Transactional-code review

No API/backend files changed. No payment, pricing, ledger, ordering, dispatch,
cancellation, authentication, vendor-order, rider, delivery or checkout logic
changed. No native API/session/cart feature modules changed. The existing
composite `App.tsx` and `CatalogScreens.tsx` contain other operational screens;
their edits are confined to customer presentation rendering and retaining the
API vendor ID in view models. The product/cart/checkout/rider implementations
in those files were not rewritten or reformatted.

Review the diff against the previous HEAD above, not against an unrelated main
branch. The final delivery report records the new commit and full file list.

## Remaining work and exact next task

**Next task:** run a staging device smoke test on one Android device and one
iPhone using existing staging app configuration. Create/publish a hero,
category artwork, eligible-vendor feature and vendor cover/logo/label in Studio.
Confirm they render on the real home/category/storefront screens, then unpublish
them, block the content request, and fail an image. Normal browse/cart/checkout
and rider/vendor operation smoke checks must still succeed. An ineligible or
out-of-area vendor ID in Studio must never appear in the normal lists.

Also inspect image crops, accessibility text, long editorial copy and signed
storage URLs on the actual staging domains. Verify fresh screen entries see
published changes without a new binary. Use normal CI and staging release
procedures; this task has neither merged nor deployed anything.

Deliberately unfinished: native-home vendor rail (none exists to safely decorate),
search-result promotion, full collection membership, FAQ/legal consumers,
marketplace-listing overrides, live refresh while a screen stays open, physical
device evidence, and store-release binaries. These are separate scoped tasks;
the requested existing merchant/category presentation integrations are built.

The branch remains optional and backward-compatible based on the automated
checks and both Metro exports. It is ready for code review; production release
still requires normal CI and staging/device checks. No new schema/deployment
step is required beyond building/releasing the changed web/native clients through
the existing process. The unchanged API already serves the feed.
