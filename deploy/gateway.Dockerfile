# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:24.17.0-alpine@sha256:156b55f92e98ccd5ef49578a8cea0df4679826564bad1c9d4ef04462b9f0ded6 AS build

WORKDIR /workspace

ARG BUN_VERSION=1.3.14

# curl + unzip to fetch and extract the verified Bun release archive.
RUN apk add --no-cache curl unzip

# Install Bun from the official oven-sh/bun GitHub release, verified against the
# release SHASUMS256.txt fail-closed — matching the verified-binary posture used
# for the OpenCode install (and CI's oven-sh/setup-bun), rather than pulling the
# unverified `bun` npm wrapper. TARGETARCH is provided automatically by BuildKit;
# x64 uses the AVX2-independent baseline+musl variant so the image runs on any
# x86 host, arm64 uses the musl variant. Both are musl for Alpine.
#
# Any download failure, checksum-fetch failure, missing entry, or hash mismatch
# aborts the build (no fallback, no retry-around-mismatch).
ARG TARGETARCH
RUN set -euo pipefail \
    && case "${TARGETARCH}" in \
         amd64) bun_asset="bun-linux-x64-musl-baseline" ;; \
         arm64) bun_asset="bun-linux-aarch64-musl" ;; \
         *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
       esac \
    && bun_base="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}" \
    && curl -fsSL --retry 3 --retry-delay 2 -o "/tmp/${bun_asset}.zip" "${bun_base}/${bun_asset}.zip" \
    && curl -fsSL --retry 3 --retry-delay 2 -o /tmp/SHASUMS256.txt "${bun_base}/SHASUMS256.txt" \
    && expected_hash="$(awk -v f="${bun_asset}.zip" '$2 == f {print $1}' /tmp/SHASUMS256.txt)" \
    && if [ -z "${expected_hash}" ]; then \
         echo "SHASUMS256.txt has no entry for ${bun_asset}.zip" >&2; exit 1; \
       fi \
    && actual_hash="$(sha256sum "/tmp/${bun_asset}.zip" | awk '{print $1}')" \
    && if [ "${actual_hash}" != "${expected_hash}" ]; then \
         echo "SHA256 mismatch for ${bun_asset}.zip: expected ${expected_hash}, got ${actual_hash}" >&2; exit 1; \
       fi \
    && unzip -q "/tmp/${bun_asset}.zip" -d /tmp/bun \
    && mv "/tmp/bun/${bun_asset}/bun" /usr/local/bin/bun \
    && chmod 755 /usr/local/bin/bun \
    # bunx is bun's package-runner alias (the npm wrapper installs both); the raw
    # release archive ships only `bun`, so symlink it for `bunx tsc`/`bunx tsdown`.
    && ln -s /usr/local/bin/bun /usr/local/bin/bunx \
    && rm -rf "/tmp/${bun_asset}.zip" /tmp/SHASUMS256.txt /tmp/bun \
    && bun --version \
    && bunx --version

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

# Trim the runtime image: re-resolve node_modules to production-only so the
# final image does not carry the dev toolchain (vitest, tsdown, eslint, …). The
# full install above is required for the build typecheck (which imports vitest).
# Bun's --production does NOT prune an already-populated node_modules, so the
# workspace node_modules are removed first for a clean production-only install.
# --ignore-scripts skips the root simple-git-hooks postinstall (a devDependency
# that would otherwise fail under --production). The runtime stage copies this
# trimmed tree.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
    && bun install --production --frozen-lockfile --ignore-scripts

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
