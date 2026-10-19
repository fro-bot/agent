import type {ReservedAddressClass} from '../net/ip-classification.js'
import type {Result} from '../shared/types.js'
import * as net from 'node:net'
import * as path from 'node:path'
import {classifyReservedIpv4, classifyReservedIpv6} from '../net/ip-classification.js'
import {err, ok} from '../shared/types.js'
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

/**
 * WHATWG `URL.hostname` keeps the brackets on an IPv6 literal (`[::1]`), and `net.isIP` returns 0 for a bracketed
 * string, so the brackets must come off before the address is recognized or classified.
 */
function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

function classifyHostname(hostname: string): ReservedAddressClass | null {
  // A trailing dot is a valid FQDN root marker that still resolves (`%2e` decodes to it through WHATWG), so drop one
  // before any name or address check. The IP and name comparisons below never carry it.
  const unbracketed = stripIpv6Brackets(hostname.toLowerCase())
  const normalized = unbracketed.endsWith('.') ? unbracketed.slice(0, -1) : unbracketed

  if (normalized === 'metadata.google.internal') {
    return 'metadata'
  }

  if (normalized === 'localhost' || normalized.endsWith('.localhost')) {
    return 'internal'
  }

  const addressType = net.isIP(normalized)
  if (addressType === 4) {
    return classifyReservedIpv4(normalized)
  }

  if (addressType === 6) {
    return classifyReservedIpv6(normalized)
  }

  return null
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

  const addressClass = classifyHostname(parsedEndpoint.hostname)

  if (addressClass === 'metadata') {
    // Cloud instance metadata service addresses must be blocked even when insecure endpoints
    // are allowed — a leaked IAM role or SSRF via metadata service compromises the entire
    // runner environment regardless of whether the endpoint is otherwise "trusted".
    return err(createValidationError('s3 endpoint must not target cloud instance metadata services'))
  }

  if (allowInsecureEndpoint === false && addressClass === 'internal') {
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
