/**
 * Shared in-memory object-store fake for tests that need S3-style ETag/CAS semantics.
 *
 * - `conditionalPut` honors `ifNoneMatch: '*'` and `ifMatch`; `ifMatch` on a missing key is 404 (S3 behavior).
 * - `conditionalDelete` honors `ifMatch`; a missing key is 404.
 * - Errors are structured `ObjectStoreOperationError`s (`httpStatusCode` 412/404/503) like the S3 adapter's.
 * - Failure injection, latency and a before-operation hook let tests drive races, outages and timeouts.
 * - `omit` removes adapter methods to model a non-CAS adapter.
 */

import type {ObjectStoreAdapter, Result} from '@fro-bot/runtime'

import {createObjectStoreOperationError, err, ok} from '@fro-bot/runtime'

export type TestObjectStoreMethod = 'list' | 'getObject' | 'conditionalPut' | 'conditionalDelete'

export interface StoredObject {
  readonly data: string
  readonly etag: string
}

export interface TestObjectStoreCall {
  readonly method: TestObjectStoreMethod
  readonly key: string
}

export interface FailNextOptions {
  /** Error returned as the operation's failure. Defaults to a 503. */
  readonly error?: Error
  /** How many matching calls fail. Defaults to 1. */
  readonly times?: number
  /** Restricts the failure to matching keys (the prefix, for `list`). */
  readonly match?: (key: string) => boolean
}

export interface TestObjectStoreOptions {
  /** Adapter methods to leave off the adapter object. */
  readonly omit?: readonly TestObjectStoreMethod[]
}

export interface TestObjectStore {
  readonly adapter: ObjectStoreAdapter
  /** Live backing map. Tests may read it; writes go through `seed` so etags stay unique. */
  readonly objects: ReadonlyMap<string, StoredObject>
  /** Every adapter call in order. */
  readonly calls: readonly TestObjectStoreCall[]
  /** Writes an object directly, bypassing preconditions, and returns its new etag. */
  readonly seed: (key: string, data: string) => string
  /** Removes an object directly, bypassing preconditions. */
  readonly remove: (key: string) => void
  /** Makes the next matching calls to `method` fail. */
  readonly failNext: (method: TestObjectStoreMethod, options?: FailNextOptions) => void
  /** Delays every call to `method` by `ms` before it executes. */
  readonly setLatency: (method: TestObjectStoreMethod, ms: number) => void
  /** Runs `hook` after the latency and before the operation executes. Pass `undefined` to clear it. */
  readonly onBefore: (method: TestObjectStoreMethod, hook: ((key: string) => Promise<void> | void) | undefined) => void
  /** Highest number of simultaneous in-flight calls seen for `method`. */
  readonly peakInFlight: (method: TestObjectStoreMethod) => number
  /** Number of calls made to `method`. */
  readonly callCount: (method: TestObjectStoreMethod) => number
  /** Clears the call log and the in-flight peaks. */
  readonly resetCalls: () => void
}

export function createPreconditionFailedError(): Error {
  return createObjectStoreOperationError('PreconditionFailed: condition not met', {
    errorCode: 'PreconditionFailed',
    httpStatusCode: 412,
  })
}

export function createNotFoundError(): Error {
  return createObjectStoreOperationError('NoSuchKey: key does not exist', {
    errorCode: 'NoSuchKey',
    httpStatusCode: 404,
  })
}

export function createUnavailableError(): Error {
  return createObjectStoreOperationError('ServiceUnavailable: injected failure', {
    errorCode: 'ServiceUnavailable',
    httpStatusCode: 503,
  })
}

interface FailureRule {
  readonly method: TestObjectStoreMethod
  readonly error: Error
  readonly match: ((key: string) => boolean) | undefined
  remaining: number
}

export function createTestObjectStore(options: TestObjectStoreOptions = {}): TestObjectStore {
  const objects = new Map<string, StoredObject>()
  const calls: TestObjectStoreCall[] = []
  const rules: FailureRule[] = []
  const latency = new Map<TestObjectStoreMethod, number>()
  const hooks = new Map<TestObjectStoreMethod, (key: string) => Promise<void> | void>()
  const inFlight = new Map<TestObjectStoreMethod, number>()
  const peak = new Map<TestObjectStoreMethod, number>()
  let etagCounter = 0

  function nextEtag(): string {
    etagCounter += 1
    return `etag-${etagCounter}`
  }

  function takeFailure(method: TestObjectStoreMethod, key: string): Error | undefined {
    const rule = rules.find(r => r.method === method && r.remaining > 0 && (r.match?.(key) ?? true))
    if (rule === undefined) {
      return undefined
    }
    rule.remaining -= 1
    return rule.error
  }

  async function run<T>(
    method: TestObjectStoreMethod,
    key: string,
    operation: () => Result<T, Error>,
  ): Promise<Result<T, Error>> {
    calls.push({method, key})
    const current = (inFlight.get(method) ?? 0) + 1
    inFlight.set(method, current)
    peak.set(method, Math.max(peak.get(method) ?? 0, current))
    try {
      const delay = latency.get(method)
      if (delay !== undefined && delay > 0) {
        await new Promise<void>(resolve => {
          setTimeout(resolve, delay)
        })
      }
      await hooks.get(method)?.(key)
      const injected = takeFailure(method, key)
      if (injected !== undefined) {
        return err(injected)
      }
      return operation()
    } finally {
      inFlight.set(method, (inFlight.get(method) ?? 1) - 1)
    }
  }

  const adapter: ObjectStoreAdapter = {
    upload: async () => ok(undefined),
    download: async () => ok(undefined),
    list: async prefix =>
      run('list', prefix, () =>
        ok(
          Array.from(objects.keys())
            .filter(key => key.startsWith(prefix))
            .sort(),
        ),
      ),
    getObject: async key =>
      run('getObject', key, () => {
        const current = objects.get(key)
        return current === undefined ? err(createNotFoundError()) : ok({data: current.data, etag: current.etag})
      }),
    conditionalPut: async (key, data, putOptions) =>
      run('conditionalPut', key, () => {
        const current = objects.get(key)
        if (putOptions.ifNoneMatch === '*' && current !== undefined) {
          return err(createPreconditionFailedError())
        }
        if (putOptions.ifMatch !== undefined) {
          if (current === undefined) {
            return err(createNotFoundError())
          }
          if (current.etag !== putOptions.ifMatch) {
            return err(createPreconditionFailedError())
          }
        }
        const etag = nextEtag()
        objects.set(key, {data, etag})
        return ok({etag})
      }),
    conditionalDelete: async (key, deleteOptions) =>
      run('conditionalDelete', key, () => {
        const current = objects.get(key)
        if (current === undefined) {
          return err(createNotFoundError())
        }
        if (current.etag !== deleteOptions.ifMatch) {
          return err(createPreconditionFailedError())
        }
        objects.delete(key)
        return ok(undefined)
      }),
  }

  for (const method of options.omit ?? []) {
    Reflect.deleteProperty(adapter, method)
  }

  return {
    adapter,
    objects,
    calls,
    seed: (key, data) => {
      const etag = nextEtag()
      objects.set(key, {data, etag})
      return etag
    },
    remove: key => {
      objects.delete(key)
    },
    failNext: (method, failOptions = {}) => {
      rules.push({
        method,
        error: failOptions.error ?? createUnavailableError(),
        match: failOptions.match,
        remaining: failOptions.times ?? 1,
      })
    },
    setLatency: (method, ms) => {
      latency.set(method, ms)
    },
    onBefore: (method, hook) => {
      if (hook === undefined) {
        hooks.delete(method)
        return
      }
      hooks.set(method, hook)
    },
    peakInFlight: method => peak.get(method) ?? 0,
    callCount: method => calls.filter(call => call.method === method).length,
    resetCalls: () => {
      calls.length = 0
      peak.clear()
    },
  }
}
