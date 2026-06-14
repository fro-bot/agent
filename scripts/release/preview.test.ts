import {describe, expect, it} from 'vitest'
import {analyzeReleaseType, computeNextVersion, filterHarnessTags} from './preview.js'

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

describe('filterHarnessTags', () => {
  it('removes tags containing +harness', () => {
    // #given
    const tags = ['v1.17.3+harness.87250603', 'v0.62.0', 'v0.61.0']

    // #when
    const result = filterHarnessTags(tags)

    // #then
    expect(result).toEqual(['v0.62.0', 'v0.61.0'])
  })

  it('returns the latest clean SemVer tag first when harness tags sort highest', () => {
    // #given — simulates git tag --sort=-version:refname output where +harness sorts above clean tags
    const tags = ['v1.17.3+harness.87250603', 'v0.62.0', 'v0.61.0']

    // #when
    const result = filterHarnessTags(tags)

    // #then — first element is the latest clean tag, not the harness tag
    expect(result[0]).toBe('v0.62.0')
  })

  it('keeps all tags when none contain +harness', () => {
    // #given
    const tags = ['v0.62.0', 'v0.61.0', 'v0.60.0']

    // #when
    const result = filterHarnessTags(tags)

    // #then
    expect(result).toEqual(['v0.62.0', 'v0.61.0', 'v0.60.0'])
  })

  it('returns empty array when all tags are harness tags', () => {
    // #given
    const tags = ['v1.17.3+harness.87250603', 'v1.16.0+harness.aabbccdd']

    // #when
    const result = filterHarnessTags(tags)

    // #then
    expect(result).toEqual([])
  })

  it('returns empty array for empty input', () => {
    // #given
    const tags: readonly string[] = []

    // #when
    const result = filterHarnessTags(tags)

    // #then
    expect(result).toEqual([])
  })
})
