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
FROM node:24.16.0-alpine@sha256:fb71d01345f11b708a3553c66e7c74074f2d506400ea81973343d915cb64eef0 AS build

WORKDIR /workspace

RUN corepack enable

# Workspace root manifests first (layer-cache friendly)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./

# Only the workspace-agent package is needed (it has no @fro-bot/runtime dep)
COPY apps/workspace-agent/ apps/workspace-agent/

RUN pnpm install --frozen-lockfile --filter @fro-bot/workspace-agent...

RUN pnpm --filter @fro-bot/workspace-agent build

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:24.16.0-alpine@sha256:fb71d01345f11b708a3553c66e7c74074f2d506400ea81973343d915cb64eef0 AS runtime

WORKDIR /app

# Pinned tool versions (track the runtime constants noted in the header).
# OPENCODE_VERSION is the harness build of OpenCode (fro-bot/agent releases),
# in the form <base>+harness.<sha>. Bumped in lockstep with the action default
# by the harness-release workflow; merge the auto-PR to advance both surfaces.
ARG OPENCODE_VERSION=1.17.3+harness.94c10df9
ARG SYSTEMATIC_VERSION=2.31.0

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
    && curl -fsSL --retry 3 --retry-delay 2 -o "/tmp/${oc_asset}.tar.gz" "${base_url}/${oc_asset}.tar.gz" \
    && curl -fsSL --retry 3 --retry-delay 2 -o /tmp/SHA256SUMS "${base_url}/SHA256SUMS" \
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
