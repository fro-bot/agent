import type {ObjectStoreConfig, Result} from '../shared/types.js'
import {DEFAULT_S3_PREFIX} from '../shared/constants.js'
import {err, ok} from '../shared/types.js'
import {getEffectiveEncryption} from './encryption.js'
import {createValidationError} from './types.js'
import {validateEndpoint, validatePrefix} from './validation.js'

const AWS_ACCOUNT_ID_PATTERN = /^\d{12}$/

/**
 * A setting value plus the name of the source the operator set it through (an Action input name, an env var, ...).
 * The source is the only part that ever appears in an error message; the value never does.
 */
export interface SettingSource {
  readonly value: string | null
  readonly source: string
}

/**
 * Plain object-store settings. Each surface (Action inputs, gateway env and `_FILE` values) reads its own sources and
 * maps them onto this shape. Values need not be trimmed: the parser trims each one, and a value that is empty after
 * trimming counts as unset. This module does no IO.
 */
export interface ObjectStoreSettingsInput {
  readonly enabled: boolean
  readonly bucket: SettingSource
  /** Candidates in order; the first non-empty one wins. At least one is required so an error can name a source. */
  readonly region: readonly [SettingSource, ...SettingSource[]]
  readonly endpoint: SettingSource
  readonly allowInsecureEndpoint: boolean
  readonly prefix: SettingSource
  readonly sseEncryption: SettingSource
  readonly sseKmsKeyId: SettingSource
  readonly expectedBucketOwner: SettingSource
}

export interface ObjectStoreSettingsOptions {
  /** `required`: an empty region is an error when the store is enabled. `optional`: it yields `''`. */
  readonly region: 'required' | 'optional'
}

function present(setting: SettingSource): string | undefined {
  const trimmed = setting.value?.trim()
  return trimmed != null && trimmed.length > 0 ? trimmed : undefined
}

function fail(source: string, message: string): Result<never, Error> {
  return err(createValidationError(`${source}: ${message}`))
}

/** `a`, `a or b`, `a, b or c`. */
function joinSources(sources: readonly [SettingSource, ...SettingSource[]]): string {
  const [first, ...others] = sources
  const last = others.pop()

  if (last === undefined) {
    return first.source
  }

  return `${[first, ...others].map(candidate => candidate.source).join(', ')} or ${last.source}`
}

function parseSseEncryption(setting: SettingSource): Result<ObjectStoreConfig['sseEncryption'], Error> {
  const value = present(setting)

  if (value === undefined) {
    return ok(undefined)
  }

  if (value === 'aws:kms' || value === 'AES256') {
    return ok(value)
  }

  return fail(setting.source, "must be either 'aws:kms' or 'AES256'")
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
  if (sseResult.success === false) {
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
      return err(createValidationError(`${joinSources(input.region)} is required`))
    }

    if (endpoint !== undefined) {
      const endpointResult = validateEndpoint(endpoint, input.allowInsecureEndpoint)
      if (endpointResult.success === false) {
        return fail(input.endpoint.source, endpointResult.error.message)
      }
    }

    const prefixResult = validatePrefix(prefix)
    if (prefixResult.success === false) {
      return fail(input.prefix.source, prefixResult.error.message)
    }
    prefix = prefixResult.data

    if (expectedBucketOwner !== undefined && AWS_ACCOUNT_ID_PATTERN.test(expectedBucketOwner) === false) {
      return fail(input.expectedBucketOwner.source, 'must be a 12-digit AWS account ID')
    }
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
