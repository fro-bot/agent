---
type: architecture
last-updated: "2026-08-24"
updated-by: "ses_fd0b1eaf4ffeTMI146lECk0yxc"
sources:
  - src/harness/run.ts
  - src/harness/phases/bootstrap.ts
  - src/harness/phases/routing.ts
  - src/harness/phases/acquire-lock.ts
  - src/harness/phases/acknowledge.ts
  - src/harness/phases/cache-restore.ts
  - src/harness/phases/session-prep.ts
  - src/harness/phases/execute.ts
  - src/features/agent/retry.ts
  - src/features/agent/session-poll.ts
  - src/features/agent/streaming.ts
  - src/features/agent/prompt-sender.ts
  - src/features/agent/response-file.ts
  - src/harness/phases/finalize.ts
  - src/harness/phases/cleanup.ts
  - src/harness/phases/dedup.ts
  - src/harness/phases/review-reconciliation.ts
  - src/harness/post.ts
  - src/features/triggers/router.ts
  - src/features/triggers/skip-conditions-pr.ts
  - src/features/agent/output-mode.ts
  - src/features/agent/response-post.ts
  - src/features/delegated/brokered-push.ts
  - src/features/delegated/brokered-push-gate.ts
  - src/features/delegated/brokered-push-validation.ts
  - src/features/delegated/reconstruct-changes.ts
  - src/features/reviews/review-reconciliation.ts
  - src/features/reviews/review-guards.ts
  - src/services/github/context.ts
  - packages/runtime/src/agent/response-delivery.ts
  - packages/runtime/src/agent/response-file.ts
  - packages/runtime/src/coordination/lock.ts
  - packages/runtime/src/coordination/types.ts
  - RFCs/RFC-005-GitHub-Triggers-Events.md
  - RFCs/RFC-010-Delegated-Work.md
  - RFCs/RFC-012-Agent-Execution-Main-Action.md
  - RFCs/RFC-017-Post-Action-Cache-Hook.md
  - RFCs/RFC-019-S3-Storage-Backend.md
summary: "Phase-by-phase walkthrough of a single action run, including review reconciliation and brokered push"
---

# Execution Lifecycle

Every Fro Bot run follows the same phase sequence, orchestrated by `src/harness/run.ts`. This page builds on the [[Architecture Overview]] — specifically the harness layer — and walks through each phase in execution order. Each phase is a standalone module under `src/harness/phases/`, a deliberate design that keeps the orchestrator thin and each phase independently testable.

## Phase Sequence

```text
main.ts
  └─ run()
       ├─  1. Bootstrap
       ├─  2. Routing
       ├─  3. Deduplication
       ├─  4. Acquire Lock
       ├─  5. Acknowledge
       ├─  6. Cache Restore
       ├─  7. Session Prep
       ├─  8. Execute
       ├─  9. Review Reconciliation
       ├─ 10. Finalize
       └─ 11. Cleanup (always, via finally)

post.ts
  └─ runPost()
       └─ Durable Cache Save
```

## 1. Bootstrap

Parses action inputs (`parseActionInputs`), validates credentials, and ensures the OpenCode CLI is available. If the tools aren't already cached, the setup module installs OpenCode. When `enable-omo: true`, it also installs Bun and oMo (see [[Setup and Configuration]]). On failure, the run exits immediately with code 1.

Bootstrap also resolves the run's **response-delivery decision** — a two-axis object (`resolveResponseDelivery()` in `packages/runtime/src/agent/response-delivery.ts`) that decides both _how_ the agent's answer reaches GitHub and _whether the agent is given a GitHub credential at all_. Comment and review triggers (`issue_comment`, `pull_request`, `issues`) resolve to `file-convention` delivery with the credential **withheld**; `schedule` and `workflow_dispatch` resolve to `model-gh` delivery with the credential **provisioned**, because those flows legitimately create branches, commits, and PRs on their own. The decision is computed once here from the raw event name, threaded through setup so the credential is (or is not) provisioned, and re-asserted against the routing classification so a mismatch fails loudly rather than silently mis-provisioning. See [[Setup and Configuration]] for how the credential is withheld and [[Prompt Architecture]] for how the delivery mode reshapes the response protocol the agent is told to follow.

## 2. Routing

This is where the incoming GitHub webhook event gets classified and the run decides what to do.

First, `parseGitHubContext()` reads the raw Actions context and calls `normalizeEvent()` to produce a `NormalizedEvent` — a discriminated union with eight variants (one per supported event type plus `unsupported`). This normalization layer is the project's central abstraction: no downstream code ever touches raw webhook payloads.

Then `routeEvent()` applies skip conditions to decide whether to proceed. Skip conditions include: action not supported (e.g., a `labeled` event), draft PR, locked issue, bot responding to itself, unauthorized author (not `OWNER`, `MEMBER`, or `COLLABORATOR`), missing prompt for schedule/dispatch events, and PR review not requested from the bot. If any condition matches, the run exits cleanly with code 0 and a skip reason.

Pull-request events also carry an **opt-out label** check (`src/features/triggers/skip-conditions-pr.ts`). When a PR carries the configured `review-skip-label` (default `skip-agent-review`, see [[Setup and Configuration]]), the automatic review is suppressed. The suppression is deliberately overridable so it never silences a directed request: a `@fro-bot` mention in the PR body overrides the label on opened, synchronize, reopened, and edited actions (where the PR author controls the body), and an explicit review request naming the bot overrides it on `review_requested`. `ready_for_review` has no override — its trigger is not author-controlled — so the label always wins there. This keeps the label a passive default-off switch rather than a hard gate an authorized human cannot bypass.

## 3. Deduplication

A lightweight guard against duplicate runs for the same entity within a configurable window (default: 10 minutes). Uses cache-based sentinel markers — not an in-flight lock. This is best-effort suppression; workflow-level concurrency groups provide the stronger guarantee.

## 4. Acquire Lock

When the S3 object store is enabled, the harness acquires a per-repo coordination lock (`src/harness/phases/acquire-lock.ts`) so that multiple surfaces — the GitHub Action, the Discord gateway, and the [[Operator Web Control Surface|operator web surface]] — cannot execute concurrently against the same repository. The lock is an S3 object (JSON `LockRecord`) written with conditional-put semantics (`If-None-Match: *` for initial acquisition).

The lock config carries two staleness thresholds. The ordinary stale threshold governs takeover of a lock held by a _running_ surface that stopped heartbeating, while a separate **pending** stale threshold (`pendingStaleThresholdMs`) governs runs that were admitted but never progressed. This second threshold exists because the gateway now records queued and failed runs through the same admission path, so a run that is reserved but stuck must eventually become reclaimable without waiting out the full running-lease TTL. Both the acquire and cleanup phases pass this threshold so the two surfaces agree on when a pending lock may be taken over.

The lock result is a discriminated union with four outcomes:

- **`acquired`** — This run holds the lock. The returned `lockEtag` is carried through to the cleanup phase for release.
- **`held-by-other`** — Another surface (or another Action run) already holds the lock. The current run exits cleanly with code 0.
- **`s3-disabled`** — S3 is not configured. Coordination is opt-in, so the run proceeds without a lock.
- **`error`** — Lock acquisition failed unexpectedly. The run proceeds without a lock to preserve single-surface behavior. The 15-minute TTL on any orphaned lock from a prior crash allows recovery via stale-takeover on the next attempt.

The shared coordination layer (`packages/runtime/src/coordination/types.ts`) also names a run's lifecycle phases as a closed union — `PENDING`, `ACKNOWLEDGED`, `EXECUTING`, and the three **terminal phases** `COMPLETED`, `FAILED`, and `CANCELLED` (the last modeled as a `TerminalPhase` type so that gateway cancellation and the operator cancel route agree on one closed set instead of hand-writing the same literals). The Action harness itself does not expose these phases directly, but they are the vocabulary the [[Operator Web Control Surface]] and Discord gateway use for the runs that share this same per-repo lock.

The lock has a 15-minute TTL. In v1, the Action does not run a heartbeat to extend the lease — the median Action run (~2 minutes) is well within TTL, and rare long runs recover through stale takeover.

## 5. Acknowledge

Posts visual feedback so the user knows the agent received their request. For comment-triggered events, this means adding an `eyes` (👀) reaction to the triggering comment and applying an `agent: working` label to the issue or PR. These are non-fatal — if the GitHub API call fails, execution continues.

## 6. Cache Restore

Restores the OpenCode storage directory from GitHub Actions cache (or S3 backup if configured). The cache key is scoped by repository, branch, and OS to prevent cross-branch contamination. After restore, the module checks for corruption (unreadable directory, version mismatch) and falls back to clean state if needed. Credentials (`auth.json`) that may have leaked into cache from a prior run are deleted as a security measure.

This phase also bootstraps the OpenCode SDK server and establishes a client connection — the server handle is reused throughout the remaining phases.

## 7. Session Prep

Processes any file attachments from the triggering context, searches prior sessions for relevant context (see [[Session Persistence]]), and builds the agent prompt (see [[Prompt Architecture]]). The prompt is a multi-section XML-tagged document that includes environment metadata, issue/PR context, session history, the task directive, and response protocol rules.

## 8. Execute

The core phase. Calls `executeOpenCode()` which creates (or continues) an SDK session, sends the assembled prompt, and streams events back in real time. The SDK lifecycle follows the pattern: spawn server, connect client, create session, send prompt, process event stream, close.

If a turn fails with a retryable error, the system retries up to three times with a continuation prompt. A configurable timeout (default: 30 minutes) bounds execution if the agent runs too long — but that bound is an internal execution deadline, not the whole GitHub Actions job timeout. The distinction matters: the deadline aborts only the agent's own work so that Finalize and Cleanup still get a bounded budget to preserve outcomes and persist state (`action.yaml` documents this boundary, and the job's own `timeout-minutes` remains the outer backstop). A run that hits the deadline is reported as a genuine terminal failure rather than a silent hang, and a pre-deadline terminal result is kept distinct from the bounded post-result teardown that follows it, so cleanup can never overwrite the real outcome.

A permission ask raised mid-run no longer blocks until that deadline. OpenCode can emit an interactive permission request during a turn — a shell command, an out-of-tree file write — and in CI there is no operator to answer it, so an unanswered ask would previously pin the run open until the execution deadline elapsed. The streaming consumer (`src/features/agent/streaming.ts`) now **denies and logs** any such ask as it arrives, and the two native ask defaults that are actually reachable in CI are denied at config time (see [[Setup and Configuration]]). A permission reply is issued only when the SDK's v1 route can act on it — the route no-ops without a `query.directory`, so replies that could never take effect are not attempted. The result is that a run which trips a permission gate fails or continues promptly on its own terms rather than stalling to the deadline.

Each attempt now resolves to a **classified outcome** rather than a bare "retry or not" boolean (`src/features/agent/retry.ts`). The outcome distinguishes a submission that never reached the server (`submit_failed`) from a turn that actually ran and then failed, and among failed turns it separates retryable from terminal. The retry decision is _derived_ from that outcome — only a retryable turn failure retries — which keeps the classification, not a side-effect flag, as the authoritative signal. One subtlety this guards against: the event stream is subscribed _before_ the prompt is submitted, so if submission returns a transport error while the server has already accepted the prompt and begun working, the attempt is reclassified from `submit_failed` to a turn failure rather than resending the original prompt into a session that is already running it.

Not every provider error is retryable, and the phase distinguishes them (`packages/runtime/src/agent/error-format/types.ts` enumerates the terminal error kinds — `quota_exceeded`, `provider_auth_error` — as a closed set that the classifiers produce from bounded, provider-neutral fields). Classification prefers the most trustworthy signal available: a structured SDK field first (including the provider's own `isRetryable` flag on an API error, so a provider that says "retry me" is honored even when no status code or prose pattern matches), then an HTTP status such as 429, and only then a prose regex as a last resort. **Provider quota exhaustion is terminal**: the retry loop classifies a `quota_exceeded` error as non-retryable and fails fast rather than burning the remaining attempts on a wall it cannot get past. **Provider authentication failures are treated the same way**: a bad or expired credential is not a transient fetch error, so the phase classifies it as terminal and stops retrying immediately. The subtlety both cases guard against is that a provider's error-retry can look like session activity — the underlying `wait()` may even resolve as if it succeeded — so an activity tracker records the terminal signal and the phase reconciles it into the authoritative result, reporting a failure instead of a false success. A brief poll also merges any terminal signal the event stream never emitted, so a wall observed only during polling still surfaces as a failure.

The continuation prompt sent on a retry is no longer a fixed string that asserted a "network error (fetch failed)" cause regardless of what actually happened. It is built from the observed error type (`src/features/agent/prompt-sender.ts`), so a rate-limit retry says rate limit and a timeout says timeout, and it asks the model to _continue the remaining objective_ rather than to "resume" — a distinction that matters because a credential-provisioned run is additionally told to verify what has already landed (external changes and response artifacts) before acting, so it does not repeat a side effect that already succeeded. Recovery also treats the response file by _status_ rather than mere existence (`src/features/agent/response-file.ts`): an agent that created the file and then overflowed before writing a body leaves it empty, so the harness inspects the file and proceeds with recovery only when the deliverable is genuinely absent, declining to recover — rather than silently posting nothing — when the file exists but cannot be parsed. Recovery also probes where the write actually landed. An earlier version searched a fallback path (`_temp/fro-bot-response/<runId>-<attempt>/<nonce>.md`) the write never used, so a stray file went unrecovered. The deny rule that keeps the model out of that fallback directory and the recovery probe that scans it are now derived from a single shared definition (`packages/runtime/src/agent/response-file.ts`), so the guard and the recovery can no longer drift apart and point at different paths.

When a terminal failure reaches the user, its diagnostics are handled carefully: provider-controlled error text is kept out of the trusted failure summary the action delivers, so a hostile or noisy provider message cannot smuggle content into the run's authoritative outcome. The structured session error is preserved through teardown rather than being swallowed by the cleanup path, which is what lets a failed run deliver an accurate, trustworthy failure notice instead of a generic one.

## 9. Review Reconciliation

Runs after Execute, before Finalize, only for `pull_request` review triggers on the model-`gh` posting path (`workflow_dispatch`/`schedule`). Calls `decideReconciliation()` in `src/features/reviews/review-reconciliation.ts` to inspect the agent's posted review body for a verdict signal. If the verdict warrants a formal GitHub APPROVE, the phase submits one automatically via the GitHub review API through the shared review guards (fork/self/head-SHA/TOCTOU). This removes the manual step of having the agent issue the `gh pr review --approve` command itself on approve-verdicts.

For comment/review flows that post through the file convention (see Finalize), this phase **skips immediately** — the model posts no review of its own for reconciliation to reconcile, and Finalize owns the review post instead. The fork/self/head-SHA/TOCTOU guard set both paths share has been extracted into `src/features/reviews/review-guards.ts`, so a file-driven approve on a fork PR is blocked exactly as a reconciled one would be.

The phase is **fail-safe**: any error logs a warning and no-ops. It never throws and never fails the run. It also checks the bot login before acting — an empty or null `botLogin` triggers an immediate no-op.

## 10. Finalize

Writes a synthetic summary message into the session history so future runs can discover what this run accomplished. Prunes old sessions based on dual-condition retention (age OR count). Collects metrics and sets action outputs (session ID, cache status, duration).

For `pull_request`/`issue_comment`/`issues` triggers, this phase also **posts the agent's response on the model's behalf** — the file-convention delivery path. The model wrote its response to a run-scoped file (outside the checkout, under `RUNNER_TEMP`, nonce-named and created by the action); Finalize reads it, binds the target and surface to the trusted `NormalizedEvent` (never the file), validates it against a strict allowlist schema, and posts via the Octokit comment/review writers (`src/features/agent/response-post.ts`) — a PR-review verdict goes through the same shared review guards (`src/features/reviews/review-guards.ts`) as reconciliation. This path is **fail-closed**: a missing, malformed, or undeliverable response fails the run (naming the file), and a delivery assertion prevents a green-but-silent run. The dedup marker for these flows is written only after delivery is confirmed, so a failed post followed by a retry cannot dedup-skip into a silent success.

This design exists for a security reason, not just tidiness. Because the model no longer posts its own comment or review, it no longer needs a GitHub credential for those flows — so the credential is withheld from the OpenCode child entirely (see [[Setup and Configuration]]). The response file is treated as _untrusted payload_: it contributes only body content (and, for a review, an `approve`/`request-changes` verdict) within an envelope whose target, surface, and eligibility come from the trusted event. A fork PR cannot preseed a workspace file to redirect a post or forge an approval. `workflow_dispatch`/`schedule` runs keep `model-gh` delivery — they post via the model's own `gh` and are unchanged.

### Brokered push

Finalize also hosts an optional **brokered push** step for the file-convention path (RFC-010, `src/features/delegated/brokered-push.ts`). The credential-withholding design above means a comment-triggered agent cannot commit for itself — it has no `gh` token. Brokered push closes that gap for the narrow, trusted case of a same-repository pull-request comment: after a successful run that produced workspace edits but posted no comment of its own, the harness reconstructs those edits and commits them to the PR head branch on the model's behalf, using the action's own Octokit client rather than any credential the model can reach. This lets an authorized `@fro-bot` fix request land as a real commit while still keeping the token off the agent process.

The step is a fail-closed state machine where every stage re-derives trust from event-time facts rather than the model's output. An **early gate** (`brokered-push-gate.ts`) admits only `issue_comment` events on a same-repo pull request from an `OWNER`, `MEMBER`, or `COLLABORATOR`, and only when a **trusted head SHA** was captured before execution (see [[Setup and Configuration]] for the `trusted-head-sha` input that anchors this). A **live permission re-check** then confirms the triggering actor still has `write` or `admin` on the repository, failing closed on any lookup error so a transient outage suppresses the push rather than allowing it. **Reconstruction** (`reconstruct-changes.ts`) diffs the workspace against that trusted SHA — never local `HEAD`, branches, or remotes — enumerates untracked files, and reads each changed file through an `O_NOFOLLOW` handle to close a symlink swap race. A **path allowlist** (`brokered-push-validation.ts`) restricts delivery to `src/`, package `src/`, `docs/`, and a short set of top-level docs (`README.md`, `ARCHITECTURE.md`, `STRUCTURE.md`), capped at 100 files, so config, scripts, and CI files can never be pushed. A final **pre-write gate** re-resolves the live PR immediately before the Git Data API write, rejecting the push if the PR closed, the base or head repository changed, the head branch was renamed, or the head SHA moved.

The whole step runs under a 120-second wall-clock ceiling enforced by a `Promise.race`. The `AbortSignal` cancels the Octokit calls promptly, but the reconstruction `git` subprocess cannot observe an abort signal, so the race is the hard bound for a stalled subprocess; the abandoned promise never leaks because the process exits once `run()` resolves. Delivery is deliberately **non-atomic**: the commit lands before the response comment is posted, and a timeout firing after `updateRef` already succeeded reports failure for a commit that may exist. This self-heals — a re-run reconstructs the now-updated branch to _nothing-to-deliver_ rather than double-pushing. On success, Finalize appends a "Brokered push delivered" footer (branch, changed paths, commit SHA) to the delivered comment; on failure it fails the run with a generic error and posts no push.

## 11. Cleanup (Always)

Runs in a `finally` block regardless of success or failure. Completes the acknowledgment state machine (replaces 👀 with 🎉 on success or 😕 on failure, removes the `agent: working` label). Cleans up file attachments. Prunes old sessions. Shuts down the OpenCode server — importantly, this triggers a SQLite WAL checkpoint that merges in-flight session data into the main database file before cache save. If the S3 object store is enabled, uploads run artifacts and metadata to the store (see [[Session Persistence]]). Saves the cache and optionally uploads a prompt log artifact for observability.

The cleanup phase has its own `finally` block for lock release: if a coordination lock was acquired in phase 4, it is released after all S3 sync and cache save operations complete. This ordering ensures the next surface sees a coherent state. Lock release is always attempted, even if earlier cleanup steps failed.

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
