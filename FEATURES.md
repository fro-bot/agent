# Features: Fro Bot Agent

**Extracted from:** PRD.md
**Date:** 2026-01-14
**Version:** v1.2 MVP

---

## Table of Contents

- [Product Overview](#product-overview)
- [Feature Summary](#feature-summary)
- [Category A: GitHub Agent Interactions](#category-a-github-agent-interactions)
- [Category B: Discord Agent](#category-b-discord-agent)
- [Category C: Shared Memory & Persistence](#category-c-shared-memory--persistence)
- [Category D: Setup Action & Environment Bootstrap](#category-d-setup-action--environment-bootstrap)
- [Category E: SDK Execution](#category-e-sdk-execution)
- [Category F: Context & Prompt](#category-f-context--prompt)
- [Category G: Security & Access Control](#category-g-security--access-control)
- [Category H: Observability & Auditability](#category-h-observability--auditability)
- [Category I: Error Handling & Reliability](#category-i-error-handling--reliability)
- [Category J: Configuration & Deployment](#category-j-configuration--deployment)
- [Category K: Additional Triggers & Directives](#category-k-additional-triggers--directives)
- [Dependency Graph](#dependency-graph)

---

## Product Overview

Fro Bot Agent is a reusable **agent harness** that runs OpenCode with an Oh My OpenCode (oMo) Sisyphus agent workflow to act as an autonomous collaborator on GitHub (Issues, Discussions, PRs) and Discord (long-running bot with Kimaki-like UX).

**Core Differentiator:** Durable memory across runs - OpenCode session/application state is restored at start and saved at end, enabling the agent to pick up work without repeating expensive investigation.

**v1.2 Changes:** Additional GitHub triggers (`issues`, `pull_request`, `pull_request_review_comment`, `schedule`), trigger-specific prompt directives, post-action cache hook for reliable state persistence, prompt input required for scheduled/manual triggers.

**v1.1 Changes:** SDK-based execution replaces CLI, GraphQL context hydration, file attachment support, explicit model/agent configuration, mock event support for local testing.

**Target Personas:**
- Repo Maintainer (Primary) - wants reliable "extra engineer"
- Contributor (Secondary) - wants fast PR/issue feedback
- Discord Moderator (Secondary) - wants agent grounded in specific repo
- Platform/Security Owner (Stakeholder) - requires audit trails & least-privilege

---

## Feature Summary

| Priority             | Count | Categories                                     |
| -------------------- | ----- | ---------------------------------------------- |
| **Must Have (P0)**   | 52    | Core functionality for MVP                     |
| **Should Have (P1)** | 12    | Important but not critical for initial release |
| **Could Have (P2)**  | 2     | Desirable, can be deferred                     |

| Category                         | Feature Count |
| -------------------------------- | ------------- |
| GitHub Agent Interactions        | 11            |
| Discord Agent                    | 5             |
| Shared Memory & Persistence      | 8             |
| Setup Action & Bootstrap         | 7             |
| SDK Execution                    | 6             |
| Context & Prompt                 | 8             |
| Security & Access Control        | 5             |
| Observability & Auditability     | 4             |
| Error Handling & Reliability     | 4             |
| Configuration & Deployment       | 4             |
| Additional Triggers & Directives | 8             |

---

## Category A: GitHub Agent Interactions

### F1: GitHub Action Trigger Support

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** None

**Description:**
The product ships as a TypeScript GitHub Action (Node.js 24 runtime) supporting oMo/Sisyphus-style triggers with expanded event support.

**Core Triggers:**
| Event                         | Supported Actions                   | Prompt Requirement            | Scope      |
| ----------------------------- | ----------------------------------- | ----------------------------- | ---------- |
| `issue_comment`               | `created`                           | Optional (uses comment body)  | Issue/PR   |
| `discussion_comment`          | `created`                           | Optional (uses comment body)  | Discussion |
| `workflow_dispatch`           | -                                   | **Required**                  | Repo       |
| `schedule`                    | -                                   | **Required**                  | Repo       |
| `issues`                      | `opened`, `edited` (with @mention)  | Optional (defaults to triage) | Issue      |
| `pull_request`                | `opened`, `synchronize`, `reopened` | Optional (defaults to review) | PR         |
| `pull_request_review_comment` | `created`                           | Optional (uses comment body)  | PR Review  |

**Acceptance Criteria:**
- [ ] Supports `workflow_dispatch` for manual invocation
- [ ] Supports `issue_comment` `created` as primary trigger for Issues and PRs
- [ ] Supports `schedule` event with required `prompt` input
- [ ] Supports `issues` event with `opened` action (auto-triage)
- [ ] Supports `issues.edited` only when `@fro-bot` mentioned in body
- [ ] Supports `pull_request` event with `opened`, `synchronize`, `reopened` actions
- [ ] Supports `pull_request_review_comment` with `created` action
- [ ] Skips draft PRs by default (configurable)
- [ ] Hard fails if `prompt` is empty for `schedule`/`workflow_dispatch`
- [ ] Runtime detection distinguishes Issue vs PR context
- [ ] Supports `discussion` with `types: [created]` (document gaps as known limitations)
- [ ] Action invocable via `uses: fro-bot/agent@v0`

**Technical Considerations:**
- Must detect fork PRs at runtime to apply security gates
- Event context parsing from `github.event.*` payloads
- Trigger-specific prompt directives (see F69)

---

### F2: Issue Comment Interaction

**Priority:** Must Have (P0)
**Complexity:** Low
**Dependencies:** F1

**Description:**
Agent can read issue context and post in-thread comments.

**Acceptance Criteria:**
- [ ] Agent reads full issue body and comment thread
- [ ] Agent posts new comments in issue threads
- [ ] Agent can update existing "agent comments" for idempotent reruns
- [ ] Comments include collapsed run summary (see F35)

**Edge Cases:**
- Very long issue threads (pagination handling)
- Locked issues (handle gracefully, report in summary)

---

### F3: Discussion Comment Interaction

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F1, F28 (GraphQL)

**Description:**
Agent can participate in GitHub Discussions threads.

**Acceptance Criteria:**
- [ ] Agent reads discussion body and comment thread via GraphQL
- [ ] Agent posts in-thread discussion comments
- [ ] Agent can update existing agent comments
- [ ] Comments include collapsed run summary

**Technical Considerations:**
- Discussion API requires GraphQL (not REST)
- Uses same GraphQL client as F28

---

### F4: PR Conversation Comments

**Priority:** Must Have (P0)
**Complexity:** Low
**Dependencies:** F1

**Description:**
Agent can post comments in PR conversation thread.

**Acceptance Criteria:**
- [ ] Agent reads PR description and conversation thread
- [ ] Agent posts general PR comments
- [ ] Agent can update existing agent comments
- [ ] Comments include collapsed run summary

---

### F5: PR Review Comments

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F4

**Description:**
Agent can post line-level review comments on PR diffs.

**Acceptance Criteria:**
- [ ] Agent can read PR diff content
- [ ] Agent can post review comments on specific lines/hunks
- [ ] Agent can submit reviews (approve, request changes, comment)
- [ ] Review comments are contextually relevant to changed code

**Technical Considerations:**
- Requires understanding of diff hunks and line mapping
- Must handle multi-commit PRs and force-pushes

---

### F6: Delegated Work - Push Commits

**Priority:** Must Have (P0)
**Complexity:** High
**Dependencies:** F1, F18

**Description:**
When requested, the agent can push commits to branches.

**Acceptance Criteria:**
- [ ] Agent can create new branches
- [ ] Agent can commit changes to branches
- [ ] Agent can push to remote (non-protected branches)
- [ ] Uses elevated credentials (GitHub App token or PAT) only when needed
- [ ] Never pushes directly to protected branches without explicit PR

---

### F7: Delegated Work - Open PRs

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F6

**Description:**
When requested, the agent can open pull requests.

**Acceptance Criteria:**
- [ ] Agent can create PR from pushed branch to target branch
- [ ] PR includes meaningful title and description
- [ ] PR references original issue/discussion if applicable
- [ ] Agent posts confirmation comment with PR link

---

### F8: Comment Idempotency

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F2, F3, F4

**Description:**
Agent maintains idempotent behavior for reruns by updating existing comments.

**Acceptance Criteria:**
- [ ] Agent can identify its own prior comments (via marker/signature)
- [ ] Rerun updates existing agent comment instead of creating duplicate
- [ ] Option to post separate summary comment when update would lose history
- [ ] Large diffs or end-of-run summaries can use separate comments

**Technical Considerations:**
- Use hidden HTML comment marker to identify agent comments
- Configurable behavior: update vs append

---

### F9: Anti-Loop Protection

**Priority:** Must Have (P0)
**Complexity:** Low
**Dependencies:** F1

**Description:**
Agent ignores comments from its own account to prevent infinite loops.

**Acceptance Criteria:**
- [ ] Agent detects when comment author matches bot identity
- [ ] Agent skips processing for self-authored comments
- [ ] Detection works for both GitHub App and PAT authentication

---

### F10: Reactions & Labels Acknowledgment

**Priority:** Must Have (P0)
**Complexity:** Low
**Dependencies:** F1

**Description:**
Agent provides visual feedback via reactions and labels to acknowledge work status.

**Acceptance Criteria:**
- [ ] Agent adds 👀 (eyes) reaction to triggering comment on receipt
- [ ] Agent adds "agent: working" label to issue/PR when starting work
- [ ] Agent replaces 👀 with success reaction on completion
- [ ] Agent removes "agent: working" label on completion (success or failure)
- [ ] "agent: working" label is created automatically if it doesn't exist
- [ ] All reaction/label operations are non-fatal (warn on failure)

---

### F11: Issue vs PR Context Detection

**Priority:** Must Have (P0)
**Complexity:** Low
**Dependencies:** F1

**Description:**
Agent accurately detects whether it's operating on an issue or PR from `issue_comment` events.

**Acceptance Criteria:**
- [ ] Agent queries GitHub API to determine if issue has associated PR
- [ ] Detection works for both standalone issues and PRs
- [ ] Context type ("issue" or "pr") included in prompt and run summary
- [ ] PR-specific operations (review comments) only attempted on PRs

---

## Category B: Discord Agent

### F12: Discord Channel-to-Repo Mapping

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** None

**Description:**
Discord channels map 1:1 to GitHub repos/projects.

**Acceptance Criteria:**
- [ ] Admin command to link Discord channel to GitHub repo
- [ ] Mapping stored persistently in bot config/database
- [ ] Only users with configured role (e.g., Maintainer) can create mappings
- [ ] Mapping changes are audited/logged

**Technical Considerations:**
- Database or config file for mapping storage
- Role-based permission checking via Discord API

---

### F13: Discord Thread-to-Session Mapping

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F12, F14

**Description:**
Discord threads map to OpenCode sessions for conversation continuity.

**Acceptance Criteria:**
- [ ] New thread creates or resumes OpenCode session
- [ ] Thread messages route to associated session
- [ ] Session continuity maintained across thread messages
- [ ] User can resume prior session by referencing thread

---

### F14: Discord Daemon Architecture

**Priority:** Must Have (P0)
**Complexity:** High
**Dependencies:** None

**Description:**
Discord bot runs as long-lived daemon with reverse proxy boundary.

**Acceptance Criteria:**
- [ ] Bot runs as persistent process (not triggered per-event)
- [ ] Discord-facing component handles message routing and auth
- [ ] OpenCode execution happens in isolated process/container
- [ ] Graceful handling of Discord API issues (log and continue)

**Technical Considerations:**
- Recommended: Docker container or systemd service
- Reverse proxy isolates Discord auth from OpenCode execution
- Must handle Discord gateway disconnects/reconnects

---

### F15: Discord Shared Memory with GitHub

**Priority:** Must Have (P0)
**Complexity:** High
**Dependencies:** F12, F13, F16, F20

**Description:**
For the same project, Discord and GitHub share OpenCode storage.

**Acceptance Criteria:**
- [ ] Discord bot accesses same storage as GitHub Action for given repo
- [ ] S3 sync mechanism enables cross-environment sharing
- [ ] Session created in Discord visible to GitHub runs and vice versa
- [ ] Storage isolation maintained between different repos

**Technical Considerations:**
- S3 write-through required (Discord runs outside GitHub Actions cache)
- Sync on session start and end

---

### F16: Discord Permission Model

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F12

**Description:**
Discord bot respects permission boundaries for GitHub operations.

**Acceptance Criteria:**
- [ ] Bot checks user's Discord role before channel-repo linking
- [ ] Delegated GitHub operations respect GitHub permissions
- [ ] Permission denials logged and reported to user
- [ ] No credentials exposed in Discord messages

---

## Category C: Shared Memory & Persistence

### F17: OpenCode Storage Cache Restore

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** None

**Description:**
Restore OpenCode storage directory at start of GitHub Action run.

**Acceptance Criteria:**
- [ ] Restore `$XDG_DATA_HOME/opencode/storage/` at job start
- [ ] Cache miss is not a failure (proceed with empty state)
- [ ] Restore completes in <30s for typical sizes (<500MB)
- [ ] Cache key includes agent identity, repo, and branch

**Cache Key Pattern:**
```
opencode-storage-${agent_identity}-${repo}-${ref_name}-${runner_os}
```

**Restore-keys Fallback:**
```
opencode-storage-${agent_identity}-${repo}-${ref_name}-
opencode-storage-${agent_identity}-${repo}-
```

---

### F18: OpenCode Storage Cache Save

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F17

**Description:**
Save OpenCode storage directory at end of GitHub Action run.

**Acceptance Criteria:**
- [ ] Save `$XDG_DATA_HOME/opencode/storage/` at job end
- [ ] Save runs even if job fails (via `if: always()`)
- [ ] Cache key unique per run to enable versioning
- [ ] Save excludes `auth.json` (see F34)

---

### F19: Session Search on Startup

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F17

**Description:**
On startup, the agent uses oMo session tools to find relevant prior work.

**Two layers involved:**
1. **Action-side (RFC-004)**: `listSessions()` and `searchSessions()` utilities run at startup
2. **Agent-side (oMo)**: Agent uses `session_search` and `session_read` LLM tools during execution

**Acceptance Criteria:**
- [ ] Action harness calls RFC-004 `listSessions()` to discover prior sessions
- [ ] Agent prompt includes session context from startup introspection
- [ ] Agent is instructed to call oMo `session_search` before re-investigating
- [ ] Agent reads relevant prior sessions when found via `session_read`
- [ ] Evidence of session search appears in logs

---

### F20: S3 Write-Through Backup

**Priority:** Must Have (P0)
**Complexity:** High
**Dependencies:** F17, F18

**Description:**
Optional S3 backup for cross-runner portability and Discord support.

**Acceptance Criteria:**
- [ ] Sync storage to S3 at end of run
- [ ] Restore from S3 when GitHub cache misses
- [ ] S3 prefix scoped by agent identity + repo
- [ ] Credentials provided via GitHub Secrets (placeholders in docs)
- [ ] Required for Discord agent (runs outside GitHub Actions)

**Technical Considerations:**
- Separate IAM roles/policies per environment
- Recommend S3 bucket versioning for rollback

---

### F21: Close-the-Loop Session Writeback

**Priority:** Must Have (P0)
**Complexity:** Low
**Dependencies:** F19, F18

**Description:**
Before finishing, the action produces a durable summary discoverable by future sessions.

**Acceptance Criteria:**
- [ ] Action harness calls RFC-004 `writeSessionSummary()` at end of run
- [ ] Written summary is in valid OpenCode message format
- [ ] Agent is instructed to document key decisions/fixes before completing
- [ ] Summary searchable via `session_search` in future runs

---

### F22: Session Pruning

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F17, F18

**Description:**
Retention policy prevents unbounded storage growth.

**Acceptance Criteria:**
- [ ] Action harness calls RFC-004 `pruneSessions()` at end of each run
- [ ] Default: keep last 50 sessions OR sessions from last 30 days (whichever larger)
- [ ] Pruning also removes child sessions of pruned parents
- [ ] Retention policy configurable via action input
- [ ] Pruned sessions logged in run summary

---

### F23: Storage Versioning

**Priority:** Should Have (P1)
**Complexity:** Low
**Dependencies:** F17

**Description:**
Include version marker in storage directory for compatibility checks.

**Acceptance Criteria:**
- [ ] `.version` file in storage directory with version number
- [ ] Version incremented on breaking storage format changes
- [ ] On version mismatch: warn and proceed with clean state (no failure)
- [ ] Mismatch warning appears in run summary

---

### F24: Corruption Detection

**Priority:** Should Have (P1)
**Complexity:** Medium
**Dependencies:** F17

**Description:**
Detect obvious corruption in restored storage.

**Acceptance Criteria:**
- [ ] Check for missing required directories
- [ ] Check for unreadable database files
- [ ] If corruption detected: log warning, include in run summary
- [ ] Proceed with clean state on corruption (no failure)

---

## Category D: Setup Action & Environment Bootstrap

### F25: Setup Action Entrypoint

**Priority:** Must Have (P0)
**Complexity:** High
**Dependencies:** F1

**Description:**
Provide a dedicated `setup` action (`uses: fro-bot/agent/setup@v0`) that bootstraps the complete agent environment.

**Acceptance Criteria:**
- [ ] `uses: fro-bot/agent/setup` available as separate action
- [ ] Outputs: `opencode-path`, `opencode-version`, `gh-authenticated`, `setup-duration`, `cache-status`

---

### F26: OpenCode CLI Installation

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F25

**Description:**
Install OpenCode binary via `@actions/tool-cache` for cross-run caching.

**Acceptance Criteria:**
- [ ] Installs OpenCode CLI via `@actions/tool-cache` with cross-run caching
- [ ] Supports `opencode-version` input (default: `latest`)
- [ ] Add OpenCode to PATH for subsequent steps

---

### F27: oMo Plugin Installation

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F26

**Description:**
Automatically install Bun runtime and oMo plugins.

**Acceptance Criteria:**
- [ ] Automatically installs Bun runtime via `@actions/tool-cache`
- [ ] Installs oMo plugin via `bunx oh-my-opencode install`
- [ ] Users do NOT need `oven-sh/setup-bun`
- [ ] Graceful degradation: warn on failure, do not fail the run

---

### F28: GitHub CLI Authentication

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F25

**Description:**
Configure `gh` CLI with appropriate credentials.

**Acceptance Criteria:**
- [ ] Configures `gh` CLI with `GH_TOKEN` environment variable
- [ ] Supports GitHub App token generation from `app-id` + `private-key` inputs
- [ ] Falls back to `GITHUB_TOKEN` when App credentials not provided
- [ ] `GH_TOKEN` takes priority over `GITHUB_TOKEN` for `gh` CLI operations

---

### F29: Git Identity Configuration

**Priority:** Must Have (P0)
**Complexity:** Low
**Dependencies:** F25

**Description:**
Configure git identity for commits.

**Acceptance Criteria:**
- [ ] Set `user.name` and `user.email` for commits
- [ ] Use GitHub App bot identity format: `<app-slug>[bot]`
- [ ] Email format: `<user-id>+<app-slug>[bot]@users.noreply.github.com`

---

### F30: auth.json Population

**Priority:** Must Have (P0)
**Complexity:** Low
**Dependencies:** F25

**Description:**
Write LLM provider credentials securely.

**Acceptance Criteria:**
- [ ] Populates `auth.json` from `auth-json` secret input
- [ ] File written with mode `0600` (owner read/write only)
- [ ] **NEVER cached** - populated fresh each run

---

### F31: Cache Restoration in Setup

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F25, F17

**Description:**
Restore OpenCode storage from cache during setup phase.

**Acceptance Criteria:**
- [ ] Restore OpenCode storage from GitHub Actions cache
- [ ] Run early in setup phase for session continuity
- [ ] Cache miss does not fail setup

---

## Category E: SDK Execution

### F32: SDK-Based Agent Execution

**Priority:** Must Have (P0)
**Complexity:** High
**Dependencies:** F26, F27

**Description:**
Use `@opencode-ai/sdk` for agent execution, replacing CLI model.

**Acceptance Criteria:**
- [ ] Use `createOpencode()` for automatic server lifecycle
- [ ] Server started automatically, managed via AbortController
- [ ] No manual port management required
- [ ] Session created via `client.session.create({ body: { title } })`
- [ ] Prompt sent via `client.session.promptAsync()` (non-blocking)
- [ ] Track session ID throughout execution

---

### F33: Event Subscription and Processing

**Priority:** Must Have (P0)
**Complexity:** High
**Dependencies:** F32

**Description:**
Subscribe to and process SDK events for progress tracking.

**Acceptance Criteria:**
- [ ] Subscribe via `client.event.subscribe()` returns async stream
- [ ] Track state: `mainSessionIdle`, `mainSessionError`, `lastError`
- [ ] Process tool calls, text updates, session events

---

### F34: Completion Detection

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F33

**Description:**
Detect when agent has completed work.

**Acceptance Criteria:**
- [ ] Poll every 500ms for idle state
- [ ] Check completion conditions (todos complete, no pending work)
- [ ] Handle session errors with proper exit codes

---

### F35: Timeout and Cancellation

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F32

**Description:**
Support configurable timeout and clean cancellation.

**Acceptance Criteria:**
- [ ] Configurable timeout via `timeout` input (0 = no timeout, default: 30 minutes)
- [ ] AbortController for clean cancellation
- [ ] SIGINT handling for graceful shutdown

---

### F36: SDK Cleanup

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F32

**Description:**
Clean shutdown of SDK server and resources.

**Acceptance Criteria:**
- [ ] `server.close()` on completion, error, or signal
- [ ] Restore any modified git config
- [ ] Proper exit codes (0=success, 1=error, 130=interrupted)

---

### F37: Model and Agent Configuration

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F32

**Description:**
Configure which model and agent to use via action inputs.

**Acceptance Criteria:**
- [ ] `model` input required (format: `provider/model`)
- [ ] `agent` input optional, validated against available agents via `client.agent.list()`
- [ ] Fall back to default agent with warning if validation fails
- [ ] Model/agent included in run summary footer
- [ ] Log model selection at start of execution

---

## Category F: Context & Prompt

### F38: Mock Event Support

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F1

**Description:**
Support mock GitHub events for local development and testing.

**Acceptance Criteria:**
- [ ] `MOCK_EVENT` environment variable accepts JSON payload matching GitHub webhook schema
- [ ] `MOCK_TOKEN` provides authentication token for local testing
- [ ] Only enabled when `CI` env var is not `true` OR `allow-mock-event: true` input is set
- [ ] Mock payload validated on parse; clear error messages for malformed input
- [ ] Log warning when mock mode is active
- [ ] Mock mode uses `https://dev.opencode.ai` for share links

---

### F39: File Attachment Detection

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F32

**Description:**
Parse GitHub user-attachment URLs from comment body.

**Acceptance Criteria:**
- [ ] Parse markdown images: `![alt](https://github.com/user-attachments/assets/...)`
- [ ] Parse HTML images: `<img ... src="https://github.com/user-attachments/assets/..." />`
- [ ] Parse file links: `[filename](https://github.com/user-attachments/files/...)`
- [ ] Validate URLs are from `github.com/user-attachments/` only

---

### F40: File Attachment Download

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F39

**Description:**
Download and process file attachments.

**Acceptance Criteria:**
- [ ] Authenticate with GitHub token for private repo attachments
- [ ] Download to temp storage
- [ ] Determine MIME type from response headers
- [ ] Max 5 attachments per comment
- [ ] Max 5MB per attachment, 15MB total
- [ ] Allowed types: `image/*`, `text/*`, `application/json`, `application/pdf`
- [ ] Attachments NOT persisted to cache

---

### F41: File Attachment Prompt Injection

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F40, F32

**Description:**
Pass file attachments to SDK as typed parts.

**Acceptance Criteria:**
- [ ] Replace original markdown with `@filename` reference
- [ ] Pass as `type: "file"` parts with base64 content
- [ ] Log attachment metadata (filename, size, type) but not content

---

### F42: GraphQL Issue Context Hydration

**Priority:** Must Have (P0)
**Complexity:** High
**Dependencies:** F1

**Description:**
Fetch full issue context via GraphQL.

**Acceptance Criteria:**
- [ ] Fetch: title, body, author, state, created date
- [ ] Fetch: last 50 comments with author, timestamp, body
- [ ] Fetch: labels and assignees
- [ ] Truncate bodies > 10KB with note
- [ ] Fall back to REST API on GraphQL failure

---

### F43: GraphQL PR Context Hydration

**Priority:** Must Have (P0)
**Complexity:** High
**Dependencies:** F1

**Description:**
Fetch full PR context via GraphQL.

**Acceptance Criteria:**
- [ ] Fetch base data: title, body, author, state, baseRefName, headRefName, headRefOid
- [ ] Fetch stats: additions, deletions, commits.totalCount
- [ ] Fetch repository info: baseRepository.nameWithOwner, headRepository.nameWithOwner
- [ ] Fetch commits: last 100 with oid, message, author
- [ ] Fetch files: last 100 with path, additions, deletions, changeType
- [ ] Fetch comments: last 100 with full metadata
- [ ] Fetch reviews: last 100 with state, body, and inline comments (path, line)
- [ ] Detect fork PRs by comparing headRepository vs baseRepository
- [ ] Fall back to REST API on GraphQL failure

---

### F44: Context Budgeting

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F42, F43

**Description:**
Enforce limits on context size.

**Acceptance Criteria:**
- [ ] Max 50 comments per thread
- [ ] Max 100 changed files
- [ ] Truncate bodies > 10KB with note
- [ ] Total context budget: ~100KB before prompt injection
- [ ] Log warning when context is degraded

---

### F45: Agent Prompt Construction

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F42, F43, F44

**Description:**
Build structured agent prompt with all required sections.

**Acceptance Criteria:**
- [ ] Multi-section structure: mode-instructions, identity, context, user-request, mandatory-reading, issue/pr-data, action-instructions
- [ ] Include mandatory reading instructions (gh issue view, gh pr view, etc.)
- [ ] Include heredoc syntax guidance for GitHub comments
- [ ] Include session tool instructions (session_search, session_read)
- [ ] Include GitHub CLI examples for common operations

---

## Category G: Security & Access Control

### F46: auth.json Exclusion

**Priority:** Must Have (P0)
**Complexity:** Low
**Dependencies:** F17, F18

**Description:**
Never persist `auth.json`; rehydrate each run from secrets.

**Acceptance Criteria:**
- [ ] `auth.json` explicitly excluded from cache paths
- [ ] `auth.json` explicitly excluded from S3 sync
- [ ] `auth.json` populated from GitHub Actions secrets each run
- [ ] No credentials appear in logs or comments

---

### F47: Fork PR Permission Gating

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F1, F9

**Description:**
Only respond to comments from authorized users on fork PRs.

**Acceptance Criteria:**
- [ ] Use `issue_comment` trigger (not `pull_request_review_comment`)
- [ ] Check author association: only OWNER, MEMBER, COLLABORATOR
- [ ] Ignore comments from unauthorized users (no response, log only)
- [ ] Ignore comments from bot's own account (anti-loop)

**Technical Considerations:**
- `github.event.comment.author_association` for association check
- Matches oMo Sisyphus agent approach for secure fork handling

---

### F48: Credential Strategy

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F6, F7

**Description:**
Flexible credential handling for elevated operations.

**Acceptance Criteria:**
- [ ] Default: GitHub App token for elevated ops (recommended)
- [ ] Fallback: PAT support for repos without GitHub App
- [ ] Default `GITHUB_TOKEN` remains minimal permissions
- [ ] Elevated credentials used only when delegated work requested

---

### F49: Branch-Scoped Caching

**Priority:** Must Have (P0)
**Complexity:** Low
**Dependencies:** F17

**Description:**
Prefer branch-scoped caches to reduce poisoning risk.

**Acceptance Criteria:**
- [ ] Cache key includes `ref_name` (branch)
- [ ] Restore-keys allow fallback to repo-level cache
- [ ] Cache threat model documented

---

### F50: Concurrency Handling

**Priority:** Should Have (P1)
**Complexity:** Medium
**Dependencies:** F17, F18

**Description:**
Handle simultaneous runs hitting same cache key.

**Acceptance Criteria:**
- [ ] Use last-write-wins semantics
- [ ] Emit warning in run summary if race detected (best-effort)
- [ ] No data corruption from concurrent writes

---

## Category H: Observability & Auditability

### F51: Run Summary in Comments

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F2, F3, F4

**Description:**
Every agent comment includes collapsed details block with run metadata.

**Acceptance Criteria:**
- [ ] Summary includes: event type, repo, ref/branch, run ID
- [ ] Summary includes: cache status (hit/miss/corrupted)
- [ ] Summary includes: session IDs used/created
- [ ] Summary includes: links to PRs/commits created
- [ ] Summary includes: duration and token usage (if available)
- [ ] Summary includes: model/agent used
- [ ] Summary formatted as collapsed `<details>` block

---

### F52: GitHub Actions Job Summary

**Priority:** Must Have (P0)
**Complexity:** Low
**Dependencies:** F51

**Description:**
Provide structured summary in GitHub Actions job output.

**Acceptance Criteria:**
- [ ] Job summary includes all metadata from F51
- [ ] Job summary viewable in Actions UI
- [ ] Session IDs and run IDs included for traceability

---

### F53: Structured Logging

**Priority:** Must Have (P0)
**Complexity:** Low
**Dependencies:** None

**Description:**
Emit JSON-structured logs for machine parsing.

**Acceptance Criteria:**
- [ ] Logs emitted in JSON format
- [ ] Include: timestamp, level, message, context
- [ ] Include: session IDs, run IDs, repo context

---

### F54: Token Usage Reporting

**Priority:** Must Have (P0)
**Complexity:** Low
**Dependencies:** F51

**Description:**
Report LLM token usage in run summary when available.

**Acceptance Criteria:**
- [ ] Token usage included in collapsed summary
- [ ] Tracks input/output tokens if provider supports
- [ ] Helps with cost monitoring and optimization

---

## Category I: Error Handling & Reliability

### F55: Error Message Format

**Priority:** Must Have (P0)
**Complexity:** Low
**Dependencies:** F2, F3, F4

**Description:**
Standardized error message format in agent comments.

**Acceptance Criteria:**
- [ ] Human-readable summary of what failed
- [ ] Error type identified (rate limit, LLM timeout, cache corruption, etc.)
- [ ] Suggested next steps or retry guidance included
- [ ] Error details in collapsed section if verbose

---

### F56: GitHub API Rate Limit Handling

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** None

**Description:**
Graceful degradation when GitHub API rate limited.

**Acceptance Criteria:**
- [ ] Exponential backoff: max 3 retries (30s/60s/120s)
- [ ] After retries exhausted: post partial results
- [ ] Rate limit status included in run summary
- [ ] No crash or silent failure

---

### F57: LLM API Error Handling

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** None

**Description:**
Graceful handling of LLM API timeouts and errors.

**Acceptance Criteria:**
- [ ] Retry once after 10s on timeout/error
- [ ] After retry: post error comment with explanation
- [ ] Error type distinguished (timeout, quota, network)
- [ ] Partial results posted if available

---

### F58: Discord API Error Handling

**Priority:** Must Have (P0)
**Complexity:** Low
**Dependencies:** F14

**Description:**
Discord bot handles API issues without crashing.

**Acceptance Criteria:**
- [ ] API errors logged but don't crash daemon
- [ ] Automatic reconnect on gateway disconnect
- [ ] User notified of temporary issues when possible

---

## Category J: Configuration & Deployment

### F59: Action Inputs Configuration

**Priority:** Must Have (P0)
**Complexity:** Low
**Dependencies:** F1

**Description:**
Configurable action inputs for customization.

**Acceptance Criteria:**
- [ ] `model` input required (format: `provider/model`)
- [ ] `agent` input optional
- [ ] `timeout` input configurable (default: 30 minutes)
- [ ] `auth-json` input for LLM credentials
- [ ] Session retention policy configurable
- [ ] S3 backup enable/disable configurable
- [ ] All inputs documented with defaults

---

### F60: Secrets/Vars Documentation

**Priority:** Must Have (P0)
**Complexity:** Low
**Dependencies:** None

**Description:**
Clear documentation of required secrets and variables.

**Acceptance Criteria:**
- [ ] Document required: `GITHUB_TOKEN`, `OPENCODE_AUTH_JSON`
- [ ] Document optional S3: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET`, `AWS_REGION`
- [ ] Only placeholders in examples (no real secrets)
- [ ] Security best practices documented

---

### F61: Discord Deployment Guide

**Priority:** Must Have (P0)
**Complexity:** Low
**Dependencies:** F14

**Description:**
Documentation for deploying Discord daemon.

**Acceptance Criteria:**
- [ ] Docker container deployment documented
- [ ] systemd service deployment documented
- [ ] Channel-repo mapping configuration documented
- [ ] Required Discord bot permissions documented

---

### F62: Rollback Plan

**Priority:** Should Have (P1)
**Complexity:** Low
**Dependencies:** F23

**Description:**
Documented procedure for handling breaking storage changes.

**Acceptance Criteria:**
- [ ] Rollback steps documented in release notes
- [ ] Include: revert action version
- [ ] Include: clear affected cache keys
- [ ] Version compatibility matrix maintained

---

## P1 Additional Features (Should Have)

### F63: Pull Request Review Comment Support (SUPERSEDED - See F73)

**Priority:** ~~Should Have (P1)~~ → **Elevated to P0 as F73 in v1.2**
**Complexity:** Medium
**Dependencies:** F5

**Description:**
Handle `pull_request_review_comment` event type for inline code review responses.

> **Note:** This feature has been elevated to P0 and is now tracked as **F73** in Category K.

---

### F64: Session Sharing

**Priority:** Should Have (P1)
**Complexity:** Medium
**Dependencies:** F32

**Description:**
Create public session share links for transparency.

**Acceptance Criteria:**
- [ ] Optional `share` input: `true`, `false`, or unset (auto)
- [ ] Auto behavior: share for public repos, don't share for private
- [ ] Call `client.session.share({ path: session })` to create public link
- [ ] Include share link in comment footer with optional social card image
- [ ] Output `share-url` from action

---

### F65: Automatic Branch Management

**Priority:** Should Have (P1)
**Complexity:** High
**Dependencies:** F6, F7

**Description:**
Automate branch creation and management for different workflows.

**Acceptance Criteria:**
- [ ] **Issue workflow**: Create new branch → make changes → push → create PR
- [ ] **Local PR workflow**: Checkout existing branch → make changes → push
- [ ] **Fork PR workflow**: Add fork remote → checkout → push to fork
- [ ] Branch naming: `opencode/{issue|pr}{number}-{timestamp}`
- [ ] Commit format with co-author attribution
- [ ] Dirty check: `git status --porcelain` before attempting push

---

### F66: Event Streaming and Progress Logging

**Priority:** Should Have (P1)
**Complexity:** Medium
**Dependencies:** F33

**Description:**
Real-time logging of agent progress and tool calls.

**Acceptance Criteria:**
- [ ] Subscribe to SSE events from OpenCode server
- [ ] Log tool calls with color-coded output (todo: yellow, bash: red, edit: green, etc.)
- [ ] Log text completions when finished
- [ ] Track session state updates in real-time

---

## P2 Features (Could Have)

### F67: Cross-Runner Portability

**Priority:** Could Have (P2)
**Complexity:** High
**Dependencies:** F20

**Description:**
Optional write-through S3 backup/restore for cross-runner scenarios.

**Acceptance Criteria:**
- [ ] S3 backup can restore to different runner types
- [ ] Storage format compatible across runners

---

### F68: Org-Level Memory Partitioning

**Priority:** Could Have (P2)
**Complexity:** Medium
**Dependencies:** F17

**Description:**
Support additional scoping (repo-only vs org-wide) as configurable.

**Acceptance Criteria:**
- [ ] Configurable memory scope: repo-only or org-wide
- [ ] Cache keys and S3 prefixes adjusted accordingly
- [ ] Cross-repo session discovery when org-wide enabled

---

## Category K: Additional Triggers & Directives

### F69: Trigger-Specific Prompt Directives

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F1, F45

**Description:**
Each trigger type injects a default task directive into the agent prompt via `getTriggerDirective()` function.

**Directive by Trigger Type:**
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

**Acceptance Criteria:**
- [ ] `getTriggerDirective(triggerContext, inputs)` function in `src/lib/agent/prompt.ts`
- [ ] Returns 5-20 lines of task-specific instructions
- [ ] Custom `prompt` input **appends** to directive for comment-based triggers
- [ ] Custom `prompt` input **replaces** directive for `schedule`/`workflow_dispatch`

---

### F70: Issues Event Trigger

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F1, F69

**Description:**
Support `issues` event for automated triage when issues are opened or edited.

**Acceptance Criteria:**
- [ ] Handle `issues` event with `opened` action
- [ ] Handle `issues.edited` only when `@fro-bot` mentioned in body
- [ ] Skip `issues.edited` without @mention (no response, log only)
- [ ] Default directive: triage behavior (summarize, reproduce, propose)
- [ ] Inject full issue body and recent comments as context

---

### F71: Pull Request Event Trigger

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F1, F69

**Description:**
Support `pull_request` event for automated code review.

**Acceptance Criteria:**
- [ ] Handle `pull_request` event with `opened`, `synchronize`, `reopened` actions
- [ ] Skip draft PRs by default (configurable via input)
- [ ] Default directive: review behavior (code quality, bugs, improvements)
- [ ] Inject commit summary, changed files list, existing review comments
- [ ] Context includes PR diff and file changes

---

### F72: Schedule Event Trigger

**Priority:** Must Have (P0)
**Complexity:** Low
**Dependencies:** F1, F69

**Description:**
Support `schedule` event for cron-based agent invocation.

**Acceptance Criteria:**
- [ ] Handle `schedule` event
- [ ] **Hard fail** if `inputs.prompt` is empty
- [ ] Uses `prompt` input directly (no default directive)
- [ ] Log scheduled task execution in run summary

---

### F73: Pull Request Review Comment Trigger (Elevated from P1)

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F5, F69

**Description:**
Handle `pull_request_review_comment` event type for inline code review responses. Elevated from P1 (F63) to P0 in v1.2.

**Acceptance Criteria:**
- [ ] Handle `pull_request_review_comment` event with `created` action
- [ ] Extract inline context: file path (`path`), line number (`line`, `original_line`)
- [ ] Extract diff hunk (`diff_hunk`) and commit ID (`commit_id`)
- [ ] Include in prompt as `<review_comment_context>` block
- [ ] Agent can respond with targeted fixes to the specific code location
- [ ] Default directive: "Respond to the review comment with file and code context"

---

### F74: Post-Action Cache Hook

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F18

**Description:**
Reliable cache saving via GitHub Actions `post:` field, independent of main action lifecycle.

**Acceptance Criteria:**
- [ ] Add `src/post.ts` entry point
- [ ] Update `action.yaml` with `runs.post: dist/post.js`
- [ ] Post-hook saves cache idempotently (best-effort)
- [ ] Post-hook runs session pruning (optional, non-fatal)
- [ ] **MUST NOT** fail the job if cache save fails
- [ ] Post-hook runs even on main action failure/timeout/cancellation

**Technical Considerations:**
- GitHub Actions `post:` runs in separate process, providing durability
- Current `finally` block cleanup can miss on hard kills (SIGKILL)
- Update `tsdown.config.ts` to bundle `post.ts` as third entry point
- Produces `dist/main.js`, `dist/setup.js`, `dist/post.js`

---

### F75: Prompt Input Required Validation

**Priority:** Must Have (P0)
**Complexity:** Low
**Dependencies:** F1, F69

**Description:**
Validate that `prompt` input is provided for triggers that require it.

**Acceptance Criteria:**
- [ ] `schedule` event: hard fail if `inputs.prompt` is empty
- [ ] `workflow_dispatch` event: hard fail if `inputs.prompt` is empty
- [ ] Error message clearly states that prompt is required
- [ ] Validation runs before agent execution begins

---

### F76: Draft PR Skip

**Priority:** Must Have (P0)
**Complexity:** Low
**Dependencies:** F71

**Description:**
Skip processing of draft PRs by default.

**Acceptance Criteria:**
- [ ] Detect draft PR status from `pull_request.draft` field
- [ ] Skip processing if PR is draft (default behavior)
- [ ] Configurable via action input to allow draft PR processing
- [ ] Log skip reason when draft PR is skipped

---

## Dependency Graph

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           GITHUB ACTION LAYER                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  F1 (Triggers) ─────────────────────────────────────────────────────────┐   │
│  ├── F2 (Issue Comments)                                                │   │
│  ├── F3 (Discussion Comments)                                           │   │
│  ├── F4 (PR Comments)                                                   │   │
│  │   └── F5 (PR Review Comments)                                        │   │
│  ├── F6 (Push Commits)                                                  │   │
│  │   └── F7 (Open PRs)                                                  │   │
│  ├── F8 (Idempotency)                                                   │   │
│  ├── F9 (Anti-Loop)                                                     │   │
│  ├── F10 (Reactions/Labels)                                             │   │
│  ├── F11 (Issue/PR Detection)                                           │   │
│  ├── F38 (Mock Events)                                                  │   │
│  │                                                                      │   │
│  └── F69 (Trigger Directives) ◄─────────────────────────────────────┐   │   │
│      ├── F70 (Issues Event)                                         │   │   │
│      │   └── responds to: opened, edited (with @mention)            │   │   │
│      ├── F71 (PR Event)                                             │   │   │
│      │   └── F76 (Draft PR Skip)                                    │   │   │
│      ├── F72 (Schedule Event)                                       │   │   │
│      │   └── F75 (Prompt Required Validation)                       │   │   │
│      └── F73 (PR Review Comment)                                    │   │   │
│                                                                     │   │   │
├─────────────────────────────────────────────────────────────────────┼───┼───┤
│                           SETUP & EXECUTION                         │   │   │
├─────────────────────────────────────────────────────────────────────┼───┼───┤
│                                                                     │   │   │
│  F25 (Setup Action) ────────────────────────────────────────────────┤   │   │
│  ├── F26 (OpenCode Install)                                         │   │   │
│  │   └── F27 (oMo Install)                                          │   │   │
│  │       └── F32 (SDK Exec) ────────────────────────────────────┐   │   │   │
│  │           ├── F33 (Event Subscription)                       │   │   │   │
│  │           ├── F34 (Completion Detection)                     │   │   │   │
│  │           ├── F35 (Timeout/Cancellation)                     │   │   │   │
│  │           ├── F36 (SDK Cleanup)                              │   │   │   │
│  │           └── F37 (Model/Agent Config)                       │   │   │   │
│  ├── F28 (gh CLI Auth)                                          │   │   │   │
│  ├── F29 (Git Identity)                                         │   │   │   │
│  ├── F30 (auth.json Population)                                 │   │   │   │
│  └── F31 (Cache Restore in Setup)                               │   │   │   │
│                                                                 │   │   │   │
├─────────────────────────────────────────────────────────────────┼───┼───┼───┤
│                           PERSISTENCE LAYER                     │   │   │   │
├─────────────────────────────────────────────────────────────────┼───┼───┼───┤
│                                                                 │   │   │   │
│  F17 (Cache Restore) ◄──────────────────────────────────────────┘   │   │   │
│  ├── F18 (Cache Save) ──────────────────────────────────────────────┤   │   │
│  │   ├── F20 (S3 Write-Through Backup)                              │   │   │
│  │   └── F74 (Post-Action Hook) ◄───────────────────────────────────┘   │   │
│  │       └── reliable save via runs.post, survives timeout/kill        │   │
│  ├── F19 (Session Search on Startup)                                    │   │
│  ├── F21 (Close-the-Loop Writeback)                                     │   │
│  ├── F22 (Session Pruning)                                              │   │
│  ├── F23 (Storage Versioning)                                           │   │
│  ├── F24 (Corruption Detection)                                         │   │
│  └── F49 (Branch-Scoped Caching)                                        │   │
│                                                                         │   │
├─────────────────────────────────────────────────────────────────────────┼───┤
│                           CONTEXT HYDRATION                             │   │
├─────────────────────────────────────────────────────────────────────────┼───┤
│                                                                         │   │
│  F39 (Attachment Detection) ────────────────────────────────────────────┤   │
│  ├── F40 (Attachment Download)                                          │   │
│  │   └── F41 (Attachment Prompt Injection)                              │   │
│                                                                         │   │
│  F42 (GraphQL Issue Context) ───────────────────────────────────────────┤   │
│  ├── F43 (GraphQL PR Context)                                           │   │
│  │   └── F44 (Context Budgeting)                                        │   │
│  │       └── F45 (Agent Prompt Construction) ◄──────────────────────────┘   │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                           SECURITY & ACCESS                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  F46 (auth.json Exclusion from Cache)                                       │
│  F47 (Fork PR Permission Gating)                                            │
│  F48 (Credential Strategy: App Token / PAT / GITHUB_TOKEN)                  │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                           DISCORD LAYER (Future)                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  F12 (Channel-Repo Mapping) ────────────────────────────────────────────┐   │
│  ├── F13 (Thread-Session Mapping)                                       │   │
│  ├── F15 (Shared Memory with GitHub) ◄──────────────────────────────────┘   │
│  └── F16 (Discord Permissions)                                              │
│                                                                             │
│  F14 (Discord Daemon) ──────────────────────────────────────────────────┐   │
│  ├── F15 (Shared Memory)                                                │   │
│  └── F58 (Discord API Error Handling)                                   │   │
│                                                                         │   │
└─────────────────────────────────────────────────────────────────────────┴───┘

Legend:
  ├──            = depends on / child of
  └──            = last child
  ◄──────────────= dependency arrow
```

---

*This document is auto-generated from PRD.md v1.2 and should be updated when the PRD changes.*
