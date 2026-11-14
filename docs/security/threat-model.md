# Threat model

Assets, actors, entry points, threats and the controls that actually exist.
Each control names the file that enforces it. Anything not enforced says
"residual".

Related: [architecture.md](architecture.md),
[secrets-management.md](secrets-management.md), [../security.md](../security.md).

## 1. Assets

| Asset | Impact if lost |
|---|---|
| Session VM credential (RDP/VNC) | direct control of a rented machine |
| Owner software credentials | licensed software / customer account compromise |
| DFAP1 signing keyring | forge connect handles for any session |
| Pair-key master / Layer-2 credential key | decrypt every stored owner credential |
| Vault AppRole secret_id | mint and read session secrets while the token lives |
| Postgres | session metadata, identities, usage (no plaintext credentials) |
| OIDC access tokens | act as the user against the API |
| AWS workload role | launch/terminate instances (scoped) |

## 2. Actors and entry points

| Actor | Entry point |
|---|---|
| Unauthenticated internet | Caddy `:443` → `/api/*`, `/tunnel`, static app |
| Authenticated user | the same API, bearer token |
| Tenant admin/owner | the API, elevated role from `org_members` |
| Compromised browser | a valid token, therefore the API as that user |
| Booting guest VM | `POST /internal/guest/provision` (non-production only) |
| Malicious session VM | outbound network, guacd's RDP client |
| Operator | shell, `deploy/.env`, Vault CLI |
| Infrastructure attacker | Docker host, Vault host, Postgres volume |

## 3. Threats and controls

### T1 — Steal a connect handle and hijack a session

- Controls: 60 s TTL, single-use `jti`, HS256 pinned, `aud`/`typ` checked,
  token sent as a WS frame (not a URL), identity in the token must equal the
  session record, replay terminates the session
  ([session-token.ts](../../services/broker/src/session-token.ts),
  [tunnel.ts](../../services/broker/src/tunnel.ts)).
- Residual: a token stolen and used **before** the legitimate client connects
  succeeds once. Channel binding (`cbh`) is minted but not enforced — enforcing
  it behind a proxy would break NAT'd clients, so it is documented as advisory.

### T2 — Read another tenant's session or instance

- Controls: tenant membership, renter-of-record read rule, admin/owner end rule
  ([http/session-view.ts](../../services/api/src/http/session-view.ts)); the
  resolver is keyed by the verified `sid`, and the broker cross-checks
  `sub`/`org`.
- Residual: a peer in the same org cannot read a session but **can** end it if
  they are an admin/owner — that is an explicit operational recovery decision.

### T3 — Steal a session credential from storage or the wire

- Controls: credentials live only in Vault; Postgres stores a path; the write is
  response-wrapped; the wrap token is single-use; the browser never sees a
  credential; the credential is wiped after the guacd handshake
  ([secrets.ts](../../services/broker/src/secrets.ts)).
- Residual: the plaintext exists in process memory during connect (bounded, not
  force-zeroed), and crosses the guacd socket (authenticated + encrypted, or
  explicitly acknowledged cleartext on a private bridge).

### T4 — Vault compromise / over-broad Vault identity

- Controls: AppRole with a scoped policy; no root token in the app; KV paths
  restricted to `sessions/*`; destructive deletes limited to the same prefix;
  path traversal blocked by `assertSafeSecretPath`; token refresh capped at
  5 minutes.
- Residual: whoever holds the `secret_id` plus network access can read session
  secrets while the AppRole role exists. Rotation is an operator step; there is
  no automatic revocation on suspicion.

### T5 — Forge a connect handle

- Controls: HMAC-SHA256 with a ≥32-byte key, constant-time compare, algorithm
  pinned, unknown `kid` rejected, `exp`/`iat` checked, `aud`/`scp` checked.
- Residual: keyring compromise forges anything; keys are env/file material with
  no HSM backing.

### T6 — Replay a handle across a broker restart

- Controls: Redis `SET NX EX` burn list when `REDIS_URL` is set, fail-closed on
  error ([redis-nonce-store.ts](../../services/broker/src/redis-nonce-store.ts)).
- Residual: with no `REDIS_URL`, the list is per-process and a restart forgets
  burned jtis for up to 60 s. The API logs a production warning in that case.

### T7 — Abuse provisioning / cost exhaustion

- Controls: authentication, per-IP rate limits (global, session-create,
  guest-provision), quota enforcement before launch, 128 KiB body cap, bounded
  `hoursRequested` (1–24), server-side template allowlist, reaper for orphans.
- Residual: quotas are per-tenant policy, not an absolute cloud budget; the
  AWS Budget alarm is operational, not in-code.

### T8 — Malicious guest VM pivots into the platform

- Controls: guacd reached over the private bridge only, no published ports,
  instruction filtering, guest provisioning refused in production, ephemeral
  instances.
- Residual: guacd is shared; a guacd RCE is a cross-tenant event. Per-VM sidecar
  guacd is the planned mitigation.

### T9 — XSS / token exfiltration from the browser

- Controls: React escaping, no `dangerouslySetInnerHTML` in session views, CSP
  at Caddy (`script-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`),
  tokens held in memory rather than `localStorage`.
- Residual: CSP is configured but not browser-verified here; `style-src
  'unsafe-inline'` is required by Guacamole/React inline styles.

### T10 — Malicious API input

- Controls: strict per-field validation, bounded enums, JSON-only bodies,
  `trustProxy` only behind the edge proxy, parameterized Prisma queries,
  5xx bodies replaced with `internal_error`.
- Residual: no schema library — validation is hand-written per route and could
  miss a field.

### T11 — Log injection / secret leakage into logs

- Controls: no token or credential is ever interpolated into an error; 4xx are
  logged as `{statusCode, method, route pattern, client, reason}`; user-controlled
  strings are not used as log keys.
- Residual: upstream library logs are not audited field by field.

### T12 — Operator or deployment compromise

- Controls: only Caddy publishes ports; Vault/Postgres/Redis are not routable;
  non-root containers; Postgres/Redis private; `.env` git-ignored; AppRole
  bootstrap done interactively.
- Residual: access to the Docker host is equivalent to full compromise. Vault
  storage is a single file-backed node in Phase-0.

## 4. Explicitly out of scope

- Physical access to the operator workstation.
- A compromised AWS account (the workload role can launch instances).
- IdP compromise (a stolen IdP token is a valid user).
- Side-channel attacks on shared CPU/memory between tenants.
- Denial of service at the network layer (only application-level rate limiting
  is implemented).
