import type {Octokit} from '../../services/github/types.js'
import type {Logger} from '../../shared/logger.js'

import {toErrorMessage} from '../../shared/errors.js'
import {isAuthorizedAssociation} from '../triggers/author-utils.js'

const AUTHORIZED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'] as const

export interface BrokeredPushEarlyGateParams {
  readonly facts: BrokeredPushEventFacts
  /** Captured by the trusted workflow checkout step; empty means no trusted PR anchor exists. */
  readonly trustedHeadSha: string
}

/** Exact trusted event facts needed by the early brokered-push eligibility gate. */
export interface BrokeredPushEventFacts {
  readonly eventType: string
  readonly isPullRequest: boolean
  readonly authorAssociation: string
  readonly commentAuthor: string
  readonly issueNumber: number
  readonly owner: string
  readonly repo: string
}

export interface BrokeredPushEarlyEligible {
  readonly decision: 'eligible'
  readonly owner: string
  readonly repo: string
  readonly prNumber: number
  readonly actor: string
  readonly trustedHeadSha: string
}

export interface BrokeredPushEarlyIneligible {
  readonly decision: 'ineligible'
  readonly reason: string
}

export type BrokeredPushEarlyGateOutcome = BrokeredPushEarlyEligible | BrokeredPushEarlyIneligible

export interface BrokeredPushPermissionAllowed {
  readonly decision: 'allowed'
  readonly permission: 'admin' | 'write'
}

export interface BrokeredPushPermissionDenied {
  readonly decision: 'denied'
  readonly reason: string
}

export type BrokeredPushPermissionOutcome = BrokeredPushPermissionAllowed | BrokeredPushPermissionDenied

export interface BrokeredPushPreWriteGateParams {
  readonly eligible: BrokeredPushEarlyEligible
  /** Head branch captured from trusted event-time context, not model or workspace metadata. */
  readonly expectedHeadBranch: string
}

export interface BrokeredPushTarget {
  readonly owner: string
  readonly repo: string
  readonly branch: string
}

export interface BrokeredPushPreWriteAllowed {
  readonly decision: 'allowed'
  readonly target: BrokeredPushTarget
}

export interface BrokeredPushPreWriteDenied {
  readonly decision: 'denied'
  readonly reason: string
}

export type BrokeredPushPreWriteOutcome = BrokeredPushPreWriteAllowed | BrokeredPushPreWriteDenied

/**
 * Apply the event-time brokered-push filter without consulting live state.
 */
export function evaluateBrokeredPushEarlyGate(params: BrokeredPushEarlyGateParams): BrokeredPushEarlyGateOutcome {
  const {facts, trustedHeadSha} = params
  const {eventType, isPullRequest, authorAssociation, commentAuthor, issueNumber, owner, repo} = facts

  if (owner.trim() === '') {
    return {decision: 'ineligible', reason: 'Repository identity is missing'}
  }

  if (repo.trim() === '') {
    return {decision: 'ineligible', reason: 'Repository identity is missing'}
  }

  if (eventType !== 'issue_comment') {
    return {decision: 'ineligible', reason: 'Event is not an issue comment'}
  }

  if (isPullRequest !== true) {
    return {decision: 'ineligible', reason: 'Issue comment is not on a pull request'}
  }

  if (isAuthorizedAssociation(authorAssociation, AUTHORIZED_ASSOCIATIONS) === false) {
    return {decision: 'ineligible', reason: 'Comment author association is not authorized'}
  }

  if (trustedHeadSha.trim() === '') {
    return {decision: 'ineligible', reason: 'Trusted head SHA anchor is missing'}
  }

  return {
    decision: 'eligible',
    owner,
    repo,
    prNumber: issueNumber,
    actor: commentAuthor,
    trustedHeadSha,
  }
}

/** Re-check the triggering actor's current repository permission immediately before brokered delivery. */
export async function checkBrokeredPushPermission(
  octokit: Octokit,
  eligible: BrokeredPushEarlyEligible,
  logger: Logger,
  signal?: AbortSignal,
): Promise<BrokeredPushPermissionOutcome> {
  try {
    const {data} = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner: eligible.owner,
      repo: eligible.repo,
      username: eligible.actor,
      ...(signal == null ? {} : {request: {signal}}),
    })

    if (data.permission === 'admin' || data.permission === 'write') {
      logger.debug('Brokered push permission confirmed', {
        owner: eligible.owner,
        repo: eligible.repo,
        username: eligible.actor,
        permission: data.permission,
      })
      return {decision: 'allowed', permission: data.permission}
    }

    const reason = `Live collaborator permission is insufficient or ambiguous: ${String(data.permission)}`
    logger.warning('Brokered push permission denied', {
      owner: eligible.owner,
      repo: eligible.repo,
      username: eligible.actor,
      permission: data.permission,
    })
    return {decision: 'denied', reason}
  } catch (error) {
    // Fail closed on any lookup error, including transient 5xx: without a positive
    // write-permission confirmation the push must not proceed. A transient outage
    // therefore suppresses delivery and posts a generic error rather than pushing.
    const reason = `Unable to verify live collaborator permission: ${toErrorMessage(error)}`
    logger.warning('Brokered push permission lookup failed', {
      owner: eligible.owner,
      repo: eligible.repo,
      username: eligible.actor,
      error: toErrorMessage(error),
    })
    return {decision: 'denied', reason}
  }
}

/**
 * Re-resolve PR identity and head immediately before the Git Data API write.
 * The target branch is returned only after every trusted identity check passes.
 */
export async function checkBrokeredPushPreWriteGate(
  octokit: Octokit,
  params: BrokeredPushPreWriteGateParams,
  logger: Logger,
  signal?: AbortSignal,
): Promise<BrokeredPushPreWriteOutcome> {
  const {eligible, expectedHeadBranch} = params

  try {
    const {data: pullRequest} = await octokit.rest.pulls.get({
      owner: eligible.owner,
      repo: eligible.repo,
      pull_number: eligible.prNumber,
      ...(signal == null ? {} : {request: {signal}}),
    })

    if (pullRequest.state !== 'open') {
      return denyPreWrite('Pull request is not open', logger, eligible)
    }

    const expectedRepository = `${eligible.owner}/${eligible.repo}`
    const baseRepository = pullRequest.base.repo?.full_name ?? ''
    if (baseRepository !== expectedRepository) {
      return denyPreWrite('Pull request base repository changed', logger, eligible)
    }

    const headRepository = pullRequest.head.repo?.full_name ?? ''
    if (headRepository !== baseRepository) {
      return denyPreWrite('Pull request head is no longer a same-repository branch', logger, eligible)
    }

    if (pullRequest.head.ref !== expectedHeadBranch) {
      return denyPreWrite('Pull request head branch changed', logger, eligible)
    }

    if (pullRequest.head.sha !== eligible.trustedHeadSha) {
      return denyPreWrite('Pull request head SHA changed', logger, eligible)
    }

    const branchReason = validateBrokeredPushBranchRef(pullRequest.head.ref)
    if (branchReason != null) {
      return denyPreWrite(branchReason, logger, eligible)
    }

    const target = {
      owner: eligible.owner,
      repo: eligible.repo,
      branch: pullRequest.head.ref,
    }
    logger.debug('Brokered push target confirmed', target)
    return {decision: 'allowed', target}
  } catch (error) {
    const reason = `Unable to re-resolve PR before write: ${toErrorMessage(error)}`
    logger.warning('Brokered push pre-write lookup failed', {
      owner: eligible.owner,
      repo: eligible.repo,
      prNumber: eligible.prNumber,
      error: toErrorMessage(error),
    })
    return {decision: 'denied', reason}
  }
}

/**
 * Validate a Git branch ref without shelling out to local Git metadata.
 * Returns a human-readable reason for invalid refs, or null when valid.
 */
export function validateBrokeredPushBranchRef(branch: unknown): string | null {
  if (typeof branch !== 'string' || branch.length === 0) {
    return 'Live PR head branch is empty or not a string'
  }

  if (branch.startsWith('/') || branch.endsWith('/')) {
    return `Live PR head branch is not a valid ref: ${branch}`
  }

  if (branch.includes('..')) {
    return `Live PR head branch contains '..': ${branch}`
  }

  if (hasControlCharacter(branch)) {
    return `Live PR head branch contains an ASCII control character: ${branch}`
  }

  if (branch.includes('@{')) {
    return `Live PR head branch contains '@{': ${branch}`
  }

  if (branch.includes('\\')) {
    return `Live PR head branch contains a backslash: ${branch}`
  }

  if (branch.endsWith('.lock')) {
    return `Live PR head branch ends with '.lock': ${branch}`
  }

  if (branch.endsWith('.') || branch.includes('//') || branch === '@') {
    return `Live PR head branch is not a valid ref: ${branch}`
  }

  if (branch.includes(' ') || /[~^:?*[\]]/.test(branch)) {
    return `Live PR head branch contains a forbidden ref character: ${branch}`
  }

  if (branch.split('/').some(component => component.startsWith('.'))) {
    return `Live PR head branch contains a dot-prefixed component: ${branch}`
  }

  return null
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) {
      return true
    }
  }

  return false
}

function denyPreWrite(reason: string, logger: Logger, eligible: BrokeredPushEarlyEligible): BrokeredPushPreWriteDenied {
  logger.warning('Brokered push pre-write gate denied', {
    owner: eligible.owner,
    repo: eligible.repo,
    prNumber: eligible.prNumber,
    reason,
  })
  return {decision: 'denied', reason}
}
