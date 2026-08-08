import type {Octokit} from '../../services/github/types.js'
import type {Logger} from '../../shared/logger.js'
import type {ContextBudget, IssueContext, PullRequestContext} from './types.js'
import {toErrorMessage} from '../../shared/errors.js'
import {truncateBody} from './budget.js'

const REST_PAGE_SIZE = 100
const REST_MAX_PAGES = 50

async function fetchRestCollection<T>(
  fetchPage: (page: number, perPage: number) => Promise<readonly T[]>,
  collection: string,
  logger: Logger,
): Promise<readonly T[]> {
  const items: T[] = []

  for (let page = 1; page <= REST_MAX_PAGES; page++) {
    const pageItems = await fetchPage(page, REST_PAGE_SIZE)
    items.push(...pageItems)

    if (pageItems.length < REST_PAGE_SIZE) {
      return items
    }
  }

  logger.warning('REST collection pagination limit reached', {
    collection,
    maxPages: REST_MAX_PAGES,
  })
  return items
}

export async function fallbackIssueContext(
  client: Octokit,
  owner: string,
  repo: string,
  number: number,
  budget: ContextBudget,
  logger: Logger,
): Promise<IssueContext | null> {
  try {
    const [issueResponse, comments] = await Promise.all([
      client.rest.issues.get({owner, repo, issue_number: number}),
      fetchRestCollection(
        async page => {
          const response = await client.rest.issues.listComments({
            owner,
            repo,
            issue_number: number,
            per_page: REST_PAGE_SIZE,
            page,
          })
          return response.data
        },
        'issue comments',
        logger,
      ),
    ])

    const issue = issueResponse.data
    const bodyResult = truncateBody(issue.body ?? '', budget.maxBodyBytes)

    const limitedComments = comments.slice(Math.max(0, comments.length - budget.maxComments)).map(c => ({
      id: c.node_id ?? String(c.id),
      author: c.user?.login ?? null,
      body: c.body ?? '',
      createdAt: c.created_at,
      authorAssociation: c.author_association,
      isMinimized: false,
    }))

    const labels = (issue.labels ?? [])
      .filter((l): l is {name: string; color?: string} => typeof l === 'object' && l != null && 'name' in l)
      .map(l => ({
        name: l.name ?? '',
        color: l.color,
      }))

    const assignees = (issue.assignees ?? []).map(a => ({
      login: a?.login ?? '',
    }))

    return {
      type: 'issue',
      number: issue.number,
      title: issue.title,
      body: bodyResult.text,
      bodyTruncated: bodyResult.truncated,
      state: issue.state,
      author: issue.user?.login ?? null,
      createdAt: issue.created_at,
      labels,
      assignees,
      comments: limitedComments,
      commentsTruncated: comments.length >= budget.maxComments,
      totalComments: comments.length,
    }
  } catch (error) {
    logger.warning('REST issue fallback failed', {
      owner,
      repo,
      number,
      error: toErrorMessage(error),
    })
    return null
  }
}

export async function fallbackPullRequestContext(
  client: Octokit,
  owner: string,
  repo: string,
  number: number,
  budget: ContextBudget,
  logger: Logger,
): Promise<PullRequestContext | null> {
  try {
    const prResponse = await client.rest.pulls.get({owner, repo, pull_number: number})
    const [commits, filesResponse, reviews, comments] = await Promise.all([
      fetchRestCollection(
        async page => {
          const response = await client.rest.pulls.listCommits({
            owner,
            repo,
            pull_number: number,
            per_page: REST_PAGE_SIZE,
            page,
          })
          return response.data
        },
        'pull request commits',
        logger,
      ),
      client.rest.pulls.listFiles({owner, repo, pull_number: number, per_page: budget.maxFiles}),
      fetchRestCollection(
        async page => {
          const response = await client.rest.pulls.listReviews({
            owner,
            repo,
            pull_number: number,
            per_page: REST_PAGE_SIZE,
            page,
          })
          return response.data
        },
        'pull request reviews',
        logger,
      ),
      fetchRestCollection(
        async page => {
          const response = await client.rest.issues.listComments({
            owner,
            repo,
            issue_number: number,
            per_page: REST_PAGE_SIZE,
            page,
          })
          return response.data
        },
        'pull request comments',
        logger,
      ),
    ])

    // Isolated from Promise.all — insufficient permissions should not lose all PR context
    const reviewersResponse = await client.rest.pulls
      .listRequestedReviewers({owner, repo, pull_number: number})
      .catch((error: unknown) => {
        logger.warning('Failed to fetch requested reviewers, defaulting to empty', {
          owner,
          repo,
          number,
          error: toErrorMessage(error),
        })
        return {data: {users: [] as {login: string}[], teams: [] as {name: string}[]}}
      })

    const pr = prResponse.data
    const bodyResult = truncateBody(pr.body ?? '', budget.maxBodyBytes)

    const baseOwner = pr.base.repo?.owner.login
    const headOwner = pr.head.repo?.owner.login
    const isFork = headOwner == null || baseOwner !== headOwner

    const limitedComments = comments.slice(Math.max(0, comments.length - budget.maxComments)).map(c => ({
      id: c.node_id ?? String(c.id),
      author: c.user?.login ?? null,
      body: c.body ?? '',
      createdAt: c.created_at,
      authorAssociation: c.author_association,
      isMinimized: false,
    }))

    const limitedCommits = commits.slice(Math.max(0, commits.length - budget.maxCommits)).map(c => ({
      oid: c.sha,
      message: c.commit.message,
      author: c.commit.author?.name ?? null,
    }))

    const files = filesResponse.data.slice(0, budget.maxFiles).map(f => ({
      path: f.filename,
      additions: f.additions,
      deletions: f.deletions,
      status: f.status,
    }))

    const limitedReviews = reviews.slice(Math.max(0, reviews.length - budget.maxReviews)).map(r => ({
      author: r.user?.login ?? null,
      state: r.state,
      body: r.body ?? '',
      createdAt: r.submitted_at ?? '',
      comments: [],
    }))

    const labels = (pr.labels ?? []).map(l => ({
      name: l.name ?? '',
      color: l.color,
    }))

    const assignees = (pr.assignees ?? []).map(a => ({
      login: a?.login ?? '',
    }))

    const requestedReviewers = (reviewersResponse.data.users ?? []).map(u => u.login)
    const requestedReviewerTeams = (reviewersResponse.data.teams ?? []).map(t => t.name)

    return {
      type: 'pull_request',
      number: pr.number,
      title: pr.title,
      body: bodyResult.text,
      bodyTruncated: bodyResult.truncated,
      state: pr.state,
      author: pr.user?.login ?? null,
      createdAt: pr.created_at,
      baseBranch: pr.base.ref,
      headBranch: pr.head.ref,
      isFork,
      labels,
      assignees,
      comments: limitedComments,
      commentsTruncated: comments.length >= budget.maxComments,
      totalComments: comments.length,
      commits: limitedCommits,
      commitsTruncated: commits.length >= budget.maxCommits,
      totalCommits: commits.length,
      files,
      filesTruncated: filesResponse.data.length >= budget.maxFiles,
      totalFiles: filesResponse.data.length,
      reviews: limitedReviews,
      reviewsTruncated: reviews.length >= budget.maxReviews,
      totalReviews: reviews.length,
      authorAssociation: pr.author_association,
      requestedReviewers,
      requestedReviewerTeams,
    }
  } catch (error) {
    logger.warning('REST pull request fallback failed', {
      owner,
      repo,
      number,
      error: toErrorMessage(error),
    })
    return null
  }
}
