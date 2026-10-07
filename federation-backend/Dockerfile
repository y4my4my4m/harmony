# =============================================================================
# Harmony federation backend image.
# =============================================================================
# Build context is federation-backend/. One image serves every role, selected
# by FEDERATION_MODE: server (HTTP on PORT, default 3001), worker (queues, no
# HTTP) or unified (both, the default).
# =============================================================================

ARG NODE_VERSION=24

# --- build stage: TypeScript -> dist ------------------------------------------
# The emitted JavaScript is architecture-independent: one native build feeds
# every platform. BUILDPLATFORM is BuildKit's; "linux" is the host platform
# under the classic builder.
FROM --platform=${BUILDPLATFORM:-linux} node:${NODE_VERSION}-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
# build-only emits despite type errors (tsc || true); CI type-checks.
RUN npm run build-only \
 && test -f dist/index.js \
 && find dist -type d -name __tests__ -prune -exec rm -rf {} + \
 && find dist -type f \( -name '*.d.ts' -o -name '*.d.ts.map' \) -delete

# --- production dependencies, on the target platform -------------------------
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# --- runtime -----------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The winston file transports write logs/ under the working directory. A volume
# mounted there must be writable by uid 1000 (node).
RUN mkdir -p logs && chown node:node logs
USER node

EXPOSE 3001

# Probes PORT. The worker serves no HTTP; compose disables this check for it.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3001)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
