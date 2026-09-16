import type {CacheSaveResult} from '../../shared/cache-save-result.js'
import type {CommentSummaryOptions, RunMetrics} from './types.js'
import * as core from '@actions/core'
import {createOwnershipLedger} from '@fro-bot/runtime'
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

  describe('Background Work section', () => {
    it('omits the section entirely when no ledger is supplied (byte-identical to today)', async () => {
      // #given a run with no ownership ledger at all -- every run in production before this unit
      const options = createMockOptions()

      // #when
      await writeJobSummary(options, logger)

      // #then nothing about background work is added
      expect(core.summary.addHeading).not.toHaveBeenCalledWith('Background Work', 3)
    })

    it('omits the section entirely when the ledger is empty (byte-identical to today)', async () => {
      // #given a ledger that adopted nothing this run
      const ledger = createOwnershipLedger()
      const options = createMockOptions()

      // #when
      await writeJobSummary(options, logger, ledger)

      // #then nothing about background work is added -- an empty ledger must not add an empty section
      expect(core.summary.addHeading).not.toHaveBeenCalledWith('Background Work', 3)
    })

    it('happy path: a fully drained run reports no unfinished work', async () => {
      // #given two entries, both settled
      const ledger = createOwnershipLedger()
      ledger.adopt('session-1', 'reviewer-subagent')
      ledger.adopt('session-2', 'linter-subagent')
      ledger.settle('session-1')
      ledger.settle('session-2')
      const options = createMockOptions()

      // #when
      await writeJobSummary(options, logger, ledger)

      // #then the section confirms nothing is missing, without naming anything as unfinished
      expect(core.summary.addHeading).toHaveBeenCalledWith('Background Work', 3)
      expect(core.summary.addRaw).toHaveBeenCalledWith('All background work finished.\n')
      expect(core.summary.addRaw).not.toHaveBeenCalledWith(expect.stringContaining('Did not finish'))
    })

    it('edge case: one unfinished execution is named by label, cancelled at the deadline', async () => {
      // #given a run that cancelled two reviewer subagents at the deadline: reconciliation
      // confirmed one stopped (settled) and could not confirm the other (unknown)
      const ledger = createOwnershipLedger()
      ledger.adopt('session-1', 'reviewer-subagent-a')
      ledger.adopt('session-2', 'reviewer-subagent-b')
      ledger.settle('session-1')
      ledger.markUnknown('session-2')
      const options = createMockOptions()

      // #when
      await writeJobSummary(options, logger, ledger)

      // #then the unconfirmed one is named by label, not folded into a bare count -- and
      // the settled one is not named as unfinished (the array is exact, not a superset)
      expect(core.summary.addRaw).toHaveBeenCalledWith('**Did not finish:**\n')
      expect(core.summary.addList).toHaveBeenCalledWith(['reviewer-subagent-b (unconfirmed)'])
    })

    it('edge case: an unknown entry is reported as unknown rather than finished', async () => {
      // #given a single entry the drain could not confirm
      const ledger = createOwnershipLedger()
      ledger.adopt('session-1', 'linter-subagent')
      ledger.markUnknown('session-1')
      const options = createMockOptions()

      // #when
      await writeJobSummary(options, logger, ledger)

      // #then it is listed with its unconfirmed state, never claimed as finished
      expect(core.summary.addList).toHaveBeenCalledWith(['linter-subagent (unconfirmed)'])
      expect(core.summary.addRaw).not.toHaveBeenCalledWith('All background work finished.\n')
    })

    it('edge case: a run finishing with unknown entries explicitly reports the degraded state', async () => {
      // #given one settled entry and one unknown entry
      const ledger = createOwnershipLedger()
      ledger.adopt('session-1', 'reviewer-subagent')
      ledger.adopt('session-2', 'linter-subagent')
      ledger.settle('session-1')
      ledger.markUnknown('session-2')
      const options = createMockOptions()

      // #when
      await writeJobSummary(options, logger, ledger)

      // #then a distinct degraded-state banner is written, not just an unfinished-work list
      expect(core.summary.addRaw).toHaveBeenCalledWith(
        expect.stringContaining('could not be confirmed finished or cancelled'),
      )
    })

    it('renders whatever label the dispatch site supplied, unmodified', async () => {
      // #given an entry adopted with an arbitrary caller-supplied label (the summary never
      // rewrites it -- reconciliation itself never adopts an entry, so there is no separate
      // reconciliation-only label path to preserve; see `writeBackgroundWorkSummary`'s doc comment)
      const ledger = createOwnershipLedger()
      ledger.adopt('session-1', 'reconciled')
      ledger.markUnknown('session-1')
      const options = createMockOptions()

      // #when
      await writeJobSummary(options, logger, ledger)

      // #then the label is rendered exactly as supplied
      expect(core.summary.addList).toHaveBeenCalledWith(['reconciled (unconfirmed)'])
    })

    it('integration: descendant token usage appears alongside the ledger section', async () => {
      // #given a run whose metrics.tokenUsage reflects an owned descendant's usage
      // (streaming.ts routes message.updated events from adopted descendants into the
      // same token accounting as the root session -- see isOwnedSession) and a ledger
      // naming that descendant
      const ledger = createOwnershipLedger()
      ledger.adopt('session-1', 'reviewer-subagent')
      ledger.settle('session-1')
      const options = createMockOptions({
        metrics: createMockMetrics({
          tokenUsage: {input: 1000, output: 500, reasoning: 0, cache: {read: 0, write: 0}},
          model: 'claude-sonnet-4-20250514',
          cost: 0.01,
        }),
      })

      // #when
      await writeJobSummary(options, logger, ledger)

      // #then both the token accounting and the background-work section are present --
      // the ledger section does not suppress or replace the existing Token Usage table
      expect(core.summary.addHeading).toHaveBeenCalledWith('Token Usage', 3)
      expect(core.summary.addHeading).toHaveBeenCalledWith('Background Work', 3)
    })
  })
})

describe('writeCacheSaveResultSummary', () => {
  const logger = createLogger({phase: 'test'})

  const persistedResult: CacheSaveResult = {cachePersisted: true, storePersisted: false, outcome: 'persisted'}
  const cacheRejectedResult: CacheSaveResult = {
    cachePersisted: false,
    storePersisted: false,
    outcome: 'cache-rejected',
  }
  const storeOnlyResult: CacheSaveResult = {cachePersisted: false, storePersisted: true, outcome: 'cache-rejected'}
  const skippedResult: CacheSaveResult = {
    cachePersisted: false,
    storePersisted: false,
    outcome: 'skipped-by-configuration',
  }
  const skippedEmptyResult: CacheSaveResult = {cachePersisted: false, storePersisted: false, outcome: 'skipped-empty'}
  const checkpointDeclinedResult: CacheSaveResult = {
    cachePersisted: false,
    storePersisted: false,
    outcome: 'checkpoint-declined',
  }
  const ownershipDeclinedResult: CacheSaveResult = {
    cachePersisted: false,
    storePersisted: false,
    outcome: 'ownership-declined',
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reports durable with no remediation text', async () => {
    // #given a save that reached durable persistence
    // #when
    await writeCacheSaveResultSummary(persistedResult, 'main', logger)

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
    await writeCacheSaveResultSummary(persistedResult, 'main', logger)
    await writeCacheSaveResultSummary(persistedResult, 'post-retry', logger)

    // #then the heading names which phase produced the row, since post.ts's retry has no
    // other surface available to distinguish it from the main step's own write
    expect(core.summary.addHeading).toHaveBeenNthCalledWith(1, 'Session Persistence', 3)
    expect(core.summary.addHeading).toHaveBeenNthCalledWith(2, 'Session Persistence (post-action retry)', 3)
  })

  it('names the cache-rejected cause and points at s3-backup when nothing persisted', async () => {
    // #given a save where nothing durable happened (cache rejected, store disabled)
    // #when
    await writeCacheSaveResultSummary(cacheRejectedResult, 'main', logger)

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
    await writeCacheSaveResultSummary(storeOnlyResult, 'main', logger)

    // #then the row and remediation are distinct from both durable and not-persisted
    expect(core.summary.addTable).toHaveBeenCalledWith(
      expect.arrayContaining([['Cache Save Result', expect.stringContaining('object store only')]]),
    )
    expect(core.summary.addRaw).toHaveBeenCalledWith(expect.stringContaining('object store'))
    expect(core.summary.addRaw).not.toHaveBeenCalledWith(expect.stringContaining('s3-backup'))
  })

  it('does not mention s3-backup for a deliberate skip', async () => {
    // #given SKIP_CACHE
    // #when
    await writeCacheSaveResultSummary(skippedResult, 'main', logger)

    // #then no remediation text at all -- a deliberate no-op needs none
    expect(core.summary.addRaw).not.toHaveBeenCalled()

    // #then no remediation text at all means no s3-backup mention either
    const remediationText = vi.mocked(core.summary).addRaw.mock.calls.flat().join(' ')
    expect(remediationText).not.toContain('s3-backup')
  })

  it('reports no cacheable content was found for skipped-empty, without s3-backup advice or rejected-write framing', async () => {
    // #given hasCacheableContent found nothing to save -- distinct from a rejected write
    // #when
    await writeCacheSaveResultSummary(skippedEmptyResult, 'main', logger)

    // #then the cell still reads not-persisted (the state-value icon), but the sentence
    // names the actual cause and does not suggest s3-backup -- it would not have helped
    expect(core.summary.addTable).toHaveBeenCalledWith(
      expect.arrayContaining([['Cache Save Result', expect.stringContaining('not persisted')]]),
    )
    const remediationText = vi.mocked(core.summary).addRaw.mock.calls.flat().join(' ')
    expect(remediationText).toContain('No session state was found to save')
    expect(remediationText).toContain('post-action step retries')
    expect(remediationText).not.toContain('did not accept the write')
    expect(remediationText).not.toContain('s3-backup')
  })

  it('drops the post-action-retries clause for skipped-empty when reported from the post-retry phase itself', async () => {
    // #given writeCacheSaveResultSummary(result, 'post-retry', logger) -- the post hook's
    // own retry, which the retries clause would otherwise falsely describe as still
    // pending
    // #when
    await writeCacheSaveResultSummary(skippedEmptyResult, 'post-retry', logger)

    // #then the cause is still named, but nothing claims a retry will follow
    const remediationText = vi.mocked(core.summary).addRaw.mock.calls.flat().join(' ')
    expect(remediationText).toContain('No session state was found to save')
    expect(remediationText).not.toContain('post-action step retries')
  })

  it('reports a declined checkpoint distinctly from a rejected write, without s3-backup advice', async () => {
    // #given the SQLite WAL could not be checkpointed, so no write was even attempted
    // #when
    await writeCacheSaveResultSummary(checkpointDeclinedResult, 'main', logger)

    // #then the sentence names the checkpoint failure, not a rejected write, and does not
    // suggest s3-backup -- a declined checkpoint means no write was attempted at all
    const remediationText = vi.mocked(core.summary).addRaw.mock.calls.flat().join(' ')
    expect(remediationText).toContain('could not be checkpointed')
    expect(remediationText).toContain('no write was attempted')
    expect(remediationText).toContain('post-action step retries')
    expect(remediationText).not.toContain('did not accept the write')
    expect(remediationText).not.toContain('s3-backup')
  })

  it('drops the post-action-retries clause for checkpoint-declined when reported from the post-retry phase itself', async () => {
    // #given writeCacheSaveResultSummary(result, 'post-retry', logger) -- rendering this
    // sentence from post.ts's own retry, which the clause would otherwise falsely
    // describe as still pending
    // #when
    await writeCacheSaveResultSummary(checkpointDeclinedResult, 'post-retry', logger)

    // #then the cause is still named, but nothing claims a retry will follow
    const remediationText = vi.mocked(core.summary).addRaw.mock.calls.flat().join(' ')
    expect(remediationText).toContain('could not be checkpointed')
    expect(remediationText).not.toContain('post-action step retries')
  })

  it('reports a declined persistence distinctly from a rejected write, and names why via declineReason', async () => {
    // #given persistence safety could not be confirmed (unresolved ownership, unconfirmed
    // quiescence, or a failed lease renewal) -- the review finding this unit exists to fix:
    // a decline must be visible with a reason, not silent
    // #when
    await writeCacheSaveResultSummary(
      ownershipDeclinedResult,
      'main',
      logger,
      'the coordination lease could not be renewed',
    )

    // #then the base sentence names persistence safety, distinct from a rejected write,
    // and the specific declineReason is appended so a reader does not need the logs
    const remediationText = vi.mocked(core.summary).addRaw.mock.calls.flat().join(' ')
    expect(remediationText).toContain('persistence safety could not be confirmed')
    expect(remediationText).toContain('**Reason:** the coordination lease could not be renewed')
    expect(remediationText).not.toContain('did not accept the write')
    expect(remediationText).not.toContain('s3-backup')
  })

  it('states plainly that the post-action step will not retry an ownership decline, from the main-phase row', async () => {
    // #given the review finding this unit fixes: cleanup.ts's main-phase row used to
    // claim "the post-action step retries once that condition clears", but post.ts's
    // `declined-for-safety` branch deliberately never retries -- it honors the decline.
    // Both rows must tell the same story about the same decision.
    // #when
    await writeCacheSaveResultSummary(ownershipDeclinedResult, 'main', logger)

    // #then the sentence says the post-action step will not retry it, and makes no retry
    // promise of any kind (no "once that condition clears", no bare "retries" clause)
    const remediationText = vi.mocked(core.summary).addRaw.mock.calls.flat().join(' ')
    expect(remediationText).toContain('the post-action step will not retry it')
    expect(remediationText).not.toContain('post-action step retries')
    expect(remediationText).not.toContain('once that condition clears')
  })

  it('omits the Reason line when declineReason is not supplied for an ownership-declined result', async () => {
    // #given a caller that (incorrectly, or in a future refactor) omits the reason --
    // the base sentence must still render rather than throwing
    // #when
    await writeCacheSaveResultSummary(ownershipDeclinedResult, 'main', logger)

    // #then
    const remediationText = vi.mocked(core.summary).addRaw.mock.calls.flat().join(' ')
    expect(remediationText).toContain('persistence safety could not be confirmed')
    expect(remediationText).not.toContain('**Reason:**')
  })

  it('does not fail the run when the summary write throws', async () => {
    // #given the same non-blocking observability rule writeJobSummary follows
    vi.mocked(core.summary.write).mockRejectedValueOnce(new Error('Write failed'))

    // #when / #then
    await expect(writeCacheSaveResultSummary(persistedResult, 'main', logger)).resolves.not.toThrow()
    expect(logger.warning).toHaveBeenCalledWith('Failed to write cache save result summary', {error: 'Write failed'})
    expect(core.warning).toHaveBeenCalledWith('Failed to write cache save result summary: Write failed')
  })
})
