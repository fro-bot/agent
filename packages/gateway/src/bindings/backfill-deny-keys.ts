/**
 * Offline/admin backfill for active-binding deny keys.
 *
 * Enumerates active bindings that lack deny keys (databaseId / nodeId) and
 * resolves each via a repo-identity query, writing the keys back to the binding.
 *
 * Security invariant: this is NOT called from any request or surface path.
 * It is an admin/maintenance entrypoint, invoked offline before the first
 * operator consumer ships. Calling it from a request handler would violate
 * the denylist-before-query invariant.
 *
 * Per-binding failures are logged and do not abort the whole backfill — a
 * binding that cannot be resolved stays keyless (fails closed at the gate).
 */

import type {Result} from '@fro-bot/runtime'

import type {BindingsStore} from './store.js'
import type {RepoBinding} from './types.js'
import {err, ok} from '@fro-bot/runtime'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackfillDeps {
  readonly bindingsStore: BindingsStore
  /**
   * Narrow repo-identity accessor — issues GET /repos/{owner}/{repo} and
   * returns {databaseId, nodeId}. Injected for testability.
   */
  readonly getRepoIdentity: (
    owner: string,
    repo: string,
  ) => Promise<Result<{databaseId: number; nodeId: string}, Error>>
  /**
   * Write the updated binding back to the store. Injected for testability.
   * In production, wire this to the store's unconditional-put or a dedicated
   * update path that overwrites the primary record.
   */
  readonly writeBinding: (binding: RepoBinding) => Promise<Result<void, Error>>
  readonly logger: {
    readonly info: (msg: string, meta?: Record<string, unknown>) => void
    readonly warn: (msg: string, meta?: Record<string, unknown>) => void
    readonly error: (msg: string, meta?: Record<string, unknown>) => void
  }
}

export interface BackfillResult {
  readonly total: number
  readonly updated: number
  readonly skipped: number
  readonly failed: number
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Backfill deny keys (databaseId + nodeId) for active bindings that lack them.
 *
 * Bindings that already have a databaseId are skipped — the primary deny key
 * is already present. Bindings missing databaseId are resolved via
 * getRepoIdentity and written back.
 *
 * Returns a summary of counts. Per-binding failures are logged and counted
 * as `failed`; they do not abort the backfill.
 *
 * Returns err() only if the initial listBindings call fails — that is a
 * whole-backfill failure, not a per-binding one.
 */
export async function backfillActiveBindingDenyKeys(deps: BackfillDeps): Promise<Result<BackfillResult, Error>> {
  const {bindingsStore, getRepoIdentity, writeBinding, logger} = deps

  // #given — list all active bindings
  const listResult = await bindingsStore.listBindings()
  if (listResult.success === false) {
    logger.error('backfill: listBindings failed; aborting', {error: listResult.error.message})
    return err(listResult.error)
  }

  const bindings = listResult.data
  let updated = 0
  let skipped = 0
  let failed = 0

  logger.info('backfill: starting deny-key backfill', {total: bindings.length})

  for (const binding of bindings) {
    const {owner, repo} = binding

    // Skip bindings that already have the primary deny key (databaseId).
    // A binding with databaseId is considered complete — nodeId is secondary.
    if (binding.databaseId !== undefined) {
      skipped++
      continue
    }

    // #when — resolve the repo's identity
    const identityResult = await getRepoIdentity(owner, repo)
    if (identityResult.success === false) {
      logger.error('backfill: repo identity resolution failed; binding stays keyless', {
        owner,
        repo,
        error: identityResult.error.message,
      })
      failed++
      continue
    }

    const {databaseId, nodeId} = identityResult.data
    const updatedBinding: RepoBinding = {...binding, databaseId, nodeId}

    // #then — write the updated binding back
    const writeResult = await writeBinding(updatedBinding)
    if (writeResult.success === false) {
      logger.error('backfill: binding update write failed; binding stays keyless', {
        owner,
        repo,
        error: writeResult.error.message,
      })
      failed++
      continue
    }

    logger.info('backfill: deny keys written', {owner, repo, databaseId})
    updated++
  }

  logger.info('backfill: deny-key backfill complete', {total: bindings.length, updated, skipped, failed})

  return ok({total: bindings.length, updated, skipped, failed})
}
