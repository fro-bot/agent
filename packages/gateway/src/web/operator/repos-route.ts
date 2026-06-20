/**
 * Authenticated repo-listing route: GET /operator/repos
 *
 * Returns the set of bound repositories an authenticated operator is authorized
 * to launch work in. Scoped per R19: only repos the operator has actual GitHub
 * access to are returned.
 *
 * Gate ordering (all must pass before any repo data is returned):
 *   1. Guard (browser/session/allowlist) — installed by buildOperatorApp
 *   2. Resolve OAuth token via session store
 *   3. listBindings() — enumerate all bound repos
 *   4. filterDeniedRecords() — drop denylisted repos BEFORE any authz call
 *   5. checkRepoAuthz() per surviving binding — keep only authorized repos
 *   6. Cap at MAX_REPOS_PER_LISTING; map to RepoSummary[]; return 200
 *
 * Security invariants:
 *   - Denylisted repos are dropped before checkRepoAuthz is called (no oracle).
 *   - Unauthorized repos are silently omitted (no oracle).
 *   - Store errors return a coarse error; no partial list leaks.
 *   - Response carries no deny-keys, workspacePath, channelId, or internal IDs.
 *   - Result is capped at MAX_REPOS_PER_LISTING (no pagination machinery).
 *   - Token is never logged.
 */

import type {Hono} from 'hono'
import type {RepoBinding} from '../../bindings/types.js'
import type {RepoKey} from '../../redaction/denylist.js'
import type {RepoAuthzDeps} from '../auth/repo-authz.js'
import type {OperatorLogger} from '../server.js'
import {toRepoSummary} from '../../operator-contract/repo-summary.js'
import {filterDeniedRecords} from '../../redaction/surface-gate.js'
import {checkRepoAuthz} from '../auth/repo-authz.js'
import {getOperatorAuthContext, registerOperatorRoute} from '../operator-route.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Hard cap on the number of repos returned per listing.
 *
 * Authz checks are per-repo and the authz cache coalesces concurrent misses,
 * so N bindings is acceptable for small-to-medium deployments. The cap prevents
 * unbounded authz fan-out for unusually large binding sets. No pagination is
 * provided — the cap is the contract. Bindings beyond the cap are silently
 * truncated (first MAX_REPOS_PER_LISTING bindings after denylist filtering).
 */
export const MAX_REPOS_PER_LISTING = 100

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

    // ── Gate 2: Resolve OAuth token ──────────────────────────────────────────
    // A missing token means the session is dropped/expired/revoked.
    // Return a coarse error — no oracle (same shape as store errors).
    const token = deps.sessionStore.getOperatorToken(sessionId, nowMs)
    if (token === undefined) {
      deps.logger.warn({githubUserId, gate: 'no-token'}, 'repos: denied — token missing')
      return c.json({error: 'unauthorized'}, 401)
    }

    // ── Gate 3: List all bound repos ─────────────────────────────────────────
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

    // ── Gate 4: Denylist filter — BEFORE any authz call ──────────────────────
    // Denylisted repos must never reach checkRepoAuthz (no oracle, no GitHub call).
    // Extract deny keys from each binding; null/null means no usable key (fail closed).
    const allowed = filterDeniedRecords(
      bindings,
      (binding: RepoBinding): RepoKey => ({
        databaseId: typeof binding.databaseId === 'number' ? binding.databaseId : null,
        nodeId: typeof binding.nodeId === 'string' ? binding.nodeId : null,
      }),
      deps.isRepoDenied,
    )

    // Apply the hard cap BEFORE authz fan-out to bound the number of GitHub calls.
    // Bindings beyond the cap are silently truncated (first MAX_REPOS_PER_LISTING).
    const capped = allowed.slice(0, MAX_REPOS_PER_LISTING)

    // ── Gate 5: Per-repo authz — keep only repos the operator can access ──────
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
