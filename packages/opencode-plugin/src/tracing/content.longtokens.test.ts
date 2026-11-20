/**
 * A run of token characters after a known prefix is redacted whatever its length. The GitHub token and URL userinfo rules used
 * to cap the run (255 and 256 characters) and then required a boundary (`\b`, `@`), so a longer run matched nothing and was
 * exported whole.
 */

import {describe, expect, it} from 'vitest'

import {createScrubber, REDACTION, scrubStructured} from './content.js'

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

describe('object keys that collide once scrubbed keep every entry', () => {
  const tokenA = ['ghp_', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5'].join('')
  const tokenB = ['ghp_', 'Zy9xW7vU5tS3rQ1pN9mL7kJ5hG3fE1dC9bA7'].join('')
  const tokenC = ['ghs_', 'Qq1Ww2Ee3Rr4Tt5Yy6Uu7Ii8Oo9Pp0Aa1Ss2'].join('')

  const walk = (value: unknown): Record<string, unknown> => {
    const result = scrubStructured(value, scrubber)
    if (!result.ok) throw new Error(result.reason)
    return result.value as Record<string, unknown>
  }

  it('gives each later colliding key a deterministic suffix, and keeps every value', () => {
    // #given two and three keys that differ only inside text the scrubber redacts
    const two = walk({[`id-${tokenA}`]: 1, [`id-${tokenB}`]: 2})
    const three = walk({[`id-${tokenA}`]: 1, [`id-${tokenB}`]: 2, [`id-${tokenC}`]: 3})

    // #then none is overwritten, the first keeps the plain name, and no original text is kept
    expect(two).toEqual({[`id-${REDACTION}`]: 1, [`id-${REDACTION} (2)`]: 2})
    expect(three).toEqual({[`id-${REDACTION}`]: 1, [`id-${REDACTION} (2)`]: 2, [`id-${REDACTION} (3)`]: 3})
    expect(JSON.stringify(three)).not.toContain('aB3dE5')
  })

  it('does the same for keys whose values are withheld whole as sensitive', () => {
    // #given two sensitive keys that collide after scrubbing
    const out = walk({[`password-${tokenA}`]: 'one', [`password-${tokenB}`]: 'two'})

    // #then both survive, each value replaced
    expect(out).toEqual({[`password-${REDACTION}`]: REDACTION, [`password-${REDACTION} (2)`]: REDACTION})
  })

  it('leaves keys that do not collide untouched, including ones that look like a suffix', () => {
    // #given distinct keys, one of which is already named like a suffix, and an inherited-property name
    const out = walk({alpha: 1, beta: 2, [`k-${tokenA}`]: 3, [`k-${REDACTION} (2)`]: 4, constructor: 5, toString: 6})

    // #then nothing is renamed: the redacted key and the one that is only named like a suffix do not collide
    expect(out).toEqual({
      alpha: 1,
      beta: 2,
      [`k-${REDACTION}`]: 3,
      [`k-${REDACTION} (2)`]: 4,
      constructor: 5,
      toString: 6,
    })
  })

  it('is bounded: past 64 collisions the later entries merge into the last suffix instead of probing without end', () => {
    // #given 200 keys that all scrub to the same text
    const input: Record<string, number> = {}
    for (let index = 0; index < 200; index += 1)
      input[`id-ghp_${String(index).padStart(3, '0')}${'x'.repeat(33)}`] = index
    const out = walk(input)

    // #then the keys are the plain name and (2) to (64), and the last holds the last value
    expect(Object.keys(out)).toHaveLength(64)
    expect(out[`id-${REDACTION} (64)`]).toBe(199)
  })
})
