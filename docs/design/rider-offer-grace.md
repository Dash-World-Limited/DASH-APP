# Design — waking a rider whose app is not running

Status: **proposed, not implemented.** Requested 7 September 2026 after the
swipe-away FCM test proved that a rider whose app has been killed stops being
dispatchable before a push can ever reach them.

---

## The problem, stated exactly

Location reporting is a JavaScript timer inside the WebView. Swiping DASH from
Recents kills the process, the timer stops, and 120 seconds later the rider is
`location_stale` and excluded from dispatch.

Measured on the failing test:

```
20:13:15  last accepted GPS fix
          ── app swiped from Recents ──
20:16:13  vendor starts preparing → rider's fix is 179s old → excluded
                                  → 0 offers → 0 pushes
20:16:48  reporting resumes (app reopened)   214s of silence
```

So the two requirements contradict each other: **push exists to reach a rider
who is not looking at the app, but eligibility requires a fix that only arrives
while the app is alive.**

## The principle

> **Offer eligibility and assignment eligibility are different questions.**
>
> A stale position is good enough to decide *whom to wake*. It is never good
> enough to decide *who is carrying the order*.

Waking the wrong rider costs one notification. Assigning the wrong rider costs
a customer their delivery. The two decisions deserve different evidence, and
today they share one threshold because there was never a case where they
diverged.

---

## The finding that shapes this design

**The accept endpoint validates nothing about the rider.** It checks that the
offer exists, that it belongs to the caller, that it is still `pending`, and
that it has not expired. It does not check approval, availability, location
freshness, distance, zone or capacity.

That is safe *today* only because dispatch filtered on all of it thirty seconds
earlier and state cannot drift far in thirty seconds. It is an assumption, not
a guarantee, and it is undocumented.

The moment an offer can be created from a stale position, that assumption
collapses — and because acceptance checks nothing, **the freshness rule would
disappear from the system entirely rather than move.** So this is not optional
polish: adding a freshness gate to acceptance is the load-bearing half of the
change, and it must land in the same commit as the relaxation, never after.

---

## 1. Offer-grace duration — recommend **600 s (10 minutes)**

A grace offer only ever causes a notification. The rider cannot act on it
without producing a fresh fix that re-validates distance and zone, so a wrong
guess costs one wasted push and one failed acceptance — never a bad assignment.
That asymmetry is what makes a window this wide defensible.

It has to cover a realistic gap: swipe → customer browses → orders → vendor
accepts → vendor starts preparing. In the failed test that was 214 s of silence
with brisk operation on both sides; a customer deciding what to order easily
pushes it past five minutes.

Beyond about ten minutes, a rider who has reported nothing is more likely to
have stopped working than to be sitting still, and the Online lease should be
the thing that catches them. Start at 600 s, measure how many grace offers
convert, and tighten rather than widen.

## 2. Online lease — recommend **900 s (15 minutes)**, renewed on every report

`Rider.onlineUntil` is set when the rider goes Online and pushed forward on
every accepted location report — roughly every 20 s while the app lives. A
living app therefore never expires; a killed one expires 15 minutes after its
last report.

The lease is what makes "Online" a claim the server can verify rather than a
flag the client set once. Without it, grace has no outer bound: a rider who
went Online on Monday would still be woken on Friday.

Grace (10 min) sits inside the lease (15 min) deliberately. Between 10 and 15
minutes a rider is still leased-online but no longer offerable — they are
online for the purposes of the UI and the ops board, and simply too stale to be
worth waking.

## 3. How lease expiry marks a swiped rider unavailable

Two mechanisms, and both are wanted:

- **Query time (correctness).** The dispatch candidate query gains
  `onlineUntil > now`. This alone is sufficient to stop offers.
- **A sweep (honesty).** The existing scheduled maintenance runner flips
  `availability` to `offline` for expired leases. Without it the rider's own
  screen and the ops board would show someone as working who cannot be given
  work — a ghost. Correctness does not require it; not lying to operators does.

## 4. Is the 30 s offer TTL sufficient? — **No**

Budget for the wake path, using timings measured on the test handset:

| Step | Observed |
|---|---|
| FCM delivery | 1–5 s |
| Rider notices and taps | 2–15 s |
| Cold start: WebView, JS, session refresh | 3–8 s |
| Fresh GPS acquisition | 2–20 s (cold fixes hit the 20 s timeout) |
| **Total** | **8–48 s, commonly 15–30 s** |

Thirty seconds fails a large fraction of the time, and it fails *after* waking
the rider — the worst outcome, because the rider is now awake, has burned a
cold GPS fix, and gets told the job is gone.

Recommend making TTL **a property of the offer, not a constant**: 30 s for a
fresh rider (unchanged, keeps the fast path fast) and **90 s for a grace
offer**. The longer TTL is paid only in the case where the alternative was no
rider at all.

## 5. Race conditions and adversarial cases

Each of these must be a test.

1. **Stale accept by direct API call.** A rider replays the accept endpoint
   without opening the app. Session and offer are both valid. Must fail — the
   fresh-fix requirement cannot live in the client.
2. **Fresh fix arrives out of range.** The rider moved. Accept must fail and
   the order must return to dispatch immediately rather than waiting out the
   TTL.
3. **Fresh fix is implausible.** Anti-spoofing rejects it, so no valid fresh
   fix exists, so acceptance fails. The existing rule does this work unchanged.
4. **Lease expires between offer and accept.**
5. **Approval revoked between offer and accept.**
6. **Availability changed to `on_break` or `offline` between offer and accept.**
7. **Capacity reached between offer and accept** (a concurrent assignment).
8. **Order cancelled between offer and accept.**
9. **Zone paused between offer and accept.**
10. **Two concurrent accepts** — the existing compare-and-set claim must still
    yield exactly one assignment.
11. **Duplicate push** from an outbox retry — already handled by the per-offer
    collapse key; must stay handled.
12. **Clock skew** on the client-supplied `recordedAt` — existing future-stamp
    guard applies, and a backdated stamp makes the rider staler, not fresher.

## 6. Two riders, one wakes and fails validation

- The failing rider's offer is **withdrawn immediately**, not left to expire.
  Holding it wastes the whole TTL on someone who has already been proven
  ineligible.
- Dispatch is **re-triggered for that order at once**.
- The other rider's offer is **untouched** — one rider failing must not disturb
  a parallel offer.
- The failure is **not recorded as a decline.** It is not a refusal and must not
  count against the rider's acceptance rate. Conflating "could not" with "would
  not" would quietly punish riders for having a slow GPS.

## 7. Changes required

**Schema (additive, nullable/defaulted, no backfill):**
- `Rider.onlineUntil DateTime?`
- `DispatchOffer.graceOffer Boolean @default(false)` — so the accept path knows
  to demand a fresh fix, and so grace conversion can be measured.

**Domain (`packages/domain/src/dispatch`):**
- `DispatchConfig` gains `offerGraceSeconds`.
- Eligibility returns **two** verdicts rather than one: `mayBeOffered` and
  `mayBeAssigned`. `location_stale` stops being a single boolean.
- Grace riders rank **strictly below** every fresh rider, so a live rider is
  always preferred and grace is only ever reached for.

**Dispatch worker:** candidate query adds `onlineUntil > now`; offers created
for grace riders set `graceOffer` and the 90 s TTL.

**Accept endpoint — the substantial change.** Inside the existing transaction,
before the claim: approval is `approved`; availability is `idle`; lease not
expired; **`locationReportedAt` within the normal 120 s**; distance and zone
re-validated against that fresh position; capacity not exceeded. The 120 s rule
is not relaxed here — it moves here, and for a grace offer this is the only
place it is enforced.

**Client:** on notification tap, acquire a native fix, report it, and only then
enable Accept. A failure to obtain a fix must say so plainly rather than
presenting a button that will fail.

## 8. Tests

The suite above, plus the one that matters most — an invariant test asserting
that **no path can produce `status = 'rider_assigned'` while the assigned
rider's `locationReportedAt` is older than 120 s.** Everything else in this
document is mechanism; that is the property being bought, and it should be
asserted directly rather than inferred from the mechanism working.

## 9. Fairness and ghost-online

**Ghost online — yes, this introduces one.** A rider whose app was killed looks
online for up to the lease. Mitigated by: ranking grace riders below fresh ones
so they are only reached for when nobody live qualifies; the sweep flipping
expired leases to `offline`; and the fact that a ghost can never be *assigned*,
only woken.

**Order latency.** A grace offer that goes unanswered costs up to 90 s before
re-rounding. Acceptable only because it is reached for when the alternative was
no rider at all — never in preference to a live rider.

**Rider fairness.** A grace offer that times out, or fails fresh-location
validation, must not count as a decline. Otherwise riders are penalised for
device behaviour they do not control, and the ranking would slowly favour
whoever leaves the app open — which is a battery-drain incentive we should not
create.

---

## What this is not

This is an interim. The correct answer is an Android foreground service
reporting location while the rider is working, which keeps them genuinely fresh
and makes grace unnecessary. That is a separate milestone with its own Play
Store policy obligations and is deliberately not started here.

This design buys a working push path in the meantime **without** letting a
stale position assign a delivery.
