/**
 * State keys for main <-> post action handoff.
 *
 * These keys are used with core.saveState() in main action
 * and core.getState() in post action. State is persisted to a file
 * by GitHub Actions and made available as STATE_* environment variables.
 */
export const STATE_KEYS = {
  /** Whether the main action processed an event (vs skipped) */
  SHOULD_SAVE_CACHE: 'shouldSaveCache',
  /** Session ID used in this run (for logging) */
  SESSION_ID: 'sessionId',
  /** Whether main action already saved cache successfully */
  CACHE_SAVED: 'cacheSaved',
  /** Whether main action already uploaded log artifacts */
  ARTIFACT_UPLOADED: 'artifactUploaded',
  /** OpenCode version detected during main action (for post-action cache path calculation) */
  OPENCODE_VERSION: 'opencodeVersion',
  S3_ENABLED: 'storeConfig.enabled',
  S3_BUCKET: 'storeConfig.bucket',
  S3_REGION: 'storeConfig.region',
  S3_PREFIX: 'storeConfig.prefix',
  S3_ENDPOINT: 'storeConfig.endpoint',
  S3_EXPECTED_BUCKET_OWNER: 'storeConfig.expectedBucketOwner',
  S3_ALLOW_INSECURE_ENDPOINT: 'storeConfig.allowInsecureEndpoint',
  S3_SSE_ENCRYPTION: 'storeConfig.sseEncryption',
  S3_SSE_KMS_KEY_ID: 'storeConfig.sseKmsKeyId',
} as const

export type StateKey = (typeof STATE_KEYS)[keyof typeof STATE_KEYS]
