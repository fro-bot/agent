import type {Octokit} from '../github/types.js'
import type {Logger} from '../logger.js'
import type {
  ExistingReviewComment,
  GitHubReviewComment,
  PRDiff,
  PreparedReviewComments,
  ReviewComment,
  ReviewResult,
  SkippedReviewComment,
  SubmitReviewOptions,
} from './types.js'
import {getPRDiff} from './diff.js'

/**
 * Prepares review comments for submission by validating file existence and patch availability.
 *
 * Separates ready-to-post comments from skipped ones to provide visibility into
 * which comments couldn't be posted and why. This separation is critical for debugging
 * review failures and understanding limitations when patch data is unavailable.
 */
export function prepareReviewComments(
  comments: readonly ReviewComment[],
  diff: PRDiff,
  logger: Logger,
): PreparedReviewComments {
  const ready: GitHubReviewComment[] = []
  const skipped: SkippedReviewComment[] = []

  for (const comment of comments) {
    const file = diff.files.find(f => f.filename === comment.path)

    if (file == null) {
      logger.warning('File not in diff, skipping comment', {path: comment.path})
      skipped.push({comment, reason: 'file_not_in_diff'})
      continue
    }

    if (file.patch == null) {
      logger.warning('File has no patch, skipping comment', {path: comment.path})
      skipped.push({comment, reason: 'patch_missing'})
      continue
    }

    const reviewComment: GitHubReviewComment = {
      path: comment.path,
      body: comment.body,
      line: comment.line,
      side: comment.side,
    }

    if (comment.startLine != null && comment.startLine !== comment.line) {
      reviewComment.start_line = comment.startLine
      reviewComment.start_side = comment.startSide ?? comment.side
    }

    ready.push(reviewComment)
  }

  return {ready, skipped}
}

/**
 * Submits a PR review with optional line-level comments.
 *
 * Uses the modern GitHub REST API createReview endpoint which allows submitting
 * a review with all comments atomically. This is preferred over posting individual
 * comments as it groups them under a single review event.
 */
export async function submitReview(
  octokit: Octokit,
  options: SubmitReviewOptions,
  logger: Logger,
): Promise<ReviewResult> {
  const {prNumber, owner, repo, event, body, comments} = options

  logger.info('Submitting review', {
    prNumber,
    event,
    commentCount: comments.length,
  })

  const diff = await getPRDiff(octokit, owner, repo, prNumber, logger)
  const prepared = prepareReviewComments(comments, diff, logger)

  const {data} = await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: prNumber,
    event,
    body,
    comments: prepared.ready.map(c => ({
      path: c.path,
      body: c.body,
      line: c.line,
      side: c.side,
      start_line: c.start_line,
      start_side: c.start_side,
    })),
  })

  logger.info('Review submitted', {
    reviewId: data.id,
    state: data.state,
    commentsPosted: prepared.ready.length,
    commentsSkipped: prepared.skipped.length,
  })

  return {
    reviewId: data.id,
    state: data.state ?? '',
    commentsPosted: prepared.ready.length,
    commentsSkipped: prepared.skipped.length,
    url: data.html_url ?? '',
  }
}

/**
 * Posts a standalone review comment on a specific line.
 *
 * Unlike submitReview which posts multiple comments atomically as part of a review,
 * this function posts individual comments. Useful for responding to specific lines
 * outside of a full review workflow or when adding follow-up comments.
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
  logger.debug('Posting review comment', {
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
 * Fetches all existing review comments on a PR.
 *
 * Returns structured data including comment IDs and reply threading info,
 * enabling the agent to understand conversation context and reply appropriately
 * to specific review threads.
 */
export async function getReviewComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  logger: Logger,
): Promise<readonly ExistingReviewComment[]> {
  logger.debug('Fetching review comments', {prNumber})

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
    author: comment.user?.login ?? 'unknown',
    inReplyToId: comment.in_reply_to_id ?? null,
  }))
}

/**
 * Replies to an existing review comment, creating a threaded conversation.
 *
 * GitHub's review system supports threaded discussions where replies are linked
 * to parent comments. This maintains conversation context and prevents orphaned responses.
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
  logger.debug('Replying to review comment', {prNumber, commentId})

  const {data} = await octokit.rest.pulls.createReplyForReviewComment({
    owner,
    repo,
    pull_number: prNumber,
    comment_id: commentId,
    body,
  })

  return data.id
}
