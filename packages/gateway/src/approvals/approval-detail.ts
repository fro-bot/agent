/**
 * Approval detail bounding helper.
 *
 * Applied at the SSE frame-build site before the value is serialised
 * into an ApprovalFrame. The parser (coordinator.ts) keeps raw values so the
 * Discord transport is unaffected.
 *
 * Guarantees:
 *  - Length-capped at APPROVAL_DETAIL_MAX_LENGTH (~4 KB).
 *  - Control characters stripped (U+0000–U+001F, U+007F) so the value cannot
 *    inject ANSI escapes, newlines, or other hostile sequences into an SSE frame.
 *  - JSON-safe: the result round-trips through JSON.stringify/parse unchanged
 *    (quotes and backslashes are left as-is; JSON.stringify handles them).
 */

/** Maximum byte/character length for a bounded approval detail value (~4 KB). */
export const APPROVAL_DETAIL_MAX_LENGTH = 4096

/**
 * Bound an approval detail value (command or filepath) for safe inclusion in
 * an SSE frame or JSON response.
 *
 * - Returns `undefined` when the input is `undefined` (or null-ish).
 * - Returns an empty string for an empty string input.
 * - Strips control characters (U+0000–U+001F inclusive, U+007F DEL).
 * - Truncates to `APPROVAL_DETAIL_MAX_LENGTH` characters after stripping.
 *
 * The caller (frame-build site) is responsible for omitting the field when the
 * result is `undefined`.
 */
export function boundApprovalDetail(value: string | undefined): string | undefined {
  // Treat null-ish as absent (defensive — the type says string|undefined but
  // untrusted callers may pass null).
  if (value == null) return undefined

  // Strip control characters: U+0000–U+001F (includes \t, \n, \r) and U+007F.
  // eslint-disable-next-line no-control-regex
  const stripped = value.replaceAll(/[\u0000-\u001F\u007F]/g, '')

  // Length-cap after stripping (stripping can only shorten, never lengthen).
  return stripped.length > APPROVAL_DETAIL_MAX_LENGTH ? stripped.slice(0, APPROVAL_DETAIL_MAX_LENGTH) : stripped
}
