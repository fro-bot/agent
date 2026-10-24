/**
 * The installation-token mint the gateway performs before it asks the workspace for anything that needs a
 * GitHub credential (`/update`, `/recover`, and the manual recover confirm click).
 *
 * The mint is `appClient.authForRepo`, which bounds itself: it aborts its own requests at
 * `INSTALLATION_TOKEN_MINT_TIMEOUT_MS` and releases each caller at that caller's own deadline, even when it
 * joined another caller's coalesced request, so it returns an `AuthTimeoutError` Result at the bound
 * whatever the transport does. These mints run in checkout preparation, under the repo lock and before the
 * run's hard timer exists, which is why that bound has to live at the source and not in each caller.
 */

import type {Result} from '@fro-bot/runtime'
import type {AppClient} from '../github/app-client.js'

import {err, ok} from '@fro-bot/runtime'
import {AppNotInstalledError, AuthTimeoutError, InsufficientPermissionsError} from '../github/app-client.js'

/**
 * Why a mint produced no token, and what kind of failure it is. `http-error` 401 is a permanent
 * installation failure, `network-error` is retryable; the kinds are what `run.ts` maps. `cause` is for
 * diagnostics only: `timeout` (the mint's own deadline expired), `threw` (a non-Error was thrown), or an
 * error class name. It is never an error message, which can carry tokens or internal detail.
 */
export type MintFailure = ({readonly kind: 'http-error'; readonly status: 401} | {readonly kind: 'network-error'}) & {
  readonly cause: string
}

/** Mints an installation token for one repo. It settles with a `Result` and never throws. */
export type MintWorkspaceToken = (owner: string, repo: string) => Promise<Result<string, MintFailure>>

/**
 * Adapts `appClient.authForRepo` to `MintWorkspaceToken`. A permanent installation failure (not installed,
 * missing permissions) is the `401` kind; every other failure, including the mint's own deadline and a throw
 * (even a synchronous one from a non-async mint), is the retryable `network-error` kind: nothing says the
 * installation is gone, and a retry may succeed.
 */
export function createInstallationTokenMint(appClient: Pick<AppClient, 'authForRepo'>): MintWorkspaceToken {
  return async (owner, repo) => {
    try {
      const authResult = await appClient.authForRepo(owner, repo)
      if (authResult.success) return ok(authResult.data.token)

      const failure = authResult.error
      if (failure instanceof AuthTimeoutError) return err({kind: 'network-error' as const, cause: 'timeout'})
      const cause = failure.constructor.name
      if (failure instanceof AppNotInstalledError || failure instanceof InsufficientPermissionsError) {
        return err({kind: 'http-error' as const, status: 401 as const, cause})
      }
      return err({kind: 'network-error' as const, cause})
    } catch (error: unknown) {
      return err({
        kind: 'network-error' as const,
        cause: error instanceof Error && error.constructor.name !== '' ? error.constructor.name : 'threw',
      })
    }
  }
}
