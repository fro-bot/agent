---
title: 'Native session tools: always-on session_list/read/search/info'
status: active
created: 2026-07-13
issue: https://github.com/fro-bot/agent/issues/1188
requirements: none (issue #1188 + operator directive are the requirements)
type: feat
depth: standard
---

# Native session tools plan

## Problem

The agent prompt unconditionally instructs the model to use `session_search` / `session_read` (`packages/runtime/src/agent/prompt.ts`, Session Management block), but those tools exist only when oMo is installed (`enable-omo`). Non-oMo runs get a prompt that references tools the model does not have. Issue #1188 documents the mismatch; the chosen direction (operator decision, contrary to the triage suggestion of gating the prompt) is to make the promise true: implement the session tools natively in the harness so every run has them, with oMo's richer implementations taking precedence when oMo is enabled.

## Verified design facts

All verified against the vendored OpenCode 1.17.18 source (`.slim/clonedeps/repos/anomalyco__opencode`) and a live `opencode serve` 1.17.18 probe:

1. **Delivery: config-dir file tool.** The tool registry loads config-dir `{tool,tools}/*.{js,ts}` files BEFORE plugin tools into the same `custom` list (`registry.ts:172-193`), and tool resolution assigns later-wins by id — so an oMo plugin tool with the same id silently overrides a file tool. Shipping ours as a file tool gives exactly the required precedence (oMo wins when present) deterministically.
2. **Naming.** A file `tool/session.js` with named exports `list` / `read` / `search` / `info` registers as `session_list` / `session_read` / `session_search` / `session_info` (`${namespace}_${export}`, `registry.ts:184`). Verified live via `/experimental/tool/ids`.
3. **Tool shape.** A plain object `{description, args, execute}` passes `isPluginTool` (`registry.ts:346-348`) — no `@opencode-ai/plugin` import needed. Plain-object JSON-schema args flow through `legacyJsonSchema` (`registry.ts:354`). The bundled tool file therefore needs zero runtime imports.
4. **Session store access: loopback HTTP.** The tool file reads a harness-provided env var (`FRO_BOT_OPENCODE_URL`) and fetches the server's own HTTP API. Verified live: import-time and execute-time fetches both succeed (200) against `/session?directory=…`; default server is unauthenticated on loopback (same posture the harness uses today — no new credential surface).
5. **Env plumbing.** The env var must be set before `createOpencode` spawns the child. `bootstrapOpenCodeServer` (`packages/runtime/src/agent/server.ts:22`) is the seam; `filterAgentEnv` must allowlist the var (non-secret loopback URL).
6. **Contract (current oMo main; string outputs):**
   - `session_list {limit?, from_date?, to_date?, project_path?}`
   - `session_read {session_id!, include_todos?, include_transcript?, limit?}`
   - `session_search {query!, session_id?, case_sensitive?, limit?}`
   - `session_info {session_id!}`
7. **Reuse.** `packages/runtime/src/session/` already implements the mechanics against a `SessionClient` SDK client: `listSessions`, `searchSessions`, `getSessionInfo`, `getSession`, `getSessionMessages`, `getSessionTodos`. The tool file constructs its client with `createOpencodeClient({baseUrl})` from `@opencode-ai/sdk` (bundled in).

## Key decisions

- **File tool, not plugin** — deterministic oMo-override precedence per registry order; no plugin load-order dependence.
- **Never deviate from the oMo contract** — match tool names, params, and string outputs exactly, so the oMo override is invisible to the model and the prompt text stays accurate under both configurations. No extra params, no extra tools.
- **No import-time side effects** in the tool file; all I/O inside `execute()`; fail-soft (`'session store unavailable'` + reason) when the env var is absent or fetch fails. A session-tool failure must never fail the run.
- **Self-contained bundle** — a dedicated tsdown entry emits `dist/session-tools.js` with session code + SDK client inlined; the setup phase copies it into the CI OpenCode config dir. No module resolution at load time.
- **Prompt stays unconditional** — the Session Management block is updated to describe all four tools accurately (it becomes true for every run).

## Units

### U1 — session tool definitions (runtime)

**Create:** `packages/runtime/src/agent/session-tools.ts` (+ colocated test)

A factory `createSessionTools(resolveBaseUrl: () => string | undefined)` returning `{list, read, search, info}` plain-object tool definitions implementing the oMo contract via the existing session module. The factory is the testable unit (inject a stub resolver + stub fetch). The module also exports the four concrete tool objects as named exports — `export const {list, read, search, info} = createSessionTools(() => process.env.FRO_BOT_OPENCODE_URL)` — which is the shape the bundle entry re-exports (named exports `list`/`read`/`search`/`info` are what the registry turns into `session_*` ids). The env read happens inside `execute()` via the resolver (probe finding: no import-time work). Output formatting: human-readable strings mirroring oMo's shapes (list table, read transcript with optional todos, search matches with context, info summary). Fail-soft on: missing env var, fetch/HTTP errors, unknown session id. Logger-free (runs inside the OpenCode server process, not the harness) — errors surface in the returned string.

**Tests:** contract-shape tests (arg schemas match the documented oMo params), behavior tests against a stubbed fetch/SessionClient, fail-soft paths.

### U2 — self-contained bundle entry

**Modify:** `tsdown.config.ts`, `scripts/build-action-dist.ts` (if entry lists are mirrored there), `package.json` build wiring as needed.

New entry `packages/runtime/src/agent/session-tools.ts` (or a thin entry file re-exporting the four named tool objects) emitting `dist/session-tools.js`. The existing config already inlines `@opencode-ai/sdk` via `noExternal` (tsdown.config.ts:44-63); the scrub + default-version invariant plugins glob all `dist/**/*.js` and cover the new file automatically (verified: scripts/build-action-dist.ts:71-155, tsdown.config.ts:27-40). Committed-dist invariant applies: deterministic rebuild (two consecutive builds byte-identical).

**Verify:** the emitted file has no bare imports (self-contained), exposes exactly the four named exports, and passes the `isPluginTool` shape when imported by a scratch script.

### U3 — setup writer

**Modify:** `src/services/setup/ci-config.ts` (or sibling new file `session-tools-config.ts` following `systematic-config.ts` pattern) + tests.

During setup, copy the committed `dist/session-tools.js` shipped with the action into the CI OpenCode config dir as `tool/session.js` (config-dir semantics per `writeSystematicConfig`, systematic-config.ts:12-35).

**Asset resolution (the load-bearing mechanism, absent from the repo today):** the action executes the committed `dist/main.js` directly (action.yaml, node24), so inside the bundle `path.dirname(fileURLToPath(import.meta.url))` IS the dist directory and `session-tools.js` is a sibling file. The writer resolves the source as `new URL('./session-tools.js', import.meta.url)` with an injectable override (adapter pattern) for tests — under vitest the code runs from `src/`, where no sibling exists, so tests always inject. Fail-soft if the asset is missing at runtime: warn and continue (run degrades to today's tools-absent reality — prompt promises tools that aren't there, which is exactly the pre-fix state, never worse).

Always written (tools are always-on); oMo installation is untouched (its plugin tools override by id at registry time).

### U4 — server URL seam

**Modify:** `packages/runtime/src/agent/server.ts` (`bootstrapOpenCodeServer`), `packages/runtime/src/agent/filter-env.ts`, tests for both.

Pin loopback server address: pass `hostname: '127.0.0.1'` + a chosen free port to `createOpencode`, set `process.env.FRO_BOT_OPENCODE_URL = server URL` before the spawn (inside the `withScrubbedEnv` scope so the child inherits it), restore after. Allowlist `FRO_BOT_OPENCODE_URL` in `filterAgentEnv` (non-secret loopback URL) with the same guard-test pattern used for `GH_CONFIG_DIR` (a future allowlist edit that drops it must fail a test).

### U5 — prompt update

**Modify:** `packages/runtime/src/agent/prompt.ts` (Session Management block) + prompt tests.

Describe all four tools (`session_list`, `session_search`, `session_read`, `session_info`) with the accurate contract; remove any oMo-conditional phrasing ambiguity. The block stays unconditional — it is now true for every run.

### U6 — end-to-end proof

Two-part verification:

1. **Happy-path live smoke** (post-merge `workflow_dispatch` on this repo): task instructs the model to call `session_list` + `session_search` and report results. Proves: tool file lands in the config dir, registry picks it up, loopback access works under the scrubbed child env, bundle runs in the server runtime (risk 2), and — on an oMo-enabled run — the override produces no duplicate-tool errors (risk 1).
2. **Failure-path proof (unit-level, pre-merge):** tests pinning fail-soft behavior — env var absent → 'session store unavailable' string (never a throw); fetch failure → error string; unknown session id → not-found string; U3 writer with missing asset → warn + continue. These cover risks 3-4 without needing a live failure injection.

## System-wide impact

- **dist/** gains `session-tools.js` — committed-dist invariant, deterministic build required.
- **filterAgentEnv allowlist** grows by one non-secret key — guard test updated in lockstep (the #1148 lesson: the allowlist chain is load-bearing).
- **No contract-version or SSE impact.** No gateway impact (gateway runs its own OpenCode config; adopting the tools there is out of scope).
- **oMo runs:** identical behavior to today except the prompt is accurate; oMo tools override by id (verified registry semantics).

## Risks

| Risk | Mitigation |
| --- | --- |
| Registry semantics change upstream (file-vs-plugin precedence) | Contract pinned by U6 live smoke per release bump; vendored-source citation in code comment |
| Bundle drags in Node-API surface unavailable in server runtime | U2 scratch-import verification + U6 live proof |
| Tool failure poisons the run | Fail-soft everywhere; tools never throw; string error returns |
| Env var stripped by scrub | Allowlist + guard test (U4) |

## Out of scope

- Gateway adoption of the tools (separate surface, separate config).
- Any oMo changes; any prompt gating (superseded by this direction).
- `from_end`/extended params beyond the current oMo contract.
