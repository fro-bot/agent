/**
 * HTTP client for the workspace-agent service.
 *
 * SECURITY INVARIANT: This module NEVER logs request body or response body,
 * even on retry, error, or rethrow. The request body contains an installation
 * access token (ghs_*). All error paths return sanitized WorkspaceError variants
 * with no token-bearing context.
 */

import type {Result} from '@fro-bot/runtime'

import type {CloneErrorCode, CloneFailure, CloneRequest, CloneSuccess, ReadyzResponse, WorkspaceError} from './types.js'

import {err, ok} from '@fro-bot/runtime'

export interface WorkspaceClientOptions {
  readonly baseUrl: string
  readonly timeoutMs?: number
  /** Timeout for /readyz checks. Defaults to 5 seconds — much shorter than clone. */
  readonly readyzTimeoutMs?: number
}

export interface WorkspaceClient {
  readonly clone: (request: CloneRequest) => Promise<Result<CloneSuccess, WorkspaceError>>
  /**
   * Check workspace readiness via GET /readyz.
   *
   * Returns:
   * - `ok({ready: true, opencode: 'ready'})` on HTTP 200
   * - `ok({ready: false, opencode: ...})` on HTTP 503 (workspace not ready)
   * - `err({kind: 'http-error', status})` on unexpected HTTP status
   * - `err({kind: 'timeout'})` on AbortSignal.timeout expiry
   * - `err({kind: 'network-error'})` on connection failure
   * - `err({kind: 'parse-error'})` on malformed response body
   */
  readonly readyz: () => Promise<Result<ReadyzResponse, WorkspaceError>>
}

const DEFAULT_TIMEOUT_MS = 300_000 // 5 minutes
const DEFAULT_READYZ_TIMEOUT_MS = 5_000 // 5 seconds — fast gate check

// Mirrors WORKSPACE_REPOS_ROOT in apps/workspace-agent/src/clone.ts (separate
// package/container boundary, so not imported). Module-private: callers use
// workspaceRepoPath() rather than composing the root themselves.
const EXPECTED_WORKSPACE_ROOT = '/workspace/repos'

/**
 * Returns the canonical workspace path for a given owner/repo pair.
 * Single source of truth shared by the client validator and add-project resume logic.
 *
 * owner and repo MUST already be lowercased (canonical form) before calling this.
 */
export function workspaceRepoPath(owner: string, repo: string): string {
  return `${EXPECTED_WORKSPACE_ROOT}/${owner}/${repo}`
}

/**
 * Create a workspace-agent HTTP client.
 *
 * Uses native fetch (Node 24+) with AbortSignal.timeout for the 5-minute clone timeout.
 * Never logs request or response bodies.
 */
export function createWorkspaceClient(options: WorkspaceClientOptions): WorkspaceClient {
  const {baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS, readyzTimeoutMs = DEFAULT_READYZ_TIMEOUT_MS} = options

  async function readyz(): Promise<Result<ReadyzResponse, WorkspaceError>> {
    let response: Response
    try {
      response = await fetch(`${baseUrl}/readyz`, {
        method: 'GET',
        signal: AbortSignal.timeout(readyzTimeoutMs),
      })
    } catch (fetchError) {
      if (fetchError instanceof Error && fetchError.name === 'TimeoutError') {
        return err({kind: 'timeout'})
      }
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        return err({kind: 'timeout'})
      }
      return err({kind: 'network-error'})
    }

    const httpStatus = response.status

    // Only 200 (ready) and 503 (not-ready) are expected.
    // Any other status is an unexpected error.
    if (httpStatus !== 200 && httpStatus !== 503) {
      return err({kind: 'http-error', status: httpStatus})
    }

    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      return err({kind: 'parse-error'})
    }

    if (isReadyzResponse(parsed) === false) {
      return err({kind: 'parse-error'})
    }

    // Status↔body coherence check: HTTP status must agree with the body's ready field.
    // A 503 + {ready:true} would be a fail-OPEN (not-ready workspace classified as ready).
    // A 200 + {ready:false} is also incoherent. Both are treated as parse-error (fail-closed).
    if (httpStatus === 200 && parsed.ready !== true) {
      return err({kind: 'parse-error'})
    }
    if (httpStatus === 503 && parsed.ready !== false) {
      return err({kind: 'parse-error'})
    }

    return ok(parsed)
  }

  async function clone(request: CloneRequest): Promise<Result<CloneSuccess, WorkspaceError>> {
    const {owner, repo} = request
    // SECURITY: body is never logged — it contains the IAT.
    const body = JSON.stringify(request)

    let response: Response
    try {
      response = await fetch(`${baseUrl}/clone`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (fetchError) {
      if (fetchError instanceof Error && fetchError.name === 'TimeoutError') {
        return err({kind: 'timeout'})
      }
      // AbortError from older runtimes
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        return err({kind: 'timeout'})
      }
      return err({kind: 'network-error'})
    }

    // SECURITY: response body is never logged.
    // Parse body for ALL responses (2xx and non-2xx).
    // PR C returns {ok: false, error: <CloneErrorCode>} with HTTP 400/409/500/503/504.
    // We must parse the body to recover structured error codes before falling back to http-error.
    const httpStatus = response.status
    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      // Body parse failed — if non-2xx, return http-error; otherwise parse-error.
      if (!response.ok) {
        return err({kind: 'http-error', status: httpStatus})
      }
      return err({kind: 'parse-error'})
    }

    if (!isCloneResponse(parsed)) {
      // Body doesn't match CloneSuccess | CloneFailure shape.
      if (!response.ok) {
        return err({kind: 'http-error', status: httpStatus})
      }
      return err({kind: 'parse-error'})
    }

    if (parsed.ok === false) {
      // Structured clone error — returned regardless of HTTP status.
      return err({kind: 'clone-error', code: parsed.error})
    }

    // Strict full-path equality check (root + owner + repo).
    // The prior suffix-only check accepted adversarial paths like /etc/passwd/owner/repo.
    // owner/repo arrive already lowercased from add-project.ts; lowercasing the response
    // path would let a case-variant root bypass validation.
    const expectedPath = workspaceRepoPath(owner, repo)
    if (parsed.path !== expectedPath) {
      return err({kind: 'response-mismatch'})
    }

    return ok(parsed)
  }

  return {clone, readyz}
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isReadyzResponse(value: unknown): value is ReadyzResponse {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.ready !== 'boolean') return false
  if (v.ready === true) {
    return v.opencode === 'ready'
  }
  // ready === false
  return v.opencode === 'starting' || v.opencode === 'down' || v.opencode === 'unknown'
}

function isCloneResponse(value: unknown): value is CloneSuccess | CloneFailure {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.ok !== 'boolean') return false
  if (v.ok === true) {
    return typeof v.path === 'string' && typeof v.commit === 'string'
  }
  // ok === false: validate error is a known CloneErrorCode
  return typeof v.error === 'string' && isCloneErrorCode(v.error)
}

const CLONE_ERROR_CODES = new Set<string>([
  'invalid-owner',
  'invalid-repo',
  'invalid-token-shape',
  'malformed-body',
  'body-too-large',
  'clone-failed',
  'clone-timeout',
  'clone-aborted',
  'git-not-available',
  'enospc',
  'disk-full',
  'permission-denied',
  'too-many-files',
  'repo-exists',
  'path-escaped-workspace',
  'head-resolution-failed',
  'overloaded',
])

function isCloneErrorCode(value: string): value is CloneErrorCode {
  return CLONE_ERROR_CODES.has(value)
}
