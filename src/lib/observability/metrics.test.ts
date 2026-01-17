import {describe, expect, it} from 'vitest'
import {createMetricsCollector} from './metrics.js'

describe('createMetricsCollector', () => {
  it('starts with default values', () => {
    // #given
    const collector = createMetricsCollector()

    // #when
    const metrics = collector.getMetrics()

    // #then
    expect(metrics.startTime).toBe(0)
    expect(metrics.endTime).toBeNull()
    expect(metrics.cacheStatus).toBe('miss')
    expect(metrics.sessionsUsed).toEqual([])
    expect(metrics.sessionsCreated).toEqual([])
    expect(metrics.prsCreated).toEqual([])
    expect(metrics.commitsCreated).toEqual([])
    expect(metrics.commentsPosted).toBe(0)
    expect(metrics.tokenUsage).toBeNull()
    expect(metrics.model).toBeNull()
    expect(metrics.cost).toBeNull()
    expect(metrics.errors).toEqual([])
  })

  it('records start time', () => {
    // #given
    const collector = createMetricsCollector()
    const before = Date.now()

    // #when
    collector.start()
    const after = Date.now()

    // #then
    const metrics = collector.getMetrics()
    expect(metrics.startTime).toBeGreaterThanOrEqual(before)
    expect(metrics.startTime).toBeLessThanOrEqual(after)
  })

  it('records end time and calculates duration', () => {
    // #given
    const collector = createMetricsCollector()

    // #when
    collector.start()
    collector.end()

    // #then
    const metrics = collector.getMetrics()
    expect(metrics.endTime).not.toBeNull()
    expect(metrics.duration).toBeGreaterThanOrEqual(0)
    expect(metrics.duration).toBe(metrics.endTime! - metrics.startTime)
  })

  it('calculates live duration when not ended', () => {
    // #given
    const collector = createMetricsCollector()

    // #when
    collector.start()
    const metrics = collector.getMetrics()

    // #then
    expect(metrics.endTime).toBeNull()
    expect(metrics.duration).toBeGreaterThanOrEqual(0)
  })

  it('sets cache status', () => {
    // #given
    const collector = createMetricsCollector()

    // #when
    collector.setCacheStatus('hit')

    // #then
    expect(collector.getMetrics().cacheStatus).toBe('hit')

    // #when
    collector.setCacheStatus('corrupted')

    // #then
    expect(collector.getMetrics().cacheStatus).toBe('corrupted')
  })

  it('adds and deduplicates sessions used', () => {
    // #given
    const collector = createMetricsCollector()

    // #when
    collector.addSessionUsed('ses_123')
    collector.addSessionUsed('ses_123')
    collector.addSessionUsed('ses_456')

    // #then
    const metrics = collector.getMetrics()
    expect(metrics.sessionsUsed).toHaveLength(2)
    expect(metrics.sessionsUsed).toContain('ses_123')
    expect(metrics.sessionsUsed).toContain('ses_456')
  })

  it('adds and deduplicates sessions created', () => {
    // #given
    const collector = createMetricsCollector()

    // #when
    collector.addSessionCreated('ses_new1')
    collector.addSessionCreated('ses_new1')
    collector.addSessionCreated('ses_new2')

    // #then
    const metrics = collector.getMetrics()
    expect(metrics.sessionsCreated).toHaveLength(2)
    expect(metrics.sessionsCreated).toContain('ses_new1')
    expect(metrics.sessionsCreated).toContain('ses_new2')
  })

  it('adds and deduplicates PRs created', () => {
    // #given
    const collector = createMetricsCollector()

    // #when
    collector.addPRCreated('https://github.com/owner/repo/pull/1')
    collector.addPRCreated('https://github.com/owner/repo/pull/1')
    collector.addPRCreated('https://github.com/owner/repo/pull/2')

    // #then
    const metrics = collector.getMetrics()
    expect(metrics.prsCreated).toHaveLength(2)
  })

  it('adds and deduplicates commits created', () => {
    // #given
    const collector = createMetricsCollector()

    // #when
    collector.addCommitCreated('abc1234')
    collector.addCommitCreated('abc1234')
    collector.addCommitCreated('def5678')

    // #then
    const metrics = collector.getMetrics()
    expect(metrics.commitsCreated).toHaveLength(2)
    expect(metrics.commitsCreated).toContain('abc1234')
    expect(metrics.commitsCreated).toContain('def5678')
  })

  it('increments comments counter', () => {
    // #given
    const collector = createMetricsCollector()

    // #when
    collector.incrementComments()
    collector.incrementComments()
    collector.incrementComments()

    // #then
    expect(collector.getMetrics().commentsPosted).toBe(3)
  })

  it('stores token usage with model and cost', () => {
    // #given
    const collector = createMetricsCollector()
    const usage = {
      input: 1000,
      output: 500,
      reasoning: 200,
      cache: {read: 100, write: 50},
    }

    // #when
    collector.setTokenUsage(usage, 'claude-sonnet-4-20250514', 0.0123)

    // #then
    const metrics = collector.getMetrics()
    expect(metrics.tokenUsage).toEqual(usage)
    expect(metrics.model).toBe('claude-sonnet-4-20250514')
    expect(metrics.cost).toBe(0.0123)
  })

  it('stores token usage without model and cost', () => {
    // #given
    const collector = createMetricsCollector()
    const usage = {
      input: 500,
      output: 250,
      reasoning: 0,
      cache: {read: 0, write: 0},
    }

    // #when
    collector.setTokenUsage(usage, null, null)

    // #then
    const metrics = collector.getMetrics()
    expect(metrics.tokenUsage).toEqual(usage)
    expect(metrics.model).toBeNull()
    expect(metrics.cost).toBeNull()
  })

  it('records errors with timestamp', () => {
    // #given
    const collector = createMetricsCollector()
    const beforeTime = new Date().toISOString()

    // #when
    collector.recordError('RateLimit', 'API rate limited', true)
    collector.recordError('NetworkError', 'Connection failed', false)

    // #then
    const metrics = collector.getMetrics()
    expect(metrics.errors).toHaveLength(2)

    const firstError = metrics.errors[0]!
    expect(firstError.type).toBe('RateLimit')
    expect(firstError.message).toBe('API rate limited')
    expect(firstError.recoverable).toBe(true)
    expect(firstError.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(firstError.timestamp >= beforeTime).toBe(true)

    const secondError = metrics.errors[1]!
    expect(secondError.type).toBe('NetworkError')
    expect(secondError.recoverable).toBe(false)
  })

  it('returns frozen metrics snapshot', () => {
    // #given
    const collector = createMetricsCollector()
    collector.start()
    collector.addSessionCreated('ses_abc')
    collector.recordError('Test', 'test error', true)

    // #when
    const metrics = collector.getMetrics()

    // #then
    expect(Object.isFrozen(metrics)).toBe(true)
    expect(Object.isFrozen(metrics.sessionsUsed)).toBe(true)
    expect(Object.isFrozen(metrics.sessionsCreated)).toBe(true)
    expect(Object.isFrozen(metrics.prsCreated)).toBe(true)
    expect(Object.isFrozen(metrics.commitsCreated)).toBe(true)
    expect(Object.isFrozen(metrics.errors)).toBe(true)
  })

  it('returns independent snapshots', () => {
    // #given
    const collector = createMetricsCollector()
    collector.addSessionUsed('ses_1')

    // #when
    const snapshot1 = collector.getMetrics()
    collector.addSessionUsed('ses_2')
    const snapshot2 = collector.getMetrics()

    // #then
    expect(snapshot1.sessionsUsed).toHaveLength(1)
    expect(snapshot2.sessionsUsed).toHaveLength(2)
  })
})
