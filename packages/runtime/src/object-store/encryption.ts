import type {ObjectStoreConfig} from '../shared/types.js'

/**
 * The server-side encryption mode requests use: the configured mode, else `AES256` on a custom endpoint (S3-compatible
 * stores generally lack KMS), else `aws:kms`.
 */
export function getEffectiveEncryption(config: ObjectStoreConfig): 'AES256' | 'aws:kms' {
  if (config.sseEncryption != null) {
    return config.sseEncryption
  }

  if (config.endpoint != null) {
    return 'AES256'
  }

  return 'aws:kms'
}
