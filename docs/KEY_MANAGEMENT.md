# Encryption key management

How the keys protecting encrypted-at-rest fields are held, rotated, and
recovered.

**Nothing in this file is a real key.** No production key material has been
generated, and none may be committed to this repository at any point.

---

## What the key protects

One keyring covers every encrypted field:

| Field | Purpose tag | Bound to |
|---|---|---|
| `Identity.mfaSecretCipher` | `mfa_totp_secret` | the identity id |
| `Identity.mfaPendingCipher` | `mfa_totp_secret` | the identity id |
| `Vendor.bankAccountCipher` | `vendor_bank_account` | the vendor id |

The fields share a key but are **separated cryptographically**, not by holding
separate keys. Every ciphertext is bound to a purpose and a subject as
additional authenticated data, so a TOTP envelope cannot be decrypted as a bank
account, and one vendor's row cannot be read as another's. Holding separate keys
per field would double the custody burden for a property the AAD binding already
gives.

## Envelope format

```
v1.<keyId>.<nonce>.<ciphertext>.<tag>
```

AES-256-GCM. 32-byte key, 12-byte random nonce per encryption, 16-byte tag.
Base64url throughout so the whole value is a safe single-line database column.

The `keyId` travels with the ciphertext. That is what makes rotation possible
without a migration: new writes use the new key, existing rows still name the key
that encrypted them, and re-encryption proceeds at its own pace.

## Configuration

| Variable | Secret? | Meaning |
|---|---|---|
| `ENCRYPTION_KEY` | **Yes** | Base64 of exactly 32 bytes. Encrypts all new values. |
| `ENCRYPTION_KEY_ID` | No | Name recorded in every envelope this key writes. It travels in plaintext inside the ciphertext, which is the point of it. |
| `ENCRYPTION_KEYS_RETIRED` | **Yes** | `id:base64key,id2:base64key2` — decrypt-only. |

Generate key material with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### What boot refuses

Key material is validated at boot, not at first use: a malformed key fails the
process rather than surfacing weeks later in front of a user.

| Refused | Why |
|---|---|
| A key that is not exactly 32 bytes | Wrong algorithm parameters, or a truncated paste |
| An all-zero key | What an unset variable decodes to |
| A key id outside `[A-Za-z0-9_-]{1,64}` | The envelope is dot-separated. An id containing a dot, a colon, or a space is written into ciphertext that **cannot be parsed back out** — the value encrypts fine and is then permanently unreadable, with nothing complaining until a decrypt. |
| One key id that is both active and retired | A half-applied rotation. If the two entries hold different material, choosing either silently destroys every row written under the other. Boot refuses rather than guessing which rotation step was skipped. |
| The same key material under two ids | A rotation that did not rotate |
| A duplicate retired id | Decryption would be non-deterministic |
| A malformed retired entry | The list is wrong, and some key is probably missing from it |
| Retired keys with no `ENCRYPTION_KEY` | Not a decrypt-only mode: it can read old rows and write none, so it fails at the first write instead of at boot |
| Production with no `ENCRYPTION_KEY` | Nowhere safe for a TOTP secret to live |
| `MFA_ENABLED=true` with no key, in any environment | MFA without a key is not "MFA off", it is MFA that fails at enrolment |

**No refusal message ever contains key material.** Asserted in
`apps/api/src/__tests__/key-rotation.test.ts` and by `npm run check:keys`.

These rules live in one place — `assembleKeyring` in
`packages/domain/src/envelope` — because the API and the development seed both
build keyrings, and the seed used to apply weaker rules than the API did.

---

## Custody

### What exists, and where

Milestone III, all of it code and verified locally. **It is on the branch
`claude/milestone-iii-secret-management` and has not been merged to `main`**, so
a clone of `main` has none of the following:

- Every variable is classified secret or non-secret in
  `apps/api/src/secrets/classification.ts`, and that table drives log
  redaction, the leak regression tests, and the `.env.example` gate.
- Key material cannot reach a log, an error message, an audit entry, a metric,
  or a health response. `apps/api/src/__tests__/secrets.test.ts` iterates the
  classification table rather than checking one hand-picked example.
- Every ambiguous keyring configuration in the table above is refused at boot.
- A rotation survey (`apps/api/src/secrets/rotation.ts`) answers "is it safe to
  destroy the old key yet?" without decrypting anything.
- `npm run check:keys` rehearses the custody procedure against synthetic keys.

### What does not exist

**There is no production key, no secret store, and no deployment.** No key
material has ever been generated for a real environment.

The secret-source contract is runtime environment injection — see
[ADR-0011](DECISIONS.md#adr-0011--runtime-environment-injection-as-the-secret-source-contract).
The application reads `ENCRYPTION_KEY` from its environment and does not know
what put it there. Choosing the platform that puts it there is still open.

### Requirements for whoever provisions production

1. **The key never enters this repository, a container image, a CI log, an
   environment file in version control, a ticket, or a chat message.**
2. Hold it in a managed secret store (AWS Secrets Manager, GCP Secret Manager,
   Vault, or the platform's equivalent) and inject it into the process
   environment at runtime. The application needs no change for any of them.
3. Separate key material per environment. A staging key must not decrypt
   production data, or staging access becomes production access.
4. Restrict read access to the runtime service identity and a named break-glass
   role. Log every access to the secret itself, not only to the application.
   The policy is in [`RUNBOOKS.md` §2a](RUNBOOKS.md#2a-break-glass-access-to-secrets).
5. **Back the key up separately from the database, and test restoring it.** See
   the next section — this is the rule with the worst failure mode in the
   system.
6. Decide and document who can authorise a break-glass read.

---

## Backup and restore

**The key backup and the database backup are two halves, and they are kept
apart.** Both halves of that sentence carry weight:

| Situation | Result |
|---|---|
| Database backup restored, key **lost** | Every encrypted field is unrecoverable ciphertext. There is no recovery. Vendors must re-enter payout details and every administrator must re-enrol TOTP. |
| Database backup and key stored **together** | One archive, one theft, and the encryption has protected nothing. The separation *is* the control. |
| Database restored with the **active key only**, retired keys dropped | The subtle one. The system boots, most rows read, and a minority fail with `unknown_key` — usually discovered by a vendor, weeks later. |

`npm run check:keys` demonstrates all three against synthetic keys. It is a
rehearsal of the *procedure*, **not** of a real restore: no real backup has ever
been created, and none has ever been restored.

### What a key backup must contain

- The active key and its id.
- **Every key in `ENCRYPTION_KEYS_RETIRED`**, with its id. A restore that keeps
  only the active key loses every row not yet re-encrypted.
- Which environment each belongs to, so a staging key cannot be restored into
  production by mistake.

### Restore verification

After restoring both halves and before serving traffic, the survey in
`apps/api/src/secrets/rotation.ts` answers whether the keyring matches the data:

- `unknownKeyIds` non-empty means **rows are already unreadable** — a key is
  missing from the restore. Stop and find it before anything writes.
- `rowsNeedingReEncryption` above zero is normal mid-rotation and is not a
  restore failure.

The rest of the procedure is in [`RUNBOOKS.md` §3](RUNBOOKS.md#3-backup-and-restore).

## Rotation

The design supports rotation without downtime or a migration window:

1. Generate a new key and give it a new id.
2. Move the current key into `ENCRYPTION_KEYS_RETIRED` under its existing id.
3. Set `ENCRYPTION_KEY` / `ENCRYPTION_KEY_ID` to the new key. Deploy.

   New writes use the new key. Existing rows keep naming the old one and still
   decrypt, because the retired key is still held.

4. Re-encrypt in the background:

   ```ts
   import { reEncryptAll, surveyKeyUsage } from './secrets/rotation.js';

   const result = await reEncryptAll(prisma, keyring);
   ```

   This moves **every** encrypted column — vendor payout details *and* both TOTP
   secret columns. Missing the TOTP columns is exactly how a rotation looks
   complete and is not: payout details get surveyed, moved, and signed off while
   every administrator's second factor still sits under the key about to be
   destroyed.

   `decryptPayoutDetailsForSettlement()` also returns `needsReEncryption: true`
   for any record opened with a non-active key, which is the per-record form of
   the same signal.

5. **Check the retirement gate before removing anything.**

   ```ts
   const survey = await surveyKeyUsage(prisma, keyring);
   // survey.safeToRetireOtherKeys === true
   ```

   The survey reads each ciphertext's key id out of the envelope prefix without
   decrypting. Its parameter is a `KeyringIdentity` — `{ activeKeyId,
   heldKeyIds }` — not a `Keyring`, so it is the type signature rather than a
   convention that keeps key material out of it: an operator can run this from
   the key ids on a deployment manifest, holding no key. `keyringIdentity(ring)`
   derives those ids at a call site that already has a keyring, discarding the
   bytes. It reports:

   | Field | Meaning |
   |---|---|
   | `rowsNeedingReEncryption` | Rows still under a non-active key. Must be `0`. |
   | `unknownKeyIds` | Key ids found in stored data that the keyring does not hold. Must be empty — non-empty means rows are **already** unreadable, which is an incident, not a rotation step. |
   | `safeToRetireOtherKeys` | Both of the above are clear. **This is the only signal that gates key destruction.** |

6. Only once `safeToRetireOtherKeys` is true, remove the old key from
   `ENCRYPTION_KEYS_RETIRED` and destroy it per the retention policy.

**Do not skip steps 4 and 5.** Removing a retired key while rows still name it
makes those rows permanently unreadable — the failure is `unknown_key`, and
there is no recovery except restoring the key. `npm run check:keys`
demonstrates this failure against synthetic material, and
`apps/api/src/__tests__/key-rotation.test.ts` walks the whole sequence above
against a real database.

### When to rotate

- On any suspected exposure of key material — immediately, and treat it as an
  incident.
- When someone with break-glass access leaves.
- On a scheduled cadence once one is agreed. Annual is a common baseline; this
  has not been decided and needs an owner.

### What rotation does not do

Rotating the key does **not** invalidate anything an attacker already
decrypted. If a key is believed exposed, rotation is the second step. The first
is to treat every value it protected as compromised: force re-enrolment of every
TOTP secret, and require vendors to re-confirm payout details.

---

## Open decisions

| Question | Owner | Status |
|---|---|---|
| Which secret store, and which deployment platform | Codex / infrastructure | Open. Deliberately not chosen here — ADR-0011. The application needs no change for any of them. |
| Rotation cadence | Owner | Open. Annual is a common baseline; nothing is decided. |
| Who holds the break-glass role | Owner | Open. This repository defines no organisational roles and will not invent them. |
| Who authorises assuming it | Owner | Open. The policy requires a second person; who that is, is not decided. |
| Key backup location and restore drill schedule | Codex / infrastructure | Open. No backup exists and none has been rehearsed. |
| Whether NDPA 2023 imposes specific key-custody duties | Qualified Nigerian counsel | Open. Nothing here is a compliance statement. |
