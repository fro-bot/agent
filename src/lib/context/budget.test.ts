import type {ContextBudget, IssueContext, PullRequestContext} from './types.js'
import {describe, expect, it} from 'vitest'
import {
  DEFAULT_CONTEXT_BUDGET,
  estimateContextSize,
  exceedsBudget,
  formatContextForPrompt,
  truncateBody,
} from './budget.js'

describe('truncateBody', () => {
  it('returns original text when under limit', () => {
    // #given
    const text = 'Short text'
    const maxBytes = 100

    // #when
    const result = truncateBody(text, maxBytes)

    // #then
    expect(result.text).toBe('Short text')
    expect(result.truncated).toBe(false)
  })

  it('truncates text exceeding limit with suffix', () => {
    // #given
    const text = 'This is a longer text that should be truncated'
    const maxBytes = 20

    // #when
    const result = truncateBody(text, maxBytes)

    // #then
    expect(result.text.length).toBeLessThanOrEqual(maxBytes)
    expect(result.text).toContain('…[truncated]')
    expect(result.truncated).toBe(true)
  })

  it('handles empty string', () => {
    // #given
    const text = ''
    const maxBytes = 100

    // #when
    const result = truncateBody(text, maxBytes)

    // #then
    expect(result.text).toBe('')
    expect(result.truncated).toBe(false)
  })

  it('handles multi-byte characters safely', () => {
    // #given - Japanese text with multi-byte characters
    const text = 'こんにちは世界' // "Hello World" in Japanese
    const maxBytes = 10

    // #when
    const result = truncateBody(text, maxBytes)

    // #then - should not break in middle of character
    expect(result.truncated).toBe(true)
    // Verify the result is valid UTF-8 by checking it doesn't throw
    expect(() => new TextEncoder().encode(result.text)).not.toThrow()
  })
})

describe('estimateContextSize', () => {
  it('calculates size for issue context', () => {
    // #given
    const context: IssueContext = {
      type: 'issue',
      number: 123,
      title: 'Test Issue',
      body: 'This is the body',
      bodyTruncated: false,
      state: 'open',
      author: 'testuser',
      createdAt: '2024-01-01T00:00:00Z',
      labels: [{name: 'bug'}],
      assignees: [{login: 'dev1'}],
      comments: [
        {
          id: 'comment-1',
          author: 'user1',
          body: 'Comment text',
          createdAt: '2024-01-01T00:00:00Z',
          authorAssociation: 'MEMBER',
          isMinimized: false,
        },
      ],
      commentsTruncated: false,
      totalComments: 1,
    }

    // #when
    const size = estimateContextSize(context)

    // #then
    expect(size).toBeGreaterThan(0)
    expect(typeof size).toBe('number')
  })

  it('calculates size for pull request context', () => {
    // #given
    const context: PullRequestContext = {
      type: 'pull_request',
      number: 456,
      title: 'Test PR',
      body: 'PR body',
      bodyTruncated: false,
      state: 'open',
      author: 'prauthor',
      createdAt: '2024-01-01T00:00:00Z',
      baseBranch: 'main',
      headBranch: 'feature',
      isFork: false,
      labels: [],
      assignees: [],
      comments: [],
      commentsTruncated: false,
      totalComments: 0,
      commits: [{oid: 'abc123', message: 'Initial commit', author: 'dev'}],
      commitsTruncated: false,
      totalCommits: 1,
      files: [{path: 'src/test.ts', additions: 10, deletions: 5}],
      filesTruncated: false,
      totalFiles: 1,
      reviews: [],
      reviewsTruncated: false,
      totalReviews: 0,
    }

    // #when
    const size = estimateContextSize(context)

    // #then
    expect(size).toBeGreaterThan(0)
  })
})

describe('exceedsBudget', () => {
  it('returns false when under budget', () => {
    // #given
    const context: IssueContext = {
      type: 'issue',
      number: 1,
      title: 'Small',
      body: 'Small body',
      bodyTruncated: false,
      state: 'open',
      author: 'user',
      createdAt: '2024-01-01T00:00:00Z',
      labels: [],
      assignees: [],
      comments: [],
      commentsTruncated: false,
      totalComments: 0,
    }
    const budget: ContextBudget = DEFAULT_CONTEXT_BUDGET

    // #when
    const result = exceedsBudget(context, budget)

    // #then
    expect(result).toBe(false)
  })

  it('returns true when exceeding maxTotalBytes', () => {
    // #given
    const largeBody = 'x'.repeat(200 * 1024) // 200KB
    const context: IssueContext = {
      type: 'issue',
      number: 1,
      title: 'Large',
      body: largeBody,
      bodyTruncated: false,
      state: 'open',
      author: 'user',
      createdAt: '2024-01-01T00:00:00Z',
      labels: [],
      assignees: [],
      comments: [],
      commentsTruncated: false,
      totalComments: 0,
    }
    const budget: ContextBudget = {...DEFAULT_CONTEXT_BUDGET, maxTotalBytes: 100 * 1024}

    // #when
    const result = exceedsBudget(context, budget)

    // #then
    expect(result).toBe(true)
  })
})

describe('formatContextForPrompt', () => {
  it('formats issue context as markdown', () => {
    // #given
    const context: IssueContext = {
      type: 'issue',
      number: 42,
      title: 'Bug Report',
      body: 'Something is broken',
      bodyTruncated: false,
      state: 'open',
      author: 'reporter',
      createdAt: '2024-01-15T10:00:00Z',
      labels: [{name: 'bug'}, {name: 'priority-high'}],
      assignees: [{login: 'developer'}],
      comments: [
        {
          id: 'comment-2',
          author: 'helper',
          body: 'Have you tried restarting?',
          createdAt: '2024-01-15T11:00:00Z',
          authorAssociation: 'CONTRIBUTOR',
          isMinimized: false,
        },
      ],
      commentsTruncated: false,
      totalComments: 1,
    }

    // #when
    const markdown = formatContextForPrompt(context)

    // #then
    expect(markdown).toContain('## Issue #42')
    expect(markdown).toContain('Bug Report')
    expect(markdown).toContain('reporter')
    expect(markdown).toContain('bug')
    expect(markdown).toContain('Something is broken')
    expect(markdown).toContain('helper')
    expect(markdown).toContain('Have you tried restarting?')
  })

  it('formats pull request context as markdown', () => {
    // #given
    const context: PullRequestContext = {
      type: 'pull_request',
      number: 100,
      title: 'Add new feature',
      body: 'This PR adds a cool feature',
      bodyTruncated: false,
      state: 'open',
      author: 'contributor',
      createdAt: '2024-02-01T09:00:00Z',
      baseBranch: 'main',
      headBranch: 'feature/cool-thing',
      isFork: false,
      labels: [{name: 'enhancement'}],
      assignees: [],
      comments: [],
      commentsTruncated: false,
      totalComments: 0,
      commits: [{oid: 'abc1234', message: 'feat: add cool thing', author: 'contributor'}],
      commitsTruncated: false,
      totalCommits: 1,
      files: [{path: 'src/cool.ts', additions: 50, deletions: 10}],
      filesTruncated: false,
      totalFiles: 1,
      reviews: [
        {
          author: 'reviewer',
          state: 'APPROVED',
          body: 'LGTM!',
          createdAt: '2024-02-01T10:00:00Z',
          comments: [],
        },
      ],
      reviewsTruncated: false,
      totalReviews: 1,
    }

    // #when
    const markdown = formatContextForPrompt(context)

    // #then
    expect(markdown).toContain('## Pull Request #100')
    expect(markdown).toContain('Add new feature')
    expect(markdown).toContain('main')
    expect(markdown).toContain('feature/cool-thing')
    expect(markdown).toContain('contributor')
    expect(markdown).toContain('src/cool.ts')
    expect(markdown).toContain('APPROVED')
  })

  it('includes truncation notes when content was truncated', () => {
    // #given
    const context: IssueContext = {
      type: 'issue',
      number: 1,
      title: 'Test',
      body: 'Body text…[truncated]',
      bodyTruncated: true,
      state: 'open',
      author: 'user',
      createdAt: '2024-01-01T00:00:00Z',
      labels: [],
      assignees: [],
      comments: [],
      commentsTruncated: true,
      totalComments: 100,
    }

    // #when
    const markdown = formatContextForPrompt(context)

    // #then
    expect(markdown).toContain('truncated')
  })

  it('indicates fork PR status', () => {
    // #given
    const context: PullRequestContext = {
      type: 'pull_request',
      number: 50,
      title: 'Fork PR',
      body: 'From a fork',
      bodyTruncated: false,
      state: 'open',
      author: 'external',
      createdAt: '2024-01-01T00:00:00Z',
      baseBranch: 'main',
      headBranch: 'patch-1',
      isFork: true,
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
    }

    // #when
    const markdown = formatContextForPrompt(context)

    // #then
    expect(markdown.toLowerCase()).toContain('fork')
  })
})
