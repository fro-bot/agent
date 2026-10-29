/**
 * A run that dispatched background work does not complete on the root's first success: the server runs the parent again
 * to take each child's notice in (probe P2). It completes only when every child is terminal and the root is idle after
 * the last turn a notice triggered. Drives the real loop and the real drain gate against the captured frames.
 */

import type {OwnershipLedger} from '@fro-bot/runtime'

import {createOwnershipLedger, ok} from '@fro-bot/runtime'
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
  startWindowedRun,
  STRANGER,
  succeeded,
} from './run-core-v2.fixture.js'
import {getWaitReason} from './wait-reason-registry.js'

function states(ledger: OwnershipLedger): Record<string, string> {
  return Object.fromEntries(ledger.snapshot().map(entry => [entry.sessionId, entry.state]))
}

/** Root dispatches `child` in the background and finishes its first turn. */
async function dispatchAndIdle(run: ReturnType<typeof startWindowedRun>, child = CHILD): Promise<void> {
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
function noticeTurn(
  run: ReturnType<typeof startWindowedRun>,
  child = CHILD,
  state = 'completed',
  inbox = 'msg_notice',
): void {
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
    const run = startWindowedRun({ownershipLedger: ledger, onOwnershipChange, active: [CHILD], children: [CHILD]})
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
    const run = startWindowedRun({ownershipLedger: ledger})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(
      frames.toolStarted('subagent', 'call_16_0'),
      onSession(SUBAGENT_FOREGROUND_SUCCESS_FRAME, ROOT),
      frames.succeeded(),
    )
    await vi.advanceTimersByTimeAsync(1_000)

    // #then — nothing was adopted, so once the directory has stayed quiet the root's success completes the run
    expect(ledger.snapshot()).toEqual([])
    expect(succeeded(run)).toBe(true)
  })

  it('does not adopt a failed subagent call that kept its running progress metadata', async () => {
    // #given
    const ledger = createOwnershipLedger()
    const run = startWindowedRun({ownershipLedger: ledger})
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
    await vi.advanceTimersByTimeAsync(1_000)

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
    const run = startWindowedRun({ownershipLedger: ledger, onBusy, active: [CHILD], children: [CHILD]})
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
    const run = startWindowedRun({ownershipLedger: ledger, active: [], children: [CHILD]})
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
    const run = startWindowedRun({ownershipLedger: ledger, active: [], children: [CHILD]})
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
    const run = startWindowedRun({ownershipLedger: ledger, active: [], children: [CHILD]})
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
    const run = startWindowedRun({ownershipLedger: ledger, active: [OTHER_CHILD], children: [CHILD, OTHER_CHILD]})
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
    const run = startWindowedRun({ownershipLedger: ledger, active: [CHILD], children: [CHILD]})
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
    const run = startWindowedRun({ownershipLedger: ledger, active: [CHILD], children: [CHILD]})
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
    const run = startWindowedRun({ownershipLedger: ledger, active: [], children: [CHILD]})
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
    const run = startWindowedRun({ownershipLedger: ledger, active: [CHILD], children: [CHILD]})
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
    const run = startWindowedRun({ownershipLedger: ledger, active: [], children: [CHILD]})
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
    const run = startWindowedRun({ownershipLedger: ledger, active: [CHILD], children: [CHILD]})
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
    const run = startWindowedRun({ownershipLedger: ledger, active: [CHILD], children: [CHILD]})
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
    const run = startWindowedRun({ownershipLedger: ledger, controller, active: [CHILD], children: [CHILD]})
    await vi.advanceTimersByTimeAsync(10)
    await dispatchAndIdle(run)

    // #when
    controller.abort()
    await vi.advanceTimersByTimeAsync(20_000)

    // #then
    const error = failure(run)
    expect(error.kind).toBe('drain-timeout')
    expect(run.interrupt).toHaveBeenCalledWith(expect.objectContaining({sessionId: CHILD}))
    // the root is idle while it drains, so there is nothing to interrupt on it
    expect(run.interrupt).not.toHaveBeenCalledWith(expect.objectContaining({sessionId: ROOT}))
  })

  it('does not trip the inactivity timer while it waits on a quiet child', async () => {
    // #given
    const ledger = createOwnershipLedger()
    const controller = new AbortController()
    const run = startWindowedRun({
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
    const run = startWindowedRun({
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

  it('reports the directory window as the reason once the ledger is drained, and does not wait for a notice', async () => {
    // #given — reconciliation settled the child, but its notice never came
    const ledger = createOwnershipLedger()
    const controller = new AbortController()
    const run = startWindowedRun({
      ownershipLedger: ledger,
      controller,
      runId: 'run-window',
      active: [],
      children: [CHILD],
    })
    await vi.advanceTimersByTimeAsync(10)

    // #when
    await dispatchAndIdle(run)
    await vi.advanceTimersByTimeAsync(200)

    // #then — the directory window is what the run waits on, not the missing notice
    expect(run.outcome()).toBeUndefined()
    expect(getWaitReason('run-window')).toBe('ledger-not-drained')

    // #when — the window completes
    await vi.advanceTimersByTimeAsync(1_500)

    // #then — released on the directory alone
    expect(succeeded(run)).toBe(true)
  })
})

describe('runOpenCodeCoreV2: bounded reconcile passes', () => {
  it('bounds a reconcile pass that never answers: the child becomes unknown and the loop keeps reading', async () => {
    // #given — listing children hangs
    const ledger = createOwnershipLedger()
    const run = startWindowedRun({ownershipLedger: ledger, active: [CHILD], children: [CHILD]})
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
    const run = startWindowedRun({ownershipLedger: ledger, controller, active: [CHILD], children: [CHILD]})
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

describe('runOpenCodeCoreV2: a notice queued into a busy child', () => {
  it('completes once the child takes the notice in, instead of waiting for a delivery it never forwarded', async () => {
    // #given — the root's child is still busy when its own child (a grandchild) ends, so that notice queues there
    const ledger = createOwnershipLedger()
    const run = startWindowedRun({ownershipLedger: ledger, active: [], children: [CHILD]})
    await vi.advanceTimersByTimeAsync(10)
    await dispatchAndIdle(run)

    // #when — the child takes the grandchild's notice in, then ends itself and the root takes that notice in
    run.emit(
      frames.notice('ses_grandchild', 'completed', 'msg_grandchild', CHILD),
      frames.delivered('msg_grandchild', CHILD),
    )
    noticeTurn(run)
    await vi.advanceTimersByTimeAsync(2_000)

    // #then
    expect(succeeded(run)).toBe(true)
  })

  it('does not complete while the notice is still queued in the child', async () => {
    // #given
    const ledger = createOwnershipLedger()
    const run = startWindowedRun({ownershipLedger: ledger, active: [], children: [CHILD]})
    await vi.advanceTimersByTimeAsync(10)
    await dispatchAndIdle(run)

    // #when — never delivered
    run.emit(frames.notice('ses_grandchild', 'completed', 'msg_grandchild', CHILD))
    noticeTurn(run)
    await vi.advanceTimersByTimeAsync(2_000)

    // #then
    expect(run.outcome()).toBeUndefined()
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })

  it('ignores a delivery in a session this run does not own', async () => {
    // #given — a notice queued in the child
    const ledger = createOwnershipLedger()
    const run = startWindowedRun({ownershipLedger: ledger, active: [], children: [CHILD]})
    await vi.advanceTimersByTimeAsync(10)
    await dispatchAndIdle(run)

    // #when — the id is "delivered" in a stranger's session
    run.emit(
      frames.notice('ses_grandchild', 'completed', 'msg_grandchild', CHILD),
      frames.delivered('msg_grandchild', STRANGER),
    )
    noticeTurn(run)
    await vi.advanceTimersByTimeAsync(2_000)

    // #then
    expect(run.outcome()).toBeUndefined()
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })
})

/**
 * The root dispatches a child in the background, then halts before it ever reports a success. Cancelling the child
 * delivers a notice that makes the server start a successor root turn; `successor` says when, relative to the cancel.
 */
async function haltWithChildRunning(
  halt: (run: ReturnType<typeof startWindowedRun>) => void,
  successor: {readonly afterMs: number; readonly stoppable: boolean},
) {
  const ledger = createOwnershipLedger()
  let rootBusy = false
  let rootInterrupts = 0
  const run: ReturnType<typeof startWindowedRun> = startWindowedRun({
    ownershipLedger: ledger,
    children: [CHILD],
    active: [CHILD],
    activeReply: async (): Promise<Record<string, {readonly type: string}>> => ({
      ...(rootBusy ? {[ROOT]: {type: 'running'}} : {}),
      ...(run.activeSet.has(CHILD) ? {[CHILD]: {type: 'running'}} : {}),
    }),
    interrupt: async sessionId => {
      if (sessionId === ROOT) {
        rootInterrupts += 1
        if (successor.stoppable) rootBusy = false
        return ok({interrupted: true})
      }
      // Cancelling the child delivers its notice, which wakes the root a moment later.
      run.activeSet.delete(CHILD)
      setTimeout(() => {
        rootBusy = true
      }, successor.afterMs)
      return ok({interrupted: true})
    },
  })
  await vi.advanceTimersByTimeAsync(10)
  run.emit(
    frames.started(),
    frames.toolStarted('subagent', 'call_dispatch'),
    frames.toolCalled('call_dispatch', {description: 'bg child', prompt: 'work', background: true}),
    frames.dispatch(CHILD),
  )
  await vi.advanceTimersByTimeAsync(10)
  expect(states(ledger)).toEqual({[CHILD]: 'outstanding'})
  halt(run)
  await vi.advanceTimersByTimeAsync(20_000)
  return {
    run,
    rootInterrupts: () => rootInterrupts,
    startSuccessor: () => {
      rootBusy = true
    },
  }
}

describe('runOpenCodeCoreV2: a halted root with background work outstanding', () => {
  const HALTS = [
    ['execution.failed', (run: ReturnType<typeof startWindowedRun>) => run.emit(frames.failed())],
    [
      'execution.interrupted by a user',
      (run: ReturnType<typeof startWindowedRun>) => run.emit(frames.interrupted(ROOT, 'user')),
    ],
  ] as const

  it.each(HALTS)(
    'stops the successor root turn the child’s cancel wakes inside the window, on %s',
    async (_label, halt) => {
      // #given / #when — the root halts with the child running; the child's cancel wakes the root 200 ms later
      const {run, rootInterrupts} = await haltWithChildRunning(halt, {afterMs: 200, stoppable: true})

      // #then — the wake was seen in the window and interrupted, and the run released once the directory stayed quiet
      expect(rootInterrupts()).toBeGreaterThanOrEqual(1)
      expect(failure(run).quarantined).toBe(false)
    },
  )

  it.each(HALTS)(
    'quarantines on %s when the successor root turn cannot be stopped, and keeps interrupting through the hold',
    async (_label, halt) => {
      // #given / #when
      const {run, rootInterrupts, startSuccessor} = await haltWithChildRunning(halt, {afterMs: 200, stoppable: false})

      // #then
      expect(failure(run).quarantined).toBe(true)
      const interruptsAtQuarantine = rootInterrupts()

      // #when — the server starts yet another successor turn during the hold
      startSuccessor()
      await vi.advanceTimersByTimeAsync(2_000)

      // #then — the root is interrupted again
      expect(rootInterrupts()).toBeGreaterThan(interruptsAtQuarantine)
    },
  )

  it('has no fast path for a halted root that owns no background work: it still reads the directory', async () => {
    // #given
    const ledger = createOwnershipLedger()
    const run = startWindowedRun({ownershipLedger: ledger})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(frames.failed())
    await vi.advanceTimersByTimeAsync(1_000)

    // #then
    expect(failure(run).quarantined).toBe(false)
    expect(run.interrupt).not.toHaveBeenCalled()
  })
})

describe('runOpenCodeCoreV2: a notice that cannot be read', () => {
  it('fences the child it names, so the run completes instead of waiting out its deadline', async () => {
    // #given — the child ended, but its notice carries a state this client does not know
    const ledger = createOwnershipLedger()
    const run = startWindowedRun({ownershipLedger: ledger, active: [], children: [CHILD]})
    await vi.advanceTimersByTimeAsync(10)
    await dispatchAndIdle(run)

    // #when — the unreadable notice, then the turn that takes it in
    noticeTurn(run, CHILD, 'paused', 'msg_odd')
    await vi.advanceTimersByTimeAsync(2_000)

    // #then
    expect(succeeded(run)).toBe(true)
  })

  it('marks a still-running child unknown rather than settled, and keeps the run going', async () => {
    // #given
    const ledger = createOwnershipLedger()
    const run = startWindowedRun({ownershipLedger: ledger, active: [CHILD], children: [CHILD]})
    await vi.advanceTimersByTimeAsync(10)
    await dispatchAndIdle(run)

    // #when
    run.emit(frames.notice(CHILD, 'paused', 'msg_odd'))
    await vi.advanceTimersByTimeAsync(10)

    // #then — the notice proves nothing about the child, so it blocks the drain
    expect(states(ledger)).toEqual({[CHILD]: 'unknown'})
    expect(run.outcome()).toBeUndefined()
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })

  it('ignores an unreadable notice delivered to a session this run does not own', async () => {
    // #given
    const ledger = createOwnershipLedger()
    const run = startWindowedRun({ownershipLedger: ledger, active: [CHILD], children: [CHILD]})
    await vi.advanceTimersByTimeAsync(10)
    await dispatchAndIdle(run)

    // #when
    run.emit(frames.notice(CHILD, 'paused', 'msg_odd', STRANGER))
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(states(ledger)).toEqual({[CHILD]: 'outstanding'})
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })
})
