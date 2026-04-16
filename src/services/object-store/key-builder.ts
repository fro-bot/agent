import type {Result} from '../../shared/types.js'
import type {ContentType, ObjectStoreConfig, ValidationError} from './types.js'

import {err, ok} from '../../shared/types.js'
import {sanitizeKeyComponent, validatePrefix} from './validation.js'

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

  const sanitizedRepo = sanitizeKeyComponent(repo)
  if (sanitizedRepo.success === false) {
    return err(sanitizedRepo.error)
  }

  const baseKey = `${validatedPrefix.data}/${sanitizedIdentity.data}/${sanitizedRepo.data}/${contentType}`

  if (suffix == null) {
    return ok(`${baseKey}/`)
  }

  const sanitizedSuffix = sanitizeKeyComponent(suffix)
  if (sanitizedSuffix.success === false) {
    return err(sanitizedSuffix.error)
  }

  return ok(`${baseKey}/${sanitizedSuffix.data}`)
}
