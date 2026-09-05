import type {CommentSummaryOptions, RunMetrics} from './types.js'
import * as core from '@actions/core'
import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest'

import {createLogger} from '../../shared/logger.js'
import {writeCacheSaveResultSummary, writeJobSummary} from './job-summary.js'

vi.mock('@actions/core', () => {
  const mockSummary = {
    addHeading: vi.fn().mockReturnThis(),
    addTable: vi.fn().mockReturnThis(),
    addRaw: vi.fn().mockReturnThis(),
    addList: vi.fn().mockReturnThis(),
    write: vi.fn().mockResolvedValue(undefined),
  }
  return {
    summary: mockSummary,
    warning: vi.fn(),
  }
})

vi.mock('../../shared/logger.js', () => ({
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
    cacheSource: null,
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
  const {resolvedOutputMode, ...restOverrides} = overrides

  return {
    eventType: 'issue_comment',
    repo: 'owner/repo',
    ref: 'main',
    runId: 12345,
    runUrl: 'https://github.com/owner/repo/actions/runs/12345',
    metrics: createMockMetrics(),
    agent: 'sisyphus',
    resolvedOutputMode: resolvedOutputMode ?? null,
    deliveryKind: 'none',
    ...restOverrides,
  }
}

describe('writeJobSummary', () => {
  const logger = createLogger({phase: 'test'})
  const originalStepSummary = process.env.GITHUB_STEP_SUMMARY

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.GITHUB_STEP_SUMMARY
  })

  afterAll(() => {
    if (originalStepSummary != null) {
      process.env.GITHUB_STEP_SUMMARY = originalStepSummary
    }
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
    const tableCall = vi.mocked(core.summary).addTable.mock.calls[0]![0]
    expect(tableCall).toBeDefined()
    expect(tableCall.some(row => Array.isArray(row) && row.includes('issue_comment'))).toBe(true)
    expect(tableCall.some(row => Array.isArray(row) && row.includes('owner/repo'))).toBe(true)
    expect(tableCall.some(row => Array.isArray(row) && row.includes('sisyphus'))).toBe(true)
  })

  it('renders build (default) when agent is null', async () => {
    // #given
    const options = createMockOptions({agent: 'build (default)'})

    // #when
    await writeJobSummary(options, logger)

    // #then
    const tableCall = vi.mocked(core.summary).addTable.mock.calls[0]![0]
    expect(tableCall).toContainEqual(['Agent', 'build (default)'])
  })

  it('includes Output Mode row when resolved mode is set', async () => {
    // #given
    const options = createMockOptions({resolvedOutputMode: 'working-dir'})

    // #when
    await writeJobSummary(options, logger)

    // #then
    const tableCall = vi.mocked(core.summary).addTable.mock.calls[0]![0]
    expect(tableCall).toContainEqual(['Output Mode', 'working-dir'])
  })

  it('includes the delivery kind in the main metrics table', async () => {
    // #given a run that delivered a review
    const options = createMockOptions({deliveryKind: 'review'})

    // #when
    await writeJobSummary(options, logger)

    // #then the consumer-visible summary identifies the delivered response
    const tableCall = vi.mocked(core.summary).addTable.mock.calls[0]![0]
    expect(tableCall).toContainEqual(['Delivery Kind', 'review'])
  })

  it('renders Output Mode as N/A when resolved mode is null', async () => {
    // #given
    const options = createMockOptions({resolvedOutputMode: null})

    // #when
    await writeJobSummary(options, logger)

    // #then
    const tableCall = vi.mocked(core.summary).addTable.mock.calls[0]![0]
    expect(tableCall).toContainEqual(['Output Mode', 'N/A'])
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

  it('includes the classification path for errors in the job summary', async () => {
    // #given an error record with a structured classification path
    const error = Object.assign(
      {timestamp: '2024-01-01T00:00:00Z', type: 'APIError', message: 'Provider unavailable', recoverable: true},
      {classificationPath: 'structured' as const},
    )
    const options = createMockOptions({metrics: createMockMetrics({errors: [error]})})

    // #when writing the job summary
    await writeJobSummary(options, logger)

    // #then the classification path is visible alongside the error
    expect(core.summary.addRaw).toHaveBeenCalledWith(
      '- **APIError** (🔄 Recovered, classification: structured): Provider unavailable\n',
    )
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
    expect(core.warning).toHaveBeenCalledWith('Failed to write job summary: Write failed')
  })
})

describe('writeCacheSaveResultSummary', () => {
  const logger = createLogger({phase: 'test'})

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reports durable with no remediation text', async () => {
    // #given a save that reached durable persistence
    // #when
    await writeCacheSaveResultSummary('durable', 'main', logger)

    // #then the row reports success and no remediation sentence is added
    expect(core.summary.addTable).toHaveBeenCalledWith(
      expect.arrayContaining([['Cache Save Result', expect.stringContaining('persisted')]]),
    )
    expect(core.summary.addRaw).not.toHaveBeenCalled()
    expect(core.summary.write).toHaveBeenCalled()

    // #then no remediation text at all means no s3-backup mention either
    const remediationText = vi.mocked(core.summary).addRaw.mock.calls.flat().join(' ')
    expect(remediationText).not.toContain('s3-backup')
  })

  it('headings distinguish the main-step write from a post-action retry', async () => {
    // #given the same result reported from each phase
    // #when
    await writeCacheSaveResultSummary('durable', 'main', logger)
    await writeCacheSaveResultSummary('durable', 'post-retry', logger)

    // #then the heading names which phase produced the row, since post.ts's retry has no
    // other surface available to distinguish it from the main step's own write
    expect(core.summary.addHeading).toHaveBeenNthCalledWith(1, 'Session Persistence', 3)
    expect(core.summary.addHeading).toHaveBeenNthCalledWith(2, 'Session Persistence (post-action retry)', 3)
  })

  it('names the cache-rejected cause and points at s3-backup when nothing persisted', async () => {
    // #given a save where nothing durable happened (cache rejected, store disabled)
    // #when
    await writeCacheSaveResultSummary('not-persisted', 'main', logger)

    // #then the remediation names every actual cause -- a read-only token, a key
    // collision, and a transient failure -- not just one of them, plus the fix, all in
    // one sentence. Capture every addRaw call (not just the first) so the assertion
    // holds regardless of how the remediation text is split across calls.
    const remediationText = vi.mocked(core.summary).addRaw.mock.calls.flat().join(' ')
    expect(remediationText).toContain('did not accept the write')
    expect(remediationText).toContain('read-only cache token')
    expect(remediationText).toContain('key collision')
    expect(remediationText).toContain('transient')
    expect(remediationText).toContain('s3-backup')

    // #then keeping R4's "one sentence, not a paragraph" bar: no blank line, and no
    // sentence-ending period until the single one that closes the remediation text
    expect(remediationText).not.toContain('\n\n')
    expect(remediationText.trim().indexOf('.')).toBe(remediationText.trim().length - 1)
  })

  it('distinguishes store-only from both full success and failure, without s3-backup advice', async () => {
    // #given the object store persisted the state but the Actions cache write did not
    // #when
    await writeCacheSaveResultSummary('store-only', 'main', logger)

    // #then the row and remediation are distinct from both durable and not-persisted
    expect(core.summary.addTable).toHaveBeenCalledWith(
      expect.arrayContaining([['Cache Save Result', expect.stringContaining('object store only')]]),
    )
    expect(core.summary.addRaw).toHaveBeenCalledWith(expect.stringContaining('object store'))
    expect(core.summary.addRaw).not.toHaveBeenCalledWith(expect.stringContaining('s3-backup'))
  })

  it('does not mention s3-backup for a deliberate skip', async () => {
    // #given SKIP_CACHE or no cacheable content
    // #when
    await writeCacheSaveResultSummary('skipped', 'main', logger)

    // #then no remediation text at all -- a deliberate no-op needs none
    expect(core.summary.addRaw).not.toHaveBeenCalled()

    // #then no remediation text at all means no s3-backup mention either
    const remediationText = vi.mocked(core.summary).addRaw.mock.calls.flat().join(' ')
    expect(remediationText).not.toContain('s3-backup')
  })

  it('does not fail the run when the summary write throws', async () => {
    // #given the same non-blocking observability rule writeJobSummary follows
    vi.mocked(core.summary.write).mockRejectedValueOnce(new Error('Write failed'))

    // #when / #then
    await expect(writeCacheSaveResultSummary('durable', 'main', logger)).resolves.not.toThrow()
    expect(logger.warning).toHaveBeenCalledWith('Failed to write cache save result summary', {error: 'Write failed'})
    expect(core.warning).toHaveBeenCalledWith('Failed to write cache save result summary: Write failed')
  })
})
