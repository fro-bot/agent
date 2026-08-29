import type {Octokit} from '../../services/github/types.js'
import type {ExecAdapter} from '../../services/setup/types.js'
import type {Logger} from '../../shared/logger.js'
import type {CommitResult, FileChange} from './types.js'

import {toErrorMessage} from '../../shared/errors.js'
import {
  checkBrokeredPushPermission,
  checkBrokeredPushPreWriteGate,
  evaluateBrokeredPushEarlyGate,
  type BrokeredPushEventFacts,
} from './brokered-push-gate.js'
import {validateBrokeredPushFiles} from './brokered-push-validation.js'
import {createCommit} from './commit.js'
import {reconstructChanges} from './reconstruct-changes.js'

const BROKERED_PUSH_COMMIT_MESSAGE = 'chore: apply brokered changes'
const BROKERED_PUSH_TIMEOUT_REASON = 'brokered push exceeded time budget'

export interface BrokeredPushParams {
  readonly octokit: Octokit
  readonly execAdapter: ExecAdapter
  readonly logger: Logger
  readonly eventFacts: BrokeredPushEventFacts
  readonly trustedHeadSha: string
  readonly expectedHeadBranch: string
  readonly repoRoot: string
  readonly extraPathPrefixes: readonly string[]
  readonly signal?: AbortSignal
}

export type BrokeredPushFailureClass =
  'validation' | 'reconstruction' | 'moved-head' | 'identity' | 'permission' | 'commit' | 'timeout' | 'unknown'

export type BrokeredPushOutcome =
  | {readonly kind: 'bypass'}
  | {readonly kind: 'nothing-to-deliver'}
  | {readonly kind: 'pushed'; readonly commit: CommitResult; readonly branch: string; readonly paths: readonly string[]}
  | {
      readonly kind: 'fail-loud'
      readonly failureClass: 'validation'
      readonly reason: string
      readonly paths: readonly string[]
    }
  | {
      readonly kind: 'fail-loud'
      readonly failureClass: Exclude<BrokeredPushFailureClass, 'validation'>
      readonly reason: string
    }

/**
 * Run the brokered-push delivery state machine after a successful eligible execution.
 *
 * Every write is gated by trusted event facts, live permission, reconstruction,
 * brokered-path validation, and a final live PR identity check. A commit is only
 * reported as delivered when createCommit completes, which includes updateRef.
 */
export async function runBrokeredPush(params: BrokeredPushParams): Promise<BrokeredPushOutcome> {
  const {octokit, execAdapter, logger, eventFacts, trustedHeadSha, expectedHeadBranch, repoRoot, signal} = params

  try {
    const earlyGate = evaluateBrokeredPushEarlyGate({facts: eventFacts, trustedHeadSha})
    if (earlyGate.decision === 'ineligible') {
      logger.debug('Brokered push bypassed by early eligibility gate', {reason: earlyGate.reason})
      return {kind: 'bypass'}
    }

    const permission = await checkBrokeredPushPermission(octokit, earlyGate, logger, signal)
    if (permission.decision === 'denied') {
      return failLoud(
        signal?.aborted === true ? BROKERED_PUSH_TIMEOUT_REASON : permission.reason,
        signal?.aborted === true ? 'timeout' : 'permission',
        logger,
      )
    }

    const reconstruction = await reconstructChanges(execAdapter, trustedHeadSha, repoRoot, logger)
    if (reconstruction.success === false) {
      const timedOut = isBrokeredPushTimeout(reconstruction.error, signal)
      return failLoud(
        timedOut ? BROKERED_PUSH_TIMEOUT_REASON : reconstruction.error.message,
        timedOut ? 'timeout' : 'reconstruction',
        logger,
      )
    }

    if (reconstruction.data.kind === 'bypass') {
      logger.debug('Brokered push bypassed during reconstruction', {reason: reconstruction.data.reason})
      return {kind: 'bypass'}
    }

    if (reconstruction.data.kind === 'nothing-to-deliver') {
      return {kind: 'nothing-to-deliver'}
    }

    const changes: FileChange[] = reconstruction.data.changes
    const validation = validateBrokeredPushFiles(changes, params.extraPathPrefixes)
    if (validation.valid === false) {
      return failLoud(validation.errors.join('; '), 'validation', logger, validation.paths)
    }

    const preWriteObservation = {lookupFailed: false}
    const preWriteGate = await checkBrokeredPushPreWriteGate(
      observeBrokeredPushPreWriteLookup(octokit, preWriteObservation),
      {eligible: earlyGate, expectedHeadBranch},
      logger,
      signal,
    )
    if (preWriteGate.decision === 'denied') {
      const failureClass = preWriteObservation.lookupFailed ? 'permission' : 'identity'
      return failLoud(
        signal?.aborted === true ? BROKERED_PUSH_TIMEOUT_REASON : preWriteGate.reason,
        signal?.aborted === true ? 'timeout' : failureClass,
        logger,
      )
    }

    const headObservation = {changed: false}
    try {
      const commit = await createCommit(
        observeBrokeredPushHead(octokit, earlyGate.trustedHeadSha, headObservation),
        {
          owner: preWriteGate.target.owner,
          repo: preWriteGate.target.repo,
          branch: preWriteGate.target.branch,
          message: BROKERED_PUSH_COMMIT_MESSAGE,
          expectedHeadSha: earlyGate.trustedHeadSha,
          files: changes,
          signal,
        },
        logger,
      )

      return {kind: 'pushed', commit, branch: preWriteGate.target.branch, paths: changes.map(change => change.path)}
    } catch (error) {
      const timedOut = isBrokeredPushTimeout(error, signal)
      return failLoud(
        timedOut ? BROKERED_PUSH_TIMEOUT_REASON : getBrokeredPushFailureReason(error),
        timedOut ? 'timeout' : headObservation.changed ? 'moved-head' : 'commit',
        logger,
      )
    }
  } catch (error) {
    const timedOut = isBrokeredPushTimeout(error, signal)
    return failLoud(
      timedOut ? BROKERED_PUSH_TIMEOUT_REASON : getBrokeredPushFailureReason(error),
      timedOut ? 'timeout' : 'unknown',
      logger,
    )
  }
}

function getBrokeredPushFailureReason(error: unknown): string {
  return toErrorMessage(error)
}

function isBrokeredPushTimeout(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')
}

function observeBrokeredPushHead(octokit: Octokit, expectedHeadSha: string, observation: {changed: boolean}): Octokit {
  // createCommit owns the branch-head check, so observe its getRef call rather than
  // classifying the resulting error by inspecting its human-readable reason.
  const originalGetRef = octokit.rest.git.getRef
  const observedGetRef = Object.assign(async (...args: Parameters<typeof originalGetRef>) => {
    const result = await originalGetRef(...args)
    if (result.data.object.sha !== expectedHeadSha) {
      observation.changed = true
    }
    return result
  }, originalGetRef)

  return {
    ...octokit,
    rest: {
      ...octokit.rest,
      git: {
        ...octokit.rest.git,
        getRef: observedGetRef,
      },
    },
  }
}

function observeBrokeredPushPreWriteLookup(octokit: Octokit, observation: {lookupFailed: boolean}): Octokit {
  const originalGetPull = octokit.rest.pulls.get
  const observedGetPull = Object.assign(async (...args: Parameters<typeof originalGetPull>) => {
    try {
      return await originalGetPull(...args)
    } catch (error) {
      observation.lookupFailed = true
      throw error
    }
  }, originalGetPull)

  return {
    ...octokit,
    rest: {
      ...octokit.rest,
      pulls: {
        ...octokit.rest.pulls,
        get: observedGetPull,
      },
    },
  }
}

function failLoud(
  reason: string,
  failureClass: 'validation',
  logger: Logger,
  paths: readonly string[],
): Extract<BrokeredPushOutcome, {readonly kind: 'fail-loud'; readonly failureClass: 'validation'}>
function failLoud(
  reason: string,
  failureClass: Exclude<BrokeredPushFailureClass, 'validation'>,
  logger: Logger,
): Extract<
  BrokeredPushOutcome,
  {readonly kind: 'fail-loud'; readonly failureClass: Exclude<BrokeredPushFailureClass, 'validation'>}
>
function failLoud(
  reason: string,
  failureClass: BrokeredPushFailureClass,
  logger: Logger,
  paths?: readonly string[],
): Extract<BrokeredPushOutcome, {readonly kind: 'fail-loud'}> {
  logger.warning('Brokered push delivery failed', {reason})
  if (failureClass === 'validation') {
    if (paths == null) {
      throw new Error('Validation brokered-push failures require offending paths')
    }

    return {kind: 'fail-loud', reason, failureClass, paths}
  }

  return {kind: 'fail-loud', reason, failureClass}
}
