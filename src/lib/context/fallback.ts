import type {Octokit} from '../github/types.js'
import type {Logger} from '../logger.js'
import type {ContextBudget, IssueContext, PullRequestContext} from './types.js'
import {toErrorMessage} from '../../utils/errors.js'
import {truncateBody} from './budget.js'

export async function fallbackIssueContext(
  client: Octokit,
  owner: string,
  repo: string,
  number: number,
  budget: ContextBudget,
  logger: Logger,
): Promise<IssueContext | null> {
  try {
    const [issueResponse, commentsResponse] = await Promise.all([
      client.rest.issues.get({owner, repo, issue_number: number}),
      client.rest.issues.listComments({owner, repo, issue_number: number, per_page: budget.maxComments}),
    ])

    const issue = issueResponse.data
    const bodyResult = truncateBody(issue.body ?? '', budget.maxBodyBytes)

    const comments = commentsResponse.data.slice(0, budget.maxComments).map(c => ({
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
      comments,
      commentsTruncated: commentsResponse.data.length >= budget.maxComments,
      totalComments: commentsResponse.data.length,
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
    const [prResponse, commitsResponse, filesResponse, reviewsResponse, commentsResponse] = await Promise.all([
      client.rest.pulls.get({owner, repo, pull_number: number}),
      client.rest.pulls.listCommits({owner, repo, pull_number: number, per_page: budget.maxCommits}),
      client.rest.pulls.listFiles({owner, repo, pull_number: number, per_page: budget.maxFiles}),
      client.rest.pulls.listReviews({owner, repo, pull_number: number, per_page: budget.maxReviews}),
      client.rest.issues.listComments({owner, repo, issue_number: number, per_page: budget.maxComments}),
    ])

    const pr = prResponse.data
    const bodyResult = truncateBody(pr.body ?? '', budget.maxBodyBytes)

    const baseOwner = pr.base.repo?.owner.login
    const headOwner = pr.head.repo?.owner.login
    const isFork = headOwner == null || baseOwner !== headOwner

    const comments = commentsResponse.data.slice(0, budget.maxComments).map(c => ({
      id: c.node_id ?? String(c.id),
      author: c.user?.login ?? null,
      body: c.body ?? '',
      createdAt: c.created_at,
      authorAssociation: c.author_association,
      isMinimized: false,
    }))

    const commits = commitsResponse.data.slice(0, budget.maxCommits).map(c => ({
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

    const reviews = reviewsResponse.data.slice(0, budget.maxReviews).map(r => ({
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
      comments,
      commentsTruncated: commentsResponse.data.length >= budget.maxComments,
      totalComments: commentsResponse.data.length,
      commits,
      commitsTruncated: commitsResponse.data.length >= budget.maxCommits,
      totalCommits: commitsResponse.data.length,
      files,
      filesTruncated: filesResponse.data.length >= budget.maxFiles,
      totalFiles: filesResponse.data.length,
      reviews,
      reviewsTruncated: reviewsResponse.data.length >= budget.maxReviews,
      totalReviews: reviewsResponse.data.length,
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
