# Configuration reference

Everything the platform reads from the environment, with its default and what it
actually does. The **validated** set is `services/api/src/config.ts`: a bad value
(or an unsafe combination) fails boot with a message naming the variable. The
broker reads `services/broker/src/config.ts`. Anything marked **required** has no
default — the process will not start without it.

Templates: [`.env.example`](../.env.example) (local), [`.env.dev.example`](../.env.dev.example)
(the fuller local demo), [`deploy/.env.example`](../deploy/.env.example) (deployed).

`DFAP_ENV=production` (or `NODE_ENV=production`) switches on the production
guards noted below. It is never inferred from a hostname.

## Runtime

| Variable | Default | Meaning |
|---|---|---|
| `DFAP_ENV` | `phase0` | `development` / `staging` / `production`. Enables the production guards. |
| `NODE_ENV` | — | Also triggers the production guards. |
| `API_PORT` | `8081` | HTTP listen port. `scripts/start-all.mjs` sets `3000`. |
| `CONNECT_TOKEN_TTL_S` | `60` | DFAP1 connect-token lifetime, clamped to 1–60. The broker refuses longer. |
| `CREDENTIAL_TTL_S` | `900` | Vault TTL for a staged session credential (bounded 60–86400). |
| `DFAP_DEV_FALLBACK` | `false` | Fabricate session/teardown results and serve the in-memory marketplace when the database is unreachable. **Refused in production.** |

## Signing keys

The API and broker must be handed the *same* material.

| Variable | Default | Meaning |
|---|---|---|
| `DFAP_SIGNING_KEYS` | **required** | `kid:base64, kid:base64, …`. Each value must decode to ≥32 bytes. Extra kids stay verify-only (rotation). |
| `DFAP_SIGNING_KID` | **required** | The kid used to *mint*. Must exist in `DFAP_SIGNING_KEYS`. |

Rotation: add the new key, switch `DFAP_SIGNING_KID`, keep the old key until its
longest-lived token has expired. See [runbooks/key-management.md](runbooks/key-management.md).

## Inbound authentication

| Variable | Default | Meaning |
|---|---|---|
| `DFAP_AUTH_MODE` | `deny` | `deny` (reject everything), `dev-header` (trust `x-dfap-user` / `x-dfap-org`, **refused in production**), `oidc` (verify a JWT access token). Roles always come from the database, never from a header. |
| `DFAP_OIDC_ISSUER` | required with `oidc` | Exact expected `iss`. Must be `http(s)`. |
| `DFAP_OIDC_AUDIENCE` | required with `oidc` | Exact expected audience — the API's resource id, not a client id. |
| `DFAP_OIDC_JWKS_URL` | discovery | Explicit JWKS endpoint. Defaults to OIDC discovery at the issuer. |
| `DFAP_OIDC_ALGORITHMS` | `RS256` | Comma-separated allowlist. `none` is rejected. |
| `DFAP_OIDC_CLOCK_TOLERANCE_S` | `5` | Allowed clock skew. |
| `DFAP_OIDC_ORG_CLAIM` | — | Claim carrying the org hint. Only *selects* among memberships that exist server-side. |
| `DFAP_OIDC_TOKEN_USE_CLAIM` | `token_use` | Claim name that distinguishes an access token from an id token. |
| `DFAP_OIDC_TOKEN_USE_VALUE` | `access` | Required value of that claim. |
| `DFAP_OIDC_REQUIRE_TOKEN_USE` | `false` | Set `true` for providers that issue both token types. |
| `DFAP_OIDC_JWKS_CACHE_MAX_AGE_S` | `600` | JWKS cache lifetime. |
| `DFAP_OIDC_JWKS_COOLDOWN_S` | `30` | Minimum gap between refreshes on an unknown `kid` (a DoS guard). |
| `DFAP_OIDC_ACCESS_TOKEN_TYP` | — | Required `typ` header, when the provider sets one. |

## Browser access (CORS)

| Variable | Default | Meaning |
|---|---|---|
| `DFAP_CORS_ALLOWED_ORIGINS` | empty | Comma-separated **exact** origins. Empty denies all cross-origin browser access. Wildcards, paths and trailing slashes are rejected at boot. |

## Database

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | **required** | Prisma connection string. Apply the schema with `npx prisma migrate deploy`. |
| `DFAP_TEST_DATABASE_URL` | — | Test-only. Points the PostgreSQL suite at a **disposable** database; the suite skips otherwise. |

## Provisioning provider

| Variable | Default | Meaning |
|---|---|---|
| `CLOUD_PROVIDER` | `fake` | `fake` (in-memory, zero cost) or `aws` (real EC2 — costs money). |
| `AWS_REGION` | required with `aws` | EC2 region. |
| `AWS_LAUNCH_TEMPLATE_ID` | required with `aws` | Launch template that owns the VM spec, hardening, and IAM instance profile. |
| `AWS_LAUNCH_TEMPLATE_VERSION` | latest | Pin a template version. |
| `AWS_SESSION_AMI_ID` | required with `aws` | Must be a real `ami-*`; placeholders are rejected. |
| `AWS_SESSION_INSTANCE_TYPE` | required with `aws` | Validated against `AWS_SESSION_ARCHITECTURE`. |
| `AWS_SESSION_ARCHITECTURE` | required with `aws` | `x86_64` or `arm64`. |
| `AWS_SESSION_VOLUME_GIB` | `20` | Root volume size sent with every `RunInstances` call. |

Prefer an AWS SSO profile (`AWS_PROFILE`) over static keys. Never commit
credentials; the SDK's default chain picks up the profile.

## Secrets

| Variable | Default | Meaning |
|---|---|---|
| `VAULT_ADDR` | — | When set, the API uses the real Vault client instead of the in-memory fake. **Required in production.** Production requires `https://` unless `VAULT_ALLOW_HTTP=true`. |
| `VAULT_APPROLE_ROLE_ID` | — | AppRole role id. **Preferred identity**; mutually exclusive with `VAULT_TOKEN`. |
| `VAULT_APPROLE_SECRET_ID` / `_FILE` | — | AppRole secret id, inline or from a file (preferred on a container host). Required with the role id. |
| `VAULT_TOKEN` / `VAULT_TOKEN_FILE` | — | Static-token fallback for platforms that cannot issue an AppRole. Must carry the scoped policy, never a root token. Exactly one of the inline/file forms. |
| `VAULT_MOUNT` | `secret` | KV v2 mount point (single path segment). |
| `VAULT_NAMESPACE` | — | Vault Enterprise namespace (ignored by OSS). |
| `VAULT_ALLOW_HTTP` | `false` | Production escape hatch for a Vault reachable only over a private, non-routable network. Cleartext is otherwise refused at boot. |
| `DFAP_CREDENTIAL_KEY_FILE` | — | PEM file holding the durable credential-sealing key (Layer 2). **Required in production.** |
| `DFAP_CREDENTIAL_KEY_PEM` | — | The same key inline (alternative to the file). |
| `DFAP_CREDENTIAL_KEY_RETIRED_PEMS` | — | Newline/comma-separated retired keys, decrypt-only, for rotation. |
| `DFAP_PAIR_MASTER_KEY` | — | Base64 seed (≥32 bytes) for the per-owner–rentee pair keys. **Required in production**; otherwise a non-secret development seed is derived. |

## Marketplace billing

| Variable | Default | Meaning |
|---|---|---|
| `STRIPE_API_KEY` | — | When set, metering is sent to Stripe. |
| `STRIPE_WEBHOOK_SECRET` | required with `STRIPE_API_KEY` | Signing secret for `POST /billing/webhook`. The raw body is verified before parsing. |

## Guest credential provisioning

| Variable | Default | Meaning |
|---|---|---|
| `DFAP_GUEST_PROVISIONING` | `disabled` | `disabled` (endpoint answers 503) or `instance-identity` (verify an AWS-signed instance identity document, enforce the instance→session binding, deliver the credential once). **Refused in production** until real AWS verification is validated. |
| `DFAP_GUEST_IDENTITY_CERT_FILE` | — | PEM file of the AWS regional instance-identity public key. |
| `DFAP_GUEST_IDENTITY_CERT_PEM` | — | The same key inline. |
| `DFAP_GUEST_PROVISIONING_TTL_S` | `900` | Absolute ceiling on a provisioning window. |
| `DFAP_GUEST_PROVISIONING_MAX_DELIVERIES` | `10` | Max deliveries per live session, idempotent retries included. |

## Readiness and pool tuning

| Variable | Default | Meaning |
|---|---|---|
| `DFAP_READY_TIMEOUT_S` | `600` (30–3600) | Budget for a VM to be `running` **and** accept a connection on the probe port. Missing it fails the session and destroys the VM. |
| `DFAP_READY_PROBE_PORT` | `3389` | Port the readiness probe dials. |
| `DFAP_EVAL_SSH_PUBKEY` | — | SSH public key installed on disposable evaluation VMs (cloud-init path only; production injects no login material). |

## Broker and guacd

Read by `services/broker/src/config.ts`; `scripts/start-all.mjs` also passes the
same values to the in-process broker.

| Variable | Default | Meaning |
|---|---|---|
| `BROKER_PORT` | `8080` | WebSocket listen port. |
| `BROKER_WS_PATH` | `/tunnel` | Path the broker serves. |
| `GUACD_HOST` | `127.0.0.1` | guacd address. Keep it on loopback. |
| `GUACD_PORT` | `4822` | guacd port. |
| `GUACD_TLS` | `false` | Connect to guacd over TLS. When `true`, `GUACD_CERT` and `GUACD_KEY` are required (and `GUACD_CA` is optional). **In production `true` is mandatory** because the session credential is injected over this channel. |
| `GUACD_CA` | — | CA bundle used to verify guacd's certificate (`rejectUnauthorized: true`, TLS ≥1.2). **Required in production when `GUACD_TLS=true`**, so the peer is pinned rather than trusted via the ambient store. |
| `GUACD_CERT` / `GUACD_KEY` | — | Client certificate/key presented to guacd. Required when `GUACD_TLS=true`. guacd does not request client certs, so this authenticates nothing by itself — it is kept because the TLS handshake configuration requires a pair. |
| `GUACD_ALLOW_CLEARTEXT` | `false` | Production-only escape hatch: with `GUACD_TLS=false`, boot fails unless this is `true`. It asserts that guacd has no published port and is reachable only over a private network. The broker logs a warning at startup whenever the channel is cleartext. |
| `MAX_CLIENT_VIOLATIONS` | `5` | Filter violations tolerated before the broker drops the connection. |
| `REDIS_URL` | — | `redis://[:password@]host[:port][/db]` or `rediss://`. When set, the in-process broker burns connect-token `jti`s in Redis (`SET NX EX`) so single-use survives a restart; when absent it uses an in-memory list and logs a production warning. Redis failures reject the connect (fail closed). |
| `BROKER_URL` | **required** | Public base URL the browser is told to dial. **Base URL only** — the client appends `BROKER_WS_PATH`. |

## Frontend (build-time, Vite)

| Variable | Default | Meaning |
|---|---|---|
| `VITE_API_BASE_URL` | dev proxy | API origin baked into the bundle. |
| `VITE_WS_URL` | dev proxy | Broker origin baked into the bundle. |
| `VITE_STRIPE_PUBLISHABLE_KEY` | — | Reserved for the hosted-checkout path; the current web build does not read it. |

## Deployment only

Used by `deploy/docker-compose*.yml` and Caddy rather than by application code:
`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `REDIS_PASSWORD`,
`DFAP_SITE_ADDRESS`, `CADDY_ACME_EMAIL`. See [deploy/README.md](../deploy/README.md).
