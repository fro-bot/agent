# Workspace executor image.
#
# Builds apps/workspace-agent (clone API + OpenCode SDK server + bearer proxy)
# and bakes the OpenCode CLI so the deployed workspace can actually serve
# /clone (for /fro-bot add-project) and host an OpenCode server (for the
# @fro-bot mention loop).
#
# Port model (enforced by main.ts + compose, not published here):
#   - 9100 (Hono API: /healthz, /clone) — sandbox-net reachable
#   - 9200 (OpenCode bearer-token proxy) — sandbox-net reachable (gateway attaches here)
#   - 54321 (raw OpenCode SDK server) — loopback (127.0.0.1) ONLY, never exposed
#
# OPENCODE_VERSION pins the harness OpenCode build for the workspace image
# (from fro-bot/agent releases, bumped in lockstep with the action default by
# the harness-release workflow; the merge gate on the auto-PR is the control).
# SYSTEMATIC_VERSION tracks DEFAULT_SYSTEMATIC_VERSION in
# packages/runtime/src/shared/constants.ts.

# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:24.17.0-alpine@sha256:156b55f92e98ccd5ef49578a8cea0df4679826564bad1c9d4ef04462b9f0ded6 AS build

WORKDIR /workspace

ARG BUN_VERSION=1.3.14

# curl + unzip to fetch and extract the verified Bun release archive.
RUN apk add --no-cache curl unzip

# Install Bun from the official oven-sh/bun GitHub release, verified against the
# release SHASUMS256.txt fail-closed — matching the verified-binary posture used
# for the OpenCode install below (and CI's oven-sh/setup-bun), rather than
# pulling the unverified `bun` npm wrapper. TARGETARCH is provided automatically
# by BuildKit; x64 uses the AVX2-independent baseline+musl variant so the image
# runs on any x86 host, arm64 uses the musl variant. Both are musl for Alpine.
#
# Any download failure, checksum-fetch failure, missing entry, or hash mismatch
# aborts the build (no fallback, no retry-around-mismatch).
#
# NOTE: keep this block in sync with the same block in deploy/gateway.Dockerfile.
ARG TARGETARCH
RUN set -euo pipefail \
    # Validate the version before URL interpolation (parity with the OpenCode block).
    && case "${BUN_VERSION}" in \
         *[!0-9A-Za-z._-]*) echo "BUN_VERSION contains disallowed characters: ${BUN_VERSION}" >&2; exit 1 ;; \
         [0-9]*.[0-9]*.[0-9]*) : ;; \
         *) echo "BUN_VERSION is not a semver-like version: ${BUN_VERSION}" >&2; exit 1 ;; \
       esac \
    && case "${TARGETARCH}" in \
         amd64) bun_asset="bun-linux-x64-musl-baseline" ;; \
         arm64) bun_asset="bun-linux-aarch64-musl" ;; \
         *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
       esac \
    && bun_base="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}" \
    && curl -fsSL --connect-timeout 30 --max-time 120 --retry 3 --retry-delay 2 -o "/tmp/${bun_asset}.zip" "${bun_base}/${bun_asset}.zip" \
    && curl -fsSL --connect-timeout 30 --max-time 120 --retry 3 --retry-delay 2 -o /tmp/SHASUMS256.txt "${bun_base}/SHASUMS256.txt" \
    && expected_hash="$(awk -v f="${bun_asset}.zip" '$2 == f || $2 == "./" f {print $1}' /tmp/SHASUMS256.txt)" \
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

# Workspace root manifests first (layer-cache friendly)
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

# Source for the package we actually build
COPY apps/workspace-agent/ apps/workspace-agent/

RUN bun run --filter @fro-bot/workspace-agent build

# Trim the runtime image: re-resolve node_modules to production-only so the
# final image does not carry the dev toolchain (vitest, tsdown, eslint, …). The
# full install above is required for the build typecheck (which imports vitest).
# Bun's --production does NOT prune an already-populated node_modules, so the
# workspace node_modules are removed first for a clean production-only install
# (the rm globs cover the current flat apps/* + packages/* workspace layout).
# --ignore-scripts is required: bun still runs the ROOT postinstall under
# --production (workspace mode), and that script invokes simple-git-hooks — a
# devDependency that is absent under --production, so it would fail with exit
# 127. The flag is a blanket suppression of all lifecycle scripts; that is safe
# today because no production dependency declares a postinstall, but a future
# prod dep that needs one would be silently skipped (caught only by the smoke
# tests booting the image). The runtime stage copies this trimmed tree.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
    && bun install --production --frozen-lockfile --ignore-scripts

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:24.17.0-alpine@sha256:156b55f92e98ccd5ef49578a8cea0df4679826564bad1c9d4ef04462b9f0ded6 AS runtime

WORKDIR /app

# Pinned tool versions (track the runtime constants noted in the header).
# OPENCODE_VERSION is the harness build of OpenCode (fro-bot/agent releases),
# in the form <base>+harness.<sha>. Bumped in lockstep with the action default
# by the harness-release workflow; merge the auto-PR to advance both surfaces.
ARG OPENCODE_VERSION=1.17.11+harness.bf0e9bed
ARG SYSTEMATIC_VERSION=2.32.0

# System packages:
#   git            — clone.ts runs `git clone` via execFile
#   ca-certificates — entrypoint runs update-ca-certificates to trust the mitmproxy CA
#   libgcc/libstdc++/ripgrep — required by the opencode musl binary (matches OpenCode's own image)
#   curl           — fetch the opencode binary at build time
RUN apk add --no-cache git ca-certificates libgcc libstdc++ ripgrep curl

# Bake the OpenCode CLI from the fro-bot/agent harness release.
#
# The harness build carries session/plugin/compaction patches not present in
# stock OpenCode. The workspace uses the musl variant so it runs on Alpine.
#
# TARGETARCH is provided automatically by BuildKit (amd64 | arm64). amd64 uses
# the AVX2-independent baseline variant (so the image runs on any x86 host
# regardless of the builder's CPU features); arm64 has no baseline concept.
#
# Download source: https://github.com/fro-bot/agent/releases
# Version form: <base>+harness.<sha> (e.g. 1.17.3+harness.2c9cdbd2)
#
# The '+' in the version tag is percent-encoded as '%2B' in the URL path —
# GitHub stores tags URL-encoded and a raw '+' is misread as a space.
#
# SHA256SUMS verification is fail-closed: any download failure, checksum fetch
# failure, hash mismatch, missing entry, or partial download aborts the build
# immediately with no fallback (no cached binary, no stock fallback, no retry).
ARG TARGETARCH
RUN set -euo pipefail \
    # Validate the version string before interpolation (defense-in-depth:
    # rejects path traversal, shell metacharacters, and unexpected forms).
    && case "${OPENCODE_VERSION}" in \
         *[!0-9A-Za-z.+_-]*) \
           echo "OPENCODE_VERSION contains disallowed characters: ${OPENCODE_VERSION}" >&2; exit 1 ;; \
         *+harness.*) : ;; \
         *) echo "OPENCODE_VERSION does not match expected <base>+harness.<sha> form: ${OPENCODE_VERSION}" >&2; exit 1 ;; \
       esac \
    # Fixed allowlist: only these two asset names are permitted (no free-form interpolation).
    && case "${TARGETARCH}" in \
         amd64) oc_asset="opencode-linux-x64-baseline-musl" ;; \
         arm64) oc_asset="opencode-linux-arm64-musl" ;; \
         *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
       esac \
    # Encode '+' as '%2B' for the URL path segment (GitHub tag URL encoding).
    && encoded_version="${OPENCODE_VERSION//+/%2B}" \
    && base_url="https://github.com/fro-bot/agent/releases/download/${encoded_version}" \
    # Download the asset archive and the SHA256SUMS file for this release.
    # --retry 3 --retry-delay 2: absorbs transient CDN blips; persistent 404/auth still aborts.
    && curl -fsSL --connect-timeout 30 --max-time 120 --retry 3 --retry-delay 2 -o "/tmp/${oc_asset}.tar.gz" "${base_url}/${oc_asset}.tar.gz" \
    && curl -fsSL --connect-timeout 30 --max-time 120 --retry 3 --retry-delay 2 -o /tmp/SHA256SUMS "${base_url}/SHA256SUMS" \
    # Verify the asset's SHA256 against the SHA256SUMS entry — fail closed on any mismatch.
    && expected_hash="$(awk -v f="${oc_asset}.tar.gz" '$2 == f {print $1}' /tmp/SHA256SUMS)" \
    && if [ -z "${expected_hash}" ]; then \
         echo "SHA256SUMS does not contain an entry for ${oc_asset}.tar.gz" >&2; exit 1; \
       fi \
    && actual_hash="$(sha256sum "/tmp/${oc_asset}.tar.gz" | awk '{print $1}')" \
    && if [ "${actual_hash}" != "${expected_hash}" ]; then \
         echo "SHA256 mismatch for ${oc_asset}.tar.gz: expected ${expected_hash}, got ${actual_hash}" >&2; exit 1; \
       fi \
    # Hash verified — extract, install, and confirm the binary reports its version.
    && tar -xz -C /usr/local/bin -f "/tmp/${oc_asset}.tar.gz" \
    && chmod 755 /usr/local/bin/opencode \
    && rm -f "/tmp/${oc_asset}.tar.gz" /tmp/SHA256SUMS \
    && opencode --version

# Base workspace OpenCode config: declare the Systematic plugin and disable
# autoupdate. The model and provider block are NOT baked — the entrypoint
# overlays them at runtime from WORKSPACE_OPENCODE_MODEL and
# WORKSPACE_OPENCODE_CONFIG so a deployer selects the provider/baseURL (e.g.
# cliproxyapi) and model, mirroring the action's `model` + `opencode-config`
# inputs. Only the mention-loop agent uses the plugin; clone does not.
RUN mkdir -p /root/.config/opencode \
    && printf '{\n  "$schema": "https://opencode.ai/config.json",\n  "autoupdate": false,\n  "plugin": ["@fro.bot/systematic@%s"]\n}\n' "${SYSTEMATIC_VERSION}" \
      > /root/.config/opencode/opencode.json

# Production node_modules + bundled entrypoint (mirror gateway.Dockerfile layout).
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps/workspace-agent/package.json ./apps/workspace-agent/package.json
COPY --from=build /workspace/apps/workspace-agent/dist/ ./apps/workspace-agent/dist/

# Clone target root (clone.ts writes to /workspace/repos/{owner}/{repo}).
RUN mkdir -p /workspace/repos

# CA-trust entrypoint (trusts the mitmproxy CA before launching the supervisor).
COPY deploy/workspace-entrypoint.sh /usr/local/bin/workspace-entrypoint.sh
RUN chmod 755 /usr/local/bin/workspace-entrypoint.sh

# Extracted validator/merger helpers (used by workspace-entrypoint.sh).
COPY deploy/scripts/validate-auth.mjs deploy/scripts/merge-config.mjs /usr/local/lib/workspace-scripts/

WORKDIR /app/apps/workspace-agent

ENTRYPOINT ["/usr/local/bin/workspace-entrypoint.sh"]
