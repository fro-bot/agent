import type {LockRecord, ResponseMode} from '@fro-bot/runtime'
import type {TriggerContext} from '../../features/triggers/types.js'
import type {Octokit} from '../../services/github/types.js'
import type {Logger} from '../../shared/logger.js'
import * as core from '@actions/core'
import {addLabelsToIssue, ensureLabelExists, removeLabelFromIssueWithOutcome} from '../../services/github/api.js'
import {toErrorMessage} from '../../shared/errors.js'
import {htmlCode, htmlLink, htmlParagraph, htmlStrong, htmlText} from '../../shared/summary-html.js'
import {parseActionHolderRunId} from './acquire-lock.js'

export const BLOCKED_LABEL = 'agent: blocked' as const
export const BLOCKED_LABEL_COLOR = 'D29922' as const
export const BLOCKED_LABEL_DESCRIPTION =
  'Fro Bot execution was blocked by repository coordination; retry required.' as const

export type CoordinationDeclineReason = 'active-holder' | 'expired-holder' | 'conflict'

export interface CoordinationDeclineOptions {
  readonly githubClient: Octokit
  readonly triggerContext: TriggerContext
  readonly holder: LockRecord | null
  readonly reason: CoordinationDeclineReason
  /** Parsed `response-mode` input; `none` promises no label changes. */
  readonly responseMode: ResponseMode
  readonly logger: Logger
  /** Delays before each retry of a failed re-add (one retry per entry). Overridable for tests. */
  readonly restoreBackoffMs?: readonly number[]
}

/** Two retries after the first failed add, with a short growing pause for transient API errors. */
const DEFAULT_RESTORE_BACKOFF_MS: readonly number[] = [250, 750]

/**
 * `applied`: the label is on the item. `failed`: it could not be applied, but nothing was lost (it was not there
 * before either, or the remove itself failed so any existing label is still in place). `lost`: an existing label was
 * removed for the re-stamp and every attempt to put it back failed, so the persistent blocked signal is gone.
 */
type BlockedLabelResult = 'applied' | 'failed' | 'lost'

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return
  await new Promise<void>(resolve => {
    setTimeout(resolve, ms)
  })
}

/** Issue/PR number the blocked label applies to, or `null` for repository-level, discussion, and manual triggers. */
function resolveLabelTarget(context: TriggerContext): number | null {
  const target = context.target
  if (target == null) return null
  return target.kind === 'issue' || target.kind === 'pr' ? target.number : null
}

function describeReason(reason: CoordinationDeclineReason, holder: LockRecord | null): string {
  switch (reason) {
    case 'active-holder':
      return holder?.surface === 'github'
        ? 'Another Fro Bot Action run is active for this repository.'
        : "Another run holds this repository's Action coordination lock."
    case 'expired-holder':
      return 'An expired coordination lease from a non-Action holder could not be safely reclaimed.'
    case 'conflict':
      return 'The coordination lease changed hands while this run was trying to reclaim it.'
  }
}

function leaseExpiry(holder: LockRecord | null): string | null {
  if (holder == null) return null
  const expiresAt = new Date(holder.acquired_at).getTime() + holder.ttl_seconds * 1000
  return Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : null
}

function describeEntity(context: TriggerContext): string {
  const {owner, repo} = context.repo
  const target = context.target
  if (target != null && Number.isInteger(target.number) && target.number > 0) {
    const base = `https://github.com/${owner}/${repo}`
    switch (target.kind) {
      case 'issue':
        return htmlLink(`issue #${target.number}`, `${base}/issues/${target.number}`)
      case 'pr':
        return htmlLink(`pull request #${target.number}`, `${base}/pull/${target.number}`)
      case 'discussion':
        return htmlLink(`discussion #${target.number}`, `${base}/discussions/${target.number}`)
      case 'manual':
        break
    }
  }
  return htmlText('repository-level invocation')
}

function describeHolder(context: TriggerContext, holder: LockRecord | null): string {
  if (holder == null) return htmlText('unknown')
  const holderRunId = parseActionHolderRunId(holder.holder_id)
  if (holder.surface === 'github' && holderRunId != null) {
    const url = `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${holderRunId}`
    return `${htmlText(holder.surface)} (Action run ${htmlLink(String(holderRunId), url)})`
  }
  return htmlText(holder.surface)
}

async function applyBlockedLabel(
  client: Octokit,
  context: TriggerContext,
  issueNumber: number,
  backoffMs: readonly number[],
  logger: Logger,
): Promise<BlockedLabelResult> {
  try {
    const repoString = `${context.repo.owner}/${context.repo.repo}`
    const exists = await ensureLabelExists(
      client,
      repoString,
      BLOCKED_LABEL,
      BLOCKED_LABEL_COLOR,
      BLOCKED_LABEL_DESCRIPTION,
      logger,
    )
    if (exists === false) return 'failed'
    // Re-stamp: adding a label that is already present creates no new `labeled` event, so a later successful run
    // could not tell this skip from an older one. Remove first (a 404 for an absent label is tolerated; any other
    // remove failure is logged there and we still add so the label is visible).
    const removal = await removeLabelFromIssueWithOutcome(client, repoString, issueNumber, BLOCKED_LABEL, logger)
    if (await addLabelsToIssue(client, repoString, issueNumber, [BLOCKED_LABEL], logger)) return 'applied'
    // Only an actual removal puts the persistent signal at risk; an absent or still-present label loses nothing.
    if (removal !== 'removed') return 'failed'

    for (const delayMs of backoffMs) {
      await sleep(delayMs)
      if (await addLabelsToIssue(client, repoString, issueNumber, [BLOCKED_LABEL], logger)) return 'applied'
    }
    logger.error('Blocked label could not be restored after the re-stamp removed it', {
      issueNumber,
      reason: 'restore-failed-after-remove',
      attempts: backoffMs.length + 1,
    })
    return 'lost'
  } catch (error) {
    logger.warning('Failed to apply blocked label (non-fatal)', {error: toErrorMessage(error)})
    return 'failed'
  }
}

async function writeCoordinationSkipSummary(
  context: TriggerContext,
  holder: LockRecord | null,
  reason: string,
  labelStatus: string,
  labelLostIssueNumber: number | null,
  logger: Logger,
): Promise<void> {
  try {
    const expiry = leaseExpiry(holder)
    core.summary
      .addHeading('Fro Bot Agent Run — Skipped (Coordination)', 2)
      .addRaw(`${htmlParagraph(htmlText(reason))}\n`)
      .addTable([
        [
          {data: 'Detail', header: true},
          {data: 'Value', header: true},
        ],
        ['Target', describeEntity(context)],
        ['Trigger', htmlCode(`${context.eventType}.${context.action ?? 'unknown'}`)],
        ['Reason', htmlText(reason)],
        ['Last observed holder', describeHolder(context, holder)],
        [
          'Lease expiry (observed)',
          expiry == null ? htmlText('unknown') : `${htmlCode(expiry)} — NOT an estimated completion time`,
        ],
        [`Label ${htmlCode(BLOCKED_LABEL)}`, htmlText(labelStatus)],
      ])
    if (labelLostIssueNumber != null) {
      core.summary.addRaw(
        `${htmlParagraph(
          `${htmlStrong('Action needed:')} the ${htmlCode(BLOCKED_LABEL)} label could not be re-applied to #${labelLostIssueNumber}; add it manually.`,
        )}\n`,
      )
    }
    core.summary.addRaw(
      `${htmlParagraph('No agent execution occurred. This request was not automatically requeued.')}\n` +
        `${htmlParagraph(
          `${htmlStrong('Recovery:')} re-run this workflow, or mention the bot again after the other run finishes. ` +
            `Editing the issue alone does not retrigger it. The ${htmlCode(BLOCKED_LABEL)} label is removed automatically when a ` +
            'later run for this item succeeds; remove it manually if needed.',
        )}\n`,
    )

    await core.summary.write()
  } catch (error) {
    logger.warning('Failed to write coordination skip summary', {error: toErrorMessage(error)})
  }
}

/**
 * Makes a coordination-contended skip visible without breaking the Response Protocol (no comment, no reaction):
 * a job-summary section, a warning annotation, and — for routed issue/PR targets — the `agent: blocked` label,
 * re-stamped (removed, then added) so every skip emits a fresh `labeled` event. A later successful run for the same
 * item clears it (`coordination-clear.ts`). Every step is best-effort; this never throws.
 */
export async function runCoordinationDecline(options: CoordinationDeclineOptions): Promise<void> {
  const {githubClient, triggerContext, holder, reason, responseMode, logger} = options
  const reasonText = describeReason(reason, holder)

  const issueNumber = resolveLabelTarget(triggerContext)
  let labelStatus = 'not applicable (no issue or pull request target)'
  let labelLostIssueNumber: number | null = null
  if (issueNumber != null && responseMode === 'none') {
    labelStatus = 'not applied (response-mode is none)'
  } else if (issueNumber != null) {
    const result = await applyBlockedLabel(
      githubClient,
      triggerContext,
      issueNumber,
      options.restoreBackoffMs ?? DEFAULT_RESTORE_BACKOFF_MS,
      logger,
    )
    labelStatus = result === 'applied' ? 'applied' : 'not applied (labeling failed)'
    if (result === 'lost') labelLostIssueNumber = issueNumber
  }

  await writeCoordinationSkipSummary(triggerContext, holder, reasonText, labelStatus, labelLostIssueNumber, logger)
  core.warning(`Fro Bot skipped this run: ${reasonText} No agent execution occurred; re-run the workflow to retry.`)
}
