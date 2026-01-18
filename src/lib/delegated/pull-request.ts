/**
 * Pull request operations for delegated work (RFC-010).
 *
 * Uses GitHub REST API for PR creation, updates, and management.
 */

import type {Octokit} from '../github/types.js'
import type {Logger} from '../logger.js'
import type {CreatePROptions, GeneratePRBodyOptions, PRResult, UpdatePROptions} from './types.js'

/**
 * Create a pull request.
 */
export async function createPullRequest(octokit: Octokit, options: CreatePROptions, logger: Logger): Promise<PRResult> {
  const {owner, repo, title, body, head, base, draft} = options

  logger.info('Creating pull request', {head, base, draft})

  const {data} = await octokit.rest.pulls.create({
    owner,
    repo,
    title,
    body,
    head,
    base,
    draft: draft ?? false,
  })

  logger.info('Pull request created', {number: data.number, url: data.html_url})

  return {
    number: data.number,
    url: data.html_url,
    title: data.title,
    state: data.state,
  }
}

/**
 * Find existing PR for a branch.
 *
 * Returns null if no open PR exists for the head branch.
 */
export async function findPRForBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  head: string,
  logger: Logger,
): Promise<PRResult | null> {
  const {data} = await octokit.rest.pulls.list({
    owner,
    repo,
    head: `${owner}:${head}`,
    state: 'open',
  })

  const pr = data[0]
  if (pr == null) {
    logger.debug('No PR found for branch', {head})
    return null
  }

  logger.debug('Found existing PR', {number: pr.number, head})

  return {
    number: pr.number,
    url: pr.html_url,
    title: pr.title,
    state: pr.state,
  }
}

/**
 * Update an existing PR.
 */
export async function updatePullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  options: UpdatePROptions,
  logger: Logger,
): Promise<PRResult> {
  logger.info('Updating pull request', {prNumber})

  if (options.title == null && options.body == null) {
    throw new Error('At least one of title or body must be provided for PR update')
  }

  const {data} = await octokit.rest.pulls.update({
    owner,
    repo,
    pull_number: prNumber,
    ...(options.title != null && {title: options.title}),
    ...(options.body != null && {body: options.body}),
  })

  return {
    number: data.number,
    url: data.html_url,
    title: data.title,
    state: data.state,
  }
}

/**
 * Add labels to a PR.
 *
 * No-op if labels array is empty.
 */
export async function addPRLabels(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  labels: readonly string[],
  logger: Logger,
): Promise<void> {
  if (labels.length === 0) return

  await octokit.rest.issues.addLabels({
    owner,
    repo,
    issue_number: prNumber,
    labels: [...labels],
  })

  logger.debug('Labels added to PR', {prNumber, labels})
}

/**
 * Request reviewers for a PR.
 *
 * No-op if reviewers array is empty.
 */
export async function requestReviewers(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  reviewers: readonly string[],
  logger: Logger,
): Promise<void> {
  if (reviewers.length === 0) return

  await octokit.rest.pulls.requestReviewers({
    owner,
    repo,
    pull_number: prNumber,
    reviewers: [...reviewers],
  })

  logger.debug('Reviewers requested', {prNumber, reviewers})
}

/**
 * Generate PR body with context.
 *
 * Includes description, changes list, issue reference, and session attribution.
 */
export function generatePRBody(options: GeneratePRBodyOptions): string {
  const parts: string[] = []

  parts.push(options.description)

  if (options.changes != null && options.changes.length > 0) {
    parts.push('\n## Changes\n')
    for (const change of options.changes) {
      parts.push(`- ${change}`)
    }
  }

  if (options.issueNumber != null) {
    parts.push(`\n\nCloses #${options.issueNumber}`)
  }

  if (options.sessionId != null) {
    parts.push(`\n\n---\n*Created by Fro Bot Agent (session: \`${options.sessionId}\`)*`)
  }

  return parts.join('\n')
}
