/**
 * Authenticated repo-listing route: GET /operator/repos
 *
 * Returns the set of bound repositories an authenticated operator is authorized
 * to launch work in. Scoped per R19: only repos the operator has actual GitHub
 * access to are returned.
 *
 * Gate ordering (all must pass before any repo data is returned):
 *   1. Guard (browser/session/allowlist) — installed by buildOperatorApp
 *   2. Operator rate limit (20/min, operator-keyed) — before binding enumeration
 *   3. Resolve OAuth token via session store
 *   4. listBindings() — enumerate all bound repos
 *   5. filterDeniedRecords() — drop denylisted repos BEFORE any authz call
 *   6. Dedup by owner/repo, then cap before the authz fan-out
 *   7. checkRepoAuthz() per surviving binding — keep only authorized repos
 *   8. Map to RepoSummary[]; return 200
 *
 * Security invariants:
 *   - Denylisted repos are dropped before checkRepoAuthz is called (no oracle).
 *   - Unauthorized repos are silently omitted (no oracle).
 *   - Store errors return a coarse error; no partial list leaks.
 *   - Response carries no deny-keys, workspacePath, channelId, or internal IDs.
 *   - Result is capped at MAX_REPOS_PER_LISTING distinct owner/repo pairs (no pagination machinery).
 *   - Token is never logged.
 *   - Rate limit is operator-keyed (not socket-keyed) to prevent OAuth-budget
 *     self-DoS from the per-repo authz fan-out (up to 100 GitHub calls per request).
 */

import type {Hono} from 'hono'
import type {RepoBinding} from '../../bindings/types.js'
import type {RateLimiter} from '../../http/rate-limit.js'
import type {RepoKey} from '../../redaction/denylist.js'
import type {RepoAuthzDeps} from '../auth/repo-authz.js'
import type {OperatorLogger} from '../server.js'
import {createRateLimiter} from '../../http/rate-limit.js'
import {toRepoSummary} from '../../operator-contract/repo-summary.js'
import {bindingToRepoKey, filterDeniedRecords} from '../../redaction/surface-gate.js'
import {checkRepoAuthz} from '../auth/repo-authz.js'
import {getOperatorAuthContext, registerOperatorRoute} from '../operator-route.js'
import {rateLimitedResponse} from '../safe-response.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Hard cap on the number of distinct owner/repo pairs returned per listing.
 *
 * Authz checks are per-repo and the authz cache coalesces concurrent misses,
 * so N bindings is acceptable for small-to-medium deployments. The cap prevents
 * unbounded authz fan-out for unusually large binding sets. No pagination is
 * provided — the cap is the contract. Distinct repos beyond the cap are silently
 * truncated (first MAX_REPOS_PER_LISTING distinct owner/repo pairs after denylist
 * filtering and dedup).
 */
export const MAX_REPOS_PER_LISTING = 100

/**
 * Per-operator rate limit for the repos listing route: 20 requests per minute.
 *
 * Each request fans out to up to MAX_REPOS_PER_LISTING checkRepoAuthz GitHub
 * calls. Without a rate limit, a single operator could exhaust the OAuth token
 * budget via rapid repeated listing. 20/min is generous for interactive use
 * while bounding the worst-case GitHub API fan-out to 2000 calls/min.
 */
const REPOS_RATE_LIMIT_PER_MIN = 20
const REPOS_RATE_WINDOW_MIN_MS = 60_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal session store interface required by the repos route.
 * Accepts the full SessionStore from session.ts (structural subtype).
 */
export interface ReposRouteSessionStore {
  readonly getOperatorToken: (sessionId: string, nowMs: number) => string | undefined
}

/**
 * Minimal bindings store interface required by the repos route.
 * Accepts the full BindingsStore from bindings/store.ts (structural subtype).
 */
export type ListBindingsFn = () => Promise<
  {readonly success: true; readonly data: RepoBinding[]} | {readonly success: false; readonly error: Error}
>

/** Dependencies for the repos route. */
export interface ReposRouteDeps {
  /** Session store for OAuth token retrieval. */
  readonly sessionStore: ReposRouteSessionStore
  /** Binding store list function. */
  readonly listBindings: ListBindingsFn
  /**
   * Denylist predicate — returns true when a repo's deny keys are on the denylist.
   * Must be called synchronously for each binding BEFORE any authz check.
   */
  readonly isRepoDenied: (repoKey: RepoKey) => boolean
  /** Repo authorization dependencies for checkRepoAuthz. */
  readonly repoAuthzDeps: RepoAuthzDeps
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
    const nowMs = deps.now()

    // ── Gate 1: Read authenticated context set by the guard ──────────────────
    // In production the guard always sets this; undefined is unreachable.
    // Return 401 as a safe fallback (guard not installed — programming error path).
    const authCtx = getOperatorAuthContext(c)
    if (authCtx === undefined) {
      deps.logger.warn({gate: 'no-auth-ctx'}, 'repos: denied — no auth context')
      return c.json({error: 'unauthorized'}, 401)
    }

    const {githubUserId, sessionId} = authCtx

    // ── Gate 2: Operator rate limit (operator-keyed) ─────────────────────────
    // Checked AFTER auth context (so it's operator-keyed) and BEFORE the binding
    // enumeration/authz fan-out (so it bounds the GitHub API call budget).
    const operatorKey = String(githubUserId)
    if (perMinLimiter.allow(operatorKey) === false) {
      deps.logger.warn({githubUserId, gate: 'rate-limited'}, 'repos: rate limited')
      return rateLimitedResponse(c)
    }

    // ── Gate 3: Resolve OAuth token ──────────────────────────────────────────
    // A missing token means the session is dropped/expired/revoked.
    // Return a coarse error — no oracle (same shape as store errors).
    const token = deps.sessionStore.getOperatorToken(sessionId, nowMs)
    if (token === undefined) {
      deps.logger.warn({githubUserId, gate: 'no-token'}, 'repos: denied — token missing')
      return c.json({error: 'unauthorized'}, 401)
    }

    // ── Gate 4: List all bound repos ─────────────────────────────────────────
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

    // ── Gate 5: Denylist filter — BEFORE any authz call ──────────────────────
    // Denylisted repos must never reach checkRepoAuthz (no oracle, no GitHub call).
    // Extract deny keys from each binding; null/null means no usable key (fail closed).
    const allowed = filterDeniedRecords(bindings, bindingToRepoKey, deps.isRepoDenied)

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

    // Cap AFTER dedup to bound the number of GitHub authz calls.
    // Distinct repos beyond the cap are silently truncated (first MAX_REPOS_PER_LISTING).
    const capped = dedupedAllowed.slice(0, MAX_REPOS_PER_LISTING)

    // ── Gate 7: Per-repo authz — keep only repos the operator can access ──────
    // checkRepoAuthz is called per binding. A denial silently omits the repo.
    // Per-repo authz failures are NOT errors — they are silent omissions (R19).
    const authorized: RepoBinding[] = []
    for (const binding of capped) {
      try {
        const authzResult = await checkRepoAuthz(githubUserId, binding.owner, binding.repo, token, deps.repoAuthzDeps)
        if (authzResult.authorized === true) {
          authorized.push(binding)
        }
        // Unauthorized: silently omit — no log, no error (R19 scope, no oracle).
      } catch {
        // Unexpected authz error: silently omit this repo (fail closed, no oracle).
        deps.logger.warn(
          {githubUserId, owner: binding.owner, repo: binding.repo},
          'repos: checkRepoAuthz threw — omitting repo',
        )
      }
    }

    // ── Response ─────────────────────────────────────────────────────────────
    // Map to operator-safe RepoSummary projections.
    // Prevent caching — response is session-bound and operator-specific.
    c.header('Cache-Control', 'no-store, private')

    const summaries = authorized.map(toRepoSummary)
    return c.json(summaries, 200)
  })
}
