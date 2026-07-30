import type {NormalizedEvent} from '../../services/github/types.js'
import type {Logger} from '../../shared/logger.js'
import {beforeEach, describe, expect, it} from 'vitest'
import {createMockOctokit} from '../../services/github/test-helpers.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {
  checkBrokeredPushPermission,
  checkBrokeredPushPreWriteGate,
  evaluateBrokeredPushEarlyGate,
  type BrokeredPushEarlyEligible,
} from './brokered-push-gate.js'

const OWNER = 'owner'
const REPO = 'repo'
const PR_NUMBER = 42
const ACTOR = 'maintainer'
const BRANCH = 'feature/brokered-fix'
const TRUSTED_HEAD_SHA = 'a'.repeat(40)

function issueCommentEvent(authorAssociation = 'COLLABORATOR', isPullRequest = true): NormalizedEvent {
  return {
    type: 'issue_comment',
    action: 'created',
    issue: {
      number: PR_NUMBER,
      title: 'Fix the thing',
      body: null,
      locked: false,
      isPullRequest,
    },
    comment: {
      id: 1,
      body: '@fro-bot fix it',
      author: ACTOR,
      authorAssociation,
    },
  }
}

function issuesEvent(): NormalizedEvent {
  return {
    type: 'issues',
    action: 'opened',
    issue: {
      number: PR_NUMBER,
      title: 'An issue',
      body: null,
      locked: false,
      authorAssociation: 'COLLABORATOR',
    },
    sender: {login: ACTOR},
  }
}

function eligibleEvent(anchor = TRUSTED_HEAD_SHA): BrokeredPushEarlyEligible {
  const outcome = evaluateBrokeredPushEarlyGate({
    event: issueCommentEvent(),
    owner: OWNER,
    repo: REPO,
    trustedHeadSha: anchor,
  })

  if (outcome.decision !== 'eligible') {
    throw new Error(`Expected eligible event, got ${outcome.reason}`)
  }

  return outcome
}

function livePullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: PR_NUMBER,
    state: 'open',
    base: {repo: {full_name: `${OWNER}/${REPO}`}},
    head: {
      repo: {full_name: `${OWNER}/${REPO}`},
      ref: BRANCH,
      sha: TRUSTED_HEAD_SHA,
    },
    ...overrides,
  }
}

describe('evaluateBrokeredPushEarlyGate', () => {
  it('admits a trusted same-repo PR issue comment with an anchor', () => {
    // #given a collaborator issue comment on a PR and a trusted checkout anchor
    const event = issueCommentEvent('COLLABORATOR')

    // #when the event-time gate is evaluated
    const outcome = evaluateBrokeredPushEarlyGate({
      event,
      owner: OWNER,
      repo: REPO,
      trustedHeadSha: TRUSTED_HEAD_SHA,
    })

    // #then the actor and PR identity come only from the normalized event/trusted context
    expect(outcome).toEqual({
      decision: 'eligible',
      owner: OWNER,
      repo: REPO,
      prNumber: PR_NUMBER,
      actor: ACTOR,
      trustedHeadSha: TRUSTED_HEAD_SHA,
    })
  })

  it.each([
    ['unauthorized association', issueCommentEvent('NONE'), TRUSTED_HEAD_SHA],
    ['non-PR issue comment', issueCommentEvent('COLLABORATOR', false), TRUSTED_HEAD_SHA],
    ['non-issue-comment event', issuesEvent(), TRUSTED_HEAD_SHA],
    ['missing trusted anchor', issueCommentEvent(), ''],
    ['whitespace-only trusted anchor', issueCommentEvent(), '   '],
  ])('bypasses %s without treating it as a failure', (_label, event, trustedHeadSha) => {
    // #when an event fails one of the early trusted-context checks
    const outcome = evaluateBrokeredPushEarlyGate({
      event,
      owner: OWNER,
      repo: REPO,
      trustedHeadSha,
    })

    // #then it is a typed bypass and no live state is needed
    expect(outcome.decision).toBe('ineligible')
    if (outcome.decision !== 'ineligible') throw new Error('Expected an ineligible outcome')
    expect(outcome.reason).toEqual(expect.any(String))
  })
})

describe('checkBrokeredPushPermission', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
  })

  it('allows live write permission for the event actor', async () => {
    // #given an event that passed the early gate and a live write permission
    const getCollaboratorPermissionLevel = async (params: {readonly username: string}) => {
      expect(params.username).toBe(ACTOR)
      return {data: {permission: 'write'}}
    }
    const octokit = createMockOctokit({getCollaboratorPermissionLevel})
    const eligible = eligibleEvent()

    // #when the delivery-time permission gate runs
    const outcome = await checkBrokeredPushPermission(octokit, eligible, logger)

    // #then permission is allowed without consulting model or workspace data
    expect(outcome).toEqual({decision: 'allowed', permission: 'write'})
  })

  it('allows live admin permission', async () => {
    // #given an event actor with admin permission
    const octokit = createMockOctokit({getCollaboratorPermissionLevel: {permission: 'admin'}})

    // #when the live permission gate runs
    const outcome = await checkBrokeredPushPermission(octokit, eligibleEvent(), logger)

    // #then admin is sufficient to deliver
    expect(outcome).toEqual({decision: 'allowed', permission: 'admin'})
  })

  it.each(['read', 'none', 'triage', 'maintain'])(
    'denies ambiguous or insufficient permission %s',
    async permission => {
      // #given a live permission that is not explicitly write-capable
      const octokit = createMockOctokit({getCollaboratorPermissionLevel: {permission}})

      // #when the live permission gate runs
      const outcome = await checkBrokeredPushPermission(octokit, eligibleEvent(), logger)

      // #then delivery is denied fail-loud
      expect(outcome.decision).toBe('denied')
      if (outcome.decision !== 'denied') throw new Error('Expected permission denial')
      expect(outcome.reason).toContain('permission')
    },
  )

  it('denies when the permission API errors, including a 403', async () => {
    // #given GitHub refuses the live collaborator lookup
    const error = Object.assign(new Error('Forbidden'), {status: 403})
    const getCollaboratorPermissionLevel = async () => {
      throw error
    }
    const octokit = createMockOctokit({getCollaboratorPermissionLevel})

    // #when the live permission gate runs
    const outcome = await checkBrokeredPushPermission(octokit, eligibleEvent(), logger)

    // #then the failure is not downgraded to an ineligible bypass
    expect(outcome.decision).toBe('denied')
    if (outcome.decision !== 'denied') throw new Error('Expected permission denial')
    expect(outcome.reason).toContain('permission')
  })
})

describe('checkBrokeredPushPreWriteGate', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
  })

  it('returns the same-repo live PR head as the validated target', async () => {
    // #given a live open PR whose identity and head match the trusted event facts
    const getPullRequest = async () => ({data: livePullRequest()})
    const octokit = createMockOctokit({getPullRequest})
    const eligible = eligibleEvent()

    // #when the immediate pre-write gate runs
    const outcome = await checkBrokeredPushPreWriteGate(octokit, {eligible, expectedHeadBranch: BRANCH}, logger)

    // #then the target branch comes from the live PR, after same-repo validation
    expect(outcome).toEqual({
      decision: 'allowed',
      target: {owner: OWNER, repo: REPO, branch: BRANCH},
    })
  })

  it.each([
    [
      'head advanced',
      livePullRequest({head: {repo: {full_name: `${OWNER}/${REPO}`}, ref: BRANCH, sha: 'b'.repeat(40)}}),
    ],
    ['PR closed', livePullRequest({state: 'closed'})],
    ['base repository changed', livePullRequest({base: {repo: {full_name: 'other/base'}}})],
    [
      'head became a fork',
      livePullRequest({head: {repo: {full_name: 'attacker/fork'}, ref: BRANCH, sha: TRUSTED_HEAD_SHA}}),
    ],
    [
      'head branch changed',
      livePullRequest({head: {repo: {full_name: `${OWNER}/${REPO}`}, ref: 'other/branch', sha: TRUSTED_HEAD_SHA}}),
    ],
  ])('denies %s immediately before writing', async (_label, pullRequest) => {
    // #given the live PR no longer matches the trusted event identity
    const getPullRequest = async () => ({data: pullRequest})
    const octokit = createMockOctokit({getPullRequest})

    // #when the pre-write gate runs
    const outcome = await checkBrokeredPushPreWriteGate(
      octokit,
      {eligible: eligibleEvent(), expectedHeadBranch: BRANCH},
      logger,
    )

    // #then it fails loudly instead of selecting a new target
    expect(outcome.decision).toBe('denied')
    if (outcome.decision !== 'denied') throw new Error('Expected pre-write denial')
    expect(outcome.reason).toEqual(expect.any(String))
  })

  it.each([
    '',
    '..',
    '/leading',
    'feature/..',
    'feature\0branch',
    'feature@{branch',
    String.raw`feature\branch`,
    'feature.lock',
  ])('rejects malformed head ref %j', async headRef => {
    // #given an otherwise trusted live PR with an invalid branch name
    const getPullRequest = async () => ({
      data: livePullRequest({
        head: {repo: {full_name: `${OWNER}/${REPO}`}, ref: headRef, sha: TRUSTED_HEAD_SHA},
      }),
    })
    const octokit = createMockOctokit({getPullRequest})

    // #when the pre-write gate validates the live branch
    const outcome = await checkBrokeredPushPreWriteGate(
      octokit,
      {eligible: eligibleEvent(), expectedHeadBranch: headRef},
      logger,
    )

    // #then no ambiguous ref is returned as a write target
    expect(outcome.decision).toBe('denied')
    if (outcome.decision !== 'denied') throw new Error('Expected pre-write denial')
    expect(outcome.reason).toContain('branch')
  })

  it('denies live PR lookup errors fail-loud', async () => {
    // #given GitHub cannot re-fetch the PR immediately before the write
    const getPullRequest = async () => {
      throw new Error('Not found')
    }
    const octokit = createMockOctokit({getPullRequest})

    // #when the pre-write gate runs
    const outcome = await checkBrokeredPushPreWriteGate(
      octokit,
      {eligible: eligibleEvent(), expectedHeadBranch: BRANCH},
      logger,
    )

    // #then it denies rather than using stale or workspace metadata
    expect(outcome.decision).toBe('denied')
    if (outcome.decision !== 'denied') throw new Error('Expected pre-write denial')
    expect(outcome.reason).toContain('PR')
  })
})
