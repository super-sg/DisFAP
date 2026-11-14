# DisFAP — Distributed Federated Access Platform

**Secure workspace-as-a-service.** Contractors, offshore teams, auditors, and other third parties work on sensitive apps and data through the browser — and the endpoint never holds anything but pixels.

## The guarantee

The client receives a rendered pixel stream over an HTML5 canvas. There is no file transfer, no clipboard, no drive redirection, no data channel of any kind — and that absence is *enforced in four independent layers*, not configured in one place. See [docs/security.md](docs/security.md).

## How a session works

```
User clicks "Start session"
  │
  ▼
Control plane (services/api)
  ├─ claims a pre-hardened ephemeral VM (warm pool; never reused across sessions)
  ├─ asks Vault to mint a short-lived credential for that VM
  └─ hands the browser a 60-second, single-use, HMAC-SHA256-signed handle
  │
  ▼
Broker (services/broker)
  ├─ redeems the handle (replay ⇒ session terminated)
  ├─ pulls the VM credential from Vault server-side — it never reaches the client
  ├─ connects through guacd (RDP) to the session VM
  └─ streams pixels over WebSocket, filtering the Guacamole instruction stream
  │
  ▼
Browser renders canvas (guacamole-common-js). Session ends ⇒ VM is destroyed.
```

## Prerequisites

| Requirement | Why | Needed for |
|---|---|---|
| Node.js ≥ 22 | workspaces, `fetch`, ESM | always |
| PostgreSQL 14+ | sessions, pool, billing, audit | `DFAP_DEV_FALLBACK=false` (the real path) |
| guacd (Docker or native) | Guacamole protocol ↔ RDP/VNC translation | actually connecting to a desktop |
| Docker | runs guacd | local sessions |
| AWS credentials (SSO role) | real EC2 | `CLOUD_PROVIDER=aws` only |

## Quick start (local, zero cloud, zero cost)

```bash
npm install

# 1. (optional) local env. Without this file `npm start` uses documented
#    development defaults, so the stack still comes up.
cp .env.example .env

# 2. Database. Skipped only if you keep DFAP_DEV_FALLBACK=true.
createdb disfap   # or: psql -c 'CREATE DATABASE disfap'
cd services/api && npx prisma migrate deploy && cd ../..

# 3. guacd — needed only to open a real desktop
docker run --rm -p 4822:4822 guacamole/guacd

# 4. Build once, then run everything (API + in-process broker + Vite)
npm run build
npm start
```

Open <http://localhost:5173>. The default `CLOUD_PROVIDER=fake` provisions an
in-memory instance: sessions reach `ready` and the broker path runs, but there is
no real desktop to paint — see the runbooks for the AWS path.

### Ports

| Port | Service | Notes |
|---|---|---|
| 5173 | web (Vite) | proxies `/api` → 3000 and `/tunnel` → 8080 in dev |
| 3000 | API (Fastify) | routes are served at both `/` and `/api` |
| 8080 | broker (WebSocket) | `/tunnel` |
| 4822 | guacd | loopback only; never expose it |
| 5432 | PostgreSQL | |

## Repository layout

| Path | What |
|---|---|
| [services/api/](services/api/) | Control plane: sessions, pool manager, readiness reconciler, reaper, marketplace, billing |
| [services/broker/](services/broker/) | Session gateway: token redemption, instruction filter, guacd tunnel |
| [scripts/demo/](scripts/demo/) | Demo setup, teardown, and seed helpers used by the runbooks |
| [apps/web/](apps/web/) | Browser client (React + guacamole-common-js) |
| [infra/terraform/](infra/terraform/) | Fleet infrastructure — VPC, security groups, launch templates. **Not run per session.** |
| [infra/packer/](infra/packer/) | Hardened golden-image pipeline (Packer + offline hardening stage) |
| [scripts/](scripts/) | Stack launcher and demo helpers |
| [docs/](docs/) | Architecture, security model, ADRs, runbooks |

Project specifications and historical engineering records live under
[`docs/specifications/`](docs/specifications/) and [`docs/project/`](docs/project/).
Architecture diagrams and their assets are kept under [`docs/architecture/`](docs/architecture/).

## Where to change things

| I want to… | Go to |
|---|---|
| add or change an HTTP endpoint | `services/api/src/http/routes/<area>.ts` — route modules are mounted by `src/app.ts`; `app.ts` is wiring only |
| change a request/response type | `services/api/src/http/contracts.ts` |
| add a database-backed store | `services/api/src/db/repos/<concern>.ts`, exported from `db/repos/index.ts`; the port interface lives in `src/ports.ts` |
| change session lifecycle rules | `services/api/src/state-machine.ts` (the only place transitions are allowed) |
| change wiring or startup order | `services/api/src/server.ts` |
| change the Guacamole instruction filter | `services/broker/src/protocol/` |
| change the session UI | `apps/web/src/session/` (`LaunchPage` composes `useCatalog`, `useSessionLaunch`, `LaunchProgress`, `OwnerListingForm`) |
| change the client ↔ API contract | `apps/web/src/api/client.ts` |

Two interfaces are deliberately narrow and must not be widened casually: the
`ports.ts` repository interfaces (so tests can fake the whole data layer) and the
connect-token format (an opaque `DFAP1` capability — it never carries a host,
username, or password).

## Commands

```bash
npm test                      # api + broker + web
npm run typecheck             # tsc --noEmit in every workspace
npm run build                 # prisma generate, tsc (api, broker), vite build
npm start                     # API + broker + web together
npm run dev:api               # API only (tsc build output must exist)
npm run dev:web               # Vite dev server only

npm test --workspace=@disfap/broker       # one workspace
npx vitest run test/app.test.ts           # one file (from a workspace root)
```

## Testing: what is real, and what is not

| Suite | Latest local result | Evidence |
|---|---|---|
| `services/api` | 508 passed, 14 skipped | Unit and HTTP tests use fakes; PostgreSQL persistence tests are environment-gated |
| `services/broker` | 130 passed | Mock guacd; tunnel and protocol filtering are exercised directly |
| `apps/web` | 66 passed | jsdom; the API client is mocked |
| **Total** | **704 passed, 14 skipped** | `npm test`, 2026-11-14; skipped tests require `DFAP_TEST_DATABASE_URL` |

No test in this repository calls AWS, Vault, Stripe, or Stripe's API. Anything
requiring a live cloud is a runbook step performed deliberately by an operator.

The PostgreSQL suite is the honest exception worth running before a release:

```bash
cd services/api
DFAP_TEST_DATABASE_URL="postgresql://disfap:disfap@localhost:5432/disfap_test?schema=public" \
  npx prisma migrate deploy && npx vitest run test/prisma-persistence.pg.test.ts
```

## Configuration and safety rails

`services/api/src/config.ts` is the single source of truth: it validates the
environment at startup and **refuses to boot** on an unsafe combination. The
rails that matter:

- `DFAP_ENV=production` rejects `DFAP_DEV_FALLBACK=true`, the `dev-header`
  authenticator, a wildcard CORS origin, and TLS verification disabled.
- Privilege is resolved from the database (`org_members`), never from a request
  header — `x-dfap-role` is ignored by design.
- A session's connect handle is single-use, 60-second TTL, and only issued to the
  renter of record.
- 5xx responses never carry internal detail; it goes to the log instead.

Every variable is documented in [docs/configuration.md](docs/configuration.md), with
templates in `.env.example` (local) and `deploy/.env.example` (deployed). Secrets
belong in a secret manager, not a file in this repository.

## Documentation

- [docs/architecture.md](docs/architecture.md) — full component design and session lifecycle
- [docs/specifications/](docs/specifications/) — academic design dossier and source specification
- [docs/project/](docs/project/) — development process and dated structure snapshot
- [docs/configuration.md](docs/configuration.md) — every environment variable, default, and guard
- [docs/security.md](docs/security.md) — threat model and the four isolation layers
- [docs/spec-implementation-decisions.md](docs/spec-implementation-decisions.md) — decision record for the software-marketplace spec (Layers 1–3)
- [docs/runbooks/aws-first-session.md](docs/runbooks/aws-first-session.md) — taking DisFAP from `CLOUD_PROVIDER=fake` onto real AWS
- [docs/runbooks/demo-evaluation.md](docs/runbooks/demo-evaluation.md) — end-to-end evaluation against real EC2
- [docs/runbooks/guest-provisioning.md](docs/runbooks/guest-provisioning.md) — how a booting guest receives its one-time credential
- [docs/runbooks/key-management.md](docs/runbooks/key-management.md) — signing-key rotation and the credential keyring
- [services/api/prisma/migrations/README.md](services/api/prisma/migrations/README.md) — schema history and safe migration workflow
- [docs/adr/](docs/adr/) — why the load-bearing decisions were made
- [HANDOFF.md](HANDOFF.md) — current status, known risks, and the evidence behind both

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| API exits on boot with a config error | an unsafe env combination | read the message; it names the variable and the rule |
| Sessions never leave `requested` | no provider, or the readiness probe cannot reach 3389 | `CLOUD_PROVIDER`, security-group ingress, `DFAP_READY_TIMEOUT_S` |
| `ready` but the canvas stays black | guacd down, or the credential was lost | `docker run … guacamole/guacd`; restarting the API wipes the in-memory Vault and wrap-token caches, so re-launch the session |
| Every request is 401 | `DFAP_AUTH_MODE=deny` (the production default) | set `dev-header` locally, or bring an OIDC token |
| Browser blocks the API call | origin not in the allowlist | add it to `DFAP_CORS_ALLOWED_ORIGINS` (exact origin, no wildcard) |
| `prisma` errors after a pull | client not generated | `npm run prisma:generate --workspace=@disfap/api` |
