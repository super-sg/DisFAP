# =============================================================================
# apps/web (@disfap/web) — production image  [browser client, static SPA]
# =============================================================================
# BUILD CONTEXT = repo root (npm-workspaces monorepo; `npm ci` at the root).
#
# ASSUMPTIONS about the web workspace (adjust here if their conventions differ):
#   * package name    @disfap/web
#   * build script    `npm run -w @disfap/web build`  (Vite)
#   * build output    apps/web/dist   (Vite default)
#
# WHY nginx and not "let Caddy serve it": the compose topology gives web its own
# container (Caddy proxies / to it). Serving the bundle from a tiny nginx keeps
# the web tier a dumb, backend-less static server with no route to the API,
# broker, or data plane — nothing here can be turned into a data channel.
#
# Vite inlines VITE_* at BUILD time, so the public URLs are ARG build args
# (wired from compose `build.args`). Changing a public URL requires a rebuild
# (`make build web`), not just a restart.
# =============================================================================

# ---- build stage ------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /repo

# Public URLs baked into the bundle.
ARG VITE_API_BASE_URL=/api
ARG VITE_WS_URL=wss://localhost/tunnel
ARG VITE_STRIPE_PUBLISHABLE_KEY=
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL} \
    VITE_WS_URL=${VITE_WS_URL} \
    VITE_STRIPE_PUBLISHABLE_KEY=${VITE_STRIPE_PUBLISHABLE_KEY}

# The lockfile references every workspace, so all workspace manifests must be
# present for `npm ci` even though only web is built here.
COPY package.json package-lock.json ./
COPY services ./services
COPY apps ./apps

RUN npm ci
RUN npm run -w @disfap/web build

# ---- runtime stage ----------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

# SPA-aware server config (history fallback + asset caching).
COPY deploy/web/nginx.conf /etc/nginx/conf.d/default.conf

# The compiled, self-contained static bundle. Nothing else ships.
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
