# Workspace Agent — Agent Notes

Small Hono HTTP service that runs **inside** the workspace container. The gateway daemon calls it from outside via the internal compose network (`sandbox-net`).

## Purpose

Exposes `POST /clone` (clones a GitHub repo into `/workspace/repos/{owner}/{repo}`), `POST /inspect` (read-only observation of an existing checkout), `POST /update` (network-free admission, then a bare-repo fetch, a pack-stream import, and a journaled fast-forward of an existing checkout), `POST /recover/preview` and `POST /recover` (preserve-and-replace recovery into a quarantine backup), and `GET`/`DELETE /backups/:owner/:repo[/:id]` (list/delete quarantine generations). The gateway sends `{owner, repo, token}` to `/clone` and `/update` — the agent derives the path internally and never accepts a caller-provided path.

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
14. **Every control route requires the gateway's bearer, except `/healthz` and `/readyz`.** `/clone`, `/inspect`, `/update`, `/recover/preview`, `/recover`, and `/backups/*` require `Authorization: Bearer <WORKSPACE_OPENCODE_TOKEN>` — the same root-only secret already used for the 9200 OpenCode proxy (`opencode-proxy.ts`), read once at startup and threaded into `createApp()` via the required `ServerDeps.auth` field (`server.ts`). `auth` is a discriminated union with no default: production must always pass `{kind: 'bearer', token}`; the `{kind: 'disabled-for-tests'}` variant exists solely so tests can opt out explicitly, and can never be reached by omission. The check runs before any body parsing, JSON parsing, or route logic; a missing, wrong-scheme, or wrong token gets a fixed 401 before anything else happens. Comparison is constant-time (`timingSafeEqual`, length-guarded first). Without this, uid 10001 (the unprivileged OpenCode agent, reachable over loopback on `:9100`) could call any of these routes itself.
15. **One per-repo mutex, shared by every mutating route.** `repo-mutex.ts`'s `withRepoLock` serializes clone, update, recover, and backup delete against each other for the same `owner/repo`; different repositories never contend. Callers queue FIFO; a rejected operation still releases in `finally`.
16. **A sticky maintenance hold clears only on restart.** When a subprocess's termination cannot be confirmed within its reap-grace window (SIGKILL sent, exit never observed), `markRepoHeld` (`repo-mutex.ts`) puts that repository on hold: every later mutating call refuses with `maintenance-hold`. Nothing but a workspace process restart clears it — not a timer, not a later successful operation — because a leaked subprocess's continued existence can only be ruled out by the container actually restarting.
17. **Every update/recovery mutation is journaled before it mutates, root-owned, outside `.git/`.** `journal.ts` writes one file per repository under the state directory's `journals/` store, temp-file-and-rename. A read that finds a file it cannot parse reports `malformed`, never `absent` — callers must refuse to proceed rather than act as though nothing was in flight. `main.ts` reconciles every outstanding journal at service start; `/update` and `/recover` reconcile again at the top of each call, before anything else.
18. **Git against an EXISTING checkout never runs as the root service, only as the agent uid.** The only git that ever runs as root with credentials is a fresh clone (in root-owned staging) or a fetch into the protected bare mirror; every git invocation against an agent-owned checkout — admission, fast-forward, the `/inspect` status call — runs as `AGENT_UID`/`AGENT_GID` through the sealed profiles in `git-safety.ts`.
19. **A checkout or quarantine generation's size is measured without the service walking an agent-owned path directly.** `agent-walk.ts`'s `runAgentWalk` spawns the walk as the agent uid; when that is incomplete or fails, `measureSealedTree`/`measureSealedTreeFromFd` fall back to measuring the same tree through a root-opened file descriptor instead of a path lookup the agent could have manipulated between the open and the read.

## Port

**9100** — internal only. No `ports:` mapping in compose. Gateway reaches it as `http://workspace:9100`.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /healthz | none | Liveness probe — returns `{ok: true}` |
| GET | /readyz | none | Readiness probe — gates on OpenCode + proxy state |
| POST | /clone | bearer | Clone a GitHub repo into the workspace |
| POST | /inspect | bearer | Read-only observation of an existing checkout |
| POST | /update | bearer | Admission, bare-repo fetch, pack-stream import, journaled fast-forward of an existing checkout |
| POST | /recover/preview | bearer | Stateless preview of what `/recover` would see (fingerprint, no mutation) |
| POST | /recover | bearer | Quarantine the existing checkout (if any) and install a fresh one at the remote's default-branch tip |
| GET | /backups/:owner/:repo | bearer | List quarantine generations for a repository |
| DELETE | /backups/:owner/:repo/:id | bearer | Delete one quarantine generation |

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

### POST /update

Brings an existing, eligible checkout up to date with its remote default branch, or refuses/fails with a precise reason. Request body mirrors `/clone` (`owner`, `repo`, `token` — the network half needs the same credential). Returns the bare `UpdateResult` discriminated union directly (kind `ready` ​/ `no-checkout` / `refused` / `failed`), never a `{response, statusCode}` wrapper. A `ready` result carries checked remote evidence (branch, SHA, time observed); a `refused` reason of `maintenance-hold` means a prior operation's subprocess termination could not be confirmed — see invariant 16. Never scrubs credential patterns from the response: no `UpdateResult` variant can carry one.

### POST /recover/preview

Read-only, stateless preview of what `/recover` would see. Request body mirrors `/inspect` (`owner`, `repo` — no token; never touches the network). Returns a `PreviewRecoveryResult` carrying a `fingerprint` (a digest of HEAD SHA, dirty counts, and checkout size/entry count) that the caller must echo back to `/recover`.

### POST /recover

Confirms a previously previewed recovery: quarantines the existing checkout (if any) by `rename`, then installs a fresh default-branch checkout built entirely as root before handoff. Request body mirrors `/update` plus `fingerprint` from the preview; `/recover` recomputes the fingerprint under the repo mutex and refuses with `checkout-changed` if it differs from what the caller saw. Returns the bare `ExecuteRecoveryResult` union.

- **`runId` (optional):** the gateway run that triggered the recovery. It must match `^[\w-]{1,128}$` (the format of the gateway's run ids); anything else gets a fixed 400 `invalid-run-id` and nothing moves. It is recorded in the backup's `metadata.json`, and `GET /backups` reports it. Metadata without it, from a manual recovery or an older backup, still parses and counts toward the quota.
- **Client abort:** the request signal is honoured until the `quarantining` journal is written. It is checked at entry, after the quota and disk preflight, through the fetch (it also kills the in-flight git), after the staging build, and after the ownership handoff. An abort at any of those points rolls back like a confirmed pre-quarantine failure: staging is removed, a superseded update journal is restored, the original checkout is untouched, no backup exists, and the result is `failed` / `build-failed`. If the rollback itself cannot be confirmed (the staging removal or the journal rewrite throws), the result is `failed` / `rollback-failed` instead: a `building` journal stays, the original checkout is still untouched, the next `/update` refuses `needs-recovery` and a preview refuses `journal-in-progress` until the workspace restarts and reconciles it. A confirmed `build-failed` leaves nothing behind. After that point the recovery runs to completion and ignores the abort.
- **Instance dispose:** after the fresh checkout is installed and verified and the journal is removed, the workspace sends a best-effort `POST /instance/dispose?directory=<checkout path>` to the loopback OpenCode (`opencode-instance.ts`, 5 s timeout, no body). OpenCode caches one instance per directory, file index included, and would otherwise keep listing the old tree to the next session. The call is skipped when the supervisor does not report OpenCode ready, and a failure never changes the result.

### GET /backups/:owner/:repo, DELETE /backups/:owner/:repo/:id

List or delete quarantine generations for a repository. `owner`/`repo` are path params, validated with the same sanitizers every other route uses; `:id` is validated as a simple path segment (no `..`, no path separator, not empty) before `deleteBackup` runs its own internal check — neither layer alone is trusted. No export and no bulk delete.

## Logging

One process logger (built in `main.ts`, writing to container stderr) is shared by startup reconciliation, the OpenCode supervisor, the 9200 proxy and, through `ServerDeps.logger`, the control routes. It is handed to `executeUpdate`, so `update.ts`'s own log lines emit instead of defaulting to a silent no-op.

- **`workspace-agent: update refused`** / **`workspace-agent: update failed`** (warning, `server.ts`): one line per refused or failed `/update`, with `owner`, `repo`, the closed `reason` and `durationMs`; `dirty` adds `changedPathCount`, `failed` adds `mutationStarted` and `permanent`. `ready` and `no-checkout` are silent.
- **`workspace-agent: OpenCode instance dispose failed after recovery`** (warning, `recover.ts`): one line when the best-effort dispose after a successful `/recover` times out, cannot connect, gets a non-2xx answer or throws. Fields: `owner`, `repo`, `reason` (`timeout`, `network-error`, `http-error` or `threw`) and `status` for `http-error`. The recovery result is `ok` regardless.
- **`opencode-proxy: session abort forwarded`** (info, `opencode-proxy.ts`): a proxied `POST /session/:id/abort` is the workspace-side trace of an operator cancel. Fields: `sessionId`, the `status` the caller saw (including a 502/504 the proxy produced), `durationMs`. `session delete`, `instance dispose` and `global dispose` use the same shape. Logged after the bearer check, when the response closes.

Never log names or contents that come from the agent-writable checkout (changed paths, config keys, submodule or branch names), request bodies, headers, the query string (it carries the workspace directory), or any token. Counts and closed reasons only.

**OpenCode proxy teardown** (`opencode-proxy.ts`): the proxy closes a proxied response in both directions. When the upstream response errors or closes without completing, the downstream response is destroyed, for SSE and non-SSE alike, so a caller never waits on a body that cannot finish; a response that completed is untouched. When an SSE client disconnects before its response finished, the upstream request is destroyed, so the `/event` connection to OpenCode does not outlive its reader. A non-SSE client disconnect does not destroy the upstream request: that response runs to its own end or to the inactivity timeout. Neither path logs anything of its own.

## Package layout

```
src/
├── main.ts             Entry point — starts server, installs SIGTERM handler, reconciles journals at startup
├── server.ts           Hono app factory (exported for tests)
├── server.test.ts      Server-level integration tests
├── clone.ts            Core clone logic (execFile, GIT_ASKPASS, path confinement)
├── clone.test.ts       Clone handler unit tests (mocked execFile)
├── update.ts           /update: admission, remote observation, bare-repo fetch, pack-stream import, journaled fast-forward
├── recover.ts          /recover/preview and /recover: fingerprint preview, quarantine-and-replace mutation
├── backups.ts          /backups list/delete; the quarantine-generation metadata schema (including the optional run id)
├── opencode-instance.ts Best-effort POST /instance/dispose to the loopback OpenCode, run after a successful /recover
├── opencode-generation.ts  Reads WORKSPACE_IMAGE_OPENCODE_VERSION (baked by the image); major 2+ selects the V2 trio below
├── opencode-server-v2.ts   V2 supervisor: allowlisted env, fresh database per spawn, credential holder, plugin + permission gates
├── opencode-proxy-v2.ts    V2 proxy: gateway bearer in, the ready server's Basic credential out, upstream 401 reported as such
├── opencode-instance-v2.ts V2 best-effort location evict (DELETE /api/debug/location), authenticated as the running server
├── checkout-profile.ts Config inventory, layout, and temp-index cleanliness admission checks shared by update/recover
├── git-safety.ts       Sealed, credential-free git invocation profiles for git against an EXISTING checkout
├── git-stream.ts       pack-objects | index-pack streaming primitive (runPackStream)
├── repo-mutex.ts       Per-repo operation mutex (withRepoLock) and the sticky maintenance hold (markRepoHeld)
├── journal.ts          Root-owned update/recovery journal store, temp-file-and-rename
├── agent-walk.ts       Agent-uid and sealed-fd checkout size/entry-count walkers
├── identity.ts         uid/gid, home/XDG, and state-directory-name constants
├── config.ts           Secret-file reads; egress-proxy and CA-bundle config for /update, read once at startup
├── sanitize.ts         Input validation (sanitizeOwner, sanitizeRepo, validateTokenShape)
├── sanitize.test.ts Sanitization unit tests
└── types.ts        Request/response types (shared contract with gateway workspace-api)
```

## OpenCode V2 (stock 2.x images)

`deploy/workspace.Dockerfile` bakes `WORKSPACE_IMAGE_OPENCODE_VERSION` (the `OPENCODE_VERSION` that chose the binary). `main.ts` reads it through `readOpencodeGeneration`: major 2 or higher injects the V2 runner, proxy and disposer; unset or older keeps the V1 ones exactly. A value that is set but is not a version exits 1 before any bind. The same value is reported as `opencodeVersion` on `/healthz` and `/readyz`, and the gateway picks its run loop from it. The image pin is the only switch; there is no operator setting.

- **Spawn** goes through `startOpenCodeV2Server` (`@fro-bot/runtime/workspace-v2`): `serve --stdio` with a held stdin, an explicit port, a per-spawn Basic password, readiness on `/api/agent`, and the plugin gate (Systematic `systematic` and `fro-bot.opencode-plugin` must be `active`). The child runs as uid/gid 10001 with an environment built from an allowlist.
- **Plugins are installed at image build time** by `deploy/scripts/install-opencode-v2-plugins.sh` (bounded, as uid 10001) and listed in the config content passed at spawn. Nothing installs at boot.
- **Every spawn gets a fresh database** (`prepareFreshDatabase`, under the root-owned `/var/lib/workspace-agent/opencode-v2-db`), so V2 has no execution claim to resume after a restart.
- **The credential holder** is written before readiness flips to ready and cleared on any exit, so the proxy answers 503 (never forwards a stale password) between servers. An upstream 401 is reported as a 502 with `x-fro-bot-proxy-error: upstream-auth`.
- **Shutdown** lists the sessions still active, interrupts them (reason `user`), closes stdin and confirms the exit, inside the 25s drain. `main.ts` waits for the V2 supervisor before it closes the proxy.
- **Permission gate:** after the plugin gate the supervisor checks the effective rules from `/api/agent` (`ask` or `deny` outside the checkout, `session_move` and `worktree_create` denied). A server that fails never serves.

## Build

```bash
bun run --filter @fro-bot/workspace-agent build
bun run --filter @fro-bot/workspace-agent test
bun run --filter @fro-bot/workspace-agent lint
bun run --filter @fro-bot/workspace-agent check-types
```

## Deployment

`deploy/workspace.Dockerfile` builds this package and bakes the OpenCode CLI (musl build, pinned to `DEFAULT_OPENCODE_VERSION`) plus a base `@fro.bot/systematic` plugin config. No model or provider is baked — those are deploy-time config. The container launches via `deploy/workspace-entrypoint.sh`, which (1) installs the mitmproxy CA into the **system** trust store (`update-ca-certificates`) — `git` and the `opencode` binary read the system CA bundle, so this is required for egress through the proxy; (2) validates the optional `workspace-opencode-auth` secret (API-key `auth.json` blob) and writes it to OpenCode's data path (`$XDG_DATA_HOME/opencode/auth.json`, `0600`) so the mention-loop agent can authenticate — written as a file, never exported as env, so the clone subprocess never sees it; and (3) overlays `WORKSPACE_OPENCODE_MODEL` (the `provider/model` string) and `WORKSPACE_OPENCODE_CONFIG` (a JSON `provider` block, e.g. a cliproxyapi `baseURL`) onto the base `opencode.json`, mirroring the action's `model` + `opencode-config` inputs (the Systematic plugin is always preserved). Auth and config are fail-soft when absent (clone-only boot) and fail fast when malformed. The supervisor (`main.ts`) then runs the clone API (9100), the loopback OpenCode server (54321), and the bearer proxy (9200).

Steps (2) and (3) are implemented by two checked-in Node ESM helpers in `deploy/scripts/` — `validate-auth.mjs` (`validateAuth`) and `merge-config.mjs` (`mergeConfig`) — which the entrypoint invokes (`node "$SCRIPTS_DIR/<script>.mjs"`); the Dockerfile copies them to `/usr/local/lib/workspace-scripts/`. They are plain ESM (no build step) with `node --test` coverage colocated as `*.test.mjs`, run in CI before the image build. `merge-config.mjs` writes the merged config atomically (temp file + `renameSync`) and rejects a `WORKSPACE_OPENCODE_MODEL` that is not in `provider/model` form. The config merge is an **intentionally narrow provider overlay** (shallow-merge + force `autoupdate:false` + strings-only `plugin` union/dedup) — it deliberately does **not** replicate the action's `buildCIConfig` normalization (`default_agent` pinning, legacy `plugins` stripping, permission scoping), which the workspace never needs.

## Conventions

- ESM-only: `.js` extensions required in all relative imports
- Functions only: no ES6 classes
- All interface properties `readonly`
- Strict booleans: `=== true` / `=== false`, no implicit falsy checks
- No `as any`, no `@ts-ignore`, no `@ts-expect-error`
- Vitest for tests: colocated `.test.ts` files, BDD comments (`// #given`, `// #when`, `// #then`)
- No `console.log` in library code — `main.ts` is the only file that logs to stdout

## Idempotency

If `/workspace/repos/{owner}/{repo}` already exists, `POST /clone` returns **409 repo-exists**; the gateway orchestration layer decides whether to surface this as an error or treat it as a no-op. Automatic re-sync now exists as `POST /update` (admission-gated fast-forward, not an unconditional `git fetch + reset`) — the gateway calls it before every run, retrying through `ensureClone`/`POST /clone` only when `/update` reports `no-checkout`.
