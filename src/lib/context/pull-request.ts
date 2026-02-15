import type {Octokit} from '../github/types.js'
import type {Logger} from '../logger.js'
import type {ContextBudget, PullRequestContext} from './types.js'
import {truncateBody} from './budget.js'
import {executePullRequestQuery} from './graphql.js'

export async function hydratePullRequestContext(
  client: Octokit,
  owner: string,
  repo: string,
  number: number,
  budget: ContextBudget,
  logger: Logger,
): Promise<PullRequestContext | null> {
  const response = await executePullRequestQuery(
    client,
    owner,
    repo,
    number,
    budget.maxComments,
    budget.maxCommits,
    budget.maxFiles,
    budget.maxReviews,
    logger,
  )

  if (response == null) {
    return null
  }

  const pr = response.repository.pullRequest
  if (pr == null) {
    logger.debug('Pull request not found', {owner, repo, number})
    return null
  }

  const bodyResult = truncateBody(pr.body ?? '', budget.maxBodyBytes)

  const baseOwner = pr.baseRepository?.owner.login
  const headOwner = pr.headRepository?.owner.login
  const isFork = headOwner == null || baseOwner !== headOwner

  const allComments = pr.comments.nodes
  const limitedComments = allComments.slice(0, budget.maxComments)
  const commentsTruncated = pr.comments.totalCount > limitedComments.length

  const comments = limitedComments.map(c => ({
    id: c.id,
    author: c.author?.login ?? null,
    body: c.body,
    createdAt: c.createdAt,
    authorAssociation: c.authorAssociation,
    isMinimized: c.isMinimized,
  }))

  const allCommits = pr.commits.nodes
  const limitedCommits = allCommits.slice(0, budget.maxCommits)
  const commitsTruncated = pr.commits.totalCount > limitedCommits.length

  const commits = limitedCommits.map(c => ({
    oid: c.commit.oid,
    message: c.commit.message,
    author: c.commit.author?.name ?? null,
  }))

  const allFiles = pr.files.nodes
  const limitedFiles = allFiles.slice(0, budget.maxFiles)
  const filesTruncated = pr.files.totalCount > limitedFiles.length

  const files = limitedFiles.map(f => ({
    path: f.path,
    additions: f.additions,
    deletions: f.deletions,
  }))

  const allReviews = pr.reviews.nodes
  const limitedReviews = allReviews.slice(0, budget.maxReviews)
  const reviewsTruncated = pr.reviews.totalCount > limitedReviews.length

  const reviews = limitedReviews.map(r => ({
    author: r.author?.login ?? null,
    state: r.state,
    body: r.body,
    createdAt: r.createdAt,
    comments: r.comments.nodes.map(c => ({
      id: c.id,
      author: c.author?.login ?? null,
      body: c.body,
      path: c.path,
      line: c.line,
      createdAt: c.createdAt,
    })),
  }))

  const labels = pr.labels.nodes.map(l => ({
    name: l.name,
    color: l.color,
  }))

  const assignees = pr.assignees.nodes.map(a => ({
    login: a.login,
  }))

  const requestedReviewers = pr.reviewRequests.nodes
    .map(r => ('login' in r.requestedReviewer ? r.requestedReviewer.login : null))
    .filter((login): login is string => login != null)

  const requestedReviewerTeams = pr.reviewRequests.nodes
    .map(r => ('name' in r.requestedReviewer ? r.requestedReviewer.name : null))
    .filter((name): name is string => name != null)

  return {
    type: 'pull_request',
    number: pr.number,
    title: pr.title,
    body: bodyResult.text,
    bodyTruncated: bodyResult.truncated,
    state: pr.state,
    author: pr.author?.login ?? null,
    createdAt: pr.createdAt,
    baseBranch: pr.baseRefName,
    headBranch: pr.headRefName,
    isFork,
    labels,
    assignees,
    comments,
    commentsTruncated,
    totalComments: pr.comments.totalCount,
    commits,
    commitsTruncated,
    totalCommits: pr.commits.totalCount,
    files,
    filesTruncated,
    totalFiles: pr.files.totalCount,
    reviews,
    reviewsTruncated,
    totalReviews: pr.reviews.totalCount,
    authorAssociation: pr.authorAssociation,
    requestedReviewers,
    requestedReviewerTeams,
  }
}
