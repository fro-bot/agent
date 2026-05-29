# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89

# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:24.16.0-alpine@sha256:2bdb65ed1dab192432bc31c95f94155ca5ad7fc1392fb7eb7526ab682fa5bf14 AS build

WORKDIR /workspace

# Enable corepack for pnpm
RUN corepack enable

# Copy workspace root manifests first (layer-cache friendly)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./

# Copy only the packages we need for the gateway build
COPY packages/runtime/ packages/runtime/
COPY packages/gateway/ packages/gateway/

# Install dependencies for gateway and its workspace deps only
RUN pnpm install --frozen-lockfile --filter @fro-bot/gateway...

# Build runtime first (gateway depends on it)
RUN pnpm --filter @fro-bot/runtime build

# Build gateway
RUN pnpm --filter @fro-bot/gateway build

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:24.16.0-alpine@sha256:2bdb65ed1dab192432bc31c95f94155ca5ad7fc1392fb7eb7526ab682fa5bf14 AS runtime

WORKDIR /app

# Copy production node_modules from build stage
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages/runtime/package.json ./packages/runtime/package.json
COPY --from=build /workspace/packages/runtime/dist/ ./packages/runtime/dist/
COPY --from=build /workspace/packages/gateway/package.json ./packages/gateway/package.json
COPY --from=build /workspace/packages/gateway/dist/ ./packages/gateway/dist/

WORKDIR /app/packages/gateway

# Readiness flag directory. Kept outside /tmp so static-analysis tools
# don't flag the predictable-path pattern, and so the flag survives any
# future tmpfs-mount changes to /tmp.
RUN mkdir -p /var/run/fro-bot && chmod 0700 /var/run/fro-bot

# nc is used by the healthcheck TCP probe below.
RUN apk add --no-cache netcat-openbsd

# Layered healthcheck:
#   1. Readiness flag — written by the Discord `clientReady` handler.
#   2. PID 1 alive — catches silent process death.
#   3. TCP probe to mitmproxy:8080 — catches mitmproxy crashes that leave the
#      cert file on disk but the proxy unreachable. "mitmproxy" is the compose
#      service name defined in deploy/compose.yaml; rename both together.
# The flag is cleared at process startup so a stale file from a prior run
# cannot mask a current-run failure.
HEALTHCHECK --interval=10s --timeout=3s --retries=4 --start-period=45s \
  CMD test -f /var/run/fro-bot/gateway-ready && kill -0 1 && nc -z mitmproxy 8080

CMD ["node", "dist/main.mjs"]
