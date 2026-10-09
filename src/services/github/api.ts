import type {Logger} from '../../shared/logger.js'
import type {Octokit} from './types.js'
import {toErrorMessage} from '../../shared/errors.js'

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
      error: toErrorMessage(error),
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
      error: toErrorMessage(error),
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
      error: toErrorMessage(error),
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
      error: toErrorMessage(error),
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
      error: toErrorMessage(error),
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
      error: toErrorMessage(error),
    })
    return false
  }
}

/**
 * List the label names currently on an issue or PR (one call, up to GitHub's 100-label-per-item cap).
 * Returns `null` on any API failure so callers can tell "unreadable" apart from "no labels".
 */
export async function listLabelsOnIssue(
  client: Octokit,
  repoString: string,
  issueNumber: number,
  logger: Logger,
): Promise<readonly string[] | null> {
  try {
    const {owner, repo} = parseRepoString(repoString)
    const {data} = await client.rest.issues.listLabelsOnIssue({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    })
    return data.map(label => label.name)
  } catch (error) {
    logger.warning('Failed to list labels on issue', {issueNumber, error: toErrorMessage(error)})
    return null
  }
}

const EVENTS_PAGE_SIZE = 100
// The last page can hold only unrelated events; look back at most this many pages (including the last) before giving up.
const MAX_EVENT_PAGES_SCANNED = 3

/** Page number of the `rel="last"` entry in a GitHub `Link` header, or `null` when there is no further paging. */
function parseLastPage(linkHeader: string | number | undefined): number | null {
  if (typeof linkHeader !== 'string') return null
  for (const part of linkHeader.split(',')) {
    if (part.includes('rel="last"') === false) continue
    const match = /[?&]page=(\d+)/.exec(part)
    if (match?.[1] != null) return Number(match[1])
  }
  return null
}

interface IssueEventLike {
  readonly event: string
  readonly created_at: string
  readonly label?: {readonly name: string}
}

/**
 * Epoch ms of the most recent `labeled` event for each of `labels` on an issue or PR, found in ONE pass over the
 * (chronologically ordered) issue events: the LAST page first (learned from the `Link` header on page 1), then a
 * bounded look-back toward page 1 until every requested label has been seen. Page 1 is reused, never refetched, so
 * a single-page item costs one call. The returned map is keyed by the label strings passed in and omits labels with
 * no `labeled` event within the scanned pages. Returns `null` on any API failure so "unreadable" is distinguishable
 * from "not found".
 */
export async function getLatestLabeledEventTimes(
  client: Octokit,
  repoString: string,
  issueNumber: number,
  labels: readonly string[],
  logger: Logger,
): Promise<ReadonlyMap<string, number> | null> {
  try {
    const {owner, repo} = parseRepoString(repoString)
    const fetchPage = async (page: number) =>
      client.rest.issues.listEvents({
        owner,
        repo,
        issue_number: issueNumber,
        per_page: EVENTS_PAGE_SIZE,
        page,
      })

    const wanted = new Map(labels.map(label => [label.toLowerCase(), label]))
    const found = new Map<string, number>()
    const first = await fetchPage(1)
    const lastPage = parseLastPage(first.headers.link) ?? 1
    let page = lastPage
    let response = lastPage === 1 ? first : await fetchPage(lastPage)
    for (let scanned = 0; scanned < MAX_EVENT_PAGES_SCANNED; scanned++) {
      // Pages are scanned newest-first, so a label already found came from a later page and is never overwritten.
      const pageLatest = new Map<string, number>()
      for (const event of response.data as readonly IssueEventLike[]) {
        const label = event.event === 'labeled' ? wanted.get(event.label?.name.toLowerCase() ?? '') : undefined
        if (label == null) continue
        const at = Date.parse(event.created_at)
        if (Number.isNaN(at)) continue
        if (at > (pageLatest.get(label) ?? Number.NEGATIVE_INFINITY)) pageLatest.set(label, at)
      }
      for (const [label, at] of pageLatest) {
        if (found.has(label) === false) found.set(label, at)
      }
      if (found.size === wanted.size || page <= 1 || scanned + 1 >= MAX_EVENT_PAGES_SCANNED) break
      page -= 1
      response = page === 1 ? first : await fetchPage(page)
    }
    return found
  } catch (error) {
    logger.warning('Failed to read issue events', {issueNumber, labels, error: toErrorMessage(error)})
    return null
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
      error: toErrorMessage(error),
    })
    return 'main'
  }
}

// Maps GitHub repository permission levels to author_association equivalents.
// Used when the webhook payload doesn't include the sender's association
// (e.g., pull_request events where sender != PR author).
const PERMISSION_TO_ASSOCIATION: Readonly<Record<string, string>> = {
  admin: 'OWNER',
  maintain: 'MEMBER',
  write: 'COLLABORATOR',
  triage: 'COLLABORATOR',
}

/**
 * Resolve a user's repository permission level as an author_association equivalent.
 * Used for review_requested and ready_for_review events where the webhook payload
 * carries the PR author's association instead of the sender's.
 * Returns null for read/none permissions or on API error.
 */
export async function getRepositoryPermission(
  client: Octokit,
  owner: string,
  repo: string,
  username: string,
  logger: Logger,
): Promise<string | null> {
  try {
    const {data} = await client.rest.repos.getCollaboratorPermissionLevel({owner, repo, username})
    const association = PERMISSION_TO_ASSOCIATION[data.permission] ?? null
    logger.debug('Resolved sender permission', {username, permission: data.permission, association})
    return association
  } catch (error) {
    logger.warning('Failed to resolve sender permission', {username, error: toErrorMessage(error)})
    return null
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
      error: toErrorMessage(error),
    })
    return null
  }
}
