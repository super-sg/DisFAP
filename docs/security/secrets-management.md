# Secrets management

What secrets DisFAP handles, who owns each one, where it lives, how long it
lives, and how it is rotated or revoked. No values appear here — only names,
paths and procedures.

Architecture and trust boundaries: [architecture.md](architecture.md).

## 1. Inventory

| Secret | Owner | Consumers | Storage | Lifetime | Rotation |
|---|---|---|---|---|---|
| DFAP1 signing keyring | platform operator | api (mint), broker (verify) | env `DFAP_SIGNING_KEYS` / `_KID` | long (rotation by `kid`) | add a new `kid`, switch `DFAP_SIGNING_KID`, retire the old entry after 60 s |
| Pair-key master seed | platform operator | api | env `DFAP_PAIR_MASTER_KEY` | long | re-seal owner credentials; see [../runbooks/key-management.md](../runbooks/key-management.md) |
| Layer-2 credential key (RSA-4096) | platform operator | api | file `DFAP_CREDENTIAL_KEY_FILE` or env `_PEM` | long | `DFAP_CREDENTIAL_KEY_RETIRED_PEMS` + re-seal |
| Per-session VM credential | api (minted per session) | broker (once) | Vault KV `secret/sessions/{sid}/rdp`, wrapped | `CREDENTIAL_TTL_S` (60–86400 s, default 900) | never rotated — destroyed at session end |
| Owner software credential | listing owner | api at rent time | `software_licenses.encrypted_credentials` (RSA-OAEP, Layer-2 key) | until the listing is deleted | re-upload the listing |
| Postgres role password | operator | api | `.env` → `DATABASE_URL` | long | `ALTER ROLE … PASSWORD` then update the deployment secret |
| Redis password | operator | api | `.env` → `REDIS_URL` | long | `requirepass` + `.env` |
| Vault AppRole `secret_id` | operator | api | `VAULT_APPROLE_SECRET_ID` or `_FILE` | operator-defined | `vault write -f auth/approle/role/disfap-api/secret-id`, update, revoke the old one |
| Vault root token | operator | **nobody in the app** | operator's password manager | one-time | revoke after bootstrap (`vault token revoke`) |
| Stripe secret + webhook signing secret | operator | api | `STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET` | long | Stripe dashboard |
| AWS credentials | AWS | SDK | instance role / SSO profile | short (STS) | automatic |
| OIDC access token | IdP | browser | in-memory only | minutes | automatic |

The web app is a **public OIDC client** using Authorization Code + PKCE: there
is no client secret in the bundle, and nothing secret is ever built into it.

## 2. Where secrets are *not* allowed

- Not in Postgres: `sessions.vault_cred_path` is a pointer; `sessions` has no
  credential column. `software_licenses.encrypted_credentials` is ciphertext by
  design (owner-uploaded, Layer-2 sealed).
- Not in the browser: the only thing the client holds is a 60 s opaque handle
  that names a session and nothing else.
- Not in logs: errors carry a status, never a token or body
  ([vault/errors.ts](../../services/api/src/vault/errors.ts)); the broker's
  security events carry an event kind and sid, not credential material.
- Not in URLs: the connect token is the first WebSocket frame.
- Not in `userData` in production: the eval cloud-init path only installs a
  credential explicitly marked `demoOnly`, and production uses no pre-boot
  injection at all.

## 3. Vault: identity, policy, lifecycle

### Identity

The API authenticates with **AppRole**, not a root token:

```
VAULT_APPROLE_ROLE_ID=...
VAULT_APPROLE_SECRET_ID=...        # or VAULT_APPROLE_SECRET_ID_FILE
```

`AppRoleTokenSource` ([vault/vault-auth.ts](../../services/api/src/vault/vault-auth.ts))
logs in to `auth/approle/login`, caches the token for the lesser of
`lease/2`/`lease − 60 s` and 5 minutes, re-authenticates before expiry, and
shares one login across concurrent callers. A 403 invalidates the cached token
and retries the request **once**; a policy denial therefore still surfaces.

A static `VAULT_TOKEN` / `VAULT_TOKEN_FILE` is still accepted for platforms that
cannot issue an AppRole, but it must carry the same scoped policy. The
application never uses a root token — the bootstrap script uses it once, from an
interactive prompt, and tells you to revoke it.

### Policy

[deploy/vault/policies/api.hcl](../../deploy/vault/policies/api.hcl) grants only:

| Path | Capabilities | Why |
|---|---|---|
| `secret/data/sessions/*` | create, read, update | mint and re-read a session credential |
| `secret/metadata/sessions/*` | read, delete | destroy all versions at session end |
| `sys/wrapping/wrap` | update | response-wrap the write |
| `sys/wrapping/unwrap` | update | consume the single-use token |

[deploy/vault/policies/broker.hcl](../../deploy/vault/policies/broker.hcl) grants
only `sys/wrapping/unwrap` — reserved for a split deployment.

No other mount, no `sys/*` administration, no token or policy management.

### Bootstrap (one time, operator)

```
cd deploy
make up                  # Vault starts sealed
docker compose exec vault vault operator init      # store the keys offline
docker compose exec vault vault operator unseal    # x3
make vault-bootstrap     # prompts for the root token; prints role_id/secret_id
```

`make vault-bootstrap` creates the policies, enables AppRole, creates the
`disfap-api` and `disfap-broker` roles, and prints the two values for
`deploy/.env`. Then revoke the root token.

### Lifecycle

| Phase | Mechanism |
|---|---|
| Create | `writeWrappedSecret` → KV v2 POST with `X-Vault-Wrap-TTL`; the response is a wrap token, not the secret |
| Retrieve | broker/API `unwrap` once; a second unwrap fails (`WrapTokenConsumedError`) |
| Expiry | KV entry TTL = `CREDENTIAL_TTL_S`; the wrap token has the same TTL |
| Revoke | `DELETE secret/metadata/sessions/{sid}` destroys all versions (idempotent, 404-tolerant) |
| Rotation | not applicable to a per-session credential — it is created and destroyed |

Path safety: every path segment must be `[A-Za-z0-9._-]` and start alphanumeric
([assertSafeSecretPath](../../services/api/src/vault/vault-client.ts)), so a
malformed session id cannot address or delete another secret.

### Failure behaviour

| Failure | Result |
|---|---|
| Vault unreachable / sealed | creation fails; no fallback store |
| AppRole login rejected | no request is attempted |
| Wrapped token already consumed | `WrapTokenConsumedError`; treated as tamper |
| Policy denial | 403 surfaced, one retry only |

## 4. Secret delivery to the browser and the VM

- The browser receives a 60 s capability handle only. It never receives a
  username, password, host or port (ADR-002).
- A guest VM that needs its login credential uses the verified
  instance-identity pull path, which is refused in production until real AWS
  verification is validated. There is no fallback that embeds a credential in an
  image or in userData.

## 5. Leak response

If any secret above is suspected exposed, follow
[incident-response.md](incident-response.md). Removing a value from the current
tree does **not** make a previously committed value safe — rotate it.

## 6. Not implemented (stated plainly)

- No dynamic database credentials (Vault database secrets engine).
- No Vault Transit for the Layer-2 key.
- Owner credentials are not yet stored in Vault (ciphertext stays in Postgres;
  migration runbook written, not executed).
- No hardware HSM/KMS.
- No Vault audit device configured by this repository.
- No response-wrapped delivery of the AppRole `secret_id` — it is a normal
  deployment secret.
