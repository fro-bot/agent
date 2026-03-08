import type {GitHubContext} from '../../services/github/types.js'
import type {Logger} from '../../shared/logger.js'
import {beforeEach, describe, expect, it} from 'vitest'
import {classifyEventType, normalizeEvent} from '../../services/github/context.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {routeEvent} from './router.js'

function createMockGitHubContext(eventName: string, payload: unknown = {}): GitHubContext {
  const eventType = classifyEventType(eventName)
  return {
    eventName,
    eventType,
    repo: {owner: 'owner', repo: 'repo'},
    ref: 'refs/heads/main',
    sha: 'abc123',
    runId: 12345,
    actor: 'actor',
    payload,
    event: normalizeEvent(eventType, payload),
  }
}

describe('pull_request ready_for_review routing', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
  })

  it('routes pull_request.ready_for_review event', () => {
    // #given a pull_request.ready_for_review event from an authorized author
    const payload = {
      action: 'ready_for_review',
      pull_request: {
        number: 99,
        title: 'feat: finish implementation',
        body: 'This PR is now ready for review',
        locked: false,
        draft: false,
        author_association: 'MEMBER',
        requested_reviewers: [{login: 'fro-bot[bot]', type: 'Bot'}],
        requested_teams: [],
      },
      sender: {login: 'contributor'},
    }
    const ghContext = createMockGitHubContext('pull_request', payload)

    // #when routing the event
    const result = routeEvent(ghContext, logger, {botLogin: 'fro-bot'})

    // #then it should process
    expect(result.shouldProcess).toBe(true)
    expect(result.context.eventType).toBe('pull_request')
    expect(result.context.action).toBe('ready_for_review')
  })

  it('skips pull_request.ready_for_review event when bot is not requested reviewer', () => {
    // #given a pull_request.ready_for_review event where bot is not in requested reviewers
    const payload = {
      action: 'ready_for_review',
      pull_request: {
        number: 100,
        title: 'feat: ready but reviewer is someone else',
        body: 'Ready for review',
        locked: false,
        draft: false,
        author_association: 'MEMBER',
        requested_reviewers: [{login: 'someone-else', type: 'User'}],
        requested_teams: [],
      },
      sender: {login: 'contributor'},
    }
    const ghContext = createMockGitHubContext('pull_request', payload)

    // #when routing the event
    const result = routeEvent(ghContext, logger, {botLogin: 'fro-bot'})

    // #then it should skip
    expect(result.shouldProcess).toBe(false)
    expect(result.shouldProcess === false && result.skipReason).toBe('bot_not_requested')
  })

  it('routes pull_request.review_requested event when bot is requested', () => {
    // #given a pull_request.review_requested event where bot is requested reviewer
    const payload = {
      action: 'review_requested',
      requested_reviewer: {login: 'fro-bot[bot]', type: 'Bot'},
      pull_request: {
        number: 101,
        title: 'feat: request bot review',
        body: 'Please review',
        locked: false,
        draft: false,
        author_association: 'MEMBER',
        requested_reviewers: [{login: 'fro-bot[bot]', type: 'Bot'}],
        requested_teams: [],
      },
      sender: {login: 'contributor'},
    }
    const ghContext = createMockGitHubContext('pull_request', payload)

    // #when routing the event
    const result = routeEvent(ghContext, logger, {botLogin: 'fro-bot'})

    // #then it should process
    expect(result.shouldProcess).toBe(true)
    expect(result.context.action).toBe('review_requested')
    expect(result.context.isBotReviewRequested).toBe(true)
    expect(result.context.target?.requestedReviewerLogin).toBe('fro-bot[bot]')
  })

  it('skips pull_request.review_requested event when different reviewer is requested', () => {
    // #given a pull_request.review_requested event for another reviewer
    const payload = {
      action: 'review_requested',
      requested_reviewer: {login: 'other-user', type: 'User'},
      pull_request: {
        number: 102,
        title: 'feat: request another review',
        body: 'Please review',
        locked: false,
        draft: false,
        author_association: 'MEMBER',
        requested_reviewers: [{login: 'other-user', type: 'User'}],
        requested_teams: [],
      },
      sender: {login: 'contributor'},
    }
    const ghContext = createMockGitHubContext('pull_request', payload)

    // #when routing the event
    const result = routeEvent(ghContext, logger, {botLogin: 'fro-bot'})

    // #then it should skip
    expect(result.shouldProcess).toBe(false)
    expect(result.shouldProcess === false && result.skipReason).toBe('bot_not_requested')
  })

  it('routes pull_request.review_requested event when botLogin is null', () => {
    // #given a pull_request.review_requested event and bot login not configured
    const payload = {
      action: 'review_requested',
      requested_reviewer: {login: 'other-user', type: 'User'},
      pull_request: {
        number: 103,
        title: 'feat: generic review request',
        body: 'Please review',
        locked: false,
        draft: false,
        author_association: 'MEMBER',
        requested_reviewers: [{login: 'other-user', type: 'User'}],
        requested_teams: [],
      },
      sender: {login: 'contributor'},
    }
    const ghContext = createMockGitHubContext('pull_request', payload)

    // #when routing the event
    const result = routeEvent(ghContext, logger, {botLogin: null})

    // #then it should process (assignment gating disabled)
    expect(result.shouldProcess).toBe(true)
  })
})
