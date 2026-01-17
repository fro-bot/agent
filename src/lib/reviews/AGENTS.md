# REVIEWS MODULE

**Scope:** PR diff parsing, review submission, and line-level review comments via GitHub API.

## WHERE TO LOOK

| Component    | File          | Purpose                                      |
| ------------ | ------------- | -------------------------------------------- |
| **Types**    | `types.ts`    | PRDiff, ReviewComment, SubmitReviewOptions   |
| **Diff**     | `diff.ts`     | Fetch PR diff, parse hunks, get file content |
| **Reviewer** | `reviewer.ts` | Submit reviews, post/get/reply to comments   |
| **Exports**  | `index.ts`    | Public API surface                           |

## KEY EXPORTS

```typescript
// Diff operations
getPRDiff(octokit, owner, repo, prNumber, logger)
getFileContent(octokit, owner, repo, path, ref, logger)

// Review operations
submitReview(octokit, options, logger)
postReviewComment(octokit, owner, repo, prNumber, commitSha, comment, logger)
getReviewComments(octokit, owner, repo, prNumber, logger)
replyToReviewComment(octokit, owner, repo, prNumber, commentId, body, logger)
prepareReviewComments(comments, diff, logger)

// Types
;(PRDiff, DiffFile, DiffHunk)
;(ReviewComment, ReviewEvent, ReviewResult)
;(SubmitReviewOptions, PreparedReviewComments)
;(ExistingReviewComment, SkippedReviewComment, SkipReason)
```

## PATTERNS

- **Bounded Pagination**: `getPRDiff` fetches up to MAX_PAGES (50) of 100 files each
- **Modern API**: Uses `line`/`side` parameters (not deprecated `position`)
- **Structured Skip Results**: `prepareReviewComments` returns `{ready, skipped}` with skip reasons
- **Logger Injection**: All functions take `logger: Logger` as last parameter
- **Null Patch Handling**: Binary files have `patch: null`; comments skipped with reason

## SKIP REASONS

| Reason             | Description                          |
| ------------------ | ------------------------------------ |
| `file_not_in_diff` | File path not found in PR diff       |
| `patch_missing`    | File has no patch (binary/too large) |

## ANTI-PATTERNS

| Forbidden                  | Reason                                      |
| -------------------------- | ------------------------------------------- |
| Using `position` parameter | Deprecated; use `line`/`side` instead       |
| Ignoring `truncated` flag  | Large PRs may have incomplete diff data     |
| Swallowing skip info       | Always return skipped comments with reasons |
| Unbounded pagination       | Use PAGINATION_CONFIG limits                |
