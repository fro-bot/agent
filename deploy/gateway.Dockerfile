# syntax=docker/dockerfile:1@sha256:2780b5c3bab67f1f76c781860de469442999ed1a0d7992a5efdf2cffc0e3d769

# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:24-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS build

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
FROM node:24-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS runtime

WORKDIR /app

# Copy production node_modules from build stage
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages/runtime/package.json ./packages/runtime/package.json
COPY --from=build /workspace/packages/runtime/dist/ ./packages/runtime/dist/
COPY --from=build /workspace/packages/gateway/package.json ./packages/gateway/package.json
COPY --from=build /workspace/packages/gateway/dist/ ./packages/gateway/dist/

WORKDIR /app/packages/gateway

# Placeholder healthcheck — real HTTP health endpoint arrives in Unit 7
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e 'process.exit(0)'

CMD ["node", "dist/main.mjs"]
