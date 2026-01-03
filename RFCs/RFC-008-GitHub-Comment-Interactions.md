# RFC-008: GitHub Comment Interactions

**Status:** Pending
**Priority:** MUST
**Complexity:** Medium
**Phase:** 3

---

## Summary

Implement core comment interactions for Issues, PRs, and Discussions. This includes reading threads, posting comments, updating existing comments (idempotency), and error message formatting.

## Dependencies

- **Builds Upon:** RFC-003 (GitHub Client), RFC-005 (Triggers), RFC-006 (Security), RFC-007 (Observability)
- **Enables:** RFC-009 (Reviews), RFC-010 (Delegated Work)

## Features Addressed

| Feature ID | Feature Name                      | Priority |
| ---------- | --------------------------------- | -------- |
| F2         | Issue Comment Interaction         | P0       |
| F3         | Discussion Comment Interaction    | P0       |
| F4         | PR Conversation Comments          | P0       |
| F8         | Comment Idempotency               | P0       |
| F33        | Error Message Format              | P0       |
| F43        | Reactions & Labels Acknowledgment | P0       |

## Technical Specification

### 1. File Structure

```
src/lib/
├── comments/
│   ├── types.ts          # Comment-related types
│   ├── reader.ts         # Read issue/PR/discussion threads
│   ├── writer.ts         # Post and update comments
│   ├── error-format.ts   # Error message formatting
│   ├── reactions.ts      # Reaction and label management
│   └── index.ts          # Public exports
```

### 2. Comment Types (`src/lib/comments/types.ts`)

```typescript
import type {CommentTarget} from "../github/types.js"

export interface ThreadComment {
  /** Comment ID - number for REST API (issues/PRs), string (Node ID) for GraphQL (discussions) */
  readonly id: number | string
  readonly body: string
  readonly author: string
  readonly authorAssociation: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly isBot: boolean
}

export interface Thread {
  readonly target: CommentTarget
  readonly title: string
  readonly body: string
  readonly author: string
  readonly state: string
  readonly locked: boolean
  readonly comments: readonly ThreadComment[]
}

export interface PostCommentOptions {
  readonly target: CommentTarget
  readonly body: string
  readonly updateExisting: boolean
}

export interface PostCommentResult {
  /** Comment ID - number for REST API, string (Node ID) for GraphQL */
  readonly commentId: number | string
  readonly created: boolean
  readonly updated: boolean
  readonly url: string
}

export interface ErrorInfo {
  readonly type: ErrorType
  readonly message: string
  readonly details?: string
  readonly retryable: boolean
  readonly suggestedAction?: string
}

export type ErrorType =
  | "rate_limit"
  | "llm_timeout"
  | "llm_error"
  | "cache_corruption"
  | "permission_denied"
  | "api_error"
  | "internal_error"
```

### 3. Thread Reader (`src/lib/comments/reader.ts`)

```typescript
import type {Octokit, CommentTarget} from "../github/types.js"
import type {Thread, ThreadComment, Logger} from "./types.js"

/**
 * Read full thread (issue or PR) with all comments.
 */
export async function readThread(octokit: Octokit, target: CommentTarget, logger: Logger): Promise<Thread> {
  const {type, number, owner, repo} = target

  logger.debug("Reading thread", {type, number})

  if (type === "discussion") {
    return readDiscussionThread(octokit, target, logger)
  }

  // Issues and PRs use the same endpoint
  const {data: issue} = await octokit.rest.issues.get({
    owner,
    repo,
    issue_number: number,
  })

  // Fetch all comments with pagination
  const comments = await fetchAllComments(octokit, target, logger)

  return {
    target,
    title: issue.title,
    body: issue.body ?? "",
    author: issue.user?.login ?? "unknown",
    state: issue.state,
    locked: issue.locked ?? false,
    comments,
  }
}

/**
 * Fetch all comments with pagination.
 */
async function fetchAllComments(
  octokit: Octokit,
  target: CommentTarget,
  logger: Logger,
): Promise<readonly ThreadComment[]> {
  const {number, owner, repo} = target
  const comments: ThreadComment[] = []

  let page = 1
  const perPage = 100

  while (true) {
    const {data} = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: number,
      page,
      per_page: perPage,
    })

    for (const comment of data) {
      comments.push({
        id: comment.id,
        body: comment.body ?? "",
        author: comment.user?.login ?? "unknown",
        authorAssociation: comment.author_association ?? "NONE",
        createdAt: comment.created_at,
        updatedAt: comment.updated_at,
        isBot: comment.user?.login?.endsWith("[bot]") ?? false,
      })
    }

    if (data.length < perPage) {
      break
    }

    page++

    // Safety limit
    if (page > 50) {
      logger.warning("Hit pagination limit for comments", {number, pages: page})
      break
    }
  }

  logger.debug("Fetched comments", {count: comments.length})
  return comments
}

/**
 * Read discussion thread (requires GraphQL).
 */
async function readDiscussionThread(octokit: Octokit, target: CommentTarget, logger: Logger): Promise<Thread> {
  const {number, owner, repo} = target

  const query = `
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        discussion(number: $number) {
          title
          body
          author { login }
          locked
          comments(first: 100) {
            nodes {
              id
              body
              author { login }
              createdAt
              updatedAt
            }
          }
        }
      }
    }
  `

  try {
    const result = await octokit.graphql<{
      repository: {
        discussion: {
          title: string
          body: string
          author: {login: string} | null
          locked: boolean
          comments: {
            nodes: Array<{
              id: string
              body: string
              author: {login: string} | null
              createdAt: string
              updatedAt: string
            }>
          }
        }
      }
    }>(query, {owner, repo, number})

    const discussion = result.repository.discussion

    return {
      target,
      title: discussion.title,
      body: discussion.body,
      author: discussion.author?.login ?? "unknown",
      state: "open",
      locked: discussion.locked,
      comments: discussion.comments.nodes.map(c => ({
        // GraphQL returns Node IDs (e.g., "DC_kwDOABCD1234") - store as-is
        // These IDs are needed for GraphQL mutations (replies, updates)
        id: c.id,
        body: c.body,
        author: c.author?.login ?? "unknown",
        authorAssociation: "NONE", // Not available in discussion GraphQL
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        isBot: c.author?.login?.endsWith("[bot]") ?? false,
      })),
    }
  } catch (error) {
    logger.error("Failed to read discussion", {
      number,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

/**
 * Find the most recent comment from the bot.
 */
export function findBotComment(thread: Thread, botLogin: string): ThreadComment | null {
  const botComments = thread.comments.filter(c => c.author === botLogin || c.author === `${botLogin}[bot]`)

  if (botComments.length === 0) {
    return null
  }

  // Return most recent
  return botComments[botComments.length - 1]
}
```

### 4. Comment Writer (`src/lib/comments/writer.ts`)

```typescript
import type {Octokit, CommentTarget} from "../github/types.js"
import type {PostCommentOptions, PostCommentResult, Thread, Logger} from "./types.js"
import {BOT_COMMENT_MARKER} from "../github/types.js"
import {findBotComment} from "./reader.js"

/**
 * Post or update a comment on an issue/PR.
 */
export async function postComment(
  octokit: Octokit,
  options: PostCommentOptions,
  botLogin: string,
  thread: Thread | null,
  logger: Logger,
): Promise<PostCommentResult> {
  const {target, body, updateExisting} = options
  const {type, number, owner, repo} = target

  if (type === "discussion") {
    return postDiscussionComment(octokit, options, logger)
  }

  // Check for existing bot comment if updating
  let existingComment = null
  if (updateExisting && thread != null) {
    existingComment = findBotComment(thread, botLogin)
  }

  if (existingComment != null) {
    logger.debug("Updating existing comment", {commentId: existingComment.id})

    const {data} = await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existingComment.id,
      body,
    })

    return {
      commentId: data.id,
      created: false,
      updated: true,
      url: data.html_url,
    }
  }

  // Create new comment
  logger.debug("Creating new comment", {number})

  const {data} = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: number,
    body,
  })

  return {
    commentId: data.id,
    created: true,
    updated: false,
    url: data.html_url,
  }
}

/**
 * Post discussion comment (requires GraphQL).
 */
async function postDiscussionComment(
  octokit: Octokit,
  options: PostCommentOptions,
  logger: Logger,
): Promise<PostCommentResult> {
  const {target, body} = options
  const {number, owner, repo} = target

  // First, get the discussion ID
  const discussionQuery = `
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        discussion(number: $number) {
          id
        }
      }
    }
  `

  const discussionResult = await octokit.graphql<{
    repository: {discussion: {id: string}}
  }>(discussionQuery, {owner, repo, number})

  const discussionId = discussionResult.repository.discussion.id

  // Post comment
  const mutation = `
    mutation($discussionId: ID!, $body: String!) {
      addDiscussionComment(input: { discussionId: $discussionId, body: $body }) {
        comment {
          id
          url
        }
      }
    }
  `

  const result = await octokit.graphql<{
    addDiscussionComment: {comment: {id: string; url: string}}
  }>(mutation, {discussionId, body})

  const comment = result.addDiscussionComment.comment

  // GraphQL returns Node IDs (e.g., "DC_kwDOABCD1234") - keep as string
  // Do NOT convert to number as it will lose information
  return {
    commentId: comment.id,
    created: true,
    updated: false,
    url: comment.url,
  }
}

/**
 * Check if a comment body contains our marker.
 */
export function isBotComment(body: string): boolean {
  return body.includes(BOT_COMMENT_MARKER)
}
```

### 5. Error Formatting (`src/lib/comments/error-format.ts`)

```typescript
import type {ErrorInfo, ErrorType} from "./types.js"

/**
 * Format error for display in GitHub comment.
 */
export function formatErrorComment(error: ErrorInfo): string {
  const icon = error.retryable ? "⚠️" : "❌"
  const typeLabel = formatErrorType(error.type)

  let content = `${icon} **${typeLabel}**\n\n${error.message}`

  if (error.details != null && error.details.length > 0) {
    content += `\n\n<details>\n<summary>Details</summary>\n\n\`\`\`\n${error.details}\n\`\`\`\n\n</details>`
  }

  if (error.suggestedAction != null) {
    content += `\n\n💡 **Suggested action:** ${error.suggestedAction}`
  }

  return content
}

/**
 * Create ErrorInfo from exception.
 */
export function createErrorInfo(
  type: ErrorType,
  error: Error | string,
  options: Partial<{retryable: boolean; suggestedAction: string}> = {},
): ErrorInfo {
  const message = error instanceof Error ? error.message : error
  const details = error instanceof Error ? error.stack : undefined

  return {
    type,
    message,
    details,
    retryable: options.retryable ?? isRetryableError(type),
    suggestedAction: options.suggestedAction ?? getDefaultSuggestedAction(type),
  }
}

function formatErrorType(type: ErrorType): string {
  switch (type) {
    case "rate_limit":
      return "Rate Limit Exceeded"
    case "llm_timeout":
      return "AI Response Timeout"
    case "llm_error":
      return "AI Provider Error"
    case "cache_corruption":
      return "Cache Corruption Detected"
    case "permission_denied":
      return "Permission Denied"
    case "api_error":
      return "GitHub API Error"
    case "internal_error":
      return "Internal Error"
  }
}

function isRetryableError(type: ErrorType): boolean {
  switch (type) {
    case "rate_limit":
    case "llm_timeout":
    case "api_error":
      return true
    default:
      return false
  }
}

function getDefaultSuggestedAction(type: ErrorType): string {
  switch (type) {
    case "rate_limit":
      return "Please wait a few minutes and try again."
    case "llm_timeout":
      return "The request may have been too complex. Try simplifying or retry later."
    case "llm_error":
      return "Check the AI provider status and try again."
    case "cache_corruption":
      return "The agent will start fresh. No action needed."
    case "permission_denied":
      return "Ensure you have the required permissions (OWNER, MEMBER, or COLLABORATOR)."
    case "api_error":
      return "Wait a moment and retry. If the issue persists, check GitHub status."
    case "internal_error":
      return "Please report this issue to the repository maintainers."
  }
}

/**
 * Create error comment for rate limit.
 */
export function createRateLimitError(retryAfter: number | null): ErrorInfo {
  const message =
    retryAfter != null
      ? `GitHub API rate limit exceeded. Reset in ${Math.ceil(retryAfter / 60)} minutes.`
      : "GitHub API rate limit exceeded."

  return createErrorInfo("rate_limit", message, {
    retryable: true,
    suggestedAction:
      retryAfter != null
        ? `Please retry after ${new Date(Date.now() + retryAfter * 1000).toISOString()}`
        : "Please wait a few minutes and try again.",
  })
}

/**
 * Create error comment for LLM timeout.
 */
export function createLLMTimeoutError(timeoutMs: number): ErrorInfo {
  return createErrorInfo("llm_timeout", `The AI did not respond within ${Math.round(timeoutMs / 1000)} seconds.`, {
    retryable: true,
    suggestedAction: "The request may have been too complex. Try breaking it into smaller parts or retry.",
  })
}
```

### 6. Reactions & Labels (`src/lib/comments/reactions.ts`)

```typescript
import type {Octokit, CommentTarget} from "../github/types.js"
import type {Logger} from "./types.js"

export type ReactionType = "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes"

export interface ReactionResult {
  readonly success: boolean
  readonly reactionId?: number
  readonly error?: string
}

export interface LabelResult {
  readonly success: boolean
  readonly created?: boolean
  readonly error?: string
}

const PEACE_SIGN_VARIANTS = ["✌️", "✌🏻", "✌🏼", "✌🏽", "✌🏾", "✌🏿", "☮️"] as const

/**
 * Add a reaction to a comment.
 * Non-fatal: logs warning on failure, never throws.
 */
export async function addReaction(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  reaction: ReactionType,
  logger: Logger,
): Promise<ReactionResult> {
  try {
    const {data} = await octokit.rest.reactions.createForIssueComment({
      owner,
      repo,
      comment_id: commentId,
      content: reaction,
    })

    logger.debug("Added reaction", {commentId, reaction, reactionId: data.id})
    return {success: true, reactionId: data.id}
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warning("Failed to add reaction (non-fatal)", {commentId, reaction, error: message})
    return {success: false, error: message}
  }
}

/**
 * Remove a specific reaction from a comment.
 * Non-fatal: logs warning on failure, never throws.
 */
export async function removeReaction(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  reactionId: number,
  logger: Logger,
): Promise<ReactionResult> {
  try {
    await octokit.rest.reactions.deleteForIssueComment({
      owner,
      repo,
      comment_id: commentId,
      reaction_id: reactionId,
    })

    logger.debug("Removed reaction", {commentId, reactionId})
    return {success: true}
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warning("Failed to remove reaction (non-fatal)", {commentId, reactionId, error: message})
    return {success: false, error: message}
  }
}

/**
 * Find bot's reaction on a comment.
 */
export async function findBotReaction(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  botLogin: string,
  reaction: ReactionType,
  logger: Logger,
): Promise<number | null> {
  try {
    const {data: reactions} = await octokit.rest.reactions.listForIssueComment({
      owner,
      repo,
      comment_id: commentId,
      content: reaction,
      per_page: 100,
    })

    const botReaction = reactions.find(r => r.user?.login === botLogin || r.user?.login === `${botLogin}[bot]`)

    return botReaction?.id ?? null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warning("Failed to find bot reaction (non-fatal)", {commentId, error: message})
    return null
  }
}

/**
 * Get a random peace sign emoji (with random skin tone or peace symbol).
 */
export function getRandomPeaceSign(): string {
  const index = Math.floor(Math.random() * PEACE_SIGN_VARIANTS.length)
  return PEACE_SIGN_VARIANTS[index]
}

/**
 * Add or create a label on an issue/PR.
 * Creates the label if it doesn't exist.
 * Non-fatal: logs warning on failure, never throws.
 */
export async function addLabel(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  labelName: string,
  labelColor: string,
  logger: Logger,
): Promise<LabelResult> {
  try {
    // Ensure label exists (create if not)
    try {
      await octokit.rest.issues.getLabel({owner, repo, name: labelName})
    } catch {
      // Label doesn't exist, create it
      await octokit.rest.issues.createLabel({
        owner,
        repo,
        name: labelName,
        color: labelColor,
        description: "Agent is currently working on this issue/PR",
      })
      logger.debug("Created label", {labelName})
    }

    // Add label to issue/PR
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: issueNumber,
      labels: [labelName],
    })

    logger.debug("Added label", {issueNumber, labelName})
    return {success: true, created: false}
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warning("Failed to add label (non-fatal)", {issueNumber, labelName, error: message})
    return {success: false, error: message}
  }
}

/**
 * Remove a label from an issue/PR.
 * Non-fatal: logs warning on failure, never throws.
 */
export async function removeLabel(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  labelName: string,
  logger: Logger,
): Promise<LabelResult> {
  try {
    await octokit.rest.issues.removeLabel({
      owner,
      repo,
      issue_number: issueNumber,
      name: labelName,
    })

    logger.debug("Removed label", {issueNumber, labelName})
    return {success: true}
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 404 is expected if label wasn't there
    if (message.includes("404") || message.includes("Not Found")) {
      logger.debug("Label not present, nothing to remove", {issueNumber, labelName})
      return {success: true}
    }
    logger.warning("Failed to remove label (non-fatal)", {issueNumber, labelName, error: message})
    return {success: false, error: message}
  }
}

/**
 * Acknowledge work start: add 👀 reaction and "agent: working" label.
 */
export async function acknowledgeWorkStart(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  commentId: number,
  logger: Logger,
): Promise<{reaction: ReactionResult; label: LabelResult}> {
  const [reaction, label] = await Promise.all([
    addReaction(octokit, owner, repo, commentId, "eyes", logger),
    addLabel(octokit, owner, repo, issueNumber, "agent: working", "7057ff", logger),
  ])

  return {reaction, label}
}

/**
 * Acknowledge work completion: replace 👀 with ✌🏽 and remove "agent: working" label.
 */
export async function acknowledgeWorkComplete(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  commentId: number,
  botLogin: string,
  logger: Logger,
): Promise<{removeReaction: ReactionResult; label: LabelResult}> {
  // Find and remove the 👀 reaction
  const eyesReactionId = await findBotReaction(octokit, owner, repo, commentId, botLogin, "eyes", logger)

  let removeReactionResult: ReactionResult = {success: true}
  if (eyesReactionId != null) {
    removeReactionResult = await removeReaction(octokit, owner, repo, commentId, eyesReactionId, logger)
  }

  // Remove the label
  const labelResult = await removeLabel(octokit, owner, repo, issueNumber, "agent: working", logger)

  // Note: Adding the peace sign reaction is done via comment body since
  // GitHub's reaction API doesn't support Unicode emoji directly.
  // The run summary comment will include the peace sign indicator.

  return {removeReaction: removeReactionResult, label: labelResult}
}
```

### 7. Public Exports (`src/lib/comments/index.ts`)

```typescript
export {readThread, findBotComment} from "./reader.js"
export {postComment, isBotComment} from "./writer.js"
export {formatErrorComment, createErrorInfo, createRateLimitError, createLLMTimeoutError} from "./error-format.js"
export {
  addReaction,
  removeReaction,
  findBotReaction,
  addLabel,
  removeLabel,
  acknowledgeWorkStart,
  acknowledgeWorkComplete,
  getRandomPeaceSign,
} from "./reactions.js"

export type {Thread, ThreadComment, PostCommentOptions, PostCommentResult, ErrorInfo, ErrorType} from "./types.js"
export type {ReactionType, ReactionResult, LabelResult} from "./reactions.js"
```

## Acceptance Criteria

### Thread Reading & Writing

- [ ] Issue threads are read with full comment history
- [ ] PR threads are read with full comment history
- [ ] Discussion threads are read via GraphQL
- [ ] Pagination handles large comment threads (100+ comments)
- [ ] New comments are created when no bot comment exists
- [ ] Existing bot comments are updated when `updateExisting` is true
- [ ] Bot comments are identified by marker
- [ ] Error comments include type, message, and suggested action
- [ ] Rate limit errors include reset time
- [ ] Retryable errors are marked appropriately

### Reactions & Labels (F43)

- [ ] Agent adds 👀 (eyes) reaction to triggering comment on receipt
- [ ] Agent adds "agent: working" label to issue/PR when starting work
- [ ] "agent: working" label is created automatically if it doesn't exist
- [ ] Agent removes 👀 reaction on completion
- [ ] Agent removes "agent: working" label on completion (success or failure)
- [ ] All reaction/label operations are non-fatal (warn on failure, don't fail run)
- [ ] Bot can find and clean up its own reactions

## Test Cases

### Thread Reading Tests

```typescript
describe("readThread", () => {
  it("reads issue with comments", async () => {
    const thread = await readThread(
      mockOctokit,
      {
        type: "issue",
        number: 1,
        owner: "owner",
        repo: "repo",
      },
      logger,
    )

    expect(thread.title).toBeDefined()
    expect(thread.comments).toBeInstanceOf(Array)
  })

  it("handles locked issues", async () => {
    const thread = await readThread(mockOctokit, lockedIssueTarget, logger)
    expect(thread.locked).toBe(true)
  })

  it("paginates large comment threads", async () => {
    // Mock 150 comments
    const thread = await readThread(mockOctokit, largeThreadTarget, logger)
    expect(thread.comments.length).toBeGreaterThan(100)
  })
})

describe("findBotComment", () => {
  it("finds bot comment by login", () => {
    const comment = findBotComment(mockThread, "fro-bot")
    expect(comment).not.toBeNull()
  })

  it("finds bot comment with [bot] suffix", () => {
    const comment = findBotComment(mockThread, "fro-bot")
    expect(comment?.author).toMatch(/fro-bot(\[bot\])?/)
  })

  it("returns null when no bot comment exists", () => {
    const comment = findBotComment(threadWithoutBotComment, "fro-bot")
    expect(comment).toBeNull()
  })
})
```

### Comment Writing Tests

```typescript
describe("postComment", () => {
  it("creates new comment when none exists", async () => {
    const result = await postComment(
      mockOctokit,
      {target, body: "Test", updateExisting: true},
      "fro-bot",
      threadWithoutBotComment,
      logger,
    )

    expect(result.created).toBe(true)
    expect(result.updated).toBe(false)
  })

  it("updates existing comment when found", async () => {
    const result = await postComment(
      mockOctokit,
      {target, body: "Updated", updateExisting: true},
      "fro-bot",
      threadWithBotComment,
      logger,
    )

    expect(result.created).toBe(false)
    expect(result.updated).toBe(true)
  })

  it("creates new comment when updateExisting is false", async () => {
    const result = await postComment(
      mockOctokit,
      {target, body: "New", updateExisting: false},
      "fro-bot",
      threadWithBotComment,
      logger,
    )

    expect(result.created).toBe(true)
  })
})
```

### Error Formatting Tests

```typescript
describe("formatErrorComment", () => {
  it("includes error type label", () => {
    const formatted = formatErrorComment({
      type: "rate_limit",
      message: "Rate limited",
      retryable: true,
    })

    expect(formatted).toContain("Rate Limit Exceeded")
  })

  it("includes suggested action", () => {
    const formatted = formatErrorComment({
      type: "rate_limit",
      message: "Rate limited",
      retryable: true,
      suggestedAction: "Wait 5 minutes",
    })

    expect(formatted).toContain("Wait 5 minutes")
  })

  it("uses correct icon for retryable errors", () => {
    const retryable = formatErrorComment({type: "rate_limit", message: "", retryable: true})
    const fatal = formatErrorComment({type: "internal_error", message: "", retryable: false})

    expect(retryable).toContain("⚠️")
    expect(fatal).toContain("❌")
  })
})
```

### Reactions & Labels Tests

```typescript
describe("addReaction", () => {
  it("adds eyes reaction to comment", async () => {
    const result = await addReaction(mockOctokit, "owner", "repo", 123, "eyes", logger)
    expect(result.success).toBe(true)
    expect(result.reactionId).toBeDefined()
  })

  it("returns success false on API error (non-fatal)", async () => {
    mockOctokit.rest.reactions.createForIssueComment.mockRejectedValue(new Error("API Error"))
    const result = await addReaction(mockOctokit, "owner", "repo", 123, "eyes", logger)
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })
})

describe("addLabel", () => {
  it("creates label if it does not exist", async () => {
    mockOctokit.rest.issues.getLabel.mockRejectedValue(new Error("Not Found"))
    const result = await addLabel(mockOctokit, "owner", "repo", 1, "agent: working", "7057ff", logger)
    expect(mockOctokit.rest.issues.createLabel).toHaveBeenCalled()
    expect(result.success).toBe(true)
  })

  it("adds existing label to issue", async () => {
    const result = await addLabel(mockOctokit, "owner", "repo", 1, "agent: working", "7057ff", logger)
    expect(result.success).toBe(true)
  })
})

describe("removeLabel", () => {
  it("removes label from issue", async () => {
    const result = await removeLabel(mockOctokit, "owner", "repo", 1, "agent: working", logger)
    expect(result.success).toBe(true)
  })

  it("succeeds silently if label not present (404)", async () => {
    mockOctokit.rest.issues.removeLabel.mockRejectedValue(new Error("404 Not Found"))
    const result = await removeLabel(mockOctokit, "owner", "repo", 1, "agent: working", logger)
    expect(result.success).toBe(true)
  })
})

describe("acknowledgeWorkStart", () => {
  it("adds eyes reaction and working label in parallel", async () => {
    const result = await acknowledgeWorkStart(mockOctokit, "owner", "repo", 1, 123, logger)
    expect(result.reaction.success).toBe(true)
    expect(result.label.success).toBe(true)
  })
})

describe("acknowledgeWorkComplete", () => {
  it("removes eyes reaction and working label", async () => {
    const result = await acknowledgeWorkComplete(mockOctokit, "owner", "repo", 1, 123, "fro-bot", logger)
    expect(result.removeReaction.success).toBe(true)
    expect(result.label.success).toBe(true)
  })
})

describe("getRandomPeaceSign", () => {
  it("returns a peace sign variant", () => {
    const sign = getRandomPeaceSign()
    expect(["✌️", "✌🏻", "✌🏼", "✌🏽", "✌🏾", "✌🏿", "☮️"]).toContain(sign)
  })
})
```

## Implementation Notes

1. **Discussion API**: Uses GraphQL; REST API doesn't support discussions
2. **Pagination safety**: Hard limit prevents infinite loops
3. **Comment identification**: Hidden HTML marker ensures accurate detection
4. **Error formatting**: Consistent structure for all error types
5. **Reactions are non-fatal**: All reaction/label operations catch errors and log warnings instead of failing the run
6. **Label auto-creation**: The "agent: working" label is created with purple color (#7057ff) if it doesn't exist

## Estimated Effort

- **Development**: 8-10 hours
- **Testing**: 4-5 hours
- **Total**: 12-15 hours
