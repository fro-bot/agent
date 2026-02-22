import type {RunSummary} from '../types.js'
import type {SessionClient} from './backend.js'
import type {Logger} from './types.js'

import {toErrorMessage} from '../../utils/errors.js'

/**
 * Format run summary for session storage.
 */
function formatSummaryForSession(summary: RunSummary): string {
  const lines = [
    '--- Fro Bot Run Summary ---',
    `Event: ${summary.eventType}`,
    `Repo: ${summary.repo}`,
    `Ref: ${summary.ref}`,
    `Run ID: ${summary.runId}`,
    `Cache: ${summary.cacheStatus}`,
    `Duration: ${summary.duration}s`,
  ]

  if (summary.sessionIds.length > 0) {
    lines.push(`Sessions used: ${summary.sessionIds.join(', ')}`)
  }

  if (summary.createdPRs.length > 0) {
    lines.push(`PRs created: ${summary.createdPRs.join(', ')}`)
  }

  if (summary.createdCommits.length > 0) {
    lines.push(`Commits: ${summary.createdCommits.join(', ')}`)
  }

  if (summary.tokenUsage != null) {
    lines.push(`Tokens: ${summary.tokenUsage.input} in / ${summary.tokenUsage.output} out`)
  }

  return lines.join('\n')
}

/**
 * Append a run summary to a session's message history.
 *
 * Creates a synthetic "user" message to make GitHub Action metadata searchable.
 * This enables close-the-loop functionality: agents can discover which GitHub
 * runs created which PRs/commits, avoiding duplicate work and enabling
 * follow-up coordination.
 *
 * The synthetic message uses role="user" so it appears in conversation context
 * but uses special agent="fro-bot" and modelID="run-summary" to identify it
 * as GitHub Action metadata rather than human input.
 */
export async function writeSessionSummary(
  sessionId: string,
  summary: RunSummary,
  client: SessionClient,
  logger: Logger,
): Promise<void> {
  const summaryText = formatSummaryForSession(summary)

  try {
    const result = await client.session.prompt({
      path: {id: sessionId},
      body: {
        noReply: true,
        parts: [{type: 'text' as const, text: summaryText}],
      },
    })

    if (result.error != null) {
      logger.warning('SDK prompt writeback failed', {sessionId, error: String(result.error)})
      return
    }

    logger.info('Session summary written via SDK', {sessionId})
  } catch (error) {
    logger.warning('SDK prompt writeback failed', {sessionId, error: toErrorMessage(error)})
  }
}
