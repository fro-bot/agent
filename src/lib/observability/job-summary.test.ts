/* eslint-disable @typescript-eslint/unbound-method */
import type {CommentSummaryOptions, RunMetrics} from './types.js'
import * as core from '@actions/core'
import {beforeEach, describe, expect, it, vi} from 'vitest'

import {createLogger} from '../logger.js'
import {writeJobSummary} from './job-summary.js'

vi.mock('@actions/core', () => {
  const mockSummary = {
    addHeading: vi.fn().mockReturnThis(),
    addTable: vi.fn().mockReturnThis(),
    addRaw: vi.fn().mockReturnThis(),
    addList: vi.fn().mockReturnThis(),
    write: vi.fn().mockResolvedValue(undefined),
  }
  return {summary: mockSummary}
})

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }),
}))

function createMockMetrics(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    startTime: Date.now() - 60000,
    endTime: Date.now(),
    duration: 60000,
    cacheStatus: 'hit',
    sessionsUsed: [],
    sessionsCreated: [],
    prsCreated: [],
    commitsCreated: [],
    commentsPosted: 0,
    tokenUsage: null,
    model: null,
    cost: null,
    errors: [],
    ...overrides,
  }
}

function createMockOptions(overrides: Partial<CommentSummaryOptions> = {}): CommentSummaryOptions {
  return {
    eventType: 'issue_comment',
    repo: 'owner/repo',
    ref: 'main',
    runId: 12345,
    runUrl: 'https://github.com/owner/repo/actions/runs/12345',
    metrics: createMockMetrics(),
    agent: 'Sisyphus',
    ...overrides,
  }
}

describe('writeJobSummary', () => {
  const logger = createLogger({phase: 'test'})

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes summary with required fields', async () => {
    // #given
    const options = createMockOptions()

    // #when
    await writeJobSummary(options, logger)

    // #then
    expect(core.summary.addHeading).toHaveBeenCalledWith('Fro Bot Agent Run', 2)
    expect(core.summary.addTable).toHaveBeenCalled()
    expect(core.summary.write).toHaveBeenCalled()
  })

  it('includes main metrics table', async () => {
    // #given
    const options = createMockOptions()

    // #when
    await writeJobSummary(options, logger)

    // #then
    const tableCall = vi.mocked(core.summary.addTable).mock.calls[0]![0]
    expect(tableCall).toBeDefined()
    expect(tableCall.some(row => Array.isArray(row) && row.includes('issue_comment'))).toBe(true)
    expect(tableCall.some(row => Array.isArray(row) && row.includes('owner/repo'))).toBe(true)
  })

  it('includes sessions section when sessions exist', async () => {
    // #given
    const options = createMockOptions({
      metrics: createMockMetrics({
        sessionsUsed: ['ses_prior'],
        sessionsCreated: ['ses_new'],
      }),
    })

    // #when
    await writeJobSummary(options, logger)

    // #then
    expect(core.summary.addHeading).toHaveBeenCalledWith('Sessions', 3)
    expect(core.summary.addRaw).toHaveBeenCalledWith('**Used:** ses_prior\n')
    expect(core.summary.addRaw).toHaveBeenCalledWith('**Created:** ses_new\n')
  })

  it('includes token usage section when tokens exist', async () => {
    // #given
    const options = createMockOptions({
      metrics: createMockMetrics({
        tokenUsage: {input: 1000, output: 500, reasoning: 0, cache: {read: 0, write: 0}},
        model: 'claude-sonnet-4-20250514',
        cost: 0.01,
      }),
    })

    // #when
    await writeJobSummary(options, logger)

    // #then
    expect(core.summary.addHeading).toHaveBeenCalledWith('Token Usage', 3)
    expect(core.summary.addRaw).toHaveBeenCalledWith('**Model:** claude-sonnet-4-20250514\n')
    expect(core.summary.addRaw).toHaveBeenCalledWith('**Cost:** $0.0100\n')
  })

  it('includes artifacts section when artifacts exist', async () => {
    // #given
    const options = createMockOptions({
      metrics: createMockMetrics({
        prsCreated: ['https://github.com/owner/repo/pull/1'],
        commitsCreated: ['abc123def456'],
        commentsPosted: 2,
      }),
    })

    // #when
    await writeJobSummary(options, logger)

    // #then
    expect(core.summary.addHeading).toHaveBeenCalledWith('Created Artifacts', 3)
    expect(core.summary.addList).toHaveBeenCalled()
    expect(core.summary.addRaw).toHaveBeenCalledWith('**Comments Posted:** 2\n')
  })

  it('includes errors section when errors exist', async () => {
    // #given
    const options = createMockOptions({
      metrics: createMockMetrics({
        errors: [
          {timestamp: '2024-01-01T00:00:00Z', type: 'RateLimit', message: 'API limited', recoverable: true},
          {timestamp: '2024-01-01T00:00:01Z', type: 'NetworkError', message: 'Timeout', recoverable: false},
        ],
      }),
    })

    // #when
    await writeJobSummary(options, logger)

    // #then
    expect(core.summary.addHeading).toHaveBeenCalledWith('Errors', 3)
    expect(core.summary.addRaw).toHaveBeenCalledWith('- **RateLimit** (🔄 Recovered): API limited\n')
    expect(core.summary.addRaw).toHaveBeenCalledWith('- **NetworkError** (❌ Failed): Timeout\n')
  })

  it('omits optional sections when empty', async () => {
    // #given
    const options = createMockOptions({
      metrics: createMockMetrics({
        sessionsUsed: [],
        sessionsCreated: [],
        tokenUsage: null,
        prsCreated: [],
        commitsCreated: [],
        commentsPosted: 0,
        errors: [],
      }),
    })

    // #when
    await writeJobSummary(options, logger)

    // #then
    expect(core.summary.addHeading).toHaveBeenCalledTimes(1)
    expect(core.summary.addHeading).toHaveBeenCalledWith('Fro Bot Agent Run', 2)
    expect(core.summary.addHeading).not.toHaveBeenCalledWith('Sessions', 3)
    expect(core.summary.addHeading).not.toHaveBeenCalledWith('Token Usage', 3)
    expect(core.summary.addHeading).not.toHaveBeenCalledWith('Created Artifacts', 3)
    expect(core.summary.addHeading).not.toHaveBeenCalledWith('Errors', 3)
  })

  it('handles write errors gracefully', async () => {
    // #given
    vi.mocked(core.summary.write).mockRejectedValueOnce(new Error('Write failed'))
    const options = createMockOptions()

    // #when / #then
    await expect(writeJobSummary(options, logger)).resolves.not.toThrow()
    expect(logger.warning).toHaveBeenCalledWith('Failed to write job summary', {error: 'Write failed'})
  })
})
