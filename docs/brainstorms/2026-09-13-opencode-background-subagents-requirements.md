---
date: 2026-09-13
topic: opencode-background-subagents
---

# OpenCode Background Subagents and File Watcher

## Summary

Two separable changes to how this project runs OpenCode. The first disables the OpenCode file watcher on both the Action and the workspace container, and ships on its own. The second enables background subagents as a bounded ownership feature: the harness tracks the executions it owns, handles events from owned descendant sessions, enforces dispatch limits before work starts, and cancels outstanding work before it finalizes, persists, or releases its lock.

---

## Problem Frame

Fro Bot's CI review agent fans out to reviewer personas serially inside one execution budget, and it runs out of room. Its own reviews say so: one reported "two of seven reviewer passes were interrupted, so maintainability and general-correctness coverage in this round is thinner," and a later one reported "four reviewer passes completed; the previous-comments pass was interrupted." Coverage is lost silently, and which coverage is lost varies per run.

OpenCode offers background subagents behind `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`, but the flag alone is unsafe here. A background dispatch returns immediately and runs as a detached fiber in a process-local registry that is explicitly not durable. Session idle is computed only from explicit status updates and never consults background jobs, so a session reports idle while subagents are still running. The Action's poll returns on idle and cleanup then kills the server, which destroys in-flight work with no error surfaced.

Both surfaces also filter every event to the root session, so a child session's tool calls, approvals, and activity are invisible today. In the gateway, tool approvals route to Discord buttons and fail closed when no coordinator is present; a descendant's approval request would not reach that gate at all.

Separately, the OpenCode file watcher runs in both surfaces and nothing in this project subscribes to file-change events. Upstream has one indirect consumer: the cached VCS branch refreshes from watcher events, so disabling the watcher leaves that cache stale after a checkout.

---

## Actors

- A1. CI agent: the OpenCode session the Action drives with a single prompt, under a fixed execution budget.
- A2. Gateway agent: the OpenCode session the workspace container runs, driven by a Discord mention.
- A3. Background subagent: a detached child execution dispatched by A1 or A2, running in its own session.
- A4. Harness: the Action and gateway code that owns the server lifecycle, event handling, and publication.
- A5. Human approver: the Discord operator who approves or denies gateway tool calls.

---

## Key Flows

- F1. Action run with background dispatch
  - **Trigger:** A GitHub event routes to the Action and the agent dispatches background work mid-run.
  - **Actors:** A1, A3, A4
  - **Steps:** Harness confirms the event subscription is live before submitting the prompt. Agent dispatches one or more background subagents within the enforced caps. Parent session reaches idle while subagents run. Harness recognises outstanding owned work and does not treat idle as terminal. Completion arrives as an injected turn on the parent session, which may itself dispatch further work within the caps. Harness drains, then finalizes.
  - **Outcome:** All owned work has settled or been cancelled before the harness publishes a response, prunes sessions, shuts the server down, or saves cache.
  - **Covered by:** R4, R5, R6, R9, R14, R15, R16a

- F2. Drain deadline expires
  - **Trigger:** The invocation deadline arrives with owned work still outstanding.
  - **Actors:** A1, A3, A4
  - **Steps:** Harness stops admitting new dispatches. It cancels owned remote work using a teardown signal distinct from the expired execution signal. It confirms stopping, settles any pending approvals, and reports the unfinished work in its single response.
  - **Outcome:** The run reports incomplete work rather than failing, and never reports success while a live writer is unconfirmed.
  - **Covered by:** R13, R16, R17, R18, R19, R19a, R23

- F3. Gateway approval for a descendant
  - **Trigger:** A background subagent requests a tool that requires approval.
  - **Actors:** A2, A3, A4, A5
  - **Steps:** Harness recognises the requesting session as an owned descendant and routes the request to the run's existing coordinator. The approval posts to the originating thread. The run retains ownership and approval routing until drain completes. A reply settles only the approval it names.
  - **Outcome:** Descendant tool calls pass through the same fail-closed gate as foreground calls.
  - **Covered by:** R9, R10, R11, R24

---

## Requirements

**File watcher**

- R1. Disable the OpenCode file watcher in both the Action's OpenCode child and the workspace container.
- R2. Ship the file watcher change independently of background subagents, with no shared machinery.

**Ownership and visibility**

- R3. The harness maintains a ledger of the sessions and task executions an invocation owns, keyed on the child session identifier rather than the job identifier, so that dispatch, extension, promotion, and notification all settle the same entry once.
- R4. Event handling covers owned descendant sessions in addition to the root session, and never treats an unowned session as in scope.
- R5. Ownership survives a retry attempt; the harness cancels or settles the prior execution tree before replacing it.
- R6. A missing, ambiguous, or unobservable signal resolves to unknown outstanding work, never to zero.
- R7. The harness confirms its event subscription is live before submitting work for execution.
- R8. A stream discontinuity resolves to unknown, triggers bounded cancellation, and produces an incomplete outcome rather than a successful drain.

**Approval and run ownership**

- R9. Tool approval requests originating from owned descendant sessions route to the invocation's existing approval coordinator.
- R10. Activity and approval state account for the whole owned tree, so a busy descendant does not read as an inactive run and one reply does not settle unrelated approvals.
- R11. The gateway retains run ownership and approval routing until drain completes, rather than handing off its slot when the foreground turn ends.

**Bounded dispatch**

- R12. Subagent depth is limited to one level and enforced rather than inherited from a default.
- R13. Each invocation allows at most two outstanding child executions and eight total accepted task submissions, with extensions and promotions counting toward the total. These are initial values, configurable without a code change.
- R14. Caps are enforced in the dispatch path before the background execution starts, and the same gate covers the extension and promotion paths; observing a dispatch on the event stream after it has started is not enforcement.
- R15. No new dispatch is accepted once the invocation enters finalization or cancellation.

**Lifecycle and termination**

- R16. Drain completes before execution returns, ahead of finalization, session pruning, server shutdown, cache persistence, and lock release.
- R16a. Every path that can terminate an invocation applies the outstanding-work check, not the idle branch alone. This includes the stable completed-assistant poll, the session-wait success path, and the sticky terminal flags, each of which can currently end a run independently.
- R17. Each invocation has a single deadline covering execution and drain, reserving time for cancellation and teardown, and it is not extended by a completion notification, retry, or extension.
- R18. On deadline expiry the harness stops admission, cancels owned work with a teardown signal separate from the expired execution signal, settles approvals, and reports once.
- R19. Cancellation counts as confirmed for an owned entry only on an observable terminal signal: an injected completion or error turn, a cancellation the server acknowledged, or confirmed termination of the server process itself. Absent one of those, the entry is unknown.
- R19a. Unfinished child work is non-fatal only for entries whose cancellation is confirmed; an unknown entry, an unconfirmed live writer, or a lost lock lease is not reported as success.
- R20. The harness owns publication: exactly one response is published after drain, and a background subagent never publishes an invocation response.
- R21. The harness declines cache persistence when it cannot confirm that writers have terminated.
- R22. The Action renews its coordination lock lease for the whole protected interval, covering execution, drain, and persistence, and fails closed when a renewal does not succeed.

**Reporting and recovery**

- R23. Each dispatched background execution carries a stable label identifying the work it represents, and the invocation's single response names any execution that did not finish by that label.
- R24. On startup the gateway reconciles owned background work against persisted run state; work that cannot be reattached is cancelled or recorded as unknown, and no conflicting run is admitted until reconciliation completes.

---

## Acceptance Examples

- AE1. **Covers R4, R6, R16.** Given a run whose agent dispatched a background subagent, when the parent session reports idle while that subagent is still running, the harness continues waiting rather than returning from execution.
- AE2. **Covers R6, R13.** Given a background job that was cancelled, when no completion notification is ever injected, the harness resolves the entry through its deadline rather than waiting indefinitely for a notification that cannot arrive.
- AE3. **Covers R3, R13.** Given a task execution extended onto an existing job, when a single completion notification arrives for it, the harness settles that entry once and does not report a second outstanding execution.
- AE4. **Covers R9.** Given a background subagent requesting a tool that requires approval, when the request is raised, it reaches the run's approval coordinator and posts to the originating thread.
- AE5. **Covers R15, R17.** Given an invocation in finalization, when the agent attempts a new background dispatch, the dispatch is rejected rather than queued.
- AE6. **Covers R19, R19a, R21.** Given an expired deadline where no terminal signal was observed for an owned entry, when the run finishes, it reports that entry as unknown and declines cache persistence rather than reporting success.
- AE7. **Covers R23.** Given a run where one dispatched execution did not finish, when the harness publishes, the response names that execution by its label rather than reporting a generic count.
- AE8. **Covers R16a.** Given an invocation with outstanding owned work, when a terminal path other than the idle branch is reached, that path also declines to end the run.
- AE9. **Covers R20.** Given a run where a background subagent produced a result, when the harness publishes, exactly one comment or review is delivered for the invocation.
- AE10. **Covers R8.** Given a dropped and reconnected event stream, when the harness cannot account for work across the gap, it treats outstanding work as unknown and cancels rather than declaring the drain complete.

---

## Success Criteria

- A CI review completes its persona passes without reporting interrupted coverage, or names precisely which passes did not finish.
- No run publishes a response, saves cache, or releases its lock while an owned subagent is still writing.
- A reviewer can tell from the run output whether background work completed, was cancelled, or is unknown.
- Planning can implement the ownership ledger, cap enforcement point, and teardown sequence without deciding what counts as "done" — this document already fixes that.

---

## Scope Boundaries

- No change to OpenCode itself. The harness owns its stop condition, and the events required are already delivered.
- `OPENCODE_DISABLE_FFF` is not set. It would replace the fast file finder with ripgrep, and the default already selects the faster path on the platforms both surfaces run.
- `OPENCODE_ENABLE_EXA` and `OPENCODE_ENABLE_PARALLEL` are not set. No prompt or tool configuration in this project uses web search, and neither provider's hosts are in the workspace egress allowlist.
- `OPENCODE_EXPERIMENTAL_WEBSOCKETS` is not set. It affects the OpenAI Responses transport only, which is not the path either surface depends on.
- Operator-set values for the four declined flags are not overridden. This project simply does not set them.
- Background work is not made resumable across runs. The upstream registry is process-local and not durable; cache persistence does not change that.
- Fixed review fan-out is not specified. Dispatch stays agent-selected within the caps.

---

## Key Decisions

- Ship the file watcher change separately: it is a configuration change with no shared machinery, and coupling it to a lifecycle feature would delay a verified low-risk win.
- Track owned executions in a ledger rather than counting dispatches against completions: an extension notifies once for several dispatches and a cancellation never notifies, so a counter provably fails to balance.
- Bound dispatch before execution rather than observing it after: an event consumer only learns of a subagent once it is already running, so observation cannot enforce a cap.
- Retain gateway run ownership through drain rather than restricting background subagents to read-only tools: keeping the approval gate intact preserves the fail-closed guarantee without narrowing what background work can do.
- Treat unknown as distinct from zero: every ambiguous case resolves toward cancellation and an incomplete report rather than toward declaring success.

---

## Dependencies / Assumptions

- The pinned harness base is `anomalyco/opencode` at `1.18.30`; behaviour was verified against that tree. A base bump requires re-verifying the flag names, the notification path, and the correlation key R3 depends on.
- An operator who sets `OPENCODE_EXPERIMENTAL=true` enables background subagents independently of this work, so the ownership and cap machinery must hold whether or not this project sets the specific flag.
- `filterAgentEnv` allowlists the `OPENCODE_` prefix, so both flags already reach the OpenCode child without a change to the deny set.
- The `OPENCODE_EXPERIMENTAL` umbrella also enables background subagents, and an explicit `false` overrides the umbrella. An operator setting the umbrella would enable the capability independently of this work.
- Upstream `SessionRunState.cancel()` cancels registered descendant jobs, but its traversal covers running jobs only, so a completed child linking the root to a running grandchild is not reached. This is part of why depth is limited to one.
- Disabling the watcher leaves OpenCode's cached VCS branch stale after a checkout, since that cache refreshes from watcher events. Accepted, and more visible on the long-lived container than in CI.

---

## Outstanding Questions

### Resolve Before Planning

- [Affects R17][User decision] How much of the invocation deadline is reserved for cancellation and teardown? A starting proposal is sixty seconds, unvalidated against real teardown timings.

### Deferred to Planning

- [Affects R8][Technical] How does the harness reconcile owned work after an event-stream reconnect, given that the stream offers no replay and the gap itself is not directly observable?
- [Affects R22][Technical] Whether lease renewal reuses the gateway's existing heartbeat or needs an Action-side equivalent. The policy is decided; the mechanism is not.
- [Affects R13][Needs research] Whether two outstanding and eight total are the right caps once real reviewer fan-out is measured.

---

## Sources / Research

- Upstream behaviour verified against `.slim/clonedeps/repos/anomalyco__opencode/` at `v1.18.30`, matching `packages/harness/harness.config.json`.
- Background job durability and lifecycle: `packages/core/src/background-job.ts`. Registry is process-local and documented as non-durable.
- Idle computation excludes background jobs: `packages/opencode/src/session/status.ts`.
- Dispatch, notification, and handles: `packages/opencode/src/tool/task.ts`.
- Descendant cancellation and its running-only traversal: `packages/opencode/src/session/run-state.ts`.
- Watcher and its VCS branch-cache consumer: `packages/core/src/filesystem/watcher.ts`, `packages/opencode/src/project/vcs.ts`.
- Root-session event filtering in this project: `src/features/agent/streaming.ts`, `packages/gateway/src/execute/run-core.ts`.
- Action cleanup ordering and lock TTL: `src/harness/run.ts`, `src/harness/phases/cleanup.ts`, `src/harness/phases/acquire-lock.ts`.
