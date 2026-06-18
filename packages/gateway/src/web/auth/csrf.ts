/**
 * CSRF token module for the operator web surface.
 *
 * Implements signed, session-bound CSRF tokens using HMAC-SHA256.
 * Tokens are bound to session ID, operator ID, and a 15-minute interval.
 * A 30-second grace window allows the previous interval's token to remain valid
 * during rotation.
 *
 * Security invariants:
 *   - Tokens are signed with a separate CSRF signing key (never reuse session secret).
 *   - Tokens are bound to session ID + operator ID + interval.
 *   - Verification uses timing-safe comparison (timingSafeEqual).
 *   - Tokens are never logged, never in query/body, never in cookies.
 *   - Token format: base64url(payload).base64url(hmac)
 *   - Payload: JSON {sid, oid, iv} where iv = Math.floor(nowMs / INTERVAL_MS)
 *
 * Browser-origin guard middleware:
 *   - Rejects non-cookie credential schemes (Authorization, Proxy-Authorization, X-API-Key).
 *   - Validates Origin exactly against canonical publicOrigin.
 *   - Rejects Origin: null.
 *   - Uses Fetch Metadata fallback when Origin is absent.
 *   - Rejects unsafe Fetch Metadata combinations.
 *   - Verifies signed CSRF token for mutating routes.
 *   - Adds Vary header on rejection responses.
 */

import type {Context} from 'hono'
import type {AuditLogger, BrowserGuardRejectedReason} from '../audit.js'
import type {OperatorAllowlist} from './allowlist.js'
import type {SessionStore} from './session.js'
import {Buffer} from 'node:buffer'
import {createHmac, timingSafeEqual} from 'node:crypto'
import {emitAudit} from '../audit.js'
import {parseSessionCookie} from './session.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** CSRF token rotation interval: 15 minutes. */
export const CSRF_TOKEN_INTERVAL_MS = 15 * 60 * 1000

/** Grace window for the previous interval's token: 30 seconds. */
export const CSRF_TOKEN_GRACE_MS = 30 * 1000

/** Header name for CSRF token on mutating requests. */
export const CSRF_TOKEN_HEADER = 'x-csrf-token'

/** Vary header value to add on CSRF/origin/fetch-metadata rejection responses. */
const VARY_HEADER = 'Origin, Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parameters for generating a CSRF token. */
export interface GenerateCsrfTokenParams {
  readonly sessionId: string
  readonly operatorId: number
  readonly nowMs: number
  readonly secret: string
}

/** Parameters for verifying a CSRF token. */
export interface VerifyCsrfTokenParams {
  readonly token: string
  readonly sessionId: string
  readonly operatorId: number
  readonly nowMs: number
  readonly secret: string
}

/** Result of CSRF token verification. */
export type VerifyCsrfTokenResult = {readonly ok: true} | {readonly ok: false; readonly reason: string}

/** Logger interface for the CSRF/browser-guard module. */
export interface CsrfLogger {
  readonly debug: (ctx: Record<string, unknown>, msg: string) => void
  readonly info: (ctx: Record<string, unknown>, msg: string) => void
  readonly warn: (ctx: Record<string, unknown>, msg: string) => void
  readonly error: (ctx: Record<string, unknown>, msg: string) => void
}

/** Dependencies for the browser-origin guard middleware. */
export interface BrowserGuardDeps {
  readonly logger: CsrfLogger
  readonly auditLogger: AuditLogger
  readonly sessionStore: SessionStore
  readonly allowlist: OperatorAllowlist
  readonly csrfSecret: string
  readonly publicOrigin: string
  readonly clock: () => number
}

// ---------------------------------------------------------------------------
// CSRF token payload
// ---------------------------------------------------------------------------

interface CsrfPayload {
  readonly sid: string
  readonly oid: number
  readonly iv: number
}

function buildPayload(sessionId: string, operatorId: number, intervalIndex: number): string {
  const payload: CsrfPayload = {sid: sessionId, oid: operatorId, iv: intervalIndex}
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

function computeHmac(payloadB64: string, secret: string): string {
  const keyBytes = Buffer.from(secret, 'base64url')
  return createHmac('sha256', keyBytes).update(payloadB64).digest('base64url')
}

function intervalIndex(nowMs: number): number {
  return Math.floor(nowMs / CSRF_TOKEN_INTERVAL_MS)
}

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

/**
 * Generate a signed CSRF token bound to the given session and operator.
 *
 * Token format: base64url(payload).base64url(hmac)
 * Payload: JSON {sid, oid, iv} where iv = Math.floor(nowMs / INTERVAL_MS)
 *
 * The token is deterministic within a 15-minute interval for the same inputs.
 */
export function generateCsrfToken(params: GenerateCsrfTokenParams): string {
  const {sessionId, operatorId, nowMs, secret} = params
  const iv = intervalIndex(nowMs)
  const payloadB64 = buildPayload(sessionId, operatorId, iv)
  const sig = computeHmac(payloadB64, secret)
  return `${payloadB64}.${sig}`
}

// ---------------------------------------------------------------------------
// Token verification
// ---------------------------------------------------------------------------

/**
 * Maximum CSRF token length in characters.
 * Tokens are base64url(payload).base64url(hmac) — a legitimate token is well under 512 chars.
 * Rejecting overlong tokens before any Buffer allocation prevents memory exhaustion from
 * crafted inputs.
 */
export const CSRF_TOKEN_MAX_LENGTH = 512

/**
 * Verify a CSRF token against the given session and operator.
 *
 * Accepts tokens from the current interval and the previous interval within
 * the grace window (CSRF_TOKEN_GRACE_MS).
 *
 * Uses timing-safe comparison to prevent timing oracle attacks.
 */
export function verifyCsrfToken(params: VerifyCsrfTokenParams): VerifyCsrfTokenResult {
  const {token, sessionId, operatorId, nowMs, secret} = params

  // Reject overlong tokens before any Buffer allocation — prevents memory exhaustion.
  if (token.length > CSRF_TOKEN_MAX_LENGTH) {
    return {ok: false, reason: 'malformed_token'}
  }

  if (token === '' || token.includes('.') === false) {
    return {ok: false, reason: 'malformed_token'}
  }

  const dotIdx = token.indexOf('.')
  const payloadB64 = token.slice(0, dotIdx)
  const providedSig = token.slice(dotIdx + 1)

  if (payloadB64 === '' || providedSig === '') {
    return {ok: false, reason: 'malformed_token'}
  }

  // Decode and parse payload
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
  } catch {
    return {ok: false, reason: 'malformed_token'}
  }

  if (typeof payload !== 'object' || payload === null) {
    return {ok: false, reason: 'malformed_token'}
  }

  const raw = payload as Record<string, unknown>
  if (typeof raw.sid !== 'string' || typeof raw.oid !== 'number' || typeof raw.iv !== 'number') {
    return {ok: false, reason: 'malformed_token'}
  }

  // Narrow to typed payload after field-type guards above.
  const parsed: CsrfPayload = {sid: raw.sid, oid: raw.oid, iv: raw.iv}

  // Check session and operator binding
  if (parsed.sid !== sessionId || parsed.oid !== operatorId) {
    return {ok: false, reason: 'binding_mismatch'}
  }

  // Check interval — accept current and previous (within grace window)
  const currentIv = intervalIndex(nowMs)
  const prevIv = currentIv - 1
  const tokenIv = parsed.iv

  let isValidInterval = false
  if (tokenIv === currentIv) {
    isValidInterval = true
  } else if (tokenIv === prevIv) {
    // Previous interval — only valid within grace window
    const intervalBoundaryMs = currentIv * CSRF_TOKEN_INTERVAL_MS
    const msSinceBoundary = nowMs - intervalBoundaryMs
    if (msSinceBoundary <= CSRF_TOKEN_GRACE_MS) {
      isValidInterval = true
    }
  }

  if (isValidInterval === false) {
    return {ok: false, reason: 'expired'}
  }

  // Timing-safe signature verification
  const expectedSig = computeHmac(payloadB64, secret)

  let sigsMatch = false
  try {
    const expectedBuf = Buffer.from(expectedSig, 'base64url')
    const providedBuf = Buffer.from(providedSig, 'base64url')
    // timingSafeEqual requires same-length buffers; pad/truncate to expected length
    if (expectedBuf.length === providedBuf.length) {
      sigsMatch = timingSafeEqual(expectedBuf, providedBuf)
    } else {
      // Different lengths — still do a timing-safe compare against a dummy to avoid
      // short-circuit timing leak, then return false
      timingSafeEqual(expectedBuf, expectedBuf)
      sigsMatch = false
    }
  } catch {
    return {ok: false, reason: 'malformed_token'}
  }

  if (sigsMatch === false) {
    return {ok: false, reason: 'invalid_signature'}
  }

  return {ok: true}
}

// ---------------------------------------------------------------------------
// Browser-origin guard middleware
// ---------------------------------------------------------------------------

/**
 * Determine if the request uses a non-cookie credential scheme.
 * Returns the header name (without value) if a non-cookie credential is present.
 */
function detectNonCookieCredential(c: Context): string | null {
  if (c.req.header('authorization') !== undefined) return 'Authorization'
  if (c.req.header('proxy-authorization') !== undefined) return 'Proxy-Authorization'
  if (c.req.header('x-api-key') !== undefined) return 'X-API-Key'
  return null
}

/**
 * Safe methods that do not require CSRF protection.
 * GET, HEAD, OPTIONS are safe (no state mutation).
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Add Vary header for CSRF/origin/fetch-metadata rejection responses.
 */
function addVaryHeader(c: Context): void {
  c.header('Vary', VARY_HEADER)
}

/**
 * Validate the Origin header against the canonical public origin.
 *
 * Returns true if the origin is valid (matches publicOrigin or absent for safe methods).
 * Returns false if the origin is null, mismatched, or absent for mutating methods.
 *
 * Security: absent Origin on mutating requests is rejected. Fetch Metadata fallback
 * is checked separately — if Sec-Fetch-Site is present and indicates same-origin/none,
 * the caller may allow the request. But absent Origin alone on a mutating request is
 * not sufficient — the caller must check Fetch Metadata before allowing.
 */
function validateOrigin(
  originHeader: string | undefined,
  publicOrigin: string,
  method: string,
): {readonly ok: boolean; readonly reason?: BrowserGuardRejectedReason; readonly needsFetchMetadataFallback?: boolean} {
  if (originHeader !== undefined) {
    // Reject Origin: null (opaque origin — cross-site navigation or sandboxed iframe)
    if (originHeader === 'null') {
      return {ok: false, reason: 'origin_null'}
    }

    // Exact match against canonical public origin
    if (originHeader !== publicOrigin) {
      return {ok: false, reason: 'origin_mismatch'}
    }

    return {ok: true}
  }

  // Origin absent — safe methods are allowed (no mutation risk)
  if (SAFE_METHODS.has(method)) {
    return {ok: true}
  }

  // Origin absent on mutating method — signal that Fetch Metadata fallback is needed.
  // The caller must check Fetch Metadata; if absent too, reject.
  return {ok: false, reason: 'origin_missing', needsFetchMetadataFallback: true}
}

/**
 * Validate Fetch Metadata headers for a request.
 *
 * Returns true if the request passes Fetch Metadata checks.
 * Returns false with a reason if the request should be rejected.
 *
 * Rules:
 *   - Sec-Fetch-Site: cross-site → reject (except OAuth callback exemption)
 *   - Sec-Fetch-Site: same-site → reject (same-site is not same-origin)
 *   - Sec-Fetch-Site: same-origin or none → allow
 *   - Sec-Fetch-Mode: navigate or no-cors → reject for mutating JSON routes
 *   - Sec-Fetch-Dest: object or embed → reject when present
 *   - Absent headers → allow (older browsers, direct API calls)
 */
function validateFetchMetadata(
  c: Context,
  method: string,
  isPublicCrossSiteRoute: boolean,
): {readonly ok: boolean; readonly reason?: BrowserGuardRejectedReason} {
  const fetchSite = c.req.header('sec-fetch-site')
  const fetchMode = c.req.header('sec-fetch-mode')
  const fetchDest = c.req.header('sec-fetch-dest')

  // Sec-Fetch-Dest: object or embed — reject when present (plugin/embed context)
  if (fetchDest === 'object' || fetchDest === 'embed') {
    return {ok: false, reason: 'fetch_dest_object_embed'}
  }

  if (fetchSite !== undefined) {
    if (fetchSite === 'cross-site') {
      // OAuth callback is the only cross-site exemption
      if (isPublicCrossSiteRoute === false) {
        return {ok: false, reason: 'fetch_site_cross_site'}
      }
    } else if (fetchSite === 'same-site') {
      // same-site is not same-origin — reject for security
      return {ok: false, reason: 'fetch_site_same_site'}
    }
    // same-origin and none are allowed
  }

  // Sec-Fetch-Mode: navigate or no-cors — reject for mutating JSON routes
  if (fetchMode !== undefined && SAFE_METHODS.has(method) === false) {
    if (fetchMode === 'navigate') {
      return {ok: false, reason: 'fetch_mode_navigate'}
    }
    if (fetchMode === 'no-cors') {
      return {ok: false, reason: 'fetch_mode_no_cors'}
    }
  }

  return {ok: true}
}

/**
 * Apply the browser-origin guard to a request.
 *
 * Checks in order:
 *   a) Reject non-cookie credential schemes
 *   b) Validate session cookie and get session identity
 *   c) Enforce allowlist against session-bound GitHub numeric ID
 *   d) Validate Origin against canonical publicOrigin
 *   e) Validate Fetch Metadata
 *   f) Verify CSRF token for mutating routes
 *
 * Returns the session entry if all checks pass, or a Response to return immediately.
 */
export async function applyBrowserGuard(
  c: Context,
  deps: BrowserGuardDeps,
  isPublicCrossSiteRoute: boolean,
  requireCsrf: boolean,
): Promise<
  | {readonly ok: true; readonly githubUserId: number; readonly sessionId: string}
  | {readonly ok: false; readonly response: Response}
> {
  const method = c.req.method.toUpperCase()

  // a) Reject non-cookie credential schemes — without logging values
  const nonCookieCred = detectNonCookieCredential(c)
  if (nonCookieCred !== null) {
    deps.logger.warn({}, `browser guard: rejected non-cookie credential scheme (${nonCookieCred})`)
    emitAudit(
      {kind: 'browser.guard.rejected', correlationId: 'browser-guard', reason: 'non_cookie_credential'},
      deps.auditLogger,
    )
    addVaryHeader(c)
    return {ok: false, response: c.json({error: 'bad request'}, 400)}
  }

  // b) Validate session cookie
  const cookieHeader = c.req.header('cookie')
  const sessionId = parseSessionCookie(cookieHeader)
  if (sessionId === undefined) {
    deps.logger.warn({}, 'browser guard: no session cookie')
    emitAudit({kind: 'browser.guard.rejected', correlationId: 'browser-guard', reason: 'no_session'}, deps.auditLogger)
    addVaryHeader(c)
    return {ok: false, response: c.json({error: 'unauthorized'}, 401)}
  }

  const nowMs = deps.clock()
  const session = deps.sessionStore.get(sessionId, nowMs)
  if (session === undefined) {
    deps.logger.warn({}, 'browser guard: invalid or expired session')
    emitAudit(
      {kind: 'browser.guard.rejected', correlationId: 'browser-guard', reason: 'invalid_session'},
      deps.auditLogger,
    )
    addVaryHeader(c)
    return {ok: false, response: c.json({error: 'unauthorized'}, 401)}
  }

  const {githubUserId} = session

  // c) Enforce allowlist against session-bound GitHub numeric ID
  // Touch session ONLY after allowlist passes — non-allowlisted sessions must not
  // extend their idle TTL (they should expire naturally).
  if (deps.allowlist.isAuthorized(githubUserId) === false) {
    deps.logger.warn({githubUserId}, 'browser guard: operator not in allowlist')
    emitAudit(
      {kind: 'browser.guard.rejected', correlationId: 'browser-guard', reason: 'not_allowlisted', githubUserId},
      deps.auditLogger,
    )
    addVaryHeader(c)
    return {ok: false, response: c.json({error: 'forbidden'}, 403)}
  }

  // Touch session to extend idle TTL — only after allowlist authorization passes.
  deps.sessionStore.touch(sessionId, nowMs)

  // d) Validate Origin
  const originHeader = c.req.header('origin')
  const originResult = validateOrigin(originHeader, deps.publicOrigin, method)

  if (originResult.ok === false && originResult.needsFetchMetadataFallback !== true) {
    // Hard origin rejection (null, mismatch) — no fallback
    const reason: BrowserGuardRejectedReason = originResult.reason ?? 'unknown'
    deps.logger.warn({}, `browser guard: origin rejected (${reason})`)
    emitAudit({kind: 'browser.guard.rejected', correlationId: 'browser-guard', reason}, deps.auditLogger)
    addVaryHeader(c)
    return {ok: false, response: c.json({error: 'bad request'}, 400)}
  }

  // e) Validate Fetch Metadata
  // Also handles the absent-Origin-on-mutating-request case: if validateOrigin signaled
  // needsFetchMetadataFallback, we require Fetch Metadata to be present and safe.
  const fetchMetaResult = validateFetchMetadata(c, method, isPublicCrossSiteRoute)

  if (originResult.needsFetchMetadataFallback === true) {
    // Origin was absent on a mutating request — Fetch Metadata must confirm same-origin/none.
    // If Fetch Metadata is also absent or indicates cross-site, reject.
    if (fetchMetaResult.ok === false) {
      const reason: BrowserGuardRejectedReason = fetchMetaResult.reason ?? 'unknown'
      deps.logger.warn({}, `browser guard: fetch metadata rejected (${reason})`)
      emitAudit({kind: 'browser.guard.rejected', correlationId: 'browser-guard', reason}, deps.auditLogger)
      addVaryHeader(c)
      return {ok: false, response: c.json({error: 'bad request'}, 400)}
    }
    // Fetch Metadata passed — check if sec-fetch-site is present and safe.
    // Note: Sec-Fetch-Site: same-origin or none is accepted here even when
    // Sec-Fetch-Mode is absent — Sec-Fetch-Mode is only checked for mutating
    // requests when it IS present (see validateFetchMetadata). An absent
    // Sec-Fetch-Mode with a safe Sec-Fetch-Site value is not a rejection signal.
    const fetchSite = c.req.header('sec-fetch-site')
    if (fetchSite === undefined) {
      // Both Origin and Sec-Fetch-Site absent on mutating request — reject
      deps.logger.warn({}, 'browser guard: absent origin and absent fetch metadata on mutating request')
      emitAudit(
        {kind: 'browser.guard.rejected', correlationId: 'browser-guard', reason: 'origin_missing'},
        deps.auditLogger,
      )
      addVaryHeader(c)
      return {ok: false, response: c.json({error: 'bad request'}, 400)}
    }
    // Sec-Fetch-Site is present and passed validateFetchMetadata — allow
  } else if (fetchMetaResult.ok === false) {
    const reason: BrowserGuardRejectedReason = fetchMetaResult.reason ?? 'unknown'
    deps.logger.warn({}, `browser guard: fetch metadata rejected (${reason})`)
    emitAudit({kind: 'browser.guard.rejected', correlationId: 'browser-guard', reason}, deps.auditLogger)
    addVaryHeader(c)
    return {ok: false, response: c.json({error: 'bad request'}, 400)}
  }

  // f) Verify CSRF token for mutating routes
  if (requireCsrf && SAFE_METHODS.has(method) === false) {
    const csrfToken = c.req.header(CSRF_TOKEN_HEADER)
    if (csrfToken === undefined || csrfToken === '') {
      deps.logger.warn({}, 'browser guard: missing CSRF token')
      emitAudit(
        {kind: 'browser.guard.rejected', correlationId: 'browser-guard', reason: 'csrf_missing'},
        deps.auditLogger,
      )
      addVaryHeader(c)
      return {ok: false, response: c.json({error: 'bad request'}, 400)}
    }

    const csrfResult = verifyCsrfToken({
      token: csrfToken,
      sessionId,
      operatorId: githubUserId,
      nowMs,
      secret: deps.csrfSecret,
    })

    if (csrfResult.ok === false) {
      deps.logger.warn({}, 'browser guard: CSRF token invalid')
      emitAudit(
        {kind: 'browser.guard.rejected', correlationId: 'browser-guard', reason: 'csrf_invalid'},
        deps.auditLogger,
      )
      addVaryHeader(c)
      return {ok: false, response: c.json({error: 'bad request'}, 400)}
    }
  }

  return {ok: true, githubUserId, sessionId}
}
