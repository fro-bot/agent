# OBSERVABILITY MODULE

**Scope:** Metrics collection, run summaries for GitHub comments, and Actions job summaries.

## WHERE TO LOOK

| Component       | File             | Purpose                                              |
| --------------- | ---------------- | ---------------------------------------------------- |
| **Types**       | `types.ts`       | `RunMetrics`, `ErrorRecord`, `CommentSummaryOptions` |
| **Metrics**     | `metrics.ts`     | `createMetricsCollector()` factory                   |
| **Run Summary** | `run-summary.ts` | Comment summary generation and manipulation          |
| **Job Summary** | `job-summary.ts` | GitHub Actions UI job summary                        |
| **Entry Point** | `index.ts`       | Public API re-exports                                |

## KEY EXPORTS

```typescript
createMetricsCollector() // Factory for metrics collection
generateCommentSummary(options) // Generate markdown summary
appendSummaryToComment(body, o) // Append summary to comment
extractSummaryFromComment(body) // Extract existing summary
replaceSummaryInComment(body, o) // Idempotent replacement
writeJobSummary(options, logger) // Write Actions UI job summary
formatCacheStatus(status) // Format cache status with emoji
formatDuration(ms) // Human-readable duration
formatTokenUsage(usage, model) // Detailed token display
```

## PATTERNS

- **Closure-based Metrics**: No ES6 classes; state encapsulated in collector closure
- **Frozen snapshots**: `getMetrics()` returns deeply immutable `RunMetrics`
- **Idempotent replacement**: Uses `BOT_COMMENT_MARKER` to find/replace existing summaries
- **Logger injection**: `writeJobSummary()` uses injected logger for non-blocking warnings
- **Graceful degradation**: Job summary failures never fail the workflow execution

## DATA FLOW

```
main.ts
  │
  ├─→ createMetricsCollector()
  │     ├─ start()
  │     ├─ setCacheStatus('hit'|'miss'|'corrupted')
  │     ├─ addSessionUsed/Created(id)
  │     ├─ addPRCreated/CommitCreated(url/sha)
  │     ├─ incrementComments()
  │     ├─ setTokenUsage(usage, model, cost)
  │     ├─ recordError(type, message, recoverable)
  │     └─ end() → getMetrics()
  │
  └─→ writeJobSummary(options, logger)
        └─ core.summary.write()
```

## ANTI-PATTERNS

| Forbidden                 | Reason                                     |
| ------------------------- | ------------------------------------------ |
| ES6 classes               | Violates project-wide functional pattern   |
| Multiple BOT markers      | Summary replacement must remain idempotent |
| Throwing in job summary   | Log and continue; non-critical metadata    |
| Mutable metrics snapshots | Snapshots must be frozen for consistency   |
