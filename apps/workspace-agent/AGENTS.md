# Workspace Agent — Agent Notes

Small Hono HTTP service that runs **inside** the workspace container. The gateway daemon calls it from outside via the internal compose network (`sandbox-net`).

## Purpose

Exposes `POST /clone` (clones a GitHub repo into `/workspace/repos/{owner}/{repo}`) and `POST /inspect` (read-only observation of an existing checkout). The gateway sends `{owner, repo, token}` to `/clone` — the agent derives the path internally and never accepts a caller-provided path.

## Security invariants

1. **Token never in argv.** Git is invoked via `execFile` with the IAT injected through a `GIT_ASKPASS` temp script. The token never appears in the process argument list.
2. **No shell interpolation.** `execFile` only — never `exec()` or `spawn(shell, ...)`.
3. **Git trace suppression.** `GIT_TRACE=0`, `GIT_CURL_VERBOSE=0`, `GIT_TRACE_PACKET=0`, `GIT_TRACE_PERFORMANCE=0` in every subprocess env.
4. **Stderr scrubbing.** `x-access-token:[^@]+@` is redacted before any error is returned or logged.
5. **Path confinement.** Owner and repo are validated against `[A-Za-z0-9._-]+`. After clone, `fs.realpath` confirms the path is within `/workspace/repos/`.
6. **Credential helper disabled.** `-c credential.helper=` prevents any operator-side git credential helper from caching the IAT.
7. **Token never logged.** No log line, error response, or test snapshot may contain the IAT.
8. **Askpass helper is executable, on purpose.** Mode `0700` is set with an explicit `chmod` after write (not just the `open()` mode, which the process umask can mask back down) — git executes this file to answer credential prompts.
9. **Askpass helper answers only `https://github.com`.** The script exact-matches git's literal prompt text (`Username for 'https://github.com': ` / `Password for 'https://x-access-token@github.com': `, no glob) and `exit 1`s for anything else, so a same-request HTTP redirect to another host cannot get the IAT.
10. **Global/system git config is sealed, HTTPS-only.** `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_ALLOW_PROTOCOL=https` on the clone (and post-clone local) subprocess env block a config-planted `url.<x>.insteadOf` redirect — a fresh clone has no repo-local config yet, so global/system are the only places one could come from.
11. **Fresh clones stage before they publish.** A clone is written under the root-owned staging directory (`/workspace/repos/.workspace-agent/staging/`, created by the entrypoint; `clone.ts` creates `staging/` itself if missing, `0700`) — never beside the destination, and never under the agent-traversable owner directory. HEAD is resolved and validated there, **before** handoff, so the service never runs git in an agent-owned tree for a fresh clone. Publishing is a single `rename` into `/workspace/repos/{owner}/{repo}` (see `identity.ts` for the exact path constants).
12. **Ownership handoff is filesystem calls only.** `handoff.ts` walks the staged tree with `lstat`/`lchown` — never `stat`, never `chown`, never git. It never follows a symlink (the link itself is `lchown`'d, its target never touched), never crosses a filesystem boundary (`st_dev` comparison), and fails the clone outright on a hardlinked file (`nlink > 1` has no legitimate reason to exist in a fresh HTTPS clone) rather than guessing. The walk is bounded by both a deadline and an entry cap.
13. **Existing-checkout git runs as the agent, not the service.** Once a checkout is agent-owned, any git invocation against it (`repo-exists` idempotency check, post-rename race-check) runs as `AGENT_UID`/`AGENT_GID` with the same neutralized, credential-free invocation shape `/inspect` uses (`git-safety.ts`: sealed config, exact `safe.directory`, no credentials) — never as the root-owned service. The only git that ever runs as root with credentials is the clone itself, in root-owned staging.
14. **Every control route requires the gateway's bearer, except `/healthz` and `/readyz`.** `/clone` and `/inspect` require `Authorization: Bearer <WORKSPACE_OPENCODE_TOKEN>` — the same root-only secret already used for the 9200 OpenCode proxy (`opencode-proxy.ts`), read once at startup and threaded into `createApp()` via the required `ServerDeps.auth` field (`server.ts`). `auth` is a discriminated union with no default: production must always pass `{kind: 'bearer', token}`; the `{kind: 'disabled-for-tests'}` variant exists solely so tests can opt out explicitly, and can never be reached by omission. The check runs before any body parsing, JSON parsing, or route logic; a missing, wrong-scheme, or wrong token gets a fixed 401 before anything else happens. Comparison is constant-time (`timingSafeEqual`, length-guarded first). Without this, uid 10001 (the unprivileged OpenCode agent, reachable over loopback on `:9100`) could call `/clone` or `/inspect` itself.

## Port

**9100** — internal only. No `ports:` mapping in compose. Gateway reaches it as `http://workspace:9100`.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /healthz | none | Liveness probe — returns `{ok: true}` |
| GET | /readyz | none | Readiness probe — gates on OpenCode + proxy state |
| POST | /clone | bearer | Clone a GitHub repo into the workspace |
| POST | /inspect | bearer | Read-only observation of an existing checkout |

Every route except `/healthz` and `/readyz` requires `Authorization: Bearer <WORKSPACE_OPENCODE_TOKEN>` — see security invariant 14 above. A missing, wrong-scheme, or wrong token returns `401 {"ok": false, "error": "unauthorized"}` before the route's own validation runs.

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

### POST /inspect

Read-only observation of an existing checkout (branch, SHA, dirty state, in-progress operation). Never clones, fetches, or mutates. Request body:
```json
{"owner": "fro-bot", "repo": "agent"}
```

Success (200):
```json
{"ok": true, "observation": {"head": {...}, "worktree": {...}, "operationInProgress": "none", "observedAt": "..."}}
```

Error (400/404/409/500/504):
```json
{"ok": false, "error": "invalid-owner" | "invalid-repo" | "malformed-body" | "body-too-large" | "no-checkout" | "checkout-substituted" | "inspection-failed" | "inspection-timeout"}
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
bun run --filter @fro-bot/workspace-agent build
bun run --filter @fro-bot/workspace-agent test
bun run --filter @fro-bot/workspace-agent lint
bun run --filter @fro-bot/workspace-agent check-types
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
