import {describe, expect, it} from 'vitest'
import {buildHarnessNpmVersion, buildHarnessReleaseTag, buildHarnessVersion} from './version.js'

// ---------------------------------------------------------------------------
// buildHarnessVersion
// ---------------------------------------------------------------------------

describe('buildHarnessVersion', () => {
  it('normal base + commit → <baseVersion>+harness.<shortSha>', () => {
    // #given / #when
    const result = buildHarnessVersion('1.15.13', 'cafebabe12345678')

    // #then
    expect(result).toBe('1.15.13+harness.cafebabe')
  })

  it('short sha is exactly the first 8 chars of a 40-char sha', () => {
    // #given
    const fullSha = 'abcdef1234567890abcdef1234567890abcdef12'

    // #when
    const result = buildHarnessVersion('1.15.13', fullSha)

    // #then
    expect(result).toBe('1.15.13+harness.abcdef12')
    expect(result.split('+harness.')[1]).toBe(fullSha.slice(0, 8))
  })

  it('commit shorter than 8 chars → uses the full (short) commit as-is', () => {
    // #given — a commit shorter than 8 chars (e.g. a dev stub)
    const shortCommit = 'abc'

    // #when
    const result = buildHarnessVersion('1.15.13', shortCommit)

    // #then — slice(0, 8) on a 3-char string returns the full string
    expect(result).toBe('1.15.13+harness.abc')
  })
})

// ---------------------------------------------------------------------------
// buildHarnessNpmVersion
// ---------------------------------------------------------------------------

describe('buildHarnessNpmVersion', () => {
  it('exact output for known base + commit → <baseVersion>-harness.<shortSha>', () => {
    // #given / #when
    const result = buildHarnessNpmVersion('1.17.3', 'ed359558abcdef1234567890abcdef1234567890')

    // #then
    expect(result).toBe('1.17.3-harness.ed359558')
  })

  it('full 40-char SHA truncates to first 8 chars', () => {
    // #given
    const fullSha = 'abcdef1234567890abcdef1234567890abcdef12'

    // #when
    const result = buildHarnessNpmVersion('1.17.3', fullSha)

    // #then
    expect(result).toBe('1.17.3-harness.abcdef12')
    expect(result.split('-harness.')[1]).toBe(fullSha.slice(0, 8))
  })

  it('8-char commit is used unchanged', () => {
    // #given
    const shortCommit = 'ed359558'

    // #when
    const result = buildHarnessNpmVersion('1.17.3', shortCommit)

    // #then
    expect(result).toBe('1.17.3-harness.ed359558')
  })

  it('uses hyphen separator (not plus) to produce a valid npm prerelease', () => {
    // #given / #when
    const result = buildHarnessNpmVersion('1.17.3', 'ed359558abcdef12')

    // #then — npm prerelease uses hyphen, NOT plus (build metadata)
    expect(result).toContain('-harness.')
    expect(result).not.toContain('+harness.')
  })
})

// ---------------------------------------------------------------------------
// buildHarnessReleaseTag
// ---------------------------------------------------------------------------

describe('buildHarnessReleaseTag', () => {
  it('exact output for known base + commit → v<baseVersion>+harness.<shortSha>', () => {
    // #given / #when
    const result = buildHarnessReleaseTag('1.17.3', 'ed359558abcdef1234567890abcdef1234567890')

    // #then
    expect(result).toBe('v1.17.3+harness.ed359558')
  })

  it('full 40-char SHA truncates to first 8 chars', () => {
    // #given
    const fullSha = 'abcdef1234567890abcdef1234567890abcdef12'

    // #when
    const result = buildHarnessReleaseTag('1.17.3', fullSha)

    // #then
    expect(result).toBe('v1.17.3+harness.abcdef12')
    expect(result.split('+harness.')[1]).toBe(fullSha.slice(0, 8))
  })

  it('8-char commit is used unchanged', () => {
    // #given
    const shortCommit = 'ed359558'

    // #when
    const result = buildHarnessReleaseTag('1.17.3', shortCommit)

    // #then
    expect(result).toBe('v1.17.3+harness.ed359558')
  })

  it('is v-prefixed with build-metadata plus separator (not prerelease hyphen)', () => {
    // #given / #when
    const result = buildHarnessReleaseTag('1.17.3', 'ed359558abcdef12')

    // #then — GitHub tag uses v-prefix + build metadata (+), NOT prerelease (-)
    expect(result).toMatch(/^v/)
    expect(result).toContain('+harness.')
    expect(result).not.toContain('-harness.')
  })
})
