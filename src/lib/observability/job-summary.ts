import type {Logger} from '../logger.js'
import type {CommentSummaryOptions} from './types.js'
import * as core from '@actions/core'
import {formatCacheStatus, formatDuration} from './run-summary.js'

/**
 * Write comprehensive job summary to GitHub Actions UI.
 *
 * Uses @actions/core summary API to display run metadata, token usage,
 * created artifacts, and errors in the Actions workflow UI.
 * Non-blocking: logs warning on failure but doesn't throw.
 */
export async function writeJobSummary(options: CommentSummaryOptions, logger: Logger): Promise<void> {
  const {eventType, repo, ref, runId, runUrl, metrics, agent} = options

  try {
    core.summary.addHeading('Fro Bot Agent Run', 2).addTable([
      [
        {data: 'Field', header: true},
        {data: 'Value', header: true},
      ],
      ['Event', eventType],
      ['Repository', repo],
      ['Ref', ref],
      ['Run ID', `[${runId}](${runUrl})`],
      ['Agent', agent],
      ['Cache Status', formatCacheStatus(metrics.cacheStatus)],
      ['Duration', metrics.duration == null ? 'N/A' : formatDuration(metrics.duration)],
    ])

    if (metrics.sessionsUsed.length > 0 || metrics.sessionsCreated.length > 0) {
      core.summary.addHeading('Sessions', 3)

      if (metrics.sessionsUsed.length > 0) {
        core.summary.addRaw(`**Used:** ${metrics.sessionsUsed.join(', ')}\n`)
      }

      if (metrics.sessionsCreated.length > 0) {
        core.summary.addRaw(`**Created:** ${metrics.sessionsCreated.join(', ')}\n`)
      }
    }

    if (metrics.tokenUsage != null) {
      core.summary.addHeading('Token Usage', 3)
      core.summary.addTable([
        [
          {data: 'Metric', header: true},
          {data: 'Count', header: true},
        ],
        ['Input', metrics.tokenUsage.input.toLocaleString()],
        ['Output', metrics.tokenUsage.output.toLocaleString()],
        ['Reasoning', metrics.tokenUsage.reasoning.toLocaleString()],
        ['Cache Read', metrics.tokenUsage.cache.read.toLocaleString()],
        ['Cache Write', metrics.tokenUsage.cache.write.toLocaleString()],
      ])

      if (metrics.model != null) {
        core.summary.addRaw(`**Model:** ${metrics.model}\n`)
      }

      if (metrics.cost != null) {
        core.summary.addRaw(`**Cost:** $${metrics.cost.toFixed(4)}\n`)
      }
    }

    if (metrics.prsCreated.length > 0 || metrics.commitsCreated.length > 0 || metrics.commentsPosted > 0) {
      core.summary.addHeading('Created Artifacts', 3)

      if (metrics.prsCreated.length > 0) {
        core.summary.addList([...metrics.prsCreated])
      }

      if (metrics.commitsCreated.length > 0) {
        core.summary.addList(metrics.commitsCreated.map(sha => `Commit \`${sha.slice(0, 7)}\``))
      }

      if (metrics.commentsPosted > 0) {
        core.summary.addRaw(`**Comments Posted:** ${metrics.commentsPosted}\n`)
      }
    }

    if (metrics.errors.length > 0) {
      core.summary.addHeading('Errors', 3)

      for (const error of metrics.errors) {
        const status = error.recoverable ? '🔄 Recovered' : '❌ Failed'
        core.summary.addRaw(`- **${error.type}** (${status}): ${error.message}\n`)
      }
    }

    await core.summary.write()
    logger.debug('Wrote job summary')
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    logger.warning('Failed to write job summary', {error: errorMsg})
    core.warning(`Failed to write job summary: ${errorMsg}`)
  }
}
