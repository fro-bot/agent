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

  it('returns minor for bang marker (project stays 0.x: breaking means minor, not major)', () => {
    // #given
    const messages = ['feat!: breaking']

    // #when
    const result = analyzeReleaseType(messages)

    // #then
    expect(result).toBe('minor')
  })

  it('returns minor for BREAKING CHANGE footer (project stays 0.x: breaking means minor, not major)', () => {
    // #given
    const messages = ['fix: one\n\nBREAKING CHANGE: details']

    // #when
    const result = analyzeReleaseType(messages)

    // #then
    expect(result).toBe('minor')
  })

  it('returns minor for a breaking build(deps) commit', () => {
    // #given
    const messages = ['build(deps)!: bump breaking dep\n\nBREAKING CHANGE: dep breaks']

    // #when
    const result = analyzeReleaseType(messages)

    // #then
    expect(result).toBe('minor')
  })

  it('returns minor for a breaking docs(readme) commit', () => {
    // #given
    const messages = ['docs(readme)!: breaking readme change\n\nBREAKING CHANGE: readme breaks']

    // #when
    const result = analyzeReleaseType(messages)

    // #then
    expect(result).toBe('minor')
  })

  it('returns none for a breaking build(dev) commit (explicit suppression outranks the breaking marker)', () => {
    // #given
    const messages = ['build(dev)!: breaking dev tooling\n\nBREAKING CHANGE: dev breaks']

    // #when
    const result = analyzeReleaseType(messages)

    // #then
    expect(result).toBe('none')
  })

  it('returns none for a breaking skip commit (explicit suppression outranks the breaking marker)', () => {
    // #given
    const messages = ['skip!: breaking skip\n\nBREAKING CHANGE: skip breaks']

    // #when
    const result = analyzeReleaseType(messages)

    // #then
    expect(result).toBe('none')
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

  it("bumps to 1.0.0 for computeNextVersion('0.30.10', 'major') as ordinary semver arithmetic", () => {
    // #given: resolveReleaseTypeForParsedCommit never selects 'major' for a 0.x breaking commit
    // (see analyzeReleaseType tests above) -- this only exercises computeNextVersion's own
    // arithmetic for a 'major' input directly, matching the real semver increment.
    // #when
    const result = computeNextVersion('0.30.10', 'major')

    // #then
    expect(result).toBe('1.0.0')
  })

  it("still bumps a real major for computeNextVersion('1.2.3', 'major') once past 0.x", () => {
    // #given / #when
    const result = computeNextVersion('1.2.3', 'major')

    // #then
    expect(result).toBe('2.0.0')
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
