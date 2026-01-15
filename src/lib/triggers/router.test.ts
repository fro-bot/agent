import type {GitHubContext, IssueCommentPayload} from '../github/types.js'
import type {TriggerConfig} from './types.js'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {checkSkipConditions, classifyTrigger, extractCommand, hasBotMention, routeEvent} from './router.js'
import {ALLOWED_ASSOCIATIONS} from './types.js'

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

function createMockIssueCommentPayload(
  overrides: Partial<{
    action: string
    commentBody: string
    authorLogin: string
    authorAssociation: string
    issueNumber: number
    isLocked: boolean
    isPR: boolean
  }> = {},
): IssueCommentPayload {
  return {
    action: overrides.action ?? 'created',
    issue: {
      number: overrides.issueNumber ?? 123,
      title: 'Test Issue',
      body: 'Issue body',
      state: 'open',
      user: {login: 'issue-author'},
      locked: overrides.isLocked ?? false,
      ...(overrides.isPR === true ? {pull_request: {url: 'https://api.github.com/repos/owner/repo/pulls/123'}} : {}),
    },
    comment: {
      id: 456,
      body: overrides.commentBody ?? 'Test comment',
      user: {login: overrides.authorLogin ?? 'commenter'},
      author_association: overrides.authorAssociation ?? 'MEMBER',
    },
    repository: {
      owner: {login: 'owner'},
      name: 'repo',
      full_name: 'owner/repo',
    },
    sender: {login: overrides.authorLogin ?? 'commenter'},
  }
}

function createMockGitHubContext(eventName: string, payload: unknown = {}): GitHubContext {
  return {
    eventName,
    eventType: 'issue_comment',
    repo: {owner: 'owner', repo: 'repo'},
    ref: 'refs/heads/main',
    sha: 'abc123',
    runId: 12345,
    actor: 'actor',
    payload,
  }
}

describe('classifyTrigger', () => {
  it('classifies issue_comment as issue_comment', () => {
    // #given an issue_comment event
    // #when classifying the trigger
    const result = classifyTrigger('issue_comment')

    // #then it should return issue_comment
    expect(result).toBe('issue_comment')
  })

  it('classifies discussion as discussion_comment', () => {
    // #given a discussion event
    // #when classifying the trigger
    const result = classifyTrigger('discussion')

    // #then it should return discussion_comment
    expect(result).toBe('discussion_comment')
  })

  it('classifies discussion_comment as discussion_comment', () => {
    // #given a discussion_comment event
    // #when classifying the trigger
    const result = classifyTrigger('discussion_comment')

    // #then it should return discussion_comment
    expect(result).toBe('discussion_comment')
  })

  it('classifies workflow_dispatch as workflow_dispatch', () => {
    // #given a workflow_dispatch event
    // #when classifying the trigger
    const result = classifyTrigger('workflow_dispatch')

    // #then it should return workflow_dispatch
    expect(result).toBe('workflow_dispatch')
  })

  it('classifies unknown events as unsupported', () => {
    // #given an unknown event
    // #when classifying the trigger
    const result = classifyTrigger('push')

    // #then it should return unsupported
    expect(result).toBe('unsupported')
  })

  it('classifies pull_request as pull_request', () => {
    // #given a pull_request event
    // #when classifying the trigger
    const result = classifyTrigger('pull_request')

    // #then it should return pull_request
    expect(result).toBe('pull_request')
  })

  it('classifies issues as issues', () => {
    // #given an issues event
    // #when classifying the trigger
    const result = classifyTrigger('issues')

    // #then it should return issues
    expect(result).toBe('issues')
  })

  it('classifies pull_request_review_comment as pull_request_review_comment', () => {
    // #given a pull_request_review_comment event
    // #when classifying the trigger
    const result = classifyTrigger('pull_request_review_comment')

    // #then it should return pull_request_review_comment
    expect(result).toBe('pull_request_review_comment')
  })

  it('classifies schedule as schedule', () => {
    // #given a schedule event
    // #when classifying the trigger
    const result = classifyTrigger('schedule')

    // #then it should return schedule
    expect(result).toBe('schedule')
  })
})

describe('hasBotMention', () => {
  it('detects @botname mention', () => {
    // #given a comment with @fro-bot mention
    const text = 'Hey @fro-bot can you help?'

    // #when checking for mention
    const result = hasBotMention(text, 'fro-bot')

    // #then it should detect the mention
    expect(result).toBe(true)
  })

  it('detects @botname[bot] mention', () => {
    // #given a comment with @fro-bot[bot] mention
    const text = 'Hey @fro-bot[bot] can you help?'

    // #when checking for mention
    const result = hasBotMention(text, 'fro-bot')

    // #then it should detect the mention
    expect(result).toBe(true)
  })

  it('does NOT match partial bot names like @fro-botty', () => {
    // #given a comment with @fro-botty (different bot)
    const text = 'Hey @fro-botty can you help?'

    // #when checking for @fro-bot mention
    const result = hasBotMention(text, 'fro-bot')

    // #then it should NOT detect a mention
    expect(result).toBe(false)
  })

  it('is case-insensitive', () => {
    // #given a comment with uppercase mention
    const text = 'Hey @FRO-BOT can you help?'

    // #when checking for mention
    const result = hasBotMention(text, 'fro-bot')

    // #then it should detect the mention
    expect(result).toBe(true)
  })

  it('detects mention at end of line', () => {
    // #given a comment ending with @fro-bot
    const text = 'Please review @fro-bot'

    // #when checking for mention
    const result = hasBotMention(text, 'fro-bot')

    // #then it should detect the mention
    expect(result).toBe(true)
  })

  it('returns false for empty botLogin', () => {
    // #given an empty bot login
    const text = '@fro-bot help'

    // #when checking with empty botLogin
    const result = hasBotMention(text, '')

    // #then it should return false
    expect(result).toBe(false)
  })

  it('handles special regex characters in bot name', () => {
    // #given a bot name with special characters
    const text = '@bot.name[bot] help'

    // #when checking for mention
    const result = hasBotMention(text, 'bot.name')

    // #then it should detect the mention
    expect(result).toBe(true)
  })
})

describe('extractCommand', () => {
  it('extracts command after @botname', () => {
    // #given a comment with a command
    const text = '@fro-bot review this PR'

    // #when extracting the command
    const result = extractCommand(text, 'fro-bot')

    // #then it should extract the command
    expect(result).toEqual({
      raw: 'review this PR',
      action: 'review',
      args: 'this PR',
    })
  })

  it('extracts command after @botname[bot]', () => {
    // #given a comment with [bot] suffix
    const text = '@fro-bot[bot] help me'

    // #when extracting the command
    const result = extractCommand(text, 'fro-bot')

    // #then it should extract the command
    expect(result).toEqual({
      raw: 'help me',
      action: 'help',
      args: 'me',
    })
  })

  it('returns null when no mention', () => {
    // #given a comment without mention
    const text = 'No mention here'

    // #when extracting the command
    const result = extractCommand(text, 'fro-bot')

    // #then it should return null
    expect(result).toBeNull()
  })

  it('returns null action when mention has no following text', () => {
    // #given a comment with just the mention
    const text = 'Hey @fro-bot'

    // #when extracting the command
    const result = extractCommand(text, 'fro-bot')

    // #then it should return empty command
    expect(result).toEqual({
      raw: '',
      action: null,
      args: '',
    })
  })

  it('handles multiline commands', () => {
    // #given a multiline comment
    const text = '@fro-bot review\nThis is a detailed\nrequest'

    // #when extracting the command
    const result = extractCommand(text, 'fro-bot')

    // #then it should capture the full text
    expect(result?.raw).toContain('review')
    expect(result?.action).toBe('review')
  })

  it('returns null for empty botLogin', () => {
    // #given an empty bot login
    const text = '@fro-bot help'

    // #when extracting with empty botLogin
    const result = extractCommand(text, '')

    // #then it should return null
    expect(result).toBeNull()
  })
})

describe('checkSkipConditions', () => {
  let logger: ReturnType<typeof createMockLogger>
  let config: TriggerConfig

  beforeEach(() => {
    logger = createMockLogger()
    config = {
      botLogin: 'fro-bot',
      requireMention: true,
      allowedAssociations: ALLOWED_ASSOCIATIONS,
      skipDraftPRs: true,
      promptInput: null,
    }
  })

  it('skips unsupported events', () => {
    // #given an unsupported event context
    const payload = createMockIssueCommentPayload()
    const ghContext = createMockGitHubContext('push', payload)
    const context = {
      triggerType: 'unsupported' as const,
      eventName: 'push',
      repo: ghContext.repo,
      ref: ghContext.ref,
      sha: ghContext.sha,
      runId: ghContext.runId,
      actor: ghContext.actor,
      author: null,
      target: null,
      commentBody: null,
      commentId: null,
      hasMention: false,
      command: null,
      raw: ghContext,
    }

    // #when checking skip conditions
    const result = checkSkipConditions(context, config, logger)

    // #then it should skip with unsupported_event reason
    expect(result.shouldSkip).toBe(true)
    expect(result.shouldSkip && result.reason).toBe('unsupported_event')
  })

  it('skips non-created comment actions', () => {
    // #given an edited comment
    const payload = createMockIssueCommentPayload({action: 'edited'})
    const ghContext = createMockGitHubContext('issue_comment', payload)
    const context = {
      triggerType: 'issue_comment' as const,
      eventName: 'issue_comment',
      repo: ghContext.repo,
      ref: ghContext.ref,
      sha: ghContext.sha,
      runId: ghContext.runId,
      actor: ghContext.actor,
      author: {login: 'commenter', association: 'MEMBER', isBot: false},
      target: {kind: 'issue' as const, number: 123, title: 'Test', body: null, locked: false},
      commentBody: 'test',
      commentId: 456,
      hasMention: true,
      command: null,
      raw: ghContext,
    }

    // #when checking skip conditions
    const result = checkSkipConditions(context, config, logger)

    // #then it should skip with action_not_created reason
    expect(result.shouldSkip).toBe(true)
    expect(result.shouldSkip && result.reason).toBe('action_not_created')
  })

  it('skips locked issues', () => {
    // #given a locked issue
    const payload = createMockIssueCommentPayload({isLocked: true})
    const ghContext = createMockGitHubContext('issue_comment', payload)
    const context = {
      triggerType: 'issue_comment' as const,
      eventName: 'issue_comment',
      repo: ghContext.repo,
      ref: ghContext.ref,
      sha: ghContext.sha,
      runId: ghContext.runId,
      actor: ghContext.actor,
      author: {login: 'commenter', association: 'MEMBER', isBot: false},
      target: {kind: 'issue' as const, number: 123, title: 'Test', body: null, locked: true},
      commentBody: '@fro-bot help',
      commentId: 456,
      hasMention: true,
      command: null,
      raw: ghContext,
    }

    // #when checking skip conditions
    const result = checkSkipConditions(context, config, logger)

    // #then it should skip with issue_locked reason
    expect(result.shouldSkip).toBe(true)
    expect(result.shouldSkip && result.reason).toBe('issue_locked')
  })

  it('skips self-comments (anti-loop)', () => {
    // #given a comment from the bot itself
    const payload = createMockIssueCommentPayload({authorLogin: 'fro-bot'})
    const ghContext = createMockGitHubContext('issue_comment', payload)
    const context = {
      triggerType: 'issue_comment' as const,
      eventName: 'issue_comment',
      repo: ghContext.repo,
      ref: ghContext.ref,
      sha: ghContext.sha,
      runId: ghContext.runId,
      actor: ghContext.actor,
      author: {login: 'fro-bot', association: 'MEMBER', isBot: true},
      target: {kind: 'issue' as const, number: 123, title: 'Test', body: null, locked: false},
      commentBody: '@fro-bot help',
      commentId: 456,
      hasMention: true,
      command: null,
      raw: ghContext,
    }

    // #when checking skip conditions
    const result = checkSkipConditions(context, config, logger)

    // #then it should skip with self_comment reason
    expect(result.shouldSkip).toBe(true)
    expect(result.shouldSkip && result.reason).toBe('self_comment')
  })

  it('skips self-comments with [bot] suffix', () => {
    // #given a comment from the bot with [bot] suffix
    const payload = createMockIssueCommentPayload({authorLogin: 'fro-bot[bot]'})
    const ghContext = createMockGitHubContext('issue_comment', payload)
    const context = {
      triggerType: 'issue_comment' as const,
      eventName: 'issue_comment',
      repo: ghContext.repo,
      ref: ghContext.ref,
      sha: ghContext.sha,
      runId: ghContext.runId,
      actor: ghContext.actor,
      author: {login: 'fro-bot[bot]', association: 'NONE', isBot: true},
      target: {kind: 'issue' as const, number: 123, title: 'Test', body: null, locked: false},
      commentBody: 'test',
      commentId: 456,
      hasMention: false,
      command: null,
      raw: ghContext,
    }

    // #when checking skip conditions
    const result = checkSkipConditions(context, config, logger)

    // #then it should skip with self_comment reason
    expect(result.shouldSkip).toBe(true)
    expect(result.shouldSkip && result.reason).toBe('self_comment')
  })

  it('skips unauthorized author associations', () => {
    // #given a comment from an unauthorized user
    const payload = createMockIssueCommentPayload({authorAssociation: 'NONE'})
    const ghContext = createMockGitHubContext('issue_comment', payload)
    const context = {
      triggerType: 'issue_comment' as const,
      eventName: 'issue_comment',
      repo: ghContext.repo,
      ref: ghContext.ref,
      sha: ghContext.sha,
      runId: ghContext.runId,
      actor: ghContext.actor,
      author: {login: 'random-user', association: 'NONE', isBot: false},
      target: {kind: 'issue' as const, number: 123, title: 'Test', body: null, locked: false},
      commentBody: '@fro-bot help',
      commentId: 456,
      hasMention: true,
      command: null,
      raw: ghContext,
    }

    // #when checking skip conditions
    const result = checkSkipConditions(context, config, logger)

    // #then it should skip with unauthorized_author reason
    expect(result.shouldSkip).toBe(true)
    expect(result.shouldSkip && result.reason).toBe('unauthorized_author')
  })

  it('skips comments without mention when requireMention is true', () => {
    // #given a comment without mention
    const payload = createMockIssueCommentPayload({commentBody: 'Just a regular comment'})
    const ghContext = createMockGitHubContext('issue_comment', payload)
    const context = {
      triggerType: 'issue_comment' as const,
      eventName: 'issue_comment',
      repo: ghContext.repo,
      ref: ghContext.ref,
      sha: ghContext.sha,
      runId: ghContext.runId,
      actor: ghContext.actor,
      author: {login: 'commenter', association: 'MEMBER', isBot: false},
      target: {kind: 'issue' as const, number: 123, title: 'Test', body: null, locked: false},
      commentBody: 'Just a regular comment',
      commentId: 456,
      hasMention: false,
      command: null,
      raw: ghContext,
    }

    // #when checking skip conditions
    const result = checkSkipConditions(context, config, logger)

    // #then it should skip with no_mention reason
    expect(result.shouldSkip).toBe(true)
    expect(result.shouldSkip && result.reason).toBe('no_mention')
  })

  it('allows comments without mention when requireMention is false', () => {
    // #given requireMention is false
    const configNoMention = {...config, requireMention: false}
    const payload = createMockIssueCommentPayload({commentBody: 'Just a regular comment'})
    const ghContext = createMockGitHubContext('issue_comment', payload)
    const context = {
      triggerType: 'issue_comment' as const,
      eventName: 'issue_comment',
      repo: ghContext.repo,
      ref: ghContext.ref,
      sha: ghContext.sha,
      runId: ghContext.runId,
      actor: ghContext.actor,
      author: {login: 'commenter', association: 'MEMBER', isBot: false},
      target: {kind: 'issue' as const, number: 123, title: 'Test', body: null, locked: false},
      commentBody: 'Just a regular comment',
      commentId: 456,
      hasMention: false,
      command: null,
      raw: ghContext,
    }

    // #when checking skip conditions
    const result = checkSkipConditions(context, configNoMention, logger)

    // #then it should not skip
    expect(result.shouldSkip).toBe(false)
  })

  it('allows valid comments', () => {
    // #given a valid comment with mention from authorized user
    const payload = createMockIssueCommentPayload({
      commentBody: '@fro-bot help',
      authorAssociation: 'OWNER',
    })
    const ghContext = createMockGitHubContext('issue_comment', payload)
    const context = {
      triggerType: 'issue_comment' as const,
      eventName: 'issue_comment',
      repo: ghContext.repo,
      ref: ghContext.ref,
      sha: ghContext.sha,
      runId: ghContext.runId,
      actor: ghContext.actor,
      author: {login: 'owner', association: 'OWNER', isBot: false},
      target: {kind: 'issue' as const, number: 123, title: 'Test', body: null, locked: false},
      commentBody: '@fro-bot help',
      commentId: 456,
      hasMention: true,
      command: {raw: 'help', action: 'help', args: ''},
      raw: ghContext,
    }

    // #when checking skip conditions
    const result = checkSkipConditions(context, config, logger)

    // #then it should not skip
    expect(result.shouldSkip).toBe(false)
  })
})

describe('routeEvent', () => {
  let logger: ReturnType<typeof createMockLogger>

  beforeEach(() => {
    logger = createMockLogger()
  })

  it('routes valid issue_comment event', () => {
    // #given a valid issue_comment event
    const payload = createMockIssueCommentPayload({
      commentBody: '@fro-bot review',
      authorAssociation: 'MEMBER',
    })
    const ghContext = createMockGitHubContext('issue_comment', payload)
    const config = {botLogin: 'fro-bot'}

    // #when routing the event
    const result = routeEvent(ghContext, logger, config)

    // #then it should process
    expect(result.shouldProcess).toBe(true)
    expect(result.context.triggerType).toBe('issue_comment')
    expect(result.context.hasMention).toBe(true)
    expect(result.context.command?.action).toBe('review')
  })

  it('skips unsupported events', () => {
    // #given a push event
    const ghContext = createMockGitHubContext('push', {})

    // #when routing the event
    const result = routeEvent(ghContext, logger)

    // #then it should not process
    expect(result.shouldProcess).toBe(false)
    expect(result.shouldProcess === false && result.skipReason).toBe('unsupported_event')
    expect(result.context.triggerType).toBe('unsupported')
  })

  it('builds complete TriggerContext for issue_comment', () => {
    // #given an issue_comment on a PR
    const payload = createMockIssueCommentPayload({
      isPR: true,
      commentBody: '@fro-bot help me please',
      authorLogin: 'contributor',
      authorAssociation: 'COLLABORATOR',
    })
    const ghContext = createMockGitHubContext('issue_comment', payload)
    const config = {botLogin: 'fro-bot'}

    // #when routing the event
    const result = routeEvent(ghContext, logger, config)

    // #then context should be complete
    expect(result.context.triggerType).toBe('issue_comment')
    expect(result.context.target?.kind).toBe('pr')
    expect(result.context.author?.login).toBe('contributor')
    expect(result.context.author?.association).toBe('COLLABORATOR')
    expect(result.context.target?.body).toBe('@fro-bot help me please')
    expect(result.context.hasMention).toBe(true)
    expect(result.context.command?.action).toBe('help')
    expect(result.context.command?.args).toBe('me please')
  })

  it('applies default config when none provided', () => {
    // #given an event with no config
    const payload = createMockIssueCommentPayload({
      commentBody: 'No mention here',
      authorAssociation: 'MEMBER',
    })
    const ghContext = createMockGitHubContext('issue_comment', payload)

    // #when routing with default config
    const result = routeEvent(ghContext, logger)

    // #then it should use default requireMention=true
    expect(result.shouldProcess).toBe(false)
    expect(result.shouldProcess === false && result.skipReason).toBe('no_mention')
  })

  it('merges partial config with defaults', () => {
    // #given partial config
    const payload = createMockIssueCommentPayload({commentBody: 'No mention'})
    const ghContext = createMockGitHubContext('issue_comment', payload)
    const config = {requireMention: false}

    // #when routing with partial config
    const result = routeEvent(ghContext, logger, config)

    // #then it should merge with defaults and process
    expect(result.context.hasMention).toBe(false)
  })

  it('routes discussion_comment event', () => {
    // #given a discussion_comment event
    const payload = {
      action: 'created',
      discussion: {
        number: 42,
        title: 'Test Discussion',
        body: 'Discussion body',
        locked: false,
      },
      comment: {
        id: 789,
        body: '@fro-bot help with this',
        user: {login: 'contributor'},
        author_association: 'MEMBER',
      },
    }
    const ghContext = createMockGitHubContext('discussion_comment', payload)
    const config = {botLogin: 'fro-bot'}

    // #when routing the event
    const result = routeEvent(ghContext, logger, config)

    // #then it should process with correct context
    expect(result.shouldProcess).toBe(true)
    expect(result.context.triggerType).toBe('discussion_comment')
    expect(result.context.target?.kind).toBe('discussion')
    expect(result.context.target?.number).toBe(42)
    expect(result.context.hasMention).toBe(true)
    expect(result.context.command?.action).toBe('help')
  })

  it('routes workflow_dispatch event', () => {
    // #given a workflow_dispatch event
    const payload = {
      inputs: {
        prompt: 'Please review the codebase',
      },
    }
    const ghContext = createMockGitHubContext('workflow_dispatch', payload)

    // #when routing the event
    const result = routeEvent(ghContext, logger)

    // #then it should process with correct context
    expect(result.shouldProcess).toBe(true)
    expect(result.context.triggerType).toBe('workflow_dispatch')
    expect(result.context.target?.kind).toBe('manual')
    expect(result.context.target?.body).toBe('Please review the codebase')
    expect(result.context.author?.login).toBe('actor')
    expect(result.context.author?.association).toBe('OWNER')
    expect(result.context.commentBody).toBe('Please review the codebase')
  })

  it('skips workflow_dispatch event without prompt input', () => {
    // #given a workflow_dispatch event without prompt
    const payload = {
      inputs: {},
    }
    const ghContext = createMockGitHubContext('workflow_dispatch', payload)

    // #when routing the event
    const result = routeEvent(ghContext, logger)

    // #then it should skip with prompt_required reason
    expect(result.shouldProcess).toBe(false)
    expect(result.shouldProcess === false && result.skipReason).toBe('prompt_required')
  })

  it('skips workflow_dispatch event with empty prompt input', () => {
    // #given a workflow_dispatch event with empty prompt
    const payload = {
      inputs: {
        prompt: '   ',
      },
    }
    const ghContext = createMockGitHubContext('workflow_dispatch', payload)

    // #when routing the event
    const result = routeEvent(ghContext, logger)

    // #then it should skip with prompt_required reason
    expect(result.shouldProcess).toBe(false)
    expect(result.shouldProcess === false && result.skipReason).toBe('prompt_required')
  })

  it('skips discussion_comment from bot itself', () => {
    // #given a discussion comment from the bot
    const payload = {
      action: 'created',
      discussion: {number: 1, title: 'Test', locked: false},
      comment: {
        id: 1,
        body: 'Bot response',
        user: {login: 'fro-bot'},
        author_association: 'NONE',
      },
    }
    const ghContext = createMockGitHubContext('discussion_comment', payload)
    const config = {botLogin: 'fro-bot'}

    // #when routing the event
    const result = routeEvent(ghContext, logger, config)

    // #then it should skip with self_comment reason
    expect(result.shouldProcess).toBe(false)
    expect(result.shouldProcess === false && result.skipReason).toBe('self_comment')
  })

  it('skips locked discussion', () => {
    // #given a locked discussion
    const payload = {
      action: 'created',
      discussion: {number: 1, title: 'Test', locked: true},
      comment: {
        id: 1,
        body: '@fro-bot help',
        user: {login: 'user'},
        author_association: 'MEMBER',
      },
    }
    const ghContext = createMockGitHubContext('discussion_comment', payload)
    const config = {botLogin: 'fro-bot'}

    // #when routing the event
    const result = routeEvent(ghContext, logger, config)

    // #then it should skip with issue_locked reason
    expect(result.shouldProcess).toBe(false)
    expect(result.shouldProcess === false && result.skipReason).toBe('issue_locked')
  })

  describe('issues event', () => {
    it('routes issues.opened event', () => {
      // #given an issues.opened event
      const payload = {
        action: 'opened',
        issue: {
          number: 42,
          title: 'Bug: Something is broken',
          body: 'Description of the bug',
          state: 'open',
          user: {login: 'reporter'},
          locked: false,
        },
        repository: {
          owner: {login: 'owner'},
          name: 'repo',
        },
        sender: {login: 'reporter'},
      }
      const ghContext = createMockGitHubContext('issues', payload)
      const config = {botLogin: 'fro-bot'}

      // #when routing the event
      const result = routeEvent(ghContext, logger, config)

      // #then it should process with correct context
      expect(result.shouldProcess).toBe(true)
      expect(result.context.triggerType).toBe('issues')
      expect(result.context.target?.kind).toBe('issue')
      expect(result.context.target?.number).toBe(42)
      expect(result.context.target?.title).toBe('Bug: Something is broken')
    })

    it('routes issues.edited event with bot mention', () => {
      // #given an issues.edited event with @fro-bot mention
      const payload = {
        action: 'edited',
        issue: {
          number: 42,
          title: 'Bug: Something is broken',
          body: '@fro-bot please help with this',
          state: 'open',
          user: {login: 'reporter'},
          locked: false,
        },
        repository: {
          owner: {login: 'owner'},
          name: 'repo',
        },
        sender: {login: 'reporter'},
      }
      const ghContext = createMockGitHubContext('issues', payload)
      const config = {botLogin: 'fro-bot'}

      // #when routing the event
      const result = routeEvent(ghContext, logger, config)

      // #then it should process and detect the mention
      expect(result.shouldProcess).toBe(true)
      expect(result.context.triggerType).toBe('issues')
      expect(result.context.hasMention).toBe(true)
    })

    it('skips issues.edited event without bot mention', () => {
      // #given an issues.edited event without mention
      const payload = {
        action: 'edited',
        issue: {
          number: 42,
          title: 'Bug: Something is broken',
          body: 'Updated description without mention',
          state: 'open',
          user: {login: 'reporter'},
          locked: false,
        },
        repository: {
          owner: {login: 'owner'},
          name: 'repo',
        },
        sender: {login: 'reporter'},
      }
      const ghContext = createMockGitHubContext('issues', payload)
      const config = {botLogin: 'fro-bot'}

      // #when routing the event
      const result = routeEvent(ghContext, logger, config)

      // #then it should skip with no_mention reason
      expect(result.shouldProcess).toBe(false)
      expect(result.shouldProcess === false && result.skipReason).toBe('no_mention')
    })

    it('skips issues.closed event (unsupported action)', () => {
      // #given an issues.closed event
      const payload = {
        action: 'closed',
        issue: {
          number: 42,
          title: 'Bug: Something is broken',
          body: 'Description',
          state: 'closed',
          user: {login: 'reporter'},
          locked: false,
        },
        repository: {
          owner: {login: 'owner'},
          name: 'repo',
        },
        sender: {login: 'reporter'},
      }
      const ghContext = createMockGitHubContext('issues', payload)
      const config = {botLogin: 'fro-bot'}

      // #when routing the event
      const result = routeEvent(ghContext, logger, config)

      // #then it should skip with action_not_supported reason
      expect(result.shouldProcess).toBe(false)
      expect(result.shouldProcess === false && result.skipReason).toBe('action_not_supported')
    })
  })

  describe('pull_request event', () => {
    it('routes pull_request.opened event', () => {
      // #given a pull_request.opened event
      const payload = {
        action: 'opened',
        pull_request: {
          number: 99,
          title: 'feat: add new feature',
          body: 'Description of the feature',
          state: 'open',
          user: {login: 'contributor'},
          draft: false,
          locked: false,
        },
        repository: {
          owner: {login: 'owner'},
          name: 'repo',
        },
        sender: {login: 'contributor'},
      }
      const ghContext = createMockGitHubContext('pull_request', payload)
      const config = {botLogin: 'fro-bot'}

      // #when routing the event
      const result = routeEvent(ghContext, logger, config)

      // #then it should process with correct context
      expect(result.shouldProcess).toBe(true)
      expect(result.context.triggerType).toBe('pull_request')
      expect(result.context.target?.kind).toBe('pr')
      expect(result.context.target?.number).toBe(99)
      expect(result.context.target?.isDraft).toBe(false)
    })

    it('routes pull_request.synchronize event', () => {
      // #given a pull_request.synchronize event
      const payload = {
        action: 'synchronize',
        pull_request: {
          number: 99,
          title: 'feat: add new feature',
          body: 'Description',
          state: 'open',
          user: {login: 'contributor'},
          draft: false,
          locked: false,
        },
        repository: {
          owner: {login: 'owner'},
          name: 'repo',
        },
        sender: {login: 'contributor'},
      }
      const ghContext = createMockGitHubContext('pull_request', payload)
      const config = {botLogin: 'fro-bot'}

      // #when routing the event
      const result = routeEvent(ghContext, logger, config)

      // #then it should process
      expect(result.shouldProcess).toBe(true)
      expect(result.context.triggerType).toBe('pull_request')
    })

    it('routes pull_request.reopened event', () => {
      // #given a pull_request.reopened event
      const payload = {
        action: 'reopened',
        pull_request: {
          number: 99,
          title: 'feat: add new feature',
          body: 'Description',
          state: 'open',
          user: {login: 'contributor'},
          draft: false,
          locked: false,
        },
        repository: {
          owner: {login: 'owner'},
          name: 'repo',
        },
        sender: {login: 'contributor'},
      }
      const ghContext = createMockGitHubContext('pull_request', payload)
      const config = {botLogin: 'fro-bot'}

      // #when routing the event
      const result = routeEvent(ghContext, logger, config)

      // #then it should process
      expect(result.shouldProcess).toBe(true)
      expect(result.context.triggerType).toBe('pull_request')
    })

    it('skips draft PRs when skipDraftPRs is true', () => {
      // #given a draft pull_request.opened event
      const payload = {
        action: 'opened',
        pull_request: {
          number: 99,
          title: 'feat: WIP feature',
          body: 'Description',
          state: 'open',
          user: {login: 'contributor'},
          draft: true,
          locked: false,
        },
        repository: {
          owner: {login: 'owner'},
          name: 'repo',
        },
        sender: {login: 'contributor'},
      }
      const ghContext = createMockGitHubContext('pull_request', payload)
      const config = {botLogin: 'fro-bot', skipDraftPRs: true}

      // #when routing the event
      const result = routeEvent(ghContext, logger, config)

      // #then it should skip with draft_pr reason
      expect(result.shouldProcess).toBe(false)
      expect(result.shouldProcess === false && result.skipReason).toBe('draft_pr')
    })

    it('processes draft PRs when skipDraftPRs is false', () => {
      // #given a draft pull_request.opened event with skipDraftPRs false
      const payload = {
        action: 'opened',
        pull_request: {
          number: 99,
          title: 'feat: WIP feature',
          body: 'Description',
          state: 'open',
          user: {login: 'contributor'},
          draft: true,
          locked: false,
        },
        repository: {
          owner: {login: 'owner'},
          name: 'repo',
        },
        sender: {login: 'contributor'},
      }
      const ghContext = createMockGitHubContext('pull_request', payload)
      const config = {botLogin: 'fro-bot', skipDraftPRs: false}

      // #when routing the event
      const result = routeEvent(ghContext, logger, config)

      // #then it should process
      expect(result.shouldProcess).toBe(true)
      expect(result.context.target?.isDraft).toBe(true)
    })

    it('skips pull_request.closed event (unsupported action)', () => {
      // #given a pull_request.closed event
      const payload = {
        action: 'closed',
        pull_request: {
          number: 99,
          title: 'feat: add new feature',
          body: 'Description',
          state: 'closed',
          user: {login: 'contributor'},
          draft: false,
          locked: false,
        },
        repository: {
          owner: {login: 'owner'},
          name: 'repo',
        },
        sender: {login: 'contributor'},
      }
      const ghContext = createMockGitHubContext('pull_request', payload)
      const config = {botLogin: 'fro-bot'}

      // #when routing the event
      const result = routeEvent(ghContext, logger, config)

      // #then it should skip with action_not_supported reason
      expect(result.shouldProcess).toBe(false)
      expect(result.shouldProcess === false && result.skipReason).toBe('action_not_supported')
    })
  })

  describe('pull_request_review_comment event', () => {
    it('routes pull_request_review_comment.created event', () => {
      // #given a pull_request_review_comment.created event
      const payload = {
        action: 'created',
        pull_request: {
          number: 99,
          title: 'feat: add new feature',
          locked: false,
        },
        comment: {
          id: 123,
          body: '@fro-bot please explain this code',
          user: {login: 'reviewer'},
          author_association: 'MEMBER',
          path: 'src/lib/feature.ts',
          line: 42,
          diff_hunk: '@@ -10,6 +10,8 @@ function example() {\n+  const newCode = true\n }',
          commit_id: 'abc123',
        },
        repository: {
          owner: {login: 'owner'},
          name: 'repo',
        },
        sender: {login: 'reviewer'},
      }
      const ghContext = createMockGitHubContext('pull_request_review_comment', payload)
      const config = {botLogin: 'fro-bot'}

      // #when routing the event
      const result = routeEvent(ghContext, logger, config)

      // #then it should process with correct context
      expect(result.shouldProcess).toBe(true)
      expect(result.context.triggerType).toBe('pull_request_review_comment')
      expect(result.context.target?.kind).toBe('pr')
      expect(result.context.target?.path).toBe('src/lib/feature.ts')
      expect(result.context.target?.line).toBe(42)
      expect(result.context.target?.diffHunk).toContain('const newCode')
      expect(result.context.target?.commitId).toBe('abc123')
      expect(result.context.hasMention).toBe(true)
    })

    it('skips pull_request_review_comment.edited event', () => {
      // #given a pull_request_review_comment.edited event
      const payload = {
        action: 'edited',
        pull_request: {
          number: 99,
          title: 'feat: add new feature',
          locked: false,
        },
        comment: {
          id: 123,
          body: '@fro-bot please explain this code',
          user: {login: 'reviewer'},
          author_association: 'MEMBER',
          path: 'src/lib/feature.ts',
          line: 42,
          diff_hunk: '',
          commit_id: 'abc123',
        },
        repository: {
          owner: {login: 'owner'},
          name: 'repo',
        },
        sender: {login: 'reviewer'},
      }
      const ghContext = createMockGitHubContext('pull_request_review_comment', payload)
      const config = {botLogin: 'fro-bot'}

      // #when routing the event
      const result = routeEvent(ghContext, logger, config)

      // #then it should skip with action_not_created reason
      expect(result.shouldProcess).toBe(false)
      expect(result.shouldProcess === false && result.skipReason).toBe('action_not_created')
    })

    it('handles pull_request_review_comment with null line number', () => {
      // #given a review comment without a line number (file-level comment)
      const payload = {
        action: 'created',
        pull_request: {
          number: 99,
          title: 'feat: add new feature',
          locked: false,
        },
        comment: {
          id: 123,
          body: '@fro-bot please review this file',
          user: {login: 'reviewer'},
          author_association: 'MEMBER',
          path: 'src/lib/feature.ts',
          line: null,
          diff_hunk: '@@ -10,6 +10,8 @@ function example() {',
          commit_id: 'abc123',
        },
        repository: {
          owner: {login: 'owner'},
          name: 'repo',
        },
        sender: {login: 'reviewer'},
      }
      const ghContext = createMockGitHubContext('pull_request_review_comment', payload)
      const config = {botLogin: 'fro-bot'}

      // #when routing the event
      const result = routeEvent(ghContext, logger, config)

      // #then it should process and line should be undefined
      expect(result.shouldProcess).toBe(true)
      expect(result.context.target?.line).toBeUndefined()
      expect(result.context.target?.path).toBe('src/lib/feature.ts')
    })
  })

  describe('schedule event', () => {
    it('routes schedule event with prompt input', () => {
      // #given a schedule event with promptInput configured
      const payload = {schedule: '0 0 * * *'}
      const ghContext = createMockGitHubContext('schedule', payload)
      const config = {botLogin: 'fro-bot', promptInput: 'Run daily maintenance tasks'}

      // #when routing the event
      const result = routeEvent(ghContext, logger, config)

      // #then it should process
      expect(result.shouldProcess).toBe(true)
      expect(result.context.triggerType).toBe('schedule')
      expect(result.context.target?.kind).toBe('manual')
      expect(result.context.commentBody).toBe('Run daily maintenance tasks')
    })

    it('fails schedule event without prompt input', () => {
      // #given a schedule event without promptInput
      const payload = {schedule: '0 0 * * *'}
      const ghContext = createMockGitHubContext('schedule', payload)
      const config = {botLogin: 'fro-bot', promptInput: null}

      // #when routing the event
      const result = routeEvent(ghContext, logger, config)

      // #then it should skip with prompt_required reason
      expect(result.shouldProcess).toBe(false)
      expect(result.shouldProcess === false && result.skipReason).toBe('prompt_required')
    })

    it('fails schedule event with empty prompt input', () => {
      // #given a schedule event with empty promptInput
      const payload = {schedule: '0 0 * * *'}
      const ghContext = createMockGitHubContext('schedule', payload)
      const config = {botLogin: 'fro-bot', promptInput: '   '}

      // #when routing the event
      const result = routeEvent(ghContext, logger, config)

      // #then it should skip with prompt_required reason
      expect(result.shouldProcess).toBe(false)
      expect(result.shouldProcess === false && result.skipReason).toBe('prompt_required')
    })
  })
})
