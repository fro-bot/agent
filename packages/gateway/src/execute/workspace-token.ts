/**
 * The bounded installation-token mint the gateway performs before it asks the workspace for anything
 * that needs a GitHub credential (`/update`, `/recover`).
 *
 * `appClient.authForRepo` takes no abort signal and its Octokit calls have no deadline of their own,
 * and these mints run in checkout preparation: under the repo lock, before the run's hard timer
 * exists. An unbounded mint would therefore hold the lock and a concurrency slot for as long as GitHub
 * stays silent. The mint is raced against `INSTALLATION_TOKEN_MINT_TIMEOUT_MS` instead.
 */

import type {Result} from '@fro-bot/runtime'

import {err} from '@fro-bot/runtime'
import {DEFAULT_ENSURE_CLONE_AUTH_TIMEOUT_MS} from '../workspace-api/ensure-clone.js'

/** Why a mint produced no token: `401` is a permanent installation failure, `network-error` is retryable. */
export type MintFailure = {readonly kind: 'http-error'; readonly status: 401} | {readonly kind: 'network-error'}

/** Mints an installation token for one repo. */
export type MintWorkspaceToken = (owner: string, repo: string) => Promise<Result<string, MintFailure>>

/**
 * Ceiling on one GitHub App installation-token mint (`appClient.authForRepo`). It is the bound the very
 * same call already has when a clone is ensured (`DEFAULT_ENSURE_CLONE_AUTH_TIMEOUT_MS`): one number
 * for one operation, shared by `/update`, `/recover` and the clone path.
 */
export const INSTALLATION_TOKEN_MINT_TIMEOUT_MS = DEFAULT_ENSURE_CLONE_AUTH_TIMEOUT_MS

type MintOutcome = Awaited<ReturnType<MintWorkspaceToken>> | 'timeout' | 'threw'

/**
 * Races the mint against `timeoutMs`. A mint that fails keeps its failure (a `401` stays permanent). A
 * mint that does not answer in time, or throws, is a transient `network-error`: nothing says the
 * installation is gone, and a retry may succeed. A mint that loses the race keeps running unobserved;
 * it can neither start a workspace request (callers are sequential and have already returned) nor
 * surface an unhandled rejection (its outcome is swallowed here).
 */
export async function mintBounded(
  mintToken: MintWorkspaceToken,
  owner: string,
  repo: string,
  timeoutMs: number,
): Promise<Result<string, MintFailure>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  const minted = mintToken(owner, repo).catch((): 'threw' => 'threw')
  let outcome: MintOutcome
  try {
    outcome = await Promise.race([minted, timeout])
  } finally {
    clearTimeout(timer)
  }
  return outcome === 'timeout' || outcome === 'threw' ? err({kind: 'network-error' as const}) : outcome
}
