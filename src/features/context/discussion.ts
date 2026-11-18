import type {Octokit} from '../../services/github/types.js'
import type {Logger} from '../../shared/logger.js'
import type {ContextBudget, DiscussionContext} from './types.js'
import {truncateBody} from './budget.js'
import {executeDiscussionQuery} from './graphql.js'

/**
 * Reads a discussion's body and its newest top-level comments with the Action's own client, bounded like issue
 * context. Returns null when the query fails or the discussion is not found.
 */
export async function hydrateDiscussionContext(
  client: Octokit,
  owner: string,
  repo: string,
  number: number,
  budget: ContextBudget,
  logger: Logger,
): Promise<DiscussionContext | null> {
  const response = await executeDiscussionQuery(client, owner, repo, number, budget.maxComments, logger)
  if (response == null) {
    return null
  }

  const discussion = response.repository.discussion
  if (discussion == null) {
    logger.debug('Discussion not found', {owner, repo, number})
    return null
  }

  const bodyResult = truncateBody(discussion.body, budget.maxBodyBytes)
  const comments = discussion.comments.nodes.map(c => ({
    id: c.id,
    author: c.author?.login ?? null,
    body: c.body,
    createdAt: c.createdAt,
  }))

  return {
    type: 'discussion',
    number: discussion.number,
    title: discussion.title,
    body: bodyResult.text,
    bodyTruncated: bodyResult.truncated,
    author: discussion.author?.login ?? null,
    comments,
    commentsTruncated: discussion.comments.totalCount > comments.length,
    totalComments: discussion.comments.totalCount,
  }
}
