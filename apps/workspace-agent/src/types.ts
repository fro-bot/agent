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

/** GET /healthz response. */
export interface HealthzResponse {
  readonly ok: true
  /** OpenCode server readiness. Present when the server lifecycle is managed. */
  readonly opencode?: 'ready' | 'starting' | 'down'
}

/** GET /readyz response. */
export interface ReadyzResponse {
  readonly ready: boolean
  /** OpenCode server readiness. 'unknown' when no status ref is available. */
  readonly opencode: 'ready' | 'starting' | 'down' | 'unknown'
}
