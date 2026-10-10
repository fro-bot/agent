# HARNESS PHASES

**Location:** `src/harness/phases/`

Multi-phase execution logic for the main GitHub Action harness (RFC-012).

## WHERE TO LOOK

| Component         | File               | Responsibility                                    |
| ----------------- | ------------------ | ------------------------------------------------- |
| **Bootstrap**     | `bootstrap.ts`     | Input parsing, setup, cache restore (61 L)        |
| **Routing**       | `routing.ts`       | Event parsing and trigger routing (87 L)          |
| **Dedup**         | `dedup.ts`         | Skip if agent already ran for this entity (109 L) |
| **Acknowledge**   | `acknowledge.ts`   | PR reactions and "working" labels (21 L)          |
| **Session Prep**  | `session-prep.ts`  | Attachment processing, prompt building (84 L)     |
| **Execute**       | `execute.ts`       | OpenCode agent execution and streaming (141 L)    |
| **Finalize**      | `finalize.ts`      | Summary writing, session pruning (95 L)           |
| **Cleanup**       | `cleanup.ts`       | Metrics, job summary, cache save (99 L)           |
| **Cache Restore** | `cache-restore.ts` | Phase-specific cache restore (65 L)               |

## EXECUTION FLOW

```
bootstrap → routing → dedup → acknowledge → cache-restore → session-prep → execute → finalize → cleanup
```

## KEY EXPORTS

- `runBootstrapPhase(ctx, logger)`: 12-step bootstrap (setup, cache, config)
- `runRoutingPhase(ctx, logger)`: Normalize event and determine skip status
- `runDedup(dedupWindow, triggerContext, repo, startTime)`: Skip if recent execution sentinel exists
- `runAcknowledgePhase(ctx, logger)`: Post 👀 reaction and "working" label
- `runSessionPrepPhase(ctx, logger)`: Collect context and build prompt
- `runExecutePhase(ctx, logger)`: Spawn OpenCode server and stream events
- `runFinalizePhase(ctx, logger)`: Update session history and prune
- `runCleanupPhase(ctx, logger)`: Persist state and write job summary

## COORDINATION LOCK

`acquire-lock.ts` takes the per-repo **Action** lock (`locks/action.json`, `ACTION_LOCK_SCOPE`); `cleanup.ts` releases and the renewal controller renews on the same key. Action runs exclude each other (shared S3 session object); the gateway's `repo.json` lock is separate, so Action and gateway runs do not exclude each other. S3 configured + lock error → fail closed (exit 1, `invocation-outcome=failed`); contended → exit 0 `skipped` plus `coordination-decline.ts` (job summary, warning, `agent: blocked` label on issue/PR targets unless `response-mode: none`; the label is re-stamped — removed then added, 404 on remove ignored — so every skip emits a fresh `labeled` event; a later `succeeded` run for the same item clears it via `coordination-clear.ts`, called from `run.ts`'s `finally` block); S3 disabled → no lock. A run that did not acquire the lock while S3 is configured (contended or lock error) never persists session state: `runCleanup({skipSessionPersistence: true})` reports `ownership-declined` / `declined-for-safety` and the post hook is disabled.

`coordination-clear.ts` (`runBlockedLabelClear`) removes a stale `agent: blocked` label after a `succeeded` run: one `listLabelsOnIssue`; only if the label is present, one pass over the issue events (LAST page via the `Link` header, then a look-back bounded to 3 pages, no duplicate fetches) finds the latest `labeled` event for `agent: blocked` and `agent: working`. The `agent: working` event is the run-start anchor (acknowledge applies it at run start; cleanup removes it before the clear runs, which does not delete the past `labeled` event). Remove only if blocked is **strictly earlier** than working; a tie or a missing event keeps the label. GitHub's clock on both sides; never payload timestamps (a re-run reuses the original payload), the runner clock, or the Actions run-attempts API (it needs `actions: read`). The run does not know whether its own acknowledge applied the label (`acknowledgeReceipt` discards `addWorkingLabel`'s result); that is safe by construction: if `agent: working` was already present (a crashed earlier run) or the add failed, there is no new event, so the anchor is an older run's and can only keep labels, never clear one it should keep. Best-effort and deadline-bounded (15 s): any API failure means no removal plus a logged reason; it never throws or fails the run. No-op under `response-mode: none`, for non-issue/PR targets, and for any non-`succeeded` outcome (a lock-declined or errored run never clears). **Residual race:** GitHub has no conditional label removal, so a decline landing between the event read and the remove (or between run start and acknowledge) can be cleared; the workflow's per-target concurrency group (`fro-bot-<issue/pr number>`) prevents same-target overlap.

## PATTERNS

- **Context Accumulation**: Each phase updates the `RunContext` (RFC-012).
- **Graceful Skip**: Routing and dedup phases can mark a run as skipped; downstream phases are bypassed.
- **Fail-Fast Bootstrap**: Bootstrap failures stop the action before any GitHub writes.
- **Phase Isolation**: Each phase is responsible for its own error boundary.

## ANTI-PATTERNS

- **Phase Coupling**: Avoid cross-phase dependencies outside of `RunContext`.
- **Global State**: All shared state must reside in `RunContext`.
- **Silent Phase Fail**: Log entry/exit for every phase to aid debugging.
