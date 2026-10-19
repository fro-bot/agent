import type {ObjectStoreConfig} from '../shared/types.js'
import type {ObjectStoreSettingsInput, Sourced} from './settings.js'
import {describe, expect, it} from 'vitest'

import {DEFAULT_S3_PREFIX} from '../shared/constants.js'
import {parseObjectStoreSettings} from './settings.js'

function sourced(source: string, value: string | null = null): Sourced {
  return {value, source}
}

function makeInput(overrides: Partial<ObjectStoreSettingsInput> = {}): ObjectStoreSettingsInput {
  return {
    enabled: true,
    bucket: sourced('s3-bucket', 'my-bucket'),
    region: [sourced('aws-region', 'us-east-1')],
    endpoint: sourced('s3-endpoint'),
    allowInsecureEndpoint: false,
    prefix: sourced('s3-prefix'),
    sseEncryption: sourced('s3-sse-encryption'),
    sseKmsKeyId: sourced('s3-sse-kms-key-id'),
    expectedBucketOwner: sourced('s3-expected-bucket-owner'),
    ...overrides,
  }
}

function expectFailure(result: ReturnType<typeof parseObjectStoreSettings>): string {
  expect(result.success).toBe(false)
  if (result.success) {
    throw new Error('expected a failure result')
  }
  return result.error.message
}

function expectConfig(result: ReturnType<typeof parseObjectStoreSettings>): ObjectStoreConfig {
  expect(result.success).toBe(true)
  if (!result.success) {
    throw new Error(`expected a success result, got: ${result.error.message}`)
  }
  return result.data
}

describe('parseObjectStoreSettings', () => {
  describe('happy path', () => {
    it('maps every field into an ObjectStoreConfig with no extra keys', () => {
      // #given every setting is set and the store is enabled
      const input = makeInput({
        endpoint: sourced('s3-endpoint', 'https://s3.example.com'),
        allowInsecureEndpoint: true,
        prefix: sourced('s3-prefix', 'custom-prefix'),
        sseEncryption: sourced('s3-sse-encryption', 'aws:kms'),
        sseKmsKeyId: sourced('s3-sse-kms-key-id', 'kms-key-123'),
        expectedBucketOwner: sourced('s3-expected-bucket-owner', '123456789012'),
      })

      // #when the settings are parsed
      const config = expectConfig(parseObjectStoreSettings(input, {region: 'required'}))

      // #then the output is exactly an ObjectStoreConfig
      expect(config).toStrictEqual({
        enabled: true,
        bucket: 'my-bucket',
        region: 'us-east-1',
        prefix: 'custom-prefix',
        endpoint: 'https://s3.example.com',
        expectedBucketOwner: '123456789012',
        allowInsecureEndpoint: true,
        sseEncryption: 'aws:kms',
        sseKmsKeyId: 'kms-key-123',
      })
    })

    it('leaves optional fields absent when unset', () => {
      // #given only the required settings
      const input = makeInput()

      // #when the settings are parsed
      const config = expectConfig(parseObjectStoreSettings(input, {region: 'required'}))

      // #then optional keys are absent, not undefined
      expect(config).toStrictEqual({
        enabled: true,
        bucket: 'my-bucket',
        region: 'us-east-1',
        prefix: DEFAULT_S3_PREFIX,
        allowInsecureEndpoint: false,
      })
      expect(Object.keys(config)).not.toContain('endpoint')
      expect(Object.keys(config)).not.toContain('sseEncryption')
      expect(Object.keys(config)).not.toContain('sseKmsKeyId')
      expect(Object.keys(config)).not.toContain('expectedBucketOwner')
    })

    it('treats an empty string as unset', () => {
      // #given optional fields set to empty strings
      const input = makeInput({
        endpoint: sourced('s3-endpoint', ''),
        prefix: sourced('s3-prefix', ''),
        sseEncryption: sourced('s3-sse-encryption', ''),
        sseKmsKeyId: sourced('s3-sse-kms-key-id', ''),
        expectedBucketOwner: sourced('s3-expected-bucket-owner', ''),
      })

      // #when the settings are parsed
      const config = expectConfig(parseObjectStoreSettings(input, {region: 'required'}))

      // #then they behave as if they were null
      expect(config.prefix).toBe(DEFAULT_S3_PREFIX)
      expect(config).not.toHaveProperty('endpoint')
      expect(config).not.toHaveProperty('sseEncryption')
      expect(config).not.toHaveProperty('sseKmsKeyId')
      expect(config).not.toHaveProperty('expectedBucketOwner')
    })
  })

  describe('region', () => {
    it('uses the first candidate when several are set', () => {
      // #given two non-empty candidates
      const input = makeInput({
        region: [sourced('S3_REGION', 'eu-west-1'), sourced('AWS_REGION', 'us-east-1')],
      })

      // #when the settings are parsed
      const config = expectConfig(parseObjectStoreSettings(input, {region: 'required'}))

      // #then the first one wins
      expect(config.region).toBe('eu-west-1')
    })

    it('falls through an empty or null first candidate', () => {
      // #given the first candidates are empty and null
      const input = makeInput({
        region: [sourced('S3_REGION', ''), sourced('S3_REGION_ALT', null), sourced('AWS_REGION', 'us-east-1')],
      })

      // #when the settings are parsed
      const config = expectConfig(parseObjectStoreSettings(input, {region: 'required'}))

      // #then the first non-empty candidate is used
      expect(config.region).toBe('us-east-1')
    })

    it('passes with an empty result under optional and yields an empty region', () => {
      // #given no region candidate is set and region is optional
      const input = makeInput({region: [sourced('aws-region', '')]})

      // #when the settings are parsed
      const config = expectConfig(parseObjectStoreSettings(input, {region: 'optional'}))

      // #then the region is the empty string
      expect(config.region).toBe('')
    })

    it('fails under required when enabled and names every candidate source', () => {
      // #given no region candidate is set and region is required
      const input = makeInput({region: [sourced('S3_REGION (or S3_REGION_FILE)'), sourced('AWS_REGION')]})

      // #when the settings are parsed
      const message = expectFailure(parseObjectStoreSettings(input, {region: 'required'}))

      // #then the message names both sources
      expect(message).toContain('S3_REGION (or S3_REGION_FILE)')
      expect(message).toContain('AWS_REGION')
      expect(message).toContain('is required')
    })

    it('passes under required when the store is disabled', () => {
      // #given a disabled store with no region
      const input = makeInput({enabled: false, region: [sourced('S3_REGION'), sourced('AWS_REGION')]})

      // #when the settings are parsed
      const config = expectConfig(parseObjectStoreSettings(input, {region: 'required'}))

      // #then it passes with an empty region
      expect(config.enabled).toBe(false)
      expect(config.region).toBe('')
    })
  })

  describe('enabled checks', () => {
    it('fails on a missing bucket with a message starting with the source', () => {
      // #given an enabled store with no bucket
      const input = makeInput({bucket: sourced('s3-bucket', '')})

      // #when the settings are parsed
      const message = expectFailure(parseObjectStoreSettings(input, {region: 'required'}))

      // #then the message starts with the bucket source
      expect(message.startsWith('s3-bucket')).toBe(true)
      expect(message).toContain('is required')
    })

    it('fails on a null bucket', () => {
      // #given an enabled store with a null bucket
      const input = makeInput({bucket: sourced('S3_BUCKET', null)})

      // #when the settings are parsed
      const message = expectFailure(parseObjectStoreSettings(input, {region: 'required'}))

      // #then the message starts with the bucket source
      expect(message.startsWith('S3_BUCKET')).toBe(true)
    })

    it('rejects an http endpoint without the insecure flag', () => {
      // #given an http endpoint and no opt-in
      const input = makeInput({endpoint: sourced('s3-endpoint', 'http://minio.example.com:9000')})

      // #when the settings are parsed
      const message = expectFailure(parseObjectStoreSettings(input, {region: 'required'}))

      // #then the message starts with the endpoint source and keeps the rule text
      expect(message.startsWith('s3-endpoint')).toBe(true)
      expect(message).toContain('https')
    })

    it('accepts the same http endpoint with the insecure flag', () => {
      // #given the same endpoint with the opt-in
      const input = makeInput({
        endpoint: sourced('s3-endpoint', 'http://minio.example.com:9000'),
        allowInsecureEndpoint: true,
      })

      // #when the settings are parsed
      const config = expectConfig(parseObjectStoreSettings(input, {region: 'required'}))

      // #then it passes with the raw endpoint string
      expect(config.endpoint).toBe('http://minio.example.com:9000')
      expect(config.allowInsecureEndpoint).toBe(true)
    })

    it('rejects a metadata endpoint even with the insecure flag', () => {
      // #given a cloud-metadata endpoint with the opt-in
      const input = makeInput({
        endpoint: sourced('s3-endpoint', 'http://169.254.169.254'),
        allowInsecureEndpoint: true,
      })

      // #when the settings are parsed
      const message = expectFailure(parseObjectStoreSettings(input, {region: 'required'}))

      // #then it is still rejected
      expect(message.startsWith('s3-endpoint')).toBe(true)
      expect(message).toContain('cloud instance metadata services')
    })

    it('keeps the private-address rule text for a loopback endpoint', () => {
      // #given a loopback https endpoint without the opt-in
      const input = makeInput({endpoint: sourced('s3-endpoint', 'https://127.0.0.1')})

      // #when the settings are parsed
      const message = expectFailure(parseObjectStoreSettings(input, {region: 'required'}))

      // #then the pinned rule text survives
      expect(message).toContain('loopback, link-local, or private network addresses')
    })

    it('rejects a bad prefix with a message starting with the source', () => {
      // #given a traversal prefix
      const input = makeInput({prefix: sourced('s3-prefix', '../escape')})

      // #when the settings are parsed
      const message = expectFailure(parseObjectStoreSettings(input, {region: 'required'}))

      // #then the message starts with the prefix source and keeps the rule text
      expect(message.startsWith('s3-prefix')).toBe(true)
      expect(message).toContain('prefix')
    })
  })

  describe('KMS key', () => {
    it('is rejected with a custom endpoint and no SSE mode', () => {
      // #given a custom endpoint, no SSE mode (derived AES256) and a KMS key
      const input = makeInput({
        endpoint: sourced('s3-endpoint', 'https://s3.example.com'),
        sseKmsKeyId: sourced('S3_SSE_KMS_KEY_ID', 'kms-key-123'),
        sseEncryption: sourced('S3_SSE'),
      })

      // #when the settings are parsed
      const message = expectFailure(parseObjectStoreSettings(input, {region: 'required'}))

      // #then the message names the KMS source and the mode source
      expect(message.startsWith('S3_SSE_KMS_KEY_ID')).toBe(true)
      expect(message).toContain('S3_SSE')
      expect(message).toContain('aws:kms')
    })

    it('is rejected with an explicit AES256 mode', () => {
      // #given AES256 and a KMS key
      const input = makeInput({
        sseEncryption: sourced('s3-sse-encryption', 'AES256'),
        sseKmsKeyId: sourced('s3-sse-kms-key-id', 'kms-key-123'),
      })

      // #when the settings are parsed
      const message = expectFailure(parseObjectStoreSettings(input, {region: 'required'}))

      // #then the message names the KMS source
      expect(message.startsWith('s3-sse-kms-key-id')).toBe(true)
    })

    it('is accepted with aws:kms', () => {
      // #given aws:kms and a KMS key
      const input = makeInput({
        sseEncryption: sourced('s3-sse-encryption', 'aws:kms'),
        sseKmsKeyId: sourced('s3-sse-kms-key-id', 'kms-key-123'),
      })

      // #when the settings are parsed
      const config = expectConfig(parseObjectStoreSettings(input, {region: 'required'}))

      // #then both are kept
      expect(config.sseEncryption).toBe('aws:kms')
      expect(config.sseKmsKeyId).toBe('kms-key-123')
    })

    it('is accepted on AWS with no SSE mode (derived mode is aws:kms)', () => {
      // #given no endpoint, no SSE mode and a KMS key
      const input = makeInput({sseKmsKeyId: sourced('s3-sse-kms-key-id', 'kms-key-123')})

      // #when the settings are parsed
      const config = expectConfig(parseObjectStoreSettings(input, {region: 'required'}))

      // #then the key is kept and the mode stays absent
      expect(config.sseKmsKeyId).toBe('kms-key-123')
      expect(config).not.toHaveProperty('sseEncryption')
    })
  })

  describe('disabled store', () => {
    it('passes a bad endpoint, a bad prefix and a mismatched KMS key through unchecked', () => {
      // #given a disabled store with values that fail every enabled rule
      const input = makeInput({
        enabled: false,
        bucket: sourced('s3-bucket', ''),
        endpoint: sourced('s3-endpoint', 'http://169.254.169.254'),
        prefix: sourced('s3-prefix', '../escape'),
        sseEncryption: sourced('s3-sse-encryption', 'AES256'),
        sseKmsKeyId: sourced('s3-sse-kms-key-id', 'kms-key-123'),
      })

      // #when the settings are parsed
      const config = expectConfig(parseObjectStoreSettings(input, {region: 'required'}))

      // #then the trimmed values come back as given
      expect(config).toStrictEqual({
        enabled: false,
        bucket: '',
        region: 'us-east-1',
        prefix: '../escape',
        endpoint: 'http://169.254.169.254',
        allowInsecureEndpoint: false,
        sseEncryption: 'AES256',
        sseKmsKeyId: 'kms-key-123',
      })
    })

    it('uses the default prefix when the prefix is empty', () => {
      // #given a disabled store with no prefix
      const input = makeInput({enabled: false})

      // #when the settings are parsed
      const config = expectConfig(parseObjectStoreSettings(input, {region: 'optional'}))

      // #then the default prefix applies
      expect(config.prefix).toBe(DEFAULT_S3_PREFIX)
    })

    it('still rejects a bad SSE mode', () => {
      // #given a disabled store with an invalid SSE mode
      const input = makeInput({enabled: false, sseEncryption: sourced('s3-sse-encryption', 'aes256')})

      // #when the settings are parsed
      const message = expectFailure(parseObjectStoreSettings(input, {region: 'required'}))

      // #then the SSE rule still runs
      expect(message.startsWith('s3-sse-encryption')).toBe(true)
    })
  })

  describe('SSE mode', () => {
    it.each(['aws:kms', 'AES256'] as const)('accepts %s', mode => {
      // #given a valid mode
      const input = makeInput({sseEncryption: sourced('S3_SSE', mode)})

      // #when the settings are parsed
      const config = expectConfig(parseObjectStoreSettings(input, {region: 'required'}))

      // #then it is passed through
      expect(config.sseEncryption).toBe(mode)
    })

    it.each(['aes256', 'AWS:KMS', 'kms', 'none'])('rejects %s and names the source', mode => {
      // #given an invalid mode
      const input = makeInput({sseEncryption: sourced('S3_SSE', mode)})

      // #when the settings are parsed
      const message = expectFailure(parseObjectStoreSettings(input, {region: 'required'}))

      // #then the message starts with the source and lists the allowed values
      expect(message.startsWith('S3_SSE')).toBe(true)
      expect(message).toContain('aws:kms')
      expect(message).toContain('AES256')
    })

    it('leaves the field absent when unset', () => {
      // #given no SSE mode
      const input = makeInput()

      // #when the settings are parsed
      const config = expectConfig(parseObjectStoreSettings(input, {region: 'required'}))

      // #then the key is absent
      expect(config).not.toHaveProperty('sseEncryption')
    })
  })

  describe('prefix', () => {
    it.each([null, ''])('defaults to DEFAULT_S3_PREFIX when the prefix is %j', value => {
      // #given an unset prefix
      const input = makeInput({prefix: sourced('s3-prefix', value)})

      // #when the settings are parsed
      const config = expectConfig(parseObjectStoreSettings(input, {region: 'required'}))

      // #then the default applies
      expect(config.prefix).toBe(DEFAULT_S3_PREFIX)
    })
  })

  describe('no echo', () => {
    const cases: readonly {
      readonly name: string
      readonly secret: string
      readonly input: ObjectStoreSettingsInput
    }[] = [
      {
        name: 'bad endpoint scheme',
        secret: 'echo-marker-endpoint.example.com',
        input: makeInput({endpoint: sourced('s3-endpoint', 'http://echo-marker-endpoint.example.com:9000')}),
      },
      {
        name: 'embedded credentials in the endpoint',
        secret: 'echo-marker-password',
        input: makeInput({endpoint: sourced('s3-endpoint', 'https://user:echo-marker-password@s3.example.com')}),
      },
      {
        name: 'unparseable endpoint',
        secret: 'echo-marker-not-a-url',
        input: makeInput({endpoint: sourced('s3-endpoint', 'echo-marker-not-a-url')}),
      },
      {
        name: 'metadata endpoint with the flag',
        secret: '169.254.169.254',
        input: makeInput({
          endpoint: sourced('s3-endpoint', 'http://169.254.169.254/echo-marker-path'),
          allowInsecureEndpoint: true,
        }),
      },
      {
        name: 'bad prefix',
        secret: 'echo-marker-prefix/../x',
        input: makeInput({prefix: sourced('s3-prefix', 'echo-marker-prefix/../x')}),
      },
      {
        name: 'bad SSE mode',
        secret: 'echo-marker-mode',
        input: makeInput({sseEncryption: sourced('s3-sse-encryption', 'echo-marker-mode')}),
      },
      {
        name: 'mismatched KMS key',
        secret: 'echo-marker-kms-key',
        input: makeInput({
          sseEncryption: sourced('s3-sse-encryption', 'AES256'),
          sseKmsKeyId: sourced('s3-sse-kms-key-id', 'echo-marker-kms-key'),
        }),
      },
      {
        name: 'missing bucket with a secret-looking owner',
        secret: 'echo-marker-owner',
        input: makeInput({
          bucket: sourced('s3-bucket', null),
          expectedBucketOwner: sourced('s3-expected-bucket-owner', 'echo-marker-owner'),
        }),
      },
      {
        name: 'missing region with a secret-looking bucket',
        secret: 'echo-marker-bucket',
        input: makeInput({
          bucket: sourced('s3-bucket', 'echo-marker-bucket'),
          region: [sourced('aws-region', null)],
        }),
      },
    ]

    it.each(cases)('does not include the input value for $name', ({secret, input}) => {
      // #given a failing input carrying a distinctive value
      // #when the settings are parsed
      const message = expectFailure(parseObjectStoreSettings(input, {region: 'required'}))

      // #then the message never contains the value
      expect(message.length).toBeGreaterThan(0)
      expect(message).not.toContain(secret)
    })
  })
})
