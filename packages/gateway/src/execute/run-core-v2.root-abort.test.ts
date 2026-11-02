/**
 * A run that stops interrupts what its directory shows and waits for the directory to stay quiet before the failure
 * escapes, even when the ownership ledger is empty. The prompt runs in server scope, so only an interrupt stops it;
 * releasing the lock and slot without that leaves the root writing the checkout under the next run (#1958).
 *
 * The V2 rules under test: an interrupt reply is never read as a stop (an interrupt sent before the prompt is admitted
 * leaves no trace, and the root’s late start is seen in the quiet window instead), and a stop is confirmed only by the
 * directory staying quiet. Anything the barrier cannot confirm quarantines the run and keeps the watch stopping the
 * directory through the hold.
 */

import type {OwnershipLedger, RemoteOpenCodeV2Client} from '@fro-bot/runtime'
import type {Run, StartOptions} from './run-core-v2.fixture.js'

import {createOwnershipLedger, err, ok} from '@fro-bot/runtime'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {createPermissionCoordinator} from '../approvals/coordinator.js'
import {createApprovalRegistry} from '../approvals/registry.js'
import {createPostReplyFactoryV2, OPERATOR_REJECT_MESSAGE_V2} from './permission-reply-v2.js'
import {QUARANTINE_HOLD_WINDOW_MS} from './root-stop.js'
import {failure, frames, makeLogger, ROOT, startRun} from './run-core-v2.fixture.js'

const INACTIVITY_MS = 5_000
/** Longer than the 15 s settle bound, so a run that cannot confirm the root has concluded. */
const PAST_SETTLE_BOUND_MS = 20_000
const BUSY_ROOT = async (): Promise<Readonly<Record<string, {readonly type: string}>>> => ({[ROOT]: {type: 'running'}})

interface StopScenario {
  readonly label: string
  readonly kind: 'inactivity-timeout' | 'stream-ended' | 'timeout'
  /** Starts a run that will stop for this reason, and drives it to the point where it has stopped. */
  readonly stop: (options?: StartOptions) => Promise<Run>
}

const STOP_SCENARIOS: readonly StopScenario[] = [
  {
    label: 'wall-clock timeout',
    kind: 'timeout',
    stop: async options => {
      const controller = new AbortController()
      const run = startRun({...options, controller})
      await vi.advanceTimersByTimeAsync(100)
      controller.abort()
      await vi.advanceTimersByTimeAsync(1_000)
      return run
    },
  },
  {
    label: 'operator cancel',
    kind: 'timeout',
    stop: async options => {
      const controller = new AbortController()
      const run = startRun({...options, controller})
      await vi.advanceTimersByTimeAsync(100)
      controller.abort('operator cancel')
      await vi.advanceTimersByTimeAsync(1_000)
      return run
    },
  },
  {
    label: 'operator cancel during a tool call',
    kind: 'timeout',
    stop: async options => {
      const controller = new AbortController()
      const run = startRun({...options, controller})
      await vi.advanceTimersByTimeAsync(100)
      run.emit(
        frames.started(),
        frames.toolStarted('shell', 'call_1'),
        frames.toolCalled('call_1', {command: 'sleep 60'}),
      )
      await vi.advanceTimersByTimeAsync(100)
      controller.abort('operator cancel')
      await vi.advanceTimersByTimeAsync(1_000)
      return run
    },
  },
  {
    label: 'signal aborted after the prompt was sent',
    kind: 'timeout',
    stop: async options => {
      const controller = new AbortController()
      const run = startRun({...options, controller, onPrompt: () => controller.abort()})
      await vi.advanceTimersByTimeAsync(1_000)
      return run
    },
  },
  {
    label: 'signal aborted while the prompt was in flight',
    kind: 'timeout',
    stop: async options => {
      const controller = new AbortController()
      const run = startRun({
        ...options,
        controller,
        promptResult: async () => {
          controller.abort()
          return err({kind: 'aborted'})
        },
      })
      await vi.advanceTimersByTimeAsync(1_000)
      return run
    },
  },
  {
    label: 'inactivity',
    kind: 'inactivity-timeout',
    stop: async options => {
      const run = startRun({...options, inactivityTimeoutMs: INACTIVITY_MS})
      await vi.advanceTimersByTimeAsync(INACTIVITY_MS + 1_000)
      return run
    },
  },
  {
    label: 'stream ended',
    kind: 'stream-ended',
    stop: async options => {
      const run = startRun(options)
      await vi.advanceTimersByTimeAsync(100)
      run.close()
      await vi.advanceTimersByTimeAsync(1_000)
      return run
    },
  },
  {
    label: 'stream lost',
    kind: 'stream-ended',
    stop: async options => {
      const run = startRun(options)
      await vi.advanceTimersByTimeAsync(100)
      run.failStream(new Error('socket hang up'))
      await vi.advanceTimersByTimeAsync(1_000)
      return run
    },
  },
]

const LEDGERS: readonly (readonly [string, (() => OwnershipLedger) | undefined])[] = [
  ['no ledger', undefined],
  ['an empty ledger', () => createOwnershipLedger()],
]

function ledgerOption(make: (() => OwnershipLedger) | undefined): StartOptions {
  return make === undefined ? {} : {ownershipLedger: make()}
}

afterEach(() => {
  vi.useRealTimers()
})

describe('root interrupt on a stop that may leave the root running', () => {
  describe.each(STOP_SCENARIOS)('$label', scenario => {
    it.each(LEDGERS)('interrupts the root, confirms it stopped and releases with %s', async (_label, makeLedger) => {
      // #given / #when — the run stops with nothing owned, so the ledger cannot speak for the root
      const run = await scenario.stop(ledgerOption(makeLedger))

      // #then — same failure kind, root interrupted once, confirmed absent with an ended execution, not quarantined
      const error = failure(run)
      expect(error.kind).toBe(scenario.kind)
      expect(error.quarantined).toBe(false)
      expect(run.interrupt).toHaveBeenCalledTimes(1)
      expect(run.interrupt).toHaveBeenCalledWith(expect.objectContaining({sessionId: ROOT}))
      expect(run.active).toHaveBeenCalled()
    })

    it('quarantines when the root is still active after the interrupt', async () => {
      // #given — the active list keeps reporting the root
      const run = await scenario.stop({activeReply: BUSY_ROOT})

      // #when — the bounded settle budget runs out
      await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

      // #then — same kind, with quarantine as extra evidence
      const error = failure(run)
      expect(error.kind).toBe(scenario.kind)
      expect(error.quarantined).toBe(true)
      // the root kept showing up live, so it was interrupted again on every poll, not once
      expect(run.interrupt.mock.calls.length).toBeGreaterThan(1)
    })

    it('quarantines when the interrupt fails and the root stays active', async () => {
      // #given
      const run = await scenario.stop({
        activeReply: BUSY_ROOT,
        interrupt: async () => err({kind: 'network', message: 'down'}),
      })

      // #when
      await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

      // #then
      expect(failure(run).quarantined).toBe(true)
    })

    it('quarantines when the server is unreachable, so nothing can be confirmed', async () => {
      // #given
      const run = await scenario.stop({
        activeReply: async () => {
          throw new Error('session.active failed: network down')
        },
        interrupt: async () => err({kind: 'network', message: 'down'}),
      })

      // #when
      await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

      // #then
      const error = failure(run)
      expect(error.kind).toBe(scenario.kind)
      expect(error.quarantined).toBe(true)
    })
  })

  it('does not release on an absent root: a prompt admitted late shows up in the window and is stopped', async () => {
    // #given — the prompt was sent but is not admitted yet, so the root is absent from the active list and an interrupt
    // now says `{interrupted: false}` (probe P1). A window of three readings 100 ms apart.
    const controller = new AbortController()
    let admitted = false
    const run = startRun({
      controller,
      directoryStability: {requiredObservations: 3, minSpacingMs: 100, minSpanMs: 200},
      activeReply: async (): Promise<Record<string, {readonly type: string}>> =>
        admitted ? {[ROOT]: {type: 'running'}} : {},
      interrupt: async () => {
        const wasAdmitted = admitted
        admitted = false
        return ok({interrupted: wasAdmitted})
      },
    })
    await vi.advanceTimersByTimeAsync(50)

    // #when — the stop starts, and the root is admitted 150 ms in
    controller.abort()
    await vi.advanceTimersByTimeAsync(150)
    admitted = true
    await vi.advanceTimersByTimeAsync(1_000)

    // #then — the late start was seen and interrupted, and only then did the run release
    expect(run.interrupt).toHaveBeenCalledWith(expect.objectContaining({sessionId: ROOT}))
    const error = failure(run)
    expect(error.kind).toBe('timeout')
    expect(error.quarantined).toBe(false)
  })

  it('quarantines when the prompt is admitted late and never stops', async () => {
    // #given — the same, but the root ignores every interrupt
    const controller = new AbortController()
    let admitted = false
    const run = startRun({
      controller,
      directoryStability: {requiredObservations: 3, minSpacingMs: 100, minSpanMs: 200},
      activeReply: async (): Promise<Record<string, {readonly type: string}>> =>
        admitted ? {[ROOT]: {type: 'running'}} : {},
      interrupt: async () => ok({interrupted: false}),
    })
    await vi.advanceTimersByTimeAsync(50)
    controller.abort()
    await vi.advanceTimersByTimeAsync(150)
    admitted = true

    // #when
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then
    expect(failure(run).quarantined).toBe(true)
  })

  it('keeps interrupting during the hold, so a prompt that starts late is stopped', async () => {
    // #given — quarantined because the root ignored the interrupt; it then goes quiet, and later a wake starts it again
    const controller = new AbortController()
    let rootBusy = true
    let lateStart = false
    const run = startRun({
      controller,
      activeReply: async (): Promise<Record<string, {readonly type: string}>> =>
        rootBusy || lateStart ? {[ROOT]: {type: 'running'}} : {},
      interrupt: async () => ok({interrupted: lateStart}),
    })
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)
    expect(failure(run).quarantined).toBe(true)
    rootBusy = false
    await vi.advanceTimersByTimeAsync(2_000)
    const interruptsAtQuarantine = run.interrupt.mock.calls.length

    // #when
    lateStart = true
    await vi.advanceTimersByTimeAsync(2_000)

    // #then
    expect(run.interrupt.mock.calls.length).toBeGreaterThan(interruptsAtQuarantine)
  })

  it('does not keep interrupting after the quarantine hold window closes', async () => {
    // #given
    const controller = new AbortController()
    const run = startRun({controller, activeReply: BUSY_ROOT})
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)
    await vi.advanceTimersByTimeAsync(QUARANTINE_HOLD_WINDOW_MS + 1_000)
    const calls = run.interrupt.mock.calls.length

    // #when
    await vi.advanceTimersByTimeAsync(10_000)

    // #then
    expect(run.interrupt.mock.calls.length).toBe(calls)
  })

  it('does not accept an interrupt with reason shutdown as the root stopping, and quarantines', async () => {
    // #given — the server reports the root's execution interrupted for shutdown: the claim stays held and resumable.
    // The persisted outcome even reads `interrupted`, from an earlier interrupt of the run's own.
    const run = startRun({outcome: () => 'interrupted', active: []})
    await vi.advanceTimersByTimeAsync(100)

    // #when
    run.emit(frames.interrupted(ROOT, 'shutdown'))
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then
    const error = failure(run)
    expect(error.kind).toBe('session-error')
    expect(error.quarantined).toBe(true)
  })

  it('has no fast path: a failure after the root already halted still waits for the directory to stay quiet', async () => {
    // #given
    const run = startRun()
    await vi.advanceTimersByTimeAsync(100)
    const readsBefore = run.active.mock.calls.length

    // #when
    run.emit(frames.failed())
    await vi.advanceTimersByTimeAsync(1_000)

    // #then — nothing to stop, nothing quarantined, but the directory was read
    expect(failure(run).quarantined).toBe(false)
    expect(run.interrupt).not.toHaveBeenCalled()
    expect(run.active.mock.calls.length).toBeGreaterThan(readsBefore)
  })

  it("stamps the run id on the barrier's log lines", async () => {
    // #given
    const controller = new AbortController()
    const run = startRun({controller, runId: 'run-42', activeReply: BUSY_ROOT})
    await vi.advanceTimersByTimeAsync(100)

    // #when
    controller.abort()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then
    expect(run.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({runId: 'run-42', kind: 'timeout'}),
      expect.stringContaining('quarantining run'),
    )
  })

  it('never interrupts for a run that completed', async () => {
    // #given
    const run = startRun()
    await vi.advanceTimersByTimeAsync(100)

    // #when
    run.emit(frames.succeeded())
    await vi.advanceTimersByTimeAsync(1_000)

    // #then
    expect(run.outcome()).toEqual({ok: true})
    expect(run.interrupt).not.toHaveBeenCalled()
  })

  it('waits for the directory to go quiet after a teardown reject that carries a message wakes the root', async () => {
    // #given — an approval is open, wired the way run.ts wires it (coordinator → registry → the V2 reply path), and a
    // server on which a reject WITH a message wakes the root (the model takes another step)
    const logger = makeLogger()
    const registry = createApprovalRegistry({logger})
    const clientRef: {current?: Run} = {}
    const proxy = {
      replyPermission: async (input: Parameters<RemoteOpenCodeV2Client['replyPermission']>[0]) => {
        const current = clientRef.current
        if (current === undefined) return err({kind: 'parse'} as const)
        // Upstream lets the model take another step after a reject that carries a message: the root wakes.
        if (input.decision === 'reject' && input.message !== undefined && input.message !== '') {
          setTimeout(() => current.activeSet.add(ROOT), 150)
        }
        return current.client.replyPermission(input)
      },
    } as unknown as RemoteOpenCodeV2Client
    const postReplyFactory = createPostReplyFactoryV2(proxy)
    const coordinator = createPermissionCoordinator({
      logger,
      onPending: request =>
        registry.register({
          requestID: request.requestID,
          sessionID: request.sessionID,
          approvalScopeId: 'chan_1',
          directory: '/workspace/repos/o/r',
          request,
          effects: {postReply: postReplyFactory(request.sessionID)},
        }),
      onReplied: event => registry.confirmReply(event),
      onDispose: sessionIds => {
        for (const sessionId of sessionIds) registry.disposeRun(sessionId, 'run ended').catch(() => undefined)
      },
    })
    const controller = new AbortController()
    const run = startRun({
      controller,
      coordinator,
      active: [],
      directoryStability: {requiredObservations: 3, minSpacingMs: 100, minSpanMs: 200},
    })
    clientRef.current = run
    await vi.advanceTimersByTimeAsync(50)
    run.emit(frames.permissionAsked('per_a'))
    await vi.advanceTimersByTimeAsync(50)

    // #when — the run is cancelled; the teardown reject goes out, and the root wakes 150 ms later
    controller.abort('operator cancel')
    await vi.advanceTimersByTimeAsync(100)

    // #then — the reject carried the message, and the quiet window (200 ms) is not over, so nothing is released yet
    expect(run.replyPermission).toHaveBeenCalledOnce()
    expect(run.replyPermission.mock.calls[0]?.[0]).toMatchObject({
      requestId: 'per_a',
      decision: 'reject',
      message: OPERATOR_REJECT_MESSAGE_V2,
    })
    expect(run.outcome()).toBeUndefined()

    // #when — the woken root is seen and stopped
    await vi.advanceTimersByTimeAsync(2_000)

    // #then — the stop saw the wake, and only then released the checkout, with the directory confirmed quiet
    expect(run.interrupt).toHaveBeenCalledWith(expect.objectContaining({sessionId: ROOT}))
    const error = failure(run)
    expect(error.kind).toBe('timeout')
    expect(error.quarantined).toBe(false)
  })
})
