import {describe, expect, it} from 'vitest'
import {analyzeReleaseType, computeNextVersion} from './preview.js'

describe('analyzeReleaseType', () => {
  it('returns patch for fix commit', () => {
    // #given
    const messages = ['fix: something']

    // #when
    const result = analyzeReleaseType(messages)

    // #then
    expect(result).toBe('patch')
  })

  it('returns minor for feat commit', () => {
    // #given
    const messages = ['feat: something']

    // #when
    const result = analyzeReleaseType(messages)

    // #then
    expect(result).toBe('minor')
  })

  it('returns major for bang marker', () => {
    // #given
    const messages = ['feat!: breaking']

    // #when
    const result = analyzeReleaseType(messages)

    // #then
    expect(result).toBe('major')
  })

  it('returns major for BREAKING CHANGE footer', () => {
    // #given
    const messages = ['fix: one\n\nBREAKING CHANGE: details']

    // #when
    const result = analyzeReleaseType(messages)

    // #then
    expect(result).toBe('major')
  })

  it('returns none for chore commits', () => {
    // #given
    const messages = ['chore: something']

    // #when
    const result = analyzeReleaseType(messages)

    // #then
    expect(result).toBe('none')
  })

  it('returns none for ci commits', () => {
    // #given
    const messages = ['ci: something']

    // #when
    const result = analyzeReleaseType(messages)

    // #then
    expect(result).toBe('none')
  })

  it('returns none for build with dev scope', () => {
    // #given
    const messages = ['build(dev): update dep']

    // #when
    const result = analyzeReleaseType(messages)

    // #then
    expect(result).toBe('none')
  })

  it('returns patch for build with non-dev scope', () => {
    // #given
    const messages = ['build(deps): update dep']

    // #when
    const result = analyzeReleaseType(messages)

    // #then
    expect(result).toBe('patch')
  })

  it('returns patch for docs(readme)', () => {
    // #given
    const messages = ['docs(readme): update']

    // #when
    const result = analyzeReleaseType(messages)

    // #then
    expect(result).toBe('patch')
  })

  it('returns none for skip type', () => {
    // #given
    const messages = ['skip: merge main']

    // #when
    const result = analyzeReleaseType(messages)

    // #then
    expect(result).toBe('none')
  })

  it('returns highest release type across messages', () => {
    // #given
    const messages = ['fix: one', 'feat: two']

    // #when
    const result = analyzeReleaseType(messages)

    // #then
    expect(result).toBe('minor')
  })

  it('returns none for empty messages array', () => {
    // #given
    const messages: readonly string[] = []

    // #when
    const result = analyzeReleaseType(messages)

    // #then
    expect(result).toBe('none')
  })
})

describe('computeNextVersion', () => {
  it("bumps patch for computeNextVersion('0.30.10', 'patch')", () => {
    // #given / #when
    const result = computeNextVersion('0.30.10', 'patch')

    // #then
    expect(result).toBe('0.30.11')
  })

  it("bumps minor for computeNextVersion('0.30.10', 'minor')", () => {
    // #given / #when
    const result = computeNextVersion('0.30.10', 'minor')

    // #then
    expect(result).toBe('0.31.0')
  })

  it("bumps major for computeNextVersion('0.30.10', 'major')", () => {
    // #given / #when
    const result = computeNextVersion('0.30.10', 'major')

    // #then
    expect(result).toBe('1.0.0')
  })

  it("returns null for computeNextVersion('0.30.10', 'none')", () => {
    // #given / #when
    const result = computeNextVersion('0.30.10', 'none')

    // #then
    expect(result).toBeNull()
  })
})
