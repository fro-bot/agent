import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {beforeEach, describe, expect, it, vi} from 'vitest'
/* eslint-disable perfectionist/sort-imports -- ./test-helpers.js must import before any real module
   it mocks, to register vi.mock() side effects before those modules are evaluated */
import {
  awaitLaunchWorkRun,
  buildMockRunState,
  CHANNEL_ID,
  makeBinding,
  makeDefaultQueue,
  makeDeps,
  makeEnsureCloneFn,
  makeInMemoryRequest,
  makeMessage,
  makeReadyzFn,
  makeThread,
  makeUpdateFn,
  mockRunOpenCodeCore,
  mockRuntime,
  OWNER,
  REPO,
  setupHappyPath,
  type runtimeModule,
} from './test-helpers.js'
import * as attachModule from './opencode-attach.js'
import * as promptModule from './prompt.js'
import {getInFlightRuns} from './run.js'
/* eslint-enable perfectionist/sort-imports */

/**
 * A `RunMentionDeps.update` mock for the "ensureClone succeeds" happy-path tests: the FIRST call
 * (before ensureClone) reports `no-checkout`, triggering ensureClone; the SECOND call (the retry
 * after ensureClone succeeds) reports `ready`, letting the run proceed to execution.
 */
function makeUpdateNoCheckoutThenReadyFn() {
  return vi
    .fn()
    .mockResolvedValueOnce({success: true as const, data: {kind: 'no-checkout' as const}})
    .mockResolvedValue({
      success: true as const,
      data: {
        kind: 'ready' as const,
        change: 'unchanged' as const,
        branch: 'main',
        sha: 'a'.repeat(40),
        checkedAt: '2026-01-01T00:00:00.000Z',
      },
    })
}

// ---------------------------------------------------------------------------
// Admission and gating — concurrency cap, per-channel in-flight guard,
// ensure-clone gate, readiness gate, lock acquisition, launchWork admission,
// early-abort gates, and the static seam guards / runIndex wiring around them.
// ---------------------------------------------------------------------------

describe('runMention', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── Global concurrency cap ───────────────────────────────────────────────

  describe('concurrency cap', () => {
    it('replies "at capacity" and returns early when global cap is reached', async () => {
      // #given
      const {runMention} = await import('./run.js')
      const deps = makeDeps({
        concurrency: {
          tryAcquire: vi.fn().mockReturnValue('cap'),
          release: vi.fn(),
          activeCount: vi.fn().mockReturnValue(3),
          max: 3,
        },
      })
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then
      expect(message.reply).toHaveBeenCalledOnce()
      const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        content: string
        allowedMentions: unknown
      }
      expect(call.content).toContain('capacity')
      expect(call.allowedMentions).toEqual({parse: []})
      // No thread created
      expect(message.startThread).not.toHaveBeenCalled()
    })

    it('does NOT release concurrency slot when cap was returned (slot was never acquired)', async () => {
      // #given
      const {runMention} = await import('./run.js')
      const releaseFn = vi.fn()
      const deps = makeDeps({
        concurrency: {
          tryAcquire: vi.fn().mockReturnValue('cap'),
          release: releaseFn,
          activeCount: vi.fn().mockReturnValue(3),
          max: 3,
        },
      })
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — slot was NOT acquired; release is not called
      expect(releaseFn).not.toHaveBeenCalled()
    })
  })

  // ── Per-channel in-flight guard ─────────────────────────────────────────

  describe('per-channel in-flight guard', () => {
    it('enqueues and sends queued ack when channel already has an active run (busy → queue)', async () => {
      // #given — channel is busy; queue has capacity
      // createRun is now called in launchWork for the queued path too (admission block).
      const {runMention} = await import('./run.js')
      mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'run-etag-v1'}})
      const enqueueFn = vi.fn().mockReturnValue('queued')
      const queue = makeDefaultQueue()
      ;(queue.enqueue as ReturnType<typeof vi.fn>).mockImplementation(enqueueFn)
      const deps = makeDeps({
        concurrency: {
          tryAcquire: vi.fn().mockReturnValue('busy'),
          release: vi.fn(),
          activeCount: vi.fn().mockReturnValue(1),
          max: 3,
        },
        queue,
      })
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — task enqueued
      expect(queue.enqueue).toHaveBeenCalledOnce()
      // #and — queued ack sent (not the old "already a task" reject)
      expect(message.reply).toHaveBeenCalledOnce()
      const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        content: string
        allowedMentions: unknown
      }
      expect(call.content).not.toContain('already a task')
      expect(call.content).toMatch(/queue/i)
      expect(call.allowedMentions).toEqual({parse: []})
      // #and — no thread created (not running immediately)
      expect(message.startThread).not.toHaveBeenCalled()
    })
  })

  // ── Ensure-clone gate (after concurrency AND lock/heartbeat, before EXECUTING) ──

  describe('ensure-clone gate', () => {
    it('happy path: ensure-clone succeeds → proceeds to thread creation and execution', async () => {
      // #given
      const {runMention} = await import('./run.js')
      setupHappyPath()
      const ensureClone = makeEnsureCloneFn('success')
      const deps = makeDeps({ensureClone, update: makeUpdateNoCheckoutThenReadyFn()})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — ensureClone was called (update reported no-checkout); execution proceeded
      expect(ensureClone).toHaveBeenCalledWith(OWNER, REPO)
      expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
    })

    it('ensure-clone failure (post-lock) → coarse reply in the thread, lock and slot released', async () => {
      // #given — ensureClone now runs AFTER thread creation and lock acquisition
      const {runMention} = await import('./run.js')
      setupHappyPath()
      const ensureClone = makeEnsureCloneFn('failure')
      const releaseFn = vi.fn()
      const deps = makeDeps({
        ensureClone,
        update: makeUpdateFn('no-checkout'),
        concurrency: {
          tryAcquire: vi.fn().mockReturnValue('ok'),
          release: releaseFn,
          activeCount: vi.fn().mockReturnValue(1),
          max: 3,
        },
      })
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — a thread WAS created (ensureClone runs after thread/lock now)
      expect(message.startThread).toHaveBeenCalledOnce()
      // #and — coarse reply sent in the thread, not the source message
      const thread = message._thread
      expect(thread.send).toHaveBeenCalledOnce()
      const call = (thread.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        content: string
        allowedMentions: unknown
      }
      expect(call.content).toContain('not reachable')
      expect(call.allowedMentions).toEqual({parse: []})
      // #and — lock was acquired then released (clone failure happens post-lock)
      expect(mockRuntime.acquireLock).toHaveBeenCalledOnce()
      expect(mockRuntime.releaseLock).toHaveBeenCalledOnce()
      // #and — concurrency slot released in finally
      expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)
    })

    it('ensure-clone failure does not expose internal details in reply', async () => {
      // #given
      const {runMention} = await import('./run.js')
      setupHappyPath()
      const ensureClone = vi.fn().mockResolvedValue({
        success: false as const,
        error: {kind: 'auth-failure' as const, reason: 'auth-error' as const},
      })
      const deps = makeDeps({ensureClone, update: makeUpdateFn('no-checkout')})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — no internal detail in the thread reply
      const thread = message._thread
      const call = (thread.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {content: string}
      expect(call.content).not.toContain('auth')
      expect(call.content).not.toContain('token')
      expect(call.content).not.toContain('clone')
    })

    it('ensure-clone is NOT called when concurrency cap is reached (storm guard)', async () => {
      // #given — concurrency cap fires before ensure-clone
      const {runMention} = await import('./run.js')
      const ensureClone = makeEnsureCloneFn('success')
      const deps = makeDeps({
        ensureClone,
        concurrency: {
          tryAcquire: vi.fn().mockReturnValue('cap'),
          release: vi.fn(),
          activeCount: vi.fn().mockReturnValue(3),
          max: 3,
        },
      })
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — cap reply sent; ensureClone never called
      expect(message.reply).toHaveBeenCalledOnce()
      const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {content: string}
      expect(call.content).toContain('capacity')
      expect(ensureClone).not.toHaveBeenCalled()
    })

    it('ensure-clone is NOT called when channel is busy (enqueued — storm guard)', async () => {
      // #given — busy enqueues; ensure-clone must not be called before the slot is held
      const {runMention} = await import('./run.js')
      const ensureClone = makeEnsureCloneFn('success')
      const deps = makeDeps({
        ensureClone,
        concurrency: {
          tryAcquire: vi.fn().mockReturnValue('busy'),
          release: vi.fn(),
          activeCount: vi.fn().mockReturnValue(1),
          max: 3,
        },
      })
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — queued ack sent; ensureClone never called
      expect(message.reply).toHaveBeenCalledOnce()
      const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {content: string}
      expect(call.content).toMatch(/queue/i)
      expect(ensureClone).not.toHaveBeenCalled()
    })

    it('runOpenCodeCore receives ensured path from ensureClone, not stale binding.workspacePath', async () => {
      // #given — binding has a stale workspacePath; ensureClone returns the canonical path
      const {runMention} = await import('./run.js')
      setupHappyPath()
      const canonicalPath = '/workspace/canonical/acme/widget'
      const ensureClone = vi.fn().mockResolvedValue({success: true as const, data: canonicalPath})
      const staleBinding = {...makeBinding(), workspacePath: '/old/stale/path'}
      const deps = makeDeps({ensureClone, update: makeUpdateNoCheckoutThenReadyFn()})
      const msg = makeMessage()

      // #when
      await runMention(msg, staleBinding, deps)

      // #then — runOpenCodeCore called with the canonical path
      expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
      const coreParams = mockRunOpenCodeCore.mock.calls[0]?.[0] as {directory?: string}
      expect(coreParams.directory).toBe(canonicalPath)
      expect(coreParams.directory).not.toBe('/old/stale/path')
    })
  })

  // ── Ensure-clone ordering (PR 1634 reorder: checkout prep runs under the repo lock) ──
  //
  // These pin the target order from the reorder brief:
  //   channel slot → readyz → thread creation → acquireLock → heartbeat → ensureClone → OpenCode
  // Each case is verified to fail against the OLD order (ensureClone before readyz/thread/lock).

  describe('ensure-clone ordering', () => {
    it('ensureClone runs AFTER acquireLock succeeds and AFTER heartbeat renewal starts — call order, not just call presence', async () => {
      // #given — track the actual invocation order of the three collaborators
      const {runMention} = await import('./run.js')
      const callOrder: string[] = []
      setupHappyPath({
        start: vi.fn(() => {
          callOrder.push('heartbeat.start')
        }),
      })
      mockRuntime.acquireLock.mockImplementation(async () => {
        callOrder.push('acquireLock')
        return {success: true as const, data: {acquired: true as const, etag: 'lock-etag-v1', holder: null}}
      })
      const ensureClone = vi.fn().mockImplementation(async () => {
        callOrder.push('ensureClone')
        return {success: true as const, data: '/workspace/acme/widget'}
      })
      let updateCalls = 0
      const update = vi.fn().mockImplementation(async () => {
        updateCalls += 1
        callOrder.push('update')
        if (updateCalls === 1) return {success: true as const, data: {kind: 'no-checkout' as const}}
        return {
          success: true as const,
          data: {
            kind: 'ready' as const,
            change: 'unchanged' as const,
            branch: 'main',
            sha: 'a'.repeat(40),
            checkedAt: '2026-01-01T00:00:00.000Z',
          },
        }
      })
      const deps = makeDeps({ensureClone, update})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — exact order: lock acquired, renewal started, THEN checkout prep
      expect(callOrder).toEqual(['acquireLock', 'heartbeat.start', 'update', 'ensureClone', 'update'])
    })

    it('a run that fails to acquire the lock never calls ensureClone', async () => {
      // #given — lock is held by another gateway
      const {runMention} = await import('./run.js')
      setupHappyPath()
      mockRuntime.acquireLock.mockResolvedValue({
        success: true as const,
        data: {acquired: false as const, etag: null, holder: {holder_id: 'other-gateway', etag: 'abc'} as unknown},
      } as Awaited<ReturnType<typeof runtimeModule.acquireLock>>)
      const ensureClone = makeEnsureCloneFn('success')
      const deps = makeDeps({ensureClone})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — ensureClone never called
      expect(ensureClone).not.toHaveBeenCalled()
    })

    it('a run whose lock acquisition errors (not just "held") never calls ensureClone', async () => {
      // #given — acquireLock returns a hard error (not a "held by another" result)
      const {runMention} = await import('./run.js')
      setupHappyPath()
      mockRuntime.acquireLock.mockResolvedValue({success: false as const, error: new Error('lock store unreachable')})
      const ensureClone = makeEnsureCloneFn('success')
      const deps = makeDeps({ensureClone})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — ensureClone never called
      expect(ensureClone).not.toHaveBeenCalled()
    })

    it('clone failure after lock acquisition stops the heartbeat and releases the lock with the CURRENT (post-heartbeat-stop) etag, not the original lock etag', async () => {
      // #given — heartbeat.stop() returns a fresh lockEtag that has advanced past the
      // original acquireLock etag (renewal ticked at least once). The release call must
      // use this fresh etag — reusing the stale original etag is the exact stale-etag
      // release bug this subsystem has shipped before (silent 412, orphaned lock).
      const {runMention} = await import('./run.js')
      const stopFn = vi.fn().mockResolvedValue({
        success: true,
        data: {
          runEtag: 'run-etag-after-heartbeat',
          lockEtag: 'lock-etag-after-heartbeat',
          runState: buildMockRunState(),
        },
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
      const ensureClone = makeEnsureCloneFn('failure')
      const message = makeMessage()
      const deps = makeDeps({ensureClone, update: makeUpdateFn('no-checkout')})

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — heartbeat stopped exactly once
      expect(stopFn).toHaveBeenCalledOnce()

      // #and — lock released with the fresh post-heartbeat-stop etag, not 'lock-etag-v1'
      expect(mockRuntime.releaseLock).toHaveBeenCalledOnce()
      const releaseCall = mockRuntime.releaseLock.mock.calls[0] as unknown[]
      expect(releaseCall[2]).toBe('lock-etag-after-heartbeat')

      // #and — run-state transitioned to FAILED (post-lock failure path)
      const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
      expect(transitionPhases).toContain('FAILED')

      // #and — the user is replied to in the thread that now exists
      const thread = message._thread
      expect(thread.send).toHaveBeenCalledOnce()
      const call = (thread.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {content: string}
      expect(call.content).toContain('not reachable')
    })

    it('launchWork: ensureClone runs AFTER acquireLock succeeds and AFTER heartbeat start — same order as runMention', async () => {
      // #given — the operator-web launch path (launchWork) shares executeWorkOnHeldSlot with
      // runMention, so it must exhibit the identical post-lock ordering.
      const {launchWork} = await import('./run.js')
      const callOrder: string[] = []
      setupHappyPath({
        start: vi.fn(() => {
          callOrder.push('heartbeat.start')
        }),
      })
      mockRuntime.acquireLock.mockImplementation(async () => {
        callOrder.push('acquireLock')
        return {success: true as const, data: {acquired: true as const, etag: 'lock-etag-v1', holder: null}}
      })
      const ensureClone = vi.fn().mockImplementation(async () => {
        callOrder.push('ensureClone')
        return {success: true as const, data: '/workspace/acme/widget'}
      })
      let updateCalls = 0
      const update = vi.fn().mockImplementation(async () => {
        updateCalls += 1
        callOrder.push('update')
        if (updateCalls === 1) return {success: true as const, data: {kind: 'no-checkout' as const}}
        return {
          success: true as const,
          data: {
            kind: 'ready' as const,
            change: 'unchanged' as const,
            branch: 'main',
            sha: 'a'.repeat(40),
            checkedAt: '2026-01-01T00:00:00.000Z',
          },
        }
      })
      const request = makeInMemoryRequest()
      const deps = makeDeps({ensureClone, update})

      // #when
      await awaitLaunchWorkRun(launchWork, request, deps)

      // #then — exact order matches the Discord adapter path
      expect(callOrder).toEqual(['acquireLock', 'heartbeat.start', 'update', 'ensureClone', 'update'])
    })
  })

  // ── Readiness gate (after concurrency, before thread/lock) ───────────
  describe('readiness gate', () => {
    it('happy path: readyz=ready → proceeds to thread creation and execution', async () => {
      // #given
      const {runMention} = await import('./run.js')
      setupHappyPath()
      const readyz = makeReadyzFn('ready')
      const deps = makeDeps({readyz})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — readyz called; execution proceeded
      expect(readyz).toHaveBeenCalledOnce()
      expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
    })

    it('readyz=not-ready → coarse reply, no thread created, concurrency slot released', async () => {
      // #given
      const {runMention} = await import('./run.js')
      const readyz = makeReadyzFn('not-ready')
      const releaseFn = vi.fn()
      const deps = makeDeps({
        readyz,
        concurrency: {
          tryAcquire: vi.fn().mockReturnValue('ok'),
          release: releaseFn,
          activeCount: vi.fn().mockReturnValue(1),
          max: 3,
        },
      })
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — coarse reply; no thread
      expect(message.reply).toHaveBeenCalledOnce()
      const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        content: string
        allowedMentions: unknown
      }
      expect(call.content).toContain('not reachable')
      expect(call.allowedMentions).toEqual({parse: []})
      expect(message.startThread).not.toHaveBeenCalled()
      expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)
    })

    it('readyz throws → fail-closed: coarse reply, no thread created', async () => {
      // #given
      const {runMention} = await import('./run.js')
      const readyz = makeReadyzFn('throws')
      const deps = makeDeps({readyz})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — thrown exception treated as not-ready (fail-closed)
      expect(message.reply).toHaveBeenCalledOnce()
      const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {content: string}
      expect(call.content).toContain('not reachable')
      expect(message.startThread).not.toHaveBeenCalled()
    })

    it('ensure-clone is NOT called when readyz fails', async () => {
      // #given — readyz is now the earlier gate; ensureClone must not run if it fails
      const {runMention} = await import('./run.js')
      const ensureClone = makeEnsureCloneFn('success')
      const readyz = makeReadyzFn('not-ready')
      const deps = makeDeps({ensureClone, readyz})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — readyz failed: ensureClone never called
      expect(ensureClone).not.toHaveBeenCalled()
    })

    it('readyz is NOT called when concurrency cap fires', async () => {
      // #given
      const {runMention} = await import('./run.js')
      const readyz = makeReadyzFn('ready')
      const deps = makeDeps({
        readyz,
        concurrency: {
          tryAcquire: vi.fn().mockReturnValue('cap'),
          release: vi.fn(),
          activeCount: vi.fn().mockReturnValue(3),
          max: 3,
        },
      })
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — cap fires before readyz
      expect(readyz).not.toHaveBeenCalled()
    })
  })

  // ── Lock acquisition ────────────────────────────────────────────────────

  describe('lock acquisition', () => {
    it('replies to thread "waiting" when lock is held by another — terminal, no queue', async () => {
      // #given
      const {runMention} = await import('./run.js')
      const thread = makeThread()
      const message = makeMessage(thread)
      const releaseFn = vi.fn()
      const deps = makeDeps({
        concurrency: {
          tryAcquire: vi.fn().mockReturnValue('ok'),
          release: releaseFn,
          activeCount: vi.fn().mockReturnValue(1),
          max: 3,
        },
      })

      mockRuntime.acquireLock.mockResolvedValue({
        success: true as const,
        data: {acquired: false as const, etag: null, holder: {holder_id: 'other-gateway', etag: 'abc'} as unknown},
      } as Awaited<ReturnType<typeof runtimeModule.acquireLock>>)

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — "waiting" sent to thread (coarse message, no holder ID)
      expect(thread.send).toHaveBeenCalledOnce()
      const call = thread.send.mock.calls[0]?.[0] as {content: string; allowedMentions: unknown}
      expect(call.allowedMentions).toEqual({parse: []})
      expect(call.content).toContain('in progress')
      // MUST NOT leak holder ID
      expect(call.content).not.toContain('other-gateway')
      // Concurrency slot released in finally
      expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)
    })

    it('replies coarse error to thread when acquireLock itself errors (no S3 detail)', async () => {
      // #given
      const {runMention} = await import('./run.js')
      const thread = makeThread()
      const message = makeMessage(thread)

      mockRuntime.acquireLock.mockResolvedValue({
        success: false as const,
        error: new Error('S3 timeout — internal'),
      })
      const deps = makeDeps()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — coarse reply, no S3 error detail
      expect(thread.send).toHaveBeenCalledOnce()
      const call = thread.send.mock.calls[0]?.[0] as {content: string; allowedMentions: unknown}
      expect(call.allowedMentions).toEqual({parse: []})
      expect(call.content).not.toContain('S3')
      expect(call.content).not.toContain('internal')
    })
  })
})

// ---------------------------------------------------------------------------
// Static seam guards on the module surface
// ---------------------------------------------------------------------------

describe('seam invariants (static guards)', () => {
  it('executeWorkOnHeldSlot is NOT exported from run.ts — callers must use launchWork', async () => {
    // #given — import the run module
    const runModule = await import('./run.js')

    // #then — the private execution primitive must not be exported
    expect(Object.keys(runModule)).not.toContain('executeWorkOnHeldSlot')
  })

  it('launchWork IS exported from run.ts — it is the single public front door', async () => {
    // #given — import the run module
    const runModule = await import('./run.js')

    // #then — the public front door must be exported
    expect(typeof runModule.launchWork).toBe('function')
  })

  it('runMention IS exported from run.ts — it is the Discord adapter entry point', async () => {
    // #given — import the run module
    const runModule = await import('./run.js')

    // #then — the Discord adapter must be exported
    expect(typeof runModule.runMention).toBe('function')
  })

  it('run.ts source does not export executeWorkOnHeldSlot (static source scan)', () => {
    // #given — read the source file directly (catches re-export patterns the module check misses)
    const runSrcPath = join(__dirname, 'run.ts')
    const content = readFileSync(runSrcPath, 'utf8')

    // #then — no export keyword precedes executeWorkOnHeldSlot
    // Matches: "export function executeWorkOnHeldSlot", "export async function executeWorkOnHeldSlot",
    // "export { executeWorkOnHeldSlot", "export {executeWorkOnHeldSlot"
    const exportPattern = /export\s+(?:async\s+)?function\s+executeWorkOnHeldSlot|export\s*\{[^}]*executeWorkOnHeldSlot/
    expect(exportPattern.test(content)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// FIX 5: runIndex.register() wiring test
// ---------------------------------------------------------------------------

describe('runIndex.register() wiring (FIX 5)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('createRun → runIndex.register() called with correct repo (entity_ref), surface, and startedAt', async () => {
    // #given — a mock runIndex with a spy on register()
    const {runMention} = await import('./run.js')
    setupHappyPath()

    const registerFn = vi.fn()
    const runIndex = {
      register: registerFn,
      lookup: vi.fn().mockResolvedValue(undefined),
      listRunsForRepo: vi.fn().mockResolvedValue([]),
    }

    const deps = makeDeps({runIndex})
    const message = makeMessage()

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — register was called once
    expect(registerFn).toHaveBeenCalledOnce()

    // #and — called with the correct runId (any string), repo, surface, and startedAt
    const [calledRunId, calledEntry] = registerFn.mock.calls[0] as [
      string,
      {repo: string; surface: string; startedAt: string},
    ]
    expect(typeof calledRunId).toBe('string')
    expect(calledRunId.length).toBeGreaterThan(0)
    // repo must be the entity_ref: owner/repo
    expect(calledEntry.repo).toBe(`${OWNER}/${REPO}`)
    // surface must be 'discord' (the default surface in makeMinimalRequest)
    expect(calledEntry.surface).toBe('discord')
    // startedAt must be a non-empty ISO string
    expect(typeof calledEntry.startedAt).toBe('string')
    expect(calledEntry.startedAt.length).toBeGreaterThan(0)
  })

  it('register() failure is fail-closed: run terminalized to FAILED, admission rejects', async () => {
    // #given — runIndex.register() throws
    // Per the fail-closed admission block: register throwing after createRun succeeds
    // must terminalize the run to FAILED (no orphan PENDING) and reject admission.
    const {runMention} = await import('./run.js')
    setupHappyPath()

    const registerFn = vi.fn(() => {
      throw new Error('index register failed')
    })
    const runIndex = {
      register: registerFn,
      lookup: vi.fn().mockResolvedValue(undefined),
      listRunsForRepo: vi.fn().mockResolvedValue([]),
    }

    const deps = makeDeps({runIndex})
    const message = makeMessage()

    // #when — launchWork throws (admission rejected); runMention propagates the throw
    await expect(runMention(message, makeBinding(), deps)).rejects.toThrow('index register failed')

    // #then — register was called
    expect(registerFn).toHaveBeenCalledOnce()
    // #and — run was terminalized to FAILED (transitionRun FAILED called)
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')
    // #and — runOpenCodeCore was NOT called (run was rejected before execution)
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })

  it('runIndex is optional — omitting it does not break run execution', async () => {
    // #given — no runIndex in deps
    const {runMention} = await import('./run.js')
    setupHappyPath()

    const deps = makeDeps({runIndex: undefined})
    const message = makeMessage()

    // #when — should not throw
    await runMention(message, makeBinding(), deps)

    // #then — execution completed normally
    expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
  })
})

describe('launchWork admission', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── Happy path (immediate) ─────────────────────────────────────────────────

  it('immediate: launchWork returns {accepted:true, runId} BEFORE the run completes', async () => {
    // #given — a hanging executeWorkOnHeldSlot mock (run never completes)
    // This proves launchWork returns admission early, not after the run.
    const {launchWork} = await import('./run.js')
    setupHappyPath()

    // Make runOpenCodeCore hang indefinitely
    let resolveRun: (() => void) | undefined
    mockRunOpenCodeCore.mockImplementation(
      async () =>
        new Promise<void>(resolve => {
          resolveRun = resolve
        }),
    )

    const request = makeInMemoryRequest()
    const deps = makeDeps()

    // #when — launchWork returns admission early (before run completes)
    const admissionPromise = launchWork(request, deps)
    const admission = await admissionPromise

    // #then — admission returned before run completed
    expect(admission).toMatchObject({accepted: true, runId: expect.any(String) as unknown})
    // runPromise is present for the immediate path
    expect(admission.accepted === true ? admission.runPromise : undefined).toBeDefined()

    // Yield to the event loop so executeWorkOnHeldSlot can start
    await new Promise(resolve => setTimeout(resolve, 0))

    // #and — runOpenCodeCore was called (run started, even though launchWork returned early)
    expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()

    // Resolve the hanging run so the test can clean up
    resolveRun?.()
    await (admission.accepted === true ? admission.runPromise : Promise.resolve())
  })

  // ── R8/ownership: immediate run completes after launchWork returns ──────────

  it('r8/ownership: immediate run completes and posts output after launchWork returns admission early', async () => {
    // #given — a run that completes after a delay
    // This proves the gateway in-flight set keeps the run alive after launchWork returns.
    const {launchWork} = await import('./run.js')
    setupHappyPath()

    const request = makeInMemoryRequest()
    const deps = makeDeps()

    // #when — launchWork returns admission early
    const admission = await launchWork(request, deps)

    // #then — admission returned
    expect(admission.accepted).toBe(true)

    // #and — await the run promise to verify the run completes
    await (admission.accepted === true ? admission.runPromise : Promise.resolve())

    // #and — run completed (COMPLETED transition)
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('COMPLETED')

    // #and — output was posted (flush called)
    expect(request._replySink.flush).toHaveBeenCalled()
  })

  // ── R8/ownership: shutdown drains in-flight immediate run ──────────────────

  it('r8/ownership: getInFlightRuns() exposes the in-flight set; runPromise awaits the run', async () => {
    // #given — a run that completes normally
    const {launchWork} = await import('./run.js')
    setupHappyPath()

    const request = makeInMemoryRequest()
    const deps = makeDeps()

    // #when — launchWork returns admission early
    const admission = await launchWork(request, deps)
    expect(admission.accepted).toBe(true)

    // #then — the runPromise is present (immediate path)
    expect(admission.accepted === true ? admission.runPromise : undefined).toBeDefined()

    // Await the runPromise directly (the caller's way to await the run)
    await (admission.accepted === true ? admission.runPromise : Promise.resolve())

    // #and — run completed (COMPLETED transition)
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('COMPLETED')

    // #and — in-flight set is now empty (run completed and was removed)
    expect(getInFlightRuns().size).toBe(0)
  })

  // ── Happy path (queued) ────────────────────────────────────────────────────

  it('queued: launchWork creates PENDING, returns {accepted:true, runId}, enqueues task with runId+adoptionEtag', async () => {
    // #given — channel is busy; queue has capacity
    const {launchWork} = await import('./run.js')
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'run-etag-queued'}})

    const queue = makeDefaultQueue()
    const request = makeInMemoryRequest()
    const deps = makeDeps({
      concurrency: {
        tryAcquire: vi.fn().mockReturnValue('busy'),
        release: vi.fn(),
        activeCount: vi.fn().mockReturnValue(1),
        max: 3,
      },
      queue,
    })

    // #when
    const admission = await launchWork(request, deps)

    // #then — admission accepted
    expect(admission).toMatchObject({accepted: true, runId: expect.any(String) as unknown})
    // No runPromise for queued path
    expect(admission.accepted === true ? admission.runPromise : 'not-accepted').toBeUndefined()

    // #and — createRun was called (PENDING created)
    expect(mockRuntime.createRun).toHaveBeenCalledOnce()

    // #and — task enqueued with runId and adoptionEtag
    expect(queue.enqueue).toHaveBeenCalledOnce()
    const enqueuedTask = (queue.enqueue as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as {
      runId: string
      adoptionEtag: string
    }
    expect(typeof enqueuedTask.runId).toBe('string')
    expect(enqueuedTask.runId.length).toBeGreaterThan(0)
    expect(enqueuedTask.adoptionEtag).toBe('run-etag-queued')
  })

  // ── Edge (cap) ─────────────────────────────────────────────────────────────

  it('cap: returns {accepted:false,"cap"} and does NOT call createRun', async () => {
    // #given — global cap reached
    const {launchWork} = await import('./run.js')

    const request = makeInMemoryRequest()
    const deps = makeDeps({
      concurrency: {
        tryAcquire: vi.fn().mockReturnValue('cap'),
        release: vi.fn(),
        activeCount: vi.fn().mockReturnValue(3),
        max: 3,
      },
    })

    // #when
    const admission = await launchWork(request, deps)

    // #then — admission rejected with 'cap'
    expect(admission).toMatchObject({accepted: false, reason: 'cap'})

    // #and — createRun NOT called (no admission for cap)
    expect(mockRuntime.createRun).not.toHaveBeenCalled()
  })

  // ── Edge (empty prompt) ────────────────────────────────────────────────────

  it('empty-prompt: returns {accepted:false,"empty-prompt"} before any admission', async () => {
    // #given — empty prompt
    const {launchWork} = await import('./run.js')

    const request = makeInMemoryRequest({promptText: '   '})
    const deps = makeDeps()

    // #when
    const admission = await launchWork(request, deps)

    // #then — admission rejected with 'empty-prompt'
    expect(admission).toMatchObject({accepted: false, reason: 'empty-prompt'})

    // #and — createRun NOT called (no admission for empty prompt)
    expect(mockRuntime.createRun).not.toHaveBeenCalled()
    // #and — tryAcquire NOT called (empty prompt guard fires first)
    // (concurrency is not consulted before the empty-prompt check)
  })

  // ── Fail-closed: register throws after createRun ───────────────────────────

  it('fail-closed: runIndex.register throws after createRun → run terminalized to FAILED, admission rejects', async () => {
    // #given — register throws after createRun succeeds
    const {launchWork} = await import('./run.js')
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'run-etag-v1'}})
    // transitionRun mock for the FAILED terminalization
    mockRuntime.transitionRun.mockResolvedValue({
      success: true as const,
      data: {etag: 'fail-etag', state: buildMockRunState({phase: 'FAILED'})},
    })

    const registerFn = vi.fn(() => {
      throw new Error('register failed')
    })
    const runIndex = {
      register: registerFn,
      lookup: vi.fn().mockResolvedValue(undefined),
      listRunsForRepo: vi.fn().mockResolvedValue([]),
    }

    const request = makeInMemoryRequest()
    const deps = makeDeps({runIndex})

    // #when — launchWork throws (admission rejected)
    await expect(launchWork(request, deps)).rejects.toThrow('register failed')

    // #then — createRun was called (admission started)
    expect(mockRuntime.createRun).toHaveBeenCalledOnce()

    // #and — run terminalized to FAILED (no orphan PENDING)
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')

    // #and — runOpenCodeCore NOT called (run was rejected before execution)
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })

  // ── Exactly ONE createRun per run ──────────────────────────────────────────

  it('exactly one createRun per run with PENDING initial state', async () => {
    // #given — happy path
    const {launchWork} = await import('./run.js')
    setupHappyPath()

    const request = makeInMemoryRequest()
    const deps = makeDeps()

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — createRun called exactly once
    expect(mockRuntime.createRun).toHaveBeenCalledOnce()

    // #and — the initial run state has phase PENDING
    const createRunCall = mockRuntime.createRun.mock.calls[0] as unknown[]
    const initialState = createRunCall[3] as {phase?: string}
    expect(initialState.phase).toBe('PENDING')
  })

  // ── Observer sees PENDING before ACKNOWLEDGED ──────────────────────────────

  it('observer sees PENDING before ACKNOWLEDGED for an immediate run', async () => {
    // #given — observer that records phases in order
    const {launchWork} = await import('./run.js')

    const ackState = buildMockRunState({phase: 'ACKNOWLEDGED'})
    const execState = buildMockRunState({phase: 'EXECUTING'})
    const completedState = buildMockRunState({phase: 'COMPLETED'})

    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'run-etag-v1'}})
    mockRuntime.acquireLock.mockResolvedValue({
      success: true as const,
      data: {acquired: true as const, etag: 'lock-etag-v1', holder: null},
    })
    mockRuntime.releaseLock.mockResolvedValue({success: true as const, data: undefined})
    mockRuntime.transitionRun
      .mockResolvedValueOnce({success: true as const, data: {etag: 'ack-etag', state: ackState}})
      .mockResolvedValueOnce({success: true as const, data: {etag: 'exec-etag', state: execState}})
      .mockResolvedValueOnce({success: true as const, data: {etag: 'done-etag', state: completedState}})
    mockRuntime.createHeartbeatController.mockReturnValue({
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue({
        success: true,
        data: {runEtag: 'r-etag', lockEtag: 'l-etag', runState: completedState},
      }),
      isRunning: false,
    })
    mockRunOpenCodeCore.mockResolvedValue(undefined)
    vi.mocked(attachModule.attachOpencode).mockReturnValue({
      server: {url: 'http://workspace:9200'},
      session: {create: vi.fn(), prompt: vi.fn()},
    } as unknown as ReturnType<typeof attachModule.attachOpencode>)
    vi.mocked(promptModule.buildDiscordPrompt).mockReturnValue('Repository: acme/widget\n\ndo the thing')

    const observeFn = vi.fn().mockResolvedValue(undefined)
    const runObserver = {observe: observeFn}
    const request = makeInMemoryRequest()
    const deps = makeDeps({runObserver})

    // #when — await the run promise so the run completes before asserting
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — observer called with PENDING first, then ACKNOWLEDGED, EXECUTING, COMPLETED
    expect(observeFn).toHaveBeenCalledTimes(4)
    const phases = observeFn.mock.calls.map((c: unknown[]) => (c[0] as {phase?: string}).phase)
    expect(phases[0]).toBe('PENDING')
    expect(phases[1]).toBe('ACKNOWLEDGED')
    expect(phases[2]).toBe('EXECUTING')
    expect(phases[3]).toBe('COMPLETED')
  })

  // ── LaunchAdmission type: accepted path carries runId ─────────────────────

  it('launchWork returns {accepted:true, runId} for immediate path', async () => {
    // #given
    const {launchWork} = await import('./run.js')
    setupHappyPath()

    const request = makeInMemoryRequest()
    const deps = makeDeps()

    // #when
    const admission = await launchWork(request, deps)

    // #then
    expect(admission).toMatchObject({accepted: true, runId: expect.any(String) as unknown})

    // Drain the run
    await (admission.accepted === true ? admission.runPromise : Promise.resolve())
  })

  // ── runId from request.runId is honored ────────────────────────────────────

  it('launchWork uses request.runId when provided (non-empty)', async () => {
    // #given — caller provides a specific runId
    const {launchWork} = await import('./run.js')
    setupHappyPath()

    const CALLER_RUN_ID = 'caller-provided-run-id-abc123'
    const request = makeInMemoryRequest()
    const requestWithRunId = {...request, runId: CALLER_RUN_ID}
    const deps = makeDeps()

    // #when
    const admission = await launchWork(requestWithRunId, deps)

    // #then — admission uses the caller-provided runId
    expect(admission).toMatchObject({accepted: true, runId: CALLER_RUN_ID})

    // Drain the run
    await (admission.accepted === true ? admission.runPromise : Promise.resolve())
  })

  // ── Empty string runId falls back to UUID ─────────────────────────────────

  it('launchWork generates a UUID when request.runId is empty string', async () => {
    // #given — caller provides an empty string runId (should be treated as absent)
    const {launchWork} = await import('./run.js')
    setupHappyPath()

    const request = makeInMemoryRequest()
    const requestWithEmptyRunId = {...request, runId: ''}
    const deps = makeDeps()

    // #when
    const admission = await launchWork(requestWithEmptyRunId, deps)

    // #then — admission generates a UUID (not empty string)
    expect(admission).toMatchObject({accepted: true, runId: expect.any(String) as unknown})
    expect(admission.accepted === true ? admission.runId : '').not.toBe('')

    // Drain the run
    await (admission.accepted === true ? admission.runPromise : Promise.resolve())
  })
})

describe('early-abort gates terminalize to FAILED', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── ensureClone fail (post-lock) ────────────────────────────────────────────

  it('ensureClone fail (post-lock): run terminalized to FAILED via the ACKNOWLEDGED\u2192FAILED path, lock released, no orphan PENDING', async () => {
    // #given — ensureClone now runs AFTER the lock is acquired and ACK commits, so a
    // failure here reaches ACKNOWLEDGED (unlike the readyz/thread/lock gates below, which
    // still fire pre-ACK). It must route through the same post-lock failure machinery as
    // any other execution failure (heartbeat stop, FAILED transition, lock release, reply).
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'adoption-etag-1'}})
    // One-shot stubs: ACK returns ACKNOWLEDGED state, the terminal call returns FAILED state —
    // setupHappyPath's blanket mockResolvedValue would otherwise report every transition
    // (including the ACK) as phase FAILED to the observer.
    mockRuntime.transitionRun
      .mockResolvedValueOnce({
        success: true as const,
        data: {etag: 'ack-etag', state: buildMockRunState({phase: 'ACKNOWLEDGED'})},
      })
      .mockResolvedValueOnce({
        success: true as const,
        data: {etag: 'fail-etag', state: buildMockRunState({phase: 'FAILED'})},
      })

    const ensureClone = makeEnsureCloneFn('failure')
    const observeFn = vi.fn().mockResolvedValue(undefined)
    const request = makeInMemoryRequest()
    const deps = makeDeps({ensureClone, update: makeUpdateFn('no-checkout'), runObserver: {observe: observeFn}})

    // #when — await the run promise so executeWorkOnHeldSlot completes
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — run terminalized to FAILED (no orphan PENDING)
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')
    // ACKNOWLEDGED WAS reached (ensureClone now fails after ACK, unlike the pre-ACK gates)
    expect(transitionPhases).toContain('ACKNOWLEDGED')
    // EXECUTING was NOT reached (ensureClone fires before the EXECUTING transition)
    expect(transitionPhases).not.toContain('EXECUTING')

    // #and — observer notified of FAILED state
    const observedPhases = observeFn.mock.calls.map((c: unknown[]) => (c[0] as {phase?: string}).phase)
    expect(observedPhases).toContain('FAILED')

    // #and — lock acquired then released via the generic post-lock failure path
    expect(mockRuntime.acquireLock).toHaveBeenCalledOnce()
    expect(mockRuntime.releaseLock).toHaveBeenCalledOnce()

    // #and — coarse reply reuses the existing "unreachable" post-lock failure message
    const sends = request._replySink._sends
    const errorSend = sends.find(s => s.content.includes('not reachable'))
    expect(errorSend).toBeDefined()

    // #and — runOpenCodeCore NOT called (clone fails before OpenCode starts)
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })

  // ── Gate 2: readyz not-ready ───────────────────────────────────────────────

  it('gate 2 (readyz not-ready): run terminalized to FAILED, same reply text, no orphan PENDING', async () => {
    // #given — readyz returns not-ready; run was admitted (PENDING) by launchWork
    const {launchWork} = await import('./run.js')
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'adoption-etag-2'}})
    mockRuntime.transitionRun.mockResolvedValue({
      success: true as const,
      data: {etag: 'fail-etag', state: buildMockRunState({phase: 'FAILED'})},
    })

    const readyz = makeReadyzFn('not-ready')
    const observeFn = vi.fn().mockResolvedValue(undefined)
    const request = makeInMemoryRequest()
    const deps = makeDeps({readyz, runObserver: {observe: observeFn}})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — run terminalized to FAILED
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')
    expect(transitionPhases).not.toContain('ACKNOWLEDGED')

    // #and — observer notified of FAILED
    const observedPhases = observeFn.mock.calls.map((c: unknown[]) => (c[0] as {phase?: string}).phase)
    expect(observedPhases).toContain('FAILED')

    // #and — same reply text as before
    const sends = request._replySink._sends
    const errorSend = sends.find(s => s.content.includes('not reachable'))
    expect(errorSend).toBeDefined()

    // #and — runOpenCodeCore NOT called
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })

  // ── Gate 3a: threadFactory throws ─────────────────────────────────────────

  it('gate 3a (threadFactory throws): run terminalized to FAILED, same reply text, no orphan PENDING', async () => {
    // #given — threadFactory throws; run was admitted (PENDING) by launchWork
    const {launchWork} = await import('./run.js')
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'adoption-etag-3a'}})
    mockRuntime.transitionRun.mockResolvedValue({
      success: true as const,
      data: {etag: 'fail-etag', state: buildMockRunState({phase: 'FAILED'})},
    })

    const observeFn = vi.fn().mockResolvedValue(undefined)
    const request = makeInMemoryRequest({
      // threadFactory that throws
    })
    const threadFactory = vi.fn().mockRejectedValue(new Error('Discord API error'))
    const requestWithFactory = {...request, threadFactory}
    const deps = makeDeps({runObserver: {observe: observeFn}})

    // #when
    await awaitLaunchWorkRun(launchWork, requestWithFactory, deps)

    // #then — run terminalized to FAILED
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')
    expect(transitionPhases).not.toContain('ACKNOWLEDGED')

    // #and — observer notified of FAILED
    const observedPhases = observeFn.mock.calls.map((c: unknown[]) => (c[0] as {phase?: string}).phase)
    expect(observedPhases).toContain('FAILED')

    // #and — same reply text as before
    const sends = request._replySink._sends
    const errorSend = sends.find(s => s.content.includes('Could not start'))
    expect(errorSend).toBeDefined()

    // #and — acquireLock NOT called (threadFactory failed before lock)
    expect(mockRuntime.acquireLock).not.toHaveBeenCalled()
  })

  // ── Gate 3b: threadFactory ok:false ───────────────────────────────────────

  it('gate 3b (threadFactory ok:false): run terminalized to FAILED, same reply text, no orphan PENDING', async () => {
    // #given — threadFactory returns {ok:false}; run was admitted (PENDING) by launchWork
    const {launchWork} = await import('./run.js')
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'adoption-etag-3b'}})
    mockRuntime.transitionRun.mockResolvedValue({
      success: true as const,
      data: {etag: 'fail-etag', state: buildMockRunState({phase: 'FAILED'})},
    })

    const observeFn = vi.fn().mockResolvedValue(undefined)
    const request = makeInMemoryRequest()
    const threadFactory = vi.fn().mockResolvedValue({ok: false as const, error: 'thread creation failed'})
    const requestWithFactory = {...request, threadFactory}
    const deps = makeDeps({runObserver: {observe: observeFn}})

    // #when
    await awaitLaunchWorkRun(launchWork, requestWithFactory, deps)

    // #then — run terminalized to FAILED
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')
    expect(transitionPhases).not.toContain('ACKNOWLEDGED')

    // #and — observer notified of FAILED
    const observedPhases = observeFn.mock.calls.map((c: unknown[]) => (c[0] as {phase?: string}).phase)
    expect(observedPhases).toContain('FAILED')

    // #and — same reply text as before
    const sends = request._replySink._sends
    const errorSend = sends.find(s => s.content.includes('Could not start'))
    expect(errorSend).toBeDefined()

    // #and — acquireLock NOT called
    expect(mockRuntime.acquireLock).not.toHaveBeenCalled()
  })

  // ── thread_id persistence at ACK (bug fix) ────────────────────────────────

  it('persists the live thread_id to run-state at PENDING → ACKNOWLEDGED when threadFactory succeeds', async () => {
    // #given — a discord run with a threadFactory that resolves a real thread id
    const {launchWork} = await import('./run.js')
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'adoption-etag-thread'}})
    setupHappyPath()

    const request = makeInMemoryRequest()
    const threadFactory = vi.fn().mockResolvedValue({ok: true as const, threadId: 'live-thread-999'})
    const requestWithFactory = {...request, threadFactory}
    const deps = makeDeps()

    // #when
    await awaitLaunchWorkRun(launchWork, requestWithFactory, deps)

    // #then — the ACKNOWLEDGED transitionRun call carries the live thread id in the options bag
    const ackCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'ACKNOWLEDGED')
    expect(ackCall).toBeDefined()
    expect((ackCall as unknown[])[7]).toEqual({threadId: 'live-thread-999'})
  })

  it('leaves thread_id empty at ACK when there is no threadFactory (non-discord/no-thread path)', async () => {
    // #given — a run with no threadFactory (e.g. in-memory/no-thread transport)
    const {launchWork} = await import('./run.js')
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'adoption-etag-nothread'}})
    setupHappyPath()

    const request = makeInMemoryRequest()
    const deps = makeDeps()

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — the ACKNOWLEDGED transitionRun call passes {threadId: ''} (no-op in transitionRun)
    const ackCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'ACKNOWLEDGED')
    expect(ackCall).toBeDefined()
    expect((ackCall as unknown[])[7]).toEqual({threadId: ''})
  })

  // ── Gate 4a: lock acquisition error ───────────────────────────────────────

  it('gate 4a (lock acquisition error): run terminalized to FAILED, same reply text, no orphan PENDING', async () => {
    // #given — acquireLock returns success:false; run was admitted (PENDING) by launchWork
    const {launchWork} = await import('./run.js')
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'adoption-etag-4a'}})
    mockRuntime.acquireLock.mockResolvedValue({
      success: false as const,
      error: new Error('S3 timeout'),
    })
    mockRuntime.transitionRun.mockResolvedValue({
      success: true as const,
      data: {etag: 'fail-etag', state: buildMockRunState({phase: 'FAILED'})},
    })

    const observeFn = vi.fn().mockResolvedValue(undefined)
    const request = makeInMemoryRequest()
    const deps = makeDeps({runObserver: {observe: observeFn}})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — run terminalized to FAILED
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')
    expect(transitionPhases).not.toContain('ACKNOWLEDGED')

    // #and — observer notified of FAILED
    const observedPhases = observeFn.mock.calls.map((c: unknown[]) => (c[0] as {phase?: string}).phase)
    expect(observedPhases).toContain('FAILED')

    // #and — same reply text as before (coarse error, no S3 detail)
    const sends = request._replySink._sends
    const errorSend = sends.find(s => s.content.includes('Could not start'))
    expect(errorSend).toBeDefined()
    // No S3 detail leaked
    expect(sends.every(s => !s.content.includes('S3'))).toBe(true)

    // #and — runOpenCodeCore NOT called
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })

  // ── Gate 4b: lock not acquired (held by another) ───────────────────────────

  it('gate 4b (lock not acquired): run terminalized to FAILED, same reply text, no orphan PENDING', async () => {
    // #given — acquireLock returns acquired:false; run was admitted (PENDING) by launchWork
    const {launchWork} = await import('./run.js')
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'adoption-etag-4b'}})
    mockRuntime.acquireLock.mockResolvedValue({
      success: true as const,
      data: {acquired: false as const, etag: null, holder: {holder_id: 'other-gateway', etag: 'abc'} as unknown},
    } as Awaited<ReturnType<typeof runtimeModule.acquireLock>>)
    mockRuntime.transitionRun.mockResolvedValue({
      success: true as const,
      data: {etag: 'fail-etag', state: buildMockRunState({phase: 'FAILED'})},
    })

    const observeFn = vi.fn().mockResolvedValue(undefined)
    const request = makeInMemoryRequest()
    const deps = makeDeps({runObserver: {observe: observeFn}})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — run terminalized to FAILED
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')
    expect(transitionPhases).not.toContain('ACKNOWLEDGED')

    // #and — observer notified of FAILED
    const observedPhases = observeFn.mock.calls.map((c: unknown[]) => (c[0] as {phase?: string}).phase)
    expect(observedPhases).toContain('FAILED')

    // #and — same reply text as before ("in progress")
    const sends = request._replySink._sends
    const errorSend = sends.find(s => s.content.includes('in progress'))
    expect(errorSend).toBeDefined()
    // Holder ID NOT leaked
    expect(sends.every(s => !s.content.includes('other-gateway'))).toBe(true)

    // #and — runOpenCodeCore NOT called
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })

  // ── Gate 5: ACK transition fail ────────────────────────────────────────────

  it('gate 5 (ACK transition fail): run terminalized to FAILED, lock released, same reply text', async () => {
    // #given — transitionRun PENDING→ACKNOWLEDGED fails; run is still PENDING
    const {launchWork} = await import('./run.js')
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'adoption-etag-5'}})
    mockRuntime.acquireLock.mockResolvedValue({
      success: true as const,
      data: {acquired: true as const, etag: 'lock-etag-v1', holder: null},
    })
    mockRuntime.releaseLock.mockResolvedValue({success: true as const, data: undefined})
    // First transitionRun call (ACKNOWLEDGED) fails; second (FAILED terminalization) succeeds
    mockRuntime.transitionRun
      .mockResolvedValueOnce({
        success: false as const,
        error: new Error('ACK transition conflict'),
      })
      .mockResolvedValueOnce({
        success: true as const,
        data: {etag: 'fail-etag', state: buildMockRunState({phase: 'FAILED'})},
      })

    const observeFn = vi.fn().mockResolvedValue(undefined)
    const request = makeInMemoryRequest()
    const deps = makeDeps({runObserver: {observe: observeFn}})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — run terminalized to FAILED (using adoptionEtag since ACK failed)
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')
    // ACKNOWLEDGED was attempted but failed
    expect(transitionPhases[0]).toBe('ACKNOWLEDGED')
    expect(transitionPhases[1]).toBe('FAILED')

    // #and — observer notified of FAILED
    const observedPhases = observeFn.mock.calls.map((c: unknown[]) => (c[0] as {phase?: string}).phase)
    expect(observedPhases).toContain('FAILED')

    // #and — lock released (even though ACK failed)
    expect(mockRuntime.releaseLock).toHaveBeenCalledOnce()

    // #and — same reply text as before
    const sends = request._replySink._sends
    const errorSend = sends.find(s => s.content.includes('Could not start'))
    expect(errorSend).toBeDefined()

    // #and — runOpenCodeCore NOT called
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })

  // ── Dual-finally: gate that THROWS still terminalizes ─────────────────────

  it('dual-finally: a gate that THROWS (not returns) still terminalizes to FAILED', async () => {
    // #given — ensureClone THROWS (not just returns failure); run was admitted (PENDING)
    // This tests the dual-finally wrapper: a thrown error in a gate must still
    // terminalize the run to FAILED before propagating.
    const {launchWork} = await import('./run.js')
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'adoption-etag-throw'}})
    mockRuntime.transitionRun.mockResolvedValue({
      success: true as const,
      data: {etag: 'fail-etag', state: buildMockRunState({phase: 'FAILED'})},
    })

    // ensureClone THROWS (not returns {success:false})
    const ensureClone = vi.fn().mockRejectedValue(new Error('ensureClone threw unexpectedly'))
    const observeFn = vi.fn().mockResolvedValue(undefined)
    const request = makeInMemoryRequest()
    const deps = makeDeps({ensureClone, update: makeUpdateFn('no-checkout'), runObserver: {observe: observeFn}})

    // #when — the run promise may reject (the throw propagates after terminalization)
    const admission = await launchWork(request, deps)
    if (admission.accepted === true && admission.runPromise !== undefined) {
      // The run promise may reject — catch it so the test doesn't fail on the rejection
      await admission.runPromise.catch(() => {
        /* expected: gate threw */
      })
    }

    // #then — run terminalized to FAILED (dual-finally caught the throw)
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')

    // #and — observer notified of FAILED
    const observedPhases = observeFn.mock.calls.map((c: unknown[]) => (c[0] as {phase?: string}).phase)
    expect(observedPhases).toContain('FAILED')
  })

  // ── Dual-finally: gate THROWS after lock acquisition releases the lock ─────

  it('dual-finally: a gate that THROWS after lock acquisition releases the lock', async () => {
    // #given — lock is acquired, then transitionRun THROWS (not returns failure)
    // This tests the lock-leak fix: a thrown error after acquireLock must still release the lock.
    const {launchWork} = await import('./run.js')
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'adoption-etag-throw-post-lock'}})
    mockRuntime.acquireLock.mockResolvedValue({
      success: true as const,
      data: {acquired: true as const, etag: 'lock-etag-throw', holder: null},
    })
    mockRuntime.releaseLock.mockResolvedValue({success: true as const, data: undefined})
    // transitionRun THROWS on the ACKNOWLEDGED call (not returns {success:false})
    mockRuntime.transitionRun.mockRejectedValueOnce(new Error('transitionRun threw unexpectedly'))

    const observeFn = vi.fn().mockResolvedValue(undefined)
    const request = makeInMemoryRequest()
    const deps = makeDeps({runObserver: {observe: observeFn}})

    // #when — the run promise rejects (the throw propagates after terminalization)
    const admission = await launchWork(request, deps)
    if (admission.accepted === true && admission.runPromise !== undefined) {
      await admission.runPromise.catch(() => {
        /* expected: gate threw */
      })
    }

    // #then — run terminalized to FAILED (dual-finally caught the throw)
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')

    // #and — lock IS released (not leaked)
    expect(mockRuntime.releaseLock).toHaveBeenCalledOnce()
    const releaseCall = mockRuntime.releaseLock.mock.calls[0] as unknown[]
    expect(releaseCall[2]).toBe('lock-etag-throw')
  })

  // ── R8 Discord: Discord run whose early gate fails writes FAILED run-state ─

  it('r8 Discord: Discord run whose ensureClone fails now writes FAILED run-state (previously just replied)', async () => {
    // #given — Discord mention; ensureClone fails (post-lock); run was admitted (PENDING) by launchWork
    const {runMention} = await import('./run.js')
    setupHappyPath()
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'adoption-etag-r8'}})
    // One-shot stubs: ACK returns ACKNOWLEDGED state, the terminal call returns FAILED state.
    mockRuntime.transitionRun
      .mockResolvedValueOnce({
        success: true as const,
        data: {etag: 'ack-etag', state: buildMockRunState({phase: 'ACKNOWLEDGED'})},
      })
      .mockResolvedValueOnce({
        success: true as const,
        data: {etag: 'fail-etag', state: buildMockRunState({phase: 'FAILED'})},
      })

    const ensureClone = makeEnsureCloneFn('failure')
    const observeFn = vi.fn().mockResolvedValue(undefined)
    const message = makeMessage()
    const deps = makeDeps({ensureClone, update: makeUpdateFn('no-checkout'), runObserver: {observe: observeFn}})

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — FAILED run-state written (new behavior: observable failure)
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')

    // #and — observer notified of FAILED
    const observedPhases = observeFn.mock.calls.map((c: unknown[]) => (c[0] as {phase?: string}).phase)
    expect(observedPhases).toContain('FAILED')

    // #and — reply now goes to the thread (a thread exists by the time ensureClone runs)
    // reusing the existing "unreachable" post-lock failure message
    const thread = message._thread
    expect(thread.send).toHaveBeenCalledOnce()
    const call = (thread.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {content: string}
    expect(call.content).toContain('not reachable')
  })

  // ── Regression: successful run unchanged ───────────────────────────────────

  it('regression: successful run still goes PENDING→ACKNOWLEDGED→EXECUTING→COMPLETED unchanged', async () => {
    // #given — happy path; all gates pass
    const {launchWork} = await import('./run.js')
    setupHappyPath()

    const ackState = buildMockRunState({phase: 'ACKNOWLEDGED'})
    const execState = buildMockRunState({phase: 'EXECUTING'})
    const completedState = buildMockRunState({phase: 'COMPLETED'})

    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'run-etag-v1'}})
    mockRuntime.transitionRun
      .mockResolvedValueOnce({success: true as const, data: {etag: 'ack-etag', state: ackState}})
      .mockResolvedValueOnce({success: true as const, data: {etag: 'exec-etag', state: execState}})
      .mockResolvedValueOnce({success: true as const, data: {etag: 'done-etag', state: completedState}})

    const observeFn = vi.fn().mockResolvedValue(undefined)
    const request = makeInMemoryRequest()
    const deps = makeDeps({runObserver: {observe: observeFn}})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — full lifecycle: PENDING→ACKNOWLEDGED→EXECUTING→COMPLETED
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toEqual(['ACKNOWLEDGED', 'EXECUTING', 'COMPLETED'])

    // #and — observer sees PENDING (from launchWork), then ACKNOWLEDGED, EXECUTING, COMPLETED
    const observedPhases = observeFn.mock.calls.map((c: unknown[]) => (c[0] as {phase?: string}).phase)
    expect(observedPhases[0]).toBe('PENDING')
    expect(observedPhases).toContain('ACKNOWLEDGED')
    expect(observedPhases).toContain('EXECUTING')
    expect(observedPhases).toContain('COMPLETED')
    expect(observedPhases).not.toContain('FAILED')

    // #and — exactly one createRun (no double-create)
    expect(mockRuntime.createRun).toHaveBeenCalledOnce()

    // #and — execution happened
    expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
  })
})

describe('failureKind threading (early-abort gates)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('workspace clone failure: FAILED transitionRun carries detailsPatch.failureKind = "unreachable"', async () => {
    // #given — ensureClone fails post-lock (after ACK, before EXECUTING)
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const ensureClone = makeEnsureCloneFn('failure')
    const message = makeMessage()
    const deps = makeDeps({ensureClone, update: makeUpdateFn('no-checkout')})

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — the FAILED transitionRun call persists the internal 'unreachable' kind
    const failedCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'FAILED')
    const failedOptions = failedCall?.[7] as {detailsPatch: {failureKind: unknown}} | undefined
    expect(failedOptions?.detailsPatch.failureKind).toBe('unreachable')

    // #and — this projects to 'workspace-unreachable' via the operator mapping
    const {toOperatorFailureKind} = await import('../operator-contract/run-status.js')
    expect(toOperatorFailureKind(failedOptions?.detailsPatch.failureKind)).toBe('workspace-unreachable')
  })

  it('workspace clone 401 (bad control-API bearer): FAILED transitionRun carries detailsPatch.failureKind = "workspace-unavailable", not "unreachable"', async () => {
    // #given — ensureClone fails with an http-error/401 (workspace rejected the gateway's own
    // bearer): a configuration problem, not a transient reachability blip.
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const ensureClone = vi.fn().mockResolvedValue({
      success: false as const,
      error: {kind: 'workspace-failure' as const, workspaceKind: 'http-error' as const, status: 401},
    })
    const message = makeMessage()
    const deps = makeDeps({ensureClone, update: makeUpdateFn('no-checkout')})

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — the FAILED transitionRun call persists the internal 'workspace-unavailable' kind,
    // not 'unreachable' — retrying will not fix a stale/mismatched bearer.
    const failedCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'FAILED')
    const failedOptions = failedCall?.[7] as {detailsPatch: {failureKind: unknown}} | undefined
    expect(failedOptions?.detailsPatch.failureKind).toBe('workspace-unavailable')

    // #and — this projects to 'workspace-unavailable' via the operator mapping (not
    // 'workspace-unreachable', which would invite a pointless retry)
    const {toOperatorFailureKind} = await import('../operator-contract/run-status.js')
    expect(toOperatorFailureKind(failedOptions?.detailsPatch.failureKind)).toBe('workspace-unavailable')
  })

  it('workspace clone journal-in-progress: FAILED transitionRun carries detailsPatch.failureKind = "workspace-unavailable", not "unreachable"', async () => {
    // #given — ensureClone fails with clone-error/journal-in-progress (apps/workspace-agent's
    // clone.ts refuses an outstanding update/recovery journal). A plain retry hits the exact
    // same refusal until a later `/update` or `/fro-bot recover-checkout` resolves the journal,
    // so it must not land in the retry-inviting bucket.
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const ensureClone = vi.fn().mockResolvedValue({
      success: false as const,
      error: {
        kind: 'workspace-failure' as const,
        workspaceKind: 'clone-error' as const,
        code: 'journal-in-progress' as const,
      },
    })
    const message = makeMessage()
    const deps = makeDeps({ensureClone, update: makeUpdateFn('no-checkout')})

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — the FAILED transitionRun call persists the internal 'workspace-unavailable' kind,
    // not 'unreachable' — retrying will not fix an outstanding journal on its own today.
    const failedCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'FAILED')
    const failedOptions = failedCall?.[7] as {detailsPatch: {failureKind: unknown}} | undefined
    expect(failedOptions?.detailsPatch.failureKind).toBe('workspace-unavailable')

    // #and — this projects to 'workspace-unavailable' via the operator mapping (not
    // 'workspace-unreachable', which would invite a pointless retry)
    const {toOperatorFailureKind} = await import('../operator-contract/run-status.js')
    expect(toOperatorFailureKind(failedOptions?.detailsPatch.failureKind)).toBe('workspace-unavailable')
  })

  it('workspace clone non-401 http-error (e.g. 503): FAILED transitionRun still carries detailsPatch.failureKind = "unreachable" (unchanged)', async () => {
    // #given — only 401 is treated as a configuration problem; every other HTTP status stays
    // the prior transient-reachability classification.
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const ensureClone = vi.fn().mockResolvedValue({
      success: false as const,
      error: {kind: 'workspace-failure' as const, workspaceKind: 'http-error' as const, status: 503},
    })
    const message = makeMessage()
    const deps = makeDeps({ensureClone, update: makeUpdateFn('no-checkout')})

    // #when
    await runMention(message, makeBinding(), deps)

    // #then
    const failedCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'FAILED')
    const failedOptions = failedCall?.[7] as {detailsPatch: {failureKind: unknown}} | undefined
    expect(failedOptions?.detailsPatch.failureKind).toBe('unreachable')
  })

  it('readyz failure: FAILED transitionRun carries detailsPatch.failureKind = "unreachable"', async () => {
    // #given — readyz reports not-ready before ACK
    const {runMention} = await import('./run.js')
    const readyz = makeReadyzFn('not-ready')
    const message = makeMessage()
    const deps = makeDeps({readyz})

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — the FAILED transitionRun call persists the internal 'unreachable' kind
    const failedCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'FAILED')
    const failedOptions = failedCall?.[7] as {detailsPatch: {failureKind: unknown}} | undefined
    expect(failedOptions?.detailsPatch.failureKind).toBe('unreachable')

    const {toOperatorFailureKind} = await import('../operator-contract/run-status.js')
    expect(toOperatorFailureKind(failedOptions?.detailsPatch.failureKind)).toBe('workspace-unreachable')
  })

  it('lock held: FAILED transitionRun omits detailsPatch.failureKind (contention, not a workspace-startup failure)', async () => {
    // #given — lock is held by another gateway
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const message = makeMessage()
    const deps = makeDeps()

    mockRuntime.acquireLock.mockResolvedValue({
      success: true as const,
      data: {acquired: false as const, etag: null, holder: {holder_id: 'other-gateway', etag: 'abc'} as unknown},
    } as Awaited<ReturnType<typeof runtimeModule.acquireLock>>)

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — the FAILED transitionRun call carries no detailsPatch.failureKind
    const failedCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'FAILED')
    const failedOptions = failedCall?.[7] as {detailsPatch?: {failureKind?: unknown}}
    expect(failedOptions?.detailsPatch?.failureKind).toBeUndefined()
  })

  it('threadFactory throws: FAILED transitionRun omits detailsPatch.failureKind', async () => {
    // #given — threadFactory (message.startThread) rejects before ACK
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const thread = makeThread()
    const message = makeMessage(thread)
    ;(message.startThread as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Discord thread creation failed'))
    const deps = makeDeps()

    // #when
    await runMention(message, makeBinding(), deps)

    // #then
    const failedCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'FAILED')
    const failedOptions = failedCall?.[7] as {detailsPatch?: {failureKind?: unknown}}
    expect(failedOptions?.detailsPatch?.failureKind).toBeUndefined()
  })

  it('regression: omit call sites still call failAdmittedRun with the same signature (no behavior change)', async () => {
    // #given — a plain Error from the core run (generic failure, not a pre-ACK gate)
    const {runMention} = await import('./run.js')
    setupHappyPath()
    mockRunOpenCodeCore.mockRejectedValue(new Error('boom'))

    const deps = makeDeps()
    const message = makeMessage()

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — FAILED transition still occurs with no failureKind (this failure is post-ACK)
    const failedCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'FAILED')
    const failedOptions = failedCall?.[7] as {detailsPatch?: {failureKind?: unknown}}
    expect(failedOptions?.detailsPatch?.failureKind).toBeUndefined()
  })
})
