# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:24.17.0-alpine@sha256:156b55f92e98ccd5ef49578a8cea0df4679826564bad1c9d4ef04462b9f0ded6 AS build

WORKDIR /workspace

ARG BUN_VERSION=1.3.14

# Install Bun (matches packageManager: bun@${BUN_VERSION})
RUN npm i -g bun@${BUN_VERSION}

# Copy workspace root manifests first (layer-cache friendly)
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./

# Copy every workspace package manifest so `bun install --frozen-lockfile` can
# validate the full workspace graph against bun.lock. Bun (unlike pnpm) checks
# the complete manifest set even for a filtered install, so a missing manifest
# reads as lockfile drift and fails the frozen install.
COPY apps/action/package.json apps/action/package.json
COPY apps/workspace-agent/package.json apps/workspace-agent/package.json
COPY packages/runtime/package.json packages/runtime/package.json
COPY packages/gateway/package.json packages/gateway/package.json
COPY packages/harness/package.json packages/harness/package.json

# Install the full workspace (including devDependencies). The build typechecks
# test files (which import vitest) and runs tsc/tsdown, so the build toolchain
# and dev dependencies must be present. A filtered install omits root
# devDependencies and breaks the typecheck.
RUN bun install --frozen-lockfile

# Copy the source for the packages we actually build
COPY packages/runtime/ packages/runtime/
COPY packages/gateway/ packages/gateway/

# Build runtime first (gateway depends on it)
RUN bun run --filter @fro-bot/runtime build

# Build gateway
RUN bun run --filter @fro-bot/gateway build

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:24.17.0-alpine@sha256:156b55f92e98ccd5ef49578a8cea0df4679826564bad1c9d4ef04462b9f0ded6 AS runtime

WORKDIR /app

# Copy production node_modules from build stage
COPY --from=build /workspace/node_modules ./node_modules
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
