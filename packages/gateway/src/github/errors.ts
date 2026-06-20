/**
 * Shared error utilities for gateway GitHub API interactions.
 *
 * FIX 10: Extracted from metadata-reader.ts, reader-app-client.ts, and app-client.ts
 * to eliminate duplication and prevent drift.
 */

// ---------------------------------------------------------------------------
// safeErrorMessage
// ---------------------------------------------------------------------------

/**
 * Extract a safe error message that cannot contain sensitive material.
 *
 * Strips PEM blocks and JWT-shaped strings before returning the message.
 * This is a defence-in-depth measure — callers should never pass raw auth
 * material into error constructors, but this catches accidental leakage.
 */
export function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'unknown error'
  }
  // Strip PEM blocks
  let msg = error.message.replaceAll(/-----BEGIN[^-]+-----[\s\S]*?-----END[^-]+-----/g, '[REDACTED]')
  // Strip JWT-shaped strings (three base64url segments)
  msg = msg.replaceAll(/[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, '[REDACTED]')
  return msg
}

// ---------------------------------------------------------------------------
// isOctokitNotFound
// ---------------------------------------------------------------------------

/**
 * Check whether an Octokit request error is a 404 / not-found.
 *
 * @octokit/request-error sets `status` on the error object.
 * Falls back to message pattern matching for non-Octokit errors.
 */
export function isOctokitNotFound(error: unknown): boolean {
  if (error instanceof Error) {
    const status = (error as {status?: number}).status
    if (status === 404) return true
    if (/not.?found|404/i.test(error.message)) return true
  }
  return false
}
