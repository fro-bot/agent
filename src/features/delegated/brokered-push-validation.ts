import type {FileChange} from './types.js'

import {
  BROKERED_PUSH_PROTECTED_SURFACES,
  isBrokeredPushProtectedPrefix,
  matchesBrokeredPushPrefix,
} from '../../shared/brokered-push-paths.js'
import {validateFiles} from './commit.js'

const BROKERED_PUSH_ALLOWED_PATHS = [/^src\//, /^packages\/[^/]+\/src\//, /^docs\//]
const BROKERED_PUSH_ALLOWED_ROOT_FILES = new Set(['README.md', 'ARCHITECTURE.md', 'STRUCTURE.md'])
export const MAX_BROKERED_PUSH_FILES = 100

export type BrokeredPushValidationResult =
  | {readonly valid: true; readonly errors: readonly []}
  | {readonly valid: false; readonly errors: readonly string[]; readonly paths: readonly string[]}

function protectedSurfaceForPrefix(prefix: string): string | null {
  try {
    for (const surface of BROKERED_PUSH_PROTECTED_SURFACES) {
      if (matchesBrokeredPushPrefix(prefix, surface) || matchesBrokeredPushPrefix(surface, prefix)) {
        return surface
      }
    }

    // The shared policy also covers Dockerfile variants, which are not a
    // segment-boundary match of the bare Dockerfile surface.
    return isBrokeredPushProtectedPrefix(prefix) ? prefix : null
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

    const allowed =
      BROKERED_PUSH_ALLOWED_ROOT_FILES.has(file.path) ||
      BROKERED_PUSH_ALLOWED_PATHS.some(pattern => pattern.test(file.path)) ||
      extraPrefixes.some(prefix => matchesExtraPrefix(file.path, prefix))

    if (allowed === false) {
      errors.push(`${file.path}: path is not allowed for brokered push`)
      paths.add(file.path)
    }
  }

  if (errors.length === 0) {
    return {valid: true, errors: []}
  }

  return {valid: false, errors, paths: [...paths]}
}
