/**
 * A run of token characters after a known prefix is redacted whatever its length. The GitHub token and URL userinfo rules used
 * to cap the run (255 and 256 characters) and then required a boundary (`\b`, `@`), so a longer run matched nothing and was
 * exported whole.
 */

import {describe, expect, it} from 'vitest'

import {createScrubber, REDACTION} from './content.js'

const scrubber = createScrubber({env: {}})
const scrub = (text: string): string => {
  const result = scrubber.scrub(text)
  if (!result.ok) throw new Error(result.reason)
  return result.text
}

describe('over-long tokens are redacted whole', () => {
  it.each([
    ['a classic GitHub token past 255 characters', `before ghp_${'aB3dE5fG7hJ9'.repeat(25)} after`, 'ghp_', ' after'],
    ['a classic GitHub token of 5,000 characters', `before ghs_${'x9Y8'.repeat(1_250)} after`, 'ghs_', ' after'],
    [
      'a fine-grained token past 255 characters',
      `before github_pat_${'aB3_dE5fG7hJ9'.repeat(25)} after`,
      'github_pat_',
      ' after',
    ],
  ])('%s', (_label, text, prefix, tail) => {
    // #when
    const out = scrub(text)

    // #then the whole run is gone, and what is around it is not
    expect(out).toBe(`before ${REDACTION}${tail}`)
    expect(out).not.toContain(prefix)
  })

  it('redacts URL userinfo longer than 256 characters, and keeps the scheme and the host', () => {
    // #given a 1,000-character password in a URL
    const text = `fetch https://user:${'p4ss'.repeat(250)}@example.test/path now`

    // #then
    expect(scrub(text)).toBe(`fetch https://${REDACTION}@example.test/path now`)
  })

  it('still redacts the lengths it always did, and still leaves a prefix with too short a run alone', () => {
    // #given exact lengths at and around the minimums
    const at = `ghp_${'a'.repeat(36)}`
    const short = `ghp_${'a'.repeat(35)}`

    // #then
    expect(scrub(`x ${at} y`)).toBe(`x ${REDACTION} y`)
    expect(scrub(`x ${short} y`)).toBe(`x ${short} y`)
    expect(scrub('see https://u:p@h/')).toBe(`see https://${REDACTION}@h/`)
  })

  it('does not match a prefix inside a longer word', () => {
    // #given the prefix glued to a word on its left
    const text = `xghp_${'a'.repeat(300)}`

    // #then the boundary rule is unchanged
    expect(scrub(text)).toBe(text)
  })
})

describe('URL userinfo can only be in the authority', () => {
  const FILL = 'p4ss'.repeat(100)

  it.each([
    ['a query on the host with no slash', 'https://example.com?next=user@evil.test'],
    ['a fragment on the host with no slash', 'https://example.com#frag@x'],
    ['a long query with an @, no slash after the host', `https://example.com?next=${FILL}@evil.test`],
    ['a long fragment with an @, no slash after the host', `https://example.com#${FILL}@evil.test`],
    ['an @ in the path', 'https://example.com/a@b'],
    ['a query after a port', 'https://example.com:8443?u=a@b'],
  ])('leaves the hostname alone for %s', (_label, url) => {
    // #given a URL whose only @ is outside the authority
    const text = `open ${url} now`

    // #then nothing is redacted by the userinfo rule (an unrelated domain must not look like the destination)
    expect(scrub(text)).toBe(text)
  })

  it.each([
    ['a plain user and password', 'https://user:pass@example.com/path', `https://${REDACTION}@example.com/path`],
    ['a percent-encoded userinfo', 'https://us%40er:p%3Fss%23w@example.com/', `https://${REDACTION}@example.com/`],
    ['a userinfo over 256 characters', `https://user:${FILL}@example.com/x`, `https://${REDACTION}@example.com/x`],
    ['a userinfo before a query', 'https://u:p@example.com?next=1', `https://${REDACTION}@example.com?next=1`],
    ['a userinfo before a fragment', 'https://u:p@example.com#top', `https://${REDACTION}@example.com#top`],
  ])('still redacts %s', (_label, url, expected) => {
    // #then
    expect(scrub(`open ${url} now`)).toBe(`open ${expected} now`)
  })

  it('leaves the other rules in charge of a secret in the query', () => {
    // #given a secret query parameter on a URL with no userinfo, and a connection string
    const query = scrub('GET https://example.com/cb?token=abcdef123456&x=1')
    const conn = scrub('db postgres://admin:s3cret@db.internal:5432/app ok')

    // #then the query-secret rule redacts the value, the host stays; the connection-string rule redacts its own
    expect(query).toBe(`GET https://example.com/cb?token=${REDACTION}&x=1`)
    expect(conn).toBe(`db ${REDACTION} ok`)
  })
})
