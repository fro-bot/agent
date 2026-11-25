/**
 * JSON that lives inside a string. A string is a string: the text matchers read its ORIGINAL text, in full, and nothing else
 * decides what is exported. These tests are the ones the previous design (parse a string that looks like JSON, check its
 * leaves, return the source when nothing in it was redacted) would have failed: a known literal that spans JSON syntax, a
 * credential that is itself a JSON document, a token in a duplicate key that `JSON.parse` discards, and a sensitive-named key
 * whose value is a whole object.
 */

import {describe, expect, it} from 'vitest'

import {
  contentAttribute,
  createScrubber,
  MARKER,
  REDACTION,
  scrubSpan,
  type PendingSpan,
  type Scrubber,
} from './scrub.js'
import {minCpuMs} from './timing.testing.js'

// Fixture secrets are assembled at run time so no scanner mistakes this file for a leak.
const join = (...parts: string[]): string => parts.join('')

const GITHUB = join('ghp_', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5')
const CREDENTIAL = {user: 'alice-zqxv', key: join('kwjd', '-7f3a9c21-qzvx'), nested: {n: 1}}
const COMPACT = JSON.stringify(CREDENTIAL)
const PRETTY = JSON.stringify(CREDENTIAL, null, 2)
const SPANNING = join('abcdefg', '","b":"', 'hijklmn')

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

/** The three places the plugin puts text: a tool result, a tool argument, a message. */
const placements = (text: string): readonly {readonly where: string; readonly value: unknown}[] => [
  {where: 'a tool result', value: {content: [{type: 'text', text}]}},
  {where: 'a tool argument', value: {command: text, nested: [{note: text}]}},
  {where: 'a message text', value: {messages: [{role: 'user', parts: [{type: 'text', content: text}]}]}},
]

const exported = (value: unknown, scrubber: Scrubber): string => {
  const result = scrubSpan(span({'gen_ai.tool.call.result': contentAttribute(value, 262_144)}), scrubber)
  return JSON.stringify([result.name, result.attributes])
}

describe('a known literal that is itself a JSON document', () => {
  const scrubber = createScrubber({env: {APP_CREDENTIAL: COMPACT, OTHER_SECRET: PRETTY}})
  const pieces = ['alice-zqxv', 'kwjd-7f3a9c21-qzvx']

  it.each([
    ['compact', COMPACT],
    ['pretty-printed', PRETTY],
  ])('leaves nothing of a %s literal, alone as a string value or embedded in a larger string', (_label, literal) => {
    // #given the literal alone, and inside a larger string, in every placement
    for (const text of [literal, `before ${literal} after`, `{"wrapper": ${literal}}`]) {
      for (const {where, value} of placements(text)) {
        // #when
        const out = exported(value, scrubber)

        // #then none of its distinctive parts survive
        for (const piece of pieces)
          expect({where, piece, found: out.includes(piece)}).toEqual({where, piece, found: false})
      }
    }
  })

  it('does not return a JSON-looking string unscanned, and builds its output from scanned text', () => {
    // #given the literal as the whole string, where the old design parsed it, found nothing in its leaves and returned the source
    const out = exported({content: [{type: 'text', text: COMPACT}]}, scrubber)

    // #then the output is the marker, not the document
    expect(out).toContain(REDACTION)
    expect(out).not.toContain('alice-zqxv')
  })
})

describe('a known literal that spans JSON syntax inside a string that parses as JSON', () => {
  const scrubber = createScrubber({env: {APP_SECRET: SPANNING}})

  it.each(placements(`{"a":"${SPANNING}"}`).map(({where, value}) => [where, value] as const))(
    'removes it in %s',
    (_where, value) => {
      // #given a two-field document whose values together form the literal (the quote, comma and key between them included)
      const out = exported(value, scrubber)

      // #then neither half survives
      expect(out).not.toContain('abcdefg')
      expect(out).not.toContain('hijklmn')
    },
  )
})

describe('a duplicate key in a string that parses as JSON', () => {
  const scrubber = createScrubber({env: {}})

  it.each(placements(`{"note":"${GITHUB}","note":"benign"}`).map(({where, value}) => [where, value] as const))(
    'does not hide the first value from the matchers, in %s',
    (_where, value) => {
      // #given a first value that is a recognisable token and a second that is benign (JSON.parse keeps only the second)
      const out = exported(value, scrubber)

      // #then the token does not survive, and the benign value does
      expect(out).not.toContain('aB3dE5fG7hJ9')
      expect(out).toContain('benign')
    },
  )
})

describe('a sensitive-named key inside JSON in a string: its whole value goes', () => {
  const scrubber = createScrubber({env: {}})
  /** One layer of JSON-string encoding: the document becomes a string value, so every quote in it gains a backslash. */
  const wrap = (text: string): string => JSON.stringify({v: text})

  const VALUES: readonly {
    readonly label: string
    readonly value: string
    readonly balanced: boolean
    readonly secrets: readonly string[]
  }[] = [
    {
      label: 'an object',
      value: '{"inner":"hunter two words","n":[1,2,{"x":"deepsecret"}]}',
      balanced: true,
      secrets: ['hunter', 'deepsecret'],
    },
    {
      label: 'an array',
      value: String.raw`["first secret","second \"quoted\" one",3141592]`,
      balanced: true,
      secrets: ['first', 'second', '3141592'],
    },
    {
      label: 'a nested object with quotes, an odd number of escaped quotes and brackets inside strings',
      value: String.raw`{"a":{"b":"said \"hi ]} [ {","c":["x}","y]"]},"after":"stillsecret"}`,
      balanced: true,
      secrets: ['said', 'stillsecret', 'x}'],
    },
    {
      label: 'an unterminated object',
      value: '{"inner":"unterminated secret words',
      balanced: false,
      secrets: ['unterminated', 'words'],
    },
    {label: 'a number', value: '8675309', balanced: true, secrets: ['8675309']},
    {label: 'true', value: 'true', balanced: true, secrets: ['"password":true', 'password": true']},
    {label: 'null', value: 'null', balanced: true, secrets: ['password":null', 'password": null']},
  ]

  const depths = [0, 1, 3] as const
  const document = (value: string, depth: number): string => {
    let text = `{"keep":"fine-text","password": ${value},"tail":"after-text"}`
    for (let layer = 0; layer < depth; layer += 1) text = wrap(text)
    return text
  }

  for (const {label, value, balanced, secrets} of VALUES) {
    for (const depth of depths) {
      it(`removes ${label} at escape depth ${String(depth)}, in a result, an argument and a message`, () => {
        // #given the document at this depth
        const text = document(value, depth)

        for (const {where, value: placed} of placements(text)) {
          // #when
          const out = exported(placed, scrubber)

          // #then no part of the value survives (a boolean or null is checked by its literal form too)
          for (const secret of secrets)
            expect({where, secret, found: out.includes(secret)}).toEqual({where, secret, found: false})
          expect(out).toContain(balanced ? REDACTION : '[omitted]')
          // #and when the value is balanced, what follows it is untouched
          expect({where, kept: !(balanced && depth === 0) || out.includes('after-text')}).toEqual({where, kept: true})
        }
      })
    }
  }

  it('withholds the string for an object that never closes: its end is not established, so none of it is exported', () => {
    // #given an object that never closes, on one line of a multi-line text
    const text = 'log: password: {"a": "unfinished secret\nnext line stays'

    // #when
    const out = exported({content: [{type: 'text', text}]}, scrubber)

    // #then
    expect(out).not.toContain('unfinished')
    expect(out).not.toContain('next line stays')
    expect(out).toContain('[omitted]')
  })

  it('keeps a counter name’s number, as before', () => {
    // #given
    const text = JSON.stringify({max_tokens: 8000, password: {a: 'x y'}, tokens: 120})

    // #when
    const out = exported({content: [{type: 'text', text}]}, scrubber)

    // #then
    expect(out).toContain('max_tokens')
    expect(out).toContain('8000')
    expect(out).toContain('120')
    expect(out).not.toContain('x y')
  })
})

describe('the safety net: a known literal that is still present at export is withheld, never rewritten', () => {
  const SECRET = join('lit-survives-', '9f8e7d6c5b')
  const real = createScrubber({env: {DB_PASSWORD: SECRET}})
  /** The matchers are off but the literal check is the real one: the situation the safety net exists for. */
  const blind: Scrubber = {...real, scrub: text => ({ok: true, text, redactions: 0})}

  it('withholds a plain value, a name, a status message, an event value and a content attribute, and counts each', () => {
    // #given a span whose every string holds the literal, and a scrubber that failed to remove it
    const before = blind.survivalCount?.() ?? -1
    const result = scrubSpan(
      {
        ...span({
          'fro_bot.note': `note ${SECRET}`,
          'fro_bot.list': [`a ${SECRET}`, 'fine'],
          'gen_ai.tool.call.result': contentAttribute({content: [{type: 'text', text: `out ${SECRET}`}]}, 65_536),
          'fro_bot.number': 7,
        }),
        name: `execute_tool ${SECRET}`,
        status: {code: 'error', message: `failed ${SECRET}`},
        events: [{name: 'exception', timeMs: 1, attributes: {'exception.message': `boom ${SECRET}`, fine: 'ok'}}],
      },
      blind,
    )

    // #then nothing of it is exported, each withheld value says why with a fixed reason, and the rest is untouched
    const everything = JSON.stringify(result)
    expect(everything).not.toContain(SECRET)
    expect(result.name).toBe('[omitted]')
    expect(result.status.message).toBe('[omitted]')
    expect(result.events[0]?.attributes).toEqual({'exception.message': '[omitted]', fine: 'ok'})
    expect(result.attributes['fro_bot.note']).toBe('[omitted]')
    expect(result.attributes['fro_bot.list']).toEqual(['[omitted]', 'fine'])
    expect(result.attributes['gen_ai.tool.call.result']).toBeUndefined()
    expect(result.attributes['fro_bot.number']).toBe(7)
    expect(result.attributes[MARKER.omitted]).toEqual(
      expect.arrayContaining([
        'gen_ai.tool.call.result:literal-survived',
        'fro_bot.note:literal-survived',
        'name:literal-survived',
        'status:literal-survived',
        'event.exception.message:literal-survived',
      ]),
    )
    expect((blind.survivalCount?.() ?? -1) - before).toBe(6)
  })

  it('also finds the JSON-escaped form of the literal', () => {
    // #given a literal with characters JSON escapes, and a blind scrubber
    const tricky = createScrubber({env: {API_TOKEN: 'line one\nline "two"'}})
    const weak: Scrubber = {...tricky, scrub: text => ({ok: true, text, redactions: 0})}

    // #when the escaped form is in a content attribute (what a serialization produces) and the raw form in a plain one
    const result = scrubSpan(
      span({
        'gen_ai.tool.call.result': contentAttribute(
          {content: [{type: 'text', text: 'x line one\nline "two" y'}]},
          65_536,
        ),
        'fro_bot.note': 'line one\nline "two"',
      }),
      weak,
    )

    // #then both are withheld
    expect(result.attributes['gen_ai.tool.call.result']).toBeUndefined()
    expect(result.attributes['fro_bot.note']).toBe('[omitted]')
  })

  it('never fires in normal operation, and does not feed back into the matchers', () => {
    // #given the real scrubber and a span holding the literal in several shapes
    const before = real.survivalCount?.() ?? -1
    const result = scrubSpan(
      span({
        'fro_bot.note': `note ${SECRET}`,
        'gen_ai.tool.call.result': contentAttribute(
          {content: [{type: 'text', text: JSON.stringify({a: SECRET})}]},
          65_536,
        ),
      }),
      real,
    )

    // #then the matchers removed it, the safety net had nothing to do, and the count did not move
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(result.attributes[MARKER.omitted]).toBeUndefined()
    expect((real.survivalCount?.() ?? -1) - before).toBe(0)
  })
})

describe('a value whose end cannot be established withholds the whole string', () => {
  const scrubber = createScrubber({env: {}})

  it.each([
    ['an unbalanced bracket', 'client_secret:{[{[ first passphrase: "multi\nline words" tail'],
    ['an unterminated quote', "secret: \"abc passphrase: 'multi\nline words' tail"],
  ])('withholds %s whole, with a longer value inside it too', (_label, text) => {
    // #given an outer value whose end could not be found, with a longer value inside it
    // #then nothing is exported: no "up to the end of the line", so nothing for a longer inner value to hide in
    expect(scrubber.scrub(text)).toEqual({ok: false, reason: 'sensitive-value-unbounded'})
  })

  it('stays linear on many such openers on one line', () => {
    // #given 4,000 unbalanced openers on one long line, then 4x as many
    const unit = 'secret: {[ pad '
    // CPU time, the least of five runs (see `timing.testing.ts`): load on the machine cannot fail it.
    const time = (n: number): number => {
      const text = unit.repeat(n)
      return minCpuMs(() => {
        scrubber.scrub(text)
      })
    }
    const small = Math.max(time(4_000), 1)
    const large = time(16_000)

    // #then about four times the time, far from sixteen, and quick in absolute terms
    expect(large).toBeLessThan(2_000)
    expect(large / small).toBeLessThan(10)
  })
})

describe('output is built from scanned text, never from the source or a re-serialization', () => {
  const scrubber = createScrubber({env: {}})

  it('keeps the formatting of a pretty-printed document in a string, and replaces only the value', () => {
    // #given a pretty-printed document with a sensitive key (the old design re-serialized it compactly, or returned the source)
    const text = '{\n  "keep": "fine",\n  "password": {"a": [1, 2]},\n  "tail": "after"\n}'

    // #when
    const result = scrubber.scrub(text)

    // #then the layout is the original's, with the value replaced by the marker
    expect(result).toEqual({
      ok: true,
      text: `{\n  "keep": "fine",\n  "password": ${REDACTION},\n  "tail": "after"\n}`,
      redactions: 1,
    })
  })

  it('returns a string with no match as the same text, and one with a match as text containing a marker', () => {
    // #given
    const plain = '{"a": 1,  "b": [ 2 ] }'

    // #then
    expect(scrubber.scrub(plain)).toEqual({ok: true, text: plain, redactions: 0})
    expect(scrubber.scrub(`${plain} ${GITHUB}`)).toEqual({ok: true, text: `${plain} ${REDACTION}`, redactions: 1})
  })
})

describe('a sensitive key whose value starts on a later line (pretty-printed JSON)', () => {
  const scrubber = createScrubber({env: {}})
  const wrap = (text: string): string => JSON.stringify({v: text})

  /** The value as pretty-printed text, nested lines indented one level further, with this end-of-line. */
  const VALUES = [
    {label: 'a string', value: () => '"hunter two words"', secrets: ['hunter', 'two words']},
    {
      label: 'an object',
      value: (i: string, e: string) =>
        `{${e}${i}${i}${i}"inner": "deep secret",${e}${i}${i}${i}"n": [1, 2]${e}${i}${i}}`,
      secrets: ['deep secret', 'inner'],
    },
    {
      label: 'an array',
      value: (i: string, e: string) => `[${e}${i}${i}${i}"first secret",${e}${i}${i}${i}2718281${e}${i}${i}]`,
      secrets: ['first secret', '2718281'],
    },
    {label: 'a number', value: () => '8675309', secrets: ['8675309']},
    {label: 'null', value: () => 'null', secrets: ['"password":\n']},
  ] as const

  const document = (value: string, indent: string, eol: string, depth: number): string => {
    let text = `{${eol}${indent}"keep": "fine-text",${eol}${indent}"password":${eol}${indent}${indent}${value},${eol}${indent}"tail": "after-text"${eol}}`
    for (let layer = 0; layer < depth; layer += 1) text = wrap(text)
    return text
  }

  for (const [indentLabel, indent] of [
    ['2-space', '  '],
    ['tab', '\t'],
  ] as const) {
    for (const [eolLabel, eol] of [
      ['LF', '\n'],
      ['CRLF', '\r\n'],
    ] as const) {
      for (const depth of [0, 1, 3] as const) {
        for (const {label, value, secrets} of VALUES) {
          it(`removes ${label} on the next line: ${indentLabel} indent, ${eolLabel}, escape depth ${String(depth)}`, () => {
            // #given the pretty-printed document
            const text = document(value(indent, eol), indent, eol, depth)

            for (const {where, value: placed} of placements(text)) {
              // #when
              const out = exported(placed, scrubber)

              // #then nothing of the value survives and the rest of the document is intact
              for (const secret of secrets) {
                if (secret.startsWith('"password"')) continue
                expect({where, secret, found: out.includes(secret)}).toEqual({where, secret, found: false})
              }
              expect({where, kept: out.includes('fine-text') && out.includes('after-text')}).toEqual({
                where,
                kept: true,
              })
              expect(out).toContain(REDACTION)
            }
          })
        }
      }
    }
  }

  it('also removes a value after more than four spaces on the same line, for a quoted key', () => {
    // #given a quoted key, a colon and ten spaces before the value
    const out = scrubber.scrub('{"password":          "hunter two", "ok": 1}')

    // #then
    expect(out).toEqual({ok: true, text: `{"password":          "${REDACTION}", "ok": 1}`, redactions: 1})
  })

  it('does not look past a newline for an UNQUOTED name: prose stays prose', () => {
    // #given free text where nothing follows `password:` on its line
    const text = 'Enter your password:\nis stored in the vault.\nSet token=\nlater'

    // #then nothing is redacted
    expect(scrubber.scrub(text)).toEqual({ok: true, text, redactions: 0})
  })

  it('fails closed past the whitespace bound: the whole string is withheld', () => {
    // #given a quoted key, 300 newlines (past the 256-character bound), then a string value and more on that line
    const text = `{"password":${'\n'.repeat(300)}"leaky words", "tail": "after-text"}\nnext line stays`

    // #when / #then the value's start cannot be told, so nothing of the string is exported
    expect(scrubber.scrub(text)).toEqual({ok: false, reason: 'sensitive-value-unbounded'})
  })

  it('counts a number after a counter name as a counter, even from the next line', () => {
    // #given
    const text = '{"max_tokens":\n  8000,\n  "password":\n  12345678}'

    // #when
    const out = scrubber.scrub(text)

    // #then the counter stays, the password does not
    expect(out).toEqual({ok: true, text: `{"max_tokens":\n  8000,\n  "password":\n  ${REDACTION}}`, redactions: 1})
  })
})
