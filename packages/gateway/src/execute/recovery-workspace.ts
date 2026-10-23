/**
 * The workspace calls automatic recovery makes (`checkout-recovery.ts`), wired from the workspace
 * client. Extracted from `program.ts` so the token discipline is unit-testable:
 *
 * - `previewRecovery` sends only `{owner, repo}` and mints NO installation token. The preview never
 *   touches the network, so a token would be a wasted GitHub round trip that also turns a GitHub
 *   outage into a spurious preview failure.
 * - `recover` mints a token for the repo (its network half fetches the remote) and sends it with the
 *   fingerprint and the run id. A mint failure is returned as-is, so the caller classifies it.
 */

import type {Result} from '@fro-bot/runtime'
import type {WorkspaceClient} from '../workspace-api/client.js'
import type {PreviewRecoveryFn, RecoverFn} from './checkout-recovery.js'

import {err} from '@fro-bot/runtime'

/** Mints an installation token for one repo; `http-error` 401 is a permanent installation failure. */
export type MintWorkspaceToken = (
  owner: string,
  repo: string,
) => Promise<Result<string, {readonly kind: 'http-error'; readonly status: 401} | {readonly kind: 'network-error'}>>

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
      if (token.success === false) return err(token.error)
      return workspaceClient.recover({owner, repo, token: token.data, ...options})
    },
  }
}
