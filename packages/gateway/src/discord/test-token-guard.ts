const FAKE_TOKEN_PATTERN = /^(?:test-token-fake|fake|test|MOCK)/i

/**
 * Refuses to let the gateway test suite run with what looks like a real Discord token.
 *
 * Accepts:
 *  - undefined (env var unset)
 *  - empty string
 *  - a string starting with `test-token-fake`, `fake`, `test`, or `MOCK` (case-insensitive)
 *
 * Throws on anything else — including real-looking base64 tokens copy-pasted from a `.env`.
 */
export function validateTokenIsFake(token: string | undefined): void {
  if (token === undefined || token === '') return
  if (FAKE_TOKEN_PATTERN.test(token) === true) return
  throw new Error(
    'refusing to run gateway client tests with what looks like a real DISCORD_TOKEN. ' +
      'Unset the env var or set it to a known-fake value (test-token-fake, fake, test, or MOCK).',
  )
}
