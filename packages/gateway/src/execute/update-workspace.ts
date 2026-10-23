/**
 * The `/update` call checkout preparation makes (`run.ts`), wired from the workspace client. Extracted
 * from `program.ts` so the token discipline is unit-testable: the installation-token mint is bounded
 * (`mintBounded`), and `/update` is only sent with a token that arrived in time.
 *
 * A mint failure is returned exactly as `run.ts` already maps it: `401` (permanent installation
 * failure) to `workspace-unavailable`, anything else to `unreachable`. A mint that times out or throws
 * is the retryable kind, never an `update` timeout: no update request was sent, so the "state unknown"
 * reply, which says the checkout may have changed, would be false.
 */

import type {Result} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'
import type {WorkspaceClient} from '../workspace-api/client.js'
import type {UpdateResult, UpdateWorkspaceError} from '../workspace-api/types.js'
import type {MintFailure, MintWorkspaceToken} from './workspace-token.js'

import {INSTALLATION_TOKEN_MINT_TIMEOUT_MS, mintBounded} from './workspace-token.js'

export type UpdateWorkspaceCall = (
  owner: string,
  repo: string,
  options: {readonly remainingBudgetMs: number},
) => Promise<Result<UpdateResult, UpdateWorkspaceError | MintFailure>>

export function createUpdateWorkspaceCall(deps: {
  readonly workspaceClient: Pick<WorkspaceClient, 'update'>
  readonly mintToken: MintWorkspaceToken
  readonly logger: Pick<GatewayLogger, 'warn'>
  /** Test seam; defaults to `INSTALLATION_TOKEN_MINT_TIMEOUT_MS`. */
  readonly mintTimeoutMs?: number
}): UpdateWorkspaceCall {
  const {workspaceClient, mintToken, logger, mintTimeoutMs = INSTALLATION_TOKEN_MINT_TIMEOUT_MS} = deps
  return async (owner, repo, options) => {
    const token = await mintBounded(mintToken, owner, repo, mintTimeoutMs)
    if (token.success === false) {
      // One warning per mint failure, so a thrown or stalled mint is not silent: owner, repo, why, and the
      // status of a permanent failure. Never the token or the error message.
      logger.warn(
        {
          owner,
          repo,
          cause: token.error.cause,
          ...(token.error.kind === 'http-error' ? {status: token.error.status} : {}),
        },
        'run: installation token mint failed before update',
      )
      return token
    }
    return workspaceClient.update({owner, repo, token: token.data}, options)
  }
}
