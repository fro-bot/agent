/**
 * Request/response types for the workspace-agent HTTP service.
 *
 * These types are wire-compatible with `apps/workspace-agent/src/types.ts`. Some are
 * intentionally narrower (e.g. the `/readyz` shapes below are split into a discriminated
 * union here for stricter consumer-side checking). The gateway MUST import from this file —
 * never from the workspace-agent package directly.
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
export type CheckoutOperation = 'none' | 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect'

/** A single point-in-time observation of an existing checkout. Never mutates the checkout. */
export interface CheckoutObservation {
  readonly head: CheckoutHead
  readonly worktree: WorktreeState
  readonly operationInProgress: CheckoutOperation
  /** ISO-8601 timestamp, from an injected clock. */
  readonly observedAt: string
}

/** POST /inspect error response. */
export interface InspectFailure {
  readonly ok: false
  readonly error: InspectErrorCode
}

/** POST /inspect success response. */
export interface InspectSuccess {
  readonly ok: true
  readonly observation: CheckoutObservation
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

/**
 * GET /readyz success response (HTTP 200).
 * Narrows the flat `ReadyzResponse` emitted by `apps/workspace-agent/src/server.ts`.
 */
export interface ReadyzReady {
  readonly ready: true
  readonly opencode: 'ready'
}

/**
 * GET /readyz not-ready response (HTTP 503).
 * Narrows the flat `ReadyzResponse` emitted by `apps/workspace-agent/src/server.ts`.
 */
export interface ReadyzNotReady {
  readonly ready: false
  readonly opencode: 'starting' | 'down' | 'degraded' | 'unknown'
}

/** Discriminated union of all /readyz response shapes. */
export type ReadyzResponse = ReadyzReady | ReadyzNotReady

/**
 * Client-side error discriminated union for workspace-api calls.
 * These are the errors the gateway's workspace client can return.
 */
export type WorkspaceError =
  | {readonly kind: 'clone-error'; readonly code: CloneErrorCode}
  | {readonly kind: 'inspect-error'; readonly code: InspectErrorCode}
  | {readonly kind: 'http-error'; readonly status: number}
  | {readonly kind: 'network-error'}
  | {readonly kind: 'timeout'}
  | {readonly kind: 'parse-error'}
  | {readonly kind: 'response-mismatch'}
