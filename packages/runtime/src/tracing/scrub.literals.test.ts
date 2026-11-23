/**
 * Literals added after the scrubber exists, and span links through `scrubSpan`. The shared scrubber serves the Action, whose
 * secrets appear mid-run (a server password minted after the first span was recorded), so what it knows must be able to grow.
 */

import {describe, expect, it} from 'vitest'

import {collectLiterals, createScrubber, MARKER, REDACTION, scrubSpan, type PendingSpan} from './scrub.js'

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
