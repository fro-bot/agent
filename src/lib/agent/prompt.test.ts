import type {Logger} from '../logger.js'
import type {SessionSearchResult, SessionSummary} from '../session/types.js'
import type {TriggerContext} from '../triggers/types.js'
import type {AgentContext, PromptOptions, SessionContext} from './types.js'
import {beforeEach, describe, expect, it} from 'vitest'
import {createMockLogger} from '../test-helpers.js'
import {buildAgentPrompt, buildTaskSection, getTriggerDirective} from './prompt.js'

function createMockContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    eventName: 'issue_comment',
    repo: 'owner/repo',
    ref: 'refs/heads/main',
    actor: 'test-user',
    runId: '12345',
    issueNumber: 42,
    issueTitle: 'Test Issue',
    issueType: 'issue',
    commentBody: 'Hello agent!',
    commentAuthor: 'commenter',
    commentId: 999,
    defaultBranch: 'main',
    diffContext: null,
    hydratedContext: null,
    ...overrides,
  }
}

function createMockSessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'ses_abc123',
    projectID: 'proj_123',
    directory: '/test/project',
    title: 'Test Session',
    createdAt: 1705312800000, // 2024-01-15T10:00:00Z
    updatedAt: 1705320000000, // 2024-01-15T12:00:00Z
    messageCount: 10,
    agents: ['build', 'oracle'],
    isChild: false,
    ...overrides,
  }
}

function createMockSearchResult(overrides: Partial<SessionSearchResult> = {}): SessionSearchResult {
  return {
    sessionId: 'ses_xyz789',
    matches: [
      {messageId: 'msg_1', partId: 'part_1', role: 'user', excerpt: 'Fix the auth bug in login.ts'},
      {messageId: 'msg_2', partId: 'part_2', role: 'assistant', excerpt: 'I found the issue in the JWT validation'},
    ],
    ...overrides,
  }
}

describe('buildAgentPrompt', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
  })

  it('includes environment context section', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext(),
      customPrompt: null,
      cacheStatus: 'hit',
    }

    // #when
    const prompt = buildAgentPrompt(options, mockLogger)

    // #then
    expect(prompt).toContain('# Agent Context')
    expect(prompt).toContain('**Repository:** owner/repo')
    expect(prompt).toContain('**Branch/Ref:** refs/heads/main')
    expect(prompt).toContain('**Event:** issue_comment')
    expect(prompt).toContain('**Actor:** test-user')
    expect(prompt).toContain('**Run ID:** 12345')
    expect(prompt).toContain('**Cache Status:** hit')
  })

  it('includes issue context when issue number is present', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext({
        issueNumber: 123,
        issueTitle: 'Bug: Something broken',
        issueType: 'issue',
      }),
      customPrompt: null,
      cacheStatus: 'miss',
    }

    // #when
    const prompt = buildAgentPrompt(options, mockLogger)

    // #then
    expect(prompt).toContain('## Issue Context')
    expect(prompt).toContain('**Number:** #123')
    expect(prompt).toContain('**Title:** Bug: Something broken')
    expect(prompt).toContain('**Type:** issue')
  })

  it('includes PR context when issue type is pr', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext({
        issueNumber: 456,
        issueTitle: 'feat: Add feature',
        issueType: 'pr',
      }),
      customPrompt: null,
      cacheStatus: 'hit',
    }

    // #when
    const prompt = buildAgentPrompt(options, mockLogger)

    // #then
    expect(prompt).toContain('## Pull Request Context')
    expect(prompt).toContain('**Number:** #456')
    expect(prompt).toContain('**Type:** pr')
  })

  it('includes trigger comment when present', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext({
        commentBody: 'Please fix the bug in auth.ts',
        commentAuthor: 'reporter',
      }),
      customPrompt: null,
      cacheStatus: 'hit',
    }

    // #when
    const prompt = buildAgentPrompt(options, mockLogger)

    // #then
    expect(prompt).toContain('## Trigger Comment')
    expect(prompt).toContain('**Author:** reporter')
    expect(prompt).toContain('Please fix the bug in auth.ts')
  })

  it('includes session management instructions', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext(),
      customPrompt: null,
      cacheStatus: 'hit',
    }

    // #when
    const prompt = buildAgentPrompt(options, mockLogger)

    // #then
    expect(prompt).toContain('## Session Management (REQUIRED)')
    expect(prompt).toContain('session_search')
    expect(prompt).toContain('session_read')
  })

  it('includes gh CLI operation examples', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext({issueNumber: 42, defaultBranch: 'develop'}),
      customPrompt: null,
      cacheStatus: 'hit',
    }

    // #when
    const prompt = buildAgentPrompt(options, mockLogger)

    // #then
    expect(prompt).toContain('## GitHub Operations (Use gh CLI)')
    expect(prompt).toContain('gh issue comment 42')
    expect(prompt).toContain('gh pr comment 42')
    expect(prompt).toContain('gh pr create')
    expect(prompt).toContain('--base develop')
  })

  it('includes run summary requirement with template', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext({
        eventName: 'issue_comment',
        repo: 'owner/repo',
        runId: '99999',
      }),
      customPrompt: null,
      cacheStatus: 'corrupted',
    }

    // #when
    const prompt = buildAgentPrompt(options, mockLogger)

    // #then
    expect(prompt).toContain('## Run Summary (REQUIRED)')
    expect(prompt).toContain('<details>')
    expect(prompt).toContain('<summary>Run Summary</summary>')
    expect(prompt).toContain('| Event | issue_comment |')
    expect(prompt).toContain('| Repository | owner/repo |')
    expect(prompt).toContain('| Run ID | 99999 |')
    expect(prompt).toContain('| Cache | corrupted |')
  })

  it('includes actual sessionId in run summary when provided', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext({
        eventName: 'issue_comment',
        repo: 'owner/repo',
        runId: '99999',
      }),
      customPrompt: null,
      cacheStatus: 'hit',
      sessionId: 'ses_abc123xyz',
    }

    // #when
    const prompt = buildAgentPrompt(options, mockLogger)

    // #then
    expect(prompt).toContain('| Session | ses_abc123xyz |')
    expect(prompt).not.toContain('<your_session_id>')
  })

  it('uses placeholder when sessionId not provided', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext(),
      customPrompt: null,
      cacheStatus: 'hit',
    }

    // #when
    const prompt = buildAgentPrompt(options, mockLogger)

    // #then
    expect(prompt).toContain('| Session | <your_session_id> |')
  })

  it('includes custom prompt when provided', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext(),
      customPrompt: 'Focus on security vulnerabilities and performance issues.',
      cacheStatus: 'hit',
    }

    // #when
    const prompt = buildAgentPrompt(options, mockLogger)

    // #then
    expect(prompt).toContain('Focus on security vulnerabilities and performance issues.')
  })

  it('excludes custom instructions section when customPrompt is null', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext(),
      customPrompt: null,
      cacheStatus: 'hit',
    }

    // #when
    const prompt = buildAgentPrompt(options, mockLogger)

    // #then
    expect(prompt).not.toContain('## Custom Instructions')
  })

  it('excludes custom instructions section when customPrompt is empty', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext(),
      customPrompt: '   ',
      cacheStatus: 'hit',
    }

    // #when
    const prompt = buildAgentPrompt(options, mockLogger)

    // #then
    expect(prompt).not.toContain('## Custom Instructions')
  })

  it('includes task directive for comment-triggered runs', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext({commentBody: 'Do something'}),
      customPrompt: null,
      cacheStatus: 'hit',
    }

    // #when
    const prompt = buildAgentPrompt(options, mockLogger)

    // #then
    expect(prompt).toContain('## Task')
    expect(prompt).toContain('Respond to the trigger comment above')
  })

  it('includes generic task directive for non-comment runs', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext({commentBody: null, repo: 'org/project'}),
      customPrompt: null,
      cacheStatus: 'hit',
    }

    // #when
    const prompt = buildAgentPrompt(options, mockLogger)

    // #then
    expect(prompt).toContain('## Task')
    expect(prompt).toContain('Execute the requested operation for repository org/project')
  })

  it('logs prompt metadata', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext(),
      customPrompt: 'Custom',
      cacheStatus: 'hit',
    }

    // #when
    buildAgentPrompt(options, mockLogger)

    // #then
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Built agent prompt',
      expect.objectContaining({
        length: expect.any(Number) as unknown,
        hasCustom: true,
      }),
    )
  })

  it('handles missing issue context gracefully', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext({
        issueNumber: null,
        issueTitle: null,
        issueType: null,
      }),
      customPrompt: null,
      cacheStatus: 'miss',
    }

    // #when
    const prompt = buildAgentPrompt(options, mockLogger)

    // #then
    expect(prompt).not.toContain('## Issue Context')
    expect(prompt).not.toContain('## Pull Request Context')
    expect(prompt).toContain('# Agent Context') // Still has main sections
  })

  describe('session context', () => {
    it('includes session context section when sessionContext is provided', () => {
      // #given
      const sessionContext: SessionContext = {
        recentSessions: [createMockSessionSummary()],
        priorWorkContext: [],
      }
      const options: PromptOptions = {
        context: createMockContext(),
        customPrompt: null,
        cacheStatus: 'hit',
        sessionContext,
      }

      // #when
      const prompt = buildAgentPrompt(options, mockLogger)

      // #then
      expect(prompt).toContain('## Prior Session Context')
      expect(prompt).toContain('### Recent Sessions')
    })

    it('excludes session context section when sessionContext is undefined', () => {
      // #given
      const options: PromptOptions = {
        context: createMockContext(),
        customPrompt: null,
        cacheStatus: 'hit',
      }

      // #when
      const prompt = buildAgentPrompt(options, mockLogger)

      // #then
      expect(prompt).not.toContain('## Prior Session Context')
    })

    it('renders recent sessions as a markdown table', () => {
      // #given
      const sessionContext: SessionContext = {
        recentSessions: [
          createMockSessionSummary({
            id: 'ses_001',
            title: 'Auth fix session',
            updatedAt: 1705320000000, // 2024-01-15T12:00:00Z
            messageCount: 15,
            agents: ['build'],
          }),
          createMockSessionSummary({
            id: 'ses_002',
            title: 'Feature implementation',
            updatedAt: 1705222800000, // 2024-01-14T09:00:00Z
            messageCount: 25,
            agents: ['oracle', 'librarian'],
          }),
        ],
        priorWorkContext: [],
      }
      const options: PromptOptions = {
        context: createMockContext(),
        customPrompt: null,
        cacheStatus: 'hit',
        sessionContext,
      }

      // #when
      const prompt = buildAgentPrompt(options, mockLogger)

      // #then
      expect(prompt).toContain('| ID | Title | Updated | Messages | Agents |')
      expect(prompt).toContain('| ses_001 | Auth fix session | 2024-01-15 | 15 | build |')
      expect(prompt).toContain('| ses_002 | Feature implementation | 2024-01-14 | 25 | oracle, librarian |')
      expect(prompt).toContain('Use `session_read` to review any of these sessions in detail.')
    })

    it('limits recent sessions to 5 entries', () => {
      // #given
      const sessions = Array.from({length: 10}, (_, i) =>
        createMockSessionSummary({id: `ses_${i}`, title: `Session ${i}`}),
      )
      const sessionContext: SessionContext = {
        recentSessions: sessions,
        priorWorkContext: [],
      }
      const options: PromptOptions = {
        context: createMockContext(),
        customPrompt: null,
        cacheStatus: 'hit',
        sessionContext,
      }

      // #when
      const prompt = buildAgentPrompt(options, mockLogger)

      // #then
      expect(prompt).toContain('ses_0')
      expect(prompt).toContain('ses_4')
      expect(prompt).not.toContain('ses_5')
      expect(prompt).not.toContain('ses_9')
    })

    it('includes prior work context with search results', () => {
      // #given
      const sessionContext: SessionContext = {
        recentSessions: [],
        priorWorkContext: [
          createMockSearchResult({
            sessionId: 'ses_prior',
            matches: [
              {messageId: 'msg_1', partId: 'part_1', role: 'user', excerpt: 'Fix authentication issue'},
              {messageId: 'msg_2', partId: 'part_2', role: 'assistant', excerpt: 'Found JWT bug'},
            ],
          }),
        ],
      }
      const options: PromptOptions = {
        context: createMockContext(),
        customPrompt: null,
        cacheStatus: 'hit',
        sessionContext,
      }

      // #when
      const prompt = buildAgentPrompt(options, mockLogger)

      // #then
      expect(prompt).toContain('### Relevant Prior Work')
      expect(prompt).toContain('**Session ses_prior:**')
      expect(prompt).toContain('- Fix authentication issue')
      expect(prompt).toContain('- Found JWT bug')
      expect(prompt).toContain('Use `session_read` to review full context before starting new investigation.')
    })

    it('limits prior work context to 3 sessions with 2 matches each', () => {
      // #given
      const results = Array.from({length: 5}, (_, i) =>
        createMockSearchResult({
          sessionId: `ses_${i}`,
          matches: Array.from({length: 5}, (_, j) => ({
            messageId: `msg_${j}`,
            partId: `part_${j}`,
            role: 'user' as const,
            excerpt: `Match ${i}-${j}`,
          })),
        }),
      )
      const sessionContext: SessionContext = {
        recentSessions: [],
        priorWorkContext: results,
      }
      const options: PromptOptions = {
        context: createMockContext(),
        customPrompt: null,
        cacheStatus: 'hit',
        sessionContext,
      }

      // #when
      const prompt = buildAgentPrompt(options, mockLogger)

      // #then
      // Should have 3 sessions
      expect(prompt).toContain('**Session ses_0:**')
      expect(prompt).toContain('**Session ses_2:**')
      expect(prompt).not.toContain('**Session ses_3:**')

      // Should have 2 matches per session
      expect(prompt).toContain('Match 0-0')
      expect(prompt).toContain('Match 0-1')
      expect(prompt).not.toContain('Match 0-2')
    })

    it('handles empty session context gracefully', () => {
      // #given
      const sessionContext: SessionContext = {
        recentSessions: [],
        priorWorkContext: [],
      }
      const options: PromptOptions = {
        context: createMockContext(),
        customPrompt: null,
        cacheStatus: 'hit',
        sessionContext,
      }

      // #when
      const prompt = buildAgentPrompt(options, mockLogger)

      // #then
      // Should still have the header but no subsections
      expect(prompt).toContain('## Prior Session Context')
      expect(prompt).not.toContain('### Recent Sessions')
      expect(prompt).not.toContain('### Relevant Prior Work')
    })

    it('handles sessions with empty title', () => {
      // #given
      const sessionContext: SessionContext = {
        recentSessions: [createMockSessionSummary({id: 'ses_null', title: ''})],
        priorWorkContext: [],
      }
      const options: PromptOptions = {
        context: createMockContext(),
        customPrompt: null,
        cacheStatus: 'hit',
        sessionContext,
      }

      // #when
      const prompt = buildAgentPrompt(options, mockLogger)

      // #then
      expect(prompt).toContain('| ses_null | Untitled |')
    })

    it('handles sessions with empty agents array', () => {
      // #given
      const sessionContext: SessionContext = {
        recentSessions: [createMockSessionSummary({id: 'ses_empty', agents: []})],
        priorWorkContext: [],
      }
      const options: PromptOptions = {
        context: createMockContext(),
        customPrompt: null,
        cacheStatus: 'hit',
        sessionContext,
      }

      // #when
      const prompt = buildAgentPrompt(options, mockLogger)

      // #then
      expect(prompt).toContain('| ses_empty | Test Session |')
      expect(prompt).toContain('| N/A |')
    })

    it('logs hasSessionContext in debug output', () => {
      // #given
      const sessionContext: SessionContext = {
        recentSessions: [createMockSessionSummary()],
        priorWorkContext: [],
      }
      const options: PromptOptions = {
        context: createMockContext(),
        customPrompt: null,
        cacheStatus: 'hit',
        sessionContext,
      }

      // #when
      buildAgentPrompt(options, mockLogger)

      // #then
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Built agent prompt',
        expect.objectContaining({
          hasSessionContext: true,
        }),
      )
    })
  })
})

function createMockTriggerContext(overrides: Partial<TriggerContext> = {}): TriggerContext {
  return {
    eventType: 'issue_comment',
    eventName: 'issue_comment',
    repo: {owner: 'owner', repo: 'repo'},
    ref: 'refs/heads/main',
    sha: 'abc123',
    runId: 12345,
    actor: 'test-user',
    action: 'created',
    author: {
      login: 'commenter',
      association: 'MEMBER',
      isBot: false,
    },
    target: {
      kind: 'issue',
      number: 42,
      title: 'Test Issue',
      body: 'Issue description',
      locked: false,
    },
    commentBody: '@fro-bot help',
    commentId: 999,
    hasMention: true,
    command: null,
    raw: {payload: {action: 'created'}} as unknown as TriggerContext['raw'],
    ...overrides,
  }
}

describe('getTriggerDirective', () => {
  it('returns respond directive for issue_comment', () => {
    // #given
    const context = createMockTriggerContext({eventType: 'issue_comment'})

    // #when
    const directive = getTriggerDirective(context, null)

    // #then
    expect(directive.directive).toBe('Respond to the comment above.')
    expect(directive.appendMode).toBe(true)
  })

  it('returns respond directive for discussion_comment', () => {
    // #given
    const context = createMockTriggerContext({eventType: 'discussion_comment'})

    // #when
    const directive = getTriggerDirective(context, null)

    // #then
    expect(directive.directive).toBe('Respond to the discussion comment above.')
    expect(directive.appendMode).toBe(true)
  })

  it('returns triage directive for issues.opened', () => {
    // #given
    const context = createMockTriggerContext({
      eventType: 'issues',
      action: 'opened',
    })

    // #when
    const directive = getTriggerDirective(context, null)

    // #then
    expect(directive.directive).toBe('Triage this issue: summarize, reproduce if possible, propose next steps.')
    expect(directive.appendMode).toBe(true)
  })

  it('returns mention directive for issues.edited', () => {
    // #given
    const context = createMockTriggerContext({
      eventType: 'issues',
      action: 'edited',
    })

    // #when
    const directive = getTriggerDirective(context, null)

    // #then
    expect(directive.directive).toBe('Respond to the mention in this issue.')
    expect(directive.appendMode).toBe(true)
  })

  it('returns review directive for pull_request', () => {
    // #given
    const context = createMockTriggerContext({
      eventType: 'pull_request',
      target: {
        kind: 'pr',
        number: 99,
        title: 'feat: add feature',
        body: 'Description',
        locked: false,
        isDraft: false,
      },
    })

    // #when
    const directive = getTriggerDirective(context, null)

    // #then
    expect(directive.directive).toBe('Review this pull request for code quality, potential bugs, and improvements.')
    expect(directive.appendMode).toBe(true)
  })

  it('returns file context directive for pull_request_review_comment', () => {
    // #given
    const context = createMockTriggerContext({
      eventType: 'pull_request_review_comment',
      target: {
        kind: 'pr',
        number: 99,
        title: 'feat: add feature',
        body: null,
        locked: false,
        path: 'src/lib/feature.ts',
        line: 42,
        diffHunk: '@@ -10,6 +10,8 @@\n+  const newCode = true',
        commitId: 'abc123',
      },
    })

    // #when
    const directive = getTriggerDirective(context, null)

    // #then
    expect(directive.directive).toContain('Respond to the review comment.')
    expect(directive.directive).toContain('**File:** `src/lib/feature.ts`')
    expect(directive.directive).toContain('**Line:** 42')
    expect(directive.appendMode).toBe(true)
  })

  it('returns prompt input for schedule with replace mode', () => {
    // #given
    const context = createMockTriggerContext({
      eventType: 'schedule',
      commentBody: 'Run daily maintenance tasks',
    })
    const promptInput = 'Run daily maintenance tasks'

    // #when
    const directive = getTriggerDirective(context, promptInput)

    // #then
    expect(directive.directive).toBe('Run daily maintenance tasks')
    expect(directive.appendMode).toBe(false)
  })

  it('returns prompt input for workflow_dispatch with replace mode', () => {
    // #given
    const context = createMockTriggerContext({
      eventType: 'workflow_dispatch',
      commentBody: 'Deploy to production',
    })
    const promptInput = 'Deploy to production'

    // #when
    const directive = getTriggerDirective(context, promptInput)

    // #then
    expect(directive.directive).toBe('Deploy to production')
    expect(directive.appendMode).toBe(false)
  })
})

describe('buildTaskSection', () => {
  it('builds task section with directive only when no custom prompt', () => {
    // #given
    const context = createMockTriggerContext({eventType: 'issue_comment'})

    // #when
    const section = buildTaskSection(context, null)

    // #then
    expect(section).toContain('## Task')
    expect(section).toContain('Respond to the comment above.')
    expect(section).not.toContain('Custom Instructions')
  })

  it('appends custom prompt in append mode', () => {
    // #given
    const context = createMockTriggerContext({eventType: 'issue_comment'})
    const customPrompt = 'Focus on security issues'

    // #when
    const section = buildTaskSection(context, customPrompt)

    // #then
    expect(section).toContain('## Task')
    expect(section).toContain('Respond to the comment above.')
    expect(section).toContain('Focus on security issues')
  })

  it('replaces directive with custom prompt in replace mode (schedule)', () => {
    // #given
    const context = createMockTriggerContext({eventType: 'schedule'})
    const customPrompt = 'Run maintenance tasks'

    // #when
    const section = buildTaskSection(context, customPrompt)

    // #then
    expect(section).toContain('## Task')
    expect(section).toContain('Run maintenance tasks')
  })

  it('includes review comment context in task section', () => {
    // #given
    const context = createMockTriggerContext({
      eventType: 'pull_request_review_comment',
      target: {
        kind: 'pr',
        number: 99,
        title: 'feat: add feature',
        body: null,
        locked: false,
        path: 'src/api/handler.ts',
        line: 100,
        diffHunk: '@@ changes @@',
        commitId: 'def456',
      },
    })

    // #when
    const section = buildTaskSection(context, null)

    // #then
    expect(section).toContain('**File:** `src/api/handler.ts`')
    expect(section).toContain('**Line:** 100')
    expect(section).toContain('**Commit:** `def456`')
  })
})
