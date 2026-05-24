---
title: "feat: Gateway v1 Unit 5 — channel-repo binding + /fro-bot add-project"
type: feat
status: active
date: 2026-05-23
origin: docs/plans/2026-04-18-001-feat-fro-bot-gateway-discord-v1-plan.md
parent_unit: Unit 5 of the Gateway v1 plan
deepened: 2026-05-23 (coherence + feasibility + security review applied)
---

# feat: Gateway v1 Unit 5 — channel-repo binding + /fro-bot add-project

## Overview

The first user-facing gateway feature. A Discord operator runs `/fro-bot add-project url:<git-url> [channel:<name>]`, and the gateway authenticates to GitHub, clones the repo into the workspace container, creates (or reuses) a Discord channel for that repo, and writes a binding record to S3 so future `@fro-bot` mentions in that channel know which repo to act against. Built as a four-PR series that lands incrementally, with the slash command going live in the final PR.

## Problem Frame

After v0.44.4 the gateway daemon is deploy-ready (Unit 4 + the deploy-readiness PRs #649-#656) but doesn't do anything useful — it boots, registers `/fro-bot ping`, responds to mentions with "pong" in a thread, and that's it. Unit 5 makes the gateway a *useful* tool by letting the operator hand it a repo and get a working Discord channel bound to it. This unlocks Unit 6 (the actual interaction loop where `@fro-bot` in a bound channel drives OpenCode against the local checkout).

## Requirements Trace

Aligned with the parent Gateway v1 plan:

- **R2** (channel↔repo mapping) — single bound channel per repo, S3-backed binding records survive gateway restarts
- **S8** (slash command spec) — `/fro-bot add-project url:<git-url> [channel:<name>]` with the orchestrated setup flow

## Scope Boundaries

- The slash command itself is shipped — operators can run it after the final PR merges
- Channel-binding lifecycle is **create + read** only. No `/fro-bot remove-project` or rename in this unit
- No `/fro-bot list-projects` slash command in this unit (data lives in S3; can be added later)
- The workspace agent only handles `clone` for v1 — `fetch` and `checkout` are Unit 6's responsibility (not scaffolded here)
- Single-tenant: one Discord guild, one operator. No multi-tenancy concerns

### Deferred to Separate Tasks

- Binding eviction / `/remove-project` slash command: filed as separate PR after Unit 5 ships. Until then, manual S3 cleanup is the recovery path (documented in the operator-facing failure messages)
- Automatic rollback of partial channel creation on binding-write failure: manual operator cleanup in v1 (per Gateway v1 plan's scope-review decision)
- `/fro-bot list-projects`, `/fro-bot rename-channel`, `/fro-bot reseed`, `/fro-bot recover-project`: post-Unit 6 enhancements
- Resume-from-state machinery (durable setup-intent records so retries skip completed phases): post-Unit 5 if operational experience shows partial-failure recovery is painful
- Workspace `fetch` and `checkout` handlers in workspace-agent: Unit 6 (the interaction loop) adds them — NOT scaffolded in this unit
- Workspace volume quota enforcement: post-v1 — v1 surfaces `ENOSPC` as a distinct error and instructs the operator to free disk; auto-eviction comes later

## Context & Research

### Relevant Code and Patterns

- **GitHub App auth precedent**: `src/services/github/client.ts` — provides the single-stage `createAppAuth({appId, privateKey, installationId})` pattern. The gateway needs a **two-stage** flow (JWT-level discovery, then installation-token) that does NOT exist in the action today; the gateway builds the discovery step itself. The existing client is a useful reference for the second stage only. (Plan path in the parent doc said `apps/action/...`; reality is `src/services/...`.)
- **Object-store key builder**: `packages/runtime/src/object-store/key-builder.ts` + `types.ts`. Current `ContentType` union is `'artifacts' | 'locks' | 'metadata' | 'runs' | 'sessions'`. Adding `'bindings'` is a one-line union extension. **Binding storage shape (see "Binding storage model" below):** primary record at `{prefix}/{identity}/{owner}/{repo}/bindings/repo.json` built via `buildObjectStoreKey(config, identity, '${owner}/${repo}', 'bindings', 'repo.json')` — the builder accepts the slash-joined `owner/repo` and splits it correctly. Channel-id lookup index at `{prefix}/{identity}/_/_/bindings/by-channel/{channel_id}.json` is constructed manually (not via the builder, since the builder's `sanitizeKeyComponent` would corrupt the `by-channel/` segment).
- **S3 conditional writes**: `packages/runtime/src/object-store/s3-adapter.ts` — `conditionalPut(key, data, {ifNoneMatch, ifMatch})` and `conditionalDelete(key, {ifMatch})`. Already used by coordination/lock. Bindings use `IfNoneMatch: '*'` for create-only writes.
- **Slash command shape**: `packages/gateway/src/discord/commands/ping.ts` + `index.ts` — `SlashCommand = {data: SlashCommandBuilder, execute: (interaction) => Effect.Effect<void, Error>}`. `dispatchCommand` looks up by `data.name`. The new `add-project` command file follows this exact shape.
- **Discord client defaults**: `packages/gateway/src/discord/client.ts` defaults to `[Guilds, GuildMessages]`. Channel creation needs `MANAGE_CHANNELS` permission (not a Gateway intent — a bot scope/role permission). Thread creation from messages needs `SEND_MESSAGES`. Both are already covered by the existing intents.
- **Mentions / thread pattern**: `packages/gateway/src/discord/mentions.ts` — `message.startThread({name})` + thread.send. New machinery needed: progress-message editing inside a setup thread.
- **Existing slash-command test pattern**: `packages/gateway/src/discord/commands/ping.test.ts` — mock the interaction, execute the effect, assert reply payload + error path via `Effect.either`.

### Institutional Learnings

- `docs/solutions/code-quality/architectural-issues-type-safety-and-resource-cleanup.md` — for the multi-step orchestration: model each step explicitly, ensure compensation runs even when later steps fail. Direct precedent for the partial-failure recovery in this unit.
- `docs/solutions/workflow-issues/delivery-mode-contract-for-manual-triggers-2026-04-17.md` — make execution contracts explicit on public input surfaces, resolve centrally, surface state observably. Applied here as the explicit `AddProjectPhase` enum + progress-message updates rather than heuristic state.
- `docs/solutions/best-practices/versioned-tool-config-plugin-pattern-2026-03-29.md` — sub-app conventions: single source of truth for version/config, explicit wiring, no dead installer layer. Applied to `apps/workspace-agent/` package layout.

### External References

External research skipped — local patterns are strong (Octokit auth in action, S3 conditional writes in coordination, slash command/intent code already shipped). Hono is well-documented; pulling docs at implementation time is sufficient.

## Key Technical Decisions

- **Hono for the workspace-agent HTTP server** — chosen over raw `node:http`. Reasoning: the agent will grow more endpoints (Unit 6 adds `fetch` + `checkout` usage; future units add status/log endpoints) and Hono's routing + validation ergonomics scale better than hand-rolled. New dep cost is acceptable; Hono is minimal (~14kb gzipped) and broadly used.
- **4 PRs, sequenced** — each lands an isolated layer with its own tests. PR A (bindings) and PR B (auth) ship independently and add no user-visible behavior. PR C scaffolds the workspace-agent with ONLY the `/clone` handler (no scaffolded `fetch`/`checkout` stubs — those land in Unit 6 where they're actually used). PR D ships the gateway-side HTTP client + Discord channel management + slash command together (these are tightly coupled and the HTTP client has no consumer outside the slash command). (Trimmed from earlier 5-PR plan: PR D and PR E collapsed; PR C's `fetch`/`checkout` stubs removed as premature scaffolding.)
- **Explicit `AddProjectPhase` enum + progress messages** — state machine with `PRE_FLIGHT | CLONING | CREATING_CHANNEL | WRITING_BINDING | READY` plus a `FAILED` terminal. The setup thread's first message is edited as phase progresses. On failure, the message describes what completed and what didn't, with explicit recovery instructions.
- **Credentials via `_FILE` convention** — `GITHUB_APP_ID_FILE` + `GITHUB_APP_PRIVATE_KEY_FILE`, read through the existing `readSecret(...)` helper in `packages/gateway/src/config.ts`. Compose bind-mounts the files like Discord token. Matches the existing pattern; private key never appears in env vars.
- **Auto-discover `installation_id` from repo URL** — gateway calls `GET /repos/{owner}/{repo}/installation` with an App-level JWT and uses the returned `installation_id` for subsequent API calls. No `GITHUB_APP_INSTALLATION_ID` env var. Works for any repo the App is installed on; fails fast with an "install the App on this repo" error embed otherwise.
- **`ContentType` extension over a new content scheme** — `'bindings'` added to the existing union. Keeps S3 path layout consistent with sessions/runs/locks. No new key-builder logic.
- **Workspace agent runs on port 9100, `sandbox-net` internal only** — confirmed `sandbox-net` is `internal: true` in compose and no port mapping for 9100 exists. Gateway reaches it as `http://workspace:9100`. No `host:port` mapping; no public exposure.
- **Gateway does NOT mount `/var/run/docker.sock`** — explicitly rejected by the parent plan. Workspace agent shells out to `git` inside its own container; cache folder is a named volume shared between OpenCode and the agent (same container).
- **IAT in request body, not header** — the workspace agent receives the installation access token in the POST body, uses it once for `git clone https://x-access-token:<iat>@github.com/owner/repo`, then drops it. Never logged. Never persisted.

## Open Questions

### Resolved During Planning

- Hono vs `node:http`: Hono
- Sub-PR sequencing: 4 PRs (A → D)
- Partial-failure shape: explicit phase enum + progress messages
- Credential source: `_FILE` via `readSecret`
- Installation discovery: auto-discover via App-level JWT call

### Deferred to Implementation

- Exact path layout under workspace volume for cloned repos (e.g., `/workspace/repos/{owner}/{repo}` vs flat): pick when the workspace-agent clone handler is written
- Whether to surface the auto-discovered `installation_id` in logs (privacy vs debuggability): pick when the App client is wired
- Discord embed styling for the welcome message in the new channel: leave to the slash-command implementer

## Binding Storage Model

R2 requires "single bound channel per repo" — one repo has at most one bound Discord channel at a time. Single keyed-by-channel storage cannot enforce this. The plan uses two keys per binding:

**Primary record** (one per repo, enforces R2 uniqueness):
- Key: `{prefix}/{identity}/{owner}/{repo}/bindings/repo.json`
- Body: `{channelId, channelName, workspacePath, createdAt, createdByDiscordId}`
- Written with `IfNoneMatch: '*'` — atomic create-only. Loser of a race gets `BindingExistsError`.

**Channel-to-repo lookup index** (one per channel, enables fast reverse lookup):
- Key: `{prefix}/{identity}/_/_/bindings/by-channel/{channel_id}.json`
- Body: `{owner, repo}` — minimal pointer
- Written second, after the primary record succeeds. Not on the critical path for R2 uniqueness.
- The `_/_/` segments mean this index lives at a different keyspace level so a single LIST under the index prefix returns all channel-to-repo mappings without scanning per-repo trees.

This shape gives:
- **R2 uniqueness** at the primary key (only one `repo.json` per `(owner, repo)` can exist)
- **Fast `@fro-bot` mention dispatch** in Unit 6 — `getBindingByChannelId(channelId)` is a single GET on the index, then a second GET on the primary record
- **Repo-keyed reads** for `/fro-bot list-projects` (deferred) — LIST under `{identity}/` enumerates all primary records

Pre-flight in the slash command checks the **source channel's** existing binding (if any) AND the **target repo's** binding (the primary record). The latter is the R2 enforcement point.

## Cross-Cutting Security Requirements

These invariants apply across all 4 sub-PRs and must be enforced in every code change that touches the IAT or git-execution surface:

### IAT handling (security-critical)
- **Never via argv.** Tokens must never appear as a process argument. The workspace agent invokes git via `execFile('git', ['clone', ...], {env: ...})` with the credential injected via `GIT_ASKPASS` or `git -c credential.helper=...`, not via URL substitution in the command string.
- **Never via shell.** No `spawn(shell, [..., gitCommandString])` and no `exec()`. Strict `execFile` only.
- **No git tracing.** Workspace agent sets `GIT_TRACE=0`, `GIT_CURL_VERBOSE=0`, `GIT_TRACE_PACKET=0` in the spawn env. Logs only `{ok, durationMs, sha}` — never stdout/stderr that could echo URLs.
- **Stderr scrubbing.** Any error message that includes the remote URL must be regex-scrubbed of `x-access-token:[^@]+@` before being returned in the response or logged.
- **No persistence.** IATs never written to disk. Workspace agent receives, uses, drops.
- **No telemetry.** No metrics, traces, or test-snapshots may contain the IAT. Test infrastructure includes a captured-logger assertion: `expect(allLogOutput).not.toMatch(/x-access-token/)`.

### Workspace agent trust boundary
- `sandbox-net` is `internal: true` in compose with only `gateway`, `workspace`, and `mitmproxy` attached. There is no untrusted peer on this network. **Plaintext HTTP between gateway and workspace agent is acceptable** under this constraint; documented in `deploy/README.md`.
- **Upgrade path if the trust boundary widens** (e.g., adding a sidecar that isn't fully trusted): introduce a shared-secret bearer token (HMAC of `request_id + timestamp`, validated by the agent). Out of scope for v1.
- The workspace agent **MUST NOT** be exposed outside `sandbox-net`. No `ports:` mapping in compose.

### repoPath confinement
- The workspace agent **does not accept caller-provided paths**. Caller sends `{owner, repo}` only; agent resolves the path internally to `/workspace/repos/{owner-sanitized}/{repo-sanitized}` where both segments are sanitized to `[a-zA-Z0-9._-]+` and rejected if they contain `/`, `..`, or are empty.
- No symlink following on destination resolution (`fs.realpath` check after clone confirms the path is within `/workspace/repos/`).
- `repoPath` is removed from the public `CloneRequest` type — internal-only derivation.

### Git URL allowlist
- **Gateway-side validation** (slash command layer): URL regex matches `^https://github\.com/[^/]+/[^/]+(\.git)?$` only. Reject everything else at slash-command argument validation.
- **Defense-in-depth at the workspace agent**: the agent re-validates `owner` and `repo` against the same character class and constructs the clone URL itself as `https://github.com/{owner}/{repo}.git`. Caller never provides a full URL.

### GitHub App credentials
- Read via `_FILE` convention through `readSecret(...)` (matches Discord token pattern).
- **App key rotation:** the gateway caches the private key at startup. **Restart required after rotating `secrets/github-app-private-key`.** Documented in `deploy/README.md`.
- **Installation cache invalidation:** the gateway caches `(owner, repo) → installationId` in-memory but treats cached entries as best-effort. On any `401`/`404`/`AppNotInstalledError` from a subsequent API call, the entry is evicted and re-discovered. Document this in the App client unit tests.

### Discord binding ownership model
- v1 is single-operator: anyone with `MANAGE_CHANNELS` permission in the bound guild can invoke `/fro-bot add-project` and thus create new repo bindings. This is the current threat model.
- The slash command is registered guild-scoped (not global) so it only appears in the operator's authorized guild.
- v1.1+ may add operator-role gating (`fro-bot` role per the parent plan) to narrow this further.

### Cross-cutting logging hygiene
- Repo-wide invariant for this unit: **IATs, App private keys, and signed JWTs MUST NOT appear in logs, error messages, telemetry, returned response bodies, test snapshots, or PR descriptions.** Enforced by:
  - Captured-logger assertions in `clone.test.ts`, `app-client.test.ts`, `workspace-api/client.test.ts`, and `add-project.test.ts`
  - Stderr scrubbing in the workspace agent clone handler
  - A test in `app-client.test.ts` that asserts JWT/private-key strings do not appear in the App client's error returns
  - PR review checklist line for every PR in this unit: "no secrets in logs, errors, or test fixtures"

## Output Structure

```
packages/gateway/src/
├── bindings/
│   ├── types.ts          (PR A)
│   └── store.ts          (PR A)
├── github/
│   └── app-client.ts     (PR B)
├── workspace-api/
│   ├── types.ts          (PR D — request/response shapes)
│   └── client.ts         (PR D — HTTP client over sandbox-net)
└── discord/
    ├── channels.ts       (PR D — find-or-create channel)
    └── commands/
        └── add-project.ts (PR D — slash command + orchestration)

apps/workspace-agent/
├── package.json          (PR C)
├── tsconfig.json         (PR C)
├── tsdown.config.ts      (PR C)
└── src/
    ├── main.ts           (PR C — Hono server on port 9100)
    └── handlers/
        └── clone.ts      (PR C)

packages/runtime/src/object-store/types.ts  (PR A — ContentType += 'bindings')
deploy/workspace.Dockerfile                  (PR C — install + run workspace-agent)
deploy/compose.yaml                          (PR B — GitHub App secret mounts)
```

## Implementation Units

- [ ] **PR A: Channel-repo bindings store**

**Goal:** A typed, S3-backed store for repo bindings using the two-key shape from the Binding Storage Model section above. Primary record per repo + channel-to-repo index. Read, list, create-only-write (via `IfNoneMatch: '*'`). No Discord, no GitHub — pure storage layer.

**Requirements:** R2 (persistent channel↔repo mapping)

**Dependencies:** None. Lands first.

**Files:**
- Create: `packages/gateway/src/bindings/types.ts` (`RepoBinding`: `{owner, repo, channelId, channelName, workspacePath, createdAt, createdByDiscordId}`; `ChannelIndex`: `{owner, repo}`)
- Create: `packages/gateway/src/bindings/store.ts` (the API below)
- Modify: `packages/runtime/src/object-store/types.ts` — extend `ContentType` union to include `'bindings'`
- Test: `packages/gateway/src/bindings/store.test.ts`

**Bindings store API:**
- `createBinding(binding: RepoBinding): Promise<Result<{primaryEtag, indexEtag}, BindingExistsError | StoreError>>` — writes the primary record at `{owner}/{repo}/bindings/repo.json` with `IfNoneMatch: '*'`, then writes the channel index at `_/_/bindings/by-channel/{channel_id}.json` with `IfNoneMatch: '*'`. If the index write fails after the primary succeeded, the operation rolls back the primary via `conditionalDelete` with the primary etag.
- `getBindingByRepo(owner, repo): Promise<Result<RepoBinding | null, StoreError>>` — single GET on the primary record.
- `getBindingByChannelId(channelId): Promise<Result<RepoBinding | null, StoreError>>` — GET on the channel index, then GET on the primary. Returns null if either is missing.
- `listBindings(): Promise<Result<RepoBinding[], StoreError>>` — LIST under `{identity}/` collecting all `repo.json` keys; for each, fetches the body. Used by deferred `/fro-bot list-projects`.

**Approach:**
- Both writes use `IfNoneMatch: '*'`. Primary record is the R2 uniqueness gate; index is a lookup convenience.
- Bindings parsed with a runtime type-guard (no bare `as RepoBinding` casts — follow the `hasValidLockRecordShape` pattern from `packages/runtime/src/coordination/lock.ts`). Same for `ChannelIndex`.
- Rollback on index-write failure is best-effort. If rollback itself fails, return a `PartialWriteError` that names both records and tells the caller to manually clean up the primary.

**Execution note:** Test-first for the runtime validator. The shape guard is the security boundary against malformed S3 data.

**Patterns to follow:**
- `packages/runtime/src/coordination/lock.ts` (Result-based store ops, runtime validation, IfNoneMatch semantics)
- `packages/runtime/src/object-store/key-builder.ts` (ContentType extension shape)

**Test scenarios:**
- Happy path — `createBinding({owner: 'foo', repo: 'bar', channelId: '123', ...})` writes both records, returns both etags. `getBindingByRepo('foo', 'bar')` returns the binding. `getBindingByChannelId('123')` returns the same binding.
- Happy path — `listBindings()` returns multiple bindings in stable iteration order.
- Edge case — `createBinding` called twice for the same `(owner, repo)` returns `BindingExistsError` on second call (primary IfNoneMatch fires; index write is skipped).
- Edge case — `getBindingByRepo` and `getBindingByChannelId` return `null` for missing keys without error.
- Edge case — `getBindingByChannelId` with a stale channel-index pointing at a deleted primary returns `null` (treats orphan index as absent binding).
- Error path — malformed JSON in S3 → returns `Result.err(ValidationError)` from the type guard, not a crash.
- Error path — S3 returns 403 on primary write → returns `Result.err(StoreError)`. Index write not attempted.
- Error path — primary write succeeds but index write fails → rollback `conditionalDelete` runs with the primary etag; returns `Result.err(StoreError)` if rollback succeeded, `Result.err(PartialWriteError)` if rollback also failed.
- Edge case — type-guard rejects an index body missing `owner` or `repo` fields.

**Verification:**
- `pnpm --filter @fro-bot/gateway test` green
- `pnpm check-types` green, `pnpm lint` green
- `'bindings'` is in the `ContentType` union and no existing test fails

---

- [ ] **PR B: GitHub App authentication for the gateway**

**Goal:** Octokit-backed App client with auto-discovered `installation_id`. No Discord wiring, no slash command — just the authenticated client that PR D will use.

**Requirements:** Prerequisite for S8 (need authenticated GitHub access before cloning private repos)

**Dependencies:** PR A merged (so the bindings layer is available for the eventual orchestration).

**Files:**
- Create: `packages/gateway/src/github/app-client.ts` (`createAppClient({appId, privateKey})` returns `{authForRepo(owner, repo): Promise<Result<{octokit, installationId, token}, AuthError>>}`)
- Modify: `packages/gateway/src/config.ts` — add `githubAppId` + `githubAppPrivateKey` to `GatewayConfig`, read via `readSecret('GITHUB_APP_ID_FILE')` / `readSecret('GITHUB_APP_PRIVATE_KEY_FILE')`. Fail-fast on missing creds.
- Modify: `deploy/compose.yaml` — bind-mount `secrets/github-app-id` and `secrets/github-app-private-key` as `GITHUB_APP_ID_FILE` / `GITHUB_APP_PRIVATE_KEY_FILE`
- Modify: `deploy/README.md` — document the two new secret files (creating the secrets, App permissions required)
- Test: `packages/gateway/src/github/app-client.test.ts`, `packages/gateway/src/config.test.ts` (new credentials)

**Approach:**
- Use the second stage of `src/services/github/client.ts` as the installation-token reference. Build the **first stage** (discovery) here for the first time in this repo: dynamic `import('@octokit/auth-app')`, create JWT-level auth with `{appId, privateKey}` (no `installationId`), call `GET /repos/{owner}/{repo}/installation` to discover the installation id, then re-create auth with `{appId, privateKey, installationId}` and produce the Octokit instance.
- Cache `(owner, repo) → installationId` in-memory but **treat cached entries as best-effort**. On any `401`/`404`/`AppNotInstalledError` from a subsequent API call, evict the cache entry and re-discover. Installation ids can change on uninstall+reinstall, repo transfers, and permission changes — don't assume cache permanence.
- **App key rotation requires gateway restart.** Bind-mounted file changes aren't picked up by the running process. Documented in the README update for this PR.
- **App-level JWT lifecycle:** The discovery flow mints a fresh App-level JWT on each `authForRepo(owner, repo)` call where the installation_id is not cached. JWTs are short-lived (10min default per `@octokit/auth-app`) — caching them across calls adds complexity without measurable savings; the JWT-mint cost is sub-millisecond. DO cache `(owner, repo) → installationId` (per the existing requirement). DO NOT cache the JWT itself.
- **App permission scope verification:** After successful installation discovery, fetch the installation's granted permissions via the Octokit response (`installation.permissions`). Validate that the required minimum permissions are present: `contents: read` for cloning. (Future units will add: `pull_requests: write`, `issues: write` for the action loop.) If permissions are MORE than required, log a WARN with the over-privileged scopes — don't reject, as operators may have other tools using the same App with broader needs. If permissions are LESS than required, return `Result.err(InsufficientPermissionsError)` with a message naming the missing permissions and the App's permissions URL.
- `authForRepo` returns `Result.err` cleanly when:
  - `appId`/`privateKey` are missing (config-time error, surfaced at startup, not at first call)
  - the App is not installed on the target repo (returns `AppNotInstalledError` with the install URL in the message)
  - the token request fails (returns `AuthError` with upstream message)
  - the installation lacks required permissions (returns `InsufficientPermissionsError`)
- IAT token is returned to the caller. Never logged. Lifetime is ~1 hour; caller (PR D orchestration) must use it within the request.

**Execution note:** Test the missing-credentials path first — it's the operator-facing error that matters most.

**Patterns to follow:**
- `src/services/github/client.ts` (dynamic import + dual-stage auth flow + null-on-missing-creds posture)
- `packages/gateway/src/config.ts` `readSecret` helper

**Test scenarios:**
- Happy path — `authForRepo('owner', 'repo')` with valid creds + installed App returns `{octokit, installationId, token}`.
- Happy path — second call for the same `(owner, repo)` reuses cached `installationId` (no duplicate JWT call — assert with a mock).
- Edge case — missing `GITHUB_APP_ID_FILE` at config load → `loadGatewayConfig` throws with a clear "set the file" error message.
- Edge case — App not installed on repo → `Result.err(AppNotInstalledError)` with the install URL `https://github.com/apps/fro-bot/installations/new`.
- Edge case — installation has `contents: read` exactly: succeeds without warning.
- Edge case — installation has `contents: write` (over-privileged): succeeds with a WARN log.
- Error path — installation has `contents: none` or no `contents` key: returns `InsufficientPermissionsError` with the App permissions URL.
- Error path — invalid private key format → wrapped as `AuthError`, not a stack trace.
- Error path — IAT request returns 401 → wrapped as `AuthError`. Token NOT in error message.

**Verification:**
- `pnpm --filter @fro-bot/gateway test` green
- `pnpm check-types`, `pnpm lint`, `pnpm build` green
- `docker compose -f deploy/compose.yaml config` validates with the new secret mounts

---

- [ ] **PR C: apps/workspace-agent scaffold + Hono HTTP service**

**Goal:** New `apps/workspace-agent/` sub-app: Hono server on port 9100, `/clone` route handler, packaged + built + wired into `workspace.Dockerfile` to replace `sleep infinity`. Nothing in the gateway calls it yet — that's PR D.

**Requirements:** Prerequisite for S8 (cloning happens inside the workspace, not the gateway)

**Dependencies:** None on PR A/B (independent scaffold).

**Files:**
- Create: `apps/workspace-agent/package.json` (`@fro-bot/workspace-agent`, `hono` dep, tsdown build script, type-check + lint scripts matching other sub-packages)
- Create: `apps/workspace-agent/tsconfig.json` (extends repo base, target `node24`)
- Create: `apps/workspace-agent/tsdown.config.ts` (esbuild bundling, single `dist/main.mjs` entry)
- Create: `apps/workspace-agent/src/main.ts` (Hono server on `0.0.0.0:9100`, mounts the `/clone` route, graceful shutdown on SIGTERM)
- Create: `apps/workspace-agent/src/handlers/clone.ts` (POST handler — body `{owner, repo, token}`; resolves the destination path **internally** to `/workspace/repos/{owner-sanitized}/{repo-sanitized}` per the security requirements; constructs the clone URL itself as `https://github.com/{owner}/{repo}.git`; invokes `execFile('git', [...], {env: scrubbedEnv})` with credentials via `GIT_ASKPASS` (NOT URL substitution, NOT argv); stderr scrubbed of any URL containing `x-access-token:[^@]+@`; returns `{ok: true, sha}` or `{ok: false, error}`)
- Create: `apps/workspace-agent/src/handlers/clone.test.ts` (mock git exec, assert command construction + token never appears in logs)
- Create: `apps/workspace-agent/AGENTS.md` (per-package conventions doc)
- Modify: `deploy/workspace.Dockerfile` — install `apps/workspace-agent/dist/`, change entrypoint to run `node dist/main.mjs` (replacing `sleep infinity`). Install `netcat-openbsd` for the healthcheck.
- Modify: `pnpm-workspace.yaml` — if needed, add `apps/workspace-agent` to the packages array
- Modify: `tsconfig.json` (root) — add workspace-agent project reference if the repo uses solution-style tsconfig
- Modify: `deploy/compose.yaml` — add workspace service healthcheck `nc -z localhost 9100`

**Approach:**
- Hono routes use Hono's `app.post('/clone', async (c) => {...})` shape. Body validation with Hono's `zValidator` if zod is already in the monorepo, else a small hand-rolled validator (keep it minimal). **Body shape: `{owner, repo, token}` — NO `repoPath` field. Path is derived internally.**
- **Defensive credential helper override:** Pass `-c credential.helper=` (empty value, explicitly disables any credential helper) as a global git option in the `execFile` invocation. This prevents the git credential cache or system keychain from caching the IAT after a clone, regardless of the base image's default config. Final spawn arg array: `['-c', 'credential.helper=', 'clone', ...]`.
- **Token handling (security-critical, see Cross-Cutting Security Requirements):**
  - Token enters via request body
  - Spawn git via `execFile('git', ['-c', 'credential.helper=', 'clone', ...], {env: {GIT_ASKPASS: <helper>, GIT_TRACE: '0', GIT_CURL_VERBOSE: '0', GIT_TRACE_PACKET: '0', ...minimalEnv}})` — NEVER inject the token into the command string or remote URL
  - The `GIT_ASKPASS` helper is a small script that reads the token from a private file or pipe and prints it on stdin (token kept out of argv this way)
  - Stderr scrubbed via regex before being included in any error response or log line
  - Token never written to disk, never logged, never persisted
- **Owner/repo sanitization:** validate both against `^[a-zA-Z0-9._-]+$`. Reject anything containing `/`, `..`, empty values, or names that resolve outside `/workspace/repos/`. After clone, `fs.realpath` confirms the resulting path is still beneath `/workspace/repos/` (defense against symlink-following).
- Graceful shutdown: listen for SIGTERM, drain in-flight requests with a 25s timeout, exit clean. Mirror the gateway's shutdown pattern in `packages/gateway/src/shutdown.ts`.
- Dockerfile changes: multi-stage build, final stage runs `node /app/apps/workspace-agent/dist/main.mjs`. Healthcheck = `nc -z localhost 9100` (no HTTP `/healthz` endpoint in v1; matches the gateway pattern from PR #661).

**Execution note:** Test-first for the clone handler — the token-never-logged assertion is a security property worth verifying explicitly.

**Patterns to follow:**
- `packages/gateway/package.json` + `packages/gateway/tsconfig.json` (sub-app structure)
- `packages/gateway/tsdown.config.ts` (build config)
- `packages/gateway/src/shutdown.ts` (graceful shutdown)
- `deploy/gateway.Dockerfile` (multi-stage build pattern, healthcheck shape)

**Test scenarios:**
- Happy path — POST `/clone` with valid `{owner, repo, token}` invokes `execFile('git', ['-c', 'credential.helper=', 'clone', 'https://github.com/{owner}/{repo}.git', '/workspace/repos/{owner}/{repo}'], {env: ...})` (assert the command array exactly — no token in argv), returns `{ok: true, sha}`.
- Edge case — POST `/clone` with missing `token` returns 400 with a clear validation error message.
- Edge case — POST `/clone` with `owner: '../etc'` is rejected at validation (400). Assert no `execFile` call is made.
- Edge case — POST `/clone` with `repo: 'foo/bar'` (slash) is rejected at validation (400).
- Edge case — POST `/clone` with `owner` containing only allowed chars but resolving via symlink outside `/workspace/repos/` (post-clone realpath check) returns `{ok: false, error: 'path escaped workspace'}` and the cloned tree is removed.
- Edge case — `git` subprocess env contains `GIT_TRACE=0`, `GIT_CURL_VERBOSE=0`, `GIT_TRACE_PACKET=0` (assert with a captured spawn env).
- Error path — git clone fails (e.g., repo not found) → returns `{ok: false, error: <scrubbed stderr>}`. Assert the error message contains NO `x-access-token` substring even if git echoed the URL.
- Error path — workspace disk full (`ENOSPC` from git clone): returns `{ok: false, error: 'workspace disk full', code: 'ENOSPC'}`. The orchestrator (PR D) surfaces this to the setup thread with operator instructions: "the workspace volume is out of space; free disk by removing unused repos under /workspace/repos and retry".
- Error path — token never appears in stdout/stderr/captured-logger output across the full request lifecycle (cross-cutting security invariant).
- Error path — request to an unknown route returns 404.

**Verification:**
- `pnpm --filter @fro-bot/workspace-agent test` green
- `pnpm --filter @fro-bot/workspace-agent build` produces `dist/main.mjs`
- `docker compose -f deploy/compose.yaml config` validates
- Local smoke (after `docker compose up`): `curl http://localhost:9100/clone -X POST` from inside the gateway container reaches the workspace, returns expected validation error

---

- [ ] **PR D: workspace-api client + Discord channel management + /add-project slash command**

**Goal:** Ship the slash command. Wire together PR A (bindings) + PR B (auth) + the workspace-api HTTP client. Operator runs `/fro-bot add-project url:<git-url>` and gets a Discord channel bound to a freshly cloned repo. Setup thread shows phase progression. End-to-end `/add-project` works after this lands.

**Requirements:** R2, S8

**Dependencies:** PR A + PR B + PR C all merged.

**Files:**
- Create: `packages/gateway/src/workspace-api/types.ts` — must match PR C's exact handler shapes:
  - `CloneRequest = {owner: string, repo: string, token: string}` (NO `repoPath`, NO `url` — agent derives path; agent constructs URL)
  - `CloneResponse = {ok: true, sha: string} | {ok: false, error: string, code?: string}`
- Create: `packages/gateway/src/workspace-api/client.ts` (`createWorkspaceClient({baseUrl})` returns `{clone}` — returns `Promise<Result<Response, WorkspaceError>>`)
- Create: `packages/gateway/src/discord/channels.ts` (`findOrCreateChannel(guild, name)` — searches existing channels, creates if missing, returns `Result<{channel, created}, ChannelError>`; handles name collisions with `-2`, `-3` suffixes)
- Create: `packages/gateway/src/discord/commands/add-project.ts` (`SlashCommand` with `data.name = 'add-project'`; `execute` orchestrates the 5-phase flow)
- Modify: `packages/gateway/src/discord/commands/index.ts` — register the new command in the registry
- Modify: `packages/gateway/src/config.ts` — add `workspaceAgentUrl` (defaults to `http://workspace:9100`) and `gatewayGitHubAppInstallUrl` (defaults to `https://github.com/apps/fro-bot/installations/new`; overridable for testing)
- Test: `packages/gateway/src/workspace-api/client.test.ts`, `packages/gateway/src/discord/channels.test.ts`, `packages/gateway/src/discord/commands/add-project.test.ts`

**Approach:**

**workspace-api client:**
- Single config: `WORKSPACE_AGENT_URL` env var (defaults to `http://workspace:9100`). Plumbed via `loadGatewayConfig`.
- Use native `fetch` (Node 24+). No HTTP library dep needed.
- `clone` method JSON-stringifies the request body, posts to `/clone`, parses the response, returns `Result<CloneResponse, WorkspaceError>`. Timeout: 5min for clone (large monorepos).
- Network errors, non-2xx responses, JSON parse failures all become `WorkspaceError` variants with discriminated `kind`.

**Channel name derivation and normalization:**
- If operator provides `channel:<name>` option: validate against Discord channel-name rules (lowercase, `[a-z0-9-]`, 1-100 chars, must start with letter/number). Reject anything else at slash-command argument validation.
- If not provided: derive from repo name. Strip scope (`@scoped/package` → `package`), lowercase, replace dots/underscores/uppercase-to-lowercase boundaries with hyphens (`Foo/Bar.baz` → `bar-baz`), collapse multiple hyphens, trim leading/trailing hyphens. If the result is empty after normalization, fail validation with a clear "couldn't derive a channel name from repo name" error.
- **Hostile-name rejection:** explicitly reject channel names containing zero-width characters (`\u200B-\u200D`, `\uFEFF`), RTL overrides (`\u202A-\u202E`, `\u2066-\u2069`), or any character outside the canonical Discord ASCII subset. These are bidi/homoglyph attack vectors that produce channels which look benign in logs but render differently in Discord's UI.

**Slash command help text** (these strings appear in Discord's autocomplete):
- Command description: `"Bind a GitHub repo to a Discord channel"`
- `url` option description: `"GitHub repo URL (https://github.com/owner/repo)"`
- `channel` option description: `"Optional Discord channel name (auto-derived from repo if omitted)"`

**Command shape:** single top-level command `/add-project` (NOT a `/fro-bot add-project` subcommand). The parent Gateway v1 plan documents `/fro-bot` as a logical command family but the existing `/ping` is also a flat command — keep the pattern. The command lives in `packages/gateway/src/discord/commands/add-project.ts` with `data.name = 'add-project'`. Registration in `index.ts` adds it to the registry alongside `ping`.

**Slash command schema:** `/add-project url:<string> [channel:<string>]`. URL validated with regex `^https://github\.com/[^/]+/[^/]+(\.git)?$` at the slash-command argument validation layer (rejects bad URLs before any side effects). Channel name validated per the normalization rules above.

`AddProjectPhase` enum drives the setup-thread progress messages. Each phase transition edits a single message in the setup thread (which is the channel where the slash command was invoked).

**Phase orchestration in pseudo-code (directional, not literal):**
```
PRE_FLIGHT:
  - check bot's effective permissions in the source guild:
      requires MANAGE_CHANNELS (for channel creation) and SEND_MESSAGES (for thread + welcome message)
      on missing: abort with "bot needs MANAGE_CHANNELS — visit <invite-with-elevated-perms-URL>"
      NEVER attempt subsequent steps if permissions are missing
  - parse url → {owner, repo}
  - getBindingByRepo(owner, repo) → if exists, abort with
    "{owner}/{repo} is already bound to #{existing.channelName}; bindings cannot be moved in v1"
  - appClient.authForRepo(owner, repo) → returns {octokit, installationId, token}
    on AppNotInstalledError, abort with install URL
  - resolve target channel name (param or derived from repo name per normalization rules)
CLONING:
  - workspaceClient.clone({owner, repo, token: iat})
    (agent derives path internally per security requirements)
  - on ENOSPC: edit setup-thread message with disk-full operator instructions
    ("the workspace volume is out of space; free disk by removing unused repos under /workspace/repos and retry"),
    phase = FAILED. Don't auto-retry.
  - on other failure: edit msg "clone failed: <scrubbed-error>", phase = FAILED
CREATING_CHANNEL:
  - findOrCreateChannel(guild, channelName)
    (handles -2, -3 suffixes on collision)
  - on failure (e.g., 403 MANAGE_CHANNELS missing): edit msg + invite the operator to grant the permission
WRITING_BINDING:
  - createBinding({owner, repo, channelId: <new channel id>, channelName, workspacePath, createdAt, createdByDiscordId})
  - on BindingExistsError (concurrent setup raced past PRE_FLIGHT): edit msg with the winning binding info; if WE created the channel in CREATING_CHANNEL, document manual cleanup
  - on PartialWriteError (primary written, index failed, rollback also failed): edit msg with manual S3 cleanup instructions naming both keys
  - on StoreError: edit msg with retry instructions; channel left in place; pre-flight on retry will see the channel
READY:
  - edit msg to "ready — try @fro-bot in #channelName"
  - post welcome message in the new channel
```

**Welcome message content:**
- Posted in the newly-bound channel
- Plain text + embed format
- Content (this exact wording):
  ```
  This channel is bound to <repo-owner>/<repo-name>.

  Once the interaction loop (Unit 6) ships, you'll be able to @-mention me here to ask questions or have me act on the repo.

  Until then, this channel is reserved for future use.
  ```
- The "until then" sentence is critical — without it the operator sees `READY` and expects a working @-mention loop, which Unit 6 hasn't shipped yet.

Setup thread lives in the source channel (where the operator ran `/add-project`). Not the new channel. Progress message edits, not new posts — keeps the thread tidy.

Rate-limit handling: Discord 429 → exponential backoff (3 retries, 1s/2s/4s). discord.js handles this natively for most operations; the code just needs to catch and surface.

Slash command deferReply with `ephemeral: false` (operator sees progress; non-ephemeral so it's preserved as a record).

**Execution note:** Test-first for the partial-failure scenarios (channel created but binding write failed; clone succeeded but channel creation failed). These are the operator-facing failure modes that determine whether the command is recoverable.

**Patterns to follow:**
- `packages/gateway/src/discord/commands/ping.ts` (SlashCommand shape, Effect-based execute)
- `packages/gateway/src/discord/mentions.ts` (Discord error handling style)
- `packages/runtime/src/object-store/s3-adapter.ts` (Result-based async API style, structured error variants)

**Test scenarios:**
- Happy path — fresh repo, no existing binding, App installed: phases progress PRE_FLIGHT → CLONING → CREATING_CHANNEL → WRITING_BINDING → READY. Final state: channel created, binding written, welcome message posted.
- Happy path — `channel:custom-name` option uses the specified name instead of repo name.
- Edge case — channel name collision: `owner/repo` already has `#repo` channel → new channel is `#repo-2` (suffix logic).
- Edge case — repo already bound (PRE_FLIGHT): errors with "already bound to #foo-repo" and unbind instructions (since unbind isn't implemented in v1, the instructions explain manual S3 cleanup).
- Edge case — invalid URL (PRE_FLIGHT): rejected at slash-command validation layer.
- Edge case — bot lacks MANAGE_CHANNELS at pre-flight: aborts immediately, no clone or App auth attempted, error message includes re-invite URL.
- Edge case — channel name contains zero-width or RTL override characters: rejected at slash-command argument validation with a clear error.
- Edge case — derived channel name is empty after normalization: fails validation with "couldn't derive a channel name from repo name" error.
- Error path — App lacks access to repo (PRE_FLIGHT): error embed with install link.
- Error path — clone fails (CLONING phase): edit msg "clone failed: <git stderr>", phase = FAILED. No channel created, no binding written.
- Error path — workspace disk full (`ENOSPC` from clone): edit setup-thread message with disk-full operator instructions, phase = FAILED. No auto-retry.
- Error path — channel creation 403 (CREATING_CHANNEL): edit msg with permission-grant link. Clone is preserved (workspace path stays); operator can re-run after granting permission.
- Error path — binding write fails after channel created (WRITING_BINDING): edit msg "channel #X created but binding failed; re-run the command or manually clean up". Pre-flight on retry sees existing channel and either reuses it (if name matches expected derived name) or surfaces collision.
- Edge case — concurrent `/add-project` calls for the same repo: second call's PRE_FLIGHT sees the first call's binding (or its CLONING phase) and aborts cleanly.
- Security check — token in the workspace-api request body is NOT included in any error message.
- Happy path — `clone({owner, repo, token})` POSTs to `/clone` with the right body, returns `Result.ok({ok: true, sha})`.
- Error path — workspace agent returns 500 → `Result.err({kind: 'http-error', status: 500})`.
- Error path — connection refused (workspace not running) → `Result.err({kind: 'network-error'})`.
- Error path — timeout (clone took >5min) → `Result.err({kind: 'timeout'})`.

**Verification:**
- `pnpm --filter @fro-bot/gateway test` green
- `pnpm check-types`, `pnpm lint`, `pnpm build` green
- Type contract matches PR C's types (manual cross-check — types live in gateway, mirror the workspace-agent's request/response shapes)
- Manual smoke (after merge + deploy): `/fro-bot add-project url:https://github.com/marcusrbrown/some-test-repo` in a Discord channel creates the expected outcome
- Manual failure smoke: `/fro-bot add-project url:https://github.com/private/repo-app-cant-see` produces the actionable error embed with install link

## System-Wide Impact

- **Interaction graph:** The gateway gains a second outbound network surface (in addition to Discord WS + S3 + LLM): HTTP to the workspace agent on the internal sandbox network. The workspace container gains an inbound listening port (9100, internal only). The gateway's GitHub App client makes outbound calls to the GitHub API for token issuance and installation lookup.
- **Error propagation:** Slash command errors surface in the Discord setup thread as edited progress-message updates with explicit recovery instructions. Workspace-agent errors propagate through `Result<,>` from `workspaceClient` → orchestration → progress message. GitHub App auth errors include install URLs in their messages so the operator can self-recover. None of these errors crash the gateway daemon.
- **State lifecycle risks:** Partial failures across the 5-phase orchestration leave artifacts behind: cloned repo on disk (recoverable on retry), Discord channel (manual cleanup if binding write fails), no binding (clean retry possible). The pre-flight phase on retry detects existing bindings and reuses or surfaces them. The Gateway v1 plan's scope-review decision accepts manual cleanup over auto-rollback in v1.
- **API surface parity:** This unit introduces the first inbound HTTP surface for the gateway-controlled stack (the workspace agent). Existing patterns: outbound HTTP from the gateway already exists (Discord, S3, GitHub via App client). New consideration: the workspace agent is an internal-only service; never expose port 9100 outside `sandbox-net`. Compose enforces this via `internal: true`.
- **Integration coverage:** Cross-layer scenarios not provable by unit tests alone:
  - Gateway → workspace HTTP round-trip with actual `git clone` (covered by manual smoke after PR C lands)
  - Discord channel creation with realistic permission state (covered by manual smoke after PR D lands)
  - End-to-end `/fro-bot add-project` cycle (covered by manual smoke after PR D + the live Discord guild)
- **Unchanged invariants:** Gateway intent posture (PR #651) unchanged — channel creation does NOT require `GuildMembers` or `MessageContent`. Readiness lifecycle (PR #655) unchanged. Healthcheck (PR #661) unchanged for gateway; workspace gets a new `nc -z localhost 9100` healthcheck. Object-store key layout (PR #514) unchanged except for the additive `'bindings'` content type. Coordination lock protocol (PR #547/#548) unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Workspace agent token leakage via logs | Test-first assertion that token never appears in any log channel (handler tests use a captured logger and `expect(logs).not.toContain(token)`). |
| GitHub App not installed on target repo | Detected at PRE_FLIGHT phase; error embed includes the install URL so the operator self-recovers. |
| Discord rate limits on channel creation (429) | discord.js handles 429 natively with exponential backoff. Slash command catches at orchestration level and surfaces to the setup thread if it ultimately fails after 3 retries. |
| Concurrent `/add-project` calls for the same repo | PRE_FLIGHT binding check is the serializer. `createBinding` uses `IfNoneMatch: '*'` for atomic create — the loser gets `BindingExistsError` and surfaces "already bound" cleanly. |
| Compose service-name change breaks workspace URL | `WORKSPACE_AGENT_URL` env var defaults to `http://workspace:9100`; can be overridden. README docs note the coupling. |
| Hono added to monorepo deps | Locked to specific minor version range in `package.json`. Bundle size impact ~14kb gzipped — acceptable. |
| Workspace `git clone` of large repo exceeds timeout | Default timeout configurable per-call. PR D uses 5min for clone (large monorepos). |
| Workspace container restart loses cloned repos | Workspace volume is a named volume (per Unit 4); survives container restart. Repo state survives. |
| Channel-name homoglyph attack | Rejected at slash-command validation; canonical ASCII subset enforced. |
| Workspace disk exhaustion | Distinct ENOSPC error surfaced to operator with cleanup instructions; quota enforcement deferred to post-v1. |

## Documentation / Operational Notes

- `deploy/README.md` updates land in PR B (GitHub App secret setup) and PR C (workspace agent service description). Updated again in PR D to document the slash command flow.
- New operator-facing setup steps for the App:
  1. Install the `@fro-bot` GitHub App on the repos you want to bind
  2. Generate App ID + private key, write to `secrets/github-app-id` and `secrets/github-app-private-key`
  3. Restart the gateway
  4. In Discord, run `/fro-bot add-project url:https://github.com/owner/repo`
- After PR D merges, update the gateway v1 plan (`docs/plans/2026-04-18-001-...-plan.md`) Unit 5 checkbox to `[x]` and note "shipped in PRs A/B/C/D (numbers)".

## Sources & References

- **Parent plan:** `docs/plans/2026-04-18-001-feat-fro-bot-gateway-discord-v1-plan.md` Unit 5
- **Origin brainstorm:** `docs/brainstorms/2026-04-17-fro-bot-gateway-discord-requirements.md`
- **GitHub App auth pattern:** `src/services/github/client.ts`
- **Object-store types + key builder:** `packages/runtime/src/object-store/{types,key-builder}.ts`
- **Conditional writes:** `packages/runtime/src/object-store/s3-adapter.ts`
- **Existing slash command:** `packages/gateway/src/discord/commands/ping.ts`
- **Discord intents posture (PR #651):** `packages/gateway/src/discord/client.ts`
- **Sub-app conventions:** `packages/gateway/{package.json,tsconfig.json,tsdown.config.ts}`
- **Compose sandbox-net:** `deploy/compose.yaml`
- **Workspace placeholder:** `deploy/workspace.Dockerfile`
- **Institutional learnings:** `docs/solutions/code-quality/architectural-issues-type-safety-and-resource-cleanup.md`, `docs/solutions/workflow-issues/delivery-mode-contract-for-manual-triggers-2026-04-17.md`, `docs/solutions/best-practices/versioned-tool-config-plugin-pattern-2026-03-29.md`
