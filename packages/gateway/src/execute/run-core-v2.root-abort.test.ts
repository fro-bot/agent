/**
 * A run that stops while its root may still be running must interrupt that root and confirm it stopped before the
 * failure escapes, even when the ownership ledger is empty. The prompt runs in server scope, so only an interrupt stops
 * it; releasing the lock and slot without that leaves the root writing the checkout under the next run (#1958).
 *
 * The V2 rules under test: an `{interrupted: false}` reply is never a stop (an interrupt sent before the prompt is
 * admitted leaves no trace), absence from the active list is never a stop, and an interrupt with reason `shutdown` is
 * never a stop. A stop needs an ended execution AND absence from the active list.
 */

import type {OwnershipLedger} from '@fro-bot/runtime'
import type {Run, StartOptions} from './run-core-v2.fixture.js'

import {createOwnershipLedger, err, ok} from '@fro-bot/runtime'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {QUARANTINE_HOLD_WINDOW_MS} from './root-stop.js'
import {failure, frames, ROOT, startRun} from './run-core-v2.fixture.js'

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

  it('does not read an interrupt reply of false as a stop: a root with no ended execution is quarantined', async () => {
    // #given — the root is absent and the reply says nothing was interrupted: what a prompt that is not admitted
    // yet looks like (probe P1). No execution has ended, so there is no evidence the root stopped.
    const controller = new AbortController()
    const run = startRun({
      controller,
      active: [],
      interrupt: async () => ok({interrupted: false}),
      outcome: () => null,
    })
    await vi.advanceTimersByTimeAsync(100)

    // #when
    controller.abort()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then
    expect(failure(run).quarantined).toBe(true)
  })

  it('keeps interrupting during the hold, so a prompt that starts late is stopped', async () => {
    // #given — quarantined with the root absent, then it turns up busy as the late prompt starts
    const controller = new AbortController()
    let lateStart = false
    const run = startRun({
      controller,
      activeReply: async (): Promise<Record<string, {readonly type: string}>> =>
        lateStart ? {[ROOT]: {type: 'running'}} : {},
      interrupt: async () => ok({interrupted: lateStart}),
      outcome: () => null,
    })
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)
    expect(failure(run).quarantined).toBe(true)
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

  it('takes the fast path, with no remote call, for a failure after the root already halted', async () => {
    // #given
    const run = startRun()
    await vi.advanceTimersByTimeAsync(100)

    // #when
    run.emit(frames.failed())
    await vi.advanceTimersByTimeAsync(1_000)

    // #then
    expect(failure(run).quarantined).toBe(false)
    expect(run.interrupt).not.toHaveBeenCalled()
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
})
