/**
 * The wall-clock budget one automatic dirty-checkout recovery needs (`checkout-recovery.ts`), kept in
 * its own dependency-light module so `config.ts` can check the run timeout against it at startup
 * without importing the OpenCode attach stack that `repo-quiescence.ts` pulls in.
 */

import {totalRecoveryCeilingMs} from '../workspace-api/client.js'
import {DEFAULT_ENSURE_CLONE_AUTH_TIMEOUT_MS} from '../workspace-api/ensure-clone.js'

/** Ceiling on the OpenCode `session.status` request one repo-quiescence check makes. */
export const REPO_QUIESCENCE_TIMEOUT_MS = 4_000

/**
 * Ceiling on the GitHub App installation-token mint (`appClient.authForRepo`) that `recover` performs
 * before it sends anything to the workspace. `authForRepo` takes no abort signal and its Octokit calls
 * have no deadline of their own, so the mint is raced against this. It is the bound the very same call
 * already has when a clone is ensured (`DEFAULT_ENSURE_CLONE_AUTH_TIMEOUT_MS`): one number for one
 * operation. A mint that does not answer in time declines the recovery without sending `/recover`.
 */
export const RECOVERY_TOKEN_MINT_TIMEOUT_MS = DEFAULT_ENSURE_CLONE_AUTH_TIMEOUT_MS

/**
 * Worst-case wall-clock cost of one whole automatic-recovery attempt: the quiescence check, the token
 * mint, then every workspace call (`totalRecoveryCeilingMs`: preview, recover with its dispose, the
 * backup lookup, the follow-up `update`), each at the ceiling the client is configured with (else the
 * defaults). A run with less budget left than this must not start one it could not finish.
 */
export function totalRecoveryBudgetMs(options: Parameters<typeof totalRecoveryCeilingMs>[0] = {}): number {
  return REPO_QUIESCENCE_TIMEOUT_MS + RECOVERY_TOKEN_MINT_TIMEOUT_MS + totalRecoveryCeilingMs(options)
}
