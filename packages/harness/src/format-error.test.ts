import {describe, expect, it} from 'vitest'
import {FORMAT_ERROR_MAX_LENGTH, formatPipelineError, redactSecrets} from './format-error.js'

// ---------------------------------------------------------------------------
// redactSecrets
// ---------------------------------------------------------------------------

describe('redactSecrets', () => {
  it('redacts ghp_ token shape', () => {
    // #given
    const input = 'Authorization: ghp_abc123XYZsomeLongToken'

    // #when
    const result = redactSecrets(input)

    // #then
    expect(result).not.toContain('ghp_abc123XYZsomeLongToken')
    expect(result).toContain('[REDACTED]')
  })

  it('redacts gho_ token shape', () => {
    // #given
    const input = 'token=gho_secretOAuthToken99'

    // #when
    const result = redactSecrets(input)

    // #then
    expect(result).not.toContain('gho_secretOAuthToken99')
    expect(result).toContain('[REDACTED]')
  })

  it('redacts ghu_ token shape', () => {
    // #given
    const input = 'Bearer ghu_userAccessToken42'

    // #when
    const result = redactSecrets(input)

    // #then
    expect(result).not.toContain('ghu_userAccessToken42')
    expect(result).toContain('[REDACTED]')
  })

  it('redacts ghs_ token shape', () => {
    // #given
    const input = 'GITHUB_TOKEN=ghs_serverToServerToken77'

    // #when
    const result = redactSecrets(input)

    // #then
    expect(result).not.toContain('ghs_serverToServerToken77')
    expect(result).toContain('[REDACTED]')
  })

  it('redacts github_pat_ token shape', () => {
    // #given
    const input = 'pat=github_pat_11ABCDEF_longPersonalAccessToken'

    // #when
    const result = redactSecrets(input)

    // #then
    expect(result).not.toContain('github_pat_11ABCDEF_longPersonalAccessToken')
    expect(result).toContain('[REDACTED]')
  })

  it('redacts https://user:secret@host URL credentials', () => {
    // #given
    const input = 'Clone failed: https://myuser:supersecret@github.com/org/repo.git'

    // #when
    const result = redactSecrets(input)

    // #then
    expect(result).not.toContain('supersecret')
    expect(result).toContain('[REDACTED]@github.com')
  })

  it('redacts git:// URL credentials', () => {
    // #given
    const input = 'remote: git://user:pass@host.example.com/repo'

    // #when
    const result = redactSecrets(input)

    // #then
    expect(result).not.toContain('pass')
    expect(result).toContain('[REDACTED]@host.example.com')
  })

  it('redacts ghr_ token shape (runner registration token)', () => {
    // #given
    const input = 'ACTIONS_RUNNER_TOKEN=ghr_runnerRegistrationToken99'

    // #when
    const result = redactSecrets(input)

    // #then
    expect(result).not.toContain('ghr_runnerRegistrationToken99')
    expect(result).toContain('[REDACTED]')
  })

  it('redacts URL credentials where password contains @', () => {
    // #given — password itself contains '@', so naive [^@]+ would stop at the wrong '@'
    const input = 'https://user:my@secret@github.com/o/r'

    // #when
    const result = redactSecrets(input)

    // #then — no part of the credential leaks; exactly one [REDACTED] before the host
    expect(result).not.toContain('secret')
    expect(result).not.toContain('my@secret')
    expect(result).toContain('[REDACTED]@github.com')
    // Only one [REDACTED] marker (not two)
    expect(result.split('[REDACTED]').length - 1).toBe(1)
  })

  it('leaves plain text without secrets unchanged', () => {
    // #given
    const input = 'git clone failed: repository not found'

    // #when
    const result = redactSecrets(input)

    // #then
    expect(result).toBe(input)
  })
})

// ---------------------------------------------------------------------------
// formatPipelineError
// ---------------------------------------------------------------------------

describe('formatPipelineError', () => {
  it('collapses multi-line error to single line', () => {
    // #given
    const err = new Error('line one\nline two\nline three')

    // #when
    const result = formatPipelineError(err)

    // #then
    expect(result).not.toContain('\n')
    expect(result).toContain('line one')
    expect(result).toContain('line two')
    expect(result).toContain('line three')
  })

  it('collapses carriage-return newlines', () => {
    // #given
    const err = new Error('first\r\nsecond\r\nthird')

    // #when
    const result = formatPipelineError(err)

    // #then
    expect(result).not.toContain('\r')
    expect(result).not.toContain('\n')
    expect(result).toContain('first')
  })

  it('redacts ghp_ token in error message', () => {
    // #given
    const err = new Error('auth failed with token ghp_abc123secretToken')

    // #when
    const result = formatPipelineError(err)

    // #then
    expect(result).not.toContain('ghp_abc123secretToken')
    expect(result).toContain('[REDACTED]')
  })

  it('redacts github_pat_ token in error message', () => {
    // #given
    const err = new Error('push rejected: github_pat_11ABCDEF_longPAT')

    // #when
    const result = formatPipelineError(err)

    // #then
    expect(result).not.toContain('github_pat_11ABCDEF_longPAT')
    expect(result).toContain('[REDACTED]')
  })

  it('redacts URL credentials in error message', () => {
    // #given
    const err = new Error('fetch failed: https://bot:ghp_secretToken@github.com/org/repo.git')

    // #when
    const result = formatPipelineError(err)

    // #then
    expect(result).not.toContain('ghp_secretToken')
    expect(result).toContain('[REDACTED]')
  })

  it('truncates over-cap message with ellipsis', () => {
    // #given — message longer than FORMAT_ERROR_MAX_LENGTH
    const longMsg = 'x'.repeat(FORMAT_ERROR_MAX_LENGTH + 100)
    const err = new Error(longMsg)

    // #when
    const result = formatPipelineError(err)

    // #then
    expect(result.length).toBeLessThanOrEqual(FORMAT_ERROR_MAX_LENGTH)
    expect(result.endsWith('...')).toBe(true)
  })

  it('short message passes through unchanged (no truncation)', () => {
    // #given
    const err = new Error('short error')

    // #when
    const result = formatPipelineError(err)

    // #then
    expect(result).toBe('short error')
  })

  it('handles null safely', () => {
    // #given / #when
    const result = formatPipelineError(null)

    // #then
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('handles undefined safely', () => {
    // #given / #when
    const result = formatPipelineError(undefined)

    // #then
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('handles empty string safely', () => {
    // #given / #when
    const result = formatPipelineError('')

    // #then
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('handles non-Error objects', () => {
    // #given
    const obj = {code: 'ENOENT', message: 'file not found'}

    // #when
    const result = formatPipelineError(obj)

    // #then
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('secret does not straddle the truncation cut', () => {
    // #given — secret placed near the cap boundary
    const prefix = 'a'.repeat(FORMAT_ERROR_MAX_LENGTH - 20)
    const secret = 'ghp_secretTokenValue'
    const err = new Error(`${prefix}${secret}extra text after`)

    // #when
    const result = formatPipelineError(err)

    // #then — the raw secret must not appear in the output
    expect(result).not.toContain('ghp_secretTokenValue')
    expect(result.length).toBeLessThanOrEqual(FORMAT_ERROR_MAX_LENGTH)
  })
})
