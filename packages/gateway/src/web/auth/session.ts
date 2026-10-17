/**
 * Durable server-side session store for the operator web surface.
 *
 * - An in-memory map is authoritative for reads; every session also has a signed record in the object
 *   store (see session-persistence.ts), written before the session is accepted and revoked before a
 *   revoke is acknowledged.
 * - Sessions live a fixed 7 days from login (DURABLE_SESSION_TTL_MS). No idle timeout, and nothing extends it.
 * - A gateway restart keeps sessions: `load()` restores them from the object store before the server starts.
 * - Session IDs: 256-bit CSPRNG entropy (base64url, 43 chars). Only sha256(ID) is stored or held in memory.
 * - Session cap to bound memory growth.
 * - The store holds no OAuth token. The token is used for `GET /user` at login and then dropped.
 * - Cookie helpers: buildSessionCookieValue, parseSessionCookie.
 * - POST /operator/auth/logout route builder.
 *
 * Security invariants:
 *   - Session IDs are never logged or included in error responses.
 *   - Logout is durable first: a 200 means the revoke is stored, and a 503 means the session is still valid.
 *   - Only a deliberate rotation of GATEWAY_OPERATOR_CSRF_SECRET revokes every stored session at once.
 */

import type {Result} from '@fro-bot/runtime'
import type {Context, Hono} from 'hono'
import type {RateLimiter} from '../../http/rate-limit.js'
import type {AuditLogger, SessionRestoreCounts, SessionRestorePhase} from '../audit.js'
import type {IngressRejection, ResolvedClientAddress} from '../ingress/resolve-client.js'
import type {OperatorAllowlist} from './allowlist.js'
import type {BrowserGuardDeps} from './csrf.js'
import type {SessionPersistence, SessionPersistenceError} from './session-persistence.js'
import {randomBytes} from 'node:crypto'
import {err, ok} from '@fro-bot/runtime'
import {Effect} from 'effect'
import {emitAudit} from '../audit.js'
import {respondForIngressRejection} from '../ingress/hono-context.js'
import {getOperatorAuthContext, registerOperatorRoute} from '../operator-route.js'
import {okResponse, rateLimitedResponse, unavailableResponse} from '../safe-response.js'
import {hashSessionId} from './session-persistence.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cookie name — __Host- prefix enforces Secure, Path=/, no Domain. */
export const SESSION_COOKIE_NAME = '__Host-session'

/**
 * Durable session lifetime: a fixed 7 days from login. Idle time does not shorten it and no request extends it.
 *
 * Justification (ASVS V7.1.1, OWASP Session Management): the gateway has one allowlisted operator and an
 * installed PWA that is awkward to re-authenticate. Offsetting controls: logout is durable before it is
 * acknowledged, every login mints a new session ID, and rotating GATEWAY_OPERATOR_CSRF_SECRET revokes every
 * stored session at the next load. Re-authentication stays a normal path.
 */
export const DURABLE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Cookie `Max-Age` for a durable session, in seconds. Equals {@link DURABLE_SESSION_TTL_MS}. */
export const SESSION_COOKIE_MAX_AGE_SECONDS = DURABLE_SESSION_TTL_MS / 1000

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

/** Logger interface for the session module. */
export interface SessionLogger {
  readonly debug: (ctx: Record<string, unknown>, msg: string) => void
  readonly info: (ctx: Record<string, unknown>, msg: string) => void
  readonly warn: (ctx: Record<string, unknown>, msg: string) => void
  readonly error: (ctx: Record<string, unknown>, msg: string) => void
}

/** Identity and issue time of a live durable session. It carries no credential. */
export interface DurableSession extends SessionIdentity {
  readonly issuedAt: number
}

/** `cap` and `not_ready` are refusals before any write; `write_failed` is a failed durable create. */
export type DurableCreateResult =
  {readonly outcome: 'ok'; readonly sessionId: string} | {readonly outcome: 'cap' | 'write_failed' | 'not_ready'}

export type DurableRevokeResult = {readonly outcome: 'ok'} | {readonly outcome: 'persist_failed'}

export interface DurableRevokeOptions {
  /** Writes the `rotated` status and fires no hook. For a same-user re-login. */
  readonly rotate?: boolean
}

/** Count-only result of the startup load. */
export interface SessionRestoreSummary extends SessionRestoreCounts {
  /** Users whose push deactivation was replayed. */
  readonly replayedUsers: number
  /** Records that could not be durably revoked by the load policy. They stay dropped from memory. */
  readonly revokeFailed: number
}

export interface SessionRestoreFailure {
  readonly phase: SessionRestorePhase
  readonly errorClass: string
}

export interface DurableSessionStore {
  /** Mints a new session ID, writes the signed record, then inserts it in memory. Never reuses an ID. */
  readonly create: (identity: SessionIdentity) => Promise<DurableCreateResult>
  /** Map-only. A miss makes no object-store call. Undefined for unknown, revoked or expired IDs. */
  readonly get: (sessionId: string) => DurableSession | undefined
  /**
   * Durable-first revoke. The object-store write happens before the in-memory revoke and the hook, so a
   * failed write reports `persist_failed` and leaves the session valid. Repeat revokes succeed without a
   * second hook. An ID that is not in memory is revoked by hash and fires no hook.
   */
  readonly revoke: (sessionId: string, options?: DurableRevokeOptions) => Promise<DurableRevokeResult>
  /**
   * Startup load: self-test, signed load, load policy, then push replay. A self-test or list failure, or a
   * load past its deadline, leaves the store not ready: `create` reports `not_ready` and no restored ID is
   * accepted. A single record whose read fails twice is counted as `readFailed` and dropped, and the load
   * still completes.
   */
  readonly load: () => Promise<Result<SessionRestoreSummary, SessionRestoreFailure>>
  /** Removes expired and revoked entries from memory. Never touches the object store and fires no hook. */
  readonly scavenge: () => number
  /** Deletes stored records past the retention bound. Delegates to the persistence sweep. */
  readonly sweep: SessionPersistence['sweep']
  /** Entries in memory, including revoked and expired ones not yet scavenged. */
  readonly size: () => number
  /** True once `load` has succeeded. */
  readonly isReady: () => boolean
}

/** Dependencies for session-related routes (injectable for testing). */
export interface SessionDeps {
  readonly logger: SessionLogger
  readonly auditLogger: AuditLogger
  /** Injectable clock for CSRF intervals and route time checks. The durable store reads its own clock. */
  readonly clock: () => number
  /**
   * Shared rate limiter for the logout route.
   * Must be the same instance used in buildOperatorApp so logout participates
   * in the same per-socket budget. When absent, no rate limiting is applied
   * (backwards-compatible for tests that don't care about rate limiting).
   */
  readonly rateLimiter?: RateLimiter
  /**
   * Trusted-proxy-aware client resolver for rate limiting.
   * Must resolve through the same `resolveClient` + `OperatorIngressPolicy`
   * used everywhere else on the operator surface — never a caller-spoofable
   * header read directly. When absent, no rate limiting is applied
   * (backwards-compatible for tests that don't care about rate limiting).
   * A resolution failure is never treated as a fallback 'unknown' key.
   */
  readonly resolveClientAddress?: (c: Context) => Effect.Effect<ResolvedClientAddress, IngressRejection>
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
// Durable session store
// ---------------------------------------------------------------------------

export interface DurableSessionStoreDeps {
  readonly persistence: SessionPersistence
  readonly clock: () => number
  readonly logger: SessionLogger
  readonly auditLogger: AuditLogger
  /** Applied at load: records for users outside it are dropped and durably revoked. */
  readonly allowlist: OperatorAllowlist
  /**
   * Fires once per revocation with the user's ID, including for restored sessions. It does not fire for
   * rotation, TTL expiry or an ID that is not in memory. Load replays it once per user whose revoked record
   * is stored, until `revokedAt` plus the TTL, and who has no live restored session. It must be idempotent.
   */
  readonly onSessionRevoked?: (githubUserId: number) => void
  /** Live-session cap. Defaults to {@link SESSION_MAX_ENTRIES}. */
  readonly maxEntries?: number
}

interface DurableEntry {
  readonly githubUserId: number
  readonly login: string
  readonly issuedAt: number
  revoked: boolean
}

/** Retry-After for a logout whose durable revoke failed. */
const LOGOUT_RETRY_AFTER_SECONDS = 5

const SESSION_RESTORE_CORRELATION_ID = 'session-restore'
const REVOCATION_CORRELATION_ID = 'session-revoke'
const LOAD_REVOKE_CONCURRENCY = 16

/**
 * Create the durable session store: an in-memory map that is authoritative for reads, with a signed
 * write-through copy per session in the object store.
 *
 * Entries are keyed by `sha256(sessionId)`, the same hash the object key uses, so a restored record needs
 * no raw ID and raw IDs never sit in memory. The store holds no OAuth token and no last-access time.
 * It starts not ready: `load` must succeed before `create` accepts a login.
 */
export function createDurableSessionStore(deps: DurableSessionStoreDeps): DurableSessionStore {
  const {persistence, clock, logger, auditLogger, allowlist} = deps
  const maxEntries = deps.maxEntries ?? SESSION_MAX_ENTRIES
  const entries = new Map<string, DurableEntry>()
  let ready = false
  // Creates that passed the cap check and are awaiting their durable write.
  let pendingCreates = 0

  function isExpired(entry: DurableEntry): boolean {
    return clock() >= entry.issuedAt + DURABLE_SESSION_TTL_MS
  }

  function removeDead(): number {
    let removed = 0
    for (const [key, entry] of entries) {
      if (entry.revoked || isExpired(entry)) {
        entries.delete(key)
        removed += 1
      }
    }
    return removed
  }

  function fireHook(githubUserId: number): void {
    try {
      deps.onSessionRevoked?.(githubUserId)
    } catch {
      // A hook failure must not undo a revoke that is already durable.
      logger.warn({errorClass: 'hook_threw'}, 'session revoked hook threw')
    }
  }

  async function create(identity: SessionIdentity): Promise<DurableCreateResult> {
    if (ready === false) {
      return {outcome: 'not_ready'}
    }
    if (entries.size + pendingCreates >= maxEntries) {
      removeDead()
    }
    if (entries.size + pendingCreates >= maxEntries) {
      return {outcome: 'cap'}
    }

    const sessionId = generateSessionId()
    const issuedAt = clock()
    pendingCreates += 1
    let written: Result<void, SessionPersistenceError>
    try {
      written = await persistence.create({
        sessionId,
        githubUserId: identity.githubUserId,
        login: identity.login,
        issuedAt,
      })
    } finally {
      pendingCreates -= 1
    }
    if (written.success === false) {
      logger.warn({kind: written.error.kind, errorClass: written.error.errorClass}, 'session create write failed')
      return {outcome: 'write_failed'}
    }
    entries.set(hashSessionId(sessionId), {
      githubUserId: identity.githubUserId,
      login: identity.login,
      issuedAt,
      revoked: false,
    })
    return {outcome: 'ok', sessionId}
  }

  function get(sessionId: string): DurableSession | undefined {
    const entry = entries.get(hashSessionId(sessionId))
    if (entry === undefined || entry.revoked || isExpired(entry)) {
      return undefined
    }
    return {githubUserId: entry.githubUserId, login: entry.login, issuedAt: entry.issuedAt}
  }

  async function revoke(sessionId: string, options?: DurableRevokeOptions): Promise<DurableRevokeResult> {
    const keyHash = hashSessionId(sessionId)
    const entry = entries.get(keyHash)
    if (entry?.revoked === true) {
      return {outcome: 'ok'}
    }

    const rotate = options?.rotate === true
    const persisted = await persistence.revoke(keyHash, rotate ? 'rotated' : 'revoked')
    if (persisted.success === false) {
      emitAudit(
        {
          kind: 'auth.revocation.persist_failed',
          correlationId: REVOCATION_CORRELATION_ID,
          retries: persisted.error.retries,
          errorClass: persisted.error.errorClass,
        },
        auditLogger,
      )
      logger.warn(
        {kind: persisted.error.kind, errorClass: persisted.error.errorClass, retries: persisted.error.retries},
        'session revoke write failed; session stays valid',
      )
      return {outcome: 'persist_failed'}
    }

    // Re-check after the await: a concurrent revoke of the same session may have fired the hook already.
    if (entry !== undefined && entry.revoked === false) {
      entry.revoked = true
      if (rotate === false) {
        fireHook(entry.githubUserId)
      }
    }
    return {outcome: 'ok'}
  }

  /** Revokes each hash durably and returns the hashes whose write failed. */
  async function revokeAll(keyHashes: readonly string[]): Promise<ReadonlySet<string>> {
    const failed = new Set<string>()
    for (let index = 0; index < keyHashes.length; index += LOAD_REVOKE_CONCURRENCY) {
      const batch = keyHashes.slice(index, index + LOAD_REVOKE_CONCURRENCY)
      const results = await Promise.all(batch.map(async keyHash => persistence.revoke(keyHash, 'revoked')))
      results.forEach((result, position) => {
        const keyHash = batch[position]
        if (result.success === false && keyHash !== undefined) {
          failed.add(keyHash)
        }
      })
    }
    return failed
  }

  function failRestore(failure: SessionRestoreFailure): Result<SessionRestoreSummary, SessionRestoreFailure> {
    ready = false
    logger.error(
      {phase: failure.phase, errorClass: failure.errorClass},
      'session restore failed; the session store is not ready until restart',
    )
    emitAudit(
      {
        kind: 'auth.session.restore',
        correlationId: SESSION_RESTORE_CORRELATION_ID,
        outcome: 'failed',
        phase: failure.phase,
        errorClass: failure.errorClass,
      },
      auditLogger,
    )
    return err(failure)
  }

  async function load(): Promise<Result<SessionRestoreSummary, SessionRestoreFailure>> {
    ready = false
    const selfTest = await persistence.selfTest()
    if (selfTest.success === false) {
      return failRestore({phase: 'self_test', errorClass: selfTest.error.errorClass})
    }
    const loaded = await persistence.load()
    if (loaded.success === false) {
      return failRestore({phase: 'load', errorClass: loaded.error.errorClass})
    }

    const {sessions, counts} = loaded.data
    const live: {keyHash: string; githubUserId: number; login: string; issuedAt: number}[] = []
    const toRevoke: {keyHash: string; githubUserId: number}[] = []
    const revokedUsers = new Set<number>()
    let storedRevoked = 0
    let rotated = 0
    let notAllowlisted = 0
    for (const session of sessions) {
      if (session.status === 'rotated') {
        rotated += 1
      } else if (session.status === 'revoked') {
        storedRevoked += 1
        revokedUsers.add(session.githubUserId)
      } else if (allowlist.isAuthorized(session.githubUserId) === false) {
        notAllowlisted += 1
        toRevoke.push({keyHash: session.keyHash, githubUserId: session.githubUserId})
      } else {
        live.push(session)
      }
    }

    // Newest sessions win the cap; the rest are revoked durably so they cannot return at the next restart.
    live.sort((a, b) => b.issuedAt - a.issuedAt)
    const kept = live.slice(0, maxEntries)
    const overCap = live.slice(maxEntries)
    toRevoke.push(...overCap)

    const failedRevokes = await revokeAll(toRevoke.map(item => item.keyHash))

    entries.clear()
    for (const session of kept) {
      entries.set(session.keyHash, {
        githubUserId: session.githubUserId,
        login: session.login,
        issuedAt: session.issuedAt,
        revoked: false,
      })
    }
    ready = true

    // Replay push deactivation once per user. A user with a live restored session logged in again after the
    // revoke and may have resubscribed, so deactivating would undo that.
    for (const item of toRevoke) {
      if (failedRevokes.has(item.keyHash) === false) {
        revokedUsers.add(item.githubUserId)
      }
    }
    const liveUsers = new Set(kept.map(session => session.githubUserId))
    let replayedUsers = 0
    for (const githubUserId of revokedUsers) {
      if (liveUsers.has(githubUserId) === false) {
        fireHook(githubUserId)
        replayedUsers += 1
      }
    }

    const restoreCounts: SessionRestoreCounts = {
      loaded: kept.length,
      expired: counts.expired,
      revoked: storedRevoked,
      notAllowlisted,
      unsigned: counts.unsigned,
      futureDated: counts.futureDated,
      overCap: overCap.length,
      readFailed: counts.readFailed,
    }
    const summary: SessionRestoreSummary = {...restoreCounts, replayedUsers, revokeFailed: failedRevokes.size}
    logger.info(
      {...summary, rotated, malformed: counts.malformed, unrecognized: counts.unrecognized},
      'session restore finished',
    )
    emitAudit(
      {
        kind: 'auth.session.restore',
        correlationId: SESSION_RESTORE_CORRELATION_ID,
        outcome: 'ready',
        counts: restoreCounts,
      },
      auditLogger,
    )
    return ok(summary)
  }

  return {
    create,
    get,
    revoke,
    load,
    scavenge: removeDead,
    sweep: async () => {
      const swept = await persistence.sweep()
      if (swept.success === false) {
        logger.warn({kind: swept.error.kind, errorClass: swept.error.errorClass}, 'session sweep failed')
      }
      return swept
    },
    size: () => entries.size,
    isReady: () => ready,
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
 * A set cookie carries Max-Age equal to the durable session lifetime. When clear=true it sets Max-Age=0 with
 * the same other attributes, which expires the cookie immediately.
 */
export function buildSessionCookieValue(sessionId: string, opts?: {clear?: boolean}): string {
  const value = opts?.clear === true ? '' : sessionId
  const parts = [`${SESSION_COOKIE_NAME}=${value}`, 'HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']
  parts.push(opts?.clear === true ? 'Max-Age=0' : `Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`)
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
  store: Pick<DurableSessionStore, 'revoke'>,
  deps: SessionDeps,
  _browserGuardDeps: BrowserGuardDeps,
): void {
  // Protected logout — requires session + allowlist + origin + CSRF.
  // Registered as a privileged route so the static guardrail enforces it.
  // The browser guard is applied automatically by the privileged-route guard seam
  // (setOperatorRouteGuard in server.ts). The handler reads the authenticated context
  // (sessionId, githubUserId) from Hono context variables set by the guard wrapper.
  registerOperatorRoute(app, 'POST', '/operator/auth/logout', async (c: Context): Promise<Response> => {
    // Rate limit check — shared with the operator app, keyed on the
    // trust-aware resolved client address. When no resolver is configured,
    // rate limiting is skipped entirely (test back-compat) — never a fallback
    // 'unknown' key that every unresolvable request would share.
    if (deps.rateLimiter !== undefined && deps.resolveClientAddress !== undefined) {
      const resolved = Effect.runSync(Effect.either(deps.resolveClientAddress(c)))
      if (resolved._tag === 'Left') {
        deps.logger.warn({reason: resolved.left.kind}, 'logout rejected: ingress resolution failed')
        return respondForIngressRejection(c, resolved.left)
      }
      if (deps.rateLimiter.allow(resolved.right.accountingKey) === false) {
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

    // Durable first: a 200 means the revoke is stored. On a failed write the session stays valid, the
    // cookie stays, and the operator retries.
    const revoked = await store.revoke(sessionId)
    if (revoked.outcome === 'persist_failed') {
      deps.logger.warn({githubUserId}, 'session logout failed: revoke not durable; session stays valid')
      return unavailableResponse(c, LOGOUT_RETRY_AFTER_SECONDS)
    }

    emitAudit(
      {
        kind: 'auth.logout',
        correlationId: 'logout',
        githubUserId,
      },
      deps.auditLogger,
    )
    deps.logger.info({githubUserId}, 'session logout')

    // Clear the cookie only after the revoke landed.
    const clearCookie = buildSessionCookieValue('', {clear: true})
    c.header('Set-Cookie', clearCookie)

    return okResponse(c)
  })
}
