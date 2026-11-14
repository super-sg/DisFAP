# Security architecture

This document describes the system **as implemented**, the trust boundaries
between its components, and the identity each component uses. Security
guarantees and their limitations are in [../security.md](../security.md);
secret inventory and lifecycle are in
[secrets-management.md](secrets-management.md).

If a statement here is not backed by code and a test, it says so.

## 1. Processes and ports

| Process | Code | Listens on | Reachable from | Identity |
|---|---|---|---|---|
| `caddy` | [deploy/Caddyfile](../../deploy/Caddyfile) | `:443`, `:80` | the internet | none (TLS terminator) |
| `web` | [apps/web](../../apps/web) + nginx | `:80` (container) | caddy only | none |
| `api` | [services/api](../../services/api) | `API_PORT` (3000 in compose; 8081 default) | caddy only | OIDC bearer (inbound), AppRole (Vault), AWS workload role, Postgres password, Stripe key |
| `broker` (in-process) | [services/broker](../../services/broker), hosted by the API | `BROKER_PORT` (8080) | caddy only | DFAP1 connect token from the browser; no separate service identity |
| `guacd` | upstream image | `:4822` | api only | none (see §5) |
| `postgres` | upstream image | `:5432` | api only | password role |
| `redis` | upstream image | `:6379` | api only | `requirepass` |
| `vault` | upstream image | `:8200` | api only | AppRole → short-lived token |

Only Caddy publishes host ports. guacd, Postgres, Redis and Vault are on the
`internal` Docker network, which has no gateway: they cannot reach the internet
and cannot be reached from the host.

**There is no separate broker container in the supported topology.** The broker
is a library that the API hosts in-process because it needs the control plane's
Prisma session resolver and Vault credential provider. A standalone broker
process refuses to start ([services/broker/src/server.ts](../../services/broker/src/server.ts))
rather than booting with empty stubs that reject every tunnel.

## 2. Trust boundaries

### B1 — Browser → Caddy → API

- Transport: TLS terminated at Caddy; HSTS, `X-Frame-Options: DENY`,
  `nosniff`, referrer policy and a CSP are set there.
- Authentication: `Authorization: Bearer <access token>` verified by
  [auth/jwks.ts](../../services/api/src/auth/jwks.ts) (signature, `iss`, `aud`,
  `exp`/`nbf`, pinned algorithms, `sub` present) and mapped to an internal user
  through `external_identities` ([auth/oidc.ts](../../services/api/src/auth/oidc.ts)).
- Authorization: server-side per request. A client-supplied `x-dfap-user`,
  `x-dfap-org` or `x-dfap-role` is ignored; org and role come from
  `org_members` ([../security.md](../security.md) Guarantee 6).
- CSRF: the API is bearer-token only — it sets no session cookie — so a
  cross-site request cannot carry the credential. CORS is an exact allowlist
  and never reflects an arbitrary `Origin`.
- Every response is `Cache-Control: no-store`; `/sessions/:id` returns a fresh
  single-use connect handle, which must not be cached by anything.

### B2 — API ↔ Vault

Crosses the private `internal` network. The API never holds a root token. It
authenticates with AppRole and holds a scoped policy
([deploy/vault/policies/api.hcl](../../deploy/vault/policies/api.hcl)). See
[secrets-management.md](secrets-management.md) §3.

The session credential is written with a Vault response-wrap TTL, so the write
response carries a single-use wrap token instead of the secret. The wrap token
travels only in-process to the broker resolver; it is never persisted and never
reaches the browser.

### B3 — Browser → broker (WebSocket)

- The DFAP1 handle is sent as the **first WebSocket frame**, not a query string
  or header, so it never appears in an access log.
- Verification pins HS256, rejects `alg` other than HS256, requires
  `typ=dfap-conn` and `aud=broker`, checks `iat`/`exp` (60 s), and burns the
  `jti` in a nonce store ([session-token.ts](../../services/broker/src/session-token.ts)).
- A replay of a validly signed token terminates the session it names.
- After verification the broker resolves the session **server-side** and
  requires the token's `sub`/`org` to equal the session record's
  ([tunnel.ts](../../services/broker/src/tunnel.ts)). A session id alone is
  never sufficient.
- The jti store is in-memory by default and Redis when `REDIS_URL` is set
  ([redis-nonce-store.ts](../../services/broker/src/redis-nonce-store.ts)). The
  Redis path fails closed: an unreachable store rejects the connect rather than
  treating it as first use.

### B4 — Broker → guacd

The only channel that ever carries a plaintext session credential. See §5.

### B5 — API → AWS

The API uses the instance's workload role / SSO profile. No long-lived access
keys are required, and none are stored by the application. Instance
provisioning is server-side only: the client supplies a template id, never a
provider call.

### B6 — Guest VM → API (optional, non-production)

`POST /internal/guest/provision` is deliberately **not** user-authenticated: a
booting guest has no user. Its authentication is the AWS-signed instance
identity document; its authorization is the server-side
instance → session binding built from records the control plane created. It is
refused in production until real AWS identity verification is validated
([../security.md](../security.md) Guarantee 8).

## 3. Session lifecycle (the money path)

1. `POST /api/sessions` → authenticated principal, quota check, template check.
2. Claim a warm instance or launch one. The credential is minted in the control
   plane and written to Vault `secret/sessions/{sid}/rdp` with a wrap TTL.
3. Persist the session with `vault_cred_path` (a pointer, never the secret) and
   mint a 60 s DFAP1 handle carrying `{sid, sub, org, jti}` only.
4. `GET /api/sessions/:id` → renter of record only; mints a **fresh** handle.
5. Browser opens `wss://<host>/tunnel`, sends the handle as frame 1.
6. Broker verifies, burns the jti, resolves the target + wrap token, unwraps
   once, connects to guacd, then wipes the credential in place.
7. `DELETE /api/sessions/:id` (renter, or tenant admin/owner) → terminate the
   instance, delete the Vault metadata path (all versions), close the tunnel.

## 4. Authorization matrix

Columns: an authenticated **member** of the tenant; the **renter of record** for
this session; a tenant **admin/owner**; a caller from **another tenant** (or no
membership). `—` means the operation is not offered to that role.

| Operation | Member | Renter of record | Tenant admin/owner | Other tenant |
|---|---|---|---|---|
| List templates | yes | yes | yes | yes |
| Create session | yes | — | yes | no (own org only) |
| Read session + connect handle | no | **yes** | no | no (403) |
| End session | no | yes | yes | no (403) |
| List marketplace | yes | yes | yes | yes (no credentials returned) |
| Create listing | yes | — | yes | yes (own listings) |
| Rent a listing | yes | — | yes | yes (any authenticated user) |
| Release a listing | no | no | no | owner only |
| Guest provisioning | — | — | — | instance identity only |

Reading a session is the renter **only** because a read mints a handle that
authenticates as the renter at the broker — a peer read would be account
sharing by another name ([http/session-view.ts](../../services/api/src/http/session-view.ts)).

## 5. guacd channel

guacd does not request client certificates, so this leg is **authenticated and
encrypted one way**, not mTLS.

- Production requires `GUACD_TLS=true` with `GUACD_CA` pinning
  (`rejectUnauthorized: true`, TLS ≥ 1.2) in
  [services/broker/src/config.ts](../../services/broker/src/config.ts).
- A cleartext hop is permitted only with an explicit
  `GUACD_ALLOW_CLEARTEXT=true`, which the single-host compose stack sets because
  guacd publishes no port and is reachable only on the private bridge.
- The credential is wiped from the connect values, the parameter map and the
  provider's object immediately after the handshake, on success and on failure
  ([services/broker/src/secrets.ts](../../services/broker/src/secrets.ts)).

## 6. Data plane protections

- Pixels only: the instruction filter drops file/clipboard/audio upload paths
  in both directions ([instruction-filter.ts](../../services/broker/src/instruction-filter.ts)).
- Session isolation: one tunnel per session, `sid`-scoped resolver entries, and
  a per-session credential in Vault — no shared credential pool.
- Ephemerality: burn-after-reading VMs, encrypted root volume,
  `DeleteOnTermination: true` ([cloud/provider.ts](../../services/api/src/cloud/provider.ts)).

## 7. Failure behaviour (fail closed)

| Dependency | Failure | Behaviour |
|---|---|---|
| Vault | unreachable / sealed | session creation fails with a clear error; existing sessions survive; no in-memory fallback in production |
| Vault AppRole | login rejected | no request is made; the operation fails |
| Redis (jti store) | unreachable | connect rejected; session is not resumed |
| OIDC issuer/JWKS | unreachable | 401; no unverified accept |
| Database | unreachable | 5xx `{"error":"internal_error"}`; the detail is logged only |
| guacd | unreachable | tunnel closed; session marked failed by the reaper |
| Missing production config | at boot | process exits with a specific message |

## 8. What this architecture does **not** claim

- No mTLS to guacd (see §5).
- No separate broker service identity, because there is no separate broker
  process. A split deployment must add an authenticated resolver endpoint
  before this changes.
- No Vault audit device is configured by the repo; Vault's own audit log is an
  operator prerequisite for investigating Vault-side access.
- No hardware HSM/KMS: the Layer-2 credential key is a software key.
- No browser-verified CSP: it is configured at Caddy but not exercised in a
  real browser in this environment.

See [../security.md](../security.md) "Known limitations" for the full list.
