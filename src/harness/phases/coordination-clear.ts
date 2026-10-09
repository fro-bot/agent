import type {ResponseMode} from '@fro-bot/runtime'
import type {TriggerContext} from '../../features/triggers/types.js'
import type {Octokit} from '../../services/github/types.js'
import type {Logger} from '../../shared/logger.js'
import type {InvocationOutcome} from '../outcome.js'
import {WORKING_LABEL} from '@fro-bot/runtime'
import {getLatestLabeledEventTimes, listLabelsOnIssue, removeLabelFromIssue} from '../../services/github/api.js'
import {toErrorMessage} from '../../shared/errors.js'
import {BLOCKED_LABEL} from './coordination-decline.js'

/** Upper bound on the whole clear step; it must never hold up the end of an otherwise-finished run. */
export const BLOCKED_LABEL_CLEAR_DEADLINE_MS = 15_000

export interface BlockedLabelClearOptions {
  readonly githubClient: Octokit
  readonly triggerContext: TriggerContext
  /** Final invocation outcome; only `succeeded` clears. Skipped (lock declined) and failed/incomplete never do. */
  readonly outcome: InvocationOutcome
  readonly responseMode: ResponseMode
  readonly logger: Logger
  readonly deadlineMs?: number
}

function resolveTargetNumber(context: TriggerContext): number | null {
  const target = context.target
  if (target == null) return null
  return target.kind === 'issue' || target.kind === 'pr' ? target.number : null
}

async function clearIfStale(options: BlockedLabelClearOptions, issueNumber: number): Promise<void> {
  const {githubClient, triggerContext, logger} = options
  const repoString = `${triggerContext.repo.owner}/${triggerContext.repo.repo}`

  // One cheap call first: the common case is that the label is not there and nothing else is touched.
  const labels = await listLabelsOnIssue(githubClient, repoString, issueNumber, logger)
  if (labels == null) {
    logger.info('Not clearing blocked label: labels could not be read', {issueNumber})
    return
  }
  const blockedLower = BLOCKED_LABEL.toLowerCase()
  if (labels.some(name => name.toLowerCase() === blockedLower) === false) return

  // One pass over the issue events yields both stamps, both on GitHub's clock. The anchor is this run's own
  // `agent: working` labeled event (applied by acknowledge at run start; cleanup removes the label before this
  // runs, but a removal never deletes the past `labeled` event). Never payload timestamps (a re-run reuses the
  // original payload) and never the runner clock.
  const times = await getLatestLabeledEventTimes(
    githubClient,
    repoString,
    issueNumber,
    [BLOCKED_LABEL, WORKING_LABEL],
    logger,
  )
  if (times == null) {
    logger.info('Not clearing blocked label: issue events could not be read', {issueNumber})
    return
  }
  const blockedAt = times.get(BLOCKED_LABEL)
  const workingAt = times.get(WORKING_LABEL)
  if (blockedAt == null || workingAt == null) {
    logger.info('Keeping blocked label: a labeled event needed for the comparison was not found', {
      issueNumber,
      hasBlockedEvent: blockedAt != null,
      hasWorkingEvent: workingAt != null,
    })
    return
  }

  // Strictly earlier: both stamps have whole-second resolution, so a same-second tie cannot be ordered and keeps.
  //
  // Fail-safe when `agent: working` was already present at acknowledge time (a crashed earlier run never removed it):
  // re-adding an existing label emits no event, so the latest working event is that earlier run's -- older than this
  // run's start. An older anchor can only make the comparison stricter (blocked < anchor implies blocked < this run's
  // start), so a stale anchor keeps labels it could have cleared; it never clears one it should keep.
  if (blockedAt >= workingAt) {
    logger.info('Keeping blocked label: it was applied at or after the run-start anchor', {
      issueNumber,
      blockedLabeledAt: new Date(blockedAt).toISOString(),
      workingLabeledAt: new Date(workingAt).toISOString(),
    })
    return
  }

  // Residual race: GitHub has no conditional label removal, so a coordination decline landing between the event
  // read above and this remove is cleared along with the stale label. The anchor is stamped at acknowledge (after
  // bootstrap and lock acquisition), so a decline landing between run start and acknowledge is also cleared. Same-
  // target overlap is prevented by the workflow's per-target concurrency group (fro-bot-<issue/pr number>).
  const removed = await removeLabelFromIssue(githubClient, repoString, issueNumber, BLOCKED_LABEL, logger)
  if (removed) logger.info('Cleared stale blocked label after a successful run', {issueNumber})
}

/**
 * Removes the `agent: blocked` label a PRIOR run's coordination decline left on this run's issue/PR, once this run
 * has succeeded and the label's latest `labeled` event is strictly older than this run's own `agent: working`
 * labeled event (the run-start anchor). Strictly best-effort and bounded by a deadline: every API failure (unreadable labels or events, a missing
 * working-label event) means no removal, and this never throws or fails the run.
 * No-op under `response-mode: none`, for non-issue/PR targets, and for any outcome other than `succeeded`.
 */
export async function runBlockedLabelClear(options: BlockedLabelClearOptions): Promise<void> {
  const {triggerContext, outcome, responseMode, logger} = options
  if (outcome !== 'succeeded' || responseMode === 'none') return
  const issueNumber = resolveTargetNumber(triggerContext)
  if (issueNumber == null) return

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const deadline = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => {
        resolve('timeout')
      }, options.deadlineMs ?? BLOCKED_LABEL_CLEAR_DEADLINE_MS)
    })
    const result = await Promise.race([clearIfStale(options, issueNumber).then(() => 'done' as const), deadline])
    if (result === 'timeout') logger.warning('Blocked label clear timed out; leaving the label in place', {issueNumber})
  } catch (error) {
    logger.warning('Failed to clear blocked label (non-fatal)', {error: toErrorMessage(error)})
  } finally {
    if (timer != null) clearTimeout(timer)
  }
}
