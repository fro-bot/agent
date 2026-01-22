import type {Octokit} from '../github/types.js'
import type {Logger} from '../logger.js'
import type {ContextBudget, IssueContext} from './types.js'
import {truncateBody} from './budget.js'
import {executeIssueQuery} from './graphql.js'

export async function hydrateIssueContext(
  client: Octokit,
  owner: string,
  repo: string,
  number: number,
  budget: ContextBudget,
  logger: Logger,
): Promise<IssueContext | null> {
  const response = await executeIssueQuery(client, owner, repo, number, budget.maxComments, logger)

  if (response == null) {
    return null
  }

  const issue = response.repository.issue
  if (issue == null) {
    logger.debug('Issue not found', {owner, repo, number})
    return null
  }

  const bodyResult = truncateBody(issue.body ?? '', budget.maxBodyBytes)

  const allComments = issue.comments.nodes
  const limitedComments = allComments.slice(0, budget.maxComments)
  const commentsTruncated = issue.comments.totalCount > limitedComments.length

  const comments = limitedComments.map(c => ({
    id: c.id,
    author: c.author?.login ?? null,
    body: c.body,
    createdAt: c.createdAt,
    authorAssociation: c.authorAssociation,
    isMinimized: c.isMinimized,
  }))

  const labels = issue.labels.nodes.map(l => ({
    name: l.name,
    color: l.color,
  }))

  const assignees = issue.assignees.nodes.map(a => ({
    login: a.login,
  }))

  return {
    type: 'issue',
    number: issue.number,
    title: issue.title,
    body: bodyResult.text,
    bodyTruncated: bodyResult.truncated,
    state: issue.state,
    author: issue.author?.login ?? null,
    createdAt: issue.createdAt,
    labels,
    assignees,
    comments,
    commentsTruncated,
    totalComments: issue.comments.totalCount,
  }
}
