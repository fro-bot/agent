/**
 * formatPipelineError — single-line, length-capped, secret-redacting error formatter.
 *
 * Applied at every runIntegration failure boundary so no raw error message
 * (which may contain tokens, credentials, or multi-line stack traces) escapes
 * into the integrate-command output.
 *
 * Redaction rules:
 *   - GitHub token shapes: ghp_…, gho_…, ghu_…, ghs_…, ghr_…, github_pat_…
 *   - URL credentials: scheme://user:secret@host → scheme://<redacted>@host
 *
 * No classes; functions only; explicit boolean checks; no as-any.
 */

/** Maximum length of the formatted error message (characters). */
export const FORMAT_ERROR_MAX_LENGTH = 300

/** Placeholder substituted for each redacted secret. */
const REDACTED = '[REDACTED]'

/** Ellipsis appended when the message is truncated. */
const ELLIPSIS = '...'

/**
 * Redacts known secret shapes from a string.
 *
 * Handles:
 *   - GitHub token prefixes: ghp_, gho_, ghu_, ghs_, ghr_, github_pat_
 *   - URL credentials: scheme://user:secret@host
 */
export function redactSecrets(text: string): string {
  // Redact GitHub token shapes (prefix + non-whitespace run).
  // Order matters: github_pat_ must come before the shorter ghs_/ghp_/etc. prefixes
  // to avoid a partial match leaving "github_pat_" with the suffix redacted separately.
  // No leading word boundary: the prefix is already a strong anchor, and omitting it
  // keeps redaction fail-safe for tokens glued to a preceding character.
  let result = text.replaceAll(/github_pat_\S+/g, REDACTED)
  result = result.replaceAll(/ghp_\S+/g, REDACTED)
  result = result.replaceAll(/gho_\S+/g, REDACTED)
  result = result.replaceAll(/ghu_\S+/g, REDACTED)
  result = result.replaceAll(/ghs_\S+/g, REDACTED)
  result = result.replaceAll(/ghr_\S+/g, REDACTED)

  // Redact URL credentials: scheme://user:secret@host → scheme://[REDACTED]@host
  // Use a greedy match up to the last '@' before the host (stops at whitespace).
  // This handles passwords containing '@' (e.g. https://user:my@secret@host).
  result = result.replaceAll(/([a-z][a-z\d+\-.]*:\/\/)(?:[^@\s]+@)+/gi, `$1${REDACTED}@`)

  return result
}

/**
 * Formats an unknown error value into a single-line, length-capped, secret-redacted string.
 *
 * Steps:
 *   1. Coerce to a message string (Error.message or String()).
 *   2. Collapse newlines / carriage returns to "; ".
 *   3. Redact known secret shapes.
 *   4. Cap to FORMAT_ERROR_MAX_LENGTH characters, appending "..." if truncated.
 *
 * Never throws; always returns a non-empty string.
 */
export function formatPipelineError(err: unknown): string {
  // Step 1: coerce to string
  let msg: string
  if (err instanceof Error) {
    msg = err.message
  } else if (typeof err === 'string') {
    msg = err
  } else if (err === null || err === undefined) {
    msg = 'unknown error'
  } else {
    msg = String(err)
  }

  if (msg.length === 0) {
    msg = 'unknown error'
  }

  // Step 2: collapse newlines
  msg = msg.replaceAll(/[\r\n]+/g, '; ')

  // Step 3: redact secrets
  msg = redactSecrets(msg)

  // Step 4: cap length
  if (msg.length > FORMAT_ERROR_MAX_LENGTH) {
    msg = msg.slice(0, FORMAT_ERROR_MAX_LENGTH - ELLIPSIS.length) + ELLIPSIS
  }

  return msg
}
