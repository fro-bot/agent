import type {Logger} from '../shared/logger.js'
import {Buffer} from 'node:buffer'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

import {err, ok} from '../shared/types.js'
import {createObjectStoreOperationError, type ObjectStoreAdapter, type ObjectStoreConfig} from './types.js'

function sanitizeS3ErrorMessage(message: string): string {
  return message
    .replaceAll(/X-Amz-[A-Za-z0-9-]+=[^&\s]+/g, 'X-Amz-REDACTED=[REDACTED]')
    .replaceAll(/Authorization([:=]\s*)(Bearer\s+)?[^,\s]+/gi, 'Authorization$1$2[REDACTED]')
    .slice(0, 500)
}

function logS3Error(logger: Logger, operation: string, error: unknown): Error {
  const errorCode = typeof error === 'object' && error != null && 'Code' in error ? String(error.Code) : undefined
  const errorName = error instanceof Error ? error.name : 'UnknownError'
  const httpStatusCode =
    typeof error === 'object' &&
    error != null &&
    '$metadata' in error &&
    typeof error.$metadata === 'object' &&
    error.$metadata != null &&
    'httpStatusCode' in error.$metadata
      ? Number(error.$metadata.httpStatusCode)
      : undefined
  const message = sanitizeS3ErrorMessage(error instanceof Error ? error.message : String(error))

  logger.warning(`Object store ${operation} failed`, {
    errorCode,
    errorName,
    httpStatusCode,
    message,
  })

  return createObjectStoreOperationError(`Object store ${operation} failed: ${message}`)
}

async function readResponseBody(body: unknown): Promise<string> {
  if (body instanceof Readable) {
    const chunks: Buffer[] = []
    for await (const chunk of body) {
      if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk))
        continue
      }

      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
    }

    return Buffer.concat(chunks).toString('utf8')
  }

  if (typeof body === 'object' && body != null && 'transformToString' in body) {
    const transformToString = body.transformToString
    if (typeof transformToString === 'function') {
      return String(await transformToString.call(body))
    }
  }

  throw createObjectStoreOperationError('Object store getObject failed: response body was not readable')
}

function normalizeEtag(etag: string | undefined, operation: string): string {
  if (etag == null || etag.length === 0) {
    throw createObjectStoreOperationError(`Object store ${operation} failed: missing ETag in response`)
  }

  return etag
}

const S3_MAX_ATTEMPTS = 3
const S3_LIST_MAX_ITERATIONS = 100

function toRegion(config: ObjectStoreConfig): string | undefined {
  return config.region.length > 0 ? config.region : undefined
}

function createClient(config: ObjectStoreConfig): S3Client {
  const maxAttempts = S3_MAX_ATTEMPTS
  const region = toRegion(config)

  if (config.endpoint != null) {
    return new S3Client({
      endpoint: config.endpoint,
      forcePathStyle: true,
      maxAttempts,
      region,
    })
  }

  return new S3Client({maxAttempts, region})
}

function getEffectiveEncryption(config: ObjectStoreConfig): 'AES256' | 'aws:kms' {
  if (config.sseEncryption != null) {
    return config.sseEncryption
  }

  if (config.endpoint != null) {
    return 'AES256'
  }

  return 'aws:kms'
}

export function createS3Adapter(config: ObjectStoreConfig, logger: Logger): ObjectStoreAdapter {
  const client = createClient(config)
  const effectiveEncryption = getEffectiveEncryption(config)

  return {
    upload: async (key, localPath) => {
      logger.debug('Uploading object store file', {key, localPath})

      try {
        const commandInput: {
          Body: fs.ReadStream
          Bucket: string
          ExpectedBucketOwner?: string
          Key: string
          ServerSideEncryption: 'AES256' | 'aws:kms'
          SSEKMSKeyId?: string
        } = {
          Body: fs.createReadStream(localPath),
          Bucket: config.bucket,
          ExpectedBucketOwner: config.expectedBucketOwner,
          Key: key,
          ServerSideEncryption: effectiveEncryption,
        }

        if (effectiveEncryption === 'aws:kms' && config.sseKmsKeyId != null) {
          commandInput.SSEKMSKeyId = config.sseKmsKeyId
        }

        const command = new PutObjectCommand({
          ...commandInput,
        })

        await client.send(command)
        logger.info('Uploaded object store file', {key})
        return ok(undefined)
      } catch (error) {
        return err(logS3Error(logger, 'upload', error))
      }
    },
    download: async (key, localPath) => {
      logger.debug('Downloading object store file', {key, localPath})

      try {
        await fsp.mkdir(path.dirname(localPath), {recursive: true})
        const response = await client.send(
          new GetObjectCommand({
            Bucket: config.bucket,
            ExpectedBucketOwner: config.expectedBucketOwner,
            Key: key,
          }),
        )

        if (response.Body instanceof Readable === false) {
          return err(createObjectStoreOperationError('Object store download failed: response body was not readable'))
        }

        await pipeline(response.Body, fs.createWriteStream(localPath))
        logger.info('Downloaded object store file', {key, localPath})
        return ok(undefined)
      } catch (error) {
        return err(logS3Error(logger, 'download', error))
      }
    },
    list: async prefix => {
      logger.debug('Listing object store keys', {prefix})

      try {
        const keys: string[] = []
        let continuationToken: string | undefined
        let iterations = 0

        do {
          if (iterations >= S3_LIST_MAX_ITERATIONS) {
            logger.warning('Object store list hit iteration cap, truncating result', {
              prefix,
              maxIterations: S3_LIST_MAX_ITERATIONS,
              keysReturned: keys.length,
            })
            break
          }
          iterations++

          const response = await client.send(
            new ListObjectsV2Command({
              Bucket: config.bucket,
              ContinuationToken: continuationToken,
              ExpectedBucketOwner: config.expectedBucketOwner,
              Prefix: prefix,
            }),
          )

          for (const object of response.Contents ?? []) {
            if (object.Key != null) {
              keys.push(object.Key)
            }
          }

          continuationToken = response.IsTruncated === true ? response.NextContinuationToken : undefined
        } while (continuationToken != null)

        logger.info('Listed object store keys', {count: keys.length, prefix})
        return ok(keys)
      } catch (error) {
        return err(logS3Error(logger, 'list', error))
      }
    },
    conditionalPut: async (key, data, options) => {
      logger.debug('Conditionally uploading object store data', {key, options})

      try {
        const response = await client.send(
          new PutObjectCommand({
            Body: data,
            Bucket: config.bucket,
            ExpectedBucketOwner: config.expectedBucketOwner,
            IfMatch: options.ifMatch,
            IfNoneMatch: options.ifNoneMatch,
            Key: key,
            ServerSideEncryption: effectiveEncryption,
            ...(effectiveEncryption === 'aws:kms' && config.sseKmsKeyId != null
              ? {SSEKMSKeyId: config.sseKmsKeyId}
              : {}),
          }),
        )

        const etag = normalizeEtag(response.ETag, 'conditionalPut')
        logger.info('Conditionally uploaded object store data', {key, etag})
        return ok({etag})
      } catch (error) {
        return err(logS3Error(logger, 'conditionalPut', error))
      }
    },
    conditionalDelete: async (key, options) => {
      logger.debug('Conditionally deleting object store data', {key})

      try {
        await client.send(
          new DeleteObjectCommand({
            Bucket: config.bucket,
            ExpectedBucketOwner: config.expectedBucketOwner,
            IfMatch: options.ifMatch,
            Key: key,
          }),
        )

        logger.info('Conditionally deleted object store data', {key})
        return ok(undefined)
      } catch (error) {
        return err(logS3Error(logger, 'conditionalDelete', error))
      }
    },
    getObject: async key => {
      logger.debug('Reading object store data', {key})

      try {
        const response = await client.send(
          new GetObjectCommand({
            Bucket: config.bucket,
            ExpectedBucketOwner: config.expectedBucketOwner,
            Key: key,
          }),
        )

        const data = await readResponseBody(response.Body)
        const etag = normalizeEtag(response.ETag, 'getObject')
        logger.info('Read object store data', {key, etag})
        return ok({data, etag})
      } catch (error) {
        return err(logS3Error(logger, 'getObject', error))
      }
    },
  }
}
