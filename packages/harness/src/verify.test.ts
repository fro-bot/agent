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
})

// ---------------------------------------------------------------------------
// assertIntegrationMarker
// ---------------------------------------------------------------------------

describe('assertIntegrationMarker', () => {
  it('null integrationCommit → ok (dev scaffold, no marker required)', () => {
    // #given / #when
    const result = assertIntegrationMarker('some binary output', null)

    // #then
    expect(result.ok).toBe(true)
    expect(result.message).toContain('not required')
  })

  it('empty integrationCommit → ok (dev scaffold)', () => {
    // #given / #when
    const result = assertIntegrationMarker('some binary output', '')

    // #then
    expect(result.ok).toBe(true)
  })

  it('marker present in probe output → ok', () => {
    // #given
    const commit = 'cafebabe1234abcd'
    const probeOutput = `harness (patched OpenCode)\n  integration commit: ${commit}\n  build sha: abc`

    // #when
    const result = assertIntegrationMarker(probeOutput, commit)

    // #then
    expect(result.ok).toBe(true)
    expect(result.message).toContain(commit)
  })

  it('marker absent from probe output → not ok', () => {
    // #given
    const commit = 'cafebabe1234abcd'
    const probeOutput = 'harness (patched OpenCode)\n  integration commit: deadbeef\n'

    // #when
    const result = assertIntegrationMarker(probeOutput, commit)

    // #then
    expect(result.ok).toBe(false)
    expect(result.message).toContain('missing')
    expect(result.message).toContain(commit)
  })

  it('marker is a substring of probe output → ok', () => {
    // #given — partial SHA match (first 8 chars) is sufficient for the probe
    const commit = 'cafebabe'
    const probeOutput = 'integration commit: cafebabe1234abcd'

    // #when
    const result = assertIntegrationMarker(probeOutput, commit)

    // #then
    expect(result.ok).toBe(true)
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
  it('all passing → ok with no failures', () => {
    // #given / #when
    const result = runVerifications({
      versionOutput: '1.15.13',
      expectedVersion: '1.15.13',
      probeOutput: 'integration commit: cafebabe1234',
      integrationCommit: 'cafebabe1234',
      exitCode: 0,
    })

    // #then
    expect(result.ok).toBe(true)
    expect(result.failures.length).toBe(0)
  })

  it('wrong version → not ok, failures list contains version mismatch', () => {
    // #given / #when
    const result = runVerifications({
      versionOutput: '1.15.12',
      expectedVersion: '1.15.13',
      probeOutput: 'integration commit: cafebabe1234',
      integrationCommit: 'cafebabe1234',
      exitCode: 0,
    })

    // #then
    expect(result.ok).toBe(false)
    expect(result.failures.some(f => f.includes('mismatch'))).toBe(true)
  })

  it('missing integration marker → not ok, failures list contains marker missing', () => {
    // #given / #when
    const result = runVerifications({
      versionOutput: '1.15.13',
      expectedVersion: '1.15.13',
      probeOutput: 'integration commit: deadbeef',
      integrationCommit: 'cafebabe1234',
      exitCode: 0,
    })

    // #then
    expect(result.ok).toBe(false)
    expect(result.failures.some(f => f.includes('missing'))).toBe(true)
  })

  it('non-zero exit code → not ok, failures list contains exit code', () => {
    // #given / #when
    const result = runVerifications({
      versionOutput: '',
      expectedVersion: '1.15.13',
      probeOutput: '',
      integrationCommit: null,
      exitCode: 1,
    })

    // #then
    expect(result.ok).toBe(false)
    expect(result.failures.some(f => f.includes('non-zero'))).toBe(true)
  })

  it('multiple failures → all reported', () => {
    // #given / #when
    const result = runVerifications({
      versionOutput: '1.15.12',
      expectedVersion: '1.15.13',
      probeOutput: 'no marker here',
      integrationCommit: 'cafebabe1234',
      exitCode: 1,
    })

    // #then
    expect(result.ok).toBe(false)
    // All three assertions failed
    expect(result.failures.length).toBe(3)
  })

  it('dev scaffold (null integrationCommit) → ok when version + exit match', () => {
    // #given / #when
    const result = runVerifications({
      versionOutput: '1.15.13',
      expectedVersion: '1.15.13',
      probeOutput: 'some output without a commit sha',
      integrationCommit: null,
      exitCode: 0,
    })

    // #then
    expect(result.ok).toBe(true)
    expect(result.failures.length).toBe(0)
  })
})
