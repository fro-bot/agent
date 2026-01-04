# Product Requirements Document (PRD): Fro Bot Agent Harness

## Overview

Fro Bot Agent is a reusable **agent harness** that runs OpenCode with an Oh My OpenCode (oMo) "Sisyphus-style" workflow to act as an autonomous collaborator on:

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
   - The product ships as a **TypeScript GitHub Action** (Node.js 24 runtime) with one or more entrypoints (e.g. `uses: fro-bot/agent`, `uses: fro-bot/agent/setup`), not as a reusable workflow.
   - v1 must support the oMo/Sisyphus-style **mention-driven** and **manual** flows:
     - `workflow_dispatch` for manual invocation.
     - `issue_comment` `created` as the primary trigger surface for Issues and PRs (including fork PRs), with runtime detection of Issue vs PR.
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

### P0-B: Setup Action & Environment Bootstrap

The agent requires a dedicated setup phase that mirrors the oMo Sisyphus workflow functionality.

#### D. Setup action (`uses: fro-bot/agent/setup@v0`)

1. **OpenCode CLI installation**
   - Install OpenCode binary via `@actions/tool-cache` for cross-run caching.
   - Support version pinning (`opencode-version` input) with `latest` as default.
   - Add OpenCode to PATH for subsequent steps.

2. **Oh My OpenCode (oMo) plugin installation**
   - Run `npx oh-my-opencode install` to add Sisyphus agent capabilities.
   - Graceful degradation: warn on failure, do not fail the run.

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

- [ ] GitHub Action runs on issue/PR/discussion events per oMo Sisyphus parity.
- [ ] Setup action installs OpenCode via `@actions/tool-cache` caching pattern.
- [ ] Setup action installs oMo plugins via `npx oh-my-opencode install`.
- [ ] Setup action configures `gh` CLI with GitHub App token or GITHUB_TOKEN.
- [ ] Agent adds 👀 reaction to triggering comment and "agent: working" label on start.
- [ ] Agent replaces 👀 with ✌🏽 (random skin tone) or ☮️ and removes label on completion.
- [ ] Cache restore/save works for `$XDG_DATA_HOME/opencode/storage/`.
- [ ] `auth.json` is never persisted.
- [ ] Agent uses `session_search` on startup (evidence in logs).
- [ ] Agent prompt includes full GitHub context (repo, event, issue/PR details).
- [ ] Agent prompt instructs use of `gh` CLI for all GitHub operations.
- [ ] Every comment includes collapsed run summary.
- [ ] Fork PRs handled securely via `issue_comment` with permission gating.
- [ ] Session pruning runs at end of each run.
- [ ] S3 write-through option is functional.
- [ ] Discord bot connects and routes messages to OpenCode.
- [ ] Discord and GitHub share storage via S3.

---

## Timeline (high-level)

| Phase                         | Deliverables                                                  | Estimated Duration |
| ----------------------------- | ------------------------------------------------------------- | ------------------ |
| 1. MVP GitHub memory plumbing | Cache restore/save, auth.json exclusion, run summary format   | 2 weeks            |
| 2. GitHub interaction parity  | Issue/PR/Discussion triggers, review comments, delegated work | 3 weeks            |
| 3. Discord daemon MVP         | Channel=repo, thread=session, reverse proxy, S3 sync          | 3 weeks            |
| 4. Hardening                  | Concurrency handling, pruning, error handling, docs           | 2 weeks            |

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

---

## Appendix: Technical Notes

### Runtime Decision

The project uses **Node.js 24** as the GitHub Actions runtime. This aligns with:

- Current `action.yaml` (`runs.using: node24`)
- Existing `package.json` and `tsdown` bundler setup
- Broader ecosystem compatibility

**Note:** The oMo Sisyphus reference implementation uses **Bun** in its reusable workflow. This project intentionally targets Node.js for maximum compatibility with the GitHub Actions toolkit and the existing TypeScript action ecosystem.

### Multiple Entrypoints

To support `uses: fro-bot/agent/setup`, the project will need:

- A `setup/action.yaml` in the repo root, or
- A composite action pattern with multiple `action.yaml` files.

### Storage Format Versioning

Include a `.version` file in `$XDG_DATA_HOME/opencode/storage/`:

```txt
1
```

Increment on breaking changes. Agent checks on restore and warns if mismatch.
