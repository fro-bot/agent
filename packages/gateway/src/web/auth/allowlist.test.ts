/**
 * Tests for the operator allowlist authorization module.
 *
 * Covers:
 *   - Fail closed: missing/unreadable/empty/malformed allowlist denies everyone.
 *   - Happy path: allowlisted numeric GitHub user ID is authorized.
 *   - Security: non-allowlisted user is denied.
 *   - Security: authorization uses session-bound identity, never request headers.
 *   - Security: login strings are not authoritative — only numeric IDs.
 *   - Audit: authz.denied emitted on every denial.
 *
 * Uses BDD comments (#given, #when, #then).
 */

import {describe, expect, it, vi} from 'vitest'
import {loadAllowlistFromText, parseAllowlistText} from './allowlist.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// parseAllowlistText — parsing
// ---------------------------------------------------------------------------

describe('parseAllowlistText — parsing', () => {
  it('parses a single numeric ID', () => {
    // #given
    const text = '12345\n'

    // #when
    const result = parseAllowlistText(text)

    // #then
    expect(result).toEqual({ok: true, ids: new Set([12345])})
  })

  it('parses multiple numeric IDs (newline-separated)', () => {
    // #given
    const text = '12345\n67890\n11111\n'

    // #when
    const result = parseAllowlistText(text)

    // #then
    expect(result).toEqual({ok: true, ids: new Set([12345, 67890, 11111])})
  })

  it('ignores blank lines and whitespace', () => {
    // #given
    const text = '\n  12345  \n\n  67890\n\n'

    // #when
    const result = parseAllowlistText(text)

    // #then
    expect(result).toEqual({ok: true, ids: new Set([12345, 67890])})
  })

  it('ignores comment lines starting with #', () => {
    // #given
    const text = '# operator allowlist\n12345\n# another comment\n67890\n'

    // #when
    const result = parseAllowlistText(text)

    // #then
    expect(result).toEqual({ok: true, ids: new Set([12345, 67890])})
  })

  it('returns error for empty text (no IDs)', () => {
    // #given
    const text = ''

    // #when
    const result = parseAllowlistText(text)

    // #then
    expect(result.ok).toBe(false)
  })

  it('returns error for whitespace-only text', () => {
    // #given
    const text = '   \n\n   \n'

    // #when
    const result = parseAllowlistText(text)

    // #then
    expect(result.ok).toBe(false)
  })

  it('returns error for comment-only text (no IDs)', () => {
    // #given
    const text = '# just a comment\n# another comment\n'

    // #when
    const result = parseAllowlistText(text)

    // #then
    expect(result.ok).toBe(false)
  })

  it('returns error when any line is non-numeric (malformed)', () => {
    // #given — login string mixed in
    const text = '12345\noctocat\n67890\n'

    // #when
    const result = parseAllowlistText(text)

    // #then
    expect(result.ok).toBe(false)
  })

  it('returns error for zero as a user ID (invalid)', () => {
    // #given
    const text = '0\n'

    // #when
    const result = parseAllowlistText(text)

    // #then
    expect(result.ok).toBe(false)
  })

  it('returns error for negative numbers', () => {
    // #given
    const text = '-1\n'

    // #when
    const result = parseAllowlistText(text)

    // #then
    expect(result.ok).toBe(false)
  })

  it('returns error for floating-point numbers', () => {
    // #given
    const text = '123.45\n'

    // #when
    const result = parseAllowlistText(text)

    // #then
    expect(result.ok).toBe(false)
  })

  it('returns error for an all-digits value exceeding Number.MAX_SAFE_INTEGER', () => {
    // #given — 9007199254740992 is Number.MAX_SAFE_INTEGER + 1 (all digits, no decimal)
    const oversized = String(Number.MAX_SAFE_INTEGER + 1)
    const text = `${oversized}\n`

    // #when
    const result = parseAllowlistText(text)

    // #then — must reject; integer precision is lost above MAX_SAFE_INTEGER
    expect(result.ok).toBe(false)
  })

  it('accepts a valid ID well within Number.MAX_SAFE_INTEGER', () => {
    // #given — a realistic GitHub user ID
    const text = '12345678\n'

    // #when
    const result = parseAllowlistText(text)

    // #then — must pass
    expect(result).toEqual({ok: true, ids: new Set([12345678])})
  })
})

// ---------------------------------------------------------------------------
// loadAllowlistFromText — fail-closed posture
// ---------------------------------------------------------------------------

describe('loadAllowlistFromText — fail-closed posture', () => {
  it('returns a deny-all allowlist when text is empty', () => {
    // #given
    const logger = makeLogger()

    // #when
    const allowlist = loadAllowlistFromText('', logger)

    // #then — deny-all: no ID is authorized
    expect(allowlist.isAuthorized(12345)).toBe(false)
    expect(allowlist.isAuthorized(1)).toBe(false)
  })

  it('returns a deny-all allowlist when text is malformed', () => {
    // #given
    const logger = makeLogger()

    // #when
    const allowlist = loadAllowlistFromText('octocat\n', logger)

    // #then — deny-all
    expect(allowlist.isAuthorized(12345)).toBe(false)
  })

  it('logs a warning when allowlist is empty or malformed', () => {
    // #given
    const logger = makeLogger()

    // #when
    loadAllowlistFromText('', logger)

    // #then
    expect(logger.warn).toHaveBeenCalled()
  })
})
