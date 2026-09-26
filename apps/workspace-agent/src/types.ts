/**
 * Request/response types for the workspace-agent HTTP service.
 *
 * These types define the contract between the gateway (PR D workspace-api client)
 * and the workspace-agent server. The gateway MUST import from
 * `packages/gateway/src/workspace-api/types.ts`, whose types are wire-compatible with these
 * (some intentionally narrower for stricter consumer-side checking).
 *
 * SECURITY: `repoPath` is NOT in CloneRequest. The agent derives the path internally.
 * The caller never controls where the repo is cloned.
 */

/** POST /clone request body. */
export interface CloneRequest {
  readonly owner: string
  readonly repo: string
  /** Installation access token (ghs_*). Never logged, never persisted. */
  readonly token: string
}

/** POST /clone success response. */
export interface CloneSuccess {
  readonly ok: true
  /** Absolute path inside the workspace container, e.g. /workspace/repos/fro-bot/agent */
  readonly path: string
  /** HEAD SHA after clone. */
  readonly commit: string
}

/** POST /clone error response. */
export interface CloneFailure {
  readonly ok: false
  readonly error: CloneErrorCode
  /** Optional machine-readable sub-code (e.g. 'ENOSPC'). */
  readonly code?: string
}

export type CloneErrorCode =
  | 'invalid-owner'
  | 'invalid-repo'
  | 'invalid-token-shape'
  | 'malformed-body'
  | 'body-too-large'
  | 'clone-failed'
  | 'clone-timeout'
  | 'clone-aborted'
  | 'git-not-available'
  | 'enospc'
  | 'disk-full'
  | 'permission-denied'
  | 'too-many-files'
  | 'repo-exists'
  | 'path-escaped-workspace'
  | 'head-resolution-failed'
  | 'overloaded'
  /**
   * The post-clone ownership handoff (handoff.ts) failed — a deterministic failure: the same
   * staged tree fails the same way on every retry (a hardlink, a filesystem-boundary crossing,
   * an unsupported node type, or the handoff's own deadline/entry cap). Never `clone-timeout`
   * (reserved for `git clone` itself timing out) and never `too-many-files` (reserved for an
   * EMFILE from git) — those are gateway-classified as transient/operator-environment issues,
   * not "this repository can never be handed off". The specific reason
   * (`'hardlink' | 'foreign-filesystem' | 'unsupported-entry' | 'deadline-exceeded' | 'max-entries'`,
   * see handoff.ts `HandoffFailureReason`) is carried in `CloneFailure.code`.
   */
  | 'checkout-handoff-failed'

/** POST /inspect request body. */
export interface InspectRequest {
  readonly owner: string
  readonly repo: string
}

/** Observed HEAD state of a checkout — attached to a branch, or detached. */
export type CheckoutHead =
  | {readonly kind: 'attached'; readonly branch: string; readonly sha: string}
  | {readonly kind: 'detached'; readonly sha: string}

/** Observed worktree cleanliness. `dirty` always carries all four counts together. */
export type WorktreeState =
  | {readonly kind: 'clean'}
  | {
      readonly kind: 'dirty'
      readonly staged: number
      readonly unstaged: number
      readonly untracked: number
      readonly conflicted: number
    }

/** In-progress git operation detected from state files in the git directory. */
export type CheckoutOperation = 'none' | 'merge' | 'rebase' | 'am' | 'cherry-pick' | 'revert' | 'bisect'

/** A single point-in-time observation of an existing checkout. Never mutates the checkout. */
export interface CheckoutObservation {
  readonly head: CheckoutHead
  readonly worktree: WorktreeState
  readonly operationInProgress: CheckoutOperation
  /** ISO-8601 timestamp, from an injected clock. */
  readonly observedAt: string
}

/** POST /inspect success response. */
export interface InspectSuccess {
  readonly ok: true
  readonly observation: CheckoutObservation
}

/** POST /inspect error response. */
export interface InspectFailure {
  readonly ok: false
  readonly error: InspectErrorCode
}

export type InspectErrorCode =
  | 'invalid-owner'
  | 'invalid-repo'
  | 'malformed-body'
  | 'body-too-large'
  | 'no-checkout'
  | 'checkout-substituted'
  | 'inspection-failed'
  | 'inspection-timeout'

/** GET /healthz response. */
export interface HealthzResponse {
  readonly ok: true
  /** OpenCode server readiness. Present when the server lifecycle is managed. */
  readonly opencode?: 'ready' | 'starting' | 'down' | 'degraded'
}

/** GET /readyz response. */
export interface ReadyzResponse {
  readonly ready: boolean
  /**
   * OpenCode server readiness. 'unknown' when no status ref is available.
   * 'degraded' = retries exhausted, clone API still alive, /readyz returns 503.
   */
  readonly opencode: 'ready' | 'starting' | 'down' | 'degraded' | 'unknown'
}
