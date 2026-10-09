import type {LockRecord, ResponseMode} from '@fro-bot/runtime'
import type {TriggerContext} from '../../features/triggers/types.js'
import type {Octokit} from '../../services/github/types.js'
import type {Logger} from '../../shared/logger.js'
import * as core from '@actions/core'
import {addLabelsToIssue, ensureLabelExists, removeLabelFromIssue} from '../../services/github/api.js'
import {toErrorMessage} from '../../shared/errors.js'
import {escapeSummaryText as cell} from '../../shared/summary-escape.js'
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
        return `<a href="${base}/issues/${target.number}">issue #${target.number}</a>`
      case 'pr':
        return `<a href="${base}/pull/${target.number}">pull request #${target.number}</a>`
      case 'discussion':
        return `<a href="${base}/discussions/${target.number}">discussion #${target.number}</a>`
      case 'manual':
        break
    }
  }
  return 'repository-level invocation'
}

function describeHolder(context: TriggerContext, holder: LockRecord | null): string {
  if (holder == null) return 'unknown'
  const holderRunId = parseActionHolderRunId(holder.holder_id)
  if (holder.surface === 'github' && holderRunId != null) {
    const url = `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${holderRunId}`
    return `${cell(holder.surface)} (Action run <a href="${url}">${holderRunId}</a>)`
  }
  return cell(holder.surface)
}

async function applyBlockedLabel(
  client: Octokit,
  context: TriggerContext,
  issueNumber: number,
  logger: Logger,
): Promise<boolean> {
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
    if (exists === false) return false
    // Re-stamp: adding a label that is already present creates no new `labeled` event, so a later successful run
    // could not tell this skip from an older one. Remove first (a 404 for an absent label is tolerated by
    // `removeLabelFromIssue`; any other remove failure is logged there and we still add so the label is visible).
    await removeLabelFromIssue(client, repoString, issueNumber, BLOCKED_LABEL, logger)
    return await addLabelsToIssue(client, repoString, issueNumber, [BLOCKED_LABEL], logger)
  } catch (error) {
    logger.warning('Failed to apply blocked label (non-fatal)', {error: toErrorMessage(error)})
    return false
  }
}

async function writeCoordinationSkipSummary(
  context: TriggerContext,
  holder: LockRecord | null,
  reason: string,
  labelStatus: string,
  logger: Logger,
): Promise<void> {
  try {
    const expiry = leaseExpiry(holder)
    core.summary
      .addHeading('Fro Bot Agent Run — Skipped (Coordination)', 2)
      .addRaw(`${cell(reason)}\n\n`)
      .addTable([
        [
          {data: 'Detail', header: true},
          {data: 'Value', header: true},
        ],
        ['Target', describeEntity(context)],
        ['Trigger', `<code>${cell(context.eventType)}.${cell(context.action ?? 'unknown')}</code>`],
        ['Reason', cell(reason)],
        ['Last observed holder', describeHolder(context, holder)],
        [
          'Lease expiry (observed)',
          expiry == null ? 'unknown' : `<code>${expiry}</code> — NOT an estimated completion time`,
        ],
        [`Label <code>${BLOCKED_LABEL}</code>`, labelStatus],
      ])
      .addRaw(
        '\nNo agent execution occurred. This request was not automatically requeued.\n\n' +
          '**Recovery:** re-run this workflow, or mention the bot again after the other run finishes. ' +
          'Editing the issue alone does not retrigger it. The `agent: blocked` label is removed automatically when a ' +
          'later run for this item succeeds; remove it manually if needed.\n',
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
  if (issueNumber != null && responseMode === 'none') {
    labelStatus = 'not applied (response-mode is none)'
  } else if (issueNumber != null) {
    const applied = await applyBlockedLabel(githubClient, triggerContext, issueNumber, logger)
    labelStatus = applied ? 'applied' : 'not applied (labeling failed)'
  }

  await writeCoordinationSkipSummary(triggerContext, holder, reasonText, labelStatus, logger)
  core.warning(`Fro Bot skipped this run: ${reasonText} No agent execution occurred; re-run the workflow to retry.`)
}
