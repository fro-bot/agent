/**
 * Env and `_FILE` secret readers shared by the gateway config and the backfill runner.
 *
 * Precedence for a name `X`: a `X_FILE` that points at a readable file decides the value. A blank file (empty or
 * whitespace-only) is an explicit opt-out: the reader returns null (or reports a missing secret) and does not
 * consult the `X` env var, so a stale env value can never bring back a secret an operator emptied. A `X_FILE` path
 * that does not exist falls through to the `X` env var.
 *
 * The object-store settings are the one exception; they defer a blank file to env through `isSecretFileBlank` and
 * `readEnvSecret` (see `object-store-config.ts`).
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

/** The error text for a required secret that is unset, or whose `_FILE` is blank. */
export function missingSecretMessage(name: string): string {
  return `Missing required secret: ${name} (set ${name} env var or ${name}_FILE pointing to a file)`
}

/**
 * Read a required secret by name.
 *
 * Precedence:
 * 1. If `${name}_FILE` is set AND that file exists → its trailing-trimmed contents. A blank file is a missing secret;
 *    the env var is not consulted.
 * 2. Else if `process.env[name]` is non-blank → return it
 * 3. Else throw with a clear message
 */
export function readSecret(name: string): string {
  const value = readOptionalSecret(name)
  if (value === null) {
    throw new Error(missingSecretMessage(name))
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
    throw new Error(missingSecretMessage(name))
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
    if (contents !== undefined) {
      const trimmed = contents.trimEnd()
      if (trimmed.trim() === '') return null
      return trimmed
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
    if (contents !== undefined) {
      // Strip only trailing whitespace (newline/spaces from echo) so leading whitespace
      // in valid secrets is preserved — matching the env-var path which uses raw process.env[name].
      // Treat whitespace-only or empty files as "not set" (e.g. empty bind-mounted optional secrets). The env var
      // is not consulted: an emptied file is an explicit opt-out.
      const trailingTrimmed = contents.trimEnd()
      if (trailingTrimmed.trim() === '') return null
      if (/[\r\n\u0085\u2028\u2029]/.test(trailingTrimmed)) {
        throw new Error(
          `Secret value at ${filePath} contains embedded line-breaking characters — likely a copy-paste with line-wrapping. Remove the line break and rewrite the file as a single line.`,
        )
      }
      return trailingTrimmed
    }
  }

  return readEnvSecret(name)
}

/**
 * Read a single-line value from the `name` env var only, ignoring any `${name}_FILE`. Returns null when it is unset or
 * blank, and rejects embedded line breaks.
 */
export function readEnvSecret(name: string): string | null {
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

/**
 * Whether `${name}_FILE` points at an existing file that is empty or whitespace-only. Uses the same hardened file read
 * as the secret readers (symlinks, non-regular files and oversize files throw). Returns false when no file is
 * configured or the path does not exist.
 */
export function isSecretFileBlank(name: string): boolean {
  const filePath = process.env[`${name}_FILE`]
  if (filePath === undefined) {
    return false
  }

  try {
    return readSecretFile(filePath).trim() === ''
  } catch (error) {
    if (error instanceof SecretFileNotFoundError) {
      return false
    }
    throw error
  }
}
