/**
 * The gateway's calls into the workspace control API that need a GitHub installation token, wired from
 * the app client and the workspace client. Extracted from `program.ts` so the wiring itself is tested:
 * every mint is bounded by `authForRepo`'s own deadline, and no workspace request is sent with a token that
 * did not arrive in time.
 *
 * - `update` (checkout preparation, `run.ts`): `update-workspace.ts`.
 * - `previewRecovery`, `recover` (automatic recovery of a dirty checkout): `recovery-workspace.ts`.
 *
 * The mint itself is `appClient.authForRepo`, adapted by `createInstallationTokenMint`: a permanent
 * installation failure (not installed, missing permissions) is the `401` kind `run.ts` maps to
 * `workspace-unavailable`; every other failure is the retryable `network-error` kind. Both carry the error
 * class as their `cause` (never the message) for diagnostics.
 */

import type {GatewayLogger} from '../discord/client.js'
import type {AppClient} from '../github/app-client.js'
import type {WorkspaceClient} from '../workspace-api/client.js'
import type {RecoveryWorkspaceCalls} from './recovery-workspace.js'
import type {UpdateWorkspaceCall} from './update-workspace.js'

import {createRecoveryWorkspaceCalls} from './recovery-workspace.js'
import {createUpdateWorkspaceCall} from './update-workspace.js'
import {createInstallationTokenMint} from './workspace-token.js'

export interface WorkspaceCalls extends RecoveryWorkspaceCalls {
  readonly update: UpdateWorkspaceCall
}

export function createWorkspaceCalls(deps: {
  readonly appClient: Pick<AppClient, 'authForRepo'>
  readonly workspaceClient: Pick<WorkspaceClient, 'update' | 'previewRecovery' | 'recover'>
  readonly logger: Pick<GatewayLogger, 'warn'>
}): WorkspaceCalls {
  const {appClient, workspaceClient, logger} = deps

  const mintToken = createInstallationTokenMint(appClient)

  return {
    update: createUpdateWorkspaceCall({workspaceClient, mintToken, logger}),
    ...createRecoveryWorkspaceCalls({workspaceClient, mintToken}),
  }
}
