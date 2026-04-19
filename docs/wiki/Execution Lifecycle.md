---
type: architecture
last-updated: "2026-04-19"
updated-by: "92324bf"
sources:
  - src/harness/run.ts
  - src/harness/phases/bootstrap.ts
  - src/harness/phases/routing.ts
  - src/harness/phases/acknowledge.ts
  - src/harness/phases/cache-restore.ts
  - src/harness/phases/session-prep.ts
  - src/harness/phases/execute.ts
  - src/harness/phases/finalize.ts
  - src/harness/phases/cleanup.ts
  - src/harness/phases/dedup.ts
  - src/harness/post.ts
  - src/features/triggers/router.ts
  - src/features/agent/output-mode.ts
  - src/services/github/context.ts
  - RFCs/RFC-005-GitHub-Triggers-Events.md
  - RFCs/RFC-012-Agent-Execution-Main-Action.md
  - RFCs/RFC-017-Post-Action-Cache-Hook.md
  - RFCs/RFC-019-S3-Storage-Backend.md
summary: "Phase-by-phase walkthrough of a single action run from trigger to cache save"
---

# Execution Lifecycle

Every Fro Bot run follows the same phase sequence, orchestrated by `src/harness/run.ts`. This page builds on the [[Architecture Overview]] — specifically the harness layer — and walks through each phase in execution order. Each phase is a standalone module under `src/harness/phases/`, a deliberate design that keeps the orchestrator thin and each phase independently testable.

## Phase Sequence

```text
main.ts
  └─ run()
       ├─ 1. Bootstrap
       ├─ 2. Routing
       ├─ 3. Deduplication
       ├─ 4. Acknowledge
       ├─ 5. Cache Restore
       ├─ 6. Session Prep
       ├─ 7. Execute
       ├─ 8. Finalize
       └─ 9. Cleanup (always, via finally)

post.ts
  └─ runPost()
       └─ Durable Cache Save
```

## 1. Bootstrap

Parses action inputs (`parseActionInputs`), validates credentials, and ensures OpenCode and its dependencies are available. If the tools aren't already cached, the setup module installs Bun, oMo, and the OpenCode CLI (see [[Setup and Configuration]]). On failure, the run exits immediately with code 1.

## 2. Routing

This is where the incoming GitHub webhook event gets classified and the run decides what to do.

First, `parseGitHubContext()` reads the raw Actions context and calls `normalizeEvent()` to produce a `NormalizedEvent` — a discriminated union with eight variants (one per supported event type plus `unsupported`). This normalization layer is the project's central abstraction: no downstream code ever touches raw webhook payloads.

Then `routeEvent()` applies skip conditions to decide whether to proceed. Skip conditions include: action not supported (e.g., a `labeled` event), draft PR, locked issue, bot responding to itself, unauthorized author (not `OWNER`, `MEMBER`, or `COLLABORATOR`), missing prompt for schedule/dispatch events, and PR review not requested from the bot. If any condition matches, the run exits cleanly with code 0 and a skip reason.

## 3. Deduplication

A lightweight guard against duplicate runs for the same entity within a configurable window (default: 10 minutes). Uses cache-based sentinel markers — not an in-flight lock. This is best-effort suppression; workflow-level concurrency groups provide the stronger guarantee.

## 4. Acknowledge

Posts visual feedback so the user knows the agent received their request. For comment-triggered events, this means adding an `eyes` (👀) reaction to the triggering comment and applying an `agent: working` label to the issue or PR. These are non-fatal — if the GitHub API call fails, execution continues.

## 5. Cache Restore

Restores the OpenCode storage directory from GitHub Actions cache (or S3 backup if configured). The cache key is scoped by repository, branch, and OS to prevent cross-branch contamination. After restore, the module checks for corruption (unreadable directory, version mismatch) and falls back to clean state if needed. Credentials (`auth.json`) that may have leaked into cache from a prior run are deleted as a security measure.

This phase also bootstraps the OpenCode SDK server and establishes a client connection — the server handle is reused throughout the remaining phases.

## 6. Session Prep

Processes any file attachments from the triggering context, searches prior sessions for relevant context (see [[Session Persistence]]), and builds the agent prompt (see [[Prompt Architecture]]). The prompt is a multi-section XML-tagged document that includes environment metadata, issue/PR context, session history, the task directive, and response protocol rules.

## 7. Execute

The core phase. Calls `executeOpenCode()` which creates (or continues) an SDK session, sends the assembled prompt, and streams events back in real time. The SDK lifecycle follows the pattern: spawn server, connect client, create session, send prompt, process event stream, close.

If the LLM returns a fetch error (transient provider failure), the system retries up to three times with a continuation prompt. A configurable timeout (default: 30 minutes) aborts execution if the agent runs too long.

## 8. Finalize

Writes a synthetic summary message into the session history so future runs can discover what this run accomplished. Prunes old sessions based on dual-condition retention (age OR count). Posts the run summary to GitHub. Collects metrics and sets action outputs (session ID, cache status, duration).

## 9. Cleanup (Always)

Runs in a `finally` block regardless of success or failure. Completes the acknowledgment state machine (replaces 👀 with 🎉 on success or 😕 on failure, removes the `agent: working` label). Cleans up file attachments. Prunes old sessions. Shuts down the OpenCode server — importantly, this triggers a SQLite WAL checkpoint that merges in-flight session data into the main database file before cache save. If the S3 object store is enabled, uploads run artifacts and metadata to the store (see [[Session Persistence]]). Finally, saves the cache and optionally uploads a prompt log artifact for observability.

## Post-Action Hook

`post.ts` runs after the main step completes — even if the main step was cancelled or failed. It exists because GitHub Actions may kill the main step's `finally` block after a brief grace period, which could interrupt the cache save. The post-action hook provides a second, durable opportunity to persist state. It reads flags from action state to determine whether the main step already saved successfully, avoiding redundant work.

## Event Types

The router supports seven event types, each with specific skip conditions and prompt directives:

| Event                         | Common Trigger                         | Agent Behavior                      |
| ----------------------------- | -------------------------------------- | ----------------------------------- |
| `issue_comment`               | `@fro-bot` mention in a comment        | Respond to the comment              |
| `discussion_comment`          | `@fro-bot` mention in a discussion     | Respond to the discussion           |
| `issues`                      | Issue opened or edited with mention    | Triage (opened) or respond (edited) |
| `pull_request`                | PR opened, synced, or review requested | Code review                         |
| `pull_request_review_comment` | `@fro-bot` mention in review thread    | Respond with file/line context      |
| `schedule`                    | Cron trigger                           | Execute the configured prompt       |
| `workflow_dispatch`           | Manual trigger                         | Execute the provided prompt         |

For `schedule` and `workflow_dispatch`, the custom prompt replaces the default directive entirely. The harness also prepends a `## Delivery Mode` preamble inside `<task>` for these triggers, declaring whether the agent should edit the working directory or deliver via branch+PR (driven by the `output-mode` action input). See [Delivery-mode contract for manual workflow triggers](../solutions/workflow-issues/delivery-mode-contract-for-manual-triggers-2026-04-17.md). For all other events, the custom prompt is appended to the event-specific directive.

## Security Gating

The routing phase enforces access control before any agent execution occurs. Only users with `OWNER`, `MEMBER`, or `COLLABORATOR` association can trigger the agent. Bot accounts are blocked to prevent infinite loops. Fork PRs are skipped for `pull_request` events. These checks happen at the `NormalizedEvent` level, using the author association field that GitHub provides in webhook payloads.
