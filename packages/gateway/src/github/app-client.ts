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

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

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
 * Create a GitHub App client that authenticates against repositories using
 * installation tokens.
 *
 * The client mints a fresh JWT for each discovery call (JWTs are cheap and
 * short-lived; caching them adds invalidation complexity for no win). The
 * installation ID is cached in memory per (owner, repo) pair.
 */
export function createAppClient(options: AppClientOptions): AppClient {
  const {appId, privateKey, installUrl = 'https://github.com/apps/fro-bot-agent/installations/new', logger} = options

  // In-memory cache: "owner/repo" → installationId
  const installationCache = new Map<string, number>()

  const cacheKey = (owner: string, repo: string): string => `${owner}/${repo}`

  async function authForRepo(
    owner: string,
    repo: string,
  ): Promise<Result<AppClientAuthResult, AppNotInstalledError | InsufficientPermissionsError | AuthError>> {
    try {
      // Stage 1: JWT-level auth — discover installation ID if not cached.
      let installationId = installationCache.get(cacheKey(owner, repo))

      if (installationId === undefined) {
        // Note: the over-privileged WARN in verifyPermissions only fires during
        // discovery (cache miss). Cache-hit calls skip this block entirely, so
        // the WARN will not repeat on subsequent calls — this is intentional.
        // Mint a JWT-scoped auth (no installationId) to call the discovery endpoint.
        const jwtAuth = createAppAuth({appId, privateKey})

        // Get a JWT token for the App-level request.
        const {token: jwtToken} = await jwtAuth({type: 'app'})

        const discoveryOctokit = new Octokit({auth: jwtToken})

        let installationData: {id: number; permissions: Record<string, string>}
        try {
          const response = await discoveryOctokit.request('GET /repos/{owner}/{repo}/installation', {owner, repo})
          installationData = {
            id: response.data.id,
            permissions: response.data.permissions ?? {},
          }
        } catch (discoveryError) {
          if (isNotFoundError(discoveryError)) {
            return err(new AppNotInstalledError(owner, repo, installUrl))
          }
          return err(new AuthError(safeErrorMessage(discoveryError)))
        }

        // Verify permissions.
        const permissionResult = verifyPermissions(installationData.permissions, installUrl, logger)
        if (permissionResult !== null) {
          return err(permissionResult)
        }

        installationId = installationData.id
        installationCache.set(cacheKey(owner, repo), installationId)

        logger?.debug('Discovered GitHub App installation', {
          owner,
          repo,
          installationId,
        })
      }

      // Stage 2: Mint a repository-scoped installation token.
      // Narrow the token to the requested repository and the minimum required
      // permissions (contents:read) so a compromised token cannot be used to
      // access other repositories in the same installation.
      const installAuth = createAppAuth({appId, privateKey, installationId})
      let token: string
      try {
        ;({token} = await installAuth({
          type: 'installation',
          repositoryNames: [repo],
          permissions: {contents: 'read'},
        }))
      } catch (mintError) {
        // Stage-2 failure means the cached installationId is no longer usable
        // (e.g. revoked installation, rotated key, transient API error).
        // Evict it so the next call re-discovers rather than failing indefinitely.
        installationCache.delete(cacheKey(owner, repo))
        return err(new AuthError(safeErrorMessage(mintError)))
      }

      const octokit = new Octokit({auth: token})

      return ok({octokit, installationId, token})
    } catch (error) {
      return err(new AuthError(safeErrorMessage(error)))
    }
  }

  function invalidateCache(owner: string, repo: string): void {
    installationCache.delete(cacheKey(owner, repo))
  }

  return {authForRepo, invalidateCache}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Verify that the installation's granted permissions meet the minimum
 * requirements. Returns an error if under-privileged, logs a WARN if
 * over-privileged, returns null if OK.
 */
function verifyPermissions(
  granted: Record<string, string>,
  installUrl: string,
  logger?: AppClientOptions['logger'],
): InsufficientPermissionsError | null {
  const missing: string[] = []
  const overPrivileged: string[] = []

  for (const [permission, requiredLevel] of Object.entries(REQUIRED_PERMISSIONS)) {
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

function isNotFoundError(error: unknown): boolean {
  if (error instanceof Error) {
    // @octokit/request-error sets status on the error object
    const status = (error as {status?: number}).status
    if (status === 404) return true
    if (/not.?found|404/i.test(error.message)) return true
  }
  return false
}

/**
 * Extract a safe error message that cannot contain sensitive material.
 *
 * We strip anything that looks like a PEM block or a JWT (three base64url
 * segments separated by dots) before returning the message. This is a
 * defence-in-depth measure — callers should never pass raw auth material
 * into error constructors, but this catches accidental leakage.
 */
function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Unknown error'
  }
  // Strip PEM blocks
  let msg = error.message.replaceAll(/-----BEGIN[^-]+-----[\s\S]*?-----END[^-]+-----/g, '[REDACTED]')
  // Strip JWT-shaped strings (three base64url segments)
  msg = msg.replaceAll(/[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, '[REDACTED]')
  return msg
}
