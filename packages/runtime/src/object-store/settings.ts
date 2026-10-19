import type {ObjectStoreConfig, Result} from '../shared/types.js'
import {DEFAULT_S3_PREFIX} from '../shared/constants.js'
import {err, ok} from '../shared/types.js'
import {getEffectiveEncryption} from './s3-adapter.js'
import {createValidationError} from './types.js'
import {validateEndpoint, validatePrefix} from './validation.js'

/**
 * A setting value plus the name of the source the operator set it through (an Action input name, an env var, ...).
 * The source is the only part that ever appears in an error message; the value never does.
 */
export interface Sourced {
  readonly value: string | null
  readonly source: string
}

/**
 * Plain, already-trimmed object-store settings. Each surface (Action inputs, gateway env and `_FILE` values) reads its
 * own sources and maps them onto this shape. An empty string counts as unset. This module does no IO.
 */
export interface ObjectStoreSettingsInput {
  readonly enabled: boolean
  readonly bucket: Sourced
  /** Candidates in order; the first non-empty one wins. */
  readonly region: readonly Sourced[]
  readonly endpoint: Sourced
  readonly allowInsecureEndpoint: boolean
  readonly prefix: Sourced
  readonly sseEncryption: Sourced
  readonly sseKmsKeyId: Sourced
  readonly expectedBucketOwner: Sourced
}

export interface ObjectStoreSettingsOptions {
  /** `required`: an empty region is an error when the store is enabled. `optional`: it yields `''`. */
  readonly region: 'required' | 'optional'
}

function present(sourced: Sourced): string | undefined {
  return sourced.value != null && sourced.value.length > 0 ? sourced.value : undefined
}

function fail(source: string, message: string): Result<never, Error> {
  return err(createValidationError(`${source}: ${message}`))
}

function joinSources(sources: readonly string[]): string {
  if (sources.length === 0) {
    return 'region'
  }

  if (sources.length === 1) {
    return sources[0] as string
  }

  return `${sources.slice(0, -1).join(', ')} or ${sources.at(-1) as string}`
}

function parseSseEncryption(sourced: Sourced): Result<ObjectStoreConfig['sseEncryption'], Error> {
  const value = present(sourced)

  if (value === undefined) {
    return ok(undefined)
  }

  if (value === 'aws:kms' || value === 'AES256') {
    return ok(value)
  }

  return fail(sourced.source, "must be either 'aws:kms' or 'AES256'")
}

/**
 * Parse object-store settings into an `ObjectStoreConfig` (without credentials).
 *
 * Rules run only when the store is enabled, except the SSE mode value, which is checked whenever it is set. Error
 * messages read `<source>: <rule message>` and never contain the input value.
 */
export function parseObjectStoreSettings(
  input: ObjectStoreSettingsInput,
  options: ObjectStoreSettingsOptions,
): Result<ObjectStoreConfig, Error> {
  const sseResult = parseSseEncryption(input.sseEncryption)
  if (!sseResult.success) {
    return sseResult
  }
  const sseEncryption = sseResult.data

  const bucket = present(input.bucket)
  const region = input.region.map(present).find(candidate => candidate !== undefined)
  const endpoint = present(input.endpoint)
  const expectedBucketOwner = present(input.expectedBucketOwner)
  const sseKmsKeyId = present(input.sseKmsKeyId)
  let prefix = present(input.prefix) ?? DEFAULT_S3_PREFIX

  if (input.enabled) {
    if (bucket === undefined) {
      return err(createValidationError(`${input.bucket.source} is required`))
    }

    if (region === undefined && options.region === 'required') {
      return err(createValidationError(`${joinSources(input.region.map(candidate => candidate.source))} is required`))
    }

    if (endpoint !== undefined) {
      const endpointResult = validateEndpoint(endpoint, input.allowInsecureEndpoint)
      if (!endpointResult.success) {
        return fail(input.endpoint.source, endpointResult.error.message)
      }
    }

    const prefixResult = validatePrefix(prefix)
    if (!prefixResult.success) {
      return fail(input.prefix.source, prefixResult.error.message)
    }
    prefix = prefixResult.data
  }

  const config: ObjectStoreConfig = {
    enabled: input.enabled,
    bucket: bucket ?? '',
    region: region ?? '',
    prefix,
    allowInsecureEndpoint: input.allowInsecureEndpoint,
    ...(endpoint === undefined ? {} : {endpoint}),
    ...(expectedBucketOwner === undefined ? {} : {expectedBucketOwner}),
    ...(sseEncryption === undefined ? {} : {sseEncryption}),
    ...(sseKmsKeyId === undefined ? {} : {sseKmsKeyId}),
  }

  if (input.enabled && sseKmsKeyId !== undefined && getEffectiveEncryption(config) !== 'aws:kms') {
    return fail(
      input.sseKmsKeyId.source,
      `requires the server-side encryption mode to be aws:kms; set ${input.sseEncryption.source} to aws:kms`,
    )
  }

  return ok(config)
}
