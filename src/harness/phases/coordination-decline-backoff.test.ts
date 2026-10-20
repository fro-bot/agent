import type {LockRecord} from '@fro-bot/runtime'
import type {TriggerContext} from '../../features/triggers/types.js'
import * as core from '@actions/core'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockOctokit} from '../../services/github/test-helpers.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {runCoordinationDecline} from './coordination-decline.js'

vi.mock('@actions/core', () => ({
  summary: {
    addHeading: vi.fn().mockReturnThis(),
    addTable: vi.fn().mockReturnThis(),
    addRaw: vi.fn().mockReturnThis(),
    write: vi.fn().mockResolvedValue(undefined),
  },
  warning: vi.fn(),
}))

// Real services/github/api.js on purpose, as in coordination-decline-restamp.test.ts. Runtime `sleep` is also real:
// these tests pin how `restoreBackoffMs` entries turn into waits, so the timing comes from fake timers.

const context: TriggerContext = {
  eventType: 'issue_comment',
  eventName: 'issue_comment',
  repo: {owner: 'fro-bot', repo: 'agent'},
  ref: 'refs/heads/main',
  sha: 'abc',
  runId: 5,
  actor: 'someone',
  action: 'created',
  author: null,
  target: {kind: 'issue', number: 7, title: 't', body: null, locked: false},
  commentBody: null,
  commentId: null,
  hasMention: true,
  command: null,
  isBotReviewRequested: false,
  raw: {},
}

const holder: LockRecord = {
  repo: 'fro-bot/agent',
  holder_id: 'action:4242:1',
  surface: 'github',
  acquired_at: '2026-10-05T00:00:00.000Z',
  ttl_seconds: 900,
  run_id: '4242',
}

function failure(): Error {
  return Object.assign(new Error('boom'), {status: 502})
}

async function startDecline(
  client: ReturnType<typeof createMockOctokit>,
  logger: ReturnType<typeof createMockLogger>,
  restoreBackoffMs: readonly number[],
): Promise<void> {
  return runCoordinationDecline({
    githubClient: client,
    triggerContext: context,
    holder,
    reason: 'active-holder',
    responseMode: 'github',
    logger,
    restoreBackoffMs,
  })
}

/** The add wrapper warns on each failed add; the thing to rule out is `applyBlockedLabel` itself throwing. */
function expectNoApplyFailure(logger: ReturnType<typeof createMockLogger>): void {
  expect(logger.warning).not.toHaveBeenCalledWith('Failed to apply blocked label (non-fatal)', expect.anything())
}

/** The status cell of the summary's `Label` row. */
function labelStatuses(): readonly unknown[] {
  return vi
    .mocked(core.summary.addTable)
    .mock.calls.flatMap(call => call[0])
    .map(row => row[1])
    .filter(cell => typeof cell === 'string')
}

describe('runCoordinationDecline restore backoff timing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for a positive backoff entry before the re-add, then restores the label', async () => {
    // #given the remove succeeds, the first add fails, and the retry would succeed, behind a 250 ms backoff
    const removeLabel = vi.fn().mockResolvedValue({data: []})
    const addLabels = vi.fn().mockRejectedValueOnce(failure()).mockResolvedValue({data: []})
    const logger = createMockLogger()

    // #when the decline starts and 249 ms pass
    const done = startDecline(createMockOctokit({removeLabel, addLabels}), logger, [250])
    await vi.advanceTimersByTimeAsync(249)

    // #then the re-add has not run yet
    expect(addLabels).toHaveBeenCalledTimes(1)

    // #when the last millisecond passes
    await vi.advanceTimersByTimeAsync(1)
    await done

    // #then the re-add ran and the label is reported as applied
    expect(addLabels).toHaveBeenCalledTimes(2)
    expect(logger.error).not.toHaveBeenCalled()
    expectNoApplyFailure(logger)
    expect(labelStatuses()).toContain('applied')
  })

  it('retries immediately for a negative entry without waiting or throwing', async () => {
    // #given the remove succeeds, the first add fails, and the retry would succeed behind a -5 ms backoff
    const removeLabel = vi.fn().mockResolvedValue({data: []})
    const addLabels = vi.fn().mockRejectedValueOnce(failure()).mockResolvedValue({data: []})
    const logger = createMockLogger()

    // #when the decline runs with no fake time advanced
    const done = startDecline(createMockOctokit({removeLabel, addLabels}), logger, [-5])
    await vi.advanceTimersByTimeAsync(0)

    // #then no timer is pending and the retry already ran (runtime sleep would have thrown on -5)
    expect(vi.getTimerCount()).toBe(0)
    await expect(done).resolves.toBeUndefined()
    expectNoApplyFailure(logger)
    expect(addLabels).toHaveBeenCalledTimes(2)
    expect(labelStatuses()).toContain('applied')
  })

  it('retries a negative entry immediately and waits only for the positive entry after it', async () => {
    // #given the remove succeeds, and the initial add and the first retry fail, with backoff [-5, 250]
    const removeLabel = vi.fn().mockResolvedValue({data: []})
    const addLabels = vi
      .fn()
      .mockRejectedValueOnce(failure())
      .mockRejectedValueOnce(failure())
      .mockResolvedValue({data: []})
    const logger = createMockLogger()

    // #when the decline runs with no fake time advanced
    const done = startDecline(createMockOctokit({removeLabel, addLabels}), logger, [-5, 250])
    await vi.advanceTimersByTimeAsync(0)

    // #then the first retry already ran, and the second is waiting on a 250 ms timer
    expect(addLabels).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)

    // #when 249 ms pass
    await vi.advanceTimersByTimeAsync(249)

    // #then the second retry has still not run
    expect(addLabels).toHaveBeenCalledTimes(2)

    // #when the last millisecond passes
    await vi.advanceTimersByTimeAsync(1)
    await done

    // #then the second retry ran and the label is applied
    expect(addLabels).toHaveBeenCalledTimes(3)
    expect(logger.error).not.toHaveBeenCalled()
    expectNoApplyFailure(logger)
    expect(labelStatuses()).toContain('applied')
  })
})
