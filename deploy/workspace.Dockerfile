# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89

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
# OPENCODE_VERSION tracks DEFAULT_OPENCODE_VERSION and SYSTEMATIC_VERSION tracks
# DEFAULT_SYSTEMATIC_VERSION in packages/runtime/src/shared/constants.ts.

# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:24.16.0-alpine@sha256:2bdb65ed1dab192432bc31c95f94155ca5ad7fc1392fb7eb7526ab682fa5bf14 AS build

WORKDIR /workspace

RUN corepack enable

# Workspace root manifests first (layer-cache friendly)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./

# Only the workspace-agent package is needed (it has no @fro-bot/runtime dep)
COPY apps/workspace-agent/ apps/workspace-agent/

RUN pnpm install --frozen-lockfile --filter @fro-bot/workspace-agent...

RUN pnpm --filter @fro-bot/workspace-agent build

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:24.16.0-alpine@sha256:2bdb65ed1dab192432bc31c95f94155ca5ad7fc1392fb7eb7526ab682fa5bf14 AS runtime

WORKDIR /app

# Pinned tool versions (track the runtime constants noted in the header).
ARG OPENCODE_VERSION=1.14.41
ARG SYSTEMATIC_VERSION=2.24.0

# System packages:
#   git            — clone.ts runs `git clone` via execFile
#   ca-certificates — entrypoint runs update-ca-certificates to trust the mitmproxy CA
#   libgcc/libstdc++/ripgrep — required by the opencode musl binary (matches OpenCode's own image)
#   curl           — fetch the opencode binary at build time
RUN apk add --no-cache git ca-certificates libgcc libstdc++ ripgrep curl

# Bake the OpenCode CLI, selecting the musl variant for the target architecture.
# TARGETARCH is provided automatically by BuildKit (amd64 | arm64). amd64 uses
# the AVX2-independent baseline variant (so the image runs on any x86 host
# regardless of the builder's CPU features); arm64 has no baseline concept.
# These are the same variants OpenCode's own image ships.
ARG TARGETARCH
RUN case "${TARGETARCH}" in \
      amd64) oc_asset="opencode-linux-x64-baseline-musl" ;; \
      arm64) oc_asset="opencode-linux-arm64-musl" ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/${oc_asset}.tar.gz" \
      | tar -xz -C /usr/local/bin \
    && chmod 755 /usr/local/bin/opencode \
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

WORKDIR /app/apps/workspace-agent

ENTRYPOINT ["/usr/local/bin/workspace-entrypoint.sh"]
