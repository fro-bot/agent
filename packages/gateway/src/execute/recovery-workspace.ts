/**
 * The workspace calls automatic recovery makes (`checkout-recovery.ts`), wired from the workspace
 * client. Extracted from `program.ts` so the token discipline is unit-testable:
 *
 * - `previewRecovery` sends only `{owner, repo}` and mints NO installation token. The preview never
 *   touches the network, so a token would be a wasted GitHub round trip that also turns a GitHub
 *   outage into a spurious preview failure.
 * - `recover` mints a token for the repo (its network half fetches the remote) and sends it with the
 *   fingerprint and the run id. The mint (`authForRepo`) bounds itself, because this runs under the repo lock.
 *   A mint that fails, throws or does not answer in time returns `token-unavailable` WITHOUT sending
 *   `/recover`: nothing was asked of the workspace, so the caller treats it as a decline, not an ambiguous
 *   transport error.
 */

import type {WorkspaceClient} from '../workspace-api/client.js'
import type {PreviewRecoveryFn, RecoverFn} from './checkout-recovery.js'
import type {MintWorkspaceToken} from './workspace-token.js'

import {err} from '@fro-bot/runtime'

export interface RecoveryWorkspaceCalls {
  readonly previewRecovery: PreviewRecoveryFn
  readonly recover: RecoverFn
}

export function createRecoveryWorkspaceCalls(deps: {
  readonly workspaceClient: Pick<WorkspaceClient, 'previewRecovery' | 'recover'>
  readonly mintToken: MintWorkspaceToken
}): RecoveryWorkspaceCalls {
  const {workspaceClient, mintToken} = deps
  return {
    previewRecovery: async (owner, repo) => workspaceClient.previewRecovery({owner, repo}),
    recover: async (owner, repo, options) => {
      const token = await mintToken(owner, repo)
      // Whatever the cause (a failure, a throw or a timeout), no `/recover` was sent: nothing moved.
      // The cause rides along for the decline log.
      if (token.success === false) return err({kind: 'token-unavailable' as const, cause: token.error.cause})
      return workspaceClient.recover({owner, repo, token: token.data, ...options})
    },
  }
}
