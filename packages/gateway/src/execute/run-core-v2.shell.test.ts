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

import {createOwnershipLedger, shellLedgerKey} from '@fro-bot/runtime'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {CHILD, failure, frames, OTHER_SHELL, ROOT, SHELL, startRun, STRANGER, succeeded} from './run-core-v2.fixture.js'
import {getWaitReason} from './wait-reason-registry.js'

const SHELL_KEY = shellLedgerKey(SHELL)
const OTHER_SHELL_KEY = shellLedgerKey(OTHER_SHELL)
const RUNNING_SHELL: StartOptions['shellServer'] = {shells: {[SHELL]: {status: 'running', owner: ROOT}}}
const PAST_SETTLE_BOUND_MS = 20_000

function states(ledger: OwnershipLedger): Record<string, string> {
  return Object.fromEntries(ledger.snapshot().map(entry => [entry.sessionId, entry.state]))
}

/** The root backgrounds a shell (the p20 sequence) and finishes its first turn. */
async function backgroundAndIdle(run: ReturnType<typeof startRun>, shellId = SHELL, callId = 'call_shell') {
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
async function backgroundMidTurn(run: ReturnType<typeof startRun>, shellId = SHELL, callId = 'call_shell') {
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
function noticeTurn(run: ReturnType<typeof startRun>, shellId = SHELL, state = 'completed', inbox = 'msg_shell') {
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

/** Index of the first call that starts with `prefix`, or -1. */
function firstIndex(log: readonly string[], prefix: string): number {
  return log.findIndex(entry => entry.startsWith(prefix))
}

async function runningShellRun(options: StartOptions = {}) {
  const log: string[] = []
  const run = startRun({
    ownershipLedger: createOwnershipLedger(),
    shellServer: {shells: {[SHELL]: {status: 'running', owner: ROOT}}, log},
    ...options,
  })
  await vi.advanceTimersByTimeAsync(10)
  return {run, log}
}

afterEach(() => {
  vi.useRealTimers()
})

describe('runOpenCodeCoreV2: adopting a background shell', () => {
  it('adopts a shell of the root when it is created, keyed apart from sessions', async () => {
    // #given
    const ledger = createOwnershipLedger()
    const onOwnershipChange = vi.fn()
    const run = startRun({ownershipLedger: ledger, onOwnershipChange, shellServer: RUNNING_SHELL})
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
    const run = startRun({ownershipLedger: ledger, shellServer: RUNNING_SHELL})
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
    const run = startRun({ownershipLedger: ledger, onOwnershipChange, shellServer: RUNNING_SHELL})
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
    const run = startRun({
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
    const run = startRun({ownershipLedger: ledger})
    await vi.advanceTimersByTimeAsync(10)

    // #when — `POST /api/shell` has no owner tag; `POST /api/session/:id/shell` is awaited and sends no job notice
    run.emit(
      frames.started(),
      {...frames.shellCreated(SHELL), data: {info: {...frames.shellCreated(SHELL).data.info, metadata: {}}}},
      frames.shellCreated(OTHER_SHELL, ROOT, {background: true}),
      frames.succeeded(),
    )
    await vi.advanceTimersByTimeAsync(10)

    // #then — nothing owned, so the root's success completes the run
    expect(ledger.snapshot()).toEqual([])
    expect(succeeded(run)).toBe(true)
  })

  it('releases a foreground shell when its call ends, so the root completes on its own success', async () => {
    // #given — created (adopted) and then finished inside its call: no notice will ever come for it
    const ledger = createOwnershipLedger()
    const run = startRun({ownershipLedger: ledger})
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
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(ledger.snapshot()).toEqual([])
    expect(succeeded(run)).toBe(true)
  })

  it('releases a foreground shell whose call failed and kept no shell id, from the progress frame', async () => {
    // #given
    const ledger = createOwnershipLedger()
    const run = startRun({ownershipLedger: ledger})
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
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(ledger.snapshot()).toEqual([])
    expect(succeeded(run)).toBe(true)
  })

  it('does not release a backgrounded shell', async () => {
    // #given / #when
    const ledger = createOwnershipLedger()
    const run = startRun({ownershipLedger: ledger, shellServer: RUNNING_SHELL})
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
    const run = startRun({ownershipLedger: ledger, onBusy, runId: 'run-shell', shellServer: RUNNING_SHELL})
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
    const run = startRun({ownershipLedger: ledger, active: [], shellServer: RUNNING_SHELL})
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
    const run = startRun({ownershipLedger: ledger, active: [], shellServer: RUNNING_SHELL})
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
    const run = startRun({ownershipLedger: ledger, active: [], shellServer: RUNNING_SHELL})
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
    const run = startRun({
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
    const run = startRun({ownershipLedger: ledger, active: [], shellServer: RUNNING_SHELL})
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
    const run = startRun({ownershipLedger: ledger, active: [], shellServer: RUNNING_SHELL})
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
    const run = startRun({ownershipLedger: ledger, active: [], shellServer: RUNNING_SHELL})
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
    const run = startRun({ownershipLedger: ledger})
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
  it('settles a shell the server shows is gone, and still waits for its notice', async () => {
    // #given — adopted, never noticed; the server no longer lists it as running and reads it as exited
    const ledger = createOwnershipLedger()
    const run = startRun({
      ownershipLedger: ledger,
      active: [],
      runId: 'run-shell-gone',
      shellServer: {shells: {[SHELL]: {status: 'exited', owner: ROOT}}},
    })
    await vi.advanceTimersByTimeAsync(10)

    // #when
    await backgroundAndIdle(run)
    await vi.advanceTimersByTimeAsync(2_000)

    // #then — the idle-time pass settled it; admission still needs the notice
    expect(states(ledger)).toEqual({[SHELL_KEY]: 'settled'})
    expect(run.outcome()).toBeUndefined()
    expect(getWaitReason('run-shell-gone')).toBe('notice-not-observed')
    run.close()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)
  })

  it('keeps a shell unknown when the server cannot be read', async () => {
    // #given
    const ledger = createOwnershipLedger()
    const run = startRun({ownershipLedger: ledger, active: [], shellServer: {shells: {}, listFails: true}})
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
    const run = startRun({ownershipLedger: ledger, active: [], shellServer})
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

describe('runOpenCodeCoreV2: stopping with a background shell owned', () => {
  it('on the deadline while draining: DELETEs the shell before the root is interrupted, and quarantines', async () => {
    // #given — the root is idle and the run is draining on a shell that never exits
    const controller = new AbortController()
    const {run, log} = await runningShellRun({controller, active: []})
    await backgroundAndIdle(run)
    log.length = 0

    // #when — the wall-clock deadline
    controller.abort()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then — drain-timeout, the kill ahead of the root abort, the shell gone, the run quarantined
    const error = failure(run)
    expect(error.kind).toBe('drain-timeout')
    expect(error.quarantined).toBe(true)
    expect(firstIndex(log, `delete:${SHELL}`)).toBeGreaterThanOrEqual(0)
    expect(firstIndex(log, `delete:${SHELL}`)).toBeLessThan(firstIndex(log, `interrupt:${ROOT}`))
    expect(run.shellServer.shells[SHELL]).toBeUndefined()
  })

  it('on operator cancel mid-turn: DELETEs the shell before the root is interrupted, and quarantines', async () => {
    // #given — the root launched a shell and is still working
    const controller = new AbortController()
    const {run, log} = await runningShellRun({controller})
    run.emit(
      frames.started(),
      frames.toolStarted('shell', 'call_shell'),
      frames.shellCreated(SHELL),
      frames.shellBackgrounded('call_shell', SHELL),
      frames.toolStarted('read', 'call_read'),
    )
    await vi.advanceTimersByTimeAsync(10)
    log.length = 0

    // #when
    controller.abort('operator cancel')
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then
    const error = failure(run)
    expect(error.kind).toBe('timeout')
    expect(error.quarantined).toBe(true)
    expect(firstIndex(log, `delete:${SHELL}`)).toBeLessThan(firstIndex(log, `interrupt:${ROOT}`))
    expect(firstIndex(log, `delete:${SHELL}`)).toBeGreaterThanOrEqual(0)
  })

  it('on a provider failure: DELETEs the shell before the root is interrupted, and quarantines', async () => {
    // #given
    const {run, log} = await runningShellRun()
    run.emit(frames.started(), frames.shellCreated(SHELL), frames.shellBackgrounded('call_shell', SHELL))
    await vi.advanceTimersByTimeAsync(10)
    log.length = 0

    // #when — the root's execution fails
    run.emit(frames.failed(ROOT, {type: 'provider.auth', message: 'bad key', status: 401}))
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then — the kill is not skipped because the root itself had halted
    const error = failure(run)
    expect(error.kind).toBe('session-error')
    expect(error.quarantined).toBe(true)
    expect(firstIndex(log, `delete:${SHELL}`)).toBeGreaterThanOrEqual(0)
    expect(firstIndex(log, `delete:${SHELL}`)).toBeLessThan(firstIndex(log, `interrupt:${ROOT}`))
  })

  it('kills a shell the stream never reported when it belongs to the root', async () => {
    // #given — no ledger entry: the creation frame was lost
    const controller = new AbortController()
    const {run, log} = await runningShellRun({controller, ownershipLedger: createOwnershipLedger()})
    run.emit(frames.started())
    await vi.advanceTimersByTimeAsync(10)

    // #when
    controller.abort()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then
    expect(firstIndex(log, `delete:${SHELL}`)).toBeGreaterThanOrEqual(0)
    expect(run.shellServer.shells[SHELL]).toBeUndefined()
  })

  it('quarantines when the kill cannot be confirmed, and keeps deleting through the hold', async () => {
    // #given — the server accepts every DELETE and kills nothing
    const controller = new AbortController()
    const {run} = await runningShellRun({
      controller,
      active: [],
      shellServer: {
        shells: {[SHELL]: {status: 'running', owner: ROOT}},
        deleteDoesNotKill: [SHELL],
        log: [],
      },
    })
    await backgroundAndIdle(run)

    // #when
    controller.abort()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)
    const deletesAtQuarantine = run.shellServer.deleteShell.mock.calls.length

    // #then
    expect(failure(run).quarantined).toBe(true)
    expect(deletesAtQuarantine).toBeGreaterThanOrEqual(1)

    // #when — the hold goes on
    await vi.advanceTimersByTimeAsync(5_000)

    // #then — the watch re-issued the DELETE
    expect(run.shellServer.deleteShell.mock.calls.length).toBeGreaterThan(deletesAtQuarantine)
    expect(run.shellServer.shells[SHELL]).toBeDefined()
  })

  it('quarantines when the barrier deleted a shell the ledger never heard of: its error notice wakes the root', async () => {
    // #given — probe A: an owned running shell whose creation frame was lost, and a wall-clock failure
    const controller = new AbortController()
    const {run, log} = await runningShellRun({controller, active: []})
    run.emit(frames.started())
    await vi.advanceTimersByTimeAsync(10)

    // #when
    controller.abort()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then — killed, the root interrupted anyway, and the run quarantined rather than released
    expect(firstIndex(log, `delete:${SHELL}`)).toBeGreaterThanOrEqual(0)
    expect(firstIndex(log, `interrupt:${ROOT}`)).toBeGreaterThan(firstIndex(log, `delete:${SHELL}`))
    const error = failure(run)
    expect(error.kind).toBe('timeout')
    expect(error.quarantined).toBe(true)
  })

  it('keeps the quarantine watch open after the barrier deleted a shell: the woken root can start another', async () => {
    // #given — probe A, then a wall-clock failure; the root is confirmed stopped at once, but a DELETE woke it
    const controller = new AbortController()
    const {run} = await runningShellRun({controller, active: []})
    run.emit(frames.started())
    await vi.advanceTimersByTimeAsync(10)
    controller.abort()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)
    expect(failure(run).quarantined).toBe(true)
    const deletesBefore = run.shellServer.deleteShell.mock.calls.length

    // #when — the woken root starts a new shell well into the hold
    run.shellServer.shells[OTHER_SHELL] = {status: 'running', owner: ROOT}
    await vi.advanceTimersByTimeAsync(5_000)

    // #then — the watch is still sweeping and kills it
    expect(run.shellServer.deleteShell.mock.calls.length).toBeGreaterThan(deletesBefore)
    expect(run.shellServer.shells[OTHER_SHELL]).toBeUndefined()
  })

  it('quarantines a provider failure after reconcile settled a shell whose notice is still in flight', async () => {
    // #given — the shell is gone from the server, so reconcile settles it at the root idle; no notice has arrived
    const ledger = createOwnershipLedger()
    const run = startRun({
      ownershipLedger: ledger,
      active: [],
      shellServer: {shells: {[SHELL]: {status: 'exited', owner: ROOT}}},
    })
    await vi.advanceTimersByTimeAsync(10)
    await backgroundMidTurn(run)
    await vi.advanceTimersByTimeAsync(31_000)
    expect(states(ledger)).toEqual({[SHELL_KEY]: 'settled'})

    // #when — the root's turn fails before the notice shows
    run.emit(frames.failed(ROOT, {type: 'provider.auth', message: 'bad key', status: 401}))
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then — the notice can still wake the root, so the stop is not confirmed
    const error = failure(run)
    expect(error.kind).toBe('session-error')
    expect(error.quarantined).toBe(true)
  })

  it('quarantines a provider failure after reconcile settled a child whose notice is still in flight', async () => {
    // #given — the same for a background child (the round-1 residual)
    const ledger = createOwnershipLedger()
    const run = startRun({ownershipLedger: ledger, active: [], children: [CHILD]})
    await vi.advanceTimersByTimeAsync(10)
    run.emit(frames.started(), frames.toolStarted('subagent', 'call_dispatch'), frames.dispatch(CHILD))
    await vi.advanceTimersByTimeAsync(31_000)
    expect(states(ledger)).toEqual({[CHILD]: 'settled'})

    // #when
    run.emit(frames.failed(ROOT, {type: 'provider.auth', message: 'bad key', status: 401}))
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then
    expect(failure(run).quarantined).toBe(true)
  })

  it('does not quarantine a provider failure once the shell notice has been observed', async () => {
    // #given — the notice arrived and settled the shell, the woken root turn then fails; nothing is left running
    const ledger = createOwnershipLedger()
    const run = startRun({
      ownershipLedger: ledger,
      active: [],
      shellServer: {shells: {[SHELL]: {status: 'exited', owner: ROOT}}},
    })
    await vi.advanceTimersByTimeAsync(10)
    await backgroundMidTurn(run)

    // #when — the shell ends while the root works, and the root's turn then fails
    run.emit(
      frames.shellExited(SHELL),
      frames.shellNotice(SHELL),
      frames.delivered('msg_shell'),
      frames.failed(ROOT, {type: 'provider.auth', message: 'bad key', status: 401}),
    )
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then — the stop confirms: no notice is owed, and no shell was deleted
    const error = failure(run)
    expect(error.kind).toBe('session-error')
    expect(error.quarantined).toBe(false)
    expect(run.shellServer.deleteShell).not.toHaveBeenCalled()
  })

  it('treats an unreadable notice as accounted for, so the fence closes the follow-up window', async () => {
    // #given — the shell stopped, and its job notice cannot be read
    const ledger = createOwnershipLedger()
    const run = startRun({
      ownershipLedger: ledger,
      active: [],
      shellServer: {shells: {[SHELL]: {status: 'exited', owner: ROOT}}},
    })
    await vi.advanceTimersByTimeAsync(10)
    await backgroundMidTurn(run)
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
    await vi.advanceTimersByTimeAsync(31_000)

    // #when
    run.emit(frames.failed(ROOT, {type: 'provider.auth', message: 'bad key', status: 401}))
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then
    expect(failure(run).quarantined).toBe(false)
  })

  it('does not admit the drain while a child’s shell runs whose creation frame was dropped (child not adopted yet)', async () => {
    // #given — the child's shell is created before the dispatch result adopts the child, so the loop ignores it
    const ledger = createOwnershipLedger()
    const run = startRun({
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

  it('keeps deleting through the hold when only a shell the stream never reported is left running', async () => {
    // #given — nothing adopted, so no follow-up is open and the root confirms at once; a stray shell ignores the DELETE
    const controller = new AbortController()
    const run = startRun({
      controller,
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

    // #then — the root was confirmed, the shell was not: quarantined, and the watch went on deleting
    expect(failure(run).quarantined).toBe(true)
    expect(run.shellServer.deleteShell.mock.calls.length).toBeGreaterThan(deletesAtQuarantine)
  })

  it('makes no shell DELETE when no shell is owned', async () => {
    // #given
    const controller = new AbortController()
    const run = startRun({controller, ownershipLedger: createOwnershipLedger(), active: []})
    await vi.advanceTimersByTimeAsync(100)

    // #when
    controller.abort()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then
    expect(run.shellServer.deleteShell).not.toHaveBeenCalled()
    expect(failure(run).quarantined).toBe(false)
  })
})
