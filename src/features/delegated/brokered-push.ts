import type {NormalizedEvent, Octokit} from '../../services/github/types.js'
import type {ExecAdapter} from '../../services/setup/types.js'
import type {Logger} from '../../shared/logger.js'
import type {CommitResult, FileChange} from './types.js'

import {toErrorMessage} from '../../shared/errors.js'
import {
  checkBrokeredPushPermission,
  checkBrokeredPushPreWriteGate,
  evaluateBrokeredPushEarlyGate,
} from './brokered-push-gate.js'
import {validateBrokeredPushFiles} from './brokered-push-validation.js'
import {createCommit} from './commit.js'
import {reconstructChanges} from './reconstruct-changes.js'

const BROKERED_PUSH_COMMIT_MESSAGE = 'chore: apply brokered changes'

export interface BrokeredPushParams {
  readonly octokit: Octokit
  readonly execAdapter: ExecAdapter
  readonly logger: Logger
  readonly event: NormalizedEvent
  readonly owner: string
  readonly repo: string
  readonly trustedHeadSha: string
  readonly expectedHeadBranch: string
  readonly repoRoot: string
}

export type BrokeredPushOutcome =
  | {readonly kind: 'skipped'}
  | {readonly kind: 'bypass'}
  | {readonly kind: 'nothing-to-deliver'}
  | {readonly kind: 'pushed'; readonly commit: CommitResult; readonly branch: string}
  | {readonly kind: 'fail-loud'; readonly reason: string}

/**
 * Run the brokered-push delivery state machine after a successful eligible execution.
 *
 * Every write is gated by trusted event facts, live permission, reconstruction,
 * brokered-path validation, and a final live PR identity check. A commit is only
 * reported as delivered when createCommit completes, which includes updateRef.
 */
export async function runBrokeredPush(params: BrokeredPushParams): Promise<BrokeredPushOutcome> {
  const {octokit, execAdapter, logger, event, owner, repo, trustedHeadSha, expectedHeadBranch, repoRoot} = params

  try {
    const earlyGate = evaluateBrokeredPushEarlyGate({event, owner, repo, trustedHeadSha})
    if (earlyGate.decision === 'ineligible') {
      logger.debug('Brokered push bypassed by early eligibility gate', {reason: earlyGate.reason})
      return {kind: 'bypass'}
    }

    const permission = await checkBrokeredPushPermission(octokit, earlyGate, logger)
    if (permission.decision === 'denied') {
      return failLoud(permission.reason, logger)
    }

    const reconstruction = await reconstructChanges(execAdapter, trustedHeadSha, repoRoot)
    if (reconstruction.success === false) {
      return failLoud(reconstruction.error.message, logger)
    }

    if (reconstruction.data.kind === 'bypass') {
      logger.debug('Brokered push bypassed during reconstruction', {reason: reconstruction.data.reason})
      return {kind: 'bypass'}
    }

    if (reconstruction.data.kind === 'nothing-to-deliver') {
      return {kind: 'nothing-to-deliver'}
    }

    const changes: FileChange[] = reconstruction.data.changes
    const validation = validateBrokeredPushFiles(changes)
    if (validation.valid === false) {
      return failLoud(validation.errors.join('; '), logger)
    }

    const preWriteGate = await checkBrokeredPushPreWriteGate(octokit, {eligible: earlyGate, expectedHeadBranch}, logger)
    if (preWriteGate.decision === 'denied') {
      return failLoud(preWriteGate.reason, logger)
    }

    try {
      const commit = await createCommit(
        octokit,
        {
          owner: preWriteGate.target.owner,
          repo: preWriteGate.target.repo,
          branch: preWriteGate.target.branch,
          message: BROKERED_PUSH_COMMIT_MESSAGE,
          files: changes,
        },
        logger,
      )

      return {kind: 'pushed', commit, branch: preWriteGate.target.branch}
    } catch (error) {
      return failLoud(toErrorMessage(error), logger)
    }
  } catch (error) {
    return failLoud(toErrorMessage(error), logger)
  }
}

function failLoud(reason: string, logger: Logger): {readonly kind: 'fail-loud'; readonly reason: string} {
  logger.warning('Brokered push delivery failed', {reason})
  return {kind: 'fail-loud', reason}
}
