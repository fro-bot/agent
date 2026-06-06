/**
 * ensureWorkspaceClone — reusable gateway seam for workspace checkout rehydration.
 *
 * Guarantees that a workspace checkout exists for a bound repo before mention
 * execution proceeds. Mints a repo-scoped installation token via the GitHub App
 * client and calls workspaceClient.clone(), treating `repo-exists` as a
 * successful recovery signal (idempotent per workspace-agent contract).
 *
 * SECURITY INVARIANTS:
 * - Installation access tokens (ghs_*) are NEVER logged.
 * - Internal paths, auth details, and S3 keys are NEVER surfaced to callers for
 *   inclusion in Discord replies — callers receive structured failure kinds only.
 * - Raw error messages are NEVER included in returned errors (unexpected-error stays coarse).
 */

import type {Result} from '@fro-bot/runtime'
import type {AppClient} from '../github/app-client.js'
import type {WorkspaceClient} from './client.js'
import type {CloneErrorCode, WorkspaceError} from './types.js'

import {err, ok} from '@fro-bot/runtime'
import {workspaceRepoPath} from './client.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Structured failure kinds returned by ensureWorkspaceClone.
 *
 * - `auth-failure`: GitHub App auth failed or timed out. `reason` distinguishes
 *   the two sub-cases for ops/automation; callers may ignore it for coarse replies.
 * - `workspace-failure`: Clone failed. `workspaceKind` mirrors the underlying
 *   WorkspaceError kind for structured ops/automation use. Additional fields
 *   (`code`, `status`) are present when the underlying error carries them.
 *   Callers may reply generically using only `error.kind`.
 * - `unexpected-error`: Unexpected thrown exception. Stays coarse — no raw message.
 *
 * Discord reply handlers MUST use only `error.kind` for user-facing messages.
 * Ops/automation MAY inspect `reason`, `workspaceKind`, `code`, and `status`.
 */
export type EnsureCloneFailure =
  | {readonly kind: 'auth-failure'; readonly reason?: 'auth-error' | 'timeout'}
  | WorkspaceFailure
  | {readonly kind: 'unexpected-error'}

/**
 * workspace-failure sub-union — mirrors WorkspaceError kinds with structured detail.
 * The `workspaceKind` field is the discriminant within this variant.
 */
export type WorkspaceFailure =
  | {readonly kind: 'workspace-failure'; readonly workspaceKind: 'clone-error'; readonly code: CloneErrorCode}
  | {readonly kind: 'workspace-failure'; readonly workspaceKind: 'http-error'; readonly status: number}
  | {readonly kind: 'workspace-failure'; readonly workspaceKind: 'network-error'}
  | {readonly kind: 'workspace-failure'; readonly workspaceKind: 'timeout'}
  | {readonly kind: 'workspace-failure'; readonly workspaceKind: 'parse-error'}
  | {readonly kind: 'workspace-failure'; readonly workspaceKind: 'response-mismatch'}

/** Default timeout for the GitHub App auth call in milliseconds (30 seconds). */
export const DEFAULT_ENSURE_CLONE_AUTH_TIMEOUT_MS = 30_000

export interface EnsureCloneDeps {
  readonly owner: string
  readonly repo: string
  readonly appClient: AppClient
  readonly workspaceClient: WorkspaceClient
  readonly logger: {
    readonly info: (msg: string, meta?: Record<string, unknown>) => void
    readonly warn: (msg: string, meta?: Record<string, unknown>) => void
    readonly error: (msg: string, meta?: Record<string, unknown>) => void
  }
  /**
   * Timeout in milliseconds for the GitHub App auth call.
   * Defaults to DEFAULT_ENSURE_CLONE_AUTH_TIMEOUT_MS (30s).
   * Inject a small value in tests to avoid hanging.
   */
  readonly timeoutMs?: number
}

// ---------------------------------------------------------------------------
// Helper: map WorkspaceError → WorkspaceFailure
// ---------------------------------------------------------------------------

/**
 * Map a WorkspaceError to a WorkspaceFailure, preserving structured detail
 * (workspaceKind, code, status) for ops/automation while keeping the outer
 * `kind: 'workspace-failure'` coarse for Discord reply handlers.
 */
function toWorkspaceFailure(error: WorkspaceError): WorkspaceFailure {
  switch (error.kind) {
    case 'clone-error':
      return {kind: 'workspace-failure', workspaceKind: 'clone-error', code: error.code}
    case 'http-error':
      return {kind: 'workspace-failure', workspaceKind: 'http-error', status: error.status}
    case 'network-error':
      return {kind: 'workspace-failure', workspaceKind: 'network-error'}
    case 'timeout':
      return {kind: 'workspace-failure', workspaceKind: 'timeout'}
    case 'parse-error':
      return {kind: 'workspace-failure', workspaceKind: 'parse-error'}
    case 'response-mismatch':
      return {kind: 'workspace-failure', workspaceKind: 'response-mismatch'}
  }
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Ensure a workspace checkout exists for the given owner/repo.
 *
 * Flow:
 * 1. Mint a repo-scoped installation token via appClient.authForRepo().
 * 2. Call workspaceClient.clone({owner, repo, token}).
 * 3. On clone success: return the validated path from the clone response.
 * 4. On clone-error/repo-exists: return workspaceRepoPath(owner, repo) — the
 *    checkout already exists; this is a successful recovery signal.
 * 5. On any other failure: return a structured EnsureCloneFailure.
 *
 * Returns:
 * - `ok(path)` — checkout exists at the returned path.
 * - `err({kind: 'auth-failure', reason: 'auth-error'})` — GitHub App auth failed.
 * - `err({kind: 'auth-failure', reason: 'timeout'})` — GitHub App auth timed out.
 * - `err({kind: 'workspace-failure', workspaceKind, ...})` — clone failed with
 *   structured detail (workspaceKind mirrors WorkspaceError kind; http-error
 *   includes status; clone-error includes code; response-mismatch is distinguishable).
 * - `err({kind: 'unexpected-error'})` — unexpected thrown exception (coarse, no message).
 *
 * Discord reply handlers MUST use only `error.kind` for user-facing messages.
 */
export async function ensureWorkspaceClone(deps: EnsureCloneDeps): Promise<Result<string, EnsureCloneFailure>> {
  const {owner, repo, appClient, workspaceClient, logger, timeoutMs = DEFAULT_ENSURE_CLONE_AUTH_TIMEOUT_MS} = deps

  try {
    // Stage 1: Mint a repo-scoped installation token with a bounded timeout.
    // Without a timeout, a hung GitHub API call would block the mention handler indefinitely.
    // Use a sentinel class so we can distinguish a timeout from a real thrown error.
    class AuthTimeoutError extends Error {
      constructor() {
        super('auth-timeout')
        this.name = 'AuthTimeoutError'
      }
    }
    const authPromise = appClient.authForRepo(owner, repo)
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new AuthTimeoutError()), timeoutMs)
    })
    let authResult: Awaited<ReturnType<typeof appClient.authForRepo>>
    try {
      authResult = await Promise.race([authPromise, timeoutPromise])
    } catch (raceError: unknown) {
      if (raceError instanceof AuthTimeoutError) {
        // Timeout — treat as auth-failure with reason 'timeout'.
        logger.warn('ensure-clone: app auth timed out', {owner, repo, timeoutMs})
        return err({kind: 'auth-failure', reason: 'timeout'})
      }
      // Real thrown error — re-throw so the outer catch handles it as unexpected-error.
      throw raceError
    } finally {
      clearTimeout(timeoutHandle)
    }
    if (authResult.success === false) {
      logger.warn('ensure-clone: app auth failed', {
        owner,
        repo,
        errorKind: authResult.error.constructor.name,
      })
      return err({kind: 'auth-failure', reason: 'auth-error'})
    }

    // SECURITY: token is never logged.
    const {token} = authResult.data

    // Stage 2: Clone (or confirm existing checkout).
    const cloneResult = await workspaceClient.clone({owner, repo, token})

    if (cloneResult.success === true) {
      // Fresh clone succeeded — return the validated path from the response.
      logger.info('ensure-clone: clone succeeded', {owner, repo})
      return ok(cloneResult.data.path)
    }

    const cloneError = cloneResult.error

    // repo-exists is a successful recovery signal: the checkout already exists.
    if (cloneError.kind === 'clone-error' && cloneError.code === 'repo-exists') {
      logger.info('ensure-clone: repo-exists, checkout already present', {owner, repo})
      return ok(workspaceRepoPath(owner, repo))
    }

    // response-mismatch is a security signal — log at error level, fail closed.
    if (cloneError.kind === 'response-mismatch') {
      logger.error('ensure-clone: response-mismatch from workspace agent', {owner, repo})
      return err(toWorkspaceFailure(cloneError))
    }

    // All other clone failures: timeout, network-error, http-error, parse-error,
    // or non-recoverable clone-error codes. Preserve structured detail.
    logger.warn('ensure-clone: clone failed', {owner, repo, workspaceKind: cloneError.kind})
    return err(toWorkspaceFailure(cloneError))
  } catch (error) {
    logger.error('ensure-clone: unexpected error', {
      owner,
      repo,
      error: error instanceof Error ? error.message : String(error),
    })
    // SECURITY: raw message is never included in the returned error.
    return err({kind: 'unexpected-error'})
  }
}
