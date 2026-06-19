/**
 * Server-side opaque session store for the operator web surface.
 *
 * - In-memory store: create, get, touch, delete, scavenge, size.
 * - 8-hour absolute TTL and 30-minute idle TTL enforced on every get().
 * - Session IDs: 256-bit CSPRNG entropy (base64url, 43 chars).
 * - Session cap to bound memory growth.
 * - Revocation hooks: called on delete().
 * - Cookie helpers: buildSessionCookieValue, parseSessionCookie.
 * - POST /operator/auth/logout route builder.
 *
 * Security invariants:
 *   - Session IDs are never logged or included in error responses.
 *   - Logout is idempotent: unknown session IDs return 200 (no oracle).
 *   - Gateway restart is global logout: in-memory sessions are gone.
 */

import type {Context, Hono} from 'hono'
import type {RateLimiter} from '../../http/rate-limit.js'
import type {AuditLogger} from '../audit.js'
import type {BrowserGuardDeps} from './csrf.js'
import {randomBytes} from 'node:crypto'
import {emitAudit} from '../audit.js'
import {getOperatorAuthContext, registerOperatorRoute} from '../operator-route.js'
import {okResponse, rateLimitedResponse} from '../safe-response.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cookie name — __Host- prefix enforces Secure, Path=/, no Domain. */
export const SESSION_COOKIE_NAME = '__Host-session'

/** Absolute session lifetime: 8 hours. */
export const SESSION_ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1000

/** Idle session lifetime: 30 minutes since last access. */
export const SESSION_IDLE_TTL_MS = 30 * 60 * 1000

/**
 * Maximum number of live sessions in the store.
 * Prevents unbounded Map growth. Sized for a single-operator deployment.
 */
export const SESSION_MAX_ENTRIES = 10_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Identity bound to a session. */
export interface SessionIdentity {
  /** Stable GitHub numeric user ID. */
  readonly githubUserId: number
  /** GitHub display login — mutable, for display only. */
  readonly login: string
}

/**
 * A single session entry stored server-side.
 *
 * Security invariant: `oauthToken` is an in-memory-only, session-bound secret.
 * It is never written to disk, never included in any cookie, never logged, and
 * never returned to the operator via any API response. It lives and dies with
 * this entry — dropped on revocation, TTL expiry, and scavenge.
 */
export interface SessionEntry extends SessionIdentity {
  /** Timestamp (ms since epoch) when this session was created. */
  readonly issuedAt: number
  /** Timestamp (ms since epoch) of the last access (create or touch). */
  lastAccessedAt: number
  /** Whether this session has been explicitly revoked. */
  revoked: boolean
  /**
   * GitHub OAuth access token retained server-side for privileged route use.
   *
   * At-rest boundary: in-memory only. No disk, no logs, no cookie.
   * Scope: repo read (minimum required by checkRepoAuthz).
   * Lifetime: bound to this session entry — cleared on revocation, TTL expiry,
   * and on first detected GitHub token expiry/revocation (via dropOperatorToken).
   *
   * NEVER expose this field in SessionIdentity, OperatorSessionInfo, or any
   * operator-facing response. Access only through getOperatorToken().
   *
   * Optional so that stub/test SessionEntry literals do not need to carry it.
   */
  oauthToken?: string | undefined
}

/** Revocation hook callback — called with the session ID when the session is deleted. */
export type RevocationHook = (sessionId: string) => void

/** Server-side session store interface. */
export interface SessionStore {
  /**
   * Create a new session for the given identity, retaining the OAuth token server-side.
   *
   * The token is stored in-memory only, bound to this session entry. It is never
   * written to disk, never included in any cookie, and never returned to the operator.
   *
   * Returns the new session ID, or undefined if the session cap is reached.
   */
  create: (identity: SessionIdentity, oauthToken: string, nowMs: number) => string | undefined
  /**
   * Retrieve a session entry by ID.
   * Returns undefined if not found, expired (absolute or idle), or revoked.
   * Does NOT update lastAccessedAt — call touch() separately.
   * Returns a Readonly view to prevent external mutation of revoked/lastAccessedAt bypassing hooks.
   *
   * Security: the returned entry does NOT expose the oauthToken field — use
   * getOperatorToken() for the narrow token accessor.
   */
  get: (sessionId: string, nowMs: number) => Readonly<Omit<SessionEntry, 'oauthToken'>> | undefined
  /**
   * Update lastAccessedAt to extend the idle TTL.
   * No-op for unknown or revoked sessions.
   */
  touch: (sessionId: string, nowMs: number) => void
  /**
   * Revoke a session immediately.
   * No-op for unknown sessions.
   * Triggers any registered revocation hooks.
   * The retained OAuth token is dropped with the entry.
   */
  delete: (sessionId: string) => void
  /**
   * Register a revocation hook for a specific session ID.
   * The hook is called with the session ID when delete() is called for that session.
   * Multiple hooks per session are supported.
   */
  onRevoke: (sessionId: string, hook: RevocationHook) => void
  /**
   * Remove expired and revoked entries from the store.
   * Call periodically to bound memory growth.
   * Retained OAuth tokens are dropped with their entries.
   */
  scavenge: (nowMs: number) => void
  /** Total number of entries in the store (including revoked, not yet scavenged). */
  size: () => number
  /**
   * Return the retained OAuth token for a live, non-revoked, non-expired session.
   *
   * Returns undefined when:
   *   - The session ID is unknown.
   *   - The session is revoked or TTL-expired.
   *   - The token was explicitly dropped via dropOperatorToken().
   *
   * Security: the token is NEVER logged, never included in any response, and
   * never returned via get(). This is the only sanctioned accessor.
   */
  getOperatorToken: (sessionId: string, nowMs: number) => string | undefined
  /**
   * Drop the retained OAuth token for a session without revoking the session itself.
   *
   * Call this when checkRepoAuthz (or any token-using path) fails in a way
   * consistent with an expired or revoked GitHub token. The session remains valid
   * for non-token operations, but subsequent getOperatorToken() calls return undefined,
   * signalling to the caller that re-authentication is needed.
   *
   * Re-auth signal: when getOperatorToken() returns undefined for a live session,
   * the caller should surface a distinct "re-authenticate" response to the operator
   * (not a generic permission denial) so the browser can redirect to /start.
   *
   * No-op for unknown or revoked sessions.
   */
  dropOperatorToken: (sessionId: string) => void
}

/** Logger interface for the session module. */
export interface SessionLogger {
  readonly debug: (ctx: Record<string, unknown>, msg: string) => void
  readonly info: (ctx: Record<string, unknown>, msg: string) => void
  readonly warn: (ctx: Record<string, unknown>, msg: string) => void
  readonly error: (ctx: Record<string, unknown>, msg: string) => void
}

/** Dependencies for session-related routes (injectable for testing). */
export interface SessionDeps {
  readonly logger: SessionLogger
  readonly auditLogger: AuditLogger
  /** Injectable clock for TTL checks. Defaults to Date.now. */
  readonly clock: () => number
  /**
   * Shared rate limiter for the logout route.
   * Must be the same instance used in buildOperatorApp so logout participates
   * in the same per-socket budget. When absent, no rate limiting is applied
   * (backwards-compatible for tests that don't care about rate limiting).
   */
  readonly rateLimiter?: RateLimiter
  /**
   * Source key extractor for rate limiting.
   * Must be derived from the TCP socket address — NOT from caller-spoofable headers.
   * When absent, falls back to 'unknown' (backwards-compatible for tests).
   */
  readonly getSourceKey?: (c: Context) => string
}

// ---------------------------------------------------------------------------
// Session ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically random session ID with 256 bits of entropy.
 * Returns a base64url-encoded string (43 characters, no padding).
 */
function generateSessionId(): string {
  return randomBytes(32).toString('base64url')
}

// ---------------------------------------------------------------------------
// In-memory session store
// ---------------------------------------------------------------------------

/**
 * Create a simple in-memory session store.
 *
 * Suitable for v1 single-process deployment. Gateway restart clears all sessions
 * (global logout — acceptable for v1).
 *
 * Session IDs are 256-bit CSPRNG values (base64url, 43 chars). At that entropy
 * level, enumeration is computationally infeasible; Map.get() is the correct
 * lookup — no timing-safe comparison is needed or useful here.
 */
export function createInMemorySessionStore(): SessionStore {
  const entries = new Map<string, SessionEntry>()
  const hooks = new Map<string, RevocationHook[]>()

  function isExpired(entry: SessionEntry, nowMs: number): boolean {
    if (nowMs - entry.issuedAt > SESSION_ABSOLUTE_TTL_MS) return true
    if (nowMs - entry.lastAccessedAt > SESSION_IDLE_TTL_MS) return true
    return false
  }

  return {
    create(identity: SessionIdentity, oauthToken: string, nowMs: number): string | undefined {
      // Opportunistically scavenge expired/revoked entries before checking the cap.
      // This makes cap behavior live-entry-based and fixes re-auth after stale session
      // deletion: the revoked slot is reclaimed without requiring a manual scavenge() call.
      if (entries.size >= SESSION_MAX_ENTRIES) {
        for (const [key, entry] of entries) {
          if (entry.revoked === true || isExpired(entry, nowMs)) {
            entries.delete(key)
            hooks.delete(key)
          }
        }
      }

      if (entries.size >= SESSION_MAX_ENTRIES) return undefined

      const sessionId = generateSessionId()
      const entry: SessionEntry = {
        githubUserId: identity.githubUserId,
        login: identity.login,
        issuedAt: nowMs,
        lastAccessedAt: nowMs,
        revoked: false,
        // Token is in-memory only: no disk, no logs, no cookie.
        // Scope: repo read (minimum required by checkRepoAuthz).
        oauthToken,
      }
      entries.set(sessionId, entry)
      return sessionId
    },

    get(sessionId: string, nowMs: number): Omit<SessionEntry, 'oauthToken'> | undefined {
      const entry = entries.get(sessionId)
      if (entry === undefined) return undefined
      if (entry.revoked === true) return undefined
      if (isExpired(entry, nowMs)) return undefined
      // Return a projection that excludes oauthToken — the token is never in the public entry.
      // Build the public entry by copying only the known public fields.
      const publicEntry: Omit<SessionEntry, 'oauthToken'> = {
        githubUserId: entry.githubUserId,
        login: entry.login,
        issuedAt: entry.issuedAt,
        lastAccessedAt: entry.lastAccessedAt,
        revoked: entry.revoked,
      }
      return publicEntry
    },

    touch(sessionId: string, nowMs: number): void {
      const entry = entries.get(sessionId)
      if (entry === undefined) return
      if (entry.revoked === true) return
      entry.lastAccessedAt = nowMs
    },

    delete(sessionId: string): void {
      const entry = entries.get(sessionId)
      if (entry === undefined) return
      entry.revoked = true

      const sessionHooks = hooks.get(sessionId)
      if (sessionHooks !== undefined) {
        for (const hook of sessionHooks) {
          try {
            hook(sessionId)
          } catch {
            // Swallow hook failures — revocation must not be blocked by hook errors.
          }
        }
        hooks.delete(sessionId)
      }
    },

    onRevoke(sessionId: string, hook: RevocationHook): void {
      const existing = hooks.get(sessionId)
      if (existing === undefined) {
        hooks.set(sessionId, [hook])
      } else {
        existing.push(hook)
      }
    },

    scavenge(nowMs: number): void {
      for (const [key, entry] of entries) {
        if (entry.revoked === true || isExpired(entry, nowMs)) {
          entries.delete(key)
          hooks.delete(key)
        }
      }
    },

    size(): number {
      return entries.size
    },

    getOperatorToken(sessionId: string, nowMs: number): string | undefined {
      const entry = entries.get(sessionId)
      if (entry === undefined) return undefined
      if (entry.revoked === true) return undefined
      if (isExpired(entry, nowMs)) return undefined
      return entry.oauthToken
    },

    dropOperatorToken(sessionId: string): void {
      const entry = entries.get(sessionId)
      if (entry === undefined) return
      if (entry.revoked === true) return
      entry.oauthToken = undefined
    },
  }
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

/**
 * Build a Set-Cookie header value for the session cookie.
 *
 * Attributes:
 *   - __Host- prefix: enforces Secure, Path=/, no Domain (browser-enforced).
 *   - HttpOnly: not accessible via JavaScript.
 *   - Secure: HTTPS only.
 *   - SameSite=Lax: CSRF mitigation for cross-site navigations.
 *   - Path=/: required by __Host- prefix.
 *
 * When clear=true, sets Max-Age=0 to expire the cookie immediately.
 */
export function buildSessionCookieValue(sessionId: string, opts?: {clear?: boolean}): string {
  const value = opts?.clear === true ? '' : sessionId
  const parts = [`${SESSION_COOKIE_NAME}=${value}`, 'HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']
  if (opts?.clear === true) {
    parts.push('Max-Age=0')
  }
  return parts.join('; ')
}

/**
 * Parse the session ID from a Cookie header string.
 * Returns the session ID if the session cookie is present, or undefined.
 */
export function parseSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined || cookieHeader === '') return undefined

  // Split on '; ' and find the session cookie
  const cookies = cookieHeader.split(/;\s*/)
  for (const cookie of cookies) {
    const eqIdx = cookie.indexOf('=')
    if (eqIdx === -1) continue
    const name = cookie.slice(0, eqIdx).trim()
    const value = cookie.slice(eqIdx + 1).trim()
    if (name === SESSION_COOKIE_NAME) {
      return value === '' ? undefined : value
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Logout route builder
// ---------------------------------------------------------------------------

/**
 * Register the POST /operator/auth/logout route on the given Hono app.
 *
 * Logout is a privileged route protected by session + allowlist + origin + CSRF.
 * The browser guard (applied automatically by the privileged-route guard seam
 * installed in server.ts) runs before this handler. The handler reads the
 * authenticated context (sessionId, githubUserId) from Hono context variables
 * set by the guard wrapper.
 *
 * Invalidates the session server-side and clears the session cookie.
 * Returns 200 after successful authenticated logout.
 *
 * @throws {Error} Programming error if browserGuardDeps is not provided.
 *   Logout must always be protected — a public mutating logout path is a
 *   CSRF footgun and is not supported.
 */
export function buildLogoutRoutes(
  app: Hono,
  store: SessionStore,
  deps: SessionDeps,
  _browserGuardDeps: BrowserGuardDeps,
): void {
  // Protected logout — requires session + allowlist + origin + CSRF.
  // Registered as a privileged route so the static guardrail enforces it.
  // The browser guard is applied automatically by the privileged-route guard seam
  // (setOperatorRouteGuard in server.ts). The handler reads the authenticated context
  // (sessionId, githubUserId) from Hono context variables set by the guard wrapper.
  registerOperatorRoute(app, 'POST', '/operator/auth/logout', async (c: Context): Promise<Response> => {
    // Rate limit check — shared with the operator app, keyed on socket address.
    if (deps.rateLimiter !== undefined) {
      const sourceKey = deps.getSourceKey === undefined ? 'unknown' : deps.getSourceKey(c)
      if (deps.rateLimiter.allow(sourceKey) === false) {
        deps.logger.warn({}, 'logout rejected: rate limited')
        return rateLimitedResponse(c)
      }
    }

    // Read the authenticated context stored by the guard wrapper.
    // The browser guard (session + allowlist + origin + CSRF) has already run.
    const authCtx = getOperatorAuthContext(c)
    if (authCtx === undefined) {
      // Guard not installed — this is a programming error. buildLogoutRoutes requires
      // browserGuardDeps and the guard must be installed before registering privileged routes.
      return c.json({error: 'unauthorized'}, 401)
    }

    const {sessionId, githubUserId} = authCtx

    // Emit audit event before deleting the session.
    emitAudit(
      {
        kind: 'auth.logout',
        correlationId: 'logout',
        githubUserId,
      },
      deps.auditLogger,
    )
    deps.logger.info({githubUserId}, 'session logout')

    store.delete(sessionId)

    // Always clear the cookie — idempotent logout
    const clearCookie = buildSessionCookieValue('', {clear: true})
    c.header('Set-Cookie', clearCookie)

    return okResponse(c)
  })
}
