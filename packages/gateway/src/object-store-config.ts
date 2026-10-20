import type {ObjectStoreConfig, SettingSource} from './runtime-effect.js'

import {parseObjectStoreSettings} from './runtime-effect.js'
import {isSecretFileBlank, missingSecretMessage, readEnvSecret, readOptionalSecret} from './secrets.js'

/**
 * A missing or invalid object-store setting. Its message names the setting and the rule it broke and never contains a
 * value (the parser's no-echo rule), so startup may log it.
 */
export class ObjectStoreConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ObjectStoreConfigError'
  }
}

/**
 * Read one object-store setting from its `_FILE` form or env. A blank `_FILE` counts as unset and defers to the
 * same-named env var; a non-blank file wins over env, and a missing path falls through to env, as `readOptionalSecret`
 * does. Every other gateway secret keeps the stricter rule where a blank file is an explicit opt-out.
 */
function readSetting(name: string): string | null {
  return isSecretFileBlank(name) ? readEnvSecret(name) : readOptionalSecret(name)
}

/** An optional setting read from env or its `_FILE` form. The setting's name is its error-message source. */
function fromEnv(name: string): SettingSource {
  return {value: readSetting(name), source: name}
}

/**
 * The region candidates in order. `AWS_REGION` (and `AWS_REGION_FILE`) is read only when `S3_REGION` is unset or
 * blank, so an unused fallback that is malformed or unreadable cannot abort startup. An unread fallback is still
 * listed (with no value) so the "required" message names both candidates.
 */
function readRegionCandidates(): readonly [SettingSource, ...SettingSource[]] {
  const primary = fromEnv('S3_REGION')
  const primaryIsSet = primary.value !== null && primary.value.trim() !== ''

  return [primary, primaryIsSet ? {value: null, source: 'AWS_REGION'} : fromEnv('AWS_REGION')]
}

/**
 * Read the object-store settings from env and `_FILE` values and parse them with the shared runtime parser.
 *
 * One mapping for every gateway path (server and backfill). Credentials are not part of the result; each caller adds
 * its own. `S3_BUCKET` is required and keeps the `Missing required secret: S3_BUCKET (...)` text. Throws an
 * `ObjectStoreConfigError` (source name and rule, never the value) when a setting is missing or invalid. Errors from
 * reading a `_FILE` (symlink, not a regular file, too large, unreadable) propagate as they are: they name a file path,
 * so startup does not log them.
 */
export function loadObjectStoreSettings(): ObjectStoreConfig {
  const bucket = readSetting('S3_BUCKET')
  if (bucket === null) {
    throw new ObjectStoreConfigError(missingSecretMessage('S3_BUCKET'))
  }

  const result = parseObjectStoreSettings(
    {
      enabled: true,
      bucket: {value: bucket, source: 'S3_BUCKET'},
      region: readRegionCandidates(),
      endpoint: fromEnv('S3_ENDPOINT'),
      allowInsecureEndpoint: readSetting('S3_ALLOW_INSECURE_ENDPOINT') === 'true',
      prefix: fromEnv('S3_PREFIX'),
      sseEncryption: fromEnv('S3_SSE'),
      sseKmsKeyId: fromEnv('S3_SSE_KMS_KEY_ID'),
      expectedBucketOwner: fromEnv('S3_EXPECTED_BUCKET_OWNER'),
    },
    {region: 'required'},
  )

  if (result.success === false) {
    throw new ObjectStoreConfigError(result.error.message)
  }

  return result.data
}
