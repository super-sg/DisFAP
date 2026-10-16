# @disfap/api — DisFAP control plane

Owns session lifecycle, the warm/cold VM pool, the reaper, DFAP1 connect-token
minting, credential staging, and a billing skeleton. Fastify + Prisma (Postgres),
Node 22, ESM, strict TypeScript.

## Responsibilities

| Area | Entry points |
|---|---|
| Session lifecycle FSM | `src/state-machine.ts` (pure, exhaustive) |
| Create / end / read sessions | `src/sessions/*`, routes in `src/app.ts` |
| Warm/cold pool (race-free claim) | `src/pool/pool-manager.ts` |
| Fleet reconciliation (teardown layer 4) | `src/pool/reaper.ts` |
| Cloud seam (fake + AWS stub) | `src/cloud/provider.ts` |
| Credential staging (Vault seam) | `src/vault/*`, `src/credentials/*` |
| Owner-credential key provider (Layer 2) | `src/crypto/hsm-rsa.ts`, `src/crypto/credential-key-store.ts` |
| Broker integration (closes the loop) | `src/integration/*` |
| Billing (Stripe seam, quota, usage) | `src/billing/*` |
| Composition root | `src/server.ts`, `src/config.ts` |

## The security-critical boundaries

- **Connect tokens** are minted with `mintConnectToken` imported from
  `@disfap/broker` — never reimplemented. The token names a session id and
  identity only: no host, no port, no credential (ADR-002). The contract test
  `test/create-session.test.ts` mints a token and verifies it with the broker's
  own `verifyConnectToken` — if the broker's format ever changes, this test
  fails.
- **Credentials never touch Postgres.** The per-session VM credential is minted
  at claim time, written to Vault (`secret/sessions/{sid}/rdp`) with a TTL, and
  handed to the broker as a single-use response-wrapped token. The DB stores
  only `sessions.vault_cred_path` (a pointer). `WrapTokenCache` holds the wrap
  token in-process between mint and connect.
- **Owner credentials are sealed, and the key is durable.** A software owner's
  submitted credential is encrypted at ingest under the Layer-2 RSA key
  (`src/crypto/hsm-rsa.ts`) with a payload that records the algorithm actually
  used, the actual modulus size, and a real key id (`SHA-256(SPKI DER)`). The key
  material is durable (`src/crypto/credential-key-store.ts`): a PKCS#8 PEM from
  `DFAP_CREDENTIAL_KEY_FILE`/`DFAP_CREDENTIAL_KEY_PEM`, with decrypt-only retired
  keys for rotation. Production refuses to boot without one. See
  [`docs/runbooks/key-management.md`](../../docs/runbooks/key-management.md). The
  catalog only ever returns `hsmKeyFingerprint` (a public key id), never
  credentials.
- **Burn-after-reading** (ADR-004): every `pool_instances` row gets an
  `expires_at` at creation, so the reaper can bound a VM's life even if the
  control plane forgets about it. The reaper also terminates DisFAP-tagged
  cloud instances that have no DB row (orphans) once past a 15-minute grace.

## Interfaces / fakes (Phase-0 vs Phase-1)

Every cloud/Vault/Stripe call is behind an interface with a fake in-memory
implementation for tests and Phase-0, and a real adapter (or a clearly-marked
stub where the real integration is not yet written):

| Interface | Fake (Phase-0/tests) | Real |
|---|---|---|
| `CloudProvider` | `FakeCloudProvider` | `AwsCloudProvider` (EC2 `RunInstances`; still a stub) |
| `VaultClient` | `FakeVaultClient` | `HttpVaultClient` (KV v2 + response-wrapping; tested against a mock server, not a real cluster) |
| `HsmService` (Layer-2 credential key) | `generateEphemeralHsm()` (tests only) | `SoftwareHsm` / `RotatingCredentialHsm` over a durable key from `DFAP_CREDENTIAL_KEY_FILE`/`_PEM`. Software key only — **no** HSM/KMS |
| `StripeClient` | `FakeStripeClient` | `RealStripeClient` |
| `Authenticator` | `DevHeaderAuthenticator` (local dev only) | `OidcAuthenticator` (verified OIDC/JWT access tokens); `FailClosedAuthenticator` is the `deny` default |

Inbound authentication **fails closed**: `DFAP_AUTH_MODE` defaults to `deny`, so
a deployment with no identity provider wired rejects every request rather than
trusting client-asserted identity. `dev-header` reads identity from
`x-dfap-user` / `x-dfap-org`, is refused when `DFAP_ENV`/`NODE_ENV` is
`production`, and never trusts `x-dfap-role` — roles are resolved server-side
from `org_members`. `oidc` verifies JWT **access** tokens with the maintained
`jose` library (signature, algorithm allowlist, exact issuer/audience, `exp`,
`nbf`, required `sub`; keys from a server-configured JWKS with rotation) and maps
`(issuer, subject)` to an internal user through `external_identities` — never
equating the external `sub` with a DisFAP id. Browser CORS uses an exact
`DFAP_CORS_ALLOWED_ORIGINS` allowlist (empty by default; wildcards rejected).

The AWS and Stripe SDKs are loaded via dynamic `import()`, so importing this
package needs neither the SDKs nor cloud credentials.

## HTTP surface

- `POST /sessions` → `{ sessionId, token, brokerUrl, expiresAt }`
- `POST /sessions/:id/end` (body `{ reason }`, non-`user` reasons require admin)
- `GET /sessions/:id` (credential/token-free view)
- `POST /billing/webhook` (raw-body Stripe signature verification, idempotent)
- `GET /healthz`

## Scripts

```bash
npm run prisma:generate   # generate the Prisma client (required before typecheck/build)
npm run typecheck         # tsc --noEmit
npm run test              # vitest run
npm run build             # prisma generate && tsc -p tsconfig.build.json
npm start                 # node dist/server.js
npm run provision:identity -- --issuer <url> --subject <sub> --user <userId>
```

> Type-checking and building require `prisma generate` first (it creates the
> `@prisma/client` types). Unit tests do **not** — the tested modules depend on
> the port interfaces in `src/ports.ts`, not on the generated client, so they
> run without a database.

## Provisioning OIDC identities (operator)

Every external identity must be mapped to an **existing** internal user before it
can authenticate; there is no just-in-time provisioning and email is never a
key. The supported workflow is the DB-direct CLI (run after `npm run build`):

```bash
DATABASE_URL='postgresql://…' npm run provision:identity -- \
  --issuer https://login.example.com/ \
  --subject '<token sub>' \
  --user usr_abc123 \
  [--email alice@example.com] [--reassign]
```

It is idempotent, validates the internal user exists, refuses to repoint an
existing `(issuer, subject)` to another user without `--reassign`, and prints
only non-secret identifiers. There is **no HTTP endpoint** for provisioning. See
[`docs/runbooks/oidc-production-onboarding.md`](../../docs/runbooks/oidc-production-onboarding.md).

## Configuration (fail-fast, `src/config.ts`)

Required: `DATABASE_URL`, `DFAP_SIGNING_KEYS` (`kid:base64,...`),
`DFAP_SIGNING_KID`, `BROKER_URL`. Optional: `CLOUD_PROVIDER` (`fake`|`aws`),
`AWS_REGION` / `AWS_LAUNCH_TEMPLATE_ID`, `VAULT_ADDR` / `VAULT_TOKEN`,
`DFAP_CREDENTIAL_KEY_FILE` / `DFAP_CREDENTIAL_KEY_PEM` /
`DFAP_CREDENTIAL_KEY_RETIRED_PEMS`, `DFAP_PAIR_MASTER_KEY`,
`STRIPE_API_KEY` / `STRIPE_WEBHOOK_SECRET`, `CONNECT_TOKEN_TTL_S` (≤60),
`CREDENTIAL_TTL_S`, `API_PORT`, `DFAP_AUTH_MODE`
(`deny`|`dev-header`|`oidc`, default `deny`), `DFAP_CORS_ALLOWED_ORIGINS`
(comma-separated exact origins, default none), `DFAP_GUEST_PROVISIONING`
(`disabled`|`instance-identity`, default `disabled`), `DFAP_GUEST_IDENTITY_CERT_FILE` /
`DFAP_GUEST_IDENTITY_CERT_PEM`, `DFAP_GUEST_PROVISIONING_TTL_S`,
`DFAP_GUEST_PROVISIONING_MAX_DELIVERIES`.

**Guest credential provisioning (audit C3 / M8).** `POST /internal/guest/provision`
lets a booting session VM prove its AWS instance identity and receive its session
credential once; it is gated, defaults to `disabled` (503), and requires AWS
instance-identity public-key material when enabled. **It is refused in production
until real AWS verification is validated** — see
[`docs/runbooks/guest-provisioning.md`](../../docs/runbooks/guest-provisioning.md).

**Production requires durable providers.** When `DFAP_ENV`/`NODE_ENV` is
`production`, boot fails unless all three are configured: a durable credential
key (`DFAP_CREDENTIAL_KEY_FILE` or `DFAP_CREDENTIAL_KEY_PEM`), the pair master
(`DFAP_PAIR_MASTER_KEY`, base64 ≥32 bytes), and Vault (`VAULT_ADDR` +
`VAULT_TOKEN`). This refuses the three silent fallbacks that would otherwise
masquerade as real security — an ephemeral in-memory key, a non-secret dev pair
seed, and the in-memory `FakeVaultClient`. Outside production, an unset
credential key uses a durable dev file at `services/api/.dfap/credential-key.pem`.
See [`docs/runbooks/key-management.md`](../../docs/runbooks/key-management.md).

When `DFAP_AUTH_MODE=oidc`, these are required: `DFAP_OIDC_ISSUER` (exact
issuer), `DFAP_OIDC_AUDIENCE` (the API's resource id). Optional:
`DFAP_OIDC_JWKS_URL` (else discovered from the issuer),
`DFAP_OIDC_ALGORITHMS` (default `RS256`; `none` rejected),
`DFAP_OIDC_CLOCK_TOLERANCE_S` (default 5), `DFAP_OIDC_ORG_CLAIM` (org *selector*
claim), `DFAP_OIDC_ACCESS_TOKEN_TYP` (e.g. `at+jwt`),
`DFAP_OIDC_TOKEN_USE_CLAIM`/`_VALUE` (default `token_use`/`access`),
`DFAP_OIDC_REQUIRE_TOKEN_USE` (default false),
`DFAP_OIDC_JWKS_CACHE_MAX_AGE_S` (default 600),
`DFAP_OIDC_JWKS_COOLDOWN_S` (default 30). Missing required provider settings fail
boot — the API never falls back to trusting anything.

The signing-key env format is identical to the broker's, so both services take
the same key material.
