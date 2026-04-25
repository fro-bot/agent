import type {Result} from '../shared/types.js'

export type {ObjectStoreConfig} from '../shared/types.js'

export type ContentType = 'artifacts' | 'locks' | 'metadata' | 'runs' | 'sessions'

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
}

export interface ValidationError extends Error {
  readonly code: 'OBJECT_STORE_VALIDATION_ERROR'
}

export interface PathTraversalError extends Error {
  readonly code: 'OBJECT_STORE_PATH_TRAVERSAL_ERROR'
}

export interface ObjectStoreOperationError extends Error {
  readonly code: 'OBJECT_STORE_OPERATION_ERROR'
}

export function createValidationError(message: string): ValidationError {
  return Object.assign(new Error(message), {code: 'OBJECT_STORE_VALIDATION_ERROR' as const})
}

export function createPathTraversalError(message: string): PathTraversalError {
  return Object.assign(new Error(message), {code: 'OBJECT_STORE_PATH_TRAVERSAL_ERROR' as const})
}

export function createObjectStoreOperationError(message: string): ObjectStoreOperationError {
  return Object.assign(new Error(message), {code: 'OBJECT_STORE_OPERATION_ERROR' as const})
}
