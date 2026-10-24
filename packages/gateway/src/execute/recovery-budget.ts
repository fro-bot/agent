/**
 * The wall-clock budget one automatic dirty-checkout recovery needs (`checkout-recovery.ts`), kept in
 * its own dependency-light module so `config.ts` can check the run timeout against it at startup
 * without importing the OpenCode attach stack that `repo-quiescence.ts` pulls in.
 */

import {INSTALLATION_TOKEN_MINT_TIMEOUT_MS} from '../github/app-client.js'
import {totalRecoveryCeilingMs} from '../workspace-api/client.js'

/** Ceiling on the OpenCode `session.status` request one repo-quiescence check makes. */
export const REPO_QUIESCENCE_TIMEOUT_MS = 4_000

/**
 * Worst-case wall-clock cost of one whole automatic-recovery attempt: the quiescence check, TWO token
 * mints (one for `/recover`, one for the follow-up `update`, which mints its own), then every workspace
 * call (`totalRecoveryCeilingMs`: preview, recover with its dispose, the backup lookup, the follow-up
 * `update`), each at the ceiling the client is configured with (else the defaults). A run with less
 * budget left than this must not start one it could not finish.
 */
export function totalRecoveryBudgetMs(options: Parameters<typeof totalRecoveryCeilingMs>[0] = {}): number {
  return REPO_QUIESCENCE_TIMEOUT_MS + 2 * INSTALLATION_TOKEN_MINT_TIMEOUT_MS + totalRecoveryCeilingMs(options)
}
