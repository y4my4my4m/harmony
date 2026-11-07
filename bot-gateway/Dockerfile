# =============================================================================
# Harmony bot gateway image.
# =============================================================================
# Build context is bot-gateway/. REST and WebSocket gateway on PORT (default
# 3002).
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
# Alpine fixes newer than the base image. npm, npx and corepack are absent: CMD runs
# node, and npm's bundled tar, pacote and sigstore carried the image's critical CVEs.
RUN apk upgrade --no-cache \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3002)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
