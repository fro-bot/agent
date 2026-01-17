# Product Requirements Document (PRD): Fro Bot Agent Harness

**Version:** 1.2
**Last Updated:** 2026-01-14

### Version History

| Version | Date | Changes |
| --- | --- | --- |
| 1.2 | 2026-01-14 | Additional GitHub triggers (`issues`, `pull_request`, `pull_request_review_comment`, `schedule`), trigger-specific prompt directives, post-action cache hook, prompt input required for scheduled/manual triggers |
| 1.1 | 2026-01-10 | SDK execution model (replaces CLI), GraphQL context hydration, file attachments, model/agent config, mock event support, enhanced prompt construction |
| 1.0 | 2026-01-02 | Initial PRD |

---

## Overview

Fro Bot Agent is a reusable **agent harness** that runs OpenCode with an Oh My OpenCode (oMo) Sisyphus agent workflow to act as an autonomous collaborator on:

- **GitHub**: Issues, Discussions, and Pull Requests (PRs) via GitHub Actions.
- **Discord**: A long-running bot (Kimaki-like UX) connected to OpenCode through a reverse proxy / daemon model.

The core differentiator is **durable memory across runs**: OpenCode session/application state is restored at the start of each run and saved at the end, so the agent can pick up work without repeating expensive investigation.

---

## Problem Statement

Most "agent in CI" implementations are effectively **stateless**:

- Each run starts from scratch.
- Prior investigations, decisions, and fixes are lost.
- The agent re-explores the codebase and re-discovers the same errors repeatedly.

This leads to:

- Higher compute/cost per incident.
- Slower iteration cycles for maintainers.
- Lower trust (agent behavior appears inconsistent).

Fro Bot addresses this by:

1. Persisting OpenCode's stateful storage directory between runs.
2. **Action-side utilities (RFC-004)**: The GitHub Action harness uses TypeScript utilities (`listSessions`, `searchSessions`, `pruneSessions`, `writeSessionSummary`) to manage sessions at the infrastructure level.
3. **Agent-side tools (oMo)**: The AI agent uses oMo session tools (`session_list`, `session_read`, `session_search`, `session_info`) during runtime to discover and reuse prior work.
4. Producing auditable "run summaries" in GitHub comments and action logs.

---

## Goals and Objectives

### Product goals (v1)

1. **GitHub-native agent**: Respond and act on Issues, Discussions, and PRs via GitHub Actions triggers.
2. **Discord-native agent**: Provide Kimaki-like UX (channel = repo/project, thread = session) via long-running daemon.
3. **Shared memory**: For a given project (GitHub repo), the GitHub and Discord entrypoints share the same durable OpenCode storage.
4. **Operationally safe persistence**: Persist only OpenCode storage (`$XDG_DATA_HOME/opencode/storage/`) and never persist `auth.json`.
5. **Close-the-loop behavior**: Each run leaves behind a durable, searchable record (session writeback + run summary).

### Measurable objectives

| Objective | Target | Measurement |
| --- | --- | --- |
| Memory reuse rate | ≥60% of runs reference prior sessions | Count runs with `session_search`/`session_read` calls |
| Repeat work reduction | ≥40% fewer redundant investigations | Compare exploration tool calls on recurring issues |
| Time to first actionable output | ≤90s median on cache-hit runs | Measure time from job start to first comment |
| Safety | 0 credential leakage incidents | Audit logs/comments/caches quarterly |

---

## Scope

### In scope for v1

#### GitHub agent

- Support **all interaction models currently supported by oMo Sisyphus** (reference workflow):
  - https://github.com/code-yeongyu/oh-my-opencode/blob/f61e1a5f2bf7971caa6b8658a7964d1dbd217407/.github/workflows/sisyphus-agent.yml
- Behaviors:
  - Comment on Issues and Discussions.
  - Comment on PR conversation **and** provide PR review comments (where appropriate).
  - Accept delegated work, including the ability to **push commits and open PRs** (subject to permissions and safety gates).

#### Discord agent

- Kimaki-like mapping:
  - **One channel per project** (project == GitHub repo).
  - **One thread per OpenCode session** (resume/fork supported as a concept).
- Reverse proxy / daemon model enabling persistent connectivity.

#### Shared memory

- Restore at run start; save at run end.
- Explicit session revive + search before re-investigating.

### Not in scope (v1 non-goals)

- Training a custom model.
- Guaranteeing perfect long-term memory without user curation (memory can drift; the system is expected to summarize and prune).
- Persisting secrets (explicitly out of scope).
- Multi-tenant Discord hosting across unrelated orgs without isolation controls.

---

## User Personas / Target Audience

1. **Repo Maintainer (Primary)**
   - Wants a reliable "extra engineer" for triage, fixes, and PR follow-ups.
   - Cares about safety, permissions, and not leaking secrets.

2. **Contributor (Secondary)**
   - Wants fast feedback on PRs/issues.
   - Values actionable suggestions and reproducible steps.

3. **Discord Community Moderator (Secondary)**
   - Wants an agent that can collaborate in Discord while being grounded in a specific repo/project.
   - Needs permission model and clear mapping between Discord contexts and repos.

4. **Platform / Security Owner (Stakeholder)**
   - Requires least-privilege permissions, audit trails, and clear secret-handling.

---

## Key User Stories

### GitHub

1. **Issue triage**
   - As a maintainer, when an issue is opened, Fro Bot can summarize, reproduce (if possible), search prior sessions, and propose next steps.

2. **PR review + fix delegation**
   - As a maintainer, I can ask Fro Bot to review a PR, suggest changes, and optionally push a fix branch and open a PR.

3. **Avoid repeated work**
   - As a maintainer, Fro Bot should recall prior investigations and not repeat the same exploration every run.

### Discord

4. **Live collaboration**
   - As a moderator, I can chat with Fro Bot in a project channel, and it uses (and enriches) the same memory as GitHub.

5. **Session continuity**
   - As a user, I can resume a prior session thread and Fro Bot continues with context.

---

## Functional Requirements

### P0 (must-have for v1)

#### A. GitHub agent interactions

1. **Triggers / entrypoints**
   - The product ships as a **TypeScript GitHub Action** (Node.js 24 runtime) with a single entrypoint (`uses: fro-bot/agent`), not as a reusable workflow. Setup functionality is integrated into the main action via auto-setup.
   - **Core triggers (v1):**

     | Event | Supported Actions | Prompt Requirement | Scope |
     | --- | --- | --- | --- |
     | `issue_comment` | `created` | Optional (uses comment body) | Issue/PR |
     | `discussion_comment` | `created` | Optional (uses comment body) | Discussion |
     | `workflow_dispatch` | - | **Required** | Repo |
     | `schedule` | - | **Required** | Repo |
     | `issues` | `opened`, `edited` (with @mention) | Optional (defaults to triage) | Issue |
     | `pull_request` | `opened`, `synchronize`, `reopened` | Optional (defaults to review) | PR |
     | `pull_request_review_comment` | `created` | Optional (uses comment body) | PR Review |

   - **Skip conditions:**
     - `issues.edited`: Skip unless comment body contains `@fro-bot` mention.
     - `pull_request`: Skip draft PRs by default (configurable).
     - `schedule`/`workflow_dispatch`: Hard fail if `inputs.prompt` is empty.
   - **Trigger-specific prompt directives:**
     - Each trigger type injects a default task directive (e.g., "review this PR", "triage this issue").
     - Custom `prompt` input overrides the default directive.
   - v1 should also support Discussions where feasible (e.g., `discussion` with `types: [created]` on comments), but any gap must be documented as a known limitation until implemented.

2. **Supported surfaces**
   - Issues: in-thread comments.
   - Discussions: in-thread comments.
   - PRs: PR conversation comments **and** review comments.

3. **Idempotency**
   - For each run, the agent should be able to:
     - Create a new comment, or
     - Update an existing "agent comment" (for idempotent reruns).
   - The system should support a mode where "agent summary" is posted as a **separate comment** in some situations (e.g., end-of-run summary, large diffs, or when updating would lose history).

4. **Safe handling of forks / untrusted code**
   - Use `issue_comment` trigger (not `pull_request_review_comment`) to maintain secret access for fork PRs.
   - Permission gating: only respond to comments from users with `OWNER`, `MEMBER`, or `COLLABORATOR` association.
   - Anti-loop protection: ignore comments from the bot's own account.
   - Note: This matches the oMo Sisyphus approach for secure fork PR handling.

5. **Delegated work**
   - When requested, the agent may:
     - Push commits to branches.
     - Open PRs.
   - **Credential strategy (v1 decision):**
     - Recommended default: **GitHub App token** for elevated operations (branch creation, push commits, open PRs) with least-privilege scopes.
     - Supported fallback: **PAT** (e.g., `${{ secrets.GH_PAT }}`) for repos that do not want to provision/configure a GitHub App.
     - The default `GITHUB_TOKEN` permissions should remain minimal; elevated credentials are used only when delegated work is requested.
   - Must enforce permissions boundaries and avoid secret exposure.

6. **Run summary in GitHub output**
   - Every comment created/updated by the agent must include a **collapsed details block** containing:
     - Run metadata (event type, repo, ref/branch, run id).
     - Whether cache was restored (hit/miss/corrupted).
     - Session IDs used/created.
     - Links to any PRs/commits the agent created.
     - Duration and token usage (if available).

7. **Reactions and labels (acknowledgment UX)**
   - On comment trigger, immediately add 👀 reaction to acknowledge receipt.
   - Add `agent: working` label to the issue/PR.
   - On completion, remove 👀 reaction and add ✌🏽 (random skin tone) or ☮️ reaction.
   - Remove `agent: working` label.
   - All reaction/label operations use `|| true` for graceful failure.

8. **Context collection**
   - Determine if the trigger is an Issue or PR (check for `.pull_request` field via API).
   - Extract: type, number, title, comment body, comment author, comment ID.
   - Pass all context to the agent prompt.

9. **Error message format**
   - When the agent encounters an error, the comment must include:
     - A human-readable summary of what failed.
     - The error type (e.g., rate limit, LLM timeout, cache corruption).
     - Suggested next steps or retry guidance.

#### B. Discord agent interactions

1. **Mapping model**
   - Channel = GitHub repo/project.
   - Thread = OpenCode session.

2. **Architecture**
   - Discord bot runs as a long-lived process (daemon).
   - **Reverse proxy boundary**: The Discord-facing component handles message routing and authentication; OpenCode execution happens in an isolated process/container.
   - Recommended deployment: container (Docker) or systemd service on a VM.

3. **Shared memory with GitHub**
   - For the same project, Discord and GitHub share OpenCode storage (see Data/Storage Requirements).
   - Sync mechanism: S3 write-through (required for Discord, since it runs outside GitHub Actions cache).

4. **Permission model**
   - **Discord ↔ GitHub project mapping (v1 decision):**
     - Only users with a configured Discord role (e.g., **Maintainer**) may link a Discord channel to a GitHub repo.
     - The mapping is stored by the Discord daemon (config/database) and treated as an audited administrative action.
   - Bot respects GitHub permissions when performing delegated work.

#### C. Shared memory & session tool usage

**Important: Two layers of session management exist:**

| Layer | Tools/Functions | Used By | When |
| --- | --- | --- | --- |
| **Action-side (RFC-004)** | `listSessions()`, `searchSessions()`, `pruneSessions()`, `writeSessionSummary()` | GitHub Action harness | Before/after agent execution |
| **Agent-side (oMo)** | `session_list`, `session_read`, `session_search`, `session_info` | AI agent via LLM tool calls | During agent execution |

Both layers operate on the same OpenCode storage directory (`~/.local/share/opencode/storage/`).

1. **What to persist**
   - Persist the entire OpenCode storage subtree:
     - `$XDG_DATA_HOME/opencode/storage/`

2. **Startup behavior: revive + search**
   - **Action harness**: Calls RFC-004 `listSessions()` and optionally `searchSessions()` to gather context for the agent prompt.
   - **Agent**: Must use oMo `session_search` before re-investigating likely repeats.

3. **Close-the-loop writeback**
   - **Action harness**: Calls RFC-004 `writeSessionSummary()` to append run metadata.
   - **Agent**: Must produce a durable summary message (final message in session, GitHub comment).

4. **Session pruning (required for MVP)**
   - **Action harness only**: Calls RFC-004 `pruneSessions()` at end of each run.
   - Default: keep last 50 sessions per repo, or sessions from last 30 days (whichever is larger).
   - Configurable via action input.

### P0-B: Auto-Setup & Environment Bootstrap

The agent automatically handles environment setup as part of the main action execution.

#### D. Auto-setup (integrated into `fro-bot/agent@v0`)

1. **OpenCode CLI installation**
   - Install OpenCode binary via `@actions/tool-cache` for cross-run caching.
   - Support version pinning (`opencode-version` input) with `latest` as default.
   - Add OpenCode to PATH for subsequent steps.

2. **Oh My OpenCode (oMo) plugin installation**
   - Automatically installs Bun runtime (required dependency) via `@actions/tool-cache`.
   - Runs `bunx oh-my-opencode install` to add Sisyphus agent capabilities.
   - Graceful degradation: warn on failure, do not fail the run.
   - Users do NOT need to manually install Bun or use `oven-sh/setup-bun`.

3. **GitHub CLI (`gh`) authentication**
   - Configure `gh` with `GH_TOKEN` environment variable.
   - **Credential priority:**
     1. GitHub App installation token (generated from `app-id` + `private-key` inputs)
     2. Fallback: `GITHUB_TOKEN` (default, limited permissions)
   - `GH_TOKEN` takes priority over `GITHUB_TOKEN` for `gh` CLI operations.

4. **Git identity configuration**
   - Set `user.name` and `user.email` for commits.
   - Use GitHub App bot identity format: `<app-slug>[bot]` and `<user-id>+<app-slug>[bot]@users.noreply.github.com`.

5. **auth.json population**
   - Write LLM provider credentials from `auth-json` secret input.
   - File written with mode `0600` (owner read/write only).
   - **NEVER cached** - populated fresh each run.

6. **Cache restoration**
   - Restore OpenCode storage from GitHub Actions cache.
   - Run early in setup phase for session continuity.

#### E. Agent prompt requirements

The agent prompt must include sufficient context and instructions for GitHub operations:

1. **GitHub context injection**
   - Repository, branch/ref, event type, actor.
   - Issue/PR number and title (if applicable).
   - Triggering comment body (if applicable).

2. **Session tool instructions (REQUIRED)**
   - Instruct agent to use `session_search` before re-investigating.
   - Instruct agent to use `session_read` when prior work is found.
   - Instruct agent to leave a searchable summary before completing.

3. **GitHub CLI (`gh`) instructions**
   - All GitHub operations MUST use pre-authenticated `gh` CLI.
   - Provide examples for common operations:
     - `gh issue comment <number> --body "message"`
     - `gh pr comment <number> --body "message"`
     - `gh pr create --title "..." --body "..." --base main --head branch`
     - `gh api repos/{owner}/{repo}/...`
   - For commits: use `git add`, `git commit`, `git push origin HEAD`.

4. **Run summary requirement**
   - Every comment MUST include collapsed `<details>` block with run metadata.

#### F. OpenCode SDK Execution (P0 - PRIMARY)

> **Note:** This replaces the previous CLI execution model (`opencode run "$PROMPT"`). RFC-012 is superseded by this specification. A new RFC-013 will detail the SDK implementation.

1. **SDK-based execution** (replaces CLI as default)
   - Use `@opencode-ai/sdk` with `createOpencode()` for automatic server lifecycle.
   - Server started automatically, managed via AbortController.
   - No manual port management required.

2. **Session lifecycle**
   - Create session: `client.session.create({ body: { title } })`
   - Send prompt: `client.session.promptAsync()` (non-blocking)
   - Track session ID throughout execution.

3. **Event subscription and processing**
   - Subscribe: `client.event.subscribe()` returns async stream.
   - Track state: `mainSessionIdle`, `mainSessionError`, `lastError`.
   - Process tool calls, text updates, session events.

4. **Completion detection**
   - Poll every 500ms for idle state.
   - Check completion conditions (todos complete, no pending work).
   - Handle session errors with proper exit codes.

5. **Timeout and cancellation**
   - Configurable timeout via `timeout` input (0 = no timeout, default: 30 minutes).
   - AbortController for clean cancellation.
   - SIGINT handling for graceful shutdown.

6. **Cleanup**
   - `server.close()` on completion, error, or signal.
   - Restore any modified git config.
   - Proper exit codes (0=success, 1=error, 130=interrupted).

#### G. Local Development & Testing (P0)

1. **Mock event support**
   - `MOCK_EVENT` environment variable accepts JSON payload matching GitHub webhook schema.
   - `MOCK_TOKEN` provides authentication token for local testing.
   - Only enabled when `CI` env var is not `true` OR `allow-mock-event: true` input is set.

2. **Mock payload schema**
   - Must include: `eventName`, `payload`, `repo`, `actor`.
   - Validated on parse; clear error messages for malformed input.

3. **Share URL behavior**
   - Mock mode uses `https://dev.opencode.ai` for share links.
   - Production uses `https://opencode.ai`.

4. **Security guard**
   - Mock mode MUST be explicitly disabled in production workflows.
   - Log warning when mock mode is active.

#### H. File Attachment Processing (P0)

1. **Attachment detection**
   - Parse comment body for GitHub user-attachment URLs:
     - Markdown images: `![alt](https://github.com/user-attachments/assets/...)`
     - HTML images: `<img ... src="https://github.com/user-attachments/assets/..." />`
     - File links: `[filename](https://github.com/user-attachments/files/...)`
   - Regex pattern: `/!?\[.*?\]\((https:\/\/github\.com\/user-attachments\/[^)]+)\)/gi`

2. **Download and processing**
   - Authenticate with GitHub token for private repo attachments.
   - Download to temp storage.
   - Determine MIME type from response headers.

3. **Prompt injection** (SDK mode)
   - Replace original markdown with `@filename` reference.
   - Pass as `type: "file"` parts with base64 content.

4. **Limits and policy**
   - Max 5 attachments per comment.
   - Max 5MB per attachment, 15MB total.
   - Allowed types: `image/*`, `text/*`, `application/json`, `application/pdf`.

5. **Security**
   - Validate URLs are from `github.com/user-attachments/` only.
   - Attachments NOT persisted to cache.
   - Log attachment metadata (filename, size, type) but not content.

#### I. Model and Agent Configuration (P0)

1. **Action inputs**

   ```yaml
   agent:
     description: "Agent to use (default: Sisyphus). Must be primary agent, not subagent."
     required: false
     default: "Sisyphus"
   model:
     description: "Model override (format: provider/model). If not set, uses agent's configured model."
     required: false
   ```

2. **Agent configuration**
   - Default agent: `"Sisyphus"` (oMo's default agent).
   - Agent validated against `client.agent.list()`.
   - Non-primary agents (subagents) fall back to Sisyphus with warning.
   - Missing agents fall back to Sisyphus with warning.

3. **Model parsing and validation** (when provided)
   - Format: `{providerID}/{modelID}` (e.g., `anthropic/claude-sonnet-4-20250514`).
   - Both segments must be non-empty.
   - Error if format invalid.

4. **Execution**
   - Pass to `client.session.chat()` or `client.session.promptAsync()`:
     ```typescript
     // Agent is always provided (defaults to "Sisyphus")
     // Model override is optional
     {
       agent: agentName,
       ...(model != null && {
         providerID: model.providerID,
         modelID: model.modelID,
       }),
       parts: [...]
     }
     ```

5. **Auditability**
   - Include agent (and model if overridden) in run summary footer.
   - Log agent/model selection at start of execution.

#### J. Enhanced GitHub Context Hydration (P0)

1. **Issue context** (via GraphQL)
   - Title, body, author, state, created date.
   - Last 50 comments with author, timestamp, body.
   - Labels and assignees.

2. **Pull request context** (via GraphQL)
   - Base data: title, body, author, state, baseRefName, headRefName, headRefOid.
   - Stats: additions, deletions, commits.totalCount.
   - Repository info: baseRepository.nameWithOwner, headRepository.nameWithOwner.
   - Commits: last 100 with oid, message, author.
   - Files: last 100 with path, additions, deletions, changeType.
   - Comments: last 100 with full metadata.
   - Reviews: last 100 with state, body, and inline comments (path, line).

3. **Context budgeting**
   - Max 50 comments per thread.
   - Max 100 changed files.
   - Truncate bodies > 10KB with note.
   - Total context budget: ~100KB before prompt injection.

4. **Fork PR detection**
   - Compare `headRepository.nameWithOwner` vs `baseRepository.nameWithOwner`.
   - Different handling for local vs fork PRs (branch checkout strategy).

5. **Fallback behavior**
   - If GraphQL fails, fall back to REST API with reduced context.
   - Log warning when context is degraded.

#### K. Agent Prompt Construction (P0)

1. **Prompt structure**

   ```
   [mode-instructions]     # analyze-mode, ultrawork-mode (from config)

   [identity]              # Bot username, mentioned by whom, in which repo

   [context]               # Type, number, title, repo, default branch

   [user-request]          # The triggering comment body

   [mandatory-reading]     # Instructions to read full conversation first

   [issue/pr-data]         # GraphQL-hydrated context (from J above)

   [action-instructions]   # Create todos, investigate, report results
   ```

2. **Mandatory context reading instructions**
   - For issues: `gh issue view NUMBER --comments`
   - For PRs: THREE commands required:
     - `gh pr view NUMBER --comments`
     - `gh api repos/OWNER/REPO/pulls/NUMBER/comments`
     - `gh api repos/OWNER/REPO/pulls/NUMBER/reviews`
   - Extract: original description, previous attempts, decisions, feedback, linked references.

3. **GitHub comment formatting guidance**
   - ALWAYS use heredoc syntax for comments with backticks:
     ```bash
     gh issue comment NUMBER --body "$(cat <<'EOF'
     Content with `code` preserved
     EOF
     )"
     ```
   - Code blocks MUST have exactly 3 backticks + language identifier.
   - Every opening triple-backtick must have a closing triple-backtick on its own line.

4. **Session tool instructions** (preserved from current PRD)
   - Use `session_search` before re-investigating.
   - Use `session_read` when prior work found.
   - Leave searchable summary before completing.

#### L. Trigger-Specific Prompt Directives (P0)

Each trigger type injects a default task directive into the agent prompt. The `getTriggerDirective()` function returns trigger-appropriate instructions that can be overridden by custom `prompt` input.

1. **Directive by trigger type**

   | Trigger | Default Directive | Notes |
   | --- | --- | --- |
   | `issue_comment` | "Respond to the comment above" | Uses comment body as instruction |
   | `discussion_comment` | "Respond to the discussion comment above" | Similar to issue_comment |
   | `pull_request_review_comment` | "Respond to the review comment with file and code context" | Includes file path, line number, diff hunk |
   | `issues` (opened) | "Triage this issue: summarize, reproduce if possible, propose next steps" | Automated triage behavior |
   | `issues` (edited with @mention) | "Respond to the mention in this issue" | Only when @fro-bot mentioned |
   | `pull_request` (opened/synchronize) | "Review this pull request for code quality, potential bugs, and improvements" | Default review behavior |
   | `schedule` | (uses `prompt` input directly) | No default - prompt required |
   | `workflow_dispatch` | (uses `prompt` input directly) | No default - prompt required |

2. **Context injection per trigger**
   - `pull_request_review_comment`: Inject `<review_comment_context>` block with:
     - File path (`path`)
     - Line number (`line`, `original_line`)
     - Diff hunk (`diff_hunk`)
     - Commit ID (`commit_id`)
   - `pull_request`: Inject commit summary, changed files list, existing review comments.
   - `issues`: Inject full issue body and recent comments.

3. **Prompt override behavior**
   - Custom `prompt` input **appends** to trigger directive for comment-based triggers.
   - Custom `prompt` input **replaces** directive for `schedule`/`workflow_dispatch`.

4. **Implementation**
   - Add `getTriggerDirective(triggerContext, inputs)` function in `src/lib/agent/prompt.ts`.
   - Thin layer - returns 5-20 lines of task text, not a separate prompt builder.

#### M. Post-Action Cache Hook (P0)

Reliable cache saving via GitHub Actions `post:` field, independent of main action lifecycle.

1. **Rationale**
   - Current `finally` block cleanup can miss on hard kills (timeout, cancellation, SIGKILL).
   - GitHub Actions `post:` runs in a separate process, providing durability.

2. **Implementation**
   - Add `src/post.ts` entry point.
   - Update `action.yaml` with `runs.post: dist/post.js`.
   - Post-hook responsibilities:
     - Save cache (idempotent, best-effort).
     - Session pruning (optional, non-fatal).
   - **MUST NOT** fail the job if cache save fails.

3. **Build impact**
   - Update `tsdown.config.ts` to bundle `post.ts` as third entry point.
   - Produces `dist/main.js`, `dist/setup.js`, `dist/post.js`.

### P1 (should-have)

1. **Setup action refinements**
   - Custom `opencode.json` configuration injection.
   - App token generation within the action (vs external action).

2. **"Corruption detected" handling**
   - Detect obvious corruption in restored storage (e.g., missing required directories, unreadable DB files).
   - If corruption detected: warn in logs + run summary; proceed with clean state.

3. **Concurrency handling**
   - If two runs hit the same cache key simultaneously:
     - Use **last-write-wins** semantics.
     - Emit a warning in the run summary if a race is detected (best-effort).

4. **Storage versioning**
   - Include a version marker in the storage directory.
   - On version mismatch: warn and proceed with clean state (do not fail).

5. **Session sharing** (SDK mode)
   - Optional `share` input: `true`, `false`, or unset (auto).
   - Auto behavior: share for public repos, don't share for private.
   - Call `client.session.share({ path: session })` to create public link.
   - Include share link in comment footer with optional social card image.
   - Output `share-url` from action.

6. **Automatic branch management**
   - **Issue workflow**: Create new branch → make changes → push → create PR.
   - **Local PR workflow**: Checkout existing branch → make changes → push.
   - **Fork PR workflow**: Add fork remote → checkout → push to fork.
   - Branch naming: `opencode/{issue|pr}{number}-{timestamp}`.
   - Commit format with co-author attribution.
   - Dirty check: `git status --porcelain` before attempting push.

7. **Event streaming and progress logging**
   - Subscribe to SSE events from OpenCode server.
   - Log tool calls with color-coded output (todo: yellow, bash: red, edit: green, etc.).
   - Log text completions when finished.
   - Track session state updates in real-time.

8. **Setup action consolidation** (deferred from v1.2)
   - Consolidate setup functionality into main action for simplified UX.
   - Requires separate RFC with migration plan.
   - Keep setup action for backwards compatibility.

### P2 (nice-to-have)

1. **Cross-runner portability**
   - Optional write-through S3 backup/restore.

2. **Org-level memory partitioning**
   - Support additional scoping (repo-only vs org-wide) as configurable.

---

## Non-Functional Requirements

### Security & privacy

- **Never persist `auth.json`**; it must be populated each run from GitHub Actions secrets (placeholders only in docs/examples).
- Avoid printing credentials or including them in comments.
- Cache threat model considerations:
  - Caches can be accessible depending on repo settings and scoping.
  - Prefer branch-scoped caches to reduce poisoning risk.
- For PRs from forks: use `issue_comment` trigger with permission gating (OWNER/MEMBER/COLLABORATOR only).

### Reliability

- Cache missing must not fail the run.
- Cache corruption should not fail the run; it should be detected and warned.
- Agent should degrade gracefully when external systems are unavailable:
  - **GitHub API rate limit**: Exponential backoff (max 3 retries, 30s/60s/120s), then post partial results.
  - **LLM API timeout/error**: Retry once after 10s, then post error comment.
  - **Discord API issues**: Log and continue; do not crash daemon.

### Performance

- Restore cache early in job.
- Minimize repeated exploration using session search.
- Target: cache restore < 30s for typical storage sizes (< 500MB).

### Observability / auditability

- Provide:
  - GitHub comment summary (with collapsed details block).
  - GitHub Actions job summary + logs.
- Include session IDs and run IDs for traceability.
- Emit structured logs (JSON) for machine parsing.

### Cost controls

- Avoid unnecessary repeated LLM/tool calls by:
  - session revive + search.
  - posting stable summaries.
- Emit token usage in run summary (when available from LLM provider).

---

## Data / Storage Requirements

### Persisted data (required)

- Persist exactly:
  - `$XDG_DATA_HOME/opencode/storage/` (typically `~/.local/share/opencode/storage/`)

### Sensitive / excluded data

- Do not persist:
  - `$XDG_DATA_HOME/opencode/auth.json`
- `auth.json` is rehydrated each run from GitHub Actions secrets.

### GitHub Actions cache mechanics

- Restore persisted storage at start of run.
- Save updated storage at end of run.

### Cache key strategy (v1 default)

- Default: **branch-scoped** with agent identity and repo.
- Key pattern:
  ```
  opencode-storage-${agent_identity}-${repo}-${ref_name}-${runner_os}
  ```
- Restore-keys (fallback):
  ```
  opencode-storage-${agent_identity}-${repo}-${ref_name}-
  opencode-storage-${agent_identity}-${repo}-
  ```
- `agent_identity`: `github` or `discord` (prevents cross-contamination).

### Retention / eviction

- Treat cache eviction as expected; S3 write-through exists to reduce loss.
- GitHub Actions cache: 7-day eviction for unused keys (GitHub default).

### Optional: S3 write-through backup (MVP)

- MVP includes S3 sync as an option.
- Scope: **per agent identity + repo**.
- Uses GitHub secrets/vars placeholders only, e.g. `${{ secrets.AWS_ACCESS_KEY_ID }}`.
- **Required for Discord** (since Discord runs outside GitHub Actions).

---

## Deployment / Operations

### GitHub

- Runs as GitHub Action(s) written in TypeScript, targeting **Node.js 24** runtime.
- Required permissions (principle of least privilege; exact list depends on enabled features):
  - `contents: read` (for analysis).
  - `issues: write`, `pull-requests: write` (for comments/reviews).
  - `contents: write` (when delegated work enabled).

### Discord

- Long-running daemon/bot.
- Recommended deployment: Docker container or systemd service.
- Requires a mapping from Discord channel → GitHub repo (stored in bot’s config/database).
- Reverse proxy boundary between Discord and OpenCode execution.

### Required secrets/vars (examples only)

- GitHub:
  - `${{ secrets.GITHUB_TOKEN }}` (default) and additional tokens if needed for elevated operations.
  - `${{ secrets.OPENCODE_AUTH_JSON }}` or equivalent (input).
- Optional S3 backup:
  - `${{ secrets.AWS_ACCESS_KEY_ID }}`
  - `${{ secrets.AWS_SECRET_ACCESS_KEY }}`
  - `${{ vars.S3_BUCKET }}`
  - `${{ vars.AWS_REGION }}`

### Failure modes & expected behavior

| Failure                          | Behavior                                          |
| -------------------------------- | ------------------------------------------------- |
| Cache miss                       | Proceed normally, seed cache at end               |
| Cache corruption detected        | Proceed with clean state, post warning in summary |
| Fork PR                          | Run via `issue_comment` with permission gating    |
| LLM rate limit                   | Retry with backoff (3x), then post partial/error  |
| GitHub API rate limit            | Retry with backoff, then post partial/error       |
| Concurrent runs (same cache key) | Last-write-wins; emit warning                     |

### Rollback plan

- If a release breaks storage compatibility:
  1. Revert to previous action version.
  2. Clear cache keys matching the broken version.
  3. Document in release notes.

---

## User Journeys

### Journey 1: Issue triage with memory

1. User opens issue.
2. Job restores OpenCode storage cache.
3. Agent runs: `session_search` for similar issues; reads prior session if relevant.
4. Agent posts an issue comment with:
   - proposed diagnosis/next steps
   - collapsed run summary with session IDs and cache status.
5. Job saves updated storage.

### Journey 2: PR review + delegated fix

1. Maintainer requests Fro Bot review and fix.
2. Agent restores storage, searches prior context.
3. Agent reviews diff and posts:
   - review comments
   - conversation summary comment
4. If requested, agent pushes commits and opens a PR.
5. Agent posts final summary with links + collapsed details.
6. Storage saved.

### Journey 3: Discord collaboration, same project memory

1. User chats in a repo channel.
2. Bot opens/resumes a session thread.
3. Session uses the same persisted storage as GitHub runs (via S3 sync).
4. User resumes later; agent continues with context.

### Journey 4: Cache miss / first run

1. Issue opened on a repo with no prior agent runs.
2. Cache restore returns miss (no error).
3. Agent proceeds with fresh session.
4. Agent posts comment with run summary noting "cache: miss (first run)".
5. Storage saved for future runs.

---

## Success Metrics

| Metric                          | Target                        | How to Measure                                    |
| ------------------------------- | ----------------------------- | ------------------------------------------------- |
| Memory reuse rate               | ≥60%                          | % runs with `session_search`/`session_read` calls |
| Repeat work reduction           | ≥40%                          | Compare exploration calls on recurring issues     |
| Time to first actionable output | ≤90s (cache hit)              | Job start → first comment timestamp               |
| User satisfaction               | Positive qualitative feedback | Maintainer surveys/interviews                     |
| Safety                          | 0 incidents                   | Quarterly audit of logs/comments/caches           |

---

## Acceptance Criteria (MVP)

The MVP is considered complete when:

**Additional Triggers (L)**

- [ ] `issues` event supported with `opened` action (triage behavior).
- [ ] `issues.edited` triggers only when `@fro-bot` mentioned in body.
- [ ] `pull_request` event supported with `opened`, `synchronize`, `reopened` actions.
- [ ] `pull_request` skips draft PRs by default.
- [ ] `pull_request_review_comment` event supported with `created` action.
- [ ] `schedule` event supported with required `prompt` input (hard fail if empty).
- [ ] `workflow_dispatch` hard fails if `prompt` input is empty.
- [ ] Each trigger type injects appropriate default directive via `getTriggerDirective()`.
- [ ] Custom `prompt` input appends to (comment-based) or replaces (scheduled/manual) directive.

**Post-Action Cache Hook (M)**

- [ ] `src/post.ts` entry point exists and bundles to `dist/post.js`.
- [ ] `action.yaml` includes `runs.post: dist/post.js`.
- [ ] Post-hook saves cache idempotently (best-effort, never fails job).
- [ ] Post-hook runs even on main action failure/timeout.

**SDK Execution (F)**

- [ ] Agent execution uses `@opencode-ai/sdk` with `createOpencode()` for server lifecycle.
- [ ] Session created via `client.session.create()` and prompt sent via `client.session.promptAsync()`.
- [ ] Event subscription via `client.event.subscribe()` for progress tracking.
- [ ] Completion detection via polling for idle state.
- [ ] Timeout configurable via `timeout` input (default: 30 minutes).
- [ ] Clean shutdown on completion, error, or signal (SIGINT).

**Mock Event Support (G)**

- [ ] `MOCK_EVENT` and `MOCK_TOKEN` env vars enable local testing.
- [ ] Mock mode disabled in production unless `allow-mock-event: true`.

**File Attachments (H)**

- [ ] GitHub user-attachment URLs parsed from comment body.
- [ ] Attachments downloaded and passed as `type: "file"` parts to SDK.
- [ ] Limits enforced: 5 files max, 5MB each, 15MB total.

**Model/Agent Config (I)**

- [ ] `agent` input optional, defaults to `"Sisyphus"`.
- [ ] `model` input optional; if not provided, uses agent's configured model.
- [ ] Model format validated as `provider/model` when provided.
- [ ] Agent validated against available agents.
- [ ] Agent/model included in run summary.

**GraphQL Context (J)**

- [ ] Full issue context fetched via GraphQL (title, body, comments, labels).
- [ ] Full PR context fetched via GraphQL (commits, files, reviews, inline comments).
- [ ] Context budgeting enforced (50 comments, 100 files, 10KB body truncation).
- [ ] Fallback to REST API on GraphQL failure.

**Prompt Construction (K)**

- [ ] Multi-section prompt structure with mode instructions, identity, context, user request.
- [ ] Mandatory reading instructions for issues and PRs.
- [ ] Heredoc guidance for GitHub comment formatting.
- [ ] Session tool instructions included.

**Core Functionality (existing)**

- [ ] GitHub Action runs on issue/PR/discussion events per oMo Sisyphus parity.
- [ ] Setup action installs OpenCode via `@actions/tool-cache` caching pattern.
- [ ] Setup action installs oMo plugins via `bunx oh-my-opencode install`.
- [ ] Setup action configures `gh` CLI with GitHub App token or GITHUB_TOKEN.
- [ ] Agent adds 👀 reaction to triggering comment and "agent: working" label on start.
- [ ] Agent replaces 👀 with success reaction and removes label on completion.
- [ ] Cache restore/save works for `$XDG_DATA_HOME/opencode/storage/`.
- [ ] `auth.json` is never persisted.
- [ ] Agent uses `session_search` on startup (evidence in logs).
- [ ] Every comment includes collapsed run summary.
- [ ] Fork PRs handled securely via `issue_comment` with permission gating.
- [ ] Session pruning runs at end of each run.
- [ ] S3 write-through option is functional.
- [ ] Discord bot connects and routes messages to OpenCode.
- [ ] Discord and GitHub share storage via S3.

---

## Timeline (high-level)

| Phase                        | Deliverables                                                  | Estimated Duration |
| ---------------------------- | ------------------------------------------------------------- | ------------------ |
| 1. SDK Execution Foundation  | SDK integration, model/agent config, mock event support       | 2 weeks            |
| 2. Enhanced Context          | GraphQL hydration, file attachments, prompt construction      | 2 weeks            |
| 3. GitHub Interaction Parity | Issue/PR/Discussion triggers, review comments, delegated work | 3 weeks            |
| 4. Discord Daemon MVP        | Channel=repo, thread=session, reverse proxy, S3 sync          | 3 weeks            |
| 5. Hardening                 | Concurrency handling, pruning, error handling, docs           | 2 weeks            |

---

## Open Questions / Risks / Dependencies

1. **Cache poisoning & trust boundaries**
   - Risk: branch-scoped cache reduces poisoning risk, but write-through S3 introduces new risks and IAM complexity.
   - Mitigation:
     - Separate S3 prefixes by `agent_identity + repo`.
     - Separate IAM roles/policies by environment; restrict to `GetObject/PutObject/List` for that prefix.
     - Document threat model and recommend enabling S3 bucket versioning.

2. **Session storage size growth**
   - Risk: unbounded storage growth can cause cache thrash and slower restores.
   - Mitigation:
     - Implement session pruning (default: 50 sessions or 30 days) in v1.
     - Emit storage size in run summary; warn when exceeding a configurable threshold.

3. **@opencode-ai/sdk stability**
   - Risk: External SDK dependency with unknown API stability.
   - Mitigation:
     - Pin SDK version in package.json.
     - Comprehensive integration tests for SDK interactions.
     - Monitor SDK releases for breaking changes.

4. **GraphQL rate limits**
   - Risk: Large PRs with many comments/files could hit rate limits.
   - Mitigation:
     - Implement pagination with limits (50 comments, 100 files).
     - Cache GraphQL responses within a run.
     - Fall back to REST API on GraphQL failure.

5. **File attachment security**
   - Risk: Malicious attachments (malware, oversized files, unexpected MIME types).
   - Mitigation:
     - Strict URL allowlist (`github.com/user-attachments/` only).
     - Size limits (5MB per file, 15MB total).
     - MIME type validation.
     - Attachments never persisted to cache.

6. **Noisy automated triggers** (NEW - v1.2)
   - Risk: `issues` and `pull_request` events could trigger expensive/noisy runs on every edit.
   - Mitigation:
     - Constrain supported actions per trigger (see section A.1).
     - Require @mention for `issues.edited`.
     - Skip draft PRs by default.
     - Clear documentation on which events/actions are handled.

7. **Post-action hook reliability** (NEW - v1.2)
   - Risk: Post-hook may still miss in extreme edge cases (runner crash).
   - Mitigation:
     - Post-hook is best-effort addition, not replacement for `finally` cleanup.
     - S3 write-through provides additional durability layer.
     - Monitor cache hit rates to detect issues.

---

## Appendix: Technical Notes

### Execution Model Decision

**v1.1 Change:** The project uses **SDK-based execution** via `@opencode-ai/sdk` as the primary execution model. This replaces the previous CLI execution model (`opencode run "$PROMPT"`).

**Rationale:**

- Enables structured file attachments as typed parts
- Provides session event streaming for real-time progress
- Supports agent validation before execution
- Aligns with OpenCode GitHub Action and oh-my-opencode patterns

**RFC Impact:**

- RFC-012 (Agent Execution - Main Action) is superseded by this specification
- RFC-013 (SDK Execution Mode) will detail the implementation
- RFC-011 (Setup Action) decision table updated to reflect SDK choice

### Runtime Decision

The project uses **Node.js 24** as the GitHub Actions runtime. This aligns with:

- Current `action.yaml` (`runs.using: node24`)
- Existing `package.json` and `tsdown` bundler setup
- Broader ecosystem compatibility

**Note:** The oMo Sisyphus reference implementation uses **Bun** in its reusable workflow. This project targets Node.js for the action runtime but **automatically installs Bun** when needed for oMo plugin installation, providing seamless compatibility without requiring users to configure Bun separately.

### Single Entrypoint with Auto-Setup

The main action (`uses: fro-bot/agent`) handles both environment setup and agent execution. There is no separate setup action.

### Storage Format Versioning

Include a `.version` file in `$XDG_DATA_HOME/opencode/storage/`:

```txt
1
```

Increment on breaking changes. Agent checks on restore and warns if mismatch.

### New Dependencies (v1.1)

| Dependency         | Purpose                        | Version Strategy               |
| ------------------ | ------------------------------ | ------------------------------ |
| `@opencode-ai/sdk` | SDK client for OpenCode server | Pin to specific version        |
| GraphQL client     | GitHub context hydration       | Use Octokit's built-in GraphQL |
