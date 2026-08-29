import type {Octokit} from '../../services/github/types.js'
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

async function run(
  options: {
    readonly octokit?: Octokit
    readonly signal?: AbortSignal
    readonly trustedHeadSha?: string
    readonly extraPathPrefixes?: readonly string[]
  } = {},
) {
  return runBrokeredPush({
    octokit: options.octokit ?? createMockOctokit(),
    execAdapter: createExecAdapter(),
    logger: createMockLogger(),
    eventFacts: {
      eventType: 'issue_comment',
      isPullRequest: true,
      authorAssociation: 'COLLABORATOR',
      commentAuthor: ACTOR,
      issueNumber: 42,
      owner: OWNER,
      repo: REPO,
    },
    trustedHeadSha: options.trustedHeadSha ?? TRUSTED_HEAD_SHA,
    expectedHeadBranch: BRANCH,
    repoRoot: '/workspace',
    extraPathPrefixes: options.extraPathPrefixes ?? [],
    signal: options.signal,
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
      getRef: {object: {sha: TRUSTED_HEAD_SHA}},
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
      paths: ['src/fix.ts'],
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

  it('delivers a consumer-layout change set when an extra path prefix is opted in', async () => {
    // #given an eligible PR mention whose reconstructed changes live under a consumer app
    const changes = [{path: 'apps/web/src/index.ts', content: 'export const app = true'}]
    allowGateSequence(changes)
    const updateRef = vi.fn().mockResolvedValue({data: {}})
    const octokit = createMockOctokit({
      getRef: {object: {sha: TRUSTED_HEAD_SHA}},
      getCommit: {tree: {sha: 'base-tree-sha'}},
      createBlob: {sha: 'blob-sha'},
      createTree: {sha: 'tree-sha'},
      createCommit: vi.fn().mockResolvedValue({
        data: {sha: 'commit-sha', html_url: 'https://github.com/owner/repo/commit/commit-sha', message: 'fix'},
      }),
      updateRef,
    })

    // #when brokered push delivery runs with the consumer path opt-in
    const outcome = await run({octokit, extraPathPrefixes: ['apps']})

    // #then the consumer-layout change is delivered and the opt-in reaches validation
    expect(outcome.kind).toBe('pushed')
    expect(outcome).toMatchObject({branch: BRANCH, paths: ['apps/web/src/index.ts']})
    expect(mocks.validateFiles).toHaveBeenCalledWith(changes, ['apps'])
    expect(updateRef).toHaveBeenCalledWith(
      expect.objectContaining({owner: OWNER, repo: REPO, ref: `heads/${BRANCH}`, sha: 'commit-sha', force: false}),
    )
  })

  it('fails loud when the branch head changes before createCommit constructs the tree', async () => {
    // #given the live pre-write gate passed, but the commit primitive observes a newer head
    allowGateSequence([{path: 'src/fix.ts', content: 'fixed'}])
    const createBlob = vi.fn()
    const createTree = vi.fn()
    const updateRef = vi.fn()
    const octokit = createMockOctokit({
      getRef: {object: {sha: 'b'.repeat(40)}},
      getCommit: vi.fn(),
      createBlob,
      createTree,
      updateRef,
    })

    // #when brokered push delivery runs
    const outcome = await run({octokit})

    // #then the TOCTOU mismatch is fail-loud and no write-side API is called
    expect(outcome.kind).toBe('fail-loud')
    if (outcome.kind !== 'fail-loud') throw new Error('Expected fail-loud outcome')
    expect(outcome.failureClass).toBe('moved-head')
    expect(outcome).not.toHaveProperty('paths')
    expect(outcome.reason).toContain('Branch head changed before commit construction')
    expect(createBlob).not.toHaveBeenCalled()
    expect(createTree).not.toHaveBeenCalled()
    expect(updateRef).not.toHaveBeenCalled()
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
    const changes = [
      {path: '.github/workflows/ci.yml', content: 'unsafe'},
      {path: 'foo.md', content: 'also unsafe'},
    ]
    allowGateSequence(changes)
    mocks.validateFiles.mockReturnValue({
      valid: false,
      errors: ['path is not allowed'],
      paths: ['.github/workflows/ci.yml', 'foo.md'],
    })

    // #when brokered push delivery runs
    const outcome = await run()

    // #then the model response must be suppressed by a typed failure
    expect(outcome).toEqual({
      kind: 'fail-loud',
      reason: 'path is not allowed',
      failureClass: 'validation',
      paths: ['.github/workflows/ci.yml', 'foo.md'],
    })
    expect(mocks.checkPreWriteGate).not.toHaveBeenCalled()
  })

  it('fails loud when permission, reconstruction, or pre-write checks reject delivery', async () => {
    // #given a live permission denial
    mocks.evaluateEarlyGate.mockReturnValue(eligibleGateOutcome())
    mocks.checkPermission.mockResolvedValue({decision: 'denied', reason: 'permission removed'})

    // #when brokered push delivery runs
    const permissionOutcome = await run()

    // #then no workspace or write operation is attempted
    expect(permissionOutcome).toMatchObject({kind: 'fail-loud', failureClass: 'permission'})
    if (permissionOutcome.kind !== 'fail-loud') throw new Error('Expected fail-loud outcome')
    expect(permissionOutcome.reason).toEqual(expect.stringContaining('permission'))
    expect(mocks.reconstructChanges).not.toHaveBeenCalled()

    // #given reconstruction itself fails
    vi.clearAllMocks()
    mocks.evaluateEarlyGate.mockReturnValue(eligibleGateOutcome())
    mocks.checkPermission.mockResolvedValue({decision: 'allowed', permission: 'write'})
    mocks.reconstructChanges.mockResolvedValue({success: false, error: new Error('head moved')})

    // #when brokered push delivery runs
    const reconstructionOutcome = await run()

    // #then reconstruction errors fail loud instead of becoming a bypass
    expect(reconstructionOutcome).toMatchObject({kind: 'fail-loud', failureClass: 'reconstruction'})
    if (reconstructionOutcome.kind !== 'fail-loud') throw new Error('Expected fail-loud outcome')
    expect(reconstructionOutcome.reason).toEqual(expect.stringContaining('head moved'))

    // #given a live pre-write gate denial
    vi.clearAllMocks()
    allowGateSequence([{path: 'src/fix.ts', content: 'fixed'}])
    mocks.checkPreWriteGate.mockResolvedValue({decision: 'denied', reason: 'head SHA changed'})

    // #when brokered push delivery runs
    const preWriteOutcome = await run()

    // #then no commit is reported or created
    expect(preWriteOutcome).toMatchObject({kind: 'fail-loud', failureClass: 'identity'})
    if (preWriteOutcome.kind !== 'fail-loud') throw new Error('Expected fail-loud outcome')
    expect(preWriteOutcome.reason).toEqual(expect.stringContaining('head SHA changed'))
  })

  it('classifies a 404 from the pre-write PR lookup as an identity failure', async () => {
    // #given all prior gates pass and the PR disappears before the final identity check
    const changes = [{path: 'src/fix.ts', content: 'fixed'}]
    mocks.evaluateEarlyGate.mockReturnValue(eligibleGateOutcome())
    mocks.checkPermission.mockResolvedValue({decision: 'allowed', permission: 'write'})
    mocks.reconstructChanges.mockResolvedValue({success: true, data: {kind: 'changes', changes}})
    mocks.validateFiles.mockReturnValue({valid: true, errors: []})
    mocks.checkPreWriteGate.mockImplementation(async (wrappedOctokit: Octokit) => {
      try {
        await wrappedOctokit.rest.pulls.get({owner: OWNER, repo: REPO, pull_number: 42})
      } catch {
        // The real gate converts the lookup failure into a denied outcome.
      }
      return {decision: 'denied', reason: 'Unable to re-resolve PR before write: Not Found'}
    })
    const octokit = createMockOctokit({
      getPullRequest: vi.fn().mockRejectedValue(Object.assign(new Error('Not Found'), {status: 404})),
    })

    // #when brokered push delivery runs
    const outcome = await run({octokit})

    // #then deletion or transfer is reported as identity drift, not permission failure
    expect(outcome).toEqual({
      kind: 'fail-loud',
      reason: 'Unable to re-resolve PR before write: Not Found',
      failureClass: 'identity',
    })
  })

  it.each([
    'Unable to diff workspace against trusted head SHA: diff failed',
    'Unable to enumerate untracked workspace files: ls-files failed',
    'Reconstructed file validation failed: src/fix.ts: invalid content',
  ])('classifies %s as reconstruction', async reason => {
    // #given an eligible delivery whose reconstruction stage reports a failure
    mocks.evaluateEarlyGate.mockReturnValue(eligibleGateOutcome())
    mocks.checkPermission.mockResolvedValue({decision: 'allowed', permission: 'write'})
    mocks.reconstructChanges.mockResolvedValue({success: false, error: new Error(reason)})

    // #when brokered push delivery runs
    const outcome = await run()

    // #then all reconstruction failure sites share the stable reconstruction class
    expect(outcome).toEqual({kind: 'fail-loud', reason, failureClass: 'reconstruction'})
  })

  it('fails loud when the ref update rejects after commit creation', async () => {
    // #given a complete eligible delivery whose ref update loses the race
    allowGateSequence([{path: 'src/fix.ts', content: 'fixed'}])
    const updateRef = vi.fn().mockRejectedValue(Object.assign(new Error('reference update rejected'), {status: 422}))
    const octokit = createMockOctokit({
      getRef: {object: {sha: TRUSTED_HEAD_SHA}},
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
    expect(outcome).toEqual({kind: 'fail-loud', reason: 'reference update rejected', failureClass: 'commit'})
  })

  it('maps an aborted octokit-backed path to the brokered push budget reason', async () => {
    // #given a pre-aborted brokered push signal and an octokit-backed gate that observes it
    const controller = new AbortController()
    controller.abort()
    mocks.evaluateEarlyGate.mockReturnValue(eligibleGateOutcome())
    mocks.checkPermission.mockImplementation(async () => {
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      throw error
    })

    // #when brokered push delivery runs with the pre-aborted signal
    const outcome = await run({signal: controller.signal})

    // #then the raw abort error is replaced with the clear fail-loud budget reason
    expect(outcome).toEqual({kind: 'fail-loud', reason: 'brokered push exceeded time budget', failureClass: 'timeout'})
    expect(mocks.checkPermission).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      controller.signal,
    )
  })

  it('classifies unexpected thrown exceptions as unknown', async () => {
    // #given an eligible event whose permission gate throws an unclassified exception
    mocks.evaluateEarlyGate.mockReturnValue(eligibleGateOutcome())
    mocks.checkPermission.mockRejectedValue(new Error('unexpected gate failure'))

    // #when brokered push delivery runs
    const outcome = await run()

    // #then the failure is machine-distinguishable without parsing its reason
    expect(outcome).toEqual({kind: 'fail-loud', reason: 'unexpected gate failure', failureClass: 'unknown'})
  })
})
