# RFC-009: PR Review Features

**Status:** Pending
**Priority:** MUST
**Complexity:** High
**Phase:** 3

---

## Summary

Implement PR-specific features: reading diffs, posting line-level review comments, and submitting reviews. This enables the agent to provide actionable code review feedback.

## Dependencies

- **Builds Upon:** RFC-003 (GitHub Client), RFC-008 (Comments)
- **Enables:** RFC-010 (Delegated Work)

## Features Addressed

| Feature ID | Feature Name       | Priority |
| ---------- | ------------------ | -------- |
| F5         | PR Review Comments | P0       |

## Technical Specification

### 1. File Structure

```
src/lib/
├── reviews/
│   ├── types.ts          # Review-related types
│   ├── diff.ts           # Diff parsing and analysis
│   ├── reviewer.ts       # Review operations
│   └── index.ts          # Public exports
```

### 2. Review Types (`src/lib/reviews/types.ts`)

```typescript
export interface PRDiff {
  readonly files: readonly DiffFile[]
  readonly additions: number
  readonly deletions: number
  readonly changedFiles: number
}

export interface DiffFile {
  readonly filename: string
  readonly status: "added" | "removed" | "modified" | "renamed" | "copied"
  readonly additions: number
  readonly deletions: number
  readonly patch: string | null
  readonly previousFilename: string | null
}

export interface DiffHunk {
  readonly startLine: number
  readonly lineCount: number
  readonly content: string
}

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT"

export interface ReviewComment {
  readonly path: string
  readonly line: number
  readonly side: "LEFT" | "RIGHT"
  readonly body: string
  /** For multi-line comments: the first line of the range (inclusive) */
  readonly startLine?: number
  /** For multi-line comments: the side for start_line (defaults to `side` if not specified) */
  readonly startSide?: "LEFT" | "RIGHT"
}

export interface SubmitReviewOptions {
  readonly prNumber: number
  readonly owner: string
  readonly repo: string
  readonly event: ReviewEvent
  readonly body: string
  readonly comments: readonly ReviewComment[]
}

export interface ReviewResult {
  readonly reviewId: number
  readonly state: string
  readonly commentsPosted: number
  readonly url: string
}
```

### 3. Diff Parsing (`src/lib/reviews/diff.ts`)

```typescript
import type {Octokit} from "../github/types.js"
import type {PRDiff, DiffFile, DiffHunk, Logger} from "./types.js"

/**
 * Fetch PR diff with file contents.
 */
export async function getPRDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  logger: Logger,
): Promise<PRDiff> {
  logger.debug("Fetching PR diff", {prNumber})

  const {data} = await octokit.rest.pulls.listFiles({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  })

  const files: DiffFile[] = data.map(file => ({
    filename: file.filename,
    status: file.status as DiffFile["status"],
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch ?? null,
    previousFilename: file.previous_filename ?? null,
  }))

  const totals = files.reduce(
    (acc, file) => ({
      additions: acc.additions + file.additions,
      deletions: acc.deletions + file.deletions,
    }),
    {additions: 0, deletions: 0},
  )

  logger.debug("Fetched diff", {
    files: files.length,
    additions: totals.additions,
    deletions: totals.deletions,
  })

  return {
    files,
    additions: totals.additions,
    deletions: totals.deletions,
    changedFiles: files.length,
  }
}

/**
 * Parse hunks from a patch string.
 */
export function parseHunks(patch: string): readonly DiffHunk[] {
  const hunks: DiffHunk[] = []
  const lines = patch.split("\n")
  let currentHunk: {startLine: number; lineCount: number; content: string[]} | null = null

  for (const line of lines) {
    // Hunk header: @@ -start,count +start,count @@
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)

    if (hunkMatch != null) {
      // Save previous hunk
      if (currentHunk != null) {
        hunks.push({
          startLine: currentHunk.startLine,
          lineCount: currentHunk.lineCount,
          content: currentHunk.content.join("\n"),
        })
      }

      // Start new hunk
      currentHunk = {
        startLine: Number.parseInt(hunkMatch[1], 10),
        lineCount: hunkMatch[2] != null ? Number.parseInt(hunkMatch[2], 10) : 1,
        content: [line],
      }
    } else if (currentHunk != null) {
      currentHunk.content.push(line)
    }
  }

  // Save last hunk
  if (currentHunk != null) {
    hunks.push({
      startLine: currentHunk.startLine,
      lineCount: currentHunk.lineCount,
      content: currentHunk.content.join("\n"),
    })
  }

  return hunks
}

/**
 * Calculate the line number in the diff for a review comment.
 */
export function calculateDiffPosition(patch: string, targetLine: number): number | null {
  const lines = patch.split("\n")
  let currentLine = 0
  let position = 0

  for (const line of lines) {
    position++

    // Skip hunk headers
    if (line.startsWith("@@")) {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line)
      if (match != null) {
        currentLine = Number.parseInt(match[1], 10) - 1
      }
      continue
    }

    // Deleted lines don't affect line count
    if (line.startsWith("-")) {
      continue
    }

    // Added lines or context lines
    currentLine++

    if (currentLine === targetLine) {
      return position
    }
  }

  return null
}

/**
 * Get file content at a specific ref.
 */
export async function getFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
  logger: Logger,
): Promise<string | null> {
  try {
    const {data} = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref,
    })

    if ("content" in data && data.content != null) {
      return Buffer.from(data.content, "base64").toString("utf8")
    }

    return null
  } catch {
    logger.debug("File not found", {path, ref})
    return null
  }
}
```

### 4. Review Operations (`src/lib/reviews/reviewer.ts`)

```typescript
import type {Octokit} from "../github/types.js"
import type {SubmitReviewOptions, ReviewResult, ReviewComment, Logger} from "./types.js"
import {calculateDiffPosition, getPRDiff} from "./diff.js"

/**
 * Submit a PR review with optional line comments.
 */
export async function submitReview(
  octokit: Octokit,
  options: SubmitReviewOptions,
  logger: Logger,
): Promise<ReviewResult> {
  const {prNumber, owner, repo, event, body, comments} = options

  logger.info("Submitting review", {
    prNumber,
    event,
    commentCount: comments.length,
  })

  // Prepare comments with positions
  const diff = await getPRDiff(octokit, owner, repo, prNumber, logger)
  const preparedComments = await prepareReviewComments(comments, diff, logger)

  const {data} = await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: prNumber,
    event,
    body,
    comments: preparedComments,
  })

  logger.info("Review submitted", {
    reviewId: data.id,
    state: data.state,
  })

  return {
    reviewId: data.id,
    state: data.state ?? "",
    commentsPosted: preparedComments.length,
    url: data.html_url ?? "",
  }
}

/**
 * GitHub API review comment structure for createReview.
 *
 * Per GitHub REST API docs (pulls.createReview):
 * https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request
 *
 * For review comments attached to a review:
 * - `path`: Required. The relative path of the file to comment on.
 * - `body`: Required. Text of the review comment.
 * - `line`: The line of the blob in the pull request diff that the comment applies to.
 *           For multi-line comments, the last line of the range.
 * - `side`: Which side of the diff the comment applies to.
 *           "LEFT" = base (deletion side), "RIGHT" = head (addition side).
 *           Default is "RIGHT".
 * - `start_line`: For multi-line comments, the first line of the range.
 * - `start_side`: For multi-line comments, the side for start_line.
 *
 * Note: For `createReview`, comments use `line` (the actual line number in the file).
 * The deprecated `position` parameter (diff hunk position) is NOT used here.
 */
interface GitHubReviewComment {
  path: string
  body: string
  line: number
  side?: "LEFT" | "RIGHT"
  start_line?: number
  start_side?: "LEFT" | "RIGHT"
}

/**
 * Prepare review comments with correct line positions.
 */
async function prepareReviewComments(
  comments: readonly ReviewComment[],
  diff: PRDiff,
  logger: Logger,
): Promise<GitHubReviewComment[]> {
  const prepared: GitHubReviewComment[] = []

  for (const comment of comments) {
    const file = diff.files.find(f => f.filename === comment.path)

    if (file == null) {
      logger.warning("File not in diff, skipping comment", {path: comment.path})
      continue
    }

    if (file.patch == null) {
      logger.warning("File has no patch, skipping comment", {path: comment.path})
      continue
    }

    // Build the comment object
    // Note: `side` defaults to "RIGHT" if not specified in the API
    const reviewComment: GitHubReviewComment = {
      path: comment.path,
      body: comment.body,
      line: comment.line,
      side: comment.side,
    }

    // For multi-line comments, include start_line and start_side
    // Multi-line comments span from start_line to line (inclusive)
    if (comment.startLine != null && comment.startLine !== comment.line) {
      reviewComment.start_line = comment.startLine
      reviewComment.start_side = comment.startSide ?? comment.side
    }

    prepared.push(reviewComment)
  }

  return prepared
}

/**
 * Post a single review comment on a specific line.
 *
 * Note: createReviewComment requires `commit_id` and uses `position` (diff position)
 * or the newer `line` + `side` parameters. We use `line` + `side` as recommended.
 *
 * Per GitHub docs: https://docs.github.com/en/rest/pulls/comments#create-a-review-comment-for-a-pull-request
 */
export async function postReviewComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  commitSha: string,
  comment: ReviewComment,
  logger: Logger,
): Promise<number> {
  logger.debug("Posting review comment", {
    prNumber,
    path: comment.path,
    line: comment.line,
  })

  const {data} = await octokit.rest.pulls.createReviewComment({
    owner,
    repo,
    pull_number: prNumber,
    commit_id: commitSha,
    path: comment.path,
    line: comment.line,
    side: comment.side,
    body: comment.body,
  })

  return data.id
}

/**
 * Get existing review comments on a PR.
 */
export async function getReviewComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  logger: Logger,
): Promise<
  readonly {
    id: number
    path: string
    line: number | null
    body: string
    author: string
  }[]
> {
  const {data} = await octokit.rest.pulls.listReviewComments({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  })

  return data.map(comment => ({
    id: comment.id,
    path: comment.path,
    line: comment.line ?? comment.original_line ?? null,
    body: comment.body,
    author: comment.user?.login ?? "unknown",
  }))
}

/**
 * Reply to an existing review comment.
 */
export async function replyToReviewComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  commentId: number,
  body: string,
  logger: Logger,
): Promise<number> {
  const {data} = await octokit.rest.pulls.createReplyForReviewComment({
    owner,
    repo,
    pull_number: prNumber,
    comment_id: commentId,
    body,
  })

  return data.id
}
```

### 5. Public Exports (`src/lib/reviews/index.ts`)

```typescript
export {getPRDiff, parseHunks, calculateDiffPosition, getFileContent} from "./diff.js"
export {submitReview, postReviewComment, getReviewComments, replyToReviewComment} from "./reviewer.js"

export type {
  PRDiff,
  DiffFile,
  DiffHunk,
  ReviewEvent,
  ReviewComment,
  SubmitReviewOptions,
  ReviewResult,
} from "./types.js"
```

## Acceptance Criteria

- [ ] PR diff is fetched with all changed files
- [ ] Diff patches are parsed into hunks correctly
- [ ] Line positions are calculated for review comments
- [ ] Reviews can be submitted with APPROVE, REQUEST_CHANGES, or COMMENT
- [ ] Review comments are attached to correct lines
- [ ] Large PRs (100+ files) are handled with pagination
- [ ] File content can be retrieved for context
- [ ] Existing review comments can be read
- [ ] Replies to review comments work correctly

## Test Cases

### Diff Tests

```typescript
describe("getPRDiff", () => {
  it("fetches all changed files", async () => {
    const diff = await getPRDiff(mockOctokit, "owner", "repo", 1, logger)
    expect(diff.files.length).toBeGreaterThan(0)
    expect(diff.changedFiles).toBe(diff.files.length)
  })

  it("calculates totals correctly", async () => {
    const diff = await getPRDiff(mockOctokit, "owner", "repo", 1, logger)
    const manualTotal = diff.files.reduce((sum, f) => sum + f.additions, 0)
    expect(diff.additions).toBe(manualTotal)
  })
})

describe("parseHunks", () => {
  it("parses single hunk", () => {
    const patch = `@@ -1,3 +1,4 @@
 line1
+new line
 line2
 line3`

    const hunks = parseHunks(patch)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].startLine).toBe(1)
  })

  it("parses multiple hunks", () => {
    const patch = `@@ -1,3 +1,3 @@
 context
-removed
+added
@@ -10,2 +10,3 @@
 more context
+another addition`

    const hunks = parseHunks(patch)
    expect(hunks).toHaveLength(2)
  })
})

describe("calculateDiffPosition", () => {
  it("finds correct position for added line", () => {
    const patch = `@@ -1,3 +1,4 @@
 line1
+new line
 line2
 line3`

    const position = calculateDiffPosition(patch, 2) // new line is at line 2
    expect(position).toBe(3) // Position 3 in the diff
  })

  it("returns null for line not in diff", () => {
    const patch = `@@ -1,3 +1,3 @@
 line1
 line2
 line3`

    const position = calculateDiffPosition(patch, 100)
    expect(position).toBeNull()
  })
})
```

### Review Tests

```typescript
describe("submitReview", () => {
  it("submits review with event type", async () => {
    const result = await submitReview(
      mockOctokit,
      {
        prNumber: 1,
        owner: "owner",
        repo: "repo",
        event: "COMMENT",
        body: "Review body",
        comments: [],
      },
      logger,
    )

    expect(result.state).toBe("COMMENTED")
  })

  it("attaches comments to correct files", async () => {
    const result = await submitReview(
      mockOctokit,
      {
        prNumber: 1,
        owner: "owner",
        repo: "repo",
        event: "COMMENT",
        body: "Review body",
        comments: [{path: "src/main.ts", line: 10, side: "RIGHT", body: "Comment"}],
      },
      logger,
    )

    expect(result.commentsPosted).toBe(1)
  })

  it("skips comments for files not in diff", async () => {
    const result = await submitReview(
      mockOctokit,
      {
        prNumber: 1,
        owner: "owner",
        repo: "repo",
        event: "COMMENT",
        body: "Review body",
        comments: [{path: "nonexistent.ts", line: 1, side: "RIGHT", body: "Comment"}],
      },
      logger,
    )

    expect(result.commentsPosted).toBe(0)
  })
})
```

## Implementation Notes

1. **Diff pagination**: GitHub limits to 3000 files; large PRs may need multiple calls
2. **Binary files**: No patch available; skip review comments
3. **Line mapping**: Complex for multi-line changes; single-line comments simpler
4. **Commit SHA**: Required for posting individual review comments

## Estimated Effort

- **Development**: 8-10 hours
- **Testing**: 4-5 hours
- **Total**: 12-15 hours
