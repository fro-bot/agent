---
title: "feat: Agent Cohesion via Deterministic Session Continuity"
type: feat
status: active
date: 2026-03-22
origin: docs/brainstorms/2026-03-22-agent-cohesion-session-context-brainstorm.md
---

## Enhancement Summary

**Deepened on:** 2026-03-22 **Sections enhanced:** 8 **Research agents used:** Oracle (architecture review), 3x Librarian (prompt ordering, SDK patterns, GitHub Actions artifacts), Explore (codebase patterns), Librarian (session continuity patterns)

### Critical Findings

1. **Title auto-update risk**: OpenCode auto-overwrites session titles based on first message content (`packages/opencode/src/session/prompt.ts:1963-1968`). A title set at creation (`fro-bot: pr-347`) may be replaced with an auto-generated summary. **Mitigation**: Re-set title via `session.update()` after first prompt, or use the `search` query parameter for lookup instead of relying on exact title preservation.
2. **Server-side title search exists**: The `listGlobal()` endpoint accepts a `search` parameter for case-insensitive title filtering (`packages/opencode/src/server/routes/experimental.ts:223`). This avoids the N+1 performance issue of client-side filtering.
3. **`listSessions()` is expensive**: Current implementation reads messages for every session to extract agent names (`src/services/session/search.ts:40-41`). Using it for title lookup triggers N+1 message reads. Use `listSessionsForProject()` from `storage.ts` or SDK `search` parameter instead.
4. **Exact match required**: Prefix matching `fro-bot: pr-34` would collide with `fro-bot: pr-347`. Use exact string equality, not prefix/substring matching.
5. **Prompt "Instruction Sandwich"**: LLMs exhibit U-shaped attention (primacy + recency). Moving Agent Context to position 11 risks the agent missing critical constraints. Keep a short non-negotiable rules block at position 1 AND duplicate key constraints at the end.
6. **Session busy state**: Before continuing a session, must check it's not busy/compacting. OpenCode's `assertNotBusy()` will reject prompts to active sessions.

### New Considerations Discovered

- XML tags are 23% more effective than Markdown headers for Claude's structural parsing (Anthropic 2026 Context Engineering Guide)
- GitHub Copilot coding agent uses entity-scoped keys (Issue/PR ID) for session identity — validates our logical key approach
- "Rolling Summary" pattern (summary + key decisions + outstanding todos) reduces prior-work token cost by ~80% while preserving decision context
- `upload-artifact@v4+` recommends `retention-days: 7`, `compression-level: 9`, and `include-hidden-files: true` for log artifacts

---

# Agent Cohesion via Deterministic Session Continuity

## Overview

Introduce deterministic logical session keys so repeated agent runs on the same PR, issue, discussion, or scheduled task preferentially continue the same session lineage rather than creating a new session every time. Restructure prompts so the agent sees its own prior thread context before generic history. Ship observability improvements alongside so the behavior is measurable from day one.

## Problem Statement

The agent currently has **persistence without continuity**. Every run calls `client.session.create()` (`src/features/agent/execution.ts:53`) and gets a new session with a meaningless timestamp title. Prior work is discovered via fuzzy text search using `issueTitle ?? repo` (`src/harness/phases/session-prep.ts:42`), which is:

- **Unstable**: Issue titles change. Repository names are too broad to be useful as a search key.
- **Non-deterministic**: The same PR can match different prior sessions across runs depending on title edits or session content evolution.
- **Context-burying**: Even when prior work is found, it appears in the `## Prior Session Context` section near the bottom of the prompt, below generic operating rules, task directives, environment info, and response protocol.

The result: the agent frequently re-investigates issues, doesn't recall its own decisions from prior runs, and presents generic context where specific thread continuity should dominate.

### Case Study Evidence (see brainstorm: docs/brainstorms/2026-03-22-agent-cohesion-session-context-brainstorm.md)

- PR test runs (via `ci.yaml`) preserve prompt/log artifacts; real Fro Bot runs (via `fro-bot.yaml`) do not upload `opencode-logs`.
- OpenCode creates sessions titled "New session - 2026-03-22T06:52:13.670Z" — useless as stable lookup keys.
- Prompts front-load generic operating rules before the most important continuity signal.
- Noise like `Blocked 3 postinstalls` and `tool.registry ... invalid` appears in logs without being clearly actionable or suppressed.

## Proposed Solution

A balanced continuity-first rollout phased across four work streams:

1. **Logical Keys** — Deterministic entity-scoped keys derived from trigger context
2. **Session Mapping** — Persistent key-to-session-ID mapping with fallback to deterministic retrieval
3. **Prompt Restructuring** — Thread identity near the top; current thread before historical context
4. **Observability** — Universal log/prompt artifact retention for all trigger types

## Technical Approach

### Architecture

```
NormalizedEvent
      |
      v
buildLogicalKey(TriggerContext) --> LogicalSessionKey
      |                                    |
      v                                    v
session-prep.ts                    execution.ts
  listSessions() + filter          session.create({ body: { title } })
  by title prefix match            OR continue existing session
      |                                    |
      v                                    v
resolvedSessionId              prompt.ts
  (continue or create)           thread identity section at top
                                 current thread context before history
```

The logical key is the new first-class concept. It answers: "What logical conversation does this run belong to?"

The **session title** is the persistence mechanism. When creating a session, we set the title to a prefixed logical key (e.g., `fro-bot: pr-347`). On subsequent runs, we list sessions and match by title prefix. This gives us:

- **O(1) stability**: The title is immutable once set by us and survives across cache cycles.
- **Human readability**: Visible in OpenCode UI and logs.
- **Self-healing**: No external state file to corrupt or lose — the truth lives in the sessions themselves.
- **Searchable fallback**: Title text is searchable alongside session content.

### Logical Key Design

Each trigger family maps to a deterministic key:

| Event Type                    | Key Pattern           | Source Fields                                            |
| ----------------------------- | --------------------- | -------------------------------------------------------- |
| `issue_comment` (on issue)    | `issue-{number}`      | `event.issue.number`, `!event.issue.isPullRequest`       |
| `issue_comment` (on PR)       | `pr-{number}`         | `event.issue.number`, `event.issue.isPullRequest`        |
| `discussion_comment`          | `discussion-{number}` | `event.discussion.number`                                |
| `issues`                      | `issue-{number}`      | `event.issue.number`                                     |
| `pull_request`                | `pr-{number}`         | `event.pullRequest.number`                               |
| `pull_request_review_comment` | `pr-{number}`         | `event.pullRequest.number`                               |
| `schedule`                    | `schedule-{hash}`     | SHA-256 of cron expression or `schedule-default`         |
| `workflow_dispatch`           | `dispatch-{runId}`    | `context.runId` (each manual dispatch is its own thread) |

The key is scoped to `{owner}/{repo}` implicitly (sessions are already project-scoped via workspace path). The key format is `{entity-type}-{identifier}` — simple, stable, loggable.

**Implementation**: Pure function `buildLogicalKey(context: TriggerContext): LogicalSessionKey | null`

```typescript
export interface LogicalSessionKey {
  readonly key: string
  readonly entityType: "discussion" | "dispatch" | "issue" | "pr" | "schedule"
  readonly entityId: string
}
```

Note: The existing dedup phase (`src/harness/phases/dedup.ts:20-38`) already extracts entity type and number for PR/issue events via `extractDedupEntity()`. The logical key function should follow the same pattern but cover all trigger families.

#### Research Insights: Key Design Edge Cases

**Industry validation**: GitHub Copilot coding agent uses entity-scoped keys (Issue ID / PR ID) as the primary anchor for session identity. A `findLinkedCopilotPR` function searches for PRs authored by the bot that reference a specific issue number. This validates our entity-type + number approach.

**Schedule key refinement**: The Oracle review identified that `schedule-{hash}` needs more context to avoid collisions across workflows. A single repository may have multiple workflow files with different cron schedules. Recommended key: `schedule-{hash(workflowPath + cronExpression + promptInput)}` to ensure different scheduled tasks in different workflows get their own sessions.

**Dispatch key and reruns**: GitHub reruns maintain the same `runId` but increment `run_attempt`. Decision needed: should a rerun continue the same session or start fresh? Recommended: `dispatch-{runId}` (same session on rerun) since reruns typically mean "try again" not "do something different". Include `run_attempt` in logs but not in the key.

**Closed/reopened PRs**: A PR that's closed and reopened should keep the same session (the investigation is still relevant). This happens naturally since the PR number doesn't change.

**Transferred issues**: An issue transferred between repos should NOT share a session. The logical key is implicitly repo-scoped because sessions are project-scoped via workspace path. However, if the same repo is checked out at different paths across runs, workspace normalization (`normalizeWorkspacePath()` in `src/shared/paths.ts`) ensures consistency.

### Session Title Convention

The OpenCode SDK supports setting a title at session creation:

```typescript
// From anomalyco/opencode — packages/opencode/src/session/index.ts:218
export const create = fn(
  z.object({
    parentID: SessionID.zod.optional(),
    title: z.string().optional(),
    permission: Info.shape.permission,
    workspaceID: WorkspaceID.zod.optional(),
  }),
)
```

The SDK client call (as used by oMo — `code-yeongyu/oh-my-openagent`):

```typescript
await client.session.create({
  body: {title: `fro-bot: pr-347`},
})
```

**Title format**: `fro-bot: {logical-key}`

- Prefix `fro-bot: ` distinguishes our sessions from manually-created ones.
- The logical key portion (`pr-347`, `issue-12`, `schedule-a1b2c3`) is the stable lookup target.
- Example titles: `fro-bot: pr-347`, `fro-bot: issue-42`, `fro-bot: discussion-5`, `fro-bot: schedule-d4e5f6`

#### Research Insights: Session Title Robustness

**Title auto-update risk**: OpenCode auto-generates titles from the first message content (`packages/opencode/src/session/prompt.ts:1963-1968`). A title set at creation may be overwritten after the first prompt. Mitigations:

1. **Re-set title after prompt**: Call `client.session.update()` (PATCH endpoint at `routes/session.ts:265`) to restore the logical key title after each prompt. This is the safest approach.
2. **Use `search` parameter for lookup**: The experimental `listGlobal()` endpoint accepts `search` for case-insensitive title filtering. Even if the title is modified, a search for `fro-bot: pr-347` within the title text would still match if the original prefix is retained as a substring.
3. **Embed key in writeback summary**: The plan already includes the logical key in `writeSessionSummary()` output. This provides a content-based fallback independent of title state.

**Recommended approach**: Set title at creation AND re-set after first prompt. Use the `search` parameter for primary lookup, with writeback content search as fallback.

**Exact match requirement**: Use exact string equality for title matching, never prefix/substring. `fro-bot: pr-34` must NOT match `fro-bot: pr-347`. The `search` parameter does substring matching, so filter results to exact title equality client-side after server-side narrowing.

**Server-side title filtering**: The SDK supports `search` on session listing:

```typescript
// Server-side filtering — avoids N+1 message reads
const response = await client.session.list({
  query: {directory: workspacePath, search: "fro-bot: pr-347"},
})
// Then exact-match filter client-side
const match = response.data?.find(s => s.title === "fro-bot: pr-347")
```

### Session Continuity Flow

Modified execution flow in `session-prep.ts` and `execution.ts`:

```
1. buildLogicalKey(triggerContext) → key
2. buildSessionTitle(key) → "fro-bot: {key}"
3. listSessions() → find session with matching title
4. If matching session found:
   a. Verify session is usable (not archived, not too old)
   b. Use session.id as continuation target
5. If no title match:
   a. Fallback: searchSessions() with logical key as query
   b. If fallback match found → use that session
6. If nothing found → create new session with title set to "fro-bot: {key}"
7. Pass resolved session context to prompt builder
```

**SDK capabilities used**:

- `client.session.create({ body: { title } })` — Create with deterministic title
- `client.session.list({ query: { directory } })` — List sessions, filter by title client-side
- `client.session.prompt({ path: { id }, body: { parts } })` — Send prompt to existing session

When continuing an existing session:

- Skip `client.session.create()` entirely
- Use `sendPromptToSession(client, existingSessionId, prompt, ...)` directly

This requires modifying `executeOpenCode()` to accept an optional `continueSessionId` parameter.

**Why not an external session map file?** The session title IS the mapping. Using the SDK's `search` parameter for server-side title filtering avoids the N+1 overhead entirely. This avoids a separate state file that can corrupt, go stale, or get out of sync with actual sessions.

#### Research Insights: Session Lookup Performance and Safety

**N+1 message reads**: The current `listSessions()` in `src/services/session/search.ts:39-54` calls `getSessionMessages()` for every session to extract agent names. Do NOT use this function for title-based lookup. Instead use either:

1. `listSessionsForProject()` from `storage.ts` — returns `SessionInfo` metadata without reading messages
2. SDK `search` parameter — server-side title filtering, most efficient

**Session busy state**: Before continuing a session, verify it's idle. OpenCode internally calls `assertNotBusy(sessionID)` before accepting prompts (`packages/opencode/src/session/revert.ts:24`). Session states to check:

- `idle` — safe to continue
- `busy` — active operation in progress; create new session instead
- `compacting` — mid-compaction (`time.compacting` set); wait briefly or create new
- `archived` — soft-deleted (`time.archived` set); excluded from default listings

**Error handling tri-state**: The Oracle review identified that the storage layer collapses SDK errors into empty results (`[]` / `null`). The session resolver should distinguish three outcomes:

1. **Found** — session exists and is idle → continue it
2. **Not found** — no matching session → create new
3. **Lookup error** — SDK failure → log warning, create new session, do NOT assume "not found"

**Concurrency guard**: If two workflow runs for the same PR overlap (e.g., `synchronize` + `issue_comment` within seconds), both may attempt to continue the same session. The action cannot assume users configured workflow concurrency groups correctly. Mitigations:

- Check session busy state before prompting
- If busy, create a fresh session with the same logical key title (the stale one gets pruned normally)
- Log when a continuity reset occurs for debugging

### Prompt Restructuring

Current prompt section order (from `src/features/agent/prompt.ts:120-284`):

```
1. Agent Context (generic CI operating rules)
2. Custom Prompt (schedule/dispatch only)
3. Task Section (trigger directive)
4. Output Contract (PR only)
5. Environment (repo, branch, actor, run ID)
6. Issue/PR Context (number, title, type)
7. Trigger Comment (comment body)
8. Prior Session Context (recent sessions + search results)  <-- buried
9. PR Diff Summary
10. Hydrated Context (GraphQL)
11. Session Management Instructions
12. Response Protocol
13. GitHub CLI Reference
```

Proposed reordering:

```
1. Thread Identity (NEW — logical key, continuation status, thread history summary)
2. Task Section (trigger directive — what to do)
3. Trigger Comment (what the user said)
4. Current Thread Context (NEW — prior work from THIS logical thread only)
5. Output Contract (PR only)
6. Environment (repo, branch, actor, run ID)
7. Issue/PR Context (number, title, type)
8. PR Diff Summary
9. Hydrated Context (GraphQL)
10. Related Historical Context (RENAMED — other sessions, not current thread)
11. Agent Context (generic CI operating rules — demoted)
12. Session Management Instructions
13. Response Protocol
14. GitHub CLI Reference
```

Key changes:

- **Thread Identity** (new section): Appears first. Contains logical key, whether this is a continuation or fresh start, and a 2-3 sentence summary of what the thread has covered so far.
- **Current Thread Context** (new section): Replaces the generic "Prior Session Context" when a mapped session exists. Shows excerpts from the exact logical thread, not fuzzy search matches.
- **Related Historical Context** (renamed): The old "Prior Session Context" becomes secondary. Only shown when there's additional relevant work outside the current thread.
- **Agent Context** (demoted): Generic operating rules move below task-specific context. The agent needs to know WHAT to do before HOW to operate.
- **Non-Negotiable Rules** (new, position 1): Short block of hard constraints that must NOT be buried. Extracted from Agent Context to ensure primacy attention.

#### Research Insights: Prompt Ordering Best Practices

**U-shaped attention model**: LLMs (including Claude) exhibit a consistent U-shaped performance curve — information at the absolute beginning (primacy) and end (recency) of the prompt gets the most attention. Content between 20% and 80% of the context window is under-attended (MIT 2025 follow-up study). This means:

- Non-negotiable rules (single comment, Run Summary, non-interactive CI) MUST stay at position 1 AND be duplicated near the end
- Reference material (environment, CLI examples) can safely sit in the middle "valley"
- The task/trigger comment should be near the top for primacy

**Instruction Sandwich pattern**: Place core constraints at the top AND a summary of key rules at the bottom. This is the standard pattern for 2026 agents. Revised ordering:

```
1. Non-Negotiable Rules (NEW — extracted hard constraints, ~5 lines)
2. Thread Identity (logical key, continuation status, thread summary)
3. Task Section (trigger directive)
4. Trigger Comment (what the user said)
5. Current Thread Context (prior work from THIS thread)
6. Output Contract (PR only)
7. Environment (repo, branch, actor, run ID)
8. Issue/PR Context (number, title, type)
9. PR Diff Summary
10. Hydrated Context (GraphQL)
11. Related Historical Context (other sessions)
12. Agent Context (detailed CI operating rules — expanded guidance)
13. Session Management Instructions
14. Response Protocol (includes Run Summary template)
15. GitHub CLI Reference
16. Constraint Reminder (NEW — 3-line repeat of non-negotiables for recency)
```

**XML tags vs Markdown**: Anthropic's 2026 Context Engineering Guide reports XML tags (`<context>`, `<task>`) are 23% more effective than Markdown headers for Claude because they provide explicit structural cues for the attention mechanism. Consider migrating prompt sections from `## Heading` to `<section name="heading">` format in a future iteration. This is not blocking for the current plan but is a high-value future optimization.

**Rolling Summary pattern**: For prior-work injection, condense the continued session's history into a structured block rather than raw excerpts:

```
<prior_work>
  <summary>Reviewed PR #347: identified 3 issues in auth module, suggested test additions.</summary>
  <key_decisions>Chose JWT over session tokens for stateless auth. Approved migration path.</key_decisions>
  <outstanding_todos>- Fix failing test in UserService.test.ts</outstanding_todos>
</prior_work>
```

This reduces token cost by ~80% compared to injecting full message excerpts while preserving decision context.

### Observability Improvements

1. **Upload `opencode-logs` in `fro-bot.yaml`**: Add the same `actions/upload-artifact` step that `ci.yaml` uses at lines 211-215.

2. **Prompt artifact retention for all triggers**: Already implemented via `isOpenCodePromptArtifactEnabled()` in `execution.ts:62`. The gap is that `fro-bot.yaml` doesn't upload the resulting artifacts. Fix is in (1) above.

3. **Log noise triage**: Document expected vs unexpected log messages:
   - `Blocked 3 postinstalls` — Expected noise from Bun; suppress or annotate in setup phase
   - `tool.registry ... invalid` — Investigate whether this indicates a misconfigured tool registry path

#### Research Insights: Artifact Upload Best Practices

**upload-artifact v4+ recommendations** (2025-2026 best practices):

```yaml
- name: Upload OpenCode Logs
  if: always()
  uses: actions/upload-artifact@v4 # pin to exact SHA in practice
  with:
    name: opencode-logs-${{ github.run_id }}-${{ github.run_attempt }}
    path: ~/.local/share/opencode/log
    retention-days: 7 # 7 days standard for debug logs
    include-hidden-files: true # required if logs under hidden dirs
    compression-level: 9 # max compression for text-heavy logs
    if-no-files-found: warn # don't fail if agent didn't produce logs
```

**Key considerations**:

- **Unique names**: Include `run_id` and `run_attempt` to avoid "Artifact already exists" errors on reruns
- **`if: always()`**: Ensures logs are captured even when the agent step fails — critical for debugging LLM errors
- **`retention-days: 7`**: Industry standard for temporary debugging logs; reduces storage cost while providing enough review time
- **`compression-level: 9`**: Recommended for large text-based log files; saves storage at minimal CPU cost
- **Post-action timing**: `upload-artifact` only captures files that exist at the moment it runs. Position it as the last step to capture as much as possible. Post-action hooks (like `post.ts`) run after all steps, so their logs may not be captured unless written to a persistent directory during the main run

## System-Wide Impact

### Interaction Graph

- `buildLogicalKey()` is called in session-prep phase → used to build session title → `listSessions()` filters by title → determines whether `executeOpenCode()` creates or continues a session → affects prompt content (thread identity section) → affects session writeback (summary includes logical key) → title persists in session metadata for future lookups.
- No external state files introduced. Session titles are the single source of truth for logical key mapping, stored within OpenCode's own session storage.

### Error Propagation

- Title-based lookup returns no match → fallback to content-based search via `searchSessions()`. No hard dependency on title matching.
- Matched session no longer usable (archived, corrupted) → fall back to search, then create new session with the same title.
- SDK `session.list()` failure → treat as empty list, create new session. Worst case: a duplicate session exists with the same title (harmless — next run picks the most recently updated).
- SDK `session.create()` with title fails → fall back to create without title (current behavior), log warning.

### State Lifecycle Risks

- **Pruned sessions**: A session with a logical key title gets pruned by `pruneSessions()`. Next run finds no title match, falls back to search or creates fresh. No orphaned references since there's no external map.
- **Cache eviction**: GitHub Actions cache has 7-day inactivity expiry. If the cache is evicted, all sessions (and their titles) are lost. S3 backup (if enabled) preserves them. System rebuilds naturally on next run.
- **Branch isolation**: Sessions are already branch-scoped via cache keys (`opencode-storage-{repo}-{branch}-{os}`). A PR branch gets its own sessions. When the branch is deleted, the cache is eventually evicted.
- **Duplicate titles**: If two runs race and both create sessions with the same title, subsequent runs pick the most recently updated one. The stale duplicate gets pruned normally.

### API Surface Parity

- `listSessions()` in `src/services/session/search.ts` gains a new caller (title-based lookup) but its signature and behavior are unchanged.
- `searchSessions()` remains unchanged — used as fallback when title match fails and for "Related Historical Context".
- `writeSessionSummary()` in `src/services/session/writeback.ts` should include the logical key in the summary text so it's searchable by future fallback queries.

### Integration Test Scenarios

1. **Continuation success**: Two sequential runs for the same PR → second run finds session titled `fro-bot: pr-347` → continues that session, prompt shows thread identity.
2. **Stale session recovery**: Titled session was pruned → second run finds no title match → falls back to content search → creates new session with same title.
3. **Cross-event continuity**: `pull_request` opened → `issue_comment` on same PR → both produce logical key `pr-347` → second run finds session titled `fro-bot: pr-347` and continues it.
4. **Schedule thread stability**: Two cron-triggered runs with same expression → both produce same `schedule-{hash}` key → second run continues the first's session.
5. **Cache eviction recovery**: All sessions lost → title match fails, content search fails → creates fresh session with deterministic title → continuity resumes from next run.
6. **Title creation**: First run for a new issue → no matching title → creates session titled `fro-bot: issue-42` → subsequent runs find it by title.

## Acceptance Criteria

### Functional Requirements

- [ ] `buildLogicalKey()` produces deterministic keys for all 7 supported event types (`src/services/github/types.ts` EVENT_TYPES minus `unsupported`)
- [ ] Sessions are created with deterministic titles (`fro-bot: {logical-key}`) via `client.session.create({ body: { title } })`
- [ ] Repeated runs on the same PR consistently continue the same OpenCode session (matched by title)
- [ ] Repeated runs on the same issue consistently continue the same OpenCode session
- [ ] Discussion comment runs continue the same session for the same discussion number
- [ ] Schedule runs with the same cron expression continue the same session thread
- [ ] Workflow dispatch runs create new sessions (each dispatch is independent)
- [ ] When a titled session is missing/stale, the system falls back to content-based search
- [ ] When both title match and search fail, a new session is created with the logical key title
- [ ] `executeOpenCode()` can continue an existing session instead of always creating a new one

### Prompt Requirements

- [ ] Thread Identity section appears near the top of the prompt (before task section)
- [ ] Current thread context appears before related historical context
- [ ] Generic operating rules (Agent Context) appear after task-specific content
- [ ] Prompt distinguishes "current thread context" from "related historical context"
- [ ] Session writeback includes logical key for future searchability

### Observability Requirements

- [ ] `fro-bot.yaml` uploads `opencode-logs` artifact for all trigger types
- [ ] Prompt artifacts are preserved and uploadable for schedule, issue, discussion, and comment triggers
- [ ] Session resolution is logged (title match hit/miss, fallback to search, new session created)
- [ ] Logical key is included in execution phase logs

### Non-Functional Requirements

- [ ] Title-based session lookup adds negligible overhead (client-side filter on ≤50 sessions)
- [ ] Fallback to content-based search maintains current behavior — no regression if title match fails
- [ ] No external state files introduced — session titles are the single source of truth

### Quality Gates

- [ ] All new code has colocated `.test.ts` files following BDD comments (`// #given`, `// #when`, `// #then`)
- [ ] `buildLogicalKey()` has exhaustive tests for all event types including edge cases (missing fields, null values)
- [ ] Session resolution logic has tests for title match, fallback search, and new session creation
- [ ] Prompt restructuring has snapshot tests verifying section order
- [ ] `pnpm test && pnpm lint && pnpm check-types && pnpm build` pass with no regressions
- [ ] `dist/` stays in sync after build

## Implementation Phases

### Phase 1: Logical Keys and Session Resolution

**Goal**: Ship the logical key computation and title-based session resolution without changing prompt structure.

**Tasks**:

1. Create `src/services/session/logical-key.ts` (~80 LOC)
   - `buildLogicalKey(context: TriggerContext): LogicalSessionKey | null`
   - `buildSessionTitle(key: LogicalSessionKey): string` — returns `fro-bot: {key.key}`
   - `findSessionByTitle(sessions: readonly SessionInfo[], title: string): SessionInfo | null` — exact match, NOT prefix/substring; picks most recently updated if multiple matches
   - `resolveSessionForLogicalKey(client, workspacePath, key, logger): Promise<SessionResolution>` — the single entry point for session reuse decisions. Returns `{status: 'found', session} | {status: 'not-found'} | {status: 'error', error}`
   - Pure key/title functions have no side effects; resolver is the only function with SDK calls
   - Cover all 7 event types from `NormalizedEvent`

2. Create `src/services/session/logical-key.test.ts`
   - Exhaustive tests for all event types
   - Edge cases: missing target, null fields, `unsupported` event
   - Title generation and exact matching tests (including collision cases: `pr-34` must NOT match `pr-347`)
   - `findSessionByTitle` with multiple matches (picks most recently updated)
   - `resolveSessionForLogicalKey` with mock SDK: found/not-found/error tri-state
   - Schedule key uniqueness: different workflows with same cron get different keys

**Estimated effort**: Small. Pure data model, no integration points yet.

**Success criteria**: All tests pass, types compile, no runtime changes.

### Phase 2: Session Continuity in Execution

**Goal**: Modify execution to prefer continuing an existing session when a title-matched session exists.

**Tasks**:

1. Modify `src/harness/phases/session-prep.ts`
   - Import `buildLogicalKey`, `buildSessionTitle`, `resolveSessionForLogicalKey`
   - After listing recent sessions, call `resolveSessionForLogicalKey()` — this is the ONLY place session reuse decisions are made
   - If resolution is `found`, set `continueSessionId` for execution phase
   - If resolution is `not-found` or `error`, use logical key as deterministic search query (replaces `issueTitle ?? repo`)
   - Add `logicalKey`, `continueSessionId`, and `isContinuation` to `SessionPrepPhaseResult`
   - Use `listSessionsForProject()` (metadata-only, no message reads) instead of `listSessions()` for title lookup

2. Modify `src/features/agent/execution.ts`
   - Add optional `continueSessionId?: string` and `sessionTitle?: string` to function params (via `ExecutionConfig` or `PromptOptions`)
   - If `continueSessionId` is provided, skip `client.session.create()` and use that session ID directly
   - If creating a new session, pass title: `client.session.create({ body: { title: sessionTitle } })`
   - After successful prompt, **re-set title** via `session.update()` to guard against OpenCode's auto-title behavior
   - Note: oMo uses `{ body: { title }, query: { directory } } as Record<string, unknown>` pattern for the SDK call

3. Modify `src/harness/phases/execute.ts`
   - Pass `continueSessionId` and `sessionTitle` from session-prep result to `executeOpenCode()`

4. Update `src/services/session/writeback.ts`
   - Include logical key in `formatSummaryForSession()` output
   - Example: `Logical Thread: pr-347`
   - This makes the key searchable as a content-based fallback even if title is overwritten

**Estimated effort**: Medium. Touches 4 files, requires careful null handling for the continuation path.

**Success criteria**: Repeated runs on the same PR reuse the same session ID. Fallback to content search when title match fails. New sessions get deterministic titles.

### Phase 3: Prompt Restructuring

**Goal**: Reorder prompt sections so thread identity and current-thread context appear before generic rules.

**Tasks**:

1. Create `src/features/agent/prompt-thread.ts` (~100 LOC)
   - `buildNonNegotiableRulesSection(): string` — 5-line hard constraints block (non-interactive CI, gh-only output, exactly one comment/review, Run Summary required, bot marker required)
   - `buildThreadIdentitySection(logicalKey, isContinuation, threadSummary): string`
   - `buildCurrentThreadContextSection(currentThreadResults): string` — uses "Rolling Summary" pattern (summary + key decisions + outstanding todos) to reduce token cost
   - `buildConstraintReminderSection(): string` — 3-line repeat of non-negotiables for recency attention

2. Modify `src/features/agent/prompt.ts`
   - Add `logicalKey?: LogicalSessionKey` and `isContinuation?: boolean` to `PromptOptions`
   - Insert Non-Negotiable Rules section at position 1 (Instruction Sandwich top)
   - Insert Thread Identity section at position 2
   - Split session context into "Current Thread" and "Related Historical"
   - Keep detailed Agent Context at position 12 (expanded guidance, not just constraints)
   - Add Constraint Reminder at position 16 (Instruction Sandwich bottom)
   - Update `buildSessionContextSection()` to accept `currentThreadSessionId` and partition results

3. Update `src/features/agent/types.ts`
   - Add `logicalKey`, `isContinuation`, `currentThreadSessionId` to `PromptOptions`

4. Update prompt snapshot tests to verify new section order
   - Verify Non-Negotiable Rules appears at position 1
   - Verify Constraint Reminder appears at end
   - Verify Thread Identity appears before Task Section

**Estimated effort**: Medium. Mostly restructuring existing code, but prompt tests need careful updates.

**Success criteria**: Prompts show thread identity near top. Current thread context is separated from related history. Snapshot tests verify the new layout.

### Phase 4: Observability

**Goal**: Ensure all trigger types produce inspectable artifacts.

**Tasks**:

1. Modify `.github/workflows/fro-bot.yaml`
   - Add `actions/upload-artifact` step for `opencode-logs` from `~/.local/share/opencode/log`
   - Use `if: always()` so logs are captured even on failure
   - Set `retention-days: 7`, `compression-level: 9`, `include-hidden-files: true`
   - Include `${{ github.run_id }}-${{ github.run_attempt }}` in artifact name for uniqueness
   - Set `if-no-files-found: warn` (don't fail if agent didn't produce logs)
   - Position as the last step before post-action hooks

2. Add logical key to execution-phase log entries
   - Log `logicalKey` alongside `sessionId` in session-prep and execute phases

3. Document log noise decisions in code comments:
   - `Blocked N postinstalls` → expected Bun behavior, no action needed
   - `tool.registry ... invalid` → investigate root cause, file as separate issue if needed

**Estimated effort**: Small. Workflow file change + log field additions.

**Success criteria**: `Fro Bot` runs produce downloadable `opencode-logs` artifacts. Logical key appears in structured logs.

## Alternative Approaches Considered

### 1. Retrieval-First (Rejected)

Keep creating fresh sessions, just improve search keys. Rejected because it fragments work across many sessions — cohesion improves but true continuity does not. (see brainstorm: docs/brainstorms/2026-03-22-agent-cohesion-session-context-brainstorm.md)

### 2. Observability-First (Rejected)

Ship artifact retention first, defer continuity. Rejected because it risks becoming instrumentation without behavior change. The brainstorm resolved that artifact retention should ship alongside continuity work, not separately.

### 3. External Session Map File

Persist a `session-map.json` file in the OpenCode storage directory with `logicalKey → sessionId` entries. Provides O(1) lookup.

Rejected as primary mechanism because: it introduces a separate state file that can corrupt, go stale, or diverge from actual sessions. The title-based approach stores the mapping IN the sessions themselves — no external state to manage. If O(1) lookup ever matters (unlikely with ≤50 sessions), an in-memory cache per run is sufficient.

### 4. Embed Key in Session Content Only

Embed the logical key only in writeback summaries and search for it via `searchSessions()`. This works as a fallback (and we do include the key in writeback for exactly this reason), but full-text search is slower and less precise than title matching. Used as the secondary fallback when title match fails.

## Dependencies & Prerequisites

- **OpenCode SDK**: Uses existing `session.create()` with `{ body: { title } }`, `session.prompt()`, `session.list()`, `session.get()` endpoints. The `title` parameter on create is supported since at least `anomalyco/opencode` current dev branch (confirmed via source: `packages/opencode/src/session/index.ts:218` — `Session.create` schema includes `title: z.string().optional()`). The JS SDK client passes this as `{ body: { title } }` — same pattern used by oMo in `src/cli/run/session-resolver.ts` and `src/tools/delegate-task/sync-session-creator.ts`.
- **Dedup phase**: Already shipped (`src/harness/phases/dedup.ts`). The logical key design is complementary — dedup prevents redundant runs, logical keys ensure continuity across allowed runs.
- **Session storage simplification plan**: Non-blocking. That plan consolidates mapper files; this plan adds new files alongside them. They can be merged independently.
- **Cache infrastructure**: No new files to cache. Session titles are stored within OpenCode's existing session storage, which is already cached as part of the `~/.local/share/opencode/` tree.

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| OpenCode auto-overwrites session title after first prompt | **High** | **Medium** | Re-set title via `session.update()` after each prompt. Use SDK `search` parameter for lookup (substring match) then exact-match filter client-side. Embed key in writeback summary as content-based fallback. |
| SDK `session.create` doesn't accept `title` in deployed version | Low | Medium | Verify SDK version. Fall back to creating without title (current behavior) + log warning. Title can be set retroactively via `PATCH /session/{id}` with `{ title }` (confirmed in `routes/session.ts:265`). |
| Session is busy/compacting when continuation attempted | Medium | Medium | Check session state before prompting. If busy/compacting, create new session with same logical key title. Log continuity reset for debugging. |
| Title-matched session was pruned between runs | Medium | Low | Fall back to content search then create new. Natural self-healing. |
| Cache eviction loses all sessions | Medium | Medium | S3 backup (if enabled) preserves sessions and titles; system rebuilds naturally on next run |
| SDK `session.prompt()` fails on continued session | Low | Medium | Catch error, create new session with same title, log warning |
| Duplicate sessions with same title (race condition) | Low | Low | Exact-match lookup picks most recently updated. Stale duplicate pruned normally. |
| `listSessions()` N+1 message reads for title lookup | **High** | Medium | Do NOT use `listSessions()` for title lookup. Use `listSessionsForProject()` (metadata only) or SDK `search` parameter for server-side filtering. |
| Prefix collision (pr-34 matches pr-347) | Medium | Medium | Use exact string equality for title matching, never prefix/substring. Server-side `search` results must be exact-match filtered client-side. |
| Agent Context demotion causes constraint violations | Medium | Medium | Use "Instruction Sandwich" pattern: keep 5-line non-negotiable rules block at position 1 AND duplicate as constraint reminder at position 16 (end). |
| Prompt restructuring breaks existing tests | High | Low | Snapshot tests need updating; this is expected, not a bug |
| Logical key collision (unlikely) | Very Low | Low | Keys are scoped by entity type + number; collisions are impossible within a single repo |

## Future Considerations

- **Cross-branch continuity**: A PR branch and main might want to share session context for the same issue. Currently blocked by branch-scoped cache keys. Could be addressed by adding a secondary lookup in the default branch cache.
- **Session compaction**: Long-lived threads (schedule tasks) may accumulate large histories. OpenCode's session summarization (`POST /session/{id}/summarize`) could be used periodically. Aider's `ChatSummary` pattern triggers compaction when token count exceeds a threshold, converting oldest messages into a high-level summary — worth evaluating for schedule threads.
- **Multi-session threads**: Some complex issues may benefit from branched sessions (parent-child). The `parentID` field in `SessionInfo` already supports this.
- **Session rollover policy**: Very active PRs (100+ comments) may grow sessions beyond useful context limits. Consider a rollover threshold where a new session is created with a summary of the old one carried forward.
- **XML tag migration**: Anthropic's 2026 Context Engineering Guide reports XML tags are 23% more effective than Markdown headers for Claude. A future iteration could migrate prompt sections from `## Heading` to `<section name="heading">` format for improved structural parsing.
- **Repository-native shared memory**: Squad-style "decision log" pattern — append structured blocks to a versioned `decisions.md` file in the repo. If all agent memory is wiped, it reads `decisions.md` to re-synchronize. Could complement session continuity for critical architectural decisions.

## Documentation Plan

- Update `AGENTS.md` code map to include new files (`logical-key.ts`, `prompt-thread.ts`)
- Add session continuity to the "How It Works" section of `README.md`
- Document the logical key scheme in a brief section of `AGENTS.md` under PATTERNS

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-03-22-agent-cohesion-session-context-brainstorm.md](docs/brainstorms/2026-03-22-agent-cohesion-session-context-brainstorm.md) — Key decisions carried forward: (1) optimize for stable continuity over fuzzy retrieval, (2) deterministic logical keys as first-class concept, (3) observability ships alongside continuity

### Internal References

- Session creation: `src/features/agent/execution.ts:53`
- Session search query: `src/harness/phases/session-prep.ts:42`
- Prompt building: `src/features/agent/prompt.ts:120-284`
- Session context section: `src/features/agent/prompt.ts:335-379`
- NormalizedEvent types: `src/services/github/types.ts:33-146`
- Dedup entity extraction: `src/harness/phases/dedup.ts:20-38`
- Session writeback: `src/services/session/writeback.ts:52-77`
- Cache save: `src/services/cache/save.ts`
- State keys: `src/harness/config/state-keys.ts`
- CI artifact upload: `.github/workflows/ci.yaml:211-215`
- Fro Bot workflow: `.github/workflows/fro-bot.yaml` (missing artifact upload)

### Related Plans

- `docs/plans/2026-03-21-dedup-execution.md` — Execution deduplication (complementary)
- `docs/plans/2026-03-04-session-storage-simplification.md` — Storage layer consolidation (non-blocking)
- `docs/plans/2026-02-15-feat-opencode-sqlite-session-support-plan.md` — SQLite backend (non-blocking)

### External References

- OpenCode session create schema: `anomalyco/opencode` `packages/opencode/src/session/index.ts:218` — `{ parentID?, title?, permission?, workspaceID? }`
- OpenCode session update route: `anomalyco/opencode` `packages/opencode/src/server/routes/session.ts:265` — `PATCH` with `{ title?, time? }`
- oMo session creation with title: `code-yeongyu/oh-my-openagent` `src/cli/run/session-resolver.ts`, `src/tools/delegate-task/sync-session-creator.ts`
- OpenCode SDK JS API: `POST /session` (optional `{ title, parentID, permission }`), `POST /session/{id}/message`, `GET /session/{id}`
- OpenCode SDK docs: https://opencode.ai/docs/
