import type {ObjectStoreConfig, SettingSource} from './runtime-effect.js'

import {parseObjectStoreSettings} from './runtime-effect.js'
import {readOptionalSecret, readSecret} from './secrets.js'

/** An optional setting read from env or its `_FILE` form. The setting's name is its error-message source. */
function fromEnv(name: string): SettingSource {
  return {value: readOptionalSecret(name), source: name}
}

/**
 * Read the object-store settings from env and `_FILE` values and parse them with the shared runtime parser.
 *
 * One mapping for every gateway path (server and backfill). Credentials are not part of the result; each caller adds
 * its own. `S3_BUCKET` is read with `readSecret` so its missing-value text stays unchanged; every other setting is
 * optional. Throws with the parser's message (source name and rule, never the value) when a setting is invalid.
 */
export function loadObjectStoreSettings(): ObjectStoreConfig {
  const result = parseObjectStoreSettings(
    {
      enabled: true,
      bucket: {value: readSecret('S3_BUCKET'), source: 'S3_BUCKET'},
      region: [fromEnv('S3_REGION'), fromEnv('AWS_REGION')],
      endpoint: fromEnv('S3_ENDPOINT'),
      allowInsecureEndpoint: readOptionalSecret('S3_ALLOW_INSECURE_ENDPOINT') === 'true',
      prefix: fromEnv('S3_PREFIX'),
      sseEncryption: fromEnv('S3_SSE'),
      sseKmsKeyId: fromEnv('S3_SSE_KMS_KEY_ID'),
      expectedBucketOwner: fromEnv('S3_EXPECTED_BUCKET_OWNER'),
    },
    {region: 'required'},
  )

  if (result.success === false) {
    throw new Error(result.error.message)
  }

  return result.data
}
