import type {Logger} from '../logger.js'
import type {Octokit} from './types.js'

type ReactionContent = '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes'

export interface RepoIdentifier {
  readonly owner: string
  readonly repo: string
}

/**
 * Parse "owner/repo" string into separate owner and repo parts.
 */
export function parseRepoString(repoString: string): RepoIdentifier {
  const [owner, repo] = repoString.split('/')
  if (owner == null || repo == null || owner.length === 0 || repo.length === 0) {
    throw new Error(`Invalid repository string: ${repoString}`)
  }
  return {owner, repo}
}

/**
 * Create a reaction on an issue comment.
 */
export async function createCommentReaction(
  client: Octokit,
  repoString: string,
  commentId: number,
  content: ReactionContent,
  logger: Logger,
): Promise<{id: number} | null> {
  try {
    const {owner, repo} = parseRepoString(repoString)
    const {data} = await client.rest.reactions.createForIssueComment({
      owner,
      repo,
      comment_id: commentId,
      content,
    })
    logger.debug('Created comment reaction', {commentId, content, reactionId: data.id})
    return {id: data.id}
  } catch (error) {
    logger.warning('Failed to create comment reaction', {
      commentId,
      content,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * List reactions on an issue comment.
 */
export async function listCommentReactions(
  client: Octokit,
  repoString: string,
  commentId: number,
  logger: Logger,
): Promise<readonly {id: number; content: string; userLogin: string | null}[]> {
  try {
    const {owner, repo} = parseRepoString(repoString)
    const {data} = await client.rest.reactions.listForIssueComment({
      owner,
      repo,
      comment_id: commentId,
      per_page: 100,
    })
    return data.map(r => ({
      id: r.id,
      content: r.content,
      userLogin: r.user?.login ?? null,
    }))
  } catch (error) {
    logger.warning('Failed to list comment reactions', {
      commentId,
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}

/**
 * Delete a reaction from an issue comment.
 */
export async function deleteCommentReaction(
  client: Octokit,
  repoString: string,
  commentId: number,
  reactionId: number,
  logger: Logger,
): Promise<boolean> {
  try {
    const {owner, repo} = parseRepoString(repoString)
    await client.rest.reactions.deleteForIssueComment({
      owner,
      repo,
      comment_id: commentId,
      reaction_id: reactionId,
    })
    logger.debug('Deleted comment reaction', {commentId, reactionId})
    return true
  } catch (error) {
    logger.warning('Failed to delete comment reaction', {
      commentId,
      reactionId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/**
 * Create or update a label in a repository.
 * Returns true if label was created/already exists, false on error.
 */
export async function ensureLabelExists(
  client: Octokit,
  repoString: string,
  name: string,
  color: string,
  description: string,
  logger: Logger,
): Promise<boolean> {
  const {owner, repo} = parseRepoString(repoString)

  try {
    await client.rest.issues.createLabel({
      owner,
      repo,
      name,
      color,
      description,
    })
    logger.debug('Created label', {name, color})
    return true
  } catch (error) {
    // 422 = label already exists, which is fine
    if (error instanceof Error && 'status' in error && (error as {status: number}).status === 422) {
      logger.debug('Label already exists', {name})
      return true
    }
    logger.warning('Failed to create label', {
      name,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/**
 * Add labels to an issue or PR.
 * Note: GitHub API uses issue_number for both issues and PRs.
 */
export async function addLabelsToIssue(
  client: Octokit,
  repoString: string,
  issueNumber: number,
  labels: readonly string[],
  logger: Logger,
): Promise<boolean> {
  try {
    const {owner, repo} = parseRepoString(repoString)
    await client.rest.issues.addLabels({
      owner,
      repo,
      issue_number: issueNumber,
      labels: [...labels],
    })
    logger.debug('Added labels to issue', {issueNumber, labels})
    return true
  } catch (error) {
    logger.warning('Failed to add labels to issue', {
      issueNumber,
      labels,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/**
 * Remove a label from an issue or PR.
 * Returns true if label was removed or wasn't present.
 */
export async function removeLabelFromIssue(
  client: Octokit,
  repoString: string,
  issueNumber: number,
  label: string,
  logger: Logger,
): Promise<boolean> {
  try {
    const {owner, repo} = parseRepoString(repoString)
    await client.rest.issues.removeLabel({
      owner,
      repo,
      issue_number: issueNumber,
      name: label,
    })
    logger.debug('Removed label from issue', {issueNumber, label})
    return true
  } catch (error) {
    // 404 = label not on issue, which is fine
    if (error instanceof Error && 'status' in error && (error as {status: number}).status === 404) {
      logger.debug('Label was not present on issue', {issueNumber, label})
      return true
    }
    logger.warning('Failed to remove label from issue', {
      issueNumber,
      label,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/**
 * Get the default branch of a repository.
 */
export async function getDefaultBranch(client: Octokit, repoString: string, logger: Logger): Promise<string> {
  try {
    const {owner, repo} = parseRepoString(repoString)
    const {data} = await client.rest.repos.get({owner, repo})
    return data.default_branch
  } catch (error) {
    logger.warning('Failed to get default branch', {
      repo: repoString,
      error: error instanceof Error ? error.message : String(error),
    })
    return 'main'
  }
}

/**
 * Get user information by username.
 * Used to get bot user ID for commit attribution.
 */
export async function getUserByUsername(
  client: Octokit,
  username: string,
  logger: Logger,
): Promise<{id: number; login: string} | null> {
  try {
    const {data} = await client.rest.users.getByUsername({username})
    return {id: data.id, login: data.login}
  } catch (error) {
    logger.debug('Failed to get user by username', {
      username,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}
