# Customer ↔ rider messaging: what exists, and what building it would take

**Status: nothing is built, and nothing was built in this pass.** This is the
report asked for before any in-app chat is written, so the decision to build it
is taken deliberately rather than arrived at halfway through.

Written 29 September 2026, from a search of the whole repository and of every
branch's history.

## Two corrections to the premise

**The rider's Message action does not open WhatsApp.** It opens the phone's SMS
app. `ContactRow` in `apps/mobile/src/v2/rider/RiderScreens.tsx` is two
buttons — Call, which opens `tel:`, and Message, which opens `sms:` — against
the customer phone number the delivery payload carries. There is no `wa.me`
link, no WhatsApp deep link and no WhatsApp SDK anywhere in the app, and
`git log -S` across all branches finds none there either.

**WhatsApp does appear in the codebase, but nowhere near the rider.** It is one
of four `grantedMethod` values on `DeclutterContactRequest` — the Declutter
marketplace's flow for a buyer asking to reach a seller about a listing. That
flow is admin-mediated: the V1 default is `dash_relay` (DASH coordinates and no
seller detail leaves the platform), and `whatsapp_direct` needs the separate,
step-up-gated `declutter:contact:disclose:direct` permission plus recorded
seller consent, or the request is refused 403/400. It is a
buyer-to-seller-about-a-listing disclosure, not a rider-to-customer channel,
and it is not a chat: the buyer's `message` is a single field on the request,
written once when asking.

So there is no chat to port, and no WhatsApp integration to remove. The SMS
fallback is what is live.

## What exists that chat would build on

This is the part worth knowing before estimating: the hard half of realtime is
already done, to production standard, for order tracking.

| Piece | Where | State |
|---|---|---|
| WebSocket endpoint | `apps/api/src/routes/realtime.ts` | Built. Origin-checked, authenticates from a frame rather than an ambient cookie (so cross-site hijacking gets nothing), unauthenticated sockets timed out, per-identity connection cap, per-connection frame budget. |
| Connection registry and fan-out | `apps/api/src/realtime/hub.ts` | Built. Backpressure via `bufferedAmount`, eviction, dedupe, and a revalidation sweep that closes sockets whose session was revoked — so socket authority never outlives request authority. |
| Topic model and authorization | `packages/domain/src/realtime` | Built. Topics are `kind:id` over `order`, `vendor`, `rider`, `city`, with `canSubscribe`, `canReachOrder`, `canReachVendor`. A refused topic returns `not_found` whether it does not exist or belongs to someone else. |
| Order-scoped identity | `apps/api/src/routes/orders.ts`, the dispatch worker | Built. An order already knows its customer and its assigned rider, and already hides customer identity and exact address until a rider accepts. |
| Push delivery | — | **Not built.** `expo-notifications` is not a dependency; there is no device-token table and no FCM sender. `apps/mobile/src/features/` has no notification module. The app config blocks `FOREGROUND_SERVICE` and `RECEIVE_BOOT_COMPLETED` deliberately. |

The realtime layer has no message-shaped notification and no chat topic, but
adding one is an extension of a working design rather than a new subsystem.

## What is missing, by layer

### Database

Nothing exists. `git log --all --diff-filter=A` finds no file ever added whose
name contains chat, conversation or message, and `schema.prisma` has no such
model. Two tables, at least:

- **`Conversation`** — one per order, which is the only scope that makes sense
  here: `orderId` unique, `customerId`, `riderId` (nullable until assignment),
  `status`, `openedAt`, `closedAt`. Keying on the order is what makes
  authorization answerable and what makes closing the conversation a
  consequence of the delivery finishing rather than a separate decision.
- **`ConversationMessage`** — `conversationId`, `senderRole`
  (`customer` | `rider` | `system`), `senderIdentityId`, `body`, `createdAt`,
  `readAt`, and a delivery state. System messages matter: "rider assigned",
  "order delivered" belong in the thread.

Both fall under the existing retention and account-deletion machinery, which is
not optional — `packages/domain/src/retention` and the deletion/export policy
in `packages/domain/src/account` would each need a rule for message bodies, and
the personal-data export would need to include them. Message bodies are
personal data and are likely candidates for encryption at rest, which the
repository already does for vendor payout details (`packages/domain/src/envelope`).

### API and realtime

- `GET /v1/orders/:id/conversation` — the thread, paginated.
- `POST /v1/orders/:id/conversation/messages` — send, rate-limited per
  identity, with a length cap and an idempotency key so a retried tap does not
  double-post.
- `POST .../read` — read receipts, or the unread count is a lie.
- A `conversation:<id>` topic kind, or a `message` notification on the existing
  `order:<id>` topic. The second is less work and reuses `canReachOrder`
  exactly; the first is cleaner if conversations ever outlive an order.

### Authorization

The rule follows the order and nothing else:

- The customer who owns the order may read and write, from placement until a
  fixed window after completion.
- The rider **currently assigned** may read and write, from acceptance until
  the same window. A rider who was offered and declined, or who was unassigned,
  loses access at that moment and keeps no history.
- Support and admin roles read under an existing permission and are recorded in
  the audit log, as every other privileged read in this codebase is.
- Nobody else, and a refusal is `not_found` rather than `403`, matching
  `assertScope` and the realtime layer.

This is deliberately the same shape as `canReachOrder`, so it should be
expressed as an extension of it rather than a parallel rule that can drift.

### Frontend

- A conversation screen in v2's patterns, reachable from the rider's active
  delivery and from the customer's tracking screen.
- Conversation state: optimistic send, a pending/sent/failed state per message,
  retry, and reconciliation against the socket so a message does not appear
  twice.
- An unread badge on both faces.
- Offline behaviour. A rider on a Lagos street loses signal constantly; a
  queued message that silently vanishes is worse than one that visibly failed.

### Notifications

This is the largest missing piece and the reason chat is not a small feature. A
message nobody is told about is not messaging. It needs `expo-notifications`,
a device-token table with its own retention rule, an FCM sender in the API, the
`POST /v1/devices` registration route (`apps/api/src/routes/devices.ts` exists
but registers nothing of the kind today), notification permission handling on
the phone, and a Play Data Safety declaration covering it.

### Safety and abuse

Two people who are strangers get a private channel, which is a safety surface,
not just a feature: reporting, blocking, retention of reported threads beyond
the normal window, and a decision about whether DASH staff can read threads and
under what authority. This is a product and legal decision, not an engineering
one, and it should be made before the schema is written rather than bolted on.

## Recommendation

Keep the SMS fallback for this release. It works, it is honest about what it is,
and it costs nothing to maintain.

In-app chat is a milestone of its own — realistically the database, API,
authorization, two screens, notifications and the safety policy — and the
realtime foundation it would sit on is already the strongest part of the
platform. It should not be started inside a release-preparation pass.

One caveat worth recording: the SMS fallback puts the customer's real phone
number on the rider's phone, and the rider's on the customer's. The platform is
otherwise careful about this — Declutter will not disclose a seller's number
without step-up permission and recorded consent, and the rider offer screen
hides customer identity until acceptance. Number masking, or in-app chat, is
what closes that gap. It is a gap that exists today and is not introduced by
anything in this pass.
