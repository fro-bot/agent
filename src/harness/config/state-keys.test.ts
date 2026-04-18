import type {StateKey} from './state-keys.js'
import {describe, expect, it} from 'vitest'
import {STATE_KEYS} from './state-keys.js'

describe('state-keys', () => {
  describe('STATE_KEYS', () => {
    it('contains shouldSaveCache key', () => {
      expect(STATE_KEYS.SHOULD_SAVE_CACHE).toBe('shouldSaveCache')
    })

    it('contains sessionId key', () => {
      expect(STATE_KEYS.SESSION_ID).toBe('sessionId')
    })

    it('contains cacheSaved key', () => {
      expect(STATE_KEYS.CACHE_SAVED).toBe('cacheSaved')
    })

    it('contains opencodeVersion key', () => {
      expect(STATE_KEYS.OPENCODE_VERSION).toBe('opencodeVersion')
    })

    it('contains artifactUploaded key', () => {
      expect(STATE_KEYS.ARTIFACT_UPLOADED).toBe('artifactUploaded')
    })

    it('contains object store config state keys', () => {
      expect(STATE_KEYS.S3_ENABLED).toBe('storeConfig.enabled')
      expect(STATE_KEYS.S3_BUCKET).toBe('storeConfig.bucket')
      expect(STATE_KEYS.S3_REGION).toBe('storeConfig.region')
      expect(STATE_KEYS.S3_PREFIX).toBe('storeConfig.prefix')
      expect(STATE_KEYS.S3_ENDPOINT).toBe('storeConfig.endpoint')
      expect(STATE_KEYS.S3_EXPECTED_BUCKET_OWNER).toBe('storeConfig.expectedBucketOwner')
      expect(STATE_KEYS.S3_ALLOW_INSECURE_ENDPOINT).toBe('storeConfig.allowInsecureEndpoint')
      expect(STATE_KEYS.S3_SSE_ENCRYPTION).toBe('storeConfig.sseEncryption')
      expect(STATE_KEYS.S3_SSE_KMS_KEY_ID).toBe('storeConfig.sseKmsKeyId')
    })

    it('has correct number of keys', () => {
      expect(Object.keys(STATE_KEYS)).toHaveLength(14)
    })

    it('values are string type compatible', () => {
      const key: StateKey = STATE_KEYS.SHOULD_SAVE_CACHE
      expect(typeof key).toBe('string')
    })
  })
})
