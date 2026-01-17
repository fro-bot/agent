import type {CommentTarget, Octokit} from '../github/types.js'
import type {Logger} from '../logger.js'
import type {
  AddDiscussionCommentResponse,
  DiscussionQueryResponse,
  PostCommentOptions,
  PostCommentResult,
  UpdateDiscussionCommentResponse,
} from './types.js'
import {BOT_COMMENT_MARKER} from '../github/types.js'
import {findBotComment, readThread} from './reader.js'

/**
 * Check if comment body contains bot marker.
 * Marker is hidden HTML comment for reliable identification.
 */
export function isBotComment(body: string): boolean {
  return body.includes(BOT_COMMENT_MARKER)
}

/**
 * Create new comment on issue or PR.
 * Uses REST API (issues.createComment works for both).
 */
async function createIssueComment(
  client: Octokit,
  target: CommentTarget,
  body: string,
  logger: Logger,
): Promise<PostCommentResult | null> {
  try {
    const {data} = await client.rest.issues.createComment({
      owner: target.owner,
      repo: target.repo,
      issue_number: target.number,
      body,
    })
    logger.debug('Created issue comment', {commentId: data.id, target})
    return {
      commentId: data.id,
      created: true,
      updated: false,
      url: data.html_url,
    }
  } catch (error) {
    logger.warning('Failed to create issue comment', {
      target,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * Update existing issue/PR comment.
 * Idempotency: prevents duplicate bot comments on re-runs.
 */
async function updateIssueComment(
  client: Octokit,
  target: CommentTarget,
  commentId: number,
  body: string,
  logger: Logger,
): Promise<PostCommentResult | null> {
  try {
    const {data} = await client.rest.issues.updateComment({
      owner: target.owner,
      repo: target.repo,
      comment_id: commentId,
      body,
    })
    logger.debug('Updated issue comment', {commentId: data.id, target})
    return {
      commentId: data.id,
      created: false,
      updated: true,
      url: data.html_url,
    }
  } catch (error) {
    logger.warning('Failed to update issue comment', {
      target,
      commentId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

const GET_DISCUSSION_ID_QUERY = `
  query GetDiscussionId($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      discussion(number: $number) {
        id
        title
        body
        author { login }
        comments(first: 100) {
          nodes {
            id
            body
            author { login }
            createdAt
            updatedAt
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`

const ADD_DISCUSSION_COMMENT_MUTATION = `
  mutation AddDiscussionComment($discussionId: ID!, $body: String!) {
    addDiscussionComment(input: {discussionId: $discussionId, body: $body}) {
      comment { id url }
    }
  }
`

const UPDATE_DISCUSSION_COMMENT_MUTATION = `
  mutation UpdateDiscussionComment($commentId: ID!, $body: String!) {
    updateDiscussionComment(input: {commentId: $commentId, body: $body}) {
      comment { id url }
    }
  }
`

/**
 * Post or update discussion comment using GraphQL.
 * Discussions require GraphQL for both read and write operations.
 */
async function postDiscussionComment(
  client: Octokit,
  target: CommentTarget,
  options: PostCommentOptions,
  logger: Logger,
): Promise<PostCommentResult | null> {
  try {
    const threadResult = await client.graphql<DiscussionQueryResponse>(GET_DISCUSSION_ID_QUERY, {
      owner: target.owner,
      repo: target.repo,
      number: target.number,
    })

    const discussion = threadResult.repository.discussion
    if (discussion == null) {
      logger.warning('Discussion not found', {target})
      return null
    }

    if (options.updateExisting === true && options.botLogin != null) {
      const thread = await readThread(client, target, options.botLogin, logger)
      if (thread != null) {
        const existingComment = findBotComment(thread, options.botLogin)
        if (existingComment != null && typeof existingComment.id === 'string') {
          const updateResult = await client.graphql<UpdateDiscussionCommentResponse>(
            UPDATE_DISCUSSION_COMMENT_MUTATION,
            {commentId: existingComment.id, body: options.body},
          )
          logger.debug('Updated discussion comment', {commentId: existingComment.id})
          return {
            commentId: updateResult.updateDiscussionComment.comment.id,
            created: false,
            updated: true,
            url: updateResult.updateDiscussionComment.comment.url,
          }
        }
      }
    }

    const result = await client.graphql<AddDiscussionCommentResponse>(ADD_DISCUSSION_COMMENT_MUTATION, {
      discussionId: discussion.id,
      body: options.body,
    })

    logger.debug('Created discussion comment', {discussionId: discussion.id})
    return {
      commentId: result.addDiscussionComment.comment.id,
      created: true,
      updated: false,
      url: result.addDiscussionComment.comment.url,
    }
  } catch (error) {
    logger.warning('Failed to post discussion comment', {
      target,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

export async function postComment(
  client: Octokit,
  target: CommentTarget,
  options: PostCommentOptions,
  logger: Logger,
): Promise<PostCommentResult | null> {
  if (target.type === 'discussion') {
    return postDiscussionComment(client, target, options, logger)
  }

  if (options.updateExisting === true && options.botLogin != null) {
    const thread = await readThread(client, target, options.botLogin, logger)
    if (thread != null) {
      const existingComment = findBotComment(thread, options.botLogin)
      if (existingComment != null && typeof existingComment.id === 'number') {
        return updateIssueComment(client, target, existingComment.id, options.body, logger)
      }
    }
  }

  return createIssueComment(client, target, options.body, logger)
}
