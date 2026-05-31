/**
 * Configuration for the workspace-agent.
 *
 * Secret reading follows the same hardened pattern as packages/gateway/src/config.ts:
 * - `${NAME}_FILE` env → read file via O_NOFOLLOW fd, fstat check, size cap
 * - `process.env[NAME]` fallback
 * - Never log the value
 */

import {closeSync, constants, fstatSync, openSync, readFileSync} from 'node:fs'
import process from 'node:process'

const MAX_SECRET_BYTES = 4096

class SecretFileNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretFileNotFoundError'
  }
}

/**
 * Read a secret file with hardened path validation. Uses `openSync` with
 * `O_NOFOLLOW` so symlinks fail at open (no TOCTOU window between validation
 * and read), then `fstatSync` on the already-open file descriptor to confirm
 * the file is a regular file under the size limit.
 */
function readSecretFile(filePath: string): string {
  let fd: number
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      if (error.code === 'ENOENT') {
        throw new SecretFileNotFoundError(`Secret file does not exist: ${filePath}`)
      }
      if (error.code === 'ELOOP') {
        throw new Error(
          `Secret path is not a regular file: ${filePath} (got symlink). Symlinks are not supported — bind-mount a real file.`,
        )
      }
    }
    throw error
  }
  try {
    const stat = fstatSync(fd)
    if (stat.isFile() === false) {
      const kind = describeStatKind(stat)
      throw new Error(
        `Secret path is not a regular file: ${filePath} (got ${kind}). FIFOs, devices, and directories are not supported.`,
      )
    }
    if (stat.size > MAX_SECRET_BYTES) {
      throw new Error(`Secret file is too large: ${filePath} (${stat.size} bytes > ${MAX_SECRET_BYTES} byte limit).`)
    }
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

function describeStatKind(stat: import('node:fs').Stats): string {
  if (stat.isSymbolicLink()) return 'symlink'
  if (stat.isFIFO()) return 'FIFO/pipe'
  if (stat.isCharacterDevice()) return 'character device'
  if (stat.isBlockDevice()) return 'block device'
  if (stat.isDirectory()) return 'directory'
  if (stat.isSocket()) return 'socket'
  return 'unknown non-file'
}

/**
 * Read an optional secret by name.
 *
 * Precedence:
 * 1. If `${name}_FILE` env var is set AND that file exists → read file contents, trim trailing whitespace
 * 2. Else if `process.env[name]` is set → return it
 * 3. Else return null
 */
export function readOptionalSecret(name: string): string | null {
  const filePath = process.env[`${name}_FILE`]
  if (filePath !== undefined) {
    let contents: string | undefined
    try {
      contents = readSecretFile(filePath)
    } catch (error) {
      if (error instanceof SecretFileNotFoundError) {
        // file not present; fall through to env-var fallback
      } else {
        throw error
      }
    }
    if (contents !== undefined) {
      const trailingTrimmed = contents.trimEnd()
      if (trailingTrimmed.trim() === '') return null
      if (/[\r\n\u0085\u2028\u2029]/.test(trailingTrimmed)) {
        throw new Error(
          `Secret value at ${filePath} contains embedded line-breaking characters. Remove the line break and rewrite the file as a single line.`,
        )
      }
      return trailingTrimmed
    }
  }

  const value = process.env[name]
  if (value !== undefined && value.trim() !== '') {
    if (/[\r\n\u0085\u2028\u2029]/.test(value)) {
      throw new Error(
        `Environment variable ${name} contains embedded line-breaking characters. Remove the line break and set it as a single line.`,
      )
    }
    return value
  }

  return null
}

/**
 * Read a required secret by name. Throws if missing.
 */
export function readSecret(name: string): string {
  const value = readOptionalSecret(name)
  if (value === null) {
    throw new Error(`Missing required secret: ${name} (set ${name} env var or ${name}_FILE pointing to a file)`)
  }
  return value
}
