# Spec → implementation: decisions log

Working notes for implementing *"System and Method for Secure Session Brokering
with Zero-Exposure Credential Injection in Virtual Machines"* (DisFAP patent
draft) against this repo. Each entry: what the spec says → what we built and
**why**, including the trade-offs we accepted. This is a living document; it is
updated as the work proceeds.

Status legend: ✅ done · 🟡 dev-complete (real wiring is a Phase-1 adapter) · ⏳ pending

---

## 0. Scope decision

The spec describes six layers. Layers 3–6 (orchestrator, cloud interface,
Guacamole/pixel gateway, ephemeral VM) already exist in the repo. We are closing
the Layer-1/2 gaps and the two **spec-specific differentiators**, in a
"dev-complete" mode: everything runs locally end-to-end with fakes and seam
adapters; going to real infrastructure is a config/adapter change, not a rewrite.

**Not in scope for this pass:** standing up real AWS, a real HSM (Thales Luna /
CloudHSM), or a real Vault cluster — those are deployment steps an adapter swap
behind interfaces we already have.

---

## 1. License persistence (spec Layer 1) — ✅

**Spec:** owners list software licenses; rentees browse and rent them.

**Before:** an `InMemoryMarketplaceStore` with four hardcoded seeds; nothing
survived a restart; no rental ledger at all.

**Decision:** add `software_licenses` and `license_rentals` tables and a
`PrismaMarketplaceStore` that implements the existing `MarketplaceStore` port.

**Why keep the port:** the existing orchestrator/route/tests depend on
`MarketplaceStore`; persistence is an implementation detail behind it.

**Trade-off (dev resilience):** the Prisma store accepts an optional
`fallback` store and degrades to it **only** on "DB unreachable" /
"migration missing" (`P2021`/`P2022`) errors — matching the repo's existing
Phase-0 dev-fallback philosophy. A unique-violation (double-rent) deliberately
does **not** fall back; it propagates. This is the one place where "convenient
in dev" could mask a real error, so the boundary is drawn as tightly as
possible.

**Schema choice:** `templateId` on a license is a plain string, **not** a FK to
`workspace_templates` — dev seed ids (`tmpl_win_rdp`, …) may not exist as rows
in a local DB, and a license must be listable regardless.

---

## 2. Per owner-rentee pair keys (spec Technical Advancement 4) — ✅

**Spec:** *"Every owner-renter pair gets a unique encryption key built by
utilizing both of their ids."*

**Decision:** `crypto/pair-keys.ts` derives an AES-256-GCM key with
`HKDF-SHA256(masterSeed, salt=ownerId, info=renteeId)`. The key is **never
stored** — only the master seed is protected.

**Why HKDF over a stored key:** the spec says "built by utilizing both ids", and
derivation gives exactly that with no key table to secure, rotate, or leak. It
also makes the key deterministic, so no lookup is needed to decrypt.

**Why bind ids into the AEAD's associated data too:** so a payload can't be
"re-homed" onto another pair by editing a DB row, and so a forged `pair`
fingerprint fails the GCM tag.

**Order-insensitivity:** ids are canonicalised (sorted) so `(A,B)` and `(B,A)`
name the same lease relationship.

**Dev fallback:** without `DFAP_PAIR_MASTER_KEY`, the master seed is derived
deterministically from the signing kid so derived keys survive a dev restart.
Explicitly documented as **not a secret**.

**Where it's used:** the orchestrator re-seals the decrypted credential under
the pair key at rent time and stores that sealed payload on the rental row
(`license_rentals.pair_payload`) — rental-scoped proof, distinct from the
owner-at-rest HSM payload.

---

## 3. Pre-boot credential injection (spec "Working Explanation" step 5) — ⚠️ superseded by §14 (M8)

**Spec:** *"Before the VM is spun up, the orchestrator gets access to the VM's
disk file directly and writes the trust certificate into the authorized logins
section of the OS itself. After all this the orchestrator gives the hypervisor
the signal to boot the VM."*

**Before:** credentials were only staged in Vault and injected into the live
RDP/guacd handshake (the repo's chosen ADR-004 variant). The spec's offline
write-to-disk-before-boot step did not exist.

**Decision:** a `PreBootInjector` port (`cloud/disk-injector.ts`) called by the
`PoolManager` **before** `RunInstances`, returning a `userData` blob that rides
the launch spec so the login material is on the VM's disk from first boot.

**Why a sealed blob rather than raw credential text:** the blob is AES-256-GCM
sealed to `(sessionId, imageId)` under a guest-image wrap key; the golden
image's `dfap-preboot.service` unseals it locally, materializes the login
(Linux `authorized_keys`/ssh cert; Windows offline SAM provisioning from the
Packer offline-harden stage), deletes the blob, then enables RDP. A leaked
blob is useless without that specific image.

> **M8 update — this realization is now DEV/TEST ONLY.** A guest-side unseal key
> baked into a reusable AMI is a shared secret across every instance of that
> image, which is unacceptable. Milestone 8 retires the sealed-blob path from
> production and replaces it with a per-instance, AWS-instance-identity-
> authenticated pull of the credential (see §14). `OfflineImageInjector` is kept
> as an explicit seam for local development and tests; `server.ts` composes
> `NoPreBootInjector` in production.

**Honest limitation (documented in the module):** true *offline disk* mutation
(attach EBS volume → edit → re-snapshot) per session is 90–150 s of overhead;
we implement the functionally equivalent **first-boot-before-login-exposure**
injection via `UserData`, which the guest consumes before the login service
starts. The `PreBootInjector` seam is where a future per-image offline mutator
plugs in without touching the pool manager.

**Warm-pool interaction:** injection applies only on the **cold** path. A warm
instance booted earlier can't host a credential that didn't exist yet, so its
login material flows via Vault at connect time (unchanged behaviour).

---

## 4. Rental metering & automatic release (spec Advantages / offboarding) — ✅

**Spec:** *"Whenever a rentee's access period is over, all access is immediately
lost with absolutely no chance of any lingering cached session data or
credentials."* · *"our system terminates the rentee's access automatically when
the session ends."*

**Decision:** at rent time the orchestrator (a) reports a Stripe meter event
(`dfap_license_rental_hours`, idempotent per `license+session`) and (b) writes a
`license_rentals` row. On `endSession`, an optional `RentalReleaser` dep calls
`completeForSession` — closing the rental and returning the license to
`available`.

**Why meter-after-session-id-not-before:** the idempotency key needs the session
id; metering is best-effort (a metering failure must not fail a session that is
otherwise ready), so it is caught and recorded as `meterEventId: null`.

---

## 5. Two-thread concurrency, honestly accounted — ✅ (with a note)

**Spec:** thread 1 spools the VM, thread 2 retrieves/decrypts credentials,
concurrently, for "utmost efficiency".

**Decision:** keep both as concurrently-started async threads, but thread 1
**joins thread 2 for the credential** because the spec's pre-boot injection
ordering requires the credential before `RunInstances`. We measure and expose
both durations (`thread1VmSpoolingMs`, `thread2CredentialRetrievalMs`) plus the
orchestrator total, so the claim stays verifiable.

**Why not fake the parallelism:** decrypting RSA is sub-millisecond; pretending
otherwise would be dishonest telemetry. The expensive VM spool dominates, which
is exactly the efficiency the spec is after. The comment block says so.

---

## 6. Verification — ✅

Tests added (all green, `npm test`): `pair-keys.test.ts` (derivation, roundtrip,
order-insensitivity, wrong-pair/tamper rejection, fingerprint), `disk-injector.test.ts`
(seals without plaintext, image-bound unseal, wrong image/key fails, no-op),
`orchestrator.test.ts` (decrypted credential reaches `createSession`, rental record,
pair-seal opens only for the pair, metering idempotency, 404/409, release),
`end-session.test.ts` (auto-release on end, no-op when already terminal), plus new
pool-manager cases asserting injection happens **before** `RunInstances` and is
skipped on a warm hit.

Web: `LaunchPage` now offers a rental-duration selector (1/2/4/8 h) and shows the
computed total on the rent button, so "pay for a certain amount of time" is a real
input rather than a hardcoded hour.

**Live smoke test (fake cloud, no DB, no AWS):** booted the built control plane and
verified over HTTP: `GET /api/marketplace/licenses` lists the seed catalog →
`POST /api/marketplace/rent` with 2 h returns `{sessionId, token, brokerUrl,
rentalId, license.totalChargedUsd: 9, telemetry}` → the rented license drops out of
the available list → `POST /api/marketplace/licenses/:id/release` returns **403** for
a non-owner and **200** for the owner, restoring the license. Full suite:
**196 tests** green (api 84, broker 95, web 17).

## 7. Migration step (required before the DB path works) — ⏳ ops

The two new tables need a migration. The repo commits no `migrations/` directory
yet, so this is a one-time ops step wherever a Postgres exists:

```sh
cd services/api
npx prisma migrate dev --name marketplace   # local dev (creates + applies)
# deploy/ uses:  npx prisma migrate deploy
```

Until then, `PrismaMarketplaceStore` degrades to the in-memory seed catalog
(P2021/P2022) so local dev keeps working.

---

## 8. Rental atomicity, failure compensation & recovery (Milestone 2) — ✅ (no migration)

**No schema change was needed.** Every recovery decision reuses existing
columns: `software_licenses.status/current_rentee_id/updated_at`,
`license_rentals.started_at/hours_requested/ended_at`, `sessions.state`.

**Atomic claim (audit H2 — double-rent).** `MarketplaceStore` gains
`claimAvailable(id, renteeId)`, a conditional compare-and-set. Postgres does it
with one guarded `updateMany({ where: { id, status: 'available' }, ... })` and
treats `count === 1` as the win; the in-memory store mirrors it. Two concurrent
rents therefore produce exactly one winner and one `409`. `markRented` survives
only as a force/admin/dev helper — the orchestrator no longer uses it.

**Explicit ordering + compensation (layer 3).** The orchestrator runs
`advisory pre-check → ATOMIC CLAIM → HSM decrypt → createSession → recordRental
→ meter → attachMeterEvent`. Any failure *before a valid session exists* releases
the claim with a second conditional op, `releaseClaim(id, renteeId)`, which can
only free a claim still held by that rentee — it can never release another
tenant's license. No rental row and no meter event are written for a session that
never became valid. If metering fails, the rental is already persisted and
`meter_event_id` stays null as a recoverable obligation.

**VM cleanup.** `createSession` gains optional `cloud` + `instances` deps: a
failure after `RunInstances` best-effort terminates the instance and marks the
`pool_instances` row terminated; if that cleanup is absent or itself fails, the
pool row (with its hard `expires_at`) plus the `failed` session remain the
recoverable obligation the layer-4 fleet reaper still acts on. Cleanup success is
recorded on the `failed` event (`vmCleanedUp`), never silently assumed.

**Template ownership (audit C2).** A marketplace session legally launches a
template owned by another org. Rather than removing the org check, `createSession`
accepts a server-minted (never client-supplied) `templateGrant` and keeps the
check by asking the store `isLicensedTo(licenseId, renteeId, templateId)` — true
only when the license is currently rented to this rentee AND its template is the
one requested. Tenant isolation is preserved; the only new path is a data-backed
exception for the exact licensed template.

**Rental reaper.** `marketplace/rental-reaper.ts` closes expired leases
(`started_at + hours_requested` passed) **only when the driven session is
terminal or gone** — a stale timestamp never steals the license of a live
session — and separately releases abandoned claims (a rented license with no open
rental past a grace window). Per-item error isolation; a failed teardown is
retried on the next pass; both actions are idempotent.

**Verification.** Full suite **252 tests** green (api **140**, up from 102;
broker 95; web 17); workspace typechecks clean; `@disfap/api` production build
(`prisma generate && tsc`) succeeds. New/expanded coverage: atomic-claim
concurrency, conditional-write shape, compensation on failed creation, VM
cleanup, cross-org grant allow/deny, and the reaper's expiry/idempotency/retry.
Real cloud provisioning remains unverified — no AWS calls were made.

---

## 9. Post-session persistence-failure gap (Milestone 3) — ✅ (migration added)

**The gap.** M2 ordered `claim → createSession → recordRental`. If `recordRental`
failed *after* a session (and possibly a VM) existed, the license stayed `rented`
with **no durable link** to the session, so the stale-claim reaper's "rented, no
open rental" rule could free the license while the session was still alive.

**Durable license↔session link (the migration).** `Session` gains nullable
`license_id` (`@@index([licenseId, state])`). The orchestrator passes `licenseId`
into `createSession`, which stamps it on the row **in the same insert that first
makes the session durable** — so from the instant a non-terminal session can
exist, a durable link exists. The repo had no `migrations/` directory, so a
greenfield baseline was authored offline with
`prisma migrate diff --from-empty --to-schema-datamodel` at
`prisma/migrations/20261016000000_init/` (it includes the new column + index).
It is **not applied** to any database yet.

**Compensation (layer 3).** Only the `recordRental` call is wrapped. On failure
the orchestrator calls `terminateSession(sid)` (the real `endSession`, wired in
`server.ts`) to tear down the session + VM, and runs the conditional
`releaseClaim(licenseId, renteeId)` **only when the reported state is terminal**
(`ended`/`failed`). If teardown throws, is absent, or returns a non-terminal
state, the claim is deliberately **held** — a new `rental_persist_failed` event
records `{ licenseId, terminated }` for observability.

**Reaper safety.** `RentalReaperSessions` gains
`hasActiveSessionForLicense(licenseId)`; `planRentalReap` takes the set of
licenses that still have a non-terminal linked session and moves them into a new
`heldClaims` bucket (never `releaseClaims`). A lookup **error is treated as
"may be live"** (fail-closed). `RentalReapResult.heldClaims` exposes the decision.

**Meter ≠ rental.** A `meter_event_id` failure after the rental is recorded still
returns a valid session and never terminates it; only a rental-persistence failure
triggers teardown.

**Why an active session can never lose its reservation:** the claim precedes the
session row, and the row carries `license_id`; the reaper releases a stale claim
only when no non-terminal session for that license remains (errors ⇒ hold). Hence
a live session's license is never eligible for stale-claim release. Fail-closed
residual: a session that is never terminated keeps its license held indefinitely
(no session-state reaper exists yet).

**Verification.** Full suite **265 tests** green (api **153**, up from 140; broker
95; web 17); workspace typechecks clean; `@disfap/api` production build succeeds.
New/expanded coverage: rental-persist failure → terminate + release; teardown
throw/non-terminal → claim held; meter failure → session preserved; concurrent
same-license rents → one winner; `license_id` persisted; real reaper holds while a
linked session is live and releases once terminal; reaper fail-safe on lookup
error. No AWS calls; no database migration executed.

---

## 10. Authentication & HTTP exposure hardening (Milestone 4) — ✅ dev-complete

**The gaps (audit C4 + HTTP surface).** `HeaderStubAuthenticator` trusted
`x-dfap-user` / `x-dfap-org` / `x-dfap-role` on every request, in every
environment; the release route accepted a role from those headers; CORS
reflected any `Origin` with credentials; `GET /marketplace/licenses` was
unauthenticated; and no real identity provider exists.

**No improvised prod auth.** The repo has no OIDC/JWT verifier, and the task
forbids inventing a token system. Rather than build one, composition picks one
of two adapters from `DFAP_AUTH_MODE`:

- `FailClosedAuthenticator` (**default `deny`**) — rejects every request. A
  deployment with no IdP wired serves nothing instead of trusting asserted
  identity.
- `DevHeaderAuthenticator` (`dev-header`) — **local dev only**; `loadConfig`
  refuses it when `DFAP_ENV`/`NODE_ENV` is `production`. Reads identity from
  `x-dfap-user` / `x-dfap-org`, and **ignores `x-dfap-role` entirely**.

**Privilege is server-side data.** A principal's `role` is resolved from
`org_members` through a new `MembershipRepo` port (`PrismaMembershipRepo`), not
from the request. In dev-header mode the role comes from the DB; with the dev
fallback and no reachable DB it drops to least-privilege `member`. No path lets
a header confer owner/admin.

**Object-level authorization.**
- License release is now **owner-only** (`license.ownerId === principal.userId`).
  The old "or any admin/owner" branch let an admin of *another* org release a
  license; because `software_licenses` carries no owning org, no tenant-scoped
  admin override can be expressed, so the branch is removed rather than guessed.
- Session read/terminate already require `session.orgId === principal.orgId`;
  kept and covered by tests.
- `GET /marketplace/licenses` is now **authenticated** (ownerName + availability
  are tenant-identifying). It still returns only the HSM fingerprint, never
  credentials.

**CORS.** Exact `DFAP_CORS_ALLOWED_ORIGINS` allowlist (comma-separated bare
origins; wildcards rejected at config load; empty default = deny all). The
`onRequest` hook sets `Access-Control-Allow-Origin` only for a listed origin and
never reflects an arbitrary one; the role header is dropped from
`Access-Control-Allow-Headers`.

**Frontend.** `ApiClient` no longer sends `x-dfap-role`; the dev identity headers
are emitted only under Vite's `import.meta.env.DEV` (stripped from production
bundles).

**Migration (the previously-unapplied one).** No new schema change was needed for
auth. The M3 baseline `20261016000000_init` was **validated on a disposable
local PostgreSQL cluster**: `prisma migrate deploy` applied cleanly, and a new
env-gated test (`DFAP_TEST_DATABASE_URL`) proved `sessions.license_id` persists
and `hasActiveForLicense` tracks session state. It remains **unapplied to any
real database**; `prisma/migrations/README.md` documents fresh-DB use and safe
baselining of an existing DB.

**Verification.** Full suite **287 passing + 3 skipped** (api **175** passed,
broker 95, web 17; the 3 skips are the PG test without `DFAP_TEST_DATABASE_URL`).
Workspace typechecks clean; `@disfap/api` production build succeeds. No AWS
calls; no real database migrated.

**Honest status:** production authentication is **not operational** — there is no
IdP. The API fails closed until one is integrated.

---

## 11. OIDC/JWT access-token authentication (Milestone 5) — ✅ dev-complete

**What M4 left open.** M4 shipped a fail-closed default plus a dev-only header
adapter, but no real verifier — so a production deployment served nothing. M5
adds a genuine **production `Authenticator`** behind the same seam, leaving the
fail-closed default intact when provider config is absent or invalid.

**Library choice.** The repo had no JOSE/OIDC dependency. We added
[`jose`](https://github.com/panva/jose) (`^6.2.12`) — the maintained,
zero-dependency, WebCrypto-based JOSE implementation — rather than hand-rolling
signature verification (which the task forbids). `createRemoteJWKSet` provides
caching plus **rotation** (refetch on an unknown `kid`, subject to a cooldown).

**Trusted verification (`auth/jwks.ts`).** `JoseAccessTokenVerifier` wraps
`jwtVerify` and enforces: signature; a configurable `algorithms` allowlist that
never includes `none`; **exact** issuer; **exact** audience; `exp` and `nbf`
(with a clock tolerance); required `sub`. Signing keys come **only** from
server config — an explicit `DFAP_OIDC_JWKS_URL` or OIDC discovery at the issuer
whose advertised `issuer` is pinned to the configured one. A request can never
supply a key or JWKS URL. Every failure (bad signature, unknown key, malformed,
expired, wrong issuer/audience, unreachable JWKS/discovery) maps to a 401 —
there is no unverified fallback.

**Access tokens, not ID tokens.** The audience must be the API's resource id
(an ID token addresses the client), and providers that mark token kind are
honored via a configurable `token_use` claim (`DFAP_OIDC_TOKEN_USE_CLAIM`/
`_VALUE`, enforced when present, or strictly with `DFAP_OIDC_REQUIRE_TOKEN_USE`)
and/or a required JOSE header `typ` (`DFAP_OIDC_ACCESS_TOKEN_TYP`, e.g. RFC 9068
`at+jwt`).

**Identity mapping (new schema).** An external `sub` is **never** equated with an
internal user id. New model `external_identities` maps `(issuer, subject) →
user_id` with a `UNIQUE (issuer, subject)` index; email is informational only,
never a key. `IdentityRepo.resolve` returns null for an unmapped identity and
the caller **rejects** — there is **no JIT provisioning**. Organization
membership and role come from `org_members` (`MembershipRepo.resolveMembership`
returns `{orgId, role}`); an optional org claim (`DFAP_OIDC_ORG_CLAIM`) only
*selects* among the caller's real memberships and never grants one. Ambiguous
(multi-org, no claim) and membership-less callers are rejected.

**Composition.** `authMode` is now `'deny' | 'dev-header' | 'oidc'`; `oidc`
requires `DFAP_OIDC_ISSUER` + `DFAP_OIDC_AUDIENCE` or boot fails
(`parseOidc`). `server.ts` composes exactly one adapter from the mode; if `oidc`
were somehow selected without config it falls closed. `dev-header` remains
refused in production.

**Frontend (partial by design).** `ApiClient` gained an injectable
`getAccessToken` and sends `Authorization: Bearer` when it is present (and never
sends a role header). **No authorization-code+PKCE login flow is implemented**,
so the end-to-end production login path is still incomplete — stated here and in
`docs/security.md`.

**Migration.** New `20261016010000_external_identities` (authored with
`prisma migrate diff --from-url <baseline> --to-schema-datamodel`), applied and
validated on a **disposable** local PostgreSQL cluster — both migrations apply
to a fresh DB, and the env-gated PG test now also proves `(issuer, subject)`
resolution and the unique constraint. **Unapplied to any real database.**

**Verification.** Full suite **328 passing + 4 skipped** (api **212**, broker
95, web 21). Workspace typechecks clean; `@disfap/api` production build
succeeds. No AWS calls; no real database migrated; no real IdP contacted.

**Honest status:** backend OIDC verification and identity mapping are implemented
and tested against local keys/fixtures, but **production authentication is not
operational end to end** — no frontend login flow exists and no real IdP has
been connected or tested. Production still effectively fails closed.

---

## 12. End-to-end OIDC authentication workflow (Milestone 6) — ✅ dev-complete

**What M5 left open.** M5 made the API able to verify access tokens and map
`(issuer, subject)` to internal users, but nothing *obtained* tokens (no browser
login flow), and no supported workflow existed to provision identity mappings.
M6 closes both, provider-neutrally.

**Browser login (`apps/web/src/auth/*`).** Added
[`oidc-client-ts`](https://github.com/authts/oidc-client-ts) (`^3.5.0`) — the
maintained browser OIDC client. `createUserManager` performs **Authorization
Code + PKCE** (`response_type=code`, S256, public client, **no client secret**),
with a fresh `nonce` per request (the library binds and validates it).
`OidcAuth` wraps the manager: `init()` processes the callback (success, denied
login, callback error), `signin()`/`signout()` drive login/logout, and
`getAccessToken()` returns a currently-valid token — renewing once on expiry via
`signinSilent`, and returning **`null` and clearing state** when there is no
session or renewal fails (so the client can never look authenticated while
sending no token).

**Token handling.** Access/refresh tokens live in an **in-memory** store
(`InMemoryWebStorage`), never `localStorage`; only the in-flight
state/nonce/PKCE verifier is kept in `sessionStorage` for the redirect
round-trip. `ApiClient` attaches the token as `Authorization: Bearer` (never a
role header). The browser never treats a readable JWT as verified — only the API
verifies. Trade-off: a full page reload drops the in-memory session (re-login),
which is deliberate and documented.

**Identity provisioning (operator).** `src/auth/identity-provisioning.ts`
(pure) + `PrismaIdentityProvisioningStore` + a DB-direct CLI
`src/cli/provision-identity.ts` (`npm run provision:identity -- --issuer … --subject … --user …`).
It validates the internal user exists, is idempotent, refuses to repoint an
existing mapping to another user without an explicit `--reassign`, keeps the key
as the exact `(issuer, subject)` (never email), and prints no secrets. There is
**no unauthenticated endpoint** for provisioning.

**Testing.** The strongest practical integration test
(`services/api/test/oidc-e2e.test.ts`) runs a **real** local OIDC provider
(discovery, JWKS, `/authorize` with S256 verification, `/token` minting genuine
RS256 access tokens) against the **real** `JoseAccessTokenVerifier` +
`OidcAuthenticator` + Fastify app, driving the full PKCE flow: a valid token
reaches an authenticated resource (200), no token → 401, an unmapped subject →
403, a tampered token → 401, and `x-dfap-user`/`x-dfap-org`/`x-dfap-role` cannot
override the verified identity or escalate privilege. `apps/web/test/oidc.test.ts`
covers settings parsing, the real code+PKCE authorize request (S256/state/nonce,
no secret), in-memory token storage, callback success/denied/invalid-state, token
expiry/renewal, logout, and bearer attachment. `identity-provisioning.test.ts`
covers create/idempotent/conflict/reassign/nonexistent/exact-match.

**Verification.** Full suite **366 passing + 5 skipped** (api **230**, broker
95, web 41). Workspace typechecks clean; `@disfap/api` production build succeeds;
the provisioning CLI was exercised against a disposable PostgreSQL cluster
(create/unchanged/refuse-reassign/reassign/nonexistent). No AWS calls; no real
database migrated; no real IdP contacted.

**Honest status:** the browser login flow, the backend verification/identity
mapping, and the operator provisioning workflow are implemented and tested
against local test issuers and disposable databases — but **no real identity
provider has been connected or tested**, so end-to-end production login is **not
operational**. The onboarding steps are in
[runbooks/oidc-production-onboarding.md](runbooks/oidc-production-onboarding.md).

---

## 13. Durable key management & credential-storage correctness (Milestone 7) — ✅ dev-complete

**The finding.** The Layer-2 credential key was an **ephemeral** `SoftwareHsm`:
a fresh RSA keypair per process start. Any `software_licenses.encrypted_credentials`
row persisted in Postgres became undecryptable after a restart, and the
`keyFingerprint` was a timestamp (`hsm-rsa4096-<now>`) rather than a real key id.
The declared algorithm (`RSA-OAEP-4096`) was never validated, the payload did not
record the modulus size, production silently fell back to a **non-secret** pair
master seed, and production without Vault silently used the in-memory
`FakeVaultClient`. The `HttpVaultClient` was an unexercised stub. Rentals left
`license_rentals.pair_payload` behind forever.

**A — durable key lifecycle.** `crypto/hsm-rsa.ts` now defines a validated
provider seam and a v2 payload `{ v, algorithm, keyBits, keyFingerprint,
cipherTextB64, encryptedAt }` where:
`algorithm` is the *actual* cipher (`RSA-OAEP-SHA256`), `keyBits` is the *actual*
modulus, and `keyFingerprint` is `SHA-256(SPKI DER)` (a real, stable key id).
`validateCredentialKey` refuses a non-RSA key, a modulus off the allowlist
(`2048/3072/4096`), or one below the minimum (default `3072`; generated keys are
`4096`); `decrypt` re-checks the version, algorithm, key size, and key id and
fails closed on any mismatch, unknown key, or tampered ciphertext.
`crypto/credential-key-store.ts` supplies durable material from
`DFAP_CREDENTIAL_KEY_FILE` (a PKCS#8 PEM, created `0600` on first use outside
production) or `DFAP_CREDENTIAL_KEY_PEM` (base64), plus decrypt-only retired keys
(`DFAP_CREDENTIAL_KEY_RETIRED_PEMS`) for rotation. `createCredentialHsm` throws
when no durable source is available; there is **no** implicit ephemeral fallback.
`config.ts` requires a durable key, `DFAP_PAIR_MASTER_KEY`, and `VAULT_ADDR`/
`VAULT_TOKEN` in production, so a misconfigured deploy fails to boot instead of
minting a non-secret pair seed or serving an in-memory Vault.

**B — credential-storage architecture.** The authoritative model is documented
(`security.md` Guarantee 7, `runbooks/key-management.md`): Vault is already
authoritative for *session* credentials (the DB holds only
`sessions.vault_cred_path`); *owner* credentials remain in Postgres, sealed under
the Layer-2 key, with `key_fingerprint` recording the sealing key. Moving owner
credentials into Vault (add `vault_cred_path`, dual-write, backfill, cutover,
later drop) is planned with an explicit rollback, but **not executed**: it cannot
be validated without a real Vault, and this milestone does not move secret
material into a store it cannot test. `HttpVaultClient` was rewritten from a stub
into a real KV-v2 + response-wrapping adapter — the API's own token for
writes/revokes (never a client token), the single-use wrap token only for unwrap,
bounded request timeouts, optional namespace, and status-only errors that never
carry a secret or token — and is tested against a local **mock** Vault server
(single-use unwrap, TTL expiry, auth rejection, 5xx, timeout, namespace, revoke).
It is explicitly *not* validated against a real Vault.

**C — pair-key / sensitive-artifact lifecycle.** `license_rentals.pair_payload`
is rental-scoped and is now cleared **inside** `closeRental` and
`completeForSession` (idempotent), with a durable backstop sweep
(`clearStalePairPayloads`) run by the rental reaper for any ended rental whose
payload was not cleared inline. `endSession` now revokes the session credential
through a bounded retry (`util/retry.ts`) instead of a single best-effort call;
the single-use wrap token and the secret's TTL remain the backstop. `null` is not
claimed to be physical memory erasure.

**D — tests.** New: `credential-keys.test.ts` (20 — restart persistence across
provider instances, key-file `0600`, env-PEM, wrong-key, tampering, algorithm
mismatch, key-size mismatch, disallowed/short modulus, key-id stability, rotation
with retired keys, duplicate id, no private material exposed);
`vault-client.test.ts` (11, against the mock Vault); `credential-lifecycle.test.ts`
(9 — pair-payload clearing, idempotent sweep, reaper isolation, `withRetries`);
`end-session.test.ts` (+2 — revoke retried, teardown unaffected). Extended
`config.test.ts` (18 → 25) and `prisma-license-store.test.ts` (8 → 11).
`prisma-persistence.pg.test.ts` grew 5 → 7 (pair payload persisted as JSONB and
cleared to SQL NULL; `jsonb` null-filter sweep) and was run on a disposable
PostgreSQL cluster.

**Migration status.** **No schema change this milestone** —
`license_rentals.pair_payload` was already a nullable `jsonb` column. Both
existing migrations (`20261016000000_init`, `20261016010000_external_identities`)
were applied to a fresh disposable cluster (port 55435) and removed; they remain
unapplied to any real database.

**Verification.** Full suite **418 passing + 7 skipped** (api **282**, broker 95,
web 41). Workspace typechecks clean; `@disfap/api` and `@disfap/web` production
builds green. No AWS; no real Vault; no HSM; no real database migrated.

**Honest status:** the key lifecycle, Vault adapter, and cleanup obligations are
implemented and tested with generated keys, a mock Vault, and a disposable
database — but **no hardware-backed provider is implemented** and **no real Vault
or IdP is connected**, so production custody remains incomplete. Rotation,
backup/recovery, and the owner-credential migration are documented in
[runbooks/key-management.md](runbooks/key-management.md).

---

## 14. Guest credential provisioning (Milestone 8) — ✅ dev-complete (production gated)

**Finding closed:** audit **C3** — the guest side could not obtain or materialize
the session credential, and the sealed-blob design required key material in the
guest.

**Spec:** *"the orchestrator gets access to the VM's disk file directly and
writes the trust certificate into the authorized logins section of the OS
itself … before the hypervisor boots the VM."*

**Decision (resolves the SSM-vs-sealed-blob conflict).** Retire the sealed-blob
`userData` path from production and adopt an **authenticated per-instance pull**:

- **Trust root:** AWS's RSA-signed EC2 **instance identity document** (IMDSv2
  `.../instance-identity/document` + detached `/signature`), verified with
  Node's `crypto` RSA-SHA256 (`src/guest/instance-identity.ts`). IMDS is
  link-local and only serves the instance's own document, so instance A cannot
  obtain/forge a document naming instance B — a genuine per-instance proof
  without any baked-in key.
- **Authorization is server-side data**, not the guest's claim: the verified
  instance id is joined to `pool_instances.cloud_instance_id` →
  `claimed_by_session_id` → session (`src/guest/binding-resolver.ts`), and the
  AMI/region/state/TTL are re-checked. A generic shared instance role is **not**
  proof. No schema change (the join uses existing columns).
- **Delivery:** `GuestProvisioningService` (`src/guest/guest-provisioning.ts`)
  reads the credential from the **same Vault path** the broker uses
  (`VaultClient.read()` added; `VaultGuestCredentialSource`), builds a
  versioned, strictly-validated package (`src/guest/provisioning-package.ts`) and
  returns it **once**. `POST /internal/guest/provision` (not user-authenticated;
  the signed identity is the authentication) is gated and fails closed (503)
  when the service is absent.
- **Guest:** `infra/packer/provision/guest/dfap-provision.sh` +
  `systemd/dfap-provision.service`. Runs `Before=xrdp.service`; the drop-in
  `systemd/xrdp-gate.conf` makes xrdp/xrdp-sesman `Requires=` it, so a failed
  provision leaves the RDP listener **down**. It re-checks the package against
  its own `instance-id`/`ami-id`/`dfap:session_id` tag, creates a
  least-privilege `tsusers` account (username from the delivered license
  identity — fixing the mismatch), idempotently handles replay, and never logs
  or argv-passes the secret (`chpasswd` on stdin).
- **Hardening reconciled:** `offline-harden/harden-offline.sh` no longer marks
  `/etc/{passwd,shadow,group,gshadow}` immutable (first-boot provisioning must
  write them; a boot-time `chattr -i` buys no real protection). Everything else
  in the immutable list is unchanged; auditd watches added in `harden.sh`.
  Documented as a trade-off, not claimed equal to immutability.
- **Production stays disabled:** `DFAP_GUEST_PROVISIONING=instance-identity`
  requires AWS cert material and is **refused at config load in production**
  until real AWS verification is validated. `server.ts` composes
  `NoPreBootInjector` in production (no `userData` credential). See
  [runbooks/guest-provisioning.md](runbooks/guest-provisioning.md).

**Tests.** `instance-identity.test.ts` (12), `guest-provisioning.test.ts` (27),
`guest-provision-script.test.ts` (3 — `bash -n` + the script's `--self-test`
fixtures), plus extended `vault-client.test.ts` (read semantics) and
`config.test.ts` (mode/production guards) and 5 HTTP-level route tests in
`app.test.ts`. These are **local fixtures** (generated keys, fakes); they pin
the contract and the fail-closed logic, **not** real VM isolation.

**Verification.** Full suite **473 passing + 7 skipped** (api **337**, broker
95, web 41). Workspace typechecks clean; `@disfap/api` and `@disfap/web`
production builds green. No AWS; no real Vault; no database migrated; **no schema
change this milestone**.

**Honest status:** the trust interfaces, the authorization state machine, the
delivery path and the fail-closed guest unit are implemented and tested — but
**no real VM isolation has been demonstrated** (no real AWS certs, no live
IMDS), so production guest provisioning is deliberately off.

---

## What needs AWS / real infra (and when)

**Nothing in this pass.** Everything above runs with `CLOUD_PROVIDER=fake`, a
`FakeVaultClient`, and the software HSM. AWS credentials become necessary only
when you want to validate the **real** paths:

| Real path | Adapter to configure | Credential/secret needed |
|---|---|---|
| Real VM launch/terminate | `AwsCloudProvider` (`CLOUD_PROVIDER=aws`) | AWS creds + `AWS_LAUNCH_TEMPLATE_ID`, `AWS_REGION` |
| Real Vault (wrap tokens) | `HttpVaultClient` | `VAULT_ADDR`, `VAULT_TOKEN` (unsealed cluster) |
| Hardware-backed key | not implemented — swap the software provider for Vault Transit / CloudHSM | HSM/KMS endpoint + creds; keep `DFAP_CREDENTIAL_KEY_FILE`/`_PEM` for the software path |
| Real Stripe | `RealStripeClient` | `STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET` |
| Golden image w/ preboot unit | `infra/packer` + `infra/terraform` | AWS creds + `session_ami_id` |
| Guest credential provisioning (M8) | `DFAP_GUEST_PROVISIONING=instance-identity` + `DFAP_GUEST_IDENTITY_CERT_FILE` | AWS regional instance-identity public cert + a live IMDS document; **production refused until validated** |

**Production hardening that must happen before a paying tenant:** set
`DFAP_PAIR_MASTER_KEY` (base64, ≥32 bytes, secret-managed), configure a durable
credential key via `DFAP_CREDENTIAL_KEY_FILE` or `DFAP_CREDENTIAL_KEY_PEM`, and
point `VAULT_ADDR`/`VAULT_TOKEN` at a real cluster — config now refuses to boot in
production without all three (see
[runbooks/key-management.md](runbooks/key-management.md)). Then apply the Prisma
migrations (`npx prisma migrate dev` locally, `migrate deploy` in deploy).

Step-by-step instructions for actually running the AWS paths (tooling, IAM,
Terraform, AMI build, verification, teardown) live in
[runbooks/aws-first-session.md](runbooks/aws-first-session.md).
