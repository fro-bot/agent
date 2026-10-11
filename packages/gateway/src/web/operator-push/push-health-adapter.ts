/**
 * Object-store adapter wrapper that feeds the push health tracker at the I/O boundary the
 * subscription store is built over. `getObject` and `list` record a read; `conditionalPut`
 * and `conditionalDelete` record a write.
 *
 * A call is `ok` when it completed: it succeeded, or the backend answered about the key
 * (`NoSuchKey`/`NotFound`, `PreconditionFailed` 412, `ConditionalRequestConflict` 409; by status
 * 404/412/409 when there is no code). Anything else, including a throw, is `failed`.
 * Policy denials and no-op store results never reach the adapter, so they record nothing.
 * Methods the adapter does not define stay undefined, so the store's capability checks hold.
 */

import type {ObjectStoreAdapter, Result} from '@fro-bot/runtime'
import type {PushHealthBackendKind, PushHealthTracker} from './push-health.js'

const ANSWER_CODES: ReadonlySet<string> = new Set([
  'NoSuchKey',
  'NotFound',
  'PreconditionFailed',
  'ConditionalRequestConflict',
])
const ANSWER_STATUSES: ReadonlySet<number> = new Set([404, 409, 412])

/**
 * The backend answered about the key: a missing key, a CAS conflict (412) or write contention (409).
 * The structured code wins over the status (a 404 `NoSuchBucket` is a fault); the status is used only
 * when there is no code. Message text is never consulted.
 */
function isBackendAnswer(error: Error): boolean {
  const {httpStatusCode, errorCode, errorName} = error as Error & {
    readonly httpStatusCode?: number
    readonly errorCode?: string
    readonly errorName?: string
  }
  const code = errorCode ?? errorName
  if (code !== undefined) {
    return ANSWER_CODES.has(code)
  }
  return typeof httpStatusCode === 'number' && ANSWER_STATUSES.has(httpStatusCode)
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
