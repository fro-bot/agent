/**
 * Tests for the operator audit seam.
 *
 * Covers:
 *   - Happy path: each AuditEvent variant emits a structured log record with expected typed fields.
 *   - Security: no cookie, secret, token, prompt, or bearer value appears in any emitted record.
 *   - Security: bearer.rejected records the rejection without logging the credential value.
 *   - Security: embedded credentials, lowercase bearer, bare localhost/internal URLs, common cookie names.
 *   - Resilience: sink failures are swallowed and do not throw.
 *
 * Uses BDD comments (#given, #when, #then).
 */

import type {AuditEvent, AuditLogger} from './audit.js'
import {describe, expect, it, vi} from 'vitest'
import {emitAudit} from './audit.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Derived from AuditLogger so the mock stays in sync with the interface.
type LogFn = AuditLogger['info']

type LogMock = ReturnType<typeof vi.fn<LogFn>>

interface MockLogger extends AuditLogger {
  readonly info: LogMock
  readonly warn: LogMock
}

function makeLogger(): MockLogger {
  return {
    info: vi.fn<LogFn>(),
    warn: vi.fn<LogFn>(),
  }
}

/** Extract the context object from the first call to a mock logger method. */
function firstCallCtx(mockFn: LogMock): Record<string, unknown> {
  const call = mockFn.mock.calls[0]
  if (call === undefined) throw new Error('expected at least one call')
  return call[0]
}

/** Extract the message string from the first call to a mock logger method. */
function firstCallMsg(mockFn: LogMock): string {
  const call = mockFn.mock.calls[0]
  if (call === undefined) throw new Error('expected at least one call')
  return call[1]
}

/** Serialize all captured log calls to a single string for redaction assertions. */
function serializeAllCalls(logger: MockLogger): string {
  return JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls])
}

// Planted sensitive values that must never appear in any log output.
const PLANTED_COOKIE = 'session=abc123secret'
const PLANTED_TOKEN = 'ghp_SUPERSECRETTOKEN'
const PLANTED_BEARER = 'Bearer eyJhbGciOiJSUzI1NiJ9.SECRETPAYLOAD'
const PLANTED_SECRET = 'client_secret_VERYSECRET'
const PLANTED_PROMPT = 'PROMPT_CONTENT_THAT_IS_PRIVATE'
const PLANTED_INTERNAL_URL = 'http://10.0.0.5/internal'
const PLANTED_BOUNDARY_SCOPED_COOKIE = 'mysession=abc123secret'

/** Assert none of the planted sentinels appear in the serialized log output. */
function assertNoSensitiveValues(logger: MockLogger): void {
  const serialized = serializeAllCalls(logger)
  expect(serialized).not.toContain(PLANTED_COOKIE)
  expect(serialized).not.toContain(PLANTED_TOKEN)
  expect(serialized).not.toContain(PLANTED_BEARER)
  expect(serialized).not.toContain(PLANTED_SECRET)
  expect(serialized).not.toContain(PLANTED_PROMPT)
  expect(serialized).not.toContain(PLANTED_INTERNAL_URL)
}

// ---------------------------------------------------------------------------
// auth.start
// ---------------------------------------------------------------------------

describe('emitAudit — auth.start', () => {
  it('emits a structured info record with expected fields', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {kind: 'auth.start', correlationId: 'corr-001'}

    // #when
    emitAudit(event, logger)

    // #then
    expect(logger.info).toHaveBeenCalledOnce()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(firstCallMsg(logger.info)).toBe('audit: auth.start')
    expect(firstCallCtx(logger.info)).toMatchObject({kind: 'auth.start', correlationId: 'corr-001'})
  })

  it('redacts sensitive values planted in correlationId', () => {
    // #given — plant each sentinel in correlationId
    for (const planted of [
      PLANTED_COOKIE,
      PLANTED_TOKEN,
      PLANTED_BEARER,
      PLANTED_SECRET,
      PLANTED_PROMPT,
      PLANTED_INTERNAL_URL,
    ]) {
      const logger = makeLogger()
      const event: AuditEvent = {kind: 'auth.start', correlationId: planted}

      // #when
      emitAudit(event, logger)

      // #then
      assertNoSensitiveValues(logger)
    }
  })
})

// ---------------------------------------------------------------------------
// auth.callback.success
// ---------------------------------------------------------------------------

describe('emitAudit — auth.callback.success', () => {
  it('emits a structured info record with expected fields', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {
      kind: 'auth.callback.success',
      correlationId: 'corr-002',
      githubUserId: 42,
      login: 'octocat',
    }

    // #when
    emitAudit(event, logger)

    // #then
    expect(logger.info).toHaveBeenCalledOnce()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(firstCallMsg(logger.info)).toBe('audit: auth.callback.success')
    expect(firstCallCtx(logger.info)).toMatchObject({
      kind: 'auth.callback.success',
      correlationId: 'corr-002',
      githubUserId: 42,
      login: 'octocat',
    })
  })

  it('preserves safe typed fields when caller-controlled strings are redacted', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {
      kind: 'auth.callback.success',
      correlationId: 'corr-safe-typed-field',
      githubUserId: 42,
      login: `octo-${PLANTED_TOKEN}`,
    }

    // #when
    emitAudit(event, logger)

    // #then
    expect(firstCallCtx(logger.info)).toMatchObject({githubUserId: 42, login: '[redacted]'})
    assertNoSensitiveValues(logger)
  })

  it('redacts sensitive values planted in correlationId and login', () => {
    // #given — plant each sentinel in both caller-controlled string fields
    for (const planted of [
      PLANTED_COOKIE,
      PLANTED_TOKEN,
      PLANTED_BEARER,
      PLANTED_SECRET,
      PLANTED_PROMPT,
      PLANTED_INTERNAL_URL,
    ]) {
      const logger = makeLogger()
      const event: AuditEvent = {
        kind: 'auth.callback.success',
        correlationId: planted,
        githubUserId: 42,
        login: planted,
      }

      // #when
      emitAudit(event, logger)

      // #then
      assertNoSensitiveValues(logger)
    }
  })
})

describe('emitAudit — redaction boundaries', () => {
  it('keeps non-session cookie-name substrings visible by design', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {kind: 'auth.start', correlationId: PLANTED_BOUNDARY_SCOPED_COOKIE}

    // #when
    emitAudit(event, logger)

    // #then
    expect(firstCallCtx(logger.info)).toMatchObject({correlationId: PLANTED_BOUNDARY_SCOPED_COOKIE})
  })
})

// ---------------------------------------------------------------------------
// auth.callback.failure
// ---------------------------------------------------------------------------

describe('emitAudit — auth.callback.failure', () => {
  it('emits a structured warn record with expected fields', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {
      kind: 'auth.callback.failure',
      correlationId: 'corr-003',
      reason: 'state_mismatch',
    }

    // #when
    emitAudit(event, logger)

    // #then
    expect(logger.warn).toHaveBeenCalledOnce()
    expect(logger.info).not.toHaveBeenCalled()
    expect(firstCallMsg(logger.warn)).toBe('audit: auth.callback.failure')
    expect(firstCallCtx(logger.warn)).toMatchObject({
      kind: 'auth.callback.failure',
      correlationId: 'corr-003',
      reason: 'state_mismatch',
    })
  })

  it('redacts sensitive values planted in correlationId; reason enum is preserved', () => {
    // #given — plant each sentinel in correlationId
    for (const planted of [
      PLANTED_COOKIE,
      PLANTED_TOKEN,
      PLANTED_BEARER,
      PLANTED_SECRET,
      PLANTED_PROMPT,
      PLANTED_INTERNAL_URL,
    ]) {
      const logger = makeLogger()
      const event: AuditEvent = {
        kind: 'auth.callback.failure',
        correlationId: planted,
        reason: 'provider_error',
      }

      // #when
      emitAudit(event, logger)

      // #then
      assertNoSensitiveValues(logger)
      // Safe enum reason must survive redaction
      expect(serializeAllCalls(logger)).toContain('provider_error')
    }
  })
})

// ---------------------------------------------------------------------------
// auth.logout
// ---------------------------------------------------------------------------

describe('emitAudit — auth.logout', () => {
  it('emits a structured info record with expected fields', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {
      kind: 'auth.logout',
      correlationId: 'corr-004',
      githubUserId: 42,
    }

    // #when
    emitAudit(event, logger)

    // #then
    expect(logger.info).toHaveBeenCalledOnce()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(firstCallMsg(logger.info)).toBe('audit: auth.logout')
    expect(firstCallCtx(logger.info)).toMatchObject({kind: 'auth.logout', correlationId: 'corr-004', githubUserId: 42})
  })

  it('redacts sensitive values planted in correlationId', () => {
    // #given
    for (const planted of [
      PLANTED_COOKIE,
      PLANTED_TOKEN,
      PLANTED_BEARER,
      PLANTED_SECRET,
      PLANTED_PROMPT,
      PLANTED_INTERNAL_URL,
    ]) {
      const logger = makeLogger()
      const event: AuditEvent = {kind: 'auth.logout', correlationId: planted, githubUserId: 42}

      // #when
      emitAudit(event, logger)

      // #then
      assertNoSensitiveValues(logger)
    }
  })
})

// ---------------------------------------------------------------------------
// auth.revocation
// ---------------------------------------------------------------------------

describe('emitAudit — auth.revocation', () => {
  it('emits a structured info record with expected fields', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {
      kind: 'auth.revocation',
      correlationId: 'corr-005',
      githubUserId: 42,
    }

    // #when
    emitAudit(event, logger)

    // #then
    expect(logger.info).toHaveBeenCalledOnce()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(firstCallMsg(logger.info)).toBe('audit: auth.revocation')
    expect(firstCallCtx(logger.info)).toMatchObject({
      kind: 'auth.revocation',
      correlationId: 'corr-005',
      githubUserId: 42,
    })
  })

  it('redacts sensitive values planted in correlationId', () => {
    // #given
    for (const planted of [
      PLANTED_COOKIE,
      PLANTED_TOKEN,
      PLANTED_BEARER,
      PLANTED_SECRET,
      PLANTED_PROMPT,
      PLANTED_INTERNAL_URL,
    ]) {
      const logger = makeLogger()
      const event: AuditEvent = {kind: 'auth.revocation', correlationId: planted, githubUserId: 42}

      // #when
      emitAudit(event, logger)

      // #then
      assertNoSensitiveValues(logger)
    }
  })
})

// ---------------------------------------------------------------------------
// authz.denied
// ---------------------------------------------------------------------------

describe('emitAudit — authz.denied', () => {
  it('emits a structured warn record with expected fields', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {
      kind: 'authz.denied',
      correlationId: 'corr-006',
      githubUserId: 42,
      reason: 'not_allowlisted',
    }

    // #when
    emitAudit(event, logger)

    // #then
    expect(logger.warn).toHaveBeenCalledOnce()
    expect(logger.info).not.toHaveBeenCalled()
    expect(firstCallMsg(logger.warn)).toBe('audit: authz.denied')
    expect(firstCallCtx(logger.warn)).toMatchObject({
      kind: 'authz.denied',
      correlationId: 'corr-006',
      githubUserId: 42,
      reason: 'not_allowlisted',
    })
  })

  it('redacts sensitive values planted in correlationId; reason enum is preserved', () => {
    // #given
    for (const planted of [
      PLANTED_COOKIE,
      PLANTED_TOKEN,
      PLANTED_BEARER,
      PLANTED_SECRET,
      PLANTED_PROMPT,
      PLANTED_INTERNAL_URL,
    ]) {
      const logger = makeLogger()
      const event: AuditEvent = {
        kind: 'authz.denied',
        correlationId: planted,
        githubUserId: 42,
        reason: 'not_allowlisted',
      }

      // #when
      emitAudit(event, logger)

      // #then
      assertNoSensitiveValues(logger)
      expect(serializeAllCalls(logger)).toContain('not_allowlisted')
    }
  })
})

// ---------------------------------------------------------------------------
// launch.accepted
// ---------------------------------------------------------------------------

describe('emitAudit — launch.accepted', () => {
  it('emits a structured info record with expected fields', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {
      kind: 'launch.accepted',
      correlationId: 'corr-007',
      githubUserId: 42,
      repoFullName: 'org/repo',
    }

    // #when
    emitAudit(event, logger)

    // #then
    expect(logger.info).toHaveBeenCalledOnce()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(firstCallMsg(logger.info)).toBe('audit: launch.accepted')
    expect(firstCallCtx(logger.info)).toMatchObject({
      kind: 'launch.accepted',
      correlationId: 'corr-007',
      githubUserId: 42,
      repoFullName: 'org/repo',
    })
  })

  it('redacts sensitive values planted in correlationId and repoFullName', () => {
    // #given — plant each sentinel in both caller-controlled string fields
    for (const planted of [
      PLANTED_COOKIE,
      PLANTED_TOKEN,
      PLANTED_BEARER,
      PLANTED_SECRET,
      PLANTED_PROMPT,
      PLANTED_INTERNAL_URL,
    ]) {
      const logger = makeLogger()
      const event: AuditEvent = {
        kind: 'launch.accepted',
        correlationId: planted,
        githubUserId: 42,
        repoFullName: planted,
      }

      // #when
      emitAudit(event, logger)

      // #then
      assertNoSensitiveValues(logger)
    }
  })
})

// ---------------------------------------------------------------------------
// launch.rejected
// ---------------------------------------------------------------------------

describe('emitAudit — launch.rejected', () => {
  it('emits a structured warn record with expected fields', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {
      kind: 'launch.rejected',
      correlationId: 'corr-008',
      githubUserId: 42,
      reason: 'binding_not_found',
    }

    // #when
    emitAudit(event, logger)

    // #then
    expect(logger.warn).toHaveBeenCalledOnce()
    expect(logger.info).not.toHaveBeenCalled()
    expect(firstCallMsg(logger.warn)).toBe('audit: launch.rejected')
    expect(firstCallCtx(logger.warn)).toMatchObject({
      kind: 'launch.rejected',
      correlationId: 'corr-008',
      githubUserId: 42,
      reason: 'binding_not_found',
    })
  })

  it('redacts sensitive values planted in correlationId; reason enum is preserved', () => {
    // #given
    for (const planted of [
      PLANTED_COOKIE,
      PLANTED_TOKEN,
      PLANTED_BEARER,
      PLANTED_SECRET,
      PLANTED_PROMPT,
      PLANTED_INTERNAL_URL,
    ]) {
      const logger = makeLogger()
      const event: AuditEvent = {
        kind: 'launch.rejected',
        correlationId: planted,
        githubUserId: 42,
        reason: 'binding_not_found',
      }

      // #when
      emitAudit(event, logger)

      // #then
      assertNoSensitiveValues(logger)
      expect(serializeAllCalls(logger)).toContain('binding_not_found')
    }
  })
})

// ---------------------------------------------------------------------------
// approval.decision
// ---------------------------------------------------------------------------

describe('emitAudit — approval.decision', () => {
  it('emits a structured info record with expected fields', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {
      kind: 'approval.decision',
      correlationId: 'corr-009',
      githubUserId: 42,
      requestId: 'req-abc',
      decision: 'once',
    }

    // #when
    emitAudit(event, logger)

    // #then
    expect(logger.info).toHaveBeenCalledOnce()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(firstCallMsg(logger.info)).toBe('audit: approval.decision')
    expect(firstCallCtx(logger.info)).toMatchObject({
      kind: 'approval.decision',
      correlationId: 'corr-009',
      githubUserId: 42,
      requestId: 'req-abc',
      decision: 'once',
    })
  })

  it('redacts sensitive values planted in correlationId and requestId', () => {
    // #given — plant each sentinel in both caller-controlled string fields
    for (const planted of [
      PLANTED_COOKIE,
      PLANTED_TOKEN,
      PLANTED_BEARER,
      PLANTED_SECRET,
      PLANTED_PROMPT,
      PLANTED_INTERNAL_URL,
    ]) {
      const logger = makeLogger()
      const event: AuditEvent = {
        kind: 'approval.decision',
        correlationId: planted,
        githubUserId: 42,
        requestId: planted,
        decision: 'reject',
      }

      // #when
      emitAudit(event, logger)

      // #then
      assertNoSensitiveValues(logger)
    }
  })
})

// ---------------------------------------------------------------------------
// approval.rejected — per-reason log level
// ---------------------------------------------------------------------------

describe('emitAudit — approval.rejected', () => {
  it('already_claimed → INFO (benign: expected single-winner race outcome)', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {
      kind: 'approval.rejected',
      correlationId: 'corr-010',
      githubUserId: 42,
      requestId: 'req-abc',
      reason: 'already_claimed',
    }

    // #when
    emitAudit(event, logger)

    // #then — benign reason logs at INFO, not WARN
    expect(logger.info).toHaveBeenCalledOnce()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(firstCallMsg(logger.info)).toBe('audit: approval.rejected')
    expect(firstCallCtx(logger.info)).toMatchObject({
      kind: 'approval.rejected',
      correlationId: 'corr-010',
      githubUserId: 42,
      requestId: 'req-abc',
      reason: 'already_claimed',
    })
  })

  it('not_found → INFO (benign: stale or duplicate request)', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {
      kind: 'approval.rejected',
      correlationId: 'corr-010b',
      githubUserId: 42,
      requestId: 'req-gone',
      reason: 'not_found',
    }

    // #when
    emitAudit(event, logger)

    // #then — benign reason logs at INFO, not WARN
    expect(logger.info).toHaveBeenCalledOnce()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(firstCallCtx(logger.info)).toMatchObject({reason: 'not_found'})
  })

  it('scope_mismatch → WARN (security signal: cross-scope settlement attempt)', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {
      kind: 'approval.rejected',
      correlationId: 'corr-010c',
      githubUserId: 42,
      requestId: 'req-cross',
      reason: 'scope_mismatch',
    }

    // #when
    emitAudit(event, logger)

    // #then — anomalous reason logs at WARN
    expect(logger.warn).toHaveBeenCalledOnce()
    expect(logger.info).not.toHaveBeenCalled()
    expect(firstCallCtx(logger.warn)).toMatchObject({reason: 'scope_mismatch'})
  })

  it('unknown → WARN (operational anomaly: settlement failure)', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {
      kind: 'approval.rejected',
      correlationId: 'corr-010d',
      githubUserId: 42,
      requestId: 'req-fail',
      reason: 'unknown',
    }

    // #when
    emitAudit(event, logger)

    // #then — operational anomaly logs at WARN
    expect(logger.warn).toHaveBeenCalledOnce()
    expect(logger.info).not.toHaveBeenCalled()
    expect(firstCallCtx(logger.warn)).toMatchObject({reason: 'unknown'})
  })

  it('deadline_expired → WARN (registry-internal path; kept in taxonomy)', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {
      kind: 'approval.rejected',
      correlationId: 'corr-010e',
      githubUserId: 42,
      requestId: 'req-expired',
      reason: 'deadline_expired',
    }

    // #when
    emitAudit(event, logger)

    // #then — deadline expiry logs at WARN
    expect(logger.warn).toHaveBeenCalledOnce()
    expect(logger.info).not.toHaveBeenCalled()
    expect(firstCallCtx(logger.warn)).toMatchObject({reason: 'deadline_expired'})
  })

  it('redacts sensitive values planted in correlationId and requestId; reason enum is preserved', () => {
    // #given
    for (const planted of [
      PLANTED_COOKIE,
      PLANTED_TOKEN,
      PLANTED_BEARER,
      PLANTED_SECRET,
      PLANTED_PROMPT,
      PLANTED_INTERNAL_URL,
    ]) {
      const logger = makeLogger()
      const event: AuditEvent = {
        kind: 'approval.rejected',
        correlationId: planted,
        githubUserId: 42,
        requestId: planted,
        reason: 'already_claimed',
      }

      // #when
      emitAudit(event, logger)

      // #then
      assertNoSensitiveValues(logger)
      expect(serializeAllCalls(logger)).toContain('already_claimed')
    }
  })
})

// ---------------------------------------------------------------------------
// binding.read
// ---------------------------------------------------------------------------

describe('emitAudit — binding.read', () => {
  it('emits a structured info record with expected fields', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {
      kind: 'binding.read',
      correlationId: 'corr-011',
      githubUserId: 42,
      repoFullName: 'org/repo',
    }

    // #when
    emitAudit(event, logger)

    // #then
    expect(logger.info).toHaveBeenCalledOnce()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(firstCallMsg(logger.info)).toBe('audit: binding.read')
    expect(firstCallCtx(logger.info)).toMatchObject({
      kind: 'binding.read',
      correlationId: 'corr-011',
      githubUserId: 42,
      repoFullName: 'org/repo',
    })
  })

  it('redacts sensitive values planted in correlationId and repoFullName', () => {
    // #given
    for (const planted of [
      PLANTED_COOKIE,
      PLANTED_TOKEN,
      PLANTED_BEARER,
      PLANTED_SECRET,
      PLANTED_PROMPT,
      PLANTED_INTERNAL_URL,
    ]) {
      const logger = makeLogger()
      const event: AuditEvent = {
        kind: 'binding.read',
        correlationId: planted,
        githubUserId: 42,
        repoFullName: planted,
      }

      // #when
      emitAudit(event, logger)

      // #then
      assertNoSensitiveValues(logger)
    }
  })
})

// ---------------------------------------------------------------------------
// bearer.rejected — critical: credential must never appear in log output
// ---------------------------------------------------------------------------

describe('emitAudit — bearer.rejected', () => {
  it('emits a structured warn record with expected fields', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {
      kind: 'bearer.rejected',
      correlationId: 'corr-012',
      reason: 'invalid_signature',
    }

    // #when
    emitAudit(event, logger)

    // #then
    expect(logger.warn).toHaveBeenCalledOnce()
    expect(logger.info).not.toHaveBeenCalled()
    expect(firstCallMsg(logger.warn)).toBe('audit: bearer.rejected')
    expect(firstCallCtx(logger.warn)).toMatchObject({
      kind: 'bearer.rejected',
      correlationId: 'corr-012',
      reason: 'invalid_signature',
    })
  })

  it('redacts sensitive values planted in correlationId; reason enum and kind are preserved', () => {
    // #given — plant each sentinel in correlationId
    for (const planted of [
      PLANTED_COOKIE,
      PLANTED_TOKEN,
      PLANTED_BEARER,
      PLANTED_SECRET,
      PLANTED_PROMPT,
      PLANTED_INTERNAL_URL,
    ]) {
      const logger = makeLogger()
      const event: AuditEvent = {
        kind: 'bearer.rejected',
        correlationId: planted,
        reason: 'expired',
      }

      // #when
      emitAudit(event, logger)

      // #then
      assertNoSensitiveValues(logger)
      // Safe enum reason and kind must survive redaction
      const serialized = serializeAllCalls(logger)
      expect(serialized).toContain('expired')
      expect(serialized).toContain('bearer.rejected')
    }
  })

  it('emits no sensitive values for missing_token reason', () => {
    // #given
    for (const planted of [
      PLANTED_COOKIE,
      PLANTED_TOKEN,
      PLANTED_BEARER,
      PLANTED_SECRET,
      PLANTED_PROMPT,
      PLANTED_INTERNAL_URL,
    ]) {
      const logger = makeLogger()
      const event: AuditEvent = {
        kind: 'bearer.rejected',
        correlationId: planted,
        reason: 'missing_token',
      }

      // #when
      emitAudit(event, logger)

      // #then
      assertNoSensitiveValues(logger)
    }
  })
})

// ---------------------------------------------------------------------------
// Redaction — embedded / edge-case patterns
// ---------------------------------------------------------------------------

describe('emitAudit — redaction edge cases', () => {
  it('redacts GitHub tokens embedded mid-string (no ^ anchor)', () => {
    // #given — token embedded inside a longer string
    const logger = makeLogger()
    const event: AuditEvent = {kind: 'auth.start', correlationId: 'prefix-ghp_SUPERSECRETTOKEN-suffix'}

    // #when
    emitAudit(event, logger)

    // #then
    expect(serializeAllCalls(logger)).not.toContain('ghp_SUPERSECRETTOKEN')
  })

  it('redacts lowercase bearer token', () => {
    // #given — lowercase "bearer" header value
    const logger = makeLogger()
    const event: AuditEvent = {kind: 'auth.start', correlationId: 'bearer eyJhbGciOiJSUzI1NiJ9.SECRET'}

    // #when
    emitAudit(event, logger)

    // #then
    expect(serializeAllCalls(logger)).not.toContain('eyJhbGciOiJSUzI1NiJ9.SECRET')
  })

  it('redacts mixed-case bearer token', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {kind: 'auth.start', correlationId: 'BEARER eyJhbGciOiJSUzI1NiJ9.SECRET'}

    // #when
    emitAudit(event, logger)

    // #then
    expect(serializeAllCalls(logger)).not.toContain('eyJhbGciOiJSUzI1NiJ9.SECRET')
  })

  it('redacts bare http://localhost URL (no trailing slash)', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {kind: 'auth.start', correlationId: 'http://localhost'}

    // #when
    emitAudit(event, logger)

    // #then
    expect(serializeAllCalls(logger)).not.toContain('http://localhost')
  })

  it('redacts http://localhost with path', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {kind: 'auth.start', correlationId: 'http://localhost/api/secret'}

    // #when
    emitAudit(event, logger)

    // #then
    expect(serializeAllCalls(logger)).not.toContain('http://localhost/api/secret')
  })

  it('redacts http://localhost with port', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {kind: 'auth.start', correlationId: 'http://localhost:3000/api'}

    // #when
    emitAudit(event, logger)

    // #then
    expect(serializeAllCalls(logger)).not.toContain('http://localhost:3000/api')
  })

  it('redacts host.docker.internal URL', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {kind: 'auth.start', correlationId: 'http://host.docker.internal/service'}

    // #when
    emitAudit(event, logger)

    // #then
    expect(serializeAllCalls(logger)).not.toContain('host.docker.internal')
  })

  it('redacts svc.cluster.local URL', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {kind: 'auth.start', correlationId: 'http://myservice.svc.cluster.local/api'}

    // #when
    emitAudit(event, logger)

    // #then
    expect(serializeAllCalls(logger)).not.toContain('myservice.svc.cluster.local')
  })

  it('redacts common cookie names: sid', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {kind: 'auth.start', correlationId: 'sid=abc123secret'}

    // #when
    emitAudit(event, logger)

    // #then
    expect(serializeAllCalls(logger)).not.toContain('abc123secret')
  })

  it('redacts common cookie names: sessionid', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {kind: 'auth.start', correlationId: 'sessionid=abc123secret'}

    // #when
    emitAudit(event, logger)

    // #then
    expect(serializeAllCalls(logger)).not.toContain('abc123secret')
  })

  it('redacts common cookie names: connect.sid', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {kind: 'auth.start', correlationId: 'connect.sid=abc123secret'}

    // #when
    emitAudit(event, logger)

    // #then
    expect(serializeAllCalls(logger)).not.toContain('abc123secret')
  })
})

// ---------------------------------------------------------------------------
// browser.guard.rejected
// ---------------------------------------------------------------------------

describe('emitAudit — browser.guard.rejected', () => {
  it('emits a structured warn record with expected fields', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {
      kind: 'browser.guard.rejected',
      correlationId: 'corr-014',
      reason: 'origin_mismatch',
    }

    // #when
    emitAudit(event, logger)

    // #then
    expect(logger.warn).toHaveBeenCalledOnce()
    expect(logger.info).not.toHaveBeenCalled()
    expect(firstCallMsg(logger.warn)).toBe('audit: browser.guard.rejected')
    expect(firstCallCtx(logger.warn)).toMatchObject({
      kind: 'browser.guard.rejected',
      correlationId: 'corr-014',
      reason: 'origin_mismatch',
    })
  })

  it('redacts sensitive values planted in correlationId; reason enum is preserved', () => {
    // #given
    for (const planted of [
      PLANTED_COOKIE,
      PLANTED_TOKEN,
      PLANTED_BEARER,
      PLANTED_SECRET,
      PLANTED_PROMPT,
      PLANTED_INTERNAL_URL,
    ]) {
      const logger = makeLogger()
      const event: AuditEvent = {
        kind: 'browser.guard.rejected',
        correlationId: planted,
        reason: 'fetch_site_cross_site',
      }

      // #when
      emitAudit(event, logger)

      // #then
      assertNoSensitiveValues(logger)
      expect(serializeAllCalls(logger)).toContain('fetch_site_cross_site')
    }
  })
})

// ---------------------------------------------------------------------------
// approval.decision — extended decision enum (once | always | reject)
// ---------------------------------------------------------------------------

describe('emitAudit — approval.decision with once/always/reject', () => {
  it('emits a structured info record with decision:"once"', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {
      kind: 'approval.decision',
      correlationId: 'corr-once',
      githubUserId: 42,
      requestId: 'req-once',
      decision: 'once',
    }

    // #when
    emitAudit(event, logger)

    // #then
    expect(logger.info).toHaveBeenCalledOnce()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(firstCallMsg(logger.info)).toBe('audit: approval.decision')
    expect(firstCallCtx(logger.info)).toMatchObject({
      kind: 'approval.decision',
      decision: 'once',
      requestId: 'req-once',
    })
  })

  it('emits a structured info record with decision:"always"', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {
      kind: 'approval.decision',
      correlationId: 'corr-always',
      githubUserId: 42,
      requestId: 'req-always',
      decision: 'always',
    }

    // #when
    emitAudit(event, logger)

    // #then
    expect(logger.info).toHaveBeenCalledOnce()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(firstCallCtx(logger.info)).toMatchObject({decision: 'always'})
  })

  it('emits a structured info record with decision:"reject"', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {
      kind: 'approval.decision',
      correlationId: 'corr-reject',
      githubUserId: 42,
      requestId: 'req-reject',
      decision: 'reject',
    }

    // #when
    emitAudit(event, logger)

    // #then
    expect(logger.info).toHaveBeenCalledOnce()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(firstCallCtx(logger.info)).toMatchObject({decision: 'reject'})
  })

  it('"always" and "once" emit distinctly (different decision field values)', () => {
    // #given
    const loggerOnce = makeLogger()
    const loggerAlways = makeLogger()
    const eventOnce: AuditEvent = {
      kind: 'approval.decision',
      correlationId: 'corr-d1',
      githubUserId: 42,
      requestId: 'req-d1',
      decision: 'once',
    }
    const eventAlways: AuditEvent = {
      kind: 'approval.decision',
      correlationId: 'corr-d2',
      githubUserId: 42,
      requestId: 'req-d2',
      decision: 'always',
    }

    // #when
    emitAudit(eventOnce, loggerOnce)
    emitAudit(eventAlways, loggerAlways)

    // #then — decision values are distinct
    expect(firstCallCtx(loggerOnce.info)).toMatchObject({decision: 'once'})
    expect(firstCallCtx(loggerAlways.info)).toMatchObject({decision: 'always'})
    expect(firstCallCtx(loggerOnce.info).decision).not.toBe(firstCallCtx(loggerAlways.info).decision)
  })

  it('redacts sensitive values in correlationId and requestId for all new decision values', () => {
    // #given
    for (const decision of ['once', 'always', 'reject'] as const) {
      for (const planted of [PLANTED_COOKIE, PLANTED_TOKEN, PLANTED_BEARER, PLANTED_SECRET]) {
        const logger = makeLogger()
        const event: AuditEvent = {
          kind: 'approval.decision',
          correlationId: planted,
          githubUserId: 42,
          requestId: planted,
          decision,
        }

        // #when
        emitAudit(event, logger)

        // #then
        assertNoSensitiveValues(logger)
        // decision enum value must survive
        expect(serializeAllCalls(logger)).toContain(decision)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// authz.denied — insufficient_permission reason
// ---------------------------------------------------------------------------

describe('emitAudit — authz.denied with insufficient_permission', () => {
  it('emits a structured warn record with reason:"insufficient_permission"', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {
      kind: 'authz.denied',
      correlationId: 'corr-insuf',
      githubUserId: 42,
      reason: 'insufficient_permission',
    }

    // #when
    emitAudit(event, logger)

    // #then
    expect(logger.warn).toHaveBeenCalledOnce()
    expect(logger.info).not.toHaveBeenCalled()
    expect(firstCallCtx(logger.warn)).toMatchObject({
      kind: 'authz.denied',
      reason: 'insufficient_permission',
    })
  })

  it('reason enum "insufficient_permission" survives redaction', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {
      kind: 'authz.denied',
      correlationId: PLANTED_TOKEN,
      githubUserId: 42,
      reason: 'insufficient_permission',
    }

    // #when
    emitAudit(event, logger)

    // #then
    assertNoSensitiveValues(logger)
    expect(serializeAllCalls(logger)).toContain('insufficient_permission')
  })
})

// ---------------------------------------------------------------------------
// push.subscribed / push.unsubscribed
// ---------------------------------------------------------------------------

describe('emitAudit — push.subscribed', () => {
  it('emits a structured info record with expected fields', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {kind: 'push.subscribed', correlationId: 'corr-push-1', githubUserId: 42}

    // #when
    emitAudit(event, logger)

    // #then
    expect(logger.info).toHaveBeenCalledOnce()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(firstCallMsg(logger.info)).toBe('audit: push.subscribed')
    expect(firstCallCtx(logger.info)).toMatchObject({
      kind: 'push.subscribed',
      correlationId: 'corr-push-1',
      githubUserId: 42,
    })
  })

  it('redacts sensitive values planted in correlationId', () => {
    // #given
    for (const planted of [PLANTED_COOKIE, PLANTED_TOKEN, PLANTED_BEARER, PLANTED_SECRET, PLANTED_PROMPT]) {
      const logger = makeLogger()
      const event: AuditEvent = {kind: 'push.subscribed', correlationId: planted, githubUserId: 42}

      // #when
      emitAudit(event, logger)

      // #then
      assertNoSensitiveValues(logger)
    }
  })
})

describe('emitAudit — push.unsubscribed', () => {
  it('emits a structured info record with expected fields', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {kind: 'push.unsubscribed', correlationId: 'corr-push-2', githubUserId: 42}

    // #when
    emitAudit(event, logger)

    // #then
    expect(logger.info).toHaveBeenCalledOnce()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(firstCallMsg(logger.info)).toBe('audit: push.unsubscribed')
    expect(firstCallCtx(logger.info)).toMatchObject({
      kind: 'push.unsubscribed',
      correlationId: 'corr-push-2',
      githubUserId: 42,
    })
  })
})

// ---------------------------------------------------------------------------
// push.subscription.deactivated
// ---------------------------------------------------------------------------

describe('emitAudit — push.subscription.deactivated', () => {
  it('emits a structured info record with expected fields', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {
      kind: 'push.subscription.deactivated',
      correlationId: 'corr-push-3',
      githubUserId: 42,
      reason: 'session_revoked',
    }

    // #when
    emitAudit(event, logger)

    // #then
    expect(logger.info).toHaveBeenCalledOnce()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(firstCallCtx(logger.info)).toMatchObject({
      kind: 'push.subscription.deactivated',
      githubUserId: 42,
      reason: 'session_revoked',
    })
  })
})

// ---------------------------------------------------------------------------
// push.dispatch
// ---------------------------------------------------------------------------

describe('emitAudit — push.dispatch', () => {
  it('emits a structured info record carrying only trigger and coarse counts', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {
      kind: 'push.dispatch',
      correlationId: 'approval-123',
      trigger: 'approval',
      delivered: 2,
      dead: 1,
      failed: 0,
    }

    // #when
    emitAudit(event, logger)

    // #then
    expect(logger.info).toHaveBeenCalledOnce()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(firstCallMsg(logger.info)).toBe('audit: push.dispatch')
    expect(firstCallCtx(logger.info)).toMatchObject({
      kind: 'push.dispatch',
      correlationId: 'approval-123',
      trigger: 'approval',
      delivered: 2,
      dead: 1,
      failed: 0,
    })
    // Structural: the recorded context must never carry an endpoint, key, or payload field.
    const ctx = firstCallCtx(logger.info)
    expect(Object.keys(ctx).sort()).toEqual(['correlationId', 'dead', 'delivered', 'failed', 'kind', 'trigger'].sort())
  })

  it('redacts sensitive values planted in correlationId', () => {
    // #given
    for (const planted of [PLANTED_COOKIE, PLANTED_TOKEN, PLANTED_BEARER, PLANTED_SECRET, PLANTED_PROMPT]) {
      const logger = makeLogger()
      const event: AuditEvent = {
        kind: 'push.dispatch',
        correlationId: planted,
        trigger: 'run_failed',
        delivered: 0,
        dead: 0,
        failed: 1,
      }

      // #when
      emitAudit(event, logger)

      // #then
      assertNoSensitiveValues(logger)
    }
  })
})

// ---------------------------------------------------------------------------
// push.disabled
// ---------------------------------------------------------------------------

describe('emitAudit — push.disabled', () => {
  it('logs config_absent at info level', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {kind: 'push.disabled', correlationId: 'startup', reason: 'config_absent'}

    // #when
    emitAudit(event, logger)

    // #then
    expect(logger.info).toHaveBeenCalledOnce()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(firstCallCtx(logger.info)).toMatchObject({kind: 'push.disabled', reason: 'config_absent'})
  })

  it('logs self_test_failed at warn level', () => {
    // #given
    const logger = makeLogger()
    const event: AuditEvent = {kind: 'push.disabled', correlationId: 'startup', reason: 'self_test_failed'}

    // #when
    emitAudit(event, logger)

    // #then
    expect(logger.warn).toHaveBeenCalledOnce()
    expect(logger.info).not.toHaveBeenCalled()
    expect(firstCallCtx(logger.warn)).toMatchObject({kind: 'push.disabled', reason: 'self_test_failed'})
  })
})

// ---------------------------------------------------------------------------
// Sink resilience — throwing logger must not propagate
// ---------------------------------------------------------------------------

describe('emitAudit — sink failure resilience', () => {
  it('does not throw when logger.info throws', () => {
    // #given
    const logger: AuditLogger = {
      info: () => {
        throw new Error('sink exploded')
      },
      warn: vi.fn<LogFn>(),
    }
    const event: AuditEvent = {kind: 'auth.start', correlationId: 'corr-resilience-1'}

    // #when / #then — must not throw
    expect(() => emitAudit(event, logger)).not.toThrow()
  })

  it('does not throw when logger.warn throws', () => {
    // #given
    const logger: AuditLogger = {
      info: vi.fn<LogFn>(),
      warn: () => {
        throw new Error('sink exploded')
      },
    }
    const event: AuditEvent = {kind: 'bearer.rejected', correlationId: 'corr-resilience-2', reason: 'expired'}

    // #when / #then — must not throw
    expect(() => emitAudit(event, logger)).not.toThrow()
  })
})
