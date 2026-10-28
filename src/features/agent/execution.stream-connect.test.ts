/**
 * A stream that does not connect is a transient transport failure, not a rejected prompt.
 *
 * `runPromptAttempt` waits for the event stream's `server.connected` frame before it sends a new prompt. When the
 * stream never connects, or ends first, nothing was sent, so `executeOpenCode`'s retry loop (`MAX_LLM_RETRIES`, with
 * its backoff bounded by the deadline) resends the original prompt on a fresh stream; each attempt subscribes anew.
 */
import type {Event} from '@opencode-ai/sdk'
import type {Logger} from '../../shared/logger.js'
import type {PromptOptions} from './types.js'
import {createOpencode} from '@opencode-ai/sdk'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {executeOpenCode} from './execution.js'
import {EVENT_STREAM_CONNECT_TIMEOUT_MS, MAX_LLM_RETRIES, RETRY_DELAYS_MS} from './retry.js'

const SERVER_CONNECTED = {type: 'server.connected', properties: {}} as unknown as Event

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
}))

vi.mock('@opencode-ai/sdk', () => ({
  createOpencode: vi.fn(),
}))

// v2 wait is unavailable in this test environment, so every attempt falls back to poll.
vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: vi.fn().mockReturnValue({
    v2: {session: {wait: vi.fn().mockRejectedValue(new Error('v2 not available in test'))}},
  }),
}))

vi.mock('./prompt.js', () => ({
  buildAgentPrompt: vi.fn().mockReturnValue({text: 'Built prompt', referenceFiles: []}),
}))

vi.mock('./reference-files.js', () => ({
  materializeReferenceFiles: vi.fn().mockResolvedValue([]),
}))

function createMockPromptOptions(): PromptOptions {
  return {
    context: {
      eventName: 'issue_comment',
      repo: 'owner/repo',
      ref: 'refs/heads/main',
      actor: 'test-user',
      runId: '12345',
      issueNumber: 42,
      issueTitle: 'Test Issue',
      issueType: 'issue',
      commentBody: 'Test comment',
      commentAuthor: 'commenter',
      commentId: 999,
      defaultBranch: 'main',
      diffContext: null,
      hydratedContext: null,
      authorAssociation: null,
      isRequestedReviewer: false,
    },
    customPrompt: null,
    cacheStatus: 'hit',
    responseSurface: 'issue-comment',
  }
}

/** A stream that never announces itself and never ends. */
function createSilentEventStream(): AsyncIterable<Event> {
  return (async function* () {
    await new Promise<never>(() => undefined)
  })()
}

/** A stream that ends at once, without ever announcing itself. */
function createEmptyEventStream(): AsyncIterable<Event> {
  return (async function* () {})()
}

/** A healthy stream: announces itself, waits for the prompt, then reports activity and a root idle. */
function createHealthyEventStream(promptAsync: ReturnType<typeof vi.fn>): AsyncIterable<Event> {
  return (async function* () {
    yield SERVER_CONNECTED
    const callsBefore = promptAsync.mock.calls.length
    while (promptAsync.mock.calls.length === callsBefore) {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    yield {
      type: 'message.part.delta',
      properties: {sessionID: 'ses_root', delta: {type: 'text', text: 'activity'}},
    } as unknown as Event
    yield {type: 'session.idle', properties: {sessionID: 'ses_root'}} as unknown as Event
    await new Promise<never>(() => undefined)
  })()
}

function createClient(streams: readonly ((promptAsync: ReturnType<typeof vi.fn>) => AsyncIterable<Event>)[]) {
  const promptAsync = vi.fn().mockResolvedValue({data: {parts: [{type: 'text', text: 'ok'}]}})
  const statusSequence = [{ses_root: {type: 'busy'}}, {ses_root: {type: 'idle'}}]
  let statusIndex = 0
  let subscribeCalls = 0
  const subscribe = vi.fn().mockImplementation(async () => {
    const make = streams[Math.min(subscribeCalls, streams.length - 1)]
    subscribeCalls += 1
    if (make == null) throw new Error('no stream configured')
    return {stream: make(promptAsync)}
  })
  const client = {
    session: {
      create: vi.fn().mockResolvedValue({data: {id: 'ses_root', title: 'Test', version: '1'}}),
      update: vi.fn().mockResolvedValue({data: {}}),
      abort: vi.fn().mockResolvedValue({data: undefined}),
      promptAsync,
      messages: vi.fn().mockResolvedValue({data: []}),
      children: vi.fn().mockResolvedValue({data: []}),
      status: vi.fn().mockImplementation(async () => {
        const response = statusSequence[Math.min(statusIndex, statusSequence.length - 1)]
        statusIndex += 1
        return {data: response}
      }),
    },
    event: {subscribe},
  }
  vi.mocked(createOpencode).mockResolvedValue({
    client: client as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
    server: {url: 'http://127.0.0.1:4096', close: vi.fn()},
  })
  return {client, promptAsync, subscribe}
}

/** Runs the fake clock forward in small steps so the async retry chain gets its turns. */
async function advance(totalMs: number, stepMs = 250): Promise<void> {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    await vi.advanceTimersByTimeAsync(stepMs)
  }
}

describe('executeOpenCode — a stream that does not connect is retried', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('retries on a fresh stream when the first never connects: the prompt is sent once and the run succeeds', async () => {
    // #given the first attempt's stream is silent and the second connects
    const {client, promptAsync, subscribe} = createClient([() => createSilentEventStream(), createHealthyEventStream])

    // #when
    const result = executeOpenCode(createMockPromptOptions(), logger)
    await advance(EVENT_STREAM_CONNECT_TIMEOUT_MS + 2_100 + (RETRY_DELAYS_MS[0] ?? 0) + 5_000)

    // #then
    expect(await result).toMatchObject({success: true})
    expect(subscribe).toHaveBeenCalledTimes(2)
    expect(promptAsync).toHaveBeenCalledOnce()
    expect(client.session.promptAsync).toHaveBeenCalledOnce()
  })

  it('retries when the first stream ends before it connects', async () => {
    // #given
    const {promptAsync, subscribe} = createClient([() => createEmptyEventStream(), createHealthyEventStream])

    // #when
    const result = executeOpenCode(createMockPromptOptions(), logger)
    await advance(2_100 + (RETRY_DELAYS_MS[0] ?? 0) + 5_000)

    // #then
    expect(await result).toMatchObject({success: true})
    expect(subscribe).toHaveBeenCalledTimes(2)
    expect(promptAsync).toHaveBeenCalledOnce()
  })

  it('fails once the retries are exhausted when no attempt ever connects, and never sends the prompt', async () => {
    // #given every attempt's stream is silent
    const {promptAsync, subscribe} = createClient([() => createSilentEventStream()])

    // #when
    const result = executeOpenCode(createMockPromptOptions(), logger)
    const perAttemptMs = EVENT_STREAM_CONNECT_TIMEOUT_MS + 2_100
    const delays = RETRY_DELAYS_MS.slice(0, MAX_LLM_RETRIES - 1).reduce((total, delay) => total + delay, 0)
    await advance(MAX_LLM_RETRIES * perAttemptMs + delays + 5_000)

    // #then
    const outcome = await result
    expect(outcome.success).toBe(false)
    expect(outcome.error).toContain('did not connect')
    expect(subscribe).toHaveBeenCalledTimes(MAX_LLM_RETRIES)
    expect(promptAsync).not.toHaveBeenCalled()
  })

  it('does not retry past the deadline: the backoff is bounded by the time the run has left', async () => {
    // #given a run with 12 s in total and a stream that never connects
    const {promptAsync, subscribe} = createClient([() => createSilentEventStream()])

    // #when the deadline passes during the first wait or the backoff after it
    const result = executeOpenCode(createMockPromptOptions(), logger, {
      agent: null,
      model: null,
      timeoutMs: 12_000,
    })
    await advance(12_000 + 20_000)

    // #then it ended at the deadline, with a timeout result, and no attempt after the deadline subscribed
    const outcome = await result
    expect(outcome.success).toBe(false)
    expect(promptAsync).not.toHaveBeenCalled()
    expect(subscribe.mock.calls.length).toBeLessThanOrEqual(2)
  })
})
