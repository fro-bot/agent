import type {ObjectStoreAdapter, ObjectStoreConfig, Result} from '@fro-bot/runtime'

import {buildObjectStoreKey, err, ok, sanitizeKeyComponent} from '@fro-bot/runtime'

import {
  createBindingExistsError,
  createPartialWriteError,
  createStoreError,
  createValidationError,
  hasValidChannelIndexShape,
  hasValidRepoBindingShape,
  type BindingExistsError,
  type PartialWriteError,
  type RepoBinding,
  type StoreError,
  type ValidationError,
} from './types.js'

export interface BindingsStore {
  readonly createBinding: (
    binding: RepoBinding,
  ) => Promise<Result<{primaryEtag: string; indexEtag: string}, BindingExistsError | StoreError | PartialWriteError>>
  readonly getBindingByRepo: (
    owner: string,
    repo: string,
  ) => Promise<Result<RepoBinding | null, StoreError | ValidationError>>
  readonly getBindingByChannelId: (
    channelId: string,
  ) => Promise<Result<RepoBinding | null, StoreError | ValidationError>>
  readonly listBindings: () => Promise<Result<RepoBinding[], StoreError | ValidationError>>
}

export interface BindingsStoreConfig {
  readonly adapter: ObjectStoreAdapter
  readonly storeConfig: ObjectStoreConfig
  readonly identity: string
}

function isPreconditionFailed(error: Error): boolean {
  return /pre-?condition/i.test(error.message)
}

function isNotFound(error: Error): boolean {
  return /not.?found|no.?such.?key|404/i.test(error.message)
}

function buildPrimaryKey(
  storeConfig: ObjectStoreConfig,
  identity: string,
  owner: string,
  repo: string,
): Result<string, Error> {
  const key = buildObjectStoreKey(storeConfig, identity, `${owner}/${repo}`, 'bindings', 'repo.json')
  if (key.success === false) {
    return err(key.error)
  }

  return ok(key.data)
}

function buildChannelIndexKey(
  storeConfig: ObjectStoreConfig,
  identity: string,
  channelId: string,
): Result<string, Error> {
  // Channel index lives at {prefix}/{identity}/_/_/bindings/by-channel/{channelId}.json
  // We build this manually because buildObjectStoreKey's sanitizeKeyComponent replaces '/' with '-'
  // in the suffix, which would corrupt the by-channel/ sub-path.
  const sanitizedIdentity = sanitizeKeyComponent(identity)
  if (sanitizedIdentity.success === false) {
    return err(sanitizedIdentity.error)
  }

  const sanitizedChannelId = sanitizeKeyComponent(channelId)
  if (sanitizedChannelId.success === false) {
    return err(sanitizedChannelId.error)
  }

  return ok(`${storeConfig.prefix}/${sanitizedIdentity.data}/_/_/bindings/by-channel/${sanitizedChannelId.data}.json`)
}

function parseRepoBinding(data: string): Result<RepoBinding, ValidationError> {
  try {
    const parsed: unknown = JSON.parse(data)
    if (hasValidRepoBindingShape(parsed) === false) {
      return err(createValidationError('Invalid repo binding payload'))
    }

    return ok(parsed)
  } catch (error) {
    return err(createValidationError(error instanceof Error ? error.message : String(error)))
  }
}

function parseChannelIndex(data: string): Result<{owner: string; repo: string}, ValidationError> {
  try {
    const parsed: unknown = JSON.parse(data)
    if (hasValidChannelIndexShape(parsed) === false) {
      return err(createValidationError('Invalid channel index payload'))
    }

    return ok(parsed)
  } catch (error) {
    return err(createValidationError(error instanceof Error ? error.message : String(error)))
  }
}

export function createBindingsStore({adapter, storeConfig, identity}: BindingsStoreConfig): BindingsStore {
  async function createBinding(
    binding: RepoBinding,
  ): Promise<Result<{primaryEtag: string; indexEtag: string}, BindingExistsError | StoreError | PartialWriteError>> {
    if (adapter.conditionalPut == null) {
      return err(createStoreError('Object store adapter does not support conditionalPut'))
    }

    if (adapter.conditionalDelete == null) {
      return err(createStoreError('Object store adapter does not support conditionalDelete'))
    }

    const primaryKeyResult = buildPrimaryKey(storeConfig, identity, binding.owner, binding.repo)
    if (primaryKeyResult.success === false) {
      return err(createStoreError(primaryKeyResult.error.message))
    }

    const primaryKey = primaryKeyResult.data
    const indexKeyResult = buildChannelIndexKey(storeConfig, identity, binding.channelId)
    if (indexKeyResult.success === false) {
      return err(createStoreError(indexKeyResult.error.message))
    }

    const indexKey = indexKeyResult.data

    // Write primary record with IfNoneMatch: '*' — atomic create-only
    const primaryWrite = await adapter.conditionalPut(primaryKey, JSON.stringify(binding), {ifNoneMatch: '*'})
    if (primaryWrite.success === false) {
      if (isPreconditionFailed(primaryWrite.error)) {
        return err(createBindingExistsError(binding.owner, binding.repo))
      }

      return err(createStoreError(primaryWrite.error.message))
    }

    const primaryEtag = primaryWrite.data.etag

    // Write channel index with IfNoneMatch: '*'
    const indexBody: {owner: string; repo: string} = {owner: binding.owner, repo: binding.repo}
    const indexWrite = await adapter.conditionalPut(indexKey, JSON.stringify(indexBody), {ifNoneMatch: '*'})
    if (indexWrite.success === false) {
      // Index write failed — attempt rollback of primary
      const rollback = await adapter.conditionalDelete(primaryKey, {ifMatch: primaryEtag})
      if (rollback.success === false) {
        return err(createPartialWriteError(primaryKey, indexKey))
      }

      return err(createStoreError(indexWrite.error.message))
    }

    return ok({primaryEtag, indexEtag: indexWrite.data.etag})
  }

  async function getBindingByRepo(
    owner: string,
    repo: string,
  ): Promise<Result<RepoBinding | null, StoreError | ValidationError>> {
    if (adapter.getObject == null) {
      return err(createStoreError('Object store adapter does not support getObject'))
    }

    const primaryKeyResult = buildPrimaryKey(storeConfig, identity, owner, repo)
    if (primaryKeyResult.success === false) {
      return err(createStoreError(primaryKeyResult.error.message))
    }

    const result = await adapter.getObject(primaryKeyResult.data)
    if (result.success === false) {
      if (isNotFound(result.error)) {
        return ok(null)
      }

      return err(createStoreError(result.error.message))
    }

    return parseRepoBinding(result.data.data)
  }

  async function getBindingByChannelId(
    channelId: string,
  ): Promise<Result<RepoBinding | null, StoreError | ValidationError>> {
    if (adapter.getObject == null) {
      return err(createStoreError('Object store adapter does not support getObject'))
    }

    const indexKeyResult = buildChannelIndexKey(storeConfig, identity, channelId)
    if (indexKeyResult.success === false) {
      return err(createStoreError(indexKeyResult.error.message))
    }

    const indexKey = indexKeyResult.data

    // Fetch the channel index entry
    const indexResult = await adapter.getObject(indexKey)
    if (indexResult.success === false) {
      if (isNotFound(indexResult.error)) {
        return ok(null)
      }

      return err(createStoreError(indexResult.error.message))
    }

    const indexParsed = parseChannelIndex(indexResult.data.data)
    if (indexParsed.success === false) {
      return err(indexParsed.error)
    }

    const {owner, repo} = indexParsed.data

    // Fetch the primary record
    const primaryKeyResult = buildPrimaryKey(storeConfig, identity, owner, repo)
    if (primaryKeyResult.success === false) {
      return err(createStoreError(primaryKeyResult.error.message))
    }

    const primaryResult = await adapter.getObject(primaryKeyResult.data)
    if (primaryResult.success === false) {
      if (isNotFound(primaryResult.error)) {
        // Stale index — primary was deleted; treat as absent
        return ok(null)
      }

      return err(createStoreError(primaryResult.error.message))
    }

    return parseRepoBinding(primaryResult.data.data)
  }

  async function listBindings(): Promise<Result<RepoBinding[], StoreError | ValidationError>> {
    if (adapter.getObject == null) {
      return err(createStoreError('Object store adapter does not support getObject'))
    }

    // LIST under the identity prefix to find all repo.json keys
    const listPrefix = `${storeConfig.prefix}/${identity}/`
    const listResult = await adapter.list(listPrefix)
    if (listResult.success === false) {
      return err(createStoreError(listResult.error.message))
    }

    // Filter to only primary binding records (repo.json under bindings/, not channel index entries)
    const bindingKeys = listResult.data.filter(key => key.endsWith('/bindings/repo.json') && !key.includes('/_/_/'))

    const bindings: RepoBinding[] = []
    for (const key of bindingKeys) {
      const result = await adapter.getObject(key)
      if (result.success === false) {
        if (isNotFound(result.error)) {
          // Key disappeared between list and get — skip
          continue
        }

        return err(createStoreError(result.error.message))
      }

      const parsed = parseRepoBinding(result.data.data)
      if (parsed.success === false) {
        // Corrupted record — skip and continue; one bad record must not kill the whole listing
        continue
      }

      bindings.push(parsed.data)
    }

    return ok(bindings)
  }

  return {createBinding, getBindingByRepo, getBindingByChannelId, listBindings}
}
