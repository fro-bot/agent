import type {Result} from '../../shared/types.js'
import type {ContentType, ObjectStoreConfig, ValidationError} from './types.js'

import {err, ok} from '../../shared/types.js'
import {createValidationError} from './types.js'
import {sanitizeKeyComponent, validatePrefix} from './validation.js'

function splitRepoPath(repo: string): Result<readonly string[], ValidationError> {
  const trimmed = repo.trim()
  if (trimmed.length === 0) {
    return err(createValidationError('repository path must not be empty'))
  }

  const segments = trimmed.split('/').filter(segment => segment.length > 0)
  if (segments.length === 0 || segments.length > 2) {
    return err(createValidationError('repository path must be "owner/repo" or a single component'))
  }

  return ok(segments)
}

export function buildObjectStoreKey(
  config: ObjectStoreConfig,
  identity: string,
  repo: string,
  contentType: ContentType,
  suffix?: string,
): Result<string, ValidationError> {
  const validatedPrefix = validatePrefix(config.prefix)
  if (validatedPrefix.success === false) {
    return err(validatedPrefix.error)
  }

  const sanitizedIdentity = sanitizeKeyComponent(identity)
  if (sanitizedIdentity.success === false) {
    return err(sanitizedIdentity.error)
  }

  const repoSegments = splitRepoPath(repo)
  if (repoSegments.success === false) {
    return err(repoSegments.error)
  }

  const sanitizedRepoSegments: string[] = []
  for (const segment of repoSegments.data) {
    const sanitized = sanitizeKeyComponent(segment)
    if (sanitized.success === false) {
      return err(sanitized.error)
    }
    sanitizedRepoSegments.push(sanitized.data)
  }

  const repoPath = sanitizedRepoSegments.join('/')
  const baseKey = `${validatedPrefix.data}/${sanitizedIdentity.data}/${repoPath}/${contentType}`

  if (suffix == null) {
    return ok(`${baseKey}/`)
  }

  const sanitizedSuffix = sanitizeKeyComponent(suffix)
  if (sanitizedSuffix.success === false) {
    return err(sanitizedSuffix.error)
  }

  return ok(`${baseKey}/${sanitizedSuffix.data}`)
}
