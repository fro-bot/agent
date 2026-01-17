/**
 * Comment interaction types for RFC-008.
 *
 * Supports Issues, PRs (REST API with numeric IDs), and Discussions (GraphQL with Node IDs).
 * Re-exports CommentTarget and BOT_COMMENT_MARKER from github/types.ts for convenience.
 */

// Re-export shared types from github module
export {BOT_COMMENT_MARKER, type CommentTarget} from '../github/types.js'

/**
 * A comment within a thread (issue, PR, or discussion).
 *
 * Note: `id` is `number` for REST API (issues/PRs) and `string` for GraphQL (discussions).
 * The `isBot` flag indicates if this comment was authored by the bot and contains the marker.
 */
export interface ThreadComment {
  readonly id: number | string
  readonly body: string
  readonly author: string
  readonly authorAssociation: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly isBot: boolean
}

/**
 * A full thread including the original post and all comments.
 *
 * For discussions, `discussionId` contains the GraphQL Node ID needed for mutations.
 */
export interface Thread {
  readonly type: 'discussion' | 'issue' | 'pr'
  readonly number: number
  readonly title: string
  readonly body: string
  readonly author: string
  readonly comments: readonly ThreadComment[]
  readonly discussionId?: string // GraphQL Node ID, only for discussions
}

/**
 * Options for posting a comment.
 */
export interface PostCommentOptions {
  /** The comment body content */
  readonly body: string
  /** If true, update existing bot comment instead of creating new */
  readonly updateExisting?: boolean
  /** Bot login for identifying existing comments (required if updateExisting is true) */
  readonly botLogin?: string
}

/**
 * Result of a comment post operation.
 */
export interface PostCommentResult {
  readonly commentId: number | string
  readonly created: boolean
  readonly updated: boolean
  readonly url: string
}

/**
 * Error types for categorizing failures.
 */
export const ERROR_TYPES = [
  'api_error',
  'configuration',
  'internal',
  'llm_timeout',
  'permission',
  'rate_limit',
  'validation',
] as const

export type ErrorType = (typeof ERROR_TYPES)[number]

/**
 * Structured error information for formatted error comments.
 */
export interface ErrorInfo {
  readonly type: ErrorType
  readonly message: string
  readonly details?: string
  readonly suggestedAction?: string
  readonly retryable: boolean
  readonly resetTime?: Date // For rate limit errors
}

/**
 * GraphQL response types for discussion queries.
 */
export interface DiscussionQueryResponse {
  readonly repository: {
    readonly discussion: {
      readonly id: string
      readonly title: string
      readonly body: string
      readonly author: {readonly login: string} | null
      readonly comments: {
        readonly nodes: readonly {
          readonly id: string
          readonly body: string
          readonly author: {readonly login: string} | null
          readonly createdAt: string
          readonly updatedAt: string
        }[]
        readonly pageInfo: {
          readonly hasNextPage: boolean
          readonly endCursor: string | null
        }
      }
    } | null
  }
}

/**
 * GraphQL response for adding a discussion comment.
 */
export interface AddDiscussionCommentResponse {
  readonly addDiscussionComment: {
    readonly comment: {
      readonly id: string
      readonly url: string
    }
  }
}

/**
 * GraphQL response for updating a discussion comment.
 */
export interface UpdateDiscussionCommentResponse {
  readonly updateDiscussionComment: {
    readonly comment: {
      readonly id: string
      readonly url: string
    }
  }
}
