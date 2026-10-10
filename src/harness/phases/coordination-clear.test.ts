import type {TriggerContext, TriggerTarget} from '../../features/triggers/types.js'
import type {Octokit} from '../../services/github/types.js'
import type {InvocationOutcome} from '../outcome.js'
import {WORKING_LABEL} from '@fro-bot/runtime'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockOctokit} from '../../services/github/test-helpers.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {BLOCKED_LABEL_CLEAR_DEADLINE_MS, runBlockedLabelClear} from './coordination-clear.js'
import {BLOCKED_LABEL} from './coordination-decline.js'

// Real services/github/api.js on purpose: these tests pin how the clear decision reads GitHub's own clock.

// #1756: attempt 1 was declined and labeled at 14:35:17Z; Marcus re-ran it, and the re-run's acknowledge phase
// applied `agent: working` at 21:43:22Z -- the run-start anchor.
const DECLINE_LABELED_AT = '2026-10-09T14:35:17Z'
const WORKING_LABELED_AT = '2026-10-09T21:43:22Z'

function target(kind: TriggerTarget['kind'], number = 1756): TriggerTarget {
  return {kind, number, title: 't', body: null, locked: false}
}

function createContext(t: TriggerTarget | null, raw: Record<string, unknown> = {}): TriggerContext {
  return {
    eventType: 'issue_comment',
    eventName: 'issue_comment',
    repo: {owner: 'fro-bot', repo: 'agent'},
    ref: 'refs/heads/main',
    sha: 'abc',
    runId: 37945216417,
    actor: 'someone',
    action: 'created',
    author: null,
    target: t,
    commentBody: null,
    commentId: null,
    hasMention: true,
    command: null,
    isBotReviewRequested: false,
    raw,
  }
}

function labeledEvent(createdAt: string, name: string) {
  return {event: 'labeled', created_at: createdAt, label: {name}}
}

const blockedEvent = (createdAt: string = DECLINE_LABELED_AT) => labeledEvent(createdAt, BLOCKED_LABEL)
const workingEvent = (createdAt: string = WORKING_LABELED_AT) => labeledEvent(createdAt, WORKING_LABEL)
const unrelated = {event: 'commented', created_at: '2026-10-09T18:00:00Z'}

interface ClientSetup {
  readonly labels?: readonly string[] | Error
  readonly eventPages?: readonly (readonly unknown[])[] | Error
}

function createClient(setup: ClientSetup = {}) {
  const labels = setup.labels ?? [BLOCKED_LABEL]
  const listLabelsOnIssue = vi.fn().mockImplementation(async () => {
    if (labels instanceof Error) throw labels
    return {data: labels.map(name => ({name}))}
  })
  const eventPages = setup.eventPages ?? [[blockedEvent(), workingEvent()]]
  const listEvents = vi.fn().mockImplementation(async ({page}: {page: number}) => {
    if (eventPages instanceof Error) throw eventPages
    const headers =
      eventPages.length > 1
        ? {
            link: `<https://api.github.com/x?per_page=100&page=2>; rel="next", <https://api.github.com/x?per_page=100&page=${eventPages.length}>; rel="last"`,
          }
        : {}
    return {data: eventPages[page - 1] ?? [], headers}
  })
  const removeLabel = vi.fn().mockResolvedValue({data: []})
  const client: Octokit = createMockOctokit({listLabelsOnIssue, listEvents, removeLabel})
  return {client, listLabelsOnIssue, listEvents, removeLabel}
}

function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), {status})
}

function fetchedPages(listEvents: ReturnType<typeof vi.fn>): number[] {
  return listEvents.mock.calls.map(call => (call[0] as {page: number}).page)
}

async function clear(
  client: Octokit,
  overrides: Partial<{
    outcome: InvocationOutcome
    responseMode: 'github' | 'none'
    context: TriggerContext
    deadlineMs: number
  }> = {},
) {
  const logger = createMockLogger()
  await runBlockedLabelClear({
    githubClient: client,
    triggerContext: overrides.context ?? createContext(target('issue')),
    outcome: overrides.outcome ?? 'succeeded',
    responseMode: overrides.responseMode ?? 'github',
    logger,
    deadlineMs: overrides.deadlineMs,
  })
  return logger
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return {promise, resolve}
}

const settle = async () => new Promise<void>(resolve => setTimeout(resolve, 10))

describe('runBlockedLabelClear', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('clears', () => {
    it('removes the label when the blocked labeled event is older than the run-start working label event', async () => {
      // #given the label is present and was applied before this run's acknowledge applied agent: working
      const c = createClient()

      // #when a succeeded run reaches the clear step
      await clear(c.client)

      // #then the label is removed, and no Actions endpoint is involved (only issue label/event reads)
      expect(c.removeLabel).toHaveBeenCalledWith(
        expect.objectContaining({owner: 'fro-bot', repo: 'agent', issue_number: 1756, name: BLOCKED_LABEL}),
      )
      expect(c.listEvents).toHaveBeenCalledTimes(1)
    })

    it('clears on a re-run whose payload timestamps are old but whose working event is fresh (#1756)', async () => {
      // #given a re-run reusing attempt 1's payload (comment created before the decline) and a fresh working event
      const stalePayload = {comment: {created_at: '2026-10-09T14:30:00Z', updated_at: '2026-10-09T14:30:00Z'}}
      const c = createClient()

      // #when the re-run succeeds
      await clear(c.client, {context: createContext(target('issue'), stalePayload)})

      // #then the label is cleared from GitHub's event clock, not the payload (a payload anchor would keep it)
      expect(c.removeLabel).toHaveBeenCalledTimes(1)
    })

    it('clears the label on pull request targets too', async () => {
      // #given a PR target
      const c = createClient()

      // #when the run succeeds
      await clear(c.client, {context: createContext(target('pr', 12))})

      // #then the PR's label is removed
      expect(c.removeLabel).toHaveBeenCalledWith(expect.objectContaining({issue_number: 12}))
    })

    it('matches label names case-insensitively and ignores events for other labels', async () => {
      // #given case-differing label names and an unrelated, newer label event
      const c = createClient({
        labels: ['Agent: Blocked'],
        eventPages: [
          [
            labeledEvent(DECLINE_LABELED_AT, 'AGENT: BLOCKED'),
            labeledEvent(WORKING_LABELED_AT, 'Agent: Working'),
            labeledEvent('2026-10-09T23:00:00Z', 'bug'),
          ],
        ],
      })

      // #when the run succeeds
      await clear(c.client)

      // #then only the two relevant labels are compared, so the label is cleared
      expect(c.removeLabel).toHaveBeenCalledTimes(1)
    })
  })

  describe('keeps', () => {
    it('keeps the label on a same-second tie', async () => {
      // #given the blocked and working labeled events share a whole-second timestamp
      const c = createClient({eventPages: [[blockedEvent(WORKING_LABELED_AT), workingEvent()]]})

      // #when the run succeeds
      await clear(c.client)

      // #then ordering is ambiguous, so the label is kept
      expect(c.removeLabel).not.toHaveBeenCalled()
    })

    it('keeps the label when the blocked event is newer than the working event', async () => {
      // #given a decline landed after this run applied its working label
      const c = createClient({eventPages: [[workingEvent(), blockedEvent('2026-10-09T21:50:00Z')]]})

      // #when the run succeeds
      await clear(c.client)

      // #then the label is kept
      expect(c.removeLabel).not.toHaveBeenCalled()
    })

    it('uses the LATEST blocked event when the label was re-stamped more than once', async () => {
      // #given an old blocked event followed by a newer re-stamp after the working event
      const c = createClient({eventPages: [[blockedEvent(), workingEvent(), blockedEvent('2026-10-09T21:50:00Z')]]})

      // #when the run succeeds
      await clear(c.client)

      // #then the newer event wins and the label is kept
      expect(c.removeLabel).not.toHaveBeenCalled()
    })

    it('keeps the label when there is no agent: working labeled event at all', async () => {
      // #given acknowledge never applied the working label (skipped, or the add failed this run)
      const c = createClient({eventPages: [[blockedEvent()]]})

      // #when the run succeeds
      const logger = await clear(c.client)

      // #then there is no anchor, so the label is kept and the reason is logged
      expect(c.removeLabel).not.toHaveBeenCalled()
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Keeping blocked label'),
        expect.objectContaining({hasBlockedEvent: true, hasWorkingEvent: false}),
      )
    })

    it('keeps the label when agent: working was already present at acknowledge (no fresh event) and predates the decline', async () => {
      // #given a crashed earlier run left agent: working in place AFTER the decline, and this run's acknowledge
      // re-added the existing label (no new event), so the latest working event is the crashed run's, older than
      // this run's start -- and the decline came after it
      const c = createClient({eventPages: [[workingEvent('2026-10-09T10:00:00Z'), blockedEvent()]]})

      // #when the run succeeds
      await clear(c.client)

      // #then the stale anchor is older than the decline, so the label is kept (fails safe)
      expect(c.removeLabel).not.toHaveBeenCalled()
    })

    it('never over-clears with a stale working anchor: an anchor older than this run start only keeps more', async () => {
      // #given a stale working event (crashed run) older than a decline that landed during this run
      // (decline 21:50 > stale anchor 10:00; this run started ~21:43)
      const c = createClient({
        eventPages: [[workingEvent('2026-10-09T10:00:00Z'), blockedEvent('2026-10-09T21:50:00Z')]],
      })

      // #when the run succeeds
      await clear(c.client)

      // #then the decline is not cleared
      expect(c.removeLabel).not.toHaveBeenCalled()
    })

    it('keeps the label when no blocked labeled event can be found', async () => {
      // #given the label is present but the events carry no labeled event for it
      const c = createClient({eventPages: [[workingEvent(), unrelated]]})

      // #when the run succeeds
      await clear(c.client)

      // #then it is kept
      expect(c.removeLabel).not.toHaveBeenCalled()
    })

    it('makes no events calls at all when the label is absent', async () => {
      // #given the item does not carry the blocked label
      const c = createClient({labels: ['bug']})

      // #when the run succeeds
      await clear(c.client)

      // #then exactly one read happened (the labels list) and nothing else
      expect(c.listLabelsOnIssue).toHaveBeenCalledTimes(1)
      expect(c.listEvents).not.toHaveBeenCalled()
      expect(c.removeLabel).not.toHaveBeenCalled()
    })

    it('keeps the label and logs why when the issue events API fails', async () => {
      // #given events are unreadable
      const c = createClient({eventPages: httpError(500)})

      // #when the run succeeds
      const logger = await clear(c.client)

      // #then nothing is removed and the reason is logged
      expect(c.removeLabel).not.toHaveBeenCalled()
      expect(logger.warning).toHaveBeenCalledWith(
        'Failed to read issue events',
        expect.objectContaining({issueNumber: 1756, error: 'HTTP 500'}),
      )
    })

    it('keeps the label when the labels list is unreadable', async () => {
      // #given listing labels fails
      const c = createClient({labels: httpError(500)})

      // #when the run succeeds
      await clear(c.client)

      // #then nothing else is attempted
      expect(c.listEvents).not.toHaveBeenCalled()
      expect(c.removeLabel).not.toHaveBeenCalled()
    })

    it('does not throw when the remove itself fails', async () => {
      // #given the final DELETE fails
      const c = createClient()
      c.removeLabel.mockRejectedValue(httpError(500))

      // #when / #then the clear step still resolves
      await expect(clear(c.client)).resolves.toBeDefined()
    })

    it('gives up within the deadline when the API hangs, and does not remove', async () => {
      // #given a labels call that never settles
      const c = createClient()
      c.listLabelsOnIssue.mockImplementation(async () => new Promise(() => {}))

      // #when the run succeeds with a tiny deadline
      const logger = await clear(c.client, {deadlineMs: 20})

      // #then the step returns, logs the timeout, and removes nothing
      expect(c.removeLabel).not.toHaveBeenCalled()
      expect(logger.warning).toHaveBeenCalledWith(
        expect.stringContaining('Blocked label clear timed out'),
        expect.anything(),
      )
      expect(BLOCKED_LABEL_CLEAR_DEADLINE_MS).toBeLessThanOrEqual(30_000)
    })
  })

  describe('after the deadline', () => {
    it('starts no DELETE when the labels read resolves only after the timeout', async () => {
      // #given a labels read that is held until after the deadline, then yields a stale blocked label
      const c = createClient()
      const gate = deferred<{data: readonly {name: string}[]}>()
      c.listLabelsOnIssue.mockImplementation(async () => gate.promise)

      // #when the clear times out and only then does the read resolve
      const logger = await clear(c.client, {deadlineMs: 20})
      gate.resolve({data: [{name: BLOCKED_LABEL}]})
      await settle()

      // #then the timeout was logged and no later read or DELETE was started
      expect(logger.warning).toHaveBeenCalledWith(
        expect.stringContaining('Blocked label clear timed out'),
        expect.anything(),
      )
      expect(c.listEvents).not.toHaveBeenCalled()
      expect(c.removeLabel).not.toHaveBeenCalled()
    })

    it('starts no DELETE when the events read resolves only after the timeout', async () => {
      // #given an events read held until after the deadline, whose result would justify clearing
      const c = createClient()
      const gate = deferred<{data: readonly unknown[]; headers: Record<string, string>}>()
      c.listEvents.mockImplementation(async () => gate.promise)

      // #when the clear times out and only then does the read resolve
      await clear(c.client, {deadlineMs: 20})
      gate.resolve({data: [blockedEvent(), workingEvent()], headers: {}})
      await settle()

      // #then the DELETE is never issued
      expect(c.removeLabel).not.toHaveBeenCalled()
    })

    it('hands Octokit an abort signal that fires at the deadline', async () => {
      // #given a hung labels read
      const c = createClient()
      c.listLabelsOnIssue.mockImplementation(async () => new Promise(() => {}))

      // #when the clear times out
      await clear(c.client, {deadlineMs: 20})

      // #then the read was given a request signal and it has been aborted
      const params = c.listLabelsOnIssue.mock.calls[0]?.[0] as {request?: {signal: AbortSignal}}
      expect(params.request?.signal.aborted).toBe(true)
    })
  })

  describe('paging', () => {
    it('finds both events with only the first and last page fetched when both are on the last page', async () => {
      // #given three pages with both labeled events on the last page
      const c = createClient({eventPages: [[unrelated], [unrelated], [blockedEvent(), workingEvent()]]})

      // #when the run succeeds
      await clear(c.client)

      // #then page 1 (for the Link header) and page 3 are fetched; page 2 is never walked
      expect(fetchedPages(c.listEvents)).toEqual([1, 3])
      expect(c.removeLabel).toHaveBeenCalledTimes(1)
    })

    it('looks back from the last page for the blocked event, in one pass for both labels', async () => {
      // #given the working event on the last page (4) and the blocked event two pages earlier (2)
      const c = createClient({
        eventPages: [[blockedEvent('2026-10-09T09:00:00Z')], [blockedEvent()], [unrelated], [workingEvent()]],
      })

      // #when the run succeeds
      await clear(c.client)

      // #then pages are fetched newest-first, once each, and page 1 is never refetched
      expect(fetchedPages(c.listEvents)).toEqual([1, 4, 3, 2])
      // #and the newest blocked event (page 2, not the older page-1 one) is compared, so the label is cleared
      expect(c.removeLabel).toHaveBeenCalledTimes(1)
    })

    it('keeps the label when the blocked event is beyond the bounded look-back', async () => {
      // #given five pages where the blocked event is only on page 1 (beyond the last three pages scanned)
      const c = createClient({eventPages: [[blockedEvent()], [unrelated], [unrelated], [unrelated], [workingEvent()]]})

      // #when the run succeeds
      await clear(c.client)

      // #then fetches stay bounded (page 1, then the last three pages) and the label is kept
      expect(fetchedPages(c.listEvents)).toEqual([1, 5, 4, 3])
      expect(c.removeLabel).not.toHaveBeenCalled()
    })

    it('prefers the newer page when a label appears on several scanned pages', async () => {
      // #given the last page holds a newer blocked re-stamp but no working event, so the look-back continues to
      // an earlier page that holds the working event AND an older blocked event
      const c = createClient({
        eventPages: [[unrelated], [workingEvent(), blockedEvent()], [blockedEvent('2026-10-09T21:50:00Z')]],
      })

      // #when the run succeeds
      await clear(c.client)

      // #then the newer (last-page) blocked event wins over the older one seen later in the scan, so it is kept
      expect(fetchedPages(c.listEvents)).toEqual([1, 3, 2])
      expect(c.removeLabel).not.toHaveBeenCalled()
    })
  })

  describe('no-ops', () => {
    it('does nothing under response-mode none', async () => {
      // #given response-mode none, which promises no label changes
      const c = createClient()

      // #when the run succeeds
      await clear(c.client, {responseMode: 'none'})

      // #then no API is touched
      expect(c.listLabelsOnIssue).not.toHaveBeenCalled()
      expect(c.removeLabel).not.toHaveBeenCalled()
    })

    it.each([['manual' as const], ['discussion' as const]])('does nothing for a %s target', async kind => {
      // #given a target that is not an issue or PR
      const c = createClient()

      // #when the run succeeds
      await clear(c.client, {context: createContext(target(kind))})

      // #then no API is touched
      expect(c.listLabelsOnIssue).not.toHaveBeenCalled()
      expect(c.removeLabel).not.toHaveBeenCalled()
    })

    it('does nothing when there is no target', async () => {
      // #given a repository-level trigger
      const c = createClient()

      // #when the run succeeds
      await clear(c.client, {context: createContext(null)})

      // #then no API is touched
      expect(c.listLabelsOnIssue).not.toHaveBeenCalled()
    })

    it.each([['skipped' as const], ['failed' as const], ['incomplete' as const]])(
      'does nothing for a %s run (declined/errored lock, or no success)',
      async outcome => {
        // #given a run that did not succeed -- including this run's own declined or errored lock
        const c = createClient()

        // #when the run ends
        await clear(c.client, {outcome})

        // #then no API is touched
        expect(c.listLabelsOnIssue).not.toHaveBeenCalled()
        expect(c.removeLabel).not.toHaveBeenCalled()
      },
    )
  })
})
