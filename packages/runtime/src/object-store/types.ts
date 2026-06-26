import type {Result} from '../shared/types.js'

export type {ObjectStoreConfig} from '../shared/types.js'

export type ContentType = 'artifacts' | 'bindings' | 'locks' | 'metadata' | 'runs' | 'sessions'

export interface ObjectStoreAdapter {
  readonly upload: (key: string, localPath: string) => Promise<Result<void, Error>>
  readonly download: (key: string, localPath: string) => Promise<Result<void, Error>>
  readonly list: (prefix: string) => Promise<Result<string[], Error>>
  readonly conditionalPut?: (
    key: string,
    data: string,
    options: {ifNoneMatch?: string; ifMatch?: string},
  ) => Promise<Result<{etag: string}, Error>>
  readonly conditionalDelete?: (key: string, options: {ifMatch: string}) => Promise<Result<void, Error>>
  readonly getObject?: (key: string) => Promise<Result<{data: string; etag: string}, Error>>
  /** Returns keys with their S3 LastModified timestamps for recency-bounded scans. */
  readonly listWithMetadata?: (
    prefix: string,
  ) => Promise<Result<readonly {readonly key: string; readonly lastModified: Date}[], Error>>
}

export interface ValidationError extends Error {
  readonly code: 'OBJECT_STORE_VALIDATION_ERROR'
}

export interface PathTraversalError extends Error {
  readonly code: 'OBJECT_STORE_PATH_TRAVERSAL_ERROR'
}

export interface ObjectStoreOperationError extends Error {
  readonly code: 'OBJECT_STORE_OPERATION_ERROR'
  readonly errorCode?: string
  // errorName is the AWS SDK v3 field (error.name) — present when errorCode (error.Code) is absent.
  // Both are threaded through logS3Error in s3-adapter.ts so isNotFound can use either.
  readonly errorName?: string
  readonly httpStatusCode?: number
}

export function createValidationError(message: string): ValidationError {
  return Object.assign(new Error(message), {code: 'OBJECT_STORE_VALIDATION_ERROR' as const})
}

export function createPathTraversalError(message: string): PathTraversalError {
  return Object.assign(new Error(message), {code: 'OBJECT_STORE_PATH_TRAVERSAL_ERROR' as const})
}

export function createObjectStoreOperationError(
  message: string,
  details?: {readonly errorCode?: string; readonly errorName?: string; readonly httpStatusCode?: number},
): ObjectStoreOperationError {
  // Attach each structured key only when defined so that 'errorCode' in error === false
  // for single-arg callers (e.g. internal sanity checks without S3 context).
  return Object.assign(new Error(message), {
    code: 'OBJECT_STORE_OPERATION_ERROR' as const,
    ...(details?.errorCode !== undefined && {errorCode: details.errorCode}),
    ...(details?.errorName !== undefined && {errorName: details.errorName}),
    ...(details?.httpStatusCode !== undefined && {httpStatusCode: details.httpStatusCode}),
  })
}
