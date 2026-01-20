/**
 * Context hydration types for RFC-015.
 *
 * Defines types for GraphQL-based context hydration of issues and pull requests,
 * including budgeting constraints and formatted output.
 */

/**
 * Budget constraints for context hydration.
 * Prevents prompt bloat by limiting fetched content.
 */
export interface ContextBudget {
  readonly maxComments: number
  readonly maxCommits: number
  readonly maxFiles: number
  readonly maxReviews: number
  readonly maxBodyBytes: number
  readonly maxTotalBytes: number
}

/**
 * Default budget per RFC-015 specification.
 */
export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxComments: 50,
  maxCommits: 100,
  maxFiles: 100,
  maxReviews: 100,
  maxBodyBytes: 10 * 1024, // 10KB
  maxTotalBytes: 100 * 1024, // 100KB
} as const

/**
 * Comment in an issue or PR thread.
 */
export interface ContextComment {
  readonly author: string | null
  readonly body: string
  readonly createdAt: string
  readonly authorAssociation: string
}

/**
 * Label attached to an issue or PR.
 */
export interface ContextLabel {
  readonly name: string
  readonly color?: string
}

/**
 * Assignee on an issue or PR.
 */
export interface ContextAssignee {
  readonly login: string
}

/**
 * Commit in a pull request.
 */
export interface ContextCommit {
  readonly oid: string
  readonly message: string
  readonly author: string | null
}

/**
 * File changed in a pull request.
 */
export interface ContextFile {
  readonly path: string
  readonly additions: number
  readonly deletions: number
  readonly status?: string
}

/**
 * Review on a pull request.
 */
export interface ContextReview {
  readonly author: string | null
  readonly state: string
  readonly body: string
  readonly createdAt: string
  readonly comments: readonly ContextReviewComment[]
}

/**
 * Inline review comment on a pull request.
 */
export interface ContextReviewComment {
  readonly author: string | null
  readonly body: string
  readonly path: string
  readonly line: number | null
  readonly createdAt: string
}

/**
 * Hydrated issue context from GraphQL.
 */
export interface IssueContext {
  readonly type: 'issue'
  readonly number: number
  readonly title: string
  readonly body: string
  readonly bodyTruncated: boolean
  readonly state: string
  readonly author: string | null
  readonly createdAt: string
  readonly labels: readonly ContextLabel[]
  readonly assignees: readonly ContextAssignee[]
  readonly comments: readonly ContextComment[]
  readonly commentsTruncated: boolean
  readonly totalComments: number
}

/**
 * Hydrated pull request context from GraphQL.
 */
export interface PullRequestContext {
  readonly type: 'pull_request'
  readonly number: number
  readonly title: string
  readonly body: string
  readonly bodyTruncated: boolean
  readonly state: string
  readonly author: string | null
  readonly createdAt: string
  readonly baseBranch: string
  readonly headBranch: string
  readonly isFork: boolean
  readonly labels: readonly ContextLabel[]
  readonly assignees: readonly ContextAssignee[]
  readonly comments: readonly ContextComment[]
  readonly commentsTruncated: boolean
  readonly totalComments: number
  readonly commits: readonly ContextCommit[]
  readonly commitsTruncated: boolean
  readonly totalCommits: number
  readonly files: readonly ContextFile[]
  readonly filesTruncated: boolean
  readonly totalFiles: number
  readonly reviews: readonly ContextReview[]
  readonly reviewsTruncated: boolean
  readonly totalReviews: number
}

/**
 * Union type for hydrated context (issue or PR).
 */
export type HydratedContext = IssueContext | PullRequestContext

/**
 * Result of truncating a body string.
 */
export interface TruncateResult {
  readonly text: string
  readonly truncated: boolean
}

/**
 * GraphQL response types for issue query.
 */
export interface IssueGraphQLResponse {
  readonly repository: {
    readonly issue: {
      readonly number: number
      readonly title: string
      readonly body: string
      readonly state: string
      readonly createdAt: string
      readonly author: {readonly login: string} | null
      readonly labels: {
        readonly nodes: readonly {readonly name: string; readonly color: string}[]
      }
      readonly assignees: {
        readonly nodes: readonly {readonly login: string}[]
      }
      readonly comments: {
        readonly totalCount: number
        readonly nodes: readonly {
          readonly body: string
          readonly createdAt: string
          readonly author: {readonly login: string} | null
          readonly authorAssociation: string
        }[]
      }
    } | null
  }
}

/**
 * GraphQL response types for pull request query.
 */
export interface PullRequestGraphQLResponse {
  readonly repository: {
    readonly pullRequest: {
      readonly number: number
      readonly title: string
      readonly body: string
      readonly state: string
      readonly createdAt: string
      readonly author: {readonly login: string} | null
      readonly baseRefName: string
      readonly headRefName: string
      readonly baseRepository: {readonly owner: {readonly login: string}} | null
      readonly headRepository: {readonly owner: {readonly login: string}} | null
      readonly labels: {
        readonly nodes: readonly {readonly name: string; readonly color: string}[]
      }
      readonly assignees: {
        readonly nodes: readonly {readonly login: string}[]
      }
      readonly comments: {
        readonly totalCount: number
        readonly nodes: readonly {
          readonly body: string
          readonly createdAt: string
          readonly author: {readonly login: string} | null
          readonly authorAssociation: string
        }[]
      }
      readonly commits: {
        readonly totalCount: number
        readonly nodes: readonly {
          readonly commit: {
            readonly oid: string
            readonly message: string
            readonly author: {readonly name: string | null} | null
          }
        }[]
      }
      readonly files: {
        readonly totalCount: number
        readonly nodes: readonly {
          readonly path: string
          readonly additions: number
          readonly deletions: number
        }[]
      }
      readonly reviews: {
        readonly totalCount: number
        readonly nodes: readonly {
          readonly state: string
          readonly body: string
          readonly createdAt: string
          readonly author: {readonly login: string} | null
          readonly comments: {
            readonly nodes: readonly {
              readonly body: string
              readonly path: string
              readonly line: number | null
              readonly createdAt: string
              readonly author: {readonly login: string} | null
            }[]
          }
        }[]
      }
    } | null
  }
}
