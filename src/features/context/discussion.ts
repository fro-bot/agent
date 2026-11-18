import type {Octokit} from '../../services/github/types.js'
import type {Logger} from '../../shared/logger.js'
import type {ContextBudget, DiscussionContext} from './types.js'
import {readThread} from '../comments/reader.js'
import {truncateBody} from './budget.js'

/**
 * Reads a discussion's body and top-level comments with the Action's own client, bounded like issue context.
 * Returns null when the thread cannot be read; the reader logs the cause.
 */
export async function hydrateDiscussionContext(
  client: Octokit,
  owner: string,
  repo: string,
  number: number,
  budget: ContextBudget,
  logger: Logger,
): Promise<DiscussionContext | null> {
  const thread = await readThread(client, {type: 'discussion', number, owner, repo}, null, logger)
  if (thread == null) {
    return null
  }

  const bodyResult = truncateBody(thread.body, budget.maxBodyBytes)
  const limitedComments = thread.comments.slice(Math.max(0, thread.comments.length - budget.maxComments))

  return {
    type: 'discussion',
    number: thread.number,
    title: thread.title,
    body: bodyResult.text,
    bodyTruncated: bodyResult.truncated,
    author: thread.author === 'unknown' ? null : thread.author,
    comments: limitedComments.map(c => ({id: String(c.id), author: c.author, body: c.body, createdAt: c.createdAt})),
    commentsTruncated: thread.comments.length > limitedComments.length,
    totalComments: thread.comments.length,
  }
}
