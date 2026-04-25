import type {ObjectStoreAdapter, ObjectStoreConfig} from '../object-store/types.js'
import type {Logger} from '../shared/logger.js'
import type {CoordinationConfig} from './types.js'

import {describe, expect, it, vi} from 'vitest'

import {err, ok} from '../shared/types.js'
import {validateProviderSemantics} from './self-test.js'

const PROBE_KEY = 'fro-bot-state/self-test/_probe/locks/semantics.json'
const STALE_ETAG = '"0000000000000000000000000000dead"'

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

function createStoreConfig(): ObjectStoreConfig {
  return {
    enabled: true,
    bucket: 'test-bucket',
    region: 'us-east-1',
    prefix: 'fro-bot-state',
  }
}

function createStoreAdapter(overrides: Partial<Required<ObjectStoreAdapter>> = {}): Required<ObjectStoreAdapter> {
  return {
    upload: vi.fn(async () => ok(undefined)),
    download: vi.fn(async () => ok(undefined)),
    list: vi.fn(async () => ok([])),
    conditionalPut: vi.fn(async () => ok({etag: 'etag-1'})),
    conditionalDelete: vi.fn(async () => ok(undefined)),
    getObject: vi.fn(async () => ok({data: '{}', etag: 'etag-1'})),
    ...overrides,
  }
}

function createCoordinationConfig(storeAdapter: Required<ObjectStoreAdapter>): CoordinationConfig {
  return {
    storeAdapter,
    storeConfig: createStoreConfig(),
    lockTtlSeconds: 900,
    heartbeatIntervalMs: 30_000,
    staleThresholdMs: 60_000,
  }
}

/**
 * Build a `conditionalPut` mock that simulates a fully-compliant provider.
 *
 * Order matches the self-test sequence:
 *   1. PUT ifNoneMatch:* on empty key → succeeds
 *   2. PUT ifNoneMatch:* on existing key → fails (precondition)
 *   3. PUT ifMatch:STALE → fails (precondition)
 */
function compliantConditionalPut() {
  return vi
    .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
    .mockResolvedValueOnce(ok({etag: 'etag-1'}))
    .mockResolvedValueOnce(err(new Error('precondition failed')))
    .mockResolvedValueOnce(err(new Error('precondition failed')))
}

/**
 * Build a `conditionalDelete` mock that simulates a fully-compliant provider.
 *
 * Order matches the self-test sequence:
 *   1. DELETE ifMatch:STALE → fails (precondition)
 *   2. DELETE ifMatch:correctEtag → succeeds (cleanup)
 */
function compliantConditionalDelete() {
  return vi
    .fn<Required<ObjectStoreAdapter>['conditionalDelete']>()
    .mockResolvedValueOnce(err(new Error('precondition failed')))
    .mockResolvedValueOnce(ok(undefined))
}

describe('provider semantics self-test', () => {
  it('uses the configured prefix for probe keys', async () => {
    // #given
    const conditionalPut = compliantConditionalPut()
    const conditionalDelete = compliantConditionalDelete()
    const storeConfig: ObjectStoreConfig = {...createStoreConfig(), prefix: 'custom-prefix'}
    const config: CoordinationConfig = {
      storeAdapter: createStoreAdapter({conditionalPut, conditionalDelete}),
      storeConfig,
      lockTtlSeconds: 900,
      heartbeatIntervalMs: 30_000,
      staleThresholdMs: 60_000,
    }

    // #when
    const result = await validateProviderSemantics(config, createLogger())

    // #then
    expect(result).toEqual(ok(undefined))
    expect(conditionalPut).toHaveBeenNthCalledWith(
      1,
      'custom-prefix/self-test/_probe/locks/semantics.json',
      JSON.stringify({probe: 1}),
      {ifNoneMatch: '*'},
    )
    expect(conditionalDelete).toHaveBeenNthCalledWith(2, 'custom-prefix/self-test/_probe/locks/semantics.json', {
      ifMatch: 'etag-1',
    })
  })

  it('passes when the provider rejects ifNoneMatch, stale ifMatch PUT, and stale ifMatch DELETE', async () => {
    // #given
    const conditionalPut = compliantConditionalPut()
    const conditionalDelete = compliantConditionalDelete()
    const config = createCoordinationConfig(createStoreAdapter({conditionalPut, conditionalDelete}))

    // #when
    const result = await validateProviderSemantics(config, createLogger())

    // #then
    expect(result).toEqual(ok(undefined))
    expect(conditionalPut).toHaveBeenCalledTimes(3)
    expect(conditionalDelete).toHaveBeenCalledTimes(2)
    expect(conditionalDelete).toHaveBeenNthCalledWith(1, PROBE_KEY, {ifMatch: STALE_ETAG})
    expect(conditionalDelete).toHaveBeenNthCalledWith(2, PROBE_KEY, {ifMatch: 'etag-1'})
  })

  it('fails when the provider incorrectly allows the second if-none-match write', async () => {
    // #given
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(ok({etag: 'etag-1'}))
      .mockResolvedValueOnce(ok({etag: 'etag-2'}))
      .mockResolvedValueOnce(err(new Error('precondition failed')))
    const conditionalDelete = compliantConditionalDelete()
    const config = createCoordinationConfig(createStoreAdapter({conditionalPut, conditionalDelete}))

    // #when
    const result = await validateProviderSemantics(config, createLogger())

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message : '').toContain('ifNoneMatch')
  })

  it('fails when the provider incorrectly allows a write with a stale if-match etag', async () => {
    // #given — ifNoneMatch passes but ifMatch with fabricated stale etag also succeeds (broken)
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(ok({etag: 'etag-1'}))
      .mockResolvedValueOnce(err(new Error('precondition failed')))
      .mockResolvedValueOnce(ok({etag: 'etag-stale-accepted'}))
    const conditionalDelete = compliantConditionalDelete()
    const config = createCoordinationConfig(createStoreAdapter({conditionalPut, conditionalDelete}))

    // #when
    const result = await validateProviderSemantics(config, createLogger())

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message : '').toContain('ifMatch on PUT')
  })

  it('fails when the provider incorrectly allows a delete with a stale if-match etag', async () => {
    // #given — ifNoneMatch and ifMatch PUT both correctly reject, but stale-ifMatch DELETE wrongly succeeds.
    // This is the historical R2 behavior the self-test must catch.
    const conditionalPut = compliantConditionalPut()
    const conditionalDelete = vi
      .fn<Required<ObjectStoreAdapter>['conditionalDelete']>()
      .mockResolvedValueOnce(ok(undefined))
      .mockResolvedValueOnce(err(new Error('precondition failed')))
    const config = createCoordinationConfig(createStoreAdapter({conditionalPut, conditionalDelete}))

    // #when
    const result = await validateProviderSemantics(config, createLogger())

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message : '').toContain('ifMatch on DELETE')
  })

  it('cleans up the probe object even when the provider allows the second if-none-match write', async () => {
    // #given
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(ok({etag: 'etag-1'}))
      .mockResolvedValueOnce(ok({etag: 'etag-2'}))
      .mockResolvedValueOnce(err(new Error('precondition failed')))
    const conditionalDelete = compliantConditionalDelete()
    const config = createCoordinationConfig(createStoreAdapter({conditionalPut, conditionalDelete}))

    // #when
    await validateProviderSemantics(config, createLogger())

    // #then — cleanup uses the most recent successful etag (etag-2 from the wrongly-allowed second write)
    expect(conditionalDelete).toHaveBeenNthCalledWith(2, PROBE_KEY, {ifMatch: 'etag-2'})
  })

  it('returns semantics error even when cleanup also fails', async () => {
    // #given — provider fails ifNoneMatch AND cleanup fails
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(ok({etag: 'etag-1'}))
      .mockResolvedValueOnce(ok({etag: 'etag-2'}))
      .mockResolvedValueOnce(err(new Error('precondition failed')))
    const conditionalDelete = vi
      .fn<Required<ObjectStoreAdapter>['conditionalDelete']>()
      .mockResolvedValueOnce(err(new Error('precondition failed')))
      .mockResolvedValueOnce(err(new Error('cleanup failed')))
    const config = createCoordinationConfig(createStoreAdapter({conditionalPut, conditionalDelete}))

    // #when
    const result = await validateProviderSemantics(config, createLogger())

    // #then — semantics error takes priority over cleanup error
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message : '').toContain('ifNoneMatch')
    expect(result.success === false ? result.error.message : '').not.toContain('cleanup')
  })

  it('returns the underlying validation error when the prefix is empty', async () => {
    // #given
    const storeConfig: ObjectStoreConfig = {...createStoreConfig(), prefix: ''}
    const config: CoordinationConfig = {
      storeAdapter: createStoreAdapter(),
      storeConfig,
      lockTtlSeconds: 900,
      heartbeatIntervalMs: 30_000,
      staleThresholdMs: 60_000,
    }

    // #when
    const result = await validateProviderSemantics(config, createLogger())

    // #then — buildObjectStoreKey rejects empty prefix; conditional ops are never reached.
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message.toLowerCase() : '').toContain('prefix')
    expect(config.storeAdapter.conditionalPut).not.toHaveBeenCalled()
    expect(config.storeAdapter.conditionalDelete).not.toHaveBeenCalled()
  })

  it('returns an error when the adapter is missing conditionalPut', async () => {
    // #given
    const storeAdapter: ObjectStoreAdapter = {
      upload: async () => ok(undefined),
      download: async () => ok(undefined),
      list: async () => ok([]),
      conditionalDelete: async () => ok(undefined),
      getObject: async () => ok({data: '{}', etag: 'etag-1'}),
    }
    const config = createCoordinationConfig(storeAdapter as Required<ObjectStoreAdapter>)

    // #when
    const result = await validateProviderSemantics(config, createLogger())

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message : '').toBe(
      'Object store adapter does not support conditionalPut',
    )
  })

  it('returns an error when the adapter is missing conditionalDelete', async () => {
    // #given
    const storeAdapter: ObjectStoreAdapter = {
      upload: async () => ok(undefined),
      download: async () => ok(undefined),
      list: async () => ok([]),
      conditionalPut: async () => ok({etag: 'etag-1'}),
      getObject: async () => ok({data: '{}', etag: 'etag-1'}),
    }
    const config = createCoordinationConfig(storeAdapter as Required<ObjectStoreAdapter>)

    // #when
    const result = await validateProviderSemantics(config, createLogger())

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message : '').toBe(
      'Object store adapter does not support conditionalDelete',
    )
  })
})
