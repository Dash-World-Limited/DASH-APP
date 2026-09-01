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

| Variable | Meaning |
|---|---|
| `ENCRYPTION_KEY` | Base64 of exactly 32 bytes. Encrypts all new values. |
| `ENCRYPTION_KEY_ID` | Name recorded in every envelope this key writes. |
| `ENCRYPTION_KEYS_RETIRED` | `id:base64key,id2:base64key2` — decrypt-only. |

Generate key material with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

The API validates key material at boot, not at first use: a malformed key fails
the process rather than surfacing weeks later in front of a user. An all-zero
key is rejected outright, because that is what an unset variable decodes to.

Production refuses to start without `ENCRYPTION_KEY`, and refuses to start with
`MFA_ENABLED=true` and no key — MFA without a key is not "MFA off", it is MFA
that fails at enrolment.

---

## Custody — for Codex to implement

**None of this is done. The repository has no production key and no secret
store.**

Requirements for whoever provisions production:

1. **The key never enters this repository, a container image, a CI log, an
   environment file in version control, or a ticket.**
2. Hold it in a managed secret store (AWS Secrets Manager, GCP Secret Manager,
   Vault, or the platform's equivalent) and inject it at runtime.
3. Separate key material per environment. A staging key must not decrypt
   production data, or staging access becomes production access.
4. Restrict read access to the runtime service identity and a named break-glass
   role. Log every access to the secret itself, not only to the application.
5. **Back the key up separately from the database, and test restoring it.** A
   database backup without the key is unrecoverable ciphertext; a key stored
   beside the backup defeats the encryption. These are the two halves and they
   must be kept apart.
6. Decide and document who can authorise a break-glass read.

## Rotation

The design supports rotation without downtime or a migration window:

1. Generate a new key and give it a new id.
2. Move the current key into `ENCRYPTION_KEYS_RETIRED` under its existing id.
3. Set `ENCRYPTION_KEY` / `ENCRYPTION_KEY_ID` to the new key. Deploy.

   New writes use the new key. Existing rows keep naming the old one and still
   decrypt, because the retired key is still held.

4. Re-encrypt in the background. `decryptPayoutDetailsForSettlement()` returns
   `needsReEncryption: true` for any record opened with a non-active key, which
   is the signal a rotation job uses to find outstanding rows.
5. Once nothing reports `needsReEncryption`, remove the old key from
   `ENCRYPTION_KEYS_RETIRED` and destroy it per the retention policy.

**Do not skip step 4.** Removing a retired key while rows still name it makes
those rows permanently unreadable — the failure is `unknown_key`, and there is
no recovery except restoring the key.

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

| Question | Owner |
|---|---|
| Which secret store | Codex / infrastructure |
| Rotation cadence | Owner |
| Who may authorise a break-glass read | Owner |
| Key backup location and restore drill schedule | Codex / infrastructure |
| Whether NDPA 2023 imposes specific key-custody duties | Qualified Nigerian counsel |
