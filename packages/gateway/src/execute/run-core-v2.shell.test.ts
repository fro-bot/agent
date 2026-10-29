/**
 * Background `shell` jobs in the V2 run loop. A background shell is a server job, not a session: `session.active` never
 * lists it, an interrupt does not stop it, and its completion notice wakes the root exactly as a child's does. So the
 * run treats it like a background subagent: it adopts the shell, waits for it, and on every stop path kills it BEFORE the
 * root is interrupted.
 *
 * The frames are the stock v2.2.0 captures from the bgshell probes (p20, p22), moved onto the ids under test.
 */

import type {OwnershipLedger} from '@fro-bot/runtime'
import type {StartOptions} from './run-core-v2.fixture.js'

import {createOwnershipLedger, ok, shellLedgerKey} from '@fro-bot/runtime'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {
  CHILD,
  failure,
  frames,
  OTHER_SHELL,
  ROOT,
  SHELL,
  startWindowedRun,
  STRANGER,
  succeeded,
} from './run-core-v2.fixture.js'
import {getWaitReason} from './wait-reason-registry.js'

const SHELL_KEY = shellLedgerKey(SHELL)
const OTHER_SHELL_KEY = shellLedgerKey(OTHER_SHELL)
const RUNNING_SHELL: StartOptions['shellServer'] = {shells: {[SHELL]: {status: 'running', owner: ROOT}}}
const PAST_SETTLE_BOUND_MS = 20_000

function states(ledger: OwnershipLedger): Record<string, string> {
  return Object.fromEntries(ledger.snapshot().map(entry => [entry.sessionId, entry.state]))
}

/** The root backgrounds a shell (the p20 sequence) and finishes its first turn. */
async function backgroundAndIdle(run: ReturnType<typeof startWindowedRun>, shellId = SHELL, callId = 'call_shell') {
  run.emit(
    frames.started(),
    frames.toolStarted('shell', callId),
    frames.toolCalled(callId, {command: 'sleep 8', background: true}),
    frames.shellCreated(shellId),
    frames.shellProgress(callId, shellId),
    frames.shellBackgrounded(callId, shellId),
    frames.delta('Started it.'),
    frames.succeeded(),
  )
  await vi.advanceTimersByTimeAsync(10)
}

/** The root backgrounds a shell and keeps working: no idle yet, so the run is not draining. */
async function backgroundMidTurn(run: ReturnType<typeof startWindowedRun>, shellId = SHELL, callId = 'call_shell') {
  run.emit(
    frames.started(),
    frames.toolStarted('shell', callId),
    frames.toolCalled(callId, {command: 'sleep 8', background: true}),
    frames.shellCreated(shellId),
    frames.shellProgress(callId, shellId),
    frames.shellBackgrounded(callId, shellId),
    frames.delta('Started it.'),
  )
  await vi.advanceTimersByTimeAsync(10)
}

/** The server enqueues the shell's notice, wakes the root to take it in, and the root answers (p20 order). */
function noticeTurn(
  run: ReturnType<typeof startWindowedRun>,
  shellId = SHELL,
  state = 'completed',
  inbox = 'msg_shell',
) {
  // The process has ended by the time its notice is sent, so the server no longer lists it as running.
  run.shellServer.shells[shellId] = {status: 'exited', owner: ROOT}
  run.emit(
    frames.shellExited(shellId),
    frames.shellNotice(shellId, state, inbox),
    frames.started(),
    frames.delivered(inbox),
    frames.delta('The shell finished.', ROOT, 0, 'msg_followup'),
    frames.succeeded(),
  )
}

afterEach(() => {
  vi.useRealTimers()
})

describe('runOpenCodeCoreV2: adopting a background shell', () => {
  it('adopts a shell of the root when it is created, keyed apart from sessions', async () => {
    // #given
    const ledger = createOwnershipLedger()
    const onOwnershipChange = vi.fn()
    const run = startWindowedRun({ownershipLedger: ledger, onOwnershipChange, shellServer: RUNNING_SHELL})
    await vi.advanceTimersByTimeAsync(10)

    // #when — only the creation frame has arrived
    run.emit(frames.started(), frames.shellCreated(SHELL))
    await vi.advanceTimersByTimeAsync(10)

    // #then — in the ledger, never registered as a session, never persisted as one
    expect(states(ledger)).toEqual({[SHELL_KEY]: 'outstanding'})
    expect(run.coordinator.addOwnedSession).not.toHaveBeenCalledWith(SHELL_KEY)
    expect(run.coordinator.addOwnedSession).not.toHaveBeenCalledWith(SHELL)
    expect(onOwnershipChange).toHaveBeenLastCalledWith({rootSessionId: ROOT, ownedSessionIds: []})
    run.close()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)
  })

  it('adopts a shell moved to the background, whose creation frame the run never saw', async () => {
    // #given — a foreground call that the user moved to the background: only its `running` result arrives
    const ledger = createOwnershipLedger()
    const run = startWindowedRun({ownershipLedger: ledger, shellServer: RUNNING_SHELL})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(
      frames.started(),
      frames.toolStarted('shell', 'call_fg'),
      frames.toolCalled('call_fg', {command: 'make test'}),
      frames.shellBackgrounded('call_fg', SHELL),
    )
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(states(ledger)).toEqual({[SHELL_KEY]: 'outstanding'})
    run.close()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)
  })

  it('adopts a shell once however many signals name it', async () => {
    // #given
    const ledger = createOwnershipLedger()
    const onOwnershipChange = vi.fn()
    const run = startWindowedRun({ownershipLedger: ledger, onOwnershipChange, shellServer: RUNNING_SHELL})
    await vi.advanceTimersByTimeAsync(10)

    // #when — created, then the same shell's backgrounded result, then created again
    await backgroundAndIdle(run)
    const changes = onOwnershipChange.mock.calls.length
    run.emit(frames.shellCreated(SHELL))
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(ledger.snapshot()).toHaveLength(1)
    expect(onOwnershipChange.mock.calls.length).toBe(changes)
    run.close()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)
  })

  it('adopts the shell of an owned child, and not the shell of a session this run does not own', async () => {
    // #given — a dispatched child
    const ledger = createOwnershipLedger()
    const run = startWindowedRun({
      ownershipLedger: ledger,
      active: [CHILD],
      children: [CHILD],
      shellServer: {shells: {[SHELL]: {status: 'running', owner: CHILD}}},
    })
    await vi.advanceTimersByTimeAsync(10)
    run.emit(
      frames.started(),
      frames.toolStarted('subagent', 'call_dispatch'),
      frames.dispatch(CHILD),
      frames.succeeded(),
    )
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(frames.shellCreated(SHELL, CHILD), frames.shellCreated(OTHER_SHELL, STRANGER))
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(states(ledger)).toEqual({[CHILD]: 'outstanding', [SHELL_KEY]: 'outstanding'})
    run.close()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)
  })

  it('does not adopt a shell nobody tagged, nor the shell of a user-run command', async () => {
    // #given
    const ledger = createOwnershipLedger()
    const run = startWindowedRun({ownershipLedger: ledger})
    await vi.advanceTimersByTimeAsync(10)

    // #when — `POST /api/shell` has no owner tag; `POST /api/session/:id/shell` is awaited and sends no job notice
    run.emit(
      frames.started(),
      {...frames.shellCreated(SHELL), data: {info: {...frames.shellCreated(SHELL).data.info, metadata: {}}}},
      frames.shellCreated(OTHER_SHELL, ROOT, {background: true}),
      frames.succeeded(),
    )
    await vi.advanceTimersByTimeAsync(1_000)

    // #then — nothing owned, so once the directory stays quiet the root's success completes the run
    expect(ledger.snapshot()).toEqual([])
    expect(succeeded(run)).toBe(true)
  })

  it('releases a foreground shell when its call ends, so the root completes on its own success', async () => {
    // #given — created (adopted) and then finished inside its call: no notice will ever come for it
    const ledger = createOwnershipLedger()
    const run = startWindowedRun({ownershipLedger: ledger})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(
      frames.started(),
      frames.toolStarted('shell', 'call_fg'),
      frames.toolCalled('call_fg', {command: 'ls'}),
      frames.shellCreated(SHELL),
      frames.shellProgress('call_fg', SHELL),
      frames.shellForegroundDone('call_fg', SHELL),
      frames.succeeded(),
    )
    await vi.advanceTimersByTimeAsync(1_000)

    // #then
    expect(ledger.snapshot()).toEqual([])
    expect(succeeded(run)).toBe(true)
  })

  it('releases a foreground shell whose call failed and kept no shell id, from the progress frame', async () => {
    // #given
    const ledger = createOwnershipLedger()
    const run = startWindowedRun({ownershipLedger: ledger})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(
      frames.started(),
      frames.toolStarted('shell', 'call_fg'),
      frames.shellCreated(SHELL),
      frames.shellProgress('call_fg', SHELL),
      frames.toolFailed('call_fg'),
      frames.succeeded(),
    )
    await vi.advanceTimersByTimeAsync(1_000)

    // #then
    expect(ledger.snapshot()).toEqual([])
    expect(succeeded(run)).toBe(true)
  })

  it('does not release a backgrounded shell', async () => {
    // #given / #when
    const ledger = createOwnershipLedger()
    const run = startWindowedRun({ownershipLedger: ledger, shellServer: RUNNING_SHELL})
    await vi.advanceTimersByTimeAsync(10)
    await backgroundAndIdle(run)

    // #then
    expect(states(ledger)).toEqual({[SHELL_KEY]: 'outstanding'})
    run.close()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)
  })
})

describe('runOpenCodeCoreV2: draining a background shell', () => {
  it("waits for a running shell: the root's first success is not terminal", async () => {
    // #given
    const ledger = createOwnershipLedger()
    const onBusy = vi.fn()
    const run = startWindowedRun({ownershipLedger: ledger, onBusy, runId: 'run-shell', shellServer: RUNNING_SHELL})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    await backgroundAndIdle(run)
    await vi.advanceTimersByTimeAsync(5_000)

    // #then — still running, not busy, waiting on the ledger
    expect(run.outcome()).toBeUndefined()
    expect(onBusy).toHaveBeenLastCalledWith(false)
    expect(getWaitReason('run-shell')).toBe('ledger-not-drained')
    run.close()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)
  })

  it.each([
    ['exit before notice (p20)', true],
    ['notice before exit (p22)', false],
  ])('completes after the shell notice and the woken root turn: %s', async (_label, exitFirst) => {
    // #given — the shell runs while the root sits idle
    const ledger = createOwnershipLedger()
    const run = startWindowedRun({ownershipLedger: ledger, active: [], shellServer: RUNNING_SHELL})
    await vi.advanceTimersByTimeAsync(10)
    await backgroundAndIdle(run)
    expect(run.outcome()).toBeUndefined()

    // #when
    if (exitFirst) {
      noticeTurn(run)
    } else {
      run.shellServer.shells[SHELL] = {status: 'exited', owner: ROOT}
      run.emit(
        frames.shellNotice(SHELL, 'completed', 'msg_shell'),
        frames.shellExited(SHELL),
        frames.started(),
        frames.delivered('msg_shell'),
        frames.delta('The shell finished.', ROOT, 0, 'msg_followup'),
        frames.succeeded(),
      )
    }
    await vi.advanceTimersByTimeAsync(2_000)

    // #then — one reply carrying the follow-up, the shell settled by its notice, nothing killed or interrupted
    expect(succeeded(run)).toBe(true)
    expect(run.sink.text()).toContain('Started it.')
    expect(run.sink.text()).toContain('The shell finished.')
    expect(states(ledger)).toEqual({[SHELL_KEY]: 'settled'})
    expect(run.interrupt).not.toHaveBeenCalled()
    expect(run.shellServer.deleteShell).not.toHaveBeenCalled()
  })

  it('completes on a DELETEd shell’s error notice as it does on a completed one (p22)', async () => {
    // #given
    const ledger = createOwnershipLedger()
    const run = startWindowedRun({ownershipLedger: ledger, active: [], shellServer: RUNNING_SHELL})
    await vi.advanceTimersByTimeAsync(10)
    await backgroundAndIdle(run)

    // #when
    noticeTurn(run, SHELL, 'error', 'msg_err')
    await vi.advanceTimersByTimeAsync(2_000)

    // #then
    expect(succeeded(run)).toBe(true)
    expect(states(ledger)).toEqual({[SHELL_KEY]: 'settled'})
  })

  it('does not complete on a notice alone: the root must run the turn that takes it in', async () => {
    // #given
    const ledger = createOwnershipLedger()
    const run = startWindowedRun({ownershipLedger: ledger, active: [], shellServer: RUNNING_SHELL})
    await vi.advanceTimersByTimeAsync(10)
    await backgroundAndIdle(run)

    // #when — queued, not delivered
    run.emit(frames.shellExited(SHELL), frames.shellNotice(SHELL))
    await vi.advanceTimersByTimeAsync(5_000)

    // #then
    expect(run.outcome()).toBeUndefined()
    expect(states(ledger)).toEqual({[SHELL_KEY]: 'settled'})
    run.close()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)
  })

  it('waits for every shell: one notice of two does not complete the run', async () => {
    // #given — two shells
    const ledger = createOwnershipLedger()
    const run = startWindowedRun({
      ownershipLedger: ledger,
      active: [],
      shellServer: {
        shells: {[SHELL]: {status: 'running', owner: ROOT}, [OTHER_SHELL]: {status: 'running', owner: ROOT}},
      },
    })
    await vi.advanceTimersByTimeAsync(10)
    await backgroundAndIdle(run, SHELL, 'call_a')
    run.emit(
      frames.started(),
      frames.toolStarted('shell', 'call_b'),
      frames.shellCreated(OTHER_SHELL),
      frames.shellBackgrounded('call_b', OTHER_SHELL),
      frames.succeeded(),
    )
    await vi.advanceTimersByTimeAsync(10)

    // #when — the first ends and its turn runs
    noticeTurn(run, SHELL, 'completed', 'msg_a')
    await vi.advanceTimersByTimeAsync(2_000)

    // #then
    expect(run.outcome()).toBeUndefined()
    expect(states(ledger)).toEqual({[SHELL_KEY]: 'settled', [OTHER_SHELL_KEY]: 'outstanding'})

    // #when — the second ends
    noticeTurn(run, OTHER_SHELL, 'completed', 'msg_b')
    await vi.advanceTimersByTimeAsync(2_000)

    // #then
    expect(succeeded(run)).toBe(true)
  })

  it('ignores a user shell command’s notice: it carries no jobID and settles nothing', async () => {
    // #given
    const ledger = createOwnershipLedger()
    const run = startWindowedRun({ownershipLedger: ledger, active: [], shellServer: RUNNING_SHELL})
    await vi.advanceTimersByTimeAsync(10)
    await backgroundAndIdle(run)

    // #when
    run.emit(frames.userShellNotice(), frames.started(), frames.delivered('msg_user_shell'), frames.succeeded())
    await vi.advanceTimersByTimeAsync(5_000)

    // #then
    expect(states(ledger)).toEqual({[SHELL_KEY]: 'outstanding'})
    expect(run.outcome()).toBeUndefined()
    run.close()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)
  })

  it('does not let a notice from another session settle the shell', async () => {
    // #given
    const ledger = createOwnershipLedger()
    const run = startWindowedRun({ownershipLedger: ledger, active: [], shellServer: RUNNING_SHELL})
    await vi.advanceTimersByTimeAsync(10)
    await backgroundAndIdle(run)

    // #when — a stranger's session gets a notice that names this run's shell
    run.emit(frames.shellNotice(SHELL, 'completed', 'msg_x', STRANGER))
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(states(ledger)).toEqual({[SHELL_KEY]: 'outstanding'})
    run.close()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)
  })

  it('fences a shell whose notice cannot be read: unknown, not settled, and the gate stops waiting for a readable one', async () => {
    // #given — the shell ended; the server sends a job notice this client cannot read
    const ledger = createOwnershipLedger()
    const run = startWindowedRun({ownershipLedger: ledger, active: [], shellServer: RUNNING_SHELL})
    await vi.advanceTimersByTimeAsync(10)
    await backgroundAndIdle(run)
    run.shellServer.shells[SHELL] = {status: 'exited', owner: ROOT}

    // #when
    run.emit({
      type: 'session.inbox.enqueued',
      data: {
        inboxID: 'msg_bad',
        sessionID: ROOT,
        item: {
          type: 'synthetic',
          payload: {text: 'x', metadata: {source: 'shell', shellID: SHELL, jobID: SHELL, state: 'paused'}},
          delivery: 'steer',
        },
      },
    })
    await vi.advanceTimersByTimeAsync(10)

    // #then — never settled by the notice itself
    expect(states(ledger)).toEqual({[SHELL_KEY]: 'unknown'})

    // #when — reconciliation sees the shell stop, and the turn that follows ends
    await vi.advanceTimersByTimeAsync(31_000)
    run.emit(frames.started(), frames.succeeded())
    await vi.advanceTimersByTimeAsync(2_000)

    // #then
    expect(states(ledger)).toEqual({[SHELL_KEY]: 'settled'})
    expect(succeeded(run)).toBe(true)
  })

  it('fails the run on a shell.created of an owned session that cannot be read: a writer nobody can wait for', async () => {
    // #given
    const ledger = createOwnershipLedger()
    const run = startWindowedRun({ownershipLedger: ledger})
    await vi.advanceTimersByTimeAsync(10)

    // #when — no shell id, but the owner tag is readable
    run.emit(frames.started(), {
      type: 'shell.created',
      data: {info: {status: 'running', metadata: {sessionID: ROOT}}},
    })
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then
    expect(failure(run).kind).toBe('session-error')
  })
})

describe('runOpenCodeCoreV2: reconciling a background shell', () => {
  it('settles a shell the server shows is gone, and releases on the directory without waiting for its notice', async () => {
    // #given — adopted, never noticed; the server no longer lists it as running and reads it as exited
    const ledger = createOwnershipLedger()
    const run = startWindowedRun({
      ownershipLedger: ledger,
      active: [],
      runId: 'run-shell-gone',
      shellServer: {shells: {[SHELL]: {status: 'exited', owner: ROOT}}},
    })
    await vi.advanceTimersByTimeAsync(10)

    // #when
    await backgroundAndIdle(run)
    await vi.advanceTimersByTimeAsync(2_000)

    // #then — the idle-time pass settled it, and the quiet directory is what releases the run: no notice was awaited
    expect(states(ledger)).toEqual({[SHELL_KEY]: 'settled'})
    expect(succeeded(run)).toBe(true)
    expect(getWaitReason('run-shell-gone')).toBeUndefined()
  })

  it('keeps a shell unknown when the server cannot be read', async () => {
    // #given
    const ledger = createOwnershipLedger()
    const run = startWindowedRun({ownershipLedger: ledger, active: [], shellServer: {shells: {}, listFails: true}})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    await backgroundAndIdle(run)
    await vi.advanceTimersByTimeAsync(2_000)

    // #then — never settled on a failed read, and the run does not complete
    expect(states(ledger)).toEqual({[SHELL_KEY]: 'unknown'})
    expect(run.outcome()).toBeUndefined()
    run.close()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)
  })

  it('reconciles on the periodic tick as well as on root idle', async () => {
    // #given — the shell was still running at idle
    const ledger = createOwnershipLedger()
    const shellServer = {shells: {[SHELL]: {status: 'running' as const, owner: ROOT}}}
    const run = startWindowedRun({ownershipLedger: ledger, active: [], shellServer})
    await vi.advanceTimersByTimeAsync(10)
    await backgroundAndIdle(run)
    expect(states(ledger)).toEqual({[SHELL_KEY]: 'outstanding'})

    // #when — it exits quietly, and the interval elapses
    run.shellServer.shells[SHELL] = {status: 'exited', owner: ROOT}
    await vi.advanceTimersByTimeAsync(31_000)

    // #then
    expect(states(ledger)).toEqual({[SHELL_KEY]: 'settled'})
    run.close()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)
  })
})

/** Index of the first call that starts with `prefix`, or -1. */
function firstIndex(log: readonly string[], prefix: string): number {
  return log.findIndex(entry => entry.startsWith(prefix))
}

/**
 * A run whose DELETE of a shell queues the error notice that wakes the shell's owner, as the server does (probe p22).
 * `rootStops` says whether the interrupt that follows can stop the woken root.
 */
async function runWithShell(
  options: StartOptions & {readonly rootStops?: boolean; readonly owner?: string | null} = {},
) {
  const log: string[] = []
  const {rootStops = true, owner = ROOT, ...rest} = options
  const run: ReturnType<typeof startWindowedRun> = startWindowedRun({
    ownershipLedger: createOwnershipLedger(),
    shellServer: {
      shells: {[SHELL]: {status: 'running', owner}},
      log,
      onDelete: (_id, killed) => {
        if (killed.owner !== null) run.activeSet.add(killed.owner)
      },
    },
    interrupt: async sessionId => {
      log.push(`interrupt-reply:${sessionId}`)
      if (rootStops) run.activeSet.delete(sessionId)
      return ok({interrupted: true})
    },
    ...rest,
  })
  await vi.advanceTimersByTimeAsync(10)
  return {run, log}
}

describe('runOpenCodeCoreV2: stopping with a background shell in the directory', () => {
  it.each([
    ['the deadline while draining', 'drain-timeout'],
    ['an operator cancel mid-turn', 'timeout'],
  ] as const)(
    'on %s: deletes the shell before the root is interrupted, and releases once the woken root stays stopped',
    async (label, kind) => {
      // #given — the root backgrounded a shell and is draining (deadline) or still working (cancel)
      const controller = new AbortController()
      const {run, log} = await runWithShell({controller, active: []})
      if (kind === 'drain-timeout') {
        await backgroundAndIdle(run)
      } else {
        run.emit(
          frames.started(),
          frames.toolStarted('shell', 'call_shell'),
          frames.shellCreated(SHELL),
          frames.shellBackgrounded('call_shell', SHELL),
          frames.toolStarted('read', 'call_read'),
        )
        run.activeSet.add(ROOT)
        await vi.advanceTimersByTimeAsync(10)
      }
      log.length = 0

      // #when
      controller.abort(label === 'the deadline while draining' ? undefined : 'operator cancel')
      await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

      // #then — the DELETE comes first; the root it woke was interrupted afterwards; the directory then stayed quiet
      const error = failure(run)
      expect(error.kind).toBe(kind)
      expect(error.quarantined).toBe(false)
      expect(firstIndex(log, `delete:${SHELL}`)).toBeGreaterThanOrEqual(0)
      expect(firstIndex(log, `interrupt:${ROOT}`)).toBeGreaterThan(firstIndex(log, `delete:${SHELL}`))
      expect(run.shellServer.shells[SHELL]).toBeUndefined()
    },
  )

  it('on a provider failure: deletes the shell before the root is interrupted, and releases once the woken root stays stopped', async () => {
    // #given
    const {run, log} = await runWithShell({active: []})
    run.emit(frames.started(), frames.shellCreated(SHELL), frames.shellBackgrounded('call_shell', SHELL))
    await vi.advanceTimersByTimeAsync(10)
    log.length = 0

    // #when — the root's execution fails
    run.emit(frames.failed(ROOT, {type: 'provider.auth', message: 'bad key', status: 401}))
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then
    const error = failure(run)
    expect(error.kind).toBe('session-error')
    expect(error.quarantined).toBe(false)
    expect(firstIndex(log, `interrupt:${ROOT}`)).toBeGreaterThan(firstIndex(log, `delete:${SHELL}`))
  })

  it('quarantines when the root a DELETE woke cannot be stopped, and keeps interrupting through the hold', async () => {
    // #given — probe A: a shell of the root, a wall-clock failure, and a root that ignores every interrupt
    const controller = new AbortController()
    const {run, log} = await runWithShell({controller, active: [], rootStops: false})
    run.emit(frames.started())
    await vi.advanceTimersByTimeAsync(10)

    // #when
    controller.abort()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)
    const interruptsAtQuarantine = run.interrupt.mock.calls.length

    // #then
    const error = failure(run)
    expect(error.kind).toBe('timeout')
    expect(error.quarantined).toBe(true)
    expect(firstIndex(log, `delete:${SHELL}`)).toBeGreaterThanOrEqual(0)
    expect(interruptsAtQuarantine).toBeGreaterThan(1)

    // #when — the hold goes on
    await vi.advanceTimersByTimeAsync(5_000)

    // #then — the watch keeps interrupting
    expect(run.interrupt.mock.calls.length).toBeGreaterThan(interruptsAtQuarantine)
  })

  it('deletes a shell of the directory that no session of the run owns', async () => {
    // #given — an untagged shell: nobody can say whose it is, and nothing else shares the checkout
    const controller = new AbortController()
    const {run, log} = await runWithShell({controller, active: [], owner: null})
    run.emit(frames.started())
    await vi.advanceTimersByTimeAsync(10)

    // #when
    controller.abort()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then
    expect(firstIndex(log, `delete:${SHELL}`)).toBeGreaterThanOrEqual(0)
    expect(run.shellServer.shells[SHELL]).toBeUndefined()
  })

  it('quarantines when the shell survives its DELETE, and keeps deleting through the hold', async () => {
    // #given — the server accepts every DELETE and kills nothing
    const controller = new AbortController()
    const run = startWindowedRun({
      controller,
      active: [],
      ownershipLedger: createOwnershipLedger(),
      shellServer: {shells: {[SHELL]: {status: 'running', owner: ROOT}}, deleteDoesNotKill: [SHELL], log: []},
    })
    await vi.advanceTimersByTimeAsync(100)
    run.emit(frames.started())
    await vi.advanceTimersByTimeAsync(10)

    // #when
    controller.abort()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)
    const deletesAtQuarantine = run.shellServer.deleteShell.mock.calls.length
    await vi.advanceTimersByTimeAsync(5_000)

    // #then
    expect(failure(run).quarantined).toBe(true)
    expect(deletesAtQuarantine).toBeGreaterThanOrEqual(1)
    expect(run.shellServer.deleteShell.mock.calls.length).toBeGreaterThan(deletesAtQuarantine)
  })

  it('keeps the quarantine watch open after a stop it could not confirm: a late shell is deleted', async () => {
    // #given — quarantined because the woken root cannot be stopped
    const controller = new AbortController()
    const {run} = await runWithShell({controller, active: [], rootStops: false})
    run.emit(frames.started())
    await vi.advanceTimersByTimeAsync(10)
    controller.abort()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)
    expect(failure(run).quarantined).toBe(true)
    const deletesBefore = run.shellServer.deleteShell.mock.calls.length

    // #when — a new shell starts well into the hold
    run.shellServer.shells[OTHER_SHELL] = {status: 'running', owner: ROOT}
    await vi.advanceTimersByTimeAsync(5_000)

    // #then
    expect(run.shellServer.deleteShell.mock.calls.length).toBeGreaterThan(deletesBefore)
    expect(run.shellServer.shells[OTHER_SHELL]).toBeUndefined()
  })

  it('quarantines when a late shell stalls the window past the barrier bound, and the watch starts (the final-sweep case)', async () => {
    // #given — a stop that finds nothing at first
    const controller = new AbortController()
    const {run} = await runWithShell({controller, active: []})
    run.shellServer.shells[SHELL] = {status: 'exited', owner: ROOT}
    run.emit(frames.started())
    await vi.advanceTimersByTimeAsync(10)

    // #when — the stop begins, and shells that survive their DELETE keep appearing for the whole barrier bound
    controller.abort()
    const keepStarting = setInterval(() => {
      run.shellServer.shells[`sh_late_${String(Date.now())}`] = {status: 'running', owner: ROOT}
    }, 300)
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)
    clearInterval(keepStarting)

    // #then — unconfirmed, quarantined, and the watch deleted what showed up afterwards
    expect(failure(run).quarantined).toBe(true)
    const deletesAtQuarantine = run.shellServer.deleteShell.mock.calls.length
    run.shellServer.shells.sh_after = {status: 'running', owner: ROOT}
    await vi.advanceTimersByTimeAsync(2_000)
    expect(run.shellServer.deleteShell.mock.calls.length).toBeGreaterThan(deletesAtQuarantine)
  })

  it('makes no shell DELETE when no shell is in the directory', async () => {
    // #given
    const controller = new AbortController()
    const run = startWindowedRun({controller, ownershipLedger: createOwnershipLedger(), active: []})
    await vi.advanceTimersByTimeAsync(100)

    // #when
    controller.abort()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then
    expect(run.shellServer.deleteShell).not.toHaveBeenCalled()
    expect(failure(run).quarantined).toBe(false)
  })

  it('quarantines a shell that is still running when the deadline hits after a settled reconcile, notice or not', async () => {
    // #given — reconcile settled the shell (gone from the server), its notice never arrived, then the root's turn fails
    const run = startWindowedRun({
      ownershipLedger: createOwnershipLedger(),
      active: [],
      shellServer: {shells: {[SHELL]: {status: 'exited', owner: ROOT}}},
    })
    await vi.advanceTimersByTimeAsync(10)
    await backgroundMidTurn(run)
    await vi.advanceTimersByTimeAsync(31_000)

    // #when — the root's turn fails before the notice shows
    run.emit(frames.failed(ROOT, {type: 'provider.auth', message: 'bad key', status: 401}))
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then — nothing runs in the directory, so the stop releases: the notice is not what decides
    const error = failure(run)
    expect(error.kind).toBe('session-error')
    expect(error.quarantined).toBe(false)
  })

  it('does not quarantine a provider failure once the shell notice has been observed', async () => {
    // #given
    const run = startWindowedRun({
      ownershipLedger: createOwnershipLedger(),
      active: [],
      shellServer: {shells: {[SHELL]: {status: 'exited', owner: ROOT}}},
    })
    await vi.advanceTimersByTimeAsync(10)
    await backgroundMidTurn(run)

    // #when
    run.emit(
      frames.shellExited(SHELL),
      frames.shellNotice(SHELL),
      frames.delivered('msg_shell'),
      frames.failed(ROOT, {type: 'provider.auth', message: 'bad key', status: 401}),
    )
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then
    const error = failure(run)
    expect(error.kind).toBe('session-error')
    expect(error.quarantined).toBe(false)
    expect(run.shellServer.deleteShell).not.toHaveBeenCalled()
  })

  it('does not release on a child’s shell whose creation frame was dropped (child not adopted yet) while it runs', async () => {
    // #given — the child's shell is created before the dispatch result adopts the child, so the loop ignores it
    const ledger = createOwnershipLedger()
    const run = startWindowedRun({
      ownershipLedger: ledger,
      active: [],
      children: [CHILD],
      shellServer: {shells: {[SHELL]: {status: 'running', owner: CHILD}}},
    })
    await vi.advanceTimersByTimeAsync(10)
    run.emit(
      frames.started(),
      frames.shellCreated(SHELL, CHILD),
      frames.toolStarted('subagent', 'call_dispatch'),
      frames.dispatch(CHILD),
      frames.succeeded(),
    )
    await vi.advanceTimersByTimeAsync(10)
    expect(Object.keys(states(ledger))).toEqual([CHILD])

    // #when — the child ends and the root takes its notice in; everything the ledger tracks is done
    run.emit(
      frames.notice(CHILD, 'completed', 'msg_notice'),
      frames.started(),
      frames.delivered('msg_notice'),
      frames.succeeded(),
    )
    await vi.advanceTimersByTimeAsync(5_000)

    // #then — the server still lists the shell, so the run keeps draining
    expect(states(ledger)).toEqual({[CHILD]: 'settled'})
    expect(run.outcome()).toBeUndefined()

    // #when — the shell stops
    run.shellServer.shells[SHELL] = {status: 'exited', owner: CHILD}
    await vi.advanceTimersByTimeAsync(3_000)

    // #then
    expect(succeeded(run)).toBe(true)
  })

  it('does not release a REST-discovered shell that disappears, then a wake inside the window', async () => {
    // #given — the shell was never adopted; it is listed, vanishes, and the root is woken 700 ms later
    const run = startWindowedRun({
      ownershipLedger: createOwnershipLedger(),
      active: [],
      shellServer: {shells: {[SHELL]: {status: 'running', owner: CHILD}}},
      directoryStability: {requiredObservations: 3, minSpacingMs: 500, minSpanMs: 1_000},
    })
    await vi.advanceTimersByTimeAsync(10)
    run.emit(frames.started(), frames.succeeded())
    await vi.advanceTimersByTimeAsync(600)
    delete run.shellServer.shells[SHELL]

    // #when — the disappearance is followed by a wake of the root inside the quiet window
    await vi.advanceTimersByTimeAsync(700)
    run.emit(frames.started())
    run.activeSet.add(ROOT)
    await vi.advanceTimersByTimeAsync(1_500)

    // #then — not released on the disappearance
    expect(run.outcome()).toBeUndefined()

    // #when — the woken turn ends and the directory stays quiet
    run.emit(frames.succeeded())
    await vi.advanceTimersByTimeAsync(5_000)

    // #then
    expect(succeeded(run)).toBe(true)
  })

  it('does not release while an awakened child that reconcile already settled is still active at the root’s success', async () => {
    // #given — the ledger settled the child, its shell's exit woke it, and the root succeeds meanwhile
    const ledger = createOwnershipLedger()
    const run = startWindowedRun({ownershipLedger: ledger, active: [], children: [CHILD]})
    await vi.advanceTimersByTimeAsync(10)
    run.emit(frames.started(), frames.toolStarted('subagent', 'call_dispatch'), frames.dispatch(CHILD))
    await vi.advanceTimersByTimeAsync(31_000)
    expect(states(ledger)).toEqual({[CHILD]: 'settled'})
    run.activeSet.add(CHILD)

    // #when
    run.emit(frames.succeeded())
    await vi.advanceTimersByTimeAsync(5_000)

    // #then — settled in the ledger, yet active in the directory: no release
    expect(run.outcome()).toBeUndefined()

    // #when — it stops
    run.activeSet.delete(CHILD)
    await vi.advanceTimersByTimeAsync(3_000)

    // #then
    expect(succeeded(run)).toBe(true)
  })

  it('a fatal move of an owned session always quarantines, even when the directory then stays quiet', async () => {
    // #given
    const run = startWindowedRun({ownershipLedger: createOwnershipLedger(), active: []})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(frames.moved(ROOT))
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then
    const error = failure(run)
    expect(error.kind).toBe('session-error')
    expect(error.quarantined).toBe(true)
  })
})
