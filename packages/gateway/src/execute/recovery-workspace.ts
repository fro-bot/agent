/**
 * The workspace calls automatic recovery makes (`checkout-recovery.ts`), wired from the workspace
 * client. Extracted from `program.ts` so the token discipline is unit-testable:
 *
 * - `previewRecovery` sends only `{owner, repo}` and mints NO installation token. The preview never
 *   touches the network, so a token would be a wasted GitHub round trip that also turns a GitHub
 *   outage into a spurious preview failure.
 * - `recover` mints a token for the repo (its network half fetches the remote) and sends it with the
 *   fingerprint and the run id. The mint is bounded by `mintBounded` (`INSTALLATION_TOKEN_MINT_TIMEOUT_MS`), because the
 *   production mint has no deadline of its own and this runs under the repo lock. A mint that fails,
 *   throws or does not answer in time returns `token-unavailable` WITHOUT sending `/recover`: nothing
 *   was asked of the workspace, so the caller treats it as a decline, not an ambiguous transport error.
 */

import type {WorkspaceClient} from '../workspace-api/client.js'
import type {PreviewRecoveryFn, RecoverFn} from './checkout-recovery.js'
import type {MintWorkspaceToken} from './workspace-token.js'

import {err} from '@fro-bot/runtime'
import {INSTALLATION_TOKEN_MINT_TIMEOUT_MS, mintBounded} from './workspace-token.js'

export interface RecoveryWorkspaceCalls {
  readonly previewRecovery: PreviewRecoveryFn
  readonly recover: RecoverFn
}

export function createRecoveryWorkspaceCalls(deps: {
  readonly workspaceClient: Pick<WorkspaceClient, 'previewRecovery' | 'recover'>
  readonly mintToken: MintWorkspaceToken
  /** Test seam; defaults to `INSTALLATION_TOKEN_MINT_TIMEOUT_MS`. */
  readonly mintTimeoutMs?: number
}): RecoveryWorkspaceCalls {
  const {workspaceClient, mintToken, mintTimeoutMs = INSTALLATION_TOKEN_MINT_TIMEOUT_MS} = deps
  return {
    previewRecovery: async (owner, repo) => workspaceClient.previewRecovery({owner, repo}),
    recover: async (owner, repo, options) => {
      const token = await mintBounded(mintToken, owner, repo, mintTimeoutMs)
      // Whatever the cause (a failure, a throw or a timeout), no `/recover` was sent: nothing moved.
      if (token.success === false) return err({kind: 'token-unavailable' as const})
      return workspaceClient.recover({owner, repo, token: token.data, ...options})
    },
  }
}
