/**
 * Branch operations for delegated work (RFC-010).
 *
 * Uses GitHub Git Data API for branch creation, existence checking, and deletion.
 */

import type {Octokit} from '../github/types.js'
import type {Logger} from '../logger.js'
import type {BranchResult, CreateBranchOptions} from './types.js'

/**
 * Create a new branch from a base branch.
 *
 * Idempotent: if branch already exists, returns existing ref with `created: false`.
 */
export async function createBranch(
  octokit: Octokit,
  options: CreateBranchOptions,
  logger: Logger,
): Promise<BranchResult> {
  const {owner, repo, branchName, baseBranch} = options

  logger.info('Creating branch', {branchName, baseBranch})

  const {data: baseRef} = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${baseBranch}`,
  })

  const baseSha = baseRef.object.sha

  try {
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: baseSha,
    })

    logger.info('Branch created', {branchName, sha: baseSha})

    return {
      name: branchName,
      sha: baseSha,
      created: true,
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('Reference already exists')) {
      logger.info('Branch already exists', {branchName})

      const {data: existingRef} = await octokit.rest.git.getRef({
        owner,
        repo,
        ref: `heads/${branchName}`,
      })

      return {
        name: branchName,
        sha: existingRef.object.sha,
        created: false,
      }
    }

    throw error
  }
}

/**
 * Check if a branch exists.
 */
export async function branchExists(
  octokit: Octokit,
  owner: string,
  repo: string,
  branchName: string,
  logger: Logger,
): Promise<boolean> {
  try {
    await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${branchName}`,
    })
    logger.debug('Branch exists', {branchName})
    return true
  } catch {
    logger.debug('Branch does not exist', {branchName})
    return false
  }
}

/**
 * Delete a branch.
 *
 * Throws if branch doesn't exist or is protected.
 */
export async function deleteBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  branchName: string,
  logger: Logger,
): Promise<void> {
  logger.info('Deleting branch', {branchName})

  await octokit.rest.git.deleteRef({
    owner,
    repo,
    ref: `heads/${branchName}`,
  })

  logger.info('Branch deleted', {branchName})
}

/**
 * Generate a unique branch name with prefix, timestamp, and random suffix.
 *
 * Format: `{prefix}-{timestamp}-{random}` or `{prefix}-{timestamp}-{random}-{suffix}`
 */
export function generateBranchName(prefix: string, suffix?: string): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).slice(2, 8)
  const base = `${prefix}-${timestamp}-${random}`

  if (suffix != null) {
    return `${base}-${suffix}`
  }

  return base
}
