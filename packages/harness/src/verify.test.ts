import {describe, expect, it} from 'vitest'
import {assertExitZero, assertIntegrationMarker, assertVersionMatch, runVerifications} from './verify.js'

// ---------------------------------------------------------------------------
// assertVersionMatch
// ---------------------------------------------------------------------------

describe('assertVersionMatch', () => {
  it('exact match → ok', () => {
    // #given / #when
    const result = assertVersionMatch('1.15.13', '1.15.13')

    // #then
    expect(result.ok).toBe(true)
    expect(result.message).toContain('1.15.13')
  })

  it('trims whitespace before comparing', () => {
    // #given / #when
    const result = assertVersionMatch('  1.15.13\n', '1.15.13')

    // #then
    expect(result.ok).toBe(true)
  })

  it('wrong version → not ok with mismatch message', () => {
    // #given / #when
    const result = assertVersionMatch('1.15.12', '1.15.13')

    // #then
    expect(result.ok).toBe(false)
    expect(result.message).toContain('mismatch')
    expect(result.message).toContain('1.15.12')
    expect(result.message).toContain('1.15.13')
  })

  it('empty version string → not ok', () => {
    // #given / #when
    const result = assertVersionMatch('', '1.15.13')

    // #then
    expect(result.ok).toBe(false)
    expect(result.message).toContain('mismatch')
  })

  it('version with extra text → not ok (exact match required)', () => {
    // #given / #when — binary outputs "opencode 1.15.13" instead of just "1.15.13"
    const result = assertVersionMatch('opencode 1.15.13', '1.15.13')

    // #then
    expect(result.ok).toBe(false)
    expect(result.message).toContain('mismatch')
  })

  it('harness version string exact match → ok', () => {
    // #given / #when — harness build self-reports "<base>+harness.<short8>"
    const result = assertVersionMatch('1.15.13+harness.cafebabe', '1.15.13+harness.cafebabe')

    // #then
    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// assertIntegrationMarker
// ---------------------------------------------------------------------------

describe('assertIntegrationMarker', () => {
  it('null integrationCommit → ok (dev scaffold, no marker required)', () => {
    // #given / #when
    const result = assertIntegrationMarker('1.15.13', null)

    // #then
    expect(result.ok).toBe(true)
    expect(result.message).toContain('not required')
  })

  it('empty integrationCommit → ok (dev scaffold)', () => {
    // #given / #when
    const result = assertIntegrationMarker('1.15.13', '')

    // #then
    expect(result.ok).toBe(true)
  })

  it('correct harness build: +harness.<short8> present in --version → ok', () => {
    // #given — harness build self-reports "<base>+harness.<short8>" via --version
    const commit = 'cafebabe1234abcd'
    const versionOutput = `1.15.13+harness.${commit.slice(0, 8)}`

    // #when
    const result = assertIntegrationMarker(versionOutput, commit)

    // #then
    expect(result.ok).toBe(true)
    expect(result.message).toContain(`+harness.${commit.slice(0, 8)}`)
  })

  it('stock binary: bare base version, no +harness. segment → not ok', () => {
    // #given — a stock upstream binary reports bare "<base>", no harness marker
    const commit = 'cafebabe1234abcd'
    const versionOutput = '1.15.13'

    // #when
    const result = assertIntegrationMarker(versionOutput, commit)

    // #then
    expect(result.ok).toBe(false)
    expect(result.message).toContain('missing')
    expect(result.message).toContain(`+harness.${commit.slice(0, 8)}`)
  })

  it('harness build with DIFFERENT commit short8 → not ok', () => {
    // #given — a harness build of a different commit; short8 does not match
    const expectedCommit = 'cafebabe1234abcd'
    const otherCommit = 'deadbeef99887766'
    const versionOutput = `1.15.13+harness.${otherCommit.slice(0, 8)}`

    // #when
    const result = assertIntegrationMarker(versionOutput, expectedCommit)

    // #then
    expect(result.ok).toBe(false)
    expect(result.message).toContain('missing')
    expect(result.message).toContain(`+harness.${expectedCommit.slice(0, 8)}`)
  })

  it('marker only as substring in unrelated text (not the +harness. format) → not ok', () => {
    // #given — SHA appears in output but not as "+harness.<short8>"
    const commit = 'cafebabe1234abcd'
    const versionOutput = `1.15.13\nError: unknown commit cafebabe1234abcd referenced\n`

    // #when
    const result = assertIntegrationMarker(versionOutput, commit)

    // #then — must fail: SHA in unstructured position is not the harness marker
    expect(result.ok).toBe(false)
    expect(result.message).toContain('missing')
  })
})

// ---------------------------------------------------------------------------
// assertExitZero
// ---------------------------------------------------------------------------

describe('assertExitZero', () => {
  it('exit code 0 → ok', () => {
    // #given / #when
    const result = assertExitZero(0, '--version')

    // #then
    expect(result.ok).toBe(true)
    expect(result.message).toContain('--version')
    expect(result.message).toContain('exit 0')
  })

  it('exit code 1 → not ok', () => {
    // #given / #when
    const result = assertExitZero(1, '--version')

    // #then
    expect(result.ok).toBe(false)
    expect(result.message).toContain('1')
  })

  it('exit code 127 (not found) → not ok', () => {
    // #given / #when
    const result = assertExitZero(127, '--version')

    // #then
    expect(result.ok).toBe(false)
    expect(result.message).toContain('127')
  })
})

// ---------------------------------------------------------------------------
// runVerifications — combined
// ---------------------------------------------------------------------------

describe('runVerifications', () => {
  it('correct harness build: all passing → ok with no failures', () => {
    // #given / #when — harness build self-reports "<base>+harness.<short8>"
    const commit = 'cafebabe1234abcd'
    const result = runVerifications({
      versionOutput: `1.15.13+harness.${commit.slice(0, 8)}`,
      expectedVersion: `1.15.13+harness.${commit.slice(0, 8)}`,
      integrationCommit: commit,
      exitCode: 0,
    })

    // #then
    expect(result.ok).toBe(true)
    expect(result.failures.length).toBe(0)
  })

  it('wrong version → not ok, failures list contains version mismatch', () => {
    // #given / #when
    const commit = 'cafebabe1234abcd'
    const result = runVerifications({
      versionOutput: '1.15.12',
      expectedVersion: `1.15.13+harness.${commit.slice(0, 8)}`,
      integrationCommit: commit,
      exitCode: 0,
    })

    // #then
    expect(result.ok).toBe(false)
    expect(result.failures.some(f => f.includes('mismatch'))).toBe(true)
  })

  it('stock binary (bare base version) with integration commit required → not ok', () => {
    // #given — a stock upstream binary reports bare "<base>"; expected is "<base>+harness.<short8>"
    const commit = 'cafebabe1234abcd'
    const result = runVerifications({
      versionOutput: '1.15.13',
      expectedVersion: `1.15.13+harness.${commit.slice(0, 8)}`,
      integrationCommit: commit,
      exitCode: 0,
    })

    // #then — version mismatch AND marker missing both fail
    expect(result.ok).toBe(false)
    expect(result.failures.some(f => f.includes('mismatch'))).toBe(true)
    expect(result.failures.some(f => f.includes('missing'))).toBe(true)
  })

  it('harness build with wrong commit short8 → not ok (marker fails)', () => {
    // #given — binary has +harness.<other8>, not the expected commit's short8
    const expectedCommit = 'cafebabe1234abcd'
    const otherCommit = 'deadbeef99887766'
    const result = runVerifications({
      versionOutput: `1.15.13+harness.${otherCommit.slice(0, 8)}`,
      expectedVersion: `1.15.13+harness.${expectedCommit.slice(0, 8)}`,
      integrationCommit: expectedCommit,
      exitCode: 0,
    })

    // #then — version mismatch AND marker missing both fail
    expect(result.ok).toBe(false)
    expect(result.failures.some(f => f.includes('mismatch'))).toBe(true)
    expect(result.failures.some(f => f.includes('missing'))).toBe(true)
  })

  it('dev scaffold (null integrationCommit) → ok when version + exit match', () => {
    // #given / #when — dev scaffold: no integration commit, bare base version
    const result = runVerifications({
      versionOutput: '1.15.13',
      expectedVersion: '1.15.13',
      integrationCommit: null,
      exitCode: 0,
    })

    // #then
    expect(result.ok).toBe(true)
    expect(result.failures.length).toBe(0)
  })

  it('non-zero exit code → not ok, failures list contains exit code', () => {
    // #given / #when
    const result = runVerifications({
      versionOutput: '',
      expectedVersion: '1.15.13',
      integrationCommit: null,
      exitCode: 1,
    })

    // #then
    expect(result.ok).toBe(false)
    expect(result.failures.some(f => f.includes('non-zero'))).toBe(true)
  })

  it('multiple failures → all reported', () => {
    // #given / #when
    const commit = 'cafebabe1234abcd'
    const result = runVerifications({
      versionOutput: '1.15.12',
      expectedVersion: `1.15.13+harness.${commit.slice(0, 8)}`,
      integrationCommit: commit,
      exitCode: 1,
    })

    // #then
    expect(result.ok).toBe(false)
    // All three assertions failed
    expect(result.failures.length).toBe(3)
  })
})
