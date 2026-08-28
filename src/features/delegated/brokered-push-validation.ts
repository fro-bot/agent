import type {FileChange} from './types.js'

import {validateFiles} from './commit.js'

const BROKERED_PUSH_ALLOWED_PATHS = [/^src\//, /^packages\/[^/]+\/src\//, /^docs\//]
const BROKERED_PUSH_ALLOWED_ROOT_FILES = new Set(['README.md', 'ARCHITECTURE.md', 'STRUCTURE.md'])
export const MAX_BROKERED_PUSH_FILES = 100

export type BrokeredPushValidationResult =
  | {readonly valid: true; readonly errors: readonly []}
  | {readonly valid: false; readonly errors: readonly string[]; readonly paths: readonly string[]}

/**
 * Validate file changes for brokered push delivery.
 *
 * Brokered pushes are limited to product, package source, documentation, and
 * the explicitly allowlisted top-level project documents. The shared delegated
 * validation remains responsible for path traversal, sensitive paths, and size.
 */
export function validateBrokeredPushFiles(files: readonly FileChange[]): BrokeredPushValidationResult {
  const validation = validateFiles(files)
  const errors = [...validation.errors]
  const paths = new Set<string>()

  if (files.length > MAX_BROKERED_PUSH_FILES) {
    errors.push(`Brokered push exceeds the maximum of ${MAX_BROKERED_PUSH_FILES} files`)
  }

  for (const file of files) {
    if (validateFiles([file]).valid === false) {
      paths.add(file.path)
    }

    const allowed =
      BROKERED_PUSH_ALLOWED_ROOT_FILES.has(file.path) ||
      BROKERED_PUSH_ALLOWED_PATHS.some(pattern => pattern.test(file.path))

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
