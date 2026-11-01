---
type: subsystem
last-updated: "2026-11-01"
updated-by: "9a429e2a6ddc692bd6098b5504c225830af85bf9"
sources:
  - packages/runtime/src/agent/ownership-ledger.ts
  - packages/runtime/src/agent/ledger-reconcile.ts
  - packages/runtime/src/agent/ledger-reconcile-v2.ts
  - packages/runtime/src/agent/event-v2.ts
  - packages/runtime/src/agent/shell-jobs-v2.ts
  - packages/runtime/src/agent/subagent-notice.ts
  - packages/runtime/src/agent/shell-notice.ts
  - packages/runtime/src/agent/directory-quiescence-v2.ts
  - packages/runtime/src/agent/server-v2.ts
  - src/features/agent/streaming.ts
  - src/features/agent/streaming-v2.ts
  - src/features/agent/session-poll.ts
  - src/features/agent/drain-v2.ts
  - src/harness/phases/execute.ts
  - src/harness/phases/release-v2.ts
  - src/harness/phases/cleanup.ts
  - src/harness/run.ts
  - src/harness/outcome.ts
  - packages/gateway/src/execute/run-core.ts
  - packages/gateway/src/execute/run-core-v2.ts
  - packages/gateway/src/execute/drain-completion-v2.ts
  - packages/gateway/src/execute/settle-owned-sessions-v2.ts
  - packages/gateway/src/execute/root-stop.ts
  - packages/gateway/src/execute/root-stop-v2.ts
  - packages/gateway/src/execute/run.ts
  - packages/gateway/src/execute/recovery.ts
  - packages/gateway/src/execute/opencode-generation.ts
  - packages/gateway/src/execute/repo-quiescence-v2.ts
  - packages/opencode-plugin/src/task-reuse-guard.ts
  - src/services/setup/no-task-reuse-config.ts
  - src/services/setup/ci-config-v2.ts
  - packages/runtime/src/agent/permission-rules-v2.ts
  - docs/solutions/integration-issues/permission-ask-dropped-by-ownership-filter-2026-09-19.md
summary: "How ownership accounting and generation-specific release gates contain background subagents, shells, and follow-up turns"
---

# Background Subagents and Ownership

A root session becoming idle does not mean its run has finished. Background subagents can still write the checkout, a shell can remain alive, and completion notices can queue another parent turn. Releasing the repository lock or saving session state at the first idle event would race those writers.

Fro Bot therefore separates **ownership accounting** from **release evidence**. The Action and gateway share an ownership ledger, but each OpenCode generation has its own completion protocol. [[Architecture Overview]] explains generation selection; [[Execution Lifecycle]] places the release checks in the Action pipeline.

## Ownership accounting

`packages/runtime/src/agent/ownership-ledger.ts` creates a fresh in-memory ledger for each invocation. Entries are `outstanding`, `settled`, or `unknown`. Unknown means the harness cannot confirm whether work stopped; it blocks the ledger's drain and persistence predicates just as outstanding work does. A late event from a settled entry still belongs to the run.

Subagent entries are keyed by child session ID. Reused dispatch identifiers cannot safely identify an execution, and a delayed completion must never settle a newer job. V2 also tracks background shells, using namespaced shell keys so shell IDs cannot be mistaken for session IDs. Those entries support progress, accounting, and reconciliation; they are not independently sufficient evidence that a directory is safe to release.

Ownership is learned from observed dispatch metadata. On V1, a completed `task` part with background metadata identifies its child session. On V2, `event-v2.ts` projects native events into the shared activity vocabulary, including subagent and shell dispatches. Once adopted, descendants contribute tool activity, usage, and human requests to their owning run. Their terminal errors do not automatically fail the root: the root can explain or recover from a child's failure through its follow-up turn.

## Reconciliation and notices

Reconciliation repairs a missed settlement, not a missed adoption. V1's `ledger-reconcile.ts` checks that a tracked session is a direct child of the expected parent and separately checks directory-scoped liveness. A confirmed child that is no longer live settles; failed reads or mismatched parentage remain unknown. It never adopts every child returned by discovery, because a foreground delegation has the same child-session shape as a background dispatch.

V2's `ledger-reconcile-v2.ts` and `shell-jobs-v2.ts` perform the corresponding session and shell checks. Shared notice parsers (`subagent-notice.ts`, `shell-notice.ts`) recognize upstream completion messages that can wake the parent. Ledger settlement and the parent's response to a notice are separate events: a child can stop before the notice is queued, and the parent's old terminal reply says nothing about the next turn.

An unexpected stream end records an observation gap. An empty ledger cannot disprove an unobserved dispatch, so missing observations are retained as uncertainty instead of silently being interpreted as no work.

## V2 release is directory-based

V2 uses the shared observer and stability gate in `packages/runtime/src/agent/directory-quiescence-v2.ts`. Every success waits for this gate, including a run that adopted no background work. The observer reads the global active-session list and resolves session placement, lists the directory's shells, and checks relevant session inboxes for queued work.

Inbox reads cover the root, owned sessions, and sessions updated since the run began minus a ten-minute margin. This keeps an old workspace's accumulated history from dominating each poll. Queuing an inbox item updates the session timestamp, so newly admitted work falls inside the recent set. The recent-session scan is bounded; an unreadable, incomplete, or over-limit observation cannot count as quiet.

Release requires eleven consecutive quiet readings at least 500 milliseconds apart and spanning at least five seconds. Any activity or failed reading resets the window. Root activity that invalidates the completion evidence also resets admission, including activity racing the final reading. A partial read can still identify sessions or shells to stop, but cannot authorize release.

This is deliberately stronger than an empty ledger. V2 can wake a session after a shell exits or a child's completion is enqueued, through a step the event stream does not expose. The ledger describes what the harness observed; the directory gate checks the checkout that is about to be handed back.

The stability window is still bounded evidence, not a proof against an upstream producer paused longer than the window and waking later. Quarantine after an unconfirmed stop and the next run's workspace admission check provide additional protection.

## Action: drain, stop, then shut down

The Action's V2 release is `src/harness/phases/release-v2.ts`, backed by `src/features/agent/drain-v2.ts`. A successful execution drains within the remaining execution budget. A failed execution, expired drain, or exceptional exit takes the stop path: delete running shells first, interrupt active sessions with the root first, then observe again until the same directory-stability gate passes. Killing a shell can itself wake its owner, which explains the ordering and repeated observations.

The stop has a fresh 30-second confirmation budget rather than inheriting the execution signal that already expired. Shell deletion and session interruption have separate two- and three-second bounds, so a stuck deletion cannot consume the interrupt allowance. An interrupt response is a receipt, not confirmation that the writer stopped.

Successful execution keeps its event observer alive through release. A notice-triggered parent turn can add a PR, a commit, usage, or a terminal failure after the initial attempt returned. Release folds those observations into the result, stops observation before server shutdown, and refreshes usage only from a quiet directory. The synthetic run summary is deferred until this point, then written with pruning in a bounded pre-shutdown phase. Writing it earlier would queue another inbox item while the gate was trying to drain.

Finally, the server is shut down and its exit confirmed. An unconfirmed directory or process exit declines persistence. A lost prompt acknowledgment also declines persistence and endorsement, even if a later stop finds a quiet directory: the harness cannot account for what the accepted prompt may have done.

Overflow recovery uses the same generation-specific backend as the original execution. V2 refuses to archive and restart when stopping the old session's work cannot be confirmed, preventing a replacement session from racing the old writer.

## Gateway: drain and quarantine

`packages/gateway/src/execute/run-core-v2.ts` owns its drain before returning, so heartbeat stop, terminal run-state writes, and concurrency-slot handoff occur after admission. Its completion gate also checks the root's reply and delivery evidence; directory stability is an additional release requirement, not a replacement for a useful answer.

Failure passes through `settle-owned-sessions-v2.ts`, which repeatedly stops directory activity and attempts to confirm quiet. An unconfirmed stop marks the failure quarantined. The run retains its heartbeat and channel slot during a bounded hold; `root-stop-v2.ts` continues stopping observed activity during that hold. Afterwards the slot is freed, but the lock is left to expire rather than explicitly released on uncertain evidence. An owned session observed moving outside the directory also prevents confirmed release.

Startup recovery and lock-takeover checks select the appropriate generation from workspace readiness. A busy or unreadable workspace blocks startup repair; recovery never deletes coordination locks. Persisted ownership is diagnostic, not authority to conclude that a writer is gone. The periodic stranded-run sweep separately repairs stale records without releasing locks; [[Troubleshooting]] describes that distinction.

## V1 compatibility path

V1 retains its SDK-based drain. The Action's `runDrain` in `src/harness/phases/execute.ts` reconciles tracked children, waits within the remaining timeout minus the teardown reserve, and aborts unresolved entries on expiry. With no Action timeout it stops waiting after three consecutive passes that observe no tracked live work while ownership remains unresolved. Individual drain reads and aborts remain bounded.

V1 completion evidence is generation-scoped: renewed root activity invalidates an old idle observation, and the latest root user turn must have a qualified terminal reply. The gateway's V1 barrier additionally confirms an aborted root through its latest terminal assistant reply and liveness, rather than accepting absence from the live set alone. An abort issued while prompt preparation is still underway can otherwise report success without stopping the later runner.

## Requests, reuse, and configuration

The Action rejects interactive requests rather than waiting for an absent human. Its V1 permission responder answers every well-formed ask on its private server without awaiting the reply inside the stream loop. V2 similarly rejects permission asks and cancels forms. The gateway instead routes owned requests through its shared approval and question registries; applying CI's unconditional rejection there would cross run boundaries and bypass human interaction.

Both generations prevent subagent-session reuse before dispatch. V1 installs the local `no-task-reuse` guard; V2's `@fro.bot/opencode-plugin` rejects a `subagent` call carrying a `sessionID`. A fresh child session per job makes completion attribution meaningful. Subagent depth remains pinned to one, with V2 expressing it under `experimental.subagent_depth`. Session moves and worktree creation are denied on V2 because they would weaken directory ownership.

[[Setup and Configuration]] explains the effective-rule gate, run-attempt attachment access, and the narrow grant allowing bundled skills to read their own references outside the checkout.

## Persistence and honest outcomes

Cleanup declines a save when ownership remains unresolved, server quiescence is unconfirmed, or lease continuity is unverified. V2 release adds its directory and prompt-acknowledgment facts before publication. A decline maps to `declined-for-safety`, which the post-action hook honors rather than retrying with less evidence; see [[Session Persistence]].

The final invocation outcome distinguishes failure from `incomplete`: a useful artifact may exist while observation, ownership, process exit, or lease continuity could not be certified. Such runs receive no success reaction or dedup certificate. Known defects also veto brokered pushes and formal approvals. This preserves the distinction between observing no problem and proving completion.
