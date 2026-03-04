# REVIEWS MODULE

**Scope:** PR diff parsing, review submission, and line-level review comments via GitHub API.

## WHERE TO LOOK

| Component    | File          | Purpose                                      |
| ------------ | ------------- | -------------------------------------------- |
| **Types**    | `types.ts`    | PRDiff, ReviewComment, SubmitReviewOptions   |
| **Diff**     | `diff.ts`     | Fetch PR diff, parse hunks, get file content |
| **Reviewer** | `reviewer.ts` | Submit reviews, post/get/reply to comments   |

## KEY EXPORTS

```typescript
// Diff operations
getPRDiff(octokit, owner, repo, prNumber, logger)
getFileContent(octokit, owner, repo, path, ref, logger)
parseHunks(patch) // Parse diff chunks into startLine/lineCount

// Review operations
submitReview(octokit, options, logger)
postReviewComment(octokit, owner, repo, prNumber, commitSha, comment, logger)
getReviewComments(octokit, owner, repo, prNumber, logger)
replyToReviewComment(octokit, owner, repo, prNumber, commentId, body, logger)
prepareReviewComments(comments, diff, logger)

// Types & Constants
;(PRDiff, DiffFile, DiffHunk)
;(ReviewComment, ReviewEvent, ReviewResult)
;(SubmitReviewOptions, PreparedReviewComments)
;(ExistingReviewComment, SkippedReviewComment, SkipReason)
;(PAGINATION_CONFIG, REVIEW_EVENTS, SKIP_REASONS)
```

## PATTERNS

- **Bounded Pagination**: `getPRDiff` uses `PAGINATION_CONFIG` (max 50 pages of 100 files).
- **Modern API**: Uses `line`/`side` (addition=RIGHT, deletion=LEFT) instead of `position`.
- **Atomic Submission**: `submitReview` uses `createReview` to post all comments at once.
- **Skip Transparency**: `prepareReviewComments` returns `{ready, skipped}` with reasons.
- **Safe I/O**: `getFileContent` returns `null` on 404 instead of throwing.

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
| Manual patch parsing       | Use `parseHunks` for unified diff handling  |
| Unbounded API calls        | Respect `PAGINATION_CONFIG` limits          |
