/**
 * The workspace calls automatic recovery makes (`checkout-recovery.ts`), wired from the workspace
 * client. Extracted from `program.ts` so the token discipline is unit-testable:
 *
 * - `previewRecovery` sends only `{owner, repo}` and mints NO installation token. The preview never
 *   touches the network, so a token would be a wasted GitHub round trip that also turns a GitHub
 *   outage into a spurious preview failure.
 * - `recover` mints a token for the repo (its network half fetches the remote) and sends it with the
 *   fingerprint and the run id. The mint is bounded by `RECOVERY_TOKEN_MINT_TIMEOUT_MS`, because the
 *   production mint has no deadline of its own and this runs under the repo lock. A mint that fails,
 *   throws or does not answer in time returns `token-unavailable` WITHOUT sending `/recover`: nothing
 *   was asked of the workspace, so the caller treats it as a decline, not an ambiguous transport error.
 */

import type {Result} from '@fro-bot/runtime'
import type {WorkspaceClient} from '../workspace-api/client.js'
import type {PreviewRecoveryFn, RecoverFn} from './checkout-recovery.js'

import {err} from '@fro-bot/runtime'
import {RECOVERY_TOKEN_MINT_TIMEOUT_MS} from './recovery-budget.js'

/** Mints an installation token for one repo; `http-error` 401 is a permanent installation failure. */
export type MintWorkspaceToken = (
  owner: string,
  repo: string,
) => Promise<Result<string, {readonly kind: 'http-error'; readonly status: 401} | {readonly kind: 'network-error'}>>

export interface RecoveryWorkspaceCalls {
  readonly previewRecovery: PreviewRecoveryFn
  readonly recover: RecoverFn
}

type MintOutcome = Awaited<ReturnType<MintWorkspaceToken>> | 'timeout' | 'threw'

/**
 * Races the mint against `timeoutMs`. `authForRepo` accepts no abort signal, so a mint that loses the
 * race keeps running unobserved; it can neither start a recovery (the caller is sequential and has
 * already returned) nor surface an unhandled rejection (its outcome is swallowed here).
 */
async function mintWithin(
  mintToken: MintWorkspaceToken,
  owner: string,
  repo: string,
  timeoutMs: number,
): Promise<MintOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  const minted = mintToken(owner, repo).catch((): 'threw' => 'threw')
  try {
    return await Promise.race([minted, timeout])
  } finally {
    clearTimeout(timer)
  }
}

export function createRecoveryWorkspaceCalls(deps: {
  readonly workspaceClient: Pick<WorkspaceClient, 'previewRecovery' | 'recover'>
  readonly mintToken: MintWorkspaceToken
  /** Test seam; defaults to `RECOVERY_TOKEN_MINT_TIMEOUT_MS`. */
  readonly mintTimeoutMs?: number
}): RecoveryWorkspaceCalls {
  const {workspaceClient, mintToken, mintTimeoutMs = RECOVERY_TOKEN_MINT_TIMEOUT_MS} = deps
  return {
    previewRecovery: async (owner, repo) => workspaceClient.previewRecovery({owner, repo}),
    recover: async (owner, repo, options) => {
      const token = await mintWithin(mintToken, owner, repo, mintTimeoutMs)
      if (token === 'timeout' || token === 'threw' || token.success === false) {
        return err({kind: 'token-unavailable' as const})
      }
      return workspaceClient.recover({owner, repo, token: token.data, ...options})
    },
  }
}
