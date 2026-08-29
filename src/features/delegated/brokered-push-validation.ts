import type {BrokeredPushAllowlist} from '@fro-bot/runtime'
import type {FileChange} from './types.js'

import {
  BROKERED_PUSH_PROTECTED_SURFACES,
  hasProtectedSegment,
  isBrokeredPushProtectedPrefix,
  isCanonicalBrokeredPushPath,
  matchesBrokeredPushPrefix,
  normalizeBrokeredPushPrefix,
} from '../../shared/brokered-push-paths.js'
import {validateFiles} from './commit.js'

const BROKERED_PUSH_ALLOWED_PATH_DEFINITIONS = [
  {defaultPath: 'src/', pattern: /^src\//},
  {defaultPath: 'packages/*/src/', pattern: /^packages\/[^/]+\/src\//},
  {defaultPath: 'docs/', pattern: /^docs\//},
] as const
export const BROKERED_PUSH_ALLOWED_PATHS = BROKERED_PUSH_ALLOWED_PATH_DEFINITIONS.map(definition => definition.pattern)
export const BROKERED_PUSH_ALLOWED_ROOT_FILES: ReadonlySet<string> = new Set([
  'README.md',
  'ARCHITECTURE.md',
  'STRUCTURE.md',
])
export const MAX_BROKERED_PUSH_FILES = 100

export function createBrokeredPushAllowlist(extraPrefixes: readonly string[] = []): BrokeredPushAllowlist {
  return {
    defaultPaths: BROKERED_PUSH_ALLOWED_PATH_DEFINITIONS.map(definition => definition.defaultPath),
    rootFiles: [...BROKERED_PUSH_ALLOWED_ROOT_FILES],
    extraPrefixes: [...extraPrefixes],
  }
}

export function serializeBrokeredPushAllowlist(allowlist: BrokeredPushAllowlist): string {
  return JSON.stringify(allowlist)
}

export type BrokeredPushValidationResult =
  | {readonly valid: true; readonly errors: readonly []}
  | {readonly valid: false; readonly errors: readonly string[]; readonly paths: readonly string[]}

function protectedSurfaceForPrefix(prefix: string): string | null {
  try {
    const normalizedPrefix = normalizeBrokeredPushPrefix(prefix)
    if (isBrokeredPushProtectedPrefix(normalizedPrefix) === false) {
      return null
    }

    for (const surface of BROKERED_PUSH_PROTECTED_SURFACES) {
      const isDockerfileVariant =
        surface === 'Dockerfile' &&
        (normalizedPrefix.toLowerCase() === 'dockerfile' || normalizedPrefix.toLowerCase().startsWith('dockerfile.'))
      if (
        matchesBrokeredPushPrefix(normalizedPrefix, surface) ||
        matchesBrokeredPushPrefix(surface, normalizedPrefix)
      ) {
        return surface
      }
      if (isDockerfileVariant) {
        return surface
      }
    }

    return normalizedPrefix
  } catch {
    // Enforcement is fail-closed for callers that bypass the input parser.
    return prefix
  }
}

function matchesExtraPrefix(path: string, prefix: string): boolean {
  try {
    return matchesBrokeredPushPrefix(path, prefix)
  } catch {
    return false
  }
}

/**
 * Validate file changes for brokered push delivery.
 *
 * Brokered pushes are limited to product, package source, documentation, and
 * the explicitly allowlisted top-level project documents. The shared delegated
 * validation remains responsible for path traversal, sensitive paths, and size.
 */
export function validateBrokeredPushFiles(
  files: readonly FileChange[],
  extraPrefixes: readonly string[] = [],
): BrokeredPushValidationResult {
  const validation = validateFiles(files)
  const errors = [...validation.errors]
  const paths = new Set<string>()

  for (const prefix of extraPrefixes) {
    const protectedSurface = protectedSurfaceForPrefix(prefix)
    if (protectedSurface != null) {
      errors.push(`${prefix}: path prefix overlaps protected brokered-push surface ${protectedSurface}`)
    }
  }

  if (files.length > MAX_BROKERED_PUSH_FILES) {
    errors.push(`Brokered push exceeds the maximum of ${MAX_BROKERED_PUSH_FILES} files`)
  }

  for (const file of files) {
    if (validateFiles([file]).valid === false) {
      paths.add(file.path)
    }

    const allowedByDefault =
      BROKERED_PUSH_ALLOWED_ROOT_FILES.has(file.path) ||
      BROKERED_PUSH_ALLOWED_PATHS.some(pattern => pattern.test(file.path))
    const allowedByExtra = extraPrefixes.some(prefix => matchesExtraPrefix(file.path, prefix))
    const allowed = allowedByDefault || allowedByExtra

    if (isCanonicalBrokeredPushPath(file.path) === false) {
      errors.push(`${file.path}: path is not canonical for brokered push`)
      paths.add(file.path)
    }

    if (allowed === false) {
      errors.push(`${file.path}: path is not allowed for brokered push`)
      paths.add(file.path)
    } else if (allowedByDefault === false && allowedByExtra && hasProtectedSegment(file.path)) {
      errors.push(`${file.path}: path is within a protected brokered-push surface`)
      paths.add(file.path)
    }
  }

  if (errors.length === 0) {
    return {valid: true, errors: []}
  }

  return {valid: false, errors, paths: [...paths]}
}
