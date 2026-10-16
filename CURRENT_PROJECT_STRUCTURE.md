# DisFAP — Current Project Structure & Implementation Detail

**Source of truth for this document:** the working tree at
`/Users/supersg/Documents/Random Projects/DisFAP` (rev r3, last updated
2026-10-16), cross-referenced against the source spec
*"System and Method for Secure Session Brokering with Zero-Exposure Credential
Injection in Virtual Machines"* (the `.docx` in the repo root).

> Status at time of writing: `npm run typecheck` — clean; `npm test` — **265
> passed** (api 153 · broker 95 · web 17); `@disfap/api` production build —
> succeeds. Nothing is committed; all work is uncommitted working-tree changes.
> Real AWS, real HSM/Vault/Stripe, and the Prisma migration are NOT yet live.

---

## 1. Repository layout (as it is now)

```
DisFAP/
├── System and Method for Secure Session Brokering with Zero.docx   # source spec
├── DisFAP Flow 💦.png                                               # flow diagram
├── README.md                                                        # product overview + session flow
├── HANDOFF.md                                                       # implementation log, decisions, status (rev r3)
├── package.json                                                     # npm-workspaces monorepo (Node ≥ 22)
├── tsconfig.base.json                                               # strict, exactOptionalPropertyTypes, noUncheckedIndexedAccess
├── .env.dev.example                                                 # local dev env (DFAP_DEV_FALLBACK=true)
├── .gitignore
├── apps/
│   └── web/                                                         # @disfap/web — browser client (React + guacamole-common-js)
│       ├── vite.config.ts
│       ├── vitest.config.ts
│       ├── src/
│       │   ├── api/client.ts
│       │   ├── session/
│       │   │   ├── dfap-tunnel.ts       # WebSocket tunnel to broker
│       │   │   └── state.ts             # UI session state machine
│       │   ├── types/guacamole-common-js.d.ts
│       │   └── vite-env.d.ts
│       └── test/
│           ├── setup.ts
│           ├── state.test.ts
│           └── dfap-tunnel.test.ts
├── deploy/                                                          # Docker Compose, Caddy, Dockerfiles, Vault, env examples
│   ├── docker-compose.yml
│   ├── Makefile
│   ├── README.md
│   ├── Caddyfile
│   ├── .env.example                                                   # DFAP_DEV_FALLBACK=false, NODE_ENV=production
│   ├── dockerfiles/
│   ├── vault/
│   └── web/
├── docs/
│   ├── architecture.md                                              # component map, session lifecycle, teardown layers, marketplace
│   ├── security.md                                                  # threat model, 4 isolation layers, guarantees 1–5
│   ├── spec-implementation-decisions.md                             # spec→implementation decision record (Layers 1–3)
│   ├── runbooks/aws-first-session.md                                # real-AWS onboarding runbook
│   └── adr/
│       ├── 001-warm-pool-over-terraform-per-session.md
│       ├── 002-opaque-token-over-guacamole-auth-json.md
│       ├── 003-guacd-plus-node-broker-over-java-webapp.md
│       └── 004-burn-after-reading-vms.md
├── infra/
│   ├── packer/                                                      # hardened golden-image pipeline (Packer + offline hardening) — guest path unimplemented
│   └── terraform/                                                   # fleet infra (VPC, SGs, launch templates) — not run per session
│       ├── phase0/
│       └── modules/session-fleet/
├── scripts/
│   └── start-all.mjs                                                # local launcher (sets DFAP_DEV_FALLBACK=true)
└── services/
    ├── api/                                                         # @disfap/api — control plane (sessions, pool, reaper, billing, marketplace)
    │   ├── package.json
    │   ├── vitest.config.ts
    │   ├── prisma/
    │   │   ├── schema.prisma                                        # Postgres data model incl. software_licenses, license_rentals, sessions.license_id
    │   │   └── migrations/
    │   │       ├── migration_lock.toml
    │   │       └── 20261016000000_init/                             # offline baseline migration (NOT applied to any DB yet)
    │   │           └── migration.sql
    │   ├── src/
    │   │   ├── app.ts                                               # HTTP composition + routes
    │   │   ├── server.ts                                            # composition root; wires adapters, starts broker in-process, 60s reaper loop
    │   │   ├── config.ts                                            # fail-fast env config; DFAP_DEV_FALLBACK gating, prod guard
    │   │   ├── ports.ts                                             # narrow interfaces (SessionRepo, TemplateRepo, InstanceRepo, …)
    │   │   ├── state-machine.ts                                     # session states: requested→allocating→ready→connected⇄idle→disconnected→terminating→ended (failed)
    │   │   ├── keyring.ts                                           # signing-key ring (DFAP1 tokens)
    │   │   ├── auth/authenticator.ts                                # HeaderStubAuthenticator (dev stub; C4 — NOT production auth)
    │   │   ├── sessions/
    │   │   │   ├── create-session.ts                                # VM claim, Vault credential stage, DFAP1 token mint, license_id persisted at row creation
    │   │   │   └── end-session.ts                                   # VM terminate, Vault revoke, usage record, rental release (H1 terminal release)
    │   │   ├── orchestrator/
    │   │   │   └── two-thread-orchestrator.ts                       # Layer 3: Thread 1 VM spool + Thread 2 HSM decrypt; atomic claim; compensation; metering
    │   │   ├── pool/
    │   │   │   ├── pool-manager.ts                                  # FOR UPDATE SKIP LOCKED warm-pool claim; cold launch; pre-boot injection before RunInstances
    │   │   │   ├── launch-planner.ts                                # template → launch spec + hourly cost
    │   │   │   └── reaper.ts                                        # fleet reaper (60s): DescribeInstances left-joined vs DB
    │   │   ├── cloud/
    │   │   │   ├── provider.ts                                      # CloudProvider port: FakeCloudProvider / AwsCloudProvider (stub)
    │   │   │   └── disk-injector.ts                                 # PreBootInjector port; OfflineImageInjector (AES-256-GCM sealed blob to userData)
    │   │   ├── crypto/
    │   │   │   ├── hsm-rsa.ts                                       # Layer 2: SoftwareHsm RSA-4096 OAEP-SHA256 (ephemeral per-process key in dev)
    │   │   │   └── pair-keys.ts                                     # TA-4: HKDF-SHA256 per owner-rentee pair key (AES-256-GCM)
    │   │   ├── credentials/
    │   │   │   ├── credential-issuer.ts                             # VaultCredentialIssuer (stages wrap token in Vault)
    │   │   │   └── vault/
    │   │   │       ├── vault-client.ts                              # VaultClient port: FakeVaultClient / HttpVaultClient
    │   │   │       ├── wrap-token-cache.ts
    │   │   │       └── credential-provider.ts (broker side)
    │   │   ├── marketplace/
    │   │   │   ├── license-store.ts                                 # Layer 1: MarketplaceStore port + InMemoryMarketplaceStore
    │   │   │   ├── prisma-license-store.ts                          # Prisma implementation of the store
    │   │   │   └── rental-reaper.ts                                 # expired-lease + abandoned-claim recovery (fail-closed)
    │   │   ├── billing/
    │   │   │   ├── stripe-client.ts                                 # StripeClient port: FakeStripeClient / RealStripeClient
    │   │   │   ├── quota.ts                                         # quota/concurrency gate
    │   │   │   ├── usage.ts                                         # usage records + compute cost
    │   │   │   └── webhook.ts                                       # idempotent Stripe webhooks
    │   │   ├── db/
    │   │   │   ├── client.ts                                        # PrismaClient singleton
    │   │   │   └── prisma-repos.ts                                  # ONLY module importing @prisma/client
    │   │   └── integration/
    │   │       ├── prisma-session-resolver.ts                       # broker-side session resolution
    │   │       └── vault-credential-provider.ts                     # broker-side Vault credential fetch (read-once)
    │   └── test/                                                    # api unit/integration tests (153)
    ├── broker/                                                      # @disfap/broker — session gateway (token redemption, instruction filter, guacd tunnel)
    │   ├── package.json
    │   ├── vitest.config.ts
    │   ├── src/
    │   │   ├── server.ts                                            # createBroker (in-process from API in Phase-0)
    │   │   ├── config.ts                                            # BrokerConfig (ports, guacd, signing keys, Redis URL optional)
    │   │   ├── session-token.ts                                     # DFAP1: HMAC-SHA256, 60s TTL, single-use jti (NonceStore), alg pinned
    │   │   ├── nonce-store.ts                                       # jti burn store
    │   │   ├── session-resolver.ts                                  # sid → target + wrap token (org/sub identity check)
    │   │   ├── tunnel.ts                                            # WebSocket→filtered pixel stream; replay ⇒ terminate session
    │   │   ├── ws-adapter.ts                                        # WebSocket ClientSocket shim
    │   │   ├── instruction-filter.ts                                # Layer 2 isolation: c2s opcode allowlist; s2c stream-index tracking (deny file/clipboard/pipe/argv)
    │   │   ├── guac/
    │   │   │   ├── parser.ts                                        # Guacamole instruction parser
    │   │   │   └── serialize.ts                                     # Guacamole instruction serializer
    │   │   ├── protocol/
    │   │   │   ├── adapter.ts                                       # ProtocolAdapter port
    │   │   │   └── guacd-adapter.ts / guacd-client.ts               # guacd (RDP/VNC) adapter
    │   │   └── vault/credential-provider.ts                         # VaultCredentialProvider (read-once credential fetch)
    │   └── test/                                                    # broker tests (95): tunnel, session-token, guacd-client, parser, instruction-filter, e2e
    └── web/ (see apps/web above)
```

**Workspaces:** `services/*` and `apps/*` → `@disfap/api`, `@disfap/broker`, `@disfap/web`.  
**Test runner:** Vitest (no AWS/DB in tests). **Seams keeping dev free of
externals:** `CloudProvider`, `VaultClient`, `HsmService` (`SoftwareHsm`),
`MarketplaceStore` (in-memory / Prisma), `StripeClient` (fake / real).

---

## 2. Spec → implementation compliance (layer by layer)

The spec describes **six layers**. Below is how each maps to code, what is
implemented, what is "dev-complete" (real wiring is an adapter swap behind an
existing port), and what is explicitly not claimed.

### Layer 1 — Owners & rentees (software-license marketplace)

| What the spec says | Implementation | Status |
|---|---|---|
| Owners list licensed software (MATLAB, AutoCAD, Adobe…); rentees rent it by the hour | `MarketplaceStore` port + `software_licenses`/`license_rentals` tables; seed catalog (MATLAB, AutoCAD, Premiere, JetBrains) | ✅ implemented |
| Rentees browse catalog, see hourly rate, pay for a limited time | `listAvailable`, hourly rate, `hoursRequested`, `totalChargedUsd`; web `LaunchPage` duration selector (1/2/4/8 h) | ✅ implemented |
| Credentials encrypted via HSM, stored in Vault, plaintime limited | `encrypted_credentials` = HSM RSA-4096 payload; plaintext never in DB; Vault path staged per session | ✅ dev-complete (real Vault/HSM behind seams) |
| Rental auto-released when access period ends | `completeForSession(sessionId)` on `endSession`; rental reaper closes expired leases | ✅ implemented |
| Double-rent must be impossible | Atomic `claimAvailable(id, renteeId)` conditional CAS (Postgres `updateMany` count===1; in-memory mirror); `markRented` reduced to force/admin/dev helper | ✅ implemented (fixes audit H2) |
| Cross-org template launch allowed only for the licensed template | Server-minted `templateGrant` + `isLicensedTo(licenseId, renteeId, templateId)` data-backed check (fixes audit C2) | ✅ implemented |
| Persistence | `PrismaMarketplaceStore` behind the port; degrades to in-memory **only** when `DFAP_DEV_FALLBACK=true` (default false) on `P2021`/`P2022` | ✅ code done; migration not yet applied to a DB |
| Migration | Baseline `prisma/migrations/20261016000000_init/migration.sql` (391 lines, includes all tables + `sessions.license_id` + index) generated offline with `prisma migrate diff --from-empty` | ⏳ authored, not applied |

### Layer 2 — HSM RSA-4096 + Vault (credential encryption at rest)

| What the spec says | Implementation | Status |
|---|---|---|
| Owner credentials encrypted with HSM RSA-4096, stored in Hashicorp Vault, plaintime limited | `crypto/hsm-rsa.ts` `SoftwareHsm` (RSA-4096 OAEP-SHA256); `EncryptedCredentialPayload` opaque blob; `VaultClient` port (`FakeVaultClient`/`HttpVaultClient`) | ✅ dev-complete (real HSM/Vault behind seams) |
| Per owner-rentee pair unique key from both ids (TA-4) | `crypto/pair-keys.ts`: `HKDF-SHA256(masterSeed, salt=ownerId, info=renteeId)`, AES-256-GCM, ids bound in AAD, order-insensitive, never stored; re-seal stored on `license_rentals.pair_payload` | ✅ implemented |
| Production key material | `DFAP_PAIR_MASTER_KEY` env (base64, ≥32 bytes); dev derives deterministic non-secret seed from signing kid | ⚠️ dev seed in use; production must set real master |
| HSM key persistence | `SoftwareHsm` mints an ephemeral RSA-4096 keypair per process (audit H5 — persisted ciphertext can't decrypt across restarts) | ⚠️ known gap; production must pin persistent HSM/CloudHSM/Vault Transit key |

### Layer 3 — Orchestrator (two concurrent threads)

| What the spec says | Implementation | Status |
|---|---|---|
| Orchestrator triggered on rent; Thread 1 spools VM, Thread 2 retrieves/decrypts credentials, concurrently | `two-thread-orchestrator.ts` `rentAndOrchestrate`: both threads started concurrently via `Promise.all`; Thread 1 joins Thread 2 only for the credential (pre-boot ordering requires it); telemetry exposes `thread1VmSpoolingMs`, `thread2CredentialRetrievalMs`, `orchestratorTotalMs`, `hsmKeyFingerprint` | ✅ implemented (honest accounting — decrypt is sub-ms, not faked) |
| Credential decrypted inside HSM boundary before VM boot | HSM decrypt in Thread 2; plaintext lives only between `hsm.decrypt` and pair-seal/createSession hand-off; never logged/persisted unsealed/returned to client | ✅ implemented |
| Pre-boot injection before boot (Working Explanation step 5) | `PreBootInjector` port called by `PoolManager` **before** `RunInstances` (cold path only); `OfflineImageInjector` seals credential to `(sessionId, imageId)` as `userData` blob — now **DEV/TEST ONLY**; `NoPreBootInjector` composes in production (M8). The production realization is the per-instance identity pull (`src/guest/`) | ✅ dev-complete (M8 §14: sealed blob retired from production; per-instance pull built, production-gated) |
| Rental row + Stripe meter event at rent time | `recordRental` → `reportMeterEvent` (`dfap_license_rental_hours`, idempotent per license+session) → `attachMeterEvent`; meter failure is non-fatal (`meter_event_id = null`, retry obligation) | ✅ implemented |
| Failure compensation before a valid session | Release claim via conditional `releaseClaim(id, renteeId)` (never touches another tenant's claim); no rental row / meter event for a session that never became valid | ✅ implemented |
| VM cleanup if creation fails after launch | `createSession` optional `cloud`/`instances` deps: best-effort `terminateInstance` + mark pool row terminated; `vmCleanedUp` recorded on the `failed` event; pool row `expires_at` + `failed` session are the reaper's backstop | ✅ implemented |
| Rental-persistence failure after session exists (M3 gap) | Durable `sessions.license_id` stamped in the same insert that creates the session; on `recordRental` failure → `terminateSession` + conditional `releaseClaim` only when terminal; otherwise claim **held**; reaper gates on `hasActiveSessionForLicense` (fail-closed) | ✅ implemented (fixes M3 gap); migration not yet applied |

### Layer 4 — Cloud interface (VM & session management)

| What the spec says | Implementation | Status |
|---|---|---|
| Manage VMs and sessions (launch/terminate) | `CloudProvider` port + `PoolManager` (claim warm instance or cold-launch via `RunInstances`); every instance stamped with hard `expires_at` | ✅ dev-complete (real AWS behind seam) |
| Real AWS path | `AwsCloudProvider` class exists as a **stub** | ⚠️ stub only — real `launchInstance`/`terminateInstance` untested; not claimed to work |
| Burn-after-reading: VM destroyed, never reused | ADR-004; `endSession` terminates instance, deletes SG, revokes Vault credential; no sanitize-and-return path | ✅ implemented (fake cloud) |
| Fleet reaper (60s) | `Reaper.reconcile()` + `RentalReaper.reconcile()` run every 60s in `server.ts` | ✅ implemented |
| Per-session security group, no public IP, egress default-deny | Documented in `docs/security.md` Guarantee 3; enforced by terraform (not per-session code in this repo) | ⚠️ infra-level, not verified against real AWS |

### Layer 5 — Guacamole gateway + pixel translation

| What the spec says | Implementation | Status |
|---|---|---|
| Apache Guacamole gateway; custom plugin for login; credentials slipped into RDP/VNC handshake server-side | `services/broker` tunnel → guacd adapter (RDP 3389); credential fetched from Vault server-side (read-once, response-wrapped) and injected into the guacd connection; client never sees host/username/password | ✅ implemented (fake Vault) |
| Translation to HTML5 pixels; no protocol/credential data leaked to client | `DFAP1` token (HMAC-SHA256, 60s, single-use `jti`, burned via NonceStore; replay ⇒ session terminated); broker resolves sid server-side; pixels stream over WebSocket | ✅ implemented |
| Guacamole wipes credential from memory after login | `tunnel.ts` scrubs the credential reference (`{username:'', password:''}`) after the upstream connect; spec's "different network segment" honored (credential on a different path than the client) | ✅ implemented |
| Four independent pixel-only isolation layers | `docs/security.md` Guarantee 1: (1) guacd connection params (no copy/paste/drive/print/SFTP), (2) broker `InstructionFilter` (c2s allowlist: mouse/key/size/sync/nop/disconnect/ack/touch; s2c stream tracking drops file/clipboard/pipe/argv), (3) guest OS policy (baked into hardened image), (4) browser client (no clipboard/file handlers). Layer 2 is load-bearing; violations logged as security events; repeated c2s violations terminate the session | ✅ implemented |
| `InstructionFilter` tests run with no AWS dependency | `services/broker/test/instruction-filter.test.ts`, `parser.test.ts`, `session-token.test.ts`, `tunnel.test.ts`, `e2e.test.ts` | ✅ 95 broker tests pass |

### Layer 6 — Ephemeral VM (licensed software, wiped after session)

| What the spec says | Implementation | Status |
|---|---|---|
| VM runs licensed software, ephemeral, destroyed + disks wiped at session end | Session state machine ends in `ended`/`failed`; VM terminated; per-session SG deleted; credential revoked; golden image (AMI + snapshot SHA-256) recorded per session | ✅ dev-complete (fake cloud; real disk-wipe not verified) |
| Guest-side provisioning unit (per-instance identity, fail-closed) | `dfap-provision.service` + `dfap-provision.sh` (IMDSv2 signed identity → `POST /internal/guest/provision` → validate → create least-privilege `tsusers` account); xrdp `Requires=` gate | ✅ built + unit-tested (M8, audit C3 closed; **production refused until real-AWS validation** — runbook `guest-provisioning.md`) |
| Credentials delivered to the guest | Authenticated per-instance pull from the control plane (credential read from the same Vault path the broker uses; package bound to instance+image+session) — **not** `userData` | ✅ dev-complete (host + guest); real VM isolation unproven |

---

## 3. Cross-cutting security & operational state

| Area | State |
|---|---|
| Authentication | `HeaderStubAuthenticator` — caller self-asserts `owner`/`admin`/`member`/`auditor`. **Not production auth** (audit C4). |
| CORS | Reflects `Origin` with credentials (audit C4). |
| Dev fallbacks | `DFAP_DEV_FALLBACK` parsed by strict `bool()`; default **false**; fail-fast if enabled in `DFAP_ENV=production`/`NODE_ENV=production`. Fabricated `createSession`/`endSession`/`getSession` + marketplace fallback all gated behind it (fixes audit C1/H6). |
| Re-rent bypass | Old `NODE_ENV` check removed; replaced with `devAllowRerent` (default false) — busy license ⇒ 409 unless opted in (fixes audit H3). |
| Terminal-state rental release (H1) | `endSession` on an already-terminal session still best-effort calls `completeForSession`. |
| `pair_payload` | Written but never read/deleted (audit H4 — documented as open). |
| Dead-man switch | Inert/over-scoped (audit H7 — open). |
| Prisma migration | Baseline authored (`20261016000000_init`), **not applied** to any DB; until applied the API degrades to in-memory catalog (only with `DFAP_DEV_FALLBACK=true`). |
| Real AWS / HSM / Vault / Stripe | Adapter seams exist; none wired. `CLOUD_PROVIDER=fake` in local dev. |

### Open risks (explicitly stated, not hidden)
- Post-session persistence failure: addressed in r3, but residual fail-closed risk if teardown permanently fails (license held indefinitely; no session-state reaper exists yet).
- `templateGrant` assumed server-minted; no capability signature on it.
- Real cloud cleanup (`AwsCloudProvider`) unverified.
- No automated meter retry for null-`meter_event_id`.
- Auth (C4) and C4/CORS untouched.
- H7, M1–M9, L1–L5, `listTemplates` fallback sibling of C1. (**C3 closed in M8** —
  per-instance identity provisioning built and unit-tested; production gated on
  real-AWS validation. **H4/H5 closed in M7.**)

---

## 4. Test & build verification (real commands, rev r3)

| Command | Result |
|---|---|
| `npm run typecheck` | clean (api, broker, web) |
| `npm test` | **265 passed** (api 153 · broker 95 · web 17) |
| `npm run build --workspace=@disfap/api` | succeeds (`prisma generate && tsc`) |
| `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script` | generated `prisma/migrations/20261016000000_init/migration.sql` (391 lines) |

---

## 5. What is NOT done (and not claimed)

- Real AWS/EC2 launch/terminate — `AwsCloudProvider` is a stub; no AWS calls made or credentials needed.
- Guest-side `dfap-preboot.service` — no in-image unseal/login unit; no Linux/Windows template with preboot.
- Real HSM (Thales Luna / CloudHSM / Vault Transit) — `SoftwareHsm` ephemeral per-process key in dev.
- Real Vault cluster — `FakeVaultClient` in dev; `HttpVaultClient` is the seam.
- Real Stripe — `FakeStripeClient` in dev.
- Prisma migration applied to a real database.
- Automated meter retry; session-state reaper for the residual fail-closed case.

---

## 6. Next moves (from HANDOFF §12, gated on pending decisions)

1. Guest `dfap-preboot.service` (needs guest credential-mechanism decision).
2. Apply the baseline migration (`prisma migrate dev` locally / `migrate deploy` in `deploy/`).
3. Automated meter retry + session-state reaper for the residual fail-closed case.
4. Linux RDP workspace template + marketplace entry.
5. Marketplace UI component test in `apps/web`.
6. AWS Level A walkthrough.
7. Remaining audit findings (H7, M1–M9, L1–L5, `listTemplates` fallback). (C3 closed
   in M8; C4 closed in r4; H4/H5 closed in r7.)
