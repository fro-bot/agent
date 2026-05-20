const FAKE_TOKEN_PATTERN = /^(?:test-token-fake|fake-token|mock-token|test)(?:[^a-z0-9]|$)/i

/**
 * Refuses to let the gateway test suite run with what looks like a real Discord token.
 *
 * Accepts:
 *  - undefined (env var unset)
 *  - empty string
 *  - a string matching one of the explicit fake prefixes (case-insensitive):
 *      - `test-token-fake` (exact prefix, then anything)
 *      - `fake-token` (must include the `-token` suffix to avoid matching real tokens)
 *      - `mock-token` (must include the `-token` suffix)
 *      - `test` followed by a non-alphanumeric character or end of string
 *        (so `test` and `test-` match, but `testing` and `test123` do not)
 *
 * Throws on anything else — including real-looking base64 tokens copy-pasted from a `.env`,
 * and on bare `fake` or `MOCK` which are too short to be unambiguous.
 */
export function validateTokenIsFake(token: string | undefined): void {
  if (token === undefined || token === '') return
  if (FAKE_TOKEN_PATTERN.test(token) === true) return
  throw new Error(
    'refusing to run gateway client tests with what looks like a real DISCORD_TOKEN. ' +
      'Unset the env var or set it to a known-fake value (test-token-fake, fake-token, mock-token, or test).',
  )
}
