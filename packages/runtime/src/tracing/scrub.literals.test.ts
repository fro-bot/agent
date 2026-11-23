/**
 * Literals added after the scrubber exists, and span links through `scrubSpan`. The shared scrubber serves the Action, whose
 * secrets appear mid-run (a server password minted after the first span was recorded), so what it knows must be able to grow.
 */

import {describe, expect, it} from 'vitest'

import {
  collectLiterals,
  createScrubber,
  MARKER,
  MAX_LITERAL_CHARS,
  MIN_LITERAL_CHARS,
  REDACTION,
  scrubSpan,
  type PendingSpan,
} from './scrub.js'
import {minCpuMs} from './timing.testing.js'

// Words, not secret shapes: no pattern in `SCRUB_PATTERNS` matches them, so only the literal pass can redact them.
const LATE = 'harbor-lantern-quartz-7731'
const text = (scrubber: ReturnType<typeof createScrubber>, input: string): string => {
  const result = scrubber.scrub(input)
  if (!result.ok) throw new Error(`scrub failed: ${result.reason}`)
  return result.text
}

function pending(overrides: Partial<PendingSpan> = {}): PendingSpan {
  return {
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    parentSpanId: undefined,
    name: 'phase',
    kind: 'internal',
    startMs: 1,
    endMs: 2,
    attributes: {},
    status: {code: 'unset'},
    events: [],
    ...overrides,
  }
}

describe('literals added after creation', () => {
  it('leaves a value alone before it is added and redacts it from every later string', () => {
    // #given a scrubber created before the value was known
    const scrubber = createScrubber()
    expect(text(scrubber, `connect with ${LATE} now`)).toBe(`connect with ${LATE} now`)

    // #when the value is added
    scrubber.addLiterals?.([LATE])

    // #then a later scrub removes it, and the safety net reports it as a survivor
    expect(text(scrubber, `connect with ${LATE} now`)).toBe(`connect with ${REDACTION} now`)
    expect(scrubber.survived?.(`kept ${LATE}`)).toBe(true)
    expect(scrubber.survived?.('kept nothing')).toBe(false)
  })

  it('redacts a literal added after a span was recorded, at the scrub that exports it', () => {
    // #given a span recorded with the value in its name, an attribute, an event and a status message
    const scrubber = createScrubber()
    const recorded = pending({
      name: `connect ${LATE}`,
      attributes: {'fro_bot.detail': `host ${LATE}`},
      status: {code: 'error', message: `failed ${LATE}`},
      events: [{name: 'exception', timeMs: 1, attributes: {'exception.message': `boom ${LATE}`}}],
    })

    // #when the value is added before the span is scrubbed for export
    scrubber.addLiterals?.([LATE])
    const exported = scrubSpan(recorded, scrubber)

    // #then no position carries it
    expect(JSON.stringify(exported)).not.toContain(LATE)
    expect(exported.name).toBe(`connect ${REDACTION}`)
    expect(exported.attributes['fro_bot.detail']).toBe(`host ${REDACTION}`)
    expect(exported.status.message).toBe(`failed ${REDACTION}`)
    expect(exported.events[0]?.attributes['exception.message']).toBe(`boom ${REDACTION}`)
    expect(exported.attributes[MARKER.redactions]).toBe(4)
  })

  it('redacts the JSON-escaped form too, as it does for construction-time literals', () => {
    // #given a value that JSON escapes differently, added late
    const quoted = String.raw`say "harbor lantern" \ now`
    const scrubber = createScrubber()
    scrubber.addLiterals?.([quoted])

    // #when it appears inside serialized JSON
    const result = text(scrubber, JSON.stringify({note: quoted}))

    // #then the escaped form is gone
    expect(result).not.toContain('harbor lantern')
  })

  it('ignores a value it already knows and a value under the length bound', () => {
    // #given a scrubber that knows one literal at construction
    const scrubber = createScrubber({extraSecrets: [LATE]})

    // #when the same value and a short one are added
    scrubber.addLiterals?.([LATE, 'short'])

    // #then the short value is not redacted from ordinary text, and the known one still is
    expect(text(scrubber, 'a short note')).toBe('a short note')
    expect(text(scrubber, LATE)).toBe(REDACTION)
  })

  it('keeps every added literal past the construction-time cap of 128', () => {
    // #given 300 distinct literals, which the construction-time set would cut to the longest 128
    const many = Array.from({length: 300}, (_, index) => `ledger-entry-${String(index).padStart(4, '0')}-ok`)
    expect(collectLiterals({}, many)).toHaveLength(128)
    const scrubber = createScrubber()

    // #when all are added
    scrubber.addLiterals?.(many)

    // #then each one is redacted, the first and the last included
    const exported = text(scrubber, many.join(' | '))
    for (const literal of many) expect(exported).not.toContain(literal)
    expect(scrubber.survived?.(many[299] ?? '')).toBe(true)
  })

  it('redacts a literal the construction-time cap dropped once it is added', () => {
    // #given more extra secrets than the cap keeps, so the shortest is dropped at construction
    const many = Array.from(
      {length: 130},
      (_, index) => `${'x'.repeat(index % 7)}ledger-${String(index).padStart(4, '0')}`,
    )
    const kept = new Set(collectLiterals({}, many))
    const dropped = many.filter(value => !kept.has(value))
    expect(dropped.length).toBeGreaterThan(0)
    const scrubber = createScrubber({extraSecrets: many})
    expect(text(scrubber, `see ${dropped[0] ?? ''}`)).toContain(dropped[0] ?? 'missing')

    // #when it is added
    scrubber.addLiterals?.(dropped)

    // #then it is redacted
    expect(text(scrubber, `see ${dropped[0] ?? ''}`)).toBe(`see ${REDACTION}`)
  })
})

describe('span links', () => {
  it('keeps a link as its two ids and nothing else, so no text can ride on it', () => {
    // #given a span with a link, and a caller that tries to hang text (a registered secret) on it anyway
    const scrubber = createScrubber()
    scrubber.addLiterals?.([LATE])
    const link = {traceId: 'c'.repeat(32), spanId: 'd'.repeat(16)}
    const forged = {...link, attributes: {[LATE]: LATE}} as typeof link

    // #when it is scrubbed
    const exported = scrubSpan(pending({links: [forged]}), scrubber)

    // #then only the ids survive: no attributes, and the secret is nowhere in the span
    expect(exported.links).toEqual([link])
    expect(JSON.stringify(exported)).not.toContain(LATE)
    expect(MARKER.omitted in exported.attributes).toBe(false)
  })

  it.each([
    ['a short trace id', {traceId: 'c'.repeat(31), spanId: 'd'.repeat(16)}],
    ['a long span id', {traceId: 'c'.repeat(32), spanId: 'd'.repeat(17)}],
    ['an all-zero trace id', {traceId: '0'.repeat(32), spanId: 'd'.repeat(16)}],
    ['an all-zero span id', {traceId: 'c'.repeat(32), spanId: '0'.repeat(16)}],
    ['uppercase hex', {traceId: 'C'.repeat(32), spanId: 'd'.repeat(16)}],
    ['non-hex text', {traceId: 'c'.repeat(32), spanId: 'not-a-span-id!!!!'}],
    // `RegExp.test` coerces its argument, so these would read as valid hex unless the type is checked first.
    [
      'an array trace id',
      {traceId: ['c'.repeat(32)], spanId: 'd'.repeat(16)} as unknown as {traceId: string; spanId: string},
    ],
    [
      'an object span id',
      {traceId: 'c'.repeat(32), spanId: {toString: () => 'd'.repeat(16)}} as unknown as {
        traceId: string
        spanId: string
      },
    ],
    ['a missing span id', {traceId: 'c'.repeat(32)} as unknown as {traceId: string; spanId: string}],
  ])('drops a link with %s and keeps the span, marked with a fixed reason', (_label, bad) => {
    // #given a span with one good link and one bad one
    const good = {traceId: 'e'.repeat(32), spanId: 'f'.repeat(16)}

    // #when it is scrubbed
    const exported = scrubSpan(pending({links: [bad, good]}), createScrubber())

    // #then the span and the good link remain, the bad id appears nowhere, and the marker names no id
    expect(exported.name).toBe('phase')
    expect(exported.links).toEqual([good])
    expect(exported.attributes[MARKER.omitted]).toEqual(['links:invalid-id'])
  })

  it('omits the links key when every link is invalid', () => {
    // #given / #when
    const exported = scrubSpan(pending({links: [{traceId: '0'.repeat(32), spanId: '0'.repeat(16)}]}), createScrubber())

    // #then
    expect('links' in exported).toBe(false)
  })

  it('adds no links key to a span that had none', () => {
    // #given / #when
    const exported = scrubSpan(pending(), createScrubber())

    // #then
    expect('links' in exported).toBe(false)
  })
})

describe('the literal length range', () => {
  // A letter run no pattern in `SCRUB_PATTERNS` reads as a secret (a `ghs_`-style prefix would be redacted anyway).
  const shaped = (length: number): string => `lit-${'k'.repeat(Math.max(0, length - 4))}`.slice(0, length)

  it('reaches 65,536 characters, so an Actions runtime token of 4,152 characters is a literal', () => {
    expect(MIN_LITERAL_CHARS).toBe(8)
    expect(MAX_LITERAL_CHARS).toBe(65_536)
  })

  it.each([8, 4_096, 4_152, 8_192, 65_536])('redacts a %i-character literal wherever it appears', length => {
    // #given a literal of that length, known at creation and one known later
    const value = shaped(length)
    const early = createScrubber({env: {}, patterns: [], extraSecrets: [value]})
    const late = createScrubber({env: {}, patterns: []})
    late.addLiterals?.([value])

    for (const scrubber of [early, late]) {
      // #when it sits in ordinary text, twice
      const result = text(scrubber, `before ${value} between ${value} after`)

      // #then both are redacted and the text around them survives
      expect(result).toBe(`before ${REDACTION} between ${REDACTION} after`)
      expect(scrubber.survived?.(`x ${value} y`)).toBe(true)
    }
  })

  it('redacts the JSON-escaped form of a long literal that needs escaping', () => {
    // #given a 5,000-character value with quotes and backslashes, which doubles its escaped form
    const value = String.raw`a"b\c`.repeat(1_000)
    const scrubber = createScrubber({env: {}, patterns: []})
    scrubber.addLiterals?.([value])

    // #when / #then it is removed raw and inside a JSON string
    expect(text(scrubber, `raw ${value} end`)).toBe(`raw ${REDACTION} end`)
    expect(text(scrubber, JSON.stringify({k: value}))).not.toContain(String.raw`a\"b`)
  })

  it.each([7, 65_537])('still ignores a %i-character literal', length => {
    // #given a value outside the range, known at creation and later
    const value = shaped(length)
    const scrubber = createScrubber({env: {}, patterns: [], extraSecrets: [value]})
    scrubber.addLiterals?.([value])

    // #then it is never matched, which is why a caller must know the range
    expect(text(scrubber, `x ${value} y`)).toContain(value)
    expect(collectLiterals({A_TOKEN: value})).toEqual([])
  })

  it('finds every occurrence of a long literal, overlapping ones included', () => {
    // #given a 5,000-character literal that overlaps itself by all but 8 characters
    const unit = 'abcdefgh'
    const value = unit.repeat(625)
    const scrubber = createScrubber({env: {}, patterns: [], extraSecrets: [value]})

    // #when the text holds it shifted by one unit: 630 units, so the two occurrences overlap
    const result = text(scrubber, `<${unit.repeat(626)}>`)

    // #then the union of the overlapping occurrences is one range, with the delimiters left
    expect(result).toBe(`<${REDACTION}>`)
  })
})

describe('literal matching stays linear however long the literal is', () => {
  // The worst case for a native search: the literal ends in a character that is everywhere in the text, so a mismatch lets it skip
  // nothing, and the text is the literal's own long prefix over and over, so each alignment matches almost to the end before it
  // fails. V8's `indexOf` then costs length(text) x length(literal): seconds for a megabyte.
  const literal = `b${'a'.repeat(65_535)}`
  const block = `${literal.slice(0, 65_535)}#`
  const textOf = (blocks: number): string => block.repeat(blocks)

  it.each(['scrub', 'survived'] as const)(
    'takes about eight times as long for eight times the text (%s)',
    operation => {
      // #given a scrubber that knows the 64 KiB literal
      const scrubber = createScrubber({env: {}, patterns: [], extraSecrets: [literal]})
      const run = (input: string): void => {
        if (operation === 'scrub') scrubber.scrub(input)
        else scrubber.survived?.(input)
      }
      // CPU time, the least of three runs (see `timing.testing.ts`): load on the machine cannot fail it.
      const time = (blocks: number): number => {
        const input = textOf(blocks)
        return minCpuMs(() => {
          run(input)
        }, 3)
      }

      // #when the text is 2 and then 16 blocks (131 KiB and 1 MiB)
      const small = Math.max(time(2), 1)
      const large = time(16)

      // #then about eight times the time, far from sixty-four, and quick in absolute terms
      expect(large).toBeLessThan(2_000)
      expect(large / small).toBeLessThan(24)
    },
    120_000,
  )

  it('also holds for a literal that really occurs, many times', () => {
    // #given the literal itself repeated
    const scrubber = createScrubber({env: {}, patterns: [], extraSecrets: [literal]})
    const result = scrubber.scrub(literal.repeat(8))

    // #then it is one removal per occurrence, united into one range
    expect(result).toMatchObject({ok: true, text: REDACTION, redactions: 1})
  })
})
