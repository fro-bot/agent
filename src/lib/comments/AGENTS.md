# COMMENTS MODULE

**Scope:** GitHub comment interactions for issues, PRs, and discussions (RFC-008).

## WHERE TO LOOK

| Component        | File              | Purpose                                               |
| ---------------- | ----------------- | ----------------------------------------------------- |
| **Types**        | `types.ts`        | ThreadComment, Thread, ErrorInfo, PostCommentResult   |
| **Reader**       | `reader.ts`       | `readThread()`, `findBotComment()`, pagination (257L) |
| **Writer**       | `writer.ts`       | `postComment()`, `isBotComment()`, GraphQL mutations  |
| **Error Format** | `error-format.ts` | `formatErrorComment()`, error creation helpers        |
| **Exports**      | `index.ts`        | Public API surface                                    |

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
BOT_COMMENT_MARKER // HTML comment for identification
```

## PATTERNS

- **Dual ID types**: REST (Issue/PR) uses `number`; GraphQL (Discussion) uses `string` Node ID.
- **Bot detection**: Verify BOTH author (`botLogin` or `botLogin[bot]`) AND `BOT_COMMENT_MARKER`.
- **Pagination safety**: Enforced `MAX_PAGES = 50` limit to prevent infinite loops.
- **Non-fatal operations**: All API calls catch errors, log warnings, and return `null`.
- **Idempotent updates**: `postComment` with `updateExisting` replaces latest bot comment.
- **Visual Severity Mapping**: ErrorType maps to emojis (⚠️ `rate_limit`, ⏳ `llm_timeout`, ❌ others).

## DATA FLOW

```
postComment(client, target, options, logger)
  │
  ├─→ target.type === 'discussion' (GraphQL)
  │     ├─ readThread() → findBotComment() [if updateExisting]
  │     └─ mutation: addDiscussionComment | updateDiscussionComment
  │
  └─→ target.type === 'issue' | 'pr' (REST)
        ├─ readThread() → findBotComment() [if updateExisting]
        └─ rest.issues: createComment | updateComment
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

- **Reactions**: Use `src/lib/agent/reactions.ts` for emoji/label operations.
- **Run Summary**: Use `src/lib/observability/run-summary.ts` for comment summaries.
- **Permissions**: Discussions require `discussions: write` in workflow.
