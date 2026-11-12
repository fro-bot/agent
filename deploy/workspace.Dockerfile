# Workspace executor image.
#
# Builds apps/workspace-agent (clone API + bearer proxy + OpenCode V2 supervisor)
# and bakes the stock OpenCode V2 CLI so the deployed workspace can actually serve
# /clone (for /fro-bot add-project) and host an OpenCode server (for the
# @fro-bot mention loop).
#
# Port model (enforced by main.ts + compose, not published here):
#   - 9100 (Hono API: /healthz, /clone) — sandbox-net reachable
#   - 9200 (OpenCode bearer-token proxy) — sandbox-net reachable (gateway attaches here)
#   - 54321 (raw OpenCode server) — loopback (127.0.0.1) ONLY, never exposed
#
# OPENCODE_VERSION is an optional build argument that defaults to the V2 version in
# packages/runtime/src/shared/opencode-v2-pin.json. A Docker ARG default cannot be
# read from a file, so the `version-gate` stage resolves it: unset or empty means the
# pin, and any explicit value must equal the pin. The resolved version is written to
# /usr/local/share/fro-bot/opencode-version, which every later stage reads, so no
# stage can disagree with the gate. The musl asset from anomalyco/opencode is verified
# against the digest recorded in the pin file (the `opencode-v2` stage below). Build with:
#   docker build -f deploy/workspace.Dockerfile .
# SYSTEMATIC_VERSION tracks DEFAULT_SYSTEMATIC_VERSION in
# packages/runtime/src/shared/constants.ts.

# ── Stage 0: version-gate (resolves the OpenCode V2 version and refuses anything but the pin) ──
# Every other stage starts FROM this one, so a non-V2, harness or unpinned OPENCODE_VERSION fails the build here, before
# any download or package install. An unset or empty OPENCODE_VERSION means the version in the pin file. The pin file is
# bind-mounted from the build context for the check, so it does not land in any image layer; the resolved version does,
# as /usr/local/share/fro-bot/opencode-version, and the later stages and the entrypoint read it from there.
FROM node:24.22.3-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS version-gate

ARG OPENCODE_VERSION

RUN --mount=type=bind,source=packages/runtime/src/shared/opencode-v2-pin.json,target=/opt/opencode-v2-pin.json \
    set -eu \
    && pin_version="$(node -p 'JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version' /opt/opencode-v2-pin.json)" \
    && resolved="${OPENCODE_VERSION:-${pin_version}}" \
    && case "${resolved}" in \
         *[!0-9A-Za-z.+_-]*) echo "OPENCODE_VERSION contains disallowed characters: ${resolved}" >&2; exit 1 ;; \
         *harness*) echo "OPENCODE_VERSION ${resolved} is a retired V1 harness build: this image runs OpenCode V2 only; omit the build-arg to build the pin in packages/runtime/src/shared/opencode-v2-pin.json" >&2; exit 1 ;; \
         [2-9].*|[1-9][0-9]*.*) : ;; \
         *) echo "OPENCODE_VERSION ${resolved} is not an OpenCode V2 version: this image runs V2 only; omit the build-arg to build the pin in packages/runtime/src/shared/opencode-v2-pin.json" >&2; exit 1 ;; \
       esac \
    && if [ "${resolved}" != "${pin_version}" ]; then \
         echo "OPENCODE_VERSION ${resolved} is not the pinned V2 version ${pin_version} (packages/runtime/src/shared/opencode-v2-pin.json)" >&2; exit 1; \
       fi \
    && mkdir -p /usr/local/share/fro-bot \
    && printf '%s' "${resolved}" > /usr/local/share/fro-bot/opencode-version \
    && chmod 0644 /usr/local/share/fro-bot/opencode-version \
    && echo "OpenCode V2 version: ${resolved}"

# ── Stage 1: build-deps (full workspace, dev deps, workspace-agent build) ──────
# Forked into `workspace-test` below BEFORE dev dependencies are pruned, then
# continued as `build` (prune to production) for the runtime stage to copy from.
FROM version-gate AS build-deps

WORKDIR /workspace

ARG BUN_VERSION=1.4.4

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
COPY packages/opencode-plugin/package.json packages/opencode-plugin/package.json

# Install the full workspace (including devDependencies). The build typechecks
# test files (which import vitest) and runs tsc/tsdown, so the build toolchain
# and dev dependencies must be present. A filtered install omits root
# devDependencies and breaks the typecheck.
RUN bun install --frozen-lockfile

# Source for the package we actually build. The V2 runner imports @fro-bot/runtime/workspace-v2, a
# TypeScript-source workspace package that the build type-checks and bundles in, so its source comes too
# (deploy/gateway.Dockerfile does the same).
COPY apps/workspace-agent/ apps/workspace-agent/
COPY packages/runtime/ packages/runtime/

RUN bun run --filter @fro-bot/workspace-agent build

# ── Stage 1b: workspace-test (forked from build-deps BEFORE dev-dep pruning) ──
# Runs the workspace-agent test suite — including the Unit 2 adversarial
# real-git fixtures under apps/workspace-agent/src/update-fixtures/ — against
# an Alpine `apk` git, not the CI runner's git, so the fixture suite's
# transport/hook/filter/collision assertions exercise Alpine's git. It uses the
# same package source as runtime, though separate builds are not guaranteed to
# resolve an identical binary. Only reachable via `docker build --target
# workspace-test`; the default build (no --target) never builds this stage
# (BuildKit skips stages that are not ancestors of the requested target), so
# it adds zero cost to the runtime image build.
FROM build-deps AS workspace-test

# git: same package source as the runtime stage's `apk add git` below (Alpine
# apk, not a separately curl-fetched binary), so the fixtures run against
# Alpine's git rather than the CI runner's.
# openssl: CLI binary the self-signed-cert fixtures shell out to
# (generateSelfSignedCert in update-fixtures/helpers.ts). The runtime image has
# no need for the openssl CLI (only its libs, transitively, for Node/OpenCode),
# so this is confined to the test-only stage rather than added to runtime.
RUN apk add --no-cache git git-daemon openssl

# Vitest 5 does not walk up to find a config, so the suite (run with `--config ../../vitest.config.ts`) needs the
# root config plus the local modules it imports (setup file, home-isolation helper, incomplete-run reporter).
COPY vitest.config.ts ./
COPY scripts/vitest-home-isolation.ts scripts/vitest-home-isolation.setup.ts scripts/vitest-incomplete-run-reporter.ts scripts/

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

# ── Stage 1c: opencode-v2 (stock V2 binary, digest-verified) ──────────────────
# Build it alone with:
#   docker build --target opencode-v2 -f deploy/workspace.Dockerfile .
#
# The recorded digest is read from the SAME JSON file the Action's
# installOpenCode imports (packages/runtime/src/shared/opencode-v2-pin.json), with
# node — already in this base image — so no digest is hand-copied here. The archive
# must match BOTH that digest and the release's SHA256SUMS line. Any failure
# aborts the build: no fallback version, no retry-around-mismatch, no skipped check.
# The version-gate stage has already refused any OPENCODE_VERSION that is not the pinned V2 version and recorded it.
FROM version-gate AS opencode-v2

ARG TARGETARCH

COPY packages/runtime/src/shared/opencode-v2-pin.json /opt/opencode-v2-pin.json

RUN set -euo pipefail \
    && mkdir -p /out \
    # Fixed allowlist of musl assets (Alpine), keyed by TARGETARCH.
    && case "${TARGETARCH}" in \
         amd64) oc_asset="opencode-linux-x64-musl.tar.gz" ;; \
         arm64) oc_asset="opencode-linux-arm64-musl.tar.gz" ;; \
         *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
       esac \
    # Read this asset's digest from the shared JSON file.
    && recorded_hash="$(node -p 'JSON.parse(fs.readFileSync(process.argv[1], "utf8")).assets[process.argv[2]] ?? ""' /opt/opencode-v2-pin.json "${oc_asset}")" \
    && if [ "${#recorded_hash}" -ne 64 ]; then \
         echo "opencode-v2-pin.json has no valid sha256 for ${oc_asset}" >&2; exit 1; \
       fi \
    && apk add --no-cache curl \
    && oc_version="$(cat /usr/local/share/fro-bot/opencode-version)" \
    && oc_base_url="https://github.com/anomalyco/opencode/releases/download/v${oc_version}" \
    && curl -fsSL --connect-timeout 30 --max-time 120 --retry 3 --retry-delay 2 -o "/tmp/${oc_asset}" "${oc_base_url}/${oc_asset}" \
    && curl -fsSL --connect-timeout 30 --max-time 120 --retry 3 --retry-delay 2 -o /tmp/SHA256SUMS "${oc_base_url}/SHA256SUMS" \
    # The SHA256SUMS line must equal the recorded digest, and so must the archive.
    && sums_hash="$(awk -v f="${oc_asset}" '$2 == f {print $1}' /tmp/SHA256SUMS)" \
    && if [ -z "${sums_hash}" ]; then \
         echo "SHA256SUMS does not contain an entry for ${oc_asset}" >&2; exit 1; \
       fi \
    && if [ "${sums_hash}" != "${recorded_hash}" ]; then \
         echo "SHA256SUMS entry for ${oc_asset} disagrees with the recorded digest: SHA256SUMS has ${sums_hash}, recorded ${recorded_hash}" >&2; exit 1; \
       fi \
    && actual_hash="$(sha256sum "/tmp/${oc_asset}" | awk '{print $1}')" \
    && if [ "${actual_hash}" != "${recorded_hash}" ]; then \
         echo "SHA256 mismatch for ${oc_asset}: expected ${recorded_hash}, got ${actual_hash}" >&2; exit 1; \
       fi \
    && tar -xz -C /out -f "/tmp/${oc_asset}" \
    && chmod 755 /out/opencode \
    # Tell the runtime stage which version this output was verified for.
    && printf '%s' "${oc_version}" > /out/VERSION \
    && rm -f "/tmp/${oc_asset}" /tmp/SHA256SUMS

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM version-gate AS runtime

WORKDIR /app

# Pinned tool versions (track the runtime constants noted in the header).
ARG SYSTEMATIC_VERSION=3.32.3

# System packages come from the base image's Alpine 3.24 branch and are not
# pinned: the branch index drops older versions, so exact pins would break the
# build. The base image stays digest-pinned.
#   git            — clone.ts runs `git clone` via execFile
#   ca-certificates — entrypoint runs update-ca-certificates to trust the mitmproxy CA
#   libgcc/libstdc++/ripgrep — required by the opencode musl binary (matches OpenCode's own image)
#   curl           — the :9100 healthcheck probe (compose.yaml)
#   setpriv        — drops privilege to the opencode agent uid for OpenCode's
#                    own credential/config provisioning (see workspace-entrypoint.sh).
#                    Alpine's setpriv ships as part of util-linux and supports
#                    --reuid/--regid/--clear-groups directly, so no /etc/passwd
#                    lookup is required for the numeric uid/gid switch and no
#                    root supplementary group can survive the drop — see the
#                    entrypoint for the full choice rationale (setpriv vs.
#                    su-exec vs. runuser).
#   tini           — pid 1; reaps orphaned tool processes. Don't also enable
#                    `--init`/`init: true` (validate-stack.sh rejects it).
RUN apk add --no-cache \
      git \
      ca-certificates \
      libgcc \
      libstdc++ \
      ripgrep \
      curl \
      setpriv \
      tini \
    && /sbin/tini --version

# Package managers for agent tasks: Bun (the binary `build-deps` verified) and npm 12. The base's bundled npm 11,
# yarn and corepack are removed, because npm 11's own dependency tree carries HIGH CVEs that overrides can't reach
# (#2117). The V2 plugin install below uses OpenCode's in-process arborist, not this npm.
ARG NPM_VERSION=12.2.2
COPY --from=build-deps /usr/local/bin/bun /usr/local/bin/bun
RUN set -euo pipefail \
    && case "${NPM_VERSION}" in \
         *[!0-9A-Za-z._-]*) echo "NPM_VERSION contains disallowed characters: ${NPM_VERSION}" >&2; exit 1 ;; \
         [0-9]*.[0-9]*.[0-9]*) : ;; \
         *) echo "NPM_VERSION is not a semver-like version: ${NPM_VERSION}" >&2; exit 1 ;; \
       esac \
    && ln -s bun /usr/local/bin/bunx \
    && npm install -g --prefix /tmp/npm-next --cache /tmp/npm-cache \
         --ignore-scripts --no-audit --no-fund "npm@${NPM_VERSION}" \
    && rm -rf \
         /usr/local/lib/node_modules/npm \
         /usr/local/lib/node_modules/corepack \
         /opt/yarn-v* \
         /usr/local/bin/npm \
         /usr/local/bin/npx \
         /usr/local/bin/corepack \
         /usr/local/bin/yarn \
         /usr/local/bin/yarnpkg \
    && mv /tmp/npm-next/lib/node_modules/npm /usr/local/lib/node_modules/npm \
    && ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && rm -rf /tmp/npm-next /tmp/npm-cache /root/.npm /root/.cache \
    && [ "$(npm --version)" = "${NPM_VERSION}" ] \
    && [ "$(npx --version)" = "${NPM_VERSION}" ] \
    && bun --version \
    && bunx --version \
    && for tool in yarn yarnpkg corepack; do \
         if command -v "${tool}" >/dev/null 2>&1; then \
           echo "${tool} is still present after removal" >&2; exit 1; \
         fi; \
       done

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

# Bake the stock OpenCode V2 CLI that the `opencode-v2` stage verified against the digest recorded in
# opencode-v2-pin.json. The step refuses output that is missing or was verified for a different version, so every stage
# must be built from the version the gate recorded.
ARG TARGETARCH
COPY --from=opencode-v2 /out/ /tmp/opencode-v2/
RUN set -euo pipefail \
    && if [ "$(cat /tmp/opencode-v2/VERSION 2>/dev/null || true)" != "$(cat /usr/local/share/fro-bot/opencode-version)" ] || [ ! -x /tmp/opencode-v2/opencode ]; then \
         echo "no verified V2 binary for the version the gate recorded ($(cat /usr/local/share/fro-bot/opencode-version))" >&2; exit 1; \
       fi \
    && install -m 755 /tmp/opencode-v2/opencode /usr/local/bin/opencode \
    && rm -rf /tmp/opencode-v2 \
    && opencode --version

# Install the Systematic and fro-bot plugins into the agent's cache NOW, at build time, as uid 10001 and under a bound.
# The server then finds them by spec at boot with no registry access, which is what the --network none smoke test
# proves. An unbounded boot-time install would hang `GET /api/agent` for as long as the registry hangs (probe P10).
# Systematic installs at SYSTEMATIC_VERSION (declared above), and the versions must equal DEFAULT_SYSTEMATIC_VERSION
# and FRO_BOT_PLUGIN_VERSION in packages/runtime/src/shared/constants.ts; deploy/scripts/workspace-v2-image.test.mjs
# keeps them in step, and the plugin gate refuses a server whose plugins differ from what the workspace expects.
ARG FRO_BOT_PLUGIN_VERSION=0.1.0
COPY deploy/scripts/install-opencode-v2-plugins.sh /usr/local/lib/workspace-scripts/install-opencode-v2-plugins.sh
RUN sh /usr/local/lib/workspace-scripts/install-opencode-v2-plugins.sh \
      "@fro.bot/systematic@${SYSTEMATIC_VERSION}" \
      "@fro.bot/opencode-plugin@${FRO_BOT_PLUGIN_VERSION}"

# Which OpenCode this image carries, reported on /readyz. The entrypoint exports it as WORKSPACE_IMAGE_OPENCODE_VERSION
# from /usr/local/share/fro-bot/opencode-version (the file the gate wrote and the install above read), so the reported
# version and the binary cannot disagree; it is not an operator setting. The workspace agent refuses to start without a
# V2 value, and the gateway admits a run only when it reads one.

# Base workspace OpenCode config: disable updates. The model and provider block are NOT baked — the entrypoint
# overlays them at runtime from WORKSPACE_OPENCODE_MODEL and
# WORKSPACE_OPENCODE_CONFIG so a deployer selects the provider/baseURL (e.g.
# cliproxyapi) and model, mirroring the action's `model` + `opencode-config`
# inputs.
#
# Baked to a trusted, root-owned, world-readable (not writable) path OUTSIDE
# any per-uid home — NOT /root/.config, which is the service's own home and
# not a path the agent-uid provisioning step should ever need write access
# near. The entrypoint's agent-uid subprocess reads this file (world-readable
# is sufficient — no write access is needed) and writes the merged result to
# the agent's own $XDG_CONFIG_HOME.
#
# No plugin entry: the Systematic and fro-bot plugins are listed in the config content the workspace agent passes at
# spawn (and installed at build time above). The entrypoint rewrites the global file it builds from this base at every
# start, so a plugin listed only there would not survive.
RUN mkdir -p /usr/local/share/fro-bot \
    && printf '{\n  "$schema": "https://opencode.ai/config.json",\n  "update": "disable"\n}\n' \
         > /usr/local/share/fro-bot/opencode.base.json \
    && chown 0:0 /usr/local/share/fro-bot/opencode.base.json \
    && chmod 0644 /usr/local/share/fro-bot/opencode.base.json

# Managed OpenCode config (deploy/managed-config/opencode-v2.json). OpenCode loads /etc/opencode/opencode.json (the
# Linux managed config dir) last, so a root-owned file at that path is a layer the agent can add to but never remove
# from. Root-owned and 0644, in a root-owned 0755 directory (pinned by deploy/scripts/managed-config.test.mjs).
# The task-reuse guard is the fro-bot plugin, loaded from the config content the workspace agent passes at spawn.
RUN mkdir -p /etc/opencode \
    && chown 0:0 /etc/opencode \
    && chmod 0755 /etc/opencode
COPY deploy/managed-config/opencode-v2.json /etc/opencode/opencode.json
RUN chown 0:0 /etc/opencode/opencode.json \
    && chmod 0644 /etc/opencode/opencode.json

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

# tini is pid 1; the workspace-agent service is its only child (the entrypoint
# execs node), so it is NOT pid 1. Don't override this entrypoint (bypasses tini).
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/workspace-entrypoint.sh"]
