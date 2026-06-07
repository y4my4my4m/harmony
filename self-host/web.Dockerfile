# =============================================================================
# Harmony frontend image - builds the Vue SPA and serves it with nginx.
# =============================================================================
# Build context is the repo root. VITE_* values are build-time inputs (Vite
# inlines them into the bundle), passed as build args by docker-compose.yml.
# =============================================================================

# --- build stage -------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

# Install deps first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Build-time configuration (consumed by Vite as import.meta.env.*)
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_INSTANCE_DOMAIN
ARG VITE_INSTANCE_NAME=Harmony
ARG VITE_DOMAIN
ARG VITE_APP_URL
ARG VITE_FEDERATION_API_URL
ARG VITE_LIVEKIT_URL
ARG VITE_ENABLE_FEDERATION=true
ARG VITE_ENABLE_VOICE=true
ARG VITE_ENABLE_E2E_ENCRYPTION=true
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY \
    VITE_INSTANCE_DOMAIN=$VITE_INSTANCE_DOMAIN \
    VITE_INSTANCE_NAME=$VITE_INSTANCE_NAME \
    VITE_DOMAIN=$VITE_DOMAIN \
    VITE_APP_URL=$VITE_APP_URL \
    VITE_FEDERATION_API_URL=$VITE_FEDERATION_API_URL \
    VITE_LIVEKIT_URL=$VITE_LIVEKIT_URL \
    VITE_ENABLE_FEDERATION=$VITE_ENABLE_FEDERATION \
    VITE_ENABLE_VOICE=$VITE_ENABLE_VOICE \
    VITE_ENABLE_E2E_ENCRYPTION=$VITE_ENABLE_E2E_ENCRYPTION

COPY . .
RUN npm run build-only

# --- serve stage -------------------------------------------------------------
FROM nginx:alpine AS serve
COPY --from=build /app/dist /usr/share/nginx/html
COPY self-host/web-nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
