import type {RunSummary} from '../types.js'
import type {SessionClient} from './backend.js'
import type {Logger} from './types.js'

import {beforeEach, describe, expect, it, vi} from 'vitest'

import {writeSessionSummary} from './writeback.js'

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}

function createMockSdkClient(options?: {promptResponse?: {data?: unknown; error?: unknown}}) {
  return {
    session: {
      prompt: vi.fn().mockResolvedValue(options?.promptResponse ?? {data: undefined, error: undefined}),
    },
  }
}

function createMockRunSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    eventType: 'issue_comment',
    repo: 'owner/repo',
    ref: 'main',
    runId: 12345,
    cacheStatus: 'hit',
    sessionIds: ['ses_abc123'],
    createdPRs: [],
    createdCommits: [],
    duration: 45,
    tokenUsage: {input: 1000, output: 500, reasoning: 0, cache: {read: 0, write: 0}},
    ...overrides,
  }
}

describe('writeSessionSummary', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('calls SDK prompt with noReply and correct session ID', async () => {
    // #given
    const summary = createMockRunSummary()
    const client = createMockSdkClient()

    // #when
    await writeSessionSummary('ses_test', summary, client as unknown as SessionClient, mockLogger)

    // #then
    expect(client.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        path: {id: 'ses_test'},
        body: expect.objectContaining({
          noReply: true,
          parts: [
            expect.objectContaining({
              type: 'text',
              text: expect.stringContaining('Fro Bot Run Summary') as unknown,
            }) as unknown,
          ],
        }) as unknown,
      }),
    )
  })

  it('logs success when SDK prompt succeeds', async () => {
    // #given
    const summary = createMockRunSummary()
    const client = createMockSdkClient()

    // #when
    await writeSessionSummary('ses_test', summary, client as unknown as SessionClient, mockLogger)

    // #then
    expect(mockLogger.info).toHaveBeenCalledWith('Session summary written via SDK', {sessionId: 'ses_test'})
  })

  it('includes summary text with event details', async () => {
    // #given
    const summary = createMockRunSummary({
      eventType: 'pull_request',
      repo: 'test/repo',
      createdPRs: ['#123'],
      createdCommits: ['abc1234'],
      tokenUsage: {input: 2000, output: 1500, reasoning: 0, cache: {read: 0, write: 0}},
    })
    const client = createMockSdkClient()

    // #when
    await writeSessionSummary('ses_test', summary, client as unknown as SessionClient, mockLogger)

    // #then
    const promptCall = client.session.prompt.mock.calls[0]?.[0] as {body: {parts: {text: string}[]}}
    const text = promptCall.body.parts[0]?.text ?? ''
    expect(text).toContain('Event: pull_request')
    expect(text).toContain('Repo: test/repo')
    expect(text).toContain('PRs created: #123')
    expect(text).toContain('Commits: abc1234')
    expect(text).toContain('Tokens: 2000 in / 1500 out')
  })

  it('omits optional fields when not present', async () => {
    // #given
    const summary = createMockRunSummary({
      sessionIds: [],
      createdPRs: [],
      createdCommits: [],
      tokenUsage: null,
    })
    const client = createMockSdkClient()

    // #when
    await writeSessionSummary('ses_test', summary, client as unknown as SessionClient, mockLogger)

    // #then
    const promptCall = client.session.prompt.mock.calls[0]?.[0] as {body: {parts: {text: string}[]}}
    const text = promptCall.body.parts[0]?.text ?? ''
    expect(text).not.toContain('Sessions used:')
    expect(text).not.toContain('PRs created:')
    expect(text).not.toContain('Commits:')
    expect(text).not.toContain('Tokens:')
  })

  it('logs warning and returns when SDK prompt returns error', async () => {
    // #given
    const summary = createMockRunSummary()
    const client = createMockSdkClient({promptResponse: {data: undefined, error: 'server error'}})

    // #when
    await writeSessionSummary('ses_test', summary, client as unknown as SessionClient, mockLogger)

    // #then — warning logged, no throw
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK prompt writeback failed', {
      sessionId: 'ses_test',
      error: expect.stringContaining('server error') as unknown,
    })
    expect(mockLogger.info).not.toHaveBeenCalled()
  })

  it('logs warning and returns when SDK prompt throws', async () => {
    // #given
    const summary = createMockRunSummary()
    const mockPrompt = vi.fn().mockRejectedValue(new Error('connection refused'))
    const client = {session: {prompt: mockPrompt}}

    // #when
    await writeSessionSummary('ses_test', summary, client as unknown as SessionClient, mockLogger)

    // #then — warning logged, no throw
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK prompt writeback failed', {
      sessionId: 'ses_test',
      error: 'connection refused',
    })
    expect(mockLogger.info).not.toHaveBeenCalled()
  })
})
