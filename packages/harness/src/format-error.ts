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
export const FORMAT_ERROR_MAX_LENGTH = 2000

/** Placeholder substituted for each redacted secret. */
const REDACTED = '[REDACTED]'

/** Ellipsis appended when the message is truncated. */
const ELLIPSIS = '...'

/** A character that may appear in a URL scheme after its first letter: `[a-z\d+\-.]` (ASCII, case-insensitive). */
function isSchemeCharCode(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x2b || // +
    code === 0x2d || // -
    code === 0x2e // .
  )
}

/** An ASCII letter, the only character a scheme may start with: `[a-z]` under the `i` flag. */
function isLetterCode(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a)
}

/**
 * One credential segment body: a (possibly empty) run of characters that are neither `@` nor whitespace. Sticky so
 * each probe starts exactly at `lastIndex`; reusing the engine's own `\s` keeps the Unicode whitespace set identical
 * to the original pattern.
 */
const CREDENTIAL_SEGMENT_BODY = /[^@\s]*/y

/**
 * Redacts URL credentials — `scheme://user:secret@host` → `scheme://[REDACTED]@host` — in linear time.
 *
 * This is the exact semantics of the former pattern `/([a-z][a-z\d+\-.]*:\/\/)(?:[^@\s]+@)+/gi`, which was
 * quadratic in two ways a backtracking regex cannot express away:
 *   1. With no anchor on where a scheme starts, every letter of a long scheme-legal run was retried and each attempt
 *      scanned to the end of the run.
 *   2. Even with that anchored, each `://` re-scanned the rest of its whitespace-free word looking for an `@`;
 *      `x://x://x://…` (no `@`) re-scans the same tail once per `://`, and a regex engine cannot memoize that.
 *
 * Instead, find each `://` and work outward:
 *   - Scheme (leftward): the maximal `[a-z\d+\-.]` run ending at `://`. The original leftmost match starts at the
 *     FIRST LETTER of that run (earlier digits/`+`/`-`/`.` stay outside the match), so a run with no letter never
 *     matches. (A plain `(?<![a-z\d+\-.])` lookbehind would wrongly reject `1http://u:p@h`.)
 *   - Credentials (rightward): a chain of `[^@\s]+@` segments, consumed greedily; the match ends after the last `@`
 *     reached with every segment non-empty. The chain is deterministic — there is never anything to backtrack into.
 *   - Memo: a segment scan that ends at whitespace/end-of-string saw no `@` in its span, so any later `://` whose
 *     credentials start inside that span fails identically and is skipped without re-scanning (`noAtBefore`).
 * Every character is examined a constant number of times.
 */
function redactUrlCredentials(text: string): string {
  const length = text.length
  let output = ''
  let copiedUpTo = 0 // text[0, copiedUpTo) is already accounted for in `output`
  let searchFrom = 0
  let noAtBefore = 0 // credentials starting at p <= noAtBefore are known to fail (no `@` before whitespace/end)

  while (searchFrom < length) {
    const delimiter = text.indexOf('://', searchFrom)
    if (delimiter === -1) break
    searchFrom = delimiter + 1

    const credentialsStart = delimiter + 3
    if (credentialsStart <= noAtBefore) continue

    // Scheme: leftward over the maximal scheme-character run, then to the first letter within it.
    let runStart = delimiter
    while (runStart > copiedUpTo && isSchemeCharCode(text.charCodeAt(runStart - 1))) runStart -= 1
    let schemeStart = runStart
    while (schemeStart < delimiter && !isLetterCode(text.charCodeAt(schemeStart))) schemeStart += 1
    if (schemeStart === delimiter) continue

    // Credentials: chain of non-empty `[^@\s]+@` segments.
    let matchEnd = credentialsStart
    let segmentStart = credentialsStart
    let chained = false
    for (;;) {
      CREDENTIAL_SEGMENT_BODY.lastIndex = segmentStart
      CREDENTIAL_SEGMENT_BODY.exec(text)
      const segmentEnd = CREDENTIAL_SEGMENT_BODY.lastIndex
      const stoppedAtAt = segmentEnd < length && text.charCodeAt(segmentEnd) === 0x40
      if (segmentEnd > segmentStart && stoppedAtAt) {
        matchEnd = segmentEnd + 1
        segmentStart = matchEnd
        chained = true
        continue
      }
      // Stopped at whitespace/end: no `@` lies in [segmentStart, segmentEnd), so later `://` inside it must fail too.
      if (!stoppedAtAt) noAtBefore = segmentEnd
      break
    }
    if (!chained) continue

    // Keep everything before the match, the scheme and `://` verbatim (the replacement was `$1[REDACTED]@`).
    output += `${text.slice(copiedUpTo, credentialsStart)}${REDACTED}@`
    copiedUpTo = matchEnd
    searchFrom = matchEnd
  }

  return copiedUpTo === 0 ? text : output + text.slice(copiedUpTo)
}

/**
 * Redacts known secret shapes from a string.
 *
 * Handles:
 *   - GitHub token prefixes: ghp_, gho_, ghu_, ghs_, ghr_, github_pat_
 *   - URL credentials: scheme://user:secret@host
 *
 * Runs in time linear in the input length: each token pattern is a literal prefix followed by one `\S+` run (no
 * nested quantifiers, nothing to backtrack into), and URL credentials use the scanner above.
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
  // Greedy through the last '@' of the chain (stops at whitespace), so passwords containing '@'
  // (e.g. https://user:my@secret@host) are fully covered.
  return redactUrlCredentials(result)
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
