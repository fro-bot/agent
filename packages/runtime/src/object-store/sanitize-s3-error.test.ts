import {describe, expect, it} from 'vitest'

import {sanitizeS3ErrorMessage} from './sanitize-s3-error.js'

/** The pre-fix implementation, kept as the oracle the linear scanner must agree with. */
function legacySanitize(message: string): string {
  return message
    .replaceAll(/X-Amz-[A-Za-z0-9-]+=[^&\s]+/g, 'X-Amz-REDACTED=[REDACTED]')
    .replaceAll(/Authorization([:=]\s*)(Bearer\s+)?[^,\s]+/gi, 'Authorization$1$2[REDACTED]')
    .slice(0, 500)
}

describe('sanitizeS3ErrorMessage', () => {
  it.each([
    [
      'a presigned URL query string',
      'GET https://b.s3.amazonaws.com/k?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20260101&X-Amz-Signature=abc123 failed',
      'GET https://b.s3.amazonaws.com/k?X-Amz-REDACTED=[REDACTED]&X-Amz-REDACTED=[REDACTED]&X-Amz-REDACTED=[REDACTED] failed',
    ],
    [
      'a signature followed by whitespace',
      'request failed X-Amz-Signature=abc123 Authorization=Bearer secret-token',
      'request failed X-Amz-REDACTED=[REDACTED] Authorization=Bearer [REDACTED]',
    ],
    ['a hyphenated parameter name', 'X-Amz-Security-Token=tok123', 'X-Amz-REDACTED=[REDACTED]'],
    ['a prefix with no parameter name', 'X-Amz-=value', 'X-Amz-=value'],
    ['a parameter with no value', 'X-Amz-Signature= next', 'X-Amz-Signature= next'],
    ['a parameter with no equals sign', 'X-Amz-Signature abc', 'X-Amz-Signature abc'],
    ['a value ended by an ampersand', 'X-Amz-Date=20260101T000000Z&other=1', 'X-Amz-REDACTED=[REDACTED]&other=1'],
    ['an Authorization header with a scheme', 'Authorization: Bearer abc.def', 'Authorization: Bearer [REDACTED]'],
    ['a message with nothing to redact', 'NoSuchKey: the key does not exist', 'NoSuchKey: the key does not exist'],
  ])('redacts %s', (_label, input, expected) => {
    expect(sanitizeS3ErrorMessage(input)).toBe(expected)
    expect(legacySanitize(input)).toBe(expected)
  })

  it('truncates the result to 500 characters', () => {
    expect(sanitizeS3ErrorMessage('x'.repeat(2000))).toHaveLength(500)
  })

  it('agrees with the pre-fix implementation over a small alphabet of the tokens that matter', () => {
    // #given every string of up to six tokens drawn from the pieces the pattern cares about
    const tokens = ['X-Amz-', 'a', '-', '=', '&', ' ', 'X-Amz-A=', '\u00A0']
    const inputs = new Set<string>([''])
    let frontier = ['']
    for (let length = 0; length < 6; length++) {
      frontier = frontier.flatMap(prefix => tokens.map(token => prefix + token))
      for (const input of frontier) inputs.add(input)
    }

    // #then the output is identical for every one of them
    for (const input of inputs) expect(sanitizeS3ErrorMessage(input)).toBe(legacySanitize(input))
  })

  it('returns promptly on a long run of repeated prefixes with no equals sign', () => {
    // #given the input that made the unbounded pattern quadratic: many "X-Amz-" starts that never reach "="
    const input = 'X-Amz-'.repeat(20_000)

    // #when
    const startedAt = performance.now()
    const result = sanitizeS3ErrorMessage(input)
    const elapsedMs = performance.now() - startedAt

    // #then nothing is redacted (there is nothing to redact), and the scan is linear
    expect(result).toBe(input.slice(0, 500))
    expect(elapsedMs).toBeLessThan(200)
  })

  it('returns promptly on a long run of repeated prefixes ending in a parameter', () => {
    // #given the same run, with a real parameter at the end
    const input = `${'X-Amz-'.repeat(20_000)}Signature=abc123`

    // #when
    const startedAt = performance.now()
    const result = sanitizeS3ErrorMessage(input)
    const elapsedMs = performance.now() - startedAt

    // #then the whole run is one parameter name, so it is redacted as one match, and the scan is linear
    expect(result).toBe('X-Amz-REDACTED=[REDACTED]')
    expect(elapsedMs).toBeLessThan(200)
  })
})
