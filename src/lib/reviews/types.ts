/**
 * Review Types (RFC-009)
 *
 * Type definitions for PR review features including diff parsing,
 * review comments, and review submission.
 */

// Pagination constants (per Oracle recommendation)
export const PAGINATION_CONFIG = {
  /** Maximum items per API page */
  PER_PAGE: 100,
  /** Maximum pages to fetch (bounded pagination) */
  MAX_PAGES: 50,
} as const

/**
 * Complete PR diff information including all changed files.
 */
export interface PRDiff {
  readonly files: readonly DiffFile[]
  readonly additions: number
  readonly deletions: number
  readonly changedFiles: number
  /** True if pagination limit was hit (may be incomplete) */
  readonly truncated: boolean
}

/**
 * Information about a single changed file in a PR.
 */
export interface DiffFile {
  readonly filename: string
  readonly status: 'added' | 'copied' | 'modified' | 'removed' | 'renamed'
  readonly additions: number
  readonly deletions: number
  /** Patch content (null for binary files or truncated diffs) */
  readonly patch: string | null
  readonly previousFilename: string | null
}

/**
 * Parsed hunk from a diff patch.
 * Represents a contiguous block of changes.
 */
export interface DiffHunk {
  /** Starting line number in the new file (RIGHT side) */
  readonly startLine: number
  /** Number of lines in this hunk (new file) */
  readonly lineCount: number
  /** Raw hunk content including header */
  readonly content: string
}

/**
 * GitHub review event types.
 */
export const REVIEW_EVENTS = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'] as const
export type ReviewEvent = (typeof REVIEW_EVENTS)[number]

/**
 * A review comment to be posted on a specific line.
 *
 * Uses the modern GitHub API with `line`/`side` parameters
 * (not the deprecated `position` parameter).
 */
export interface ReviewComment {
  /** Path to the file being commented on */
  readonly path: string
  /** Line number in the file (for multi-line: the last line) */
  readonly line: number
  /** Which side of the diff: LEFT (base/deletion) or RIGHT (head/addition) */
  readonly side: 'LEFT' | 'RIGHT'
  /** Comment body (markdown) */
  readonly body: string
  /** For multi-line comments: the first line of the range (inclusive) */
  readonly startLine?: number
  /** For multi-line comments: the side for start_line (defaults to `side` if not specified) */
  readonly startSide?: 'LEFT' | 'RIGHT'
}

/**
 * Options for submitting a PR review.
 */
export interface SubmitReviewOptions {
  readonly prNumber: number
  readonly owner: string
  readonly repo: string
  readonly event: ReviewEvent
  readonly body: string
  readonly comments: readonly ReviewComment[]
  /** Commit SHA for the review (uses PR head if not specified) */
  readonly commitSha?: string
}

/**
 * Result of a review submission.
 */
export interface ReviewResult {
  readonly reviewId: number
  readonly state: string
  readonly commentsPosted: number
  readonly commentsSkipped: number
  readonly url: string
}

/**
 * Reasons why a review comment was skipped.
 */
export const SKIP_REASONS = ['file_not_in_diff', 'patch_missing', 'line_not_in_hunks'] as const
export type SkipReason = (typeof SKIP_REASONS)[number]

/**
 * A review comment that was skipped during preparation.
 */
export interface SkippedReviewComment {
  readonly comment: ReviewComment
  readonly reason: SkipReason
}

/**
 * Result of preparing review comments.
 * Separates ready-to-post comments from skipped ones.
 */
export interface PreparedReviewComments {
  readonly ready: readonly GitHubReviewComment[]
  readonly skipped: readonly SkippedReviewComment[]
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
export interface GitHubReviewComment {
  path: string
  body: string
  line: number
  side?: 'LEFT' | 'RIGHT'
  start_line?: number
  start_side?: 'LEFT' | 'RIGHT'
}

/**
 * An existing review comment fetched from a PR.
 */
export interface ExistingReviewComment {
  readonly id: number
  readonly path: string
  readonly line: number | null
  readonly body: string
  readonly author: string
  readonly inReplyToId: number | null
}
