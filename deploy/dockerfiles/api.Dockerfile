# =============================================================================
# services/api (@disfap/api) — production image  [control plane]
# =============================================================================
# BUILD CONTEXT = repo root (npm-workspaces monorepo; `npm ci` at the root).
#
# ASSUMPTIONS about the api workspace (documented so the api team and this
# image stay in sync — adjust here if their conventions differ):
#   * package name          @disfap/api
#   * build script          `npm run -w @disfap/api build`  -> services/api/dist
#   * server entrypoint      services/api/dist/server.js
#   * Prisma schema          services/api/prisma/schema.prisma
#   * it imports @disfap/broker (session-token mint/verify) — hence broker
#     source is copied and installed too.
#
# The Prisma CLI is intentionally KEPT in the runtime image (no dev-prune) so
# `make migrate` can run `prisma migrate deploy` inside this container.
# `openssl` is installed for the Prisma query engine.
# =============================================================================

# ---- build stage ------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /repo

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY services ./services
COPY apps ./apps

RUN npm ci

# Generate the Prisma client against the api schema, then build the workspace.
RUN cd services/api && npx prisma generate
RUN npm run -w @disfap/api build

# ---- runtime stage ----------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /repo

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Full (incl. Prisma CLI) node_modules + built api + built broker dep + schema.
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/services/api ./services/api
COPY --from=build /repo/services/broker ./services/broker
COPY --from=build /repo/package.json ./package.json

WORKDIR /repo/services/api
USER node

EXPOSE 3000

# The api is expected to expose /healthz (used by compose + Caddy upstream).
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/server.js"]
