import type {
  DirectoryObservation,
  DirectoryStabilityTuning,
  LedgerReconcileAdapter,
  SubagentNotice,
} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'
import type {DrainRejectCode} from './drain-completion.js'

import {createDirectoryStabilityGate, createOwnershipLedger, err, ok, shellLedgerKey} from '@fro-bot/runtime'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {createDrainCompletionV2} from './drain-completion-v2.js'

const ROOT = 'ses_root'
const CHILD = 'ses_child'
const OTHER = 'ses_other'

function notice(childSessionId: string, state: SubagentNotice['state'] = 'completed'): SubagentNotice {
  return {childSessionId, state, agent: 'General', description: 'bg'}
}

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

type Live = readonly string[] | 'fail' | 'hang'

/** A short window: three quiet readings, 50 ms apart, over 100 ms. */
const FAST: DirectoryStabilityTuning = {requiredObservations: 3, minSpacingMs: 50, minSpanMs: 100}

const QUIET: DirectoryObservation = {kind: 'quiescent'}
const ACTIVE_CHILD: DirectoryObservation = {
  kind: 'active',
  activity: {activeSessionIds: ['ses_child'], runningShellIds: [], queuedInbox: []},
}
const RUNNING_SHELL: DirectoryObservation = {
  kind: 'active',
  activity: {activeSessionIds: [], runningShellIds: ['sh_1'], queuedInbox: []},
}
const QUEUED_NOTICE: DirectoryObservation = {
  kind: 'active',
  activity: {activeSessionIds: [], runningShellIds: [], queuedInbox: [{sessionId: 'ses_child', queued: 1}]},
}
const UNREADABLE: DirectoryObservation = {
  kind: 'unreadable',
  reason: 'shell.list: network',
  activity: {activeSessionIds: [], runningShellIds: [], queuedInbox: []},
}

function setup(
  options: {
    readonly live?: readonly Live[]
    readonly children?: readonly string[]
    /** What each directory reading shows, in order; once spent, the directory is quiet. */
    readonly directory?: DirectoryObservation[]
    /** Called for each reading, so a test can change the world between readings. */
    readonly onRead?: (reading: number) => void
    readonly tuning?: DirectoryStabilityTuning
  } = {},
) {
  const ledger = createOwnershipLedger()
  for (const child of options.children ?? [CHILD]) ledger.adopt(child, child)
  const readings = options.live ?? [[]]
  let call = 0
  const adapter: LedgerReconcileAdapter = {
    children: vi.fn(async () => ok([])),
    liveSessionIds: vi.fn(async (signal?: AbortSignal) => {
      const reading = readings[Math.min(call, readings.length - 1)] ?? []
      call += 1
      if (reading === 'hang') {
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), {once: true})
        })
      }
      return reading === 'fail' ? err(new Error('active failed')) : ok(new Set(reading))
    }),
  }
  const controller = new AbortController()
  const onAdmitted = vi.fn()
  const reasons: DrainRejectCode[] = []
  const script = [...(options.directory ?? [])]
  let reading = 0
  const observe = vi.fn(async () => {
    reading += 1
    options.onRead?.(reading)
    return script.shift() ?? QUIET
  })
  const tuning = options.tuning ?? FAST
  const gate = createDirectoryStabilityGate({...tuning, observe})
  const drain = createDrainCompletionV2({
    rootSessionId: ROOT,
    ledger,
    adapter,
    directoryGate: gate,
    directorySpacingMs: tuning.minSpacingMs ?? 500,
    signal: controller.signal,
    logger: makeLogger(),
    onAdmitted,
    onNotAdmitted: code => reasons.push(code),
    validationIntervalMs: 1_000,
    requestTimeoutMs: 5_000,
  })
  return {ledger, adapter, controller, onAdmitted, reasons, drain, observe, gate}
}

/** The server's own statement that a child ended: the ledger settles and the gate hears the notice. */
function childEnds(s: ReturnType<typeof setup>, child = CHILD, inboxId: string | null = 'msg_notice') {
  s.ledger.settle(child)
  s.drain.noteNotice(notice(child), inboxId)
}

/** The turn the notice triggers: it starts, takes the notice in, and ends. */
function noticeTurn(s: ReturnType<typeof setup>, inboxId = 'msg_notice') {
  s.drain.noteRootActivity() // execution.started
  s.drain.noteInboxDelivered(inboxId)
  s.drain.noteRootActivity() // the reply text
  s.drain.noteRootIdle() // execution.succeeded
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createDrainCompletionV2', () => {
  it('still needs idle evidence after an unreadable notice', async () => {
    // #given
    const s = setup()
    s.drain.noteRootIdle()
    s.drain.beginDrain()
    s.ledger.settle(CHILD)

    // #when — the notice invalidates the earlier idle
    s.drain.noteUnreadableNotice()
    await vi.advanceTimersByTimeAsync(300)

    // #then
    expect(s.onAdmitted).not.toHaveBeenCalled()
    expect(s.reasons.at(-1)).toBe('idle-evidence-stale')
  })

  it('admits success only after the turn the notice triggered has ended and the root is not live', async () => {
    // #given — the root went idle once, the child settled, its notice arrived
    const s = setup()
    s.drain.noteRootIdle()
    s.drain.beginDrain()
    childEnds(s)

    // #when — the notice's turn runs and ends
    noticeTurn(s)
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(300)

    // #then
    expect(s.onAdmitted).toHaveBeenCalledTimes(1)
  })

  it('does not treat the first idle after a background child as terminal', async () => {
    // #given — the child settled and its notice is queued, but the root has not taken it in yet
    const s = setup()
    s.drain.noteRootIdle()
    s.drain.beginDrain()

    // #when
    childEnds(s)
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(300)

    // #then — the earlier idle is stale, so nothing is admitted
    expect(s.onAdmitted).not.toHaveBeenCalled()
    expect(s.reasons.at(-1)).toBe('idle-evidence-stale')
  })

  it('does not admit while the notice is queued, even when the root went idle after it', async () => {
    // #given — an idle arrives after the notice, but the notice was never delivered into a turn
    const s = setup()
    s.drain.beginDrain()
    childEnds(s)

    // #when
    s.drain.noteRootActivity()
    s.drain.noteRootIdle()
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(300)

    // #then
    expect(s.onAdmitted).not.toHaveBeenCalled()
  })

  it('admits once the queued notice is delivered and the root ends the turn that took it in', async () => {
    // #given
    const s = setup()
    s.drain.beginDrain()
    childEnds(s)
    s.drain.noteRootActivity()
    s.drain.noteRootIdle()
    await vi.advanceTimersByTimeAsync(300)
    expect(s.onAdmitted).not.toHaveBeenCalled()

    // #when — the delivery arrives, then the turn ends
    s.drain.noteInboxDelivered('msg_notice')
    s.drain.noteRootActivity()
    s.drain.noteRootIdle()
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(300)

    // #then
    expect(s.onAdmitted).toHaveBeenCalledTimes(1)
  })

  it('counts a notice that is already in the transcript as delivered', async () => {
    // #given — a session.synthetic notice has no inbox id: it is the message itself
    const s = setup()
    s.drain.beginDrain()
    childEnds(s, CHILD, null)

    // #when
    s.drain.noteRootActivity()
    s.drain.noteRootIdle()
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(300)

    // #then
    expect(s.onAdmitted).toHaveBeenCalledTimes(1)
  })

  it('does not hold the run for a notice the directory never showed: the directory decides, not the notice', async () => {
    // #given — reconciliation settled the child and no notice was ever seen; the directory stays quiet
    const s = setup()
    s.drain.noteRootIdle()
    s.drain.beginDrain()
    s.ledger.settle(CHILD)

    // #when
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(500)

    // #then
    expect(s.onAdmitted).toHaveBeenCalledTimes(1)
  })

  it("accepts a cancelled notice as the child's terminal word", async () => {
    // #given
    const s = setup()
    s.drain.beginDrain()
    s.ledger.settle(CHILD)
    s.drain.noteNotice(notice(CHILD, 'cancelled'), 'msg_cancel')

    // #when
    noticeTurn(s, 'msg_cancel')
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(300)

    // #then
    expect(s.onAdmitted).toHaveBeenCalledTimes(1)
  })

  it('does not admit while the ledger still has an unsettled child', async () => {
    // #given — one of two children has ended
    const s = setup({children: [CHILD, OTHER]})
    s.drain.beginDrain()
    childEnds(s, CHILD, 'msg_a')

    // #when
    noticeTurn(s, 'msg_a')
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(300)

    // #then
    expect(s.onAdmitted).not.toHaveBeenCalled()
    expect(s.reasons.at(-1)).toBe('ledger-not-drained')
  })

  it('does not admit while the root is live in the active list', async () => {
    // #given
    const s = setup({live: [[ROOT]]})
    s.drain.beginDrain()
    childEnds(s)
    noticeTurn(s)

    // #when
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(300)

    // #then
    expect(s.onAdmitted).not.toHaveBeenCalled()
    expect(s.reasons.at(-1)).toBe('root-live')
  })

  it('does not admit when the active list cannot be read', async () => {
    // #given
    const s = setup({live: ['fail']})
    s.drain.beginDrain()
    childEnds(s)
    noticeTurn(s)

    // #when
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(300)

    // #then
    expect(s.onAdmitted).not.toHaveBeenCalled()
    expect(s.reasons.at(-1)).toBe('root-liveness-unavailable')
  })

  it('does not admit when root activity arrives while the liveness request is in flight', async () => {
    // #given — the request answers after the root started a new turn
    const s = setup()
    s.drain.beginDrain()
    childEnds(s)
    noticeTurn(s)
    s.drain.requestValidation()

    // #when — the root starts another turn before the answer lands
    s.drain.noteRootActivity()
    await vi.advanceTimersByTimeAsync(300)

    // #then
    expect(s.onAdmitted).not.toHaveBeenCalled()
  })

  it('does not admit on a liveness reading older than a turn that began and ended while it was in flight', async () => {
    // #given — everything else is in place; the reading is requested
    const s = setup()
    s.drain.beginDrain()
    childEnds(s)
    noticeTurn(s)
    s.drain.requestValidation()

    // #when — another full turn runs before the answer lands, leaving fresh idle evidence behind it
    noticeTurn(s)
    await vi.advanceTimersByTimeAsync(300)

    // #then — the reading predates that turn, so this pass must not admit
    expect(s.reasons.at(-1)).toBe('revision-drift')
    expect(s.onAdmitted).not.toHaveBeenCalled()
  })

  it('retries a declined validation on its interval until the evidence lands', async () => {
    // #given — the root is live at first, then not
    const s = setup({live: [[ROOT], []]})
    s.drain.beginDrain()
    childEnds(s)
    noticeTurn(s)
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(300)
    expect(s.onAdmitted).not.toHaveBeenCalled()

    // #when
    await vi.advanceTimersByTimeAsync(1_100)

    // #then
    expect(s.onAdmitted).toHaveBeenCalledTimes(1)
  })

  it('bounds a liveness request that never answers, so it counts as no evidence', async () => {
    // #given
    const s = setup({live: ['hang']})
    s.drain.beginDrain()
    childEnds(s)
    noticeTurn(s)

    // #when
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(5_100)

    // #then
    expect(s.onAdmitted).not.toHaveBeenCalled()
    expect(s.reasons.at(-1)).toBe('root-liveness-unavailable')
  })

  it('admits at most once and never after dispose', async () => {
    // #given
    const s = setup()
    s.drain.beginDrain()
    childEnds(s)
    noticeTurn(s)

    // #when
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(300)
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(2_000)

    // #then
    expect(s.onAdmitted).toHaveBeenCalledTimes(1)
  })

  it('never admits after dispose or once the run signal aborted', async () => {
    // #given
    const disposed = setup()
    disposed.drain.beginDrain()
    childEnds(disposed)
    noticeTurn(disposed)
    disposed.drain.dispose()
    const aborted = setup()
    aborted.drain.beginDrain()
    childEnds(aborted)
    noticeTurn(aborted)
    aborted.controller.abort()

    // #when
    disposed.drain.requestValidation()
    aborted.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(2_000)

    // #then
    expect(disposed.onAdmitted).not.toHaveBeenCalled()
    expect(aborted.onAdmitted).not.toHaveBeenCalled()
  })
})

describe('createDrainCompletionV2: background shells', () => {
  const SHELL = 'sh_185e8678e001OVuLXzTBhwDmUx'
  const SHELL_KEY = shellLedgerKey(SHELL)

  function shellSetup(options: {readonly live?: readonly Live[]} = {}) {
    const s = setup({children: [], ...options})
    s.ledger.adopt(SHELL_KEY, 'sleep 8')
    return s
  }

  /** The server's own statement that a background shell ended: the ledger settles and the gate hears the notice. */
  function shellEnds(s: ReturnType<typeof setup>, inboxId: string | null = 'msg_shell_notice') {
    s.ledger.settle(SHELL_KEY)
    s.drain.noteShellNotice(SHELL, 'completed', inboxId)
  }

  it('does not admit while a shell is outstanding, whatever the root did', async () => {
    // #given — the root went idle and the shell still runs
    const s = shellSetup()
    s.drain.noteRootIdle()
    s.drain.beginDrain()

    // #when
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(300)

    // #then
    expect(s.onAdmitted).not.toHaveBeenCalled()
    expect(s.reasons.at(-1)).toBe('ledger-not-drained')
  })

  it('admits only after the shell notice and the root turn it woke have both ended (real p20 order)', async () => {
    // #given — idle once, shell running
    const s = shellSetup()
    s.drain.noteRootIdle()
    s.drain.beginDrain()

    // #when — the notice arrives and the shell settles, but the woken turn has not run yet
    shellEnds(s)
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(300)

    // #then — the first idle is not terminal
    expect(s.onAdmitted).not.toHaveBeenCalled()

    // #when — the woken turn takes the notice in and ends
    noticeTurn(s, 'msg_shell_notice')
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(300)

    // #then
    expect(s.onAdmitted).toHaveBeenCalledTimes(1)
  })

  it('holds a queued shell notice until it is delivered into a root turn', async () => {
    // #given
    const s = shellSetup()
    s.drain.noteRootIdle()
    s.drain.beginDrain()
    shellEnds(s)

    // #when — a root idle that did not take the notice in
    s.drain.noteRootIdle()
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(300)

    // #then
    expect(s.onAdmitted).not.toHaveBeenCalled()
  })
})

/** A child that ended and a root turn that took its notice in: everything else says the run may finish. */
function readyToAdmit(s: ReturnType<typeof setup>) {
  s.drain.noteRootIdle()
  s.drain.beginDrain()
  childEnds(s)
  noticeTurn(s)
}

describe('createDrainCompletionV2: the directory gate', () => {
  it('does not admit before the directory has stayed quiet for the whole window', async () => {
    // #given — everything else is in place
    const s = setup()
    readyToAdmit(s)

    // #when
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(60)

    // #then — two readings of three are not enough
    expect(s.onAdmitted).not.toHaveBeenCalled()
    expect(s.reasons.at(-1)).toBe('ledger-not-drained')

    // #when
    await vi.advanceTimersByTimeAsync(100)

    // #then
    expect(s.onAdmitted).toHaveBeenCalledTimes(1)
  })

  it('uses the production window by default: eleven readings over five seconds', async () => {
    // #given
    const s = setup({tuning: {}})
    readyToAdmit(s)

    // #when
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(4_900)

    // #then
    expect(s.onAdmitted).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(s.onAdmitted).toHaveBeenCalledTimes(1)
  })

  it('does not admit while an awakened, settled child is still active, and keeps draining', async () => {
    // #given — the ledger settled the child long ago; its shell’s exit woke it, and it is running again
    const s = setup({directory: [ACTIVE_CHILD, ACTIVE_CHILD, ACTIVE_CHILD, ACTIVE_CHILD]})
    readyToAdmit(s)

    // #when
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(180)

    // #then — still not admitted, though every other piece of evidence is in
    expect(s.onAdmitted).not.toHaveBeenCalled()
    expect(s.reasons.at(-1)).toBe('ledger-not-drained')

    // #when — the child stops and the directory stays quiet
    await vi.advanceTimersByTimeAsync(400)

    // #then
    expect(s.onAdmitted).toHaveBeenCalledTimes(1)
  })

  it('does not admit on a wake inside the window, after readings that looked quiet', async () => {
    // #given — two quiet readings, then a REST-discovered shell’s completion wakes a session
    const s = setup({directory: [QUIET, QUIET, ACTIVE_CHILD]})
    readyToAdmit(s)

    // #when
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(120)

    // #then — the count started again
    expect(s.onAdmitted).not.toHaveBeenCalled()
    expect(s.observe.mock.calls.length).toBeGreaterThanOrEqual(3)

    // #when
    await vi.advanceTimersByTimeAsync(400)

    // #then — and a full window later it passes
    expect(s.onAdmitted).toHaveBeenCalledTimes(1)
    expect(s.observe.mock.calls.length).toBeGreaterThanOrEqual(6)
  })

  it('does not admit while a shell the ledger never heard of runs, and admits once it is gone', async () => {
    // #given — the shell disappears, then nothing else shows
    const s = setup({directory: [RUNNING_SHELL, RUNNING_SHELL]})
    readyToAdmit(s)

    // #when
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(90)

    // #then
    expect(s.onAdmitted).not.toHaveBeenCalled()

    // #when
    await vi.advanceTimersByTimeAsync(400)

    // #then — admitted on the directory alone: the disappearance is not what admits, the following quiet window is
    expect(s.onAdmitted).toHaveBeenCalledTimes(1)
  })

  it('catches an enqueued notice whose wake is deferred inside the window', async () => {
    // #given — the notice sits in the inbox for the first readings, then the wake starts
    const s = setup({directory: [QUIET, QUEUED_NOTICE, ACTIVE_CHILD]})
    readyToAdmit(s)

    // #when
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(140)

    // #then
    expect(s.onAdmitted).not.toHaveBeenCalled()
  })

  it('reads a failed reading as not quiet and says it cannot tell', async () => {
    // #given
    const s = setup({directory: [UNREADABLE, UNREADABLE, UNREADABLE]})
    readyToAdmit(s)

    // #when
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(140)

    // #then
    expect(s.onAdmitted).not.toHaveBeenCalled()
    expect(s.reasons).toContain('root-liveness-unavailable')
  })

  it('drops the count when root activity invalidates the evidence mid-window, and starts over', async () => {
    // #given
    const s = setup()
    readyToAdmit(s)
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(60)
    const readsBefore = s.observe.mock.calls.length

    // #when — the root takes another turn
    noticeTurn(s)
    await vi.advanceTimersByTimeAsync(1_500)

    // #then — admitted, but only after a fresh window: the earlier readings did not carry over
    expect(s.onAdmitted).toHaveBeenCalledTimes(1)
    expect(s.observe.mock.calls.length - readsBefore).toBeGreaterThanOrEqual(3)
  })

  it('needs a fresh window after activity and a new idle land during the final reading', async () => {
    // #given — the third and last reading is held; the root takes a turn and goes idle again while it is in flight
    const s = setup({
      onRead: reading => {
        if (reading !== 3) return
        s.drain.noteRootActivity()
        s.drain.noteRootIdle()
        s.drain.requestValidation()
      },
    })
    readyToAdmit(s)
    s.drain.requestValidation()

    // #when — the held reading comes back quiet, and the retry runs
    await vi.advanceTimersByTimeAsync(60)
    const readsAtDrift = s.observe.mock.calls.length
    expect(s.onAdmitted).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)

    // #then — the retry did not reuse the old streak: it took a whole new window, three readings, before admitting
    expect(s.onAdmitted).toHaveBeenCalledTimes(1)
    expect(s.observe.mock.calls.length - readsAtDrift).toBeGreaterThanOrEqual(3)
    expect(s.reasons).toContain('revision-drift')
  })

  it('drops the count on a reading that passes with the evidence already obsolete', async () => {
    // #given — one reading from passing, then the evidence changes under it
    const s = setup({
      tuning: {requiredObservations: 2, minSpacingMs: 50, minSpanMs: 50},
      onRead: reading => {
        if (reading === 2) s.drain.noteRootActivity()
      },
    })
    readyToAdmit(s)

    // #when
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(80)

    // #then — the streak the changed evidence produced was thrown away, not left to count toward the next attempt
    expect(s.gate.state().streak).toBe(0)
    expect(s.onAdmitted).not.toHaveBeenCalled()
  })

  it('does not read the directory before the cheap evidence is in', async () => {
    // #given — idle evidence is stale
    const s = setup()
    s.drain.beginDrain()
    childEnds(s)

    // #when
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(300)

    // #then
    expect(s.observe).not.toHaveBeenCalled()
  })

  it('does not admit once the run signal aborted mid-window', async () => {
    // #given
    const s = setup()
    readyToAdmit(s)
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(60)

    // #when
    s.controller.abort()
    await vi.advanceTimersByTimeAsync(1_000)

    // #then
    expect(s.onAdmitted).not.toHaveBeenCalled()
  })

  it('does not admit after dispose mid-window, and reads no more', async () => {
    // #given
    const s = setup()
    readyToAdmit(s)
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(60)

    // #when
    s.drain.dispose()
    const reads = s.observe.mock.calls.length
    await vi.advanceTimersByTimeAsync(1_000)

    // #then
    expect(s.onAdmitted).not.toHaveBeenCalled()
    expect(s.observe.mock.calls.length).toBeLessThanOrEqual(reads + 1)
  })
})
