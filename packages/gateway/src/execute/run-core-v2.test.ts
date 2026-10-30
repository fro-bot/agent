/**
 * Behaviour of the OpenCode V2 execute+stream core: session, prompt, stream consumption, tool lines, failures.
 *
 * Drives the real `runOpenCodeCoreV2` loop with fake timers against a scripted event stream built from the captured
 * v2.2.0 frames (see `run-core-v2.fixture.ts`). Root stop, drain and approvals have their own files.
 */

import {ok} from '@fro-bot/runtime'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {
  authFailure,
  DIRECTORY,
  failure,
  frames,
  HEARTBEAT,
  makeCoordinator,
  ROOT,
  SERVER_CONNECTED,
  startRun,
  STRANGER,
  succeeded,
} from './run-core-v2.fixture.js'
import {EVENT_STREAM_CONNECT_TIMEOUT_MS} from './run-core.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('runOpenCodeCoreV2: a plain turn', () => {
  it('creates the session at the directory, prompts after the stream connects, and resolves on the root succeeding', async () => {
    // #given
    const run = startRun()

    // #when
    await vi.advanceTimersByTimeAsync(10)
    run.emit(frames.started(), frames.delta('all done'), frames.succeeded())
    await vi.advanceTimersByTimeAsync(10)

    // #then — one reply, streamed once
    expect(succeeded(run)).toBe(true)
    expect(run.sink.text()).toBe('all done')
    expect(run.client.createSession).toHaveBeenCalledWith(expect.objectContaining({directory: DIRECTORY}))
    expect(run.prompt).toHaveBeenCalledTimes(1)
    expect(run.prompt).toHaveBeenCalledWith(
      expect.objectContaining({sessionId: ROOT, text: 'Fix the bug please', directory: DIRECTORY}),
    )
    expect(run.coordinator.addOwnedSession).toHaveBeenCalledWith(ROOT)
    expect(run.interrupt).not.toHaveBeenCalled()
  })

  it('subscribes before it prompts and holds the prompt until server.connected is read', async () => {
    // #given — the server takes a while to announce the stream
    const order: string[] = []
    let release: (() => void) | undefined
    async function* delayed(): AsyncGenerator<object> {
      await new Promise<void>(resolve => {
        release = resolve
      })
      yield SERVER_CONNECTED
      await new Promise<void>(() => undefined)
    }
    const run = startRun({
      subscribeResult: async () => {
        order.push('subscribe')
        return {success: true, data: delayed()}
      },
      onPrompt: () => order.push('prompt'),
    })

    // #when — the connect frame has not arrived
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run.prompt).not.toHaveBeenCalled()
    release?.()
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(order).toEqual(['subscribe', 'prompt'])
  })

  it('fails as unreachable, and never prompts, when the stream does not connect in time', async () => {
    // #given
    const run = startRun({
      subscribeResult: async () => ({
        success: true,
        data: (async function* () {
          await new Promise<void>(() => undefined)
        })(),
      }),
    })

    // #when
    await vi.advanceTimersByTimeAsync(EVENT_STREAM_CONNECT_TIMEOUT_MS + 100)

    // #then
    expect(failure(run).kind).toBe('unreachable')
    expect(run.prompt).not.toHaveBeenCalled()
  })

  it('fails as unreachable when the first frame is not server.connected', async () => {
    // #given
    const run = startRun({
      subscribeResult: async () => ({
        success: true,
        data: (async function* () {
          yield frames.started()
        })(),
      }),
    })

    // #when
    await vi.advanceTimersByTimeAsync(100)

    // #then
    expect(failure(run).kind).toBe('unreachable')
    expect(run.prompt).not.toHaveBeenCalled()
  })

  it('refuses to run without a coordinator, before it creates a session', async () => {
    // #given / #when
    const {runOpenCodeCoreV2} = await import('./run-core-v2.js')
    const kit = await import('./run-core-v2.fixture.js')
    const client = startRun().client
    await vi.advanceTimersByTimeAsync(10)
    const createCalls = vi.mocked(client.createSession).mock.calls.length
    const attempt = runOpenCodeCoreV2({
      client,
      directory: DIRECTORY,
      promptText: 'x',
      sink: kit.makeSink(),
      signal: new AbortController().signal,
      logger: kit.makeLogger(),
    })

    // #then
    await expect(attempt).rejects.toMatchObject({kind: 'missing-coordinator'})
    expect(vi.mocked(client.createSession).mock.calls.length).toBe(createCalls)
  })

  it('fails with timeout before any call when the signal is already aborted', async () => {
    // #given
    const controller = new AbortController()
    controller.abort()

    // #when
    const run = startRun({controller})
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(failure(run).kind).toBe('timeout')
    expect(run.client.createSession).not.toHaveBeenCalled()
  })

  it('reports busy while it works and not busy once done', async () => {
    // #given
    const onBusy = vi.fn()
    const run = startRun({onBusy})

    // #when
    await vi.advanceTimersByTimeAsync(10)
    run.emit(frames.succeeded())
    await vi.advanceTimersByTimeAsync(100)

    // #then — busy while it works, not busy from the root's success on (waiting for the directory is not work)
    expect(onBusy.mock.calls.map(call => call[0] as boolean)).toEqual([true, false, false])
  })
})

describe('runOpenCodeCoreV2: attach failures', () => {
  it('maps a 401 on session create to auth', async () => {
    // #given
    const run = startRun({createSessionResult: async () => authFailure()})

    // #when
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(failure(run).kind).toBe('auth')
    expect(run.subscribe).not.toHaveBeenCalled()
  })

  it('maps a transport failure on session create to unreachable', async () => {
    // #given
    const run = startRun({
      createSessionResult: async () => ({success: false, error: {kind: 'network', message: 'down'}}),
    })

    // #when
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(failure(run).kind).toBe('unreachable')
  })

  it('maps a 401 on the event subscription to auth', async () => {
    // #given
    const run = startRun({subscribeResult: async () => authFailure()})

    // #when
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(failure(run).kind).toBe('auth')
    expect(run.prompt).not.toHaveBeenCalled()
  })

  it('maps a 401 on the prompt to auth, a server error to prompt-error and a transport failure to unreachable', async () => {
    // #given
    const auth = startRun({promptResult: async () => authFailure()})
    await vi.advanceTimersByTimeAsync(10)
    const rejected = startRun({promptResult: async () => ({success: false, error: {kind: 'http', status: 500}})})
    await vi.advanceTimersByTimeAsync(10)
    const down = startRun({promptResult: async () => ({success: false, error: {kind: 'network', message: 'x'}})})
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(failure(auth).kind).toBe('auth')
    expect(failure(rejected).kind).toBe('prompt-error')
    expect(failure(down).kind).toBe('unreachable')
  })

  it('never puts a credential or response text in the error message', async () => {
    // #given
    const run = startRun({createSessionResult: async () => authFailure()})

    // #when
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(failure(run).message).not.toMatch(/bearer|token|password/i)
  })
})

describe('runOpenCodeCoreV2: streaming the reply', () => {
  it('never lets reasoning text reach the reply', async () => {
    // #given
    const run = startRun()
    await vi.advanceTimersByTimeAsync(10)

    // #when — the captured reasoning frames carry the text "PRIVATE CHAIN OF THOUGHT" in a delta and in an end event
    run.emit(frames.started(), ...frames.reasoning(), frames.delta('answer'), frames.succeeded())
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(run.sink.text()).toBe('answer')
    expect(run.sink.text()).not.toContain('PRIVATE')
  })

  it('counts reasoning as activity, so a long think does not trip the inactivity timer', async () => {
    // #given
    const run = startRun({inactivityTimeoutMs: 5_000})
    await vi.advanceTimersByTimeAsync(10)

    // #when — reasoning keeps arriving inside each window
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(3_000)
      run.emit(...frames.reasoning())
    }
    run.emit(frames.delta('done'), frames.succeeded())
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(succeeded(run)).toBe(true)
  })

  it('separates text parts so they do not run together', async () => {
    // #given
    const run = startRun()
    await vi.advanceTimersByTimeAsync(10)

    // #when — two assistant text parts, as the captured text frames carry ordinals
    run.emit(
      frames.delta('First part.', ROOT, 0, 'msg_a'),
      frames.delta('Second part.', ROOT, 1, 'msg_a'),
      frames.succeeded(),
    )
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(run.sink.text()).toMatch(/First part\.\s+Second part\./)
  })

  it('appends a text part that arrived only as an end event, and never twice', async () => {
    // #given
    const run = startRun()
    await vi.advanceTimersByTimeAsync(10)

    // #when — one part streamed deltas and then ended; another only ended
    run.emit(
      frames.delta('streamed', ROOT, 0, 'msg_a'),
      frames.textEnded('streamed', ROOT, 0, 'msg_a'),
      frames.textEnded('whole', ROOT, 1, 'msg_a'),
      frames.succeeded(),
    )
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(run.sink.text().match(/streamed/g)).toHaveLength(1)
    expect(run.sink.text()).toContain('whole')
  })

  it('ignores text from a session this run does not own', async () => {
    // #given
    const run = startRun()
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(frames.delta('stranger text', STRANGER), frames.delta('mine'), frames.succeeded())
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(run.sink.text()).toBe('mine')
  })

  it("does not complete on another session's success", async () => {
    // #given
    const run = startRun()
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(frames.succeeded(STRANGER))
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(run.outcome()).toBeUndefined()
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })

  it('releases held whitespace to the sink on exit', async () => {
    // #given
    const run = startRun()
    await vi.advanceTimersByTimeAsync(10)

    // #when — a part whose only text so far is whitespace, then the turn ends
    run.emit(frames.delta('Hello', ROOT, 0, 'msg_a'), frames.delta('\n\n', ROOT, 1, 'msg_a'), frames.succeeded())
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(run.sink.text()).toContain('Hello')
  })
})

describe('runOpenCodeCoreV2: tool lines', () => {
  it('shows an essential direct tool once, with its command', async () => {
    // #given
    const onActivity = vi.fn()
    const run = startRun({onActivity})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(
      frames.toolStarted('shell', 'call_1'),
      frames.toolCalled('call_1', {command: 'bun test', description: 'Run tests'}),
      frames.toolSuccess('call_1'),
      frames.succeeded(),
    )
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(onActivity).toHaveBeenCalledTimes(1)
    expect(run.sink.text()).toContain('bun test')
  })

  it('hides a read-only tool that succeeded and shows one that failed', async () => {
    // #given
    const onActivity = vi.fn()
    const run = startRun({onActivity})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(
      frames.toolStarted('read', 'call_1'),
      frames.toolCalled('call_1', {filePath: '/a'}),
      frames.toolSuccess('call_1'),
      frames.toolStarted('read', 'call_2'),
      frames.toolCalled('call_2', {filePath: '/b'}),
      frames.toolFailed('call_2'),
      frames.succeeded(),
    )
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(onActivity).toHaveBeenCalledTimes(1)
  })

  it('summarizes the calls inside an execute call, each once, and not the wrapper', async () => {
    // #given — Code Mode: one execute call carries two inner calls, reported by progress and again by the result
    const onActivity = vi.fn()
    const run = startRun({onActivity})
    await vi.advanceTimersByTimeAsync(10)
    const running = [{tool: 'opencode.worktree_list', status: 'running'}]
    const half = [
      {tool: 'opencode.worktree_list', status: 'completed'},
      {tool: 'opencode.models', status: 'running'},
    ]
    const done = [
      {tool: 'opencode.worktree_list', status: 'completed'},
      {tool: 'opencode.models', status: 'completed'},
    ]

    // #when
    run.emit(
      frames.toolStarted('execute', 'call_x'),
      frames.toolCalled('call_x', {code: 'await tools.opencode.worktree_list({})'}),
      frames.executeProgress('call_x', running),
      frames.executeProgress('call_x', half),
      frames.executeProgress('call_x', done),
      frames.executeSuccess('call_x', done),
      frames.succeeded(),
    )
    await vi.advanceTimersByTimeAsync(10)

    // #then — two inner calls, two lines; the execute wrapper itself gets none
    expect(onActivity).toHaveBeenCalledTimes(2)
    const lines = onActivity.mock.calls.map(([summary]) => String(summary))
    expect(lines.some(line => line.includes('worktree_list'))).toBe(true)
    expect(lines.some(line => line.includes('models'))).toBe(true)
    expect(lines.some(line => line.includes('execute'))).toBe(false)
  })

  it('names an execute inner call that carries input, so the line says which tool ran', async () => {
    // #given — the real server reports each inner call with its input, and the generic renderer prints input alone
    const onActivity = vi.fn()
    const run = startRun({onActivity})
    await vi.advanceTimersByTimeAsync(10)
    const calls = [{tool: 'opencode.worktree_create', status: 'completed', input: {name: 'e2e-wt'}}]

    // #when
    run.emit(frames.toolStarted('execute', 'call_x'), frames.executeSuccess('call_x', calls), frames.succeeded())
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(onActivity).toHaveBeenCalledTimes(1)
    expect(String(onActivity.mock.calls[0]?.[0])).toContain('worktree_create')
  })

  it('shows an execute inner call that failed', async () => {
    // #given
    const onActivity = vi.fn()
    const run = startRun({onActivity})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(
      frames.toolStarted('execute', 'call_x'),
      frames.executeSuccess('call_x', [{tool: 'opencode.worktree_remove', status: 'error'}]),
      frames.succeeded(),
    )
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(onActivity).toHaveBeenCalledTimes(1)
    expect(run.sink.text()).toContain('worktree_remove')
  })

  it('keeps going when a tool line cannot be rendered', async () => {
    // #given — a hostile input shape
    const run = startRun()
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(
      frames.toolStarted('shell', 'call_1'),
      frames.toolCalled('call_1', {command: {nested: true}}),
      frames.toolSuccess('call_1'),
      frames.delta('still here'),
      frames.succeeded(),
    )
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(succeeded(run)).toBe(true)
    expect(run.sink.text()).toContain('still here')
  })

  it('treats tool progress as activity for the inactivity timer', async () => {
    // #given
    const run = startRun({inactivityTimeoutMs: 5_000})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(3_000)
      run.emit(frames.executeProgress('call_x', [{tool: 'opencode.models', status: 'running'}]))
    }
    run.emit(frames.succeeded())
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(succeeded(run)).toBe(true)
  })
})

describe('runOpenCodeCoreV2: failures the server reports', () => {
  it('fails the run on a root execution failure with a fixed reason and none of the upstream text', async () => {
    // #given — the captured failure carries an upstream response body
    const run = startRun()
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(frames.failed())
    await vi.advanceTimersByTimeAsync(20_000)

    // #then
    const error = failure(run)
    expect(error.kind).toBe('session-error')
    expect(error.providerFailureReason).toBe('session error')
    expect(error.message).not.toContain('secret upstream body')
    expect(error.message).not.toContain('boom')
  })

  it('labels an auth failure with the closed provider reason', async () => {
    // #given
    const run = startRun()
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(frames.failed(ROOT, {type: 'provider.auth', message: 'No auth available', status: 401}))
    await vi.advanceTimersByTimeAsync(20_000)

    // #then
    expect(failure(run).providerFailureReason).toBe('provider auth unavailable')
  })

  it('does not fail on a retry; the terminal event decides', async () => {
    // #given — the captured rate-limit retry
    const run = startRun()
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(frames.retry(), frames.delta('recovered'), frames.succeeded())
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(succeeded(run)).toBe(true)
  })

  it('fails the run when something else interrupts the root, but not when the run did it', async () => {
    // #given
    const other = startRun()
    await vi.advanceTimersByTimeAsync(10)
    const controller = new AbortController()
    const own = startRun({controller})
    await vi.advanceTimersByTimeAsync(10)

    // #when — another client interrupts one root; the run cancels the other and its own interrupt echoes back
    other.emit(frames.interrupted(ROOT, 'user'))
    controller.abort()
    own.emit(frames.interrupted(ROOT, 'user'))
    await vi.advanceTimersByTimeAsync(20_000)

    // #then — both end in a failure, but the first is a session error and the second a timeout (the run's own stop)
    expect(failure(other).kind).toBe('session-error')
    expect(failure(own).kind).toBe('timeout')
  })

  it('fails closed on a session move of an owned session and interrupts it where it now lives', async () => {
    // #given — the outside-checkout rules re-base on the destination after a move (probe P12). The session is stored
    // under its destination from then on, so the directory no longer places it.
    const run = startRun()
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(frames.moved(ROOT))
    await vi.advanceTimersByTimeAsync(20_000)

    // #then — never confirmed (the destination's shells cannot be seen from here), and still interrupted
    const error = failure(run)
    expect(error.kind).toBe('session-error')
    expect(error.quarantined).toBe(true)
    expect(run.interrupt).toHaveBeenCalledWith(expect.objectContaining({sessionId: ROOT}))
  })

  it('keeps interrupting a moved session through the quarantine hold while it stays active', async () => {
    // #given — the moved root keeps running at its destination and ignores the interrupt
    let rootBusy = true
    const run = startRun({
      activeReply: async (): Promise<Record<string, {readonly type: string}>> =>
        rootBusy ? {[ROOT]: {type: 'running'}} : {},
      interrupt: async () => ok({interrupted: true}),
    })
    await vi.advanceTimersByTimeAsync(10)
    run.emit(frames.moved(ROOT))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(failure(run).quarantined).toBe(true)
    const atQuarantine = run.interrupt.mock.calls.length

    // #when — the hold goes on
    await vi.advanceTimersByTimeAsync(5_000)

    // #then — the watch still reaches it, wherever the directory would place it
    expect(run.interrupt.mock.calls.length).toBeGreaterThan(atQuarantine)

    // #when — it stops
    rootBusy = false
    await vi.advanceTimersByTimeAsync(2_000)
    const atStop = run.interrupt.mock.calls.length
    await vi.advanceTimersByTimeAsync(5_000)

    // #then — nothing more is sent once it is off the active list
    expect(run.interrupt.mock.calls.length).toBe(atStop)
  })

  it('ignores a session move of a session it does not own', async () => {
    // #given
    const run = startRun()
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(frames.moved(STRANGER), frames.succeeded())
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(succeeded(run)).toBe(true)
  })

  it('fails closed on an unreadable permission ask for an owned session, rather than hanging on it', async () => {
    // #given — no request id, so no reply can ever be sent
    const run = startRun()
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit({type: 'permission.asked', data: {sessionID: ROOT, action: 'edit'}})
    await vi.advanceTimersByTimeAsync(20_000)

    // #then
    expect(failure(run).kind).toBe('session-error')
  })

  it('keeps going past an unreadable event that names no owned session', async () => {
    // #given
    const run = startRun()
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit({type: 'permission.asked', data: {sessionID: STRANGER}}, frames.succeeded())
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(succeeded(run)).toBe(true)
  })
})

describe('runOpenCodeCoreV2: the stream itself', () => {
  it('fails through the barrier when the stream is lost mid-run', async () => {
    // #given
    const run = startRun()
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.failStream(new Error('socket hang up'))
    await vi.advanceTimersByTimeAsync(20_000)

    // #then — the prompt keeps running server-side, so the root was interrupted and confirmed
    const error = failure(run)
    expect(error.kind).toBe('stream-ended')
    expect(run.interrupt).toHaveBeenCalledWith(expect.objectContaining({sessionId: ROOT}))
  })

  it('fails as stream-ended when the stream closes before the root finishes', async () => {
    // #given
    const run = startRun()
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)

    // #then
    expect(failure(run).kind).toBe('stream-ended')
    expect(run.interrupt).toHaveBeenCalled()
  })

  it('fails when a second server.connected shows the stream was replaced', async () => {
    // #given
    const run = startRun()
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(SERVER_CONNECTED)
    await vi.advanceTimersByTimeAsync(20_000)

    // #then
    expect(failure(run).kind).toBe('stream-ended')
  })

  it('fails as stream-ended through the barrier when nothing arrives for the silence window', async () => {
    // #given
    const run = startRun({streamSilenceTimeoutMs: 30_000})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    await vi.advanceTimersByTimeAsync(31_000)
    await vi.advanceTimersByTimeAsync(20_000)

    // #then
    expect(failure(run).kind).toBe('stream-ended')
    expect(run.interrupt).toHaveBeenCalled()
  })

  it('treats a heartbeat as a sign of life, so a quiet but live stream is not cut', async () => {
    // #given
    const run = startRun({streamSilenceTimeoutMs: 30_000})
    await vi.advanceTimersByTimeAsync(10)

    // #when — a heartbeat every 15 s for two minutes, then the turn ends
    for (let i = 0; i < 8; i += 1) {
      await vi.advanceTimersByTimeAsync(15_000)
      run.emit(HEARTBEAT)
    }
    run.emit(frames.succeeded())
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(succeeded(run)).toBe(true)
  })

  it('closes the event subscription on every exit', async () => {
    // #given
    const run = startRun()
    await vi.advanceTimersByTimeAsync(10)
    const signal = run.signalOfSubscription()

    // #when
    run.emit(frames.succeeded())
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(signal?.aborted).toBe(true)
  })
})

describe('runOpenCodeCoreV2: unrelated forms and approvals do not touch a plain run', () => {
  it('leaves a coordinator that was never asked alone', async () => {
    // #given
    const coordinator = makeCoordinator()
    const run = startRun({coordinator})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(frames.succeeded())
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(coordinator.onPermissionAsked).not.toHaveBeenCalled()
  })
})

describe('runOpenCodeCoreV2: a directory with the history of earlier runs', () => {
  it('releases without reading the inbox of a session from an earlier run, even one with an item queued', async () => {
    // #given — the workspace server keeps the sessions of every run; this one last changed an hour ago
    const run = startRun({
      active: [],
      oldSessions: ['ses_earlier'],
      shellServer: {shells: {}, inbox: {ses_earlier: 2}},
    })
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(frames.started(), frames.succeeded())
    await vi.advanceTimersByTimeAsync(1_000)

    // #then
    expect(run.outcome()).toEqual({ok: true})
    expect(run.shellServer.listSessionInbox).not.toHaveBeenCalledWith(
      expect.objectContaining({sessionId: 'ses_earlier'}),
    )
  })

  it('does not release while a session updated during the run has an item queued', async () => {
    // #given — a session of the directory (read as recent) with a notice queued and no wake yet
    const run = startRun({active: [], sessions: ['ses_recent'], shellServer: {shells: {}, inbox: {ses_recent: 1}}})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(frames.started(), frames.succeeded())
    await vi.advanceTimersByTimeAsync(3_000)

    // #then
    expect(run.outcome()).toBeUndefined()
    expect(run.shellServer.listSessionInbox).toHaveBeenCalledWith(expect.objectContaining({sessionId: 'ses_recent'}))
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })
})
