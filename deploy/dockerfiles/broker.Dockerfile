# =============================================================================
# services/broker (@disfap/broker) — production image
# =============================================================================
# BUILD CONTEXT = repo root (set in docker-compose.yml). That is required: this
# is an npm-workspaces monorepo, so the lockfile at the root is the source of
# truth and `npm ci` must run there for hoisting/symlinks to resolve.
#
# `npm ci` here installs *inside the image* from the committed, read-only
# lockfile — it never writes back to the host tree.
#
# The broker's tsconfig is `noEmit` (type-check only), so we compile the server
# entry graph to JS explicitly with emit flags rather than editing that
# committed config. Only the src import graph reached from server.ts is
# compiled; test files are untouched.
# =============================================================================

# ---- build stage ------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /repo

# Root manifests + all workspace sources (the lockfile references the full
# workspace set, so `npm ci` needs every workspace's package.json present).
COPY package.json package-lock.json ./
COPY services ./services
COPY apps ./apps

RUN npm ci

# Emit runnable ESM to services/broker/dist. noEmitOnError defaults to false, so
# this produces JS regardless; type-checking is enforced centrally in CI.
RUN npx tsc services/broker/src/server.ts \
      --outDir services/broker/dist \
      --rootDir services/broker/src \
      --module nodenext \
      --moduleResolution nodenext \
      --target es2023 \
      --esModuleInterop \
      --resolveJsonModule \
      --skipLibCheck

# Drop devDependencies (typescript, vitest, @types/*) from the install so the
# runtime image ships only what the broker needs at run time (`ws`).
RUN npm prune --omit=dev

# ---- runtime stage ----------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /repo

# Hoisted production node_modules + the compiled broker + its manifest.
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/services/broker/dist ./services/broker/dist
COPY --from=build /repo/services/broker/package.json ./services/broker/package.json
COPY --from=build /repo/package.json ./package.json

# Run unprivileged (the base image ships a `node` user).
USER node

EXPOSE 8080

# Liveness for the compose/LB healthcheck: the broker serves /healthz on the
# same HTTP server as the /tunnel WebSocket.
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=5 \
  CMD node -e "require('http').get('http://127.0.0.1:8080/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# NOTE: the broker's standalone entrypoint (services/broker/src/server.ts)
# currently throws by design until services/api lands the control-plane client
# that supplies the SessionResolver + Vault CredentialProvider to
# createBroker(). Once that composition root is wired, this same command runs
# the live gateway with no change here. See deploy/README.md.
CMD ["node", "services/broker/dist/server.js"]
