import type {Logger, PromptContext} from './types.js'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {buildAgentPrompt, extractPromptContext} from './prompt.js'

// Mock logger
function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

describe('prompt', () => {
  describe('buildAgentPrompt', () => {
    it('includes repository context', () => {
      // #given
      const context: PromptContext = {
        eventName: 'issue_comment',
        repo: 'owner/repo',
        ref: 'main',
        actor: 'testuser',
        issueNumber: null,
        issueTitle: null,
        commentBody: null,
        prNumber: null,
      }
      const mockLogger = createMockLogger()

      // #when
      const prompt = buildAgentPrompt(context, null, mockLogger)

      // #then
      expect(prompt).toContain('owner/repo')
      expect(prompt).toContain('main')
      expect(prompt).toContain('issue_comment')
      expect(prompt).toContain('testuser')
    })

    it('includes issue/PR context when provided', () => {
      // #given
      const context: PromptContext = {
        eventName: 'issue_comment',
        repo: 'owner/repo',
        ref: 'main',
        actor: 'testuser',
        issueNumber: 123,
        issueTitle: 'Test Issue Title',
        commentBody: null,
        prNumber: null,
      }
      const mockLogger = createMockLogger()

      // #when
      const prompt = buildAgentPrompt(context, null, mockLogger)

      // #then
      expect(prompt).toContain('#123')
      expect(prompt).toContain('Test Issue Title')
    })

    it('includes comment body when provided', () => {
      // #given
      const context: PromptContext = {
        eventName: 'issue_comment',
        repo: 'owner/repo',
        ref: 'main',
        actor: 'testuser',
        issueNumber: 123,
        issueTitle: 'Test Issue',
        commentBody: '@bot please help with this issue',
        prNumber: null,
      }
      const mockLogger = createMockLogger()

      // #when
      const prompt = buildAgentPrompt(context, null, mockLogger)

      // #then
      expect(prompt).toContain('@bot please help with this issue')
      expect(prompt).toContain('Trigger Comment')
    })

    it('includes session management instructions', () => {
      // #given
      const context: PromptContext = {
        eventName: 'issue_comment',
        repo: 'owner/repo',
        ref: 'main',
        actor: 'testuser',
        issueNumber: null,
        issueTitle: null,
        commentBody: null,
        prNumber: null,
      }
      const mockLogger = createMockLogger()

      // #when
      const prompt = buildAgentPrompt(context, null, mockLogger)

      // #then
      expect(prompt).toContain('session_search')
      expect(prompt).toContain('session_read')
      expect(prompt).toContain('Session Management')
    })

    it('includes gh CLI examples', () => {
      // #given
      const context: PromptContext = {
        eventName: 'issue_comment',
        repo: 'owner/repo',
        ref: 'main',
        actor: 'testuser',
        issueNumber: null,
        issueTitle: null,
        commentBody: null,
        prNumber: null,
      }
      const mockLogger = createMockLogger()

      // #when
      const prompt = buildAgentPrompt(context, null, mockLogger)

      // #then
      expect(prompt).toContain('gh issue comment')
      expect(prompt).toContain('gh pr comment')
      expect(prompt).toContain('gh pr create')
      expect(prompt).toContain('gh api')
    })

    it('includes run summary requirement', () => {
      // #given
      const context: PromptContext = {
        eventName: 'issue_comment',
        repo: 'owner/repo',
        ref: 'main',
        actor: 'testuser',
        issueNumber: null,
        issueTitle: null,
        commentBody: null,
        prNumber: null,
      }
      const mockLogger = createMockLogger()

      // #when
      const prompt = buildAgentPrompt(context, null, mockLogger)

      // #then
      expect(prompt).toContain('Run Summary')
      expect(prompt).toContain('<details>')
      expect(prompt).toContain('</details>')
    })

    it('includes custom prompt when provided', () => {
      // #given
      const context: PromptContext = {
        eventName: 'issue_comment',
        repo: 'owner/repo',
        ref: 'main',
        actor: 'testuser',
        issueNumber: null,
        issueTitle: null,
        commentBody: null,
        prNumber: null,
      }
      const customPrompt = 'Always respond in haiku format'
      const mockLogger = createMockLogger()

      // #when
      const prompt = buildAgentPrompt(context, customPrompt, mockLogger)

      // #then
      expect(prompt).toContain('Custom Instructions')
      expect(prompt).toContain('Always respond in haiku format')
    })

    it('does not include custom instructions section when no custom prompt', () => {
      // #given
      const context: PromptContext = {
        eventName: 'issue_comment',
        repo: 'owner/repo',
        ref: 'main',
        actor: 'testuser',
        issueNumber: null,
        issueTitle: null,
        commentBody: null,
        prNumber: null,
      }
      const mockLogger = createMockLogger()

      // #when
      const prompt = buildAgentPrompt(context, null, mockLogger)

      // #then
      expect(prompt).not.toContain('Custom Instructions')
    })

    it('includes task section when comment body present', () => {
      // #given
      const context: PromptContext = {
        eventName: 'issue_comment',
        repo: 'owner/repo',
        ref: 'main',
        actor: 'testuser',
        issueNumber: 123,
        issueTitle: 'Test Issue',
        commentBody: '@bot help',
        prNumber: null,
      }
      const mockLogger = createMockLogger()

      // #when
      const prompt = buildAgentPrompt(context, null, mockLogger)

      // #then
      expect(prompt).toContain('## Task')
      expect(prompt).toContain('Respond to the trigger comment')
    })

    it('logs prompt length', () => {
      // #given
      const context: PromptContext = {
        eventName: 'push',
        repo: 'owner/repo',
        ref: 'main',
        actor: 'testuser',
        issueNumber: null,
        issueTitle: null,
        commentBody: null,
        prNumber: null,
      }
      const mockLogger = createMockLogger()

      // #when
      buildAgentPrompt(context, null, mockLogger)

      // #then
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Built agent prompt',
        expect.objectContaining({length: expect.any(Number) as number}),
      )
    })
  })

  describe('extractPromptContext', () => {
    const originalEnv = process.env

    beforeEach(() => {
      process.env = {...originalEnv}
    })

    afterEach(() => {
      process.env = originalEnv
    })

    it('extracts context from environment variables', () => {
      // #given
      process.env.GITHUB_EVENT_NAME = 'issue_comment'
      process.env.GITHUB_REPOSITORY = 'owner/repo'
      process.env.GITHUB_REF_NAME = 'feature-branch'
      process.env.GITHUB_ACTOR = 'testactor'

      // #when
      const context = extractPromptContext()

      // #then
      expect(context.eventName).toBe('issue_comment')
      expect(context.repo).toBe('owner/repo')
      expect(context.ref).toBe('feature-branch')
      expect(context.actor).toBe('testactor')
    })

    it('provides defaults when environment variables missing', () => {
      // #given
      delete process.env.GITHUB_EVENT_NAME
      delete process.env.GITHUB_REPOSITORY
      delete process.env.GITHUB_REF_NAME
      delete process.env.GITHUB_ACTOR

      // #when
      const context = extractPromptContext()

      // #then
      expect(context.eventName).toBe('unknown')
      expect(context.repo).toBe('unknown/unknown')
      expect(context.ref).toBe('main')
      expect(context.actor).toBe('unknown')
    })

    it('returns null for optional context fields', () => {
      // #when
      const context = extractPromptContext()

      // #then
      expect(context.issueNumber).toBeNull()
      expect(context.issueTitle).toBeNull()
      expect(context.commentBody).toBeNull()
      expect(context.prNumber).toBeNull()
    })
  })
})
