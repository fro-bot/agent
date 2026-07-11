/**
 * GitHub OAuth PKCE + state flow for the operator web surface.
 *
 * Implements:
 *   - GET /operator/auth/github/start: generate PKCE S256 verifier server-side,
 *     derive code challenge, generate cryptographic state, store server-side with
 *     short TTL and outstanding-attempt cap, redirect to GitHub.
 *   - GET /operator/auth/github/callback: validate state (one-time, TTL), exchange
 *     code with PKCE verifier, fetch GitHub user, extract stable numeric id and
 *     display login, emit audit events.
 *
 * Security invariants:
 *   - Code verifier is NEVER written to a cookie or included in any browser-visible
 *     response. It lives only in the server-side state store.
 *   - State is one-time: consumed on first use, rejected on replay.
 *   - Redirect targets are validated as same-origin/path-allowlisted before state mint.
 *   - Callback route must remain compatible with future Fetch Metadata middleware
 *     because GitHub redirects cross-site after authorization.
 *   - All auth failure branches return the same coarse 400 response shape (no-oracle).
 *   - Numeric GitHub user id is the authority; login is display metadata only.
 *   - Source key for outstanding-attempt counting is injected by the caller and must
 *     be derived from the TCP socket address, not from caller-spoofable headers.
 *   - Callback validates that the current source key matches the source key bound at
 *     state mint time, preventing cross-IP state replay.
 */

import type {Context, Hono} from 'hono'
import type {RateLimiter} from '../../http/rate-limit.js'
import type {AuditLogger} from '../audit.js'
import type {OperatorAllowlist} from './allowlist.js'
import type {SessionDeps, SessionStore} from './session.js'
import {createHash, randomBytes} from 'node:crypto'
import {emitAudit} from '../audit.js'
import {registerPublicCrossSiteRoute, registerPublicRoute} from '../operator-route.js'
import {badRequestResponse, forbiddenResponse, rateLimitedResponse, unavailableResponse} from '../safe-response.js'
import {buildSessionCookieValue, parseSessionCookie} from './session.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single OAuth state entry stored server-side. */
export interface OAuthStateEntry {
  /** PKCE code verifier — server-side only, never browser-visible. */
  readonly codeVerifier: string
  /** Timestamp (ms since epoch) when this state was issued. */
  readonly issuedAt: number
  /** Whether this state has been consumed (one-time use). */
  consumed: boolean
  /** Optional same-origin return path bound at state mint time. */
  readonly redirectTarget?: string
  /** Source key (socket IP) for outstanding-attempt counting. */
  readonly sourceKey?: string
}

/** Server-side state store interface for OAuth state entries. */
export interface OAuthStateStore {
  /** Store a state entry. */
  set: (stateValue: string, entry: OAuthStateEntry) => void
  /** Retrieve a state entry by value. Returns undefined if not found. */
  get: (stateValue: string) => OAuthStateEntry | undefined
  /** Mark a state entry as consumed (one-time use). */
  consume: (stateValue: string) => void
  /** Count outstanding (unconsumed) entries for a given source key. */
  countOutstanding: (sourceKey: string) => number
  /** Total number of entries in the store. */
  size: () => number
  /**
   * Evict consumed and expired entries from the store.
   * Call periodically to bound memory growth.
   */
  evictStale: (nowMs: number, ttlMs: number) => void
}

/** Logger interface for the OAuth module. */
export interface OAuthLogger {
  readonly debug: (ctx: Record<string, unknown>, msg: string) => void
  readonly info: (ctx: Record<string, unknown>, msg: string) => void
  readonly warn: (ctx: Record<string, unknown>, msg: string) => void
  readonly error: (ctx: Record<string, unknown>, msg: string) => void
}

/** Dependencies for the GitHub OAuth routes (injectable for testing). */
export interface GitHubOAuthDeps {
  readonly logger: OAuthLogger
  readonly auditLogger: AuditLogger
  /** Injectable fetch for token exchange and user fetch. Defaults to global fetch. */
  readonly fetch: typeof globalThis.fetch
  /** Injectable clock for TTL checks. Defaults to Date.now. */
  readonly clock: () => number
  /**
   * Injectable PKCE code verifier generator.
   * Must return a cryptographically random string of at least 43 characters.
   * Defaults to a CSPRNG-based generator.
   */
  readonly generateVerifier: () => string
  /**
   * Injectable state value generator.
   * Must return a cryptographically random string.
   * Defaults to a CSPRNG-based generator.
   */
  readonly generateState: () => string
  /** Server-side state store. */
  readonly stateStore: OAuthStateStore
  /**
   * Injectable source key extractor for outstanding-attempt counting.
   * Must return a key derived from the TCP socket address — NOT from
   * caller-spoofable headers like X-Forwarded-For or X-Real-IP.
   *
   * In production, wire this to getConnInfo(c).remote.address with a
   * 'unknown' fallback. In tests, return a fixed string.
   *
   * The global rate limiter in buildOperatorApp already applies socket-keyed
   * limits; this key is used only for the per-OAuth-flow outstanding-attempt cap
   * and for source key binding validation on callback.
   */
  readonly getSourceKey: (c: Context) => string
  /**
   * Rate limiter shared with the operator app.
   * Applied to both /start and /callback before any work is performed.
   * Must be the same instance as the one used in buildOperatorApp so that
   * OAuth routes participate in the same per-socket budget.
   */
  readonly rateLimiter: RateLimiter
  /**
   * Server-side session store. When present, a successful OAuth callback mints
   * a fresh session and sets the __Host- session cookie. When absent, the
   * callback returns a coarse JSON identity response (pre-session-layer posture).
   */
  readonly sessionStore?: SessionStore
  /**
   * Session deps (logger, auditLogger, clock) for session operations.
   * Required when sessionStore is present; ignored otherwise.
   */
  readonly sessionDeps?: SessionDeps
  /**
   * Operator allowlist for post-authentication authorization.
   * When present (alongside sessionStore), the callback checks the allowlist
   * BEFORE minting a session — non-allowlisted users are denied 403 and never
   * get a session cookie. When absent, no allowlist check is performed.
   */
  readonly allowlist?: OperatorAllowlist
  /**
   * Operator push deactivation hook — opt-in, present only when operator push
   * is configured. Called with the newly-minted session's `githubUserId`
   * immediately after a session is created, so it can be closed over and
   * invoked later from `sessionStore.onRevoke` (fired on logout / TTL
   * expiry). Registered here — not inside the revoke hook itself — because
   * `SessionStore.onRevoke`'s hook signature only receives the sessionId,
   * and the entry's identity is not guaranteed readable once revoked; the
   * identity is captured at session-creation time instead.
   */
  readonly onSessionRevoke?: (githubUserId: number) => void
}

/** Configuration for the GitHub OAuth PKCE + state routes. */
export interface GitHubOAuthConfig {
  /** GitHub OAuth App client ID. */
  readonly clientId: string
  /** GitHub OAuth App client secret. Never logged or browser-visible. */
  readonly clientSecret: string
  /**
   * Public HTTPS origin for the operator surface.
   * Used to build the callback redirect_uri and validate return paths.
   * Example: 'https://operator.example.com'
   */
  readonly publicOrigin: string
  /**
   * Path for the OAuth callback route.
   * Example: '/operator/auth/github/callback'
   */
  readonly callbackPath: string
  /**
   * Allowlisted same-origin return paths for post-auth redirect.
   * Only paths in this list are accepted as return_to targets.
   */
  readonly allowedReturnPaths: readonly string[]
  /**
   * Maximum outstanding (unconsumed) OAuth attempts per source key.
   * Prevents state store exhaustion from unauthenticated floods.
   */
  readonly maxOutstandingAttemptsPerKey: number
  /**
   * TTL for OAuth state entries in milliseconds.
   * State older than this is rejected as expired.
   * Default: 10 minutes (600_000 ms).
   */
  readonly stateTtlMs: number
}

// ---------------------------------------------------------------------------
// Production factory
// ---------------------------------------------------------------------------

/**
 * Build production GitHubOAuthDeps with real CSPRNG generators, global fetch,
 * Date.now clock, and a fresh in-memory state store.
 *
 * The caller must supply logger, auditLogger, getSourceKey, and rateLimiter
 * because those depend on the surrounding server context (logger from program.ts,
 * source key from getConnInfo which requires the Hono context, rateLimiter from
 * the shared operator app instance).
 */
export function buildGitHubOAuthDeps(
  logger: OAuthLogger,
  auditLogger: AuditLogger,
  getSourceKey: (c: Context) => string,
  rateLimiter: RateLimiter,
  sessionStore?: SessionStore,
  sessionDeps?: SessionDeps,
  allowlist?: OperatorAllowlist,
  onSessionRevoke?: (githubUserId: number) => void,
): GitHubOAuthDeps {
  return {
    logger,
    auditLogger,
    fetch: globalThis.fetch,
    clock: () => Date.now(),
    generateVerifier: () => randomBytes(32).toString('base64url'),
    generateState: () => randomBytes(32).toString('base64url'),
    stateStore: createInMemoryStateStore(),
    getSourceKey,
    rateLimiter,
    ...(sessionStore === undefined ? {} : {sessionStore}),
    ...(sessionDeps === undefined ? {} : {sessionDeps}),
    ...(allowlist === undefined ? {} : {allowlist}),
    ...(onSessionRevoke === undefined ? {} : {onSessionRevoke}),
  }
}

// ---------------------------------------------------------------------------
// In-memory state store
// ---------------------------------------------------------------------------

/**
 * Create a simple in-memory OAuth state store.
 *
 * Suitable for v1 single-process deployment. Gateway restart clears all state
 * (global logout for in-flight OAuth flows — acceptable for v1).
 *
 * Supports eviction of consumed and expired entries via evictStale() to bound
 * memory growth. Call evictStale() periodically or on each request.
 */
export function createInMemoryStateStore(): OAuthStateStore {
  const entries = new Map<string, OAuthStateEntry>()

  return {
    set(stateValue: string, entry: OAuthStateEntry): void {
      entries.set(stateValue, entry)
    },

    get(stateValue: string): OAuthStateEntry | undefined {
      return entries.get(stateValue)
    },

    consume(stateValue: string): void {
      const entry = entries.get(stateValue)
      if (entry !== undefined) {
        entry.consumed = true
      }
    },

    countOutstanding(sourceKey: string): number {
      let count = 0
      for (const entry of entries.values()) {
        if (entry.sourceKey === sourceKey && entry.consumed === false) {
          count++
        }
      }
      return count
    },

    size(): number {
      return entries.size
    },

    evictStale(nowMs: number, ttlMs: number): void {
      for (const [key, entry] of entries) {
        if (entry.consumed === true || nowMs - entry.issuedAt > ttlMs) {
          entries.delete(key)
        }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

/**
 * Derive the S256 code challenge from a PKCE code verifier.
 * SHA-256 hash of the verifier, base64url-encoded (no padding).
 */
function deriveCodeChallenge(verifier: string): string {
  const hash = createHash('sha256').update(verifier, 'ascii').digest()
  // base64url: replace + with -, / with _, strip trailing =
  return hash.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

// ---------------------------------------------------------------------------
// Redirect target validation
// ---------------------------------------------------------------------------

/**
 * Validate a return_to path as same-origin and allowlisted.
 *
 * Returns the validated path string, or null if invalid.
 * Rejects:
 *   - Absolute URLs (http://, https://, //)
 *   - Paths not in the allowlist
 *   - Empty strings
 */
function validateReturnPath(returnTo: string, allowedPaths: readonly string[]): string | null {
  if (returnTo === '') return null

  // Reject absolute URLs and protocol-relative URLs
  if (/^https?:\/\//i.test(returnTo)) return null
  if (returnTo.startsWith('//')) return null

  // Must start with /
  if (returnTo.startsWith('/') === false) return null

  // Must be in the allowlist (exact match)
  if (allowedPaths.includes(returnTo) === false) return null

  return returnTo
}

// ---------------------------------------------------------------------------
// Typed JSON parse helpers
// ---------------------------------------------------------------------------

interface TokenResponse {
  readonly access_token: string
}

interface UserResponse {
  readonly id: number
  readonly login: string
}

function parseTokenResponse(data: unknown): TokenResponse | null {
  if (typeof data !== 'object' || data === null) return null
  const obj = data as Record<string, unknown>
  if (typeof obj.access_token !== 'string' || obj.access_token === '') return null
  return {access_token: obj.access_token}
}

function parseUserResponse(data: unknown): UserResponse | null {
  if (typeof data !== 'object' || data === null) return null
  const obj = data as Record<string, unknown>
  if (typeof obj.id !== 'number' || Number.isInteger(obj.id) === false || obj.id <= 0) return null
  if (typeof obj.login !== 'string' || obj.login === '') return null
  return {id: obj.id, login: obj.login}
}

// ---------------------------------------------------------------------------
// Fetch timeout
// ---------------------------------------------------------------------------

/** Timeout for external GitHub API calls (token exchange and user fetch). */
const GITHUB_FETCH_TIMEOUT_MS = 8_000

/**
 * Global ceiling on total live entries in the OAuth state store across all source keys.
 *
 * Prevents unbounded Map growth when many distinct source keys each stay below the
 * per-source outstanding cap. Once the store reaches this size, /start fails closed
 * until stale entries are evicted (evictStale runs before the check on every request).
 *
 * Sized to be generous for legitimate concurrent flows (1000 simultaneous OAuth starts
 * across all users) while bounding worst-case memory to ~1 MB (each entry is ~200 bytes).
 */
const MAX_GLOBAL_STATE_STORE_ENTRIES = 1_000

// ---------------------------------------------------------------------------
// Route builder
// ---------------------------------------------------------------------------

/**
 * Register the GitHub OAuth start and callback routes on the given Hono app.
 *
 * Both routes are registered as public (unauthenticated) via registerPublicRoute.
 * The callback route is compatible with future Fetch Metadata middleware because
 * GitHub redirects cross-site after authorization.
 *
 * Both routes apply the shared rate limiter before any work. The rate limiter
 * must be the same instance used in buildOperatorApp so OAuth routes participate
 * in the same per-socket budget.
 *
 * Call this from buildOperatorApp after the global middleware is set up.
 */
export function buildGitHubOAuthRoutes(app: Hono, deps: GitHubOAuthDeps, config: GitHubOAuthConfig): void {
  const callbackUri = `${config.publicOrigin}${config.callbackPath}`

  // ── GET /operator/auth/github/start ────────────────────────────────────────

  registerPublicRoute(app, 'GET', '/operator/auth/github/start', async (c: Context): Promise<Response> => {
    // Determine source key for rate limiting and outstanding-attempt counting.
    // Must be derived from the TCP socket address (not caller-spoofable headers).
    const sourceKey = deps.getSourceKey(c)

    // Rate limit check — shared with the operator app, keyed on socket address.
    if (deps.rateLimiter.allow(sourceKey) === false) {
      deps.logger.warn({}, 'oauth start rejected: rate limited')
      return rateLimitedResponse(c)
    }

    // Evict stale entries before counting outstanding so expired unconsumed
    // entries do not permanently block new starts once the cap is reached.
    deps.stateStore.evictStale(deps.clock(), config.stateTtlMs)

    // Check outstanding attempt cap before doing any work.
    const outstanding = deps.stateStore.countOutstanding(sourceKey)
    if (outstanding >= config.maxOutstandingAttemptsPerKey) {
      deps.logger.warn({}, 'oauth start rejected: outstanding attempt cap exceeded')
      return rateLimitedResponse(c)
    }

    // Check global store ceiling to prevent unbounded Map growth across distinct source keys.
    if (deps.stateStore.size() >= MAX_GLOBAL_STATE_STORE_ENTRIES) {
      deps.logger.warn({}, 'oauth start rejected: global state store ceiling reached')
      return rateLimitedResponse(c)
    }

    // Validate return_to before minting state.
    const returnTo = c.req.query('return_to')
    let redirectTarget: string | undefined
    if (returnTo !== undefined && returnTo !== '') {
      const validated = validateReturnPath(returnTo, config.allowedReturnPaths)
      if (validated === null) {
        deps.logger.warn({}, 'oauth start rejected: invalid return_to target')
        return badRequestResponse(c)
      }
      redirectTarget = validated
    }

    // Generate PKCE verifier and state — server-side only.
    const codeVerifier = deps.generateVerifier()
    const stateValue = deps.generateState()
    const codeChallenge = deriveCodeChallenge(codeVerifier)

    // Store state server-side. Code verifier NEVER leaves the server.
    deps.stateStore.set(stateValue, {
      codeVerifier,
      issuedAt: deps.clock(),
      consumed: false,
      ...(redirectTarget === undefined ? {} : {redirectTarget}),
      sourceKey,
    })

    // Emit auth.start audit event.
    emitAudit({kind: 'auth.start', correlationId: stateValue}, deps.auditLogger)

    // Build GitHub authorization URL.
    const authUrl = new URL('https://github.com/login/oauth/authorize')
    authUrl.searchParams.set('client_id', config.clientId)
    authUrl.searchParams.set('redirect_uri', callbackUri)
    authUrl.searchParams.set('state', stateValue)
    authUrl.searchParams.set('code_challenge', codeChallenge)
    authUrl.searchParams.set('code_challenge_method', 'S256')
    authUrl.searchParams.set('scope', 'read:user')

    return c.redirect(authUrl.toString(), 302)
  })

  // ── GET /operator/auth/github/callback ─────────────────────────────────────
  //
  // GitHub redirects the browser cross-site after authorization, so this route
  // is registered as a public cross-site route to allow Sec-Fetch-Site: cross-site.
  // The Fetch Metadata browser guard exempts this route from cross-site rejection.
  // All other security checks (state validation, PKCE, source key binding) remain.

  registerPublicCrossSiteRoute(app, 'GET', config.callbackPath, async (c: Context): Promise<Response> => {
    // Determine source key for rate limiting and source key binding validation.
    const sourceKey = deps.getSourceKey(c)

    // Rate limit check — shared with the operator app, keyed on socket address.
    if (deps.rateLimiter.allow(sourceKey) === false) {
      deps.logger.warn({}, 'oauth callback rejected: rate limited')
      return rateLimitedResponse(c)
    }

    // Correlation ID for audit events — use state value if present, else 'unknown'.
    const stateParam = c.req.query('state')
    const correlationId = stateParam ?? 'unknown'

    // Check for GitHub error param (provider_error).
    const errorParam = c.req.query('error')
    if (errorParam !== undefined) {
      // Only consume the state if it exists, is unconsumed, is not expired, and
      // the source key matches the one bound at mint time. This prevents a
      // different source from burning another source's state via a crafted
      // error callback.
      if (stateParam !== undefined && stateParam !== '') {
        const stateEntry = deps.stateStore.get(stateParam)
        const nowMs = deps.clock()
        if (
          stateEntry !== undefined &&
          stateEntry.consumed === false &&
          nowMs - stateEntry.issuedAt <= config.stateTtlMs &&
          (stateEntry.sourceKey === undefined || stateEntry.sourceKey === sourceKey)
        ) {
          deps.stateStore.consume(stateParam)
        }
      }
      deps.logger.warn({}, 'oauth callback: provider returned error')
      emitAudit({kind: 'auth.callback.failure', correlationId, reason: 'provider_error'}, deps.auditLogger)
      return badRequestResponse(c)
    }

    // Validate required params.
    const codeParam = c.req.query('code')
    if (stateParam === undefined || stateParam === '') {
      deps.logger.warn({}, 'oauth callback: missing state param')
      emitAudit({kind: 'auth.callback.failure', correlationId: 'unknown', reason: 'state_mismatch'}, deps.auditLogger)
      return badRequestResponse(c)
    }
    if (codeParam === undefined || codeParam === '') {
      deps.logger.warn({}, 'oauth callback: missing code param')
      emitAudit({kind: 'auth.callback.failure', correlationId, reason: 'state_mismatch'}, deps.auditLogger)
      return badRequestResponse(c)
    }

    // Look up state server-side.
    const stateEntry = deps.stateStore.get(stateParam)
    if (stateEntry === undefined) {
      deps.logger.warn({}, 'oauth callback: unknown state')
      emitAudit({kind: 'auth.callback.failure', correlationId, reason: 'state_mismatch'}, deps.auditLogger)
      return badRequestResponse(c)
    }

    // One-time consumption check.
    if (stateEntry.consumed === true) {
      deps.logger.warn({}, 'oauth callback: replayed state')
      emitAudit({kind: 'auth.callback.failure', correlationId, reason: 'state_mismatch'}, deps.auditLogger)
      return badRequestResponse(c)
    }

    // TTL check.
    const now = deps.clock()
    if (now - stateEntry.issuedAt > config.stateTtlMs) {
      deps.logger.warn({}, 'oauth callback: expired state')
      emitAudit({kind: 'auth.callback.failure', correlationId, reason: 'state_mismatch'}, deps.auditLogger)
      return badRequestResponse(c)
    }

    // Source key binding check — reject if the callback comes from a different
    // socket address than the one that initiated the flow. Uses the socket-derived
    // key only; never caller-spoofable headers.
    if (stateEntry.sourceKey !== undefined && stateEntry.sourceKey !== sourceKey) {
      deps.logger.warn({}, 'oauth callback: source key mismatch')
      emitAudit({kind: 'auth.callback.failure', correlationId, reason: 'source_key_mismatch'}, deps.auditLogger)
      return badRequestResponse(c)
    }

    // Consume state (one-time use) before any external calls.
    // This preserves the consume-before-external-await invariant.
    deps.stateStore.consume(stateParam)

    // Exchange code for access token using PKCE verifier.
    let accessToken: string
    try {
      const tokenBody = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code: codeParam,
        redirect_uri: callbackUri,
        code_verifier: stateEntry.codeVerifier,
      })

      const tokenRes = await deps.fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: tokenBody,
        signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
      })

      if (tokenRes.ok === false) {
        deps.logger.warn({}, 'oauth callback: token exchange HTTP error')
        emitAudit({kind: 'auth.callback.failure', correlationId, reason: 'token_exchange_failed'}, deps.auditLogger)
        return badRequestResponse(c)
      }

      const tokenData = parseTokenResponse(await tokenRes.json())
      if (tokenData === null) {
        deps.logger.warn({}, 'oauth callback: token exchange returned no access_token')
        emitAudit({kind: 'auth.callback.failure', correlationId, reason: 'token_exchange_failed'}, deps.auditLogger)
        return badRequestResponse(c)
      }

      accessToken = tokenData.access_token
    } catch {
      deps.logger.warn({}, 'oauth callback: token exchange threw')
      emitAudit({kind: 'auth.callback.failure', correlationId, reason: 'token_exchange_failed'}, deps.auditLogger)
      return badRequestResponse(c)
    }

    // Fetch authenticated GitHub user.
    let githubUserId: number
    let login: string
    try {
      const userRes = await deps.fetch('https://api.github.com/user', {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
        signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
      })

      if (userRes.ok === false) {
        deps.logger.warn({}, 'oauth callback: user fetch HTTP error')
        emitAudit({kind: 'auth.callback.failure', correlationId, reason: 'user_fetch_failed'}, deps.auditLogger)
        return badRequestResponse(c)
      }

      const userData = parseUserResponse(await userRes.json())
      if (userData === null) {
        deps.logger.warn({}, 'oauth callback: user fetch returned invalid id or login')
        emitAudit({kind: 'auth.callback.failure', correlationId, reason: 'user_fetch_failed'}, deps.auditLogger)
        return badRequestResponse(c)
      }

      githubUserId = userData.id
      login = userData.login
    } catch {
      deps.logger.warn({}, 'oauth callback: user fetch threw')
      emitAudit({kind: 'auth.callback.failure', correlationId, reason: 'user_fetch_failed'}, deps.auditLogger)
      return badRequestResponse(c)
    }

    deps.logger.info({githubUserId}, 'oauth callback: identity verified')

    // Mint a server-side session when a session store is wired.
    if (deps.sessionStore !== undefined && deps.sessionDeps !== undefined) {
      // Check allowlist BEFORE minting a session — non-allowlisted users must not
      // receive a session cookie. This is the authoritative allowlist gate for OAuth.
      if (deps.allowlist !== undefined && deps.allowlist.isAuthorized(githubUserId) === false) {
        deps.logger.warn({githubUserId}, 'oauth callback: operator not in allowlist — session not minted')
        emitAudit({kind: 'auth.callback.failure', correlationId, reason: 'not_allowlisted' as const}, deps.auditLogger)
        return forbiddenResponse(c)
      }

      const nowMs = deps.sessionDeps.clock()

      // Clear any stale pre-auth session cookie before setting the new one
      // to prevent session fixation.
      const existingCookieHeader = c.req.header('cookie')
      const existingSessionId = parseSessionCookie(existingCookieHeader)
      if (existingSessionId !== undefined) {
        deps.sessionStore.delete(existingSessionId)
      }

      // Pass the access token to the session store for server-side retention.
      // The token is stored in-memory only — never in the cookie, never logged,
      // never in any operator-facing response. The cookie value remains the opaque
      // session ID; the token is accessible only via sessionStore.getOperatorToken().
      const newSessionId = deps.sessionStore.create({githubUserId, login}, accessToken, nowMs)
      if (newSessionId === undefined) {
        // Session cap reached — return 503 with Retry-After so clients know to retry.
        // This is a capacity issue, not a bad request; 400 would be semantically wrong.
        deps.sessionDeps.logger.warn({githubUserId}, 'oauth callback: session cap reached')
        return unavailableResponse(c, 60)
      }

      // Emit success audit event only after session is successfully minted.
      emitAudit({kind: 'auth.callback.success', correlationId, githubUserId, login}, deps.auditLogger)

      // Register the operator push deactivation hook for this session, closing
      // over githubUserId now — sessionStore.onRevoke's hook only receives the
      // sessionId, and the entry's identity is not reliably readable once the
      // session has been marked revoked.
      if (deps.onSessionRevoke !== undefined) {
        deps.sessionStore.onRevoke(newSessionId, () => {
          deps.onSessionRevoke?.(githubUserId)
        })
      }

      // Clear stale cookie first, then set the new session cookie.
      // Hono's c.header() appends when called multiple times for Set-Cookie.
      if (existingSessionId !== undefined) {
        c.header('Set-Cookie', buildSessionCookieValue('', {clear: true}), {append: true})
      }
      c.header('Set-Cookie', buildSessionCookieValue(newSessionId), {append: true})

      deps.sessionDeps.logger.info({githubUserId}, 'oauth callback: session minted')

      // Redirect to the validated return path if one was captured at flow start.
      // Re-validate here as defense-in-depth — the allowlist config could differ
      // from what was checked at /start, and stored targets must never be trusted
      // unconditionally. Use the returned validated path, not the raw stored value.
      if (stateEntry.redirectTarget !== undefined && stateEntry.redirectTarget !== '') {
        const validatedPath = validateReturnPath(stateEntry.redirectTarget, config.allowedReturnPaths)
        if (validatedPath !== null) {
          return c.redirect(validatedPath, 302)
        }
      }

      return c.json({githubUserId, login}, 200)
    }

    // No session store wired — identity verified, emit success audit before returning.
    emitAudit({kind: 'auth.callback.success', correlationId, githubUserId, login}, deps.auditLogger)
    return c.json({githubUserId, login}, 200)
  })
}
