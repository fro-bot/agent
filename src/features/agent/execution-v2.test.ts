/**
 * The V2 execution loop, end to end against a scripted server: session setup, subscribe-before-prompt, text without
 * reasoning, form cancel, permission reject, retry on a stream that never connects, provider-error mapping and the
 * deadline interrupt. The V1 counterparts live in `execution.test.ts` and `execution.stream-connect.test.ts`.
 */
import type {OpenCodeV2ServerHandle} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import type {PromptOptions} from './types.js'
import {
  QUESTION_FORM_CREATED_FRAME,
  QUESTION_FORM_ID,
  REASONING_FRAMES,
  TEXT_SESSION_ID,
} from '@fro-bot/runtime/event-v2-fixtures'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {
  createFakeServer,
  DIRECTORY,
  frame,
  ROOT_SESSION_ID,
  STARTED,
  SUCCEEDED,
  succeedWithText,
} from './execution-v2.fixture.js'
import {cancelFormV2, executeOpenCodeV2, interruptRootSession, replyToPermissionAskV2} from './execution-v2.js'
import {EVENT_STREAM_CONNECT_TIMEOUT_MS, MAX_LLM_RETRIES, RETRY_DELAYS_MS} from './retry.js'

const consoleMock = vi.hoisted(() => ({outputTextContent: vi.fn(), outputToolExecution: vi.fn()}))
vi.mock('../../shared/console.js', () => consoleMock)

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
}))

vi.mock('./prompt.js', () => ({
  buildAgentPrompt: vi.fn().mockReturnValue({text: 'Built prompt', referenceFiles: []}),
}))

vi.mock('./reference-files.js', () => ({
  materializeReferenceFiles: vi.fn().mockResolvedValue([]),
}))

function promptOptions(): PromptOptions {
  return {
    context: {
      eventName: 'issue_comment',
      repo: 'owner/repo',
      ref: 'refs/heads/main',
      actor: 'user',
      runId: '1',
      issueNumber: 1,
      issueTitle: 'T',
      issueType: 'issue',
      commentBody: 'hi',
      commentAuthor: 'c',
      commentId: 1,
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

function handle(): OpenCodeV2ServerHandle & {readonly registered: string[]} {
  const registered: string[] = []
  return {
    url: 'http://127.0.0.1:4096',
    directory: DIRECTORY,
    registerOwnedSession: (id: string) => registered.push(id),
    registered,
  } as unknown as OpenCodeV2ServerHandle & {readonly registered: string[]}
}

async function advance(totalMs: number, stepMs = 250): Promise<void> {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) await vi.advanceTimersByTimeAsync(stepMs)
}

describe('executeOpenCodeV2', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
    consoleMock.outputTextContent.mockClear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('creates the session with its title, agent and model, subscribes before it prompts, and completes', async () => {
    // #given
    const server = createFakeServer({onPrompt: (_, pipe) => succeedWithText(pipe)})
    const serverHandle = handle()

    // #when
    const result = executeOpenCodeV2(
      promptOptions(),
      logger,
      {
        agent: 'build',
        model: {providerID: 'anthropic', modelID: 'claude-x'},
        timeoutMs: 60_000,
        sessionTitle: 'Fro Bot: issue #1',
      },
      serverHandle,
      undefined,
      server.client,
    )
    await advance(2_000)

    // #then
    expect(await result).toMatchObject({success: true, exitCode: 0, sessionId: ROOT_SESSION_ID})
    expect(server.calls.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: DIRECTORY,
        title: 'Fro Bot: issue #1',
        agent: 'build',
        model: {providerID: 'anthropic', modelID: 'claude-x'},
      }),
    )
    expect(serverHandle.registered).toEqual([ROOT_SESSION_ID])
    // The stream is live (subscribed, and its first frame read) before the one prompt goes out.
    expect(server.order.indexOf('subscribe')).toBeLessThan(server.order.indexOf('prompt'))
    expect(server.calls.prompt).toHaveBeenCalledTimes(1)
    expect(server.calls.prompt.mock.calls[0]?.[0]).toMatchObject({text: 'Built prompt', directory: DIRECTORY})
    // The title is re-asserted after the attempt.
    expect(server.calls.updateSession).toHaveBeenCalledWith(
      expect.objectContaining({sessionId: ROOT_SESSION_ID, title: 'Fro Bot: issue #1'}),
    )
  })

  it('excludes reasoning from the response text', async () => {
    // #given
    const server = createFakeServer({
      onPrompt: (_, pipe) => {
        pipe.push(STARTED)
        for (const item of REASONING_FRAMES) pipe.push(item)
        succeedWithText(pipe)
      },
    })

    // #when
    const result = executeOpenCodeV2(
      promptOptions(),
      logger,
      {agent: null, model: null, timeoutMs: 60_000},
      handle(),
      undefined,
      server.client,
    )
    await advance(2_000)
    await result

    // #then
    const written = JSON.stringify(consoleMock.outputTextContent.mock.calls)
    expect(written).toContain('all done')
    expect(written).not.toContain('PRIVATE CHAIN OF THOUGHT')
  })

  it('continues an existing session and sets its model and agent through the session routes', async () => {
    // #given
    const server = createFakeServer({onPrompt: (_, pipe) => succeedWithText(pipe)})

    // #when
    const result = executeOpenCodeV2(
      promptOptions(),
      logger,
      {
        agent: 'plan',
        model: {providerID: 'anthropic', modelID: 'm'},
        timeoutMs: 60_000,
        continueSessionId: ROOT_SESSION_ID,
      },
      handle(),
      undefined,
      server.client,
    )
    await advance(2_000)

    // #then
    expect(await result).toMatchObject({success: true, sessionId: ROOT_SESSION_ID})
    expect(server.calls.createSession).not.toHaveBeenCalled()
    expect(server.calls.switchModel).toHaveBeenCalledWith(
      expect.objectContaining({sessionId: ROOT_SESSION_ID, model: {providerID: 'anthropic', modelID: 'm'}}),
    )
    expect(server.calls.switchAgent).toHaveBeenCalledWith(
      expect.objectContaining({sessionId: ROOT_SESSION_ID, agent: 'plan'}),
    )
  })

  it('cancels a question form at once and the run still completes', async () => {
    // #given
    const server = createFakeServer({
      onPrompt: (_, pipe) => {
        pipe.push(STARTED)
        pipe.push(QUESTION_FORM_CREATED_FRAME)
        pipe.push(SUCCEEDED)
      },
    })

    // #when
    const result = executeOpenCodeV2(
      promptOptions(),
      logger,
      {agent: null, model: null, timeoutMs: 60_000},
      handle(),
      undefined,
      server.client,
    )
    await advance(2_000)

    // #then
    expect(await result).toMatchObject({success: true})
    expect(server.calls.cancelForm).toHaveBeenCalledWith(expect.objectContaining({formId: QUESTION_FORM_ID}))
  })

  it('logs a form cancel that fails and the run still completes', async () => {
    // #given
    const server = createFakeServer({
      onPrompt: (_, pipe) => {
        pipe.push(STARTED)
        pipe.push(QUESTION_FORM_CREATED_FRAME)
        pipe.push(SUCCEEDED)
      },
    })
    server.calls.cancelForm.mockResolvedValue({success: false, error: {kind: 'http', status: 500}})

    // #when
    const result = executeOpenCodeV2(
      promptOptions(),
      logger,
      {agent: null, model: null, timeoutMs: 60_000},
      handle(),
      undefined,
      server.client,
    )
    await advance(2_000)

    // #then
    expect(await result).toMatchObject({success: true})
    expect(logger.warning).toHaveBeenCalledWith(
      'Failed to cancel OpenCode V2 form; the run continues',
      expect.objectContaining({error: 'Form cancel failed: http 500'}),
    )
  })

  it('rejects a permission ask and the run continues', async () => {
    // #given
    const server = createFakeServer({
      onPrompt: (_, pipe) => {
        pipe.push(STARTED)
        pipe.push(
          frame('permission.asked', {
            id: 'per_1',
            sessionID: ROOT_SESSION_ID,
            action: 'external_directory',
            resources: ['/etc/hosts'],
          }),
        )
        pipe.push(SUCCEEDED)
      },
    })

    // #when
    const result = executeOpenCodeV2(
      promptOptions(),
      logger,
      {agent: null, model: null, timeoutMs: 60_000},
      handle(),
      undefined,
      server.client,
    )
    await advance(2_000)

    // #then
    expect(await result).toMatchObject({success: true})
    expect(server.calls.replyPermission).toHaveBeenCalledTimes(1)
    expect(server.calls.replyPermission.mock.calls[0]?.[0]).toMatchObject({
      sessionId: ROOT_SESSION_ID,
      requestId: 'per_1',
      decision: 'reject',
    })
  })

  describe('a stream that does not connect', () => {
    it('is retried on a fresh stream: the prompt is sent once and the run succeeds', async () => {
      // #given the first stream is silent and the second connects
      const server = createFakeServer({silentFirstStream: true, onPrompt: (_, pipe) => succeedWithText(pipe)})

      // #when
      const result = executeOpenCodeV2(
        promptOptions(),
        logger,
        {agent: null, model: null, timeoutMs: 120_000},
        handle(),
        undefined,
        server.client,
      )
      await advance(EVENT_STREAM_CONNECT_TIMEOUT_MS + 2_100 + (RETRY_DELAYS_MS[0] ?? 0) + 5_000)

      // #then
      expect(await result).toMatchObject({success: true})
      expect(server.calls.subscribeEvents).toHaveBeenCalledTimes(2)
      expect(server.calls.prompt).toHaveBeenCalledTimes(1)
    })

    it('fails as a transport error once the retries are exhausted, never sending the prompt', async () => {
      // #given every stream ends before it connects
      const server = createFakeServer({endWithoutConnect: true})

      // #when
      const result = executeOpenCodeV2(
        promptOptions(),
        logger,
        {agent: null, model: null, timeoutMs: 600_000},
        handle(),
        undefined,
        server.client,
      )
      const delays = RETRY_DELAYS_MS.slice(0, MAX_LLM_RETRIES - 1).reduce((total, delay) => total + delay, 0)
      await advance(MAX_LLM_RETRIES * 2_100 + delays + 5_000)

      // #then
      const outcome = await result
      expect(outcome.success).toBe(false)
      expect(outcome.llmError?.type).toBe('llm_fetch_error')
      expect(outcome.error).toContain('ended before it connected')
      expect(server.calls.subscribeEvents).toHaveBeenCalledTimes(MAX_LLM_RETRIES)
      expect(server.calls.prompt).not.toHaveBeenCalled()
    })
  })

  describe('failures', () => {
    it('resends the original prompt after a retryable submission failure', async () => {
      // #given the first prompt call answers 503
      const server = createFakeServer({
        promptResults: [{kind: 'http', status: 503}],
        onPrompt: (_, pipe) => succeedWithText(pipe),
      })

      // #when
      const result = executeOpenCodeV2(
        promptOptions(),
        logger,
        {agent: null, model: null, timeoutMs: 120_000},
        handle(),
        undefined,
        server.client,
      )
      await advance(2_000 + (RETRY_DELAYS_MS[0] ?? 0) + 5_000)

      // #then
      expect(await result).toMatchObject({success: true})
      expect(server.calls.prompt).toHaveBeenCalledTimes(2)
      expect(server.calls.prompt.mock.calls[1]?.[0]).toMatchObject({text: 'Built prompt'})
    })

    it('does not retry an auth failure of the prompt route', async () => {
      // #given
      const server = createFakeServer({promptResults: [{kind: 'auth', status: 401}]})

      // #when
      const result = executeOpenCodeV2(
        promptOptions(),
        logger,
        {agent: null, model: null, timeoutMs: 60_000},
        handle(),
        undefined,
        server.client,
      )
      await advance(2_000)

      // #then
      expect(await result).toMatchObject({success: false, exitCode: 1})
      expect(server.calls.prompt).toHaveBeenCalledTimes(1)
    })

    it('maps a provider auth failure to its class and stops without a retry', async () => {
      // #given
      const server = createFakeServer({
        onPrompt: (_, pipe) => {
          pipe.push(STARTED)
          pipe.push(
            frame('session.execution.failed', {
              sessionID: ROOT_SESSION_ID,
              error: {type: 'provider.auth', message: 'invalid x-api-key sk-live-secret', status: 401},
            }),
          )
        },
      })

      // #when
      const result = executeOpenCodeV2(
        promptOptions(),
        logger,
        {agent: null, model: null, timeoutMs: 60_000},
        handle(),
        undefined,
        server.client,
      )
      await advance(3_000)
      const outcome = await result

      // #then
      expect(outcome.success).toBe(false)
      expect(outcome.llmError?.type).toBe('provider_auth_error')
      expect(JSON.stringify(outcome)).not.toContain('sk-live-secret')
      expect(server.calls.prompt).toHaveBeenCalledTimes(1)
    })

    it('continues the turn with a continuation prompt after a retryable transport failure', async () => {
      // #given the first turn fails with a transport error and the second succeeds
      const server = createFakeServer({
        onPrompt: (attempt, pipe) => {
          pipe.push(STARTED)
          if (attempt === 1) {
            pipe.push(
              frame('session.execution.failed', {
                sessionID: ROOT_SESSION_ID,
                error: {type: 'provider.transport', message: 'socket hang up'},
              }),
            )
          } else {
            succeedWithText(pipe)
          }
        },
      })

      // #when
      const result = executeOpenCodeV2(
        promptOptions(),
        logger,
        {agent: null, model: null, timeoutMs: 120_000},
        handle(),
        undefined,
        server.client,
      )
      await advance(3_000 + (RETRY_DELAYS_MS[0] ?? 0) + 5_000)

      // #then
      expect(await result).toMatchObject({success: true})
      expect(server.calls.prompt).toHaveBeenCalledTimes(2)
      const resent = server.calls.prompt.mock.calls[1]?.[0] as {text: string}
      expect(resent.text).toContain('observed failure type `llm_fetch_error`')
    })

    it('fails the run when an owned session moves, and interrupts the root', async () => {
      // #given
      const server = createFakeServer({
        onPrompt: (_, pipe) => {
          pipe.push(STARTED)
          pipe.push(frame('session.moved', {sessionID: ROOT_SESSION_ID, location: {directory: '/elsewhere'}}))
        },
      })

      // #when
      const result = executeOpenCodeV2(
        promptOptions(),
        logger,
        {agent: null, model: null, timeoutMs: 60_000},
        handle(),
        undefined,
        server.client,
      )
      await advance(3_000)

      // #then
      expect(await result).toMatchObject({success: false})
      expect(server.calls.interrupt).toHaveBeenCalledWith(expect.objectContaining({sessionId: ROOT_SESSION_ID}))
    })
  })

  describe('the deadline', () => {
    it('interrupts the root through the interrupt route and reports a timeout', async () => {
      // #given a turn that starts and never ends
      const server = createFakeServer({onPrompt: (_, pipe) => pipe.push(STARTED)})

      // #when
      const result = executeOpenCodeV2(
        promptOptions(),
        logger,
        {agent: null, model: null, timeoutMs: 3_000},
        handle(),
        undefined,
        server.client,
      )
      await advance(8_000)

      // #then
      const outcome = await result
      expect(outcome).toMatchObject({success: false, exitCode: 130, sessionId: ROOT_SESSION_ID})
      expect(outcome.error).toContain('timed out')
      expect(server.calls.interrupt).toHaveBeenCalledTimes(1)
      expect(server.calls.interrupt).toHaveBeenCalledWith(expect.objectContaining({sessionId: ROOT_SESSION_ID}))
    })

    it('does not interrupt for a failure that was not the deadline', async () => {
      // #given
      const server = createFakeServer({
        onPrompt: (_, pipe) => {
          pipe.push(STARTED)
          pipe.push(
            frame('session.execution.failed', {
              sessionID: ROOT_SESSION_ID,
              error: {type: 'provider.invalid-request', message: 'bad'},
            }),
          )
        },
      })

      // #when
      const result = executeOpenCodeV2(
        promptOptions(),
        logger,
        {agent: null, model: null, timeoutMs: 60_000},
        handle(),
        undefined,
        server.client,
      )
      await advance(3_000)
      await result

      // #then
      expect(server.calls.interrupt).not.toHaveBeenCalled()
    })
  })
})

describe('replyToPermissionAskV2', () => {
  const request = {requestId: 'per_9', sessionId: 'ses_1', action: 'edit', resources: []}

  it('sends reject and nothing else', async () => {
    // #given
    const server = createFakeServer()

    // #when
    await replyToPermissionAskV2(server.client, request)

    // #then
    const decisions = server.calls.replyPermission.mock.calls.map(call => (call[0] as {decision: string}).decision)
    expect(decisions).toEqual(['reject'])
    expect(decisions).not.toContain('once')
    expect(decisions).not.toContain('always')
  })

  it('tries twice, then reports the failure, still sending reject each time', async () => {
    // #given
    const server = createFakeServer()
    server.calls.replyPermission.mockResolvedValue({success: false, error: {kind: 'http', status: 500}})

    // #when / #then
    await expect(replyToPermissionAskV2(server.client, request)).rejects.toThrow('failed after 2 attempt(s): http 500')
    expect(server.calls.replyPermission).toHaveBeenCalledTimes(2)
    for (const call of server.calls.replyPermission.mock.calls) {
      expect((call[0] as {decision: string}).decision).toBe('reject')
    }
  })

  it('succeeds on the second attempt after a thrown first one', async () => {
    // #given
    const server = createFakeServer()
    server.calls.replyPermission.mockRejectedValueOnce(new Error('aborted by timeout'))

    // #when / #then
    await expect(replyToPermissionAskV2(server.client, request)).resolves.toBeUndefined()
    expect(server.calls.replyPermission).toHaveBeenCalledTimes(2)
  })
})

describe('cancelFormV2 and interruptRootSession', () => {
  it('rejects when the cancel fails so the stream can log it', async () => {
    // #given
    const server = createFakeServer()
    server.calls.cancelForm.mockResolvedValue({success: false, error: {kind: 'network', message: 'down'}})

    // #when / #then
    await expect(cancelFormV2(server.client, {formId: 'frm_1', sessionId: TEXT_SESSION_ID})).rejects.toThrow(
      'Form cancel failed: network',
    )
  })

  it('never reads {interrupted: false} as a stop and never throws', async () => {
    // #given
    const server = createFakeServer({interruptResult: {interrupted: false}})
    const logger = createMockLogger()

    // #when
    await interruptRootSession(server.client, 'ses_1', logger)

    // #then
    expect(logger.debug).toHaveBeenCalledWith('OpenCode V2 session interrupt found nothing active', {
      sessionId: 'ses_1',
    })
  })

  it('logs an interrupt that fails and carries on', async () => {
    // #given
    const server = createFakeServer()
    server.calls.interrupt.mockResolvedValue({success: false, error: {kind: 'http', status: 500}})
    const logger = createMockLogger()

    // #when
    await interruptRootSession(server.client, 'ses_1', logger)

    // #then
    expect(logger.warning).toHaveBeenCalled()
  })
})
