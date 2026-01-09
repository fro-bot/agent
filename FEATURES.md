# Features: Fro Bot Agent

**Extracted from:** PRD.md
**Date:** 2026-01-02
**Version:** v1 MVP

---

## Table of Contents

- [Product Overview](#product-overview)
- [Feature Summary](#feature-summary)
- [Category A: GitHub Agent](#category-a-github-agent)
- [Category B: Discord Agent](#category-b-discord-agent)
- [Category C: Shared Memory & Persistence](#category-c-shared-memory--persistence)
- [Category D: Security & Access Control](#category-d-security--access-control)
- [Category E: Observability & Auditability](#category-e-observability--auditability)
- [Category F: Error Handling & Reliability](#category-f-error-handling--reliability)
- [Category G: Configuration & Deployment](#category-g-configuration--deployment)
- [Dependency Graph](#dependency-graph)

---

## Product Overview

Fro Bot Agent is a reusable **agent harness** that runs OpenCode with an Oh My OpenCode (oMo Sisyphus agent workflow to act as an autonomous collaborator on GitHub (Issues, Discussions, PRs) and Discord (long-running bot with Kimaki-like UX).

**Core Differentiator:** Durable memory across runs - OpenCode session/application state is restored at start and saved at end, enabling the agent to pick up work without repeating expensive investigation.

**Target Personas:**
- Repo Maintainer (Primary) - wants reliable "extra engineer"
- Contributor (Secondary) - wants fast PR/issue feedback
- Discord Moderator (Secondary) - wants agent grounded in specific repo
- Platform/Security Owner (Stakeholder) - requires audit trails & least-privilege

---

## Feature Summary

| Priority             | Count | Categories                                     |
| -------------------- | ----- | ---------------------------------------------- |
| **Must Have (P0)**   | 24    | Core functionality for MVP                     |
| **Should Have (P1)** | 6     | Important but not critical for initial release |
| **Could Have (P2)**  | 3     | Desirable, can be deferred                     |

| Category                     | Feature Count |
| ---------------------------- | ------------- |
| GitHub Agent                 | 11            |
| Discord Agent                | 5             |
| Shared Memory & Persistence  | 8             |
| Security & Access Control    | 5             |
| Observability & Auditability | 3             |
| Error Handling & Reliability | 4             |
| Configuration & Deployment   | 4             |

---

## Category A: GitHub Agent

### F1: GitHub Action Trigger Support

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** None

**Description:**
The product ships as a TypeScript GitHub Action (Node.js 24 runtime) supporting oMo/Sisyphus-style triggers.

**Acceptance Criteria:**
- [ ] Supports `workflow_dispatch` for manual invocation
- [ ] Supports `issue_comment` `created` as primary trigger for Issues and PRs
- [ ] Runtime detection distinguishes Issue vs PR context
- [ ] Supports `discussion` with `types: [created]` on comments trigger for Discussions (document gaps as known limitations)
- [ ] Action invocable via `uses: fro-bot/agent@v0`

**Technical Considerations:**
- Must detect fork PRs at runtime to apply security gates
- Event context parsing from `github.event.*` payloads

**Edge Cases:**
- Fork PR from untrusted contributor triggers `issue_comment` (not `pull_request_review_comment`)
- Discussion events may have different payload structure

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
- [ ] Comments include collapsed run summary (see F20)

**Edge Cases:**
- Very long issue threads (pagination handling)
- Locked issues (handle gracefully, report in summary)

---

### F3: Discussion Comment Interaction

**Priority:** Must Have (P0)
**Complexity:** Low
**Dependencies:** F1

**Description:**
Agent can participate in GitHub Discussions threads.

**Acceptance Criteria:**
- [ ] Agent reads discussion body and comment thread
- [ ] Agent posts in-thread discussion comments
- [ ] Agent can update existing agent comments
- [ ] Comments include collapsed run summary

**Technical Considerations:**
- Discussion API differs from Issues API; verify GraphQL vs REST requirements

---

### F4: PR Conversation Comments

**Priority:** Must Have (P0)
**Complexity:** Low
**Dependencies:** F1

**Description:**
Agent can post comments in PR conversation thread (not review comments).

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
**Dependencies:** F1, F17

**Description:**
When requested, the agent can push commits to branches.

**Acceptance Criteria:**
- [ ] Agent can create new branches
- [ ] Agent can commit changes to branches
- [ ] Agent can push to remote (non-protected branches)
- [ ] Uses elevated credentials (GitHub App token or PAT) only when needed
- [ ] Never pushes directly to protected branches without explicit PR

**Technical Considerations:**
- Requires `contents: write` permission
- Must configure git user identity for commits
- GitHub App token recommended for elevated operations

**Edge Cases:**
- Branch protection rules block push (handle gracefully, report in summary)
- Merge conflicts with target branch

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

**Technical Considerations:**
- Requires `pull-requests: write` permission
- PR template support desirable

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

### F10: Setup Action Entrypoint

**Priority:** Must Have (P0)
**Complexity:** High
**Dependencies:** F1, F17

**Description:**
Provide a dedicated `setup` action (`uses: fro-bot/agent/setup@v0`) that bootstraps the complete agent environment, mirroring oMo Sisyphus workflow functionality.

**Acceptance Criteria:**
- [ ] `uses: fro-bot/agent/setup` available as separate action
- [ ] Installs OpenCode CLI via `@actions/tool-cache` with cross-run caching
- [ ] Supports `opencode-version` input (default: `latest`)
- [ ] Automatically installs Bun runtime via `@actions/tool-cache` (required for oMo)
- [ ] Installs oMo plugin via `bunx oh-my-opencode install`
- [ ] Bun installation is automatic - users do NOT need `oven-sh/setup-bun`
- [ ] Configures `gh` CLI with `GH_TOKEN` environment variable
- [ ] Supports GitHub App token generation from `app-id` + `private-key` inputs
- [ ] Falls back to `GITHUB_TOKEN` when App credentials not provided
- [ ] Configures git identity for commits (`<app-slug>[bot]` format)
- [ ] Populates `auth.json` from secrets (mode 0600, never cached)
- [ ] Restores session cache early in setup phase
- [ ] Ensures required system utilities for Sisyphus-style execution and UX:
  - [ ] `tmux` available
  - [ ] `stdbuf` available
- [ ] Real-time log streaming is supported (best-effort): agent/OpenCode output should appear while it runs, not only at the end
- [ ] Outputs: `opencode-path`, `opencode-version`, `gh-authenticated`, `setup-duration`, `cache-status`

**Technical Considerations:**
- Requires `@actions/tool-cache` for binary caching
- Requires `@actions/exec` for running npx, gh, git commands
- `setup/action.yaml` must reference `dist/setup.js` entrypoint
- Build must produce both `dist/main.js` and `dist/setup.js`

**Edge Cases:**
- OpenCode download failure (retry with backoff)
- oMo installation failure (warn, don't fail)
- GitHub App token generation failure (fall back to GITHUB_TOKEN)

---

### F11: Session Search on Startup

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F13

**Description:**
On startup, the agent uses oMo session tools to find relevant prior work. The action harness also performs startup introspection using RFC-004 utilities to provide context.

**Two layers involved:**
1. **Action-side (RFC-004)**: `listSessions()` and `searchSessions()` utilities run at startup to gather session context for the agent prompt
2. **Agent-side (oMo)**: Agent uses `session_search` and `session_read` LLM tools during execution to query prior work

**Acceptance Criteria:**
- [ ] Action harness calls RFC-004 `listSessions()` to discover prior sessions
- [ ] Agent prompt includes session context from startup introspection
- [ ] Agent is instructed to call oMo `session_search` before re-investigating
- [ ] Search queries based on current context (issue title, error messages, file paths)
- [ ] Agent reads relevant prior sessions when found via `session_read`
- [ ] Evidence of session search appears in logs

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
**Dependencies:** F12, F13, F16, F18

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
- [ ] Save excludes `auth.json` (see F23)

---

### F19: S3 Write-Through Backup

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

### F20: Run Summary in Comments

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
- [ ] Summary formatted as collapsed `<details>` block

---

### F21: Close-the-Loop Session Writeback

**Priority:** Must Have (P0)
**Complexity:** Low
**Dependencies:** F11, F18

**Description:**
Before finishing, the action produces a durable summary discoverable by future sessions.

**Two layers involved:**
1. **Action-side (RFC-004)**: `writeSessionSummary()` utility appends run metadata to the session in OpenCode storage format
2. **Agent-side (oMo)**: Agent is instructed to leave a searchable summary message before completing

**Acceptance Criteria:**
- [ ] Action harness calls RFC-004 `writeSessionSummary()` at end of run
- [ ] Written summary is in valid OpenCode message format (discoverable by oMo tools)
- [ ] Agent is instructed to document key decisions/fixes before completing
- [ ] Summary searchable via `session_search` in future runs

---

### F22: Session Pruning

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F17, F18

**Description:**
Retention policy prevents unbounded storage growth. This is an **action-side** operation using RFC-004 utilities.

**Implementation:**
The GitHub Action harness calls RFC-004 `pruneSessions()` at the end of each run. This utility operates directly on OpenCode storage (JSON files at `~/.local/share/opencode/storage/`).

**Acceptance Criteria:**
- [ ] Action harness calls RFC-004 `pruneSessions()` at end of each run
- [ ] Default: keep last 50 sessions per repo OR sessions from last 30 days (whichever larger)
- [ ] Pruning also removes child sessions (those with `parentID`) of pruned parents
- [ ] Retention policy configurable via action input
- [ ] Pruned sessions logged in run summary
- [ ] Freed storage space reported in metrics

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

## Category D: Security & Access Control

### F25: auth.json Exclusion

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

### F26: Fork PR Permission Gating

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
- Matches oMo Sisyphus approach for secure fork handling

---

### F27: Credential Strategy

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

### F28: Branch-Scoped Caching

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

### F29: Concurrency Handling

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

## Category E: Observability & Auditability

### F30: GitHub Actions Job Summary

**Priority:** Must Have (P0)
**Complexity:** Low
**Dependencies:** F20

**Description:**
Provide structured summary in GitHub Actions job output.

**Acceptance Criteria:**
- [ ] Job summary includes all metadata from F20
- [ ] Job summary viewable in Actions UI
- [ ] Session IDs and run IDs included for traceability

---

### F31: Structured Logging

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

### F32: Token Usage Reporting

**Priority:** Must Have (P0)
**Complexity:** Low
**Dependencies:** F20

**Description:**
Report LLM token usage in run summary when available.

**Acceptance Criteria:**
- [ ] Token usage included in collapsed summary
- [ ] Tracks input/output tokens if provider supports
- [ ] Helps with cost monitoring and optimization

---

## Category F: Error Handling & Reliability

### F33: Error Message Format

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

### F34: GitHub API Rate Limit Handling

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

### F35: LLM API Error Handling

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

### F36: Discord API Error Handling

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

## Category G: Configuration & Deployment

### F37: Action Inputs Configuration

**Priority:** Must Have (P0)
**Complexity:** Low
**Dependencies:** F1

**Description:**
Configurable action inputs for customization.

**Acceptance Criteria:**
- [ ] OpenCode credentials (auth.json or JSON object) configurable
- [ ] Custom prompt configurable
- [ ] Session retention policy configurable
- [ ] S3 backup enable/disable configurable
- [ ] Elevated credential source configurable
- [ ] All inputs documented with defaults

---

### F38: Secrets/Vars Documentation

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

### F39: Discord Deployment Guide

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

### F40: Rollback Plan

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

## Dependency Graph

```
F1 (Triggers)
├── F2 (Issue Comments)
├── F3 (Discussion Comments)
├── F4 (PR Comments)
│   └── F5 (PR Review Comments)
├── F6 (Push Commits) ──────┐
│   └── F7 (Open PRs)       │
├── F8 (Idempotency)        │
├── F9 (Anti-Loop)          │
├── F43 (Reactions/Labels)  │
├── F44 (Issue/PR Detection)│
└── F11 (Session Search) ◄──┤
                            │
F17 (Cache Restore) ◄───────┤
├── F18 (Cache Save)        │
│   └── F19 (S3 Backup)     │
├── F22 (Pruning)           │
├── F23 (Versioning)        │
├── F24 (Corruption)        │
└── F28 (Branch Scope)      │
                            │
F12 (Channel Mapping) ──────┤
├── F13 (Thread Mapping)    │
├── F15 (Shared Memory) ◄───┘
└── F16 (Permissions)
F14 (Daemon) ───────────────┐
├── F15 (Shared Memory)     │
└── F36 (Discord Errors)    │
                            │
F25 (auth.json) ◄───────────┘
F26 (Fork PR Gating)
F27 (Credential Strategy)
```

---

## Next Steps

After FEATURES.md creation:

1. **Run `/prd/to-rules`** - Generate technical guidelines and coding standards
2. **Run `/prd/to-rfcs`** - Break down features into implementation RFCs with detailed specs

---

## Category H: Agent Prompt & Context

### F41: Agent Prompt Context Injection

**Priority:** Must Have (P0)
**Complexity:** Medium
**Dependencies:** F10, F11

**Description:**
The agent prompt must include sufficient context and instructions for GitHub operations, session management, and run summaries.

**Acceptance Criteria:**
- [ ] Prompt includes GitHub context: repo, branch/ref, event type, actor
- [ ] Prompt includes issue/PR context: number, title, triggering comment body
- [ ] Prompt instructs agent to use `session_search` before re-investigating
- [ ] Prompt instructs agent to use `session_read` when prior work is found
- [ ] Prompt instructs agent to leave searchable summary before completing
- [ ] Prompt provides `gh` CLI examples for all GitHub operations
- [ ] Prompt requires every comment include collapsed run summary

**Technical Considerations:**
- Prompt constructed in setup action or main action entry
- Context extracted from GitHub Actions environment and event payload
- Must be compatible with OpenCode/oMo prompt format

---

### F42: gh CLI Operation Instructions

**Priority:** Must Have (P0)
**Complexity:** Low
**Dependencies:** F10

**Description:**
Agent prompt must instruct use of pre-authenticated `gh` CLI for all GitHub operations.

**Acceptance Criteria:**
- [ ] Prompt includes examples for `gh issue comment`
- [ ] Prompt includes examples for `gh pr comment`
- [ ] Prompt includes examples for `gh pr create`
- [ ] Prompt includes examples for `gh api` calls
- [ ] Prompt includes git commit/push workflow
- [ ] Agent understands `GH_TOKEN` is already configured

---

### F43: Reactions & Labels Acknowledgment

**Priority:** Must Have (P0)
**Complexity:** Low
**Dependencies:** F1, F10

**Description:**
Agent provides visual feedback via reactions and labels to acknowledge work status, matching oMo Sisyphus behavior.

**Acceptance Criteria:**
- [ ] Agent adds 👀 (eyes) reaction to triggering comment on receipt
- [ ] Agent adds "agent: working" label to issue/PR when starting work
- [ ] Agent replaces 👀 with success reaction on completion (🎉 hooray - GitHub API doesn't support peace sign)
- [ ] Agent removes "agent: working" label on completion (success or failure)
- [ ] "agent: working" label is created automatically if it doesn't exist
- [ ] All reaction/label operations are non-fatal (warn on failure, don't fail run)

**Technical Considerations:**
- Reactions via `gh api` POST to `/repos/{repo}/issues/comments/{id}/reactions`
- Labels via `gh label create --force` and `gh issue/pr edit --add-label/--remove-label`
- Must detect bot's own reactions for cleanup (filter by bot login)

---

### F44: Issue vs PR Context Detection

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

**Technical Considerations:**
- Use `gh api /repos/{repo}/issues/{number}` and check `.pull_request` field
- Cache result to avoid repeated API calls

---

*This document is auto-generated from PRD.md and should be updated when the PRD changes.*
