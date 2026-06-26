/**
 * Authenticated run-listing route: GET /operator/runs
 *
 * Returns a bounded, repo-scoped, newest-first list of run summaries for all
 * repositories an authenticated operator is authorized to access. Mirrors the
 * security posture of GET /operator/repos exactly.
 *
 * Gate ordering (all must pass before any run data is returned):
 *   1. Guard (browser/session/allowlist) — installed by buildOperatorApp
 *   2. Operator rate limit (20/min, operator-keyed) — before binding enumeration
 *   3. Resolve OAuth token via session store
 *   4. listBindings() — enumerate all bound repos
 *   5. filterDeniedRecords() — drop denylisted repos BEFORE any authz call
 *   6. checkRepoAuthz() per surviving binding — keep only authorized repos
 *   7. listRunsForRepo() per authorized binding — enumerate run-states
 *   8. toRunSummary() projection — drop null (entity_ref mismatch) + warn
 *   9. Flatten; sort newest-first by createdAt; cap at MAX_RUNS_PER_LISTING
 *  10. Cache-Control: no-store, private; return 200 {runs: RunSummary[]}
 *
 * Security invariants:
 *   - Denylisted repos are dropped before checkRepoAuthz is called (no oracle).
 *   - Unauthorized repos are silently omitted (no oracle).
 *   - Denied/unauthorized repos' run-states are never read (authz fan-out bounds GitHub calls).
 *   - Store errors return a coarse error; no partial list leaks.
 *   - Response carries only {runId, repo, status, createdAt, updatedAt?}.
 *   - Result is capped at MAX_RUNS_PER_LISTING (no pagination machinery).
 *   - Token is never logged.
 *   - Rate limit is operator-keyed (not socket-keyed) to prevent OAuth-budget
 *     self-DoS from the per-repo authz fan-out (up to 100 GitHub calls per request).
 */

import type {RunState} from '@fro-bot/runtime'
import type {Hono} from 'hono'
import type {RepoBinding} from '../../bindings/types.js'
import type {RateLimiter} from '../../http/rate-limit.js'
import type {RunSummary} from '../../operator-contract/run-summary.js'
import type {RepoKey} from '../../redaction/denylist.js'
import type {RepoAuthzDeps} from '../auth/repo-authz.js'
import type {OperatorLogger} from '../server.js'
import {createRateLimiter} from '../../http/rate-limit.js'
import {toRunSummary} from '../../operator-contract/run-summary.js'
import {bindingToRepoKey, filterDeniedRecords} from '../../redaction/surface-gate.js'
import {checkRepoAuthz} from '../auth/repo-authz.js'
import {getOperatorAuthContext, registerOperatorRoute} from '../operator-route.js'
import {rateLimitedResponse} from '../safe-response.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Hard cap on the number of runs returned per listing.
 *
 * Runs are sorted newest-first across all authorized repos, then truncated.
 * No pagination is provided — the cap is the contract.
 */
export const MAX_RUNS_PER_LISTING = 100

/**
 * Authz fan-out cap: maximum number of bindings that proceed to checkRepoAuthz.
 *
 * Mirrors the repos-route cap. Bindings beyond this are silently truncated
 * (first MAX_REPOS_AUTHZ_FANOUT bindings after denylist filtering).
 */
const MAX_REPOS_AUTHZ_FANOUT = 100

/**
 * Per-operator rate limit for the runs listing route: 20 requests per minute.
 *
 * Each request fans out to up to MAX_REPOS_AUTHZ_FANOUT checkRepoAuthz GitHub
 * calls, then per-repo run-state reads. Without a rate limit, a single operator
 * could exhaust the OAuth token budget via rapid repeated listing.
 */
const RUNS_RATE_LIMIT_PER_MIN = 20
const RUNS_RATE_WINDOW_MIN_MS = 60_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal session store interface required by the runs route.
 * Accepts the full SessionStore from session.ts (structural subtype).
 */
export interface RunsRouteSessionStore {
  readonly getOperatorToken: (sessionId: string, nowMs: number) => string | undefined
}

/**
 * Minimal bindings store interface required by the runs route.
 * Accepts the full BindingsStore from bindings/store.ts (structural subtype).
 */
export type RunsListBindingsFn = () => Promise<
  {readonly success: true; readonly data: RepoBinding[]} | {readonly success: false; readonly error: Error}
>

/** Dependencies for the runs route. */
export interface RunsRouteDeps {
  /** Session store for OAuth token retrieval. */
  readonly sessionStore: RunsRouteSessionStore
  /** Binding store list function. */
  readonly listBindings: RunsListBindingsFn
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
   * Enumerate all run-states for a single repo.
   *
   * Required — type-enforced. This is NOT the optional-dep silent-unmount class:
   * the route will not compile without this field. Injected via RunIndex.listRunsForRepo
   * in production; injected as a Map-backed stub in tests.
   */
  readonly listRunsForRepo: (repo: string) => Promise<readonly RunState[]>
  /**
   * Optional injectable per-minute rate limiter (operator-keyed).
   * When absent, a fresh limiter is created with RUNS_RATE_LIMIT_PER_MIN.
   */
  readonly perMinRateLimiter?: RateLimiter
}

// ---------------------------------------------------------------------------
// Route builder
// ---------------------------------------------------------------------------

/**
 * Register GET /operator/runs on the given Hono app.
 *
 * Must be called after setOperatorRouteGuard is installed in buildOperatorApp.
 * The guard runs first (browser/session/allowlist); this handler runs only
 * if the guard allows the request.
 *
 * Response body: {runs: RunSummary[]} — operator-safe projections of authorized
 * runs, sorted newest-first, capped at MAX_RUNS_PER_LISTING.
 */
export function buildRunsRoute(app: Hono, deps: RunsRouteDeps): void {
  // Per-operator rate limiter (operator-keyed, not socket-keyed).
  // Keyed on string(githubUserId) so the limit is per-operator, not per-repo.
  const perMinLimiter =
    deps.perMinRateLimiter ??
    createRateLimiter({limit: RUNS_RATE_LIMIT_PER_MIN, windowMs: RUNS_RATE_WINDOW_MIN_MS, clock: deps.now})

  registerOperatorRoute(app, 'GET', '/operator/runs', async c => {
    const nowMs = deps.now()

    // ── Gate 1: Read authenticated context set by the guard ──────────────────
    // In production the guard always sets this; undefined is unreachable.
    // Return 401 as a safe fallback (guard not installed — programming error path).
    const authCtx = getOperatorAuthContext(c)
    if (authCtx === undefined) {
      deps.logger.warn({gate: 'no-auth-ctx'}, 'runs: denied — no auth context')
      return c.json({error: 'unauthorized'}, 401)
    }

    const {githubUserId, sessionId} = authCtx

    // ── Gate 2: Operator rate limit (operator-keyed) ─────────────────────────
    // Checked AFTER auth context (so it's operator-keyed) and BEFORE the binding
    // enumeration/authz fan-out (so it bounds the GitHub API call budget).
    const operatorKey = String(githubUserId)
    if (perMinLimiter.allow(operatorKey) === false) {
      deps.logger.warn({githubUserId, gate: 'rate-limited'}, 'runs: rate limited')
      return rateLimitedResponse(c)
    }

    // ── Gate 3: Resolve OAuth token ──────────────────────────────────────────
    // A missing token means the session is dropped/expired/revoked.
    // Return a coarse error — no oracle (same shape as store errors).
    const token = deps.sessionStore.getOperatorToken(sessionId, nowMs)
    if (token === undefined) {
      deps.logger.warn({githubUserId, gate: 'no-token'}, 'runs: denied — token missing')
      return c.json({error: 'unauthorized'}, 401)
    }

    // ── Gate 4: List all bound repos ─────────────────────────────────────────
    // A store error returns a coarse error — no partial list leaks.
    let bindings: RepoBinding[]
    try {
      const result = await deps.listBindings()
      if (result.success === false) {
        deps.logger.warn({githubUserId}, 'runs: listBindings failed — returning coarse error')
        return c.json({error: 'unavailable'}, 503)
      }
      bindings = result.data
    } catch (error: unknown) {
      deps.logger.warn({githubUserId, error}, 'runs: listBindings threw — returning coarse error')
      return c.json({error: 'unavailable'}, 503)
    }

    // ── Gate 5: Denylist filter — BEFORE any authz call ──────────────────────
    // Denylisted repos must never reach checkRepoAuthz (no oracle, no GitHub call).
    // Their run-states are never read — tighter than "scan all then filter."
    const allowed = filterDeniedRecords(bindings, bindingToRepoKey, deps.isRepoDenied)

    // Apply the authz fan-out cap BEFORE authz to bound the number of GitHub calls.
    // Bindings beyond the cap are silently truncated (first MAX_REPOS_AUTHZ_FANOUT).
    const capped = allowed.slice(0, MAX_REPOS_AUTHZ_FANOUT)

    // ── Gate 6: Per-repo authz — keep only repos the operator can access ──────
    // checkRepoAuthz is called per binding. A denial silently omits the repo.
    // Per-repo authz failures are NOT errors — they are silent omissions (no oracle).
    const authorized: RepoBinding[] = []
    for (const binding of capped) {
      try {
        const authzResult = await checkRepoAuthz(githubUserId, binding.owner, binding.repo, token, deps.repoAuthzDeps)
        if (authzResult.authorized === true) {
          authorized.push(binding)
        }
        // Unauthorized: silently omit — no log, no error (no oracle).
      } catch {
        // Unexpected authz error: silently omit this repo (fail closed, no oracle).
        deps.logger.warn(
          {githubUserId, owner: binding.owner, repo: binding.repo},
          'runs: checkRepoAuthz threw — omitting repo',
        )
      }
    }

    // ── Enumerate runs for each authorized binding ────────────────────────────
    // Run-states are read ONLY for authorized, non-denied repos. A per-repo scan
    // error is isolated (skip that repo, continue) — never a 500.
    //
    // Dedup by owner/repo before scanning: bindings are keyed by channelId, so two
    // Discord channels can share the same owner/repo. Scanning the same repo twice
    // would produce duplicate runs and double the S3 cost. Keep the first binding
    // per unique owner/repo (they project identically — repo comes from owner/repo).
    const allSummaries: RunSummary[] = []
    const scannedRepos = new Set<string>()

    for (const binding of authorized) {
      const repo = `${binding.owner}/${binding.repo}`
      if (scannedRepos.has(repo)) {
        continue
      }
      scannedRepos.add(repo)

      let runs: readonly RunState[]
      try {
        runs = await deps.listRunsForRepo(repo)
      } catch (error: unknown) {
        deps.logger.warn({githubUserId, repo, error}, 'runs: listRunsForRepo threw — skipping repo')
        continue
      }

      // Project each run via the closed-DTO builder.
      // toRunSummary returns null when entity_ref owner/repo does not match the
      // binding (corruption/rename guard). Drop nulls and warn-log.
      for (const runState of runs) {
        const summary = toRunSummary(runState, binding)
        if (summary === null) {
          deps.logger.warn({githubUserId, repo, runId: runState.run_id}, 'runs: run omitted — entity_ref mismatch')
          continue
        }
        allSummaries.push(summary)
      }
    }

    // ── Sort newest-first, cap, respond ──────────────────────────────────────
    // Sort by createdAt (started_at) descending. Treat unparseable dates as oldest
    // (Date.parse returns NaN; NaN comparisons sort to the end).
    allSummaries.sort((a, b) => {
      const aMs = Date.parse(a.createdAt)
      const bMs = Date.parse(b.createdAt)
      // Treat NaN as oldest (0) so unparseable dates sink to the end.
      const aNorm = Number.isNaN(aMs) ? 0 : aMs
      const bNorm = Number.isNaN(bMs) ? 0 : bMs
      return bNorm - aNorm
    })

    const runs = allSummaries.slice(0, MAX_RUNS_PER_LISTING)

    // Prevent caching — response is session-bound and operator-specific.
    c.header('Cache-Control', 'no-store, private')

    return c.json({runs}, 200)
  })
}
