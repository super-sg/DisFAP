# Incident response

What to do when a specific secret or boundary is suspected compromised. Every
step names a real command or file. No secret value appears in this document.

## 0. Evidence sources

| Source | What it holds | Where |
|---|---|---|
| `session_events` | per-session lifecycle + failure detail (`kind`, `actor`, `detail`) | Postgres |
| `audit_log` | hash-chained, per-tenant audit rows | Postgres |
| API logs | structured JSON: request id, status, route pattern, client IP, `request rejected` warnings, `rate limit exceeded` | container stdout |
| Broker security events | `auth_failure`, `replay`, `violation`, `parse_error`, `connected` | forwarded to the API logger |
| Caddy logs | TLS termination, request lines (never the connect token) | container stdout |
| Vault logs / audit | **no audit device is configured by this repo** — enable one before relying on Vault-side forensics | Vault operator |

The broker event with `kind: "replay"` is the strongest signal: a validly signed
handle was used twice, and the session it named is terminated automatically.

## 1. A DFAP1 connect handle leaked

Signal: `replay` event, or a user reports a session they did not start.

1. The broker already terminates the session named by the replayed handle.
2. Confirm from `session_events` (`kind = 'ended'`, reason mentions replay).
3. If the handle may not have been replayed yet, end the session:
   `DELETE /api/sessions/{sid}` as the renter or a tenant admin.
4. Ending destroys the VM and deletes the Vault credential path, so the handle
   becomes useless even before its 60 s expiry.
5. Nothing to rotate: the handle is a capability, not a stored secret.

## 2. The DFAP1 signing keyring leaked

Impact: an attacker can forge handles for any session id (but still needs the
session id and a matching `sub`/`org`, and the jti must be unused).

1. Mint a new kid:
   `cd deploy && make gen-keys` (prints `DFAP_SIGNING_KEYS` / `DFAP_SIGNING_KID`).
2. Add the new kid **alongside** the old one, set `DFAP_SIGNING_KID` to the new
   kid, restart the API (the broker verifies any key in the ring).
3. Wait at least 60 s (the handle TTL), then remove the old entry and restart.
4. Force-end every live session if you believe handles were minted:
   `DELETE /api/sessions/{sid}` for each ready/connecting session.

## 3. The Vault AppRole `secret_id` leaked

1. Revoke it and issue a new one:
   ```
   docker compose exec vault vault write -f auth/approle/role/disfap-api/secret-id
   ```
   (run with an operator token that can write that path — not the app's token).
2. Update `VAULT_APPROLE_SECRET_ID` (or the mounted secret file) and restart the
   API.
3. List and revoke outstanding secret ids / tokens for that role:
   ```sh
   vault list auth/approle/role/disfap-api/secret-id
   vault write auth/approle/role/disfap-api/secret-id-accessor/destroy secret_id_accessor=<accessor>
   ```
   Revoke any live token for the role by accessor (`vault list auth/token/accessors`,
   then `vault token revoke -accessor <accessor>`).
4. Review Vault's own logs for reads of `secret/data/sessions/*` you did not
   initiate. If an audit device was not enabled, you cannot reconstruct this —
   enable one now.
5. Rotate every session credential by ending the affected sessions.

## 4. The Vault root token leaked

1. `vault token revoke <root-token>` immediately (from a host that holds it).
2. Generate a new root token with `vault operator generate-root` only if needed
   for recovery; do not put it in `.env`.
3. Assume every secret in Vault was readable: end all sessions, rotate the
   AppRole `secret_id`, rotate Postgres/Redis passwords, rotate Stripe keys.
4. Re-run `make vault-bootstrap` to re-assert the policies.

## 5. The Layer-2 credential key (owner credentials) leaked

1. Follow [../runbooks/key-management.md](../runbooks/key-management.md): move
   the compromised key to `DFAP_CREDENTIAL_KEY_RETIRED_PEMS`, introduce a new
   `DFAP_CREDENTIAL_KEY_FILE`, re-seal every `software_licenses` row.
2. Notify listing owners: their uploaded credentials were decryptable.
3. Rotate the upstream software credentials themselves — the platform cannot do
   that for them.

## 6. The pair-key master seed leaked

Impact: every owner–rentee pair key can be derived, so any stored pair-sealed
payload is openable.

1. Generate a new `DFAP_PAIR_MASTER_KEY` (≥32 bytes base64).
2. Re-seal affected payloads (the pair key is derived, so there is no key table
   to migrate — re-encrypt under the new seed).
3. This is a breaking rotation: plan a maintenance window.

## 7. A session VM was compromised

1. End the session (`DELETE /api/sessions/{sid}`) — this terminates the instance
   and revokes the Vault credential.
2. Confirm the instance is gone (reaper / AWS console). If it is still running
   and unreachable by the API, terminate it out of band.
3. Treat the credential that VM held as burned; it is per-session and already
   revoked, and it is not reused elsewhere.
4. If the VM was rented from a marketplace listing, notify the owner.

## 8. Vault is unavailable or sealed

- New sessions fail; existing tunnels keep running until their credential was
  already consumed (it was consumed at connect time).
- Do **not** configure a fallback store to restore service. Unseal Vault instead.
- Check `docker compose exec vault vault status`; unseal with the offline keys.

## 9. Redis (replay store) is unavailable

- Every connect is rejected while it is down (fail closed) and a
  `"nonce store unavailable"` auth failure is emitted.
- Restore Redis; no manual cleanup is needed (burn keys are TTL'd).
- Do not remove `REDIS_URL` to "fix" it: that degrades replay protection to
  per-process memory.

## 10. Suspected credential leakage through logs

1. Search container logs for the field names (`password`, `privateKey`,
   `X-Vault-Token`, `Authorization`) — values should never appear.
2. If a value does appear, rotate that secret per the sections above, then fix
   the logging call site (redact, never stringify the object).

## 11. Post-disclosure checklist

- [ ] Session ended / credential revoked
- [ ] Secret rotated and redeployed
- [ ] Old credential revoked at the source (Vault, IdP, Stripe, DB)
- [ ] `session_events` / `audit_log` exported for the incident record
- [ ] Affected tenants notified if their credential or data was exposed
- [ ] Root cause fixed and a test added that fails without the fix
