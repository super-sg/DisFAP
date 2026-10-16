# =============================================================================
# DisFAP Phase-0 — operator Makefile
# =============================================================================
# All targets shell out to `docker compose` using deploy/docker-compose.yml and
# deploy/.env in THIS directory. Run everything from deploy/.
#
#   make gen-keys   # print a fresh DFAP1 signing keyring to paste into .env
#   make up         # build + start the whole stack (detached)
#   make migrate    # prisma migrate deploy inside a throwaway api container
#   make logs       # tail all service logs
#   make down       # stop the stack (volumes kept)
# =============================================================================

# `docker compose` (v2) is assumed. COMPOSE bundles the compose file + env file
# so every target is consistent regardless of the caller's cwd tricks.
COMPOSE ?= docker compose -f docker-compose.yml --env-file .env

.DEFAULT_GOAL := help
.PHONY: help up down build logs ps migrate gen-keys psql vault-status restart

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

up: ## Build images if needed and start the stack (detached)
	$(COMPOSE) up -d --build

down: ## Stop and remove containers (named volumes are preserved)
	$(COMPOSE) down

build: ## Build (or rebuild) images. Optionally: `make build web`
	$(COMPOSE) build $(filter-out $@,$(MAKECMDGOALS))

logs: ## Tail logs for all services (Ctrl-C to stop)
	$(COMPOSE) logs -f --tail=200

ps: ## Show container status
	$(COMPOSE) ps

migrate: ## Apply Prisma migrations against Postgres (prisma migrate deploy)
	$(COMPOSE) run --rm api npx prisma migrate deploy

gen-keys: ## Print a fresh DFAP1 signing keyring (paste both lines into .env)
	@kid="k$$(date +%Y%m%d)"; \
	key="$$(openssl rand -base64 32)"; \
	echo "# --- fresh DFAP1 signing key ($$(date -u +%FT%TZ)) ---"; \
	echo "DFAP_SIGNING_KEYS=$$kid:$$key"; \
	echo "DFAP_SIGNING_KID=$$kid"

psql: ## Open a psql shell on the Postgres container
	$(COMPOSE) exec postgres sh -c 'psql -U "$$POSTGRES_USER" "$$POSTGRES_DB"'

vault-status: ## Show Vault seal/init status (sealed until you unseal it)
	$(COMPOSE) exec vault vault status || true

restart: ## Recreate app containers without a full rebuild
	$(COMPOSE) up -d --no-build api broker web caddy

# Swallow extra goal words (e.g. the `web` in `make build web`) so they don't
# error as unknown targets.
%:
	@:
