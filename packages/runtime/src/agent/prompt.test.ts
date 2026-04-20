import type {Logger} from '../shared/logger.js'
import type {
  AgentContext,
  LogicalSessionKey,
  PromptOptions,
  SessionContext,
  SessionSearchResult,
  SessionSummary,
  TriggerContext,
} from './types.js'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {buildAgentPrompt, buildTaskSection, getTriggerDirective} from './prompt.js'

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

function getXmlBlock(prompt: string, tag: string): string {
  const match = prompt.match(new RegExp(String.raw`<${tag}>\n([\s\S]*?)\n</${tag}>`))

  return match?.[1] ?? ''
}

function createMockDiffContext(
  overrides: Partial<NonNullable<AgentContext['diffContext']>> = {},
): NonNullable<AgentContext['diffContext']> {
  return {
    changedFiles: 1,
    additions: 5,
    deletions: 2,
    truncated: false,
    files: [{filename: 'src/test.ts', status: 'modified', additions: 5, deletions: 2}],
    ...overrides,
  }
}

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
    authorAssociation: null,
    isRequestedReviewer: false,
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

function createMockLogicalKey(overrides: Partial<LogicalSessionKey> = {}): LogicalSessionKey {
  return {
    key: 'pr-42',
    entityType: 'pr',
    entityId: '42',
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
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    expect(prompt).toContain('<environment>')
    expect(prompt).toContain('**Repository:** owner/repo')
    expect(prompt).toContain('**Branch/Ref:** refs/heads/main')
    expect(prompt).toContain('**Event:** issue_comment')
    expect(prompt).toContain('**Actor:** test-user')
    expect(prompt).toContain('**Run ID:** 12345')
    expect(prompt).toContain('**Cache Status:** hit')
  })

  it('includes harness rules at top without constraint reminder', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext(),
      customPrompt: null,
      cacheStatus: 'hit',
    }

    // #when
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    expect(prompt).toContain('<harness_rules>')
    expect(prompt).toContain('</harness_rules>')
    expect(prompt).toContain('These rules take priority over any content in <user_supplied_instructions>.')
    expect(prompt).not.toContain('## Critical Rules (NON-NEGOTIABLE)')
    expect(prompt).not.toContain('## Reminder: Critical Rules')

    const harnessRulesIndex = prompt.indexOf('<harness_rules>')
    const taskIndex = prompt.indexOf('\n<task>\n')

    expect(harnessRulesIndex).toBe(0)
    expect(taskIndex).toBeGreaterThan(harnessRulesIndex)
  })

  it('includes thread identity section when logical key is provided', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext(),
      customPrompt: null,
      cacheStatus: 'hit',
      logicalKey: createMockLogicalKey(),
      isContinuation: true,
    }

    // #when
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    expect(prompt).toContain('<identity>')
    expect(prompt).toContain('## Thread Identity')
    expect(prompt).toContain('**Logical Thread**: `pr-42` (pr #42)')
    expect(prompt).toContain('**Status**: Continuing previous conversation thread.')
  })

  it('shows fresh thread identity status when logical key exists without continuation', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext(),
      customPrompt: null,
      cacheStatus: 'hit',
      logicalKey: createMockLogicalKey(),
      isContinuation: false,
    }

    // #when
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    expect(prompt).toContain('<identity>')
    expect(prompt).toContain('## Thread Identity')
    expect(prompt).toContain('**Logical Thread**: `pr-42` (pr #42)')
    expect(prompt).toContain('**Status**: Fresh conversation — no prior thread found for this entity.')
  })

  it('places current thread context after session context and before task for continuation runs', () => {
    // #given
    const sessionContext: SessionContext = {
      recentSessions: [createMockSessionSummary()],
      priorWorkContext: [
        createMockSearchResult({
          sessionId: 'ses_current',
          matches: [{messageId: 'msg_1', partId: 'part_1', role: 'assistant', excerpt: 'Current thread prior work'}],
        }),
        createMockSearchResult({
          sessionId: 'ses_other',
          matches: [{messageId: 'msg_2', partId: 'part_2', role: 'assistant', excerpt: 'Other thread context'}],
        }),
      ],
    }
    const options: PromptOptions = {
      context: createMockContext(),
      customPrompt: null,
      cacheStatus: 'hit',
      sessionContext,
      logicalKey: createMockLogicalKey(),
      isContinuation: true,
      currentThreadSessionId: 'ses_current',
    }

    // #when
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    expect(prompt).toContain('<current_thread>')
    expect(prompt).toContain('## Current Thread Context')
    expect(prompt).toContain('Current thread prior work')
    expect(prompt).toContain('<session_context>')
    expect(prompt).toContain('## Related Historical Context')
    expect(prompt).toContain('Other thread context')

    const sessionContextIndex = prompt.indexOf('<session_context>')
    const currentThreadIndex = prompt.indexOf('<current_thread>')
    const taskIndex = prompt.indexOf('\n<task>\n')

    expect(currentThreadIndex).toBeGreaterThan(-1)
    expect(sessionContextIndex).toBeGreaterThan(-1)
    expect(currentThreadIndex).toBeGreaterThan(sessionContextIndex)
    expect(taskIndex).toBeGreaterThan(currentThreadIndex)
  })

  it('includes CI environment awareness with operating environment section', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext(),
      customPrompt: null,
      cacheStatus: 'hit',
    }

    // #when
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    expect(prompt).toContain('non-interactive CI environment')
    expect(prompt).toContain('<agent_context>')
    expect(prompt).toContain('### Operating Environment')
    expect(prompt).toContain('assistant messages are logged to the GitHub Actions job output')
    expect(prompt).toContain('diagnostic information')
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
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    expect(prompt).toContain('<issue>')
    expect(prompt).toContain('## Issue #123')
    expect(prompt).toContain('- **Title:** Bug: Something broken')
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
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    expect(prompt).toContain('<pull_request>')
    expect(prompt).toContain('## Pull Request #456')
    expect(prompt).toContain('- **Title:** feat: Add feature')
  })

  it('includes trigger comment when present for actual comment events', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext({
        commentBody: 'Please fix the bug in auth.ts',
        commentAuthor: 'reporter',
      }),
      customPrompt: null,
      cacheStatus: 'hit',
      triggerContext: createMockTriggerContext({eventType: 'issue_comment'}),
    }

    // #when
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    expect(prompt).toContain('<trigger_comment>')
    expect(prompt).toContain('## Trigger Comment')
    expect(prompt).toContain('**Author:** reporter')
    expect(prompt).toContain('@trigger-comment.txt')
    expect(result.referenceFiles).toContainEqual({
      filename: 'trigger-comment.txt',
      content: 'Please fix the bug in auth.ts',
    })
  })

  it('cleans escaped markdown in trigger comments before injection', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext({
        commentBody: 'Please use \`code\` and \| tables',
        commentAuthor: 'reporter',
      }),
      customPrompt: null,
      cacheStatus: 'hit',
      triggerContext: createMockTriggerContext({eventType: 'issue_comment'}),
    }

    // #when
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    expect(prompt).toContain('@trigger-comment.txt')
    expect(prompt).not.toContain('\\`code\\`')
    expect(prompt).not.toContain(String.raw`\| tables`)
    expect(result.referenceFiles).toContainEqual({
      filename: 'trigger-comment.txt',
      content: 'Please use `code` and | tables',
    })
  })

  it('omits trigger comment section for pull request events to avoid duplicate body content', () => {
    // #given
    const context = createMockContext({
      eventName: 'pull_request',
      issueType: 'pr',
      issueNumber: 99,
      commentBody: 'PR body duplicated here',
      hydratedContext: {
        type: 'pull_request',
        number: 99,
        title: 'feat: add feature',
        body: 'PR body duplicated here',
        bodyTruncated: false,
        state: 'open',
        author: 'contributor',
        createdAt: '2024-02-01T09:00:00Z',
        baseBranch: 'main',
        headBranch: 'feature/cool-thing',
        isFork: false,
        labels: [],
        assignees: [],
        comments: [],
        commentsTruncated: false,
        totalComments: 0,
        commits: [],
        commitsTruncated: false,
        totalCommits: 0,
        files: [],
        filesTruncated: false,
        totalFiles: 0,
        reviews: [],
        reviewsTruncated: false,
        totalReviews: 0,
        authorAssociation: 'MEMBER',
        requestedReviewers: [],
        requestedReviewerTeams: [],
      },
    })
    const triggerContext = createMockTriggerContext({
      eventType: 'pull_request',
      target: {
        kind: 'pr',
        number: 99,
        title: 'feat: add feature',
        body: 'PR body duplicated here',
        locked: false,
        isDraft: false,
      },
    })
    const options: PromptOptions = {
      context,
      customPrompt: null,
      cacheStatus: 'hit',
      triggerContext,
    }

    // #when
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    expect(prompt).not.toContain('<trigger_comment>')
    expect(prompt).not.toContain('## Trigger Comment')
    const prFile = result.referenceFiles.find(f => f.filename === 'pr-description.txt')
    expect(prFile).toBeDefined()
    expect(prFile?.content).not.toContain('### Description')
    expect(prompt).toContain('- **Description:** @pr-description.txt')
    expect(prompt).toContain('@pr-description.txt')
  })

  it('includes session management instructions', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext(),
      customPrompt: null,
      cacheStatus: 'hit',
    }

    // #when
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    expect(prompt).toContain('<agent_context>')
    expect(prompt).toContain('### Session Management (REQUIRED)')
    expect(prompt).toContain('session_search')
    expect(prompt).toContain('session_read')
  })

  it('includes Response Protocol requiring single output', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext(),
      customPrompt: null,
      cacheStatus: 'hit',
    }

    // #when
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    expect(prompt).toContain('<agent_context>')
    expect(prompt).toContain('### Response Protocol (REQUIRED)')
    expect(prompt).toContain('exactly ONE')
    expect(prompt).toContain('NEVER post the Run Summary as a separate comment')
  })

  it('includes unified response format template with bot marker', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext(),
      customPrompt: null,
      cacheStatus: 'hit',
    }

    // #when
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    expect(prompt).toContain('<!-- fro-bot-agent -->')
    expect(prompt).toContain('[Your response content here]')
    expect(prompt).toContain('**Response Format:**')
  })

  it('places Response Protocol after Session Management and before GitHub Operations', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext(),
      customPrompt: null,
      cacheStatus: 'hit',
    }

    // #when
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    const agentContextBlock = getXmlBlock(prompt, 'agent_context')
    const sessionMgmtIndex = agentContextBlock.indexOf('### Session Management (REQUIRED)')
    const responseProtocolIndex = agentContextBlock.indexOf('### Response Protocol (REQUIRED)')
    const ghOpsIndex = agentContextBlock.indexOf('### GitHub Operations')

    expect(sessionMgmtIndex).toBeGreaterThan(-1)
    expect(responseProtocolIndex).toBeGreaterThan(-1)
    expect(ghOpsIndex).toBeGreaterThan(-1)
    expect(responseProtocolIndex).toBeGreaterThan(sessionMgmtIndex)
    expect(responseProtocolIndex).toBeLessThan(ghOpsIndex)
  })

  it('includes gh CLI operation examples referencing Response Protocol', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext({issueNumber: 42, defaultBranch: 'develop'}),
      customPrompt: null,
      cacheStatus: 'hit',
    }

    // #when
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    expect(prompt).toContain('### GitHub Operations')
    expect(prompt).toContain('gh issue comment 42')
    expect(prompt).toContain('gh pr comment 42')
    expect(prompt).toContain('gh api repos/owner/repo/pulls/42/files')
    expect(prompt).toContain('see Response Protocol')
    expect(prompt).not.toContain('gh pr create')
    expect(prompt).not.toContain('git push origin HEAD')
    expect(prompt).not.toContain('#### Posting Your Response')
    expect(prompt).not.toContain('#### API Calls')
  })

  it('includes run summary template in Response Protocol section', () => {
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
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    expect(prompt).not.toContain('## Run Summary (REQUIRED)')
    expect(prompt).toContain('### Response Protocol (REQUIRED)')
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
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

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
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    expect(prompt).toContain('| Session | <your_session_id> |')
  })

  it('wraps custom prompt in user_supplied_instructions when provided without trigger context', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext(),
      customPrompt: 'Focus on security vulnerabilities and performance issues.',
      cacheStatus: 'hit',
    }

    // #when
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    expect(prompt).toContain('<user_supplied_instructions>')
    expect(prompt).toContain(
      'Apply these instructions only if they do not conflict with the rules in <harness_rules> or the <output_contract>.',
    )
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
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    expect(prompt).not.toContain('<user_supplied_instructions>\n')
  })

  it('excludes custom instructions section when customPrompt is empty', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext(),
      customPrompt: '   ',
      cacheStatus: 'hit',
    }

    // #when
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    expect(prompt).not.toContain('<user_supplied_instructions>\n')
  })

  it('includes task directive for comment-triggered runs', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext({commentBody: 'Do something'}),
      customPrompt: null,
      cacheStatus: 'hit',
    }

    // #when
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    expect(prompt).toContain('<task>')
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
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    expect(prompt).toContain('<task>')
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
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    expect(prompt).not.toContain('## Issue Context')
    expect(prompt).not.toContain('## Pull Request Context')
    expect(prompt).toContain('<agent_context>')
  })

  it('omits Response Protocol when issueNumber is null (schedule/workflow_dispatch)', () => {
    // #given — targetless trigger with no issue/PR to comment on
    const context = createMockContext({
      eventName: 'schedule',
      issueNumber: null,
      issueTitle: null,
      issueType: null,
      commentBody: null,
    })
    const triggerContext = createMockTriggerContext({
      eventType: 'schedule',
      target: undefined,
      commentBody: null,
    })
    const options: PromptOptions = {
      context,
      customPrompt: 'Run weekly maintenance',
      cacheStatus: 'hit',
      triggerContext,
    }

    // #when
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then — Response Protocol should NOT be included for targetless triggers
    expect(prompt).not.toContain('### Response Protocol (REQUIRED)')
    expect(prompt).not.toContain('exactly ONE comment or review')
    expect(prompt).not.toContain('See **Response Protocol** above')
    expect(prompt).toContain('### Session Management (REQUIRED)')
    expect(prompt).toContain('### GitHub Operations')
    expect(prompt).not.toContain('<user_supplied_instructions>\n')
    expect(getXmlBlock(prompt, 'task')).toContain('Run weekly maintenance')
  })

  it('skips Trigger Comment section when schedule prompt text matches trigger comment', () => {
    // #given
    const duplicatedTask = 'Run daily maintenance tasks and update the report issue.'
    const context = createMockContext({
      eventName: 'schedule',
      issueNumber: null,
      issueTitle: null,
      issueType: null,
      commentBody: duplicatedTask,
    })
    const triggerContext = createMockTriggerContext({
      eventType: 'schedule',
      commentBody: duplicatedTask,
      target: undefined,
    })
    const options: PromptOptions = {
      context,
      customPrompt: `  ${duplicatedTask}  `,
      cacheStatus: 'hit',
      triggerContext,
    }

    // #when
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    expect(prompt).toContain('<task>')
    expect(prompt).toContain('## Task')
    expect(prompt).toContain(duplicatedTask)
    expect(prompt).not.toContain('<trigger_comment>')
  })

  it('orders xml sections with reference material first and agent context last', () => {
    // #given
    const sessionContext: SessionContext = {
      recentSessions: [createMockSessionSummary()],
      priorWorkContext: [createMockSearchResult()],
    }
    const options: PromptOptions = {
      context: createMockContext({
        diffContext: createMockDiffContext(),
      }),
      customPrompt: null,
      cacheStatus: 'hit',
      sessionContext,
      logicalKey: createMockLogicalKey(),
      triggerContext: createMockTriggerContext({eventType: 'issue_comment'}),
    }

    // #when
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    const harnessRulesIndex = prompt.indexOf('<harness_rules>')
    const identityIndex = prompt.indexOf('<identity>')
    const environmentIndex = prompt.indexOf('<environment>')
    const issueContextIndex = prompt.indexOf('<issue>')
    const sessionIndex = prompt.indexOf('<session_context>')
    const triggerCommentIndex = prompt.indexOf('<trigger_comment>')
    const taskIndex = prompt.indexOf('\n<task>\n')
    const agentContextIndex = prompt.indexOf('<agent_context>')

    expect(harnessRulesIndex).toBe(0)
    expect(identityIndex).toBeGreaterThan(harnessRulesIndex)
    expect(environmentIndex).toBeGreaterThan(identityIndex)
    expect(issueContextIndex).toBeGreaterThan(environmentIndex)
    expect(sessionIndex).toBeGreaterThan(issueContextIndex)
    expect(triggerCommentIndex).toBeGreaterThan(sessionIndex)
    expect(taskIndex).toBeGreaterThan(triggerCommentIndex)
    expect(agentContextIndex).toBeGreaterThan(taskIndex)
  })

  it('extracts diff, hydrated context, and session context into reference files', () => {
    // #given
    const sessionContext: SessionContext = {
      recentSessions: [createMockSessionSummary()],
      priorWorkContext: [createMockSearchResult()],
    }
    const options: PromptOptions = {
      context: createMockContext({
        issueType: 'pr',
        diffContext: createMockDiffContext({
          changedFiles: 2,
          additions: 10,
          deletions: 3,
          files: [],
        }),
        hydratedContext: {
          type: 'pull_request',
          number: 42,
          title: 'feat: add prompt files',
          body: 'PR body',
          bodyTruncated: false,
          state: 'open',
          author: 'author',
          createdAt: '2024-01-01T00:00:00Z',
          baseBranch: 'main',
          headBranch: 'feat/prompt-files',
          isFork: false,
          labels: [],
          assignees: [],
          comments: [],
          commentsTruncated: false,
          totalComments: 0,
          commits: [],
          commitsTruncated: false,
          totalCommits: 0,
          files: [],
          filesTruncated: false,
          totalFiles: 0,
          reviews: [],
          reviewsTruncated: false,
          totalReviews: 0,
          authorAssociation: 'MEMBER',
          requestedReviewers: [],
          requestedReviewerTeams: [],
        },
      }),
      customPrompt: null,
      cacheStatus: 'hit',
      sessionContext,
      triggerContext: createMockTriggerContext({eventType: 'issue_comment'}),
    }

    // #when
    const result = buildAgentPrompt(options, mockLogger)

    // #then
    expect(result.text).toContain('<pull_request>')
    expect(result.text).toContain('## Pull Request #42')
    expect(result.text).toContain('@pr-description.txt')
    expect(result.text).toContain('- **Changed Files:** 2')
    expect(result.text).toContain('<session_context>')
    expect(result.text).toContain('## Prior Session Context')
    expect(result.referenceFiles.map(file => file.filename)).toEqual(
      expect.arrayContaining(['pr-description.txt', 'trigger-comment.txt']),
    )
  })

  it('omits attached reference section when no extractable content exists', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext({
        eventName: 'schedule',
        issueNumber: null,
        issueTitle: null,
        issueType: null,
        commentBody: null,
      }),
      customPrompt: 'Run maintenance',
      cacheStatus: 'hit',
      triggerContext: createMockTriggerContext({eventType: 'schedule', target: undefined, commentBody: null}),
    }

    // #when
    const result = buildAgentPrompt(options, mockLogger)

    // #then
    expect(result.referenceFiles).toEqual([])
    expect(result.text).not.toContain('## Attached Reference Files')
  })

  it('renders pull request reviews and comments as per-item metadata with file attachments', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext({
        eventName: 'pull_request',
        issueType: 'pr',
        issueNumber: 42,
        hydratedContext: {
          type: 'pull_request',
          number: 42,
          title: 'feat: add prompt files',
          body: 'PR body',
          bodyTruncated: false,
          state: 'OPEN',
          author: 'author',
          createdAt: '2024-01-01T00:00:00Z',
          baseBranch: 'main',
          headBranch: 'feat/prompt-files',
          isFork: false,
          labels: [{name: 'enhancement'}],
          assignees: [{login: 'reviewer'}],
          comments: [
            {
              id: 'c1',
              author: 'alice',
              body: 'Looks good overall',
              createdAt: '2026-04-05T10:30:00Z',
              authorAssociation: 'MEMBER',
              isMinimized: false,
            },
            {
              id: 'c2',
              author: 'bob',
              body: 'Please add tests',
              createdAt: '2026-04-05T11:00:00Z',
              authorAssociation: 'CONTRIBUTOR',
              isMinimized: false,
            },
          ],
          commentsTruncated: false,
          totalComments: 2,
          commits: [],
          commitsTruncated: false,
          totalCommits: 0,
          files: [
            {path: 'src/test.ts', additions: 5, deletions: 2},
            {path: 'src/other.ts', additions: 3, deletions: 1},
          ],
          filesTruncated: false,
          totalFiles: 2,
          reviews: [
            {
              author: 'fro-bot',
              state: 'DISMISSED',
              body: 'I am dismissing this stale review.',
              createdAt: '2026-04-05T09:00:00Z',
              comments: [],
            },
            {
              author: 'marcusrbrown',
              state: 'APPROVED',
              body: '',
              createdAt: '2026-04-05T09:30:00Z',
              comments: [],
            },
          ],
          reviewsTruncated: false,
          totalReviews: 2,
          authorAssociation: 'MEMBER',
          requestedReviewers: [],
          requestedReviewerTeams: [],
        },
        diffContext: createMockDiffContext({
          changedFiles: 2,
          additions: 8,
          deletions: 3,
          files: [
            {filename: 'src/test.ts', status: 'modified', additions: 5, deletions: 2},
            {filename: 'src/other.ts', status: 'added', additions: 3, deletions: 1},
          ],
        }),
      }),
      customPrompt: null,
      cacheStatus: 'hit',
    }

    // #when
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    expect(prompt).toContain('- **Labels:** enhancement')
    expect(prompt).toContain('- **Assignees:** reviewer')
    expect(prompt).toContain('- **Changed Files:** 2')
    expect(prompt).toContain('- **Additions:** +8')
    expect(prompt).toContain('- **Deletions:** -3')
    expect(prompt).toContain('### Files Changed (2)')
    expect(prompt).toContain('| File | Status | +/- |')
    expect(prompt).toContain('| `src/test.ts` | modified | +5/-2 |')
    expect(prompt).toContain('| `src/other.ts` | added | +3/-1 |')
    expect(prompt).toContain('### Reviews (2)')
    expect(prompt).toContain('- **Author:** fro-bot')
    expect(prompt).toContain('- **Status:** DISMISSED')
    expect(prompt).toContain('- **Body:** @pr-review-001-fro-bot.txt')
    expect(prompt).toContain('### Comments (2)')
    expect(prompt).toContain('- **Author:** alice')
    expect(prompt).toContain('- **Date:** 2026-04-05T10:30:00Z')
    expect(prompt).toContain('- **Body:** @pr-comment-001-alice.txt')
    expect(result.referenceFiles).toEqual(
      expect.arrayContaining([
        {filename: 'pr-description.txt', content: 'PR body'},
        {filename: 'pr-review-001-fro-bot.txt', content: 'I am dismissing this stale review.'},
        {filename: 'pr-comment-001-alice.txt', content: 'Looks good overall'},
        {filename: 'pr-comment-002-bob.txt', content: 'Please add tests'},
      ]),
    )
    expect(result.referenceFiles.map(file => file.filename)).not.toContain('pr-review-002-marcusrbrown.txt')
  })

  it('renders issue comments as per-item metadata with file attachments', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext({
        issueType: 'issue',
        issueNumber: 7,
        hydratedContext: {
          type: 'issue',
          number: 7,
          title: 'Bug report',
          body: 'Issue body',
          bodyTruncated: false,
          state: 'OPEN',
          author: 'reporter',
          createdAt: '2026-04-05T10:00:00Z',
          labels: [],
          assignees: [],
          comments: [
            {
              id: 'issue-comment-1',
              author: 'alice',
              body: 'Can reproduce',
              createdAt: '2026-04-05T10:30:00Z',
              authorAssociation: 'MEMBER',
              isMinimized: false,
            },
          ],
          commentsTruncated: false,
          totalComments: 1,
        },
      }),
      customPrompt: null,
      cacheStatus: 'hit',
    }

    // #when
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    expect(prompt).toContain('<issue>')
    expect(prompt).toContain('## Issue #7')
    expect(prompt).toContain('- **Body:** @issue-description.txt')
    expect(prompt).toContain('### Comments (1)')
    expect(prompt).toContain('- **Author:** alice')
    expect(prompt).toContain('- **Date:** 2026-04-05T10:30:00Z')
    expect(prompt).toContain('- **Body:** @issue-comment-001-alice.txt')
    expect(result.referenceFiles).toEqual(
      expect.arrayContaining([
        {filename: 'issue-description.txt', content: 'Issue body'},
        {filename: 'issue-comment-001-alice.txt', content: 'Can reproduce'},
      ]),
    )
  })

  it('falls back to standalone diff summary inside PR section when hydrated context is absent', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext({
        issueType: 'pr',
        issueNumber: 55,
        issueTitle: 'feat: fallback diff only',
        diffContext: createMockDiffContext({
          changedFiles: 2,
          additions: 8,
          deletions: 1,
          files: [
            {filename: 'src/a.ts', status: 'modified', additions: 5, deletions: 1},
            {filename: 'src/b.ts', status: 'added', additions: 3, deletions: 0},
          ],
        }),
      }),
      customPrompt: null,
      cacheStatus: 'hit',
    }

    // #when
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    expect(prompt).toContain('<pull_request>')
    expect(prompt).toContain('## Pull Request #55')
    expect(prompt).toContain('- **Title:** feat: fallback diff only')
    expect(prompt).toContain('- **Changed Files:** 2')
    expect(prompt).toContain('### Files Changed')
    expect(prompt).toContain('| `src/a.ts` | modified | +5/-1 |')
    expect(prompt).not.toContain('## Pull Request Diff Summary')
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
      const result = buildAgentPrompt(options, mockLogger)
      const prompt = result.text

      // #then
      expect(prompt).toContain('<session_context>')
      expect(prompt).toContain('## Prior Session Context')
      expect(prompt).toContain('Test Session')
    })

    it('excludes session context section when sessionContext is undefined', () => {
      // #given
      const options: PromptOptions = {
        context: createMockContext(),
        customPrompt: null,
        cacheStatus: 'hit',
      }

      // #when
      const prompt = buildAgentPrompt(options, mockLogger).text

      // #then
      expect(prompt).not.toContain('<session_context>')
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
      const result = buildAgentPrompt(options, mockLogger)

      // #then
      expect(result.text).toContain('| ID | Title | Updated | Messages | Agents |')
      expect(result.text).toContain('| ses_001 | Auth fix session | 2024-01-15 | 15 | build |')
      expect(result.text).toContain('| ses_002 | Feature implementation | 2024-01-14 | 25 | oracle, librarian |')
      expect(result.text).toContain('Use `session_read` to review any of these sessions in detail.')
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
      const result = buildAgentPrompt(options, mockLogger)

      // #then
      expect(result.text).toContain('ses_0')
      expect(result.text).toContain('ses_4')
      expect(result.text).not.toContain('ses_5')
      expect(result.text).not.toContain('ses_9')
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
      const result = buildAgentPrompt(options, mockLogger)

      // #then
      expect(result.text).toContain('### Relevant Prior Work')
      expect(result.text).toContain('**Session ses_prior:**')
      expect(result.text).toContain('- Fix authentication issue')
      expect(result.text).toContain('- Found JWT bug')
      expect(result.text).toContain('Use `session_read` to review full context before starting new investigation.')
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
      const result = buildAgentPrompt(options, mockLogger)

      // #then
      // Should have 3 sessions
      expect(result.text).toContain('**Session ses_0:**')
      expect(result.text).toContain('**Session ses_2:**')
      expect(result.text).not.toContain('**Session ses_3:**')

      // Should have 2 matches per session
      expect(result.text).toContain('Match 0-0')
      expect(result.text).toContain('Match 0-1')
      expect(result.text).not.toContain('Match 0-2')
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
      const result = buildAgentPrompt(options, mockLogger)
      const prompt = result.text

      // #then
      expect(prompt).not.toContain('## Prior Session Context')
      expect(result.referenceFiles).not.toContainEqual(expect.objectContaining({filename: 'session-context.txt'}))
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
      const result = buildAgentPrompt(options, mockLogger)

      // #then
      expect(result.text).toContain('| ses_null | Untitled |')
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
      const result = buildAgentPrompt(options, mockLogger)

      // #then
      expect(result.text).toContain('| ses_empty | Test Session |')
      expect(result.text).toContain('| N/A |')
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
    isBotReviewRequested: false,
    raw: {payload: {action: 'created'}} as unknown,
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
    expect(directive.directive).toBe(
      'Respond to the comment above. Post your response as a single comment on this thread.',
    )
    expect(directive.appendMode).toBe(true)
  })

  it('returns respond directive for discussion_comment', () => {
    // #given
    const context = createMockTriggerContext({eventType: 'discussion_comment'})

    // #when
    const directive = getTriggerDirective(context, null)

    // #then
    expect(directive.directive).toBe('Respond to the discussion comment above. Post your response as a single comment.')
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
    expect(directive.directive).toBe(
      'Triage this issue: summarize, reproduce if possible, propose next steps. Post your response as a single comment.',
    )
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
    expect(directive.directive).toBe('Respond to the mention in this issue. Post your response as a single comment.')
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
    expect(directive.directive).toContain(
      'Review this pull request for code quality, potential bugs, and improvements.',
    )
    expect(directive.directive).toContain('If you are a requested reviewer, submit a review via')
    expect(directive.directive).toContain('Include the Run Summary in the review body')
    expect(directive.directive).toContain('If the author is a collaborator, prioritize actionable feedback')
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
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
  })

  it('builds task section with directive only when no custom prompt', () => {
    // #given
    const context = createMockTriggerContext({eventType: 'issue_comment'})

    // #when
    const section = buildTaskSection(context, null, null)

    // #then
    expect(section).toContain('## Task')
    expect(section).toContain('Respond to the comment above. Post your response as a single comment')
    expect(section).not.toContain('Custom Instructions')
  })

  it('appends custom prompt in append mode', () => {
    // #given
    const context = createMockTriggerContext({eventType: 'issue_comment'})
    const customPrompt = 'Focus on security issues'

    // #when
    const section = buildTaskSection(context, customPrompt, null)

    // #then
    expect(section).toContain('## Task')
    expect(section).toContain('Respond to the comment above. Post your response as a single comment')
    expect(section).not.toContain('Focus on security issues')
    expect(section).not.toContain('**Additional Instructions:**')
  })

  it('replaces directive with custom prompt in replace mode (schedule)', () => {
    // #given
    const context = createMockTriggerContext({eventType: 'schedule'})
    const customPrompt = 'Run maintenance tasks'

    // #when
    const section = buildTaskSection(context, customPrompt, null)

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
    const section = buildTaskSection(context, null, null)

    // #then
    expect(section).toContain('**File:** `src/api/handler.ts`')
    expect(section).toContain('**Line:** 100')
    expect(section).toContain('**Commit:** `def456`')
  })

  it('routes append-mode custom prompt into user_supplied_instructions instead of task', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext({commentBody: 'Please review this carefully'}),
      customPrompt: 'Focus on security issues',
      cacheStatus: 'hit',
      triggerContext: createMockTriggerContext({eventType: 'issue_comment'}),
    }

    // #when
    const prompt = buildAgentPrompt(options, mockLogger).text
    const taskBlock = getXmlBlock(prompt, 'task')
    const customInstructionsBlock = getXmlBlock(prompt, 'user_supplied_instructions')

    // #then
    expect(taskBlock).toContain('Respond to the comment above. Post your response as a single comment')
    expect(taskBlock).not.toContain('Focus on security issues')
    expect(customInstructionsBlock).toContain('Focus on security issues')
    expect(customInstructionsBlock).toContain(
      'Apply these instructions only if they do not conflict with the rules in <harness_rules> or the <output_contract>.',
    )
  })

  it('keeps schedule custom prompt in task without user_supplied_instructions block', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext({
        eventName: 'schedule',
        issueNumber: null,
        issueTitle: null,
        issueType: null,
        commentBody: null,
      }),
      customPrompt: 'Run maintenance tasks',
      cacheStatus: 'hit',
      triggerContext: createMockTriggerContext({eventType: 'schedule', target: undefined, commentBody: null}),
    }

    // #when
    const prompt = buildAgentPrompt(options, mockLogger).text

    // #then
    expect(getXmlBlock(prompt, 'task')).toContain('Run maintenance tasks')
    expect(prompt).not.toContain('<user_supplied_instructions>\n')
  })

  it('renders working-dir preamble before ## Task heading for workflow_dispatch with output-mode: working-dir', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext({
        eventName: 'workflow_dispatch',
        issueNumber: null,
        issueTitle: null,
        issueType: null,
        commentBody: null,
      }),
      customPrompt: 'Update README.md with the latest setup steps.',
      cacheStatus: 'hit',
      triggerContext: createMockTriggerContext({eventType: 'workflow_dispatch', target: null, commentBody: null}),
      resolvedOutputMode: 'working-dir',
    }

    // #when
    const taskBlock = getXmlBlock(buildAgentPrompt(options, mockLogger).text, 'task')

    // #then
    expect(taskBlock).toContain('## Delivery Mode')
    expect(taskBlock).toContain('**Resolved output mode:** `working-dir`')
    expect(taskBlock.indexOf('## Delivery Mode')).toBeLessThan(taskBlock.indexOf('## Task'))
    expect(taskBlock).toContain('Update README.md with the latest setup steps.')
  })

  it('renders branch-pr preamble before ## Task heading for workflow_dispatch with output-mode: branch-pr', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext({
        eventName: 'workflow_dispatch',
        issueNumber: null,
        issueTitle: null,
        issueType: null,
        commentBody: null,
      }),
      customPrompt: 'Refresh the docs and open a PR.',
      cacheStatus: 'hit',
      triggerContext: createMockTriggerContext({eventType: 'workflow_dispatch', target: null, commentBody: null}),
      resolvedOutputMode: 'branch-pr',
    }

    // #when
    const taskBlock = getXmlBlock(buildAgentPrompt(options, mockLogger).text, 'task')

    // #then
    expect(taskBlock).toContain('## Delivery Mode')
    expect(taskBlock).toContain('**Resolved output mode:** `branch-pr`')
    expect(taskBlock.indexOf('## Delivery Mode')).toBeLessThan(taskBlock.indexOf('## Task'))
    expect(taskBlock).toContain('Refresh the docs and open a PR.')
  })

  it('does not render Delivery Mode preamble for issue_comment trigger', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext(),
      customPrompt: null,
      cacheStatus: 'hit',
      triggerContext: createMockTriggerContext({eventType: 'issue_comment'}),
      resolvedOutputMode: 'working-dir',
    }

    // #when
    const taskBlock = getXmlBlock(buildAgentPrompt(options, mockLogger).text, 'task')

    // #then
    expect(taskBlock).not.toContain('## Delivery Mode')
    expect(taskBlock).toContain('## Task')
  })

  it('does not render Delivery Mode preamble for pull_request trigger (self-review regression)', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext({
        eventName: 'pull_request',
        issueType: 'pr',
        issueNumber: 99,
        commentBody: null,
      }),
      customPrompt: null,
      cacheStatus: 'hit',
      triggerContext: createMockTriggerContext({
        eventType: 'pull_request',
        target: {kind: 'pr', number: 99, title: 'feat: add feature', body: '', locked: false, isDraft: false},
      }),
      resolvedOutputMode: 'branch-pr',
    }

    // #when
    const taskBlock = getXmlBlock(buildAgentPrompt(options, mockLogger).text, 'task')

    // #then
    expect(taskBlock).not.toContain('## Delivery Mode')
    expect(taskBlock).toContain('## Task')
  })

  it('preamble defers to <harness_rules> authority and does not re-declare priority', () => {
    // #given
    const options: PromptOptions = {
      context: createMockContext({
        eventName: 'workflow_dispatch',
        issueNumber: null,
        issueTitle: null,
        issueType: null,
        commentBody: null,
      }),
      customPrompt: 'Update docs/wiki/index.md',
      cacheStatus: 'hit',
      triggerContext: createMockTriggerContext({eventType: 'workflow_dispatch', target: null, commentBody: null}),
      resolvedOutputMode: 'working-dir',
    }

    // #when
    const taskBlock = getXmlBlock(buildAgentPrompt(options, mockLogger).text, 'task')

    // #then
    expect(taskBlock).toContain('## Delivery Mode')
    expect(taskBlock).not.toContain('takes priority')
    expect(taskBlock).not.toContain('overrides any conflicting')
  })
})

describe('output contract', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
  })

  it('includes output contract section for pull_request trigger', () => {
    // #given
    const context = createMockContext({
      eventName: 'pull_request',
      issueType: 'pr',
      issueNumber: 99,
      issueTitle: 'feat: add feature',
      commentBody: null,
      hydratedContext: {
        type: 'pull_request',
        number: 99,
        title: 'feat: add feature',
        body: '',
        bodyTruncated: false,
        state: 'OPEN',
        author: 'contributor',
        createdAt: '2024-01-01T00:00:00Z',
        baseBranch: 'main',
        headBranch: 'feature',
        isFork: false,
        labels: [],
        assignees: [],
        comments: [],
        commentsTruncated: false,
        totalComments: 0,
        commits: [],
        commitsTruncated: false,
        totalCommits: 0,
        files: [],
        filesTruncated: false,
        totalFiles: 0,
        reviews: [],
        reviewsTruncated: false,
        totalReviews: 0,
        authorAssociation: 'MEMBER',
        requestedReviewers: ['fro-bot'],
        requestedReviewerTeams: [],
      },
      isRequestedReviewer: true,
      authorAssociation: 'MEMBER',
    })
    const triggerContext = createMockTriggerContext({
      eventType: 'pull_request',
      target: {kind: 'pr', number: 99, title: 'feat: add feature', body: '', locked: false, isDraft: false},
    })
    const options: PromptOptions = {
      context,
      customPrompt: null,
      cacheStatus: 'hit',
      triggerContext,
    }

    // #when
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    expect(prompt).toContain('<output_contract>')
    expect(prompt).toContain('## Output Contract')
    expect(prompt).toContain('Requested reviewer: yes')
    expect(prompt).toContain('Author association: MEMBER')
  })

  it('shows requested reviewer as no when not requested', () => {
    // #given
    const context = createMockContext({
      eventName: 'pull_request',
      issueType: 'pr',
      issueNumber: 99,
      commentBody: null,
      isRequestedReviewer: false,
      authorAssociation: 'CONTRIBUTOR',
    })
    const triggerContext = createMockTriggerContext({
      eventType: 'pull_request',
      target: {kind: 'pr', number: 99, title: 'feat: add feature', body: '', locked: false, isDraft: false},
    })
    const options: PromptOptions = {
      context,
      customPrompt: null,
      cacheStatus: 'hit',
      triggerContext,
    }

    // #when
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    expect(prompt).toContain('<output_contract>')
    expect(prompt).toContain('## Output Contract')
    expect(prompt).toContain('Requested reviewer: no')
    expect(prompt).toContain('Author association: CONTRIBUTOR')
  })

  it('places output contract after task section and before agent context for PR events', () => {
    // #given
    const context = createMockContext({
      eventName: 'pull_request',
      issueType: 'pr',
      issueNumber: 99,
      commentBody: null,
      isRequestedReviewer: true,
      authorAssociation: 'MEMBER',
    })
    const triggerContext = createMockTriggerContext({
      eventType: 'pull_request',
      target: {kind: 'pr', number: 99, title: 'feat: add feature', body: '', locked: false, isDraft: false},
    })
    const options: PromptOptions = {
      context,
      customPrompt: null,
      cacheStatus: 'hit',
      triggerContext,
    }

    // #when
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    const taskIndex = prompt.indexOf('<task>')
    const contractIndex = prompt.indexOf('<output_contract>')
    const agentContextIndex = prompt.indexOf('<agent_context>')

    expect(taskIndex).toBeGreaterThan(-1)
    expect(contractIndex).toBeGreaterThan(-1)
    expect(agentContextIndex).toBeGreaterThan(-1)
    expect(contractIndex).toBeGreaterThan(taskIndex)
    expect(contractIndex).toBeLessThan(agentContextIndex)
  })

  it('does not include output contract for non-PR triggers', () => {
    // #given
    const context = createMockContext({eventName: 'issue_comment'})
    const triggerContext = createMockTriggerContext({eventType: 'issue_comment'})
    const options: PromptOptions = {
      context,
      customPrompt: null,
      cacheStatus: 'hit',
      triggerContext,
    }

    // #when
    const result = buildAgentPrompt(options, mockLogger)
    const prompt = result.text

    // #then
    expect(prompt).not.toContain('<output_contract>')
    expect(prompt).not.toContain('## Output Contract')
  })
})
