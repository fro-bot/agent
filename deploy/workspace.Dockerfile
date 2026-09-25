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

# ── Stage 1: build-deps (full workspace, dev deps, workspace-agent build) ──────
# Forked into `workspace-test` below BEFORE dev dependencies are pruned, then
# continued as `build` (prune to production) for the runtime stage to copy from.
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build-deps

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

# ── Stage 1b: workspace-test (forked from build-deps BEFORE dev-dep pruning) ──
# Runs the workspace-agent test suite — including the Unit 2 adversarial
# real-git fixtures under apps/workspace-agent/src/update-fixtures/ — against
# THIS image's own Alpine `apk` git, not the CI runner's git, so the fixture
# suite's transport/hook/filter/collision assertions exercise the exact git
# binary the runtime image ships. Only reachable via `docker build --target
# workspace-test`; the default build (no --target) never builds this stage
# (BuildKit skips stages that are not ancestors of the requested target), so
# it adds zero cost to the runtime image build.
FROM build-deps AS workspace-test

# git: same source as the runtime stage's `apk add git` below (Alpine apk, not
# a separately curl-fetched binary) — the whole point of this stage is running
# the fixtures against a git that matches what ships in runtime.
# openssl: CLI binary the self-signed-cert fixtures shell out to
# (generateSelfSignedCert in update-fixtures/helpers.ts). The runtime image has
# no need for the openssl CLI (only its libs, transitively, for Node/OpenCode),
# so this is confined to the test-only stage rather than added to runtime.
RUN apk add --no-cache git openssl

CMD ["sh", "-c", "set -e; git --version; exec bun run --filter @fro-bot/workspace-agent test"]

# ── Stage 1 (continued): build (prune dev deps to production-only) ───────────
FROM build-deps AS build

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
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime

WORKDIR /app

# Pinned tool versions (track the runtime constants noted in the header).
# OPENCODE_VERSION is the harness build of OpenCode (fro-bot/agent releases),
# in the form <base>+harness.<sha>. Bumped in lockstep with the action default
# by the harness-release workflow; merge the auto-PR to advance both surfaces.
ARG OPENCODE_VERSION=1.18.30+harness.7c479429
ARG SYSTEMATIC_VERSION=3.21.0

# System packages:
#   git            — clone.ts runs `git clone` via execFile
#   ca-certificates — entrypoint runs update-ca-certificates to trust the mitmproxy CA
#   libgcc/libstdc++/ripgrep — required by the opencode musl binary (matches OpenCode's own image)
#   curl           — fetch the opencode binary at build time
#   setpriv        — drops privilege to the opencode agent uid for OpenCode's
#                    own credential/config provisioning (see workspace-entrypoint.sh).
#                    Alpine's setpriv ships as part of util-linux and supports
#                    --reuid/--regid/--clear-groups directly, so no /etc/passwd
#                    lookup is required for the numeric uid/gid switch and no
#                    root supplementary group can survive the drop — see the
#                    entrypoint for the full choice rationale (setpriv vs.
#                    su-exec vs. runuser).
RUN apk add --no-cache git ca-certificates libgcc libstdc++ ripgrep curl setpriv

# ── Unprivileged OpenCode agent account ─────────────────────────────────────
# The workspace-agent SERVICE stays uid 0 (reduced capabilities only — see
# compose.yaml). OpenCode itself — and everything it spawns as tools — runs as
# this fixed, shared, no-login uid/gid so a compromised OpenCode/tool process
# cannot read the service's secrets or write the service's git config.
# uid/gid 10001 and the account name are a contract shared with the workspace
# agent's spawn code (apps/workspace-agent/src) — do not renumber casually.
RUN addgroup -g 10001 opencode \
    && adduser -D -H -u 10001 -G opencode -s /sbin/nologin -h /home/opencode opencode

# Agent home + XDG roots, owned by the agent, mode 0700 (no other uid — not
# even root's own reads via `docker exec` as a different user — can browse
# into it). OpenCode's own writes here (auth.json, opencode.json, cache,
# session state) happen as uid 10001 — see the entrypoint's provisioning step.
RUN mkdir -p /home/opencode/.local/share /home/opencode/.config /home/opencode/.cache /home/opencode/.local/state \
    && chown -R opencode:opencode /home/opencode \
    && chmod 0700 /home/opencode /home/opencode/.local /home/opencode/.local/share /home/opencode/.config \
        /home/opencode/.cache /home/opencode/.local/state

# The service's OWN home (root's HOME) is deliberately NOT /root and NOT
# /home/opencode — a distinct, root-only path so nothing the service itself
# writes under $HOME (e.g. global git config) lands somewhere the agent uid
# can read or tamper with, and vice versa.
RUN mkdir -p /var/lib/workspace-agent/home \
    && chown 0:0 /var/lib/workspace-agent/home \
    && chmod 0700 /var/lib/workspace-agent/home
ENV HOME=/var/lib/workspace-agent/home

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
# The version keeps +harness. build metadata while the release tag uses the
# -harness. prerelease form. Mirrors toHarnessReleaseTag() in
# src/services/setup/opencode.ts.
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
    # Derive the prerelease tag from the build-metadata version form.
    && tag_version="${OPENCODE_VERSION//+harness./-harness.}" \
    && base_url="https://github.com/fro-bot/agent/releases/download/${tag_version}" \
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

# Disable OpenCode's file watcher by default: nothing in this container consumes
# file-change events, so the watcher is pure overhead. A deployer can still
# override this through compose. Accepted consequence: OpenCode's cached VCS
# branch can go stale after a checkout, since that cache refreshes from watcher
# events (see deploy/README.md).
ENV OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER=true

# Enable OpenCode's background-subagent dispatch (task({background: true})) by
# default: the ownership-ledger, drain, and descendant-event-routing machinery
# this repo built for it is otherwise unreachable dead code. A deployer can
# still override this through compose.
ENV OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true

# Base workspace OpenCode config: declare the Systematic plugin and disable
# autoupdate. The model and provider block are NOT baked — the entrypoint
# overlays them at runtime from WORKSPACE_OPENCODE_MODEL and
# WORKSPACE_OPENCODE_CONFIG so a deployer selects the provider/baseURL (e.g.
# cliproxyapi) and model, mirroring the action's `model` + `opencode-config`
# inputs. Only the mention-loop agent uses the plugin; clone does not.
#
# Baked to a trusted, root-owned, world-readable (not writable) path OUTSIDE
# any per-uid home — NOT /root/.config, which is the service's own home and
# not a path the agent-uid provisioning step should ever need write access
# near. The entrypoint's agent-uid subprocess reads this file (world-readable
# is sufficient — no write access is needed) and writes the merged result to
# the agent's own $XDG_CONFIG_HOME.
RUN mkdir -p /usr/local/share/fro-bot \
    && printf '{\n  "$schema": "https://opencode.ai/config.json",\n  "autoupdate": false,\n  "plugin": ["@fro.bot/systematic@%s"]\n}\n' "${SYSTEMATIC_VERSION}" \
      > /usr/local/share/fro-bot/opencode.base.json \
    && chown 0:0 /usr/local/share/fro-bot/opencode.base.json \
    && chmod 0644 /usr/local/share/fro-bot/opencode.base.json

# Production node_modules + bundled entrypoint (mirror gateway.Dockerfile layout).
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps/workspace-agent/package.json ./apps/workspace-agent/package.json
COPY --from=build /workspace/apps/workspace-agent/dist/ ./apps/workspace-agent/dist/

# Clone target root (clone.ts writes to /workspace/repos/{owner}/{repo}).
# Root-owned, 0755, on purpose: only the per-repo checkout directories beneath
# it are handed to the agent uid, and only by the entrypoint's one-time
# migration for pre-existing volumes (deploy/scripts/migrate-repo-ownership.mjs)
# or by the workspace-agent's own clone path — never this parent directory.
RUN mkdir -p /workspace/repos \
    && chown 0:0 /workspace/repos \
    && chmod 0755 /workspace/repos

# CA-trust entrypoint (trusts the mitmproxy CA before launching the supervisor).
COPY deploy/workspace-entrypoint.sh /usr/local/bin/workspace-entrypoint.sh
RUN chmod 755 /usr/local/bin/workspace-entrypoint.sh

# Extracted validator/merger/provisioning helpers (used by
# workspace-entrypoint.sh). Root-owned, not writable by the agent uid — these
# run partly as root (validation, migration) and partly as the agent uid
# (config/auth provisioning), but neither identity may ever modify them.
COPY deploy/scripts/validate-auth.mjs deploy/scripts/merge-config.mjs \
     deploy/scripts/ensure-protected-dir.mjs deploy/scripts/migrate-repo-ownership.mjs \
     deploy/scripts/provision-agent-config.mjs /usr/local/lib/workspace-scripts/

WORKDIR /app/apps/workspace-agent

# Explicit and documented: the service itself always starts as root so it can
# create/validate the protected directories, install the mitmproxy CA,
# migrate legacy checkout ownership, and read root-only secret mounts. It
# drops OpenCode itself to uid 10001 before exec — see workspace-entrypoint.sh.
USER 0:0

ENTRYPOINT ["/usr/local/bin/workspace-entrypoint.sh"]
