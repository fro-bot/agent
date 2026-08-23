---
title: "feat: /fro-bot dispatch — trigger Action runs from Discord"
type: feat
status: done
date: 2026-08-22
origin: docs/brainstorms/2026-04-17-fro-bot-gateway-discord-requirements.md
---

# feat: /fro-bot dispatch — trigger Action runs from Discord

## Overview

Ship Unit 7A of the gateway roadmap: a Discord `/fro-bot dispatch task:<task>` subcommand that triggers the repository's fixed GitHub Action workflow for the repo bound to the invoking channel and returns the accepted run's URL.

This plan supersedes Unit 7, “Cloud dispatch + summaries bridge,” in `docs/plans/2026-04-18-001-feat-fro-bot-gateway-discord-v1-plan.md`. The implementation scope is deliberately limited to dispatch acceptance. Completion notification and the summaries bridge remain separate tasks.

## Problem Frame

Work that needs the Action's environment — matrix CI, secrets-heavy operations, long-running jobs — currently has no path from Discord. A user in a bound channel can mention the bot for local execution in the gateway's workspace, but cannot reach the Action at all without leaving Discord for the GitHub UI.

The April plan specified this capability and it never shipped. Its design predates the operator web surface, the object-store key builder, run-state coordination, and the release-notes narration flow that gave `correlation-id` its current meaning, so the original unit is no longer implementable as written.

## Requirements Trace

- **R3:** Reuse the channel binding as the authoritative repo context. The task is user-authored session content and must be treated as untrusted input by the Action. No cross-surface session resume is introduced.
- **R4:** Preserve local execution as the default gateway behavior while adding explicit cloud dispatch. Unit 7A reports acceptance and a run link only; progress reporting is deferred because it needs durable dispatch state plus webhook ingress or a background reconciler. R4 is therefore only partially satisfied by this unit.
- **S4:** Implement `/fro-bot dispatch` → `workflow_dispatch` with the fixed `.github/workflows/fro-bot.yaml` workflow and `{prompt: task}` input. The origin requirement names `/fro-bot cloud`; the shipped command intentionally uses `/fro-bot dispatch` by owner decision. Unit 7A returns the run URL only, not Action progress updates, so S4 is only partially satisfied.
- **S7:** Keep the feature self-hostable. The gateway remains the caller, the GitHub App remains the credential boundary, and deployment documentation must describe the additional narrowly scoped App permission.

### Deliberate Deviations from Origin

1. **Command name:** The command is `/fro-bot dispatch`, not `/fro-bot cloud`. This is an explicit owner decision.
2. **Acceptance-only delivery:** Unit 7A returns the accepted run link only, not progress updates. Discord interaction tokens expire after 15 minutes while Action runs routinely exceed that window; durable `DispatchRecord` state and either signed `workflow_run` webhook ingress or a background reconciler are required for reliable later updates. R4/S4 are only partially satisfied until that work ships.

## Scope Boundaries

### In Scope

- Add the `dispatch` subcommand to the existing `/fro-bot` parent command.
- Require a non-empty, trimmed `task` string.
- Resolve the repo only from `bindingsStore.getBindingByChannelId(channelId)`.
- Authorize with the existing `userIsAuthorized` trigger-role gate: the configured trigger role, or guild-level ManageChannels when no trigger role is configured.
- Resolve the repository default branch through `GET /repos/{owner}/{repo}`.
- Dispatch the fixed `.github/workflows/fro-bot.yaml` workflow on that default branch with only the `prompt` input.
- Return typed outcomes and a user-facing reply that says GitHub **accepted** the dispatch, never that the work succeeded.
- Keep dispatch outside the local execution slot and per-channel `RunTask` queue. GitHub Actions performs authoritative per-repo lock acquisition through the existing Action routing.
- Add the dedicated GitHub App workflow-dispatch capability, tests, command wiring, program injection, and deployment documentation.

### Out of Scope

- Arbitrary repo, ref, workflow path, task type, model, PR/issue number, or `correlation-id` options.
- Completion notifications, progress updates, polling, webhook ingress, or durable dispatch records.
- Summaries publication, storage, or reading.
- Changes to `packages/gateway/src/execute/*`.
- Changes to `.github/workflows/fro-bot.yaml`; its existing `prompt` input is sufficient.

### Deferred to Separate Tasks

- **7B — completion notification** (~5–7 days plus ingress configuration). Prefer a signed `workflow_run` webhook only if public ingress becomes a supported deployment requirement. The Hono listener is currently gateway-net only. Add a dedicated durable `DispatchRecord`; do not overload `RunState`, because the Action deliberately creates no `RunState` and GitHub is canonical for Action status.
- **7C — summaries bridge** (~5–8 days). It currently has no consumer: it was designed to feed `/fro-bot review <pr>`, which does not exist. Building publisher, storage, and reader now would create dead code. `writeSessionSummary` at `packages/runtime/src/session/writeback.ts:56` is not this bridge; it appends a synthetic message to the current OpenCode session and serves a different purpose. If the bridge is built later, route keys through `buildObjectStoreKey` at `packages/runtime/src/object-store/key-builder.ts:22` rather than the April plan's raw `summaries/{owner}/{repo}/...` scheme so configured prefixes, identity namespacing, and validation remain intact.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "packages/gateway",
  "freshness": {"vcs_reference": "main"},
  "budget": {"max_search_passes": 1, "max_candidate_inspections": 3, "exhausted": false},
  "candidates": [
    {"path_or_symbol": "packages/gateway/src/github/app-client.ts", "description": "GitHub App installation token minting, currently contents:read only", "disposition": "extend"},
    {"path_or_symbol": "packages/gateway/src/discord/commands/fro-bot.ts", "description": "parent slash command with subcommand routing and makeGuildCommand executors", "disposition": "extend"},
    {"path_or_symbol": "packages/gateway/src/execute/run.ts", "description": "local OpenCode execution with queue and concurrency", "disposition": "insufficient"}
  ]
}
```

## High-Level Technical Design

The feature has three boundaries:

1. **Capability boundary — `packages/gateway/src/github/app-client.ts`:** retain `REQUIRED_PERMISSIONS` as the ordinary `contents: read` minimum. Add a dedicated `authForWorkflowDispatch()` capability that verifies the installation has `Actions: write`, mints a repository-scoped token with only the permissions required for dispatch, and preserves the existing installation cache and secret-redaction invariants. A missing permission must retain the App install URL for the Discord outcome.
2. **GitHub adapter — `packages/gateway/src/github/dispatch.ts`:** authenticate, resolve the default branch, and call the workflow dispatch endpoint for `.github/workflows/fro-bot.yaml`. Use a raw Octokit request with `X-GitHub-Api-Version: 2026-03-10`, a local minimal response type, and runtime shape parsing. Do not use `@octokit/rest`, the typed plugin endpoint, or the obsolete `return_run_details: true` flag. Do not send `correlation-id`.
3. **Discord adapter — `packages/gateway/src/discord/commands/dispatch.ts`:** use `makeGuildCommand` for the normal defer/auth/work pipeline, resolve the binding, call the injected `dispatchWorkflow` primitive, and map every typed outcome to safe reply copy. Extend `FroBotDeps` and construct the primitive in `program.ts`; do not use module globals.

The parent command remains the single registered command. `packages/gateway/src/discord/commands/index.ts` is intentionally unchanged because it already registers the parent returned by `createFroBotCommand()`.

### Typed Outcomes

The dispatch adapter exposes an exhaustive outcome set:

- `accepted` — repository, run ID, and run HTML URL.
- `invalid-task` — the command input is empty after trimming.
- `channel-unbound` — no binding exists for the interaction channel.
- `app-not-installed` — repository plus App installation URL.
- `missing-actions-permission` — repository plus App installation URL.
- `repo-not-found` — the repository lookup or default-branch resolution cannot find the repo.
- `workflow-not-found` — the fixed workflow is absent on the repository's default branch.
- `dispatch-rejected` — GitHub rejected the request with a non-success response or malformed success payload.
- `github-unavailable` — GitHub API/network failure, including 5xx responses.

The Discord mapping must use an exhaustive `switch` with a `const exhaustiveCheck: never` guard. Unexpected throws still fall through the shared `INTERNAL_ERROR_COPY` path.

## Key Technical Decisions

- **Use `/fro-bot dispatch`, not `/fro-bot cloud`:** explicit owner decision; the implementation and documentation use one name consistently.
- **Never send `correlation-id`:** `.github/workflows/fro-bot.yaml` treats any non-empty value as release-notes mode, which changes output mode to `working-dir`, suppresses GitHub response delivery with `response-mode: none`, and applies a 600-second timeout. A dispatch command must not accidentally enter that mode.
- **Dispatch the default branch only:** resolve it from `GET /repos/{owner}/{repo}` and do not expose an arbitrary ref. The workflow runs repository-local actions and scripts while holding secrets and minting App credentials.
- **Use raw API request and parse the response locally:** the installed Octokit stack types the dispatch endpoint as `204` with no body, while the current API returns `200` with nested `workflow_run` details. The local parser isolates this API/version mismatch and rejects malformed shapes.
- **Keep ordinary App auth narrow:** Actions: write is required only for dispatch. Add it through `authForWorkflowDispatch()` rather than widening the shared `REQUIRED_PERMISSIONS` constant, so ordinary gateway tokens continue requesting only `contents: read`.
- **No local queue or slot participation:** dispatch consumes no local execution resources. The Action owns the authoritative per-repo lock; a successful API acceptance can still lead to a skipped run if another surface holds that lock.
- **Say accepted, not succeeded:** the reply describes GitHub's acceptance of the dispatch and includes the run link. It does not imply the Action completed successfully.

## Implementation Units

- [x] **Unit 1: Add scoped workflow-dispatch capability to the GitHub App client**

**Files:** modify `packages/gateway/src/github/app-client.ts`, `packages/gateway/src/github/app-client.test.ts`.

Extend the App client with a dispatch-specific authorization path. Keep ordinary repository authentication behavior and `REQUIRED_PERMISSIONS` unchanged. Verify `Actions: write` separately, retain the installation URL in the typed error, and mint a token scoped to the requested repository. Keep token, private key, and JWT values out of logs.

**Required test scenarios:**

- Installation grants `contents: read` and `actions: write` → dispatch capability returns an authenticated client/token and the repository scope is preserved.
- Installation grants `contents: read` but no Actions write permission → returns the typed insufficient-permission error with the install URL and does not cache an unusable dispatch capability.
- Installation is absent → returns `AppNotInstalledError` with the install URL.
- Token minting or discovery fails → returns a safe auth error without logging credentials.
- Ordinary `authForRepo` with `contents: read` → remains successful without requiring Actions write.

- [x] **Unit 2: Implement the typed GitHub workflow-dispatch adapter**

**Files:** create `packages/gateway/src/github/dispatch.ts` and `packages/gateway/src/github/dispatch.test.ts`.

Create the gateway-level dispatch primitive. It resolves the binding's owner/repo through the repository endpoint, uses the repository's default branch, calls the fixed workflow with `prompt: task`, sends the explicit API-version header, parses the nested `workflow_run` response, and maps GitHub/App failures to the closed outcome set. The adapter must not accept or synthesize arbitrary refs or correlation IDs.

**Required test scenarios:**

- Valid task, repository metadata with default branch, and a `200` response containing nested `workflow_run` → returns `accepted` with repo, run ID, and HTML URL.
- Whitespace-only task → returns `invalid-task` and makes no GitHub request.
- Missing repository metadata → returns `repo-not-found`.
- Fixed workflow absent on the default branch → returns `workflow-not-found`.
- App absent → returns `app-not-installed` with install URL.
- App lacks Actions write → returns `missing-actions-permission` with install URL.
- GitHub 5xx or transport failure → returns `github-unavailable`.
- GitHub returns a non-success dispatch response → returns `dispatch-rejected`.
- Successful request payload inspection → confirms the ref is the resolved default branch, inputs contain only `prompt`, and `correlation-id` is never sent.
- `200` response with a malformed or missing nested `workflow_run` → returns `dispatch-rejected` rather than fabricating a run link.

- [x] **Unit 3: Wire `/fro-bot dispatch`, program injection, and deployment documentation**

**Files:** create `packages/gateway/src/discord/commands/dispatch.ts` and `packages/gateway/src/discord/commands/dispatch.test.ts`; modify `packages/gateway/src/discord/commands/fro-bot.ts`, `packages/gateway/src/discord/commands/fro-bot.test.ts`, `packages/gateway/src/discord/commands/index.test.ts`, `packages/gateway/src/program.ts`, `packages/gateway/src/program.test.ts`, and `deploy/README.md`.

Add the required `task` option to the parent builder and route `dispatch` through a factory-built executor. Extend `FroBotDeps` with the injected `dispatchWorkflow` primitive, construct it once in `program.ts`, and keep the existing parent registry path unchanged. Resolve the channel binding inside the command, apply the normal trigger authorization bar, and map all outcomes with exhaustive handling. Document the command, the accepted-only behavior, and the GitHub App Actions: write requirement in `deploy/README.md`.

The command must not enqueue a `RunTask`, acquire the gateway concurrency slot, create local `RunState`, or call local execution code. It should defer, authorize, dispatch, and edit the interaction with the final acceptance or failure copy.

**Required test scenarios:**

- Bound channel plus authorized user plus successful adapter result → replies that GitHub accepted the dispatch and includes the run URL; does not claim success.
- Unbound channel → replies with the channel-unbound guidance and does not call the adapter.
- Whitespace-only task → replies with invalid-task guidance and does not call the adapter.
- User without the configured trigger role → denied; with no trigger role, a user with ManageChannels is authorized.
- Adapter returns `app-not-installed` or `missing-actions-permission` → reply includes the repository and install URL without exposing tokens or internal errors.
- Adapter returns `workflow-not-found`, `repo-not-found`, `dispatch-rejected`, or `github-unavailable` → each maps to the intended safe copy.
- Parent builder exposes `dispatch` with required `task`, while the existing parent command remains the sole registered command.
- Injected primitive is constructed and passed through program wiring; tests do not require real GitHub or Discord network calls.
- Exhaustiveness guard remains present and catches an unhandled outcome at type-check time.
- Regression coverage confirms the command path does not add the `correlation-id` input or enter the local queue/concurrency path.

## Deployment and Operational Notes

- The GitHub App installation must grant Actions: write in addition to the existing contents: read capability. The implementation requests this through the dispatch-specific capability only.
- The workflow remains `.github/workflows/fro-bot.yaml`; no workflow change is needed because its existing `prompt` input is sufficient.
- The command is self-hosted with the existing gateway deployment. `deploy/README.md` must state the setup requirement and show `/fro-bot dispatch task:<task>`.
- Rate limiting is not included in Unit 7A. Repeated dispatches consume GitHub Actions minutes and currently have no gateway-side guard.

## Risks

- **Actions: write broadens the gateway App capability.** Mitigate with the dedicated `authForWorkflowDispatch()` path and repository-scoped tokens; do not widen `REQUIRED_PERMISSIONS`.
- **`correlation-id` misuse silently creates a no-response run.** Mitigate by omitting the input entirely and keeping a request-payload regression test.
- **Users may read “accepted” as “succeeded.”** Mitigate with explicit reply copy that names GitHub acceptance and links the run without claiming completion.
- **Unbounded Actions spend.** Repeated dispatches are currently possible. The command should be observable and documented as a future rate-limit concern.
- **Run lookup or response-shape drift.** Mitigate with the explicit API version, raw request, local response parser, and malformed-response tests.
- **Lock contention after acceptance.** A dispatch can be accepted and later skipped when another surface owns the repository lock. Mitigate by describing acceptance rather than execution success; completion semantics belong to 7B.

## Open Questions — Deferred to Implementation

- **Rate limiting:** raised during scoping. Add a per-user or per-channel dispatch limit before broadening usage, because every accepted request can consume GitHub Actions minutes. Decide the initial budget, window, and whether a successful API acceptance or only a completed run counts against it.

## Verification

- Run `bun run check:md-links` after writing the plan.
- Confirm every cited repository-relative path resolves.
- No source files, workflow files, generated files, or lockfiles are changed by this plan.
