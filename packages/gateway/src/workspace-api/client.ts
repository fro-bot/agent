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
  BackupEntry,
  CheckoutObservation,
  CheckoutOperation,
  CloneErrorCode,
  CloneFailure,
  CloneRequest,
  CloneSuccess,
  CloneWorkspaceError,
  DeleteBackupResult,
  DeleteBackupWorkspaceError,
  ExecuteRecoveryRequest,
  ExecuteRecoveryResult,
  ExecuteRecoveryWorkspaceError,
  InspectErrorCode,
  InspectFailure,
  InspectRequest,
  InspectSuccess,
  InspectWorkspaceError,
  JournalInProgressPhase,
  ListBackupsResult,
  ListBackupsWorkspaceError,
  PreviewRecoveryRequest,
  PreviewRecoveryResult,
  PreviewRecoveryWorkspaceError,
  ReadyzResponse,
  RecoverableUpdatePreview,
  RecoveryPreview,
  RetentionUsage,
  UpdateRefusalReason,
  UpdateRequest,
  UpdateResult,
  UpdateWorkspaceError,
  WorkspaceError,
} from './types.js'

import {err, ok} from '@fro-bot/runtime'

export interface WorkspaceClientOptions {
  readonly baseUrl: string
  /**
   * Control-API bearer — the same `WORKSPACE_OPENCODE_TOKEN` this gateway already holds for
   * the 9200 attach proxy (`config.workspaceOpencodeToken`). Sent as `Authorization: Bearer
   * <token>` on every control call (`clone`, `inspect`) except `readyz`, which the workspace
   * exempts from auth for the compose readiness probe.
   */
  readonly token: string
  readonly timeoutMs?: number
  /** Timeout for /readyz checks. Defaults to 5 seconds — much shorter than clone. */
  readonly readyzTimeoutMs?: number
  /**
   * Timeout for /inspect checks. Defaults to DEFAULT_INSPECT_TIMEOUT_MS (25 seconds) —
   * much shorter than clone. See DEFAULT_INSPECT_TIMEOUT_MS for sizing rationale.
   */
  readonly inspectTimeoutMs?: number
  /** Ceiling for /update calls before any caller-supplied `remainingBudgetMs`. Defaults to DEFAULT_UPDATE_TIMEOUT_MS (100 seconds). */
  readonly updateTimeoutMs?: number
  /** Timeout for /recover/preview calls. Defaults to DEFAULT_PREVIEW_RECOVERY_TIMEOUT_MS (45 seconds). */
  readonly previewRecoveryTimeoutMs?: number
  /** Timeout for /recover calls. Defaults to DEFAULT_RECOVER_TIMEOUT_MS (5 minutes). */
  readonly recoverTimeoutMs?: number
  /** Timeout for GET /backups calls. Defaults to DEFAULT_LIST_BACKUPS_TIMEOUT_MS (60 seconds). */
  readonly listBackupsTimeoutMs?: number
  /** Timeout for DELETE /backups/:id calls. Defaults to DEFAULT_DELETE_BACKUP_TIMEOUT_MS (30 seconds). */
  readonly deleteBackupTimeoutMs?: number
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
  /**
   * Bring an ELIGIBLE existing checkout up to date via POST /update. Returns the bare `UpdateResult`
   * union (ready/refused/failed/no-checkout) as the Ok value — workspace-agent's `/update` route
   * returns its domain result directly, not wrapped in `{ok, error}`, so this mirrors that shape
   * exactly rather than re-deriving a client-only error taxonomy for it.
   *
   * `remainingBudgetMs`, when given, is honored as the ACTUAL request ceiling whenever it is
   * shorter than the 100-second default (the lesser of the two always wins) — a caller with less
   * than 100s of its own overall budget left must never let this call outlive it.
   *
   * Returns:
   * - `ok(result)` on HTTP 200/404/409/502/503/504 with a body matching that status's `UpdateResult` shape.
   * - `err({kind: 'http-error', status})` on any other status (400/401/413/500/...) — those are
   *   HTTP-layer-only outcomes (validation failure, bad bearer, oversized body), never a domain result.
   * - `err({kind: 'timeout'})` when the effective deadline (min(100s, remainingBudgetMs)) elapses.
   * - `err({kind: 'network-error'})` on connection failure.
   * - `err({kind: 'parse-error'})` on a malformed or status-incoherent response body.
   */
  readonly update: (
    request: UpdateRequest,
    options?: {readonly remainingBudgetMs?: number},
  ) => Promise<Result<UpdateResult, UpdateWorkspaceError>>
  /**
   * Report what a `/recover` call would see, via POST /recover/preview. Never mutates.
   *
   * Returns `ok(result)` on HTTP 200/404/409/503 with the matching `PreviewRecoveryResult` shape;
   * `err({kind: 'http-error', status})` on any other status; `err({kind: 'timeout'})` on expiry;
   * `err({kind: 'network-error'})` on connection failure; `err({kind: 'parse-error'})` on a
   * malformed or status-incoherent body.
   */
  readonly previewRecovery: (
    request: PreviewRecoveryRequest,
  ) => Promise<Result<PreviewRecoveryResult, PreviewRecoveryWorkspaceError>>
  /**
   * Confirm a previously previewed recovery via POST /recover: quarantine-and-replace.
   *
   * Returns `ok(result)` on HTTP 200/404/409/503 with the matching `ExecuteRecoveryResult` shape;
   * `err({kind: 'http-error', status})` on any other status; timeout/network-error/parse-error as above.
   */
  readonly recover: (
    request: ExecuteRecoveryRequest,
  ) => Promise<Result<ExecuteRecoveryResult, ExecuteRecoveryWorkspaceError>>
  /**
   * List quarantine generations via GET /backups/:owner/:repo.
   *
   * Returns `ok(result)` on HTTP 200/503 with the matching `ListBackupsResult` shape;
   * `err({kind: 'http-error', status})` on any other status; timeout/network-error/parse-error as above.
   */
  readonly listBackups: (owner: string, repo: string) => Promise<Result<ListBackupsResult, ListBackupsWorkspaceError>>
  /**
   * Remove exactly one quarantine generation via DELETE /backups/:owner/:repo/:id.
   *
   * Returns `ok(result)` on HTTP 200/400/404/409/503 with the matching `DeleteBackupResult` shape —
   * unlike every other route here, 400 IS a domain result (`{kind: 'refused', reason: 'invalid-id'}`),
   * never a generic validation-only body, so it is parsed rather than folded into `http-error`.
   * `err({kind: 'http-error', status})` on any other status; timeout/network-error/parse-error as above.
   */
  readonly deleteBackup: (
    owner: string,
    repo: string,
    id: string,
  ) => Promise<Result<DeleteBackupResult, DeleteBackupWorkspaceError>>
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

/**
 * Ceiling for /update calls — mirrors clone's network-bound nature (fetch + fast-forward apply)
 * but /update never re-clones, so it gets its own smaller budget rather than reusing
 * DEFAULT_TIMEOUT_MS. Always bounded further by any caller-supplied `remainingBudgetMs` (the
 * lesser of the two wins — see `update()`'s own doc comment).
 */
const DEFAULT_UPDATE_TIMEOUT_MS = 100_000 // 100 seconds

/**
 * Ceiling for /recover/preview — read-only, but stacks up to ~3 sequential local git/fs checks
 * (checkCheckoutLayout, inventoryCheckoutConfig, inspectCheckout) at workspace-agent's own 15s
 * local-git budget each, plus a bounded 10s filesystem walk. 45s gives headroom above that
 * worst-case stack instead of guessing a round number.
 */
const DEFAULT_PREVIEW_RECOVERY_TIMEOUT_MS = 45_000 // 45 seconds

/**
 * Ceiling for /recover — a MUTATING operation that fetches a fresh copy of the remote (like
 * clone) plus quarantines the old checkout and installs the new one. Matches clone's own
 * DEFAULT_TIMEOUT_MS (5 minutes) since the network+build phase is the same shape of work.
 */
const DEFAULT_RECOVER_TIMEOUT_MS = 300_000 // 5 minutes

/**
 * Ceiling for GET /backups — read-only, but can walk the filesystem of up to
 * RETENTION_MAX_GENERATIONS (5) quarantine generations when their metadata.json is missing or
 * malformed, each bounded at workspace-agent's own 15s walk timeout. 60s covers that worst case
 * with margin.
 */
const DEFAULT_LIST_BACKUPS_TIMEOUT_MS = 60_000 // 60 seconds

/** Ceiling for DELETE /backups/:id — a single recursive directory removal; generously above inspect's 25s. */
const DEFAULT_DELETE_BACKUP_TIMEOUT_MS = 30_000 // 30 seconds

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
    token,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    readyzTimeoutMs = DEFAULT_READYZ_TIMEOUT_MS,
    inspectTimeoutMs = DEFAULT_INSPECT_TIMEOUT_MS,
    updateTimeoutMs = DEFAULT_UPDATE_TIMEOUT_MS,
    previewRecoveryTimeoutMs = DEFAULT_PREVIEW_RECOVERY_TIMEOUT_MS,
    recoverTimeoutMs = DEFAULT_RECOVER_TIMEOUT_MS,
    listBackupsTimeoutMs = DEFAULT_LIST_BACKUPS_TIMEOUT_MS,
    deleteBackupTimeoutMs = DEFAULT_DELETE_BACKUP_TIMEOUT_MS,
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
        headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
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

    // A 401 means the workspace rejected the gateway's bearer. Classify it before parsing the
    // body so it stays http-error/401 even if a future CLONE_ERROR_CODE matches the 401 body.
    if (httpStatus === 401) {
      return err({kind: 'http-error', status: httpStatus})
    }

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
        headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
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

    // Same as clone(): a rejected bearer is http-error/401 regardless of the body.
    if (httpStatus === 401) {
      return err({kind: 'http-error', status: httpStatus})
    }

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

  async function update(
    request: UpdateRequest,
    updateOptions?: {readonly remainingBudgetMs?: number},
  ): Promise<Result<UpdateResult, UpdateWorkspaceError>> {
    const body = JSON.stringify(request)
    const effectiveMs = Math.min(updateTimeoutMs, updateOptions?.remainingBudgetMs ?? updateTimeoutMs)

    // A plain `setTimeout`-driven abort (not `AbortSignal.timeout`) so the effective ceiling is
    // fake-timer-testable — see execute/run-core.ts's own deadline pattern for why native
    // AbortSignal.timeout scheduling is not reliably fake-timer-controlled.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), effectiveMs)

    let response: Response
    try {
      response = await fetch(`${baseUrl}/update`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
        body,
        signal: controller.signal,
      })
    } catch (fetchError) {
      clearTimeout(timer)
      if (fetchError instanceof Error && (fetchError.name === 'AbortError' || fetchError.name === 'TimeoutError')) {
        return err({kind: 'timeout'})
      }
      return err({kind: 'network-error'})
    }
    clearTimeout(timer)

    const httpStatus = response.status
    if (!isUpdateResultStatus(httpStatus)) {
      return err({kind: 'http-error', status: httpStatus})
    }

    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      return err({kind: 'parse-error'})
    }

    if (!isUpdateResult(parsed, httpStatus)) {
      return err({kind: 'parse-error'})
    }

    return ok(parsed)
  }

  async function previewRecovery(
    request: PreviewRecoveryRequest,
  ): Promise<Result<PreviewRecoveryResult, PreviewRecoveryWorkspaceError>> {
    const body = JSON.stringify(request)
    let response: Response
    try {
      response = await fetch(`${baseUrl}/recover/preview`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
        body,
        signal: AbortSignal.timeout(previewRecoveryTimeoutMs),
      })
    } catch (fetchError) {
      if (fetchError instanceof Error && (fetchError.name === 'TimeoutError' || fetchError.name === 'AbortError')) {
        return err({kind: 'timeout'})
      }
      return err({kind: 'network-error'})
    }

    const httpStatus = response.status
    if (!isPreviewRecoveryResultStatus(httpStatus)) {
      return err({kind: 'http-error', status: httpStatus})
    }

    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      return err({kind: 'parse-error'})
    }

    if (!isPreviewRecoveryResult(parsed, httpStatus)) {
      return err({kind: 'parse-error'})
    }

    return ok(parsed)
  }

  async function recover(
    request: ExecuteRecoveryRequest,
  ): Promise<Result<ExecuteRecoveryResult, ExecuteRecoveryWorkspaceError>> {
    // SECURITY: body is never logged — it carries the IAT, same discipline as clone()/update().
    const body = JSON.stringify(request)
    let response: Response
    try {
      response = await fetch(`${baseUrl}/recover`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
        body,
        signal: AbortSignal.timeout(recoverTimeoutMs),
      })
    } catch (fetchError) {
      if (fetchError instanceof Error && (fetchError.name === 'TimeoutError' || fetchError.name === 'AbortError')) {
        return err({kind: 'timeout'})
      }
      return err({kind: 'network-error'})
    }

    const httpStatus = response.status
    if (!isExecuteRecoveryResultStatus(httpStatus)) {
      return err({kind: 'http-error', status: httpStatus})
    }

    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      return err({kind: 'parse-error'})
    }

    if (!isExecuteRecoveryResult(parsed, httpStatus)) {
      return err({kind: 'parse-error'})
    }

    return ok(parsed)
  }

  async function listBackups(
    owner: string,
    repo: string,
  ): Promise<Result<ListBackupsResult, ListBackupsWorkspaceError>> {
    let response: Response
    try {
      response = await fetch(`${baseUrl}/backups/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
        method: 'GET',
        headers: {Authorization: `Bearer ${token}`},
        signal: AbortSignal.timeout(listBackupsTimeoutMs),
      })
    } catch (fetchError) {
      if (fetchError instanceof Error && (fetchError.name === 'TimeoutError' || fetchError.name === 'AbortError')) {
        return err({kind: 'timeout'})
      }
      return err({kind: 'network-error'})
    }

    const httpStatus = response.status
    if (httpStatus !== 200 && httpStatus !== 503) {
      return err({kind: 'http-error', status: httpStatus})
    }

    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      return err({kind: 'parse-error'})
    }

    if (!isListBackupsResult(parsed, httpStatus)) {
      return err({kind: 'parse-error'})
    }

    return ok(parsed)
  }

  async function deleteBackup(
    owner: string,
    repo: string,
    id: string,
  ): Promise<Result<DeleteBackupResult, DeleteBackupWorkspaceError>> {
    let response: Response
    try {
      response = await fetch(
        `${baseUrl}/backups/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(id)}`,
        {
          method: 'DELETE',
          headers: {Authorization: `Bearer ${token}`},
          signal: AbortSignal.timeout(deleteBackupTimeoutMs),
        },
      )
    } catch (fetchError) {
      if (fetchError instanceof Error && (fetchError.name === 'TimeoutError' || fetchError.name === 'AbortError')) {
        return err({kind: 'timeout'})
      }
      return err({kind: 'network-error'})
    }

    const httpStatus = response.status
    if (!isDeleteBackupResultStatus(httpStatus)) {
      return err({kind: 'http-error', status: httpStatus})
    }

    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      return err({kind: 'parse-error'})
    }

    if (!isDeleteBackupResult(parsed, httpStatus)) {
      return err({kind: 'parse-error'})
    }

    return ok(parsed)
  }

  return {clone, readyz, inspect, update, previewRecovery, recover, listBackups, deleteBackup}
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
  'journal-in-progress',
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

// ---------------------------------------------------------------------------
// /update response parsing — status/body coherence enforced; nothing is cast.
// ---------------------------------------------------------------------------

function isUpdateResultStatus(status: number): boolean {
  return status === 200 || status === 404 || status === 409 || status === 502 || status === 503 || status === 504
}

const UPDATE_CHANGE_KINDS = new Set<string>(['fast-forward', 'unchanged'])

function isUpdateReadyBody(v: Record<string, unknown>): boolean {
  if (typeof v.change !== 'string' || !UPDATE_CHANGE_KINDS.has(v.change)) return false
  if (typeof v.branch !== 'string' || v.branch.length === 0) return false
  if (!isValidSha(v.sha)) return false
  if (v.fromSha !== undefined && !isValidSha(v.fromSha)) return false
  return isValidIsoTimestamp(v.checkedAt)
}

const LAYOUT_REFUSAL_REASONS = new Set<string>([
  'core-worktree',
  'gitfile',
  'symlinked-git-dir',
  'symlinked-config',
  'alternates',
  'replace-refs',
  'grafts',
  'shallow',
  'partial-clone',
  'linked-worktree',
  'unsupported-index-flag',
  'bare-repository',
])

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
}

const OBSTRUCTION_KINDS = new Set<string>([
  'exact-conflict',
  'prefix-conflict',
  'identical-content',
  'symlink-ancestor',
])

function isObstructionArray(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  return value.every(entry => {
    if (typeof entry !== 'object' || entry === null) return false
    const e = entry as Record<string, unknown>
    return typeof e.path === 'string' && typeof e.kind === 'string' && OBSTRUCTION_KINDS.has(e.kind)
  })
}

const UPDATE_REFUSAL_REASONS = new Set<UpdateRefusalReason>([
  'needs-recovery',
  'checkout-substituted',
  'unsupported-layout',
  'unsupported-config',
  'operation-in-progress',
  'dirty',
  'submodule-initialized',
  'detached',
  'non-default-branch',
  'diverged',
  'ahead',
  'obstructed',
  'maintenance-hold',
])

/** Every refusal reason's own required extra field(s), field-by-field — never cast. */
function isUpdateRefusedBody(v: Record<string, unknown>): boolean {
  if (typeof v.reason !== 'string' || !UPDATE_REFUSAL_REASONS.has(v.reason as UpdateRefusalReason)) return false
  switch (v.reason) {
    case 'unsupported-layout':
      return typeof v.layoutReason === 'string' && LAYOUT_REFUSAL_REASONS.has(v.layoutReason)
    case 'unsupported-config':
      return isStringArray(v.disallowedKeys)
    case 'operation-in-progress':
      return isCheckoutOperation(v.operation)
    case 'dirty':
      return isStringArray(v.changedPaths)
    case 'submodule-initialized':
      return isStringArray(v.submodules)
    case 'non-default-branch':
      return typeof v.branch === 'string' && v.branch.length > 0
    case 'obstructed':
      return isObstructionArray(v.obstructions)
    default:
      return true
  }
}

const UPDATE_FAILURE_REASONS = new Set<string>([
  'aborted',
  'inspection-failed',
  'fetch-auth-rejected',
  'fetch-not-found',
  'fetch-forbidden',
  'fetch-rate-limited',
  'fetch-unreachable',
  'fetch-timeout',
  'fetch-failed',
  'remote-moved',
  'apply-failed',
  'termination-unconfirmed',
])

function isUpdateFailedBody(v: Record<string, unknown>): boolean {
  if (typeof v.reason !== 'string' || !UPDATE_FAILURE_REASONS.has(v.reason)) return false
  if (v.mutationStarted !== true && v.mutationStarted !== false && v.mutationStarted !== 'possibly') return false
  return typeof v.permanent === 'boolean'
}

/**
 * Status/body coherence, matching `apps/workspace-agent/src/server.ts`'s `statusForUpdateResult`
 * exactly: 200→ready, 404→no-checkout, 409→refused, 504→failed+fetch-timeout,
 * 502→failed+permanent, 503→failed+not-permanent. A body whose `kind`/`reason` disagrees with the
 * HTTP status it arrived on is untrustworthy wire data — rejected rather than trusted at face value.
 */
function isUpdateResult(value: unknown, status: number): value is UpdateResult {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (status === 200) return v.kind === 'ready' && isUpdateReadyBody(v)
  if (status === 404) return v.kind === 'no-checkout'
  if (status === 409) return v.kind === 'refused' && isUpdateRefusedBody(v)
  if (v.kind !== 'failed' || !isUpdateFailedBody(v)) return false
  if (status === 504) return v.reason === 'fetch-timeout'
  if (status === 502) return v.permanent === true
  return v.permanent === false // status === 503
}

// ---------------------------------------------------------------------------
// /recover/preview and /recover response parsing — shared shapes
// ---------------------------------------------------------------------------

function isDirtyCounts(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    isNonNegativeInteger(v.staged) &&
    isNonNegativeInteger(v.unstaged) &&
    isNonNegativeInteger(v.untracked) &&
    isNonNegativeInteger(v.conflicted)
  )
}

function isRetentionUsage(value: unknown): value is RetentionUsage {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    isNonNegativeInteger(v.generationCount) &&
    typeof v.hasUnknownSize === 'boolean' &&
    isNonNegativeInteger(v.totalBytes) &&
    isNonNegativeInteger(v.maxGenerations) &&
    isNonNegativeInteger(v.maxBytes)
  )
}

function isRecoveryPreview(value: unknown): value is RecoveryPreview {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.inspectionSafe !== 'boolean') return false
  if (!isNonNegativeInteger(v.estimatedSizeBytes)) return false
  if (!isNonNegativeInteger(v.entryCount)) return false
  if (typeof v.sizeMeasurementComplete !== 'boolean') return false
  if (!isRetentionUsage(v.retention)) return false
  if (typeof v.fingerprint !== 'string') return false
  if (v.inspectionSafe === false) return true
  if (v.headSha !== undefined && !isValidSha(v.headSha)) return false
  if (v.branch !== undefined && (typeof v.branch !== 'string' || v.branch.length === 0)) return false
  if (!isDirtyCounts(v.dirty)) return false
  if (!isCheckoutOperation(v.operationInProgress)) return false
  return isNonNegativeInteger(v.ignoredCount)
}

const JOURNAL_IN_PROGRESS_PHASES = new Set<string>([
  'fetched',
  'applying',
  'applied',
  'building',
  'quarantining',
  'installing',
  'verifying',
  'malformed',
])

function isJournalInProgressPhase(value: unknown): value is JournalInProgressPhase {
  return typeof value === 'string' && JOURNAL_IN_PROGRESS_PHASES.has(value)
}

const UPDATE_JOURNAL_PHASES = new Set<string>(['fetched', 'applying', 'applied'])

function isRecoverableUpdatePreview(value: unknown): value is RecoverableUpdatePreview {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.phase !== 'string' || !UPDATE_JOURNAL_PHASES.has(v.phase)) return false
  if (!isValidSha(v.fromSha) || !isValidSha(v.toSha)) return false
  if (!isValidIsoTimestamp(v.startedAt)) return false
  if (!isNonNegativeInteger(v.estimatedSizeBytes) || !isNonNegativeInteger(v.entryCount)) return false
  if (typeof v.sizeMeasurementComplete !== 'boolean') return false
  return typeof v.fingerprint === 'string'
}

function isPreviewRecoveryResultStatus(status: number): boolean {
  return status === 200 || status === 404 || status === 409 || status === 503
}

/** Status/body coherence, matching `server.ts`'s `statusForPreviewRecoveryResult` exactly. */
function isPreviewRecoveryResult(value: unknown, status: number): value is PreviewRecoveryResult {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (status === 404) return v.kind === 'no-checkout'
  if (status === 409) {
    if (v.kind !== 'refused') return false
    if (v.reason === 'checkout-substituted' || v.reason === 'maintenance-hold') return true
    return v.reason === 'journal-in-progress' && isJournalInProgressPhase(v.phase)
  }
  if (status === 503) {
    return v.kind === 'failed' && (v.reason === 'inspection-failed' || v.reason === 'termination-unconfirmed')
  }
  // status === 200
  if (v.kind === 'ok') return isRecoveryPreview(v.preview)
  return v.kind === 'recoverable-update' && isRecoverableUpdatePreview(v.update)
}

// ---------------------------------------------------------------------------
// /recover response parsing
// ---------------------------------------------------------------------------

function isExecuteRecoveryResultStatus(status: number): boolean {
  return status === 200 || status === 404 || status === 409 || status === 503
}

const EXECUTE_RECOVERY_FAILURE_REASONS = new Set<string>([
  'inspection-failed',
  'fetch-failed',
  'build-failed',
  'quarantine-failed',
  'install-failed',
  'verification-failed',
  'termination-unconfirmed',
])

/** Status/body coherence, matching `server.ts`'s `statusForExecuteRecoveryResult` exactly. */
function isExecuteRecoveryResult(value: unknown, status: number): value is ExecuteRecoveryResult {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (status === 404) return v.kind === 'no-checkout'
  if (status === 409) {
    if (v.kind !== 'refused') return false
    if (v.reason === 'maintenance-hold' || v.reason === 'checkout-changed') return true
    if (v.reason === 'journal-in-progress') return isJournalInProgressPhase(v.phase)
    if (v.reason === 'quota-exceeded') return isRetentionUsage(v.usage)
    return v.reason === 'insufficient-disk-space'
  }
  if (status === 503) {
    return v.kind === 'failed' && typeof v.reason === 'string' && EXECUTE_RECOVERY_FAILURE_REASONS.has(v.reason)
  }
  // status === 200
  return (
    v.kind === 'ok' &&
    typeof v.recoveryId === 'string' &&
    v.recoveryId.length > 0 &&
    isValidSha(v.sha) &&
    typeof v.branch === 'string' &&
    v.branch.length > 0
  )
}

// ---------------------------------------------------------------------------
// GET/DELETE /backups response parsing
// ---------------------------------------------------------------------------

function isBackupEntry(value: unknown): value is BackupEntry {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || v.id.length === 0) return false
  if (typeof v.metadataOk !== 'boolean') return false
  if (!isValidIsoTimestamp(v.createdAt)) return false
  if (!isNonNegativeInteger(v.sizeBytes)) return false
  if (typeof v.sizeComplete !== 'boolean') return false
  if (v.originalHeadSha !== undefined && !isValidSha(v.originalHeadSha)) return false
  if (v.originalBranch !== undefined && typeof v.originalBranch !== 'string') return false
  return true
}

/**
 * `server.ts`'s `statusForListBackupsResult` is a straight `ok→200 | else→503` map — status is
 * already checked by the caller before this runs, so only the body shape is validated here.
 */
function isListBackupsResult(value: unknown, status: number): value is ListBackupsResult {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (status === 503) return v.kind === 'failed'
  if (v.kind !== 'ok') return false
  if (!Array.isArray(v.backups) || !v.backups.every(isBackupEntry)) return false
  return isNonNegativeInteger(v.totalBytes)
}

function isDeleteBackupResultStatus(status: number): boolean {
  return status === 200 || status === 400 || status === 404 || status === 409 || status === 503
}

const DELETE_BACKUP_REFUSAL_REASONS = new Set<string>([
  'invalid-id',
  'not-found',
  'maintenance-hold',
  'recovery-in-progress',
])

/**
 * Status/body coherence, matching `server.ts`'s `statusForDeleteBackupResult` exactly — including
 * that 400 carries a DOMAIN `{kind: 'refused', reason: 'invalid-id'}` body here, unlike every other
 * route in this client where 400 is a generic validation-only shape folded into `http-error`.
 */
function isDeleteBackupResult(value: unknown, status: number): value is DeleteBackupResult {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (status === 200) return v.kind === 'ok'
  if (status === 503) return v.kind === 'failed'
  if (v.kind !== 'refused' || typeof v.reason !== 'string' || !DELETE_BACKUP_REFUSAL_REASONS.has(v.reason)) {
    return false
  }
  if (status === 400) return v.reason === 'invalid-id'
  if (status === 404) return v.reason === 'not-found'
  return v.reason === 'maintenance-hold' || v.reason === 'recovery-in-progress' // status === 409
}
