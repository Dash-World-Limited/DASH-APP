# Content Studio employee access

`content_editor` is a staff role in the existing DASH identity/permission system. Its complete permission set is **`content:manage` only**. It does not inherit customer, operational, vendor, rider, finance, platform-admin, user/role administration, impersonation or Super Admin permissions.

`content:manage` permits the existing Studio dashboard, configuration, history, vendor-reference lookup, media library/upload, draft creation/editing and local preview. Media metadata/archive remains part of the existing media-management surface; archive still refuses assets referenced by drafts or historical revisions. Studio never writes vendor operational records.

`content:publish` is required in addition to management access for publish, unpublish and rollback. No explicit non-Super-Admin role bundle grants it. Super Admin inherits both through the existing all-permissions design. API checks run before publication record lookup, payload validation or mutations. Hidden/disabled controls are only an additional UI affordance.

Workflow: editor prepares and previews a draft → Super Admin reviews → Super Admin publishes. Editors can edit the working draft of a published entry; the immutable live revision remains unchanged until approval/publication.

## Sign-in and sign-out

Use `/studio/signin`, then `/studio`. The shared staff sign-in component calls the existing DASH password, TOTP enrolment/confirmation, verification and recovery-code APIs. There is no second password store or session backend. New editors enrol TOTP on first login and receive the existing single-use recovery codes. A password-only privileged response is rejected by the UI; existing staging MFA/keyring configuration must remain enabled. After completion, the page checks `content:manage` and invokes the existing sign-out flow for an account without it.

`/studio` and compatible `/admin/content` share one ContentStudio implementation. The dedicated route has no AdminShell or Super Admin navigation. Only a Super Admin sees the Operational console link. Existing `/admin` authorization remains in place. Studio Sign out invokes the existing logout/session-revocation helper before redirecting to `/studio/signin`; it does not just navigate. As elsewhere in DASH, the shared client clears local state even if logout's network call fails; server revocation requires successful delivery. This change does not redesign that behavior.

## Later staging provisioning — NOT executed

The existing `bootstrap-staging-super-admin.mjs` is unsuitable: it grants Super Admin and suspends seeded staff. There is no reusable least-privilege staff-creation endpoint. The narrow replacement `scripts/provision-content-editor.mjs` uses the same DASH Prisma identity database and password hashing implementation, creates only `content_editor`, and changes no existing identity. It is not registered as an API route.

Before running later, obtain operator authorization and a database checkpoint. Privately inspect `sudo systemctl cat dash-api.service` to discover the actual staging environment loader; its file path is still unconfirmed. Load the same effective staging configuration securely, confirm PostgreSQL database `dashdb_staging`, working MFA/keyring settings and mailbox ownership. Generate both required Prisma clients for that release using the normal runbook. Do not seed or reset.

From the reviewed release root, in an interactive private terminal:

```bash
DASH_PROVISION_CONTENT_EDITOR=YES DASH_STAFF_EMAIL_VERIFIED=YES \
  node --import tsx scripts/provision-content-editor.mjs
```

When prompted later, enter `studio@dashworldng.com`, the employee's display name, and a unique password of 14–256 characters twice. Password entry is hidden, readline history is disabled, and password arguments/environment variables/files are not accepted or used. Do not pipe secrets, enable shell tracing/session recording, or share the terminal. Only the created identity ID and role are printed; raw database exceptions are suppressed. JavaScript strings cannot be reliably zeroized in process memory; use a trusted host and terminal.

The CLI requires both explicit confirmation flags, refuses noninteractive input and any arguments, and refuses every target except PostgreSQL `dashdb_staging`. It normalizes email, checks duplicates case-insensitively (including legacy mixed-case rows), and uses one serializable transaction for identity, sole role and a secret-free audit event. Unique constraints/transaction conflicts fail closed; reruns do not reset passwords or add roles. It creates no session, TOTP secret, recovery code, customer profile or operational profile. Operator confirmation of mailbox control supplies `emailVerifiedAt`; this is not an email-verification bypass exposed to web clients.

This deliberately supports staging only. A future production provisioning procedure needs its own review and authorization, not a renamed database or a bypass of this guard. Revoke host/operator access under the existing process when personnel change; the script confers no browser user/role administration.

No real `studio@dashworldng.com` identity has been created by this implementation. Verify later with `/studio/signin`, enrol MFA privately, save recovery codes securely, and confirm a direct publish attempt is denied. David continues using his existing Super Admin identity and retains publication authority.

## Schema and rollout

`IdentityRole.role` is already `String`. This change requires no Prisma schema edit or migration. Install/build the release using the staging public API URL as usual, keeping existing environment/secrets and operational settings. This document is preparation only: no merge, deployment or account creation is authorized or performed here.
