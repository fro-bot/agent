---
title: "feat: Workspace executor image — make /fro-bot add-project and the mention loop work end-to-end"
type: feat
status: active
date: 2026-06-01
origin: docs/plans/2026-04-18-001-feat-fro-bot-gateway-discord-v1-plan.md
---

# feat: Workspace executor image

## Overview

The deployed `workspace` Docker service is still a placeholder (`FROM node:24-alpine` + `sleep infinity`). Nothing listens on `:9100`, so when `/fro-bot add-project` POSTs to `http://workspace:9100/clone` it fails with `network-error`, and the `@fro-bot` mention loop has no OpenCode server to attach to. The application code already exists and is shipped (`apps/workspace-agent/`): a single Node entrypoint that supervises the clone API (9100), a loopback OpenCode SDK server (54321), and a bearer-token proxy (9200), with graceful SIGTERM drain.

This plan turns `deploy/workspace.Dockerfile` from an idle container into a real executor image that builds and runs that service — unblocking both `/fro-bot add-project` (clone) and the mention loop (OpenCode) in one PR.

## Problem Frame

Confirmed live on Fronomenal Discord against gateway v0.46.3: full add-project path works (URL validation ✓, S3 binding PRE_FLIGHT ✓ — the #713 fix) up to the clone hand-off, then fails because the workspace service runs `sleep infinity` instead of the real Hono service. The clone code, OpenCode-server launcher, and bearer proxy are all shipped and tested; the gap is purely the image build + compose/CI wiring (see origin: `docs/plans/2026-04-18-001-feat-fro-bot-gateway-discord-v1-plan.md`, "Deferred to Separate Tasks" L74, and the Unit 6 plan's Unit 1 file list, which shipped the code but not the Dockerfile/compose changes).

## Requirements Trace

- R1. The deployed `workspace` service listens on `:9100` and serves `POST /clone`, so `/fro-bot add-project` completes a real repo clone.
- R2. The workspace container runs the OpenCode SDK server (loopback) + bearer proxy (`:9200`) so the mention loop can attach.
- R3. The OpenCode CLI (pinned 1.14.41) is available on `PATH` inside the image, baked at build time.
- R4. Outbound TLS through mitmproxy works for **all** workspace egress clients — `git`/libcurl and the Bun-compiled `opencode` — not just Node's `fetch`.
- R5. Port model preserved: `9100`/`9200` are `sandbox-net`-reachable but never host-published; `54321` is loopback-only.
- R6. No standing git credentials baked into the image; the clone path keeps using per-request `GIT_ASKPASS` tokens from the gateway.
- R7. CI proves the image builds and boots far enough to serve `/healthz`, mirroring the existing `gateway-smoke` guard.

## Scope Boundaries

- No change to `apps/workspace-agent/` application code — it is already complete (the smoke test may surface a defect; fix only if found).
- No oMo / oh-my-openagent in the workspace image — disable-omo-by-default shipped; the workspace uses OpenCode's built-in `build` agent plus the `@fro.bot/systematic` plugin only.
- No transparent-proxy / iptables / privileged-container changes — the regular-proxy-mode sandbox model is unchanged.
- No new host-published ports.

### Deferred to Separate Tasks

- **mitmproxy egress allowlist hardening to a minimal, profiled set** — this PR establishes CA trust and tunes the allowlist for *observed known hosts* (github.com, githubusercontent, the configured object-store host, the LLM provider). Tightening to a fully profiled minimal set is a fast-follow once real OpenCode sessions reveal the complete egress fingerprint.
- **Summaries bridge** (the master plan's literal "Unit 7") — unrelated cross-surface context feature, tracked separately.

## Context & Research

### Relevant Code and Patterns

- `apps/workspace-agent/src/main.ts` — the 3-process supervisor + SIGTERM drain; `CMD` target is `node dist/main.mjs`. Exits 1 if `WORKSPACE_OPENCODE_TOKEN` is missing.
- `apps/workspace-agent/src/opencode-server.ts:101` — spawns `opencode` **from PATH** (`opencode serve --hostname 127.0.0.1 --port 54321`); 15s readiness poll. Clone API boots independently — OpenCode failure only flips a `/healthz` status field.
- `apps/workspace-agent/src/clone.ts` — `git clone` via `execFile` with per-request `GIT_ASKPASS`; atomic rename; path confinement.
- `apps/workspace-agent/package.json` — `build` = `tsc -p tsconfig.json --noEmit && tsdown` → `dist/main.mjs`; runtime deps only `hono` + `@hono/node-server` (no `@fro-bot/runtime` dependency — build is standalone, simpler than the gateway).
- `deploy/gateway.Dockerfile` — the multi-stage Alpine build/runtime template to mirror (corepack pnpm, `--filter` install, copy `dist/`, pinned digest base, `CMD ["node","dist/main.mjs"]`).
- `deploy/compose.yaml:168-204` — the `workspace` service; `:133-134` — the `gateway` already mounts `mitmproxy-certs`; the `workspace` does **not**. `:206-243` — mitmproxy sidecar + CA healthcheck. `:245-256` — volumes + networks.
- `.github/workflows/ci.yaml:236-279` — `gateway-smoke` job template; `:49` — the `deploy/**` paths-filter already triggers review jobs on these files (no filter change needed).

### Institutional Learnings

- `docs/solutions/performance-issues/tool-binary-caching-ephemeral-runners.md` — bake tool binaries into the image; do not runtime-install in the hot path.
- `docs/solutions/best-practices/versioned-tool-config-plugin-pattern-2026-03-29.md` — the `@fro.bot/systematic` plugin is declared via OpenCode config, not a separate install step. Reuse this pattern for the workspace OpenCode config.
- OpenCode version pin (project memory): `DEFAULT_OPENCODE_VERSION = 1.14.41`; 1.14.42+ regresses the SSE stream. The workspace must pin the same version.

### External References (verified against the cloned OpenCode source at `.slim/clonedeps/repos/anomalyco__opencode/`)

- OpenCode's installer detects Alpine (`/etc/alpine-release`, `ldd … musl`) and ships `opencode-linux-x64-musl.tar.gz`. Its **own** production Dockerfile is `FROM alpine` + `apk add libgcc libstdc++ ripgrep`. Alpine/musl is a first-class target — confirmed, high confidence.
- `opencode serve` is part of the same binary (`src/cli/cmd/serve.ts`).
- OpenCode is Bun-compiled with `--use-system-ca` and checks `HTTP(S)_PROXY` (`src/util/network.ts`); docs state it "respects standard proxy environment variables." Proxy honoring — confirmed, medium-high confidence. **`--use-system-ca` means it reads the system CA bundle, not `NODE_EXTRA_CA_CERTS`** — load-bearing for R4.

## Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| **Single PR, full executor** (clone + OpenCode + proxy) | `main.ts` already co-supervises all three with graceful OpenCode degradation; a clone-only image would mean *modifying tested code* to disable the supervisor, and `main.ts` exits without the OpenCode token regardless. Splitting is pure overhead. (Council: unanimous.) |
| **Base `node:24-alpine`** (same pinned digest as gateway) | OpenCode's own image is Alpine; it ships a musl binary and detects Alpine. Matches the gateway base and the existing placeholder. (Council: resolved by source evidence over the general musl prior.) |
| **Bake OpenCode 1.14.41 at build time** via the direct musl `tar.gz` (not npm) | Deterministic; avoids the npm-install-hang failure class we pinned around; runtime install would race the mitmproxy CA gate inside the sandbox. (Council: unanimous.) |
| **System-CA trust via entrypoint, not `NODE_EXTRA_CA_CERTS` alone** | `git`/libcurl and `opencode --use-system-ca` read the **system** CA bundle. The gateway's env-var shortcut is insufficient here. Entrypoint copies the mitmproxy CA into `/usr/local/share/ca-certificates/` and runs `update-ca-certificates` to regenerate the merged bundle (base CAs + mitmproxy). This is the genuine highest risk — it would silently fail clone-through-proxy otherwise. |
| **Mount `mitmproxy-certs` at a dedicated read-only path** (e.g. `/run/mitmproxy-certs:ro`), not over `/etc/ssl/certs` | `update-ca-certificates` must write the merged bundle into the container's own `/etc/ssl/certs`. Mounting the CA volume *over* that dir (as the gateway does) would make it read-only and drop the base CA set. Reading the single cert from a separate path preserves both base + mitmproxy trust. |
| **`@fro.bot/systematic` declared via baked workspace OpenCode config** | Reuses the config-declared plugin pattern. The plugin is needed only by the mention-loop agent, not the clone path. |
| **Also set `NODE_EXTRA_CA_CERTS`** for the Node processes (Hono + proxy) | Belt-and-suspenders: the system-CA update covers git/opencode; the env var covers Node's `fetch`/`https` without relying on the merged bundle. |
| **`workspace-smoke` CI job mirroring `gateway-smoke`** | Build image, `docker run` with a dummy token + `NO_PROXY`, assert `:9100` listening + `/healthz` 200 (proving the clone path boots independently of OpenCode) and no `ERR_MODULE_NOT_FOUND` / `opencode` ENOENT. (Council: unanimous.) |

## Open Questions

### Resolved During Planning

- **Base image musl vs glibc** — Alpine/musl, confirmed against OpenCode source (its own Dockerfile is Alpine).
- **Does `opencode` honor `HTTPS_PROXY`?** — Yes (Bun runtime + `src/util/network.ts` + docs), medium-high confidence; the smoke test and first real session validate it empirically.
- **Why the gateway's CA approach is insufficient** — git/opencode read the system bundle, not `NODE_EXTRA_CA_CERTS`; resolved via entrypoint `update-ca-certificates`.
- **Is `@fro.bot/systematic` needed for add-project?** — No; clone is pure git. It is needed for the mention-loop agent and is declared via the workspace OpenCode config.

### Deferred to Implementation

- **Exact `@fro.bot/systematic` bake mechanism** — declare-and-reify-on-first-boot vs pre-populate the OpenCode package cache at build. Prefer build-time pre-population to avoid runtime npm through the proxy, but the exact path is settled when wiring the workspace OpenCode config and seeing how the server resolves the plugin. Does not block the clone path.
- **Final allowlist host set** — tune by observing mitmproxy `BLOCKED` lines from a real OpenCode session; ship permissive-logged for unknowns, gate merge only on known hosts resolving.
- **Whether `/healthz` should gate `opencode: 'ready'` for the smoke** — the clone path is independent, so the smoke asserts `:9100`/`/healthz` reachable with OpenCode possibly `'down'` under `NO_PROXY`; confirm the exact assertion when the job runs.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
deploy/workspace.Dockerfile  (multi-stage, Alpine)
  Stage build:  corepack pnpm → install --filter @fro-bot/workspace-agent...
                → pnpm --filter @fro-bot/workspace-agent build  → dist/main.mjs
  Stage runtime: apk add git ca-certificates libgcc libstdc++ ripgrep
                 → curl opencode-linux-x64-musl.tar.gz (v1.14.41) → /usr/local/bin/opencode
                 → copy dist/main.mjs + node_modules
                 → bake workspace OpenCode config declaring @fro.bot/systematic
                 → COPY workspace-entrypoint.sh
                 → ENTRYPOINT ["workspace-entrypoint.sh"]

workspace-entrypoint.sh  (runs at container start)
  wait for /run/mitmproxy-certs/mitmproxy-ca-cert.pem to exist
  → cp → /usr/local/share/ca-certificates/mitmproxy.crt
  → update-ca-certificates                 # merged bundle: base + mitmproxy
  → export NODE_EXTRA_CA_CERTS=...          # Node fetch/https
  → exec node dist/main.mjs                 # the existing 3-process supervisor

compose workspace service
  build: real Dockerfile
  + mount mitmproxy-certs at /run/mitmproxy-certs:ro   # NEW (currently missing)
  + NODE_EXTRA_CA_CERTS env                            # NEW
  + healthcheck: GET /healthz                          # NEW
  ports: none published   54321 loopback   9100/9200 sandbox-net only   (unchanged)

Egress clients inside workspace → mitmproxy:8080 (HTTPS_PROXY) → allowlist
  git (libcurl) ─┐
  opencode (Bun) ─┼─ all trust the merged system CA bundle
  node fetch     ─┘   (node also via NODE_EXTRA_CA_CERTS)
```

## Implementation Units

- [ ] **Unit 1: Workspace executor Dockerfile**

**Goal:** Replace the placeholder with a multi-stage Alpine image that builds `apps/workspace-agent` and bakes OpenCode 1.14.41 (musl) + the system packages the clone/OpenCode paths need.

**Requirements:** R1, R2, R3, R6

**Dependencies:** None

**Files:**
- Modify: `deploy/workspace.Dockerfile`

**Approach:**
- Mirror `deploy/gateway.Dockerfile` structure (pinned digest base, corepack pnpm, layer-cache-friendly manifest copy).
- Build stage: copy root manifests + `packages/runtime/` is **not** needed (workspace-agent has no runtime dep) — copy `apps/workspace-agent/`, `pnpm install --frozen-lockfile --filter @fro-bot/workspace-agent...`, `pnpm --filter @fro-bot/workspace-agent build`.
- Runtime stage: `apk add --no-cache git ca-certificates libgcc libstdc++ ripgrep curl`; download `opencode-linux-x64-musl.tar.gz` for the pinned version, extract `opencode` to `/usr/local/bin`, `chmod +x`; copy `dist/main.mjs` + production `node_modules`; bake the workspace OpenCode config declaring `@fro.bot/systematic`; `COPY` the entrypoint (Unit 2); set `ENTRYPOINT`.
- Pin the OpenCode version to match `DEFAULT_OPENCODE_VERSION` (1.14.41) — keep it a single build ARG so it tracks the constant.

**Patterns to follow:**
- `deploy/gateway.Dockerfile` multi-stage layout + pinned digests.
- OpenCode's own Alpine Dockerfile package set (`libgcc libstdc++ ripgrep`).

**Test scenarios:**
- Test expectation: none (Dockerfile) — behavior is proven by the Unit 4 smoke job, not unit tests.

**Verification:**
- `docker build -f deploy/workspace.Dockerfile .` succeeds; `opencode --version` inside the image prints `1.14.41`; `git --version` resolves; `node dist/main.mjs` is the launch target.

- [ ] **Unit 2: CA-trust entrypoint script**

**Goal:** Make outbound TLS through mitmproxy work for git/opencode (system CA bundle) before the supervisor starts.

**Requirements:** R4

**Dependencies:** Unit 1

**Files:**
- Create: `deploy/workspace-entrypoint.sh`

**Approach:**
- Block until the mounted mitmproxy CA file exists (bounded wait with a clear timeout/error — the compose healthcheck already gates start, but the cert path must be present before `update-ca-certificates`).
- Copy the CA into `/usr/local/share/ca-certificates/mitmproxy.crt`; run `update-ca-certificates` (regenerates `/etc/ssl/certs/ca-certificates.crt` = base + mitmproxy).
- Export `NODE_EXTRA_CA_CERTS` to the merged bundle for the Node processes.
- `exec node dist/main.mjs` so the supervisor becomes PID 1 (SIGTERM drain in `main.ts` works).

**Patterns to follow:**
- The CA-trust intent documented in the current `deploy/workspace.Dockerfile` header comment; the gateway's `NODE_EXTRA_CA_CERTS` usage in compose.

**Test scenarios:**
- Test expectation: none (shell entrypoint) — exercised by the Unit 4 smoke job (which runs with `NO_PROXY` and a fabricated/absent CA path; the script must degrade sanely when no CA is mounted in the smoke context).

**Verification:**
- In a composed stack, `docker exec workspace git clone https://github.com/octocat/Hello-World /tmp/t` succeeds (no `SSL certificate problem`); the smoke job (no CA mounted) still reaches `:9100` listening.

- [ ] **Unit 3: Compose wiring for the real workspace**

**Goal:** Wire the workspace service to the real image with CA trust and a health gate, preserving the sandbox port model.

**Requirements:** R1, R4, R5

**Dependencies:** Unit 1, Unit 2

**Files:**
- Modify: `deploy/compose.yaml`

**Approach:**
- Mount `mitmproxy-certs` read-only at a dedicated path (e.g. `/run/mitmproxy-certs:ro`) — **not** over `/etc/ssl/certs` (so `update-ca-certificates` can write the merged bundle).
- Add `NODE_EXTRA_CA_CERTS` env for the Node side.
- Add a `/healthz` healthcheck on the workspace (wget/nc TCP probe to 9100 or HTTP 200), so dependents and operators can gate on readiness — mirror the gateway's healthcheck shape.
- Confirm: no `ports:` entries (9100/9200 sandbox-net-only, 54321 loopback), `depends_on: mitmproxy healthy` (already present), `WORKSPACE_OPENCODE_TOKEN_FILE` mount (already present).

**Patterns to follow:**
- `gateway` service `mitmproxy-certs` mount + `NODE_EXTRA_CA_CERTS` + `HEALTHCHECK` shape; `create_host_path: false` convention for any new bind mounts.

**Test scenarios:**
- Test expectation: none (compose config) — validated by a local `docker compose config` parse and the Unit 4 image smoke; full-stack clone is the manual acceptance check.

**Verification:**
- `docker compose -f deploy/compose.yaml config` parses; workspace builds from the real Dockerfile; no host ports published; CA volume mounted at the dedicated path.

- [ ] **Unit 4: `workspace-smoke` CI job**

**Goal:** Prove the image builds and the clone path boots independently of OpenCode, guarding against module-resolution and missing-binary regressions.

**Requirements:** R7

**Dependencies:** Unit 1, Unit 2

**Files:**
- Modify: `.github/workflows/ci.yaml`

**Approach:**
- Add a `workspace-smoke` job mirroring `gateway-smoke` (`needs: [setup]`, same `if` gating on push/should-build).
- Build the workspace image; `docker run` with `-e WORKSPACE_OPENCODE_TOKEN=dummy -e NO_PROXY='*'` under a `timeout`.
- Assert the process logs `workspace-agent listening on 0.0.0.0:9100`; probe `/healthz` returns 200 (clone path up even if `opencode` status is `down` without egress).
- Assert no `ERR_MODULE_NOT_FOUND` and no `opencode` `ENOENT`/spawn failure in output (proves the binary is on PATH).
- Note: `main.ts` exits 1 without the token, so the dummy token is required for the container to stay up.

**Patterns to follow:**
- `.github/workflows/ci.yaml:236-279` `gateway-smoke` job verbatim shape (timeout handling, exit-status checks, grep assertions).

**Test scenarios:**
- Happy path: image boots → `:9100` listening + `/healthz` 200 → job passes.
- Error path: missing `opencode` on PATH → `ENOENT` in logs → job fails.
- Error path: bundle/module resolution broken → `ERR_MODULE_NOT_FOUND` → job fails.
- Edge case: boot hang → `timeout` exit 124 → job fails (mirror gateway-smoke).

**Verification:**
- The job runs on this PR (the `deploy/**` + `ci.yaml` changes trigger it), builds the image, and passes the assertions.

- [ ] **Unit 5: Deploy docs**

**Goal:** Document that the workspace is now a real executor: the OpenCode token requirement, the `OBJECT_STORE_HOSTS` allowlist relationship, and the CA-trust behavior.

**Requirements:** R1, R4

**Dependencies:** Unit 1-3

**Files:**
- Modify: `deploy/README.md`
- Modify: `apps/workspace-agent/AGENTS.md` (note the image now builds + runs the service; entrypoint CA step)

**Approach:**
- Update the workspace section: image now builds OpenCode + the clone service; the `workspace-opencode-token` secret is required; egress goes through mitmproxy and the CA is trusted at entrypoint; set `OBJECT_STORE_HOSTS` for the deployment's bucket host.
- Keep it operational and first-person-neutral (no session/process narration).

**Patterns to follow:**
- Existing `deploy/README.md` secret/migration sections; the "When adding a new optional secret" style.

**Test scenarios:**
- Test expectation: none (docs).

**Verification:**
- markdownlint clean; the workspace setup steps are accurate against the final compose/Dockerfile.

## System-Wide Impact

- **Interaction graph:** Gateway `program.ts` clone handoff (`workspaceAgentUrl`) and mention loop (`workspaceOpencodeUrl` + token) both depend on this image. No gateway code changes — it is already pointed at `workspace:9100`/`9200`.
- **Error propagation:** OpenCode-server boot failure must remain non-fatal to the clone path (`/healthz` flips `opencode: 'down'`, `:9100` stays up). The entrypoint must not abort the supervisor on a missing CA in non-sandbox contexts (smoke).
- **State lifecycle risks:** `/workspace/repos` must be writable by the runtime user; the askpass temp-dir cleanup (`asyncCleanupAllAskpassDirs`) runs on SIGTERM — entrypoint must `exec` so the supervisor is PID 1.
- **API surface parity:** none — no new public API; the clone/proxy contracts are unchanged.
- **Integration coverage:** the smoke job proves boot + clone-path independence; full clone-through-proxy and a real mention session are manual acceptance checks (and the genuine validation of R4's git/opencode CA trust + proxy honoring).
- **Unchanged invariants:** port model (9100/9200 sandbox-net, 54321 loopback, none host-published); per-request `GIT_ASKPASS` credentials (no standing creds); mitmproxy regular-proxy-mode sandbox; `apps/workspace-agent/` source.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| **git/libcurl + `opencode` ignore `NODE_EXTRA_CA_CERTS`, breaking clone-through-proxy** (highest risk) | Entrypoint installs the CA into the system store via `update-ca-certificates`; manual `git clone` through the composed stack is the acceptance check. |
| OpenCode binary incompatible with Alpine/musl | Resolved: OpenCode ships a musl binary and its own image is Alpine; smoke job's spawn check catches a regression. |
| `opencode` doesn't honor `HTTPS_PROXY` → LLM calls blackhole on `internal` net | Medium-high confidence it does (Bun + `network.ts` + docs); validated by a real mention session post-merge; fast-follow if not. |
| Allowlist blocks a needed host → clone or OpenCode egress fails | Tune observed hosts in this PR; ship permissive-logged for unknowns; gate merge only on known hosts. |
| `@fro.bot/systematic` reify hangs on first boot through the proxy | Prefer build-time bake of the plugin into the OpenCode package cache; clone path is unaffected regardless. |
| Image size / build time grows | Multi-stage build discards the toolchain; acceptable for a long-running service image. |

## Documentation / Operational Notes

- Operators must populate `deploy/secrets/workspace-opencode-token` (already documented) and set `OBJECT_STORE_HOSTS` for their bucket host.
- After merge, the canonical validation is a real `/fro-bot add-project <repo-url>` on a deployed stack completing the clone, then an `@fro-bot` mention exercising the OpenCode loop.
- Infra deploys from a git ref; this rides the normal release (a minor bump) — no special backport unless infra needs it on the 0.46.x line.

## Sources & References

- **Origin document:** `docs/plans/2026-04-18-001-feat-fro-bot-gateway-discord-v1-plan.md` (workspace image deferral)
- Unit 6 plan: `docs/plans/2026-05-30-001-feat-gateway-unit-6-mention-loop-plan.md` (shipped the workspace-agent code)
- Code: `apps/workspace-agent/src/{main,server,clone,opencode-server,opencode-proxy}.ts`, `deploy/{gateway.Dockerfile,workspace.Dockerfile,compose.yaml}`, `.github/workflows/ci.yaml:236-279`
- OpenCode source (verified): `.slim/clonedeps/repos/anomalyco__opencode/{install,packages/opencode/Dockerfile,src/util/network.ts,src/cli/cmd/serve.ts}`
- Council scope review + empirical musl/proxy/CA verification (this session)
