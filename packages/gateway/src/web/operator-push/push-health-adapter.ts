/**
 * Object-store adapter wrapper that feeds the push health tracker at the I/O
 * boundary the subscription store is built over. `getObject` and `list` record
 * a read; `conditionalPut` and `conditionalDelete` record a write.
 *
 * A call counts as `ok` when it completed — it succeeded, or the backend answered
 * with HTTP 404 or 412 (a CAS conflict or a missing key); anything else, including
 * a throw, counts as `failed`. Policy denials and no-op store results never reach
 * the adapter, so they record nothing. Methods the adapter does not define stay
 * undefined, so the store's capability checks are unchanged.
 */

import type {ObjectStoreAdapter, Result} from '@fro-bot/runtime'
import type {PushHealthBackendKind, PushHealthTracker} from './push-health.js'

/** The backend answered (HTTP 404/412, structured fields only — never message text). */
function isBackendAnswer(error: Error): boolean {
  const {httpStatusCode, errorCode, errorName} = error as Error & {
    readonly httpStatusCode?: number
    readonly errorCode?: string
    readonly errorName?: string
  }
  if (typeof httpStatusCode === 'number' && Number.isFinite(httpStatusCode)) {
    return httpStatusCode === 404 || httpStatusCode === 412
  }
  const code = errorCode ?? errorName
  return code === 'NoSuchKey' || code === 'NotFound' || code === 'PreconditionFailed'
}

export function observePushAdapterHealth(
  adapter: ObjectStoreAdapter,
  tracker: Pick<PushHealthTracker, 'nextSequence' | 'recordBackend'>,
): ObjectStoreAdapter {
  async function observe<T>(
    kind: PushHealthBackendKind,
    call: () => Promise<Result<T, Error>>,
  ): Promise<Result<T, Error>> {
    const startSequence = tracker.nextSequence()
    let result: Result<T, Error>
    try {
      result = await call()
    } catch (error: unknown) {
      tracker.recordBackend(kind, 'failed', startSequence)
      throw error
    }
    const completed = result.success === true || isBackendAnswer(result.error)
    tracker.recordBackend(kind, completed === true ? 'ok' : 'failed', startSequence)
    return result
  }

  const {getObject, conditionalPut, conditionalDelete} = adapter
  return {
    ...adapter,
    list: async prefix => observe('read', async () => adapter.list(prefix)),
    ...(getObject === undefined ? {} : {getObject: async key => observe('read', async () => getObject(key))}),
    ...(conditionalPut === undefined
      ? {}
      : {
          conditionalPut: async (key, data, options) =>
            observe('write', async () => conditionalPut(key, data, options)),
        }),
    ...(conditionalDelete === undefined
      ? {}
      : {conditionalDelete: async (key, options) => observe('write', async () => conditionalDelete(key, options))}),
  }
}
