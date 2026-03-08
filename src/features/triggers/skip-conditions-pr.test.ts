import type {Logger} from '../../shared/logger.js'
import {beforeEach, describe, expect, it} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {routeEvent} from './router.js'
import {createMockGitHubContext} from './test-helpers.js'

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

  it('skips pull_request.review_requested event when a team is requested (not an individual)', () => {
    // #given a pull_request.review_requested event where a team (not individual) is the reviewer
    const payload = {
      action: 'review_requested',
      requested_team: {name: 'Platform Team', slug: 'platform-team'},
      pull_request: {
        number: 105,
        title: 'feat: team review',
        body: 'Please review',
        locked: false,
        draft: false,
        author_association: 'MEMBER',
        requested_reviewers: [],
        requested_teams: [{name: 'Platform Team', slug: 'platform-team'}],
      },
      sender: {login: 'contributor'},
    }
    const ghContext = createMockGitHubContext('pull_request', payload)

    // #when routing the event
    const result = routeEvent(ghContext, logger, {botLogin: 'fro-bot'})

    // #then it should skip because a team was requested, not the bot individually
    expect(result.shouldProcess).toBe(false)
    expect(result.shouldProcess === false && result.skipReason).toBe('bot_not_requested')
  })
})
