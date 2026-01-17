# COMMENTS MODULE

**Scope:** GitHub comment interactions for issues, PRs, and discussions (RFC-008).

## WHERE TO LOOK

| Component        | File              | Purpose                                              |
| ---------------- | ----------------- | ---------------------------------------------------- |
| **Types**        | `types.ts`        | ThreadComment, Thread, ErrorInfo, PostCommentResult  |
| **Reader**       | `reader.ts`       | `readThread()`, `findBotComment()`, pagination       |
| **Writer**       | `writer.ts`       | `postComment()`, `isBotComment()`, GraphQL mutations |
| **Error Format** | `error-format.ts` | `formatErrorComment()`, error creation helpers       |
| **Exports**      | `index.ts`        | Public API surface                                   |

## KEY EXPORTS

```typescript
// Reading threads
readThread(client, target, botLogin, logger) // Read full thread with comments
findBotComment(thread, botLogin) // Find most recent bot comment

// Writing comments
postComment(client, target, options, logger) // Create or update comment
isBotComment(body) // Check if body has BOT_COMMENT_MARKER

// Error formatting
formatErrorComment(error) // Format error as markdown
createErrorInfo(type, message, retryable, opts) // Create error info
createRateLimitError(message, resetTime) // Rate limit error helper
createLLMTimeoutError(message) // LLM timeout error helper

// Re-exported from github/types.ts
BOT_COMMENT_MARKER // HTML comment for bot identification
```

## PATTERNS

- **Dual ID types**: REST returns `number` IDs, GraphQL returns `string` Node IDs
- **Bot detection**: Checks BOTH author AND marker (security against marker copying)
- **Pagination safety**: Max 50 pages to prevent infinite loops
- **Non-fatal operations**: All API calls catch errors and return null/false
- **Logger injection**: All functions take `logger: Logger` as parameter
- **Idempotent updates**: `postComment` with `updateExisting: true` updates latest bot comment

## DATA FLOW

```
postComment(client, target, options, logger)
  │
  ├─→ target.type === 'discussion'
  │     ├─ readThread() → findBotComment() [if updateExisting]
  │     └─ GraphQL mutation (add or update)
  │
  └─→ target.type === 'issue' | 'pr'
        ├─ readThread() → findBotComment() [if updateExisting]
        └─ REST API (create or update)
```

## ANTI-PATTERNS

| Forbidden                    | Reason                                         |
| ---------------------------- | ---------------------------------------------- |
| Trusting marker alone        | Users can copy marker; always check author too |
| Unbounded pagination         | Use MAX_PAGES limit to prevent infinite loops  |
| Throwing on API errors       | Return null and log warning; non-fatal         |
| Using numeric ID for GraphQL | Discussion comments use string Node IDs        |
| Logging full Node IDs        | Treat as sensitive identifiers                 |

## INTEGRATION NOTES

- **Reactions**: Use `src/lib/agent/reactions.ts` for emoji/label operations (RFC-008 F43)
- **Run Summary**: Use `src/lib/observability/run-summary.ts` for comment summaries
- **Workflows need**: `discussions: write` permission for discussion comments
