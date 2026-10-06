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

`acquire-lock.ts` takes the per-repo **Action** lock (`locks/action.json`, `ACTION_LOCK_SCOPE`); `cleanup.ts` releases and the renewal controller renews on the same key. Action runs exclude each other (shared S3 session object); the gateway's `repo.json` lock is separate, so Action and gateway runs do not exclude each other. S3 configured + lock error → fail closed (exit 1, `invocation-outcome=failed`); contended → exit 0 `skipped` plus `coordination-decline.ts` (job summary, warning, `agent: blocked` label on issue/PR targets unless `response-mode: none`; the label stays until removed manually); S3 disabled → no lock. A run that did not acquire the lock while S3 is configured (contended or lock error) never persists session state: `runCleanup({skipSessionPersistence: true})` reports `ownership-declined` / `declined-for-safety` and the post hook is disabled.

## PATTERNS

- **Context Accumulation**: Each phase updates the `RunContext` (RFC-012).
- **Graceful Skip**: Routing and dedup phases can mark a run as skipped; downstream phases are bypassed.
- **Fail-Fast Bootstrap**: Bootstrap failures stop the action before any GitHub writes.
- **Phase Isolation**: Each phase is responsible for its own error boundary.

## ANTI-PATTERNS

- **Phase Coupling**: Avoid cross-phase dependencies outside of `RunContext`.
- **Global State**: All shared state must reside in `RunContext`.
- **Silent Phase Fail**: Log entry/exit for every phase to aid debugging.
