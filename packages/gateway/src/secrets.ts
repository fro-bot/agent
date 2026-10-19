/**
 * Env and `_FILE` secret readers shared by the gateway config and the backfill runner.
 *
 * Precedence for a name `X`: a non-empty file at `X_FILE` wins, then the `X` env var. An empty or whitespace-only
 * file counts as unset and falls through to the env var; a missing file does too.
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
 *
 * Throws on:
 * - ENOENT: file does not exist (SecretFileNotFoundError — callers can catch
 *   this specifically to fall through to env-var fallbacks)
 * - Symlink (ELOOP from openSync with O_NOFOLLOW)
 * - Not a regular file: FIFOs, devices, directories (rejected after fstat)
 * - Size > MAX_SECRET_BYTES: prevents memory exhaustion
 *
 * The 4096-byte limit is generous for any reasonable secret. AWS keys are
 * typically <50 bytes; Discord tokens are <100; OAuth refresh tokens are
 * occasionally larger but well under 4KB.
 *
 * Note: O_NOFOLLOW is a POSIX extension supported on Linux and macOS. On
 * Windows (where Node's openSync silently ignores the flag), symlinks fall
 * through to the fstat-based rejection — same outcome, just at a later check.
 */
function readSecretFile(filePath: string): string {
  let fd: number
  try {
    // O_NOFOLLOW: open fails immediately if path is a symlink (Linux/macOS).
    // This removes the lstat-then-read TOCTOU window — we can never race on a
    // symlink swap because the open() syscall itself refuses to follow.
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      if (error.code === 'ENOENT') {
        throw new SecretFileNotFoundError(`Secret file does not exist: ${filePath}`)
      }
      if (error.code === 'ELOOP') {
        // O_NOFOLLOW path-is-symlink rejection on Linux/macOS
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
        `Secret path is not a regular file: ${filePath} (got ${kind}). FIFOs, devices, and directories are not supported — bind-mount a real file.`,
      )
    }
    if (stat.size > MAX_SECRET_BYTES) {
      throw new Error(
        `Secret file is too large: ${filePath} (${stat.size} bytes > ${MAX_SECRET_BYTES} byte limit). Secrets should be a single value on a single line.`,
      )
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
 * Read a required secret by name.
 *
 * Precedence:
 * 1. If `${name}_FILE` env var is set AND that file exists → read file contents, trim trailing whitespace
 * 2. Else if `process.env[name]` is set → return it
 * 3. Else throw with a clear message
 */
export function readSecret(name: string): string {
  const value = readOptionalSecret(name)
  if (value === null) {
    throw new Error(`Missing required secret: ${name} (set ${name} env var or ${name}_FILE pointing to a file)`)
  }
  return value
}

/**
 * Read a required secret that may contain embedded newlines (e.g. PEM private keys).
 *
 * Same precedence as `readSecret` but skips the line-break rejection check.
 * Only use for secrets where multi-line content is expected and valid.
 */
export function readMultilineSecret(name: string): string {
  const value = readOptionalMultilineSecret(name)
  if (value === null) {
    throw new Error(`Missing required secret: ${name} (set ${name} env var or ${name}_FILE pointing to a file)`)
  }
  return value
}

/**
 * Read an optional secret that may contain embedded newlines (e.g. PEM private keys).
 *
 * Same precedence as `readOptionalSecret` but skips the line-break rejection check.
 */
export function readOptionalMultilineSecret(name: string): string | null {
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
    // An empty or whitespace-only file counts as unset, so it falls through to the env var below.
    if (contents !== undefined && contents.trim() !== '') {
      return contents.trimEnd()
    }
  }

  const value = process.env[name]
  if (value !== undefined && value.trim() !== '') {
    return value
  }

  return null
}

/**
 * Read an optional secret by name.
 *
 * Same precedence as `readSecret` but returns `null` instead of throwing.
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
    // Treat whitespace-only or empty files as "not set" (e.g. empty bind-mounted optional secrets). They fall
    // through to the env var below, so an empty `touch`ed file never shadows a value set in the environment.
    if (contents !== undefined && contents.trim() !== '') {
      // Strip only trailing whitespace (newline/spaces from echo) so leading whitespace
      // in valid secrets is preserved — matching the env-var path which uses raw process.env[name].
      const trailingTrimmed = contents.trimEnd()
      if (/[\r\n\u0085\u2028\u2029]/.test(trailingTrimmed)) {
        throw new Error(
          `Secret value at ${filePath} contains embedded line-breaking characters — likely a copy-paste with line-wrapping. Remove the line break and rewrite the file as a single line.`,
        )
      }
      return trailingTrimmed
    }
  }

  const value = process.env[name]
  if (value !== undefined && value.trim() !== '') {
    if (/[\r\n\u0085\u2028\u2029]/.test(value)) {
      throw new Error(
        `Environment variable ${name} contains embedded line-breaking characters — likely a copy-paste with line-wrapping. Remove the line break and set it as a single line.`,
      )
    }
    return value
  }

  return null
}
