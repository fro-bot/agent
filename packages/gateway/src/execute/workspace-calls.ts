/**
 * The gateway's calls into the workspace control API that need a GitHub installation token, wired from
 * the app client and the workspace client. Extracted from `program.ts` so the wiring itself is tested:
 * every mint is bounded, and no workspace request is sent with a token that did not arrive in time.
 *
 * - `update` (checkout preparation, `run.ts`): `update-workspace.ts`.
 * - `previewRecovery`, `recover` (automatic recovery of a dirty checkout): `recovery-workspace.ts`.
 *
 * The mint itself is `appClient.authForRepo`, adapted here to the shape the bounded helpers use. A
 * permanent installation failure (not installed, missing permissions) is the `401` kind `run.ts` maps
 * to `workspace-unavailable`; every other failure is the retryable `network-error` kind. Both carry the
 * error class as their `cause` (never the message) for diagnostics.
 */

import type {GatewayLogger} from '../discord/client.js'
import type {AppClient} from '../github/app-client.js'
import type {WorkspaceClient} from '../workspace-api/client.js'
import type {RecoveryWorkspaceCalls} from './recovery-workspace.js'
import type {UpdateWorkspaceCall} from './update-workspace.js'
import type {MintWorkspaceToken} from './workspace-token.js'

import {err, ok} from '@fro-bot/runtime'
import {AppNotInstalledError, InsufficientPermissionsError} from '../github/app-client.js'
import {createRecoveryWorkspaceCalls} from './recovery-workspace.js'
import {createUpdateWorkspaceCall} from './update-workspace.js'

export interface WorkspaceCalls extends RecoveryWorkspaceCalls {
  readonly update: UpdateWorkspaceCall
}

export function createWorkspaceCalls(deps: {
  readonly appClient: Pick<AppClient, 'authForRepo'>
  readonly workspaceClient: Pick<WorkspaceClient, 'update' | 'previewRecovery' | 'recover'>
  readonly logger: Pick<GatewayLogger, 'warn'>
}): WorkspaceCalls {
  const {appClient, workspaceClient, logger} = deps

  const mintToken: MintWorkspaceToken = async (owner, repo) => {
    const authResult = await appClient.authForRepo(owner, repo)
    if (authResult.success === false) {
      const cause = authResult.error.constructor.name
      if (
        authResult.error instanceof AppNotInstalledError ||
        authResult.error instanceof InsufficientPermissionsError
      ) {
        return err({kind: 'http-error' as const, status: 401 as const, cause})
      }
      return err({kind: 'network-error' as const, cause})
    }
    return ok(authResult.data.token)
  }

  return {
    update: createUpdateWorkspaceCall({workspaceClient, mintToken, logger}),
    ...createRecoveryWorkspaceCalls({workspaceClient, mintToken}),
  }
}
