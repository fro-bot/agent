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
  it('exact output for known base + commit → <baseVersion>+harness.<shortSha>', () => {
    // #given / #when
    const result = buildHarnessReleaseTag('1.17.3', 'ed359558abcdef1234567890abcdef1234567890')

    // #then
    expect(result).toBe('1.17.3+harness.ed359558')
  })

  it('full 40-char SHA truncates to first 8 chars', () => {
    // #given
    const fullSha = 'abcdef1234567890abcdef1234567890abcdef12'

    // #when
    const result = buildHarnessReleaseTag('1.17.3', fullSha)

    // #then
    expect(result).toBe('1.17.3+harness.abcdef12')
    expect(result.split('+harness.')[1]).toBe(fullSha.slice(0, 8))
  })

  it('8-char commit is used unchanged', () => {
    // #given
    const shortCommit = 'ed359558'

    // #when
    const result = buildHarnessReleaseTag('1.17.3', shortCommit)

    // #then
    expect(result).toBe('1.17.3+harness.ed359558')
  })

  it('is NOT v-prefixed and uses build-metadata plus separator (not prerelease hyphen)', () => {
    // #given / #when
    const result = buildHarnessReleaseTag('1.17.3', 'ed359558abcdef12')

    // #then — non-v so it stays out of the product `v${version}` tag space; build metadata (+), NOT prerelease (-)
    expect(result).not.toMatch(/^v/)
    expect(result).toContain('+harness.')
    expect(result).not.toContain('-harness.')
  })
})

// ---------------------------------------------------------------------------
// Round-trip: buildHarnessVersion output satisfies the harness predicate;
// buildHarnessNpmVersion output does NOT (npm hyphen form ≠ binary form).
// FIX 10: ensures the binary/release form and the npm form are correctly
// distinguished by the action's isHarnessVersion predicate.
// ---------------------------------------------------------------------------

// Inline the predicate from src/services/setup/opencode.ts — same logic,
// no cross-package import needed (the predicate is a one-liner).
const isHarnessVersion = (v: string): boolean => v.includes('+harness.')

describe('round-trip: buildHarnessVersion ↔ isHarnessVersion', () => {
  it('buildHarnessVersion output satisfies isHarnessVersion (binary/release form)', () => {
    // #given
    const baseVersion = '1.17.3'
    const integrationCommit = 'abc123456789abcd'

    // #when
    const binaryVersion = buildHarnessVersion(baseVersion, integrationCommit)

    // #then — the binary form must be recognized as a harness version by the action
    expect(isHarnessVersion(binaryVersion)).toBe(true)
    expect(binaryVersion).toContain('+harness.')
  })

  it('buildHarnessNpmVersion output does NOT satisfy isHarnessVersion (npm hyphen form)', () => {
    // #given
    const baseVersion = '1.17.3'
    const integrationCommit = 'abc123456789abcd'

    // #when
    const npmVersion = buildHarnessNpmVersion(baseVersion, integrationCommit)

    // #then — the npm form uses a hyphen and must NOT be treated as a harness download version
    expect(isHarnessVersion(npmVersion)).toBe(false)
    expect(npmVersion).toContain('-harness.')
    expect(npmVersion).not.toContain('+harness.')
  })
})
