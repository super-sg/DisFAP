# DisFAP — Phase-0 all-in-one deployment

Everything DisFAP needs, on **one `t4g.small`**, in Docker Compose: the control-plane
**api**, the session **broker**, **guacd**, a single-node **Vault**, **Postgres**, **Redis**,
and **Caddy** for TLS. This is the cheapest runnable topology (see
[`docs/architecture.md` §"Phase-0 deployment"](../docs/architecture.md)); the production
topology (Vault Raft + KMS, RDS, ElastiCache, a guacd ASG) arrives with the first paying
tenant.

```
                         Internet
                            │  :443 / :80   (only ports published on the host)
                    ┌───────▼────────┐
                    │     caddy      │   TLS termination + routing
                    └──┬─────┬─────┬─┘
             /         │  /api│     │ /tunnel (WebSocket)
        ┌──────────────▼┐ ┌──▼─────┐ └─▼────────────┐
        │      web      │ │  api   │  │   broker     │
        │ (nginx, SPA)  │ │        │  │              │
        └───────────────┘ └──┬─────┘  └──┬───────┬───┘
                    edge net  │           │ edge  │ edge
        ─────────────────────────────────────────────────  (internal: true) ──
              internal net    │           │       │ 4822
                    ┌─────────▼──┐ ┌───────▼─┐  ┌──▼────┐
                    │  postgres  │ │  redis  │  │ vault │        guacd ──► session VMs
                    └────────────┘ └─────────┘  └───────┘        (on `edge`, egress only)
```

**Only Caddy publishes host ports.** `guacd`, `postgres`, `redis`, and `vault` publish
nothing. Postgres/Redis/Vault sit on a Docker network marked `internal: true` — no route to
the host, no route to the internet. `guacd` is never public: the broker reaches it by DNS
name on the private `edge` network and its `4822` port is never mapped.

---

## Prerequisites

- Docker Engine + Docker Compose v2 (`docker compose version`)
- `openssl` (for `make gen-keys`)
- GNU Make

---

## Local bring-up

Run everything from **this `deploy/` directory**.

### 1. Generate a DFAP1 signing key and create `.env`

```sh
cp .env.example .env
make gen-keys      # prints DFAP_SIGNING_KEYS=... and DFAP_SIGNING_KID=...
```

Paste the two printed lines over the placeholders in `.env`, then fill in the other
`CHANGE_ME` values (DB/Redis passwords, Stripe test keys, AWS region). Keep
`DATABASE_URL` / `REDIS_URL` in sync with the `POSTGRES_*` / `REDIS_PASSWORD` you choose.

> The key is 32 random bytes, base64-encoded — exactly `openssl rand -base64 32`. The
> broker rejects any signing key shorter than 32 bytes.

### 2. Start the stack

```sh
make up            # docker compose up -d --build
make ps            # watch services become healthy
```

First run builds the `api`, `broker`, and `web` images from the repo root (npm workspaces).

### 3. Initialise & unseal Vault (one time)

Phase-0 Vault boots **sealed and uninitialised** (this is deliberate — it is a real Vault,
not `-dev`). Initialise it once, save the output somewhere safe, and unseal it:

```sh
# 1 unseal key for Phase-0 (production uses 5 shares / threshold 3).
docker compose exec vault vault operator init -key-shares=1 -key-threshold=1

# Copy the "Unseal Key 1" and "Initial Root Token" from the output, then:
docker compose exec vault vault operator unseal <UNSEAL_KEY_1>

make vault-status  # should now show Sealed: false
```

Put the **Initial Root Token** into `VAULT_TOKEN=` in `.env` and `make restart` so the api
can talk to Vault. (Vault must be unsealed again after any `make down` + `make up`; existing
sessions survive a Vault outage, but *new* session creation fails fast until it is unsealed —
see [`docs/security.md`](../docs/security.md) "Known limitations".)

### 4. Apply database migrations

```sh
make migrate       # prisma migrate deploy, in a throwaway api container
```

### 5. Open the app

```
https://localhost
```

Caddy serves a **self-signed** certificate from its internal CA, so the browser warns once.
Either accept the warning or trust the local CA (below).

#### Trusting the local CA (optional, removes the warning)

```sh
# Export Caddy's root and add it to your OS/browser trust store.
docker compose exec caddy \
  cat /data/caddy/pki/authorities/local/root.crt > caddy-local-ca.crt
# macOS: Keychain Access → System → drag caddy-local-ca.crt → "Always Trust".
```

### Everyday commands

```sh
make logs          # tail everything
make logs api      #   (or a single service)  -> docker compose logs -f api
make psql          # psql shell on Postgres
make down          # stop (named volumes kept)
```

---

## AWS Phase-0 note

- **One `t4g.small`** (arm64 / Graviton) runs this entire Compose stack — the same images
  built here, `arm64`-native.
- **No NAT Gateway.** Egress (api → Stripe/AWS, guacd → session VMs) goes out the instance's
  own public interface / VPC endpoints. A NAT Gateway is ~$32/mo of pure overhead we skip at
  this scale.
- **Cold-launch sessions** — no warm pool in Phase-0 (a session waits ~60–90 s for a VM). The
  warm pool ([ADR-001](../docs/adr/001-warm-pool-over-terraform-per-session.md)) arrives with
  the production topology.
- **AWS Budgets alarm at $50** is the backstop guardrail (teardown layer 5 in
  [`docs/architecture.md`](../docs/architecture.md)). It is the last line against a runaway
  bill, not the first.
- On EC2, prefer the **instance IAM role** over static keys — leave `AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY` blank in `.env`.

To serve a real domain: point DNS at the instance, set `DFAP_SITE_ADDRESS=<fqdn>` and
`CADDY_ACME_EMAIL=<you>` in `.env`, **delete the `tls internal` line** in the `Caddyfile`,
set `VITE_API_BASE_URL` / `VITE_WS_URL` to the FQDN, then `make build web && make up`. Caddy
auto-provisions a real Let's Encrypt certificate over the published `:80`/`:443`.

---

## ⚠️ What is intentionally NOT production-grade here

This deployment is optimised for **cost and a single box**, not resilience. Do not put a
paying tenant on it as-is. Specifically:

| Area | Phase-0 (here) | Production requirement |
|---|---|---|
| **Vault** | Single node, **file** storage, TLS-disabled listener, **manual unseal** | Integrated storage (**Raft**, 3+ nodes) + **KMS auto-unseal** + TLS listener. See [`vault/config.hcl`](vault/config.hcl). |
| **TLS** | **Self-signed** internal CA for `localhost` | Real ACME / Let's Encrypt cert on a public FQDN |
| **Database** | Postgres in a container on one disk | Managed **RDS** (Multi-AZ, PITR backups) |
| **Redis** | Single container | **ElastiCache** (or equivalent HA) |
| **guacd** | One shared container | guacd **ASG** (and a per-VM sidecar for the premium tier) |
| **Availability** | **No HA** — one box, one AZ; any failure = downtime | Multi-AZ everywhere; no single point of failure |
| **Secrets** | Passwords in `.env` on the box | Injected from a secrets manager, never on disk |
| **Session VMs** | **Cold launch**, no warm pool | Warm pool ([ADR-001](../docs/adr/001-warm-pool-over-terraform-per-session.md)) |

The **pixel-only guarantee and the DFAP1 token/credential handling are the same code in both
phases** — those are enforced in the broker/guacd/image layers
([`docs/security.md`](../docs/security.md)), not by this deployment. Phase-0 relaxes
*operational* posture (HA, managed data stores, Vault sealing), never the security model.

---

## Files in this directory

| File | Purpose |
|---|---|
| `docker-compose.yml` | The whole stack. Networks, volumes, healthchecks, ports. |
| `Caddyfile` | Edge TLS + routing (`/`→web, `/api/*`→api, `/tunnel`→broker WS). |
| `.env.example` | Every required variable, documented. Copy to `.env`. |
| `Makefile` | `up`, `down`, `logs`, `migrate`, `gen-keys`, `psql`, … |
| `vault/config.hcl` | Phase-0 Vault server config (with the production WARNING). |
| `web/nginx.conf` | SPA server config for the `web` container. |
| `dockerfiles/api.Dockerfile` | Multi-stage build of `services/api` (control plane). |
| `dockerfiles/broker.Dockerfile` | Multi-stage build of `services/broker` (gateway). |
| `dockerfiles/web.Dockerfile` | Multi-stage build of `apps/web` → nginx static server. |
| `dockerfiles/*.dockerignore` | Per-Dockerfile build-context excludes (BuildKit). |

### Build-context / image assumptions

All three Dockerfiles use **the repo root as the build context** so npm workspaces resolve,
and run `npm ci` from the committed, read-only lockfile inside the image (this never writes
to the host tree). They assume conventional workspace layout — documented at the top of each
Dockerfile — namely:

- `@disfap/api` has a `build` script → `services/api/dist/server.js`, a Prisma schema at
  `services/api/prisma/schema.prisma`, exposes `/healthz`, and listens on `3000`.
- `@disfap/web` has a Vite `build` script → `apps/web/dist`.
- `@disfap/broker` (already committed) is compiled to `services/broker/dist/server.js`. For
  the api to `import '@disfap/broker'` at runtime, the broker package must expose a JS
  entrypoint (`main`/`exports` → its `dist`); that is a broker/api workspace concern, wired
  centrally when those two land their composition root.

If a workspace's real conventions differ (script name, output dir), adjust the corresponding
Dockerfile — those lines are commented for exactly this reason.

### Known Phase-0 caveat: broker standalone start

`services/broker/src/server.ts` intentionally **throws** on a standalone launch until
`services/api` provides the control-plane `SessionResolver` + Vault `CredentialProvider` to
`createBroker()`. Until that composition root is wired, the `broker` container will start and
immediately exit, and `/tunnel` returns `502` at Caddy. The image/compose are already pointed
at `node services/broker/dist/server.js`, so the broker goes live with **no change here** once
that wiring lands.
