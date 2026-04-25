import type {ObjectStoreAdapter, ObjectStoreConfig} from '../object-store/types.js'
import type {Logger} from '../shared/logger.js'
import type {CoordinationConfig} from './types.js'

import {describe, expect, it, vi} from 'vitest'

import {err, ok} from '../shared/types.js'
import {validateProviderSemantics} from './self-test.js'

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

describe('provider semantics self-test', () => {
  it('uses the configured prefix for probe keys', async () => {
    // #given
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(ok({etag: 'etag-1'}))
      .mockResolvedValueOnce(err(new Error('precondition failed')))
      .mockResolvedValueOnce(err(new Error('precondition failed')))
    const conditionalDelete = vi.fn<Required<ObjectStoreAdapter>['conditionalDelete']>(async () => ok(undefined))
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
      'custom-prefix/_probe/ifnonematch-test',
      JSON.stringify({probe: 1}),
      {ifNoneMatch: '*'},
    )
    expect(conditionalDelete).toHaveBeenCalledWith('custom-prefix/_probe/ifnonematch-test', {ifMatch: 'etag-1'})
  })

  it('passes when the provider rejects both if-none-match and stale if-match writes', async () => {
    // #given
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(ok({etag: 'etag-1'}))
      .mockResolvedValueOnce(err(new Error('precondition failed')))
      .mockResolvedValueOnce(err(new Error('precondition failed')))
    const conditionalDelete = vi.fn<Required<ObjectStoreAdapter>['conditionalDelete']>(async () => ok(undefined))
    const config = createCoordinationConfig(createStoreAdapter({conditionalPut, conditionalDelete}))

    // #when
    const result = await validateProviderSemantics(config, createLogger())

    // #then
    expect(result).toEqual(ok(undefined))
    expect(conditionalPut).toHaveBeenCalledTimes(3)
    expect(conditionalDelete).toHaveBeenCalledWith('fro-bot-state/_probe/ifnonematch-test', {ifMatch: 'etag-1'})
  })

  it('fails when the provider incorrectly allows the second if-none-match write', async () => {
    // #given
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(ok({etag: 'etag-1'}))
      .mockResolvedValueOnce(ok({etag: 'etag-2'}))
      .mockResolvedValueOnce(err(new Error('precondition failed')))
    const conditionalDelete = vi.fn<Required<ObjectStoreAdapter>['conditionalDelete']>(async () => ok(undefined))
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
    const conditionalDelete = vi.fn<Required<ObjectStoreAdapter>['conditionalDelete']>(async () => ok(undefined))
    const config = createCoordinationConfig(createStoreAdapter({conditionalPut, conditionalDelete}))

    // #when
    const result = await validateProviderSemantics(config, createLogger())

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message : '').toContain('ifMatch')
  })

  it('cleans up the probe object even when the provider allows the second write', async () => {
    // #given
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(ok({etag: 'etag-1'}))
      .mockResolvedValueOnce(ok({etag: 'etag-2'}))
      .mockResolvedValueOnce(err(new Error('precondition failed')))
    const conditionalDelete = vi.fn<Required<ObjectStoreAdapter>['conditionalDelete']>(async () => ok(undefined))
    const config = createCoordinationConfig(createStoreAdapter({conditionalPut, conditionalDelete}))

    // #when
    await validateProviderSemantics(config, createLogger())

    // #then
    expect(conditionalDelete).toHaveBeenCalledWith('fro-bot-state/_probe/ifnonematch-test', {ifMatch: 'etag-2'})
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
      .mockResolvedValueOnce(err(new Error('cleanup failed')))
    const config = createCoordinationConfig(createStoreAdapter({conditionalPut, conditionalDelete}))

    // #when
    const result = await validateProviderSemantics(config, createLogger())

    // #then — semantics error takes priority over cleanup error
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message : '').toContain('ifNoneMatch')
    expect(result.success === false ? result.error.message : '').not.toContain('cleanup')
  })
})
