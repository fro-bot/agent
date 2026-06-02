# Workspace Agent — Agent Notes

Small Hono HTTP service that runs **inside** the workspace container. The gateway daemon calls it from outside via the internal compose network (`sandbox-net`).

## Purpose

Exposes a single `POST /clone` endpoint that clones a GitHub repo into `/workspace/repos/{owner}/{repo}`. The gateway sends `{owner, repo, token}` — the agent derives the path internally and never accepts a caller-provided path.

## Security invariants

1. **Token never in argv.** Git is invoked via `execFile` with the IAT injected through a `GIT_ASKPASS` temp script. The token never appears in the process argument list.
2. **No shell interpolation.** `execFile` only — never `exec()` or `spawn(shell, ...)`.
3. **Git trace suppression.** `GIT_TRACE=0`, `GIT_CURL_VERBOSE=0`, `GIT_TRACE_PACKET=0`, `GIT_TRACE_PERFORMANCE=0` in every subprocess env.
4. **Stderr scrubbing.** `x-access-token:[^@]+@` is redacted before any error is returned or logged.
5. **Path confinement.** Owner and repo are validated against `[A-Za-z0-9._-]+`. After clone, `fs.realpath` confirms the path is within `/workspace/repos/`.
6. **Credential helper disabled.** `-c credential.helper=` prevents any operator-side git credential helper from caching the IAT.
7. **Token never logged.** No log line, error response, or test snapshot may contain the IAT.

## Port

**9100** — internal only. No `ports:` mapping in compose. Gateway reaches it as `http://workspace:9100`.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /healthz | Liveness probe — returns `{ok: true}` |
| POST | /clone | Clone a GitHub repo into the workspace |

### POST /clone

Request body:
```json
{"owner": "fro-bot", "repo": "agent", "token": "ghs_..."}
```

Success (200):
```json
{"ok": true, "path": "/workspace/repos/fro-bot/agent", "commit": "<HEAD SHA>"}
```

Conflict (409) — repo already cloned:
```json
{"ok": false, "error": "repo-exists"}
```

Validation error (400):
```json
{"ok": false, "error": "invalid-owner" | "invalid-repo" | "invalid-token-shape" | "malformed-body"}
```

Server error (500):
```json
{"ok": false, "error": "clone-failed" | "git-not-available" | "enospc", "code": "ENOSPC"}
```

## Package layout

```
src/
├── main.ts         Entry point — starts server, installs SIGTERM handler
├── server.ts       Hono app factory (exported for tests)
├── server.test.ts  Server-level integration tests
├── clone.ts        Core clone logic (execFile, GIT_ASKPASS, path confinement)
├── clone.test.ts   Clone handler unit tests (mocked execFile)
├── sanitize.ts     Input validation (sanitizeOwner, sanitizeRepo, validateTokenShape)
├── sanitize.test.ts Sanitization unit tests
└── types.ts        Request/response types (shared contract with gateway workspace-api)
```

## Build

```bash
pnpm --filter @fro-bot/workspace-agent build
pnpm --filter @fro-bot/workspace-agent test
pnpm --filter @fro-bot/workspace-agent lint
pnpm --filter @fro-bot/workspace-agent check-types
```

## Deployment

`deploy/workspace.Dockerfile` builds this package and bakes the OpenCode CLI (musl build, pinned to `DEFAULT_OPENCODE_VERSION`) plus a base `@fro.bot/systematic` plugin config. No model or provider is baked — those are deploy-time config. The container launches via `deploy/workspace-entrypoint.sh`, which (1) installs the mitmproxy CA into the **system** trust store (`update-ca-certificates`) — `git` and the `opencode` binary read the system CA bundle, so this is required for egress through the proxy; (2) validates the optional `workspace-opencode-auth` secret (API-key `auth.json` blob) and writes it to OpenCode's data path (`$XDG_DATA_HOME/opencode/auth.json`, `0600`) so the mention-loop agent can authenticate — written as a file, never exported as env, so the clone subprocess never sees it; and (3) overlays `WORKSPACE_OPENCODE_MODEL` (the `provider/model` string) and `WORKSPACE_OPENCODE_CONFIG` (a JSON `provider` block, e.g. a cliproxyapi `baseURL`) onto the base `opencode.json`, mirroring the action's `model` + `opencode-config` inputs (the Systematic plugin is always preserved). Auth and config are fail-soft when absent (clone-only boot) and fail fast when malformed. The supervisor (`main.ts`) then runs the clone API (9100), the loopback OpenCode server (54321), and the bearer proxy (9200).

Steps (2) and (3) are implemented by two checked-in Node ESM helpers in `deploy/scripts/` — `validate-auth.mjs` (`validateAuth`) and `merge-config.mjs` (`mergeConfig`) — which the entrypoint invokes (`node "$SCRIPTS_DIR/<script>.mjs"`); the Dockerfile copies them to `/usr/local/lib/workspace-scripts/`. They are plain ESM (no build step) with `node --test` coverage colocated as `*.test.mjs`, run in CI before the image build. `merge-config.mjs` writes the merged config atomically (temp file + `renameSync`) and rejects a `WORKSPACE_OPENCODE_MODEL` that is not in `provider/model` form. The config merge is an **intentionally narrow provider overlay** (shallow-merge + force `autoupdate:false` + strings-only `plugin` union/dedup) — it deliberately does **not** replicate the action's `buildCIConfig` normalization (oMo/omo-slim/disabled-mode `default_agent` branching, plugin dedup-by-prefix), which exists for modes the workspace never runs.

## Conventions

- ESM-only: `.js` extensions required in all relative imports
- Functions only: no ES6 classes
- All interface properties `readonly`
- Strict booleans: `=== true` / `=== false`, no implicit falsy checks
- No `as any`, no `@ts-ignore`, no `@ts-expect-error`
- Vitest for tests: colocated `.test.ts` files, BDD comments (`// #given`, `// #when`, `// #then`)
- No `console.log` in library code — `main.ts` is the only file that logs to stdout

## Idempotency

If `/workspace/repos/{owner}/{repo}` already exists, `POST /clone` returns **409 repo-exists**. PR D (the gateway orchestration layer) is responsible for deciding whether to surface this as an error or treat it as a no-op. Automatic re-sync (`git fetch + reset`) is deferred to Unit 6.
