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
