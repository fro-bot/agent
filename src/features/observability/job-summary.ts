import type {OwnershipEntryState, OwnershipLedger, OwnershipLedgerEntry} from '@fro-bot/runtime'
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
  'declined-for-safety': '🔒 declined (safety)',
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
 *
 * `ownership-declined` also gets its own sentence: unlike `checkpoint-declined` (the
 * database itself could not be checkpointed), this decline happens before the checkpoint
 * is ever attempted, because persistence safety could not be confirmed. Its specific
 * cause (unresolved ownership, unconfirmed quiescence, or a failed lease renewal) is
 * supplied by the caller as `declineReason` and appended to this base sentence, the same
 * way `checkpoint-declined`'s own `reason` is appended by `writeCheckpointDeclineSummary`
 * in `save.ts` -- the two declines happen in different call sites, so each names its own
 * reason through its own channel rather than inventing a shared one.
 *
 * `ownership-declined` is a plain string, not a `{sentence, retryDetail}` pair, because
 * unlike every other not-persisted outcome it never gets a retry clause at all, in either
 * phase: `post.ts` deliberately does NOT retry a `declined-for-safety` save (see the
 * `cacheSaved === 'declined-for-safety'` branch in `post.ts`, which honors the decline
 * instead) -- and its own `phase: 'post-skip-safety'` row must say the same thing
 * `cleanup.ts`'s `phase: 'main'` row says, or the two rows tell contradictory stories
 * about the same decision. So this sentence states plainly that the post-action step will
 * not retry it, for both phases alike.
 *
 * `skipped-empty` and `checkpoint-declined` are the only two entries with a trailing
 * "the post-action step retries" clause, and that clause is true only when this sentence
 * is rendered from `cleanup.ts`'s `phase: 'main'` write -- a post-action retry genuinely
 * follows. `post.ts` renders the same outcome from its own retry (`phase: 'post-retry'`),
 * which IS that retry; claiming it "retries" again would be false. So each entry carries
 * its base `sentence` plus an optional `retryDetail` suffix (appended after "the
 * post-action step retries"), and `cacheSaveResultRemediation` below only appends the
 * whole retry clause for `phase === 'main'`.
 */
const OUTCOME_TO_REMEDIATION = {
  'skipped-by-configuration': undefined,
  'skipped-empty': {
    sentence: 'No session state was found to save',
    retryDetail: 'in case the database was still being written',
  },
  'checkpoint-declined': {
    sentence:
      'Session state did not persist this run \u2014 the database could not be checkpointed, so no write was attempted',
    retryDetail: undefined,
  },
  'ownership-declined':
    'Session state did not persist this run \u2014 persistence safety could not be confirmed; the post-action step will not retry it.',
  'cache-rejected':
    'Session state did not persist this run \u2014 the cache service did not accept the write, which on a comment-triggered run usually means a read-only cache token, but can also be a key collision or a transient cache-service failure; enable `s3-backup` to persist state independent of the Actions cache.',
  'cache-error':
    'Session state did not persist this run \u2014 the cache service did not accept the write, which on a comment-triggered run usually means a read-only cache token, but can also be a key collision or a transient cache-service failure; enable `s3-backup` to persist state independent of the Actions cache.',
  persisted: undefined,
} as const satisfies Record<CacheSaveOutcome, string | undefined | {sentence: string; retryDetail: string | undefined}>

function cacheSaveResultRemediation(
  result: CacheSaveResult,
  phase: 'main' | 'post-retry' | 'post-skip-safety',
): string | undefined {
  // store-only is a state-value distinction, not a separate CacheSaveOutcome (it only
  // arises from cache-rejected/cache-error plus storePersisted -- see
  // OUTCOME_TO_STATE_VALUE in cache-save-result.ts) -- so it is handled ahead of the
  // outcome table, which would otherwise report the rejected-write sentence (and its
  // s3-backup suggestion) even though the object store already durably persisted the
  // state through that same backend.
  if (toCacheSaveStateValue(result) === 'store-only') {
    return 'Session state persisted to the object store; the Actions cache write did not persist it.'
  }

  const entry = OUTCOME_TO_REMEDIATION[result.outcome]
  if (entry == null) {
    return undefined
  }
  if (typeof entry === 'string') {
    return entry
  }

  // Only the main-phase write is followed by an actual post-action retry -- this call
  // (phase === 'post-retry') IS that retry, so the trailing clause naming it is dropped.
  if (phase !== 'main') {
    return `${entry.sentence}.`
  }
  const retryClause =
    entry.retryDetail == null ? 'the post-action step retries' : `the post-action step retries ${entry.retryDetail}`
  return `${entry.sentence}; ${retryClause}.`
}

/**
 * Writes a standalone job-summary row reporting whether session state persisted this run.
 * Deliberately separate from `writeJobSummary`: the outcome is only known once `saveCache`
 * runs in `cleanup.ts`, which executes after `runFinalizeWithResult` (the caller of
 * `writeJobSummary`) has already written and flushed the main summary table -- see the
 * cache-save-result-contract plan's Unit 3. `post.ts` calls this same function after a
 * retried save so a red state from a retry is visible without reading logs, even though
 * the post hook cannot populate the `cache-save-result` output itself (see the comment at
 * that call site). `post.ts` also calls this for `phase: 'post-skip-safety'`, when it
 * honors a `declined-for-safety` state instead of retrying -- a silent skip would be just
 * as misleading as the silent retry-that-overrides-the-decline this row exists to prevent,
 * so that skip gets its own labeled row rather than only a log line.
 *
 * Non-blocking: logs a warning on failure but never throws, the same as `writeJobSummary`.
 */
export async function writeCacheSaveResultSummary(
  result: CacheSaveResult,
  phase: 'main' | 'post-retry' | 'post-skip-safety',
  logger: Logger,
  declineReason?: string,
): Promise<void> {
  try {
    const value = toCacheSaveStateValue(result)
    const heading =
      phase === 'main'
        ? 'Session Persistence'
        : phase === 'post-retry'
          ? 'Session Persistence (post-action retry)'
          : 'Session Persistence (post-action: safety decline honored, not retried)'
    core.summary.addHeading(heading, 3).addTable([
      [
        {data: 'Field', header: true},
        {data: 'Value', header: true},
      ],
      ['Cache Save Result', formatCacheSaveResult(value)],
    ])

    const remediation = cacheSaveResultRemediation(result, phase)
    if (remediation != null) {
      core.summary.addRaw(`${remediation}\n`)
    }

    // Declared here (not folded into a fifth OUTCOME_TO_REMEDIATION variant per specific
    // cause) because the reason is only known at the ownership-declined call site --
    // runCleanup already distinguishes which of the three conditions applied and would
    // otherwise have to smuggle that distinction through a fabricated CacheSaveResult
    // shape. A reader must be able to tell WHY without reading logs, so this is not a
    // second channel -- it augments the same 'Session Persistence' row this function
    // always writes.
    if (declineReason != null && result.outcome === 'ownership-declined') {
      core.summary.addRaw(`**Reason:** ${declineReason}\n`)
    }

    await core.summary.write()
    logger.debug('Wrote cache save result summary', {value, declineReason})
  } catch (error) {
    const errorMsg = toErrorMessage(error)
    logger.warning('Failed to write cache save result summary', {error: errorMsg})
    core.warning(`Failed to write cache save result summary: ${errorMsg}`)
  }
}

/**
 * Human-readable state label for an entry named in the "did not finish" list. `settled`
 * is present only to keep this exhaustive over `OwnershipEntryState` without a cast --
 * it is never actually looked up, since `writeBackgroundWorkSummary` only indexes this
 * for entries already filtered to `state !== 'settled'`.
 */
const UNFINISHED_ENTRY_STATE_LABELS: Readonly<Record<OwnershipEntryState, string>> = {
  outstanding: 'still running',
  unknown: 'unconfirmed',
  settled: 'finished',
}

/**
 * Table-cell text per invocation outcome (`src/harness/outcome.ts`'s `InvocationOutcome`),
 * mirroring `CACHE_SAVE_RESULT_LABELS` above.
 */
const INVOCATION_OUTCOME_LABELS: Readonly<Record<'succeeded' | 'incomplete' | 'failed', string>> = {
  succeeded: '✅ succeeded',
  incomplete: '⚠️ incomplete',
  failed: '❌ failed',
}

/**
 * Writes a standalone job-summary row reporting this invocation's final, verified outcome
 * -- `succeeded`, `incomplete` (a useful result may exist, but this invocation could not
 * certify completion), or `failed`. Deliberately separate from `writeJobSummary`, the same
 * way `writeCacheSaveResultSummary` is: the FINAL outcome is only known once `runCleanup`
 * returns its teardown safety evidence, which happens after `runFinalizeWithResult` (the
 * caller of `writeJobSummary`) has already written and flushed the main summary table.
 * Non-blocking: logs a warning on failure but never throws.
 */
export async function writeInvocationOutcomeSummary(
  outcome: 'succeeded' | 'incomplete' | 'failed',
  incompleteReasons: readonly string[],
  logger: Logger,
): Promise<void> {
  try {
    core.summary.addHeading('Invocation Outcome', 3).addTable([
      [
        {data: 'Field', header: true},
        {data: 'Value', header: true},
      ],
      ['Outcome', INVOCATION_OUTCOME_LABELS[outcome]],
    ])

    if (outcome === 'incomplete' && incompleteReasons.length > 0) {
      core.summary.addRaw(
        '\nA useful result may exist, but this invocation could not certify completion. Unresolved:\n',
      )
      core.summary.addList([...incompleteReasons])
    }

    await core.summary.write()
    logger.debug('Wrote invocation outcome summary', {outcome, incompleteReasons})
  } catch (error) {
    const errorMsg = toErrorMessage(error)
    logger.warning('Failed to write invocation outcome summary', {error: errorMsg})
    core.warning(`Failed to write invocation outcome summary: ${errorMsg}`)
  }
}

/**
 * Writes the "Background Work" job-summary section reporting what this invocation's
 * ownership ledger owned and what became of it, naming unfinished executions by label
 * rather than by count so a reviewer can tell which coverage was lost (plan Unit 13,
 * R23).
 *
 * Deliberately silent (adds nothing) when `ledger` is absent or its snapshot is empty --
 * a run with no background dispatch, which is every run in production today, must
 * produce byte-identical output to before this section existed.
 *
 * `settled` entries are not listed individually: they cover both a normal completion
 * and a cancellation the drain's reconciliation pass positively confirmed had stopped --
 * the ledger does not distinguish the two (see `runDrain`'s `cancelOutstanding` in
 * `execute.ts`), so nothing here can honestly claim one or the other. `unknown` and any
 * residual `outstanding` entries are what the drain could not confirm finished; both are
 * named in the same list (with their state labelled) rather than only reporting a count,
 * per this unit's goal. Every entry's label is whatever the dispatch site supplied when
 * it called `ledger.adopt` -- reconciliation itself never adopts an entry (it only settles
 * or downgrades what dispatch already adopted; see `ledger-reconcile.ts`'s module doc), so
 * there is no separate reconciliation-only label to preserve here.
 *
 * `unknown` entries additionally get an explicit degraded-state banner: an entry the
 * drain could not confirm is neither finished nor cancelled, and folding it silently
 * into the unfinished list would let that ambiguity go unnoticed by a reader who only
 * skims for a nonempty list.
 */
function writeBackgroundWorkSummary(ledger: OwnershipLedger | undefined): void {
  if (ledger === undefined) return

  const snapshot = ledger.snapshot()
  if (snapshot.length === 0) return

  const unfinished = snapshot.filter((entry): entry is OwnershipLedgerEntry => entry.state !== 'settled')
  const unknownCount = snapshot.filter(entry => entry.state === 'unknown').length

  core.summary.addHeading('Background Work', 3)

  if (unfinished.length === 0) {
    core.summary.addRaw('All background work finished.\n')
  } else {
    core.summary.addRaw('**Did not finish:**\n')
    core.summary.addList(
      unfinished.map(entry => {
        return `${entry.label} (${UNFINISHED_ENTRY_STATE_LABELS[entry.state]})`
      }),
    )
  }

  if (unknownCount > 0) {
    core.summary.addRaw(
      `\u26A0\uFE0F **Degraded:** ${unknownCount} ${unknownCount === 1 ? 'entry' : 'entries'} could not be confirmed finished or cancelled; treat any associated changes as unverified.\n`,
    )
  }
}

/**
 * Write comprehensive job summary to GitHub Actions UI.
 *
 * Uses @actions/core summary API to display run metadata, token usage,
 * created artifacts, and errors in the Actions workflow UI.
 * Non-blocking: logs warning on failure but doesn't throw.
 */
export async function writeJobSummary(
  options: CommentSummaryOptions,
  logger: Logger,
  ownershipLedger?: OwnershipLedger,
): Promise<void> {
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

    writeBackgroundWorkSummary(ownershipLedger)

    await core.summary.write()
    logger.debug('Wrote job summary')
  } catch (error) {
    const errorMsg = toErrorMessage(error)
    logger.warning('Failed to write job summary', {error: errorMsg})
    core.warning(`Failed to write job summary: ${errorMsg}`)
  }
}
