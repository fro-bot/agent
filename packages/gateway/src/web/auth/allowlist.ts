/**
 * Operator allowlist authorization module.
 *
 * Loads a file-backed allowlist of stable numeric GitHub user IDs.
 * Authorization is fail-closed: missing/unreadable/empty/malformed allowlist
 * denies everyone.
 *
 * Security invariants:
 *   - Allowlist entries are stable numeric GitHub user IDs, not logins.
 *   - Login strings are never authoritative — only numeric IDs.
 *   - Authorization uses session-bound identity, never request headers.
 *   - Fail closed: any config/read failure denies everyone.
 *   - No session IDs, tokens, or credential values in audit records.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Logger interface for the allowlist module. */
export interface AllowlistLogger {
  readonly debug: (ctx: Record<string, unknown>, msg: string) => void
  readonly info: (ctx: Record<string, unknown>, msg: string) => void
  readonly warn: (ctx: Record<string, unknown>, msg: string) => void
  readonly error: (ctx: Record<string, unknown>, msg: string) => void
}

/** Parse result for allowlist text. */
export type ParseAllowlistResult =
  | {readonly ok: true; readonly ids: ReadonlySet<number>}
  | {readonly ok: false; readonly reason: string}

/** An operator allowlist — a set of authorized numeric GitHub user IDs. */
export interface OperatorAllowlist {
  /** Returns true if the given numeric GitHub user ID is in the allowlist. */
  readonly isAuthorized: (githubUserId: number) => boolean
  /** Number of entries in the allowlist. */
  readonly size: number
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse allowlist text into a set of numeric GitHub user IDs.
 *
 * Format:
 *   - One numeric user ID per line.
 *   - Lines starting with # are comments (ignored).
 *   - Blank lines and leading/trailing whitespace are ignored.
 *   - Any non-numeric, zero, or negative entry is a parse error.
 *   - An empty result (no IDs after filtering) is an error.
 *
 * Returns {ok: true, ids} on success, {ok: false, reason} on failure.
 */
export function parseAllowlistText(text: string): ParseAllowlistResult {
  const ids = new Set<number>()

  const lines = text.split('\n')
  for (const rawLine of lines) {
    const line = rawLine.trim()

    // Skip blank lines and comments
    if (line === '' || line.startsWith('#')) continue

    // Must be a positive integer
    if (/^\d+$/.test(line) === false) {
      return {ok: false, reason: `Non-numeric entry in allowlist: "${line}"`}
    }

    const id = Number.parseInt(line, 10)
    if (Number.isFinite(id) === false || Number.isInteger(id) === false || id <= 0) {
      return {ok: false, reason: `Invalid numeric ID in allowlist: "${line}"`}
    }

    if (Number.isSafeInteger(id) === false) {
      return {ok: false, reason: `Numeric ID exceeds safe integer range in allowlist: "${line}"`}
    }

    ids.add(id)
  }

  if (ids.size === 0) {
    return {ok: false, reason: 'Allowlist is empty — no authorized user IDs found'}
  }

  return {ok: true, ids}
}

// ---------------------------------------------------------------------------
// Deny-all sentinel
// ---------------------------------------------------------------------------

/** A deny-all allowlist returned when the allowlist is missing/malformed/empty. */
const DENY_ALL: OperatorAllowlist = {
  isAuthorized: () => false,
  size: 0,
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Load an operator allowlist from raw text content.
 *
 * Fail-closed: if the text is empty, malformed, or contains no valid IDs,
 * returns a deny-all allowlist and logs a warning.
 *
 * The caller is responsible for reading the file; this function only parses.
 */
export function loadAllowlistFromText(text: string, logger: AllowlistLogger): OperatorAllowlist {
  const result = parseAllowlistText(text)

  if (result.ok === false) {
    logger.warn({}, `operator allowlist: fail-closed — ${result.reason}`)
    return DENY_ALL
  }

  const ids = result.ids
  return {
    isAuthorized: (githubUserId: number) => ids.has(githubUserId),
    size: ids.size,
  }
}
