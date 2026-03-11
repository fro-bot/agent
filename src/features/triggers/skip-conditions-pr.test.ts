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

  it('routes pull_request.review_requested when authorized sender triggers review for bot-authored PR', () => {
    // #given a review request from a maintainer (resolved via API) for a bot-authored PR
    const payload = {
      action: 'review_requested',
      requested_reviewer: {login: 'fro-bot[bot]', type: 'Bot'},
      pull_request: {
        number: 106,
        title: 'chore: renovate dependency updates',
        body: 'Automated dependency update',
        locked: false,
        draft: false,
        author_association: 'NONE',
        requested_reviewers: [{login: 'fro-bot[bot]', type: 'Bot'}],
        requested_teams: [],
      },
      sender: {login: 'repo-maintainer'},
    }
    const ghContext = createMockGitHubContext('pull_request', payload)

    // #when routing with resolved sender association (Rule 2)
    const result = routeEvent(ghContext, logger, {botLogin: 'fro-bot', senderAssociation: 'MEMBER'})

    // #then it should process — sender's MEMBER association overrides PR author's NONE
    expect(result.shouldProcess).toBe(true)
    expect(result.context.action).toBe('review_requested')
    expect(result.context.isBotReviewRequested).toBe(true)
  })

  it('processes review_requested from bot sender when PR author is authorized', () => {
    // #given a review request triggered by a bot (auto-assign action)
    // on a PR authored by an authorized user (MEMBER)
    const payload = {
      action: 'review_requested',
      requested_reviewer: {login: 'fro-bot[bot]', type: 'Bot'},
      pull_request: {
        number: 107,
        title: 'feat: request from bot account',
        body: 'Please review',
        locked: false,
        draft: false,
        author_association: 'MEMBER',
        requested_reviewers: [{login: 'fro-bot[bot]', type: 'Bot'}],
        requested_teams: [],
      },
      sender: {login: 'bfra-me[bot]'},
    }
    const ghContext = createMockGitHubContext('pull_request', payload)

    // #when routing the event
    const result = routeEvent(ghContext, logger, {botLogin: 'fro-bot'})

    // #then it should process — bot sender check is skipped for review_requested
    // and the PR author's MEMBER association is authorized
    expect(result.shouldProcess).toBe(true)
    expect(result.context.action).toBe('review_requested')
  })

  it('blocks review_requested from bot sender when PR author is unauthorized and no senderAssociation', () => {
    // #given a review request triggered by a bot on a PR with unauthorized author
    // and no sender association resolved (API failure or bot sender)
    const payload = {
      action: 'review_requested',
      requested_reviewer: {login: 'fro-bot[bot]', type: 'Bot'},
      pull_request: {
        number: 108,
        title: 'chore: automated update',
        body: 'Bot-created PR',
        locked: false,
        draft: false,
        author_association: 'NONE',
        requested_reviewers: [{login: 'fro-bot[bot]', type: 'Bot'}],
        requested_teams: [],
      },
      sender: {login: 'some-bot[bot]'},
    }
    const ghContext = createMockGitHubContext('pull_request', payload)

    // #when routing the event
    const result = routeEvent(ghContext, logger, {botLogin: 'fro-bot'})

    // #then it should block — no permissive fallback, unauthorized author blocks
    expect(result.shouldProcess).toBe(false)
    expect(result.shouldProcess === false && result.skipReason).toBe('unauthorized_author')
  })

  it('still blocks bot sender for non-review actions (opened)', () => {
    // #given a PR opened by a bot
    const payload = {
      action: 'opened',
      pull_request: {
        number: 109,
        title: 'chore: automated PR',
        body: 'Bot-created',
        locked: false,
        draft: false,
        author_association: 'MEMBER',
        requested_reviewers: [],
        requested_teams: [],
      },
      sender: {login: 'dependabot[bot]'},
    }
    const ghContext = createMockGitHubContext('pull_request', payload)

    // #when routing the event
    const result = routeEvent(ghContext, logger, {botLogin: 'fro-bot'})

    // #then it should skip — bot sender check still applies for opened
    expect(result.shouldProcess).toBe(false)
    expect(result.shouldProcess === false && result.skipReason).toBe('self_comment')
  })

  it('blocks review_requested when PR author is unauthorized and no senderAssociation override', () => {
    // #given a review_requested event where the PR author has NONE association
    // and no senderAssociation was resolved (API failure)
    const payload = {
      action: 'review_requested',
      requested_reviewer: {login: 'fro-bot[bot]', type: 'Bot'},
      pull_request: {
        number: 108,
        title: 'chore: dependency update',
        body: 'Automated update',
        locked: false,
        draft: false,
        author_association: 'NONE',
        requested_reviewers: [{login: 'fro-bot[bot]', type: 'Bot'}],
        requested_teams: [],
      },
      sender: {login: 'trusted-maintainer'},
    }
    const ghContext = createMockGitHubContext('pull_request', payload)

    // #when routing without senderAssociation (API lookup failed)
    const result = routeEvent(ghContext, logger, {
      botLogin: 'fro-bot',
      allowedAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'],
    })

    // #then it should block — association gating applies to all actions
    expect(result.shouldProcess).toBe(false)
    expect(result.shouldProcess === false && result.skipReason).toBe('unauthorized_author')
  })

  it('processes ready_for_review from bot sender when PR author is authorized', () => {
    // #given a ready_for_review event triggered by a bot (auto-assign action)
    // on a PR authored by an authorized user (MEMBER)
    const payload = {
      action: 'ready_for_review',
      pull_request: {
        number: 110,
        title: 'feat: bot marks PR ready',
        body: 'Ready for review',
        locked: false,
        draft: false,
        author_association: 'MEMBER',
        requested_reviewers: [{login: 'fro-bot[bot]', type: 'Bot'}],
        requested_teams: [],
      },
      sender: {login: 'bfra-me[bot]'},
    }
    const ghContext = createMockGitHubContext('pull_request', payload)

    // #when routing the event
    const result = routeEvent(ghContext, logger, {botLogin: 'fro-bot'})

    // #then it should process — bot sender check skipped for ready_for_review
    // and the PR author's MEMBER association is authorized (Rule 1)
    expect(result.shouldProcess).toBe(true)
    expect(result.context.action).toBe('ready_for_review')
  })

  it('blocks ready_for_review on bot-authored PR when senderAssociation is not resolved', () => {
    // #given a ready_for_review event on a Copilot-authored PR (CONTRIBUTOR)
    // without sender association resolution (API failure scenario)
    const payload = {
      action: 'ready_for_review',
      pull_request: {
        number: 22,
        title: 'fix: SPA routing on GitHub Pages',
        body: 'Automated fix',
        locked: false,
        draft: false,
        author_association: 'CONTRIBUTOR',
        requested_reviewers: [{login: 'fro-bot', type: 'User'}],
        requested_teams: [],
      },
      sender: {login: 'marcusrbrown'},
    }
    const ghContext = createMockGitHubContext('pull_request', payload)

    // #when routing without sender association (API failed)
    const result = routeEvent(ghContext, logger, {botLogin: 'fro-bot'})

    // #then it should block — association gating applies to all actions,
    // no permissive fallback for any action
    expect(result.shouldProcess).toBe(false)
    expect(result.shouldProcess === false && result.skipReason).toBe('unauthorized_author')
  })

  it('processes ready_for_review on bot-authored PR with senderAssociation override', () => {
    // #given a ready_for_review event where the sender's association was resolved via API
    const payload = {
      action: 'ready_for_review',
      pull_request: {
        number: 22,
        title: 'fix: SPA routing on GitHub Pages',
        body: 'Automated fix',
        locked: false,
        draft: false,
        author_association: 'CONTRIBUTOR',
        requested_reviewers: [{login: 'fro-bot', type: 'User'}],
        requested_teams: [],
      },
      sender: {login: 'marcusrbrown'},
    }
    const ghContext = createMockGitHubContext('pull_request', payload)

    // #when routing with resolved sender association
    const result = routeEvent(ghContext, logger, {
      botLogin: 'fro-bot',
      senderAssociation: 'OWNER',
    })

    // #then it should process and the author association should be overridden
    expect(result.shouldProcess).toBe(true)
    expect(result.context.author?.association).toBe('OWNER')
  })
})
