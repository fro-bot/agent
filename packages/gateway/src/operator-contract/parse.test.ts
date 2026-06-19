/**
 * Tests for operator response type validators (parse.ts).
 *
 * Covers:
 *   - Happy path: valid payloads parse to ok(value).
 *   - Edge: missing fields, wrong-typed fields, extra fields.
 *   - Security NO-ORACLE: every error path is driven with crafted malicious inputs
 *     that embed sensitive substrings. The resulting Error.message must NEVER echo
 *     any part of the input — not field values, not token prefixes, not secrets.
 *
 * Extra-field policy: IGNORE extra fields (permissive structural subtyping).
 * Rationale: mirrors parseRunState's stance — the guard checks only the required
 * fields; unknown extra fields are silently ignored. This is safe because the
 * parsed value is typed as the interface (extra fields are not accessible via the
 * type) and the validator never echoes input back.
 *
 * Uses BDD comments (#given, #when, #then).
 */

import {describe, expect, it} from 'vitest'
import {parseOperatorCsrfToken, parseOperatorError, parseOperatorOk, parseOperatorSessionInfo} from './parse.js'

// ---------------------------------------------------------------------------
// parseOperatorSessionInfo — happy path
// ---------------------------------------------------------------------------

describe('parseOperatorSessionInfo — happy path', () => {
  it('returns ok(value) for a valid OperatorSessionInfo payload', () => {
    // #given
    const input = {operatorId: 42, login: 'octocat', expiresAt: 1_700_000_000_000}

    // #when
    const result = parseOperatorSessionInfo(input)

    // #then
    expect(result.success).toBe(true)
    expect(result.success && result.data).toEqual({operatorId: 42, login: 'octocat', expiresAt: 1_700_000_000_000})
  })

  it('ignores extra fields (permissive structural subtyping)', () => {
    // #given — extra field present
    const input = {operatorId: 1, login: 'user', expiresAt: 9999, extra: 'ignored'}

    // #when
    const result = parseOperatorSessionInfo(input)

    // #then — parses successfully; extra field is not in the typed result
    expect(result.success).toBe(true)
    expect(result.success && result.data.operatorId).toBe(1)
    expect(result.success && result.data.login).toBe('user')
    expect(result.success && result.data.expiresAt).toBe(9999)
  })
})

// ---------------------------------------------------------------------------
// parseOperatorSessionInfo — missing / wrong-typed fields
// ---------------------------------------------------------------------------

describe('parseOperatorSessionInfo — missing fields', () => {
  it('returns err when operatorId is missing', () => {
    // #given
    const input = {login: 'octocat', expiresAt: 1_700_000_000_000}

    // #when
    const result = parseOperatorSessionInfo(input)

    // #then
    expect(result.success).toBe(false)
  })

  it('returns err when login is missing', () => {
    // #given
    const input = {operatorId: 42, expiresAt: 1_700_000_000_000}

    // #when
    const result = parseOperatorSessionInfo(input)

    // #then
    expect(result.success).toBe(false)
  })

  it('returns err when expiresAt is missing', () => {
    // #given
    const input = {operatorId: 42, login: 'octocat'}

    // #when
    const result = parseOperatorSessionInfo(input)

    // #then
    expect(result.success).toBe(false)
  })

  it('returns err for null input', () => {
    // #given / #when / #then
    expect(parseOperatorSessionInfo(null).success).toBe(false)
  })

  it('returns err for non-object input (string)', () => {
    // #given / #when / #then
    expect(parseOperatorSessionInfo('not an object').success).toBe(false)
  })

  it('returns err for non-object input (number)', () => {
    // #given / #when / #then
    expect(parseOperatorSessionInfo(42).success).toBe(false)
  })

  it('returns err for array input', () => {
    // #given / #when / #then
    expect(parseOperatorSessionInfo([]).success).toBe(false)
  })
})

describe('parseOperatorSessionInfo — wrong-typed fields', () => {
  it('returns err when operatorId is a string instead of number', () => {
    // #given
    const input = {operatorId: '42', login: 'octocat', expiresAt: 1_700_000_000_000}

    // #when / #then
    expect(parseOperatorSessionInfo(input).success).toBe(false)
  })

  it('returns err when login is a number instead of string', () => {
    // #given
    const input = {operatorId: 42, login: 99, expiresAt: 1_700_000_000_000}

    // #when / #then
    expect(parseOperatorSessionInfo(input).success).toBe(false)
  })

  it('returns err when expiresAt is a string instead of number', () => {
    // #given
    const input = {operatorId: 42, login: 'octocat', expiresAt: '1700000000000'}

    // #when / #then
    expect(parseOperatorSessionInfo(input).success).toBe(false)
  })

  it('returns err when operatorId is null', () => {
    // #given
    const input = {operatorId: null, login: 'octocat', expiresAt: 1_700_000_000_000}

    // #when / #then
    expect(parseOperatorSessionInfo(input).success).toBe(false)
  })

  it('returns err when login is null', () => {
    // #given
    const input = {operatorId: 42, login: null, expiresAt: 1_700_000_000_000}

    // #when / #then
    expect(parseOperatorSessionInfo(input).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Security NO-ORACLE: error messages must NEVER echo input
// ---------------------------------------------------------------------------

describe('parseOperatorSessionInfo — no-oracle: error messages never echo input', () => {
  /**
   * Sensitive substrings that must NEVER appear in any error message.
   * These simulate real secrets that could appear in crafted inputs.
   */
  const SENSITIVE_SUBSTRINGS = [
    'ghs_DEADBEEF',
    'ghp_SECRET',
    'Bearer abc123',
    'sessionCorrelationId-XYZ',
    'raw-cookie-value=abc',
    'Authorization: Bearer',
    'X-CSRF-Token: tok123',
  ]

  /**
   * Crafted malicious inputs — each embeds sensitive substrings in field values
   * or as the entire input. Every error path is exercised.
   */
  const maliciousInputs: {label: string; input: unknown}[] = [
    // Non-object inputs with sensitive values
    {label: 'sensitive string as input', input: 'ghs_DEADBEEF'},
    {label: 'sensitive string as input (ghp)', input: 'ghp_SECRET'},
    {label: 'bearer token as input', input: 'Bearer abc123'},

    // Object with wrong-typed operatorId containing sensitive value
    {
      label: 'operatorId is sensitive string',
      input: {operatorId: 'ghs_DEADBEEF', login: 'octocat', expiresAt: 1_000_000},
    },
    {
      label: 'operatorId is bearer token',
      input: {operatorId: 'Bearer abc123', login: 'octocat', expiresAt: 1_000_000},
    },

    // Object with wrong-typed login containing sensitive value
    {
      label: 'login is sensitive number (ghp prefix in operatorId)',
      input: {operatorId: 'ghp_SECRET', login: 42, expiresAt: 1_000_000},
    },
    {
      label: 'login is null with sensitive operatorId',
      input: {operatorId: 'sessionCorrelationId-XYZ', login: null, expiresAt: 1_000_000},
    },

    // Object with wrong-typed expiresAt containing sensitive value
    {
      label: 'expiresAt is sensitive string',
      input: {operatorId: 42, login: 'octocat', expiresAt: 'raw-cookie-value=abc'},
    },
    {
      label: 'expiresAt is bearer token string',
      input: {operatorId: 42, login: 'octocat', expiresAt: 'Authorization: Bearer'},
    },

    // Missing fields with sensitive values in present fields
    {
      label: 'missing expiresAt, login contains sensitive value',
      input: {operatorId: 42, login: 'X-CSRF-Token: tok123'},
    },
    {
      label: 'missing login, operatorId contains sensitive string',
      input: {operatorId: 'ghs_DEADBEEF', expiresAt: 1_000_000},
    },

    // Deeply nested sensitive values
    {
      label: 'all fields wrong type with sensitive values',
      input: {operatorId: 'ghs_DEADBEEF', login: 'ghp_SECRET', expiresAt: 'Bearer abc123'},
    },

    // Sensitive value as the entire object (no valid fields)
    {
      label: 'object with only sensitive extra fields',
      input: {secret: 'ghs_DEADBEEF', token: 'ghp_SECRET'},
    },
  ]

  for (const {label, input} of maliciousInputs) {
    it(`error message does not echo input: ${label}`, () => {
      // #given — a crafted malicious input embedding sensitive substrings
      // #when
      const result = parseOperatorSessionInfo(input)

      // #then — must be an error (all these inputs are invalid)
      expect(result.success).toBe(false)
      const message = result.success === false ? result.error.message : ''

      // The error message must NOT contain any sensitive substring from the input
      for (const sensitive of SENSITIVE_SUBSTRINGS) {
        expect(message).not.toContain(sensitive)
      }

      // The error message must be a fixed, non-empty reason string
      expect(message.length).toBeGreaterThan(0)
    })
  }
})

// ---------------------------------------------------------------------------
// parseOperatorCsrfToken — happy path + error paths
// ---------------------------------------------------------------------------

describe('parseOperatorCsrfToken — happy path', () => {
  it('returns ok(value) for a valid OperatorCsrfToken payload', () => {
    // #given
    const input = {csrfToken: 'tok.abc.def'}

    // #when
    const result = parseOperatorCsrfToken(input)

    // #then
    expect(result.success).toBe(true)
    expect(result.success && result.data).toEqual({csrfToken: 'tok.abc.def'})
  })

  it('ignores extra fields', () => {
    // #given
    const input = {csrfToken: 'tok.abc.def', extra: 'ignored'}

    // #when
    const result = parseOperatorCsrfToken(input)

    // #then
    expect(result.success).toBe(true)
  })
})

describe('parseOperatorCsrfToken — error paths', () => {
  it('returns err for null input', () => {
    expect(parseOperatorCsrfToken(null).success).toBe(false)
  })

  it('returns err when csrfToken is missing', () => {
    expect(parseOperatorCsrfToken({}).success).toBe(false)
  })

  it('returns err when csrfToken is a number', () => {
    expect(parseOperatorCsrfToken({csrfToken: 42}).success).toBe(false)
  })

  it('no-oracle: error message does not echo sensitive csrfToken value', () => {
    // #given — sensitive value in csrfToken field (wrong type to trigger error)
    const input = {csrfToken: 42, secret: 'ghs_DEADBEEF'}

    // #when
    const result = parseOperatorCsrfToken(input)

    // #then
    expect(result.success).toBe(false)
    const message = result.success === false ? result.error.message : ''
    expect(message).not.toContain('ghs_DEADBEEF')
    expect(message).not.toContain('42')
  })
})

// ---------------------------------------------------------------------------
// parseOperatorOk — happy path + error paths
// ---------------------------------------------------------------------------

describe('parseOperatorOk — happy path', () => {
  it('returns ok(value) for a valid OperatorOk payload', () => {
    // #given
    const input = {ok: true}

    // #when
    const result = parseOperatorOk(input)

    // #then
    expect(result.success).toBe(true)
    expect(result.success && result.data).toEqual({ok: true})
  })

  it('ignores extra fields', () => {
    // #given
    const input = {ok: true, extra: 'ignored'}

    // #when
    const result = parseOperatorOk(input)

    // #then
    expect(result.success).toBe(true)
  })
})

describe('parseOperatorOk — error paths', () => {
  it('returns err for null input', () => {
    expect(parseOperatorOk(null).success).toBe(false)
  })

  it('returns err when ok is false', () => {
    expect(parseOperatorOk({ok: false}).success).toBe(false)
  })

  it('returns err when ok is missing', () => {
    expect(parseOperatorOk({}).success).toBe(false)
  })

  it('returns err when ok is a string', () => {
    expect(parseOperatorOk({ok: 'true'}).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseOperatorError — happy path + error paths
// ---------------------------------------------------------------------------

describe('parseOperatorError — happy path', () => {
  it('returns ok(value) for a valid OperatorError payload', () => {
    // #given
    const input = {error: 'unauthorized'}

    // #when
    const result = parseOperatorError(input)

    // #then
    expect(result.success).toBe(true)
    expect(result.success && result.data).toEqual({error: 'unauthorized'})
  })

  it('ignores extra fields', () => {
    // #given
    const input = {error: 'bad request', extra: 'ignored'}

    // #when
    const result = parseOperatorError(input)

    // #then
    expect(result.success).toBe(true)
  })
})

describe('parseOperatorError — error paths', () => {
  it('returns err for null input', () => {
    expect(parseOperatorError(null).success).toBe(false)
  })

  it('returns err when error field is missing', () => {
    expect(parseOperatorError({}).success).toBe(false)
  })

  it('returns err when error field is a number', () => {
    expect(parseOperatorError({error: 42}).success).toBe(false)
  })

  it('no-oracle: error message does not echo sensitive error field value', () => {
    // #given — sensitive value in error field (wrong type to trigger error)
    const input = {error: 42, secret: 'ghp_SECRET'}

    // #when
    const result = parseOperatorError(input)

    // #then
    expect(result.success).toBe(false)
    const message = result.success === false ? result.error.message : ''
    expect(message).not.toContain('ghp_SECRET')
    expect(message).not.toContain('42')
  })
})
