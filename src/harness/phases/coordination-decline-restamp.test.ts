import type {LockRecord} from '@fro-bot/runtime'
import type {TriggerContext} from '../../features/triggers/types.js'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockOctokit} from '../../services/github/test-helpers.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {BLOCKED_LABEL, runCoordinationDecline} from './coordination-decline.js'

vi.mock('@actions/core', () => ({
  summary: {
    addHeading: vi.fn().mockReturnThis(),
    addTable: vi.fn().mockReturnThis(),
    addRaw: vi.fn().mockReturnThis(),
    write: vi.fn().mockResolvedValue(undefined),
  },
  warning: vi.fn(),
}))

// Real services/github/api.js on purpose: this file pins how the decline behaves against actual GitHub API errors.

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

describe('runCoordinationDecline label re-stamp against GitHub API errors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('tolerates a 404 on remove (label absent) and still adds the label', async () => {
    // #given the label is not on the issue, so DELETE returns 404
    const removeLabel = vi.fn().mockRejectedValue(Object.assign(new Error('Not Found'), {status: 404}))
    const addLabels = vi.fn().mockResolvedValue({data: []})
    const client = createMockOctokit({removeLabel, addLabels})
    const logger = createMockLogger()

    // #when the decline runs
    await runCoordinationDecline({
      githubClient: client,
      triggerContext: context,
      holder,
      reason: 'active-holder',
      responseMode: 'github',
      logger,
    })

    // #then the remove was attempted, the 404 is not surfaced as a warning, and the label is added
    expect(removeLabel).toHaveBeenCalledWith(expect.objectContaining({issue_number: 7, name: BLOCKED_LABEL}))
    expect(addLabels).toHaveBeenCalledWith(expect.objectContaining({issue_number: 7, labels: [BLOCKED_LABEL]}))
    expect(logger.warning).not.toHaveBeenCalled()
  })

  it('removes before adding against the real API wrappers', async () => {
    // #given a client recording call order
    const calls: string[] = []
    const removeLabel = vi.fn().mockImplementation(async () => {
      calls.push('remove')
      return {data: []}
    })
    const addLabels = vi.fn().mockImplementation(async () => {
      calls.push('add')
      return {data: []}
    })
    const client = createMockOctokit({removeLabel, addLabels})

    // #when the decline runs
    await runCoordinationDecline({
      githubClient: client,
      triggerContext: context,
      holder,
      reason: 'active-holder',
      responseMode: 'github',
      logger: createMockLogger(),
    })

    // #then the label is re-stamped in order
    expect(calls).toEqual(['remove', 'add'])
  })

  it('still adds the label when remove fails with a non-404 error (best-effort, visible label wins)', async () => {
    // #given remove fails with a 500
    const removeLabel = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), {status: 500}))
    const addLabels = vi.fn().mockResolvedValue({data: []})
    const client = createMockOctokit({removeLabel, addLabels})

    // #when the decline runs
    await expect(
      runCoordinationDecline({
        githubClient: client,
        triggerContext: context,
        holder,
        reason: 'active-holder',
        responseMode: 'github',
        logger: createMockLogger(),
      }),
    ).resolves.toBeUndefined()

    // #then the add is still attempted
    expect(addLabels).toHaveBeenCalledTimes(1)
  })
})
