/**
 * Tests for the evidence a stopped root needs (`rootHasTerminalReply`), one probe of it (`probeRootStop`), and the
 * watch that keeps probing through a quarantine hold (`startQuarantineRootWatch`).
 */

import type {LedgerReconcileAdapter, SessionClient} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'

import {afterEach, describe, expect, it, vi} from 'vitest'

import {
  probeRootStop,
  QUARANTINE_HOLD_WINDOW_MS,
  ROOT_QUIESCENCE_POLL_INTERVAL_MS,
  ROOT_WATCH_REQUEST_TIMEOUT_MS,
  rootHasTerminalReply,
  startQuarantineRootWatch,
} from './root-stop.js'
import {stoppedRootMessages} from './test-helpers.js'

const ROOT = 'sess-root'
const NONE: ReadonlySet<string> = new Set<string>()

const user = (id: string): object => ({info: {id, role: 'user'}, parts: []})
/** A turn-terminal reply by default: completed, with a `stop` finish and no tool parts. */
const reply = (
  id: string,
  parentID: string,
  time: object = {completed: 2},
  extra: object = {finish: 'stop'},
): object => ({
  info: {id, role: 'assistant', parentID, time, ...extra},
  parts: [],
})
/** An intermediate step: upstream sets `time.completed` on it too, with `finish: 'tool-calls'`. */
const toolCallsStep = (id: string, parentID: string): object =>
  reply(id, parentID, {completed: 2}, {finish: 'tool-calls'})
const abortedReply = (id: string, parentID: string, extra: object = {}): object =>
  reply(
    id,
    parentID,
    {completed: 2},
    {error: {name: 'MessageAbortedError', data: {message: 'The operation was aborted.'}}, ...extra},
  )

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

describe('rootHasTerminalReply', () => {
  it('accepts the latest user message answered by a completed assistant message, last in the session', () => {
    expect(rootHasTerminalReply([user('u1'), reply('a1', 'u1')], NONE)).toBe(true)
  })

  it('accepts an aborted reply (an error and a completion time)', () => {
    expect(rootHasTerminalReply(stoppedRootMessages(ROOT), NONE)).toBe(true)
  })

  it.each([
    ['an aborted step that never got a finish', abortedReply('a1', 'u1')],
    ['an aborted step that had already finished a tool-calls step', abortedReply('a1', 'u1', {finish: 'tool-calls'})],
  ])('accepts %s', (_label, aborted) => {
    expect(rootHasTerminalReply([user('u1'), aborted], NONE)).toBe(true)
  })

  it.each([
    ['an intermediate tool-calls step', toolCallsStep('a1', 'u1')],
    ['a step with an unknown finish', reply('a1', 'u1', {completed: 2}, {finish: 'unknown'})],
    ['a completed step that never got a finish', reply('a1', 'u1', {completed: 2}, {})],
    [
      'a failed step (an error that is not an abort)',
      reply('a1', 'u1', {completed: 2}, {finish: 'error', error: {name: 'APIError'}}),
    ],
    [
      'a step that still has a tool part running',
      {
        info: {id: 'a1', role: 'assistant', parentID: 'u1', time: {completed: 2}, finish: 'stop'},
        parts: [{type: 'tool', state: {status: 'running'}}],
      },
    ],
    ['an aborted reply that answers an older message', abortedReply('a1', 'u0')],
    [
      'an aborted reply that has no completion time yet (still cleaning up)',
      abortedReply('a1', 'u1', {time: {created: 1}}),
    ],
  ])('rejects %s', (_label, last) => {
    expect(rootHasTerminalReply([user('u0'), user('u1'), last], NONE)).toBe(false)
  })

  it('accepts a normal stop reply whose only tool parts were interrupted by an abort', () => {
    const interrupted = {
      type: 'tool',
      state: {status: 'error', error: 'Tool execution aborted', metadata: {interrupted: true}},
    }
    const last = {
      info: {id: 'a1', role: 'assistant', parentID: 'u1', time: {completed: 2}, finish: 'stop'},
      parts: [interrupted],
    }
    expect(rootHasTerminalReply([user('u1'), last], NONE)).toBe(true)
  })

  it.each([
    ['not a list', undefined],
    ['an empty list', []],
    ['no user message', [reply('a1', 'u1')]],
    ['a user message with no reply', [user('u1')]],
    ['a reply with no completion time', [user('u1'), reply('a1', 'u1', {created: 1})]],
    ['a reply to an older user message', [user('u1'), user('u2'), reply('a1', 'u1')]],
    ['an older turn answered, then an unanswered newer user message', [user('u1'), reply('a1', 'u1'), user('u2')]],
  ])('rejects %s', (_label, messages) => {
    expect(rootHasTerminalReply(messages, NONE)).toBe(false)
  })

  it('rejects a last message that is not an assistant message, even with a matching parent and a completion time', () => {
    const toolResult = {info: {id: 't1', role: 'tool', parentID: 'u1', time: {completed: 2}}, parts: []}
    expect(rootHasTerminalReply([user('u1'), toolResult], NONE)).toBe(false)
  })

  it('rejects a list that lacks a user message the stream showed', () => {
    expect(rootHasTerminalReply([user('u1'), reply('a1', 'u1')], new Set(['u-newer']))).toBe(false)
  })

  it('accepts a list that holds every streamed user message', () => {
    expect(rootHasTerminalReply([user('u1'), reply('a1', 'u1')], new Set(['u1']))).toBe(true)
  })
})

function makeFixtures(options: {
  readonly live?: () => readonly string[]
  readonly messages?: () => unknown
  readonly abort?: () => Promise<unknown>
}) {
  const abort = vi.fn(options.abort ?? (async () => ({data: {}, error: null})))
  const messages = vi.fn(async () => ({data: options.messages?.() ?? [], error: null}))
  const client = {session: {abort, messages}} as unknown as SessionClient
  const adapter = {
    liveSessionIds: vi.fn(async () => ({success: true as const, data: new Set(options.live?.() ?? [])})),
  } as unknown as LedgerReconcileAdapter
  return {client, adapter, abort, messages}
}

describe('probeRootStop', () => {
  const base = {directory: '/workspace/repo', rootSessionId: ROOT, streamedUserMessageIds: () => NONE}

  it('is busy while the root is live, without reading messages', async () => {
    const {client, adapter, messages} = makeFixtures({live: () => [ROOT]})
    expect(await probeRootStop({...base, client, adapter, signal: new AbortController().signal})).toBe('busy')
    expect(messages).not.toHaveBeenCalled()
  })

  it('is unconfirmed when the root is absent and nothing was persisted', async () => {
    const {client, adapter} = makeFixtures({})
    expect(await probeRootStop({...base, client, adapter, signal: new AbortController().signal})).toBe('unconfirmed')
  })

  it('is confirmed when the root is absent and its latest prompt has a terminal reply', async () => {
    const {client, adapter} = makeFixtures({messages: () => stoppedRootMessages(ROOT)})
    expect(await probeRootStop({...base, client, adapter, signal: new AbortController().signal})).toBe('confirmed')
  })

  it('takes a final liveness reading after the reply evidence: a root that started in between is busy, not confirmed', async () => {
    // #given absent at the first reading, a terminal-looking reply, then live at the second (a new step started)
    let readings = 0
    const {client, adapter, messages} = makeFixtures({
      live: () => {
        readings += 1
        return readings === 1 ? [] : [ROOT]
      },
      messages: () => [user('u1'), reply('a1', 'u1')],
    })

    // #then
    expect(await probeRootStop({...base, client, adapter, signal: new AbortController().signal})).toBe('busy')
    expect(messages).toHaveBeenCalledTimes(1)
    expect(adapter.liveSessionIds).toHaveBeenCalledTimes(2)
  })

  it('does not confirm when the root started between the readings and left an intermediate tool-calls step', async () => {
    // #given a cold root absent at the first reading that then runs a whole tool-calling step before the messages read
    const {client, adapter} = makeFixtures({messages: () => [user('u1'), toolCallsStep('a1', 'u1')]})

    // #then a completed intermediate step is not a stopped turn, and there is nothing to confirm from
    expect(await probeRootStop({...base, client, adapter, signal: new AbortController().signal})).toBe('unconfirmed')
    expect(adapter.liveSessionIds).toHaveBeenCalledTimes(1)
  })

  it('is unconfirmed when the final liveness reading fails', async () => {
    let readings = 0
    const {client} = makeFixtures({messages: () => [user('u1'), reply('a1', 'u1')]})
    const adapter = {
      liveSessionIds: vi.fn(async () => {
        readings += 1
        return readings === 1
          ? {success: true as const, data: new Set<string>()}
          : {success: false as const, error: new Error('down')}
      }),
    } as unknown as LedgerReconcileAdapter
    expect(await probeRootStop({...base, client, adapter, signal: new AbortController().signal})).toBe('unconfirmed')
  })

  it('with a follow-up possible, a terminal reply to the latest message still does not confirm', async () => {
    // #given a root that is absent, with a completed aborted reply: exactly what confirms without background work
    const {client, adapter, messages} = makeFixtures({messages: () => stoppedRootMessages(ROOT)})
    const probe = await probeRootStop({
      ...base,
      client,
      adapter,
      signal: new AbortController().signal,
      followUpPossible: true,
    })

    // #then a newer turn that is not saved yet cannot be ruled out, so it is only unconfirmed (no messages read)
    expect(probe).toBe('unconfirmed')
    expect(messages).not.toHaveBeenCalled()
  })

  it('with a follow-up possible, a live root is still busy (so it is aborted again)', async () => {
    const {client, adapter} = makeFixtures({live: () => [ROOT], messages: () => stoppedRootMessages(ROOT)})
    expect(
      await probeRootStop({...base, client, adapter, signal: new AbortController().signal, followUpPossible: true}),
    ).toBe('busy')
  })

  it('is unconfirmed when the liveness lookup fails', async () => {
    const {client} = makeFixtures({})
    const adapter = {
      liveSessionIds: vi.fn(async () => ({success: false as const, error: new Error('down')})),
    } as unknown as LedgerReconcileAdapter
    expect(await probeRootStop({...base, client, adapter, signal: new AbortController().signal})).toBe('unconfirmed')
  })
})

function startWatch(
  fixtures: ReturnType<typeof makeFixtures>,
  extra: {windowMs?: number; followUpPossible?: boolean} = {},
) {
  vi.useFakeTimers()
  const logger = makeLogger()
  const stop = startQuarantineRootWatch({
    client: fixtures.client,
    adapter: fixtures.adapter,
    directory: '/workspace/repo',
    rootSessionId: ROOT,
    streamedUserMessageIds: () => NONE,
    logger,
    runId: 'run-1',
    ...extra,
  })
  return {stop, logger}
}

describe('startQuarantineRootWatch', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('aborts the root each time it shows up busy, and ends at the first confirmation with no timer left', async () => {
    // #given a root that is busy for two polls, then stopped with its aborted reply
    let polls = 0
    const fixtures = makeFixtures({
      live: () => {
        polls += 1
        return polls <= 2 ? [ROOT] : []
      },
      messages: () => (polls > 2 ? stoppedRootMessages(ROOT) : []),
    })
    const {logger} = startWatch(fixtures)

    // #when
    await vi.advanceTimersByTimeAsync(ROOT_QUIESCENCE_POLL_INTERVAL_MS * 6)

    // #then one abort per busy observation, the watch said so, and then it stopped on its own
    expect(fixtures.abort).toHaveBeenCalledTimes(2)
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({runId: 'run-1'}),
      expect.stringContaining('confirmed stopped'),
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a root that starts after the first reading and leaves an intermediate step is aborted, not confirmed', async () => {
    // #given the first probe sees an absent root and an intermediate tool-calls step; the next sees the root running
    let polls = 0
    const fixtures = makeFixtures({
      live: () => {
        polls += 1
        return polls >= 2 ? [ROOT] : []
      },
      messages: () => [user('u1'), toolCallsStep('a1', 'u1')],
    })
    const {logger} = startWatch(fixtures, {windowMs: 10_000})

    // #when
    await vi.advanceTimersByTimeAsync(ROOT_QUIESCENCE_POLL_INTERVAL_MS * 4)

    // #then the watch did not end on the intermediate step, and aborted the busy root
    expect(logger.info).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('confirmed stopped'))
    expect(fixtures.abort).toHaveBeenCalled()
  })

  it('a request that hits its cap does not stop the watch: it resumes and aborts the root before the hold ends', async () => {
    // #given the first liveness lookup never answers, and the root is running from then on
    const fixtures = makeFixtures({live: () => [ROOT]})
    vi.mocked(fixtures.adapter.liveSessionIds).mockReturnValueOnce(new Promise<never>(() => undefined))
    startWatch(fixtures, {windowMs: 60_000})

    // #when just past the cap
    await vi.advanceTimersByTimeAsync(ROOT_WATCH_REQUEST_TIMEOUT_MS - 100)

    // #then nothing was aborted yet: the hung request still holds the tick
    expect(fixtures.abort).not.toHaveBeenCalled()

    // #when the cap passes and polling resumes
    await vi.advanceTimersByTimeAsync(ROOT_QUIESCENCE_POLL_INTERVAL_MS * 3 + 200)

    // #then the busy root was aborted well before the hold would have ended
    expect(fixtures.abort).toHaveBeenCalled()
  })

  it('with a follow-up possible, never ends on a terminal reply: it aborts each busy observation until the window closes', async () => {
    // #given a root with a completed reply to its latest turn, busy now and then, and a follow-up that may start
    let polls = 0
    const fixtures = makeFixtures({
      live: () => {
        polls += 1
        return polls % 4 === 0 ? [ROOT] : []
      },
      messages: () => stoppedRootMessages(ROOT),
    })
    const {logger} = startWatch(fixtures, {windowMs: 10_000, followUpPossible: true})

    // #when most of the window passes
    await vi.advanceTimersByTimeAsync(9_000)

    // #then it is still watching, and it aborted the busy observations
    expect(fixtures.abort.mock.calls.length).toBeGreaterThan(1)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    expect(logger.info).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('confirmed stopped'))

    // #when the window closes
    await vi.advanceTimersByTimeAsync(2_000)

    // #then it ended at the window, with nothing left
    expect(logger.warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('hold ended without confirming'),
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps watching an absent root with no evidence, never aborts it, and ends at the window', async () => {
    // #given a root that is absent and never produces a reply
    const fixtures = makeFixtures({})
    const {logger} = startWatch(fixtures, {windowMs: 5_000})

    // #when the window passes
    await vi.advanceTimersByTimeAsync(10_000)

    // #then nothing was aborted (nothing was running), the end was logged, and no timer is left
    expect(fixtures.abort).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({runId: 'run-1'}),
      expect.stringContaining('hold ended without confirming'),
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it('is not stalled by a request that never answers: the window still ends it', async () => {
    // #given a liveness lookup that hangs
    const fixtures = makeFixtures({})
    vi.mocked(fixtures.adapter.liveSessionIds).mockReturnValue(new Promise<never>(() => undefined))
    startWatch(fixtures, {windowMs: 30_000})

    // #when the window passes
    await vi.advanceTimersByTimeAsync(30_000 + ROOT_WATCH_REQUEST_TIMEOUT_MS)

    // #then it is over and nothing is scheduled
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stop() ends it at once and is safe to call twice', async () => {
    // #given
    const fixtures = makeFixtures({live: () => [ROOT]})
    const {stop} = startWatch(fixtures)
    await vi.advanceTimersByTimeAsync(ROOT_QUIESCENCE_POLL_INTERVAL_MS + 10)
    const abortsBefore = fixtures.abort.mock.calls.length

    // #when
    stop()
    stop()
    await vi.advanceTimersByTimeAsync(10_000)

    // #then no more aborts and no timers
    expect(fixtures.abort.mock.calls.length).toBe(abortsBefore)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses the quarantine hold as its default window', async () => {
    // #given an absent, unconfirmed root and the default window
    const fixtures = makeFixtures({})
    startWatch(fixtures)

    // #when just under the hold passes it is still running; once it passes, nothing is left
    await vi.advanceTimersByTimeAsync(QUARANTINE_HOLD_WINDOW_MS - 1_000)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    await vi.advanceTimersByTimeAsync(2_000)

    // #then
    expect(vi.getTimerCount()).toBe(0)
  })
})
