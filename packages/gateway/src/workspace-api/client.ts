/**
 * HTTP client for the workspace-agent service.
 *
 * SECURITY INVARIANT: This module NEVER logs request body or response body,
 * even on retry, error, or rethrow. The request body contains an installation
 * access token (ghs_*). All error paths return sanitized WorkspaceError variants
 * with no token-bearing context.
 */

import type {Result} from '@fro-bot/runtime'

import type {
  CheckoutObservation,
  CheckoutOperation,
  CloneErrorCode,
  CloneFailure,
  CloneRequest,
  CloneSuccess,
  CloneWorkspaceError,
  InspectErrorCode,
  InspectFailure,
  InspectRequest,
  InspectSuccess,
  InspectWorkspaceError,
  ReadyzResponse,
  WorkspaceError,
} from './types.js'

import {err, ok} from '@fro-bot/runtime'

export interface WorkspaceClientOptions {
  readonly baseUrl: string
  readonly timeoutMs?: number
  /** Timeout for /readyz checks. Defaults to 5 seconds — much shorter than clone. */
  readonly readyzTimeoutMs?: number
  /**
   * Timeout for /inspect checks. Defaults to DEFAULT_INSPECT_TIMEOUT_MS (25 seconds) —
   * much shorter than clone. See DEFAULT_INSPECT_TIMEOUT_MS for sizing rationale.
   */
  readonly inspectTimeoutMs?: number
}

export interface WorkspaceClient {
  readonly clone: (request: CloneRequest) => Promise<Result<CloneSuccess, CloneWorkspaceError>>
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
  /**
   * Report the state of an EXISTING checkout via POST /inspect. Never clones, fetches, or
   * mutates the checkout — read-only.
   *
   * Returns:
   * - `ok(observation)` on HTTP 200 with a validated `CheckoutObservation`.
   * - `err({kind: 'inspect-error', code})` on a structured inspect failure (HTTP 404/409/500/504).
   * - `err({kind: 'http-error', status})` on unexpected HTTP status.
   * - `err({kind: 'timeout'})` on AbortSignal.timeout expiry.
   * - `err({kind: 'network-error'})` on connection failure.
   * - `err({kind: 'parse-error'})` on a malformed response body — including a status/body
   *   contradiction, an unknown `kind`/`operationInProgress` value, an invalid SHA, or a
   *   malformed timestamp. The wire response is never trusted at face value.
   */
  readonly inspect: (request: InspectRequest) => Promise<Result<CheckoutObservation, InspectWorkspaceError>>
}

const DEFAULT_TIMEOUT_MS = 300_000 // 5 minutes
const DEFAULT_READYZ_TIMEOUT_MS = 5_000 // 5 seconds — fast gate check
/**
 * Timeout for /inspect calls. The gateway calls inspect() while holding the per-repo
 * coordination lock (see ensureClone/inspect ordering in execute/run.ts), so this must
 * be sized well below the clone budget: a stalled workspace agent must not pin that lock
 * for anywhere near DEFAULT_TIMEOUT_MS.
 *
 * Server-side (apps/workspace-agent/src/inspect.ts DEFAULT_INSPECT_TIMEOUT_MS), inspect()
 * runs at most two bounded git subprocesses at 10s each (20s worst case) plus unbounded
 * filesystem work (realpath x3, several stat() calls for in-progress-operation detection).
 * 25s gives ~5s of headroom above the two-subprocess worst case for that fs work and
 * scheduling jitter, while still keeping the repo lock pinned for a small fraction of the
 * 5-minute clone budget instead of the whole thing.
 */
const DEFAULT_INSPECT_TIMEOUT_MS = 25_000 // 25 seconds — 2x10s bounded subprocesses + fs-work headroom

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
  const {
    baseUrl,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    readyzTimeoutMs = DEFAULT_READYZ_TIMEOUT_MS,
    inspectTimeoutMs = DEFAULT_INSPECT_TIMEOUT_MS,
  } = options

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

  async function clone(request: CloneRequest): Promise<Result<CloneSuccess, CloneWorkspaceError>> {
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

  async function inspect(request: InspectRequest): Promise<Result<CheckoutObservation, InspectWorkspaceError>> {
    // SECURITY: body is never logged (no secrets here, but keep the same discipline as clone()).
    const body = JSON.stringify(request)

    let response: Response
    try {
      response = await fetch(`${baseUrl}/inspect`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body,
        signal: AbortSignal.timeout(inspectTimeoutMs),
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
    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      if (!response.ok) {
        return err({kind: 'http-error', status: httpStatus})
      }
      return err({kind: 'parse-error'})
    }

    if (!isInspectResponse(parsed)) {
      if (!response.ok) {
        return err({kind: 'http-error', status: httpStatus})
      }
      return err({kind: 'parse-error'})
    }

    // Status↔body coherence check: `ok: true` must arrive on HTTP 200; `ok: false` must arrive on
    // a non-2xx status. A mismatch is untrustworthy wire data — fail closed as parse-error rather
    // than act on either half of a contradictory response.
    if (parsed.ok === true && httpStatus !== 200) {
      return err({kind: 'parse-error'})
    }
    if (parsed.ok === false && response.ok) {
      return err({kind: 'parse-error'})
    }

    if (parsed.ok === false) {
      return err({kind: 'inspect-error', code: parsed.error})
    }

    return ok(parsed.observation)
  }

  return {clone, readyz, inspect}
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
  return v.opencode === 'starting' || v.opencode === 'down' || v.opencode === 'degraded' || v.opencode === 'unknown'
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
  'checkout-handoff-failed',
])

function isCloneErrorCode(value: string): value is CloneErrorCode {
  return CLONE_ERROR_CODES.has(value)
}

// ---------------------------------------------------------------------------
// /inspect response parsing — rejects status/body contradictions, unknown `kind`
// values, invalid SHAs, and malformed timestamps rather than trusting the wire.
// ---------------------------------------------------------------------------

const SHA_RE = /^[0-9a-f]{40}$/

function isValidSha(value: unknown): value is string {
  return typeof value === 'string' && SHA_RE.test(value)
}

const CHECKOUT_OPERATIONS = new Set<string>(['none', 'merge', 'rebase', 'am', 'cherry-pick', 'revert', 'bisect'])

function isCheckoutOperation(value: unknown): value is CheckoutOperation {
  return typeof value === 'string' && CHECKOUT_OPERATIONS.has(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isCheckoutHead(value: unknown): value is CheckoutObservation['head'] {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (v.kind === 'attached') {
    return typeof v.branch === 'string' && v.branch.length > 0 && isValidSha(v.sha)
  }
  if (v.kind === 'detached') {
    return isValidSha(v.sha)
  }
  // Unknown kind — a missing branch field must never be interpreted as "detached".
  return false
}

function isWorktreeState(value: unknown): value is CheckoutObservation['worktree'] {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (v.kind === 'clean') return true
  if (v.kind === 'dirty') {
    return (
      isNonNegativeInteger(v.staged) &&
      isNonNegativeInteger(v.unstaged) &&
      isNonNegativeInteger(v.untracked) &&
      isNonNegativeInteger(v.conflicted)
    )
  }
  return false
}

/**
 * Validates an ISO-8601 timestamp by round-tripping through `Date`: the string must parse AND
 * `toISOString()` must reproduce it exactly. This rejects non-canonical-but-parseable forms
 * (e.g. `2024-01-01`, a bare date with no time component) as malformed, matching what an injected
 * clock's `toISOString()` output actually looks like on the wire.
 */
function isValidIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return false
  return parsed.toISOString() === value
}

function isCheckoutObservation(value: unknown): value is CheckoutObservation {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    isCheckoutHead(v.head) &&
    isWorktreeState(v.worktree) &&
    isCheckoutOperation(v.operationInProgress) &&
    isValidIsoTimestamp(v.observedAt)
  )
}

function isInspectResponse(value: unknown): value is InspectSuccess | InspectFailure {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.ok !== 'boolean') return false
  if (v.ok === true) {
    return isCheckoutObservation(v.observation)
  }
  return typeof v.error === 'string' && isInspectErrorCode(v.error)
}

const INSPECT_ERROR_CODES = new Set<string>([
  'invalid-owner',
  'invalid-repo',
  'malformed-body',
  'body-too-large',
  'no-checkout',
  'checkout-substituted',
  'inspection-failed',
  'inspection-timeout',
])

function isInspectErrorCode(value: string): value is InspectErrorCode {
  return INSPECT_ERROR_CODES.has(value)
}
