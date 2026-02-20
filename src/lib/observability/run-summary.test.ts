import type {CommentSummaryOptions, RunMetrics} from './types.js'
import {describe, expect, it} from 'vitest'
import {BOT_COMMENT_MARKER} from '../github/types.js'
import {
  appendSummaryToComment,
  extractSummaryFromComment,
  formatCacheStatus,
  formatDuration,
  formatTokenUsage,
  generateCommentSummary,
  replaceSummaryInComment,
} from './run-summary.js'

function createMockMetrics(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    startTime: Date.now() - 60000,
    endTime: Date.now(),
    duration: 60000,
    cacheStatus: 'hit',
    sessionsUsed: [],
    sessionsCreated: [],
    prsCreated: [],
    commitsCreated: [],
    commentsPosted: 0,
    tokenUsage: null,
    model: null,
    cost: null,
    errors: [],
    ...overrides,
  }
}

function createMockOptions(overrides: Partial<CommentSummaryOptions> = {}): CommentSummaryOptions {
  return {
    eventType: 'issue_comment',
    repo: 'owner/repo',
    ref: 'main',
    runId: 12345,
    runUrl: 'https://github.com/owner/repo/actions/runs/12345',
    metrics: createMockMetrics(),
    agent: 'sisyphus',
    ...overrides,
  }
}

describe('formatCacheStatus', () => {
  it('formats hit with checkmark', () => {
    expect(formatCacheStatus('hit')).toBe('✅ hit')
  })

  it('formats miss with new indicator', () => {
    expect(formatCacheStatus('miss')).toBe('🆕 miss')
  })

  it('formats corrupted with warning', () => {
    expect(formatCacheStatus('corrupted')).toBe('⚠️ corrupted (clean start)')
  })
})

describe('formatDuration', () => {
  it('formats seconds only for short durations', () => {
    expect(formatDuration(5000)).toBe('5s')
    expect(formatDuration(45000)).toBe('45s')
    expect(formatDuration(59000)).toBe('59s')
  })

  it('formats minutes and seconds for longer durations', () => {
    expect(formatDuration(60000)).toBe('1m 0s')
    expect(formatDuration(90000)).toBe('1m 30s')
    expect(formatDuration(135000)).toBe('2m 15s')
    expect(formatDuration(3600000)).toBe('60m 0s')
  })

  it('rounds to nearest second', () => {
    expect(formatDuration(5499)).toBe('5s')
    expect(formatDuration(5500)).toBe('6s')
  })
})

describe('formatTokenUsage', () => {
  it('includes input and output', () => {
    // #given
    const usage = {input: 1000, output: 500, reasoning: 0, cache: {read: 0, write: 0}}

    // #when
    const result = formatTokenUsage(usage, null)

    // #then
    expect(result).toContain('1,000 in')
    expect(result).toContain('500 out')
    expect(result).toBe('1,000 in / 500 out')
  })

  it('includes model when provided', () => {
    // #given
    const usage = {input: 1000, output: 500, reasoning: 0, cache: {read: 0, write: 0}}

    // #when
    const result = formatTokenUsage(usage, 'gpt-4o')

    // #then
    expect(result).toContain('(gpt-4o)')
    expect(result).toBe('1,000 in / 500 out (gpt-4o)')
  })

  it('includes reasoning tokens when non-zero', () => {
    // #given
    const usage = {input: 1000, output: 500, reasoning: 200, cache: {read: 0, write: 0}}

    // #when
    const result = formatTokenUsage(usage, null)

    // #then
    expect(result).toContain('200 reasoning')
    expect(result).toBe('1,000 in / 500 out / 200 reasoning')
  })

  it('includes cache tokens when non-zero', () => {
    // #given
    const usage = {input: 1000, output: 500, reasoning: 0, cache: {read: 100, write: 50}}

    // #when
    const result = formatTokenUsage(usage, null)

    // #then
    expect(result).toContain('150 cache')
  })

  it('includes all fields when present', () => {
    // #given
    const usage = {input: 1000, output: 500, reasoning: 200, cache: {read: 100, write: 50}}

    // #when
    const result = formatTokenUsage(usage, 'claude-sonnet-4-20250514')

    // #then
    expect(result).toBe('1,000 in / 500 out / 200 reasoning / 150 cache (claude-sonnet-4-20250514)')
  })
})

describe('generateCommentSummary', () => {
  it('includes all required fields', () => {
    // #given
    const options = createMockOptions()

    // #when
    const summary = generateCommentSummary(options)

    // #then
    expect(summary).toContain('issue_comment')
    expect(summary).toContain('owner/repo')
    expect(summary).toContain('main')
    expect(summary).toContain('12345')
    expect(summary).toContain('sisyphus')
    expect(summary).toContain('✅ hit')
  })

  it('includes bot marker for identification', () => {
    // #given
    const options = createMockOptions()

    // #when
    const summary = generateCommentSummary(options)

    // #then
    expect(summary).toContain(BOT_COMMENT_MARKER)
  })

  it('wraps in details block', () => {
    // #given
    const options = createMockOptions()

    // #when
    const summary = generateCommentSummary(options)

    // #then
    expect(summary).toContain('<details>')
    expect(summary).toContain('</details>')
    expect(summary).toContain('<summary>Run Summary</summary>')
  })

  it('includes sessions when present', () => {
    // #given
    const options = createMockOptions({
      metrics: createMockMetrics({
        sessionsUsed: ['ses_prior1', 'ses_prior2'],
        sessionsCreated: ['ses_new'],
      }),
    })

    // #when
    const summary = generateCommentSummary(options)

    // #then
    expect(summary).toContain('Sessions Used')
    expect(summary).toContain('`ses_prior1`')
    expect(summary).toContain('`ses_prior2`')
    expect(summary).toContain('Sessions Created')
    expect(summary).toContain('`ses_new`')
  })

  it('includes token usage and cost when present', () => {
    // #given
    const options = createMockOptions({
      metrics: createMockMetrics({
        tokenUsage: {input: 1000, output: 500, reasoning: 0, cache: {read: 0, write: 0}},
        model: 'claude-sonnet-4-20250514',
        cost: 0.0123,
      }),
    })

    // #when
    const summary = generateCommentSummary(options)

    // #then
    expect(summary).toContain('Tokens')
    expect(summary).toContain('1,000 in')
    expect(summary).toContain('500 out')
    expect(summary).toContain('$0.0123')
  })

  it('includes PRs and commits when created', () => {
    // #given
    const options = createMockOptions({
      metrics: createMockMetrics({
        prsCreated: ['https://github.com/owner/repo/pull/1'],
        commitsCreated: ['abc123def456'],
      }),
    })

    // #when
    const summary = generateCommentSummary(options)

    // #then
    expect(summary).toContain('PRs Created')
    expect(summary).toContain('https://github.com/owner/repo/pull/1')
    expect(summary).toContain('Commits')
    expect(summary).toContain('`abc123d`')
  })

  it('includes comments posted when non-zero', () => {
    // #given
    const options = createMockOptions({
      metrics: createMockMetrics({commentsPosted: 3}),
    })

    // #when
    const summary = generateCommentSummary(options)

    // #then
    expect(summary).toContain('Comments Posted')
    expect(summary).toContain('3')
  })

  it('includes errors when present', () => {
    // #given
    const options = createMockOptions({
      metrics: createMockMetrics({
        errors: [
          {timestamp: '2024-01-01T00:00:00Z', type: 'RateLimit', message: 'API limited', recoverable: true},
          {timestamp: '2024-01-01T00:00:01Z', type: 'NetworkError', message: 'Timeout', recoverable: false},
        ],
      }),
    })

    // #when
    const summary = generateCommentSummary(options)

    // #then
    expect(summary).toContain('Errors')
    expect(summary).toContain('2 (1 recovered)')
  })

  it('omits optional fields when not present', () => {
    // #given
    const options = createMockOptions({
      metrics: createMockMetrics({
        sessionsUsed: [],
        sessionsCreated: [],
        prsCreated: [],
        commitsCreated: [],
        commentsPosted: 0,
        tokenUsage: null,
        cost: null,
        errors: [],
      }),
    })

    // #when
    const summary = generateCommentSummary(options)

    // #then
    expect(summary).not.toContain('Sessions Used')
    expect(summary).not.toContain('Sessions Created')
    expect(summary).not.toContain('PRs Created')
    expect(summary).not.toContain('Commits')
    expect(summary).not.toContain('Comments Posted')
    expect(summary).not.toContain('Tokens')
    expect(summary).not.toContain('Cost')
    expect(summary).not.toContain('Errors')
  })
})

describe('extractSummaryFromComment', () => {
  it('returns null when no marker present', () => {
    // #given
    const body = 'Just a regular comment without any marker'

    // #when
    const result = extractSummaryFromComment(body)

    // #then
    expect(result).toBeNull()
  })

  it('extracts from marker onwards', () => {
    // #given
    const body = `Some content before\n\n---\n\n${BOT_COMMENT_MARKER}\n<details>summary content</details>`

    // #when
    const result = extractSummaryFromComment(body)

    // #then
    expect(result).not.toBeNull()
    expect(result).toContain(BOT_COMMENT_MARKER)
    expect(result).toContain('<details>')
    expect(result).not.toContain('Some content before')
  })

  it('handles marker at start of body', () => {
    // #given
    const body = `${BOT_COMMENT_MARKER}\n<details>summary</details>`

    // #when
    const result = extractSummaryFromComment(body)

    // #then
    expect(result).toBe(body)
  })
})

describe('appendSummaryToComment', () => {
  it('appends summary after separator', () => {
    // #given
    const body = 'Main comment content'
    const options = createMockOptions()

    // #when
    const result = appendSummaryToComment(body, options)

    // #then
    expect(result).toContain('Main comment content')
    expect(result).toContain('\n\n---\n\n')
    expect(result).toContain(BOT_COMMENT_MARKER)
    expect(result).toContain('<details>')
    expect(result.indexOf('Main comment content')).toBeLessThan(result.indexOf('---'))
  })

  it('preserves original body completely', () => {
    // #given
    const body = 'Line 1\nLine 2\n\nParagraph 2'
    const options = createMockOptions()

    // #when
    const result = appendSummaryToComment(body, options)

    // #then
    expect(result.startsWith(body)).toBe(true)
  })
})

describe('replaceSummaryInComment', () => {
  it('appends when no existing summary', () => {
    // #given
    const body = 'Main content without marker'
    const options = createMockOptions()

    // #when
    const result = replaceSummaryInComment(body, options)

    // #then
    expect(result).toContain('Main content without marker')
    expect(result).toContain('---')
    expect(result).toContain(BOT_COMMENT_MARKER)
  })

  it('replaces existing summary', () => {
    // #given
    const oldSummary = `${BOT_COMMENT_MARKER}\n<details><summary>Run Summary</summary>\n\nOLD CONTENT\n\n</details>`
    const body = `Content before\n\n---\n\n${oldSummary}`
    const options = createMockOptions({
      metrics: createMockMetrics({cacheStatus: 'miss'}),
    })

    // #when
    const result = replaceSummaryInComment(body, options)

    // #then
    expect(result).toContain('Content before')
    expect(result).not.toContain('OLD CONTENT')
    expect(result).toContain('🆕 miss')
  })

  it('leaves only one marker after replacement', () => {
    // #given
    const oldSummary = `${BOT_COMMENT_MARKER}\n<details>old</details>`
    const body = `Content\n\n---\n\n${oldSummary}`
    const options = createMockOptions()

    // #when
    const result = replaceSummaryInComment(body, options)

    // #then
    const markerCount = (result.match(new RegExp(BOT_COMMENT_MARKER, 'g')) ?? []).length
    expect(markerCount).toBe(1)
  })

  it('is idempotent', () => {
    // #given
    const body = 'Original content'
    const options = createMockOptions()

    // #when
    const first = replaceSummaryInComment(body, options)
    const second = replaceSummaryInComment(first, options)
    const third = replaceSummaryInComment(second, options)

    // #then
    expect(second).toBe(first)
    expect(third).toBe(first)
  })
})
