/**
 * The scan of a `{`/`[` value under a sensitive key matches each closer to the innermost open bracket. A closer of the other
 * type, or a nesting deeper than the bound, means the end of the value cannot be established: the whole string is withheld
 * (`sensitive-value-unbounded`), never cut at a closer that merely happens to bring the depth to zero.
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

/** The document at escape depth `depth`: held in a JSON string `depth` times. */
const wrap = (text: string, depth: number): string => {
  let current = text
  for (let layer = 0; layer < depth; layer += 1) current = JSON.stringify({v: current})
  return current
}

const DEPTHS = [0, 1, 3] as const

/** Nothing of the string is exported: the leaf is the marker, and the span says why. */
function expectWithheld(document: string, depths: readonly number[] = DEPTHS): void {
  for (const depth of depths) {
    for (const {where, value} of placements(wrap(document, depth))) {
      const result = run(value)
      const out = JSON.stringify(result.attributes[ATTRIBUTE])
      expect({
        where,
        depth,
        leaked: out.includes(VALUE) || out.includes('before-text') || out.includes('after-text'),
      }).toEqual({
        where,
        depth,
        leaked: false,
      })
      expect({where, depth, marked: out.includes('[omitted]')}).toEqual({where, depth, marked: true})
      expect({where, depth, reasons: result.attributes[MARKER.omitted]}).toEqual({
        where,
        depth,
        reasons: [`${ATTRIBUTE}:${REASON}`],
      })
    }
  }
}

describe('a secret-named value whose brackets do not match is withheld whole', () => {
  it('for a multi-line object closed by a bracket, with the value on the lines after it', () => {
    // #given `{ ... ]` under a sensitive key (the old scan took the `]` as the end of the value), then more lines holding the value
    const text = `before-text {"password": {\n  "a": 1\n]\n  "b": "${VALUE}"\n} after-text`

    // #then
    expectWithheld(text)
  })

  it('for `[ { ... ] }`', () => {
    // #given
    const text = `before-text {"token": [\n  {\n    "a": 1\n  ]\n  }, "${VALUE}"] after-text`

    // #then
    expectWithheld(text)
  })

  it('for a free-text assignment, unquoted name', () => {
    // #given
    const text = `before-text password: {"a": [1, 2}, "b": "${VALUE}"} after-text`

    // #then
    expectWithheld(text, [0])
  })

  it('for a closer of the wrong type at the top level of the value', () => {
    for (const [open, close] of [
      ['{', ']'],
      ['[', '}'],
    ] as const)
      expectWithheld(`before-text {"secret": ${open}"a": 1${close} "b": "${VALUE}"} after-text`)
  })

  it('for a mismatch deep inside an otherwise balanced value', () => {
    // #given
    const text = `before-text {"api_key": {"a": [{"b": [1, 2}]}, "c": "${VALUE}"} after-text`

    // #then
    expectWithheld(text)
  })

  it('for a nesting deeper than the bound, even when every bracket matches', () => {
    // #given 200 levels, balanced, then a value after it
    const text = `before-text {"password": ${'['.repeat(200)}${']'.repeat(200)}, "b": "${VALUE}"} after-text`

    // #then the depth bound is reached, so the end is not established
    expectWithheld(text)
  })
})

describe('a correctly nested value is still redacted in place', () => {
  it.each([
    ['mixed `{ [ { } ] }`', '{"a": [ {"b": {}} ], "c": [{"d": [1, 2]}]}'],
    ['alternating to the depth bound', `${'{"a":['.repeat(32)}1${']}'.repeat(32)}`],
    ['brackets inside strings are ignored', '{"a": "]} [ {", "b": ["x}", "y]"]}'],
    ['an array of arrays', '[[1, 2], [3, [4, [5]]]]'],
  ])('%s', (_label, value) => {
    // #given a well-formed value under a sensitive key, with neighbours
    for (const depth of DEPTHS) {
      const text = wrap(`{"keep": "keep-text", "password": ${value}, "tail": "after-text"}`, depth)
      for (const {where, value: placed} of placements(text)) {
        // #when
        const result = run(placed)
        const out = JSON.stringify(result.attributes[ATTRIBUTE])

        // #then it is redacted in place: marker, neighbours intact, no omission
        expect({where, depth, redacted: out.includes(REDACTION)}).toEqual({where, depth, redacted: true})
        expect({where, depth, neighbours: out.includes('keep-text') && out.includes('after-text')}).toEqual({
          where,
          depth,
          neighbours: true,
        })
        expect({where, depth, omitted: result.attributes[MARKER.omitted]}).toEqual({where, depth, omitted: undefined})
      }
    }
  })

  it('redacts a value at exactly the depth bound and withholds one level past it', () => {
    // #given a value with 64 levels, then one with 65
    const nest = (levels: number): string =>
      `{"password": ${'['.repeat(levels)}${']'.repeat(levels)}, "tail": "after-text"}`

    // #then
    expect(scrubber.scrub(nest(64))).toMatchObject({ok: true, text: `{"password": ${REDACTION}, "tail": "after-text"}`})
    expect(scrubber.scrub(nest(65))).toEqual({ok: false, reason: REASON})
  })
})
