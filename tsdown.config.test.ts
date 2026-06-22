import {describe, expect, it} from 'vitest'
import {assertVersionPresent, formatThirdPartyNotices, type LicenseEntry} from './tsdown.config.js'

describe('assertVersionPresent', () => {
  it('throws when the expected version is absent from every chunk', () => {
    // #given chunks that do not contain the harness version string
    const expected = '1.17.3+harness.2c9cdbd2'
    const chunkContents = ['var a="1.17.3"', 'other']

    // #when asserting version presence
    // #then throws with a message mentioning the version
    expect(() => assertVersionPresent(expected, chunkContents)).toThrowError('1.17.3+harness.2c9cdbd2')
  })

  it('does not throw when the expected version is present in any chunk', () => {
    // #given chunks where the second contains the full harness version string
    const expected = '1.17.3+harness.2c9cdbd2'
    const chunkContents = ['noise', 'x="1.17.3+harness.2c9cdbd2"']

    // #when asserting version presence
    // #then no throw
    expect(() => assertVersionPresent(expected, chunkContents)).not.toThrow()
  })

  it('does not throw when the expected version is present in the first chunk', () => {
    // #given chunks where the first contains the full harness version string
    const expected = '1.17.3+harness.2c9cdbd2'
    const chunkContents = ['var v="1.17.3+harness.2c9cdbd2"', 'other chunk']

    // #when asserting version presence
    // #then no throw
    expect(() => assertVersionPresent(expected, chunkContents)).not.toThrow()
  })

  it('throws on an empty chunk list', () => {
    // #given no chunks at all
    const expected = '1.17.3+harness.2c9cdbd2'
    const chunkContents: string[] = []

    // #when asserting version presence against empty list
    // #then throws because no chunk can contain the version
    expect(() => assertVersionPresent(expected, chunkContents)).toThrowError('1.17.3+harness.2c9cdbd2')
  })
})

describe('formatThirdPartyNotices', () => {
  it('formats entries as name@version + license type + content, sorted by name', () => {
    // #given two packages in reverse alphabetical order
    const entries = new Map([
      ['zlib', {version: '1.2.3', license: 'MIT', content: 'MIT License text'}],
      ['acorn', {version: '8.0.0', license: 'MIT', content: 'Acorn license text'}],
    ])

    // #when formatting
    const result = formatThirdPartyNotices(entries)

    // #then output is sorted alphabetically by package name
    expect(result).toBe('acorn@8.0.0\nMIT\nAcorn license text\n\nzlib@1.2.3\nMIT\nMIT License text')
  })

  it('normalizes CRLF line endings to LF', () => {
    // #given a package whose license content uses Windows line endings
    const entries = new Map([['pkg', {version: '1.0.0', license: 'Apache-2.0', content: 'line1\r\nline2\r\nline3'}]])

    // #when formatting
    const result = formatThirdPartyNotices(entries)

    // #then CRLF is replaced with LF throughout
    expect(result).not.toContain('\r\n')
    expect(result).toContain('line1\nline2\nline3')
  })

  it('produces identical output for the same input (determinism)', () => {
    // #given a fixed set of license entries
    const entries = new Map([
      ['react', {version: '18.2.0', license: 'MIT', content: 'React MIT license'}],
      ['typescript', {version: '5.0.0', license: 'Apache-2.0', content: 'TypeScript Apache license'}],
    ])

    // #when formatting twice
    const first = formatThirdPartyNotices(entries)
    const second = formatThirdPartyNotices(entries)

    // #then both runs produce byte-identical output
    expect(first).toBe(second)
  })

  it('returns an empty string for an empty map', () => {
    // #given no license entries
    const entries = new Map<string, LicenseEntry>()

    // #when formatting
    const result = formatThirdPartyNotices(entries)

    // #then output is empty
    expect(result).toBe('')
  })

  it('separates entries with a blank line', () => {
    // #given two packages
    const entries = new Map([
      ['alpha', {version: '1.0.0', license: 'MIT', content: 'Alpha license'}],
      ['beta', {version: '2.0.0', license: 'BSD-2-Clause', content: 'Beta license'}],
    ])

    // #when formatting
    const result = formatThirdPartyNotices(entries)

    // #then entries are separated by a blank line (double newline)
    expect(result).toContain('\n\n')
    const parts = result.split('\n\n')
    expect(parts).toHaveLength(2)
    expect(parts[0]).toBe('alpha@1.0.0\nMIT\nAlpha license')
    expect(parts[1]).toBe('beta@2.0.0\nBSD-2-Clause\nBeta license')
  })
})
