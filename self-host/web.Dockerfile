# =============================================================================
# Harmony web image - builds the Vue SPA and serves it with nginx.
# =============================================================================
# Build context is the repo root. One image serves any instance: at container
# start self-host/web-entrypoint.d/40-harmony-config.sh writes /config.json
# from the environment (SUPABASE_URL, SUPABASE_ANON_KEY, DOMAIN, INSTANCE_NAME,
# ...), and the app reads it before mounting.
#
# The VITE_* build args are optional. A value passed here is inlined into the
# bundle and serves as the fallback for a key /config.json leaves out; images
# published for every instance are built without them.
# =============================================================================

ARG NODE_VERSION=24

# --- build stage -------------------------------------------------------------
# The bundle is architecture-independent: one native build feeds every platform.
FROM --platform=${BUILDPLATFORM:-linux} node:${NODE_VERSION}-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# An ARG passed no value stays out of the environment, so Vite sees it unset.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_DOMAIN
ARG VITE_INSTANCE_DOMAIN
ARG VITE_INSTANCE_NAME
ARG VITE_APP_URL
ARG VITE_FEDERATION_URL
ARG VITE_STORAGE_DOMAIN
ARG VITE_HARMONY_ALT_DOMAINS
ARG VITE_TERMS_URL
ARG VITE_PRIVACY_URL
ARG VITE_ENABLED_OAUTH_PROVIDERS

COPY . .
RUN npm run build-only

# --- serve stage -------------------------------------------------------------
FROM nginx:alpine AS serve
COPY --from=build /app/dist /usr/share/nginx/html
COPY self-host/web-nginx.conf /etc/nginx/conf.d/default.conf
COPY self-host/web-entrypoint.d/40-harmony-config.sh /docker-entrypoint.d/40-harmony-config.sh
RUN chmod 0755 /docker-entrypoint.d/40-harmony-config.sh
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1
