import type {OpenCodeV2ServerHandle} from '@fro-bot/runtime'
import type {RoutingPhaseResult} from './phases/routing.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {DEFAULT_OPENCODE_VERSION} from '../shared/constants.js'
import {ok} from '../shared/types.js'

// Drives the REAL run() and the REAL runPost() against one shared state store, so what the post hook sees is exactly what
// `run` wrote: no test here sets a state key by hand. Only the leaf boundaries are faked: the Actions cache, the object
// store adapter, and the phases that need a live server or GitHub.
const mocks = vi.hoisted(() => ({
  state: new Map<string, string>(),
  inputs: new Map<string, string>(),
}))

vi.mock('@actions/core', () => ({
  getInput: vi.fn((name: string) => mocks.inputs.get(name) ?? ''),
  saveState: vi.fn((key: string, value: string) => {
    mocks.state.set(key, value)
  }),
  getState: vi.fn((key: string) => mocks.state.get(key) ?? ''),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
  setSecret: vi.fn(),
  notice: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  summary: {
    addHeading: vi.fn().mockReturnThis(),
    addTable: vi.fn().mockReturnThis(),
    addRaw: vi.fn().mockReturnThis(),
    write: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('@actions/github', () => ({context: {eventName: 'issues', payload: {}}}))

vi.mock('@actions/cache', () => ({saveCache: vi.fn(), restoreCache: vi.fn()}))

vi.mock('@fro-bot/runtime', async importOriginal => {
  const original = await importOriginal<typeof import('@fro-bot/runtime')>()
  return {
    ...original,
    createS3Adapter: vi.fn(),
    ensureOpenCodeAvailable: vi.fn(),
    pruneSessions: vi.fn(async () => ({prunedCount: 0, remainingCount: 0})),
    syncArtifactsToStore: vi.fn(async () => ({uploaded: 0, failed: 0})),
    syncMetadataToStore: vi.fn(async () => ({success: true})),
  }
})

vi.mock('../features/agent/index.js', () => ({
  applyTerminalReaction: vi.fn(),
  completeAcknowledgment: vi.fn(),
  resolveOutputMode: vi.fn(),
}))
vi.mock('../features/attachments/index.js', () => ({cleanupTempFiles: vi.fn()}))
vi.mock('../services/artifact/index.js', () => ({uploadLogArtifact: vi.fn()}))
vi.mock('../services/setup/git-credential-check.js', () => ({
  assertNoPersistedGitCredentials: vi.fn(async () => ok(undefined)),
}))
vi.mock('../services/github/review-delivery-receipt.js', () => ({
  createReviewDeliveryReceiptOperations: vi.fn(() => ({reserve: vi.fn(), recordDelivered: vi.fn(), release: vi.fn()})),
}))
vi.mock('../features/observability/index.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../features/observability/index.js')>()),
  writeInvocationOutcomeSummary: vi.fn(),
}))
vi.mock('./config/outputs.js', () => ({
  setActionOutputs: vi.fn(),
  setInvocationOutcomeOutput: vi.fn(),
  setCacheSaveResultOutput: vi.fn(),
}))

vi.mock('./phases/routing.js', () => ({runRouting: vi.fn()}))
vi.mock('./phases/dedup.js', () => ({runDedup: vi.fn(), saveDedupMarker: vi.fn()}))
vi.mock('./phases/acquire-lock.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./phases/acquire-lock.js')>()),
  runAcquireLock: vi.fn(),
}))
vi.mock('./phases/acknowledge.js', () => ({runAcknowledge: vi.fn()}))
vi.mock('./phases/repo-skills.js', () => ({
  runRepoSkills: vi.fn(async () => null),
  removeRepoSkillsStaging: vi.fn(async () => undefined),
}))
vi.mock('./phases/cache-restore.js', () => ({runCacheRestore: vi.fn()}))
vi.mock('./phases/session-prep.js', () => ({runSessionPrep: vi.fn()}))
vi.mock('./phases/execute.js', () => ({
  computeDrainDeadlineMs: vi.fn(() => 60_000),
  runExecute: vi.fn(),
  resolveRequestedOutputModeState: vi.fn(() => 'omitted'),
}))
vi.mock('./phases/review-reconciliation.js', () => ({
  runReviewReconciliation: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('./phases/finalize.js', () => ({
  runFinalize: vi.fn(),
  runFinalizeWithResult: vi.fn().mockResolvedValue({exitCode: 0, deliveryKind: 'none'}),
}))
vi.mock('./phases/release-v2.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./phases/release-v2.js')>()),
  runReleaseV2: vi.fn(),
}))
vi.mock('./phases/coordination-decline.js', () => ({runCoordinationDecline: vi.fn().mockResolvedValue(undefined)}))
vi.mock('./phases/coordination-clear.js', () => ({runBlockedLabelClear: vi.fn().mockResolvedValue(undefined)}))

// The real cleanup, wrapped so a test can stand in for "cleanup crashed before it saved".
vi.mock('./phases/cleanup.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./phases/cleanup.js')>()
  return {...actual, runCleanup: vi.fn(actual.runCleanup)}
})

const SESSION_KEY_V2 = 'opencode-v2-storage-github-owner-repo-main-Linux-99999-1'

async function runThenPost(): Promise<{exitCode: number}> {
  const {run} = await import('./run.js')
  const exitCode = await run()
  const {runPost} = await import('./post.js')
  const {createMockLogger} = await import('../shared/test-helpers.js')
  await runPost({logger: createMockLogger()})
  return {exitCode}
}

async function expectNothingPersisted(): Promise<void> {
  const actionsCache = await import('@actions/cache')
  const {createS3Adapter} = await import('@fro-bot/runtime')
  expect(actionsCache.saveCache).not.toHaveBeenCalled()
  expect(createS3Adapter).not.toHaveBeenCalled()
}

async function armStartedServer(): Promise<void> {
  const handle = {url: 'http://127.0.0.1:1', shutdown: vi.fn(async () => ({exit: {outcome: 'exited'}}))}
  const {runCacheRestore} = await import('./phases/cache-restore.js')
  vi.mocked(runCacheRestore).mockResolvedValue({
    cacheResult: {hit: false, key: 'k', restoredPath: null, corrupted: false, source: null},
    cacheStatus: 'miss',
    serverHandle: handle as unknown as OpenCodeV2ServerHandle,
  })
  const {runSessionPrep} = await import('./phases/session-prep.js')
  vi.mocked(runSessionPrep).mockResolvedValue({
    recentSessions: [],
    priorWorkContext: [],
    attachmentResult: null,
    normalizedWorkspace: '/w',
    logicalKey: null,
    continueSessionId: null,
    isContinuation: false,
    sessionTitle: null,
  })
  const {runReleaseV2} = await import('./phases/release-v2.js')
  vi.mocked(runReleaseV2).mockResolvedValue({
    drain: {expired: false, cancelledCount: 0, settledCount: 0, unknownCount: 0},
    persistenceDeclineReason: undefined,
  })
}

function routingResult(): RoutingPhaseResult {
  return {
    githubClient: {} as RoutingPhaseResult['githubClient'],
    triggerResult: {
      shouldProcess: true,
      context: {
        eventType: 'issues',
        eventName: 'issues',
        repo: {owner: 'owner', repo: 'repo'},
        ref: 'refs/heads/main',
        sha: 'sha',
        runId: 99999,
        actor: 'actor',
        action: 'opened',
        author: {login: 'author', association: 'OWNER', isBot: false},
        target: null,
        commentBody: null,
        commentId: null,
        hasMention: true,
        command: null,
        isBotReviewRequested: false,
        raw: {},
      },
    },
    agentContext: {
      eventName: 'issues',
      repo: 'owner/repo',
      ref: 'refs/heads/main',
      actor: 'actor',
      runId: '99999',
      issueNumber: 7,
      issueTitle: 'An issue',
      issueType: 'issue',
      commentBody: null,
      commentAuthor: null,
      commentId: null,
      defaultBranch: 'main',
      diffContext: null,
      hydratedContext: null,
      authorAssociation: 'OWNER',
      isRequestedReviewer: false,
    },
    botLogin: 'fro-bot',
  } as unknown as RoutingPhaseResult
}

async function armPhasesUpToRestore(): Promise<void> {
  mocks.inputs.set('opencode-version', DEFAULT_OPENCODE_VERSION)
  const {ensureOpenCodeAvailable} = await import('@fro-bot/runtime')
  vi.mocked(ensureOpenCodeAvailable).mockResolvedValue({
    path: '/opt/opencode',
    version: DEFAULT_OPENCODE_VERSION,
  })
  const {runRouting} = await import('./phases/routing.js')
  vi.mocked(runRouting).mockResolvedValue(routingResult())
  const {runDedup} = await import('./phases/dedup.js')
  vi.mocked(runDedup).mockResolvedValue({shouldProceed: true, entity: {entityType: 'issue', entityNumber: 7}})
  const {runAcquireLock} = await import('./phases/acquire-lock.js')
  vi.mocked(runAcquireLock).mockResolvedValue({outcome: 's3-disabled'})
  const {runAcknowledge} = await import('./phases/acknowledge.js')
  vi.mocked(runAcknowledge).mockResolvedValue({
    repo: 'owner/repo',
    commentId: 99,
    issueNumber: 7,
    issueType: 'issue',
    botLogin: 'fro-bot',
  })
}

describe('run -> post handoff: session state is saved only for a run that started the V2 server', () => {
  let tempDir: string

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.state.clear()
    mocks.inputs.clear()
    mocks.inputs.set('github-token', 'ghp_test')
    mocks.inputs.set('auth-json', '{"anthropic":{"type":"api","key":"sk-ant-test"}}')

    // Cacheable OpenCode data already on the runner: what a persistent runner holds from earlier runs.
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-post-handoff-'))
    await fs.mkdir(path.join(tempDir, 'opencode', 'storage'), {recursive: true})
    await fs.writeFile(path.join(tempDir, 'opencode', 'storage', 'session.json'), '{"stale":"from an earlier run"}')
    await fs.writeFile(path.join(tempDir, 'opencode', 'opencode.db'), 'stale db from an earlier run')
    process.env.XDG_DATA_HOME = tempDir
    process.env.GITHUB_WORKSPACE = tempDir
    process.env.GITHUB_RUN_ID = '99999'
    process.env.GITHUB_RUN_ATTEMPT = '1'
    process.env.GITHUB_REPOSITORY = 'owner/repo'
    process.env.GITHUB_REF_NAME = 'main'
    process.env.GITHUB_EVENT_NAME = 'issues'
    process.env.RUNNER_OS = 'Linux'
    process.env.RUNNER_TEMP = tempDir
    // CI sets GITHUB_JOB, which job-qualifies the save key; pin it so the expected key holds everywhere.
    vi.stubEnv('GITHUB_JOB', '')
    delete process.env.SKIP_CACHE
    delete process.env.OPENCODE_PROMPT_ARTIFACT

    const actionsCache = await import('@actions/cache')
    vi.mocked(actionsCache.saveCache).mockResolvedValue(1)
    const {createS3Adapter} = await import('@fro-bot/runtime')
    vi.mocked(createS3Adapter).mockReturnValue({
      upload: vi.fn(async () => ok(undefined)),
      download: vi.fn(async () => ok(undefined)),
      list: vi.fn(async () => ok([])),
    })
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await fs.rm(tempDir, {recursive: true, force: true})
    for (const key of [
      'XDG_DATA_HOME',
      'GITHUB_WORKSPACE',
      'GITHUB_RUN_ID',
      'GITHUB_RUN_ATTEMPT',
      'GITHUB_REPOSITORY',
      'GITHUB_REF_NAME',
      'GITHUB_EVENT_NAME',
      'RUNNER_OS',
      'RUNNER_TEMP',
    ]) {
      delete process.env[key]
    }
  })

  it('saves nothing when a V1 opencode-version is rejected, with cacheable data on the runner', async () => {
    // #given a workflow that still pins a V1 harness build
    mocks.inputs.set('opencode-version', '1.19.5+harness.bf7f7dfe')

    // #when the real run and the real post hook execute
    const {exitCode} = await runThenPost()

    // #then the input was rejected, and neither backend was touched by cleanup or by the post hook
    expect(exitCode).toBe(1)
    const core = await import('@actions/core')
    expect(vi.mocked(core.setFailed).mock.calls.join(' ')).toMatch(/no longer runs/)
    await expectNothingPersisted()
  })

  it('saves nothing when setup fails after the inputs parsed (a download error)', async () => {
    // #given valid inputs and an installer that fails
    const {ensureOpenCodeAvailable} = await import('@fro-bot/runtime')
    vi.mocked(ensureOpenCodeAvailable).mockRejectedValue(new Error('download failed: 504'))

    // #when
    const {exitCode} = await runThenPost()

    // #then
    expect(exitCode).toBe(1)
    await expectNothingPersisted()
  })

  it('saves nothing when the run fails after routing but before the server started', async () => {
    // #given everything up to routing succeeded, and the cache restore phase then throws
    await armPhasesUpToRestore()
    const {runCacheRestore} = await import('./phases/cache-restore.js')
    vi.mocked(runCacheRestore).mockRejectedValue(new Error('restore blew up'))

    // #when
    await runThenPost()

    // #then neither the cleanup save nor the post hook persisted the stale runner data
    await expectNothingPersisted()
  })

  it('post hook does not save after a crash between routing and the server start that left cleanup unsaved', async () => {
    // #given the restore phase crashed after routing, and cleanup crashed before it saved anything
    await armPhasesUpToRestore()
    const {runCacheRestore} = await import('./phases/cache-restore.js')
    vi.mocked(runCacheRestore).mockRejectedValue(new Error('restore blew up'))
    const {runCleanup} = await import('./phases/cleanup.js')
    vi.mocked(runCleanup).mockResolvedValueOnce({quiescenceConfirmed: true, continuityUnverified: false})

    // #when
    await runThenPost()

    // #then routing alone does not arm the post hook's retry
    expect(mocks.state.get('shouldSaveCache')).toBe('false')
    await expectNothingPersisted()
  })

  it('saves under V2 keys, once, for a run that started the server and then failed', async () => {
    // #given a server that started and an execution that crashed
    await armPhasesUpToRestore()
    await armStartedServer()
    const {runExecute} = await import('./phases/execute.js')
    vi.mocked(runExecute).mockRejectedValue(new Error('boom'))

    // #when
    await runThenPost()

    // #then cleanup saved under the V2 key, and the post hook then had nothing left to retry
    const actionsCache = await import('@actions/cache')
    expect(actionsCache.saveCache).toHaveBeenCalledTimes(1)
    expect(vi.mocked(actionsCache.saveCache).mock.calls[0]?.[1]).toBe(SESSION_KEY_V2)
  })

  it('post hook saves under V2 keys after a crash later than routing that left cleanup unsaved', async () => {
    // #given a started server, and a cleanup that crashed before it saved anything
    await armPhasesUpToRestore()
    await armStartedServer()
    const {runExecute} = await import('./phases/execute.js')
    vi.mocked(runExecute).mockRejectedValue(new Error('boom'))
    const {runCleanup} = await import('./phases/cleanup.js')
    vi.mocked(runCleanup).mockResolvedValueOnce({quiescenceConfirmed: true, continuityUnverified: false})

    // #when
    await runThenPost()

    // #then the post hook is the one that saved, under the V2 key and path list
    const actionsCache = await import('@actions/cache')
    expect(actionsCache.saveCache).toHaveBeenCalledTimes(1)
    expect(vi.mocked(actionsCache.saveCache).mock.calls[0]?.[1]).toBe(SESSION_KEY_V2)
  })

  it('post hook does not save after a bootstrap crash that left cleanup unsaved', async () => {
    // #given inputs that fail in bootstrap, and a cleanup that crashed before it saved anything
    mocks.inputs.set('opencode-version', '1.19.4')
    const {runCleanup} = await import('./phases/cleanup.js')
    vi.mocked(runCleanup).mockResolvedValueOnce({quiescenceConfirmed: true, continuityUnverified: false})

    // #when
    await runThenPost()

    // #then the state `run` wrote says "do not save", and the post hook honors it
    expect(mocks.state.get('shouldSaveCache')).toBe('false')
    await expectNothingPersisted()
  })
})
