/**
 * GitHub App client for the gateway.
 *
 * Provides installation-token-based Octokit instances for repository access.
 * Handles installation discovery, permission verification, and token minting.
 *
 * Security invariant: JWTs, private keys, and installation tokens are NEVER
 * written to any log output. This is enforced by the test suite.
 */

import type {Result} from '@fro-bot/runtime'

import {err, ok} from '@fro-bot/runtime'
import {createAppAuth} from '@octokit/auth-app'
import {Octokit} from '@octokit/core'

import {isUsableRepositoryId} from '../shared/repository-id.js'
import {isOctokitNotFound, safeErrorMessage} from './errors.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Timeout for GitHub API requests in getRepoIdentity (FIX 3).
 *
 * A hanging Octokit call during add-project ingest would stall the flow.
 * On timeout the error propagates as an AuthError (non-fatal for backfill;
 * the binding stays keyless and fails closed at the gate).
 */
export const REPO_IDENTITY_REQUEST_TIMEOUT_MS = 10_000

/** Maximum duration for each network operation in workflow-dispatch App auth. */
export const WORKFLOW_DISPATCH_AUTH_TIMEOUT_MS = 5_000

/**
 * Deadline for one whole `authForRepo` call: installation discovery and the token mint share it, and
 * the Octokit requests are aborted when it expires. Without it a stalled GitHub call has no end, and
 * every caller (checkout preparation under the repo lock, the manual recover confirm, the clone path,
 * the denylist reader, add-project, the backfill) would wait on it. This module is the lowest shared
 * place for the constant: `execute/` and `workspace-api/` both import from here, never the reverse.
 */
export const INSTALLATION_TOKEN_MINT_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * The repository was not found via GET /repos/{owner}/{repo} after a successful
 * authForRepo. This means the repo was deleted or renamed — NOT that the App is
 * not installed (that would have failed at the authForRepo stage).
 *
 * FIX 9: Remap 404 from getRepoIdentity to this error rather than AppNotInstalledError,
 * which is misleading (the App IS installed — the repo is gone).
 */
export class RepoNotFoundError extends Error {
  constructor(owner: string, repo: string) {
    super(`Repository ${owner}/${repo} not found (deleted or renamed)`)
    this.name = 'RepoNotFoundError'
  }
}

export class AppNotInstalledError extends Error {
  readonly installUrl: string

  constructor(owner: string, repo: string, installUrl: string) {
    super(`GitHub App is not installed on ${owner}/${repo}. Install it at: ${installUrl}`)
    this.name = 'AppNotInstalledError'
    this.installUrl = installUrl
  }
}

export class InsufficientPermissionsError extends Error {
  readonly missingPermissions: readonly string[]
  readonly installUrl: string

  constructor(missingPermissions: string[], installUrl: string) {
    super(
      `GitHub App installation is missing required permissions: ${missingPermissions.join(', ')}. ` +
        `Review installation permissions at: ${installUrl}`,
    )
    this.name = 'InsufficientPermissionsError'
    this.missingPermissions = missingPermissions
    this.installUrl = installUrl
  }
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

/**
 * An `AuthError` whose cause is the call's own deadline expiring. A subtype, so every caller that
 * handles `AuthError` handles it unchanged; callers that want to tell a stall from other failures can
 * test for it. The message is fixed: nothing from the aborted request is carried over.
 */
export class AuthTimeoutError extends AuthError {
  constructor() {
    super('GitHub App authentication timed out')
    this.name = 'AuthTimeoutError'
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimum required permissions for the App installation. */
const REQUIRED_PERMISSIONS: Record<string, string> = {
  contents: 'read',
}

/** Permission levels ordered from least to most privileged. */
const PERMISSION_LEVELS: readonly string[] = ['none', 'read', 'write', 'admin']

function permissionLevel(level: string): number {
  const idx = PERMISSION_LEVELS.indexOf(level)
  return idx === -1 ? -1 : idx
}

export interface AppClientAuthResult {
  readonly octokit: Octokit
  readonly installationId: number
  /**
   * Raw GitHub installation access token.
   * NEVER log, persist, or otherwise leak this value — treat it as a secret.
   */
  readonly token: string
}

/** The repo's immutable GitHub identity, captured at ingest for deny-key matching. */
export interface RepoIdentity {
  /**
   * GitHub numeric repository id (database_id), stable across rename/transfer.
   * Null means the id is not a positive, safely representable integer; match on nodeId.
   */
  readonly databaseId: number | null
  /** GitHub node_id string for the repository. */
  readonly nodeId: string
}

export interface AppClient {
  /**
   * Return an authenticated Octokit instance for the given repository.
   *
   * On first call for a given (owner, repo) pair, discovers the installation
   * ID via the GitHub API. Subsequent calls reuse the cached installation ID.
   *
   * Cache invalidation contract: if the caller receives a 401 or 404 from
   * GitHub after receiving a token, call `invalidateCache(owner, repo)` before
   * retrying — this forces re-discovery on the next `authForRepo` call.
   */
  readonly authForRepo: (
    owner: string,
    repo: string,
  ) => Promise<Result<AppClientAuthResult, AppNotInstalledError | InsufficientPermissionsError | AuthError>>

  /**
   * Return an authenticated, repository-scoped Octokit instance for workflow dispatch.
   *
   * This capability separately requires Actions: write and mints a token with only
   * `{actions: 'write'}`. It intentionally does not widen the ordinary authForRepo
   * permission contract.
   */
  readonly authForWorkflowDispatch: (
    owner: string,
    repo: string,
  ) => Promise<Result<AppClientAuthResult, AppNotInstalledError | InsufficientPermissionsError | AuthError>>

  /**
   * Fetch the repo's immutable numeric id and node_id via GET /repos/{owner}/{repo}.
   *
   * Uses the authenticated octokit from authForRepo — no extra auth round-trip.
   * Call this during the add-project ingest flow where a legitimate repo query
   * already happens. Do NOT call at run-creation or surface time.
   *
   * Returns the stable numeric `databaseId` (immutable across rename/transfer),
   * or `null` when the id is not a positive, safely representable integer,
   * plus the `nodeId` string for use as deny keys in the redaction gate.
   *
   * Error mapping (FIX 9):
   * - AppNotInstalledError: authForRepo failed (App not installed on this repo).
   * - RepoNotFoundError: authForRepo succeeded but GET /repos returned 404 (repo deleted/renamed).
   * - AuthError: other auth or API failure.
   */
  readonly getRepoIdentity: (
    owner: string,
    repo: string,
  ) => Promise<Result<RepoIdentity, RepoNotFoundError | AppNotInstalledError | AuthError>>

  /**
   * Evict the cached installation ID for the given (owner, repo) pair.
   *
   * Call this when a downstream GitHub API call returns 401 or 404 so the
   * next `authForRepo` re-discovers the installation rather than reusing a
   * stale cached ID.
   */
  readonly invalidateCache: (owner: string, repo: string) => void
}

export interface AppClientOptions {
  readonly appId: string
  readonly privateKey: string
  /** URL shown to users when the App is not installed or lacks permissions. */
  readonly installUrl?: string
  readonly logger?: {
    readonly warn: (msg: string, meta?: Record<string, unknown>) => void
    readonly debug: (msg: string, meta?: Record<string, unknown>) => void
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Bounds one caller's wait by that caller's OWN deadline, separately from the shared transport.
 *
 * Cancelling the transport is not enough: `@octokit/auth-app` coalesces in-flight installation-token
 * requests across callers whatever their signals, so a caller whose discovery finished late can join a
 * request owned by a caller with a later deadline, and its own signal cannot cancel that wait. This race
 * settles the caller with an `AuthTimeoutError` Result the moment its signal fires (at once if it already
 * has), whatever the shared request is doing. The transport cancellation is kept: the signal still aborts
 * the requests this caller owns.
 *
 * The abort listener is removed when the work settles first, and a rejection of work that loses the race
 * is swallowed here, so a late failure is never unhandled.
 */
async function settleByDeadline<T, E extends Error>(
  work: Promise<Result<T, E>>,
  signal: AbortSignal,
): Promise<Result<T, E | AuthTimeoutError>> {
  return new Promise(resolve => {
    const onAbort = (): void => {
      resolve(err(new AuthTimeoutError()))
    }
    if (signal.aborted) {
      onAbort()
    } else {
      signal.addEventListener('abort', onAbort, {once: true})
    }
    work
      .then(
        result => {
          resolve(result)
        },
        (error: unknown) => {
          resolve(err(new AuthError(safeErrorMessage(error))))
        },
      )
      .finally(() => {
        signal.removeEventListener('abort', onAbort)
      })
  })
}

/**
 * Whether a failed request ended because the call's deadline expired. The signal being aborted is the
 * direct evidence. A mint can also end with another caller's expiry: `@octokit/auth-app` shares one
 * in-flight token request between concurrent callers with the same options, so a caller that joined
 * another's request rejects with that request's abort (a `TimeoutError`/`AbortError`, possibly wrapped
 * as a request error's `cause`) while its own signal has not fired yet.
 */
function isDeadlineExpiry(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false
  if (signal.aborted) return true
  let current: unknown = error
  for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
    if (current.name === 'TimeoutError' || current.name === 'AbortError') return true
    current = current.cause
  }
  return false
}

/**
 * Create a GitHub App client that authenticates against repositories using
 * installation tokens.
 *
 * The client mints a fresh JWT for each discovery call (JWTs are cheap and
 * short-lived; caching them adds invalidation complexity for no win). The
 * installation ID is cached in memory per (owner, repo) pair.
 */
export function createAppClient(options: AppClientOptions): AppClient {
  const {appId, privateKey, installUrl = 'https://github.com/apps/fro-bot-agent/installations/new', logger} = options

  interface InstallationData {
    readonly id: number
    readonly permissions: Record<string, string>
  }

  // In-memory cache: "owner/repo" → verified installation data
  const installationCache = new Map<string, InstallationData>()

  const cacheKey = (owner: string, repo: string): string => `${owner}/${repo}`

  async function discoverInstallation(
    owner: string,
    repo: string,
    requestSignal?: AbortSignal,
  ): Promise<Result<InstallationData, AppNotInstalledError | InsufficientPermissionsError | AuthError>> {
    const key = cacheKey(owner, repo)
    const cached = installationCache.get(key)
    if (cached !== undefined) return ok(cached)

    try {
      // Mint a JWT-scoped auth (no installationId) to call the discovery endpoint.
      const jwtAuth = createAppAuth({appId, privateKey})
      const {token: jwtToken} = await jwtAuth({type: 'app'})
      const discoveryOctokit = new Octokit({auth: jwtToken})

      let installationData: InstallationData
      try {
        const requestOptions =
          requestSignal === undefined ? {owner, repo} : {owner, repo, request: {signal: requestSignal}}
        const response = await discoveryOctokit.request('GET /repos/{owner}/{repo}/installation', requestOptions)
        installationData = {
          id: response.data.id,
          permissions: response.data.permissions ?? {},
        }
      } catch (discoveryError) {
        if (isDeadlineExpiry(discoveryError, requestSignal)) return err(new AuthTimeoutError())
        if (isOctokitNotFound(discoveryError)) {
          return err(new AppNotInstalledError(owner, repo, installUrl))
        }
        return err(new AuthError(safeErrorMessage(discoveryError)))
      }

      // The ordinary contents:read minimum remains a prerequisite for every cached installation.
      const permissionResult = verifyPermissions(installationData.permissions, REQUIRED_PERMISSIONS, installUrl, logger)
      if (permissionResult !== null) return err(permissionResult)

      installationCache.set(key, installationData)
      logger?.debug('Discovered GitHub App installation', {
        owner,
        repo,
        installationId: installationData.id,
      })
      return ok(installationData)
    } catch (error) {
      if (isDeadlineExpiry(error, requestSignal)) return err(new AuthTimeoutError())
      return err(new AuthError(safeErrorMessage(error)))
    }
  }

  async function mintToken(
    owner: string,
    repo: string,
    installation: InstallationData,
    permissions: Record<string, string>,
    requestSignal?: AbortSignal,
  ): Promise<Result<AppClientAuthResult, AuthError>> {
    try {
      // The deadline goes on the REQUEST IMPLEMENTATION handed to `createAppAuth`, not on the
      // invocation: for the installation-token POST, `@octokit/auth-app` uses `state.request` and
      // ignores a per-invocation `request` option, so a signal passed there never reaches the transport.
      // `Octokit` is already a direct dependency; its `request` carries `.defaults`.
      const installAuth = createAppAuth({
        appId,
        privateKey,
        installationId: installation.id,
        ...(requestSignal === undefined
          ? {}
          : {request: new Octokit().request.defaults({request: {signal: requestSignal}})}),
      })
      const {token} = await installAuth({
        type: 'installation',
        repositoryNames: [repo],
        permissions,
      })
      const octokit = new Octokit({auth: token})
      return ok({octokit, installationId: installation.id, token})
    } catch (mintError) {
      // A mint failure means the cached installation may no longer be usable.
      installationCache.delete(cacheKey(owner, repo))
      if (isDeadlineExpiry(mintError, requestSignal)) return err(new AuthTimeoutError())
      return err(new AuthError(safeErrorMessage(mintError)))
    }
  }

  async function authForRepo(
    owner: string,
    repo: string,
  ): Promise<Result<AppClientAuthResult, AppNotInstalledError | InsufficientPermissionsError | AuthError>> {
    // One deadline for the whole call, shared by discovery and the mint, so the requests are aborted
    // when it expires. An abort comes back as an `AuthTimeoutError` Result, never a throw.
    const deadline = AbortSignal.timeout(INSTALLATION_TOKEN_MINT_TIMEOUT_MS)
    return settleByDeadline(
      (async () => {
        const installationResult = await discoverInstallation(owner, repo, deadline)
        if (installationResult.success === false) return installationResult
        return mintToken(owner, repo, installationResult.data, {contents: 'read'}, deadline)
      })(),
      deadline,
    )
  }

  async function authForWorkflowDispatch(
    owner: string,
    repo: string,
  ): Promise<Result<AppClientAuthResult, AppNotInstalledError | InsufficientPermissionsError | AuthError>> {
    const discoveryDeadline = AbortSignal.timeout(WORKFLOW_DISPATCH_AUTH_TIMEOUT_MS)
    const installationResult = await settleByDeadline(
      discoverInstallation(owner, repo, discoveryDeadline),
      discoveryDeadline,
    )
    if (installationResult.success === false) return installationResult

    const permissionResult = verifyPermissions(
      installationResult.data.permissions,
      {actions: 'write'},
      installUrl,
      logger,
    )
    if (permissionResult !== null) {
      // Do not retain an installation that cannot satisfy this dedicated capability.
      installationCache.delete(cacheKey(owner, repo))
      return err(permissionResult)
    }

    const mintDeadline = AbortSignal.timeout(WORKFLOW_DISPATCH_AUTH_TIMEOUT_MS)
    return settleByDeadline(
      mintToken(owner, repo, installationResult.data, {actions: 'write'}, mintDeadline),
      mintDeadline,
    )
  }

  async function getRepoIdentity(
    owner: string,
    repo: string,
  ): Promise<Result<RepoIdentity, RepoNotFoundError | AppNotInstalledError | AuthError>> {
    // Authenticate via the existing flow — reuses the cached installation ID when available.
    const authResult = await authForRepo(owner, repo)
    if (authResult.success === false) {
      // Propagate auth errors (AppNotInstalledError, InsufficientPermissionsError, AuthError).
      // InsufficientPermissionsError is not in our return type but extends Error — wrap it.
      const error = authResult.error
      if (error instanceof AppNotInstalledError) {
        return err(error)
      }
      return err(new AuthError(safeErrorMessage(error)))
    }

    const {octokit} = authResult.data

    // Issue GET /repos/{owner}/{repo} to capture the immutable numeric id and node_id.
    // This is the only correct endpoint for repo identity — GET /repos/{owner}/{repo}/installation
    // returns only installation id + permissions, NOT repo identity.
    //
    // FIX 3: Add a timeout so a hanging request cannot stall the add-project flow indefinitely.
    // FIX 9: A 404 here means the repo was deleted/renamed AFTER a successful authForRepo
    //        (which proves the App IS installed). Map to RepoNotFoundError, not AppNotInstalledError.
    try {
      const response = await octokit.request('GET /repos/{owner}/{repo}', {
        owner,
        repo,
        request: {signal: AbortSignal.timeout(REPO_IDENTITY_REQUEST_TIMEOUT_MS)},
      })

      const {id, node_id: nodeId} = response.data
      const databaseId = toSafeRepositoryId(id)

      if (databaseId === null) {
        logger?.warn('Repository database id cannot be used as a numeric deny key; matching on nodeId', {owner, repo})
      }

      return ok({databaseId, nodeId})
    } catch (error) {
      if (isOctokitNotFound(error)) {
        // FIX 9: 404 after successful auth = repo gone (deleted/renamed), not App not installed.
        return err(new RepoNotFoundError(owner, repo))
      }
      return err(new AuthError(safeErrorMessage(error)))
    }
  }

  function invalidateCache(owner: string, repo: string): void {
    installationCache.delete(cacheKey(owner, repo))
  }

  return {authForRepo, authForWorkflowDispatch, getRepoIdentity, invalidateCache}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Narrow an Octokit repository id to a positive, exactly representable number.
 *
 * The parameter accepts both Octokit response shapes: v16 exposes `id` as a
 * number, while v17 may expose `number | bigint`.
 */
function toSafeRepositoryId(id: number | bigint): number | null {
  if (typeof id === 'bigint') {
    // Fast path: avoid Number() for non-positive bigint values; the usability predicate below remains authoritative.
    if (id <= 0n) return null

    const numericId = Number(id)
    if (isUsableRepositoryId(numericId) && BigInt(numericId) === id) {
      return numericId
    }

    return null
  }

  if (isUsableRepositoryId(id) === false) {
    return null
  }

  return id
}

/**
 * Verify that the installation's granted permissions meet the minimum
 * requirements. Returns an error if under-privileged, logs a WARN if
 * over-privileged, returns null if OK.
 */
function verifyPermissions(
  granted: Record<string, string>,
  requiredPermissions: Record<string, string>,
  installUrl: string,
  logger?: AppClientOptions['logger'],
): InsufficientPermissionsError | null {
  const missing: string[] = []
  const overPrivileged: string[] = []

  for (const [permission, requiredLevel] of Object.entries(requiredPermissions)) {
    const grantedLevel = granted[permission] ?? 'none'
    const grantedIdx = permissionLevel(grantedLevel)
    const requiredIdx = permissionLevel(requiredLevel)

    if (grantedIdx < requiredIdx) {
      missing.push(`${permission}: ${requiredLevel} (granted: ${grantedLevel})`)
    } else if (grantedIdx > requiredIdx) {
      overPrivileged.push(`${permission}: ${grantedLevel} (only ${requiredLevel} required)`)
    }
  }

  if (missing.length > 0) {
    return new InsufficientPermissionsError(missing, installUrl)
  }

  if (overPrivileged.length > 0) {
    logger?.warn('GitHub App installation has over-privileged permissions; consider reducing to minimum required', {
      overPrivileged,
    })
  }

  return null
}

// isOctokitNotFound and safeErrorMessage are imported from ./errors.js (FIX 10)
