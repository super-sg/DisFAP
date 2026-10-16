# DisFAP Security Model

This document is the canonical statement of what DisFAP guarantees, what it does not, and where each guarantee is enforced in code. It is written to double as the basis for customer security questionnaires.

## Threat model

**Assets:** customer application data visible inside a session; session credentials; session recordings; the platform's own secrets.

**Adversaries considered:**

| Adversary | Capability assumed |
|---|---|
| Malicious/compromised session user | Full control of their browser and device; valid login |
| Compromised client device | Malware with access to everything the browser holds |
| Network attacker | Observe/replay/modify traffic between browser and platform |
| Compromised session VM | Arbitrary code execution inside the guest |
| Curious/negligent insider at a tenant org | Valid admin credentials for their own org only |

**Explicitly out of scope:** shoulder-surfing and camera capture of the screen (mitigated by watermarking, not prevented); a compromised control plane (that is game over for any platform — mitigated by minimizing its secret surface, not by design guarantees).

## Guarantee 1 — Pixel-only: no data channel to the client

The client receives rendered pixels and sends keyboard/mouse input. Nothing else. Enforced in **four independent layers**, so no single misconfiguration or compromise opens a channel:

| # | Layer | Enforcement point | Survives |
|---|---|---|---|
| 1 | guacd connection parameters | `disable-copy`, `disable-paste`, `enable-drive=false`, `enable-printing=false`, no SFTP — set server-side by the broker, never client-influenced | Client tampering |
| 2 | **Broker instruction filter** | [services/broker/src/instruction-filter.ts](../services/broker/src/instruction-filter.ts) — client→guacd strict allowlist (`mouse`, `key`, `size`, `sync`, `nop`, `disconnect`); guacd→client stream-index tracking that drops `file`/`clipboard`/`pipe` streams while passing `img`/`audio` | Layer-1 misconfiguration; guacd parameter regressions |
| 3 | Guest OS policy | xrdp channel config / Windows GPO baked into the hardened image — redirection disabled at the host | A compromised **broker** trying to enable channels |
| 4 | Browser client | `onfile`/`onclipboard` handlers never attached; no clipboard bridge instantiated | Accidental client-code regressions |

Layer 2 is the load-bearing one and the only one we fully control at runtime. Any non-allowlisted instruction is dropped **and logged as a security event** against the session; repeated violations flag the session for termination.

## Guarantee 2 — Credentials never transit the client

The browser receives a 60-second, single-use, HMAC-SHA256-signed **handle** naming a session id — nothing else (see [adr/002](adr/002-opaque-token-over-guacamole-auth-json.md)). The broker resolves the handle server-side and fetches the VM credential from Vault with a response-wrapped, read-once token. Replayed handles terminate the session. Verification: a devtools network capture of a full session contains no hostname, username, or password in any payload.

## Guarantee 3 — Session isolation

- One security group per session; ingress only from guacd's SG on the RDP port; **no self-referencing rules** — tenant VMs can never reach each other.
- Egress default-deny with per-org allowlist. For third-party-access use cases, egress *is* the exfiltration path; blocking it is a feature.
- No public IPs on session VMs. Admin access via SSM only; no bastion, no SSH keys on disk.
- Continuously verified: a nightly job launches sessions in two orgs and asserts zero cross-reachability from inside each VM.

## Guarantee 4 — Ephemerality

VMs boot from an offline-hardened golden image whose AMI id and snapshot SHA-256 are recorded per session, and are **destroyed, never reused** ([adr/004](adr/004-burn-after-reading-vms.md)). Five independent teardown layers ensure destruction happens even under total control-plane failure.

## Guarantee 5 — Tamper-evident audit

Session recordings are written on trusted infrastructure (the guacd node, not the VM), streamed to S3 with Object Lock (WORM), and chunk-chained with Vault Transit HMACs so removal or alteration of any frame is detectable. The platform audit log is hash-chained the same way. Recording access is itself an audited, privileged action.

## Guarantee 6 — Authenticated, tenant-scoped control plane

The control plane resolves every request to an authenticated principal before
doing anything. The rules are absolute:

- **Identity is never self-asserted.** `DFAP_AUTH_MODE` defaults to `deny`,
  which rejects every request: an unconfigured deployment serves nothing. The
  `dev-header` mode (identity from `x-dfap-user` / `x-dfap-org`) is
  local-development only and is refused at config load when
  `DFAP_ENV`/`NODE_ENV` is `production`.
- **`oidc` mode verifies real access tokens.** With `DFAP_AUTH_MODE=oidc` the
  control plane verifies OIDC/JWT **access** tokens through the maintained
  [`jose`](https://github.com/panva/jose) library (never hand-rolled crypto):
  signature, a configurable algorithm allowlist (never `none`), exact issuer,
  exact audience, `exp`, `nbf`, and a required `sub`. Signing keys come from a
  server-configured JWKS (explicit URL or OIDC discovery) with automatic refresh
  on key rotation; a request can never supply a key or JWKS URL. ID tokens
  (which address a client, not the API) are rejected — via the audience and,
  when the provider marks it, a `token_use`/`typ` discriminator. Every failure —
  bad signature, unknown key, expired, wrong issuer/audience, or an unreachable
  JWKS — is a 401, never an unverified accept.
- **External identity is mapped, not equated.** A verified token's `sub` is
  never treated as an internal DisFAP user id. It is resolved through
  `external_identities`, keyed on `(issuer, subject)`; email is informational
  and never an identity key. An unmapped identity is rejected — there is no JIT
  provisioning.
- **Privilege is server-side data, never a header or a claim.** Owner/admin is
  looked up from `org_members`; `x-dfap-role` is ignored by construction, and an
  optional org claim only *selects* among the caller's real memberships — it
  never grants one.
- **The browser acquires tokens via Authorization Code + PKCE, and treats them as
  opaque.** `apps/web` drives login/callback/logout with the maintained
  [`oidc-client-ts`](https://github.com/authts/oidc-client-ts) library (public
  client, **no client secret**, S256 PKCE, a fresh `nonce`); the access token for
  the API audience is attached as `Authorization: Bearer`. Access/refresh tokens
  are kept **in memory**, never `localStorage`. The browser never decides that a
  token is valid — it only transports it; only the API verifies it (signature,
  issuer, audience, claims). A denied login, a callback error, or a failed
  renewal clears the session and leaves the client unauthenticated (never a
  misleadingly "logged-in" state).

Object-level authorization is enforced per resource: session read/terminate
requires the session's `orgId` to match the principal's; releasing a marketplace
license requires the caller to be the license owner. Browser origins are
restricted by the exact `DFAP_CORS_ALLOWED_ORIGINS` allowlist — the API never
reflects an arbitrary `Origin` and never pairs `*` with credentials.

> The browser login flow and the backend verification/identity mapping above are
> implemented and tested against local test issuers and fixtures. **The
> end-to-end production login is still incomplete**: no **real** identity
> provider has been connected or tested. Until one is (see
> [runbooks/oidc-production-onboarding.md](runbooks/oidc-production-onboarding.md)),
> and `DFAP_AUTH_MODE=oidc` is configured against it, production remains
> effectively fail-closed.

## Guarantee 7 — Owner credentials are sealed under a durable, validated key

Owner-submitted software credentials are encrypted at ingest and only decrypted
inside the control plane (Layer 2). The rules:

- **A durable key provider is mandatory in production.** Config refuses to boot
  with an ephemeral key: `DFAP_CREDENTIAL_KEY_FILE` or `DFAP_CREDENTIAL_KEY_PEM`
  must be set (see [runbooks/key-management.md](runbooks/key-management.md)).
  Outside production a durable key file is created at
  `services/api/.dfap/credential-key.pem`, so ciphertext survives a restart.
- **The key is validated, and the metadata is honest.** The provider refuses a
  non-RSA key, a modulus off the allowed list, or one below the configured
  minimum; each payload records the algorithm actually used (`RSA-OAEP-SHA256`)
  and the actual modulus size, and both are re-checked on decrypt. The key id is
  a real fingerprint — `SHA-256(SPKI DER)` — not a timestamp label.
- **Decryption fails closed.** An unknown key id, an unexpected algorithm, a
  version/key-size mismatch, or a tampered ciphertext is an error — never a
  best-effort guess.
- **Rotation is supported.** Retired keys (`DFAP_CREDENTIAL_KEY_RETIRED_PEMS`)
  are decrypt-only, so the active key can rotate without stranding ciphertext.
- **Private material never leaves the process.** No payload, API response, or log
  line contains a private key.
- **The rental-scoped re-seal is transient.** `license_rentals.pair_payload` is
  dropped when the rental ends (inline, plus an idempotent reaper sweep); it is
  never retained past the rental it was minted for.

> This is a **software** key provider — no hardware-backed protection. No
> HSM/KMS/Transit provider is implemented, and the Vault HTTP adapter is tested
> against a mock server, not a real cluster. Moving owner credentials into Vault
> is **planned, not implemented** (see
> [runbooks/key-management.md](runbooks/key-management.md) §5).

## Guarantee 8 — Guest credentials are provisioned to a *proven* instance, fail-closed

The Linux session VM obtains its login credential at first boot by proving
**which instance it is** to the control plane; nothing is baked into the image.
This closes audit finding **C3** (previously the guest had no way to obtain or
materialize the credential).

- **No shared secret in a reusable image.** The retired design sealed the
  credential into EC2 `userData` and expected an in-image unit to unseal it — but
  a guest-side decryption key baked into an AMI is a shared secret across every
  instance of that image. That realization is now **dev/test only**; in
  production nothing is placed in `userData`.
- **Trust root is an independently verifiable, per-instance proof.** The guest
  presents AWS's RSA-signed EC2 **instance identity document** (IMDSv2, with the
  detached `/signature`). It is verified with Node's `crypto` RSA-SHA256 (never a
  hand-rolled scheme). IMDS is link-local and only serves the instance's **own**
  document, so instance A cannot obtain or forge a document naming instance B.
- **Authorization is server-side data.** The verified instance id is joined to
  `pool_instances.cloud_instance_id` → the session this control plane launched it
  for; the AMI, region, session state and TTL are all re-checked. The guest never
  names its own session, and a generic shared instance role is **not** accepted as
  authorization.
- **The guest re-checks and fails closed.** `dfap-provision.service` validates
  the package against its own `instance-id`, `ami-id` and `dfap:session_id` tag,
  materializes a least-privilege `tsusers` account, and only then lets
  xrdp/xrdp-sesman start (`Requires=dfap-provision.service`). Any failure — bad
  signature, wrong binding, unreachable control plane, failed account creation —
  leaves the RDP listener **down**.
- **Secrets stay off argv/logs.** The credential arrives only in the TLS response
  body, is written to a mode-0700 temp file removed on exit, and is set via
  `chpasswd` on **stdin** — never echoed, never an argument, never logged.
- **Revocation and idempotency.** The session's credential delivery is bounded
  (TTL + delivery cap) and revocable; teardown revokes provisioning authority
  (bounded retry) and a terminal session is denied outright. Repeated delivery
  for the same instance is idempotent.
- **Hardening reconciled honestly.** The account databases (`/etc/passwd`,
  `/etc/shadow`, `/etc/group`, `/etc/gshadow`) are deliberately **not** made
  immutable via `chattr +i`: first-boot provisioning must write them, and a
  boot-time `chattr -i` would buy no real protection. They rely on default
  permissions, auditd watches, and VM burn-after-reading. Every other immutable
  file in the hardening list is unchanged.

> **Not production-enabled, and not claimed to be.** The verifier, binding,
> delivery and guest unit are implemented and unit-tested against **generated
> keypairs and fakes** — there is no proof of real VM isolation yet.
> `DFAP_GUEST_PROVISIONING=instance-identity` is **refused at config load in
> production** until real AWS instance-identity verification (regional public
> certs + a live IMDS document) is validated. See
> [runbooks/guest-provisioning.md](runbooks/guest-provisioning.md).

## Known limitations (stated, not hidden)

- Pixels on a screen can be photographed. Watermarking (per-session, per-user overlay) makes leaks attributable, not impossible.
- Vault is a hard dependency for *new* sessions. Existing sessions survive a Vault outage; creation fails fast with a clear error.
- The shared-guacd tier means one hardened process handles multiple tenants' pixel streams. The premium tier moves guacd to a per-VM sidecar.
- **Production login is not wired end to end.** The API can verify OIDC/JWT
  access tokens (`DFAP_AUTH_MODE=oidc`) against a configured issuer/JWKS, maps
  `(issuer, subject)` to internal users, and the web client now performs
  Authorization Code + PKCE login (in-memory tokens, bearer attachment) — but **no
  real identity provider has been connected or tested**; every test uses a local
  test issuer and generated keys. With `oidc` unconfigured the mode stays `deny`
  and a production deployment rejects all requests by design. The onboarding
  steps live in [runbooks/oidc-production-onboarding.md](runbooks/oidc-production-onboarding.md).
- **External identities are provisioned out of band by an operator.** There is
  deliberately no just-in-time mapping from a token (which would re-introduce
  email/subject-as-trust) and no unauthenticated HTTP endpoint. The supported
  workflow is the DB-direct CLI `services/api/dist/cli/provision-identity.js`
  (`npm run provision:identity`), which validates the internal user exists, is
  idempotent, refuses accidental reassignment, and prints no secrets. There is no
  admin UI yet.
- License release is **owner-only**: marketplace licenses carry no owning org, so no tenant-scoped admin override can be expressed. Platform-operator release needs a server-side license→org mapping (future).
- The `software_licenses` catalog is authenticated but returns `ownerName` and availability to any authenticated user (it is a marketplace). It never returns credentials.
- **No hardware-backed key provider.** The Layer-2 credential key is a software
  key (held in process memory). Rotating it is supported, but it is not an HSM,
  KMS, or Vault Transit key, and nothing here is described as hardware-backed.
- **Owner credentials are still in Postgres**, encrypted under the Layer-2 key.
  Vault is authoritative for *session* credentials already; moving owner
  credentials into Vault (DB holds only a pointer) is planned with a documented
  add/dual-write/backfill/cutover/rollback sequence in
  [runbooks/key-management.md](runbooks/key-management.md) §5 — **not executed**,
  because it cannot be validated without a real Vault.
- **The Vault HTTP adapter is not validated against real Vault.** `HttpVaultClient`
  is a real KV-v2 + response-wrapping implementation (auth from config, timeouts,
  no secret/token logging) exercised against a local **mock** Vault server. It has
  not been run against a live cluster.
- **Production now fails closed on missing durable providers.** A production
  deploy without `DFAP_CREDENTIAL_KEY_FILE`/`_PEM`, `DFAP_PAIR_MASTER_KEY`, or
  `VAULT_ADDR`/`VAULT_TOKEN` refuses to boot rather than silently using an
  ephemeral key, a non-secret dev pair seed, or an in-memory Vault.
- **Plaintext is bounded, not force-zeroed.** Clearing a string or setting a field
  to null does not guarantee physical erasure from memory.
- **Guest credential provisioning is not production-enabled.** The
  instance-identity verifier, the server-side binding, the delivery path and the
  guest `dfap-provision.service` are implemented and tested against generated
  keys and fakes; **no real VM isolation has been demonstrated**. Production
  refuses `DFAP_GUEST_PROVISIONING=instance-identity` until AWS's real regional
  public certificates and a live IMDS document are validated
  ([runbooks/guest-provisioning.md](runbooks/guest-provisioning.md)). Until then
  a production deployment does **not** expose a working guest login.
- **The sealed-blob `PreBootInjector` is dev/test only.** It is retained as an
  explicit seam and must not be used in production (its guest key cannot be kept
  out of a reusable AMI).
- **Per-instance image binding is configuration-sourced.** `pool_instances`
  stores no `image_id`; the expected AMI comes from deployment config (single
  image in Phase-0). A multi-image fleet should persist the launched AMI per
  instance.
- **Guest cleanup is best-effort.** `dfap-deprovision.sh` narrows the window in
  which a still-live instance holds a usable account; the authoritative cleanup
  is VM destruction (burn-after-reading, encrypted root).
