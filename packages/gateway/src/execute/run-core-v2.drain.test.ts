/**
 * A run that dispatched background work does not complete on the root's first success: the server runs the parent again
 * to take each child's notice in (probe P2). It completes only when every child is terminal and the root is idle after
 * the last turn a notice triggered. Drives the real loop and the real drain gate against the captured frames.
 */

import type {OwnershipLedger} from '@fro-bot/runtime'

import {createOwnershipLedger} from '@fro-bot/runtime'
import {SUBAGENT_FOREGROUND_SUCCESS_FRAME} from '@fro-bot/runtime/event-v2-fixtures'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {LIVE_RECONCILE_TIMEOUT_MS} from './live-reconcile.js'
import {
  CHILD,
  failure,
  frames,
  onSession,
  OTHER_CHILD,
  ROOT,
  startRun,
  STRANGER,
  succeeded,
} from './run-core-v2.fixture.js'
import {getWaitReason} from './wait-reason-registry.js'

function states(ledger: OwnershipLedger): Record<string, string> {
  return Object.fromEntries(ledger.snapshot().map(entry => [entry.sessionId, entry.state]))
}

/** Root dispatches `child` in the background and finishes its first turn. */
async function dispatchAndIdle(run: ReturnType<typeof startRun>, child = CHILD): Promise<void> {
  run.emit(
    frames.started(),
    frames.toolStarted('subagent', 'call_dispatch'),
    frames.toolCalled('call_dispatch', {description: 'bg child', prompt: 'work', background: true}),
    frames.dispatch(child),
    frames.delta('Dispatched.'),
    frames.succeeded(),
  )
  await vi.advanceTimersByTimeAsync(10)
}

/** The server enqueues the child's notice, runs the parent to take it in, and the parent answers. */
function noticeTurn(run: ReturnType<typeof startRun>, child = CHILD, state = 'completed', inbox = 'msg_notice'): void {
  run.emit(
    frames.notice(child, state, inbox),
    frames.started(),
    frames.delivered(inbox),
    frames.delta('The child finished.', ROOT, 0, 'msg_followup'),
    frames.succeeded(),
  )
}

afterEach(() => {
  vi.useRealTimers()
})

describe('runOpenCodeCoreV2: adopting background work', () => {
  it('adopts the child of a successful background dispatch and registers it with the coordinator', async () => {
    // #given
    const ledger = createOwnershipLedger()
    const onOwnershipChange = vi.fn()
    const run = startRun({ownershipLedger: ledger, onOwnershipChange, active: [CHILD], children: [CHILD]})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    await dispatchAndIdle(run)

    // #then
    expect(states(ledger)).toEqual({[CHILD]: 'outstanding'})
    expect(run.coordinator.addOwnedSession).toHaveBeenCalledWith(CHILD)
    expect(onOwnershipChange).toHaveBeenCalledWith({rootSessionId: ROOT, ownedSessionIds: [CHILD]})
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })

  it('does not adopt a foreground subagent call, whose result text claims a completion', async () => {
    // #given — the captured foreground result has completed metadata and a <subagent …> text a child could forge
    const ledger = createOwnershipLedger()
    const run = startRun({ownershipLedger: ledger})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(
      frames.toolStarted('subagent', 'call_16_0'),
      onSession(SUBAGENT_FOREGROUND_SUCCESS_FRAME, ROOT),
      frames.succeeded(),
    )
    await vi.advanceTimersByTimeAsync(10)

    // #then — nothing was adopted, so the root's success completes the run
    expect(ledger.snapshot()).toEqual([])
    expect(succeeded(run)).toBe(true)
  })

  it('does not adopt a failed subagent call that kept its running progress metadata', async () => {
    // #given
    const ledger = createOwnershipLedger()
    const run = startRun({ownershipLedger: ledger})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(
      frames.toolStarted('subagent', 'call_x'),
      {
        type: 'session.tool.failed',
        data: {
          sessionID: ROOT,
          assistantMessageID: 'msg_tool',
          id: 'call_x',
          error: {type: 'tool.execution', message: 'Failed to prompt subagent'},
          metadata: {sessionID: CHILD, status: 'running'},
          executed: false,
        },
      },
      frames.succeeded(),
    )
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(ledger.snapshot()).toEqual([])
    expect(succeeded(run)).toBe(true)
  })
})

describe('runOpenCodeCoreV2: draining', () => {
  it("does not treat the root's first success as terminal while a child is outstanding", async () => {
    // #given
    const ledger = createOwnershipLedger()
    const onBusy = vi.fn()
    const run = startRun({ownershipLedger: ledger, onBusy, active: [CHILD], children: [CHILD]})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    await dispatchAndIdle(run)
    await vi.advanceTimersByTimeAsync(5_000)

    // #then — still running, and not busy: the run is waiting, not working
    expect(run.outcome()).toBeUndefined()
    expect(onBusy).toHaveBeenLastCalledWith(false)
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })

  it('completes after the turn the notice triggered, with one reply carrying the follow-up text', async () => {
    // #given — the child ends after the root went idle; nothing is active any more
    const ledger = createOwnershipLedger()
    const run = startRun({ownershipLedger: ledger, active: [], children: [CHILD]})
    await vi.advanceTimersByTimeAsync(10)
    await dispatchAndIdle(run)
    expect(run.outcome()).toBeUndefined()

    // #when
    noticeTurn(run)
    await vi.advanceTimersByTimeAsync(2_000)

    // #then — one reply, the follow-up after the dispatch text, and the child settled by its notice
    expect(succeeded(run)).toBe(true)
    expect(run.sink.text()).toContain('Dispatched.')
    expect(run.sink.text()).toContain('The child finished.')
    expect(run.sink.text().indexOf('The child finished.')).toBeGreaterThan(run.sink.text().indexOf('Dispatched.'))
    expect(states(ledger)).toEqual({[CHILD]: 'settled'})
    expect(run.interrupt).not.toHaveBeenCalled()
  })

  it("completes on a cancelled child's notice as it does on a completed one", async () => {
    // #given
    const ledger = createOwnershipLedger()
    const run = startRun({ownershipLedger: ledger, active: [], children: [CHILD]})
    await vi.advanceTimersByTimeAsync(10)
    await dispatchAndIdle(run)

    // #when
    noticeTurn(run, CHILD, 'cancelled', 'msg_cancel')
    await vi.advanceTimersByTimeAsync(2_000)

    // #then
    expect(succeeded(run)).toBe(true)
    expect(states(ledger)).toEqual({[CHILD]: 'settled'})
  })

  it('does not complete on a notice alone: the parent must run the turn that takes it in', async () => {
    // #given — the notice is queued, the parent has not run again
    const ledger = createOwnershipLedger()
    const run = startRun({ownershipLedger: ledger, active: [], children: [CHILD]})
    await vi.advanceTimersByTimeAsync(10)
    await dispatchAndIdle(run)

    // #when
    run.emit(frames.notice(CHILD))
    await vi.advanceTimersByTimeAsync(5_000)

    // #then
    expect(run.outcome()).toBeUndefined()
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })

  it('waits for every child: one notice of two does not complete the run', async () => {
    // #given
    const ledger = createOwnershipLedger()
    const run = startRun({ownershipLedger: ledger, active: [OTHER_CHILD], children: [CHILD, OTHER_CHILD]})
    await vi.advanceTimersByTimeAsync(10)
    await dispatchAndIdle(run, CHILD)
    run.emit(frames.toolStarted('subagent', 'call_dispatch_2'), frames.dispatch(OTHER_CHILD, ROOT, 'call_dispatch_2'))
    await vi.advanceTimersByTimeAsync(10)

    // #when — only the first child ends
    noticeTurn(run, CHILD, 'completed', 'msg_a')
    await vi.advanceTimersByTimeAsync(2_000)

    // #then
    expect(run.outcome()).toBeUndefined()
    expect(states(ledger)).toEqual({[CHILD]: 'settled', [OTHER_CHILD]: 'outstanding'})
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })

  it('ignores a notice about a child it never adopted', async () => {
    // #given — this run's own child is still running
    const ledger = createOwnershipLedger()
    const run = startRun({ownershipLedger: ledger, active: [CHILD], children: [CHILD]})
    await vi.advanceTimersByTimeAsync(10)
    await dispatchAndIdle(run)

    // #when — a notice for somebody else's child, then the turn it triggers
    noticeTurn(run, STRANGER, 'completed', 'msg_x')
    await vi.advanceTimersByTimeAsync(2_000)

    // #then — this run's own child is still outstanding
    expect(run.outcome()).toBeUndefined()
    expect(states(ledger)).toEqual({[CHILD]: 'outstanding'})
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })

  it('ignores a notice delivered to a session this run does not own', async () => {
    // #given — the child is still running
    const ledger = createOwnershipLedger()
    const run = startRun({ownershipLedger: ledger, active: [CHILD], children: [CHILD]})
    await vi.advanceTimersByTimeAsync(10)
    await dispatchAndIdle(run)

    // #when
    run.emit(frames.notice(CHILD, 'completed', 'msg_y', STRANGER))
    await vi.advanceTimersByTimeAsync(2_000)

    // #then
    expect(states(ledger)).toEqual({[CHILD]: 'outstanding'})
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })

  it('settles a child whose notice arrived before its dispatch result', async () => {
    // #given — the notice reaches the stream first
    const ledger = createOwnershipLedger()
    const run = startRun({ownershipLedger: ledger, active: [], children: [CHILD]})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(
      frames.started(),
      frames.toolStarted('subagent', 'call_dispatch'),
      frames.notice(CHILD),
      frames.dispatch(CHILD),
      frames.delivered('msg_notice'),
      frames.succeeded(),
    )
    await vi.advanceTimersByTimeAsync(2_000)

    // #then
    expect(states(ledger)).toEqual({[CHILD]: 'settled'})
  })

  it('marks an owned child unknown when its execution fails, and keeps the run going', async () => {
    // #given
    const ledger = createOwnershipLedger()
    const run = startRun({ownershipLedger: ledger, active: [CHILD], children: [CHILD]})
    await vi.advanceTimersByTimeAsync(10)
    await dispatchAndIdle(run)

    // #when
    run.emit(frames.failed(CHILD))
    await vi.advanceTimersByTimeAsync(10)

    // #then — not settled: an error is evidence something went wrong, not proof the child stopped writing
    expect(states(ledger)).toEqual({[CHILD]: 'unknown'})
    expect(run.outcome()).toBeUndefined()
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })

  it('lets a later notice settle a child that was marked unknown, and then completes', async () => {
    // #given
    const ledger = createOwnershipLedger()
    const run = startRun({ownershipLedger: ledger, active: [], children: [CHILD]})
    await vi.advanceTimersByTimeAsync(10)
    await dispatchAndIdle(run)
    run.emit(frames.failed(CHILD))
    await vi.advanceTimersByTimeAsync(10)

    // #when
    noticeTurn(run, CHILD, 'error', 'msg_err')
    await vi.advanceTimersByTimeAsync(2_000)

    // #then
    expect(succeeded(run)).toBe(true)
    expect(states(ledger)).toEqual({[CHILD]: 'settled'})
  })

  it('marks an owned child unknown, not settled, when something else interrupts it', async () => {
    // #given
    const ledger = createOwnershipLedger()
    const run = startRun({ownershipLedger: ledger, active: [CHILD], children: [CHILD]})
    await vi.advanceTimersByTimeAsync(10)
    await dispatchAndIdle(run)

    // #when
    run.emit(frames.interrupted(CHILD, 'user'))
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(states(ledger)).toEqual({[CHILD]: 'unknown'})
    expect(run.outcome()).toBeUndefined()
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })

  it("streams an owned child's text and ignores a stranger's", async () => {
    // #given
    const ledger = createOwnershipLedger()
    const run = startRun({ownershipLedger: ledger, active: [CHILD], children: [CHILD]})
    await vi.advanceTimersByTimeAsync(10)
    await dispatchAndIdle(run)

    // #when
    run.emit(frames.delta('child says hi', CHILD, 0, 'msg_c'), frames.delta('stranger says hi', STRANGER, 0, 'msg_s'))
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(run.sink.text()).toContain('child says hi')
    expect(run.sink.text()).not.toContain('stranger says hi')
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })

  it('fails with drain-timeout at the deadline and interrupts the unsettled child', async () => {
    // #given — the child never ends
    const ledger = createOwnershipLedger()
    const controller = new AbortController()
    const run = startRun({ownershipLedger: ledger, controller, active: [CHILD], children: [CHILD]})
    await vi.advanceTimersByTimeAsync(10)
    await dispatchAndIdle(run)

    // #when
    controller.abort()
    await vi.advanceTimersByTimeAsync(20_000)

    // #then
    const error = failure(run)
    expect(error.kind).toBe('drain-timeout')
    expect(run.interrupt).toHaveBeenCalledWith(expect.objectContaining({sessionId: CHILD}))
    expect(run.interrupt).toHaveBeenCalledWith(expect.objectContaining({sessionId: ROOT}))
  })

  it('does not trip the inactivity timer while it waits on a quiet child', async () => {
    // #given
    const ledger = createOwnershipLedger()
    const controller = new AbortController()
    const run = startRun({
      ownershipLedger: ledger,
      controller,
      inactivityTimeoutMs: 5_000,
      active: [CHILD],
      children: [CHILD],
    })
    await vi.advanceTimersByTimeAsync(10)
    await dispatchAndIdle(run)

    // #when — far past the inactivity window
    await vi.advanceTimersByTimeAsync(60_000)

    // #then — still draining: only the run's own deadline bounds a drain
    expect(run.outcome()).toBeUndefined()
    controller.abort()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(failure(run).kind).toBe('drain-timeout')
  })

  it('reports why it has not finished while draining, and clears it on exit', async () => {
    // #given
    const ledger = createOwnershipLedger()
    const controller = new AbortController()
    const run = startRun({
      ownershipLedger: ledger,
      controller,
      runId: 'run-drain',
      active: [CHILD],
      children: [CHILD],
    })
    await vi.advanceTimersByTimeAsync(10)

    // #when
    await dispatchAndIdle(run)
    await vi.advanceTimersByTimeAsync(2_000)

    // #then — the child is not settled yet
    expect(getWaitReason('run-drain')).toBe('ledger-not-drained')

    // #when
    controller.abort()
    await vi.advanceTimersByTimeAsync(20_000)

    // #then
    expect(getWaitReason('run-drain')).toBeUndefined()
  })

  it('reports a missing notice as the reason once the ledger is drained without one', async () => {
    // #given — reconciliation settled the child, but its notice never came
    const ledger = createOwnershipLedger()
    const controller = new AbortController()
    const run = startRun({ownershipLedger: ledger, controller, runId: 'run-nonotice', active: [], children: [CHILD]})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    await dispatchAndIdle(run)
    await vi.advanceTimersByTimeAsync(2_000)

    // #then — the idle pass settles the child by reconciliation; the gate still wants the notice
    expect(getWaitReason('run-nonotice')).toBe('notice-not-observed')
    controller.abort()
    await vi.advanceTimersByTimeAsync(20_000)
  })
})

describe('runOpenCodeCoreV2: bounded reconcile passes', () => {
  it('bounds a reconcile pass that never answers: the child becomes unknown and the loop keeps reading', async () => {
    // #given — listing children hangs
    const ledger = createOwnershipLedger()
    const run = startRun({ownershipLedger: ledger, active: [CHILD], children: [CHILD]})
    await vi.advanceTimersByTimeAsync(10)
    vi.mocked(run.client.session.list).mockImplementation(async () => new Promise(() => undefined))
    await dispatchAndIdle(run)

    // #when — the bound passes
    await vi.advanceTimersByTimeAsync(LIVE_RECONCILE_TIMEOUT_MS + 1_000)

    // #then — unknown (it blocks the drain, as an outstanding entry would), and the loop still handles events
    expect(states(ledger)).toEqual({[CHILD]: 'unknown'})
    run.emit(frames.delta('still reading'))
    await vi.advanceTimersByTimeAsync(10)
    expect(run.sink.text()).toContain('still reading')
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })

  it('lets a late reconcile answer settle nothing after the run left the loop', async () => {
    // #given — the pass is in flight when the run ends
    const ledger = createOwnershipLedger()
    const controller = new AbortController()
    const run = startRun({ownershipLedger: ledger, controller, active: [CHILD], children: [CHILD]})
    await vi.advanceTimersByTimeAsync(10)
    let release: (() => void) | undefined
    vi.mocked(run.client.session.list).mockImplementation(
      async () =>
        new Promise(resolve => {
          release = () => resolve({data: [{id: CHILD, parentID: ROOT}]})
        }),
    )
    await dispatchAndIdle(run)

    // #when — the run is cancelled, then the late answer would have settled the child
    controller.abort()
    await vi.advanceTimersByTimeAsync(20_000)
    release?.()
    await vi.advanceTimersByTimeAsync(10)

    // #then — teardown owns the ledger from the moment the run ended
    expect(states(ledger)[CHILD]).not.toBe('settled')
  })
})
