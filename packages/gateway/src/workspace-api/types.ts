/**
 * Request/response types for the workspace-agent HTTP service.
 *
 * These types MIRROR `apps/workspace-agent/src/types.ts` exactly.
 * The gateway MUST import from this file — never from the workspace-agent package directly.
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
 * GET /readyz success response (HTTP 200).
 * Mirrors `apps/workspace-agent/src/readyz.ts`.
 */
export interface ReadyzReady {
  readonly ready: true
  readonly opencode: 'ready'
}

/**
 * GET /readyz not-ready response (HTTP 503).
 * Mirrors `apps/workspace-agent/src/readyz.ts`.
 */
export interface ReadyzNotReady {
  readonly ready: false
  readonly opencode: 'starting' | 'down' | 'unknown'
}

/** Discriminated union of all /readyz response shapes. */
export type ReadyzResponse = ReadyzReady | ReadyzNotReady

/**
 * Client-side error discriminated union for workspace-api calls.
 * These are the errors the gateway's workspace client can return.
 */
export type WorkspaceError =
  | {readonly kind: 'clone-error'; readonly code: CloneErrorCode}
  | {readonly kind: 'http-error'; readonly status: number}
  | {readonly kind: 'network-error'}
  | {readonly kind: 'timeout'}
  | {readonly kind: 'parse-error'}
  | {readonly kind: 'response-mismatch'}
