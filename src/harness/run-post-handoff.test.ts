import type {OpenCodeV2ServerHandle} from '@fro-bot/runtime'
import type {RoutingPhaseResult} from './phases/routing.js'
import type {SandboxLifecycleOptions} from './phases/sandbox-lifecycle.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {DEFAULT_OPENCODE_VERSION} from '../shared/constants.js'
import {err, ok} from '../shared/types.js'

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

vi.mock('../services/setup/sandbox-preflight.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/setup/sandbox-preflight.js')>()),
  runSandboxPreflight: vi.fn(async () => ({ok: true as const, tools: {}})),
}))
// The REAL lifecycle by default; a test swaps in a stub or injects deps for the privileged steps it cannot run here.
vi.mock('./phases/sandbox-lifecycle.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./phases/sandbox-lifecycle.js')>()
  return {...actual, createSandboxLifecycle: vi.fn(actual.createSandboxLifecycle)}
})

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

  describe("isolate-agent: logs are published only from this invocation's own snapshot", () => {
    const logDir = (): string => path.join(tempDir, 'opencode', 'log')

    const arm = async (): Promise<void> => {
      mocks.inputs.set('isolate-agent', 'true')
      process.env.OPENCODE_PROMPT_ARTIFACT = 'true'
      await armPhasesUpToRestore()
    }

    // The privileged steps (useradd, sudo, ACLs) cannot run here, so the lifecycle's account step is injected; everything
    // else is the real lifecycle.
    const useLifecycleDeps = async (deps: NonNullable<SandboxLifecycleOptions['deps']>): Promise<void> => {
      const actual = await vi.importActual<typeof import('./phases/sandbox-lifecycle.js')>(
        './phases/sandbox-lifecycle.js',
      )
      const {createSandboxLifecycle} = await import('./phases/sandbox-lifecycle.js')
      vi.mocked(createSandboxLifecycle).mockImplementationOnce(options =>
        actual.createSandboxLifecycle({...options, deps: {...options.deps, ...deps}}),
      )
    }

    // A lifecycle whose sandbox ran and was confirmed stopped and taken back, recording the states the real one records.
    const useRestoredSandbox = async (): Promise<void> => {
      const {createSandboxLifecycle} = await import('./phases/sandbox-lifecycle.js')
      vi.mocked(createSandboxLifecycle).mockImplementationOnce(options => {
        options.recordState?.('pending')
        return {
          prepare: vi.fn(),
          launch: vi.fn(),
          startKeyProxy: vi.fn(),
          release: vi.fn(async () => {
            options.recordState?.('restored')
            return {stop: 'stopped' as const, restore: 'restored' as const}
          }),
        }
      })
    }

    it('publishes nothing from the shared log directory when the sandbox never started (the account already existed)', async () => {
      // #given an earlier step's sandbox left content in the shared log directory, and this step's createAccount refuses
      await arm()
      await fs.mkdir(logDir(), {recursive: true})
      await fs.writeFile(path.join(logDir(), 'earlier-step.log'), 'written by an earlier unconfirmed sandbox')
      await useLifecycleDeps({
        createAccount: async () => err({kind: 'exists', message: 'already exists; refusing to adopt it'}),
      })
      const {runCacheRestore} = await import('./phases/cache-restore.js')
      vi.mocked(runCacheRestore).mockImplementation(async bootstrap => {
        await bootstrap.sandbox?.prepare({keyFilePaths: [], ghConfigDir: null, repoSkills: null})
        await bootstrap.sandbox?.release()
        return null
      })

      // #when the real run and the real post hook execute
      const {exitCode} = await runThenPost()

      // #then the run failed, and the lifecycle reported the sandbox as restored: the state the issue's hole depended on
      expect(exitCode).toBe(1)
      expect(mocks.state.get('sandboxState')).toBe('restored')
      // #and the invocation is still marked isolated, from the input, with no snapshot to publish
      expect(mocks.state.get('isolatedRun')).toBe('true')
      expect(mocks.state.has('logSnapshotDir')).toBe(false)
      // #and neither the main step's cleanup nor the post hook read or uploaded anything from the shared path
      const {uploadLogArtifact} = await import('../services/artifact/index.js')
      expect(uploadLogArtifact).not.toHaveBeenCalled()
      const {syncArtifactsToStore} = await import('@fro-bot/runtime')
      expect(syncArtifactsToStore).not.toHaveBeenCalled()
    })

    it.each([
      [
        'the runner preflight rejects',
        async () => {
          const {runSandboxPreflight} = await import('../services/setup/sandbox-preflight.js')
          vi.mocked(runSandboxPreflight).mockResolvedValueOnce({
            ok: false,
            check: 'sudo',
            message: 'isolate-agent is not supported on this runner (sudo)',
          })
        },
        'true',
      ],
      [
        'the checkout carries a persisted git credential',
        async () => {
          const {assertNoPersistedGitCredentials} = await import('../services/setup/git-credential-check.js')
          vi.mocked(assertNoPersistedGitCredentials).mockResolvedValueOnce(err('http.extraheader found'))
        },
        'true',
      ],
      ['the isolate-agent value cannot be parsed', async () => undefined, 'banana'],
    ])(
      'publishes nothing from the shared log directory when isolation was requested and bootstrap fails because %s',
      async (_label, arrangeFailure, isolateAgentInput) => {
        // #given isolation requested, shared logs left by an earlier step, prompt artifacts on, and a bootstrap that
        // fails before any sandbox lifecycle exists
        await arm()
        mocks.inputs.set('isolate-agent', isolateAgentInput)
        await arrangeFailure()
        await fs.mkdir(logDir(), {recursive: true})
        await fs.writeFile(path.join(logDir(), 'earlier-step.log'), 'written by an earlier unconfirmed sandbox')

        // #when the real run, cleanup and post hook execute
        const {exitCode} = await runThenPost()

        // #then the run failed in bootstrap, and no log backend read the shared directory
        expect(exitCode).toBe(1)
        const {uploadLogArtifact} = await import('../services/artifact/index.js')
        expect(uploadLogArtifact).not.toHaveBeenCalled()
        const {syncArtifactsToStore} = await import('@fro-bot/runtime')
        expect(syncArtifactsToStore).not.toHaveBeenCalled()
      },
    )

    it('still publishes the shared log directory for a failed bootstrap when isolation was not requested', async () => {
      // #given the same failure without isolation: the log directory is the runner's own
      await arm()
      mocks.inputs.set('isolate-agent', 'false')
      const {ensureOpenCodeAvailable} = await import('@fro-bot/runtime')
      vi.mocked(ensureOpenCodeAvailable).mockRejectedValueOnce(new Error('download failed: 504'))
      await fs.mkdir(logDir(), {recursive: true})
      await fs.writeFile(path.join(logDir(), 'run.log'), 'the runner wrote this')

      // #when
      await runThenPost()

      // #then behavior is unchanged
      const {uploadLogArtifact} = await import('../services/artifact/index.js')
      expect(uploadLogArtifact).toHaveBeenCalledWith(expect.objectContaining({logPath: logDir()}))
    })

    it("invocation A's post hook uploads A's snapshot, not what a later isolated step's sandbox wrote to the shared directory", async () => {
      // #given invocation A: an isolated run that wrote a log, was confirmed restored, and whose artifact upload failed
      await arm()
      await fs.mkdir(logDir(), {recursive: true})
      await fs.writeFile(path.join(logDir(), 'a.log'), 'A output')
      await useRestoredSandbox()
      await armStartedServer()
      const {runExecute} = await import('./phases/execute.js')
      vi.mocked(runExecute).mockRejectedValue(new Error('boom'))
      const {uploadLogArtifact} = await import('../services/artifact/index.js')
      const seen: {logPath: string; files: Record<string, string>}[] = []
      vi.mocked(uploadLogArtifact).mockImplementation(async (options: {readonly logPath: string}) => {
        const names = await fs.readdir(options.logPath)
        const files = Object.fromEntries(
          await Promise.all(
            names.map(async (name): Promise<[string, string]> => [
              name,
              await fs.readFile(path.join(options.logPath, name), 'utf8'),
            ]),
          ),
        )
        seen.push({logPath: options.logPath, files})
        return false
      })
      const {run} = await import('./run.js')
      await run()
      const snapshotDir = mocks.state.get('logSnapshotDir')
      expect(snapshotDir).toBeDefined()

      // #when a later isolated step B's sandbox writes to the shared log directory, and then A's post hook runs
      await fs.writeFile(path.join(logDir(), 'a.log'), 'B sandbox rewrote this')
      await fs.writeFile(path.join(logDir(), 'b.log'), 'B sandbox output')
      const {runPost} = await import('./post.js')
      const {createMockLogger} = await import('../shared/test-helpers.js')
      await runPost({logger: createMockLogger()})

      // #then both of A's uploads (the main step's, then the post hook's retry) read A's snapshot, with A's content only
      expect(seen).toHaveLength(2)
      for (const upload of seen) {
        expect(upload.logPath).toBe(snapshotDir)
        expect(upload.files).toEqual({'a.log': 'A output'})
      }
    })
  })
})
