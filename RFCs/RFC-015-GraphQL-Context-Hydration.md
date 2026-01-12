# RFC-015: GraphQL Context Hydration

**Status:** Pending
**Priority:** MUST
**Complexity:** High
**Phase:** 2

---

## Summary

Implement enhanced GitHub context hydration using GraphQL API to provide the agent with comprehensive issue and pull request context. This replaces limited REST API context with rich, structured data including comments, reviews, commits, and file changes.

## Dependencies

- **Builds Upon:** RFC-003 (GitHub Client), RFC-005 (Triggers)
- **Enables:** RFC-008 (Comments), RFC-009 (Reviews), improved agent context awareness

## Features Addressed

| Feature ID | Feature Name              | Priority |
| ---------- | ------------------------- | -------- |
| NEW        | Issue Context via GraphQL | P0       |
| NEW        | PR Context via GraphQL    | P0       |
| NEW        | Context Budgeting         | P0       |
| NEW        | Fork PR Detection         | P0       |
| NEW        | REST API Fallback         | P0       |

## Technical Specification

### 1. File Structure

```
src/lib/
├── context/
│   ├── types.ts          # Context-related types
│   ├── graphql.ts        # GraphQL queries and client
│   ├── issue.ts          # Issue context hydration
│   ├── pull-request.ts   # PR context hydration
│   ├── budget.ts         # Context budgeting/truncation
│   ├── fallback.ts       # REST API fallback
│   └── index.ts          # Public exports
```

### 2. Context Types (`src/lib/context/types.ts`)

```typescript
import type {Logger} from "../types.js"

/**
 * Common author information.
 */
export interface Author {
  readonly login: string
  readonly avatarUrl?: string
}

/**
 * Label information.
 */
export interface Label {
  readonly name: string
  readonly color: string
}

/**
 * Comment in issue/PR thread.
 */
export interface Comment {
  readonly id: string
  readonly author: Author | null
  readonly body: string
  readonly createdAt: string
  readonly isMinimized: boolean
}

/**
 * Hydrated issue context.
 */
export interface IssueContext {
  readonly type: "issue"
  readonly number: number
  readonly title: string
  readonly body: string
  readonly author: Author | null
  readonly state: "OPEN" | "CLOSED"
  readonly createdAt: string
  readonly updatedAt: string
  readonly labels: readonly Label[]
  readonly assignees: readonly Author[]
  readonly comments: readonly Comment[]
  readonly commentCount: number
  readonly truncated: boolean
}

/**
 * Commit in PR.
 */
export interface PrCommit {
  readonly oid: string
  readonly message: string
  readonly author: {
    readonly name: string
    readonly email: string
    readonly date: string
  } | null
}

/**
 * Changed file in PR.
 */
export interface PrFile {
  readonly path: string
  readonly additions: number
  readonly deletions: number
  readonly changeType: "ADDED" | "DELETED" | "MODIFIED" | "RENAMED" | "COPIED"
}

/**
 * Review on PR.
 */
export interface PrReview {
  readonly id: string
  readonly author: Author | null
  readonly state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING"
  readonly body: string
  readonly submittedAt: string | null
  readonly comments: readonly ReviewComment[]
}

/**
 * Inline review comment.
 */
export interface ReviewComment {
  readonly id: string
  readonly path: string
  readonly line: number | null
  readonly body: string
  readonly author: Author | null
  readonly createdAt: string
}

/**
 * Hydrated pull request context.
 */
export interface PullRequestContext {
  readonly type: "pull_request"
  readonly number: number
  readonly title: string
  readonly body: string
  readonly author: Author | null
  readonly state: "OPEN" | "CLOSED" | "MERGED"
  readonly createdAt: string
  readonly updatedAt: string
  readonly baseRefName: string
  readonly headRefName: string
  readonly headRefOid: string
  readonly additions: number
  readonly deletions: number
  readonly changedFiles: number
  readonly baseRepository: string // owner/repo
  readonly headRepository: string // owner/repo (different for forks)
  readonly isFork: boolean
  readonly labels: readonly Label[]
  readonly assignees: readonly Author[]
  readonly comments: readonly Comment[]
  readonly commits: readonly PrCommit[]
  readonly files: readonly PrFile[]
  readonly reviews: readonly PrReview[]
  readonly commentCount: number
  readonly commitCount: number
  readonly fileCount: number
  readonly reviewCount: number
  readonly truncated: boolean
}

export type HydratedContext = IssueContext | PullRequestContext

/**
 * Context budgeting limits.
 */
export interface ContextBudget {
  readonly maxComments: number // Default: 50
  readonly maxCommits: number // Default: 100
  readonly maxFiles: number // Default: 100
  readonly maxReviews: number // Default: 100
  readonly maxBodyBytes: number // Default: 10KB
  readonly maxTotalBytes: number // Default: 100KB
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxComments: 50,
  maxCommits: 100,
  maxFiles: 100,
  maxReviews: 100,
  maxBodyBytes: 10 * 1024, // 10KB
  maxTotalBytes: 100 * 1024, // 100KB
}

/**
 * Context hydration options.
 */
export interface HydrationOptions {
  readonly budget?: ContextBudget
  readonly includeDiffs?: boolean // Include file diffs (expensive)
}
```

### 3. GraphQL Queries (`src/lib/context/graphql.ts`)

```typescript
import type {Octokit} from "../github/types.js"
import type {Logger} from "../types.js"

/**
 * GraphQL query for issue context.
 */
export const ISSUE_QUERY = `
  query IssueContext($owner: String!, $repo: String!, $number: Int!, $commentCount: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        id
        number
        title
        body
        state
        createdAt
        updatedAt
        author {
          login
          avatarUrl
        }
        labels(first: 20) {
          nodes {
            name
            color
          }
        }
        assignees(first: 10) {
          nodes {
            login
            avatarUrl
          }
        }
        comments(first: $commentCount) {
          totalCount
          nodes {
            id
            author {
              login
              avatarUrl
            }
            body
            createdAt
            isMinimized
          }
        }
      }
    }
  }
`

/**
 * GraphQL query for pull request context.
 */
export const PULL_REQUEST_QUERY = `
  query PullRequestContext(
    $owner: String!,
    $repo: String!,
    $number: Int!,
    $commentCount: Int!,
    $commitCount: Int!,
    $fileCount: Int!,
    $reviewCount: Int!
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        id
        number
        title
        body
        state
        createdAt
        updatedAt
        baseRefName
        headRefName
        headRefOid
        additions
        deletions
        changedFiles
        baseRepository {
          nameWithOwner
        }
        headRepository {
          nameWithOwner
        }
        author {
          login
          avatarUrl
        }
        labels(first: 20) {
          nodes {
            name
            color
          }
        }
        assignees(first: 10) {
          nodes {
            login
            avatarUrl
          }
        }
        comments(first: $commentCount) {
          totalCount
          nodes {
            id
            author {
              login
              avatarUrl
            }
            body
            createdAt
            isMinimized
          }
        }
        commits(last: $commitCount) {
          totalCount
          nodes {
            commit {
              oid
              message
              author {
                name
                email
                date
              }
            }
          }
        }
        files(first: $fileCount) {
          totalCount
          nodes {
            path
            additions
            deletions
            changeType
          }
        }
        reviews(first: $reviewCount) {
          totalCount
          nodes {
            id
            author {
              login
              avatarUrl
            }
            state
            body
            submittedAt
            comments(first: 20) {
              nodes {
                id
                path
                line
                body
                author {
                  login
                  avatarUrl
                }
                createdAt
              }
            }
          }
        }
      }
    }
  }
`

/**
 * Execute GraphQL query with error handling.
 */
export async function executeGraphQL<T>(
  octokit: Octokit,
  query: string,
  variables: Record<string, unknown>,
  logger: Logger,
): Promise<T | null> {
  try {
    logger.debug("Executing GraphQL query", {variables})
    const result = await octokit.graphql<T>(query, variables)
    return result
  } catch (error) {
    logger.warning("GraphQL query failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}
```

### 4. Issue Context Hydration (`src/lib/context/issue.ts`)

```typescript
import type {Octokit} from "../github/types.js"
import type {IssueContext, ContextBudget, Author, Label, Comment, Logger} from "./types.js"
import {DEFAULT_CONTEXT_BUDGET} from "./types.js"
import {ISSUE_QUERY, executeGraphQL} from "./graphql.js"
import {truncateBody} from "./budget.js"

interface IssueQueryResult {
  repository: {
    issue: {
      id: string
      number: number
      title: string
      body: string
      state: "OPEN" | "CLOSED"
      createdAt: string
      updatedAt: string
      author: {login: string; avatarUrl: string} | null
      labels: {nodes: Array<{name: string; color: string}>}
      assignees: {nodes: Array<{login: string; avatarUrl: string}>}
      comments: {
        totalCount: number
        nodes: Array<{
          id: string
          author: {login: string; avatarUrl: string} | null
          body: string
          createdAt: string
          isMinimized: boolean
        }>
      }
    }
  }
}

/**
 * Hydrate issue context via GraphQL.
 */
export async function hydrateIssueContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number,
  budget: ContextBudget = DEFAULT_CONTEXT_BUDGET,
  logger: Logger,
): Promise<IssueContext | null> {
  logger.info("Hydrating issue context via GraphQL", {owner, repo, number})

  const result = await executeGraphQL<IssueQueryResult>(
    octokit,
    ISSUE_QUERY,
    {
      owner,
      repo,
      number,
      commentCount: budget.maxComments,
    },
    logger,
  )

  if (result == null || result.repository?.issue == null) {
    logger.warning("Failed to fetch issue context via GraphQL")
    return null
  }

  const issue = result.repository.issue
  const truncated = issue.comments.totalCount > budget.maxComments

  const context: IssueContext = {
    type: "issue",
    number: issue.number,
    title: issue.title,
    body: truncateBody(issue.body, budget.maxBodyBytes),
    author: issue.author != null ? {login: issue.author.login, avatarUrl: issue.author.avatarUrl} : null,
    state: issue.state,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    labels: issue.labels.nodes.map(l => ({name: l.name, color: l.color})),
    assignees: issue.assignees.nodes.map(a => ({login: a.login, avatarUrl: a.avatarUrl})),
    comments: issue.comments.nodes.map(c => ({
      id: c.id,
      author: c.author != null ? {login: c.author.login, avatarUrl: c.author.avatarUrl} : null,
      body: truncateBody(c.body, budget.maxBodyBytes),
      createdAt: c.createdAt,
      isMinimized: c.isMinimized,
    })),
    commentCount: issue.comments.totalCount,
    truncated,
  }

  logger.info("Issue context hydrated", {
    number: context.number,
    commentCount: context.commentCount,
    truncated: context.truncated,
  })

  return context
}
```

### 5. Pull Request Context Hydration (`src/lib/context/pull-request.ts`)

```typescript
import type {Octokit} from "../github/types.js"
import type {PullRequestContext, ContextBudget, PrCommit, PrFile, PrReview, ReviewComment, Logger} from "./types.js"
import {DEFAULT_CONTEXT_BUDGET} from "./types.js"
import {PULL_REQUEST_QUERY, executeGraphQL} from "./graphql.js"
import {truncateBody} from "./budget.js"

interface PrQueryResult {
  repository: {
    pullRequest: {
      id: string
      number: number
      title: string
      body: string
      state: "OPEN" | "CLOSED" | "MERGED"
      createdAt: string
      updatedAt: string
      baseRefName: string
      headRefName: string
      headRefOid: string
      additions: number
      deletions: number
      changedFiles: number
      baseRepository: {nameWithOwner: string}
      headRepository: {nameWithOwner: string}
      author: {login: string; avatarUrl: string} | null
      labels: {nodes: Array<{name: string; color: string}>}
      assignees: {nodes: Array<{login: string; avatarUrl: string}>}
      comments: {
        totalCount: number
        nodes: Array<{
          id: string
          author: {login: string; avatarUrl: string} | null
          body: string
          createdAt: string
          isMinimized: boolean
        }>
      }
      commits: {
        totalCount: number
        nodes: Array<{
          commit: {
            oid: string
            message: string
            author: {name: string; email: string; date: string} | null
          }
        }>
      }
      files: {
        totalCount: number
        nodes: Array<{
          path: string
          additions: number
          deletions: number
          changeType: string
        }>
      }
      reviews: {
        totalCount: number
        nodes: Array<{
          id: string
          author: {login: string; avatarUrl: string} | null
          state: string
          body: string
          submittedAt: string | null
          comments: {
            nodes: Array<{
              id: string
              path: string
              line: number | null
              body: string
              author: {login: string; avatarUrl: string} | null
              createdAt: string
            }>
          }
        }>
      }
    }
  }
}

/**
 * Hydrate pull request context via GraphQL.
 */
export async function hydratePullRequestContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number,
  budget: ContextBudget = DEFAULT_CONTEXT_BUDGET,
  logger: Logger,
): Promise<PullRequestContext | null> {
  logger.info("Hydrating PR context via GraphQL", {owner, repo, number})

  const result = await executeGraphQL<PrQueryResult>(
    octokit,
    PULL_REQUEST_QUERY,
    {
      owner,
      repo,
      number,
      commentCount: budget.maxComments,
      commitCount: budget.maxCommits,
      fileCount: budget.maxFiles,
      reviewCount: budget.maxReviews,
    },
    logger,
  )

  if (result == null || result.repository?.pullRequest == null) {
    logger.warning("Failed to fetch PR context via GraphQL")
    return null
  }

  const pr = result.repository.pullRequest
  const baseRepo = pr.baseRepository.nameWithOwner
  const headRepo = pr.headRepository.nameWithOwner
  const isFork = baseRepo !== headRepo

  const truncated =
    pr.comments.totalCount > budget.maxComments ||
    pr.commits.totalCount > budget.maxCommits ||
    pr.files.totalCount > budget.maxFiles ||
    pr.reviews.totalCount > budget.maxReviews

  const context: PullRequestContext = {
    type: "pull_request",
    number: pr.number,
    title: pr.title,
    body: truncateBody(pr.body, budget.maxBodyBytes),
    author: pr.author != null ? {login: pr.author.login, avatarUrl: pr.author.avatarUrl} : null,
    state: pr.state,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    baseRepository: baseRepo,
    headRepository: headRepo,
    isFork,
    labels: pr.labels.nodes.map(l => ({name: l.name, color: l.color})),
    assignees: pr.assignees.nodes.map(a => ({login: a.login, avatarUrl: a.avatarUrl})),
    comments: pr.comments.nodes.map(c => ({
      id: c.id,
      author: c.author != null ? {login: c.author.login, avatarUrl: c.author.avatarUrl} : null,
      body: truncateBody(c.body, budget.maxBodyBytes),
      createdAt: c.createdAt,
      isMinimized: c.isMinimized,
    })),
    commits: pr.commits.nodes.map(n => ({
      oid: n.commit.oid,
      message: n.commit.message,
      author: n.commit.author,
    })),
    files: pr.files.nodes.map(f => ({
      path: f.path,
      additions: f.additions,
      deletions: f.deletions,
      changeType: f.changeType as PrFile["changeType"],
    })),
    reviews: pr.reviews.nodes.map(r => ({
      id: r.id,
      author: r.author != null ? {login: r.author.login, avatarUrl: r.author.avatarUrl} : null,
      state: r.state as PrReview["state"],
      body: truncateBody(r.body, budget.maxBodyBytes),
      submittedAt: r.submittedAt,
      comments: r.comments.nodes.map(c => ({
        id: c.id,
        path: c.path,
        line: c.line,
        body: truncateBody(c.body, budget.maxBodyBytes),
        author: c.author != null ? {login: c.author.login, avatarUrl: c.author.avatarUrl} : null,
        createdAt: c.createdAt,
      })),
    })),
    commentCount: pr.comments.totalCount,
    commitCount: pr.commits.totalCount,
    fileCount: pr.files.totalCount,
    reviewCount: pr.reviews.totalCount,
    truncated,
  }

  logger.info("PR context hydrated", {
    number: context.number,
    isFork: context.isFork,
    commentCount: context.commentCount,
    commitCount: context.commitCount,
    fileCount: context.fileCount,
    reviewCount: context.reviewCount,
    truncated: context.truncated,
  })

  return context
}
```

### 6. Context Budgeting (`src/lib/context/budget.ts`)

```typescript
import type {HydratedContext, ContextBudget} from "./types.js"
import {DEFAULT_CONTEXT_BUDGET} from "./types.js"

/**
 * Truncate body text to max bytes with truncation note.
 */
export function truncateBody(body: string | null | undefined, maxBytes: number): string {
  if (body == null) return ""

  const bytes = Buffer.byteLength(body, "utf8")
  if (bytes <= maxBytes) return body

  // Find a good cutoff point (don't cut in middle of multi-byte char)
  let cutoff = maxBytes - 50 // Leave room for truncation note
  while (cutoff > 0 && (body.charCodeAt(cutoff) & 0xc0) === 0x80) {
    cutoff--
  }

  const truncated = body.slice(0, cutoff)
  return `${truncated}\n\n[... truncated, ${bytes - cutoff} bytes omitted ...]`
}

/**
 * Estimate total size of hydrated context in bytes.
 */
export function estimateContextSize(context: HydratedContext): number {
  // Simple estimation: JSON stringify and measure
  const json = JSON.stringify(context)
  return Buffer.byteLength(json, "utf8")
}

/**
 * Check if context exceeds total budget.
 */
export function exceedsBudget(context: HydratedContext, budget: ContextBudget = DEFAULT_CONTEXT_BUDGET): boolean {
  return estimateContextSize(context) > budget.maxTotalBytes
}

/**
 * Format context for prompt injection.
 *
 * Produces a markdown-formatted summary of the context.
 */
export function formatContextForPrompt(context: HydratedContext): string {
  const lines: string[] = []

  if (context.type === "issue") {
    lines.push(`## Issue #${context.number}: ${context.title}`)
    lines.push("")
    lines.push(`**State:** ${context.state}`)
    lines.push(`**Author:** ${context.author?.login ?? "unknown"}`)
    lines.push(`**Created:** ${context.createdAt}`)
    lines.push(`**Labels:** ${context.labels.map(l => l.name).join(", ") || "none"}`)
    lines.push("")
    lines.push("### Description")
    lines.push("")
    lines.push(context.body || "*No description provided*")
    lines.push("")

    if (context.comments.length > 0) {
      lines.push(`### Comments (${context.commentCount} total, showing ${context.comments.length})`)
      lines.push("")
      for (const comment of context.comments) {
        if (!comment.isMinimized) {
          lines.push(`**${comment.author?.login ?? "unknown"}** (${comment.createdAt}):`)
          lines.push(comment.body)
          lines.push("")
        }
      }
    }

    if (context.truncated) {
      lines.push("*Note: Some content was truncated due to size limits.*")
    }
  } else {
    lines.push(`## Pull Request #${context.number}: ${context.title}`)
    lines.push("")
    lines.push(`**State:** ${context.state}`)
    lines.push(`**Author:** ${context.author?.login ?? "unknown"}`)
    lines.push(`**Branch:** ${context.headRefName} → ${context.baseRefName}`)
    lines.push(`**Changes:** +${context.additions}/-${context.deletions} in ${context.changedFiles} files`)
    if (context.isFork) {
      lines.push(`**Fork:** ${context.headRepository} → ${context.baseRepository}`)
    }
    lines.push(`**Labels:** ${context.labels.map(l => l.name).join(", ") || "none"}`)
    lines.push("")
    lines.push("### Description")
    lines.push("")
    lines.push(context.body || "*No description provided*")
    lines.push("")

    if (context.files.length > 0) {
      lines.push(`### Changed Files (${context.fileCount} total, showing ${context.files.length})`)
      lines.push("")
      for (const file of context.files) {
        lines.push(`- \`${file.path}\` (${file.changeType}, +${file.additions}/-${file.deletions})`)
      }
      lines.push("")
    }

    if (context.commits.length > 0) {
      lines.push(`### Recent Commits (${context.commitCount} total, showing ${context.commits.length})`)
      lines.push("")
      for (const commit of context.commits.slice(-10)) {
        const shortOid = commit.oid.slice(0, 7)
        const firstLine = commit.message.split("\n")[0]
        lines.push(`- \`${shortOid}\` ${firstLine}`)
      }
      lines.push("")
    }

    if (context.reviews.length > 0) {
      lines.push(`### Reviews (${context.reviewCount} total, showing ${context.reviews.length})`)
      lines.push("")
      for (const review of context.reviews) {
        lines.push(`**${review.author?.login ?? "unknown"}** - ${review.state}`)
        if (review.body.length > 0) {
          lines.push(review.body)
        }
        if (review.comments.length > 0) {
          lines.push(`  *${review.comments.length} inline comments*`)
        }
        lines.push("")
      }
    }

    if (context.comments.length > 0) {
      lines.push(`### Conversation (${context.commentCount} total, showing ${context.comments.length})`)
      lines.push("")
      for (const comment of context.comments) {
        if (!comment.isMinimized) {
          lines.push(`**${comment.author?.login ?? "unknown"}** (${comment.createdAt}):`)
          lines.push(comment.body)
          lines.push("")
        }
      }
    }

    if (context.truncated) {
      lines.push("*Note: Some content was truncated due to size limits.*")
    }
  }

  return lines.join("\n")
}
```

### 7. REST API Fallback (`src/lib/context/fallback.ts`)

```typescript
import type {Octokit} from "../github/types.js"
import type {IssueContext, PullRequestContext, ContextBudget, Logger} from "./types.js"
import {DEFAULT_CONTEXT_BUDGET} from "./types.js"
import {truncateBody} from "./budget.js"

/**
 * Fallback issue context via REST API.
 *
 * Used when GraphQL fails (rate limits, permissions, etc.)
 */
export async function fallbackIssueContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number,
  budget: ContextBudget = DEFAULT_CONTEXT_BUDGET,
  logger: Logger,
): Promise<IssueContext | null> {
  logger.info("Falling back to REST API for issue context", {owner, repo, number})

  try {
    const {data: issue} = await octokit.rest.issues.get({owner, repo, issue_number: number})
    const {data: comments} = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: number,
      per_page: budget.maxComments,
    })

    return {
      type: "issue",
      number: issue.number,
      title: issue.title,
      body: truncateBody(issue.body, budget.maxBodyBytes),
      author: issue.user != null ? {login: issue.user.login} : null,
      state: issue.state === "open" ? "OPEN" : "CLOSED",
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      labels: issue.labels
        .filter((l): l is {name: string; color: string} => typeof l === "object" && l != null && "name" in l)
        .map(l => ({name: l.name, color: l.color ?? ""})),
      assignees: (issue.assignees ?? []).map(a => ({login: a.login})),
      comments: comments.map(c => ({
        id: String(c.id),
        author: c.user != null ? {login: c.user.login} : null,
        body: truncateBody(c.body, budget.maxBodyBytes),
        createdAt: c.created_at,
        isMinimized: false,
      })),
      commentCount: comments.length,
      truncated: false,
    }
  } catch (error) {
    logger.error("REST fallback failed for issue", {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * Fallback PR context via REST API.
 *
 * Provides reduced context compared to GraphQL.
 */
export async function fallbackPullRequestContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number,
  budget: ContextBudget = DEFAULT_CONTEXT_BUDGET,
  logger: Logger,
): Promise<PullRequestContext | null> {
  logger.info("Falling back to REST API for PR context", {owner, repo, number})

  try {
    const {data: pr} = await octokit.rest.pulls.get({owner, repo, pull_number: number})
    const {data: comments} = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: number,
      per_page: budget.maxComments,
    })
    const {data: files} = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: number,
      per_page: budget.maxFiles,
    })

    const baseRepo = `${pr.base.repo.owner.login}/${pr.base.repo.name}`
    const headRepo = pr.head.repo != null ? `${pr.head.repo.owner.login}/${pr.head.repo.name}` : baseRepo

    return {
      type: "pull_request",
      number: pr.number,
      title: pr.title,
      body: truncateBody(pr.body, budget.maxBodyBytes),
      author: pr.user != null ? {login: pr.user.login} : null,
      state: pr.merged ? "MERGED" : pr.state === "open" ? "OPEN" : "CLOSED",
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      baseRefName: pr.base.ref,
      headRefName: pr.head.ref,
      headRefOid: pr.head.sha,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
      baseRepository: baseRepo,
      headRepository: headRepo,
      isFork: baseRepo !== headRepo,
      labels: pr.labels.map(l => ({name: l.name, color: l.color ?? ""})),
      assignees: (pr.assignees ?? []).map(a => ({login: a.login})),
      comments: comments.map(c => ({
        id: String(c.id),
        author: c.user != null ? {login: c.user.login} : null,
        body: truncateBody(c.body, budget.maxBodyBytes),
        createdAt: c.created_at,
        isMinimized: false,
      })),
      commits: [], // Not fetched in fallback
      files: files.map(f => ({
        path: f.filename,
        additions: f.additions,
        deletions: f.deletions,
        changeType: mapRestStatus(f.status),
      })),
      reviews: [], // Not fetched in fallback
      commentCount: comments.length,
      commitCount: pr.commits,
      fileCount: files.length,
      reviewCount: 0,
      truncated: false,
    }
  } catch (error) {
    logger.error("REST fallback failed for PR", {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

function mapRestStatus(status: string): "ADDED" | "DELETED" | "MODIFIED" | "RENAMED" | "COPIED" {
  switch (status) {
    case "added":
      return "ADDED"
    case "removed":
      return "DELETED"
    case "renamed":
      return "RENAMED"
    case "copied":
      return "COPIED"
    default:
      return "MODIFIED"
  }
}
```

### 8. Public Exports (`src/lib/context/index.ts`)

```typescript
export {hydrateIssueContext} from "./issue.js"
export {hydratePullRequestContext} from "./pull-request.js"
export {fallbackIssueContext, fallbackPullRequestContext} from "./fallback.js"
export {truncateBody, estimateContextSize, exceedsBudget, formatContextForPrompt} from "./budget.js"
export {executeGraphQL, ISSUE_QUERY, PULL_REQUEST_QUERY} from "./graphql.js"
export type {
  IssueContext,
  PullRequestContext,
  HydratedContext,
  ContextBudget,
  HydrationOptions,
  Author,
  Label,
  Comment,
  PrCommit,
  PrFile,
  PrReview,
  ReviewComment,
} from "./types.js"
export {DEFAULT_CONTEXT_BUDGET} from "./types.js"
```

## Acceptance Criteria

- [ ] Issue context fetched via GraphQL (title, body, comments, labels)
- [ ] PR context fetched via GraphQL (commits, files, reviews, inline comments)
- [ ] Context budgeting enforced (50 comments, 100 files, 10KB body truncation)
- [ ] Total context budget ~100KB before prompt injection
- [ ] Fork PR detected via `headRepository` vs `baseRepository` comparison
- [ ] Fallback to REST API on GraphQL failure
- [ ] Warning logged when context is degraded
- [ ] Truncation notes added when content is cut
- [ ] Context formatted for prompt injection

## Test Cases

### GraphQL Context Tests

```typescript
describe("hydrateIssueContext", () => {
  it("fetches full issue context via GraphQL", async () => {
    const context = await hydrateIssueContext(mockOctokit, "owner", "repo", 123, DEFAULT_CONTEXT_BUDGET, mockLogger)
    expect(context).not.toBeNull()
    expect(context?.type).toBe("issue")
    expect(context?.number).toBe(123)
    expect(context?.comments.length).toBeLessThanOrEqual(50)
  })

  it("falls back to REST on GraphQL failure", async () => {
    mockOctokit.graphql.mockRejectedValue(new Error("Rate limit"))
    const context = await hydrateIssueContext(mockOctokit, "owner", "repo", 123, DEFAULT_CONTEXT_BUDGET, mockLogger)
    // Should return null (caller handles fallback)
    expect(context).toBeNull()
    expect(mockLogger.warning).toHaveBeenCalledWith(expect.stringContaining("GraphQL"))
  })
})

describe("hydratePullRequestContext", () => {
  it("detects fork PRs", async () => {
    mockOctokit.graphql.mockResolvedValue({
      repository: {
        pullRequest: {
          ...mockPrData,
          baseRepository: {nameWithOwner: "owner/repo"},
          headRepository: {nameWithOwner: "fork-owner/repo"},
        },
      },
    })
    const context = await hydratePullRequestContext(mockOctokit, "owner", "repo", 1, DEFAULT_CONTEXT_BUDGET, mockLogger)
    expect(context?.isFork).toBe(true)
  })

  it("includes commits, files, and reviews", async () => {
    const context = await hydratePullRequestContext(mockOctokit, "owner", "repo", 1, DEFAULT_CONTEXT_BUDGET, mockLogger)
    expect(context?.commits.length).toBeGreaterThan(0)
    expect(context?.files.length).toBeGreaterThan(0)
    expect(context?.reviews.length).toBeGreaterThanOrEqual(0)
  })
})
```

### Budgeting Tests

```typescript
describe("truncateBody", () => {
  it("returns unchanged body under limit", () => {
    const body = "Short body"
    expect(truncateBody(body, 1000)).toBe(body)
  })

  it("truncates with note when over limit", () => {
    const body = "A".repeat(20000)
    const result = truncateBody(body, 10000)
    expect(result.length).toBeLessThan(20000)
    expect(result).toContain("truncated")
  })

  it("handles null/undefined", () => {
    expect(truncateBody(null, 1000)).toBe("")
    expect(truncateBody(undefined, 1000)).toBe("")
  })
})

describe("exceedsBudget", () => {
  it("returns true for large context", () => {
    const largeContext = createMockIssueContext({body: "X".repeat(200000)})
    expect(exceedsBudget(largeContext)).toBe(true)
  })
})
```

## Security Considerations

1. **Rate Limiting**: GraphQL has separate rate limits; REST fallback handles exhaustion
2. **Private Data**: Only fetches data user has access to via provided token
3. **Body Sanitization**: Truncation prevents prompt injection via oversized content
4. **Fork Detection**: Enables different handling for untrusted fork code

## Implementation Notes

1. **GraphQL vs REST**: GraphQL fetches more data in fewer requests
2. **Pagination**: Uses first/last with limits to stay within budget
3. **Caching**: Consider caching within a run for repeated context access
4. **Error Handling**: Graceful degradation to REST on any GraphQL failure

## Estimated Effort

- **Development**: 10-14 hours
- **Testing**: 4-6 hours
- **Total**: 14-20 hours
