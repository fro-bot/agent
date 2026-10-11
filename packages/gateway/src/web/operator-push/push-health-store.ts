/* eslint-disable @typescript-eslint/promise-function-async -- non-async on purpose: async wrappers add promise hops that shift the settle timing of fire-and-forget callers (see `observe`). */

/**
 * Store decorator that feeds the push health tracker from store operations that
 * already happen. This is the I/O boundary for backend observations.
 *
 * Classification:
 *   - `ok` result            → backend success for the operation's kind (read/write).
 *   - ownership-denied `err` → NOT recorded. A policy denial says nothing about
 *                              backend health.
 *   - any other `err`/throw  → backend failure for the operation's kind. Throws
 *                              are recorded and then re-thrown unchanged.
 *
 * Reads and writes are tracked separately, so a successful read cannot clear a
 * failed write (and vice versa). `selfTestCas` is passed through untouched: the
 * startup gate seeds the tracker explicitly.
 */

import type {Result} from '@fro-bot/runtime'
import type {PushHealthBackendKind, PushHealthTracker} from './push-health.js'
import type {OperatorPushSubscriptionStore, StoreError} from './subscription-store.js'

export function observePushStoreHealth(
  store: OperatorPushSubscriptionStore,
  tracker: Pick<PushHealthTracker, 'recordBackend'>,
): OperatorPushSubscriptionStore {
  // Deliberately `.then` chaining rather than async/await: it adds the minimum
  // number of promise hops, so callers that fire-and-forget a store call (e.g.
  // the session-revoke hook) observe the same settle timing as the raw store.
  function observe<T>(
    kind: PushHealthBackendKind,
    operation: () => Promise<Result<T, StoreError>>,
  ): Promise<Result<T, StoreError>> {
    return operation().then(
      result => {
        if (result.success === true) {
          tracker.recordBackend(kind, 'ok')
        } else if (result.error.code !== 'OPERATOR_PUSH_OWNERSHIP_DENIED') {
          tracker.recordBackend(kind, 'failed')
        }
        return result
      },
      (error: unknown) => {
        tracker.recordBackend(kind, 'failed')
        throw error
      },
    )
  }

  return {
    subscribe: input => observe('write', () => store.subscribe(input)),
    unsubscribe: args => observe('write', () => store.unsubscribe(args)),
    deactivateForOperator: args => observe('write', () => store.deactivateForOperator(args)),
    deleteForOperator: args => observe('write', () => store.deleteForOperator(args)),
    listMetadataForOperator: args => observe('read', () => store.listMetadataForOperator(args)),
    getActiveRecordsForOperator: args => observe('read', () => store.getActiveRecordsForOperator(args)),
    listAllActiveRecords: () => observe('read', () => store.listAllActiveRecords()),
    markDead: args => observe('write', () => store.markDead(args)),
    pruneInactive: args => observe('write', () => store.pruneInactive(args)),
    verifyStillOwned: args => observe('read', () => store.verifyStillOwned(args)),
    selfTestCas: () => store.selfTestCas(),
  }
}
