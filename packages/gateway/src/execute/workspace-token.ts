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
import {INSTALLATION_TOKEN_MINT_TIMEOUT_MS} from '../github/app-client.js'

// The ceiling lives in `github/app-client.ts`, the lowest module that needs it: `authForRepo` applies it
// as a deadline to its own requests. It is re-exported here for the callers in this package.
export {INSTALLATION_TOKEN_MINT_TIMEOUT_MS}

/**
 * Why a mint produced no token, and what kind of failure it is. `http-error` 401 is a permanent
 * installation failure, `network-error` is retryable; the kinds are what `run.ts` maps. `cause` is for
 * diagnostics only: `timeout` (the backstop below fired), `threw` (a non-Error was thrown), or an error
 * class name. It is never an error message, which can carry tokens or internal detail.
 */
export type MintFailure = ({readonly kind: 'http-error'; readonly status: 401} | {readonly kind: 'network-error'}) & {
  readonly cause: string
}

/** Mints an installation token for one repo. */
export type MintWorkspaceToken = (owner: string, repo: string) => Promise<Result<string, MintFailure>>

type MintOutcome = Awaited<ReturnType<MintWorkspaceToken>> | {readonly thrown: string} | 'timeout'

/** The class name of a thrown value, or `threw` when it is not an Error. Never its message. */
function describeThrown(thrown: unknown): string {
  return thrown instanceof Error && thrown.constructor.name !== '' ? thrown.constructor.name : 'threw'
}

/**
 * Backstop for a mint that ignores its deadline. `authForRepo` aborts its own requests at
 * `INSTALLATION_TOKEN_MINT_TIMEOUT_MS` and also releases each caller at that caller's own deadline,
 * even when it joined another caller's coalesced request, so it returns an `AuthTimeoutError` Result at
 * the bound whatever the transport does. This race is therefore redundant for `authForRepo` callers; it
 * remains so the repo lock never depends on every mint being well behaved (a test adapter, a future
 * mint that honours no signal).
 *
 * A mint that fails keeps its failure (a `401` stays permanent). A mint that does not answer in time,
 * or throws (even synchronously), is a transient `network-error`: nothing says the installation is
 * gone, and a retry may succeed. A mint that loses the race keeps running unobserved; it can neither
 * start a workspace request (callers are sequential and have already returned) nor surface an
 * unhandled rejection (its outcome is swallowed here).
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
  // The async wrapper turns a synchronous throw from a non-async `mintToken` into a rejection, so it is
  // caught here and the timer is cleared below like any other outcome.
  const minted = (async () => mintToken(owner, repo))().catch((error: unknown): MintOutcome => ({
    thrown: describeThrown(error),
  }))
  let outcome: MintOutcome
  try {
    outcome = await Promise.race([minted, timeout])
  } finally {
    clearTimeout(timer)
  }
  if (outcome === 'timeout') return err({kind: 'network-error' as const, cause: 'timeout'})
  if ('thrown' in outcome) return err({kind: 'network-error' as const, cause: outcome.thrown})
  return outcome
}
