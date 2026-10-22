import type {ObjectStoreAdapter, ObjectStoreConfig} from '../object-store/types.js'
import type {CoordinationConfig, LockRecord} from './types.js'

import {describe, expect, it, vi} from 'vitest'

import {err, ok} from '../shared/types.js'
import {createLockAdopter} from './lock-adoption.js'
import {readLock} from './lock.js'

const REPO_KEY = 'fro-bot-state/coordination/owner/repo/locks/repo.json'
const ACTION_KEY = 'fro-bot-state/coordination/owner/repo/locks/action.json'

function record(overrides: Partial<LockRecord> = {}): LockRecord {
  return {
    repo: 'owner/repo',
    holder_id: 'gateway-1',
    surface: 'discord',
    acquired_at: '2026-04-24T18:14:30.000Z',
    ttl_seconds: 900,
    run_id: 'run-1',
    acquisition_token: 'token-0001-abcd',
    ...overrides,
  }
}

function configFor(objects: Record<string, {data: string; etag: string} | Error>) {
  const getObject = vi.fn<Required<ObjectStoreAdapter>['getObject']>(async key => {
    const found = objects[key]
    if (found === undefined) return err(new Error('NoSuchKey'))
    return found instanceof Error ? err(found) : ok(found)
  })
  const storeConfig: ObjectStoreConfig = {enabled: true, bucket: 'b', region: 'us-east-1', prefix: 'fro-bot-state'}
  const config: CoordinationConfig = {
    storeAdapter: {
      upload: vi.fn(),
      download: vi.fn(),
      list: vi.fn(),
      getObject,
    },
    storeConfig,
    lockTtlSeconds: 900,
    heartbeatIntervalMs: 30_000,
    staleThresholdMs: 60_000,
    pendingStaleThresholdMs: 30 * 60_000,
  }
  return {config, getObject}
}

describe('readLock', () => {
  it('returns the record and its ETag, reading the requested scope', async () => {
    // #given an Action lock and a gateway lock
    const {config, getObject} = configFor({
      [REPO_KEY]: {data: JSON.stringify(record()), etag: 'etag-repo'},
      [ACTION_KEY]: {data: JSON.stringify(record({holder_id: 'action:1:1', surface: 'github'})), etag: 'etag-action'},
    })

    // #when
    const gateway = await readLock(config, 'owner/repo')
    const action = await readLock(config, 'owner/repo', 'action')

    // #then
    expect(gateway.success && gateway.data?.etag).toBe('etag-repo')
    expect(action.success && action.data?.record.holder_id).toBe('action:1:1')
    expect(getObject.mock.calls.map(call => call[0])).toEqual([REPO_KEY, ACTION_KEY])
  })

  it('returns ok(null) when the lock does not exist', async () => {
    // #given
    const {config} = configFor({})

    // #when / #then
    expect(await readLock(config, 'owner/repo')).toEqual(ok(null))
  })

  it('returns the error for any other read failure', async () => {
    // #given
    const {config} = configFor({[REPO_KEY]: Object.assign(new Error('503 slow down'), {httpStatusCode: 503})})

    // #when
    const result = await readLock(config, 'owner/repo')

    // #then
    expect(result.success).toBe(false)
  })

  it('forwards the signal only when one is given', async () => {
    // #given
    const {config, getObject} = configFor({[REPO_KEY]: {data: JSON.stringify(record()), etag: 'e'}})
    const controller = new AbortController()

    // #when
    await readLock(config, 'owner/repo', 'repo', controller.signal)
    await readLock(config, 'owner/repo')

    // #then the second call keeps its original single-argument shape
    expect(getObject.mock.calls[0]?.[1]).toEqual({signal: controller.signal})
    expect(getObject.mock.calls[1]).toHaveLength(1)
  })

  it('drops a malformed acquisition token instead of rejecting the record', async () => {
    // #given
    const {config} = configFor({[REPO_KEY]: {data: JSON.stringify(record({acquisition_token: 'x'})), etag: 'e'}})

    // #when
    const result = await readLock(config, 'owner/repo')

    // #then
    expect(result.success && result.data?.record.acquisition_token).toBeUndefined()
  })
})

describe('createLockAdopter', () => {
  const logger = () => ({debug: vi.fn<(message: string, context?: Record<string, unknown>) => void>()})

  it('resolves with the stored ETag when ownership accepts the record', async () => {
    // #given
    const {config} = configFor({[REPO_KEY]: {data: JSON.stringify(record()), etag: 'etag-stored'}})
    const adopt = createLockAdopter({config, repo: 'owner/repo', owns: () => ({owned: true}), logger: logger()})

    // #when / #then
    expect(await adopt()).toEqual({etag: 'etag-stored'})
  })

  it('resolves null and logs the reason at debug when ownership rejects the record', async () => {
    // #given
    const {config} = configFor({[REPO_KEY]: {data: JSON.stringify(record()), etag: 'etag-stored'}})
    const log = logger()
    const adopt = createLockAdopter({
      config,
      repo: 'owner/repo',
      owns: () => ({owned: false, reason: 'no-token'}),
      logger: log,
      logContext: {runId: 'run-1'},
    })

    // #when
    const adopted = await adopt()

    // #then
    expect(adopted).toBeNull()
    expect(log.debug).toHaveBeenCalledWith('Lock record not adopted', {
      runId: 'run-1',
      reason: 'no-token',
      storedHolderId: 'gateway-1',
      storedRunId: 'run-1',
    })
  })

  it('passes the stored record to ownership', async () => {
    // #given
    const stored = record({run_id: 'run-9'})
    const {config} = configFor({[REPO_KEY]: {data: JSON.stringify(stored), etag: 'e'}})
    const owns = vi.fn(() => ({owned: true as const}))

    // #when
    await createLockAdopter({config, repo: 'owner/repo', owns, logger: logger()})()

    // #then
    expect(owns).toHaveBeenCalledWith(stored)
  })

  it('resolves null when the lock is absent or unreadable, without calling ownership', async () => {
    // #given
    const owns = vi.fn(() => ({owned: true as const}))
    const absent = configFor({})
    const broken = configFor({[REPO_KEY]: Object.assign(new Error('503'), {httpStatusCode: 503})})

    // #when / #then
    expect(await createLockAdopter({config: absent.config, repo: 'owner/repo', owns, logger: logger()})()).toBeNull()
    expect(await createLockAdopter({config: broken.config, repo: 'owner/repo', owns, logger: logger()})()).toBeNull()
    expect(owns).not.toHaveBeenCalled()
  })

  it('reads the configured scope and hands the signal to the read', async () => {
    // #given
    const {config, getObject} = configFor({[ACTION_KEY]: {data: JSON.stringify(record()), etag: 'etag-action'}})
    const controller = new AbortController()
    const adopt = createLockAdopter({
      config,
      repo: 'owner/repo',
      scope: 'action',
      owns: () => ({owned: true}),
      logger: logger(),
    })

    // #when
    const adopted = await adopt(controller.signal)

    // #then
    expect(adopted).toEqual({etag: 'etag-action'})
    expect(getObject).toHaveBeenCalledWith(ACTION_KEY, {signal: controller.signal})
  })
})
