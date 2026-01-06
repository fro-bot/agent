import type {RunSummary} from '../types.js'

import type {Logger} from './types.js'

import * as fs from 'node:fs/promises'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {writeSessionSummary} from './writeback.js'

// Mock fs module
vi.mock('node:fs/promises')
vi.mock('node:os')

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}

// Helper to create mock run summary
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
    tokenUsage: {input: 1000, output: 500},
    ...overrides,
  }
}

describe('writeSessionSummary', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.XDG_DATA_HOME = '/test/data'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.XDG_DATA_HOME
  })

  it('creates message and part files in correct directories', async () => {
    // #given
    const summary = createMockRunSummary()
    vi.mocked(fs.mkdir).mockResolvedValue(undefined)
    vi.mocked(fs.writeFile).mockResolvedValue(undefined)

    // #when
    await writeSessionSummary('ses_test', summary, mockLogger)

    // #then
    expect(fs.mkdir).toHaveBeenCalledWith(expect.stringContaining('/message/ses_test'), {recursive: true})
    expect(fs.mkdir).toHaveBeenCalledWith(expect.stringContaining('/part/msg_'), {recursive: true})
    expect(fs.writeFile).toHaveBeenCalledTimes(2)
  })

  it('writes valid JSON message metadata', async () => {
    // #given
    const summary = createMockRunSummary()
    let writtenMessage: unknown = null

    vi.mocked(fs.mkdir).mockResolvedValue(undefined)
    vi.mocked(fs.writeFile).mockImplementation(async (filePath, content) => {
      const pathStr = String(filePath)
      if (pathStr.includes('/message/') && pathStr.includes('msg_')) {
        writtenMessage = JSON.parse(String(content))
      }
    })

    // #when
    await writeSessionSummary('ses_test', summary, mockLogger)

    // #then
    expect(writtenMessage).not.toBeNull()
    expect(writtenMessage).toMatchObject({
      sessionID: 'ses_test',
      role: 'user',
      agent: 'fro-bot',
      model: {
        providerID: 'system',
        modelID: 'run-summary',
      },
    })
  })

  it('writes valid JSON part with summary text', async () => {
    // #given
    const summary = createMockRunSummary({
      eventType: 'pull_request',
      repo: 'test/repo',
      createdPRs: ['#123'],
    })
    let writtenPart: unknown = null

    vi.mocked(fs.mkdir).mockResolvedValue(undefined)
    vi.mocked(fs.writeFile).mockImplementation(async (filePath, content) => {
      const pathStr = String(filePath)
      if (pathStr.includes('/part/') && pathStr.includes('prt_')) {
        writtenPart = JSON.parse(String(content))
      }
    })

    // #when
    await writeSessionSummary('ses_test', summary, mockLogger)

    // #then
    expect(writtenPart).not.toBeNull()
    const part = writtenPart as {type: string; text: string; sessionID: string}
    expect(part.type).toBe('text')
    expect(part.sessionID).toBe('ses_test')
    expect(part.text).toContain('Fro Bot Run Summary')
    expect(part.text).toContain('Event: pull_request')
    expect(part.text).toContain('Repo: test/repo')
    expect(part.text).toContain('PRs created: #123')
  })

  it('includes token usage in summary text', async () => {
    // #given
    const summary = createMockRunSummary({
      tokenUsage: {input: 2000, output: 1500},
    })
    let writtenPart: unknown = null

    vi.mocked(fs.mkdir).mockResolvedValue(undefined)
    vi.mocked(fs.writeFile).mockImplementation(async (filePath, content) => {
      const pathStr = String(filePath)
      if (pathStr.includes('/part/') && pathStr.includes('prt_')) {
        writtenPart = JSON.parse(String(content))
      }
    })

    // #when
    await writeSessionSummary('ses_test', summary, mockLogger)

    // #then
    const part = writtenPart as {text: string}
    expect(part.text).toContain('Tokens: 2000 in / 1500 out')
  })

  it('includes commits in summary text', async () => {
    // #given
    const summary = createMockRunSummary({
      createdCommits: ['abc1234', 'def5678'],
    })
    let writtenPart: unknown = null

    vi.mocked(fs.mkdir).mockResolvedValue(undefined)
    vi.mocked(fs.writeFile).mockImplementation(async (filePath, content) => {
      const pathStr = String(filePath)
      if (pathStr.includes('/part/') && pathStr.includes('prt_')) {
        writtenPart = JSON.parse(String(content))
      }
    })

    // #when
    await writeSessionSummary('ses_test', summary, mockLogger)

    // #then
    const part = writtenPart as {text: string}
    expect(part.text).toContain('Commits: abc1234, def5678')
  })

  it('generates IDs matching OpenCode format', async () => {
    // #given
    const summary = createMockRunSummary()
    let messageId: string | null = null
    let partId: string | null = null

    vi.mocked(fs.mkdir).mockResolvedValue(undefined)
    vi.mocked(fs.writeFile).mockImplementation(async (filePath, content) => {
      const pathStr = String(filePath)
      if (pathStr.includes('/message/') && pathStr.endsWith('.json')) {
        const parsed = JSON.parse(String(content)) as {id: string}
        messageId = parsed.id
      }
      if (pathStr.includes('/part/') && pathStr.endsWith('.json')) {
        const parsed = JSON.parse(String(content)) as {id: string}
        partId = parsed.id
      }
    })

    // #when
    await writeSessionSummary('ses_test', summary, mockLogger)

    // #then
    expect(messageId).toMatch(/^msg_[0-9a-f][0-9A-Za-z]+$/)
    expect(partId).toMatch(/^prt_[0-9a-f][0-9A-Za-z]+$/)
  })

  it('logs success on completion', async () => {
    // #given
    const summary = createMockRunSummary()
    vi.mocked(fs.mkdir).mockResolvedValue(undefined)
    vi.mocked(fs.writeFile).mockResolvedValue(undefined)

    // #when
    await writeSessionSummary('ses_test', summary, mockLogger)

    // #then
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Session summary written',
      expect.objectContaining({sessionId: 'ses_test'}),
    )
  })

  it('handles write errors gracefully', async () => {
    // #given
    const summary = createMockRunSummary()
    vi.mocked(fs.mkdir).mockResolvedValue(undefined)
    vi.mocked(fs.writeFile).mockRejectedValue(new Error('Permission denied'))

    // #when
    await writeSessionSummary('ses_test', summary, mockLogger)

    // #then - should not throw, just log warning
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Failed to write session summary',
      expect.objectContaining({
        sessionId: 'ses_test',
        error: 'Permission denied',
      }),
    )
  })

  it('handles mkdir errors gracefully', async () => {
    // #given
    const summary = createMockRunSummary()
    vi.mocked(fs.mkdir).mockRejectedValue(new Error('No space left'))

    // #when
    await writeSessionSummary('ses_test', summary, mockLogger)

    // #then - should not throw, just log warning
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Failed to write session summary',
      expect.objectContaining({
        sessionId: 'ses_test',
        error: 'No space left',
      }),
    )
  })

  it('omits optional fields when not present', async () => {
    // #given
    const summary = createMockRunSummary({
      sessionIds: [],
      createdPRs: [],
      createdCommits: [],
      tokenUsage: null,
    })
    let writtenPart: unknown = null

    vi.mocked(fs.mkdir).mockResolvedValue(undefined)
    vi.mocked(fs.writeFile).mockImplementation(async (filePath, content) => {
      const pathStr = String(filePath)
      if (pathStr.includes('/part/') && pathStr.includes('prt_')) {
        writtenPart = JSON.parse(String(content))
      }
    })

    // #when
    await writeSessionSummary('ses_test', summary, mockLogger)

    // #then
    const part = writtenPart as {text: string}
    expect(part.text).not.toContain('Sessions used:')
    expect(part.text).not.toContain('PRs created:')
    expect(part.text).not.toContain('Commits:')
    expect(part.text).not.toContain('Tokens:')
  })
})
