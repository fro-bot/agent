# OBSERVABILITY MODULE

**Scope:** Metrics collection, run summaries for GitHub comments, and GitHub Actions job summaries.

## WHERE TO LOOK

| Component       | File             | Purpose                                              |
| --------------- | ---------------- | ---------------------------------------------------- |
| **Types**       | `types.ts`       | `RunMetrics`, `ErrorRecord`, `CommentSummaryOptions` |
| **Metrics**     | `metrics.ts`     | `createMetricsCollector()` factory                   |
| **Run Summary** | `run-summary.ts` | Comment summary generation and manipulation          |
| **Job Summary** | `job-summary.ts` | GitHub Actions UI job summary                        |

## KEY EXPORTS

```typescript
createMetricsCollector() // Factory for metrics collection
generateCommentSummary(options) // Generate markdown summary
appendSummaryToComment(body, opts) // Append summary to comment
extractSummaryFromComment(body) // Extract existing summary
replaceSummaryInComment(body, opts) // Idempotent replacement
writeJobSummary(options, logger) // Write GitHub Actions job summary
formatCacheStatus(status) // Format cache status with emoji
formatDuration(ms) // Human-readable duration
formatTokenUsage(usage, model) // Token count display
```

## PATTERNS

- **Closure-based MetricsCollector**: No ES6 classes per project rules
- **Frozen snapshots**: `getMetrics()` returns immutable objects
- **Idempotent summary replacement**: Only one `BOT_COMMENT_MARKER` per comment
- **Logger injection**: `writeJobSummary()` takes logger for error handling
- **Non-throwing job summary**: Failures logged but never crash execution

## DATA FLOW

```
main.ts
  │
  ├─→ createMetricsCollector()
  │     ├─ start()
  │     ├─ setCacheStatus()
  │     ├─ addSessionUsed/Created()
  │     ├─ setTokenUsage()
  │     ├─ addPRCreated/CommitCreated()
  │     ├─ recordError()
  │     └─ end() → getMetrics()
  │
  └─→ writeJobSummary(options, logger)
        └─ core.summary.write()
```

## ANTI-PATTERNS

| Forbidden                 | Reason                                    |
| ------------------------- | ----------------------------------------- |
| ES6 classes               | Use closure-based factory                 |
| Multiple BOT markers      | Summary replacement must be idempotent    |
| Throwing in job summary   | Log and continue; non-critical operation  |
| Mutable metrics snapshots | Return frozen objects from `getMetrics()` |
