import type {NormalizedEvent, Octokit} from '../../services/github/types.js'
import type {ExecAdapter} from '../../services/setup/types.js'

import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockOctokit} from '../../services/github/test-helpers.js'
import {createMockLogger} from '../../shared/test-helpers.js'

const mocks = vi.hoisted(() => ({
  evaluateEarlyGate: vi.fn(),
  checkPermission: vi.fn(),
  checkPreWriteGate: vi.fn(),
  reconstructChanges: vi.fn(),
  validateFiles: vi.fn(),
}))

vi.mock('./brokered-push-gate.js', () => ({
  evaluateBrokeredPushEarlyGate: mocks.evaluateEarlyGate,
  checkBrokeredPushPermission: mocks.checkPermission,
  checkBrokeredPushPreWriteGate: mocks.checkPreWriteGate,
}))

vi.mock('./reconstruct-changes.js', () => ({
  reconstructChanges: mocks.reconstructChanges,
}))

vi.mock('./brokered-push-validation.js', () => ({
  validateBrokeredPushFiles: mocks.validateFiles,
}))

const {runBrokeredPush} = await import('./brokered-push.js')

const OWNER = 'owner'
const REPO = 'repo'
const BRANCH = 'feature/brokered-fix'
const ACTOR = 'maintainer'
const TRUSTED_HEAD_SHA = 'a'.repeat(40)

function issueCommentEvent(): NormalizedEvent {
  return {
    type: 'issue_comment',
    action: 'created',
    issue: {
      number: 42,
      title: 'Fix the thing',
      body: null,
      locked: false,
      isPullRequest: true,
    },
    comment: {
      id: 1,
      body: '@fro-bot fix it',
      author: ACTOR,
      authorAssociation: 'COLLABORATOR',
    },
  }
}

function createExecAdapter(): ExecAdapter {
  return {
    exec: vi.fn().mockResolvedValue(0),
    getExecOutput: vi.fn().mockResolvedValue({stdout: '', stderr: '', exitCode: 0}),
  }
}

function eligibleGateOutcome(): object {
  return {
    decision: 'eligible',
    owner: OWNER,
    repo: REPO,
    prNumber: 42,
    actor: ACTOR,
    trustedHeadSha: TRUSTED_HEAD_SHA,
  }
}

function allowGateSequence(changes: readonly object[]): void {
  mocks.evaluateEarlyGate.mockReturnValue(eligibleGateOutcome())
  mocks.checkPermission.mockResolvedValue({decision: 'allowed', permission: 'write'})
  mocks.reconstructChanges.mockResolvedValue({success: true, data: {kind: 'changes', changes}})
  mocks.validateFiles.mockReturnValue({valid: true, errors: []})
  mocks.checkPreWriteGate.mockResolvedValue({
    decision: 'allowed',
    target: {owner: OWNER, repo: REPO, branch: BRANCH},
  })
}

async function run(options: {readonly octokit?: Octokit; readonly trustedHeadSha?: string} = {}) {
  return runBrokeredPush({
    octokit: options.octokit ?? createMockOctokit(),
    execAdapter: createExecAdapter(),
    logger: createMockLogger(),
    event: issueCommentEvent(),
    owner: OWNER,
    repo: REPO,
    trustedHeadSha: options.trustedHeadSha ?? TRUSTED_HEAD_SHA,
    expectedHeadBranch: BRANCH,
    repoRoot: '/workspace',
  })
}

describe('runBrokeredPush', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('pushes reconstructed changes only after every gate passes and keeps force false', async () => {
    // #given an eligible PR mention and one reconstructed product change
    const changes = [{path: 'src/fix.ts', content: 'export const fixed = true'}]
    allowGateSequence(changes)
    const updateRef = vi.fn().mockResolvedValue({data: {}})
    const octokit = createMockOctokit({
      getRef: {object: {sha: 'current-sha'}},
      getCommit: {tree: {sha: 'base-tree-sha'}},
      createBlob: {sha: 'blob-sha'},
      createTree: {sha: 'tree-sha'},
      createCommit: vi.fn().mockResolvedValue({
        data: {sha: 'commit-sha', html_url: 'https://github.com/owner/repo/commit/commit-sha', message: 'fix'},
      }),
      updateRef,
    })

    // #when brokered push delivery runs
    const outcome = await run({octokit})

    // #then one aggregate commit is delivered to the pre-write target without force-pushing
    expect(outcome).toEqual({
      kind: 'pushed',
      branch: BRANCH,
      commit: {
        sha: 'commit-sha',
        url: 'https://github.com/owner/repo/commit/commit-sha',
        message: 'fix',
      },
    })
    expect(updateRef).toHaveBeenCalledWith(
      expect.objectContaining({owner: OWNER, repo: REPO, ref: `heads/${BRANCH}`, sha: 'commit-sha', force: false}),
    )
  })

  it('silently bypasses when the early eligibility gate rejects the event', async () => {
    // #given an ineligible event such as an unauthorized or non-PR mention
    mocks.evaluateEarlyGate.mockReturnValue({decision: 'ineligible', reason: 'not eligible'})

    // #when brokered push delivery runs
    const outcome = await run()

    // #then normal response delivery can proceed and no live or write step runs
    expect(outcome).toEqual({kind: 'bypass'})
    expect(mocks.checkPermission).not.toHaveBeenCalled()
    expect(mocks.reconstructChanges).not.toHaveBeenCalled()
  })

  it('returns nothing-to-deliver for an empty net diff without writing', async () => {
    // #given all gates pass but reconstruction finds no workspace changes
    mocks.evaluateEarlyGate.mockReturnValue(eligibleGateOutcome())
    mocks.checkPermission.mockResolvedValue({decision: 'allowed', permission: 'write'})
    mocks.reconstructChanges.mockResolvedValue({success: true, data: {kind: 'nothing-to-deliver'}})
    const octokit = createMockOctokit()

    // #when brokered push delivery runs
    const outcome = await run({octokit})

    // #then an empty commit is not created
    expect(outcome).toEqual({kind: 'nothing-to-deliver'})
    expect(mocks.validateFiles).not.toHaveBeenCalled()
    expect(octokit.rest.git.createCommit).not.toHaveBeenCalled()
  })

  it('fails loud when reconstructed changes are rejected by the brokered allowlist', async () => {
    // #given reconstruction produced a change outside the brokered allowlist
    const changes = [{path: '.github/workflows/ci.yml', content: 'unsafe'}]
    allowGateSequence(changes)
    mocks.validateFiles.mockReturnValue({valid: false, errors: ['path is not allowed']})

    // #when brokered push delivery runs
    const outcome = await run()

    // #then the model response must be suppressed by a typed failure
    expect(outcome).toEqual({kind: 'fail-loud', reason: 'path is not allowed'})
    expect(mocks.checkPreWriteGate).not.toHaveBeenCalled()
  })

  it('fails loud when permission, reconstruction, or pre-write checks reject delivery', async () => {
    // #given a live permission denial
    mocks.evaluateEarlyGate.mockReturnValue(eligibleGateOutcome())
    mocks.checkPermission.mockResolvedValue({decision: 'denied', reason: 'permission removed'})

    // #when brokered push delivery runs
    const permissionOutcome = await run()

    // #then no workspace or write operation is attempted
    expect(permissionOutcome).toEqual({kind: 'fail-loud', reason: 'permission removed'})
    expect(mocks.reconstructChanges).not.toHaveBeenCalled()

    // #given reconstruction itself fails
    vi.clearAllMocks()
    mocks.evaluateEarlyGate.mockReturnValue(eligibleGateOutcome())
    mocks.checkPermission.mockResolvedValue({decision: 'allowed', permission: 'write'})
    mocks.reconstructChanges.mockResolvedValue({success: false, error: new Error('head moved')})

    // #when brokered push delivery runs
    const reconstructionOutcome = await run()

    // #then reconstruction errors fail loud instead of becoming a bypass
    expect(reconstructionOutcome).toEqual({kind: 'fail-loud', reason: 'head moved'})

    // #given a live pre-write gate denial
    vi.clearAllMocks()
    allowGateSequence([{path: 'src/fix.ts', content: 'fixed'}])
    mocks.checkPreWriteGate.mockResolvedValue({decision: 'denied', reason: 'head SHA changed'})

    // #when brokered push delivery runs
    const preWriteOutcome = await run()

    // #then no commit is reported or created
    expect(preWriteOutcome).toEqual({kind: 'fail-loud', reason: 'head SHA changed'})
  })

  it('fails loud when the ref update rejects after commit creation', async () => {
    // #given a complete eligible delivery whose ref update loses the race
    allowGateSequence([{path: 'src/fix.ts', content: 'fixed'}])
    const updateRef = vi.fn().mockRejectedValue(Object.assign(new Error('reference update rejected'), {status: 422}))
    const octokit = createMockOctokit({
      getRef: {object: {sha: 'current-sha'}},
      getCommit: {tree: {sha: 'base-tree-sha'}},
      createBlob: {sha: 'blob-sha'},
      createTree: {sha: 'tree-sha'},
      createCommit: vi.fn().mockResolvedValue({
        data: {sha: 'commit-sha', html_url: 'https://github.com/owner/repo/commit/commit-sha', message: 'fix'},
      }),
      updateRef,
    })

    // #when brokered push delivery runs
    const outcome = await run({octokit})

    // #then the unreachable commit is never reported as delivered
    expect(outcome).toEqual({kind: 'fail-loud', reason: 'reference update rejected'})
  })
})
