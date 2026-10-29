import type {LedgerReconcileAdapter, SubagentNotice} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'
import type {DrainRejectCode} from './drain-completion.js'

import {createOwnershipLedger, err, ok, shellLedgerKey} from '@fro-bot/runtime'
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

function setup(options: {readonly live?: readonly Live[]; readonly children?: readonly string[]} = {}) {
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
  const drain = createDrainCompletionV2({
    rootSessionId: ROOT,
    ledger,
    adapter,
    signal: controller.signal,
    logger: makeLogger(),
    onAdmitted,
    onNotAdmitted: code => reasons.push(code),
    validationIntervalMs: 1_000,
    requestTimeoutMs: 5_000,
  })
  return {ledger, adapter, controller, onAdmitted, reasons, drain}
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
  it('stops waiting for a readable notice from a child whose notice could not be read', async () => {
    // #given — the ledger settled the child (reconciliation saw it stop), and no readable notice ever came
    const s = setup()
    s.drain.noteRootIdle()
    s.drain.beginDrain()
    s.ledger.settle(CHILD)
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(10)
    expect(s.reasons.at(-1)).toBe('notice-not-observed')

    // #when — an unreadable notice names it, and the turn that follows ends
    s.drain.noteUnreadableNotice(CHILD)
    s.drain.noteRootActivity()
    s.drain.noteRootIdle()
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(s.onAdmitted).toHaveBeenCalledTimes(1)
  })

  it('still needs idle evidence after an unreadable notice', async () => {
    // #given
    const s = setup()
    s.drain.noteRootIdle()
    s.drain.beginDrain()
    s.ledger.settle(CHILD)

    // #when — the notice invalidates the earlier idle
    s.drain.noteUnreadableNotice(CHILD)
    await vi.advanceTimersByTimeAsync(10)

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
    await vi.advanceTimersByTimeAsync(10)

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
    await vi.advanceTimersByTimeAsync(10)

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
    await vi.advanceTimersByTimeAsync(10)

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
    await vi.advanceTimersByTimeAsync(10)
    expect(s.onAdmitted).not.toHaveBeenCalled()

    // #when — the delivery arrives, then the turn ends
    s.drain.noteInboxDelivered('msg_notice')
    s.drain.noteRootActivity()
    s.drain.noteRootIdle()
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(10)

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
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(s.onAdmitted).toHaveBeenCalledTimes(1)
  })

  it('does not admit a settled ledger without the child notice', async () => {
    // #given — reconciliation settled the child, but no notice has been seen
    const s = setup()
    s.drain.noteRootIdle()
    s.drain.beginDrain()
    s.ledger.settle(CHILD)

    // #when
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(s.onAdmitted).not.toHaveBeenCalled()
    expect(s.reasons.at(-1)).toBe('notice-not-observed')
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
    await vi.advanceTimersByTimeAsync(10)

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
    await vi.advanceTimersByTimeAsync(10)

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
    await vi.advanceTimersByTimeAsync(10)

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
    await vi.advanceTimersByTimeAsync(10)

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
    await vi.advanceTimersByTimeAsync(10)

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
    await vi.advanceTimersByTimeAsync(10)

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
    await vi.advanceTimersByTimeAsync(10)
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
    await vi.advanceTimersByTimeAsync(10)
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

  it('ignores a notice for a child the ledger never adopted when judging the ledger', async () => {
    // #given — a stranger's notice cannot satisfy this run's children
    const s = setup()
    s.drain.beginDrain()
    s.ledger.settle(CHILD)
    s.drain.noteNotice(notice('ses_stranger'), 'msg_x')

    // #when
    noticeTurn(s, 'msg_x')
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(s.onAdmitted).not.toHaveBeenCalled()
    expect(s.reasons.at(-1)).toBe('notice-not-observed')
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
    await vi.advanceTimersByTimeAsync(10)

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
    await vi.advanceTimersByTimeAsync(10)

    // #then — the first idle is not terminal
    expect(s.onAdmitted).not.toHaveBeenCalled()

    // #when — the woken turn takes the notice in and ends
    noticeTurn(s, 'msg_shell_notice')
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(s.onAdmitted).toHaveBeenCalledTimes(1)
  })

  it('does not admit a settled shell whose notice was never observed', async () => {
    // #given — reconciliation saw the shell stop; its notice has not arrived
    const s = shellSetup()
    s.drain.noteRootIdle()
    s.drain.beginDrain()
    s.ledger.settle(SHELL_KEY)

    // #when
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(s.onAdmitted).not.toHaveBeenCalled()
    expect(s.reasons.at(-1)).toBe('notice-not-observed')
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
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(s.onAdmitted).not.toHaveBeenCalled()
  })

  it('counts an unreadable shell notice as observed, but still needs idle evidence', async () => {
    // #given
    const s = shellSetup()
    s.drain.noteRootIdle()
    s.drain.beginDrain()
    s.ledger.settle(SHELL_KEY)

    // #when
    s.drain.noteUnreadableShellNotice(SHELL)
    await vi.advanceTimersByTimeAsync(10)

    // #then — the earlier idle is stale
    expect(s.onAdmitted).not.toHaveBeenCalled()
    expect(s.reasons.at(-1)).toBe('idle-evidence-stale')

    // #when — the turn that follows ends
    s.drain.noteRootActivity()
    s.drain.noteRootIdle()
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(s.onAdmitted).toHaveBeenCalledTimes(1)
  })

  it('a child notice does not stand in for a shell notice, and the other way round', async () => {
    // #given — a child and a shell are outstanding, and only the child ends
    const s = setup({children: [CHILD]})
    s.ledger.adopt(SHELL_KEY, 'sleep 8')
    s.drain.noteRootIdle()
    s.drain.beginDrain()
    childEnds(s)
    s.ledger.settle(SHELL_KEY)

    // #when
    noticeTurn(s)
    s.drain.requestValidation()
    await vi.advanceTimersByTimeAsync(10)

    // #then — the shell's own notice is still missing
    expect(s.onAdmitted).not.toHaveBeenCalled()
    expect(s.reasons.at(-1)).toBe('notice-not-observed')
  })
})
