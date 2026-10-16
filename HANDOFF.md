# HANDOFF — DisFAP: implementation log, decision record & status

Single living document for: **the workflow I follow**, **every design decision and
the reasoning behind it**, **what I need from you**, **what you need to do**, and
**where the work stands**. Updated **incrementally** — a short log entry as each
step lands, with a per-milestone summary when the milestone closes.

Companion documents:

- `docs/spec-implementation-decisions.md` — the spec→implementation decision record
  (expanded per feature; this file is the overall narrative).
- `docs/runbooks/aws-first-session.md` — the real-AWS onboarding runbook.
- `docs/runbooks/oidc-production-onboarding.md` — connecting a real OIDC provider
  (production authentication onboarding).
- `System and Method for Secure Session Brokering with Zero.docx` — the source spec.

Revision history:

| Rev | Date | Milestone | Test total |
|---|---|---|---|
| r0 | 2026-10-16 | M0 — dev-complete spec implementation | 196 |
| r1 | 2026-10-16 | M1 — Phase A remediation (dev-fallback gating, H3, H1) | 214 |
| r2 | 2026-10-16 | M2 — rental atomicity, compensation, C2, recovery | **252** |
| r3 | 2026-10-16 | M3 — post-session persistence-failure gap (durable license↔session link) | **265** |
| r4 | 2026-10-16 | M4 — authentication & HTTP exposure hardening (C4, CORS, migration validation) | **287** (+3 skipped) |
| r5 | 2026-10-16 | M5 — OIDC/JWT access-token authentication (real verifier + identity mapping) | **328** (+4 skipped) |
| r6 | 2026-10-16 | M6 — end-to-end OIDC authentication (browser code+PKCE, provisioning CLI) | **366** (+5 skipped) |
| r7 | 2026-10-16 | M7 — durable key management & credential-storage correctness | **418** (+7 skipped) |
| r8 | 2026-10-16 | M8 — guest credential provisioning (C3): per-instance identity, fail-closed guest unit | **473** (+7 skipped) |

Last updated: 2026-10-16 (rev r8)

---

## 0. How to read this document

- **§1–§3** are the current state, the rules I never break, and the process I run.
- **§4** is the chronological log: what was built and why, **appended
  incrementally** — a short entry per step as the work lands, rather than one
  batch reconstructed at the end of a milestone. Each milestone section lists its
  steps in the order they were performed.
- **§5** is the consolidated decision register (numbered, each with its reasoning
  and the alternatives I rejected).
- **§6–§7** are the architecture map and the verification ledger (real commands,
  real output).
- **§8–§12** are open risks, the decisions I need from you, the file inventory, the
  git state, and next moves.

Anything marked **verified** was produced by an actual command in this repo.
Anything marked **assumed** is design reasoning not yet exercised by a test or a
real external system.

---

## 1. TL;DR & current status

The software-marketplace spec ("System and Method for Secure Session Brokering
with Zero-Exposure Credential Injection in Virtual Machines") is **implemented,
audited, remediated, and verified locally** on the fake cloud + software HSM +
dev Vault. **No AWS credentials are needed for any of it.**

Current, verified state (rev r8):

- `npm run typecheck` — **clean** across api + broker + web.
- `npm test` — **473 passed, 7 skipped** (api **337** · broker 95 · web 41; the 7
  skips are the PostgreSQL-backed persistence tests, which run only when
  `DFAP_TEST_DATABASE_URL` is set).
- `npm run build --workspace=@disfap/api` (`prisma generate && tsc`) — **succeeds**.
- `npm run build --workspace=@disfap/web` (`vite build`) — **succeeds**.
- Both migrations applied cleanly to a **disposable** local PostgreSQL cluster
  (`20261016000000_init` + `20261016010000_external_identities`); the
  provisioning CLI was exercised against a disposable cluster (create → unchanged
  → refuse-reassign → reassign → nonexistent-user) and the pair-payload
  persistence/cleanup was validated there too. Cluster destroyed afterwards.
- Nothing committed; all work is uncommitted working-tree changes.

What works today (local): catalog browse, rent (atomic claim, credential
decrypt, real session creation, rental ledger, metering), auto-release on session
end, cross-org marketplace template launch via a validated grant, a rental
reaper for expired/abandoned leases, safe compensation when the rental row fails
to persist after a session exists (terminate-then-release, with a durable
`session.license_id` link), **fail-closed inbound authentication** with
server-derived roles and an exact-origin CORS allowlist, a **real
provider-neutral OIDC/JWT access-token verifier** (signature, alg allowlist,
exact issuer/audience, `exp`/`nbf`, required `sub`, rotating JWKS, ID-token
rejection) that maps `(issuer, subject)` to an internal user, a **browser
Authorization Code + PKCE login flow** (in-memory tokens, bearer attachment), an
**operator CLI** to provision identity mappings safely, and a **durable,
validated credential-key lifecycle** (a real key id, validated modulus/algorithm,
rotation via decrypt-only retired keys, restart persistence) with a hardened
Vault adapter and cleanup obligations for rental-scoped re-seals.

What is **not** done and is **not** claimed to work: the real AWS/EC2 path (stub),
the **real-AWS validation of guest provisioning** (the instance-identity verifier,
binding and fail-closed guest unit are built and unit-tested against generated
keys/fakes, but real VM isolation is unproven and `DFAP_GUEST_PROVISIONING=
instance-identity` is refused in production), any
real HSM/KMS/Vault (the Vault HTTP adapter is tested against a mock, the key
provider is software-only), and a **real IdP connection** (the OIDC adapter and
the browser flow are tested against local test issuers/fixtures only — so
**end-to-end production login is still not operational**). Owner credentials
remain in Postgres under the Layer-2 key; moving them into Vault is documented and
planned but **not executed**. Also not done: applying the (now validated) Prisma
migrations to a real database.

---

## 2. Ground rules & invariants (never violated)

These are the standing constraints for every change, from the spec, the audit, and
your instructions:

1. **Never fabricate success on a genuine failure.** A failed create/terminate/
   fetch must surface as an error (5xx/409), never a synthetic `ready`/`ended`.
2. **Dev fallbacks are explicit and OFF by default**, and must fail fast if enabled
   while `DFAP_ENV=production` or `NODE_ENV=production`.
3. **Do not weaken authn/authz/crypto.** Any new cross-tenant path must be a
   data-backed authorization decision, never the removal of a check.
4. **No AWS / infra / DB-migration / spend actions** without your explicit go-ahead.
   No `terraform`, no `prisma migrate` against a real DB, no cloud calls.
5. **No secrets in chat.** Reference env var names only.
6. **Do not commit, reset, or discard** existing work.
7. **Keep changes consistent** with the codebase: ports/adapters, injectable fakes,
   JSDoc citing the spec layer, `exactOptionalPropertyTypes`-safe conditional
   spreads, Vitest with no AWS/DB.
8. **Stop at the end of an approved milestone** and report; do not roll into the
   next phase unbidden.

---

## 3. The workflow I follow (per milestone)

1. **Re-read the current workspace before editing.** Files drift between sessions;
   I verify actual state (e.g. this session I found the orchestrator still on the
   pre-M2 code while the store/reaper edits had persisted) rather than trusting a
   summary.
2. **Produce a short plan first** — the relevant files plus any database or
   architectural change — and state it before touching code.
3. **Implement in small, testable steps** (store → core logic → wiring → tests).
4. **Typecheck early and often** to catch signature/`exactOptionalPropertyTypes`
   errors before writing tests.
5. **Run targeted tests, then the full suite, then workspace typechecks, then the
   API production build.** Report the actual commands and output.
6. **Inspect the final diff** and confirm the tracked-file baseline is untouched.
7. **Append to `HANDOFF.md` incrementally** — a short step entry (what / why /
   what I rejected) as each step lands, so the log is a real-time record rather
   than a summary written after the fact. The revision-history row still
   summarizes the milestone when it closes.
8. **Report file-by-file, with real test results and remaining security
   limitations**, then **stop**.

Modes used so far: **(a) read-only audit**, **(b) approved-milestone
implementation**, **(c) "dev-complete" build** — production externals behind
adapter seams.

---

## 4. Chronological log

> From **r6 onward**, entries are appended **incrementally** (one short step
> entry, in the order performed — see §0/§3). Earlier revisions were recorded as a
> single consolidated per-milestone entry.

### 4.0 — M0: dev-complete spec implementation (rev r0)

**Scope.** The spec's Layers 3–6 already existed in the repo. I closed the
Layer-1/2 gaps plus the two differentiators, keeping real AWS/HSM/Vault/Stripe as
adapter seams.

Built in M0:

- **Layer 1 persistence** — `software_licenses` + `license_rentals` tables and a
  `PrismaMarketplaceStore` behind the *existing* `MarketplaceStore` port.
- **Layer 2 per owner-rentee pair keys** (spec TA-4) — `crypto/pair-keys.ts`.
- **Pre-boot credential injection** (spec "Working Explanation" step 5) —
  `cloud/disk-injector.ts` `PreBootInjector` port called by the `PoolManager`
  *before* `RunInstances`.
- **Two-thread orchestrator** — credential decrypt + pair re-seal + rental row +
  Stripe meter.
- **Rental auto-release** on `endSession`; `POST /marketplace/licenses/:id/release`.
- **Web** — `LaunchPage` rental-duration selector (1/2/4/8 h).

Result: **196 tests** (api 84 · broker 95 · web 17); typecheck clean; a live HTTP
smoke test passed (catalog → rent 2 h → license drops out → owner release 200 /
non-owner 403 → license restored). One real bug found by the new tests:
`OfflineImageInjector.unseal` ignored its `imageId` argument (AAD bound to the
blob's own id) — fixed to bind to the caller's image id.

### 4.1 — Read-only audit (no code changes)

I audited the credential lifecycle end-to-end and produced a requirement→
implementation matrix, verified-vs-assumed table, and findings by severity.

Key findings that shaped everything after:

- **C1** — fabricated `createSession`/`endSession`/`getSession` fallbacks masked
  genuine failures. In particular the earlier "end-to-end verified" rent was
  actually the masked `ses_dev_…` path; the real createSession would have thrown.
- **C2** — marketplace licenses reference templates owned by **another org**, so
  the real `createSession` rejected them (`template.orgId !== principal.orgId` →
  403). Marketplace renting could not actually work behind the fallback.
- **C3** — the guest side cannot unseal or log in: no `dfap-preboot.service`
  exists, the image key is a single global value derived from the pair master,
  `harden-offline.sh` sets `chattr +i` on `/etc/shadow|passwd`, the
  `install-workspace.sh` SSM password path has zero code, and the seed credential
  usernames don't exist in the guest. **(→ resolved in M8, §4.9: per-instance
  AWS-instance-identity pull + server-side binding + fail-closed guest unit;
  production deliberately gated until real-AWS validation.)**
- **C4** — auth is `HeaderStubAuthenticator` (any caller can self-assert
  `owner`/`admin`); CORS reflects `Origin` with credentials.
- **H1** — terminal session states bypassed rental release.
- **H2** — double-rent: license claiming was check-then-act (`markRented`).
- **H3** — the `NODE_ENV`-based re-rent bypass failed open in staging/test.
- **H4** — `pair_payload` is decorative (never read) and never deleted.
- **H5** — `SoftwareHsm` mints an ephemeral RSA-4096 key per process while
  credentials are persisted → persisted licenses can't be decrypted across
  restarts.
- **H6** — the Prisma→in-memory marketplace fallback could hide a missing
  migration in production.
- **H7** — the dead-man switch is inert/over-scoped.
- **M1–M9** — incl. **M5** (tests inject 2048-bit keys while the label stays
  `RSA-OAEP-4096`), **M6** (no rental reaper ⇒ a license can stay `rented`), and
  **M3** (metering ordering).
- Plus **L1–L5** and the `listTemplates` swallow-and-fallback sibling of C1.

Deliverables: findings by severity, doc-vs-code discrepancies, and a proposed
Phase A–G remediation plan. **You approved Phase A steps 1–4 + the H1 fix.**

### 4.2 — M1: Phase A remediation (rev r1)

**Approved scope:** gate the fabricated fallbacks; gate the Prisma→in-memory
marketplace fallback; replace the `NODE_ENV` rent bypass with an explicit flag;
ensure terminal session states still attempt rental release; add regression tests.

Implemented:

- **`DFAP_DEV_FALLBACK`** parsed by a new `bool()` (`true`/`1` enable,
  `false`/`0`/unset disable, anything else = `ConfigError`), **default false**, and
  **fail-fast** if enabled while `DFAP_ENV=production` or `NODE_ENV=production`
  (`config.ts`).
- The three fabricated fallbacks (`createSession`/`endSession`/`getSession`) and
  the marketplace fallback are all gated behind `cfg.devFallback`.
- The `NODE_ENV` rent bypass became **`devAllowRerent` (default false)** on the
  orchestrator → busy licenses are **409** unless an operator opts in.
- **H1** — the terminal-state branch of `endSession` now still attempts
  `marketplace.completeForSession(sid)` best-effort (errors swallowed) before
  returning.
- Local-dev ergonomics: `scripts/start-all.mjs` sets `DFAP_DEV_FALLBACK=true`;
  documented in `.env.dev.example` (`true`) and `deploy/.env.example` (`false`).
- Tightened `any`→`Principal`/`CreateSessionInput`; removed a stray `endedAt` from
  the fabricated `endSession` result.

Result: **214 tests** (api 102 · broker 95 · web 17); typecheck clean; API build
green. New/updated tests: `config.test.ts`, `prisma-license-store.test.ts`,
`server.test.ts`, plus updated `orchestrator.test.ts` and `end-session.test.ts`.

### 4.3 — M2: rental atomicity, compensation, C2 & recovery (rev r2)

**Approved scope (your instructions):** atomic claiming; failure compensation;
template ownership (C2) + a real integration test; a rental reaper; and a
verification pass — without AWS, without running migrations, without weakening
auth/crypto.

**Database decision: no migration required.** Every recovery decision reuses
existing columns (`software_licenses.status/current_rentee_id/updated_at`,
`license_rentals.started_at/hours_requested/ended_at`, `sessions.state`). Verified
against `schema.prisma` (which already has `updatedAt @updatedAt` and the
`rentals LicenseRental[]` relation).

Implemented:

1. **Atomic claiming.** `MarketplaceStore.claimAvailable(id, renteeId)` is a
   conditional compare-and-set — Postgres does one guarded
   `updateMany({ where: { id, status: 'available' }, … })` and treats `count === 1`
   as the win; the in-memory store mirrors it. The orchestrator uses it as the
   authoritative guard; a lost race is **409**. `markRented` survives only as a
   force/admin/dev helper.
2. **Compensation + explicit ordering.** The orchestrator runs:
   `advisory pre-check → ATOMIC CLAIM → HSM decrypt → createSession → recordRental
   → meter → attachMeterEvent`. Any failure *before a valid session exists*
   releases the claim via `releaseClaim(id, renteeId)` — a second conditional op
   that can only free a claim still held by that rentee, so it can never release
   another tenant's license. No rental row and no meter event are written for a
   session that never became valid. A meter failure leaves the rental recorded and
   `meter_event_id = null` as a recoverable obligation.
3. **VM cleanup.** `createSession` gained optional `cloud`/`instances` deps: a
   failure after `RunInstances` best-effort terminates the instance and marks the
   `pool_instances` row terminated, recording `vmCleanedUp` on the `failed` event.
   If cleanup is absent or itself fails, the pool row (hard `expires_at`) + the
   `failed` session remain the obligation the layer-4 fleet reaper acts on.
4. **Template ownership (C2).** Instead of dropping the org check, `createSession`
   accepts a **server-minted** (never client-supplied) `templateGrant` and keeps
   authorizing by asking the store
   `isLicensedTo(licenseId, renteeId, templateId)` — true only when the license is
   currently rented to this rentee *and* its template is the one requested.
5. **Rental reaper.** New `marketplace/rental-reaper.ts` (pure `planRentalReap` +
   `RentalReaper`) closes expired leases **only when the driven session is terminal
   or gone** — a stale timestamp never steals a live session's license — and
   separately releases abandoned claims (rented license, no open rental, past a
   grace window). Per-item error isolation; failed teardowns retried; idempotent.
   Wired into the 60 s loop.

Result: **252 tests** (api **140**, up from 102 · broker 95 · web 17); typecheck
clean; API build green. New/expanded coverage: atomic-claim concurrency,
conditional-write shape, compensation on failed creation, VM cleanup, cross-org
grant allow/deny, and the reaper's expiry/idempotency/retry/fail-safe paths.

> A mid-session surprise worth recording: on re-reading the workspace I found the
> orchestrator still on pre-M2 code while the store/reaper/create-session edits
> had persisted. I reconciled to the real state before editing rather than
> assuming the summary was accurate. This is why step 1 of the workflow exists.

### 4.4 — M3: post-session persistence-failure gap (rev r3)

**The gap (found at the end of M2, this is its fix).** The M2 ordering was
`claim → createSession → recordRental`. If `recordRental` failed *after* a valid
session (and possibly a VM) existed, the license stayed `rented` with **no durable
link** to that session. The stale-claim reaper's rule — "rented license, no open
rental, past grace ⇒ release" — could then free the license **while the session/VM
was still alive**. That was a real hole: the reaper treated "no rental" as proof
of "no session", which is exactly what a rental-persist failure violates.

**Fix, in four parts:**

1. **Durable link (a real migration).** `Session` gains nullable
   `license_id` (`@@index([licenseId, state])`). The orchestrator passes
   `licenseId` into `createSession`, which stamps it on the row **in the same
   insert that first makes the session durable** — before any VM/credential step
   can leave a session non-terminal. A greenfield baseline migration was authored
   offline (`prisma migrate diff --from-empty --to-schema-datamodel`) because the
   repo had **no** `migrations/` directory; it includes the new column + index.
2. **Compensation in the orchestrator.** Only the `recordRental` call is wrapped
   (the meter is not). On failure: `terminateSession(sid)` (real `endSession`,
   wired in `server.ts`) tears down the session + VM; `releaseClaim(licenseId,
   renteeId)` runs **only when the reported state is terminal** (`ended`/`failed`).
   If teardown throws or is absent, the claim is deliberately **held**.
3. **Reaper safety.** `RentalReaperSessions` gains
   `hasActiveSessionForLicense(licenseId)`; `planRentalReap` takes the set of
   licenses with active sessions and moves them to a new `heldClaims` bucket
   instead of `releaseClaims`. A lookup **error is treated as "may be live"**
   (fail-closed), and `RentalReapResult.heldClaims` makes the decision observable.
4. **Meter ≠ rental.** A meter failure still returns a valid session with
   `meter_event_id = null` (retry obligation) and **never** terminates the session
   — distinct from a rental-persistence failure.

**Why an active session can never lose its reservation (the proof I gave before
editing):**

- *Invariant A — the durable link exists before a session can be live.* The
  license is claimed (atomic CAS) **before** `createSession`, and `createSession`
  writes `sessions.license_id` in the very insert that creates the session row.
- *Invariant B — the reaper only releases provably-free licenses.* The stale-claim
  path releases `L` only when `hasActiveSessionForLicense(L) === false` (no
  non-terminal session with `license_id = L`); any error is treated as active.
- Therefore a non-terminal session for `L` makes the reaper decline to release
  `L`. Every crash window is safe: crash before the session row exists ⇒ no
  session, release is safe; crash after ⇒ a non-terminal row with `license_id`
  exists and the reaper holds.

**Alternatives I considered and rejected (the reasoning, kept):**

- *Record a provisional rental row **before** `createSession`, then attach the
  session id.* Rejected: `license_rentals.session_id` is unique + NOT NULL and the
  session id does not exist until the session row is inserted — the link would be
  non-durable across exactly the crash window we are closing, or would require
  relaxing the rental's own invariants.
- *Put the link on the license (`software_licenses.reserved_session_id`) instead of
  the session.* Rejected: at claim time the session doesn't exist yet, so this is
  the same "id we don't have yet" problem one write later, and it adds mutable
  recovery state to the license row the marketplace reads for every rent.
- *Have `endSession` release the license directly by `license_id` (skip waiting for
  the reaper).* Rejected: with the same rentee and license appearing on more than
  one session (possible after an operator-gated `devAllowRerent`), a terminal
  session `S1` releasing by `(licenseId, renteeId)` could free a claim belonging to
  a *different* live session `S2` — a conditional release cannot distinguish them.
  The reaper's rule ("no non-terminal session for `L`") is the safe discriminator,
  so the reaper stays the release path for the no-rental case. Trade-off recorded
  in §8 as a fail-closed delay.
- *Add an automated retry of the failed `recordRental` itself.* Rejected for this
  milestone: it would need a durable retry queue; the terminate-on-failure +
  reaper release already closes the correctness hole without new infrastructure.

Result: **265 tests** (api **153**, up from 140 · broker 95 · web 17); typecheck
clean (api/broker/web); API build green. New/expanded coverage: orchestrator
rental-persist failure → terminate + release; teardown throws/non-terminal → claim
held; meter failure → session preserved; concurrent same-license rents → one
winner; `createSession` persists `license_id`; the real reaper holds an abandoned
claim while a linked session is live and releases it once terminal; reaper
fail-safe on lookup error.

---

### 4.5 — M4: authentication & HTTP exposure hardening (rev r4)

**What I inspected first.** The audit report (HANDOFF §4.1 + `docs/spec-implementation-decisions.md`),
the existing `Authenticator` seam, `config.ts`, `app.ts`, `server.ts`, the API/client tests,
and the frontend `ApiClient`. Findings: `HeaderStubAuthenticator` trusted
`x-dfap-user`/`x-dfap-org`/`x-dfap-role` everywhere (C4); the release route honoured a role
from those headers; CORS reflected any `Origin` with credentials; `GET /marketplace/licenses`
was unauthenticated; and the M3 migration was authored but never applied/verified.

**The authentication design (and what I refused to build).** The repo has **no** identity
provider and the only token machinery is the broker's *connect* token (a per-session
capability, not a user identity). The instruction is explicit: do not improvise production
auth. So I did not. Instead, composition selects exactly one adapter from `DFAP_AUTH_MODE`:

- `FailClosedAuthenticator` — **default `deny`**. Every request 401s. With no IdP wired, a
  real deployment serves nothing rather than trusting asserted identity.
- `DevHeaderAuthenticator` — `dev-header`, **local development only**; `loadConfig` refuses
  it when `DFAP_ENV`/`NODE_ENV` is `production`. Reads identity from `x-dfap-user`/`x-dfap-org`
  and **ignores `x-dfap-role` entirely**.

**Privilege is server-side data.** A principal's `role` is resolved from `org_members` via a
new `MembershipRepo` port (`PrismaMembershipRepo`). The role header is never read. In
dev-header mode the role comes from the DB; under the dev fallback with no reachable DB it
drops to least-privilege `member` — never admin. So a forged `x-dfap-role: admin` confers
nothing, which the tests now pin.

**Object-level authorization.** Release became **owner-only**
(`license.ownerId === principal.userId`). The old "or any admin/owner" branch let an admin of
*another* org release a license; because `software_licenses` carries no owning org, no
tenant-scoped admin override can be expressed — so I removed the branch rather than guess
(recorded as a limitation in §8). Session read/terminate already check
`session.orgId === principal.orgId`; kept and tested. `GET /marketplace/licenses` is now
authenticated (ownerName + availability are tenant-identifying; credentials are never
returned).

**CORS.** Exact `DFAP_CORS_ALLOWED_ORIGINS` allowlist — comma-separated bare origins,
wildcards rejected at config load, empty default = deny all. The `onRequest` hook sets
`Access-Control-Allow-Origin` only for a listed origin (never reflection) and drops the role
header from `Access-Control-Allow-Headers`.

**Frontend.** `ApiClient` stopped sending `x-dfap-role`; dev identity headers are gated on
Vite's `import.meta.env.DEV`, so production bundles carry no asserted identity.

**Migration validation.** No new schema change. The M3 baseline
`20261016000000_init` was applied with `prisma migrate deploy` to a **fresh, disposable**
local PostgreSQL cluster (Postgres.app binaries; never the developer's DB), and a new
env-gated test (`DFAP_TEST_DATABASE_URL`) verified the durable `sessions.license_id` link and
`hasActiveForLicense`. The cluster was stopped and deleted afterwards. `prisma/migrations/README.md`
documents fresh-DB use and safe baselining of an existing DB.

**Alternatives I considered and rejected.**
- *Invent a signed user token (reuse the broker's HMAC machinery).* Rejected: that is exactly
  the improvised production auth the task forbids, and the connect token is a session
  capability, not an identity.
- *Keep `HeaderStubAuthenticator` but rename it.* Rejected: the flaw is trusting self-asserted
  identity/config at all; a rename hides it. Fail-closed by default is the honest posture.
- *Keep admin/owner release by scoping it to the license's org.* Rejected: the license model
  has no org, and inferring it from `templateId` (a non-FK, possibly-absent string) would make
  authorization depend on unrelated data.
- *Make `GET /marketplace/licenses` public.* Rejected: `ownerName` + availability leak
  tenant-identifying data; authenticated browsing costs nothing here.
- *Widen CORS by reflecting `Origin` in dev only.* Rejected: environment-conditional reflection
  is how CORS bypasses ship; an exact allowlist works in dev and prod.

Result: **287 passed + 3 skipped** (api **175**, up from 153 · broker 95 · web 17);
typecheck clean (api/broker/web); API build green. New coverage: `auth.test.ts` (fail-closed,
identity resolution, forged-role ignored, missing identity, no membership); config tests for
`authMode` + CORS parsing/guards; app tests for unauthenticated catalog (401), forged role
(no privilege), cross-tenant session access (403), cross-owner release (403, even as admin),
owner release (200), approved/unapproved/absent CORS; server tests for authenticator
composition; and the env-gated PostgreSQL persistence test. No AWS; the disposable DB was
migrated and removed.

---

### 4.6 — M5: OIDC/JWT access-token authentication (rev r5)

**What I inspected first.** HANDOFF, `docs/security.md`, `auth/authenticator.ts`,
`config.ts`, `ports.ts`, the Prisma schema (User/OrgMember), the membership repo,
`app.ts`, `server.ts`, the frontend `ApiClient`, and the dependency tree. Findings:
the repo had **no** JOSE/OIDC library at all (checked `node_modules` +
`package-lock.json`); M4's seam (`Authenticator`, `RoleResolver`, `MembershipRepo`)
was the right place to plug in a real verifier; and `User` had no external-identity
mapping — only `email`, which must not be an identity key.

**Library.** Added `jose@^6.2.12` (maintained, zero-dependency, WebCrypto). The task
forbids hand-rolled signature verification, so no crypto is written by hand;
`createRemoteJWKSet` supplies key caching **and rotation** (refetch on an unknown
`kid`), and `jwtVerify` does the signature/claim validation.

**Verification (`auth/jwks.ts`).** `JoseAccessTokenVerifier implements
AccessTokenVerifier` enforces signature; a configurable `algorithms` allowlist
(`none` never permitted); **exact** issuer; **exact** audience; `exp`/`nbf` with a
clock tolerance; and a required `sub`. Keys come **only** from server config — an
explicit `DFAP_OIDC_JWKS_URL` or discovery at the issuer, where the advertised
`issuer` is pinned to the configured one. A request can never supply a key or JWKS
URL. Every failure maps to a 401 — no unverified fallback (tested by making the
JWKS endpoint fail and pointing at a dead port).

**Access tokens vs ID tokens.** The audience must be the API's resource id (an ID
token addresses the client), and providers that mark token kind are honored with a
configurable `token_use` claim (enforced when present; strictly required with
`DFAP_OIDC_REQUIRE_TOKEN_USE`) and/or a required JOSE header `typ`
(`DFAP_OIDC_ACCESS_TOKEN_TYP`, e.g. RFC 9068 `at+jwt`).

**Identity mapping (new schema).** An external `sub` is **never** the internal user
id. New model `external_identities` maps `(issuer, subject) → user_id` with
`UNIQUE (issuer, subject)`; email is informational only. `PrismaIdentityRepo.resolve`
returns null for an unmapped identity and `OidcAuthenticator` **rejects** — there is
**no JIT provisioning**. Organization + role come from `org_members`
(`MembershipRepo.resolveMembership` → `{orgId, role}`): zero memberships reject;
multiple without a configured org claim reject; an org claim
(`DFAP_OIDC_ORG_CLAIM`) only *selects* among real memberships. `x-dfap-user` /
`x-dfap-org` / `x-dfap-role` are ignored entirely by this adapter.

**Composition.** `authMode` is now `'deny' | 'dev-header' | 'oidc'`; `oidc` requires
`DFAP_OIDC_ISSUER` + `DFAP_OIDC_AUDIENCE` or `loadConfig` throws (`parseOidc`),
including a `none`-algorithm rejection and http(s)-URL validation. `server.ts`
composes exactly one adapter per mode and falls closed if `oidc` is somehow
selected without config; `dev-header` is still refused in production.

**Frontend (partial by design).** `ApiClient` gained an injectable
`getAccessToken` and sends `Authorization: Bearer` when present (and still never a
role header). **No authorization-code+PKCE login flow is implemented** — the
end-to-end production login path is incomplete and stated as such in
`docs/security.md`.

**Migration.** New `20261016010000_external_identities`, authored with
`prisma migrate diff --from-url <baseline> --to-schema-datamodel` against a
disposable cluster, then applied and validated there (both migrations apply to a
fresh DB; the env-gated PG test now also proves `(issuer, subject)` resolution and
the unique constraint). **Unapplied to any real database.**

**Alternatives I considered and rejected.**
- *Hand-roll JWT verification with Node `crypto`.* Rejected outright — the task
  forbids it, and rolling JOSE is a classic source of vulnerabilities.
- *`openid-client`.* Rejected: it is a **client** library (login/refresh); the
  server only needs to verify bearer access tokens, which is `jose`'s job.
- *Just-in-time provision a user from the token's `email`.* Rejected: email is
  mutable/reassignable and must never be an identity key; unmapped ⇒ reject.
- *Key the identity on `sub` alone.* Rejected: `sub` is only unique per issuer;
  the key is `(issuer, subject)`.
- *Trust an `org`/`role` claim.* Rejected: privilege is server-side data; the org
  claim is only a selector validated against `org_members`.
- *Allow a client-supplied JWKS URL (or a `jku`/`x5u` header).* Rejected: that is
  attacker-controlled key material; the JWKS comes only from server config.
- *Default `algorithms` to "anything but none".* Rejected: an explicit allowlist
  (default `RS256`) is the safe posture.

Result: **328 passed + 4 skipped** (api **212**, up from 175 · broker 95 · web 21);
typecheck clean (api/broker/web); API build green. New coverage: `oidc-jwt.test.ts`
(18: valid, bad signature, expired, nbf, wrong issuer, wrong audience, disallowed
alg, unknown kid, missing sub, ID-token rejection, required token-use, required
`typ`, rotation, discovery, mismatched discovery issuer, dead JWKS, JWKS-failure
no-fallback, malformed); `oidc-authenticator.test.ts` (12: bearer extraction,
identity mapping, unmapped/no-membership/ambiguous rejection, org-claim selector,
malformed claim, role-escalation ignored, `x-dfap-*` headers ignored);
`config.test.ts` (12 → 18); `server.test.ts` (10 → 11, OIDC composition);
`apps/web/test/api-client.test.ts` (new, 4); `prisma-persistence.pg.test.ts`
(3 → 4). No AWS; no real DB migrated; no real IdP contacted — the disposable
cluster was migrated and removed.

---

### 4.7 — M6: end-to-end OIDC authentication (rev r6)

> Logged **incrementally**, in the order the work landed (see §0/§3). Each step was
> appended as it completed, not batched at the end.

**Step 1 — Pre-edit inspection + plan.** Re-read HANDOFF, `docs/security.md`, the
M5 verifier (`auth/jwks.ts`, `auth/oidc.ts`), `config.ts`, the Prisma
schema/migrations, the frontend `ApiClient`, `App.tsx`/`main.tsx`/`Navbar.tsx`, the
existing web tests, and the dependency tree. Findings: `ExternalIdentity` and the
`(issuer, subject)` map already exist (⇒ **no schema change** this milestone); the
browser has **no** OIDC library and **no** login flow; `ApiClient.getAccessToken`
is implemented but unused; and there is **no** supported way to seed
`external_identities`, so the backend can never be reached end to end. Presented
the plan (frontend code+PKCE · provisioning CLI · integration test · docs) before
editing.

**Step 2 — Dependency.** `npm install oidc-client-ts@^3.5.0 --workspace=@disfap/web`
(verified the exports `UserManager`, `InMemoryWebStorage`, `WebStorageStateStore`,
`User`). Maintained browser client; the API keeps `jose`; no hand-rolled crypto
anywhere.

**Step 3 — Frontend login flow.** New `apps/web/src/auth/oidc-settings.ts`
(`oidcSettingsFromEnv` + `createUserManager`), `apps/web/src/auth/OidcAuth.ts`
(wrapper), and `AuthGate.tsx` (+ `AuthGate.module.css`); wired `App.tsx` (init,
gating, token injection, sign-out), `Navbar.tsx` (`onSignOut`/`userLabel`), and
`vite-env.d.ts` (`VITE_OIDC_*`). Design: `response_type=code`, S256 PKCE, a
**public client with no client secret**, a fresh `nonce`, and an **in-memory**
token store (`InMemoryWebStorage`). `init()` handles callback success /
`error=access_denied` / invalid state / callback exception and strips the query;
`signin()` sanitizes the in-app return route; `signout()` clears local state then
best-effort provider logout; `getAccessToken()` renews once on expiry and
otherwise returns **`null` while clearing state** (never a misleadingly
authenticated client). `oidcSettingsFromEnv` **throws** on partial/malformed
config rather than silently disabling login. Tokens never touch `localStorage`;
only the in-flight state/nonce/PKCE verifier sits in `sessionStorage` for the
redirect round-trip.

  - *Rejected:* hand-rolling PKCE/redirect (or `oauth4webapi`) — the maintained
    client gets state/nonce/PKCE/renewal right; persisting tokens to
    `localStorage`/`sessionStorage`; decoding the JWT in the browser to decide
    `sub`/roles (a readable JWT is not a verified one); a silent-renew iframe by
    default (needs a served renew page; on-demand `signinSilent` is
    provider-neutral).

**Step 4 — Operator provisioning.** New
`services/api/src/auth/identity-provisioning.ts` (pure `provisionIdentity` over a
narrow `IdentityProvisioningStore` port), `PrismaIdentityProvisioningStore` in
`db/prisma-repos.ts`, and the DB-direct CLI `src/cli/provision-identity.ts`
(`npm run provision:identity`). Validates the internal user exists, is
idempotent, refuses to repoint an existing `(issuer, subject)` without an explicit
`--reassign`, keys on the exact `(issuer, subject)` (never email), and prints only
non-secret identifiers. **No HTTP endpoint.**

  - *Rejected:* auto-provisioning a user on first login (`sub`→user or
    email→user) — that is the email/subject-as-trust the audit warns about; and an
    authenticated admin HTTP endpoint (a new privilege surface) before one is
    needed.

**Step 5 — Tests.** New `apps/web/test/oidc.test.ts` (20),
`services/api/test/identity-provisioning.test.ts` (10),
`services/api/test/support/oidc-test-provider.ts` (real discovery / JWKS /
`authorize` with S256 verification / `token` minting genuine RS256), and the
strongest practical integration test `services/api/test/oidc-e2e.test.ts` (8)
wiring the real provider → real `JoseAccessTokenVerifier` + `OidcAuthenticator` +
`buildApp`; extended `prisma-persistence.pg.test.ts` (4 → 5). Along the way: the
first wrong-PKCE test was self-consistent (challenge derived from the same
verifier) and was rewritten to authorize with one challenge and exchange a
*different* verifier (a real mismatch); two `exactOptionalPropertyTypes`/type
errors in the web test were fixed. New coverage: valid token → 200, no token →
401, unmapped subject → 403, tampered signature → 401, `x-dfap-user/org/role`
cannot override the verified identity or escalate privilege (asserted on the
captured principal), cross-tenant read → 403.

  - *Rejected:* mocking the verifier at the seam (proves nothing about the real
    browser↔API boundary).

**Step 6 — Disposable-DB validation.** Fresh local PostgreSQL (port 55434):
`prisma migrate deploy` applied both migrations; `DFAP_TEST_DATABASE_URL=… vitest
run test/prisma-persistence.pg.test.ts` → **5 passed**; the CLI was exercised for
real — `created` / `unchanged` / refuse-reassign (exit 1) / `reassigned`
(`--reassign`) / `no such DisFAP user` (exit 1), the final row confirmed via
`psql`. Cluster stopped and removed. **No real DB migrated.**

**Step 7 — Docs/config.** New `docs/runbooks/oidc-production-onboarding.md`;
updated `docs/security.md` (Guarantee 6 + limitations),
`docs/spec-implementation-decisions.md` (§12), `services/api/README.md` (CLI), and
`deploy/.env.example` + `.env.dev.example` (web OIDC build vars). All of it states
production login is **not operational** until a real provider is configured and
tested.

**Step 8 — Verification + rev bump.** `npm run typecheck` clean (api/broker/web);
`npm test` **366 passed, 5 skipped** (api **230** · broker 95 · web **41**); API
build green (`prisma generate && tsc`); web build green (`vite build`). Recorded as
rev **r6** in the header + ledger. Nothing committed; no AWS.

**Step 9 — Logging practice changed to incremental.** Per your instruction,
`HANDOFF.md` is now appended **incrementally as each step lands** rather than as
one consolidated per-milestone entry; this M6 section was restructured to match
(see §0/§3).

---

### 4.8 — M7: durable key management & credential-storage correctness (rev r7)

> Logged **incrementally**, in the order the work landed (see §0/§3). Scope A–E
> (durable key lifecycle · credential-storage architecture · pair-key/artifact
> lifecycle · tests/migration safety · verification).

**Step 1 — Pre-edit inspection + plan.** Re-read HANDOFF, `docs/security.md`, the
audit findings, and the real modules: `crypto/hsm-rsa.ts`, `crypto/pair-keys.ts`,
`vault/vault-client.ts`, `credentials/credential-issuer.ts`,
`integration/vault-credential-provider.ts`, `config.ts`, `server.ts`,
`app.ts`, `marketplace/license-store.ts` + `prisma-license-store.ts`,
`marketplace/rental-reaper.ts`, `orchestrator/two-thread-orchestrator.ts`,
`sessions/end-session.ts`, `prisma/schema.prisma`, `cloud/disk-injector.ts`, and
every test that touched the HSM or the payload shape. Findings:

- **H5 confirmed.** `server.ts` did `new SoftwareHsm()` — a **fresh RSA keypair per
  process start** — while `software_licenses.encrypted_credentials` is persisted.
  Any persisted row became **undecryptable after a restart**.
- `keyFingerprint` was `hsm-rsa4096-<Date.now()>` — a timestamp, not a key id.
- `algorithm` was hardcoded `'RSA-OAEP-4096'` and never validated; the payload never
  recorded the actual modulus size; `decrypt` checked the label, not the key.
- `DFAP_PAIR_MASTER_KEY` unset ⇒ a **non-secret** dev seed derived from the signing
  kid, **including in production**.
- `server.ts` silently used the in-memory `FakeVaultClient` when `cfg.vault` was
  absent, **including in production**; `HttpVaultClient` was a stub.
- **H4 confirmed.** `license_rentals.pair_payload` was written at rent time and
  **never cleared**.

Presented the plan (durable validated key provider + fail-closed prod config ·
hardened Vault adapter + documented custody model · pair-payload cleanup + revoke
retry · tests on a disposable DB) before editing.

**Step 2 — Validated key provider (`crypto/hsm-rsa.ts`, rewritten).** Payload is
now **v2**: `{ v, algorithm, keyBits, keyFingerprint, cipherTextB64, encryptedAt }`.
`algorithm` is the cipher actually used (`RSA-OAEP-SHA256`); `keyBits` is the
actual modulus; `keyFingerprint` is `SHA-256(SPKI DER)` (32 hex chars) — a real,
stable key id. `validateCredentialKey` parses the PEM pair, refuses a non-RSA key,
a modulus off the allowlist (`2048/3072/4096`), or one below the minimum (default
**3072**; generated keys **4096**), and verifies the private key matches the
public one. `SoftwareHsm` now **requires** material — there is no implicit
generation — and `generateEphemeralHsm()` is the explicitly-named test-only
ephemeral provider. `RotatingCredentialHsm` holds the active key for encryption
plus decrypt-only retired keys; `decrypt` re-checks version, algorithm, key size,
and key id and fails closed on an unknown key, a size/key mismatch, or a tampered
ciphertext.

  - *Rejected:* keeping `RSA-OAEP-4096` as a label (it conflates cipher and size);
    letting `SoftwareHsm()` keep minting a key by default (that is the H5 bug);
    a timestamp-derived id (not a fingerprint).

**Step 3 — Durable key storage + fail-closed config
(`crypto/credential-key-store.ts`, `config.ts`).** `createCredentialHsm` builds
the provider from `DFAP_CREDENTIAL_KEY_FILE` (a PKCS#8 PEM, created `0600` inside a
`0700` directory, race-safe via `wx`) or `DFAP_CREDENTIAL_KEY_PEM` (base64), plus
decrypt-only retired keys (`DFAP_CREDENTIAL_KEY_RETIRED_PEMS`). It **throws** when
no durable source is available; the only fallback is an explicit dev default file
(`services/api/.dfap/credential-key.pem`, gitignored) and only when not
production. `loadConfig` now validates the pair master (base64, ≥32 bytes) and, in
production, **refuses to boot** unless all three durable providers are configured:
a credential key, `DFAP_PAIR_MASTER_KEY`, and `VAULT_ADDR`/`VAULT_TOKEN`. `server.ts`
wires `createCredentialHsm` and derives the pair seed from `cfg` (throwing on a
production config with no seed).

  - *Rejected:* defaulting to an ephemeral key outside production (the task asks
    for a durable non-production path); defaulting the dev key under `cwd` for all
    hand-built configs (the factory takes the dev-file path explicitly).

**Step 4 — Pair-payload lifecycle + revoke retry
(`marketplace/*`, `sessions/end-session.ts`, `util/retry.ts`).** `pair_payload` is
rental-scoped and is now cleared **inside** `closeRental` and `completeForSession`
(idempotent), with a durable backstop — `clearStalePairPayloads(olderThan)` — run
by the rental reaper for any ended rental whose payload was not cleared inline
(`clearedPairPayloads` is reported on the reap result, and a sweep failure is
isolated so it retries next pass). `endSession` now revokes the session credential
through a bounded `withRetries` (3 attempts) instead of a single best-effort call;
the single-use wrap token and the secret's TTL remain the backstop. No claim is
made that clearing a string or a field to `null` is physical memory erasure.

  - *Rejected:* a separate cleanup job/queue for the payload (the reaper already
    runs and a `closeRental`-inline clear covers the normal path); treating the
    revoke retry as a durable obligation (the wrap token + TTL already bound it).

**Step 5 — Hardened Vault adapter (`vault/vault-client.ts`).** `HttpVaultClient`
went from a stub to a real **KV v2 + response-wrapping** adapter: the API's own
token for writes/revokes (never a client-supplied token), the single-use wrap
token only for `sys/wrapping/unwrap`, `X-Vault-Wrap-TTL` on the KV write so the
secret never returns at write time, bounded request timeouts (AbortController),
optional `X-Vault-Namespace`, 400/403/404 mapped to `WrapTokenConsumedError`, and
status-only errors that never carry a secret or a token. Documented that Vault is
already authoritative for **session** credentials (the DB holds only
`sessions.vault_cred_path`) while **owner** credentials remain in Postgres under
the Layer-2 key, with a planned add/dual-write/backfill/cutover/later-drop
migration and rollback (not executed).

  - *Rejected:* executing the owner-credential→Vault migration now (it cannot be
    validated without a real Vault, and a botched migration could strand
    credentials); swallowing revoke errors silently (the caller now retries).

**Step 6 — Tests.** New: `test/credential-keys.test.ts` (20 — restart persistence
across provider instances, key-file `0600`, env-PEM, wrong-key, tampering,
algorithm mismatch, key-size mismatch, disallowed/short modulus, key-id stability,
no private material exposed, rotation with retired keys, duplicate id, explicit
ephemeral distinctness); `test/vault-client.test.ts` (11) + `test/support/
mock-vault.ts` (a local mock Vault: single-use unwrap, TTL expiry, auth rejection,
5xx, timeout, namespace, revoke, token-per-request assertions);
`test/credential-lifecycle.test.ts` (9 — pair-payload clearing, idempotent sweep,
reaper isolation, `withRetries`). Extended `test/config.test.ts` (18 → 25) with
the production guards, `test/end-session.test.ts` (+2 — revoke retried, teardown
unaffected), `test/prisma-license-store.test.ts` (8 → 11 — `Prisma.DbNull` clear
shape + sweep fallback/non-connection error), and `test/prisma-persistence.pg.test.ts`
(5 → 7 — pair payload persisted as JSONB and cleared to SQL NULL; a null-filter
sweep). Updated the fixtures/helpers in `app`, `orchestrator`, and
`rent-integration` tests for the v2 payload and the required key material.

**Step 7 — Disposable-DB validation.** Fresh local PostgreSQL (port 55435):
`prisma migrate deploy` applied both migrations; `DFAP_TEST_DATABASE_URL=… vitest
run test/prisma-persistence.pg.test.ts` → **7 passed**; `psql \d license_rentals`
confirmed `pair_payload jsonb` nullable. Cluster stopped and removed. **No schema
change this milestone** (the column already existed), and **no real DB migrated.**

**Step 8 — Docs/config.** New `docs/runbooks/key-management.md` (custody model, key
ids, rotation, backup/recovery, the owner-credential migration + rollback, and an
explicit "not claimed" list); updated `docs/security.md` (new Guarantee 7 +
limitations), `docs/spec-implementation-decisions.md` (§13), `services/api/README.md`
(key provider, Vault row, production guards), `deploy/.env.example` +
`.env.dev.example` (credential-key env), and `.gitignore` (`.dfap/`).

**Step 9 — Verification + rev bump.** `npm run typecheck` clean (api/broker/web);
`npm test` **418 passed, 7 skipped** (api **282** · broker 95 · web 41); API build
green (`prisma generate && tsc`); web build green (`vite build`). Recorded as rev
**r7** in the header + ledger. Nothing committed; no AWS; no real Vault; no HSM.

---

### 4.9 — M8: guest credential provisioning (audit C3) (rev r8)

**Goal.** Implement the Linux guest credential path and resolve the **C3**
finding (the guest could not obtain or materialize the session credential), while
resolving the long-open **SSM-vs-sealed-blob** conflict (D5).

**Inspection first (read-only).** Documented the current end-to-end path: owner
credentials (Postgres, software-sealed) → orchestrator decrypt → `createSession`
→ `PoolManager.claim` → `OfflineImageInjector` seals an AES-GCM blob into
`userData` (under one dev-derived image wrap key) → `RunInstances`; plus Vault
staging for the broker handshake. Found: no guest consumer of the blob; a
decryption key that would have to live in a reusable AMI (a shared secret);
`install-workspace.sh`'s "SSM at claim time" comment with zero backing code; and
`chattr +i /etc/{passwd,shadow,group,gshadow}` making first-boot account creation
impossible. Seeded license identities (`matlab_user`, `developer`, …) do not
exist as guest accounts.

**Step 1 — Architecture decision (in the log, `docs/security.md` Guarantee 8,
`docs/spec-implementation-decisions.md` §3 + §14).** Retire the sealed-blob
`userData` path from production; adopt an **authenticated per-instance pull**
whose trust root is AWS's RSA-signed EC2 **instance identity document** (IMDSv2),
with authorization enforced **server-side** by joining the verified instance id
to the pool→session records. Delivery is a one-time, TTL-bounded, idempotent
HTTPS pull; the credential is read back from the **same Vault path** the broker
uses.

**Step 2 — Trust + authorization core.** `src/guest/instance-identity.ts`
(verified identity, RSA-SHA256 verifier over the exact signed bytes, injected
per-region cert provider, disabled fail-closed verifier + `aws-cert-provider.ts`);
`src/guest/binding-resolver.ts` (server-side join, no schema change);
`src/guest/provisioning-package.ts` (versioned contract + strict validator shared
with the guest shell); `src/guest/guest-provisioning.ts` (pure
`evaluateProvisioningRequest` + `GuestProvisioningService` + in-memory registry).

**Step 3 — Delivery.** `VaultClient.read()` added (Fake + Http + mock-Vault GET),
`VaultGuestCredentialSource`, `PrismaGuestBindingStore`; `POST
/internal/guest/provision` in `app.ts`; wiring in `server.ts` (production
composes `NoPreBootInjector` — nothing in `userData`). `endSession` revokes
provisioning authority (bounded retry). `config.ts` adds
`DFAP_GUEST_PROVISIONING` (default `disabled`) + cert material + **production
refusal**.

**Step 4 — Guest assets.** `provision/guest/dfap-provision.sh` +
`dfap-deprovision.sh`, `systemd/dfap-provision.service`, `systemd/xrdp-gate.conf`
(xrdp/xrdp-sesman `Requires=dfap-provision.service` ⇒ fail-closed listener);
`install-workspace.sh` (installs them, `/etc/skel/.xsession`, generalized home,
`tsusers`, fixes the SSM comment); `harden.sh` (auditd watches); **reconciled**
`offline-harden/harden-offline.sh` (account DBs no longer `chattr +i`, documented
trade-off; everything else unchanged); `linux-workspace.pkr.hcl` stages
`provision/guest/`.

**Step 5 — Tests.** New `instance-identity.test.ts` (12), `guest-provisioning.test.ts`
(27), `guest-provision-script.test.ts` (3 — `bash -n` + the script's
`--self-test` fixtures); extended `vault-client.test.ts` (+3, server-side read
does not consume the wrap token), `config.test.ts` (+5, guards), and 5 HTTP-level
route tests in `app.test.ts`. All local fixtures (generated keys, fakes).

**Step 6 — Docs/config.** `docs/runbooks/guest-provisioning.md` (new),
`docs/security.md` (Guarantee 8 + limitations), `docs/spec-implementation-decisions.md`
(§3 update + §14), `.env.dev.example`.

**Step 7 — Verification + rev bump.** `npm run typecheck` clean (api/broker/web);
`npm test` **473 passed, 7 skipped** (api **337** · broker 95 · web 41); API build
green (`prisma generate && tsc`); web build green (`vite build`). **No schema
change** this milestone. Recorded as rev **r8**. Nothing committed; no AWS; no
real Vault; production guest provisioning deliberately **off**.

---

## 5. Consolidated decision register (with reasoning)

Each item: the decision, why, and what I rejected.

- **D-01 — Scope is "dev-complete"; real externals stay behind seams.** The
  repo already had Layers 3–6; AWS/HSM/Vault/Stripe are implementation details
  behind existing interfaces, so building them now would be a rewrite of
  adapters, not the spec. *Rejected:* wiring real AWS to prove pixels.
- **D-02 — Keep the `MarketplaceStore` port; put persistence behind it.** The
  orchestrator/routes/tests already depend on the port; persistence is an
  implementation detail, so swapping it in changed no callers.
- **D-03 — Dev degradation only on DB-unreachable / missing-migration
  (`P2021`/`P2022`/init errors).** A unique-violation (a real double-rent) must
  propagate. *Rejected:* catching all Prisma errors, which would hide real bugs.
- **D-04 — `license.templateId` is a plain string, not an FK.** A license must be
  listable even when its template row doesn't exist locally. (Trade-off: no
  referential integrity; documented.)
- **D-05 — Per owner-rentee key = `HKDF-SHA256(master, salt=ownerId,
  info=renteeId)` → AES-256-GCM, with owner/rentee ids bound into the AAD and
  sorted (order-insensitive).** The spec says the key is "built by utilizing both
  of their ids"; derivation gives exactly that with no key table to secure/rotate,
  and it's deterministic so no lookup is needed. *Rejected:* a stored per-pair key.
- **D-06 — Pre-boot injection = a sealed `userData` blob bound to
  `(sessionId, imageId)`, not a 90–150 s offline disk mutation.** Functionally
  equivalent "credential exists before login is exposed", far cheaper; the port is
  the seam for a real mutator later. Warm pool = cold-path only. *Rejected:*
  EBS-attach/edit/re-snapshot in Phase 0.
- **D-07 — Meter AFTER the session id exists; rental persisted before metering.**
  The idempotency key needs the session id, and a metering failure must not fail
  an otherwise-ready session. M2 hardened this to `recordRental → meter →
  attachMeterEvent`. *Rejected:* metering first (phantom charges).
- **D-08 — Two threads start concurrently, but thread 1 joins thread 2 for the
  credential.** The spec's pre-boot ordering requires the credential before
  `RunInstances`; RSA decrypt is sub-ms, so faking more parallelism would be
  dishonest. Both durations + total are exposed so the claim is verifiable.
- **D-09 — Dev fallback master seed derived from the signing `kid`**, so derived
  keys survive a dev restart; explicitly **not a secret**. Production must set
  `DFAP_PAIR_MASTER_KEY`.
- **D-10 — Web: add a duration selector to `LaunchPage`; do not rebuild the
  marketplace UI.** It already existed.
- **D-11 — `DFAP_DEV_FALLBACK` parsed by `bool()`; default false; production guard
  fails fast.** Options limited to explicit truthy/falsey tokens so a typo can't
  silently enable fabrication.
- **D-12 — Replace the `NODE_ENV` re-rent bypass with `devAllowRerent` (default
  false).** The old check failed *open* in staging/test (H3). Busy ⇒ 409 unless an
  operator opts in.
- **D-13 — H1: terminal session states still best-effort release the rental.**
  `endSession` on an already-terminal session attempts `completeForSession`
  (errors swallowed) so a license doesn't stay stuck. Paired with M2's reaper for
  the crash-window case.
- **D-14 — Local launcher sets `DFAP_DEV_FALLBACK=true`**; documented `true` in
  `.env.dev.example`, `false` in `deploy/.env.example`. `deploy/docker-compose.yml`
  sets `NODE_ENV=production`, so enabling the flag there fails fast at boot.
- **D-15 — Atomic claim = one guarded conditional write, count===1.** Postgres
  serializes the row update, so exactly one concurrent caller wins; the in-memory
  store mirrors it. *Rejected:* read-then-write (`markRented`), which is a
  double-rent race (H2).
- **D-16 — Conditional `releaseClaim(id, renteeId)`.** Compensation must never
  free a license now held by someone else, or a failed rent of tenant A could
  release tenant B's live claim.
- **D-17 — Explicit ordering + single compensation point.** See §4.3(2).
  *Rejected:* compensating sales after the fact — a session that never became
  valid must have no rental and no meter.
- **D-18 — `createSession` owns post-launch VM cleanup (optional `cloud`/
  `instances`), with the reaper as backstop and `vmCleanedUp` as the observable.**
  *Rejected:* silently assuming the VM is gone.
- **D-19 — C2 via a server-minted `templateGrant` validated by
  `isLicensedTo(licenseId, renteeId, templateId)`.** Keeps the org check; the only
  new path is the exact licensed template for the exact rentee it's rented to.
  *Rejected:* removing the org check, or trusting a client-supplied grant.
- **D-20 — Rental reaper over existing columns; no migration.** Closes an expired
  lease only when its session is terminal/gone; releases abandoned claims past a
  grace window. *Rejected:* closing on timestamp alone (would steal a live
  session's license) and adding a schema column (unnecessary).
- **D-21 — `markRented` retained only as a force/admin/dev helper.** The
  production path uses `claimAvailable`; the flag-gated re-rent forces a release
  then a normal claim.
- **D-22 — Durable `session.license_id` link (nullable) + baseline migration.**
  Recovery must be able to prove a claimed license *has a live session*; the
  session row is the only durable artifact created before the rental. Stamped in
  the same insert that creates the session. *Rejected:* holding the session id
  only in orchestrator memory (lost on crash) or trusting the open-rental
  invariant (exactly what the persist failure breaks).
- **D-23 — Compensation releases the claim ONLY on a confirmed-terminal session.**
  `terminateSession` is attempted first; the conditional `releaseClaim` runs only
  if the state is `ended`/`failed`. *Rejected:* releasing on the assumption the
  terminate "probably" worked — that could free a license for a still-running VM.
- **D-24 — Fail-closed when teardown cannot be confirmed.** If `terminateSession`
  is absent, throws, or returns a non-terminal state, the license stays `rented`;
  the durable link keeps it ineligible for stale-claim release until the session
  is terminal/absent. *Rejected:* best-effort release to "unstick" the license —
  that is the vulnerability we are closing.
- **D-25 — Reaper treats a session-lookup error as "may be live".**
  `hasActiveSessionForLicense` failing (or a bad plan input) holds the claim and
  records the error, rather than releasing. Safety over availability.
- **D-26 — Meter failure stays non-fatal and never terminates a valid session.**
  Only `recordRental` failure triggers teardown; a meter failure preserves the
  session and the null-`meter_event_id` retry obligation. *Rejected:* treating any
  post-session failure uniformly (would kill a working session over a billing
  blip).
- **D-27 — The reaper, not `endSession`, releases the no-rental case.** We did
  *not* add a release-by-`license_id` to `endSession`: a conditional
  `releaseClaim(licenseId, renteeId)` cannot tell two sessions of the same
  rentee+license apart, so a terminal `S1` could free a live `S2`'s claim. The
  reaper's "no non-terminal session for this license" rule is the safe
  discriminator. *Rejected:* releasing directly on teardown (correct only in the
  single-session case).
- **D-28 — Inbound auth fails closed by default; no improvised IdP.** `DFAP_AUTH_MODE`
  defaults to `deny` (`FailClosedAuthenticator` rejects every request); with no
  OIDC/JWT verifier wired, a production deployment serves nothing. *Rejected:*
  keeping a permissive stub, or hand-rolling a user token from the broker's HMAC
  machinery (the connect token is a session capability, not an identity).
- **D-29 — Dev header identity is explicit opt-in and refused in production.**
  `DFAP_AUTH_MODE=dev-header` reads `x-dfap-user`/`x-dfap-org`; `loadConfig` throws
  when it is set with `DFAP_ENV`/`NODE_ENV=production`. *Rejected:* selecting it
  based on `NODE_ENV !== 'production'` (fails open in staging).
- **D-30 — Privilege is server-side data, never a header.** The principal role is
  resolved from `org_members` (`MembershipRepo`/`PrismaMembershipRepo`);
  `x-dfap-role` is never read, in any mode. Dev fallback with no DB →
  least-privilege `member`. *Rejected:* trusting the role header "only in dev"
  (exactly the C4 finding).
- **D-31 — Release is owner-only.** Object-level authz is
  `license.ownerId === principal.userId`; the cross-tenant "any admin/owner" branch
  is removed because a license carries no org to scope an admin to. *Rejected:*
  guessing the license's org from `templateId` (non-FK, may be absent).
- **D-32 — `GET /marketplace/licenses` is authenticated.** ownerName/availability
  are tenant-identifying; credentials are never returned. *Rejected:* leaving the
  catalog public.
- **D-33 — CORS is an exact allowlist; never reflect `Origin`; never `*` with
  credentials.** `DFAP_CORS_ALLOWED_ORIGINS` is a bare-origin, comma-separated
  list; wildcards are rejected at config load; empty = deny. *Rejected:*
  per-environment reflection.
- **D-34 — Validate the M3 migration on a disposable cluster, not a real DB.**
  `prisma migrate deploy` on a throwaway local PostgreSQL proved
  `sessions.license_id` + `hasActiveForLicense`; an env-gated test makes it
  repeatable; the cluster was destroyed. *Rejected:* applying it to the
  developer's or any existing database.
- **D-35 — Verify JWT access tokens with the maintained `jose` library, never by
  hand.** `JoseAccessTokenVerifier` uses `jwtVerify` + `createRemoteJWKSet`
  (caching + rotation). *Rejected:* rolling JOSE on Node `crypto` (error-prone,
  forbidden) and `openid-client` (a client library, not a verifier).
- **D-36 — Keys come only from server config; a request can never supply a JWKS
  URL or key.** Explicit `DFAP_OIDC_JWKS_URL` or discovery at the configured
  issuer, with the discovered `issuer` pinned to the configured one. *Rejected:*
  honoring `jku`/`x5u`/a client-supplied JWKS (attacker-controlled trust).
- **D-37 — Exact issuer + exact audience + required `sub`, with an explicit
  algorithm allowlist (`none` always rejected).** Audience is the API's resource
  id, never the SPA client id; ID tokens are additionally rejected via a
  configurable `token_use` claim and/or required `typ` (`at+jwt`). *Rejected:*
  audience-optional verification and "any alg but none".
- **D-38 — Map external identities `(issuer, subject) → user_id`; never equate
  `sub` with an internal id; never use email as a key; no JIT provisioning.**
  New `external_identities` table; unmapped ⇒ 403. *Rejected:* trusting `email`,
  keying on `sub` alone (not globally unique), or auto-creating users from tokens.
- **D-39 — Organization and role are always server-side; an org claim is only a
  selector.** `MembershipRepo.resolveMembership(userId, orgHint?)` returns
  `{orgId, role}` from `org_members`; the claim is validated against real
  memberships and never grants one; ambiguous/membership-less callers reject.
  *Rejected:* trusting an org/role claim.
- **D-40 — Keep the fail-closed default; `oidc` requires explicit, validated
  provider config.** `authMode ∈ {deny, dev-header, oidc}`; `oidc` without
  issuer/audience fails boot; `dev-header` stays refused in production; if `oidc`
  is ever selected without config the composition falls closed. *Rejected:*
  auto-enabling a provider from presence-of-env or `NODE_ENV`.
- **D-41 — Frontend sends a bearer token via an injectable `getAccessToken`, but
  no login flow is built.** The client can carry a real access token and never
  sends a role header; the authorization-code+PKCE acquisition/refresh is left
  unimplemented and documented as such. *Rejected:* inventing a provider or
  shipping a half-built login that would imply working production auth.
- **D-42 — Author the `external_identities` migration offline and validate on a
  disposable cluster.** `prisma migrate diff --from-url <baseline> --to-schema-
  datamodel`; applied + tested on a throwaway PostgreSQL, then destroyed.
  *Rejected:* `migrate dev` against the developer's or any real database.
- **D-43 — Use `oidc-client-ts` for the browser Authorization Code + PKCE flow;
  no hand-rolled redirect/PKCE code.** A public client with **no client secret**,
  S256 PKCE, and a fresh `nonce` per request. *Rejected:* writing the flow by hand
  or using `oauth4webapi` (more code, more room for error) — the maintained
  browser client gets state/nonce/PKCE right.
- **D-44 — Keep tokens in memory, never `localStorage`/persisted storage.** An
  in-memory `UserManager` store; only the in-flight state/nonce/PKCE verifier is
  in `sessionStorage` for the redirect round-trip. Trade-off documented: a full
  reload drops the session (re-login). *Rejected:* persisting bearer tokens to
  survive reloads.
- **D-45 — The browser transports tokens; only the API verifies them.** The
  frontend never decodes a JWT to make an authz decision, attaches only the
  API-audience access token as `Authorization: Bearer`, and returns `null` (and
  clears state) on expiry/renewal failure so it never looks authenticated while
  unauthenticated. *Rejected:* trusting a client-readable JWT.
- **D-46 — Provision identities with a DB-direct operator CLI; no JIT, no public
  endpoint.** `provision:identity` validates the user exists, is idempotent,
  refuses accidental reassignment without an explicit `--reassign`, keys on the
  exact `(issuer, subject)` (never email), and prints no secrets. *Rejected:*
  auto-provisioning from a token, and an admin HTTP endpoint (a new privilege
  surface) before one is needed.
- **D-47 — Test the auth boundary with a real local issuer + the real API, not
  mocks at the seam.** `oidc-e2e.test.ts` runs a real discovery/JWKS/PKCE/`token`
  provider and the real verifier+app; the web tests drive the real library's
  authorize-request builder and in-memory store. *Rejected:* mocking the verifier
  (proves nothing about the boundary).
- **D-48 — Fail loud on a malformed/partial frontend OIDC config.** `oidcSettingsFromEnv`
  throws rather than silently disabling login (which would leave a misleading
  unauthenticated UI); when OIDC is unset the app runs without login (local dev
  only) and the API still fails closed on its own. *Rejected:* treating a broken
  issuer as "auth off".
- **D-49 — Credential ciphertext carries honest metadata: cipher, actual modulus,
  and a real key id.** Payload v2 records `algorithm` (the cipher actually used,
  `RSA-OAEP-SHA256`), `keyBits` (the actual modulus), and `keyFingerprint`
  (`SHA-256(SPKI DER)`), and `decrypt` re-validates all three (plus the payload
  version) against the loaded key. *Rejected:* a `'RSA-OAEP-4096'` label that
  conflates cipher and key size, a timestamp "fingerprint", and trusting the
  label instead of validating the key.
- **D-50 — A durable key provider is mandatory in production; no implicit
  ephemeral key.** `createCredentialHsm` requires `DFAP_CREDENTIAL_KEY_FILE` or
  `DFAP_CREDENTIAL_KEY_PEM` (rotatable via `DFAP_CREDENTIAL_KEY_RETIRED_PEMS`);
  production boot is refused without a credential key, `DFAP_PAIR_MASTER_KEY`, and
  `VAULT_ADDR`/`VAULT_TOKEN`. Outside production the only fallback is an explicit
  durable dev key file. *Rejected:* keeping `new SoftwareHsm()` minting a per-boot
  keypair (H5), and silently using a non-secret pair seed or the in-memory
  `FakeVaultClient` in production.
- **D-51 — Validate key size and algorithm at load and at decrypt; fail closed.**
  The provider refuses a non-RSA key, a modulus off the allowlist
  (`2048/3072/4096`), or one below the configured minimum (default `3072`;
  generated keys `4096`), and `decrypt` rejects an unknown key id, an unexpected
  algorithm, or a payload/key modulus mismatch. *Rejected:* accepting any key and
  labeling it 4096 (the audit finding M5), and best-effort decryption.
- **D-52 — Owner credentials stay in Postgres for now; the Vault migration is
  planned, not executed.** Vault is already authoritative for *session*
  credentials (the DB holds only `sessions.vault_cred_path`); owner credentials
  remain DB-side ciphertext under the Layer-2 key, with `key_fingerprint` as the
  pointer to the sealing key. The move to Vault-authoritative custody is
  documented with an add/dual-write/backfill/cutover/later-drop sequence and a
  rollback. *Rejected:* executing the migration now — it cannot be validated
  without a real Vault, and a botched migration could strand secret material.
- **D-53 — Rebuild `HttpVaultClient` into a real adapter, and be explicit that it
  is mock-tested.** API-token-authenticated writes/revokes, wrap-token-only
  unwrap, wrap-TTL on the KV write, request timeouts, optional namespace, and
  status-only errors that never log a secret or token; tested against a local mock
  Vault server. *Rejected:* leaving the stub (a fake presented as real Vault) and
  claiming real-Vault validation from a mock.
- **D-54 — `pair_payload` is rental-scoped and is cleared on rental end.**
  Cleared inside `closeRental`/`completeForSession` (idempotent) with a durable
  reaper sweep (`clearStalePairPayloads`) as a backstop for a clear that did not
  land inline. *Rejected:* leaving it indefinitely (H4) and relying on "nothing
  reads it" as the safety argument.
- **D-55 — Credential revocation is retried (bounded); custody is not claimed to
  be hardware-backed.** `endSession` retries revoke 3× and never blocks teardown;
  the single-use wrap token and the secret TTL are the backstop. `null`-ing a
  value is not claimed to be physical memory erasure, and the software provider is
  not described as an HSM. *Rejected:* a single best-effort revoke, and
  hardware-backed language for a software key.

---

## 6. Architecture map (overall structure)

npm-workspaces monorepo, Node ≥ 22, Vitest, `tsconfig.base.json` with `strict`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`.

- `services/api` (`@disfap/api`) — control plane: composition root (`server.ts`),
  HTTP (`app.ts`), session lifecycle (`sessions/`), pool + fleet reaper (`pool/`),
  marketplace (`marketplace/`), crypto/HSM (`crypto/`), cloud/Vault/Stripe
  adapters + ports, Prisma repos (`db/`).
- `services/broker` (`@disfap/broker`) — session token mint/verify, nonce store,
  guacd tunnel, protocol adapters.
- `apps/web` (`@disfap/web`) — marketplace/launch UI.
- `infra/packer`, `infra/terraform/phase0`, `infra/terraform/modules/session-fleet`
  — golden image + AWS infra (**guest-side path unimplemented**).
- `deploy/`, `scripts/` — local launcher and deploy env.

The seams that keep dev/tests free of AWS/DB: `CloudProvider` (`FakeCloudProvider`
/ `AwsCloudProvider` stub), `VaultClient` (`FakeVaultClient`/`HttpVaultClient`),
`HsmService` (`SoftwareHsm` / `RotatingCredentialHsm` over a durable key; the
test-only `generateEphemeralHsm`), `MarketplaceStore` (`InMemoryMarketplaceStore` /
`PrismaMarketplaceStore` with a gated fallback), `StripeClient`
(`FakeStripeClient`/`RealStripeClient`), plus the `SessionRepo`/`TemplateRepo`/
`InstanceRepo`/`QuotaStore`/`EventRecorder`/`AuditRecorder` ports.

Layers (architecture.md): 1 marketplace · 2 credential/HSM · 3 two-thread
orchestrator · 4 teardown/reaper (fleet) · 5 pixel tunnel/broker · 6 client.

---

## 7. Verification ledger (real commands, real results)

| Milestone | Command | Result |
|---|---|---|
| r0 | `npm run typecheck` | clean |
| r0 | `npm test` | **196 passed** (api 84 · broker 95 · web 17) |
| r0 | live HTTP smoke (fake cloud, no DB) | catalog → rent 2 h (`totalChargedUsd: 9`, telemetry, `rentalId`) → license removed → owner release 200 / non-owner 403 → license restored |
| r1 | `npm run typecheck` | clean |
| r1 | `npm test` | **214 passed** (api 102 · broker 95 · web 17) |
| r1 | `npm run build --workspace=@disfap/api` | succeeded (`prisma generate` + `tsc`) |
| r2 | `npm run typecheck` | clean (api, broker, web) |
| r2 | `npm test` | **252 passed** (api **140** · broker 95 · web 17) |
| r2 | `npm run build --workspace=@disfap/api` | succeeded (`prisma generate` + `tsc`) |
| r3 | `npm run typecheck` | clean (api, broker, web) |
| r3 | `npm test` | **265 passed** (api **153** · broker 95 · web 17) |
| r3 | `npm run build --workspace=@disfap/api` | succeeded (`prisma generate` + `tsc`) |
| r3 | `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script` | generated the baseline `prisma/migrations/20261016000000_init/migration.sql` (391 lines; includes `sessions.license_id` + `sessions_license_id_state_idx`) |
| r4 | `npm run typecheck` | clean (api, broker, web) |
| r4 | `npm test` | **287 passed, 3 skipped** (api **175** · broker 95 · web 17) |
| r4 | `npm run build --workspace=@disfap/api` | succeeded (`prisma generate` + `tsc`) |
| r4 | `npx prisma migrate deploy` (throwaway local PostgreSQL 55432) | `20261016000000_init` applied successfully to a fresh DB |
| r4 | `DFAP_TEST_DATABASE_URL=… npx vitest run test/prisma-persistence.pg.test.ts` | **3 passed** (`license_id` persisted + read back; `hasActiveForLicense` true while non-terminal, false once terminal; NULL license never matches) |
| r4 | `psql … \d sessions` + `pg_indexes` | confirmed `license_id text` + `btree (license_id, state)` |
| r5 | `npm install jose@^6.2.12 --workspace=@disfap/api` | added `jose` (1 package; zero deps) |
| r5 | `npm run typecheck` | clean (api, broker, web) |
| r5 | `npm test` | **328 passed, 4 skipped** (api **212** · broker 95 · web 21) |
| r5 | `npm run build --workspace=@disfap/api` | succeeded (`prisma generate` + `tsc`), exit 0 |
| r5 | `npx prisma migrate deploy` (throwaway local PostgreSQL 55433) | `20261016000000_init` + `20261016010000_external_identities` applied to a fresh DB and to the baseline DB |
| r5 | `DFAP_TEST_DATABASE_URL=… npx vitest run test/prisma-persistence.pg.test.ts` | **4 passed** (`license_id` persisted; `hasActiveForLicense`; NULL never matches; `(issuer,subject)` resolves + unique constraint enforced) |
| r5 | `psql … \d external_identities` | confirmed `UNIQUE btree (issuer, subject)`, `btree (user_id)`, FK → `users(id) ON DELETE CASCADE` |
| r6 | `npm install oidc-client-ts@^3.5.0 --workspace=@disfap/web` | added `oidc-client-ts` (browser OIDC client) |
| r6 | `npm run typecheck` | clean (api, broker, web) |
| r6 | `npm test` | **366 passed, 5 skipped** (api **230** · broker 95 · web **41**) |
| r6 | `npm run build --workspace=@disfap/api` | succeeded (`prisma generate` + `tsc`), exit 0 |
| r6 | `npx prisma migrate deploy` (throwaway local PostgreSQL 55434) | `20261016000000_init` + `20261016010000_external_identities` applied to a fresh DB |
| r6 | `DFAP_TEST_DATABASE_URL=… npx vitest run test/prisma-persistence.pg.test.ts` | **5 passed** (adds idempotent provisioning + refuse-reassign + nonexistent-user) |
| r6 | `node dist/cli/provision-identity.js …` ×5 on the disposable DB | `created` / `unchanged` / refuse-reassign (exit 1) / `reassigned` (with `--reassign`) / `no such DisFAP user` (exit 1); `psql` confirmed the final row |
| r7 | `npm run typecheck` | clean (api, broker, web) |
| r7 | `npm test` | **418 passed, 7 skipped** (api **282** · broker 95 · web 41) |
| r7 | `npm run build --workspace=@disfap/api` | succeeded (`prisma generate` + `tsc`), exit 0 |
| r7 | `npm run build --workspace=@disfap/web` | succeeded (`vite build`), exit 0 |
| r7 | `npx prisma migrate deploy` (throwaway local PostgreSQL 55435) | `20261016000000_init` + `20261016010000_external_identities` applied to a fresh DB |
| r7 | `DFAP_TEST_DATABASE_URL=… npx vitest run test/prisma-persistence.pg.test.ts` | **7 passed** (adds: pair payload persisted as JSONB + cleared to SQL NULL; null-filter sweep idempotent) |
| r7 | `psql … \d license_rentals` | confirmed `pair_payload jsonb` **nullable** (no schema change needed) |
| r8 | `npm run typecheck` | clean (api, broker, web) |
| r8 | `npm test` | **473 passed, 7 skipped** (api **337** · broker 95 · web 41) |
| r8 | `npm run build --workspace=@disfap/api` | succeeded (`prisma generate` + `tsc`), exit 0 |
| r8 | `npm run build --workspace=@disfap/web` | succeeded (`vite build`), exit 0 |
| r8 | `npx vitest run test/guest-provision-script.test.ts` | **3 passed** (`bash -n` on both guest scripts; the provision script's `--self-test` fixture suite; fail-closed when disabled) |
| r8 | (no schema change; no DB, no AWS, no real Vault) | — |

r2 new/expanded test files: `marketplace-store.test.ts` (10),
`rental-reaper.test.ts` (10), `rent-integration.test.ts` (6, exercises the **real**
`createSession` with a fake pool/cloud), and extended `prisma-license-store.test.ts`
(+4), `orchestrator.test.ts` (+5), `create-session.test.ts` (+3).

r3 new/expanded test coverage (api 140 → 153): `rental-reaper.test.ts` (10 → 14:
active-session hold, release-once-terminal, fail-safe on lookup error, pure
plan gate), `rent-integration.test.ts` (6 → 9: rental-persist failure →
terminate+release, held claim + real reaper until terminal, meter-failure
non-termination), `orchestrator.test.ts` (11 → 16: compensation ordering,
held-claim variants, meter isolation, concurrent single-winner),
`create-session.test.ts` (7 → 8: `license_id` persisted).

> Note: the r2 entry "no migration required" was correct for its own scope (the
> M2 reaper reused existing columns). r3 supersedes it for the recovery link and
> adds the baseline migration; nothing in r2 is reverted.

r4 new/expanded coverage (api 153 → 175, +1 skipped file): `auth.test.ts` (5:
fail-closed rejects all; dev-header resolves identity + server role; forged
`x-dfap-role` ignored; missing identity rejected; no-membership rejected);
`config.test.ts` (4 → 12: auth-mode default/valid/refused-in-production, CORS
default/parse/wildcard-reject/malformed-reject); `app.test.ts` (5 → 12:
unauthenticated catalog 401, forged role confers nothing, cross-tenant session
403, cross-owner release 403 even as admin, owner release 200, approved +
unapproved + absent CORS); `server.test.ts` (8 → 10: authenticator composition);
`prisma-persistence.pg.test.ts` (new, env-gated; skips without a DB).

r5 new/expanded coverage (api 175 → 212, web 17 → 21): `oidc-jwt.test.ts` (18,
real `jose` against an in-process JWKS server: valid, bad signature, expired,
nbf-in-future, wrong issuer, wrong audience, disallowed algorithm, unknown signing
key, missing subject, ID-token rejection, required token-use claim, required `typ`
header, key rotation, OIDC discovery, mismatched discovery issuer, dead JWKS,
JWKS-endpoint failure with no fallback, malformed); `oidc-authenticator.test.ts`
(12: bearer extraction, identity mapping, unmapped identity, no membership,
ambiguous multi-org, org-claim selector, membership-mismatch, malformed claim,
role-claim escalation ignored, `x-dfap-*` headers ignored); `config.test.ts`
(12 → 18: oidc required/valid, URL guards, `none` rejected, JWKS/org/typ parsing,
oidc undefined when unset); `server.test.ts` (10 → 11: OIDC composition);
`apps/web/test/api-client.test.ts` (new, 4: bearer sent/awaited/omitted, no role
header); `prisma-persistence.pg.test.ts` (3 → 4: external-identity mapping).

r6 new/expanded coverage (api 212 → 230, web 21 → 41): `oidc-e2e.test.ts` (new, 8:
real local OIDC provider → real API — valid PKCE token reaches a resource (200),
no token → 401, unmapped subject → 403, tampered signature → 401, `x-dfap-*`
cannot override identity, cross-tenant read → 403, wrong PKCE verifier refused,
mismatched issuer not trusted); `identity-provisioning.test.ts` (new, 10: create,
email informational, idempotent, nonexistent user, refuse reassign, reassign with
opt-in, invalid issuer, empty identifiers, exact-match issuer/subject);
`test/support/oidc-test-provider.ts` (new support: discovery/JWKS/authorize+PKCE/
token); `prisma-persistence.pg.test.ts` (4 → 5); `apps/web/test/oidc.test.ts`
(new, 20: settings defaults/overrides/half-config/malformed issuer, real
code+PKCE authorize request S256/state/nonce/no-secret, in-memory token store,
callback success/denied/invalid-state, token return/no-session/renewal/failed
renewal, signin return-target sanitization + nonce, signout, ApiClient bearer
attachment).

> r6 did **not** change the schema — `external_identities` already existed from r5
> — so no new migration was authored.

r7 new/expanded coverage (api 230 → 282; broker/web unchanged): `credential-keys.test.ts`
(new, 20: restart persistence across provider instances, key file `0600` + reuse,
env-PEM load, wrong key, tampered ciphertext, unexpected algorithm, key-size
mismatch, unsupported payload version, disallowed/short modulus, mismatched pair,
key-id stability, no private material exposed, rotation with retired keys,
duplicate key id, explicit ephemeral distinctness); `vault-client.test.ts` (new,
11, against `test/support/mock-vault.ts`: wrap-not-data, single-use unwrap, expiry,
per-request token choice, namespace, revoke + idempotent revoke, auth rejection,
5xx status, timeout, constructor guards, non-positive TTL); `credential-lifecycle.test.ts`
(new, 9: pair payload cleared on complete + close, idempotent, stale-sweep on an
ended rental, reaper sweep count + failure isolation + absent-store skip,
`withRetries` resolve/retry/exhaust); `config.test.ts` (18 → 25: credential-key
parsing, pair-master validation, the three production guards, production-accepts);
`end-session.test.ts` (3 → 5: revoke retried then succeeds, always-fails still
ends); `prisma-license-store.test.ts` (8 → 11: `Prisma.DbNull` clear shape, sweep
fallback, non-connection error propagates); `prisma-persistence.pg.test.ts`
(5 → 7). Updated `app`, `orchestrator`, `rent-integration`, and fixture payloads.

> r7 did **not** change the schema either — `license_rentals.pair_payload` was
> already a nullable `jsonb` column — so no new migration was authored; the
> migration *validation* was rerun on a disposable cluster.

---

## 8. Open risks & outstanding work

**Security limitations I am explicitly not claiming to have fixed:**

- **Post-session persistence failure (addressed r3)** — if `recordRental` fails
  *after* a valid session exists, the orchestrator now terminates the session + VM
  and releases the claim only on a confirmed-terminal session; otherwise the
  claim is **held** and the durable `session.license_id` link keeps the reaper
  from freeing it. Residual: if teardown permanently fails and no other mechanism
  ever terminates the stuck session, the license stays `rented` indefinitely
  (fail-closed, by design — see D-24; production should add a session-state
  reaper, which does not exist today).
- **Grant trust** — `templateGrant` is assumed server-minted; there is no
  capability signature on it. A future HTTP handler that forwarded it from request
  data would be a vulnerability.
- **Stale-claim heuristic (hardened r3)** — now gated by
  `hasActiveSessionForLicense(license_id)` (computed fail-closed), not by the
  open-rental invariant alone; an abandoned claim is released only when no
  non-terminal session remains linked to the license.
- **Cloud cleanup unverified** — `AwsCloudProvider` is a stub; production
  `terminateInstance` is untested. **The real cloud flow is not claimed to work.**
- **Key custody is software-only; Vault is mock-tested (addressed r7, with limits).**
  The Layer-2 credential key is now durable and validated (a real `SHA-256(SPKI)`
  key id, algorithm + actual modulus recorded and re-checked, rotation via
  decrypt-only retired keys, restart persistence proved by test), and production
  refuses to boot without a credential key / pair master / Vault. **But there is no
  hardware-backed provider (HSM/KMS/Transit)**, `HttpVaultClient` is validated only
  against a local **mock** Vault server, and **owner credentials remain in Postgres**
  (Vault is authoritative only for session credentials) — the move to
  Vault-authoritative owner-credential custody is documented and **not executed**
  (see `docs/runbooks/key-management.md` §5). Plaintext lifetime is bounded, not
  force-zeroed.
- **No automated meter retry** for the null-`meter_event_id` obligation.
- **Auth (C4) — hardened r4, real verifier r5, browser flow + provisioning r6;
  production login still not operational (no real IdP).** Inbound auth fails
  closed by default (`DFAP_AUTH_MODE=deny`), the dev header adapter is
  local-only and refused in production, roles come from `org_members` (never
  `x-dfap-role`), the release route is owner-only, and CORS is an exact
  allowlist. r5 added a real, provider-neutral OIDC/JWT **access-token verifier**
  (`jose`) with `(issuer, subject) → user` mapping and no JIT provisioning. r6
  added the **browser Authorization Code + PKCE flow** (in-memory tokens, bearer
  attachment) and the **operator provisioning CLI**. **Residual: no real IdP has
  been connected or tested** — tests use local test issuers and generated keys —
  so end-to-end production login is *not* operational and, with `oidc`
  unconfigured, production still serves nothing. This is intentional, not a claim
  of working auth.
- **External identities are provisioned out of band (r5; CLI added r6).**
  `external_identities` rows must be created by an operator/admin; there is
  deliberately no just-in-time mapping from a token. The supported workflow is
  the DB-direct CLI (`npm run provision:identity`), which is idempotent and
  refuses accidental reassignment; there is still **no admin UI**.
- **In-memory browser tokens lose the session on reload (r6).** Access/refresh
  tokens are held in memory only (never `localStorage`); a full page reload
  requires signing in again. This is a deliberate security trade-off; fixing it
  needs a silent-renew page, not token persistence.
- **Guest provisioning is built but not production-enabled (r8).** The
  instance-identity verifier, server-side binding, one-time delivery and the
  fail-closed guest unit (`dfap-provision.service` + xrdp gate) exist and are
  tested with generated keys/fakes. Remaining to enable production: validate
  against AWS's real regional instance-identity certs + a live IMDS document,
  persist the launched AMI per instance (no `image_id` column), and add a
  multi-region key map. `DFAP_GUEST_PROVISIONING=instance-identity` is refused in
  production until then ([runbooks/guest-provisioning.md](runbooks/guest-provisioning.md)).
- **License has no org (new r4)** — release is owner-only because
  `software_licenses` carries no owning org, so a tenant-scoped admin/operator
  release cannot be expressed. Needs a server-side license→org mapping.

**Audit findings still open:** H7 (dead-man switch), M1–M9, L1–L5, and the
`listTemplates` swallow-and-fallback (C1 sibling).
**C3 is closed** (r8 — per-instance AWS-instance-identity pull, server-side
binding, fail-closed guest unit; production gated on real-AWS validation);
**C4 is closed** (r4); **H4 is closed** (r7 — `pair_payload` is now cleared on
rental end, inline + reaper sweep); **H5 is closed** (r7 — the credential key is
durable and validated, and production refuses an ephemeral key). Also
`LaunchSpec.orgId` currently tags the **template owner's** org, not the rentee's,
for a marketplace session — a design nuance left as-is.

**Production hardening still required:** connect a **real IdP** and test the
browser login end to end (see `docs/runbooks/oidc-production-onboarding.md`),
then set `DFAP_AUTH_MODE=oidc` with `DFAP_OIDC_ISSUER`/`DFAP_OIDC_AUDIENCE` and
the web `VITE_OIDC_*` build vars; seed `external_identities` for real users with
the provisioning CLI; set `DFAP_PAIR_MASTER_KEY` (base64 ≥32 bytes,
secret-managed) and `DFAP_CREDENTIAL_KEY_FILE`/`DFAP_CREDENTIAL_KEY_PEM` (durable;
replace the software provider with Vault Transit / CloudHSM for hardware backing);
point `VAULT_ADDR`/`VAULT_TOKEN` at a **real** cluster (the adapter is mock-tested
only) and execute the documented owner-credential→Vault migration; apply the
Prisma migrations.

---

## 9. What I need from you

### 9.1 Decisions

| # | Question | Options | My recommendation |
|---|---|---|---|
| D1 | **Session VM OS** | Linux · Windows | **Linux** — the hardened Packer pipeline and isolation work are already Linux; Windows needs a new Packer template + offline SAM/cred provisioning. |
| D2 | **AWS account** | Throwaway vs real | **Throwaway** for the first run. |
| D3 | **AWS finish line** | Level A (plumbing) · Level B (working pixels) | **Level A first.** |
| D4 | **Who runs terraform/packer** | You run it and paste output · Install here and I drive | Either; I can't install CLIs or create accounts. |
| D5 | **Guest credential mechanism** | `dfap-preboot.service` (in-image) · SSM password path | **RESOLVED in M8 (§4.9):** neither as originally framed — it is now an **authenticated per-instance pull** (AWS-signed instance-identity document + server-side instance→session binding), delivered once to a fail-closed guest unit. The sealed-blob path is dev-only; SSM push remains an accepted alternative behind the same seam. |

### 9.2 AWS credentials — what, when, how

**Nothing needed right now.** Real adapters are off by default. When you go real:

| Real path | What to give me | Env / switch |
|---|---|---|
| Real VM launch/terminate | AWS account id + region; a named profile (`AWS_PROFILE=…`) or run terraform yourself | `CLOUD_PROVIDER=aws`, `AWS_REGION`, `AWS_LAUNCH_TEMPLATE_ID` |
| Real Vault (wrap tokens) | `VAULT_ADDR` + `VAULT_TOKEN` (unsealed) | `HttpVaultClient` |
| Real Stripe charging | `STRIPE_API_KEY` + `STRIPE_WEBHOOK_SECRET` (test mode fine) | `RealStripeClient` |
| Production key material | Set a real master | `DFAP_PAIR_MASTER_KEY=$(openssl rand -base64 32)` |
| Durable owner-credential key | A PKCS#8 PEM (file or base64) | `DFAP_CREDENTIAL_KEY_FILE` / `DFAP_CREDENTIAL_KEY_PEM` (see `docs/runbooks/key-management.md`) |

**Absolute rules:** (1) never paste secrets into chat — configure them locally;
(2) never put static AWS keys in `.env` on the EC2 control host — use the instance
role (`infra/terraform/phase0` already attaches the policy).

**Also tell me:** a budget-alarm email (Terraform requires one) and whether the
account is disposable.

> Cost warning: Phase-0 idle spend ≈ **$70/month** (7 VPC endpoints ≈ $51, control
> host ≈ $12, EIP ≈ $3.65), plus ~$0.083/hr per running `t3.large` session.
> `terraform destroy` between tests.

---

## 10. What you need to do

### 10.1 Required to make the DB path live (1 command)

Two migrations now exist — `prisma/migrations/20261016000000_init/` (all tables,
**including** `sessions.license_id` + its index) and
`prisma/migrations/20261016010000_external_identities/` (the OIDC
`(issuer, subject) → user_id` map). Both have been **validated on a disposable
local PostgreSQL cluster** (r5) but have **not been applied to any real
database**. Until they are, the API degrades to the in-memory catalog (only with
`DFAP_DEV_FALLBACK=true`), so local dev works without it — but persistence doesn't.

```sh
cd services/api
npx prisma migrate dev          # local: applies the pending migrations
# in deploy/:   npx prisma migrate deploy
```

> The baseline was generated offline with `prisma migrate diff` and verified on a
> throwaway cluster. Because it is a from-empty baseline, apply it to a
> **fresh/empty** database. If you already `db push`-ed a schema without migration
> history, do **not** run `migrate deploy` against it — verify the schema matches
> and mark the baseline applied with `prisma migrate resolve --applied
> 20261016000000_init` (the second migration then applies normally, or is created
> by hand if the table already exists). Full detail:
> `services/api/prisma/migrations/README.md`.

### 10.2 Required for a paying tenant

1. Set `DFAP_PAIR_MASTER_KEY` (base64, ≥32 bytes, secret-managed). Production
   now **refuses to boot** without it (r7) — there is no non-secret dev seed.
2. Configure a durable owner-credential key: `DFAP_CREDENTIAL_KEY_FILE` or
   `DFAP_CREDENTIAL_KEY_PEM` (r7). Production refuses an ephemeral key. Rotation,
   backup, and the key-id scheme are in `docs/runbooks/key-management.md`.
3. Point `VAULT_ADDR`/`VAULT_TOKEN` at a real Vault (r7 makes production refuse
   the in-memory `FakeVaultClient`; the HTTP adapter is mock-tested only), and
   execute the documented owner-credential→Vault custody migration when ready.
4. Swap the software key provider for Thales Luna / CloudHSM / Vault Transit (same
   seam) if hardware-backed custody is required — none is implemented today.

### 10.3 When you want real AWS (detail in the runbook)

```sh
brew install awscli terraform packer
brew install --cask session-manager-plugin

aws configure sso --profile disfap     # or: aws configure --profile disfap
export AWS_PROFILE=disfap

# throwaway x86_64 AMI (NOT hardened — throwaway account only)
aws ssm get-parameters \
  --names /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
  --query 'Parameters[0].Value' --output text

cd infra/terraform/phase0
cp terraform.tfvars.example terraform.tfvars   # aws_region, session_ami_id, budget email
terraform init && terraform plan && terraform apply
```

Then set `CLOUD_PROVIDER=aws`, `AWS_REGION`, `AWS_LAUNCH_TEMPLATE_ID`. The control
host has **no port 22 and no user_data** — reach it with `aws ssm start-session`
and deploy `deploy/` yourself.

### 10.4 Optional

- Confirm the next build target (see §12): a Linux template, the marketplace UI
  smoke test, or validating guest provisioning against real AWS.

---

## 11. File inventory (across all milestones)

**New (r0).** `src/crypto/pair-keys.ts`; `src/cloud/disk-injector.ts`;
`src/marketplace/prisma-license-store.ts`; test files `pair-keys`, `disk-injector`,
`orchestrator`, `end-session`; `docs/spec-implementation-decisions.md`;
`docs/runbooks/aws-first-session.md`; `HANDOFF.md`.

**Modified (r0).** `prisma/schema.prisma` (`LicenseStatus`, `SoftwareLicense`,
`LicenseRental`); `orchestrator/two-thread-orchestrator.ts` (pair re-seal,
credential → `createSession`, rental, meter); `server.ts` (wiring + seeding +
pair-master seed); `sessions/create-session.ts` (optional credential);
`sessions/end-session.ts` (rental release); `pool/pool-manager.ts` (`injector`,
`claim(…, preBoot?)`); `cloud/provider.ts` (`userData`); `marketplace/license-store.ts`
(rental records); `app.ts` (release route); `apps/web/src/session/LaunchPage.tsx`
(+css); `.env.dev.example`, `deploy/.env.example`; `docs/architecture.md`, `README.md`.

**New (r1).** `test/config.test.ts`; `test/prisma-license-store.test.ts`;
`test/server.test.ts`.

**Modified (r1).** `config.ts` (`devFallback`, `bool()`, prod guard); `server.ts`
(gate 3 fallbacks + marketplace fallback); `orchestrator/two-thread-orchestrator.ts`
(`devAllowRerent`); `sessions/end-session.ts` (H1 terminal release);
`scripts/start-all.mjs`; `.env.dev.example`; `deploy/.env.example`;
`test/orchestrator.test.ts`; `test/end-session.test.ts`.

**New (r2).** `src/marketplace/rental-reaper.ts`; `test/marketplace-store.test.ts`;
`test/rental-reaper.test.ts`; `test/rent-integration.test.ts`.

**Modified (r2).** `marketplace/license-store.ts` (`RentalLease` + 7 store
methods); `marketplace/prisma-license-store.ts` (Prisma impls); 
`sessions/create-session.ts` (grant + VM cleanup); 
`orchestrator/two-thread-orchestrator.ts` (atomic claim, compensation, ordering);
`server.ts` (grant/cleanup deps + rental reaper); 
`docs/spec-implementation-decisions.md` (section 8); `test/prisma-license-store.test.ts`;
`test/orchestrator.test.ts`; `test/create-session.test.ts`.

**New (r3).** `prisma/migrations/migration_lock.toml`;
`prisma/migrations/20261016000000_init/migration.sql` (offline baseline, includes
`sessions.license_id` + index).

**Modified (r3).** `prisma/schema.prisma` (`Session.licenseId` + index);
`ports.ts` (`SessionRecord.licenseId`, `CreateSessionData.licenseId`,
`SessionRepo.hasActiveForLicense`); `db/prisma-repos.ts` (map/insert
`licenseId` + `hasActiveForLicense`); `sessions/create-session.ts`
(`licenseId` persisted at row creation); `orchestrator/two-thread-orchestrator.ts`
(`licenseId` in input, `terminateSession`/`events` deps,
`compensateUnpersistedRental`); `marketplace/rental-reaper.ts`
(`hasActiveSessionForLicense`, `heldClaims`, active-session gate); `server.ts`
(shared `runEndSession`, orchestrator `terminateSession`/`events`, reaper
active-session wiring); `docs/spec-implementation-decisions.md`; test updates in
`orchestrator`, `rent-integration`, `rental-reaper`, `create-session`,
`end-session`, `app`.

**New (r4).** `test/auth.test.ts`; `test/prisma-persistence.pg.test.ts`
(env-gated PostgreSQL validation); `prisma/migrations/README.md` (fresh-DB +
baselining guidance).

**Modified (r4).** `src/auth/authenticator.ts` (`FailClosedAuthenticator`,
`DevHeaderAuthenticator`, `RoleResolver`; `HeaderStubAuthenticator` removed);
`src/ports.ts` (`MembershipRepo`); `src/db/prisma-repos.ts`
(`PrismaMembershipRepo`); `src/config.ts` (`authMode`, `corsAllowedOrigins` +
parsers/guards); `src/app.ts` (exact-allowlist CORS, authenticated catalog,
owner-only release); `src/server.ts` (authenticator composition, CORS wiring);
`apps/web/src/api/client.ts` (no role header; dev-gated identity);
`scripts/start-all.mjs` + `.env.dev.example` (dev auth/CORS defaults);
`deploy/.env.example` (`DFAP_AUTH_MODE`/`DFAP_CORS_ALLOWED_ORIGINS` documented
deny/empty); `services/api/README.md`; `docs/security.md` (Guarantee 6);
`docs/spec-implementation-decisions.md` (§10); tests `config`, `app`, `server`.

**New (r5).** `services/api/src/auth/jwks.ts` (`JoseAccessTokenVerifier`,
`AccessTokenVerifier`, `OidcVerifierConfig`); `services/api/src/auth/oidc.ts`
(`OidcAuthenticator`); `services/api/prisma/migrations/20261016010000_external_
identities/migration.sql`; `services/api/test/oidc-jwt.test.ts`;
`services/api/test/oidc-authenticator.test.ts`; `apps/web/test/api-client.test.ts`.

**Modified (r5).** `services/api/prisma/schema.prisma` (`ExternalIdentity` model +
`User.externalIdentities`); `services/api/src/ports.ts` (`IdentityRepo`,
`MemberResolution`, `MembershipRepo.resolveMembership`); `services/api/src/db/
prisma-repos.ts` (`PrismaIdentityRepo`, `PrismaMembershipRepo.resolveMembership`);
`services/api/src/auth/authenticator.ts` (`ForbiddenError`); `services/api/src/
config.ts` (`authMode` += `oidc`, `OidcConfig`, `parseOidc`, `httpUrl`);
`services/api/src/server.ts` (adapter composition: deny/dev-header/oidc);
`apps/web/src/api/client.ts` (`getAccessToken`, `Authorization: Bearer`);
`services/api/package.json` + root `package-lock.json` (`jose`);
`services/api/prisma/migrations/README.md`; `services/api/README.md`;
`deploy/.env.example`; `docs/security.md`; `docs/spec-implementation-decisions.md`
(§11); tests `config`, `server`, `prisma-persistence.pg`.

**New (r6).** `apps/web/src/auth/oidc-settings.ts` (`oidcSettingsFromEnv`,
`createUserManager`, `OidcSettings`); `apps/web/src/auth/OidcAuth.ts` (`OidcAuth`,
`UserManagerLike`, `BrowserLike`, `createOidcAuth`); `apps/web/src/auth/AuthGate.tsx`
(+ `AuthGate.module.css`); `apps/web/test/oidc.test.ts`; `services/api/src/auth/
identity-provisioning.ts` (`provisionIdentity`, `IdentityProvisioningStore`,
`ProvisioningError`); `services/api/src/cli/provision-identity.ts` (operator CLI);
`services/api/test/identity-provisioning.test.ts`; `services/api/test/oidc-e2e.test.ts`;
`services/api/test/support/oidc-test-provider.ts`; `docs/runbooks/oidc-production-onboarding.md`.

**Modified (r6).** `apps/web/src/App.tsx` (OIDC init, `AuthGate` gating, token
injection, sign-out); `apps/web/src/components/Navbar.tsx` (`onSignOut`/`userLabel`);
`apps/web/src/vite-env.d.ts` (`VITE_OIDC_*`); `apps/web/package.json` +
`package-lock.json` (`oidc-client-ts`); `services/api/src/db/prisma-repos.ts`
(`PrismaIdentityProvisioningStore`); `services/api/package.json`
(`provision:identity` script); `services/api/test/prisma-persistence.pg.test.ts`
(provisioning cases); `services/api/README.md`; `docs/security.md` (Guarantee 6 +
limitations); `docs/spec-implementation-decisions.md` (§12); `deploy/.env.example`
+ `.env.dev.example` (web OIDC build vars); `HANDOFF.md`.

**New (r7).** `services/api/src/crypto/credential-key-store.ts` (`CredentialKeyConfig`,
`materialFromPrivatePem`, `loadOrCreateCredentialKeyFile`, `createCredentialHsm`);
`services/api/src/util/retry.ts` (`withRetries`); `services/api/test/credential-keys.test.ts`;
`services/api/test/vault-client.test.ts`; `services/api/test/support/mock-vault.ts`;
`services/api/test/credential-lifecycle.test.ts`;
`docs/runbooks/key-management.md`.

**Modified (r7).** `services/api/src/crypto/hsm-rsa.ts` (rewritten: v2 payload,
`validateCredentialKey`, `SoftwareHsm` requires material, `RotatingCredentialHsm`,
`generateEphemeralHsm`, `keyIdFromPublicKey`); `services/api/src/config.ts`
(`credentialKey` + `pairMasterKey` parsing/validation; production guards);
`services/api/src/server.ts` (`createCredentialHsm`, `buildPairMasterSeed(cfg)`);
`services/api/src/vault/vault-client.ts` (`HttpVaultClient` real KV-v2 + wrapping
adapter); `services/api/src/credentials/credential-issuer.ts` (comment);
`services/api/src/marketplace/license-store.ts` + `prisma-license-store.ts`
(`clearStalePairPayloads`, payload clear in `closeRental`/`completeForSession`);
`services/api/src/marketplace/rental-reaper.ts` (cleanup sweep +
`clearedPairPayloads`); `services/api/src/sessions/end-session.ts` (retried
revoke); `.gitignore` (`.dfap/`); `docs/security.md` (Guarantee 7 + limitations);
`docs/spec-implementation-decisions.md` (§13); `services/api/README.md`;
`deploy/.env.example` + `.env.dev.example` (credential-key env); tests `config`,
`app`, `orchestrator`, `rent-integration`, `end-session`, `marketplace-store`,
`prisma-license-store`, `rental-reaper`, `prisma-persistence.pg`; `HANDOFF.md`.

**New (r8).** `services/api/src/guest/instance-identity.ts` (verified identity,
`InstanceIdentityVerifier`, `AwsInstanceIdentityVerifier`, `DisabledInstanceIdentityVerifier`);
`services/api/src/guest/aws-cert-provider.ts` (`StaticAwsCertProvider`);
`services/api/src/guest/provisioning-package.ts` (v1 contract + strict validator);
`services/api/src/guest/guest-provisioning.ts` (`evaluateProvisioningRequest`,
`GuestProvisioningService`, `InMemoryProvisioningRegistry`);
`services/api/src/guest/binding-resolver.ts` (`BindingResolver`, `GuestBindingStore`);
`services/api/src/guest/vault-credential-source.ts` (`VaultGuestCredentialSource`);
`infra/packer/provision/guest/dfap-provision.sh` (+ `--self-test`),
`infra/packer/provision/guest/dfap-deprovision.sh`;
`infra/packer/systemd/dfap-provision.service`, `infra/packer/systemd/xrdp-gate.conf`;
`docs/runbooks/guest-provisioning.md`; tests `instance-identity`,
`guest-provisioning`, `guest-provision-script`.

**Modified (r8).** `services/api/src/vault/vault-client.ts` (adds
`VaultClient.read()`; Fake + Http + mock-Vault GET); `services/api/src/db/prisma-repos.ts`
(`PrismaGuestBindingStore`); `services/api/src/config.ts`
(`DFAP_GUEST_PROVISIONING` + cert material + production refusal);
`services/api/src/app.ts` (`POST /internal/guest/provision`);
`services/api/src/server.ts` (guest service wiring; production ⇒ `NoPreBootInjector`);
`services/api/src/sessions/end-session.ts` (revoke provisioning authority);
`infra/packer/provision/install-workspace.sh` (installs units/scripts, `/etc/skel/.xsession`,
`tsusers`, corrected comment); `infra/packer/provision/harden.sh` (auditd watches);
`infra/packer/offline-harden/harden-offline.sh` (account DBs no longer `chattr +i`,
documented); `infra/packer/linux-workspace.pkr.hcl` (stages `provision/guest/`);
`docs/security.md` (Guarantee 8 + limitations); `docs/spec-implementation-decisions.md`
(§3 update + §14); `.env.dev.example`; tests `vault-client`, `config`, `app`.

---

## 12. Working-tree state & next moves

**Git state.** `{services/api/,deploy/,scripts/,apps/,infra/,docs/runbooks/,docs/spec-implementation-decisions.md,HANDOFF.md}`
are untracked; `.env.dev.example` is gitignored. The **tracked-file diff** is the
pre-existing baseline (README, docs/architecture, package.json,
services/broker/package.json, services/broker/src/server.ts) **plus**
`package-lock.json`, which r5 (added `jose`) and r6 (added `oidc-client-ts`) also
touched (the per-package entries live in the untracked `services/api/package.json`
and `apps/web/package.json`); r7 and r8 added no dependency. `.dfap/` (the dev
credential-key directory, created on first non-production boot/test) is gitignored
along with `*.pem`/`*.key`. **Nothing is committed or pushed.**

**Status: the r8 milestone is complete and green. No work is mid-flight.**

Queued next moves (gated on your answers in §9.1):

1. **Connect a real IdP and test the browser login end to end** — the verifier,
   identity mapping, browser authorization-code+PKCE flow, and provisioning CLI
   are all built and tested locally, but no real provider has been contacted, so
   production login is not yet operational. Steps:
   `docs/runbooks/oidc-production-onboarding.md`.
2. **Validate guest provisioning against real AWS, then enable it** (needs
   D2–D4 + the account/region) — the trust interface, server-side binding,
   one-time delivery, and the fail-closed guest unit are built and unit-tested
   against generated keys/fakes, but **production refuses
   `DFAP_GUEST_PROVISIONING=instance-identity`** until AWS's real regional
   instance-identity certificates and a live IMDS document are validated. Steps:
   `docs/runbooks/guest-provisioning.md` §2. Also persist the launched AMI per
   instance and add a multi-region key map.
3. **Apply the migrations** (`prisma migrate dev` locally / `migrate deploy` in
   `deploy/`) so the durable license↔session link and the identity map persist to
   a real database — both code paths are built and PostgreSQL-validated on a
   disposable cluster, but not applied to a live DB.
4. **Automated meter retry** for the null-`meter_event_id` obligation, and a
   **session-state reaper** for the residual fail-closed case in §8 (a stuck
   non-terminal session keeps its license held indefinitely).
5. **Linux RDP workspace template + marketplace entry** (needs D1).
6. **Marketplace UI component test** in `apps/web`, plus a browser-level CORS
   check against the exact allowlist.
7. **AWS Level A walkthrough** (needs D2–D4 + account/region/profile).
8. **Real Vault + hardware-backed key custody** — point `VAULT_ADDR` /
   `VAULT_TOKEN` at a live cluster (the HTTP adapter is mock-tested only) and, if
   hardware custody is required, replace the software key provider with Vault
   Transit / CloudHSM; then execute the documented owner-credential→Vault
   migration (`docs/runbooks/key-management.md`). Production already refuses to
   boot without a durable key, the pair master, and Vault (r7).
9. **Remaining audit findings** — H7, M1–M9, L1–L5, and the `listTemplates`
   fallback sibling of C1. (C4 closed in r4; **H4 and H5 closed in r7**; **C3
   closed in r8**, production-gated.)
10. **License→org mapping** so a tenant-scoped operator/admin release can exist
    without weakening the owner-only rule.
