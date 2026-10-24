import type {RunMentionDeps} from './run.js'

import {beforeEach, describe, expect, it, vi} from 'vitest'
/* eslint-disable perfectionist/sort-imports -- ./test-helpers.js must import before any real module
   it mocks, to register vi.mock() side effects before those modules are evaluated */
import {
  awaitLaunchWorkRun,
  buildMockRunState,
  CHANNEL_ID,
  DEFAULT_BACKUP_ID,
  makeBinding,
  makeDeps,
  makeEnsureCloneFn,
  makeInMemoryRequest,
  makeListBackupsFn,
  makeMessage,
  makePreviewRecoveryFn,
  makeQuiescenceFn,
  makeRecoverFn,
  makeRecoveryPreviewData,
  mockRunOpenCodeCore,
  mockRuntime,
  OWNER,
  REPO,
  setupHappyPath,
} from './test-helpers.js'
import {abortRegistry} from './abort-registry.js'
import {totalRecoveryBudgetMs} from './checkout-recovery.js'
import {createWorkspaceCalls} from './workspace-calls.js'
import type {ListBackupsFn, PreviewRecoveryFn, RecoverFn} from './checkout-recovery.js'
import {parseRecoverEntryCustomId} from '../discord/recover-checkout-button.js'
import {controllableDeadlines, createRealAppClient, installStalledGitHub} from '../github/test-helpers.js'
import {
  CLIENT_TIMEOUT_REPLY,
  formatRollbackFailedReply,
  RECOVER_SUFFIX,
  RECOVERY_ATTEMPTED_NOTE,
} from './preparation-reply.js'
/* eslint-enable perfectionist/sort-imports */

// ---------------------------------------------------------------------------
// Checkout preparation (Unit 7) — /update replaces ensureClone→inspect. Covers every
// outcome→phase/failureKind/persisted-record/reply mapping, the Recover button on Discord,
// client timeouts, and the clone-then-update lock discipline.
// ---------------------------------------------------------------------------

describe('checkout preparation: outcome mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('refused/dirty → FAILED, no session, checkoutPreparation persisted, exact reply + recover suffix', async () => {
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const update = vi.fn().mockResolvedValue({
      success: true,
      data: {kind: 'refused', reason: 'dirty', changedPaths: ['a.txt', 'b.txt']},
    })
    const request = makeInMemoryRequest()
    const deps = makeDeps({update})

    await awaitLaunchWorkRun(launchWork, request, deps)

    const failedCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'FAILED')
    expect(failedCall).toBeDefined()
    const options = failedCall?.[7] as {detailsPatch?: {checkoutPreparation?: unknown}}
    expect(options?.detailsPatch?.checkoutPreparation).toEqual({
      outcome: 'refused',
      reason: 'dirty',
      changedPaths: ['a.txt', 'b.txt'],
    })
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
    const sent = request._replySink._sends[0]
    expect(sent?.content).toContain("The checkout has uncommitted or untracked changes, so I can't update it safely.")
    expect(sent?.content).toContain('Use the button below')
  })

  it('failed/fetch-timeout (permanent: false) → FAILED, checkoutPreparation persisted, transient reply', async () => {
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const update = vi.fn().mockResolvedValue({
      success: true,
      data: {kind: 'failed', reason: 'fetch-timeout', mutationStarted: false, permanent: false},
    })
    const request = makeInMemoryRequest()
    const deps = makeDeps({update})

    await awaitLaunchWorkRun(launchWork, request, deps)

    const failedCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'FAILED')
    const options = failedCall?.[7] as {detailsPatch?: {checkoutPreparation?: unknown}}
    expect(options?.detailsPatch?.checkoutPreparation).toEqual({
      outcome: 'failed',
      reason: 'fetch-timeout',
      mutationStarted: false,
      permanent: false,
    })
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
    expect(request._replySink._sends[0]?.content).toContain("couldn't reach the repository's remote right now")
  })

  it('refused/maintenance-hold → FAILED, checkoutPreparation persisted, grounded reply with NO recover suffix', async () => {
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const update = vi.fn().mockResolvedValue({success: true, data: {kind: 'refused', reason: 'maintenance-hold'}})
    const request = makeInMemoryRequest()
    const deps = makeDeps({update})

    await awaitLaunchWorkRun(launchWork, request, deps)

    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
    const sent = request._replySink._sends[0]
    expect(sent?.content).toContain('the workspace has put this repository on hold')
    expect(sent?.content).not.toContain('recover-checkout')
  })

  it('failed/termination-unconfirmed → FAILED, checkoutPreparation persisted, its own reply', async () => {
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const update = vi.fn().mockResolvedValue({
      success: true,
      data: {kind: 'failed', reason: 'termination-unconfirmed', mutationStarted: 'possibly', permanent: false},
    })
    const request = makeInMemoryRequest()
    const deps = makeDeps({update})

    await awaitLaunchWorkRun(launchWork, request, deps)

    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
    expect(request._replySink._sends[0]?.content).toContain("couldn't be confirmed to have stopped")
  })

  it('ready → EXECUTING commits, OpenCode session starts, no FAILED transition', async () => {
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const request = makeInMemoryRequest()
    const deps = makeDeps()

    await awaitLaunchWorkRun(launchWork, request, deps)

    const phases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(phases).toContain('EXECUTING')
    expect(phases).not.toContain('FAILED')
    expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
  })
})

describe('checkout preparation: client timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('a client-side timeout produces the state-unknown reply, no checkoutPreparation, and releases the lock with the renewed etag', async () => {
    const {launchWork} = await import('./run.js')
    const stopFn = vi.fn().mockResolvedValue({
      success: true,
      data: {runEtag: 'run-etag-after-heartbeat', lockEtag: 'lock-etag-after-heartbeat', runState: buildMockRunState()},
    })
    setupHappyPath({stop: stopFn})
    mockRuntime.transitionRun
      .mockResolvedValueOnce({
        success: true as const,
        data: {etag: 'ack-etag', state: buildMockRunState({phase: 'ACKNOWLEDGED'})},
      })
      .mockResolvedValueOnce({
        success: true as const,
        data: {etag: 'fail-etag', state: buildMockRunState({phase: 'FAILED'})},
      })
    const update = vi.fn().mockResolvedValue({success: false, error: {kind: 'timeout'}})
    const request = makeInMemoryRequest()
    const deps = makeDeps({update})

    await awaitLaunchWorkRun(launchWork, request, deps)

    expect(request._replySink._sends[0]?.content).toContain(CLIENT_TIMEOUT_REPLY)
    const failedCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'FAILED')
    const options = failedCall?.[7] as {detailsPatch?: {checkoutPreparation?: unknown}}
    expect(options?.detailsPatch?.checkoutPreparation).toBeUndefined()
    expect(mockRuntime.releaseLock).toHaveBeenCalledOnce()
    const releaseCall = mockRuntime.releaseLock.mock.calls[0] as unknown[]
    expect(releaseCall[2]).toBe('lock-etag-after-heartbeat')
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })
})

/** Every call on every level of the injected logger, serialized for leak assertions. */
function allLogCalls(logger: ReturnType<typeof makeDeps>['logger']): string {
  const levels = [logger.debug, logger.info, logger.warn, logger.error] as unknown as ReturnType<typeof vi.fn>[]
  return JSON.stringify(levels.flatMap(level => level.mock.calls))
}

describe('checkout preparation: refusal diagnostics (#1889)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('a dirty refusal logs one warning with the run id, repo, reason and path count, and no path names', async () => {
    // #given a dirty refusal whose paths could leak repo contents
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const changedPaths = ['secrets/prod.env', 'FILE_SUMMARIES.md', 'src/internal/customer-export.csv']
    const update = vi.fn().mockResolvedValue({success: true, data: {kind: 'refused', reason: 'dirty', changedPaths}})
    const request = makeInMemoryRequest()
    const deps = makeDeps({update})

    // #when
    const admission = await awaitLaunchWorkRun(launchWork, request, deps)

    // #then exactly one refusal warning, with the correlation fields
    expect(admission.accepted).toBe(true)
    const runId = admission.accepted === true ? admission.runId : undefined
    const refusalCalls = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => call[1] === 'run: checkout preparation refused',
    )
    expect(refusalCalls).toHaveLength(1)
    expect(refusalCalls[0]?.[0]).toEqual({
      repo: `${OWNER}/${REPO}`,
      runId,
      reason: 'dirty',
      changedPathCount: 3,
    })

    // #then no path name reaches any log call, in any field or level
    const logged = allLogCalls(deps.logger)
    for (const path of changedPaths) {
      expect(logged).not.toContain(path)
    }
    expect(logged).not.toContain('changedPaths')
  })

  it('a refusal with no path detail logs the reason without a path count', async () => {
    // #given
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const update = vi.fn().mockResolvedValue({success: true, data: {kind: 'refused', reason: 'ahead'}})
    const request = makeInMemoryRequest()
    const deps = makeDeps({update})

    // #when
    const admission = await awaitLaunchWorkRun(launchWork, request, deps)

    // #then
    const runId = admission.accepted === true ? admission.runId : undefined
    expect(deps.logger.warn).toHaveBeenCalledWith(
      {repo: `${OWNER}/${REPO}`, runId, reason: 'ahead'},
      'run: checkout preparation refused',
    )
  })

  it('a failed preparation logs the reason, whether mutation started and whether it is permanent', async () => {
    // #given
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const update = vi.fn().mockResolvedValue({
      success: true,
      data: {kind: 'failed', reason: 'termination-unconfirmed', mutationStarted: 'possibly', permanent: false},
    })
    const request = makeInMemoryRequest()
    const deps = makeDeps({update})

    // #when
    const admission = await awaitLaunchWorkRun(launchWork, request, deps)

    // #then
    const runId = admission.accepted === true ? admission.runId : undefined
    expect(deps.logger.warn).toHaveBeenCalledWith(
      {
        repo: `${OWNER}/${REPO}`,
        runId,
        reason: 'termination-unconfirmed',
        mutationStarted: 'possibly',
        permanent: false,
      },
      'run: checkout preparation failed',
    )
  })

  it('a ready preparation logs no refusal or failure', async () => {
    // #given
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const request = makeInMemoryRequest()
    const deps = makeDeps()

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then
    const messages = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((call: unknown[]) => call[1])
    expect(messages).not.toContain('run: checkout preparation refused')
    expect(messages).not.toContain('run: checkout preparation failed')
  })
})

describe('checkout preparation: the Recover button (Discord only)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('a refused Discord reply carries the button, and its custom ID round-trips back to this channel', async () => {
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const update = vi.fn().mockResolvedValue({success: true, data: {kind: 'refused', reason: 'detached'}})
    const message = makeMessage()
    const deps = makeDeps({update})

    await runMention(message, makeBinding(), deps)

    const thread = message._thread
    const sendMock = thread.send as ReturnType<typeof vi.fn>
    expect(sendMock).toHaveBeenCalledOnce()
    const options = sendMock.mock.calls[0]?.[0] as {content: string; components?: unknown[]}
    expect(options.components).toHaveLength(1)
    const row = options.components?.[0] as {toJSON: () => {components: {custom_id: string}[]}}
    const customId = row.toJSON().components[0]?.custom_id
    expect(customId).toBeDefined()
    // The button identifies the BOUND channel (request.channelId), not the ephemeral reply
    // thread — every bound channel maps to exactly one repo binding (see the button module's
    // own doc comment), so Unit 8's click handler can resolve it the same way it always does.
    expect(parseRecoverEntryCustomId(customId ?? '')).toEqual({channelId: CHANNEL_ID})
  })

  it('a web-launched refusal persists checkoutPreparation but never attaches a button', async () => {
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const update = vi.fn().mockResolvedValue({success: true, data: {kind: 'refused', reason: 'detached'}})
    const request = {...makeInMemoryRequest(), surface: 'web' as const}
    const deps = makeDeps({update})

    await awaitLaunchWorkRun(launchWork, request, deps)

    const sendMock = request._replySink.send as unknown as ReturnType<typeof vi.fn>
    const options = sendMock.mock.calls[0]?.[1] as {components?: unknown}
    expect(options?.components).toBeUndefined()
    const failedCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'FAILED')
    const detailsOptions = failedCall?.[7] as {detailsPatch?: {checkoutPreparation?: unknown}}
    expect(detailsOptions?.detailsPatch?.checkoutPreparation).toEqual({outcome: 'refused', reason: 'detached'})
  })

  it('an apply-failed reply whose mutation may have started ALSO carries the button (not only refusals)', async () => {
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const update = vi.fn().mockResolvedValue({
      success: true,
      data: {kind: 'failed', reason: 'apply-failed', mutationStarted: 'possibly', permanent: false},
    })
    const message = makeMessage()
    const deps = makeDeps({update})

    await runMention(message, makeBinding(), deps)

    const options = (message._thread.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      content: string
      components?: unknown[]
    }
    expect(options.content).toContain('needs recovery before I can run here')
    expect(options.components).toHaveLength(1)
  })

  it('a client timeout does NOT carry the button (nothing useful to recover into)', async () => {
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const update = vi.fn().mockResolvedValue({success: false, error: {kind: 'timeout'}})
    const message = makeMessage()
    const deps = makeDeps({update})

    await runMention(message, makeBinding(), deps)

    const options = (message._thread.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {components?: unknown}
    expect(options.components).toBeUndefined()
  })

  it('maintenance-hold does NOT carry the button', async () => {
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const update = vi.fn().mockResolvedValue({success: true, data: {kind: 'refused', reason: 'maintenance-hold'}})
    const message = makeMessage()
    const deps = makeDeps({update})

    await runMention(message, makeBinding(), deps)

    const options = (message._thread.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {components?: unknown}
    expect(options.components).toBeUndefined()
  })
})

describe('checkout preparation: clone-then-update lock discipline', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('the lock is held across the clone-then-update sequence, and a clone failure releases it', async () => {
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const ensureClone = makeEnsureCloneFn('failure')
    const update = vi.fn().mockResolvedValue({success: true, data: {kind: 'no-checkout'}})
    const message = makeMessage()
    const deps = makeDeps({ensureClone, update})

    await runMention(message, makeBinding(), deps)

    expect(mockRuntime.acquireLock).toHaveBeenCalledOnce()
    expect(ensureClone).toHaveBeenCalledOnce()
    expect(mockRuntime.releaseLock).toHaveBeenCalledOnce()
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })
})

describe('checkout preparation: invalid owner/repo binding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    ['owner with a path separator', {owner: '../evil'}],
    ['repo with whitespace', {repo: 'wid get'}],
  ])(
    '%s → no /update, ensureClone or session; FAILED, heartbeat stopped, lock and slot released',
    async (_label, overrides) => {
      // #given — a binding canonicalWorkspaceTarget rejects, after the lock is held and the heartbeat started
      const {runMention} = await import('./run.js')
      const startFn = vi.fn()
      const stopFn = vi.fn().mockResolvedValue({
        success: true,
        data: {
          runEtag: 'run-etag-after-heartbeat',
          lockEtag: 'lock-etag-after-heartbeat',
          runState: buildMockRunState(),
        },
      })
      setupHappyPath({start: startFn, stop: stopFn})
      const update = vi.fn()
      const ensureClone = vi.fn()
      const deps = makeDeps({update, ensureClone})
      const message = makeMessage()

      // #when
      await runMention(message, {...makeBinding(), ...overrides}, deps)

      // #then — nothing touched the workspace or started a session
      expect(update).not.toHaveBeenCalled()
      expect(ensureClone).not.toHaveBeenCalled()
      expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
      // #and — the run is failed as workspace-unavailable
      const failedCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'FAILED')
      expect(failedCall).toBeDefined()
      expect((failedCall?.[7] as {detailsPatch?: {failureKind?: string}})?.detailsPatch?.failureKind).toBe(
        'workspace-unavailable',
      )
      // #and — every claimed resource is released: heartbeat stopped, lock deleted with the fresh etag, slot freed
      expect(startFn).toHaveBeenCalledOnce()
      expect(stopFn).toHaveBeenCalledOnce()
      expect(mockRuntime.releaseLock).toHaveBeenCalledOnce()
      expect((mockRuntime.releaseLock.mock.calls[0] as unknown[])[2]).toBe('lock-etag-after-heartbeat')
      const releaseFn = deps.concurrency.release as ReturnType<typeof vi.fn>
      expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)
    },
  )
})

describe('checkout preparation: deadline propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('the deadline passed to update equals the lesser of 100s and the run’s remaining budget', async () => {
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const update = vi.fn().mockResolvedValue({
      success: true,
      data: {
        kind: 'ready',
        change: 'unchanged',
        branch: 'main',
        sha: 'a'.repeat(40),
        checkedAt: '2026-01-01T00:00:00.000Z',
      },
    })
    const request = makeInMemoryRequest()
    // Small run budget — well under update's own 100s ceiling — so remainingBudgetMs
    // should reflect THIS run's budget, not a hardcoded 100_000.
    const deps = makeDeps({update, runTimeoutMs: 5_000})

    await awaitLaunchWorkRun(launchWork, request, deps)

    const call = update.mock.calls[0] as [string, string, {remainingBudgetMs: number}]
    expect(call[0]).toBe(OWNER)
    expect(call[1]).toBe(REPO)
    expect(call[2].remainingBudgetMs).toBeGreaterThan(0)
    expect(call[2].remainingBudgetMs).toBeLessThanOrEqual(5_000)
  })
})

describe('checkout preparation: both transports go through it', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('a web launch (launchWork) calls update', async () => {
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const update = vi.fn().mockResolvedValue({
      success: true,
      data: {
        kind: 'ready',
        change: 'unchanged',
        branch: 'main',
        sha: 'a'.repeat(40),
        checkedAt: '2026-01-01T00:00:00.000Z',
      },
    })
    const request = {...makeInMemoryRequest(), surface: 'web' as const}
    const deps = makeDeps({update})

    await awaitLaunchWorkRun(launchWork, request, deps)

    const call = update.mock.calls[0] as [string, string, {remainingBudgetMs: number}]
    expect(call[0]).toBe(OWNER)
    expect(call[1]).toBe(REPO)
    expect(typeof call[2].remainingBudgetMs).toBe('number')
  })

  it('a Discord mention (runMention) calls update', async () => {
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const update = vi.fn().mockResolvedValue({
      success: true,
      data: {
        kind: 'ready',
        change: 'unchanged',
        branch: 'main',
        sha: 'a'.repeat(40),
        checkedAt: '2026-01-01T00:00:00.000Z',
      },
    })
    const message = makeMessage()
    const deps = makeDeps({update})

    await runMention(message, makeBinding(), deps)

    const call = update.mock.calls[0] as [string, string, {remainingBudgetMs: number}]
    expect(call[0]).toBe(OWNER)
    expect(call[1]).toBe(REPO)
    expect(typeof call[2].remainingBudgetMs).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// Automatic recovery of a dirty checkout (#1889). `update` refused as `dirty`, the workspace is
// quiet: the run preserves-and-replaces the checkout once, re-observes with `update`, and either
// continues or replies from what it observed.
// ---------------------------------------------------------------------------

const DIRTY = {success: true, data: {kind: 'refused', reason: 'dirty', changedPaths: ['a.txt']}}
const DIRTY_CLAUSE = "The checkout has uncommitted or untracked changes, so I can't update it safely."
const NEEDS_RECOVERY = {success: true, data: {kind: 'refused', reason: 'needs-recovery'}}

function readyResult(change: 'unchanged' | 'fast-forward' = 'unchanged') {
  return {
    success: true,
    data: {
      kind: 'ready',
      change,
      branch: 'main',
      sha: 'a'.repeat(40),
      ...(change === 'fast-forward' ? {fromSha: 'c'.repeat(40)} : {}),
      checkedAt: '2026-01-01T00:00:00.000Z',
    },
  }
}

/** An `update` mock that answers each call in order and then keeps repeating the last answer. */
function updateSequence(results: readonly unknown[]) {
  const fn = vi.fn()
  results.forEach(result => fn.mockResolvedValueOnce(result))
  fn.mockResolvedValue(results.at(-1))
  return fn
}

interface RecoveryRunOptions {
  readonly updates: readonly unknown[]
  /** A caller-built `update` mock (e.g. one that counts calls); replaces `updates`. */
  readonly update?: ReturnType<typeof vi.fn>
  readonly quiescence?: 'clear' | 'busy' | 'unknown'
  readonly preview?: ReturnType<typeof vi.fn>
  readonly recover?: ReturnType<typeof vi.fn>
  readonly listBackups?: ReturnType<typeof vi.fn>
  readonly surface?: 'discord' | 'web'
  readonly runTimeoutMs?: number
}

async function launchRecoveryRun(options: RecoveryRunOptions) {
  const {launchWork} = await import('./run.js')
  setupHappyPath()
  const update = options.update ?? updateSequence(options.updates)
  const checkRepoQuiescence = makeQuiescenceFn(options.quiescence ?? 'clear')
  const previewRecovery = options.preview ?? makePreviewRecoveryFn()
  const recover = options.recover ?? makeRecoverFn()
  const listBackups = options.listBackups ?? makeListBackupsFn()
  const request = {...makeInMemoryRequest(), surface: options.surface ?? ('discord' as const)}
  const deps = makeDeps({
    update: update as unknown as RunMentionDeps['update'],
    checkRepoQuiescence,
    previewRecovery: previewRecovery as unknown as PreviewRecoveryFn,
    recover: recover as unknown as RecoverFn,
    listBackups: listBackups as unknown as ListBackupsFn,
    ...(options.runTimeoutMs === undefined ? {} : {runTimeoutMs: options.runTimeoutMs}),
  })
  const admission = await awaitLaunchWorkRun(launchWork, request, deps)
  const runId = admission.accepted === true ? admission.runId : ''
  return {request, deps, runId, update, checkRepoQuiescence, previewRecovery, recover, listBackups}
}

function transitionPhases(): string[] {
  return mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/** The one reply a refused run sends, and the options (button) it was sent with. */
function refusalReply(request: Awaited<ReturnType<typeof launchRecoveryRun>>['request']) {
  const send = request._replySink.send as unknown as ReturnType<typeof vi.fn>
  expect(send).toHaveBeenCalledOnce()
  const [, options] = send.mock.calls[0] as [string, {content: string; components?: unknown[]}]
  return options
}

/** The text the status sink was asked to resolve the run's final answer to. */
function finalAnswer(request: Awaited<ReturnType<typeof launchRecoveryRun>>['request']): string {
  const resolve = request._statusSink.resolveToAnswer as unknown as ReturnType<typeof vi.fn>
  expect(resolve).toHaveBeenCalledOnce()
  return resolve.mock.calls[0]?.[0] as string
}

describe('checkout preparation: automatic recovery of a dirty checkout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('recovers and continues: dirty, quiet, preview ok, recover ok, update ready (unchanged) reaches EXECUTING', async () => {
    // #given the #1889 sequence
    // #when
    const run = await launchRecoveryRun({updates: [DIRTY, readyResult('unchanged')]})

    // #then update ran twice, recover received this run's id and the preview fingerprint
    expect(run.update).toHaveBeenCalledTimes(2)
    expect(run.checkRepoQuiescence).toHaveBeenCalledOnce()
    expect(run.previewRecovery).toHaveBeenCalledOnce()
    expect(run.recover).toHaveBeenCalledExactlyOnceWith(OWNER, REPO, {
      fingerprint: makeRecoveryPreviewData().preview.fingerprint,
      runId: run.runId,
    })
    expect(run.runId).not.toBe('')
    // #then the run executes, and is never failed
    expect(transitionPhases()).toContain('EXECUTING')
    expect(transitionPhases()).not.toContain('FAILED')
    expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
    // #then the final answer carries the backup note exactly once, with no extra send
    expect(occurrences(finalAnswer(run.request), DEFAULT_BACKUP_ID)).toBe(1)
    expect(finalAnswer(run.request)).toContain('preserved it as backup')
    expect(run.request._replySink._sends).toHaveLength(0)
    expect(occurrences(run.request._replySink._appended.join(''), DEFAULT_BACKUP_ID)).toBe(1)
  })

  it('continues the same way when the second update fast-forwards', async () => {
    // #given / #when
    const run = await launchRecoveryRun({updates: [DIRTY, readyResult('fast-forward')]})

    // #then
    expect(run.update).toHaveBeenCalledTimes(2)
    expect(transitionPhases()).toContain('EXECUTING')
    expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
    expect(occurrences(finalAnswer(run.request), DEFAULT_BACKUP_ID)).toBe(1)
  })

  it('recovers a web-launched run the same way, and its final answer carries the note', async () => {
    // #given / #when
    const run = await launchRecoveryRun({updates: [DIRTY, readyResult()], surface: 'web'})

    // #then
    expect(run.recover).toHaveBeenCalledOnce()
    expect(transitionPhases()).toContain('EXECUTING')
    expect(occurrences(finalAnswer(run.request), DEFAULT_BACKUP_ID)).toBe(1)
    expect(run.request._replySink._sends).toHaveLength(0)
  })

  it('recovers a Discord mention (runMention) the same way', async () => {
    // #given
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const update = updateSequence([DIRTY, readyResult()])
    const recover = makeRecoverFn()
    const deps = makeDeps({
      update,
      recover: recover as unknown as RecoverFn,
      checkRepoQuiescence: makeQuiescenceFn('clear'),
    })

    // #when
    await runMention(makeMessage(), makeBinding(), deps)

    // #then
    expect(recover).toHaveBeenCalledOnce()
    expect(update).toHaveBeenCalledTimes(2)
    expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
  })

  it('runs the whole recovery while the repo lock is still held', async () => {
    // #given a recover that records whether any lock release has happened yet
    const releasesSeen: number[] = []
    const recover = vi.fn().mockImplementation(async () => {
      releasesSeen.push(mockRuntime.releaseLock.mock.calls.length + mockRuntime.releaseLockIfHolder.mock.calls.length)
      return {success: true, data: {kind: 'ok', recoveryId: DEFAULT_BACKUP_ID, sha: 'b'.repeat(40), branch: 'main'}}
    })

    // #when
    await launchRecoveryRun({updates: [DIRTY, readyResult()], recover})

    // #then
    expect(releasesSeen).toEqual([0])
  })

  it('logs the recovery at warn with run id, repo and backup id, and no path', async () => {
    // #given / #when
    const run = await launchRecoveryRun({updates: [DIRTY, readyResult()]})

    // #then
    const calls = (run.deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => (call[0] as {outcome?: string}).outcome === 'recovered',
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toEqual({
      repo: `${OWNER}/${REPO}`,
      runId: run.runId,
      outcome: 'recovered',
      backupId: DEFAULT_BACKUP_ID,
    })
    expect(allLogCalls(run.deps.logger)).not.toContain('a.txt')
  })
})

describe('checkout preparation: automatic recovery is gated', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("keeps today's refusal, calling nothing, when the run budget is one below the required sum (574s by default)", async () => {
    // #given a run budget one millisecond under quiescence + two token mints + preview + recover + dispose + lookup + update
    // #when
    const run = await launchRecoveryRun({updates: [DIRTY], runTimeoutMs: totalRecoveryBudgetMs() - 1})

    // #then
    expect(run.checkRepoQuiescence).not.toHaveBeenCalled()
    expect(run.previewRecovery).not.toHaveBeenCalled()
    expect(run.recover).not.toHaveBeenCalled()
    expect(run.update).toHaveBeenCalledOnce()
    const reply = refusalReply(run.request)
    expect(reply.content).toContain(DIRTY_CLAUSE)
    expect(reply.content.endsWith(RECOVER_SUFFIX)).toBe(true)
    expect(reply.components).toHaveLength(1)
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })

  it.each(['busy', 'unknown'] as const)("keeps today's refusal when quiescence is %s", async quiescence => {
    // #given / #when
    const run = await launchRecoveryRun({updates: [DIRTY], quiescence})

    // #then
    expect(run.checkRepoQuiescence).toHaveBeenCalledOnce()
    expect(run.previewRecovery).not.toHaveBeenCalled()
    expect(run.recover).not.toHaveBeenCalled()
    expect(run.update).toHaveBeenCalledOnce()
    const reply = refusalReply(run.request)
    expect(reply.content).toContain(DIRTY_CLAUSE)
    expect(reply.content.endsWith(RECOVER_SUFFIX)).toBe(true)
    expect(reply.components).toHaveLength(1)
  })

  it.each([
    ['preview not ok', vi.fn().mockResolvedValue({success: true, data: {kind: 'no-checkout'}})],
    ['preview transport error', vi.fn().mockResolvedValue({success: false, error: {kind: 'timeout'}})],
    [
      'size measurement incomplete',
      vi.fn().mockResolvedValue({success: true, data: makeRecoveryPreviewData({sizeMeasurementComplete: false})}),
    ],
  ])("keeps today's refusal, with no recover, when %s", async (_label, preview) => {
    // #given / #when
    const run = await launchRecoveryRun({updates: [DIRTY], preview})

    // #then
    expect(run.recover).not.toHaveBeenCalled()
    expect(run.update).toHaveBeenCalledOnce()
    const reply = refusalReply(run.request)
    expect(reply.content).toContain(DIRTY_CLAUSE)
    expect(reply.content.endsWith(RECOVER_SUFFIX)).toBe(true)
  })

  it.each([
    ['detached', {kind: 'refused', reason: 'detached'}],
    ['diverged', {kind: 'refused', reason: 'diverged'}],
    ['ahead', {kind: 'refused', reason: 'ahead'}],
    ['non-default-branch', {kind: 'refused', reason: 'non-default-branch', branch: 'feature'}],
    ['needs-recovery', {kind: 'refused', reason: 'needs-recovery'}],
    ['operation-in-progress', {kind: 'refused', reason: 'operation-in-progress', operation: 'merge'}],
    ['unsupported-layout', {kind: 'refused', reason: 'unsupported-layout', layoutReason: 'git-dir-symlink'}],
    ['unsupported-config', {kind: 'refused', reason: 'unsupported-config', disallowedKeys: ['core.hooksPath']}],
    ['obstructed', {kind: 'refused', reason: 'obstructed', obstructions: []}],
    ['submodule-initialized', {kind: 'refused', reason: 'submodule-initialized', submodules: ['vendor/x']}],
    ['maintenance-hold', {kind: 'refused', reason: 'maintenance-hold'}],
    ['a failed fetch', {kind: 'failed', reason: 'fetch-failed', mutationStarted: false, permanent: false}],
    ['apply-failed', {kind: 'failed', reason: 'apply-failed', mutationStarted: 'possibly', permanent: false}],
  ])('a %s outcome never consults quiescence or recovery', async (_label, data) => {
    // #given / #when
    const run = await launchRecoveryRun({updates: [{success: true, data}]})

    // #then
    expect(run.checkRepoQuiescence).not.toHaveBeenCalled()
    expect(run.previewRecovery).not.toHaveBeenCalled()
    expect(run.recover).not.toHaveBeenCalled()
    expect(run.update).toHaveBeenCalledOnce()
  })

  it('a ready first update never consults quiescence or recovery', async () => {
    // #given / #when
    const run = await launchRecoveryRun({updates: [readyResult()]})

    // #then
    expect(run.checkRepoQuiescence).not.toHaveBeenCalled()
    expect(run.recover).not.toHaveBeenCalled()
    expect(transitionPhases()).toContain('EXECUTING')
    expect(finalAnswer(run.request)).not.toContain('backup')
  })
})

describe('checkout preparation: a recover refusal that moved nothing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const USAGE = {
    generationCount: 5,
    hasUnknownSize: false,
    totalBytes: 1000,
    maxGenerations: 5,
    maxBytes: 10_737_418_240,
  }

  it('quota-exceeded names the cause and the cleanup command, with no RECOVER_SUFFIX and no button', async () => {
    // #given
    const recover = vi
      .fn()
      .mockResolvedValue({success: true, data: {kind: 'refused', reason: 'quota-exceeded', usage: USAGE}})

    // #when
    const run = await launchRecoveryRun({updates: [DIRTY], recover})

    // #then
    expect(run.update).toHaveBeenCalledOnce()
    expect(recover).toHaveBeenCalledOnce()
    const reply = refusalReply(run.request)
    expect(reply.content).toContain(DIRTY_CLAUSE)
    expect(reply.content).toContain('retention limit (5 generations or 10.0 GiB)')
    expect(reply.content).toContain('`/fro-bot checkout-backup delete <id>`')
    expect(reply.content).not.toContain('Nothing was discarded')
    expect(reply.content).not.toContain(RECOVER_SUFFIX)
    expect(reply.components).toBeUndefined()
    // #then the persisted record is still the original dirty refusal
    const failedCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'FAILED')
    const detailsOptions = failedCall?.[7] as {detailsPatch?: {checkoutPreparation?: unknown}}
    expect(detailsOptions?.detailsPatch?.checkoutPreparation).toEqual({
      outcome: 'refused',
      reason: 'dirty',
      changedPaths: ['a.txt'],
    })
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })

  it('insufficient-disk-space names the cause, with no RECOVER_SUFFIX and no button', async () => {
    // #given
    const recover = vi
      .fn()
      .mockResolvedValue({success: true, data: {kind: 'refused', reason: 'insufficient-disk-space'}})

    // #when
    const run = await launchRecoveryRun({updates: [DIRTY], recover})

    // #then
    const reply = refusalReply(run.request)
    expect(reply.content).toContain(DIRTY_CLAUSE)
    expect(reply.content).toContain("There isn't enough free disk space to recover `acme/widget` right now.")
    expect(reply.content).not.toContain(RECOVER_SUFFIX)
    expect(reply.components).toBeUndefined()
    expect(run.update).toHaveBeenCalledOnce()
  })

  it.each([
    ['checkout-changed', {kind: 'refused', reason: 'checkout-changed'}],
    ['journal-in-progress', {kind: 'refused', reason: 'journal-in-progress', phase: 'building'}],
    ['maintenance-hold', {kind: 'refused', reason: 'maintenance-hold'}],
    ['inspection-failed', {kind: 'failed', reason: 'inspection-failed'}],
    ['fetch-failed', {kind: 'failed', reason: 'fetch-failed'}],
    ['build-failed', {kind: 'failed', reason: 'build-failed'}],
  ])("%s sends today's dirty refusal with its button, and never recovers twice", async (_label, data) => {
    // #given
    const recover = vi.fn().mockResolvedValue({success: true, data})

    // #when
    const run = await launchRecoveryRun({updates: [DIRTY], recover})

    // #then nothing moved, so the original refusal stands and no second update is made
    expect(run.update).toHaveBeenCalledOnce()
    expect(recover).toHaveBeenCalledOnce()
    const reply = refusalReply(run.request)
    expect(reply.content).toContain(DIRTY_CLAUSE)
    expect(reply.content.endsWith(RECOVER_SUFFIX)).toBe(true)
    expect(reply.content).not.toContain('backup')
    expect(reply.components).toHaveLength(1)
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })
})

const AMBIGUOUS_RECOVERS: readonly (readonly [string, unknown])[] = [
  ['a timeout', {success: false, error: {kind: 'timeout'}}],
  ['a network error', {success: false, error: {kind: 'network-error'}}],
  ['an http error', {success: false, error: {kind: 'http-error', status: 500}}],
  ['a parse error', {success: false, error: {kind: 'parse-error'}}],
  ['no-checkout', {success: true, data: {kind: 'no-checkout'}}],
  ['quarantine-failed', {success: true, data: {kind: 'failed', reason: 'quarantine-failed'}}],
  ['install-failed', {success: true, data: {kind: 'failed', reason: 'install-failed'}}],
  ['verification-failed', {success: true, data: {kind: 'failed', reason: 'verification-failed'}}],
  ['termination-unconfirmed', {success: true, data: {kind: 'failed', reason: 'termination-unconfirmed'}}],
]

describe('checkout preparation: a recover outcome where something may have moved', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(AMBIGUOUS_RECOVERS)(
    'after %s, update is called once more and its needs-recovery result gets its text and button',
    async (_label, result) => {
      // #given
      const recover = vi.fn().mockResolvedValue(result)

      // #when
      const run = await launchRecoveryRun({updates: [DIRTY, NEEDS_RECOVERY], recover})

      // #then the reply comes from the OBSERVED state, not from the stale dirty refusal
      expect(run.update).toHaveBeenCalledTimes(2)
      expect(recover).toHaveBeenCalledOnce()
      const reply = refusalReply(run.request)
      expect(reply.content).toContain('A previous update to this checkout was interrupted and needs recovery')
      expect(reply.content).not.toContain(DIRTY_CLAUSE)
      // no backup matched this run, so the reply carries the attempted note (once) and no id
      expect(occurrences(reply.content, RECOVERY_ATTEMPTED_NOTE)).toBe(1)
      expect(reply.content).not.toContain(DEFAULT_BACKUP_ID)
      expect(reply.components).toHaveLength(1)
      expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
    },
  )

  it.each(AMBIGUOUS_RECOVERS)(
    'after %s, a ready update continues the run and says recovery was attempted',
    async (_label, result) => {
      // #given
      const recover = vi.fn().mockResolvedValue(result)

      // #when
      const run = await launchRecoveryRun({updates: [DIRTY, readyResult()], recover})

      // #then
      expect(run.update).toHaveBeenCalledTimes(2)
      expect(transitionPhases()).toContain('EXECUTING')
      expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
      const answer = finalAnswer(run.request)
      expect(answer).toContain('/fro-bot checkout-backup list')
      expect(occurrences(answer, 'checkout-backup list')).toBe(1)
    },
  )

  it("after an ambiguous recover, a still-dirty update replies with today's dirty text and names no backup", async () => {
    // #given an abort or timeout that rolled back: the checkout is exactly as it was
    const recover = vi.fn().mockResolvedValue({success: false, error: {kind: 'timeout'}})

    // #when
    const run = await launchRecoveryRun({updates: [DIRTY, DIRTY], recover})

    // #then
    expect(run.update).toHaveBeenCalledTimes(2)
    expect(recover).toHaveBeenCalledOnce()
    const reply = refusalReply(run.request)
    expect(reply.content).toContain(DIRTY_CLAUSE)
    expect(occurrences(reply.content, RECOVERY_ATTEMPTED_NOTE)).toBe(1)
    expect(reply.content).not.toContain(DEFAULT_BACKUP_ID)
  })
})

describe('checkout preparation: the follow-up update after a successful recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('still dirty: replies from that result, names the backup id, and attempts no second recovery', async () => {
    // #given a writer re-dirtied the fresh checkout
    // #when
    const run = await launchRecoveryRun({updates: [DIRTY, DIRTY]})

    // #then
    expect(run.update).toHaveBeenCalledTimes(2)
    expect(run.checkRepoQuiescence).toHaveBeenCalledOnce()
    expect(run.previewRecovery).toHaveBeenCalledOnce()
    expect(run.recover).toHaveBeenCalledOnce()
    const reply = refusalReply(run.request)
    expect(reply.content).toContain(DIRTY_CLAUSE)
    expect(occurrences(reply.content, DEFAULT_BACKUP_ID)).toBe(1)
    // the button still rides on the refusal text
    expect(reply.content.endsWith(RECOVER_SUFFIX)).toBe(true)
    expect(reply.components).toHaveLength(1)
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
    const failedCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'FAILED')
    const detailsOptions = failedCall?.[7] as {detailsPatch?: {checkoutPreparation?: unknown}}
    expect(detailsOptions?.detailsPatch?.checkoutPreparation).toEqual({
      outcome: 'refused',
      reason: 'dirty',
      changedPaths: ['a.txt'],
    })
  })

  it('refused for another reason: replies from that result and names the backup id', async () => {
    // #given
    const detached = {success: true, data: {kind: 'refused', reason: 'detached'}}

    // #when
    const run = await launchRecoveryRun({updates: [DIRTY, detached]})

    // #then
    const reply = refusalReply(run.request)
    expect(reply.content).toContain("The checkout isn't on a branch")
    expect(occurrences(reply.content, DEFAULT_BACKUP_ID)).toBe(1)
    expect(run.recover).toHaveBeenCalledOnce()
  })

  it('failed: replies from that result and names the backup id', async () => {
    // #given
    const failed = {
      success: true,
      data: {kind: 'failed', reason: 'fetch-timeout', mutationStarted: false, permanent: false},
    }

    // #when
    const run = await launchRecoveryRun({updates: [DIRTY, failed]})

    // #then
    const reply = refusalReply(run.request)
    expect(reply.content).toContain("couldn't reach the repository's remote right now")
    expect(occurrences(reply.content, DEFAULT_BACKUP_ID)).toBe(1)
  })

  it('a client timeout on the follow-up update still names the backup id', async () => {
    // #given
    const timeout = {success: false, error: {kind: 'timeout'}}

    // #when
    const run = await launchRecoveryRun({updates: [DIRTY, timeout]})

    // #then
    const reply = refusalReply(run.request)
    expect(reply.content).toContain(CLIENT_TIMEOUT_REPLY)
    expect(occurrences(reply.content, DEFAULT_BACKUP_ID)).toBe(1)
    expect(reply.components).toBeUndefined()
  })

  it('a transport error on the follow-up update fails the run with the backup id in the failure note', async () => {
    // #given
    const networkError = {success: false, error: {kind: 'network-error'}}

    // #when
    const run = await launchRecoveryRun({updates: [DIRTY, networkError]})

    // #then
    const resolveToFailure = run.request._statusSink.resolveToFailure as unknown as ReturnType<typeof vi.fn>
    expect(resolveToFailure).toHaveBeenCalledOnce()
    expect(occurrences(resolveToFailure.mock.calls[0]?.[0] as string, DEFAULT_BACKUP_ID)).toBe(1)
    expect(run.recover).toHaveBeenCalledOnce()
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })
})

describe('checkout preparation: operator cancel during preparation (deferred, pinned)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('a cancel arriving while recovery is running is not honoured: nothing is registered, and the run proceeds', async () => {
    // #given a recover that stays pending until the test releases it
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    let cancelOutcome: boolean | undefined
    let registeredDuringRecover: boolean | undefined
    let runIdSeen = ''
    const recover = vi.fn().mockImplementation(async (_owner: string, _repo: string, opts: {runId: string}) => {
      runIdSeen = opts.runId
      registeredDuringRecover = abortRegistry.has(opts.runId)
      cancelOutcome = abortRegistry.abort(opts.runId, 'operator cancel')
      await gate
      return {success: true, data: {kind: 'ok', recoveryId: DEFAULT_BACKUP_ID, sha: 'b'.repeat(40), branch: 'main'}}
    })

    // #when
    const pending = launchRecoveryRun({updates: [DIRTY, readyResult()], recover})
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce())
    release?.()
    const run = await pending

    // #then no abort controller exists for the run yet, so the cancel is a no-op ...
    expect(runIdSeen).toBe(run.runId)
    expect(registeredDuringRecover).toBe(false)
    expect(cancelOutcome).toBe(false)
    // ... and the run is not cancelled: it continues to EXECUTING
    expect(transitionPhases()).toContain('EXECUTING')
    expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
    expect(abortRegistry.isAborted(run.runId)).toBe(false)
  })
})

describe('checkout preparation: the session directory after a recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('queries quiescence for, and runs the session in, the same canonical directory the recovery replaced', async () => {
    // #given / #when
    const run = await launchRecoveryRun({updates: [DIRTY, readyResult()]})

    // #then the checkout is replaced IN PLACE at the canonical path, so the session directory is
    // unchanged by a recovery and quiescence was queried for that same repo
    expect(run.checkRepoQuiescence.mock.calls[0]?.[0]).toMatchObject({repo: `${OWNER}/${REPO}`})
    expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
    const coreArgs = mockRunOpenCodeCore.mock.calls[0]?.[0] as {directory?: string} | undefined
    expect(coreArgs?.directory).toBe(`/workspace/repos/${OWNER}/${REPO}`)
  })
})

// ---------------------------------------------------------------------------
// After an ambiguous recovery outcome the run looks up its OWN backup by run id. A found id is named on
// every reply path exactly like a `recovered` one; a missing or unanswerable lookup falls back to the
// attempted note on every one of those paths.
// ---------------------------------------------------------------------------

const BACKUP_ID = 'gen-found-1'
const TIMEOUT_RECOVER = {success: false, error: {kind: 'timeout'}}

/** A recover mock that answers `result` and remembers the run id it was given. */
function makeRunIdCapturingRecover(result: unknown) {
  const captured: {runId?: string} = {}
  const recover = vi.fn().mockImplementation(async (_owner: string, _repo: string, opts: {runId: string}) => {
    captured.runId = opts.runId
    return result
  })
  return {recover, captured}
}

/** A listBackups mock whose single entry is attributed to whichever run id `recover` was given. */
function makeAttributedListing(captured: {runId?: string}, id = BACKUP_ID) {
  return vi.fn().mockImplementation(async () => ({
    success: true as const,
    data: {
      kind: 'ok' as const,
      totalBytes: 1,
      backups: [
        {
          id,
          metadataOk: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          sizeBytes: 1,
          sizeComplete: true,
          originalHeadSha: undefined,
          originalBranch: undefined,
          runId: captured.runId,
        },
        {
          id: 'gen-someone-else',
          metadataOk: true,
          createdAt: '2026-01-02T00:00:00.000Z',
          sizeBytes: 1,
          sizeComplete: true,
          originalHeadSha: undefined,
          originalBranch: undefined,
          runId: 'another-run',
        },
      ],
    },
  }))
}

/** The recovery note a reply leads with: its first paragraph (the refusal text that follows may say "install" itself). */
function leadingNote(text: string): string {
  return text.split('\n\n')[0] ?? ''
}

/** The provenance/recovery line a failure text ends with: its last paragraph. */
function trailingNote(text: string): string {
  return text.split('\n\n').at(-1) ?? ''
}

/** The failure text the status sink was asked to resolve a thrown error to. */
function failureText(run: Awaited<ReturnType<typeof launchRecoveryRun>>): string {
  const resolveToFailure = run.request._statusSink.resolveToFailure as unknown as ReturnType<typeof vi.fn>
  expect(resolveToFailure).toHaveBeenCalledOnce()
  return resolveToFailure.mock.calls[0]?.[0] as string
}

describe('checkout preparation: an ambiguous recovery whose backup the lookup finds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('looks the backup up by this run, and a ready update continues naming the id exactly once (no attempted note)', async () => {
    // #given the recover answer was lost, but the workspace had completed the swap
    const {recover, captured} = makeRunIdCapturingRecover(TIMEOUT_RECOVER)
    const listBackups = makeAttributedListing(captured)

    // #when
    const run = await launchRecoveryRun({updates: [DIRTY, readyResult()], recover, listBackups})

    // #then
    expect(listBackups).toHaveBeenCalledExactlyOnceWith(OWNER, REPO)
    expect(run.update).toHaveBeenCalledTimes(2)
    const answer = finalAnswer(run.request)
    expect(occurrences(answer, BACKUP_ID)).toBe(1)
    expect(answer).not.toContain('gen-someone-else')
    expect(answer).not.toContain(RECOVERY_ATTEMPTED_NOTE)
    expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
  })

  it('names the id on a refusal from the second update, and keeps the Recover button', async () => {
    // #given
    const {recover, captured} = makeRunIdCapturingRecover(TIMEOUT_RECOVER)

    // #when
    const run = await launchRecoveryRun({
      updates: [DIRTY, NEEDS_RECOVERY],
      recover,
      listBackups: makeAttributedListing(captured),
    })

    // #then
    const reply = refusalReply(run.request)
    expect(occurrences(reply.content, BACKUP_ID)).toBe(1)
    expect(reply.content).not.toContain(RECOVERY_ATTEMPTED_NOTE)
    // the swap's install is unconfirmed (the follow-up update says needs-recovery), so no install claim
    expect(leadingNote(reply.content)).not.toMatch(/install/i)
    expect(reply.components).toHaveLength(1)
  })

  it('names the id when the follow-up update times out', async () => {
    // #given
    const {recover, captured} = makeRunIdCapturingRecover(TIMEOUT_RECOVER)

    // #when
    const run = await launchRecoveryRun({
      updates: [DIRTY, {success: false, error: {kind: 'timeout'}}],
      recover,
      listBackups: makeAttributedListing(captured),
    })

    // #then
    const reply = refusalReply(run.request)
    expect(reply.content).toContain(CLIENT_TIMEOUT_REPLY)
    expect(occurrences(reply.content, BACKUP_ID)).toBe(1)
  })

  it('names the id in the failure when the follow-up update throws (transport error)', async () => {
    // #given
    const {recover, captured} = makeRunIdCapturingRecover(TIMEOUT_RECOVER)

    // #when
    const run = await launchRecoveryRun({
      updates: [DIRTY, {success: false, error: {kind: 'network-error'}}],
      recover,
      listBackups: makeAttributedListing(captured),
    })

    // #then
    expect(occurrences(failureText(run), BACKUP_ID)).toBe(1)
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })

  it('names the id when the follow-up update is checkout-substituted', async () => {
    // #given
    const {recover, captured} = makeRunIdCapturingRecover(TIMEOUT_RECOVER)

    // #when
    const run = await launchRecoveryRun({
      updates: [DIRTY, {success: true, data: {kind: 'refused', reason: 'checkout-substituted'}}],
      recover,
      listBackups: makeAttributedListing(captured),
    })

    // #then
    expect(occurrences(failureText(run), BACKUP_ID)).toBe(1)
  })

  it('does not look anything up after a confirmed recovery', async () => {
    // #given / #when
    const run = await launchRecoveryRun({updates: [DIRTY, readyResult()]})

    // #then the confirmed id is used directly
    expect(run.listBackups).not.toHaveBeenCalled()
  })

  it('does not look anything up after a decline', async () => {
    // #given / #when
    const run = await launchRecoveryRun({updates: [DIRTY], quiescence: 'busy'})

    // #then
    expect(run.listBackups).not.toHaveBeenCalled()
  })
})

const UNANSWERED_LOOKUPS: readonly (readonly [string, () => ReturnType<typeof vi.fn>])[] = [
  ['finds no backup for this run', () => makeListBackupsFn()],
  [
    "finds only another run's backup",
    () =>
      vi.fn().mockResolvedValue({
        success: true,
        data: {
          kind: 'ok',
          totalBytes: 1,
          backups: [
            {
              id: 'gen-other',
              metadataOk: true,
              createdAt: '2026-01-01T00:00:00.000Z',
              sizeBytes: 1,
              sizeComplete: true,
              originalHeadSha: undefined,
              originalBranch: undefined,
              runId: 'another-run',
            },
          ],
        },
      }),
  ],
  ['fails with a timeout', () => vi.fn().mockResolvedValue({success: false, error: {kind: 'timeout'}})],
  ['reports a workspace-side failure', () => vi.fn().mockResolvedValue({success: true, data: {kind: 'failed'}})],
  ['throws', () => vi.fn().mockRejectedValue(new Error('boom'))],
]

describe('checkout preparation: an ambiguous recovery whose backup is not found or cannot be looked up', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(UNANSWERED_LOOKUPS)(
    'when the lookup %s, a ready update continues with the attempted note once and no id',
    async (_label, makeListing) => {
      // #given / #when
      const run = await launchRecoveryRun({
        updates: [DIRTY, readyResult()],
        recover: vi.fn().mockResolvedValue(TIMEOUT_RECOVER),
        listBackups: makeListing(),
      })

      // #then
      const answer = finalAnswer(run.request)
      expect(occurrences(answer, RECOVERY_ATTEMPTED_NOTE)).toBe(1)
      expect(answer).not.toContain(BACKUP_ID)
      expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
    },
  )

  it.each(UNANSWERED_LOOKUPS)(
    'when the lookup %s, a refusal carries the attempted note once',
    async (_label, makeListing) => {
      // #given / #when
      const run = await launchRecoveryRun({
        updates: [DIRTY, NEEDS_RECOVERY],
        recover: vi.fn().mockResolvedValue(TIMEOUT_RECOVER),
        listBackups: makeListing(),
      })

      // #then
      const reply = refusalReply(run.request)
      expect(occurrences(reply.content, RECOVERY_ATTEMPTED_NOTE)).toBe(1)
      expect(reply.components).toHaveLength(1)
    },
  )

  it.each(UNANSWERED_LOOKUPS)(
    'when the lookup %s, a follow-up timeout carries the attempted note once',
    async (_label, makeListing) => {
      // #given / #when
      const run = await launchRecoveryRun({
        updates: [DIRTY, {success: false, error: {kind: 'timeout'}}],
        recover: vi.fn().mockResolvedValue(TIMEOUT_RECOVER),
        listBackups: makeListing(),
      })

      // #then
      const reply = refusalReply(run.request)
      expect(reply.content).toContain(CLIENT_TIMEOUT_REPLY)
      expect(occurrences(reply.content, RECOVERY_ATTEMPTED_NOTE)).toBe(1)
    },
  )

  it.each(UNANSWERED_LOOKUPS)(
    'when the lookup %s, a thrown follow-up error carries the attempted note once',
    async (_label, makeListing) => {
      // #given / #when
      const run = await launchRecoveryRun({
        updates: [DIRTY, {success: false, error: {kind: 'network-error'}}],
        recover: vi.fn().mockResolvedValue(TIMEOUT_RECOVER),
        listBackups: makeListing(),
      })

      // #then
      expect(occurrences(failureText(run), RECOVERY_ATTEMPTED_NOTE)).toBe(1)
    },
  )

  it.each(UNANSWERED_LOOKUPS)(
    'when the lookup %s, checkout-substituted carries the attempted note once',
    async (_label, makeListing) => {
      // #given / #when
      const run = await launchRecoveryRun({
        updates: [DIRTY, {success: true, data: {kind: 'refused', reason: 'checkout-substituted'}}],
        recover: vi.fn().mockResolvedValue(TIMEOUT_RECOVER),
        listBackups: makeListing(),
      })

      // #then
      expect(occurrences(failureText(run), RECOVERY_ATTEMPTED_NOTE)).toBe(1)
    },
  )
})

describe('checkout preparation: a recovered checkout that the follow-up update reports as substituted', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps the backup note: the failure names the backup id exactly once, beside the substituted line', async () => {
    // #given the workspace confirmed the swap, then the fresh tree is not the expected repository
    // #when
    const run = await launchRecoveryRun({
      updates: [DIRTY, {success: true, data: {kind: 'refused', reason: 'checkout-substituted'}}],
    })

    // #then
    const text = failureText(run)
    expect(occurrences(text, DEFAULT_BACKUP_ID)).toBe(1)
    expect(text).toContain(`${OWNER}/${REPO}`)
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })

  it('a substituted checkout with no recovery involved carries no recovery note', async () => {
    // #given / #when
    const run = await launchRecoveryRun({
      updates: [{success: true, data: {kind: 'refused', reason: 'checkout-substituted'}}],
    })

    // #then
    const text = failureText(run)
    expect(text).not.toContain(DEFAULT_BACKUP_ID)
    expect(text).not.toContain(RECOVERY_ATTEMPTED_NOTE)
  })
})

// ---------------------------------------------------------------------------
// The lookup runs AFTER the follow-up update, and the note follows what that update observed.
// ---------------------------------------------------------------------------

const INSTALLED = 'and installed a fresh one'

describe('checkout preparation: the backup lookup runs after the follow-up update', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('finds a backup that only exists once the swap has finished, because the lookup waits for the follow-up update', async () => {
    // #given a swap that is still renaming while recover answers: the lock-free listing cannot see
    // the backup until the follow-up update (which queues behind the workspace mutex) has returned
    const state = {recovered: false, updateCalls: 0, runId: ''}
    const recover = vi.fn().mockImplementation(async (_o: string, _r: string, opts: {runId: string}) => {
      state.runId = opts.runId
      state.recovered = true
      return TIMEOUT_RECOVER
    })
    const update = updateSequence([DIRTY, readyResult()])
    const countingUpdate = vi.fn().mockImplementation(async (...args: unknown[]) => {
      state.updateCalls += 1
      return (update as (...a: unknown[]) => Promise<unknown>)(...args)
    })
    const listBackups = vi.fn().mockImplementation(async () => {
      const visible = state.recovered && state.updateCalls >= 2
      return {
        success: true as const,
        data: {
          kind: 'ok' as const,
          totalBytes: 1,
          backups: visible
            ? [
                {
                  id: BACKUP_ID,
                  metadataOk: true,
                  createdAt: '2026-01-01T00:00:00.000Z',
                  sizeBytes: 1,
                  sizeComplete: true,
                  originalHeadSha: undefined,
                  originalBranch: undefined,
                  runId: state.runId,
                },
              ]
            : [],
        },
      }
    })

    // #when
    const run = await launchRecoveryRun({updates: [], update: countingUpdate, recover, listBackups})

    // #then the id is named, so the lookup ran after the second update; and it ran exactly once
    expect(listBackups).toHaveBeenCalledOnce()
    const answer = finalAnswer(run.request)
    expect(occurrences(answer, BACKUP_ID)).toBe(1)
    expect(answer).not.toContain(RECOVERY_ATTEMPTED_NOTE)
  })

  it('makes no lookup before the follow-up update is called', async () => {
    // #given
    const order: string[] = []
    const update = updateSequence([DIRTY, readyResult()])
    const orderedUpdate = vi.fn().mockImplementation(async (...args: unknown[]) => {
      order.push('update')
      return (update as (...a: unknown[]) => Promise<unknown>)(...args)
    })
    const listBackups = vi.fn().mockImplementation(async () => {
      order.push('listBackups')
      return {success: true as const, data: {kind: 'ok' as const, backups: [], totalBytes: 0}}
    })

    // #when
    await launchRecoveryRun({
      updates: [],
      update: orderedUpdate,
      recover: vi.fn().mockResolvedValue(TIMEOUT_RECOVER),
      listBackups,
    })

    // #then
    expect(order).toEqual(['update', 'update', 'listBackups'])
  })
})

describe('checkout preparation: the recovery note matches the observed checkout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const FOUND = () => {
    const {recover, captured} = makeRunIdCapturingRecover(TIMEOUT_RECOVER)
    return {recover, listBackups: makeAttributedListing(captured)}
  }

  it('a known backup and a ready checkout claim the backup AND the install', async () => {
    const run = await launchRecoveryRun({updates: [DIRTY, readyResult()], ...FOUND()})
    const answer = finalAnswer(run.request)
    expect(answer).toContain(`preserved it as backup \`${BACKUP_ID}\``)
    expect(answer).toContain(INSTALLED)
  })

  it('a known backup and a fast-forwarded ready checkout claim the install too', async () => {
    const run = await launchRecoveryRun({updates: [DIRTY, readyResult('fast-forward')], ...FOUND()})
    expect(finalAnswer(run.request)).toContain(INSTALLED)
  })

  it.each([
    ['needs-recovery', NEEDS_RECOVERY],
    ['still dirty', DIRTY],
    [
      'a failed fetch',
      {success: true, data: {kind: 'failed', reason: 'fetch-timeout', mutationStarted: false, permanent: false}},
    ],
  ])('a known backup and %s claim the backup but NOT an install', async (_label, followUp) => {
    const run = await launchRecoveryRun({updates: [DIRTY, followUp], ...FOUND()})
    const reply = refusalReply(run.request)
    expect(reply.content).toContain(`preserved it as backup \`${BACKUP_ID}\``)
    expect(leadingNote(reply.content)).not.toMatch(/install/i)
    expect(reply.content).toContain('the state of the checkout is below')
  })

  it('a known backup and a follow-up timeout claim the backup but NOT an install', async () => {
    const run = await launchRecoveryRun({updates: [DIRTY, {success: false, error: {kind: 'timeout'}}], ...FOUND()})
    const reply = refusalReply(run.request)
    expect(reply.content).toContain(BACKUP_ID)
    expect(leadingNote(reply.content)).not.toMatch(/install/i)
  })

  it('a known backup and a thrown follow-up error claim the backup but NOT an install', async () => {
    const run = await launchRecoveryRun({
      updates: [DIRTY, {success: false, error: {kind: 'network-error'}}],
      ...FOUND(),
    })
    const text = failureText(run)
    expect(text).toContain(BACKUP_ID)
    expect(trailingNote(text)).not.toMatch(/install/i)
  })

  it('a known backup and a substituted checkout claim the backup but NOT an install', async () => {
    const run = await launchRecoveryRun({
      updates: [DIRTY, {success: true, data: {kind: 'refused', reason: 'checkout-substituted'}}],
      ...FOUND(),
    })
    const text = failureText(run)
    expect(text).toContain(BACKUP_ID)
    expect(trailingNote(text)).not.toMatch(/install/i)
  })

  it('a CONFIRMED recovery followed by a refusal also claims no install (the follow-up decides)', async () => {
    const run = await launchRecoveryRun({updates: [DIRTY, NEEDS_RECOVERY]})
    const reply = refusalReply(run.request)
    expect(reply.content).toContain(DEFAULT_BACKUP_ID)
    expect(leadingNote(reply.content)).not.toMatch(/install/i)
  })

  it('a CONFIRMED recovery followed by a ready checkout claims the install', async () => {
    const run = await launchRecoveryRun({updates: [DIRTY, readyResult()]})
    expect(finalAnswer(run.request)).toContain(INSTALLED)
  })

  it.each(UNANSWERED_LOOKUPS)(
    'when the lookup %s, the neutral note claims neither a backup nor an install, ready or not',
    async (_label, makeListing) => {
      // ready
      const ready = await launchRecoveryRun({
        updates: [DIRTY, readyResult()],
        recover: vi.fn().mockResolvedValue(TIMEOUT_RECOVER),
        listBackups: makeListing(),
      })
      const answer = finalAnswer(ready.request)
      expect(answer).toContain(RECOVERY_ATTEMPTED_NOTE)
      expect(answer).not.toContain(INSTALLED)
      expect(answer).not.toContain('preserved it as backup')
    },
  )
})

describe('checkout preparation: a follow-up update that rejects after a recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('still fails the run with the recovery note, so the operator can find the backup', async () => {
    // #given the second update rejects outright (not a Result)
    const update = vi.fn().mockResolvedValueOnce(DIRTY).mockRejectedValueOnce(new Error('socket exploded'))

    // #when
    const run = await launchRecoveryRun({updates: [], update})

    // #then the confirmed backup is still named, once, with no install claim
    const text = failureText(run)
    expect(occurrences(text, DEFAULT_BACKUP_ID)).toBe(1)
    expect(trailingNote(text)).not.toMatch(/install/i)
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })
})

describe('checkout preparation: rollback-failed on the automatic path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const ROLLBACK = {success: true, data: {kind: 'failed', reason: 'rollback-failed'}}
  const ROLLBACK_TEXT = formatRollbackFailedReply({flow: 'automatic'})

  it.each([
    ['needs-recovery', NEEDS_RECOVERY],
    ['still dirty', DIRTY],
    [
      'a failed fetch',
      {success: true, data: {kind: 'failed', reason: 'fetch-timeout', mutationStarted: false, permanent: false}},
    ],
    ['a follow-up timeout', {success: false, error: {kind: 'timeout'}}],
  ])(
    'followed by %s: replies with the cleanup text exactly once, no suffix, no button, no recovery note',
    async (_label, followUp) => {
      // #given
      const run = await launchRecoveryRun({
        updates: [DIRTY, followUp],
        recover: vi.fn().mockResolvedValue(ROLLBACK),
      })

      // #then the follow-up update still ran first
      expect(run.update).toHaveBeenCalledTimes(2)
      const reply = refusalReply(run.request)
      expect(occurrences(reply.content, ROLLBACK_TEXT)).toBe(1)
      expect(reply.content).toBe(ROLLBACK_TEXT)
      expect(reply.content).not.toContain(RECOVER_SUFFIX)
      expect(reply.components).toBeUndefined()
      expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
    },
  )

  it("persists the follow-up update's own refusal record, not a fabricated one", async () => {
    // #given / #when
    await launchRecoveryRun({updates: [DIRTY, NEEDS_RECOVERY], recover: vi.fn().mockResolvedValue(ROLLBACK)})

    // #then
    const failedCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'FAILED')
    const options = failedCall?.[7] as {detailsPatch?: {checkoutPreparation?: unknown}}
    expect(options?.detailsPatch?.checkoutPreparation).toEqual({outcome: 'refused', reason: 'needs-recovery'})
  })

  it('an unexpectedly ready follow-up update continues the run normally with the neutral note', async () => {
    // #given the cleanup somehow cleared
    const run = await launchRecoveryRun({updates: [DIRTY, readyResult()], recover: vi.fn().mockResolvedValue(ROLLBACK)})

    // #then
    expect(transitionPhases()).toContain('EXECUTING')
    expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
    const answer = finalAnswer(run.request)
    expect(occurrences(answer, RECOVERY_ATTEMPTED_NOTE)).toBe(1)
    expect(answer).not.toContain(ROLLBACK_TEXT)
  })

  it('ignores a backup the lookup claims for a rollback-failed run (none can exist before the quarantine) and stays neutral', async () => {
    // #given a lookup that, contrary to the workspace's guarantee, returns an entry for this run
    const {recover, captured} = makeRunIdCapturingRecover(ROLLBACK)

    // #when
    const run = await launchRecoveryRun({
      updates: [DIRTY, readyResult()],
      recover,
      listBackups: makeAttributedListing(captured),
    })

    // #then
    const answer = finalAnswer(run.request)
    expect(answer).toContain(RECOVERY_ATTEMPTED_NOTE)
    expect(answer).not.toContain(BACKUP_ID)
  })

  it('a thrown follow-up error keeps the neutral note rather than the cleanup text', async () => {
    const run = await launchRecoveryRun({
      updates: [DIRTY, {success: false, error: {kind: 'network-error'}}],
      recover: vi.fn().mockResolvedValue(ROLLBACK),
    })
    expect(occurrences(failureText(run), RECOVERY_ATTEMPTED_NOTE)).toBe(1)
  })

  it('a substituted checkout keeps its own failure, with the neutral note', async () => {
    const run = await launchRecoveryRun({
      updates: [DIRTY, {success: true, data: {kind: 'refused', reason: 'checkout-substituted'}}],
      recover: vi.fn().mockResolvedValue(ROLLBACK),
    })
    expect(occurrences(failureText(run), RECOVERY_ATTEMPTED_NOTE)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// The recovery token mint is bounded: a stalled GitHub call must not hold the lock past the bound.
// ---------------------------------------------------------------------------

describe('checkout preparation: a stalled installation-token mint during recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // The REAL `authForRepo` over a stalled GitHub, whose deadline fires 40 ms after the mint starts.
  const MINT_CEILING_MS = 40

  function stalledMintRecover() {
    installStalledGitHub()
    controllableDeadlines({fireAfterMs: MINT_CEILING_MS})
    const workspaceRecover = vi.fn().mockResolvedValue({success: true, data: {kind: 'no-checkout'}})
    const calls = createWorkspaceCalls({
      appClient: createRealAppClient(),
      workspaceClient: {update: vi.fn(), previewRecovery: vi.fn(), recover: workspaceRecover},
      logger: {warn: vi.fn()},
    })
    return {recover: vi.fn().mockImplementation(calls.recover), workspaceRecover}
  }

  it('ends in the usual dirty refusal within the bound, without ever sending /recover', async () => {
    // #given a mint that never answers
    const {recover, workspaceRecover} = stalledMintRecover()
    const started = Date.now()

    // #when
    const run = await launchRecoveryRun({updates: [DIRTY], recover})

    // #then today's refusal, with its Recover button, and no recovery note at all
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(workspaceRecover).not.toHaveBeenCalled()
    expect(run.update).toHaveBeenCalledTimes(1)
    expect(run.listBackups).not.toHaveBeenCalled()
    const reply = refusalReply(run.request)
    expect(reply.content).toContain(DIRTY_CLAUSE)
    expect(reply.content).not.toContain(RECOVERY_ATTEMPTED_NOTE)
    expect(reply.content).not.toContain(DEFAULT_BACKUP_ID)
    expect(reply.components).toHaveLength(1)
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })

  it('releases the repo lock exactly as any other refusal does', async () => {
    // #given
    const {recover} = stalledMintRecover()

    // #when
    await launchRecoveryRun({updates: [DIRTY], recover})

    // #then
    expect(mockRuntime.releaseLock).toHaveBeenCalledOnce()
    expect(transitionPhases()).toContain('FAILED')
    expect(transitionPhases()).not.toContain('EXECUTING')
  })

  it('persists the original dirty refusal as the checkoutPreparation record', async () => {
    // #given
    const {recover} = stalledMintRecover()

    // #when
    await launchRecoveryRun({updates: [DIRTY], recover})

    // #then
    const failedCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'FAILED')
    const options = failedCall?.[7] as {detailsPatch?: {checkoutPreparation?: unknown}}
    expect(options?.detailsPatch?.checkoutPreparation).toMatchObject({outcome: 'refused', reason: 'dirty'})
  })
})

// ---------------------------------------------------------------------------
// The first update's token mint is bounded: a stalled GitHub call must not hold the lock indefinitely.
// ---------------------------------------------------------------------------

describe('checkout preparation: a stalled installation-token mint before the first update', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // The REAL `authForRepo` over a stalled GitHub, whose deadline fires 40 ms after the mint starts.
  const MINT_CEILING_MS = 40

  function stalledMintUpdate() {
    installStalledGitHub()
    controllableDeadlines({fireAfterMs: MINT_CEILING_MS})
    const workspaceUpdate = vi.fn().mockResolvedValue({success: true, data: {kind: 'no-checkout'}})
    const calls = createWorkspaceCalls({
      appClient: createRealAppClient(),
      workspaceClient: {update: workspaceUpdate, previewRecovery: vi.fn(), recover: vi.fn()},
      logger: {warn: vi.fn()},
    })
    return {update: vi.fn().mockImplementation(calls.update), workspaceUpdate}
  }

  it('ends in the same outcome as any other retryable mint failure, within the bound, without sending /update', async () => {
    // #given a stalled mint, and the run a plain retryable mint failure produces as the baseline
    const {update, workspaceUpdate} = stalledMintUpdate()
    const baseline = await launchRecoveryRun({
      updates: [{success: false, error: {kind: 'network-error'}}],
    })
    const expected = failureText(baseline)
    vi.clearAllMocks()
    const started = Date.now()

    // #when
    const run = await launchRecoveryRun({updates: [], update})

    // #then
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(workspaceUpdate).not.toHaveBeenCalled()
    expect(failureText(run)).toBe(expected)
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })

  it('is not the state-unknown "update timed out" reply: no update request was ever sent', async () => {
    // #given
    const {update} = stalledMintUpdate()

    // #when
    const run = await launchRecoveryRun({updates: [], update})

    // #then
    expect(failureText(run)).not.toContain(CLIENT_TIMEOUT_REPLY)
    expect(run.request._replySink._sends.map((send: {content: string}) => send.content).join('\n')).not.toContain(
      CLIENT_TIMEOUT_REPLY,
    )
  })

  it('releases the repo lock and fails the run, as for any other mint failure', async () => {
    // #given
    const {update} = stalledMintUpdate()

    // #when
    await launchRecoveryRun({updates: [], update})

    // #then
    expect(mockRuntime.releaseLock).toHaveBeenCalledOnce()
    expect(transitionPhases()).toContain('FAILED')
    expect(transitionPhases()).not.toContain('EXECUTING')
  })
})
