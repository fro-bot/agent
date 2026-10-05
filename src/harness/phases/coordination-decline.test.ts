import type {LockRecord} from '@fro-bot/runtime'
import type {TriggerContext, TriggerTarget} from '../../features/triggers/types.js'
import type {Octokit} from '../../services/github/types.js'
import * as core from '@actions/core'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {addLabelsToIssue, ensureLabelExists, removeLabelFromIssue} from '../../services/github/api.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {
  BLOCKED_LABEL,
  BLOCKED_LABEL_COLOR,
  BLOCKED_LABEL_DESCRIPTION,
  clearBlockedLabel,
  runCoordinationDecline,
} from './coordination-decline.js'

vi.mock('@actions/core', () => ({
  summary: {
    addHeading: vi.fn().mockReturnThis(),
    addTable: vi.fn().mockReturnThis(),
    addRaw: vi.fn().mockReturnThis(),
    write: vi.fn().mockResolvedValue(undefined),
  },
  warning: vi.fn(),
}))

vi.mock('../../services/github/api.js', () => ({
  addLabelsToIssue: vi.fn().mockResolvedValue(true),
  ensureLabelExists: vi.fn().mockResolvedValue(true),
  removeLabelFromIssue: vi.fn().mockResolvedValue(true),
}))

const client = {} as Octokit

function createContext(target: TriggerTarget | null, action: string | null = 'created'): TriggerContext {
  return {
    eventType: 'issue_comment',
    eventName: 'issue_comment',
    repo: {owner: 'fro-bot', repo: 'agent'},
    ref: 'refs/heads/main',
    sha: 'abc',
    runId: 5,
    actor: 'someone',
    action,
    author: null,
    target,
    commentBody: null,
    commentId: null,
    hasMention: true,
    command: null,
    isBotReviewRequested: false,
    raw: {},
  }
}

function target(kind: TriggerTarget['kind'], number = 7): TriggerTarget {
  return {kind, number, title: 't', body: null, locked: false}
}

function createHolder(overrides: Partial<LockRecord> = {}): LockRecord {
  return {
    repo: 'fro-bot/agent',
    holder_id: 'action:4242:1',
    surface: 'github',
    acquired_at: '2026-10-05T00:00:00.000Z',
    ttl_seconds: 900,
    run_id: '4242',
    ...overrides,
  }
}

function summaryText(): string {
  const raw = vi.mocked(core.summary.addRaw).mock.calls.map(call => String(call[0]))
  const tables = vi.mocked(core.summary.addTable).mock.calls.map(call => JSON.stringify(call[0]))
  const headings = vi.mocked(core.summary.addHeading).mock.calls.map(call => String(call[0]))
  return [...headings, ...raw, ...tables].join('\n')
}

describe('runCoordinationDecline', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes the summary, a warning annotation, and applies the label for an issue target', async () => {
    // #given an Action holder with a live lease and an issue target
    const logger = createMockLogger()

    // #when the decline runs
    await runCoordinationDecline({
      githubClient: client,
      triggerContext: createContext(target('issue')),
      holder: createHolder(),
      reason: 'active-holder',
      responseMode: 'github',
      logger,
    })

    // #then the label is created if missing and applied, with the specified metadata
    expect(ensureLabelExists).toHaveBeenCalledWith(
      client,
      'fro-bot/agent',
      BLOCKED_LABEL,
      BLOCKED_LABEL_COLOR,
      BLOCKED_LABEL_DESCRIPTION,
      logger,
    )
    expect(BLOCKED_LABEL).toBe('agent: blocked')
    expect(BLOCKED_LABEL_COLOR).toBe('D29922')
    expect(addLabelsToIssue).toHaveBeenCalledWith(client, 'fro-bot/agent', 7, [BLOCKED_LABEL], logger)

    // #and the summary names the title, entity link, holder run link, expiry caveat, and recovery guidance
    const text = summaryText()
    expect(vi.mocked(core.summary.addHeading)).toHaveBeenCalledWith('Fro Bot Agent Run — Skipped (Coordination)', 2)
    expect(text).toContain('https://github.com/fro-bot/agent/issues/7')
    expect(text).toContain('issue_comment.created')
    expect(text).toContain('https://github.com/fro-bot/agent/actions/runs/4242')
    expect(text).toContain('2026-10-05T00:15:00.000Z')
    expect(text).toContain('NOT an estimated completion time')
    expect(text).toContain('applied')
    expect(text).toContain('No agent execution occurred. This request was not automatically requeued.')
    expect(text).toContain('Editing the issue alone does not retrigger')
    expect(core.summary.write).toHaveBeenCalled()

    // #and a warning annotation carries the same reason
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Another Fro Bot Action run is active'))
  })

  it('labels pull request targets', async () => {
    // #when the target is a PR
    await runCoordinationDecline({
      githubClient: client,
      triggerContext: createContext(target('pr', 12)),
      holder: createHolder(),
      reason: 'active-holder',
      responseMode: 'github',
      logger: createMockLogger(),
    })

    // #then the PR number is labeled and linked as a pull request
    expect(addLabelsToIssue).toHaveBeenCalledWith(client, 'fro-bot/agent', 12, [BLOCKED_LABEL], expect.anything())
    expect(summaryText()).toContain('https://github.com/fro-bot/agent/pull/12')
  })

  it.each([['manual' as const], ['discussion' as const]])('does not label a %s target', async kind => {
    // #when the target is not an issue/PR
    await runCoordinationDecline({
      githubClient: client,
      triggerContext: createContext(target(kind)),
      holder: createHolder(),
      reason: 'active-holder',
      responseMode: 'github',
      logger: createMockLogger(),
    })

    // #then no label calls are made, the summary and warning still happen
    expect(ensureLabelExists).not.toHaveBeenCalled()
    expect(addLabelsToIssue).not.toHaveBeenCalled()
    expect(core.summary.write).toHaveBeenCalled()
    expect(core.warning).toHaveBeenCalled()
  })

  it('reports a repository-level invocation when there is no target', async () => {
    // #when the trigger has no target
    await runCoordinationDecline({
      githubClient: client,
      triggerContext: createContext(null),
      holder: null,
      reason: 'conflict',
      responseMode: 'github',
      logger: createMockLogger(),
    })

    // #then the summary says so, and the unknown holder does not break rendering
    const text = summaryText()
    expect(text).toContain('repository-level invocation')
    expect(text).toContain('unknown')
    expect(addLabelsToIssue).not.toHaveBeenCalled()
  })

  it('stays non-fatal and reports the label as not applied when labeling fails', async () => {
    // #given label creation fails
    vi.mocked(ensureLabelExists).mockResolvedValueOnce(false)

    // #when the decline runs
    await runCoordinationDecline({
      githubClient: client,
      triggerContext: createContext(target('issue')),
      holder: createHolder(),
      reason: 'active-holder',
      responseMode: 'github',
      logger: createMockLogger(),
    })

    // #then no add is attempted and the summary says it was not applied; warning still emitted
    expect(addLabelsToIssue).not.toHaveBeenCalled()
    expect(summaryText()).toContain('not applied (labeling failed)')
    expect(core.warning).toHaveBeenCalled()
  })

  it('stays non-fatal when a GitHub API call throws', async () => {
    // #given the label API throws
    vi.mocked(ensureLabelExists).mockRejectedValueOnce(new Error('boom'))
    const logger = createMockLogger()

    // #when / #then the decline still completes
    await expect(
      runCoordinationDecline({
        githubClient: client,
        triggerContext: createContext(target('issue')),
        holder: createHolder(),
        reason: 'active-holder',
        responseMode: 'github',
        logger,
      }),
    ).resolves.toBeUndefined()
    expect(core.summary.write).toHaveBeenCalled()
  })

  it('escapes untrusted values and links only well-formed Action holder runs', async () => {
    // #given a trigger action and holder id carrying markup / a non-numeric run id
    await runCoordinationDecline({
      githubClient: client,
      triggerContext: createContext(target('issue'), '<img src=x onerror=alert(1)>|`x`'),
      holder: createHolder({holder_id: 'action:<script>:1'}),
      reason: 'active-holder',
      responseMode: 'github',
      logger: createMockLogger(),
    })

    // #then markup is escaped, and no run link is built from the malformed holder id
    const text = summaryText()
    expect(text).not.toContain('<img')
    expect(text).not.toContain('<script>')
    expect(text).toContain('&lt;img')
    expect(text).not.toContain('/actions/runs/')
  })

  it('skips the label but still writes the summary and warning when response-mode is none', async () => {
    // #given response-mode none, which promises no label changes
    await runCoordinationDecline({
      githubClient: client,
      triggerContext: createContext(target('issue')),
      holder: createHolder(),
      reason: 'active-holder',
      responseMode: 'none',
      logger: createMockLogger(),
    })

    // #then no label API is touched, and the summary says why
    expect(ensureLabelExists).not.toHaveBeenCalled()
    expect(addLabelsToIssue).not.toHaveBeenCalled()
    expect(summaryText()).toContain('not applied (response-mode is none)')
    expect(core.summary.write).toHaveBeenCalled()
    expect(core.warning).toHaveBeenCalled()
  })

  it('reports a takeover conflict with no holder and no Action-run link', async () => {
    // #given a lost takeover race, so the holder is unknown
    await runCoordinationDecline({
      githubClient: client,
      triggerContext: createContext(target('issue')),
      holder: null,
      reason: 'conflict',
      responseMode: 'github',
      logger: createMockLogger(),
    })

    // #then the summary and the warning carry the conflict text, with no run link
    expect(summaryText()).toContain('The coordination lease changed hands')
    expect(summaryText()).not.toContain('/actions/runs/')
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('The coordination lease changed hands'))
  })

  it('states a distinct reason for expired non-Action leases and takeover conflicts', async () => {
    // #when an expired non-Action lease could not be reclaimed
    await runCoordinationDecline({
      githubClient: client,
      triggerContext: createContext(target('issue')),
      holder: createHolder({surface: 'discord', holder_id: 'gateway-1'}),
      reason: 'expired-holder',
      responseMode: 'github',
      logger: createMockLogger(),
    })

    // #then the reason and holder surface are reported without a run link
    expect(summaryText()).toContain('expired coordination lease')
    expect(summaryText()).not.toContain('/actions/runs/')
  })
})

function blockedEvent(event: 'labeled' | 'unlabeled', createdAt: string) {
  return {event, created_at: createdAt, label: {name: BLOCKED_LABEL, color: BLOCKED_LABEL_COLOR}}
}

const blockedLabelPresent = () => vi.fn().mockResolvedValue({data: [{name: 'bug'}, {name: BLOCKED_LABEL}]})

function createEventsClient(
  listEvents: ReturnType<typeof vi.fn>,
  listLabelsOnIssue: ReturnType<typeof vi.fn> = blockedLabelPresent(),
): Octokit {
  return {rest: {issues: {listEvents, listLabelsOnIssue}}} as unknown as Octokit
}

describe('clearBlockedLabel', () => {
  const runStartMs = Date.parse('2026-10-05T12:00:00.000Z')
  const before = '2026-10-05T11:00:00.000Z'
  const after = '2026-10-05T12:30:00.000Z'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('removes the label when it was applied before this invocation started', async () => {
    // #given the most recent labeled event predates the run start
    const listEvents = vi.fn().mockResolvedValue({data: [blockedEvent('labeled', before)]})

    // #when clearing for a PR target
    await clearBlockedLabel(
      createEventsClient(listEvents),
      createContext(target('pr', 12)),
      runStartMs,
      createMockLogger(),
    )

    // #then the blocked label is removed from that number
    expect(removeLabelFromIssue).toHaveBeenCalledWith(
      expect.anything(),
      'fro-bot/agent',
      12,
      BLOCKED_LABEL,
      expect.anything(),
    )
  })

  it('makes no events call and no removal when the label is not on the issue', async () => {
    // #given the label list does not include the blocked label (the common path)
    const listEvents = vi.fn()
    const listLabelsOnIssue = vi.fn().mockResolvedValue({data: [{name: 'bug'}]})

    // #when clearing
    await clearBlockedLabel(
      createEventsClient(listEvents, listLabelsOnIssue),
      createContext(target('issue')),
      runStartMs,
      createMockLogger(),
    )

    // #then only the one label call is made
    expect(listLabelsOnIssue).toHaveBeenCalledTimes(1)
    expect(listEvents).not.toHaveBeenCalled()
    expect(removeLabelFromIssue).not.toHaveBeenCalled()
  })

  it('skips the events call without throwing when listing labels fails', async () => {
    // #given the label list call rejects
    const listEvents = vi.fn()
    const listLabelsOnIssue = vi.fn().mockRejectedValue(new Error('rate limited'))
    const logger = createMockLogger()

    // #when / #then it resolves, warns, and does nothing else
    await expect(
      clearBlockedLabel(
        createEventsClient(listEvents, listLabelsOnIssue),
        createContext(target('issue')),
        runStartMs,
        logger,
      ),
    ).resolves.toBeUndefined()
    expect(listEvents).not.toHaveBeenCalled()
    expect(removeLabelFromIssue).not.toHaveBeenCalled()
    expect(logger.warning).toHaveBeenCalled()
  })

  it('keeps the label when it was applied after this invocation started', async () => {
    // #given a newer decline labeled the target while this run was executing
    const listEvents = vi
      .fn()
      .mockResolvedValue({data: [blockedEvent('labeled', before), blockedEvent('labeled', after)]})

    // #when clearing
    await clearBlockedLabel(
      createEventsClient(listEvents),
      createContext(target('issue')),
      runStartMs,
      createMockLogger(),
    )

    // #then the newest labeled event wins and the label stays
    expect(removeLabelFromIssue).not.toHaveBeenCalled()
  })

  it('does nothing when the label is absent, was already removed, or belongs to another label', async () => {
    // #given no events, an unlabeled-last history, and events for a different label
    const other = {event: 'labeled', created_at: before, label: {name: 'bug', color: 'ffffff'}}
    for (const data of [[], [blockedEvent('labeled', before), blockedEvent('unlabeled', before)], [other]]) {
      // #when clearing
      await clearBlockedLabel(
        createEventsClient(vi.fn().mockResolvedValue({data})),
        createContext(target('issue')),
        runStartMs,
        createMockLogger(),
      )
    }

    // #then nothing is removed
    expect(removeLabelFromIssue).not.toHaveBeenCalled()
  })

  it('pages through the events to find the latest labeled event', async () => {
    // #given 100 unrelated events on page 1 and the blocked label on page 2
    const filler = Array.from({length: 100}, () => ({event: 'commented', created_at: before}))
    const listEvents = vi
      .fn()
      .mockResolvedValueOnce({data: filler})
      .mockResolvedValueOnce({data: [blockedEvent('labeled', before)]})

    // #when clearing
    await clearBlockedLabel(
      createEventsClient(listEvents),
      createContext(target('issue')),
      runStartMs,
      createMockLogger(),
    )

    // #then both pages were read and the label is removed
    expect(listEvents).toHaveBeenCalledTimes(2)
    expect(removeLabelFromIssue).toHaveBeenCalledTimes(1)
  })

  it('skips clearing without throwing when the events API fails', async () => {
    // #given the events call rejects
    const listEvents = vi.fn().mockRejectedValue(new Error('rate limited'))
    const logger = createMockLogger()

    // #when / #then it resolves, logs a warning, and removes nothing
    await expect(
      clearBlockedLabel(createEventsClient(listEvents), createContext(target('issue')), runStartMs, logger),
    ).resolves.toBeUndefined()
    expect(removeLabelFromIssue).not.toHaveBeenCalled()
    expect(logger.warning).toHaveBeenCalled()
  })

  it('does nothing for targets that cannot carry the label', async () => {
    // #given a client that must not be called
    const listEvents = vi.fn()

    // #when clearing for a manual target and for no target
    await clearBlockedLabel(
      createEventsClient(listEvents),
      createContext(target('manual')),
      runStartMs,
      createMockLogger(),
    )
    await clearBlockedLabel(createEventsClient(listEvents), createContext(null), runStartMs, createMockLogger())

    // #then no API call is made
    expect(listEvents).not.toHaveBeenCalled()
    expect(removeLabelFromIssue).not.toHaveBeenCalled()
  })

  it('swallows removal failures', async () => {
    // #given the label is eligible but removal throws
    const listEvents = vi.fn().mockResolvedValue({data: [blockedEvent('labeled', before)]})
    vi.mocked(removeLabelFromIssue).mockRejectedValueOnce(new Error('nope'))

    // #when / #then it does not throw
    await expect(
      clearBlockedLabel(createEventsClient(listEvents), createContext(target('issue')), runStartMs, createMockLogger()),
    ).resolves.toBeUndefined()
  })
})
