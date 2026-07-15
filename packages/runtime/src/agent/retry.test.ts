import type {Logger} from '../shared/logger.js'
import type {ErrorInfo} from './error-format/types.js'
import type {PromptAttemptDependencies} from './retry.js'
import {describe, expect, it, vi} from 'vitest'
import {runPromptAttempt} from './retry.js'

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

function createNonRetryableQuotaError(): ErrorInfo {
  return {
    type: 'quota_exceeded',
    message: 'Provider quota exceeded.',
    retryable: false,
  }
}

function createRetryableFetchError(): ErrorInfo {
  return {
    type: 'llm_fetch_error',
    message: 'LLM request failed: fetch failed',
    retryable: true,
  }
}

function createMockClient() {
  return {
    event: {subscribe: vi.fn().mockResolvedValue({stream: (async function* () {})()})},
  } as unknown as Parameters<typeof runPromptAttempt>[0]
}

function createDependencies(overrides: Partial<PromptAttemptDependencies> = {}): PromptAttemptDependencies {
  return {
    pollForSessionCompletion: vi.fn().mockResolvedValue({completed: false, error: 'Session did not reach idle state'}),
    processEventStream: vi.fn().mockResolvedValue({
      tokens: null,
      model: null,
      cost: null,
      prsCreated: [],
      commitsCreated: [],
      commentsPosted: 0,
      llmError: null,
    }),
    waitForEventProcessorShutdown: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('runPromptAttempt shouldRetry decision (runtime)', () => {
  it('does not set shouldRetry for a non-retryable quota_exceeded llmError, even when the poll fails', async () => {
    // #given — a non-retryable quota error was classified during stream processing, and the poll fails
    const quotaError = createNonRetryableQuotaError()
    const dependencies = createDependencies({
      processEventStream: vi.fn().mockResolvedValue({
        tokens: null,
        model: null,
        cost: null,
        prsCreated: [],
        commitsCreated: [],
        commentsPosted: 0,
        llmError: quotaError,
      }),
    })

    // #when
    const result = await runPromptAttempt(
      createMockClient(),
      'ses_123',
      '/workspace',
      1_000,
      createMockLogger(),
      dependencies,
    )

    // #then
    expect(result.success).toBe(false)
    expect(result.llmError).toEqual(quotaError)
    expect(result.shouldRetry).toBe(false)
  })

  it('sets shouldRetry for a retryable llm_fetch_error llmError when the poll fails', async () => {
    // #given — a retryable fetch error was classified during stream processing, and the poll fails
    const fetchError = createRetryableFetchError()
    const dependencies = createDependencies({
      processEventStream: vi.fn().mockResolvedValue({
        tokens: null,
        model: null,
        cost: null,
        prsCreated: [],
        commitsCreated: [],
        commentsPosted: 0,
        llmError: fetchError,
      }),
    })

    // #when
    const result = await runPromptAttempt(
      createMockClient(),
      'ses_123',
      '/workspace',
      1_000,
      createMockLogger(),
      dependencies,
    )

    // #then
    expect(result.success).toBe(false)
    expect(result.llmError).toEqual(fetchError)
    expect(result.shouldRetry).toBe(true)
  })

  it('does not set shouldRetry when llmError is null, even when the poll fails', async () => {
    // #given — no llmError was classified at all; poll still fails (e.g. plain timeout)
    const dependencies = createDependencies()

    // #when
    const result = await runPromptAttempt(
      createMockClient(),
      'ses_123',
      '/workspace',
      1_000,
      createMockLogger(),
      dependencies,
    )

    // #then
    expect(result.success).toBe(false)
    expect(result.llmError).toBeNull()
    expect(result.shouldRetry).toBe(false)
  })
})
