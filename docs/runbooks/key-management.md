# Key management & credential custody

Audience: operators running DisFAP with real credentials. This is the canonical
reference for the Layer-2 owner-credential key, its rotation, backup, and the
migration plan for moving owner credentials into Vault.

> **Status.** The software key provider and the durable (file / env-PEM) key
> sources are implemented and tested, including restart persistence and rotation.
> The Vault HTTP adapter is implemented and tested against a **mock** Vault
> server, but has **not** been exercised against a real Vault cluster, and there
> is **no hardware-backed (HSM/KMS) provider**. Nothing here claims otherwise.

## 1. What is protected, and by what

| Secret | Custodian | At rest today | Reference |
|---|---|---|---|
| Per-session VM login | **Vault** (authoritative) | Only a pointer (`sessions.vault_cred_path`) in Postgres; the value lives in Vault and is read once via a response-wrapped, single-use token | `vault/vault-client.ts`, `credentials/credential-issuer.ts` |
| Owner-submitted software credential | **Postgres** (authoritative today) | Ciphertext in `software_licenses.encrypted_credentials`, sealed under the Layer-2 credential key; `key_fingerprint` records the sealing key id | `crypto/hsm-rsa.ts` |
| Rental-scoped re-seal (`pair_payload`) | Postgres, **transient** | Cleared when the rental ends (inline + a reaper sweep) | `marketplace/license-store.ts`, `marketplace/prisma-license-store.ts`, `marketplace/rental-reaper.ts` |
| Pair-key master seed | Config (`DFAP_PAIR_MASTER_KEY`) → HKDF per `(owner, rentee)` | Not stored; derived on demand | `crypto/pair-keys.ts` |

**Authoritative model (owner credentials).** The target is Vault-authoritative:
Vault holds the value, and Postgres holds only a pointer (`vault_cred_path`) plus
the sealing key id. That migration is **planned, not executed** — it requires a
real Vault to validate, and this milestone deliberately does not move secret
material into a store it cannot test (see §5).

## 2. Key material

- **Algorithm:** RSA-OAEP with SHA-256 (MGF1-SHA256). The payload records
  `algorithm: "RSA-OAEP-SHA256"` and the actual `keyBits`, both validated on
  load and on decrypt. Modulus sizes allowed: **2048, 3072, 4096**; the platform
  generates **4096**; the default minimum it will *load* is **3072**.
- **Key id (`keyFingerprint`):** `SHA-256(public-key DER-SPKI)` hex, first 32
  characters. It is public and stable, and is stored in
  `software_licenses.key_fingerprint` and inside each payload so a ciphertext can
  always be matched to its key. It is safe to log and to show to customers.
- **Sources** (pick one; config refuses to boot in production without one):
  - `DFAP_CREDENTIAL_KEY_FILE` — path to a PKCS#8 PEM (private). Created `0600`
    inside a `0700` directory on first use outside production.
  - `DFAP_CREDENTIAL_KEY_PEM` — base64 of the same PEM, for env-injected secrets.
  - Outside production only: if neither is set, a durable key file is created at
    `services/api/.dfap/credential-key.pem` (gitignored) so ciphertext survives a
    restart. **Production never falls back to an ephemeral key.**

Generate a key:

```sh
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out credential-key.pem
chmod 600 credential-key.pem
# env form:
base64 -w0 < credential-key.pem    # -> DFAP_CREDENTIAL_KEY_PEM
```

Private key material is never written to a payload, an API response, or a log
line. The provider exposes only the public key and the key id.

## 3. Rotation

Keys are rotated **without downtime** and without stranding ciphertext:

1. Generate a new key (§2).
2. Make it the active key (`DFAP_CREDENTIAL_KEY_FILE` / `DFAP_CREDENTIAL_KEY_PEM`).
3. Move the previous key material into `DFAP_CREDENTIAL_KEY_RETIRED_PEMS`
   (comma-separated base64 PKCS#8 PEMs). Retired keys are **decrypt-only**: new
   encryptions use the active key, but older ciphertext still opens.
4. Restart the API. New owner-credential submissions are sealed under the new key
   id; existing rows remain readable via the retired key.
5. Optionally re-encrypt: decrypt each `software_licenses.encrypted_credentials`
   with the retired key and re-seal under the active key, then update
   `key_fingerprint`. Until every row is re-encrypted, the retired key **must**
   remain configured.
6. Remove a retired key only once no ciphertext references its id (verify by
   scanning `software_licenses.key_fingerprint`).

## 4. Backup & recovery

- The active **and all retired** private keys are the recovery material. Store
  them in a secret manager / offline escrow. **Never** commit them; the repo
  ignores `*.pem`, `*.key`, and `.dfap/`.
- **Loss of a key is unrecoverable** for every ciphertext sealed under it: there
  is no escrow inside the application. This is why the key id is recorded per
  license — so the blast radius of a key loss is known and bounded.
- The dev key file (`.dfap/credential-key.pem`) is convenience, **not** a backup.
- Restore: place the PEM at the configured path (or in
  `DFAP_CREDENTIAL_KEY_PEM`) and restart. Decryption resumes for all payloads
  whose key id is present.

## 5. Ciphertext migration (planned, not executed)

Owner credentials are in Postgres today; the target is Vault (§1). The migration
must never strand a credential:

1. **Schema (additive):** add a nullable `vault_cred_path` column; make
   `encrypted_credentials` nullable. Values remain untouched.
2. **Dual-write:** on license create, write the credential to Vault (short TTL
   is not appropriate here — this is at-rest custody, not a session secret) and
   store the pointer, *while still writing the DB ciphertext*.
3. **Backfill:** for each existing license, decrypt the DB ciphertext with the
   credential-key provider (rotation-aware) and write to Vault; set the pointer.
4. **Cutover:** switch the read path to Vault. Keep dual-write on.
5. **Purge:** after a soak period, drop the DB ciphertext.
6. **Drop column:** remove `encrypted_credentials` in a **later** release.

**Rollback:** at any point before step 5 the read path can revert to the DB
ciphertext, because it is still present. The column drop (step 6) must never ship
in the same release as the read-path switch.

**Ciphertext migration requirement:** payload v2 carries `v`, `algorithm`,
`keyBits`, and `keyFingerprint`. Any payload sealed by the pre-M7 ephemeral
`SoftwareHsm` was already undecryptable after a restart; those rows (dev only)
must be re-submitted. There are no production rows to migrate: no database has
these tables applied yet.

## 6. What is explicitly *not* claimed

- No hardware-backed protection. `SoftwareHsm` holds the private key in process
  memory; it is a software provider, not an HSM.
- No audit has been done of a real Vault deployment; the HTTP adapter is
  validated only against a local mock server.
- Clearing a JavaScript string or assigning `null` does not guarantee physical
  memory erasure; plaintext lifetimes are bounded, not zeroed by force.
