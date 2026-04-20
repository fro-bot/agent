import type {Result} from '../../../../src/shared/types.js'

export type {ObjectStoreConfig} from '../../../../src/shared/types.js'

export type ContentType = 'artifacts' | 'metadata' | 'sessions'

export interface ObjectStoreAdapter {
  readonly upload: (key: string, localPath: string) => Promise<Result<void, Error>>
  readonly download: (key: string, localPath: string) => Promise<Result<void, Error>>
  readonly list: (prefix: string) => Promise<Result<string[], Error>>
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
