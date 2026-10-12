# Play Console — the steps David performs

D-U-N-S and organisation verification are needed to **publish publicly** as
an organisation. They do not stop building the bundle, creating the app, or
running an **internal testing** track. Do the steps below in order; each one
names what it needs from the repository.

## Before you start — decisions only David can make

- [ ] **Application ID.** `com.dashworldng.dash` is permanent after the first
      upload. Confirm it (or choose another) before step 4.
- [ ] **Privacy Policy.** The published policy covers only Declutters. Approve
      (ideally after legal review) the DASH APP draft in
      `PRIVACY-POLICY-DASH-APP-DRAFT.md`, then publish it at a public URL.
- [ ] **Support contact.** A monitored email (and optionally phone) shown on
      the store listing.
- [ ] **Launch area.** Which city/area DASH delivers to at launch — the
      listing must not promise coverage that does not exist.

## 1. Create the app

Play Console → **Create app**
- App name: see `STORE-LISTING-DRAFT.md`
- Default language: English (United Kingdom) or English (United States)
- App or game: **App**; Free or paid: **Free**
- Declarations: accept the Developer Program Policies and US export laws.

## 2. App content (Policy → App content)

| Section | Answer / source |
|---|---|
| Privacy policy | the public URL of the approved DASH APP policy |
| App access | **All or some functionality is restricted** → add instructions from "Reviewer access" below |
| Ads | **No, my app does not contain ads** |
| Content rating | IARC questionnaire — answers below |
| Target audience | **18 and over** only (signup requires the 18+ attestation) |
| News app | No |
| Data safety | `DATA-SAFETY.md` |
| Government app | No |
| Financial features | None of the listed features (DASH takes card payment for goods via Paystack; it is not a lending, banking or crypto app) |
| Health | No |
| Account deletion | In-app path: Account → Delete account. Web URL: `https://<your web domain>/delete-account` |

### Content rating (IARC) — suggested answers

Category: **Utility, Productivity, Communication or Other** (or Shopping if
offered). Violence, sexuality, language, controlled substances, gambling:
**No**. Users can interact/communicate: **No** in-app (calls use the phone's
dialler). Shares user location with other users: **Yes** — the rider's
position is shown to the customer during their delivery. Digital purchases:
**No** (physical goods and delivery). **David to confirm** the pharmacy
category sells no prescription-only medicines through the app; if it does,
the questionnaire and Google's health policies change.

### Reviewer access (App access instructions)

Sign-in is by a code emailed to the account's address, so the reviewer needs
an inbox:

1. Create a dedicated mailbox, e.g. a new Gmail account used only for Play
   review.
2. Create a DASH account with it on the staging/production API and complete
   email verification.
3. In App access, give: the email address, the mailbox password (Play
   Console stores it securely), and these steps: *"Open DASH → Sign in → enter
   the email → open the mailbox and enter the 6-digit code. To see rider
   features, the same account is approved as a rider."*
4. Approve that account as a rider in `/ops/partners` so the reviewer can see
   both faces.

Do not invent a code-bypass for reviewers.

## 3. Store listing (Grow → Store presence → Main store listing)

Text: `STORE-LISTING-DRAFT.md`. Graphics Play requires:

| Asset | Size | Status |
|---|---|---|
| App icon | 512 × 512 PNG | `store-assets/play-icon-512.png` (32-bit PNG) — the measured wordmark on the Light ground; **David to approve** |
| Feature graphic | 1024 × 500 PNG/JPG | `store-assets/feature-graphic-1024x500.png` (24-bit PNG) — the wordmark alone; **David to approve**, or replace with a designed graphic |
| Phone screenshots | 2–8, 16:9 or 9:16, min 320 px | **Not yet produced** — capture from the A55 during testing (real app, real data) |

## 4. Internal testing

Testing → **Internal testing** → Create new release
1. Upload the **verified** bundle from the production workflow
   (`PRODUCTION-AAB.md`) — the `.aab` from its artifact, after checking its
   `.sha256` and reading its `.verification.txt`. Play App Signing: accept
   Google-managed app signing key.
2. Release name: the version name and code you dispatched with, e.g.
   `1.0.0 (12) RC1`.
3. Release notes: what testers should try (`A55-PRODUCTION-ACCEPTANCE.md`).
4. Testers tab → create an email list with the testers' Google accounts.
5. Save → Review release → **Start rollout to Internal testing**.
6. Copy the **opt-in link** and send it to testers. Each tester opens it on
   the phone, accepts, then installs DASH from the Play Store.

## 5. After internal testing

Closed/open testing and production require organisation verification (D-U-N-S)
and, for new personal accounts, Google's testing requirements. Do not start a
production rollout until the release blockers in `README.md` are closed.
