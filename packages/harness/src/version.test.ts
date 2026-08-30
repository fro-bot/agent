import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'
import {buildHarnessNpmVersion, buildHarnessVersion} from './version.js'

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
// Round-trip: buildHarnessVersion output satisfies the harness predicate;
// buildHarnessNpmVersion output does too (the forms share an identity).
// FIX 10: ensures both forms are recognized by the action's isHarnessVersion predicate.
// ---------------------------------------------------------------------------

// The harness package has an independent tsconfig, so its test cannot import root src/.
// Keep this mirror constrained by a source-level assertion against the real predicate.
const isHarnessVersion = (v: string): boolean => v.includes('+harness.') || v.includes('-harness.')

function assertActionPredicateSource(source: string): void {
  // Coupling contract: this guard matches source text, so refactoring the matched expression requires updating it.
  const sourceWithoutComments = source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '')
  if (
    sourceWithoutComments.includes('version.includes(HARNESS_MARKER)') === false ||
    sourceWithoutComments.includes("version.includes('-harness.')") === false
  ) {
    throw new Error(
      "src/services/setup/opencode.ts: expected isHarnessVersion to accept both '+harness.' and '-harness.' forms",
    )
  }
}

function readActionPredicateSource(): string {
  return readFileSync(new URL('../../../src/services/setup/opencode.ts', import.meta.url), 'utf8')
}

describe('round-trip: buildHarnessVersion ↔ isHarnessVersion', () => {
  it('keeps the local mirror equivalent to the action predicate source', () => {
    // #given the action's real predicate source
    // #when its accepted harness markers are checked against the local test mirror
    // #then both build-metadata and prerelease forms must remain represented
    expect(() => assertActionPredicateSource(readActionPredicateSource())).not.toThrow()
    expect(isHarnessVersion('1.17.3+harness.abc12345')).toBe(true)
    expect(isHarnessVersion('1.17.3-harness.abc12345')).toBe(true)
  })

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

  it('buildHarnessNpmVersion output satisfies isHarnessVersion (npm hyphen form)', () => {
    // #given
    const baseVersion = '1.17.3'
    const integrationCommit = 'abc123456789abcd'

    // #when
    const npmVersion = buildHarnessNpmVersion(baseVersion, integrationCommit)

    // #then — the production predicate recognizes both the binary and npm harness forms
    expect(isHarnessVersion(npmVersion)).toBe(true)
    expect(npmVersion).toContain('-harness.')
    expect(npmVersion).not.toContain('+harness.')
  })

  it('rejects an action predicate narrowed to +harness. only', () => {
    // #given a source whose predicate lost the prerelease marker, despite a comment retaining its text
    const narrowedSource = "// version.includes('-harness.')\nreturn version.includes(HARNESS_MARKER)"

    // #when / #then the source-level equivalence guard rejects the drift
    expect(() => assertActionPredicateSource(narrowedSource)).toThrow(
      "src/services/setup/opencode.ts: expected isHarnessVersion to accept both '+harness.' and '-harness.' forms",
    )
  })
})
