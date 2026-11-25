/**
 * One fail-closed rule: when the name/value matcher recognises a sensitive name and cannot establish where its value ends, the
 * whole string is withheld (the existing omitted marker, reason `sensitive-value-unbounded`), never redacted "to the end of the
 * line". These are exported-span tests: a tool result, a tool argument and a message text.
 */

import {describe, expect, it} from 'vitest'

import {contentAttribute, createScrubber, MARKER, REDACTION, scrubSpan, type PendingSpan} from './scrub.js'

const REASON = 'sensitive-value-unbounded'
const ATTRIBUTE = 'gen_ai.tool.call.result'

const span = (attributes: PendingSpan['attributes']): PendingSpan => ({
  traceId: 't1',
  spanId: 's1',
  parentSpanId: undefined,
  name: 'execute_tool read',
  kind: 'internal',
  startMs: 1,
  endMs: 2,
  attributes,
  status: {code: 'unset'},
  events: [],
})

const placements = (text: string): readonly {readonly where: string; readonly value: unknown}[] => [
  {where: 'a tool result', value: {content: [{type: 'text', text}]}},
  {where: 'a tool argument', value: {command: text, nested: [{note: text}]}},
  {where: 'a message text', value: {messages: [{role: 'user', parts: [{type: 'text', content: text}]}]}},
]

const scrubber = createScrubber({env: {}})
const run = (value: unknown) => scrubSpan(span({[ATTRIBUTE]: contentAttribute(value, 1_048_576)}), scrubber)

/** The text is withheld whole: the leaf is the marker, nothing of it survives, and the span says why. */
function expectWithheld(text: string, leaks: readonly string[]): void {
  for (const {where, value} of placements(text)) {
    const result = run(value)
    const out = JSON.stringify(result.attributes[ATTRIBUTE])
    for (const leak of leaks) expect({where, leak, found: out.includes(leak)}).toEqual({where, leak, found: false})
    expect({where, marked: out.includes('[omitted]')}).toEqual({where, marked: true})
    expect({where, reasons: result.attributes[MARKER.omitted]}).toEqual({where, reasons: [`${ATTRIBUTE}:${REASON}`]})
  }
}

describe('a recognised sensitive name whose value cannot be bounded withholds the whole string', () => {
  it('past the whitespace gap, before a multi-line object', () => {
    // #given a quoted key, more than 256 characters of valid JSON whitespace, then a multi-line object (the old rule redacted only the opening line)
    const text = `before-text {"password":${'\n'.repeat(300)}{\n  "a": "leaky one",\n  "b": ["leaky two"]\n}\n} after-text`

    // #then everything is withheld, including the text before and after
    expectWithheld(text, ['leaky', 'before-text', 'after-text'])
  })

  it('past the whitespace gap, before a multi-line array', () => {
    // #given
    const text = `before-text {"token":${' \r\n'.repeat(120)}[\n  "leaky one",\n  "leaky two"\n]\n} after-text`

    // #then
    expectWithheld(text, ['leaky', 'before-text', 'after-text'])
  })

  it('when the bracket scan exceeds its size bound on a long multi-line value', () => {
    // #given an object that does not close within 256 KiB, with more lines (and text) after it
    const body = '\n  "k": 1,'.repeat(40_000)
    const text = `before-text {"password": {${body}\n  "tail": "leaky tail"\n} after-text`

    // #then
    expectWithheld(text, ['leaky', 'before-text', 'after-text'])
  })

  it('when the shared work budget runs out on many unterminated openers', () => {
    // #given a text of unterminated openers whose scans together exceed the budget, then an ordinary line
    const text = `before-text ${'secret: {[ pad\n'.repeat(30_000)}leaky line after-text`

    // #then
    expectWithheld(text, ['leaky', 'before-text', 'after-text'])
  })

  it('for an unterminated quoted value followed by more lines with a credential-shaped string', () => {
    // #given a quote that never closes, then lines holding a token-shaped string and ordinary words
    const token = ['ghp_', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5'].join('')
    const text = `before-text password: "no closing quote\nline two leaky words\nline three ${token}\nand after-text`

    // #then none of it is exported
    expectWithheld(text, ['leaky', 'aB3dE5fG7hJ9', 'before-text', 'after-text', 'no closing'])
  })

  it('when the quoted value is longer than its scan bound', () => {
    // #given a closing quote 20,000 characters away
    const text = `before-text {"password": "${'leaky '.repeat(3_400)}", "ok": 1} after-text`

    // #then
    expectWithheld(text, ['leaky', 'before-text', 'after-text'])
  })

  it.each([
    [
      'five layers of encoding (a quote run of 31)',
      (inner: string) => [1, 2, 3, 4, 5].reduce(text => JSON.stringify({v: text}), inner),
    ],
    [
      'a name quote run of 31 backslashes (a depth of five)',
      () => `before-text {${'\\'.repeat(31)}"password${'\\'.repeat(31)}": "leaky one"} after-text`,
    ],
    [
      'an escaped whitespace of another depth after a quoted key',
      () => String.raw`before-text {\"password\":\\n  \"leaky one\"} after-text`,
    ],
    [
      'a bracket value whose first quote run is not of the expected form',
      () => String.raw`before-text {"password": {\\"a\\": "leaky one"}} after-text`,
    ],
  ])('for an escape depth it cannot read: %s', (_label, make) => {
    // #given
    const text = make('before-text {"password": "leaky one"} after-text')

    // #then
    expectWithheld(text, ['leaky'])
  })

  it('withholds a plain attribute value whole, and says so with the same reason', () => {
    // #given a plain string attribute, a name, a status message and an event value, each with an unbounded sensitive value
    const text = `before-text password: "never closes\nleaky second line`
    const result = scrubSpan(
      {
        ...span({'fro_bot.note': text, 'fro_bot.list': [text, 'fine']}),
        name: `execute_tool ${text}`,
        status: {code: 'error', message: text},
        events: [{name: 'exception', timeMs: 1, attributes: {'exception.message': text, fine: 'ok'}}],
      },
      scrubber,
    )

    // #then each is the marker, the rest is untouched, and every omission is listed with the reason
    expect(JSON.stringify(result)).not.toContain('leaky')
    expect(result.attributes['fro_bot.note']).toBe('[omitted]')
    expect(result.attributes['fro_bot.list']).toEqual(['[omitted]', 'fine'])
    expect(result.name).toBe('[omitted]')
    expect(result.status.message).toBe('[omitted]')
    expect(result.events[0]?.attributes).toEqual({'exception.message': '[omitted]', fine: 'ok'})
    expect(result.attributes[MARKER.omitted]).toEqual(
      expect.arrayContaining([
        `fro_bot.note:${REASON}`,
        `name:${REASON}`,
        `status:${REASON}`,
        `event.exception.message:${REASON}`,
      ]),
    )
  })

  it('withholds only the leaf concerned in structured content, and keeps the rest of the attribute', () => {
    // #given a result whose second part is unbounded and whose first and third are fine
    const result = run({
      content: [
        {type: 'text', text: 'first part is fine'},
        {type: 'text', text: `password: "never closes\nleaky second line`},
        {type: 'text', text: `third part holds password=hunter2 and is fine`},
      ],
    })

    // #then
    const parsed = JSON.parse(String(result.attributes[ATTRIBUTE])) as {content: {text: string}[]}
    expect(parsed.content.map(part => part.text)).toEqual([
      'first part is fine',
      '[omitted]',
      `third part holds password=${REDACTION} and is fine`,
    ])
    expect(result.attributes[MARKER.omitted]).toEqual([`${ATTRIBUTE}:${REASON}`])
  })
})

describe('well-formed cases are still redacted in place, with the rest of the string intact', () => {
  it.each([
    ['a quoted string', '{"password": "hunter two", "ok": 1}', `{"password": "${REDACTION}", "ok": 1}`],
    ['a balanced object', '{"password": {"a": ["x y", {"b": 2}]}, "ok": 1}', `{"password": ${REDACTION}, "ok": 1}`],
    ['a number', '{"password": 8675309, "ok": 1}', `{"password": ${REDACTION}, "ok": 1}`],
    [
      'a value on the next line, within the gap bound',
      '{"password":\n  "hunter two",\n  "ok": 1}',
      `{"password":\n  "${REDACTION}",\n  "ok": 1}`,
    ],
    [
      'an unquoted assignment',
      'before-text password=hunter2 after-text',
      `before-text password=${REDACTION} after-text`,
    ],
    [
      'a multi-line object on the next line',
      '{"password":\n  {\n    "a": "x"\n  },\n  "ok": 1}',
      `{"password":\n  ${REDACTION},\n  "ok": 1}`,
    ],
  ])('%s', (_label, text, expected) => {
    // #given / #when
    const result = scrubber.scrub(text)

    // #then redacted in place, not withheld
    expect(result).toMatchObject({ok: true, text: expected})
    for (const {where, value} of placements(text)) {
      const span = run(value)
      expect({where, omitted: span.attributes[MARKER.omitted]}).toEqual({where, omitted: undefined})
      expect({where, redacted: JSON.stringify(span.attributes[ATTRIBUTE]).includes(REDACTION)}).toEqual({
        where,
        redacted: true,
      })
    }
  })
})
