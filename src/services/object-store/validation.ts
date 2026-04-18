import type {Result} from '../../shared/types.js'
import * as net from 'node:net'
import * as path from 'node:path'

import {err, ok} from '../../shared/types.js'
import {
  createPathTraversalError,
  createValidationError,
  type PathTraversalError,
  type ValidationError,
} from './types.js'

const PREFIX_PATTERN = /^[0-9a-z][\w.-]{0,63}$/i

function containsControlChars(value: string): boolean {
  return [...value].some(character => {
    const codePoint = character.codePointAt(0)

    return codePoint != null && (codePoint <= 0x1f || codePoint === 0x7f)
  })
}

function stripControlChars(value: string): string {
  return [...value]
    .filter(character => {
      const codePoint = character.codePointAt(0)

      return codePoint == null || (codePoint > 0x1f && codePoint !== 0x7f)
    })
    .join('')
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map(segment => Number.parseInt(segment, 10))

  if (octets.length !== 4 || octets.some(Number.isNaN)) {
    return false
  }

  const first = octets[0]
  const second = octets[1]

  if (first == null || second == null) {
    return false
  }

  if (first === 10 || first === 127 || (first === 169 && second === 254) || (first === 192 && second === 168)) {
    return true
  }

  return first === 172 && second >= 16 && second <= 31
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase()

  return (
    normalized === '::1' ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  )
}

function hasDisallowedAddress(hostname: string): boolean {
  if (hostname === 'localhost') {
    return true
  }

  const addressType = net.isIP(hostname)
  if (addressType === 4) {
    return isPrivateIpv4(hostname)
  }

  if (addressType === 6) {
    return isPrivateIpv6(hostname)
  }

  return false
}

// Cloud instance metadata service addresses must be blocked even when insecure endpoints
// are allowed — a leaked IAM role or SSRF via metadata service compromises the entire
// runner environment regardless of whether the endpoint is otherwise "trusted".
// This list is narrow by design: only exact metadata endpoints. Broader link-local and
// private ranges are still blocked by hasDisallowedAddress when the insecure flag is off.
function hasMetadataServiceAddress(hostname: string): boolean {
  const normalized = hostname.toLowerCase()

  if (normalized === '169.254.169.254' || normalized === 'metadata.google.internal') {
    return true
  }

  const addressType = net.isIP(normalized)
  if (addressType === 6) {
    return normalized === 'fd00:ec2::254'
  }

  return false
}

export function validateEndpoint(endpoint: string, allowInsecureEndpoint: boolean): Result<URL, ValidationError> {
  let parsedEndpoint: URL

  try {
    parsedEndpoint = new URL(endpoint)
  } catch {
    return err(createValidationError('s3 endpoint must be a valid URL'))
  }

  if (allowInsecureEndpoint === false && parsedEndpoint.protocol !== 'https:') {
    return err(createValidationError('s3 endpoint must use https unless insecure endpoints are explicitly allowed'))
  }

  if (hasMetadataServiceAddress(parsedEndpoint.hostname)) {
    return err(createValidationError('s3 endpoint must not target cloud instance metadata services'))
  }

  if (allowInsecureEndpoint === false && hasDisallowedAddress(parsedEndpoint.hostname)) {
    return err(createValidationError('s3 endpoint must not target loopback, link-local, or private network addresses'))
  }

  if (parsedEndpoint.username.length > 0 || parsedEndpoint.password.length > 0) {
    return err(createValidationError('s3 endpoint must not include embedded credentials'))
  }

  return ok(parsedEndpoint)
}

export function validatePrefix(prefix: string): Result<string, ValidationError> {
  const normalizedPrefix = prefix.trim()

  if (normalizedPrefix.length === 0) {
    return err(createValidationError('object store prefix cannot be empty'))
  }

  if (normalizedPrefix.includes('..') || normalizedPrefix.startsWith('/')) {
    return err(createValidationError('object store prefix must not contain traversal or absolute path markers'))
  }

  if (containsControlChars(normalizedPrefix)) {
    return err(createValidationError('object store prefix must not contain control characters'))
  }

  if (PREFIX_PATTERN.test(normalizedPrefix) === false) {
    return err(createValidationError('object store prefix must match the allowed naming pattern'))
  }

  return ok(normalizedPrefix)
}

export function sanitizeKeyComponent(value: string): Result<string, ValidationError> {
  if (value.includes('\0')) {
    return err(createValidationError('object store key components must not contain null bytes'))
  }

  const normalizedValue = stripControlChars(value).replaceAll('/', '-').replaceAll('\\', '-').trim()

  if (normalizedValue.length === 0) {
    return err(createValidationError('object store key components must not be empty'))
  }

  if (normalizedValue.includes('..')) {
    return err(createValidationError('object store key components must not contain traversal markers'))
  }

  return ok(normalizedValue)
}

export function validateDownloadPath(storagePath: string, relativePath: string): Result<string, PathTraversalError> {
  const resolvedStoragePath = path.resolve(storagePath)

  if (relativePath.includes('\0')) {
    return err(createPathTraversalError('download path must not contain null bytes'))
  }

  if (path.isAbsolute(relativePath)) {
    return err(createPathTraversalError('download path must be relative to the storage root'))
  }

  const resolvedLocalPath = path.resolve(resolvedStoragePath, relativePath)
  const storagePrefix = `${resolvedStoragePath}${path.sep}`

  if (resolvedLocalPath.startsWith(storagePrefix) === false) {
    return err(createPathTraversalError('download path escapes the storage root'))
  }

  return ok(resolvedLocalPath)
}
