/**
 * Every legal way to spell an object member in JSON text that holds a sensitive key, read from a string, through `scrubSpan`
 * (a tool result, a tool argument, a message text). The value is a fixture that is NOT in any configured secret list and has no
 * recognisable token shape, so only the key can give it away. The pre-round-4 design parsed the string and caught every one
 * of these; the matchers must too, without parsing: whitespace before the colon, `\u` and other escapes in the key, a long
 * suffix, spaces and zero-width characters in the key, at escape depths 0, 1 and 3.
 */

import {describe, expect, it} from 'vitest'

import {contentAttribute, createScrubber, MARKER, REDACTION, scrubSpan, type PendingSpan} from './content.js'

const VALUE = 'zxq-plain-value-4817'
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

/** The document as a string at escape depth `depth`: `depth` times held in a JSON string. */
const wrap = (text: string, depth: number): string => {
  let current = text
  for (let layer = 0; layer < depth; layer += 1) current = JSON.stringify({v: current})
  return current
}

const DEPTHS = [0, 1, 3] as const

/** The value is removed and the neighbours are not: redacted in place, no omission. */
function expectRedactedInPlace(document: string): void {
  for (const depth of DEPTHS) {
    for (const {where, value} of placements(wrap(document, depth))) {
      const result = run(value)
      const out = JSON.stringify(result.attributes[ATTRIBUTE])
      expect({where, depth, leaked: out.includes(VALUE)}).toEqual({where, depth, leaked: false})
      expect({where, depth, redacted: out.includes(REDACTION)}).toEqual({where, depth, redacted: true})
      expect({where, depth, neighbours: out.includes('keep-text') && out.includes('after-text')}).toEqual({
        where,
        depth,
        neighbours: true,
      })
      expect({where, depth, omitted: result.attributes[MARKER.omitted]}).toEqual({where, depth, omitted: undefined})
    }
  }
}

/** A member `key: value` inside a small document with a neighbour on each side. */
const member = (key: string, between = '', after = ' ', value = `"${VALUE}"`): string =>
  `{"keep": "keep-text", ${key}${between}:${after}${value}, "tail": "after-text"}`

describe('JSON whitespace between a quoted key and its colon', () => {
  it.each([
    ['a space', ' '],
    ['a line feed', '\n'],
    ['a carriage return and line feed', '\r\n'],
    ['a tab', '\t'],
    ['a tab-indented line break', '\r\n\t\t'],
    ['mixed whitespace', ' \t\n \r\n '],
  ])('removes the value after %s before the colon', (_label, gap) => {
    expectRedactedInPlace(member('"password"', gap))
  })

  it('does so for every shape of value, and with whitespace after the colon too', () => {
    for (const value of ['"two words"', '{"a": [1, {"b": "c"}]}', '["x y", 2]', '8675309', 'null', 'true']) {
      const text = member('"token"', '\n  ', '\n  ', value)
      for (const depth of DEPTHS) {
        const out = scrubber.scrub(wrap(text, depth))
        expect({depth, value, ok: out.ok}).toEqual({depth, value, ok: true})
        const exported = out.ok ? out.text : ''
        expect({depth, value, redacted: exported.includes(REDACTION)}).toEqual({depth, value, redacted: true})
        expect({depth, value, kept: exported.includes('after-text')}).toEqual({depth, value, kept: true})
      }
    }
  })

  it('does so for a key too long for the quoted-key pass, found by the spelling of its word', () => {
    // #given a key of 2,000 characters that ends in the word (past the 1,024-character bound of the key pass)
    for (const gap of ['\n', '\r\n\t']) expectRedactedInPlace(member(`"${'x'.repeat(2_000)}password"`, gap))
  })

  it('withholds the whole string when the whitespace before the colon is over the bound', () => {
    // #given a quoted key, 300 characters of valid JSON whitespace, then a colon and a value
    const text = `before-text {"password"${' \n'.repeat(150)}: "${VALUE}"} after-text`

    // #then the key is recognised but where its value starts cannot be told: nothing of the string is exported
    for (const {where, value} of placements(text)) {
      const result = run(value)
      const out = JSON.stringify(result.attributes[ATTRIBUTE])
      expect({where, leaked: out.includes(VALUE) || out.includes('before-text')}).toEqual({where, leaked: false})
      expect({where, reasons: result.attributes[MARKER.omitted]}).toEqual({where, reasons: [`${ATTRIBUTE}:${REASON}`]})
    }
  })

  it('leaves a quoted word that is not a key alone, however much whitespace follows it', () => {
    // #given a quoted sensitive word that no colon follows
    const text = `say "password"${' \n'.repeat(200)}and "token" ${'\n'.repeat(300)}then more`

    // #then
    expect(scrubber.scrub(text)).toEqual({ok: true, text, redactions: 0})
  })
})

describe('a sensitive word spelled with escapes in the key', () => {
  const u = (text: string): string =>
    [...text].map(char => String.raw`\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')

  it.each([
    ['one letter', String.raw`p\u0061ssword`],
    ['the first letter', String.raw`\u0070assword`],
    ['the last letter', String.raw`passwor\u0064`],
    ['every letter', u('password')],
    [
      'every letter, upper-case hex digits',
      u('password')
        .replaceAll(/[a-f]/g, letter => letter.toUpperCase())
        .replaceAll(String.raw`\U`, String.raw`\u`),
    ],
    ['lower-case hex (o is 6f)', String.raw`passw\u006frd`],
    ['upper-case hex (o is 6F)', String.raw`passw\u006Frd`],
    ['a capital letter written as an escape', String.raw`\u0050assword`],
    ['a surrogate pair elsewhere in the key', String.raw`\ud83d\ude00p\u0061ssword`],
    ['a surrogate pair after the word', String.raw`p\u0061ssword\ud83d\ude00`],
    ['an escaped underscore in a compound name', String.raw`api\u005fkey`],
    ['an escaped hyphen in a compound name', String.raw`api\u002dkey`],
    ['an escaped letter in a longer name', String.raw`db_p\u0061ssword_hash`],
  ])('removes the value of a key with %s', (_label, key) => {
    expectRedactedInPlace(member(`"${key}"`))
  })

  it('does so together with whitespace before the colon', () => {
    for (const gap of ['\n', '\r\n\t', ' \n ']) expectRedactedInPlace(member(String.raw`"p\u0061ssword"`, gap, '\n  '))
  })

  it.each([
    ['a line feed', String.raw`\n`],
    ['a tab', String.raw`\t`],
    ['a slash', String.raw`\/`],
    ['a backslash pair', '\\\\'],
    ['a backspace', String.raw`\b`],
  ])('removes the value of a key with %s after the word (the escape decodes into the name)', (_label, escape) => {
    expectRedactedInPlace(member(`"password${escape}"`))
  })

  it('does not treat an escaped key that decodes to an ordinary name as sensitive', () => {
    // #given keys that decode to `name`, and a counter name
    const text = String.raw`{"keep": "keep-text", "n\u0061me": "${VALUE}", "max_t\u006fkens": 8000, "tail": "after-text"}`

    // #then they are left alone
    expect(scrubber.scrub(text)).toEqual({ok: true, text, redactions: 0})
  })

  it('withholds the whole string for an escaped key whose value end cannot be established', () => {
    // #given a `\u`-escaped sensitive key with an unterminated string value, then more lines
    const text = `before-text {"p\\u0061ssword": "no closing quote\nleaky second line after-text`

    // #then
    for (const {where, value} of placements(text)) {
      const result = run(value)
      const out = JSON.stringify(result.attributes[ATTRIBUTE])
      expect({where, leaked: out.includes('leaky') || out.includes('before-text')}).toEqual({where, leaked: false})
      expect({where, reasons: result.attributes[MARKER.omitted]}).toEqual({where, reasons: [`${ATTRIBUTE}:${REASON}`]})
    }
  })
})

describe('the rest of the JSON grammar', () => {
  it.each([
    ['the word with a suffix longer than twenty characters', '"passwordHashSaltPepperPlusLonger"'],
    ['the word with a short suffix', '"passwordHash"'],
    ['the word with a prefix', '"db_password"'],
    ['mixed case', '"PassWord"'],
    ['upper case', '"PASSWORD"'],
    ['spaces in the key', '"my password hint"'],
    ['a zero-width space inside the word, written as an escape', String.raw`"pass\u200bword"`],
    ['a zero-width space inside the word, as the character', '"pass\u200Bword"'],
    ['a zero-width joiner and a word joiner', '"pa\u200Dss\u2060word"'],
    ['a byte order mark before the word, as an escape', String.raw`"\ufeffpassword"`],
    ['a byte order mark inside the word, as the character', '"pass\uFEFFword"'],
  ])('removes the value of a key with %s', (_label, key) => {
    expectRedactedInPlace(member(key))
  })

  it('removes the value of every one of several keys in one document, duplicates included', () => {
    // #given the same sensitive key twice with different values, and an escaped one
    const text = String.raw`{"password": "first-${VALUE}", "p\u0061ssword": "second-${VALUE}", "password": "third-${VALUE}", "ok": "after-text"}`

    // #when
    const out = scrubber.scrub(text)

    // #then
    expect(out).toEqual({
      ok: true,
      text: String.raw`{"password": "${REDACTION}", "p\u0061ssword": "${REDACTION}", "password": "${REDACTION}", "ok": "after-text"}`,
      redactions: 3,
    })
  })

  it('finds a member in nested objects and arrays, and one split across lines', () => {
    // #given
    const nested = `{"a": {"b": [{"keep": "keep-text"}, {"p\\u0061ssword"\n:\n  "${VALUE}"}]}, "tail": "after-text"}`

    // #then
    expectRedactedInPlace(nested)
  })

  it('leaves a key that is only a value elsewhere, and the empty key, alone', () => {
    // #given
    const text = `{"a": "password", "b": "${VALUE}", "": "${VALUE}", "c": "token"}`

    // #then nothing is a sensitive key
    expect(scrubber.scrub(text)).toEqual({ok: true, text, redactions: 0})
  })

  it('keeps the unquoted forms as they were: no line-crossing gap in free text', () => {
    // #given prose where nothing follows the name on its line, and the YAML block form
    const prose = `Enter your password:\nis stored in the vault.\nSet token=\nlater`
    const yaml = `password:\n  ${VALUE}`

    // #then prose is left alone; the block form is a known limit and is not redacted
    expect(scrubber.scrub(prose)).toEqual({ok: true, text: prose, redactions: 0})
    expect(scrubber.scrub(yaml)).toEqual({ok: true, text: yaml, redactions: 0})
  })

  it.each([
    ['a single-quoted key', `{'password': '${VALUE}', 'ok': 'after-text'}`],
    ['an unquoted key with a colon', `password: ${VALUE} after-text`],
    ['an unquoted key with an equals sign', `password=${VALUE} after-text`],
    ['a key in quotes with an equals sign', `"password"=${VALUE} after-text`],
  ])('still removes the value of %s', (_label, text) => {
    const out = scrubber.scrub(text)
    expect(out.ok && out.text.includes(VALUE)).toBe(false)
    expect(out.ok && out.text.includes('after-text')).toBe(true)
  })
})

describe('a key that cannot be decoded is not inspected, and does not withhold', () => {
  it.each([
    ['a malformed escape', String.raw`{"keep": "keep-text", "p\uZZ61ssword": "${VALUE}", "tail": "after-text"}`],
    [
      'a key longer than the bound',
      String.raw`{"keep": "keep-text", "${'x'.repeat(2_000)}p\u0061ssword": "${VALUE}", "tail": "after-text"}`,
    ],
    ['an unknown escape', String.raw`{"keep": "keep-text", "p\qssword": "${VALUE}", "tail": "after-text"}`],
  ])('leaves %s alone: the string is exported as written', (_label, text) => {
    // #given a key that is not valid JSON, or is not a name; withholding on it would withhold any text with a backslash in it
    // #then nothing is redacted and nothing is withheld
    expect(scrubber.scrub(text)).toEqual({ok: true, text, redactions: 0})
  })

  it('does not withhold ordinary text full of backslashes and colons', () => {
    // #given paths, regular expressions and escaped text with colons
    const text = String.raw`C:\Users\dev\app: "main": 1, pattern "\d+\.\d+": x, line "a\nb": y, "k\u00e9y": z`

    // #then
    expect(scrubber.scrub(text)).toEqual({ok: true, text, redactions: 0})
  })
})
