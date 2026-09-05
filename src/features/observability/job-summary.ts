import type {CacheSaveOutcome, CacheSaveResult, CacheSaveStateValue} from '../../shared/cache-save-result.js'
import type {Logger} from '../../shared/logger.js'
import type {CommentSummaryOptions} from './types.js'
import * as core from '@actions/core'
import {toCacheSaveStateValue} from '../../shared/cache-save-result.js'
import {toErrorMessage} from '../../shared/errors.js'
import {formatCacheStatus, formatDuration} from './run-summary.js'

/**
 * Table-cell text per `CacheSaveStateValue`, mirroring `formatCacheStatus` in
 * `run-summary.ts` (visual indicator + short label, one line, no proof-of-durability
 * language -- a result is reported, never a guarantee; see the cache-save-result-contract
 * plan's R4).
 */
const CACHE_SAVE_RESULT_LABELS: Record<CacheSaveStateValue, string> = {
  durable: '✅ persisted',
  'store-only': '📦 persisted (object store only)',
  skipped: '⏭️ skipped',
  'not-persisted': '❌ not persisted',
}

function formatCacheSaveResult(value: CacheSaveStateValue): string {
  return CACHE_SAVE_RESULT_LABELS[value]
}

/**
 * One-sentence remediation text per `CacheSaveOutcome`, pinned by
 * `satisfies Record<CacheSaveOutcome, ...>` so a new outcome without a case here fails
 * `check-types` instead of silently reporting nothing. `undefined` for `persisted` and
 * `skipped-by-configuration` -- neither needs remediation, and a deliberate skip in
 * particular must never suggest `s3-backup` (it did not fail; it did not run).
 *
 * `cache-rejected`/`cache-error`'s wording names the cause as an inference, not an
 * observation: the cache write's `-1` sentinel (or a thrown error) does not distinguish a
 * policy denial from a reservation collision (see `CacheSaveOutcome` in
 * `cache-save-result.ts`), so both possibilities are named rather than picking one.
 * `checkpoint-declined` and `skipped-empty` each get their own sentence rather than
 * reusing the rejected-write one: neither is a rejected write, and `s3-backup` would not
 * help either -- a declined checkpoint means no write was attempted at all, and an empty
 * observation means there was nothing to write in the first place.
 */
const OUTCOME_TO_REMEDIATION = {
  'skipped-by-configuration': undefined,
  'skipped-empty':
    'No session state was found to save; the post-action step retries in case the database was still being written.',
  'checkpoint-declined':
    'Session state did not persist this run \u2014 the database could not be checkpointed, so no write was attempted; the post-action step retries.',
  'cache-rejected':
    'Session state did not persist this run \u2014 the cache service did not accept the write, which on a comment-triggered run usually means a read-only cache token, but can also be a key collision or a transient cache-service failure; enable `s3-backup` to persist state independent of the Actions cache.',
  'cache-error':
    'Session state did not persist this run \u2014 the cache service did not accept the write, which on a comment-triggered run usually means a read-only cache token, but can also be a key collision or a transient cache-service failure; enable `s3-backup` to persist state independent of the Actions cache.',
  persisted: undefined,
} as const satisfies Record<CacheSaveOutcome, string | undefined>

function cacheSaveResultRemediation(result: CacheSaveResult): string | undefined {
  // store-only is a state-value distinction, not a separate CacheSaveOutcome (it only
  // arises from cache-rejected/cache-error plus storePersisted -- see
  // OUTCOME_TO_STATE_VALUE in cache-save-result.ts) -- so it is handled ahead of the
  // outcome table, which would otherwise report the rejected-write sentence (and its
  // s3-backup suggestion) even though the object store already durably persisted the
  // state through that same backend.
  if (toCacheSaveStateValue(result) === 'store-only') {
    return 'Session state persisted to the object store; the Actions cache write did not persist it.'
  }
  return OUTCOME_TO_REMEDIATION[result.outcome]
}

/**
 * Writes a standalone job-summary row reporting whether session state persisted this run.
 * Deliberately separate from `writeJobSummary`: the outcome is only known once `saveCache`
 * runs in `cleanup.ts`, which executes after `runFinalizeWithResult` (the caller of
 * `writeJobSummary`) has already written and flushed the main summary table -- see the
 * cache-save-result-contract plan's Unit 3. `post.ts` calls this same function after a
 * retried save so a red state from a retry is visible without reading logs, even though
 * the post hook cannot populate the `cache-save-result` output itself (see the comment at
 * that call site).
 *
 * Non-blocking: logs a warning on failure but never throws, the same as `writeJobSummary`.
 */
export async function writeCacheSaveResultSummary(
  result: CacheSaveResult,
  phase: 'main' | 'post-retry',
  logger: Logger,
): Promise<void> {
  try {
    const value = toCacheSaveStateValue(result)
    const heading = phase === 'main' ? 'Session Persistence' : 'Session Persistence (post-action retry)'
    core.summary.addHeading(heading, 3).addTable([
      [
        {data: 'Field', header: true},
        {data: 'Value', header: true},
      ],
      ['Cache Save Result', formatCacheSaveResult(value)],
    ])

    const remediation = cacheSaveResultRemediation(result)
    if (remediation != null) {
      core.summary.addRaw(`${remediation}\n`)
    }

    await core.summary.write()
    logger.debug('Wrote cache save result summary', {value})
  } catch (error) {
    const errorMsg = toErrorMessage(error)
    logger.warning('Failed to write cache save result summary', {error: errorMsg})
    core.warning(`Failed to write cache save result summary: ${errorMsg}`)
  }
}

/**
 * Write comprehensive job summary to GitHub Actions UI.
 *
 * Uses @actions/core summary API to display run metadata, token usage,
 * created artifacts, and errors in the Actions workflow UI.
 * Non-blocking: logs warning on failure but doesn't throw.
 */
export async function writeJobSummary(options: CommentSummaryOptions, logger: Logger): Promise<void> {
  const {eventType, repo, ref, runId, runUrl, metrics, agent, resolvedOutputMode, deliveryKind} = options

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
      ['Output Mode', resolvedOutputMode ?? 'N/A'],
      ['Delivery Kind', deliveryKind],
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
        const classification = error.classificationPath == null ? '' : `, classification: ${error.classificationPath}`
        core.summary.addRaw(`- **${error.type}** (${status}${classification}): ${error.message}\n`)
      }
    }

    await core.summary.write()
    logger.debug('Wrote job summary')
  } catch (error) {
    const errorMsg = toErrorMessage(error)
    logger.warning('Failed to write job summary', {error: errorMsg})
    core.warning(`Failed to write job summary: ${errorMsg}`)
  }
}
