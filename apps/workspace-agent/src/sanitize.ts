/**
 * Input sanitization for owner and repo name segments.
 *
 * SECURITY: Both owner and repo are validated against a strict allowlist before
 * being used to construct filesystem paths or git URLs. This prevents path
 * traversal, shell injection, and URL manipulation attacks.
 */

/** Allowlist pattern: GitHub owner/repo names. */
const SAFE_SEGMENT_RE = /^[\w.-]+$/

/**
 * Sanitize a GitHub owner name.
 *
 * Returns the owner string if valid, or null if it should be rejected.
 * Rejects: empty strings, strings containing `/`, `\`, `..`, or any character
 * outside `[A-Za-z0-9._-]`. Also rejects bare `.` and `..`.
 * Allows `.github`, `repo.git`, etc. (GitHub repos can start with `.`).
 */
export function sanitizeOwner(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  if (raw.length === 0) return null
  // Reject bare dot and double-dot (path traversal sentinels).
  if (raw === '.' || raw === '..') return null
  if (raw.includes('..')) return null
  if (raw.includes('/')) return null
  if (raw.includes('\\')) return null
  if (SAFE_SEGMENT_RE.test(raw) === false) return null
  return raw
}

/**
 * Sanitize a GitHub repo name.
 *
 * Same rules as sanitizeOwner — GitHub repo names follow the same character set.
 */
export function sanitizeRepo(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  if (raw.length === 0) return null
  // Reject bare dot and double-dot (path traversal sentinels).
  if (raw === '.' || raw === '..') return null
  if (raw.includes('..')) return null
  if (raw.includes('/')) return null
  if (raw.includes('\\')) return null
  if (SAFE_SEGMENT_RE.test(raw) === false) return null
  return raw
}

/**
 * Validate the shape of an installation access token.
 *
 * GitHub installation access tokens start with `ghs_`. We do a minimal shape
 * check — we never log the token or include it in error responses.
 *
 * Returns true (and narrows to string) when the token is valid.
 */
export function validateTokenShape(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  if (raw.length === 0) return false
  // GitHub IATs are ghs_ prefixed and at least 20 chars total.
  // We keep this loose to avoid breaking on format changes, but we
  // do require the prefix as a basic sanity check.
  return raw.startsWith('ghs_') && raw.length >= 20
}
