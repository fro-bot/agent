/**
 * Repo authorization helper for the operator web surface.
 *
 * Single helper used by all privileged routes (launch, run-state, approvals,
 * binding reads). v1 rule: operator must be in the allowlist AND the user OAuth
 * token must prove GitHub read access to the target repo.
 *
 * Security invariants:
 *   - Fail closed: any lookup error, network failure, or unexpected status denies.
 *   - Allowlist check runs first; non-allowlisted operators never trigger a GitHub call.
 *   - User OAuth token is NEVER logged, audited, or included in cache keys that
 *     could be serialized/debugged. Cache key uses a random opaque token identity
 *     (UUID, assigned per token per cache instance) so the raw token never appears
 *     in any key.
 *   - Audit events include numeric GitHub user ID and safe owner/repo; never token values.
 *   - Owner/repo names are validated before any authz or GitHub call.
 *   - Positive TTL: 5 minutes. Negative TTL: 30 seconds. Both with jitter.
 *   - Concurrent misses for the same effective cache key coalesce into one GitHub call.
 *   - GitHub rate-limit responses (403/429 with Retry-After or x-ratelimit-remaining=0)
 *     are cached through the retry window.
 */

import type {AuditLogger, AuthzDeniedReason} from '../audit.js'
import type {OperatorAllowlist} from './allowlist.js'
import {randomUUID} from 'node:crypto'
import {emitAudit} from '../audit.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Logger interface for the repo authz module. */
export interface RepoAuthzLogger {
  readonly debug: (ctx: Record<string, unknown>, msg: string) => void
  readonly info: (ctx: Record<string, unknown>, msg: string) => void
  readonly warn: (ctx: Record<string, unknown>, msg: string) => void
  readonly error: (ctx: Record<string, unknown>, msg: string) => void
}

/** Result of a repo authorization check. */
export type RepoAuthzResult =
  | {readonly authorized: true}
  | {readonly authorized: false; readonly reason: RepoAuthzDeniedReason}

/** Result of a write-level repo authorization check. */
export type RepoWriteAuthzResult =
  | {readonly authorized: true; readonly level: 'write' | 'admin'}
  | {readonly authorized: false; readonly reason: RepoAuthzDeniedReason}

type AuditableRepoAuthzDeniedReason<T extends AuthzDeniedReason> = T

/**
 * Reasons for repo authorization denial surfaced by checkRepoAuthz and checkRepoWriteAuthz.
 *
 * Intentionally excludes audit-only outer reasons like `unknown` and `suspended`
 * until this helper owns those paths.
 *
 * `insufficient_permission` is returned by checkRepoWriteAuthz when the GitHub
 * response confirms repo access but the operator lacks push/admin permission.
 */
export type RepoAuthzDeniedReason = AuditableRepoAuthzDeniedReason<
  | 'invalid_repo_name'
  | 'not_allowlisted'
  | 'github_denied'
  | 'rate_limited'
  | 'lookup_error'
  | 'insufficient_permission'
>

/**
 * A single cache entry — discriminated union to make impossible states impossible.
 * Authorized entries never carry a reason; denied entries always carry one.
 * Write-level authorized entries carry an optional `level` field.
 */
type CacheEntry =
  | {readonly authorized: true; readonly level?: 'write' | 'admin'; readonly expiresAt: number}
  | {readonly authorized: false; readonly reason: RepoAuthzDeniedReason; readonly expiresAt: number}

/** In-flight coalescing promise for a cache key. */
type InFlight = Promise<RepoAuthzResult>

/** The repo authz cache — holds positive/negative results and in-flight coalescing promises. */
export interface RepoAuthzCache {
  /** Get a cached entry by key. Returns undefined if absent or expired. */
  readonly get: (key: string, nowMs: number) => CacheEntry | undefined
  /** Set a cache entry. */
  readonly set: (key: string, entry: CacheEntry) => void
  /** Get an in-flight promise for a key (coalescing). */
  readonly getInFlight: (key: string) => InFlight | undefined
  /** Set an in-flight promise for a key. */
  readonly setInFlight: (key: string, promise: InFlight) => void
  /** Remove an in-flight promise for a key. */
  readonly deleteInFlight: (key: string) => void
  /**
   * Return a stable opaque identity string for the given token, scoped to this cache instance.
   *
   * The identity is a random UUID assigned on first call and reused on subsequent calls with
   * the same token. The raw token is held only as an in-memory Map key within this cache
   * instance — it is never serialized, logged, or included in any cache entry key.
   */
  readonly tokenIdentityFor: (token: string) => string
}

/** Injectable dependencies for checkRepoAuthz. */
export interface RepoAuthzDeps {
  /** Operator allowlist — checked before any GitHub call. */
  readonly allowlist: OperatorAllowlist
  /** Injectable fetch for GitHub API calls. Defaults to globalThis.fetch. */
  readonly fetch: typeof globalThis.fetch
  /** Injectable clock for TTL checks. Defaults to Date.now. */
  readonly clock: () => number
  /**
   * Injectable random() for TTL jitter. Must return a value in [0, 1).
   * Defaults to Math.random.
   */
  readonly random: () => number
  /** Audit logger for security events. */
  readonly auditLogger: AuditLogger
  /** Structured logger. */
  readonly logger: RepoAuthzLogger
  /** Shared cache instance. Pass createRepoAuthzCache() for isolation in tests. */
  readonly cache: RepoAuthzCache
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Positive authz TTL: 5 minutes in ms. */
const POSITIVE_TTL_MS = 5 * 60 * 1000

/**
 * Positive write-authz TTL: 60 seconds in ms.
 *
 * Shorter than the read TTL because a write→read demotion (e.g. repo access
 * revoked or permission downgraded) must not let an approve succeed for minutes.
 * Revocation-safety is the primary constraint here.
 */
const WRITE_POSITIVE_TTL_MS = 60 * 1000

/** Negative authz TTL: 30 seconds in ms. */
const NEGATIVE_TTL_MS = 30 * 1000

/**
 * Cache key prefix for write-level authz entries.
 *
 * Distinct from the read-level prefix so write and read entries never collide
 * in the shared cache instance. Read entries use no prefix (bare key); write
 * entries use "w:" so a cached read-authorized result cannot satisfy a
 * write-level check and vice versa.
 */
const WRITE_CACHE_KEY_PREFIX = 'w:'

/** Maximum TTL jitter: 10% of the base TTL. */
const JITTER_FRACTION = 0.1

/** GitHub API timeout. */
const GITHUB_FETCH_TIMEOUT_MS = 8_000

/**
 * Maximum rate-limit cache duration cap.
 * If Retry-After or x-ratelimit-reset implies a window longer than this,
 * cap it to avoid caching denials indefinitely.
 */
const MAX_RATE_LIMIT_CACHE_MS = 15 * 60 * 1000

/** Default maximum number of entries in the in-memory cache. */
const DEFAULT_CACHE_MAX_SIZE = 10_000

// ---------------------------------------------------------------------------
// Response body cleanup
// ---------------------------------------------------------------------------

/**
 * Cancel a response body best-effort and non-blocking.
 * Swallows any rejection so callers never get an unhandled promise rejection.
 */
function cancelResponseBody(response: Response): void {
  response.body?.cancel().catch(() => undefined)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * GitHub owner/repo name validation.
 *
 * GitHub owner names: alphanumeric and hyphens, 1–39 chars, no leading/trailing hyphen.
 * GitHub repo names: alphanumeric, hyphens, underscores, dots; 1–100 chars.
 * We are intentionally strict to reject path traversal, null bytes, and injection attempts.
 * Single-segment names `.` and `..` are explicitly rejected as path traversal.
 */
const OWNER_RE = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i
const REPO_RE = /^[\w.-]{1,100}$/

function isValidOwner(owner: string): boolean {
  return OWNER_RE.test(owner)
}

function isValidRepo(repo: string): boolean {
  if (repo === '.' || repo === '..') return false
  if (repo.includes('\u0000')) return false
  return REPO_RE.test(repo)
}

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

/**
 * Build a cache key for operator/repo/token identity.
 *
 * The token identity is a random opaque UUID assigned per token per cache instance
 * (see RepoAuthzCache.tokenIdentityFor). The raw token value never appears in the
 * cache key, preventing accidental exposure in debug output or serialization.
 * The key is scoped to operator ID + owner/repo + token identity.
 */
function buildCacheKey(operatorId: number, owner: string, repo: string, tokenIdentity: string): string {
  return `${operatorId}:${owner}/${repo}:${tokenIdentity}`
}

// ---------------------------------------------------------------------------
// TTL with jitter
// ---------------------------------------------------------------------------

function withJitter(baseTtlMs: number, random: () => number): number {
  const jitter = Math.floor(baseTtlMs * JITTER_FRACTION * random())
  return baseTtlMs + jitter
}

// ---------------------------------------------------------------------------
// Rate-limit window parsing
// ---------------------------------------------------------------------------

/**
 * Parse the rate-limit retry window from response headers.
 *
 * Priority:
 *   1. Retry-After (seconds, integer, must be > 0)
 *   2. x-ratelimit-reset (Unix epoch seconds, only when x-ratelimit-remaining === '0')
 *
 * Returns the number of milliseconds to cache the denial, or null if neither
 * header is present or parseable.
 *
 * Caps the result at MAX_RATE_LIMIT_CACHE_MS.
 * Empty or missing headers are not treated as rate-limit signals.
 */
function parseRateLimitWindowMs(headers: {get: (name: string) => string | null}, nowMs: number): number | null {
  const retryAfter = headers.get('retry-after')
  if (retryAfter !== null && retryAfter !== '') {
    const seconds = /^\d+$/.test(retryAfter) ? Number.parseInt(retryAfter, 10) : Number.NaN
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, MAX_RATE_LIMIT_CACHE_MS)
    }
    // Retry-After present but zero/negative/non-numeric — not a rate-limit signal
    return null
  }

  // Only treat x-ratelimit-reset as a rate-limit signal when remaining === '0'
  const remaining = headers.get('x-ratelimit-remaining')
  if (remaining !== '0') return null

  const resetHeader = headers.get('x-ratelimit-reset')
  if (resetHeader !== null && resetHeader !== '') {
    const resetEpochSec = /^\d+$/.test(resetHeader) ? Number.parseInt(resetHeader, 10) : Number.NaN
    if (Number.isFinite(resetEpochSec)) {
      const resetMs = resetEpochSec * 1000
      const windowMs = resetMs - nowMs
      if (windowMs > 0) {
        return Math.min(windowMs, MAX_RATE_LIMIT_CACHE_MS)
      }
      // Reset is in the past — fall through to return null (use NEGATIVE_TTL_MS)
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Cache factory
// ---------------------------------------------------------------------------

/**
 * Create a fresh in-memory repo authz cache.
 *
 * Suitable for v1 single-process deployment. Gateway restart clears all cache
 * entries (acceptable for v1).
 *
 * Pass a fresh instance per test for isolation.
 *
 * @param maxSize - Maximum number of entries before oldest is evicted (default: 10_000).
 *   Uses Map insertion-order LRU-lite: when at cap, the oldest entry is evicted on set().
 */
export function createRepoAuthzCache(maxSize: number = DEFAULT_CACHE_MAX_SIZE): RepoAuthzCache {
  // Harden against 0, negative, NaN, and non-finite values — clamp to at least 1.
  const effectiveMaxSize = Number.isFinite(maxSize) && maxSize >= 1 ? Math.floor(maxSize) : DEFAULT_CACHE_MAX_SIZE
  const entries = new Map<string, CacheEntry>()
  const inFlight = new Map<string, InFlight>()
  // Token identity registry: maps raw token (in-memory only) → opaque random UUID.
  // The raw token is never serialized, logged, or included in any entry key.
  const tokenIdentities = new Map<string, string>()

  return {
    get(key: string, nowMs: number): CacheEntry | undefined {
      const entry = entries.get(key)
      if (entry === undefined) return undefined
      if (nowMs >= entry.expiresAt) {
        entries.delete(key)
        return undefined
      }
      return entry
    },

    set(key: string, entry: CacheEntry): void {
      // Evict oldest entry when at cap (Map preserves insertion order)
      if (entries.size >= effectiveMaxSize && !entries.has(key)) {
        const oldestKey = entries.keys().next().value
        if (oldestKey !== undefined) {
          entries.delete(oldestKey)
        }
      }
      entries.set(key, entry)
    },

    getInFlight(key: string): InFlight | undefined {
      return inFlight.get(key)
    },

    setInFlight(key: string, promise: InFlight): void {
      inFlight.set(key, promise)
    },

    deleteInFlight(key: string): void {
      inFlight.delete(key)
    },

    tokenIdentityFor(token: string): string {
      const existing = tokenIdentities.get(token)
      if (existing !== undefined) return existing
      const id = randomUUID()
      tokenIdentities.set(token, id)
      return id
    },
  }
}

// ---------------------------------------------------------------------------
// Core helper
// ---------------------------------------------------------------------------

/**
 * Check whether the given operator is authorized to access the given repo.
 *
 * v1 rule:
 *   1. Validate owner/repo names — reject malformed names immediately.
 *   2. Check operator allowlist — deny without GitHub call if not allowlisted.
 *   3. Check cache — return cached result if present and not expired.
 *   4. Coalesce concurrent misses — if an in-flight request exists for the same
 *      cache key, wait for it instead of issuing a duplicate GitHub call.
 *   5. Call GitHub repos API with the user OAuth token — treat 2xx as authorized,
 *      non-2xx as denied. Rate-limit responses are cached through the retry window.
 *   6. Cache the result and return.
 *
 * Emits `authz.denied` audit events on every denial.
 *
 * @param operatorId - Stable numeric GitHub user ID of the operator. Must come from
 *   the authenticated session — route integration must pass the authenticated operator id.
 * @param owner - Repository owner (GitHub org or user login).
 * @param repo - Repository name.
 * @param userOAuthToken - User OAuth token for GitHub API call. Must come from the
 *   authenticated session. NEVER logged, persisted, or passed outside this function.
 * @param deps - Injectable dependencies.
 */
export async function checkRepoAuthz(
  operatorId: number,
  owner: string,
  repo: string,
  userOAuthToken: string,
  deps: RepoAuthzDeps,
): Promise<RepoAuthzResult> {
  const {allowlist, clock, auditLogger, logger, cache} = deps

  // ── Step 1: Validate owner/repo names ──────────────────────────────────────
  if (isValidOwner(owner) === false || isValidRepo(repo) === false) {
    logger.warn({githubUserId: operatorId}, 'repo-authz: invalid owner/repo name — rejecting before authz')
    emitAudit(
      {
        kind: 'authz.denied',
        correlationId: 'repo-authz:invalid-repo-name',
        githubUserId: operatorId,
        reason: 'invalid_repo_name',
      },
      auditLogger,
    )
    return {authorized: false, reason: 'invalid_repo_name'}
  }

  // ── Step 2: Allowlist check ─────────────────────────────────────────────────
  if (allowlist.isAuthorized(operatorId) === false) {
    logger.warn({githubUserId: operatorId, owner, repo}, 'repo-authz: operator not in allowlist')
    emitAudit(
      {
        kind: 'authz.denied',
        correlationId: `repo-authz:${operatorId}:${owner}/${repo}`,
        githubUserId: operatorId,
        reason: 'not_allowlisted',
      },
      auditLogger,
    )
    return {authorized: false, reason: 'not_allowlisted'}
  }

  // ── Step 3: Cache lookup ────────────────────────────────────────────────────
  const tokenIdentity = cache.tokenIdentityFor(userOAuthToken)
  const cacheKey = buildCacheKey(operatorId, owner, repo, tokenIdentity)
  const nowMs = clock()
  const cached = cache.get(cacheKey, nowMs)
  if (cached !== undefined) {
    if (cached.authorized === true) {
      return {authorized: true}
    }
    // Cached negative — emit audit and structured warn for this request.
    // (The original miss already audited once; we re-emit per request for traceability.)
    const cachedReason = cached.reason
    logger.warn({githubUserId: operatorId, owner, repo, reason: cachedReason}, 'repo-authz: cached denial')
    emitAudit(
      {
        kind: 'authz.denied',
        correlationId: `repo-authz:${operatorId}:${owner}/${repo}`,
        githubUserId: operatorId,
        reason: cachedReason,
      },
      auditLogger,
    )
    return {authorized: false, reason: cachedReason}
  }

  // ── Step 4: Coalesce concurrent misses ─────────────────────────────────────
  const existing = cache.getInFlight(cacheKey)
  if (existing !== undefined) {
    // Wait for the in-flight request; if it denies, emit audit for this caller.
    const coalesced = await existing
    if (coalesced.authorized === false) {
      emitAudit(
        {
          kind: 'authz.denied',
          correlationId: `repo-authz:${operatorId}:${owner}/${repo}`,
          githubUserId: operatorId,
          reason: coalesced.reason,
        },
        auditLogger,
      )
    }
    return coalesced
  }

  // ── Step 5: GitHub API call ─────────────────────────────────────────────────
  const promise = performGitHubCheck(operatorId, owner, repo, userOAuthToken, cacheKey, deps)
  cache.setInFlight(cacheKey, promise)

  try {
    return await promise
  } finally {
    cache.deleteInFlight(cacheKey)
  }
}

// ---------------------------------------------------------------------------
// GitHub check (inner — called once per cache miss)
// ---------------------------------------------------------------------------

async function performGitHubCheck(
  operatorId: number,
  owner: string,
  repo: string,
  userOAuthToken: string,
  cacheKey: string,
  deps: RepoAuthzDeps,
): Promise<RepoAuthzResult> {
  const {fetch: fetchFn, random, auditLogger, logger, cache} = deps

  const deny = (reason: RepoAuthzDeniedReason, ttlMs: number, writeTimeMs: number): RepoAuthzResult => {
    // TTL computed from clock() at cache-write time (writeTimeMs), not request-start time.
    const expiresAt = writeTimeMs + withJitter(ttlMs, random)
    cache.set(cacheKey, {authorized: false, reason, expiresAt})
    emitAudit(
      {
        kind: 'authz.denied',
        correlationId: `repo-authz:${operatorId}:${owner}/${repo}`,
        githubUserId: operatorId,
        reason,
      },
      auditLogger,
    )
    return {authorized: false, reason}
  }

  let response: Response | undefined
  try {
    response = await fetchFn(`https://api.github.com/repos/${owner}/${repo}`, {
      method: 'GET',
      headers: {
        // Token is passed in the header but NEVER logged or cached in plaintext.
        authorization: `Bearer ${userOAuthToken}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
    })

    // Snapshot clock at response-received time for accurate TTL computation.
    const {clock} = deps
    const writeTimeMs = clock()

    // Rate-limit handling: 429 always; 403 only when Retry-After or (remaining=0 + reset)
    if (response.status === 429 || (response.status === 403 && isRateLimitResponse(response))) {
      const windowMs = parseRateLimitWindowMs(response.headers, writeTimeMs)
      const ttlMs = windowMs === null ? NEGATIVE_TTL_MS : windowMs
      logger.warn({githubUserId: operatorId, owner, repo, status: response.status}, 'repo-authz: GitHub rate limited')
      cancelResponseBody(response)
      return deny('rate_limited', ttlMs, writeTimeMs)
    }

    if (response.ok === true) {
      // Authorized — cache positive result
      const expiresAt = writeTimeMs + withJitter(POSITIVE_TTL_MS, random)
      cache.set(cacheKey, {authorized: true, expiresAt})
      logger.info({githubUserId: operatorId, owner, repo}, 'repo-authz: authorized')
      cancelResponseBody(response)
      return {authorized: true}
    }

    // 5xx — server error, not a definitive denial; return lookup_error
    if (response.status >= 500) {
      logger.warn(
        {githubUserId: operatorId, owner, repo, status: response.status},
        'repo-authz: GitHub server error — failing closed',
      )
      cancelResponseBody(response)
      return deny('lookup_error', NEGATIVE_TTL_MS, writeTimeMs)
    }

    // Non-2xx, non-rate-limit, non-5xx — denied
    logger.warn({githubUserId: operatorId, owner, repo, status: response.status}, 'repo-authz: GitHub denied access')
    cancelResponseBody(response)
    return deny('github_denied', NEGATIVE_TTL_MS, writeTimeMs)
  } catch (error: unknown) {
    // Network error, timeout, etc. — fail closed.
    // Log only a safe error kind; never log error.message or String(error) which
    // could contain hostile content from a thrown value with a custom toString().
    const errorKind =
      error instanceof Error ? (error.constructor.name === 'Error' ? 'Error' : error.constructor.name) : typeof error
    logger.warn(
      {githubUserId: operatorId, owner, repo, errorKind},
      'repo-authz: GitHub API lookup failed — failing closed',
    )
    const {clock} = deps
    return deny('lookup_error', NEGATIVE_TTL_MS, clock())
  }
}

// ---------------------------------------------------------------------------
// Rate-limit detection
// ---------------------------------------------------------------------------

/**
 * Determine whether a 403 response is a rate-limit response.
 *
 * GitHub returns 403 for both access denial and rate limiting. We treat a 403
 * as a rate-limit response only if:
 *   - Retry-After header is present and non-empty, OR
 *   - x-ratelimit-remaining === '0' AND x-ratelimit-reset is present and non-empty.
 *
 * A 403 with only x-ratelimit-reset (but remaining not '0') is NOT treated as
 * rate-limited — it is a plain access denial.
 */
function isRateLimitResponse(response: {headers: {get: (name: string) => string | null}}): boolean {
  const retryAfter = response.headers.get('retry-after')
  if (retryAfter !== null && retryAfter !== '') return true

  const remaining = response.headers.get('x-ratelimit-remaining')
  if (remaining !== '0') return false

  const reset = response.headers.get('x-ratelimit-reset')
  return reset !== null && reset !== ''
}

// ---------------------------------------------------------------------------
// Write-level authorization
// ---------------------------------------------------------------------------

/**
 * Module-level in-flight coalescing map for write-level authorization checks.
 *
 * Separate from the cache's read-level in-flight map so the coalesced result
 * is typed as `RepoWriteAuthzResult` without a cast. The cache's
 * `setInFlight`/`getInFlight` are used for read-level only.
 *
 * Keyed by the write-level cache key (same key used for the cache entry).
 */
const writeInFlight = new Map<string, Promise<RepoWriteAuthzResult>>()

/**
 * Check whether the given operator has WRITE or ADMIN permission on the given repo.
 *
 * Distinct from checkRepoAuthz (read-level). Used by the approval decision route
 * where submitting a decision requires a strictly higher bar than read access.
 *
 * v1 rule:
 *   1. Validate owner/repo names — reject malformed names immediately.
 *   2. Check operator allowlist — deny without GitHub call if not allowlisted.
 *   3. Check cache (write-level key prefix "w:") — return cached result if present.
 *   4. Coalesce concurrent misses — wait for in-flight request if one exists.
 *   5. Call GitHub repos API and READ the response body to inspect `permissions`.
 *      - `permissions.admin === true` → level 'admin'
 *      - `permissions.push === true` → level 'write'
 *      - otherwise → {authorized: false, reason: 'insufficient_permission'}
 *      - missing/malformed body → {authorized: false, reason: 'insufficient_permission'}
 *   6. Cache the result with a SHORT positive TTL (~60 s) and return.
 *
 * Permission source decision: we use the existing GET /repos/{owner}/{repo} endpoint
 * (same URL as checkRepoAuthz) and READ the response body's `permissions` object.
 * This is one fewer network call than the collaborator-permission endpoint
 * (GET /repos/{owner}/{repo}/collaborators/{username}/permission), and the
 * `permissions` field is reliably present for authenticated users with any access.
 * The body is parsed defensively — missing/malformed/non-object permissions are
 * treated as insufficient_permission (fail closed), never as an error that throws.
 *
 * Cache key uses the "w:" prefix to prevent collision with read-level entries.
 * Positive TTL is 60 s (vs 5 min for read) for revocation safety.
 * Negative TTL is 30 s (same as read).
 *
 * @param operatorId - Stable numeric GitHub user ID of the operator.
 * @param owner - Repository owner (GitHub org or user login).
 * @param repo - Repository name.
 * @param userOAuthToken - User OAuth token. NEVER logged, persisted, or passed outside this function.
 * @param deps - Injectable dependencies (same as checkRepoAuthz).
 */
export async function checkRepoWriteAuthz(
  operatorId: number,
  owner: string,
  repo: string,
  userOAuthToken: string,
  deps: RepoAuthzDeps,
): Promise<RepoWriteAuthzResult> {
  const {allowlist, clock, auditLogger, logger, cache} = deps

  // ── Step 1: Validate owner/repo names ──────────────────────────────────────
  if (isValidOwner(owner) === false || isValidRepo(repo) === false) {
    logger.warn({githubUserId: operatorId}, 'repo-write-authz: invalid owner/repo name — rejecting before authz')
    emitAudit(
      {
        kind: 'authz.denied',
        correlationId: 'repo-write-authz:invalid-repo-name',
        githubUserId: operatorId,
        reason: 'invalid_repo_name',
      },
      auditLogger,
    )
    return {authorized: false, reason: 'invalid_repo_name'}
  }

  // ── Step 2: Allowlist check ─────────────────────────────────────────────────
  if (allowlist.isAuthorized(operatorId) === false) {
    logger.warn({githubUserId: operatorId, owner, repo}, 'repo-write-authz: operator not in allowlist')
    emitAudit(
      {
        kind: 'authz.denied',
        correlationId: `repo-write-authz:${operatorId}:${owner}/${repo}`,
        githubUserId: operatorId,
        reason: 'not_allowlisted',
      },
      auditLogger,
    )
    return {authorized: false, reason: 'not_allowlisted'}
  }

  // ── Step 3: Cache lookup (write-level key) ──────────────────────────────────
  const tokenIdentity = cache.tokenIdentityFor(userOAuthToken)
  const cacheKey = WRITE_CACHE_KEY_PREFIX + buildCacheKey(operatorId, owner, repo, tokenIdentity)
  const nowMs = clock()
  const cached = cache.get(cacheKey, nowMs)
  if (cached !== undefined) {
    if (cached.authorized === true) {
      // level is always present on write-level authorized entries
      const level = cached.level ?? 'write'
      return {authorized: true, level}
    }
    const cachedReason = cached.reason
    logger.warn({githubUserId: operatorId, owner, repo, reason: cachedReason}, 'repo-write-authz: cached denial')
    emitAudit(
      {
        kind: 'authz.denied',
        correlationId: `repo-write-authz:${operatorId}:${owner}/${repo}`,
        githubUserId: operatorId,
        reason: cachedReason,
      },
      auditLogger,
    )
    return {authorized: false, reason: cachedReason}
  }

  // ── Step 4: Coalesce concurrent misses ─────────────────────────────────────
  // The write-level in-flight map is separate from the cache's read-level
  // in-flight map so the coalesced result is typed as RepoWriteAuthzResult
  // without a cast. The cache's setInFlight/getInFlight are used for read-level
  // only; write-level uses writeInFlight (module-level, keyed by cacheKey).
  const existingWrite = writeInFlight.get(cacheKey)
  if (existingWrite !== undefined) {
    const coalesced = await existingWrite
    if (coalesced.authorized === false) {
      emitAudit(
        {
          kind: 'authz.denied',
          correlationId: `repo-write-authz:${operatorId}:${owner}/${repo}`,
          githubUserId: operatorId,
          reason: coalesced.reason,
        },
        auditLogger,
      )
    }
    return coalesced
  }

  // ── Step 5: GitHub API call (reads body for permissions) ───────────────────
  const promise = performGitHubWriteCheck(operatorId, owner, repo, userOAuthToken, cacheKey, deps)
  writeInFlight.set(cacheKey, promise)

  try {
    return await promise
  } finally {
    writeInFlight.delete(cacheKey)
  }
}

// ---------------------------------------------------------------------------
// GitHub write check (inner — reads permissions body)
// ---------------------------------------------------------------------------

/**
 * Parse the GitHub repo permissions object from a parsed JSON body.
 *
 * Returns 'admin' | 'write' | null.
 * - null means insufficient permission or unreadable body.
 * - Strict boolean checks: only `=== true` counts; truthy strings like "true" do not.
 * - Prototype-safe: only own-property access via Object.prototype.hasOwnProperty.
 */
function parseWriteLevel(body: unknown): 'admin' | 'write' | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null

  const record = body as Record<string, unknown>
  const permissions = Object.prototype.hasOwnProperty.call(record, 'permissions') ? record.permissions : undefined
  if (permissions === null || typeof permissions !== 'object' || Array.isArray(permissions)) return null

  const perms = permissions as Record<string, unknown>

  // Strict boolean checks — string "true" or number 1 are not accepted.
  const admin = Object.prototype.hasOwnProperty.call(perms, 'admin') ? perms.admin : undefined
  if (admin === true) return 'admin'

  const push = Object.prototype.hasOwnProperty.call(perms, 'push') ? perms.push : undefined
  if (push === true) return 'write'

  return null
}

async function performGitHubWriteCheck(
  operatorId: number,
  owner: string,
  repo: string,
  userOAuthToken: string,
  cacheKey: string,
  deps: RepoAuthzDeps,
): Promise<RepoWriteAuthzResult> {
  const {fetch: fetchFn, random, auditLogger, logger, cache} = deps

  const deny = (reason: RepoAuthzDeniedReason, ttlMs: number, writeTimeMs: number): RepoWriteAuthzResult => {
    const expiresAt = writeTimeMs + withJitter(ttlMs, random)
    cache.set(cacheKey, {authorized: false, reason, expiresAt})
    emitAudit(
      {
        kind: 'authz.denied',
        correlationId: `repo-write-authz:${operatorId}:${owner}/${repo}`,
        githubUserId: operatorId,
        reason,
      },
      auditLogger,
    )
    return {authorized: false, reason}
  }

  let response: Response | undefined
  try {
    response = await fetchFn(`https://api.github.com/repos/${owner}/${repo}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${userOAuthToken}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
    })

    const {clock} = deps
    const writeTimeMs = clock()

    // Rate-limit handling: 429 always; 403 only when Retry-After or (remaining=0 + reset)
    if (response.status === 429 || (response.status === 403 && isRateLimitResponse(response))) {
      const windowMs = parseRateLimitWindowMs(response.headers, writeTimeMs)
      const ttlMs = windowMs === null ? NEGATIVE_TTL_MS : windowMs
      logger.warn(
        {githubUserId: operatorId, owner, repo, status: response.status},
        'repo-write-authz: GitHub rate limited',
      )
      cancelResponseBody(response)
      return deny('rate_limited', ttlMs, writeTimeMs)
    }

    if (response.ok === true) {
      // Read the body to inspect permissions — this is the key difference from checkRepoAuthz.
      let body: unknown
      try {
        body = await response.json()
      } catch {
        // Malformed JSON — fail closed as insufficient_permission (not a network error).
        logger.warn(
          {githubUserId: operatorId, owner, repo},
          'repo-write-authz: failed to parse GitHub response body — treating as insufficient_permission',
        )
        return deny('insufficient_permission', NEGATIVE_TTL_MS, writeTimeMs)
      }

      const level = parseWriteLevel(body)
      if (level === null) {
        logger.warn(
          {githubUserId: operatorId, owner, repo},
          'repo-write-authz: permissions.push/admin not true — insufficient_permission',
        )
        return deny('insufficient_permission', NEGATIVE_TTL_MS, writeTimeMs)
      }

      // Authorized — cache with short positive TTL for revocation safety.
      const expiresAt = writeTimeMs + withJitter(WRITE_POSITIVE_TTL_MS, random)
      cache.set(cacheKey, {authorized: true, level, expiresAt})
      logger.info({githubUserId: operatorId, owner, repo, level}, 'repo-write-authz: authorized')
      return {authorized: true, level}
    }

    // 5xx — server error, fail closed
    if (response.status >= 500) {
      logger.warn(
        {githubUserId: operatorId, owner, repo, status: response.status},
        'repo-write-authz: GitHub server error — failing closed',
      )
      cancelResponseBody(response)
      return deny('lookup_error', NEGATIVE_TTL_MS, writeTimeMs)
    }

    // Non-2xx, non-rate-limit, non-5xx — denied
    logger.warn(
      {githubUserId: operatorId, owner, repo, status: response.status},
      'repo-write-authz: GitHub denied access',
    )
    cancelResponseBody(response)
    return deny('github_denied', NEGATIVE_TTL_MS, writeTimeMs)
  } catch (error: unknown) {
    const errorKind =
      error instanceof Error ? (error.constructor.name === 'Error' ? 'Error' : error.constructor.name) : typeof error
    logger.warn(
      {githubUserId: operatorId, owner, repo, errorKind},
      'repo-write-authz: GitHub API lookup failed — failing closed',
    )
    const {clock} = deps
    return deny('lookup_error', NEGATIVE_TTL_MS, clock())
  }
}
