import type {CommentTarget, Octokit} from '../github/types.js'
import type {Logger} from '../logger.js'
import type {DiscussionQueryResponse, Thread, ThreadComment} from './types.js'
import {toErrorMessage} from '../../utils/errors.js'
import {BOT_COMMENT_MARKER} from '../github/types.js'

const MAX_PAGES = 50
const PER_PAGE = 100

/**
 * Check if author matches bot login (with or without [bot] suffix).
 */
function isBotAuthor(author: string, botLogin: string | null): boolean {
  if (botLogin == null) return false
  return author === botLogin || author === `${botLogin}[bot]`
}

/**
 * Verify comment is from bot by checking BOTH author AND marker.
 * Security: Prevents users from copying marker to impersonate bot.
 */
function checkIsBot(author: string, body: string, botLogin: string | null): boolean {
  return isBotAuthor(author, botLogin) && body.includes(BOT_COMMENT_MARKER)
}

/**
 * Fetch issue or PR metadata using appropriate REST endpoint.
 * PRs and issues share the issues API but PRs need pulls.get for full data.
 */
async function fetchIssueOrPR(
  client: Octokit,
  target: CommentTarget,
  logger: Logger,
): Promise<{title: string; body: string; author: string} | null> {
  try {
    if (target.type === 'pr') {
      const {data} = await client.rest.pulls.get({
        owner: target.owner,
        repo: target.repo,
        pull_number: target.number,
      })
      return {
        title: data.title,
        body: data.body ?? '',
        author: data.user?.login ?? 'unknown',
      }
    }
    const {data} = await client.rest.issues.get({
      owner: target.owner,
      repo: target.repo,
      issue_number: target.number,
    })
    return {
      title: data.title,
      body: data.body ?? '',
      author: data.user?.login ?? 'unknown',
    }
  } catch (error) {
    logger.warning('Failed to fetch issue/PR', {
      target,
      error: toErrorMessage(error),
    })
    return null
  }
}

/**
 * Fetch all comments with pagination.
 * MAX_PAGES limit prevents infinite loops on malformed API responses.
 */
async function fetchAllComments(
  client: Octokit,
  target: CommentTarget,
  botLogin: string | null,
  logger: Logger,
): Promise<ThreadComment[]> {
  const comments: ThreadComment[] = []
  let page = 1

  while (page <= MAX_PAGES) {
    try {
      const {data} = await client.rest.issues.listComments({
        owner: target.owner,
        repo: target.repo,
        issue_number: target.number,
        per_page: PER_PAGE,
        page,
      })

      if (data.length === 0) break

      for (const c of data) {
        const author = c.user?.login ?? 'unknown'
        comments.push({
          id: c.id,
          body: c.body ?? '',
          author,
          authorAssociation: c.author_association ?? 'NONE',
          createdAt: c.created_at,
          updatedAt: c.updated_at,
          isBot: checkIsBot(author, c.body ?? '', botLogin),
        })
      }

      if (data.length < PER_PAGE) break
      page++
    } catch (error) {
      logger.warning('Failed to fetch comments page', {
        target,
        page,
        error: toErrorMessage(error),
      })
      break
    }
  }

  return comments
}

const DISCUSSION_QUERY = `
  query GetDiscussion($owner: String!, $repo: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      discussion(number: $number) {
        id
        title
        body
        author { login }
        comments(first: 100, after: $after) {
          nodes {
            id
            body
            author { login }
            createdAt
            updatedAt
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`

/**
 * Fetch discussion thread using GraphQL.
 * Discussions API is GraphQL-only (no REST endpoint available).
 */
async function fetchDiscussionThread(
  client: Octokit,
  target: CommentTarget,
  botLogin: string | null,
  logger: Logger,
): Promise<Thread | null> {
  try {
    const comments: ThreadComment[] = []
    let after: string | null = null
    let discussionId: string | null = null
    let title = ''
    let body = ''
    let author = 'unknown'
    let pageCount = 0

    while (pageCount < MAX_PAGES) {
      const result: DiscussionQueryResponse = await client.graphql<DiscussionQueryResponse>(DISCUSSION_QUERY, {
        owner: target.owner,
        repo: target.repo,
        number: target.number,
        after,
      })

      const discussion: DiscussionQueryResponse['repository']['discussion'] = result.repository.discussion
      if (discussion == null) {
        logger.debug('Discussion not found', {target})
        return null
      }

      if (pageCount === 0) {
        discussionId = discussion.id
        title = discussion.title
        body = discussion.body
        author = discussion.author?.login ?? 'unknown'
      }

      for (const c of discussion.comments.nodes) {
        const commentAuthor = c.author?.login ?? 'unknown'
        comments.push({
          id: c.id,
          body: c.body,
          author: commentAuthor,
          authorAssociation: 'NONE',
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          isBot: checkIsBot(commentAuthor, c.body, botLogin),
        })
      }

      if (!discussion.comments.pageInfo.hasNextPage) break
      after = discussion.comments.pageInfo.endCursor
      pageCount++
    }

    return {
      type: 'discussion',
      number: target.number,
      title,
      body,
      author,
      comments,
      discussionId: discussionId ?? undefined,
    }
  } catch (error) {
    logger.warning('Failed to fetch discussion', {
      target,
      error: toErrorMessage(error),
    })
    return null
  }
}

export async function readThread(
  client: Octokit,
  target: CommentTarget,
  botLogin: string | null,
  logger: Logger,
): Promise<Thread | null> {
  if (target.type === 'discussion') {
    return fetchDiscussionThread(client, target, botLogin, logger)
  }

  const issueData = await fetchIssueOrPR(client, target, logger)
  if (issueData == null) return null

  const comments = await fetchAllComments(client, target, botLogin, logger)

  return {
    type: target.type,
    number: target.number,
    title: issueData.title,
    body: issueData.body,
    author: issueData.author,
    comments,
  }
}

/**
 * Find most recent bot comment in thread.
 * Returns last comment to support idempotent updates.
 */
export function findBotComment(thread: Thread, botLogin: string): ThreadComment | null {
  const botComments = thread.comments.filter(
    c => isBotAuthor(c.author, botLogin) && c.body.includes(BOT_COMMENT_MARKER),
  )
  if (botComments.length === 0) return null
  return botComments.at(-1) ?? null
}
