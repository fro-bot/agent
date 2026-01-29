import type {Octokit} from '../github/types.js'
import type {Logger} from '../logger.js'
import type {TriggerContext} from '../triggers/types.js'
import type {DiffContext} from './types.js'
import {toErrorMessage} from '../../utils/errors.js'
import {getPRDiff} from '../reviews/index.js'

const MAX_FILES_IN_CONTEXT = 50
const MAX_FILES_IN_PROMPT = 20

/**
 * Collects PR diff context for agent prompts (RFC-009 integration).
 *
 * Fetches and transforms PR diff data into a lightweight summary suitable for
 * inclusion in agent prompts. Limits file count to prevent token budget overflow
 * while providing sufficient context for code review decisions.
 *
 * Returns null gracefully on errors or when event type doesn't support diffs,
 * allowing the action to proceed without diff context.
 */
export async function collectDiffContext(
  triggerContext: TriggerContext,
  octokit: Octokit,
  repo: string,
  logger: Logger,
): Promise<DiffContext | null> {
  if (triggerContext.eventType !== 'pull_request') {
    return null
  }

  const prNumber = triggerContext.target?.number
  if (prNumber == null) {
    logger.debug('No PR number in trigger context, skipping diff collection')
    return null
  }

  const [owner, repoName] = repo.split('/')
  if (owner == null || repoName == null) {
    logger.warning('Invalid repo format, skipping diff collection', {repo})
    return null
  }

  try {
    const prDiff = await getPRDiff(octokit, owner, repoName, prNumber, logger)

    const diffContext: DiffContext = {
      changedFiles: prDiff.changedFiles,
      additions: prDiff.additions,
      deletions: prDiff.deletions,
      truncated: prDiff.truncated,
      files: prDiff.files.slice(0, MAX_FILES_IN_CONTEXT).map(f => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      })),
    }

    logger.debug('Collected diff context', {
      files: diffContext.changedFiles,
      additions: diffContext.additions,
      deletions: diffContext.deletions,
      truncated: diffContext.truncated,
    })

    return diffContext
  } catch (error) {
    logger.warning('Failed to fetch PR diff', {
      error: toErrorMessage(error),
    })
    return null
  }
}

export {MAX_FILES_IN_CONTEXT, MAX_FILES_IN_PROMPT}
