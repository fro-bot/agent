# Product Requirements Document (PRD): Fro Bot Agent Harness

**Version:** 1.4
**Last Updated:** 2026-01-17

### Version History

| Version | Date | Changes |
| --- | --- | --- |
| 1.4 | 2026-01-17 | Major restructure: single PRD with shared semantics, modality RFCs split, SDK API corrections, cache constraints, telemetry policy, source of truth hierarchy |
| 1.3 | 2026-01-17 | Agent-invokable delegated work tools via OpenCode plugin distribution (RFC-018), exposes RFC-010 library functions as MCP tools |
| 1.2 | 2026-01-14 | Additional GitHub triggers (`issues`, `pull_request`, `pull_request_review_comment`, `schedule`), trigger-specific prompt directives, post-action cache hook, prompt input required for scheduled/manual triggers |
| 1.1 | 2026-01-10 | SDK execution model (replaces CLI), GraphQL context hydration, file attachments, model/agent config, mock event support, enhanced prompt construction |
| 1.0 | 2026-01-02 | Initial PRD |

---

## Source of Truth & Conflict Resolution

**Documentation Hierarchy** (highest to lowest priority):

1. **PRD** (this document) — Product goals, shared semantics, cross-modality requirements
2. **RFCs** — Modality-specific implementation details and technical specifications
3. **FEATURES.md** — Feature tracking and acceptance criteria
4. **RULES.md** — Development conventions and code standards

**Conflict Resolution:**

- If PRD conflicts with downstream docs, PRD takes precedence.
- To change PRD requirements, open an RFC change request with justification.
- RFCs may add detail or constraints not specified in PRD but must not contradict PRD.
- Implementation details belong in RFCs, not PRD.

---

## Overview

Fro Bot Agent is a **multi-modality agent harness** that runs OpenCode with Oh My OpenCode (oMo) capabilities to act as an autonomous collaborator across multiple platforms:

- **GitHub Action** (MVP): Issues, Discussions, and Pull Requests via GitHub Actions triggers
- **Discord Bot** (MVP): Long-running daemon with channel=repo, thread=session UX
- **Future Modalities**: CLI, Slack, web interface, etc.

The core differentiator is **durable memory across runs**: OpenCode session state persists between interactions, enabling the agent to recall prior investigations and avoid redundant work.

### Modality Status

| Modality          | Status                 | Deliverable | RFCs                                                     |
| ----------------- | ---------------------- | ----------- | -------------------------------------------------------- |
| GitHub Action     | **Active Development** | MVP (0.x)   | RFC-001 through RFC-018 (GitHub Action implementation)   |
| Discord Bot       | **Planned**            | MVP (0.x)   | TBD (Discord-specific RFCs)                              |
| Shared Storage/S3 | **Active Development** | MVP (0.x)   | RFC-002 (Cache), future storage RFC for S3 write-through |

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
2. **Action-side utilities (RFC-004)**: Infrastructure-level session management (`listSessions`, `searchSessions`, `pruneSessions`, `writeSessionSummary`).
3. **Agent-side tools (oMo)**: Runtime session discovery and reuse (`session_list`, `session_read`, `session_search`, `session_info`).
4. Producing auditable "run summaries" in platform-native formats.

---

## Goals and Objectives

### Product Goals

1. **Multi-modality agent platform**: Support multiple interaction surfaces (GitHub, Discord, future) with shared memory.
2. **Durable memory**: For a given project, all modalities share the same OpenCode storage.
3. **Operationally safe persistence**: Persist only OpenCode storage; never persist credentials.
4. **Close-the-loop behavior**: Each run leaves behind a durable, searchable record.
5. **Privacy-first telemetry**: Opt-in only; no external aggregation by default.

### Measurable Objectives

| Objective | Target | Measurement | Instrumentation |
| --- | --- | --- | --- |
| Memory reuse rate | ≥60% of runs reference prior sessions | Count runs with `session_search`/`session_read` tool calls | Derived from run summary logs |
| Repeat work reduction | ≥40% fewer redundant investigations | Compare exploration tool calls on recurring issues | JSON logs with tool call counts |
| Time to first actionable output | ≤90s median on cache-hit runs | Measure time from job start to first comment | Run summary duration field |
| Safety | 0 credential leakage incidents | Audit logs/comments/caches quarterly | Manual review + automated scan |

**Telemetry Policy:**

- All metrics derived from run summaries and structured JSON logs.
- No external telemetry aggregation unless user explicitly opts in.
- No raw content (code, comments, prompts) logged to external systems.
- Metrics stored locally in run artifacts and GitHub Actions logs.

---

## Scope

### Shared Capabilities (All Modalities)

These requirements apply to **all modalities** (GitHub, Discord, future):

#### Session Management

- Persist OpenCode storage (`$XDG_DATA_HOME/opencode/storage/`)
- Restore at run start; save at run end
- Session search before re-investigating
- Session pruning (default: 50 sessions or 30 days)
- Close-the-loop writeback with run metadata

#### Security & Privacy

- Never persist `auth.json` (rehydrated each run from secrets)
- Permission gating (OWNER/MEMBER/COLLABORATOR only for write operations)
- Anti-loop protection (ignore bot's own messages)
- Audit trails with session IDs and run IDs
- Least-privilege credentials

#### Prompt Semantics

- Multi-section prompt structure (mode, identity, context, request, instructions)
- Session tool instructions (use `session_search`, `session_read`, leave summary)
- Trigger-specific directives with override behavior:
  - **Append**: Comment-based triggers (custom prompt appends to default directive)
  - **Replace**: Scheduled/manual triggers (custom prompt replaces directive, required)

#### Agent & Model Configuration

- Agent selection with server-side validation
- Model override (optional; format: `provider/model`)
- Default: use agent's configured model if no override
- Auditability: include agent/model in run summaries

#### Telemetry & Observability

- Structured JSON logs for machine parsing
- Run summaries with metadata (event type, cache status, session IDs, duration, token usage)
- Opt-in external aggregation only
- No raw content in telemetry

### Modality-Specific Scope

Detailed requirements for each modality are documented in dedicated RFCs.

#### GitHub Action (MVP) — See RFCs 001-018

**Core Features:**

- Triggers: `issue_comment`, `discussion_comment`, `issues`, `pull_request`, `pull_request_review_comment`, `workflow_dispatch`, `schedule`
- Surfaces: Issue comments, discussion comments, PR conversation comments, PR review comments
- Delegated work: branch creation, commits, PR creation (via OpenCode plugin tools)
- Cache: GitHub Actions cache with S3 write-through (optional for MVP)
- Runtime: Node.js 24, TypeScript, ESM

**Key RFCs:**

- RFC-001 through RFC-003: Foundation, cache, GitHub client
- RFC-004: Session management
- RFC-005, RFC-016: Triggers and event handling
- RFC-006: Security and permission gating
- RFC-007: Observability and run summaries
- RFC-008, RFC-009: Comments and PR reviews
- RFC-010, RFC-018: Delegated work (library + agent-invokable tools)
- RFC-011: Setup action and environment bootstrap
- RFC-013: SDK execution mode
- RFC-014, RFC-015: File attachments and GraphQL context
- RFC-017: Post-action cache hook

**GitHub Actions Cache Constraints** (documented in RFC-002):

- 10GB total per repository
- 7-day eviction for unused keys
- 512-character key length limit
- Branch-scoped keys with fallback restore keys

#### Discord Bot (MVP) — TBD RFCs

**Planned Features:**

- Mapping: channel=repo, thread=session
- Architecture: Long-running daemon with reverse proxy boundary
- Deployment: Docker container or systemd service
- Storage: S3 sync (required; no GitHub Actions cache available)
- Permissions: Discord role-based channel→repo linking

**Implementation:**

- Dedicated Discord RFCs to be created
- Reverse proxy handles message routing and authentication
- OpenCode execution in isolated process/container

#### Shared Storage (MVP) — RFC-002 + Future S3 RFC

**Current (RFC-002):**

- GitHub Actions cache infrastructure
- Cache key strategy and restore keys
- Corruption detection

**Planned (Future RFC):**

- S3 write-through backup/restore
- Scope: per agent identity + repo
- Versioning: `.version` file for migration detection
- Retention policy enforcement

**S3 Classification:**

- **Optional** for GitHub Action (cache is primary, S3 is backup)
- **Required** for Discord Bot (no GitHub Actions cache available)

### Not in Scope (MVP Non-Goals)

- Training custom models
- Guaranteed perfect long-term memory without curation
- Persisting secrets
- Multi-tenant Discord without isolation controls

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

### Cross-Modality

1. **Memory continuity**
   - As a maintainer, when I interact with Fro Bot on GitHub and Discord, it recalls prior context from both surfaces.

2. **Avoid repeated work**
   - As a maintainer, Fro Bot should recall prior investigations and not repeat the same exploration every run, regardless of interaction surface.

### GitHub-Specific

3. **Issue triage**
   - As a maintainer, when an issue is opened, Fro Bot can summarize, reproduce (if possible), search prior sessions, and propose next steps.

4. **PR review + fix delegation**
   - As a maintainer, I can ask Fro Bot to review a PR, suggest changes, and optionally push a fix branch and open a PR.

### Discord-Specific

5. **Live collaboration**
   - As a moderator, I can chat with Fro Bot in a project channel, and it uses (and enriches) the same memory as GitHub.

6. **Session continuity**
   - As a user, I can resume a prior session thread and Fro Bot continues with context.

---

## Shared Functional Requirements

These requirements apply to **all modalities**.

### A. Session Management & Memory

#### Two-Layer Session Architecture

| Layer | Tools/Functions | Used By | When |
| --- | --- | --- | --- |
| **Action-side (RFC-004)** | `listSessions()`, `searchSessions()`, `pruneSessions()`, `writeSessionSummary()` | Platform harness (GitHub Action, Discord bot) | Before/after agent execution |
| **Agent-side (oMo)** | `session_list`, `session_read`, `session_search`, `session_info` | AI agent via LLM tool calls | During agent execution |

Both layers operate on the same OpenCode storage directory.

#### Storage Persistence

1. **What to persist**
   - Persist entire OpenCode storage subtree: `$XDG_DATA_HOME/opencode/storage/`
   - Storage format versioning via `.version` file

2. **What to exclude**
   - Never persist: `$XDG_DATA_HOME/opencode/auth.json`
   - Credentials rehydrated each run from secrets

3. **Startup behavior**
   - Platform harness: calls `listSessions()` and optionally `searchSessions()` to gather context
   - Agent: uses `session_search` before re-investigating

4. **Close-the-loop writeback**
   - Platform harness: calls `writeSessionSummary()` to append run metadata
   - Agent: produces durable summary message

5. **Session pruning**
   - Platform harness only: calls `pruneSessions()` at end of each run
   - Default: keep last 50 sessions per repo, or sessions from last 30 days (whichever is larger)
   - Configurable via platform-specific inputs

### B. Security & Privacy

#### Permission Gating

- Only users with OWNER, MEMBER, or COLLABORATOR association may trigger write operations
- Bots (including self) are ignored to prevent loops
- Fork PRs: use appropriate secure triggers (e.g., `issue_comment` for GitHub)

#### Credential Handling

- Never persist credentials to cache or storage
- Credentials from secrets/environment only
- Log redaction for sensitive fields

#### Cache Security

- Branch-scoped keys to reduce poisoning risk
- S3 prefix isolation by agent identity + repo
- Never cache secrets or attachments

### C. Agent & Model Configuration

#### Agent Selection

- Default agent: configurable per modality (e.g., "Sisyphus" for GitHub Action)
- Agent validation: **server-side** (SDK validates; client passes agent name)
- Fallback: if agent invalid or unavailable, use default with warning

#### Model Override

- **Optional** model override input (format: `provider/model`)
- If not provided: use agent's configured model
- SDK execution: pass agent (always) and model (when override specified)

Example SDK call:

```typescript
{
  agent: agentName,  // Always provided
  ...(model != null && {
    providerID: model.providerID,
    modelID: model.modelID,
  }),
  parts: [...]
}
```

#### Auditability

- Include agent and model (if overridden) in run summaries
- Log agent/model selection at start of execution

### D. Prompt Construction & Semantics

#### Prompt Structure

All prompts follow this structure:

```
[mode-instructions]     # Platform-specific mode (e.g., analyze-mode, ultrawork-mode)
[identity]              # Bot identity, invoked by whom, in which context
[context]               # Type, number, title, repo/channel, metadata
[user-request]          # The triggering message/comment body
[mandatory-reading]     # Instructions to gather full context
[hydrated-data]         # Platform-specific context (issues, PRs, messages)
[action-instructions]   # Create todos, investigate, report results
```

#### Session Tool Instructions (Required)

All prompts MUST include:

- Use `session_search` before re-investigating
- Use `session_read` when prior work is found
- Leave searchable summary before completing

#### Trigger-Specific Directives

Each trigger type has a default directive:

- Comment-based: "Respond to the comment above"
- Triage: "Triage this issue: summarize, reproduce if possible, propose next steps"
- Review: "Review this pull request for code quality, potential bugs, and improvements"
- Scheduled/manual: No default (custom prompt required)

**Prompt Override Behavior:**

- **Append** for comment-based triggers (custom prompt appends to default)
- **Replace** for scheduled/manual triggers (custom prompt replaces directive; required)

### E. OpenCode SDK Execution

All modalities use `@opencode-ai/sdk` for OpenCode interaction.

#### SDK Lifecycle

1. **Server creation**
   - Use `createOpencode()` for automatic server + client creation
   - Server managed via AbortController
   - No manual port management

2. **Session lifecycle**
   - Create session: `client.session.create({ body: { title } })`
   - Send prompt: `client.session.prompt({ path: { id }, body: { agent, parts, ... } })`
   - Track session ID throughout execution

3. **Event subscription**
   - Subscribe: `client.event.subscribe()` returns async stream
   - Track state: `mainSessionIdle`, `mainSessionError`
   - Process tool calls, text updates, session events

4. **Completion detection**
   - Poll for idle state
   - Check completion conditions
   - Handle session errors with proper exit codes

5. **Cleanup**
   - `server.close()` on completion, error, or signal
   - Proper exit codes (0=success, 1=error, 130=interrupted)

**Note:** SDK method is `client.session.prompt()`, not `promptAsync()` or `chat()`. See RFC-013 for implementation details.

### F. Telemetry & Observability

#### Run Summaries

Every interaction MUST produce a run summary containing:

- Run metadata (trigger type, repo/channel, ref/branch, run ID)
- Cache status (hit/miss/corrupted)
- Session IDs used/created
- Links to created artifacts (PRs, commits, threads)
- Duration and token usage (when available from provider)

Run summary format is platform-specific (see RFC-007).

#### Structured Logging

- Emit JSON logs for machine parsing
- Include session IDs and run IDs for traceability
- Log redaction for sensitive fields

#### Telemetry Policy

- **Opt-in only**: No external telemetry aggregation by default
- **Local-first**: Metrics derived from run summaries and JSON logs
- **No raw content**: Never log code, comments, or prompts to external systems
- **Transparent**: User controls what data leaves the system

### G. Error Handling & Reliability

#### Graceful Degradation

Agent MUST degrade gracefully when external systems are unavailable:

- **GitHub/Discord API rate limit**: Exponential backoff (max 3 retries, 30s/60s/120s), then post partial results
- **LLM API timeout/error**: Retry once after 10s, then post error message
- **Cache miss/corruption**: Proceed with clean state, log warning

#### Non-Fatal Operations

Reaction/label/acknowledgment operations are **best-effort**:

- Log failures but do not fail the run
- Use try/catch with error logging (not shell-specific `|| true`)

#### Error Message Format

When errors occur, messages MUST include:

- Human-readable summary of what failed
- Error type (rate limit, timeout, corruption)
- Suggested next steps or retry guidance

---

## Modality-Specific Requirements

Detailed requirements for each modality are documented in dedicated RFCs. This PRD provides only high-level summaries.

### GitHub Action (MVP) — See RFCs 001-018

**Implementation RFCs:**

- **RFC-001**: Foundation & Core Types
- **RFC-002**: Cache Infrastructure
- **RFC-003**: GitHub API Client Layer
- **RFC-004**: Session Management Integration
- **RFC-005**: GitHub Triggers & Event Handling
- **RFC-006**: Security & Permission Gating
- **RFC-007**: Observability & Run Summary
- **RFC-008**: GitHub Comment Interactions
- **RFC-009**: PR Review Features
- **RFC-010**: Delegated Work (Push/PR)
- **RFC-011**: Setup Action & Environment Bootstrap
- **RFC-012**: Agent Execution & Main Action (superseded by RFC-013)
- **RFC-013**: SDK Execution Mode
- **RFC-014**: File Attachment Processing
- **RFC-015**: GraphQL Context Hydration
- **RFC-016**: Additional Triggers & Directives
- **RFC-017**: Post-Action Cache Hook
- **RFC-018**: Agent-Invokable Delegated Work Tools

**Runtime:**

- Node.js 24, TypeScript, ESM
- Bundled output: `dist/main.js`, `dist/post.js`, `dist/plugin/fro-bot-agent.js`

### Discord Bot (MVP) — TBD RFCs

**Planned Architecture:**

- Long-running daemon with reverse proxy boundary
- Recommended deployment: Docker container or systemd service
- S3 sync required (no GitHub Actions cache)
- Discord role-based permissions

**Implementation:**

- Dedicated Discord RFCs to be created for MVP
- Will share core session management (RFC-004) and SDK execution (RFC-013)

### Shared Storage (MVP) — RFC-002 + Future S3 RFC

**Current Implementation (RFC-002):**

- GitHub Actions cache infrastructure
- Branch-scoped keys with fallback restore keys
- Corruption detection and recovery

**Future S3 Implementation (TBD RFC):**

- S3 write-through for durability
- Required for Discord Bot
- Optional for GitHub Action (backup layer)
- Scope: per agent identity + repo
- Storage versioning via `.version` file

---

## Non-Functional Requirements

### Security & Privacy

- Never persist `auth.json`; rehydrated each run from secrets
- Avoid printing credentials or including in comments
- Cache threat model: branch-scoped keys, S3 prefix isolation
- Fork PRs: secure triggers with permission gating
- Telemetry: opt-in only, no raw content

### Reliability

- Cache missing must not fail the run
- Cache corruption: detect, warn, proceed with clean state
- Graceful degradation for API rate limits and timeouts
- Best-effort operations: log failures, do not fail run

### Performance

- Restore cache early in execution
- Minimize repeated exploration via session search
- Target: cache restore < 30s for typical storage sizes (< 500MB)

### Observability

- GitHub comment summaries with collapsed details blocks
- Platform-native job summaries and logs
- Session IDs and run IDs for traceability
- Structured JSON logs for machine parsing

### Cost Controls

- Avoid unnecessary LLM/tool calls via session reuse
- Emit token usage in run summaries (when available)
- Session pruning to manage storage growth

---

## Data / Storage Requirements

### Persisted Data

Persist exactly:

- `$XDG_DATA_HOME/opencode/storage/` (typically `~/.local/share/opencode/storage/`)

### Excluded Data

Never persist:

- `$XDG_DATA_HOME/opencode/auth.json`
- Credentials, secrets, API keys
- File attachments

### Storage Mechanics

Platform-specific storage mechanisms documented in RFCs:

- **GitHub Action**: GitHub Actions cache (RFC-002) + optional S3 write-through (future RFC)
- **Discord Bot**: S3 sync (required, future RFC)

### Cache Key Strategy (GitHub Action)

Default: branch-scoped with agent identity and repo.

Key pattern:

```
opencode-storage-${agent_identity}-${repo}-${ref_name}-${runner_os}
```

Restore-keys (fallback):

```
opencode-storage-${agent_identity}-${repo}-${ref_name}-
opencode-storage-${agent_identity}-${repo}-
```

`agent_identity`: `github` or `discord` (prevents cross-contamination)

### Retention / Eviction

- GitHub Actions cache: 7-day eviction for unused keys (GitHub default)
- S3 write-through: provides durability layer beyond cache eviction
- Session pruning: default 50 sessions or 30 days (configurable)

---

## Success Metrics

| Metric | Target | How to Measure |
| --- | --- | --- |
| Memory reuse rate | ≥60% | % runs with `session_search`/`session_read` calls (from logs) |
| Repeat work reduction | ≥40% | Compare exploration calls on recurring issues (from logs) |
| Time to first actionable output | ≤90s (cache hit) | Job start → first comment timestamp (from run summary) |
| User satisfaction | Positive qualitative feedback | Maintainer surveys/interviews |
| Safety | 0 incidents | Quarterly audit of logs/comments/caches |

---

## Acceptance Criteria (MVP)

The MVP is considered complete when:

### Shared Capabilities

- [ ] Session management with two-layer architecture (action-side + agent-side)
- [ ] OpenCode storage persistence and restoration
- [ ] `auth.json` never persisted
- [ ] Session search on startup (evidence in logs)
- [ ] Session pruning at end of run
- [ ] Close-the-loop writeback with run metadata
- [ ] Permission gating (OWNER/MEMBER/COLLABORATOR)
- [ ] Anti-loop protection (ignore bot's own messages)
- [ ] SDK-based execution with `createOpencode()` + `client.session.prompt()`
- [ ] Agent selection with server-side validation
- [ ] Optional model override (format: `provider/model`)
- [ ] Run summaries with metadata (cache status, session IDs, duration, token usage when available)
- [ ] Structured JSON logs
- [ ] Graceful degradation on API failures
- [ ] Best-effort non-fatal operations (logged failures)

### GitHub Action (MVP) — See RFCs 001-018 for Full Criteria

- [ ] All triggers supported (`issue_comment`, `discussion_comment`, `issues`, `pull_request`, `pull_request_review_comment`, `workflow_dispatch`, `schedule`)
- [ ] GraphQL context hydration
- [ ] File attachment processing
- [ ] Delegated work tools via OpenCode plugin
- [ ] GitHub Actions cache + optional S3 write-through
- [ ] Post-action cache hook

### Discord Bot (MVP) — See Future Discord RFCs for Full Criteria

- [ ] Channel=repo, thread=session mapping
- [ ] Long-running daemon with reverse proxy
- [ ] S3 sync (required)
- [ ] Discord role-based permissions

### Shared Storage (MVP) — See RFC-002 + Future S3 RFC for Full Criteria

- [ ] GitHub Actions cache functional
- [ ] S3 write-through functional
- [ ] Storage versioning with `.version` file
- [ ] Corruption detection and recovery

---

## Timeline (High-Level)

| Phase                      | Deliverables                                        | Estimated Duration |
| -------------------------- | --------------------------------------------------- | ------------------ |
| 1. GitHub Action MVP       | Core triggers, SDK execution, cache, shared storage | 4 weeks            |
| 2. GitHub Action Hardening | Delegated work, error handling, observability       | 3 weeks            |
| 3. Discord Bot MVP         | Daemon, S3 sync, basic commands                     | 3 weeks            |
| 4. Discord Bot Hardening   | Permissions, threading, stability                   | 2 weeks            |
| 5. Integration Testing     | Cross-modality memory continuity, security audit    | 2 weeks            |

---

## Open Questions / Risks / Dependencies

1. **Cache poisoning & trust boundaries**
   - Risk: S3 introduces IAM complexity and new attack vectors
   - Mitigation: S3 prefix isolation, IAM least-privilege policies, bucket versioning (see future S3 RFC)

2. **Session storage growth**
   - Risk: Unbounded growth causes cache eviction and restore latency
   - Mitigation: Session pruning (50 sessions/30 days default), storage size warnings

3. **@opencode-ai/sdk stability**
   - Risk: External dependency with unknown API stability
   - Mitigation: Pin SDK version, integration tests, monitor releases

4. **GraphQL rate limits**
   - Risk: Large PRs could hit rate limits
   - Mitigation: Pagination limits (50 comments, 100 files), REST API fallback (see RFC-015)

5. **File attachment security**
   - Risk: Malicious attachments
   - Mitigation: URL allowlist, size limits, MIME validation, no cache persistence (see RFC-014)

6. **Noisy automated triggers**
   - Risk: `issues` and `pull_request` events could trigger expensive runs
   - Mitigation: Constrained actions, @mention requirement, skip conditions (see RFC-016)

7. **Post-action hook reliability**
   - Risk: May still miss in extreme edge cases (runner crash)
   - Mitigation: Best-effort addition to `finally` cleanup, S3 provides durability layer (see RFC-017)

8. **Discord daemon uptime**
   - Risk: Long-running process requires monitoring and restart policies
   - Mitigation: Docker health checks, systemd restart policies, heartbeat monitoring (see future Discord RFCs)

---

## Appendix: Technical Notes

### SDK Execution Model

The project uses **SDK-based execution** via `@opencode-ai/sdk` as the primary execution model (see RFC-013).

**Key SDK Methods:**

- `createOpencode()` — Automatic server + client creation
- `client.session.create()` — Create session
- `client.session.prompt()` — Send prompt (not `promptAsync` or `chat`)
- `client.event.subscribe()` — Event stream subscription
- `server.close()` — Cleanup

**Rationale:**

- Structured file attachments as typed parts
- Session event streaming for real-time progress
- Server-side agent validation
- Aligns with OpenCode ecosystem patterns

### Runtime & Dependencies

**GitHub Action Runtime:**

- Node.js 24 (matches `action.yaml`)
- TypeScript, ESM-only
- Bundled output via `tsdown`

**Discord Bot Runtime:**

- TBD in future Discord RFCs

**New Dependencies:**

- `@opencode-ai/sdk` — Pinned version
- GraphQL via Octokit built-in

### Storage Format Versioning

Include `.version` file in `$XDG_DATA_HOME/opencode/storage/`:

```txt
1
```

Increment on breaking changes. Harness checks on restore and warns if mismatch.

---

## RFC References

Modality-specific implementation details are documented in dedicated RFCs:

### GitHub Action (RFCs 001-018)

- **RFC-001**: Foundation & Core Types
- **RFC-002**: Cache Infrastructure
- **RFC-003**: GitHub API Client Layer
- **RFC-004**: Session Management Integration
- **RFC-005**: GitHub Triggers & Event Handling
- **RFC-006**: Security & Permission Gating
- **RFC-007**: Observability & Run Summary
- **RFC-008**: GitHub Comment Interactions
- **RFC-009**: PR Review Features
- **RFC-010**: Delegated Work (Push/PR)
- **RFC-011**: Setup Action & Environment Bootstrap
- **RFC-012**: Agent Execution & Main Action (superseded by RFC-013)
- **RFC-013**: SDK Execution Mode
- **RFC-014**: File Attachment Processing
- **RFC-015**: GraphQL Context Hydration
- **RFC-016**: Additional Triggers & Directives
- **RFC-017**: Post-Action Cache Hook
- **RFC-018**: Agent-Invokable Delegated Work Tools

### Discord Bot (Future RFCs)

- TBD: Discord daemon architecture, permissions, threading, S3 sync

### Shared Storage (Current + Future)

- **RFC-002**: GitHub Actions cache infrastructure
- **Future RFC**: S3 write-through backup/restore

---

_This PRD defines product-wide goals and shared semantics. Modality-specific implementation details are in RFCs. For conflicts, see "Source of Truth & Conflict Resolution" section._
