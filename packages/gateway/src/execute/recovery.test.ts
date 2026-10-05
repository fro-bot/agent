import type {CoordinationConfig, RunPhase, RunState} from '@fro-bot/runtime'
import type {BindingsStore} from '../bindings/store.js'
import type {GatewayLogger} from '../discord/client.js'
import type {SinkThread} from '../discord/streaming.js'
import type {RecoverStaleRunsDeps} from './recovery.js'

import * as runtimeModule from '@fro-bot/runtime'
import {beforeEach, describe, expect, it, vi} from 'vitest'

import {recoverStaleRuns} from './recovery.js'

vi.mock('@fro-bot/runtime', () => ({
  getRunKey: vi.fn(),
  findStaleRuns: vi.fn(),
  transitionRun: vi.fn(),
  releaseLock: vi.fn(),
  forceReleaseStaleLock: vi.fn(),
  forceReleaseLock: vi.fn(),
}))

const mockGetRunKey = vi.mocked(runtimeModule.getRunKey)
const mockFindStaleRuns = vi.mocked(runtimeModule.findStaleRuns)
const mockTransitionRun = vi.mocked(runtimeModule.transitionRun)
const mockReleaseLock = vi.mocked(runtimeModule.releaseLock)
const mockForceReleaseStaleLock = vi.mocked(runtimeModule.forceReleaseStaleLock)
const mockForceReleaseLock = vi.mocked(runtimeModule.forceReleaseLock)

const OWNER = 'acme'
const REPO = 'widget'
const REPO_SLUG = `${OWNER}/${REPO}`
const RUN_ID = 'run-stale-001'
const THREAD_ID = 'thread-123'
const RUN_KEY = 'state/identity/acme/widget/runs/run-stale-001.json'
const RUN_ETAG = 'etag-run-1'

type Checker = RecoverStaleRunsDeps['checkRepoQuiescence']

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

function makeStaleRun(
  overrides: Partial<{run_id: string; thread_id: string; phase: RunPhase; details: Record<string, unknown>}> = {},
): RunState {
  return {
    run_id: overrides.run_id ?? RUN_ID,
    thread_id: overrides.thread_id ?? THREAD_ID,
    entity_ref: REPO_SLUG,
    surface: 'discord' as const,
    phase: overrides.phase ?? 'EXECUTING',
    started_at: new Date(Date.now() - 300_000).toISOString(),
    last_heartbeat: new Date(Date.now() - 300_000).toISOString(),
    holder_id: 'discord-gateway',
    details: overrides.details ?? {},
  }
}

function makeBindingsStore(bindings = [{owner: OWNER, repo: REPO}]): BindingsStore {
  return {
    createBinding: vi.fn(),
    getBindingByRepo: vi.fn(),
    getBindingByChannelId: vi.fn(),
    listBindings: vi.fn().mockResolvedValue({success: true, data: bindings}),
  }
}

function makeCoordinationConfig() {
  const conditionalDelete = vi.fn()
  const getObject = vi.fn().mockImplementation(async (key: string) => {
    if (key === RUN_KEY) return {success: true, data: {data: '{}', etag: RUN_ETAG}}
    return {success: false, error: new Error('not found')}
  })
  const config: CoordinationConfig = {
    storeAdapter: {upload: vi.fn(), download: vi.fn(), list: vi.fn(), getObject, conditionalDelete},
    storeConfig: {enabled: true, bucket: 'test', region: 'us-east-1', prefix: 'state'},
    lockTtlSeconds: 900,
    heartbeatIntervalMs: 30_000,
    staleThresholdMs: 60_000,
    pendingStaleThresholdMs: 30 * 60_000,
  }
  return {config, conditionalDelete}
}

const CLEAR = {
  kind: 'clear' as const,
  source: 'opencode-session-status' as const,
  directory: '/workspace/repos/acme/widget',
  checkedAt: '2026-01-01T00:00:00.000Z',
}
const BUSY = {...CLEAR, kind: 'busy' as const, sessionIds: ['ses-child']}
const UNKNOWN = {
  kind: 'unknown' as const,
  source: 'opencode-session-status' as const,
  directory: '/workspace/repos/acme/widget',
  reason: 'status-request-failed',
}

function makeDeps(
  overrides: Partial<RecoverStaleRunsDeps> = {},
  checker: Checker = vi.fn().mockResolvedValue(CLEAR),
): {deps: RecoverStaleRunsDeps; conditionalDelete: ReturnType<typeof vi.fn>; checker: Checker} {
  const {config, conditionalDelete} = makeCoordinationConfig()
  return {
    deps: {
      coordinationConfig: config,
      identity: 'discord-gateway',
      bindingsStore: makeBindingsStore(),
      resolveThread: vi.fn().mockResolvedValue(null),
      checkRepoQuiescence: checker,
      logger: makeLogger(),
      ...overrides,
    },
    conditionalDelete,
    checker,
  }
}

function makeThread(): SinkThread {
  return {send: vi.fn().mockResolvedValue(undefined)}
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetRunKey.mockImplementation((_config, _identity, _repo, runId) =>
    runId === RUN_ID ? {success: true, data: RUN_KEY} : ({success: false, error: new Error('unexpected')} as never),
  )
  mockFindStaleRuns.mockResolvedValue({success: true, data: []})
  mockTransitionRun.mockResolvedValue({
    success: true,
    data: {etag: 'etag-run-2', state: makeStaleRun({phase: 'FAILED'})},
  })
})

function expectNoLockDeletion(conditionalDelete: ReturnType<typeof vi.fn>): void {
  expect(conditionalDelete).not.toHaveBeenCalled()
  expect(mockReleaseLock).not.toHaveBeenCalled()
  expect(mockForceReleaseStaleLock).not.toHaveBeenCalled()
  expect(mockForceReleaseLock).not.toHaveBeenCalled()
}

describe('recoverStaleRuns', () => {
  describe('no stale runs', () => {
    it('is a clean no-op when there are no bindings', async () => {
      // #given
      const {deps, checker} = makeDeps({bindingsStore: makeBindingsStore([])})

      // #when
      await recoverStaleRuns(deps)

      // #then
      expect(mockFindStaleRuns).not.toHaveBeenCalled()
      expect(checker).not.toHaveBeenCalled()
    })

    it('does not consult the workspace when findStaleRuns returns an empty list', async () => {
      // #given
      const {deps, checker} = makeDeps()

      // #when
      await recoverStaleRuns(deps)

      // #then
      expect(mockTransitionRun).not.toHaveBeenCalled()
      expect(checker).not.toHaveBeenCalled()
    })
  })

  describe('clear workspace', () => {
    it('transitions the run to FAILED with the resolved ETag, posts a note, and never deletes a lock', async () => {
      // #given
      mockFindStaleRuns.mockResolvedValue({success: true, data: [makeStaleRun()]})
      const thread = makeThread()
      const {deps, conditionalDelete, checker} = makeDeps({resolveThread: vi.fn().mockResolvedValue(thread)})

      // #when
      await recoverStaleRuns(deps)

      // #then
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matcher typing
      expect(checker).toHaveBeenCalledWith(expect.objectContaining({repo: REPO_SLUG, signal: expect.any(AbortSignal)}))
      expect(mockTransitionRun).toHaveBeenCalledWith(
        expect.anything(),
        'discord-gateway',
        REPO_SLUG,
        RUN_ID,
        'FAILED',
        RUN_ETAG,
        expect.anything(),
      )
      expect(thread.send).toHaveBeenCalledOnce()
      expectNoLockDeletion(conditionalDelete)
    })

    it.each<RunPhase>(['PENDING', 'ACKNOWLEDGED', 'EXECUTING'])(
      'terminalizes a stale %s run only after a clear check',
      async phase => {
        // #given
        mockFindStaleRuns.mockResolvedValue({success: true, data: [makeStaleRun({phase})]})
        const {deps, conditionalDelete} = makeDeps()

        // #when
        await recoverStaleRuns(deps)

        // #then
        expect(mockTransitionRun).toHaveBeenCalledOnce()
        expectNoLockDeletion(conditionalDelete)
      },
    )

    it('skips the thread note when the thread cannot be resolved, and continues when resolveThread throws', async () => {
      // #given
      mockFindStaleRuns.mockResolvedValue({success: true, data: [makeStaleRun()]})
      const {deps} = makeDeps({resolveThread: vi.fn().mockRejectedValue(new Error('discord down'))})

      // #when / #then — does not throw
      await expect(recoverStaleRuns(deps)).resolves.toBeUndefined()
      expect(mockTransitionRun).toHaveBeenCalledOnce()
    })

    it('does not notify and does not overwrite newer state when the FAILED transition is lost', async () => {
      // #given — another writer advanced the run between read and write
      mockFindStaleRuns.mockResolvedValue({success: true, data: [makeStaleRun()]})
      mockTransitionRun.mockResolvedValue({success: false, error: new Error('precondition failed')})
      const thread = makeThread()
      const {deps, conditionalDelete} = makeDeps({resolveThread: vi.fn().mockResolvedValue(thread)})

      // #when
      await recoverStaleRuns(deps)

      // #then
      expect(mockTransitionRun).toHaveBeenCalledOnce()
      expect(thread.send).not.toHaveBeenCalled()
      expectNoLockDeletion(conditionalDelete)
    })

    it('continues with the next run when one transition fails', async () => {
      // #given
      mockFindStaleRuns.mockResolvedValue({
        success: true,
        data: [makeStaleRun(), makeStaleRun({run_id: 'run-other'})],
      })
      mockGetRunKey.mockImplementation((_config, _identity, _repo, runId) => ({
        success: true,
        data: `state/identity/acme/widget/runs/${runId}.json`,
      }))
      const {config} = makeCoordinationConfig()
      vi.mocked(config.storeAdapter.getObject as NonNullable<typeof config.storeAdapter.getObject>).mockResolvedValue({
        success: true,
        data: {data: '{}', etag: RUN_ETAG},
      })
      mockTransitionRun
        .mockResolvedValueOnce({success: false, error: new Error('boom')})
        .mockResolvedValueOnce({success: true, data: {etag: 'e2', state: makeStaleRun({phase: 'FAILED'})}})
      const {deps} = makeDeps({coordinationConfig: config})

      // #when
      await recoverStaleRuns(deps)

      // #then
      expect(mockTransitionRun).toHaveBeenCalledTimes(2)
    })
  })

  describe('blocked recovery — workspace busy or unknown', () => {
    it.each([
      ['busy', BUSY],
      ['unknown', UNKNOWN],
    ])('leaves phase and lock untouched when the workspace is %s', async (_label, result) => {
      // #given
      mockFindStaleRuns.mockResolvedValue({success: true, data: [makeStaleRun()]})
      const thread = makeThread()
      const logger = makeLogger()
      const {deps, conditionalDelete} = makeDeps(
        {resolveThread: vi.fn().mockResolvedValue(thread), logger},
        vi.fn().mockResolvedValue(result),
      )

      // #when
      await recoverStaleRuns(deps)

      // #then
      expect(mockTransitionRun).not.toHaveBeenCalled()
      expect(thread.send).not.toHaveBeenCalled()
      expectNoLockDeletion(conditionalDelete)
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({runId: RUN_ID, workspace: result.kind}),
        expect.stringContaining('recovery: blocked'),
      )
    })

    it('treats a throwing checker as blocked', async () => {
      // #given
      mockFindStaleRuns.mockResolvedValue({success: true, data: [makeStaleRun()]})
      const {deps, conditionalDelete} = makeDeps({}, vi.fn().mockRejectedValue(new Error('boom')))

      // #when
      await recoverStaleRuns(deps)

      // #then
      expect(mockTransitionRun).not.toHaveBeenCalled()
      expectNoLockDeletion(conditionalDelete)
    })

    it.each([
      ['missing ownership', {}],
      ['malformed ownership', {rootSessionId: 42, ownedSessionIds: 'nope'}],
      ['empty ownership', {rootSessionId: '', ownedSessionIds: []}],
      ['valid-looking ownership', {rootSessionId: 'ses-root', ownedSessionIds: ['ses-child']}],
    ])('cannot bypass a busy workspace with %s', async (_label, details) => {
      // #given
      mockFindStaleRuns.mockResolvedValue({success: true, data: [makeStaleRun({details})]})
      const {deps, conditionalDelete} = makeDeps({}, vi.fn().mockResolvedValue(BUSY))

      // #when
      await recoverStaleRuns(deps)

      // #then
      expect(mockTransitionRun).not.toHaveBeenCalled()
      expectNoLockDeletion(conditionalDelete)
    })

    it('does not mark persisted children settled when the snapshot is clear', async () => {
      // #given — clear terminalizes the run; no ownership state is written
      mockFindStaleRuns.mockResolvedValue({
        success: true,
        data: [makeStaleRun({details: {rootSessionId: 'ses-root', ownedSessionIds: ['ses-child']}})],
      })
      const {deps} = makeDeps()

      // #when
      await recoverStaleRuns(deps)

      // #then — plain phase transition, no detailsPatch
      expect(mockTransitionRun.mock.calls[0]).toHaveLength(7)
    })

    it('checks each repo independently: busy repo blocked, clear repo recovered', async () => {
      // #given
      const second = 'gadget'
      mockFindStaleRuns.mockImplementation(async (_config, _identity, repo) => ({
        success: true,
        data: [makeStaleRun({run_id: repo === REPO_SLUG ? RUN_ID : 'run-gadget'})],
      }))
      mockGetRunKey.mockImplementation((_config, _identity, _repo, runId) => ({
        success: true,
        data: `state/identity/runs/${runId}.json`,
      }))
      const {config} = makeCoordinationConfig()
      vi.mocked(config.storeAdapter.getObject as NonNullable<typeof config.storeAdapter.getObject>).mockResolvedValue({
        success: true,
        data: {data: '{}', etag: RUN_ETAG},
      })
      const checker: Checker = vi.fn(async ({repo}) => (repo === REPO_SLUG ? BUSY : CLEAR))
      const {deps} = makeDeps(
        {
          coordinationConfig: config,
          bindingsStore: makeBindingsStore([
            {owner: OWNER, repo: REPO},
            {owner: OWNER, repo: second},
          ]),
        },
        checker,
      )

      // #when
      await recoverStaleRuns(deps)

      // #then
      expect(mockTransitionRun).toHaveBeenCalledOnce()
      expect(mockTransitionRun.mock.calls[0]?.[2]).toBe(`${OWNER}/${second}`)
    })
  })

  describe('error paths', () => {
    it('continues to the next repo when findStaleRuns fails for one', async () => {
      // #given
      mockFindStaleRuns.mockResolvedValue({success: false, error: new Error('list failed')})
      const {deps, checker} = makeDeps()

      // #when / #then
      await expect(recoverStaleRuns(deps)).resolves.toBeUndefined()
      expect(checker).not.toHaveBeenCalled()
    })

    it('logs and returns early when listBindings fails', async () => {
      // #given
      const logger = makeLogger()
      const bindingsStore = {
        listBindings: vi.fn().mockResolvedValue({success: false, error: new Error('s3 down')}),
      } as unknown as BindingsStore
      const {deps} = makeDeps({bindingsStore, logger})

      // #when
      await recoverStaleRuns(deps)

      // #then
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({err: 's3 down'}), expect.any(String))
      expect(mockFindStaleRuns).not.toHaveBeenCalled()
    })

    it('does not abort the sweep when a repo throws unexpectedly', async () => {
      // #given
      mockFindStaleRuns.mockRejectedValueOnce(new Error('unexpected')).mockResolvedValue({success: true, data: []})
      const {deps} = makeDeps({
        bindingsStore: makeBindingsStore([
          {owner: OWNER, repo: REPO},
          {owner: OWNER, repo: 'gadget'},
        ]),
      })

      // #when / #then
      await expect(recoverStaleRuns(deps)).resolves.toBeUndefined()
      expect(mockFindStaleRuns).toHaveBeenCalledTimes(2)
    })
  })

  describe('CANCELLED locks', () => {
    it('performs no forced lock deletion at startup — CANCELLED-held locks lapse via TTL and guarded takeover', async () => {
      // #given — no stale runs; the repo lock may be held by a CANCELLED run
      const {deps, conditionalDelete} = makeDeps()

      // #when
      await recoverStaleRuns(deps)

      // #then — the sweep does not even read the lock
      expectNoLockDeletion(conditionalDelete)
      expect(vi.mocked(deps.coordinationConfig.storeAdapter.getObject as never)).not.toHaveBeenCalled()
    })
  })
})
