import type {ObjectStoreAdapter, ObjectStoreConfig} from '@fro-bot/runtime'

import {err, ok} from '@fro-bot/runtime'
import {describe, expect, it, vi} from 'vitest'

import {createBindingsStore} from './store.js'
import {hasValidChannelIndexShape, hasValidRepoBindingShape, type PartialWriteError, type RepoBinding} from './types.js'

const STORE_CONFIG: ObjectStoreConfig = {
  enabled: true,
  bucket: 'test-bucket',
  region: 'us-east-1',
  prefix: 'fro-bot-state',
}

const IDENTITY = 'gateway'

function makeBinding(overrides: Partial<RepoBinding> = {}): RepoBinding {
  return {
    owner: 'foo',
    repo: 'bar',
    channelId: '123',
    channelName: 'foo-bar',
    workspacePath: '/workspace/repos/foo/bar',
    createdAt: '2026-05-23T00:00:00.000Z',
    createdByDiscordId: 'user-1',
    ...overrides,
  }
}

function makeAdapter(overrides: Partial<Required<ObjectStoreAdapter>> = {}): Required<ObjectStoreAdapter> {
  return {
    upload: vi.fn(async () => ok(undefined)),
    download: vi.fn(async () => ok(undefined)),
    list: vi.fn(async () => ok([])),
    conditionalPut: vi.fn(async () => ok({etag: 'etag-primary'})),
    conditionalDelete: vi.fn(async () => ok(undefined)),
    getObject: vi.fn(async () => ok({data: JSON.stringify(makeBinding()), etag: 'etag-primary'})),
    ...overrides,
  }
}

// ─── Type guard unit tests ────────────────────────────────────────────────────

describe('hasValidRepoBindingShape', () => {
  it('accepts a fully-formed RepoBinding', () => {
    // #given
    const value = makeBinding()

    // #when / #then
    expect(hasValidRepoBindingShape(value)).toBe(true)
  })

  it('rejects null', () => {
    expect(hasValidRepoBindingShape(null)).toBe(false)
  })

  it('rejects a plain string', () => {
    expect(hasValidRepoBindingShape('not-an-object')).toBe(false)
  })

  it('rejects an object missing channelId', () => {
    const binding = makeBinding()
    const rest = Object.fromEntries(Object.entries(binding).filter(([k]) => k !== 'channelId'))
    expect(hasValidRepoBindingShape(rest)).toBe(false)
  })

  it('rejects an object missing createdByDiscordId', () => {
    const binding = makeBinding()
    const rest = Object.fromEntries(Object.entries(binding).filter(([k]) => k !== 'createdByDiscordId'))
    expect(hasValidRepoBindingShape(rest)).toBe(false)
  })
})

describe('hasValidChannelIndexShape', () => {
  it('accepts a valid ChannelIndex', () => {
    expect(hasValidChannelIndexShape({owner: 'foo', repo: 'bar'})).toBe(true)
  })

  it('rejects an object missing owner', () => {
    expect(hasValidChannelIndexShape({repo: 'bar'})).toBe(false)
  })

  it('rejects an object missing repo', () => {
    expect(hasValidChannelIndexShape({owner: 'foo'})).toBe(false)
  })

  it('rejects null', () => {
    expect(hasValidChannelIndexShape(null)).toBe(false)
  })
})

// ─── createBindingsStore ──────────────────────────────────────────────────────

describe('createBindingsStore', () => {
  // Happy path — createBinding writes both records, returns both etags
  it('createBinding writes primary and index records and returns both etags', async () => {
    // #given
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(ok({etag: 'etag-primary'}))
      .mockResolvedValueOnce(ok({etag: 'etag-index'}))
    const adapter = makeAdapter({conditionalPut})
    const store = createBindingsStore({adapter, storeConfig: STORE_CONFIG, identity: IDENTITY})
    const binding = makeBinding()

    // #when
    const result = await store.createBinding(binding)

    // #then
    expect(result).toEqual(ok({primaryEtag: 'etag-primary', indexEtag: 'etag-index'}))
    expect(conditionalPut).toHaveBeenCalledTimes(2)
    expect(conditionalPut).toHaveBeenNthCalledWith(
      1,
      'fro-bot-state/gateway/foo/bar/bindings/repo.json',
      JSON.stringify(binding),
      {ifNoneMatch: '*'},
    )
    expect(conditionalPut).toHaveBeenNthCalledWith(
      2,
      'fro-bot-state/gateway/_/_/bindings/by-channel/123.json',
      JSON.stringify({owner: 'foo', repo: 'bar'}),
      {ifNoneMatch: '*'},
    )
  })

  // Happy path — getBindingByRepo returns the binding
  it('getBindingByRepo returns the binding for an existing repo', async () => {
    // #given
    const binding = makeBinding()
    const adapter = makeAdapter({
      getObject: vi.fn(async () => ok({data: JSON.stringify(binding), etag: 'etag-primary'})),
    })
    const store = createBindingsStore({adapter, storeConfig: STORE_CONFIG, identity: IDENTITY})

    // #when
    const result = await store.getBindingByRepo('foo', 'bar')

    // #then
    expect(result).toEqual(ok(binding))
    expect(adapter.getObject).toHaveBeenCalledWith('fro-bot-state/gateway/foo/bar/bindings/repo.json')
  })

  // Happy path — getBindingByChannelId returns the binding
  it('getBindingByChannelId returns the binding for an existing channel', async () => {
    // #given
    const binding = makeBinding()
    const getObject = vi
      .fn<Required<ObjectStoreAdapter>['getObject']>()
      .mockResolvedValueOnce(ok({data: JSON.stringify({owner: 'foo', repo: 'bar'}), etag: 'etag-index'}))
      .mockResolvedValueOnce(ok({data: JSON.stringify(binding), etag: 'etag-primary'}))
    const adapter = makeAdapter({getObject})
    const store = createBindingsStore({adapter, storeConfig: STORE_CONFIG, identity: IDENTITY})

    // #when
    const result = await store.getBindingByChannelId('123')

    // #then
    expect(result).toEqual(ok(binding))
    expect(getObject).toHaveBeenNthCalledWith(1, 'fro-bot-state/gateway/_/_/bindings/by-channel/123.json')
    expect(getObject).toHaveBeenNthCalledWith(2, 'fro-bot-state/gateway/foo/bar/bindings/repo.json')
  })

  // Happy path — listBindings returns multiple bindings in stable order
  it('listBindings returns all primary binding records in list order', async () => {
    // #given
    const bindingA = makeBinding({owner: 'acme', repo: 'alpha', channelId: '111'})
    const bindingB = makeBinding({owner: 'acme', repo: 'beta', channelId: '222'})
    const keys = [
      'fro-bot-state/gateway/acme/alpha/bindings/repo.json',
      'fro-bot-state/gateway/acme/beta/bindings/repo.json',
      // channel index entries — must be filtered out
      'fro-bot-state/gateway/_/_/bindings/by-channel/111.json',
      'fro-bot-state/gateway/_/_/bindings/by-channel/222.json',
    ]
    const getObject = vi
      .fn<Required<ObjectStoreAdapter>['getObject']>()
      .mockResolvedValueOnce(ok({data: JSON.stringify(bindingA), etag: 'etag-a'}))
      .mockResolvedValueOnce(ok({data: JSON.stringify(bindingB), etag: 'etag-b'}))
    const adapter = makeAdapter({
      list: vi.fn(async () => ok(keys)),
      getObject,
    })
    const store = createBindingsStore({adapter, storeConfig: STORE_CONFIG, identity: IDENTITY})

    // #when
    const result = await store.listBindings()

    // #then
    expect(result).toEqual(ok([bindingA, bindingB]))
    expect(getObject).toHaveBeenCalledTimes(2)
  })

  // Edge case — duplicate createBinding returns BindingExistsError
  it('createBinding returns BindingExistsError when primary IfNoneMatch fires', async () => {
    // #given
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(err(new Error('precondition failed')))
    const adapter = makeAdapter({conditionalPut})
    const store = createBindingsStore({adapter, storeConfig: STORE_CONFIG, identity: IDENTITY})

    // #when
    const result = await store.createBinding(makeBinding())

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.code : '').toBe('BINDING_EXISTS_ERROR')
    // Index write must not be attempted
    expect(conditionalPut).toHaveBeenCalledTimes(1)
  })

  // Edge case — getBindingByRepo returns null for missing key
  it('getBindingByRepo returns null when the primary record does not exist', async () => {
    // #given
    const adapter = makeAdapter({
      getObject: vi.fn(async () => err(new Error('not found'))),
    })
    const store = createBindingsStore({adapter, storeConfig: STORE_CONFIG, identity: IDENTITY})

    // #when
    const result = await store.getBindingByRepo('foo', 'bar')

    // #then
    expect(result).toEqual(ok(null))
  })

  // Edge case — getBindingByChannelId returns null for missing channel index
  it('getBindingByChannelId returns null when the channel index does not exist', async () => {
    // #given
    const adapter = makeAdapter({
      getObject: vi.fn(async () => err(new Error('no such key'))),
    })
    const store = createBindingsStore({adapter, storeConfig: STORE_CONFIG, identity: IDENTITY})

    // #when
    const result = await store.getBindingByChannelId('999')

    // #then
    expect(result).toEqual(ok(null))
  })

  // Edge case — stale channel index pointing at deleted primary returns null
  it('getBindingByChannelId returns null when channel index points at a deleted primary', async () => {
    // #given
    const getObject = vi
      .fn<Required<ObjectStoreAdapter>['getObject']>()
      .mockResolvedValueOnce(ok({data: JSON.stringify({owner: 'foo', repo: 'bar'}), etag: 'etag-index'}))
      .mockResolvedValueOnce(err(new Error('not found')))
    const adapter = makeAdapter({getObject})
    const store = createBindingsStore({adapter, storeConfig: STORE_CONFIG, identity: IDENTITY})

    // #when
    const result = await store.getBindingByChannelId('123')

    // #then
    expect(result).toEqual(ok(null))
  })

  // Error path — malformed JSON in S3 returns ValidationError
  it('getBindingByRepo returns ValidationError when S3 body is malformed JSON', async () => {
    // #given
    const adapter = makeAdapter({
      getObject: vi.fn(async () => ok({data: 'not-valid-json{{{', etag: 'etag-1'})),
    })
    const store = createBindingsStore({adapter, storeConfig: STORE_CONFIG, identity: IDENTITY})

    // #when
    const result = await store.getBindingByRepo('foo', 'bar')

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.code : '').toBe('BINDING_VALIDATION_ERROR')
  })

  // Error path — malformed JSON in S3 returns ValidationError (shape guard)
  it('getBindingByRepo returns ValidationError when S3 body fails shape guard', async () => {
    // #given
    const adapter = makeAdapter({
      getObject: vi.fn(async () => ok({data: JSON.stringify({owner: 'foo'}), etag: 'etag-1'})),
    })
    const store = createBindingsStore({adapter, storeConfig: STORE_CONFIG, identity: IDENTITY})

    // #when
    const result = await store.getBindingByRepo('foo', 'bar')

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.code : '').toBe('BINDING_VALIDATION_ERROR')
  })

  // Error path — S3 returns 403 on primary write → StoreError, index not attempted
  it('createBinding returns StoreError when primary write fails with non-precondition error', async () => {
    // #given
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(err(new Error('403 Forbidden')))
    const adapter = makeAdapter({conditionalPut})
    const store = createBindingsStore({adapter, storeConfig: STORE_CONFIG, identity: IDENTITY})

    // #when
    const result = await store.createBinding(makeBinding())

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.code : '').toBe('BINDING_STORE_ERROR')
    expect(conditionalPut).toHaveBeenCalledTimes(1)
  })

  // Error path — primary succeeds, index fails, rollback succeeds → StoreError
  it('createBinding rolls back primary and returns StoreError when index write fails', async () => {
    // #given
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(ok({etag: 'etag-primary'}))
      .mockResolvedValueOnce(err(new Error('index write failed')))
    const conditionalDelete = vi.fn<Required<ObjectStoreAdapter>['conditionalDelete']>(async () => ok(undefined))
    const adapter = makeAdapter({conditionalPut, conditionalDelete})
    const store = createBindingsStore({adapter, storeConfig: STORE_CONFIG, identity: IDENTITY})

    // #when
    const result = await store.createBinding(makeBinding())

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.code : '').toBe('BINDING_STORE_ERROR')
    expect(conditionalDelete).toHaveBeenCalledWith('fro-bot-state/gateway/foo/bar/bindings/repo.json', {
      ifMatch: 'etag-primary',
    })
  })

  // New test T1 — listBindings skips corrupted records and returns valid ones
  it('listBindings skips corrupted records and returns the valid ones', async () => {
    // #given
    const bindingA = makeBinding({owner: 'acme', repo: 'alpha', channelId: '111'})
    const bindingC = makeBinding({owner: 'acme', repo: 'gamma', channelId: '333'})
    const keys = [
      'fro-bot-state/gateway/acme/alpha/bindings/repo.json',
      'fro-bot-state/gateway/acme/beta/bindings/repo.json', // corrupted
      'fro-bot-state/gateway/acme/gamma/bindings/repo.json',
    ]
    const getObject = vi
      .fn<Required<ObjectStoreAdapter>['getObject']>()
      .mockResolvedValueOnce(ok({data: JSON.stringify(bindingA), etag: 'etag-a'}))
      .mockResolvedValueOnce(ok({data: 'not-valid-json{{{', etag: 'etag-b'})) // corrupted
      .mockResolvedValueOnce(ok({data: JSON.stringify(bindingC), etag: 'etag-c'}))
    const adapter = makeAdapter({
      list: vi.fn(async () => ok(keys)),
      getObject,
    })
    const store = createBindingsStore({adapter, storeConfig: STORE_CONFIG, identity: IDENTITY})

    // #when
    const result = await store.listBindings()

    // #then
    expect(result).toEqual(ok([bindingA, bindingC]))
    expect(getObject).toHaveBeenCalledTimes(3)
  })

  // New test T2 — createBinding propagates key-construction error from invalid channelId
  it('createBinding returns StoreError when channelId is invalid (path traversal attempt)', async () => {
    // #given
    const adapter = makeAdapter()
    const store = createBindingsStore({adapter, storeConfig: STORE_CONFIG, identity: IDENTITY})
    const binding = makeBinding({channelId: '../../../other'})

    // #when
    const result = await store.createBinding(binding)

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.code : '').toBe('BINDING_STORE_ERROR')
    // No S3 write should have been attempted
    expect(adapter.conditionalPut).not.toHaveBeenCalled()
  })

  // New test T3 — listBindings propagates adapter.list errors as StoreError
  it('listBindings returns StoreError when adapter.list fails', async () => {
    // #given
    const adapter = makeAdapter({
      list: vi.fn(async () => err(new Error('S3 list failed'))),
    })
    const store = createBindingsStore({adapter, storeConfig: STORE_CONFIG, identity: IDENTITY})

    // #when
    const result = await store.listBindings()

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.code : '').toBe('BINDING_STORE_ERROR')
  })

  // Error path — primary succeeds, index fails, rollback also fails → PartialWriteError
  it('createBinding returns PartialWriteError when index write and rollback both fail', async () => {
    // #given
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(ok({etag: 'etag-primary'}))
      .mockResolvedValueOnce(err(new Error('index write failed')))
    const conditionalDelete = vi
      .fn<Required<ObjectStoreAdapter>['conditionalDelete']>()
      .mockResolvedValueOnce(err(new Error('rollback failed')))
    const adapter = makeAdapter({conditionalPut, conditionalDelete})
    const store = createBindingsStore({adapter, storeConfig: STORE_CONFIG, identity: IDENTITY})

    // #when
    const result = await store.createBinding(makeBinding())

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.code : '').toBe('BINDING_PARTIAL_WRITE_ERROR')
    expect(result.success === false ? (result.error as PartialWriteError).primaryKey : '').toBe(
      'fro-bot-state/gateway/foo/bar/bindings/repo.json',
    )
    expect(result.success === false ? (result.error as PartialWriteError).indexKey : '').toBe(
      'fro-bot-state/gateway/_/_/bindings/by-channel/123.json',
    )
  })
})
