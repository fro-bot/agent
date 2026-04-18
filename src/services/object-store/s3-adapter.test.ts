import type {Logger} from '../../shared/logger.js'
import type {ObjectStoreConfig} from './types.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {Readable} from 'node:stream'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {createS3Adapter} from './s3-adapter.js'

const clientConfigs: unknown[] = []
const sentCommands: unknown[] = []
const sendMock = vi.fn()

vi.mock('@aws-sdk/client-s3', () => {
  class MockS3Client {
    constructor(config: unknown) {
      clientConfigs.push(config)
    }

    async send(command: unknown): Promise<unknown> {
      sentCommands.push(command)
      return sendMock(command)
    }
  }

  class MockPutObjectCommand {
    readonly input: unknown

    constructor(input: unknown) {
      this.input = input
    }
  }

  class MockGetObjectCommand {
    readonly input: unknown

    constructor(input: unknown) {
      this.input = input
    }
  }

  class MockListObjectsV2Command {
    readonly input: unknown

    constructor(input: unknown) {
      this.input = input
    }
  }

  return {
    S3Client: MockS3Client,
    PutObjectCommand: MockPutObjectCommand,
    GetObjectCommand: MockGetObjectCommand,
    ListObjectsV2Command: MockListObjectsV2Command,
  }
})

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

function getCommandInput(callIndex: number): Record<string, unknown> {
  const command = sentCommands[callIndex]

  if (typeof command !== 'object' || command == null || 'input' in command === false) {
    throw new Error('Expected mocked AWS command with input payload')
  }

  const {input} = command

  if (typeof input !== 'object' || input == null) {
    throw new Error('Expected mocked AWS command input object')
  }

  return input as Record<string, unknown>
}

const baseConfig: ObjectStoreConfig = {
  enabled: true,
  bucket: 'test-bucket',
  region: 'us-east-1',
  prefix: 'fro-bot-state',
}

describe('createS3Adapter', () => {
  let tempDir: string

  beforeEach(async () => {
    clientConfigs.length = 0
    sentCommands.length = 0
    sendMock.mockReset()
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'object-store-'))
  })

  afterEach(async () => {
    await fs.rm(tempDir, {recursive: true, force: true})
  })

  it('configures a custom HTTPS endpoint with path-style access', async () => {
    // #given
    const logger = createLogger()

    // #when
    createS3Adapter({...baseConfig, endpoint: 'https://example.r2.cloudflarestorage.com'}, logger)

    // #then
    expect(clientConfigs).toHaveLength(1)
    expect(clientConfigs[0]).toMatchObject({
      endpoint: 'https://example.r2.cloudflarestorage.com',
      forcePathStyle: true,
      region: 'us-east-1',
    })
  })

  it('uses default AWS endpoint settings when no custom endpoint is provided', async () => {
    // #given
    const logger = createLogger()

    // #when
    createS3Adapter(baseConfig, logger)

    // #then
    expect(clientConfigs).toHaveLength(1)
    expect(clientConfigs[0]).toMatchObject({region: 'us-east-1'})
    expect(clientConfigs[0]).not.toMatchObject({forcePathStyle: true})
  })

  it('defaults to aws:kms when no custom endpoint is set', async () => {
    // #given
    sendMock.mockResolvedValue({})
    const logger = createLogger()
    const adapter = createS3Adapter(baseConfig, logger)
    const localPath = path.join(tempDir, 'opencode.db')
    await fs.writeFile(localPath, 'db-bytes')

    // #when
    const result = await adapter.upload('fro-bot-state/github/owner/repo/sessions/opencode.db', localPath)

    // #then
    expect(result.success).toBe(true)
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(getCommandInput(0)).toMatchObject({
      Bucket: 'test-bucket',
      Key: 'fro-bot-state/github/owner/repo/sessions/opencode.db',
      ServerSideEncryption: 'aws:kms',
    })
  })

  it('defaults to AES256 when custom endpoint is set', async () => {
    // #given
    sendMock.mockResolvedValue({})
    const logger = createLogger()
    const adapter = createS3Adapter({...baseConfig, endpoint: 'https://example.r2.cloudflarestorage.com'}, logger)
    const localPath = path.join(tempDir, 'opencode.db')
    await fs.writeFile(localPath, 'db-bytes')

    // #when
    const result = await adapter.upload('fro-bot-state/github/owner/repo/sessions/opencode.db', localPath)

    // #then
    expect(result.success).toBe(true)
    expect(getCommandInput(0)).toMatchObject({ServerSideEncryption: 'AES256'})
  })

  it('respects explicit sseEncryption equals AES256 override even without custom endpoint', async () => {
    // #given
    sendMock.mockResolvedValue({})
    const logger = createLogger()
    const adapter = createS3Adapter({...baseConfig, sseEncryption: 'AES256'}, logger)
    const localPath = path.join(tempDir, 'opencode.db')
    await fs.writeFile(localPath, 'db-bytes')

    // #when
    const result = await adapter.upload('fro-bot-state/github/owner/repo/sessions/opencode.db', localPath)

    // #then
    expect(result.success).toBe(true)
    expect(getCommandInput(0)).toMatchObject({ServerSideEncryption: 'AES256'})
  })

  it('respects explicit sseEncryption equals aws:kms override even with custom endpoint', async () => {
    // #given
    sendMock.mockResolvedValue({})
    const logger = createLogger()
    const adapter = createS3Adapter(
      {...baseConfig, endpoint: 'https://example.r2.cloudflarestorage.com', sseEncryption: 'aws:kms'},
      logger,
    )
    const localPath = path.join(tempDir, 'opencode.db')
    await fs.writeFile(localPath, 'db-bytes')

    // #when
    const result = await adapter.upload('fro-bot-state/github/owner/repo/sessions/opencode.db', localPath)

    // #then
    expect(result.success).toBe(true)
    expect(getCommandInput(0)).toMatchObject({ServerSideEncryption: 'aws:kms'})
  })

  it('includes SSEKMSKeyId when sseEncryption equals aws:kms and sseKmsKeyId is set', async () => {
    // #given
    sendMock.mockResolvedValue({})
    const logger = createLogger()
    const adapter = createS3Adapter({...baseConfig, sseEncryption: 'aws:kms', sseKmsKeyId: 'kms-key-123'}, logger)
    const localPath = path.join(tempDir, 'opencode.db')
    await fs.writeFile(localPath, 'db-bytes')

    // #when
    const result = await adapter.upload('fro-bot-state/github/owner/repo/sessions/opencode.db', localPath)

    // #then
    expect(result.success).toBe(true)
    expect(getCommandInput(0)).toMatchObject({
      SSEKMSKeyId: 'kms-key-123',
      ServerSideEncryption: 'aws:kms',
    })
  })

  it('omits SSEKMSKeyId when sseEncryption equals AES256 even if sseKmsKeyId is set', async () => {
    // #given
    sendMock.mockResolvedValue({})
    const logger = createLogger()
    const adapter = createS3Adapter({...baseConfig, sseEncryption: 'AES256', sseKmsKeyId: 'kms-key-123'}, logger)
    const localPath = path.join(tempDir, 'opencode.db')
    await fs.writeFile(localPath, 'db-bytes')

    // #when
    const result = await adapter.upload('fro-bot-state/github/owner/repo/sessions/opencode.db', localPath)

    // #then
    expect(result.success).toBe(true)
    expect(getCommandInput(0)).toMatchObject({ServerSideEncryption: 'AES256'})
    expect(getCommandInput(0)).not.toHaveProperty('SSEKMSKeyId')
  })

  it('sets ExpectedBucketOwner when configured', async () => {
    // #given
    sendMock.mockResolvedValue({})
    const logger = createLogger()
    const adapter = createS3Adapter({...baseConfig, expectedBucketOwner: '123456789012'}, logger)
    const localPath = path.join(tempDir, 'opencode.db')
    await fs.writeFile(localPath, 'db-bytes')

    // #when
    const result = await adapter.upload('fro-bot-state/github/owner/repo/sessions/opencode.db', localPath)

    // #then
    expect(result.success).toBe(true)
    expect(getCommandInput(0)).toMatchObject({ExpectedBucketOwner: '123456789012'})
  })

  it('redacts signed S3 errors before logging and returns an error result', async () => {
    // #given
    const logger = createLogger()
    const localPath = path.join(tempDir, 'opencode.db')
    await fs.writeFile(localPath, 'db-bytes')
    sendMock.mockRejectedValue(
      Object.assign(new Error('request failed X-Amz-Signature=abc123 Authorization=Bearer secret-token'), {
        Code: 'AccessDenied',
        $metadata: {httpStatusCode: 403},
        name: 'S3ServiceException',
      }),
    )
    const adapter = createS3Adapter(baseConfig, logger)

    // #when
    const result = await adapter.upload('fro-bot-state/github/owner/repo/sessions/opencode.db', localPath)

    // #then
    expect(result.success).toBe(false)
    expect(logger.warning).toHaveBeenCalledTimes(1)
    const context = vi.mocked(logger.warning).mock.calls[0]?.[1]
    expect(context).toMatchObject({
      errorCode: 'AccessDenied',
      errorName: 'S3ServiceException',
      httpStatusCode: 403,
    })
    expect(String(context?.message)).not.toContain('abc123')
    expect(String(context?.message)).not.toContain('secret-token')
  })

  it('lists all keys under a prefix across paginated responses', async () => {
    // #given
    sendMock
      .mockResolvedValueOnce({
        Contents: [{Key: 'fro-bot-state/github/owner/repo/sessions/opencode.db'}],
        IsTruncated: true,
        NextContinuationToken: 'page-2',
      })
      .mockResolvedValueOnce({
        Contents: [{Key: 'fro-bot-state/github/owner/repo/sessions/opencode.db-wal'}],
        IsTruncated: false,
      })
    const logger = createLogger()
    const adapter = createS3Adapter(baseConfig, logger)

    // #when
    const result = await adapter.list('fro-bot-state/github/owner/repo/sessions/')

    // #then
    expect(result.success).toBe(true)
    expect(result.success && result.data).toEqual([
      'fro-bot-state/github/owner/repo/sessions/opencode.db',
      'fro-bot-state/github/owner/repo/sessions/opencode.db-wal',
    ])
    expect(sendMock).toHaveBeenCalledTimes(2)
    expect(getCommandInput(1)).toMatchObject({ContinuationToken: 'page-2'})
  })

  it('downloads objects without throwing on S3 errors', async () => {
    // #given
    sendMock.mockResolvedValue({Body: Readable.from(['downloaded bytes'])})
    const logger = createLogger()
    const adapter = createS3Adapter(baseConfig, logger)
    const localPath = path.join(tempDir, 'downloaded.db')

    // #when
    const result = await adapter.download('fro-bot-state/github/owner/repo/sessions/opencode.db', localPath)

    // #then
    expect(result.success).toBe(true)
    await expect(fs.readFile(localPath, 'utf8')).resolves.toBe('downloaded bytes')
  })
})
