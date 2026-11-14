# Security operations

How to run, verify and troubleshoot the security controls that exist. Every
command is the real one from the repository; nothing here is aspirational
without saying so.

## 1. Start and verify the stack

```bash
cd deploy
cp .env.example .env            # then fill in the CHANGE_ME values
make gen-keys                   # paste the two lines into .env
make up
make migrate
make vault-bootstrap            # one-time: prompts for the Vault root token
# paste the printed role_id/secret_id into .env, then:
make restart
```

Verification, in order:

```bash
make ps                                   # every service Up; vault may be "unhealthy" until unsealed
docker compose exec api wget -qO- http://127.0.0.1:3000/healthz
docker compose exec caddy wget -qO- http://api:3000/healthz
docker compose exec caddy wget -qO- http://api:8080/healthz   # in-process broker
docker compose exec vault vault status
```

`/healthz` is a **liveness** signal only: it does not assert database, Vault or
cloud health, because a failing dependency must not evict every instance from
behind a load balancer.

## 2. Configuration the process refuses to boot without

| Guard | Refusal |
|---|---|
| production without `DFAP_CREDENTIAL_KEY_FILE`/`_PEM` | "durable credential key" |
| production without `DFAP_PAIR_MASTER_KEY` | "DFAP_PAIR_MASTER_KEY" |
| production without Vault identity | "VAULT_ADDR" |
| `VAULT_ADDR` with no credential | "no Vault credential" |
| static token **and** AppRole | "not both" |
| production `http://` Vault without `VAULT_ALLOW_HTTP=true` | "https for VAULT_ADDR" |
| production cleartext guacd without `GUACD_ALLOW_CLEARTEXT=true` | "GUACD_TLS must be true" |
| production guacd TLS without `GUACD_CA` | "GUACD_CA must be set" |
| signing key < 32 bytes | "shorter than 32 bytes" |
| `DFAP_AUTH_MODE=dev-header` in production | "must not be used in production" |
| credentials TTL outside 60–86400 s | "CREDENTIAL_TTL_S" |

These are enforced in [services/api/src/config.ts](../../services/api/src/config.ts)
and [services/broker/src/config.ts](../../services/broker/src/config.ts); tests
live in [services/api/test/config.test.ts](../../services/api/test/config.test.ts)
and [services/api/test/broker-config.test.ts](../../services/api/test/broker-config.test.ts).

## 3. What the logs tell you

- `request rejected` — 4xx with `statusCode`, `method`, route **pattern**,
  `client`, `reason`. This is the audit trail for 401/403.
- `rate limit exceeded` — 429 with the route and the limit class.
- `broker security event` — `auth_failure`, `replay`, `violation`,
  `parse_error`, `connected`.
- `marketplace seed skipped (production)` — expected in production.
- `REDIS_URL is not set` — replay protection is process-local; fix before
  relying on single-use handles across restarts.

Never log: `Authorization`, `X-Vault-Token`, request bodies for
`/internal/guest/provision`, or credential fields.

## 4. Rate limits and body limits

Defaults ([http/rate-limit.ts](../../services/api/src/http/rate-limit.ts)):

| Class | Limit | Applies to |
|---|---|---|
| global | 300/min per IP | everything |
| session-create | 12/min per IP | `POST /sessions`, `POST /marketplace/rent` |
| guest-provision | 30/min per IP | `POST /internal/guest/provision` |

Body limit: 128 KiB. Both are overridable at construction
(`BuildAppOptions.rateLimits`, `bodyLimitBytes`) — tests inject small values
rather than disabling the controls.

Caveat: buckets are per **IP**, so every user behind one corporate NAT (or every
guest behind one VPC NAT gateway) shares a bucket. That is acceptable for the
single-tenant demo; a multi-tenant deployment should key on the authenticated
principal once identity is resolved, or raise the cap deliberately.

`trustProxy` is set in the composition root to a single trusted hop
(`(_address, hop) => hop === 0`) because the API is reachable only through Caddy,
which **overwrites** `X-Forwarded-For` with `{remote_host}`. One trusted hop
means a client-supplied prefix can never move `req.ip` (the rate-limit key and
audit field) off the real address. Do not enable trust proxy on a directly
exposed API.

## 5. Routine security checks

```bash
npm run typecheck
npm test                       # includes the security suites below
npm run build
npm audit --omit=dev
```

`npm audit --omit=dev` currently reports only the Prisma **CLI** (pulled in for
`prisma migrate deploy`); its advisory is in build-time config parsing and the
fix is Prisma 7 (major). Runtime-path advisories were cleared by bumping Fastify
to 5.12.7 and pinning `qs` ≥6.17.0 via root `overrides`. Vite/Vitest dev-server
advisories remain dev-only; do not expose `vite dev` to a network.

Security-relevant suites:

| Suite | Proves |
|---|---|
| `services/api/test/auth.test.ts` | forged identity headers ignored, denied by default |
| `services/api/test/oidc-e2e.test.ts` | token validation, issuer/audience, unmapped identity refused |
| `services/api/test/http-hardening.test.ts` | cross-tenant denial, renter-only reads, 5xx redaction, no-store, 429 |
| `services/api/test/vault-auth.test.ts` | AppRole login, refresh, single-flight, fail-closed, no secret in errors |
| `services/api/test/vault-client.test.ts` | wrap/unwrap once, path traversal blocked, 403 re-auth once |
| `services/api/test/config.test.ts` | every production guard |
| `services/broker/test/session-token.test.ts` | signature, alg pinning, TTL, replay |
| `services/broker/test/tunnel.test.ts` | identity mismatch, replay termination, credential wipe, nonce-store failure |
| `services/broker/test/redis-nonce-store.test.ts` | single-use, AUTH, fail-closed on outage |

## 6. Backups

| Data | Method | Notes |
|---|---|---|
| Postgres | `pg_dump` (logical) | contains identities and metadata, no plaintext credentials |
| Vault | `vault operator raft snapshot save` (production) or the `vaultdata` volume (Phase-0 file backend) | a snapshot without the unseal keys is useless — store them separately |
| Credential key | operator escrow | losing it makes every owner credential unrecoverable |

Restoring Vault without the same Layer-2 key and pair-key master produces a
system that cannot decrypt existing listings. Rotate rather than improvise.

## 7. Enabling the optional controls

- **Vault audit device** (recommended before production):
  `vault audit enable file file_path=/vault/logs/audit.log` — then ship that
  file off-host. The repository does not configure it.
- **Vault TLS**: set `VAULT_ADDR=https://…` and a real listener certificate;
  the `http://` form exists only for the single-host private bridge.
- **guacd TLS**: set `GUACD_TLS=true`, `GUACD_CA`, `GUACD_CERT`, `GUACD_KEY`
  and drop `GUACD_ALLOW_CLEARTEXT`. Requires a guacd build with a TLS listener.
- **Redis**: keep `REDIS_URL` set so replay protection survives restarts.
- **OIDC**: [runbooks/oidc-production-onboarding.md](../runbooks/oidc-production-onboarding.md).

## 8. What has not been validated here

- No `docker compose up` was executed in this environment (Docker daemon not
  running), so the compose/Caddy changes are reviewed, not exercised.
- The CSP is configured at Caddy but not browser-verified.
- The Redis nonce store is tested against a minimal RESP test server, not a
  real Redis.
- Vault policies and the bootstrap script are reviewed, not executed against a
  live Vault.
- No real OIDC provider, AWS instance identity document, or live RDP session
  was used.

Treat each of these as an operational validation step before production.
