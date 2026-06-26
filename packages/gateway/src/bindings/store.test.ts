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
    listWithMetadata: vi.fn(async () => ok([])),
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

  it('accepts a binding with optional databaseId and nodeId present', () => {
    // #given
    const value = makeBinding({databaseId: 987654321, nodeId: 'MDEwOlJlcG9zaXRvcnkx'})

    // #when / #then
    expect(hasValidRepoBindingShape(value)).toBe(true)
  })

  it('accepts a binding with only databaseId present (nodeId absent)', () => {
    // #given
    const value = makeBinding({databaseId: 1})

    // #when / #then
    expect(hasValidRepoBindingShape(value)).toBe(true)
  })

  it('accepts a binding with only nodeId present (databaseId absent)', () => {
    // #given
    const value = makeBinding({nodeId: 'R_kgDOBcdefg'})

    // #when / #then
    expect(hasValidRepoBindingShape(value)).toBe(true)
  })

  it('rejects a binding where databaseId is a string instead of a number', () => {
    // #given — databaseId must be a number when present
    const value = {...makeBinding(), databaseId: '123456789'}

    // #when / #then
    expect(hasValidRepoBindingShape(value)).toBe(false)
  })

  it('rejects a binding where nodeId is a number instead of a string', () => {
    // #given — nodeId must be a string when present
    const value = {...makeBinding(), nodeId: 42}

    // #when / #then
    expect(hasValidRepoBindingShape(value)).toBe(false)
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

  // isNotFound — structured classification for AWS NoSuchKey errors
  describe('getBindingByRepo isNotFound classification', () => {
    const notFoundCases = [
      {
        label: 'real AWS NoSuchKey message with structured code and status',
        error: Object.assign(new Error('Object store getObject failed: The specified key does not exist.'), {
          code: 'OBJECT_STORE_OPERATION_ERROR',
          errorCode: 'NoSuchKey',
          httpStatusCode: 404,
        }),
      },
      {
        label: 'structured-only: generic message + errorCode NoSuchKey',
        error: Object.assign(new Error('Object store getObject failed: some generic message'), {
          code: 'OBJECT_STORE_OPERATION_ERROR',
          errorCode: 'NoSuchKey',
        }),
      },
      {
        label: 'structured-only: errorCode NotFound + httpStatusCode 404 (R2/other compatible stores)',
        error: Object.assign(new Error('Object store getObject failed: Not Found'), {
          code: 'OBJECT_STORE_OPERATION_ERROR',
          errorCode: 'NotFound',
          httpStatusCode: 404,
        }),
      },
      {
        label: 'SDK v3 shape: errorName NoSuchKey only (no errorCode)',
        error: Object.assign(new Error('Object store getObject failed: The specified key does not exist.'), {
          code: 'OBJECT_STORE_OPERATION_ERROR',
          errorName: 'NoSuchKey',
        }),
      },
      {
        label: 'R2/B2-style message-only: no such key (no structured fields)',
        error: new Error('Object store getObject failed: no such key'),
      },
      {
        label: 'legacy not found message (existing behavior)',
        error: new Error('not found'),
      },
    ]

    for (const {label, error} of notFoundCases) {
      it(`returns ok(null) for: ${label}`, async () => {
        // #given
        const adapter = makeAdapter({
          getObject: vi.fn(async () => err(error)),
        })
        const store = createBindingsStore({adapter, storeConfig: STORE_CONFIG, identity: IDENTITY})

        // #when
        const result = await store.getBindingByRepo('foo', 'bar')

        // #then
        expect(result).toEqual(ok(null))
      })
    }

    it('returns err for a genuine fatal error (403 Access Denied)', async () => {
      // #given
      const fatalError = Object.assign(new Error('Object store getObject failed: Access Denied'), {
        code: 'OBJECT_STORE_OPERATION_ERROR',
        errorCode: 'AccessDenied',
        httpStatusCode: 403,
      })
      const adapter = makeAdapter({
        getObject: vi.fn(async () => err(fatalError)),
      })
      const store = createBindingsStore({adapter, storeConfig: STORE_CONFIG, identity: IDENTITY})

      // #when
      const result = await store.getBindingByRepo('foo', 'bar')

      // #then
      expect(result.success).toBe(false)
    })

    // P1 regression: NoSuchBucket is a FATAL misconfiguration, not an absent key.
    // It shares httpStatusCode 404 with NoSuchKey but must NOT be treated as not-found.
    const fatal404Cases = [
      {
        label: 'NoSuchBucket structured (errorCode) — must return err, not ok(null)',
        error: Object.assign(new Error('Object store getObject failed: The specified bucket does not exist.'), {
          code: 'OBJECT_STORE_OPERATION_ERROR',
          errorCode: 'NoSuchBucket',
          httpStatusCode: 404,
        }),
      },
      {
        label: 'NoSuchBucket message-only — must return err, not ok(null)',
        error: new Error('Object store getObject failed: The specified bucket does not exist.'),
      },
    ]

    for (const {label, error} of fatal404Cases) {
      it(`returns err (fatal) for: ${label}`, async () => {
        // #given
        const adapter = makeAdapter({
          getObject: vi.fn(async () => err(error)),
        })
        const store = createBindingsStore({adapter, storeConfig: STORE_CONFIG, identity: IDENTITY})

        // #when
        const result = await store.getBindingByRepo('foo', 'bar')

        // #then
        expect(result.success).toBe(false)
      })
    }
  })

  // ─── Unit 1: deny-key fields (databaseId / nodeId) ──────────────────────────

  // Happy path — binding with deny keys round-trips through the store
  it('createBinding + getBindingByRepo round-trips a binding that carries databaseId and nodeId', async () => {
    // #given
    const bindingWithKeys = makeBinding({databaseId: 123456789, nodeId: 'R_kgDOBcdefg'})
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(ok({etag: 'etag-primary'}))
      .mockResolvedValueOnce(ok({etag: 'etag-index'}))
    const getObject = vi
      .fn<Required<ObjectStoreAdapter>['getObject']>()
      .mockResolvedValueOnce(ok({data: JSON.stringify(bindingWithKeys), etag: 'etag-primary'}))
    const adapter = makeAdapter({conditionalPut, getObject})
    const store = createBindingsStore({adapter, storeConfig: STORE_CONFIG, identity: IDENTITY})

    // #when — write then read
    const writeResult = await store.createBinding(bindingWithKeys)
    const readResult = await store.getBindingByRepo('foo', 'bar')

    // #then — write succeeds and read returns the binding with deny keys intact
    expect(writeResult).toEqual(ok({primaryEtag: 'etag-primary', indexEtag: 'etag-index'}))
    expect(readResult).toEqual(ok(bindingWithKeys))
    expect(readResult.success === true ? readResult.data?.databaseId : undefined).toBe(123456789)
    expect(readResult.success === true ? readResult.data?.nodeId : undefined).toBe('R_kgDOBcdefg')
    // Verify the serialized payload written to S3 includes the deny keys
    expect(conditionalPut).toHaveBeenNthCalledWith(
      1,
      'fro-bot-state/gateway/foo/bar/bindings/repo.json',
      JSON.stringify(bindingWithKeys),
      {ifNoneMatch: '*'},
    )
  })

  // Legacy compat — binding WITHOUT deny keys parses fine (fields undefined)
  it('getBindingByRepo returns a valid binding when stored payload has no databaseId or nodeId (legacy)', async () => {
    // #given — a legacy binding stored without the new fields
    const legacyBinding = makeBinding() // no databaseId / nodeId
    const adapter = makeAdapter({
      getObject: vi.fn(async () => ok({data: JSON.stringify(legacyBinding), etag: 'etag-primary'})),
    })
    const store = createBindingsStore({adapter, storeConfig: STORE_CONFIG, identity: IDENTITY})

    // #when
    const result = await store.getBindingByRepo('foo', 'bar')

    // #then — binding is valid; deny-key fields are absent (undefined)
    expect(result).toEqual(ok(legacyBinding))
    expect(result.success === true ? result.data?.databaseId : 'FAIL').toBeUndefined()
    expect(result.success === true ? result.data?.nodeId : 'FAIL').toBeUndefined()
  })

  // Legacy compat — listBindings returns legacy bindings (no deny keys) alongside keyed ones
  it('listBindings returns both legacy bindings and bindings with deny keys', async () => {
    // #given
    const legacyBinding = makeBinding({owner: 'acme', repo: 'legacy', channelId: '111'})
    const keyedBinding = makeBinding({owner: 'acme', repo: 'keyed', channelId: '222', databaseId: 42, nodeId: 'MDEw'})
    const keys = [
      'fro-bot-state/gateway/acme/legacy/bindings/repo.json',
      'fro-bot-state/gateway/acme/keyed/bindings/repo.json',
    ]
    const getObject = vi
      .fn<Required<ObjectStoreAdapter>['getObject']>()
      .mockResolvedValueOnce(ok({data: JSON.stringify(legacyBinding), etag: 'etag-a'}))
      .mockResolvedValueOnce(ok({data: JSON.stringify(keyedBinding), etag: 'etag-b'}))
    const adapter = makeAdapter({
      list: vi.fn(async () => ok(keys)),
      getObject,
    })
    const store = createBindingsStore({adapter, storeConfig: STORE_CONFIG, identity: IDENTITY})

    // #when
    const result = await store.listBindings()

    // #then — both bindings returned; legacy has no deny keys, keyed has them
    expect(result).toEqual(ok([legacyBinding, keyedBinding]))
    if (result.success !== true) throw new Error('expected success')
    expect(result.data[0]?.databaseId).toBeUndefined()
    expect(result.data[1]?.databaseId).toBe(42)
    expect(result.data[1]?.nodeId).toBe('MDEw')
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
