---
type: subsystem
last-updated: "2026-09-20"
updated-by: "schedule-d7190410-35540552880"
sources:
  - packages/runtime/src/agent/ownership-ledger.ts
  - packages/runtime/src/agent/ledger-reconcile.ts
  - packages/runtime/src/agent/server.ts
  - packages/runtime/src/agent/types.ts
  - packages/runtime/src/agent/attachment-dir.ts
  - packages/runtime/src/coordination/run-state.ts
  - src/features/agent/streaming.ts
  - src/features/agent/session-poll.ts
  - src/features/agent/retry.ts
  - src/features/agent/attempt-outcome.ts
  - src/features/agent/execution.ts
  - src/harness/phases/execute.ts
  - src/harness/phases/cleanup.ts
  - src/harness/phases/acquire-lock.ts
  - src/harness/outcome.ts
  - src/harness/config/outputs.ts
  - src/features/observability/job-summary.ts
  - src/services/setup/ci-config.ts
  - packages/gateway/src/execute/run-core.ts
  - packages/gateway/src/execute/run.ts
  - packages/gateway/src/execute/settle-owned-sessions.ts
  - packages/gateway/src/execute/recovery.ts
  - packages/gateway/src/operator-contract/run-status.ts
  - deploy/scripts/merge-config.mjs
  - deploy/workspace.Dockerfile
  - docs/plans/2026-09-14-001-feat-background-subagent-ownership-plan.md
  - docs/brainstorms/2026-09-13-opencode-background-subagents-requirements.md
  - docs/solutions/integration-issues/permission-ask-dropped-by-ownership-filter-2026-09-19.md
summary: "How the harness tracks, drains, and settles background subagent work that outlives the turn that dispatched it"
---

# Background Subagents and Ownership

OpenCode can dispatch a subagent in the background: `task({background: true})` returns immediately and the child runs as a detached fiber while the parent keeps going. That is exactly what a fan-out reviewer or a parallel research sweep wants — and it quietly breaks every assumption the Fro Bot harness previously made about when a run is finished.

This page describes the machinery that closes that gap: a per-invocation **ownership ledger**, a **drain** step that holds teardown open until owned work settles, **reconciliation** that recovers settlement events the event stream dropped, and a set of honesty-preserving outcomes for the cases where none of that can be confirmed. It applies to both surfaces — the GitHub Action ([[Execution Lifecycle]]) and the Discord gateway plus [[Operator Web Control Surface|operator web surface]].

## Why ownership had to be tracked at all

Three structural consequences fall out of detached dispatch, and each of them was load-bearing for something the harness already did.

**Session idle stops meaning "done."** OpenCode computes a session's idle state from explicit status transitions; it never consults the background job registry. So the parent session reports `session.idle` while its children are still running tools, writing the checkout, and touching the git index. Every completion signal the harness trusted — the SSE idle event, the REST idle probe, `v2.session.wait()` — now describes the parent's turn rather than the run's work.

**Descendants are invisible.** Both surfaces filtered every SSE event on root-session equality: ten such filters in `src/features/agent/streaming.ts`, nine in `packages/gateway/src/execute/run-core.ts`. A child's tool calls, token accounting, approval prompts, and errors simply did not exist as far as the harness was concerned.

**Terminal steps fire on top of live writers.** On the Action, idle leads to finalize, publish, prune, server shutdown, SQLite checkpoint, cache save, and lock release — all while children write. On the gateway, the channel's concurrency slot is handed to the next queued run while the previous run's subagents still hold the same workspace. The worst version of this is context-overflow recovery, which archives the overflowed session and re-runs under a new one: without intervention, the archived session's subagents and the recovery session's subagents write the same checkout concurrently.

The features shipped deliberately in that order — the low-risk configuration change first, then the machinery while the flag was still off, then a correctness fix for a race the machinery exposed, and only then the flag itself.

## The ownership ledger

`packages/runtime/src/agent/ownership-ledger.ts` holds a per-invocation, in-memory map created by `createOwnershipLedger()`. Each entry names a child session and a human-readable label, and sits in one of three states: `outstanding` (adopted, not yet confirmed finished), `settled` (confirmed finished, terminal), or `unknown` (the harness lost track of it).

Two decisions in that shape carry most of the weight.

**Entries are keyed on the child session id, never the job id.** Upstream reuses job ids across dispatches, so a job-keyed ledger would let a delayed notification for a stale job settle a newer execution — the ledger would report drained while live work continued.

**`unknown` is never collapsed into `settled`, and never treated as zero.** Not knowing whether a child is alive is a reason to keep waiting, not a reason to proceed. Both of the ledger's predicates — `isDrainComplete()` ("may we stop waiting?") and `isPersistenceSafe()` ("may we write to disk?") — require zero outstanding *and* zero unknown, and both delegate to one private helper so the two questions cannot silently drift apart.

The hot-path check is `isTracked(sessionId)`, which is membership in *any* state rather than "still outstanding." A settled descendant can emit a trailing event — a final chunk racing its own completion signal — and that event still belongs to this run.

### How a session becomes owned

There is exactly one adoption path on each surface, and it is an *observation*, not a request. When a `task` tool part completes carrying `state.metadata.background === true` and a `jobId` (the child session id), the stream handler adopts it. On the Action that is `src/features/agent/streaming.ts`; on the gateway it is `run-core.ts`, which additionally registers the child with the permission coordinator so approvals route correctly.

Once adopted, a descendant's text deltas, tool events, and token accounting flow through the same handlers as the root's. Three event kinds stay deliberately root-scoped:

- **`session.idle`** — a descendant going idle says nothing about the root's turn.
- **`session.error`** — a descendant error must not end the root's turn or trigger context-overflow recovery. The descendant's ledger entry is marked `unknown` instead.
- **Root freshness mutations** — the completion-evidence machinery described below is about the root session's generations, so it ignores descendant activity entirely.

Settlement also arrives through the stream. When a background dispatch finishes, upstream injects a synthetic turn into the *parent* session rendered as `<task id="…" state="completed|error">`. The stream handler parses that marker and settles the entry — for `error` as well as `completed`, because the marker is upstream's own authoritative "this execution is done" signal, whereas a raw `session.error` is not.

### Reconciliation: recovering dropped settlements

The SSE stream has no replay. A reconnect, a discontinuity, or a silently dropped event can leave a tracked entry `outstanding` forever. `packages/runtime/src/agent/ledger-reconcile.ts` asks upstream directly instead of waiting.

Reconciliation asks two questions and never conflates them: `children(parentSessionId)` is a bare parent-id lookup with no liveness filter (discovery), and `liveSessionIds()` is backed by session status, which only holds non-idle sessions (liveness). For each entry that is currently outstanding or unknown:

| Observation | Result |
| --- | --- |
| A child of this parent, and live | Left as-is — never re-promoted from `unknown` back to `outstanding` |
| A child of this parent, not live | `settle()` — absence of liveness, checked against an affirmatively confirmed child |
| Not a child of this parent at all | `markUnknown()` — even if it is live somewhere else on the server |
| Either upstream call failed | Every outstanding entry becomes `unknown` |

That third row is the security-relevant one: a persisted or forged entry that happens to name a live session under someone else's tree must never count as this run's live work, and must never grant this run's drain or Discord thread access to it.

**Reconciliation never adopts.** An earlier revision adopted any live untracked child it found and was removed as actively harmful. Upstream creates the child session identically for foreground `task` delegation and for background dispatch; the `background: true` flag lives only on the tool-part metadata, never on the session record. So `children()` and `liveSessionIds()` have no discriminant to tell an ordinary foreground subagent apart from a background dispatch, and adopting on that basis would have made every run's drain depend on a classification those two calls cannot make.

The known consequence is that a dispatch whose *adoption* event was never observed is not recoverable by reconciliation. The mitigation is detection rather than recovery: an unexpected end of stream records an observation gap regardless of what the ledger contains, so the run reports itself incomplete rather than claiming a success it cannot support.

## Drain on the Action

`runDrain` (`src/harness/phases/execute.ts`) runs after Execute returns and strictly *before* review reconciliation, finalize, and cleanup. Its placement is the point: a drain folded into cleanup would publish a response describing work that is still changing underneath it.

The sequence is straightforward once the invariants are clear. Drain reconciles once unconditionally — even with zero entries outstanding, because that is the only way to learn a tracked entry's settlement event was dropped. If the ledger is drained, it returns. Otherwise it arms a periodic reconciler and polls until the ledger drains or the deadline expires. On expiry it reconciles once more (so the cancellation set reflects the present), aborts every entry that is not confirmed settled — `unknown` as well as `outstanding`, since an unconfirmable entry is the one most likely still running — then reconciles again to confirm. Anything still unsettled is explicitly marked `unknown`.

Two timing details matter. The abort calls use a **fresh** timeout signal: the just-expired execution deadline must not also cancel the cancellation. And the drain budget is carved out of the same wall-clock budget as execution — total timeout, minus a teardown reserve, minus the time execution already spent — so one deadline covers execution and drain together rather than letting drain extend a run indefinitely.

Context-overflow recovery drains with a zero deadline against the overflowed session's ledger *before* archiving it, so the archived session's children are cancelled before the recovery session starts writing the same checkout. The recovery session then gets a fresh ledger, which is a dispatch-accounting reset rather than a claim that the replaced session left nothing unresolved — the unresolved state is carried forward separately.

### Everything else the ledger gates

Drain is the visible step, but the ledger is consulted in five other places on the Action:

- **Completion admission** (`src/features/agent/session-poll.ts`) — every path that could declare the turn finished, including the SSE-idle path, the qualified-assistant-message path, and the REST-idle path, refuses while the ledger is undrained.
- **The session wait and retry loop** (`src/features/agent/retry.ts`, `src/features/agent/execution.ts`) — an undrained ledger defers to the poll watchdog rather than exiting early, and blocks LLM retry admission. A failed prompt submission observed during that deferral is preserved rather than lost.
- **Persistence safety** (`src/harness/phases/cleanup.ts`) — see below.
- **The job summary** (`src/features/observability/job-summary.ts`) — a "Background Work" section names unfinished entries **by label** rather than by count, with a degraded banner when any entry is unknown. A count tells a reader something went wrong; a label tells them what.

## The persistence safety gate

Cleanup can now decline to save session state at all. Three independently sufficient reasons are checked in a fixed order, and only the first match is reported — a reader needs one clear cause, not a list:

1. **The ownership ledger is not persistence-safe** — a background subagent this run owns might still be writing.
2. **Server quiescence was never confirmed** — the OpenCode server itself might still be writing. This starts conservative: unconfirmed whenever a server handle exists, confirmed only when there is none.
3. **Lease continuity is unverified** — the coordination lease could not be renewed. This reads a *latched* signal that a later success never clears, and settles any in-flight renewal tick first so the decision is made against a final answer.

Declining produces the `ownership-declined` outcome, which maps to a `declined-for-safety` state value rather than `not-persisted`. That distinction is the whole point: `not-persisted` tells the post-action hook to retry, and the post hook runs with strictly less information than cleanup had — no server handle, no ownership ledger, no lease — so it must honor the decline rather than second-guess it. See [[Session Persistence]] for the full outcome contract and [[Execution Lifecycle]] for the handoff.

The lease renewal that feeds reason 3 exists *because* of drain. The original design sized a 15-minute TTL against a median two-minute Action run and skipped heartbeating entirely; drain extends the protected interval well past that assumption, so the lock is now actively renewed for as long as it is held.

## Honest outcomes: observation gap and `invocation-outcome`

The other half of the design is admitting when the harness cannot tell. An **observation gap** is recorded when the event stream ends without an intentional shutdown and without a terminal signal — covering both a thrown mid-stream error and a plain unexpected EOF. Recording it warns, requires revalidation of completion evidence, and marks every outstanding ledger entry unknown. It is deliberately *not* scoped to whether the ledger had entries: the uncertainty being recorded is "did an unobserved dispatch happen while we were blind," and requiring a pre-existing entry would assume away the exact failure mode.

The gap is sticky across retry attempts and across the overflow-recovery boundary, and it feeds `assessInvocationOutcome` (`src/harness/outcome.ts`), which reduces four verification facts — observation completeness, ownership resolution, server quiescence, lease continuity — plus delivery success into one of `succeeded`, `incomplete`, `failed`, or `skipped`. That value is published as the `invocation-outcome` action output.

`incomplete` is the new state and the interesting one: a useful result may well exist, but this invocation cannot certify completion. It forces a non-zero exit code rather than inventing a third numeric code, and it withholds the *reversible* certificates — the dedup marker is not written and no success reaction is posted — so a re-run is not dedup-skipped into a silent success.

The *irreversible* consumers are gated more narrowly. Brokered push and the formal review-approve downgrade are gated on a known execution veto — an observation gap or unresolved ownership — rather than on the full assessment. The reasoning is stated in the code and worth repeating: a known defect can veto an endorsement without the absence of that defect certifying the invocation. It is a veto, never a certificate.

## Turn-scoped completion evidence

Background dispatch also exposed a latent race in how the Action decided a turn was over. The activity tracker's idle and terminal-signal flags were *sticky* — once set, never reset — which was fine for a single-turn run. But when a child finishes, upstream injects another root user turn into the parent session and **persists that user message before the runner that will answer it starts running**. In that window the sticky flags still read "idle happened," so the poll loop could authorize completion for a turn that was still in flight: stale evidence from generation N completing generation N+1.

The fix scopes evidence to a generation. A root-freshness tracker carries a monotonic revision that advances on renewed root activity, and an idle observation is stamped with the revision it was seen at, so a superseded generation's evidence can no longer authorize finishing a later turn. A pending-parent barrier is raised when a new root user turn appears and cleared only at a fully qualified commit point — and ordering matters: the barrier goes up *before* the ledger entry is settled, because a background completion injecting another parent turn is precisely the exposure being closed.

A completion timestamp is not a success certificate either. Upstream stamps it during processor cleanup, including for failed and intermediate processing, so a qualified candidate additionally needs a finish reason that is present and is not "tool calls" or "unknown," correlation to the latest known root user message, no non-provider-executed tool part left outstanding (mirroring upstream's own prompt loop, which ignores tool-part status entirely — even a *completed* tool part blocks, because the model has not yet received the result and will produce another turn), two consecutive matching observations, corroborating session status, and a drained ledger.

The governing rule underneath all of it: **a provisional observation may record evidence or tighten a guard, but it may never release a guard or authorize completion on its own.** Barrier resolution and revalidation clearing are committed only at final admission, synchronously with the settlement they protect. The accepted consequence is that a run whose evidence is genuinely unavailable reaches the watchdog or the deadline rather than reporting an unproven success.

## Gateway: drain, quarantine, and restart

The gateway has no separate drain stage because it does not need one. Its core execution loop does not return until the ledger drains, so everything after it — heartbeat stop, terminal transition, concurrency slot handoff — already runs post-drain by construction. Root idle with an undrained ledger puts the run into a draining state: it stops reporting busy, clears the inactivity timer, fires an immediate reconciliation, and **keeps consuming the stream**. The loop waits on a signal that fires the instant drain completes, rather than blocking on an SSE event that may never arrive. A clean drain exit is explicitly not a failure path.

If the deadline expires while draining, the run fails with a distinct internal `drain-timeout` kind. Externally it is projected to the same operator-facing timeout concept as an ordinary deadline expiry (`packages/gateway/src/operator-contract/run-status.ts`), because one deadline covers execution and drain — it is the same wall-clock story from the operator's point of view.

**The termination barrier.** Every error thrown after the ledger exists passes through a barrier that attempts settlement first (`packages/gateway/src/execute/settle-owned-sessions.ts`). It fast-paths with zero remote calls when the ledger is already drained. Otherwise it uses a fresh timeout signal — the run's combined signal is already aborted and cannot carry a new cancellation — aborts the root and every unsettled child, then **confirms via reconciliation**, because an abort response is a delivery receipt rather than proof the child stopped. If settlement cannot be confirmed, the same error is rethrown with a `quarantined` flag. Quarantine is additional evidence layered on, never a replacement explanation for why the run failed.

A quarantined failure makes the run manager skip the heartbeat stop, the lock release, and the slot handoff. The run transitions to failed with the quarantine flag recorded, and a bounded hold window (about twenty times the settlement bound) elapses before the heartbeat stops and the concurrency slot is released. It deliberately does *not* release the lock: lock takeover and force-release both require a stale heartbeat, which is exactly why the hold must be bounded rather than indefinite.

**Restart reconciliation.** Ownership is persisted continuously onto run state during the run — the root session id and the not-yet-settled child ids — through a new runtime primitive that shallow-merges into a run's details without touching its phase. (The ordinary transition helper refuses a same-phase write, so mid-execution ownership changes previously had no way to persist.) That primitive re-reads the record fresh on every call rather than threading a caller-held etag, because a caller-tracked etag goes stale the moment the heartbeat's own read-modify-write commits; a lost race is non-fatal, since the next adopt or settle retries with fresher data.

On startup, recovery (`packages/gateway/src/execute/recovery.ts`) seeds a throwaway ledger with the persisted ids and runs one reconciliation pass scoped to the persisted root. Live work found means the stale run's failure transition and lock release are skipped entirely. A claim that cannot be verified at all — adapter missing, reconcile failed — cancels the run but still withholds the lock release, because an unverifiable claim might name a live writer and releasing on staleness alone is the exact hazard. Persisted run state is advisory, never authoritative: a gateway restart is not a workspace restart.

## Permission asks are requests, not notifications

The most instructive bug in this work was a run that died silently at its CI job cap having delivered nothing. The Action ran `permission.asked` events through the *same* ownership filter it used for activity and accounting. But a permission ask is not a notification — upstream publishes it and then blocks on a deferred resolution. Any ask the filter skipped was never answered, so the child blocked forever, the root blocked on the child, and the run ended by clock. No error, no exception, no classification branch reached; runs without subagents passed normally, which made it look flaky rather than structural.

The fix has two parts, both in `src/features/agent/streaming.ts`. First, the ownership gate is dropped on that one branch, leaving only a well-formedness check that the event names a session at all — the reply targets the *event's own* session, not the root's. Second, the reply is no longer awaited inside the loop, because awaiting it reproduced the same stall one layer up: one slow reply holds every subsequent event behind it. Failures are logged and execution continues rather than escalated, since throwing would abort the stream for every other in-flight ask and event, trading one stuck child for the whole run's observability.

This is safe on the Action specifically because it starts its own loopback OpenCode server per run and wires an unconditional-reject responder to it. Every well-formed ask on that subscription belongs to this run's own process tree, there is no interactive approval path in CI, and an unanswered ask has no way to resolve except by deadline.

**The same change would be wrong on the gateway**, which keeps its ownership check on that branch. The gateway has a real human-answerable Discord approval path and an ownership boundary that exists to stop one run's approval crossing into another run's thread; answering everything there would be a cross-run approval leak. That gap is tracked separately and left unfixed on purpose — it needs an ownership-boundary-safe answer path, not this fix ported across.

The generalizable rule, recorded in `docs/solutions/integration-issues/permission-ask-dropped-by-ownership-filter-2026-09-19.md`: an ownership or relevance filter is for notifications. A request the remote side is blocking on needs a reply path keyed to the request, not a membership test that can silently drop it. If a filter can skip a blocking request, skipping is not "ignore" — it is "hang."

## Configuration

Two experimental OpenCode environment flags are defaulted at server spawn (`packages/runtime/src/agent/server.ts`) and baked into the workspace image, following the same convention on both surfaces: default only when the variable is **unset or empty**, so an operator who set it explicitly — including to `false` — always wins. Treating empty as unset is not pedantry; GitHub Actions materializes an unset `env:` input as an empty string rather than an absent key, and OpenCode's boolean parsing does not read empty as true, so leaving it would silently keep the old behavior.

- **Background subagents** — the single switch that makes background dispatch reachable at all.
- **File watcher disabled** — nothing in this project consumes file-change events (both surfaces read message and tool lifecycle events only), so the watcher is pure overhead and there is no config-file equivalent. The accepted tradeoff, stated on both surfaces: OpenCode caches the VCS branch and refreshes that cache from watcher events, so it can go stale after a checkout — more visible on the long-lived workspace container than in short-lived CI.

Two OpenCode config keys back the feature. **Subagent depth is pinned to one, unconditionally, in every mode** — on the Action in `src/services/setup/ci-config.ts` and on the workspace in `deploy/scripts/merge-config.mjs` — overriding any operator value with a logged warning. This is the one deliberate exception to the project's "an explicit operator value wins" convention, and the reason is structural: upstream cancellation walks only running jobs, so at depth greater than one a *completed* child linking the root to a still-running grandchild is never walked, and the grandchild can outlive a cancellation meant to stop it. Depth one makes that path unreachable rather than requiring the harness to build a traversal of its own.

The second key grants attachment-directory access. A dispatched subagent inherits its parent session's resolved permission rules, so the grant is applied at the top-level global permission key rather than only on the `build` agent — though the `build` agent's block re-asserts the same pattern, because its catch-all deny would otherwise shadow the global grant under upstream's flattened evaluation order. The grant is scoped to the specific run *attempt's* directory rather than the shared segment: a wildcard compiles to a pattern that matches path separators, so a segment-wide grant would let a sibling run on a persistent or self-hosted runner read this run's attachments and plant symlinks.

That attachment directory (`packages/runtime/src/agent/attachment-dir.ts`) lives under the runner temp path, deliberately outside the checkout so a compromised checkout cannot plant or tamper with materialized files, and both controlled path segments are created with an exclusive, symlink-refusing `mkdir`. A plain recursive create is explicitly not safe here: it stats intermediate existing segments, which *follows* symlinks, so a symlink planted at the shared segment would be followed and the leaf's own guard would pass cleanly at the attacker's resolved location. Cleanup removes the directory best-effort.

## Related pages

- [[Execution Lifecycle]] — where drain sits in the phase sequence, and the cleanup-to-post handoff
- [[Session Persistence]] — the cache save outcome contract that `ownership-declined` extends
- [[Operator Web Control Surface]] — how quarantined and drain-timed-out runs surface to operators
- [[Setup and Configuration]] — where the environment flags and config keys are assembled
- [[Architecture Overview]] — the module map these files sit in
- [[Troubleshooting]] — diagnosing an `incomplete` invocation or a repeated `declined-for-safety`
