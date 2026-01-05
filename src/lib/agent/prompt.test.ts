import type {Logger} from '../logger.js'
import type {AgentContext, PromptOptions} from './types.js'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {buildAgentPrompt} from './prompt.js'

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
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
    expect(prompt).toContain('## Custom Instructions')
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
})
