/**
 * Authenticated repo-listing route: GET /operator/repos
 *
 * Returns the set of bound, non-denylisted repositories an authenticated operator
 * can launch work in. The repo-access rule is the same bindings-only predicate every
 * other operator route uses (see resolveRepoAccess); this listing already holds the
 * bindings, so it filters them directly instead of re-reading each one.
 *
 * Gate ordering (all must pass before any repo data is returned):
 *   1. Guard (browser/session/allowlist) — installed by buildOperatorApp
 *   2. Operator rate limit (20/min, operator-keyed) — before binding enumeration
 *   3. Redaction policy availability — 503 {error: 'redaction-policy-unavailable'}, before any binding read
 *   4. listBindings() — enumerate all bound repos
 *   5. filterDeniedRecords() — drop denylisted repos, then re-check availability (grace can expire mid-read → 503)
 *   6. Dedup by owner/repo, then cap
 *   7. Map to RepoSummary[]; return 200
 *
 * Security invariants:
 *   - Denylisted repos are silently omitted (no oracle).
 *   - An unavailable redaction policy is reported as a 503, never as an empty list; fail-closed stays fail-closed
 *     (nothing is listed). The 503 names no repo and counts none.
 *   - Store errors return a coarse error; no partial list leaks.
 *   - Response carries no deny-keys, workspacePath, channelId, or internal IDs.
 *   - Result is capped at MAX_REPOS_PER_LISTING distinct owner/repo pairs (no pagination machinery).
 *   - No per-repo store call and no GitHub call: the listing makes exactly one listBindings read.
 */

import type {Hono} from 'hono'
import type {RepoBinding} from '../../bindings/types.js'
import type {RateLimiter} from '../../http/rate-limit.js'
import type {RepoKey} from '../../redaction/denylist.js'
import type {OperatorLogger} from '../server.js'
import {createRateLimiter} from '../../http/rate-limit.js'
import {toRepoSummary} from '../../operator-contract/repo-summary.js'
import {bindingToRepoKey, filterDeniedRecords} from '../../redaction/surface-gate.js'
import {getOperatorAuthContext, registerOperatorRoute} from '../operator-route.js'
import {rateLimitedResponse, redactionPolicyUnavailableResponse} from '../safe-response.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Hard cap on the number of distinct owner/repo pairs returned per listing.
 *
 * The cap bounds the response size for unusually large binding sets. No pagination is
 * provided — the cap is the contract. Distinct repos beyond the cap are silently
 * truncated (first MAX_REPOS_PER_LISTING distinct owner/repo pairs after denylist
 * filtering and dedup).
 */
export const MAX_REPOS_PER_LISTING = 100

/**
 * Per-operator rate limit for the repos listing route: 20 requests per minute.
 *
 * Each request reads the full binding set from the object store; 20/min is generous
 * for interactive use while bounding that read amplification.
 */
const REPOS_RATE_LIMIT_PER_MIN = 20
const REPOS_RATE_WINDOW_MIN_MS = 60_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal bindings store interface required by the repos route.
 * Accepts the full BindingsStore from bindings/store.ts (structural subtype).
 */
export type ListBindingsFn = () => Promise<
  {readonly success: true; readonly data: RepoBinding[]} | {readonly success: false; readonly error: Error}
>

/** Dependencies for the repos route. */
export interface ReposRouteDeps {
  /** Binding store list function. */
  readonly listBindings: ListBindingsFn
  /**
   * Denylist predicate — returns true when a repo's deny keys are on the denylist.
   * Called synchronously for each binding.
   */
  readonly isRepoDenied: (repoKey: RepoKey) => boolean
  /**
   * Whether the redaction policy is loaded and usable (`DenylistCache.isPolicyAvailable`). Required: an absent
   * gate would let an unavailable policy read as an empty listing. While false, the route answers 503 before it
   * reads any binding.
   */
  readonly isPolicyAvailable: () => boolean
  /** Structured logger. */
  readonly logger: OperatorLogger
  /** Injectable clock. */
  readonly now: () => number
  /**
   * Optional injectable per-minute rate limiter (operator-keyed).
   * When absent, a fresh limiter is created with REPOS_RATE_LIMIT_PER_MIN.
   */
  readonly perMinRateLimiter?: RateLimiter
}

// ---------------------------------------------------------------------------
// Route builder
// ---------------------------------------------------------------------------

/**
 * Register GET /operator/repos on the given Hono app.
 *
 * Must be called after setOperatorRouteGuard is installed in buildOperatorApp.
 * The guard runs first (browser/session/allowlist); this handler runs only
 * if the guard allows the request.
 *
 * Response body: RepoSummary[] — operator-safe projection of authorized bindings.
 */
export function buildReposRoute(app: Hono, deps: ReposRouteDeps): void {
  // Per-operator rate limiter (operator-keyed, not socket-keyed).
  // Keyed on string(githubUserId) so the limit is per-operator, not per-repo.
  const perMinLimiter =
    deps.perMinRateLimiter ??
    createRateLimiter({limit: REPOS_RATE_LIMIT_PER_MIN, windowMs: REPOS_RATE_WINDOW_MIN_MS, clock: deps.now})

  registerOperatorRoute(app, 'GET', '/operator/repos', async c => {
    // ── Gate 1: Read authenticated context set by the guard ──────────────────
    // In production the guard always sets this; undefined is unreachable.
    // Return 401 as a safe fallback (guard not installed — programming error path).
    const authCtx = getOperatorAuthContext(c)
    if (authCtx === undefined) {
      deps.logger.warn({gate: 'no-auth-ctx'}, 'repos: denied — no auth context')
      return c.json({error: 'unauthorized'}, 401)
    }

    const {githubUserId} = authCtx

    // ── Gate 2: Operator rate limit (operator-keyed) ─────────────────────────
    // Checked AFTER auth context (so it's operator-keyed) and BEFORE the binding
    // enumeration (so it bounds the object-store read budget).
    const operatorKey = String(githubUserId)
    if (perMinLimiter.allow(operatorKey) === false) {
      deps.logger.warn({githubUserId, gate: 'rate-limited'}, 'repos: rate limited')
      return rateLimitedResponse(c)
    }

    // ── Gate 3: Redaction policy availability ────────────────────────────────
    // An unavailable policy denies every repo, which would read as an empty listing. Report it instead, before
    // any binding is read. One warning per request; it carries no repo identity.
    if (deps.isPolicyAvailable() === false) {
      deps.logger.warn(
        {githubUserId, gate: 'redaction-policy-unavailable'},
        'repos: redaction policy unavailable — returning 503',
      )
      return redactionPolicyUnavailableResponse(c)
    }

    // ── Gate 4: List all bound repos ──────────────────────────────────────
    // A store error returns a coarse error — no partial list leaks.
    let bindings: RepoBinding[]
    try {
      const result = await deps.listBindings()
      if (result.success === false) {
        deps.logger.warn({githubUserId}, 'repos: listBindings failed — returning coarse error')
        return c.json({error: 'unavailable'}, 503)
      }
      bindings = result.data
    } catch (error: unknown) {
      deps.logger.warn({githubUserId, error}, 'repos: listBindings threw — returning coarse error')
      return c.json({error: 'unavailable'}, 503)
    }

    // ── Gate 5: Denylist filter ────────────────────────────────────────────
    // Extract deny keys from each binding; null/null means no usable key (fail closed).
    const allowed = filterDeniedRecords(bindings, bindingToRepoKey, deps.isRepoDenied)

    // ── Gate 5b: Re-check availability after the read ──────────────────────
    // Grace can expire while listBindings() is pending; the denylist checks then deny every binding, which would
    // read as an empty listing. Report the outage instead of accepting that result.
    if (deps.isPolicyAvailable() === false) {
      deps.logger.warn(
        {githubUserId, gate: 'redaction-policy-unavailable'},
        'repos: redaction policy unavailable — returning 503',
      )
      return redactionPolicyUnavailableResponse(c)
    }

    // Dedup by owner/repo BEFORE the cap — duplicate channelId bindings for the same
    // repo would otherwise consume cap slots and crowd out distinct repos.
    const seenBeforeCap = new Set<string>()
    const dedupedAllowed = allowed.filter(b => {
      const key = `${b.owner}/${b.repo}`
      if (seenBeforeCap.has(key)) {
        return false
      }
      seenBeforeCap.add(key)
      return true
    })

    // Cap AFTER dedup to bound the response size.
    // Distinct repos beyond the cap are silently truncated (first MAX_REPOS_PER_LISTING).
    const capped = dedupedAllowed.slice(0, MAX_REPOS_PER_LISTING)
    // ── Response ─────────────────────────────────────────────────────────────
    // Map to operator-safe RepoSummary projections.
    // Prevent caching — response is session-bound and operator-specific.
    c.header('Cache-Control', 'no-store, private')

    const summaries = capped.map(toRepoSummary)
    return c.json(summaries, 200)
  })
}
