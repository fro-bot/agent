/**
 * The scrubber's one guarantee, tested directly: every text rule is a pure matcher over the ORIGINAL string, the ranges are
 * united, and the output is built once, so nothing a rule removes depends on another rule or on the order they run in.
 * Five earlier findings were the same bug in different clothes (a pass rewrote the text and a later pass read the rewrite);
 * these tests are what would have caught all five.
 */

import {describe, expect, it} from 'vitest'

import {
  contentAttribute,
  createScrubber,
  literalMatcher,
  MARKER,
  matchRanges,
  MAX_RANGES,
  REDACTION,
  SCRUB_PATTERNS,
  scrubSpan,
  scrubWithMatchers,
  type PendingSpan,
  type ScrubMatcher,
} from './content.js'
import {createLegacyScrubber} from './content.legacy.testing.js'

// Fixture secrets are assembled at run time so no scanner mistakes this file for a leak.
const join = (...parts: string[]): string => parts.join('')

/** Words that must never appear in a filler or a name, so a surviving 4-gram of a secret cannot be a coincidence. */
const FILLER = ['and', 'then', 'log', 'ok', 'the', 'line', 'done', 'next', 'here', 'once', 'also', 'more']
const NAMES = [
  'password',
  'token',
  'secret',
  'api_key',
  'authorization',
  'client_secret',
  'pwd',
  'passphrase',
  'X_API_KEY',
]

/** A multi-word literal the plugin's environment holds (the reviewer's case): spaces inside it, so a rule that reads one token cannot cover it. */
const ENV_MULTI = join('zqxv env ', '7f3a9c21 kwjd')
const ENV_ONE = join('kwjd-env-', 'zqxv-1d8e5b04')
const ENV = {API_TOKEN: ENV_ONE, DB_PASSWORD: ENV_MULTI}
const LITERALS = [ENV_ONE, ENV_MULTI]

/** Token shapes: the whole string is the secret. */
const TOKENS = {
  openai: join('sk-', 'Q9x8W7e6R5t4Y3u2I1o0P9a8S7d6'),
  anthropic: join('sk-ant-', 'api03-', 'Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe'),
  githubClassic: join('ghp_', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5'),
  githubFine: join('github_pat_', '11ABCDEFG0aBcDeFgHiJkL_mNoPqRsTuVwXyZ0123456789'),
  aws: join('AKIA', 'IOSFODNN7EXAMPLE'),
  slack: join('xox', 'b-123456789012-abcdefghij'),
  google: join('AIza', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'),
  jwt: join('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dBjftJeZ4CVPmB92K27uhbUJU1p1r'),
} as const
const ATOMS = ['zqxv9kwj3', 'kwjd7qzx2v', 'xzqk4jwv8', 'vjwq5zkx1', 'qzvx6kjw0']
const PEM_BODY = 'MIIEowIBAAKCAQEAfakefakefake'
const PEM = join('-----BEGIN RSA PRIVATE', ' KEY-----\n', PEM_BODY, '\n-----END RSA PRIVATE', ' KEY-----')
const SCHEME_CREDENTIAL = 'f4k3T0k3nValue0123456789'

interface Piece {
  /** The text, as it goes into the input. */
  readonly text: string
  /** Atoms that must not survive in any form of 4 characters or more. */
  readonly secrets: readonly string[]
}

/** Deterministic PRNG (mulberry32): the same seed always makes the same corpus. */
function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)] as T

/** One piece of an input: a shape from one rule, or a composition of several (a token inside a quoted password, and so on). */
function piece(random: () => number): Piece {
  const token = pick(random, Object.values(TOKENS))
  const atom = pick(random, ATOMS)
  const name = pick(random, NAMES)
  const sep = pick(random, [': ', '=', ':', ' = '])
  switch (Math.floor(random() * 16)) {
    case 0:
      return {text: token, secrets: [token]}
    case 1:
      return {text: `${name}${sep}${token}`, secrets: [token]}
    case 2:
      return {text: `${name}${sep}${atom}`, secrets: [atom]}
    case 3:
      return {text: `${name}${sep}"${token} ${atom} ${ENV_ONE}"`, secrets: [token, atom, ENV_ONE]}
    case 4:
      return {text: `${name}${sep}'${atom} ${token}'`, secrets: [atom, token]}
    case 5:
      return {text: String.raw`${name}${sep}\"${ENV_MULTI} ${atom}\"`, secrets: [...ENV_MULTI.split(' '), atom]}
    case 6:
      // The reviewer's case: a multi-word environment literal printed UNQUOTED after a sensitive name.
      return {text: `${name}${sep}${ENV_MULTI} ${pick(random, FILLER)}`, secrets: ENV_MULTI.split(' ')}
    case 7:
      return {text: ENV_MULTI, secrets: ENV_MULTI.split(' ')}
    case 8:
      return {text: `Authorization: Bearer ${SCHEME_CREDENTIAL}`, secrets: [SCHEME_CREDENTIAL]}
    case 9:
      return {text: `${pick(random, ['Basic', 'Token', 'Digest'])} ${SCHEME_CREDENTIAL}`, secrets: [SCHEME_CREDENTIAL]}
    case 10:
      return {text: `https://deploy:${atom}@git.host.test/r`, secrets: [`deploy:${atom}`]}
    case 11:
      return {text: `https://x.host.test/p?api_key=${atom}&page=2`, secrets: [atom]}
    case 12:
      return {text: `{"${name}": "${atom} ${token}", "ok": true}`, secrets: [atom, token]}
    case 13:
      return {text: `${PEM}`, secrets: [PEM_BODY]}
    case 14:
      return {text: `${name}${sep}${token}${token}`, secrets: [token]}
    default:
      return {text: `${name}${sep}"${PEM} ${atom}"`, secrets: [PEM_BODY, atom]}
  }
}

const SEPARATORS = [' ', '\n', ' | ', ', ', '\t', ' and ', ' 😀 ', '; ', ' (', ') ']

function corpus(seed: number, count: number): {readonly text: string; readonly secrets: readonly string[]}[] {
  const random = prng(seed)
  const inputs: {text: string; secrets: string[]}[] = []
  for (let index = 0; index < count; index += 1) {
    const pieces = Array.from({length: 1 + Math.floor(random() * 5)}, () => piece(random))
    // Repeats make overlapping and adjacent candidates: the same piece twice, and one piece glued after another.
    if (random() < 0.3) pieces.push(pieces[0] as Piece)
    let text = pick(random, FILLER)
    const secrets: string[] = []
    for (const [position, next] of pieces.entries()) {
      // Glued pieces touch with a delimiter between them (a word character would legitimately stop a rule's word boundary).
      text += position > 0 && random() < 0.15 ? pick(random, [',', ';', ')']) : pick(random, SEPARATORS)
      text += next.text
      secrets.push(...next.secrets)
    }
    inputs.push({text: text + pick(random, SEPARATORS), secrets})
  }
  return inputs
}

const fourGrams = (secret: string): string[] =>
  Array.from({length: Math.max(0, secret.length - 3)}, (_, index) => secret.slice(index, index + 4))

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1))
    ;[copy[index], copy[other]] = [copy[other] as T, copy[index] as T]
  }
  return copy
}

const matchers: ScrubMatcher[] = [...SCRUB_PATTERNS, literalMatcher(LITERALS)]

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

describe('the reviewer’s case, at the exported-span level', () => {
  const scrubber = createScrubber({env: ENV})
  const exported = (value: unknown): string => {
    const result = scrubSpan(span({'gen_ai.tool.call.arguments': contentAttribute(value, 65_536)}), scrubber)
    return JSON.stringify([result.name, result.attributes])
  }
  const words = ENV_MULTI.split(' ')

  it.each(NAMES)('removes every word of a multi-word environment literal printed unquoted after `%s`', name => {
    // #given the literal as an unquoted value, in a plain attribute, a JSON string inside a tool result, and a tool argument
    const plain = scrubSpan(span({'fro_bot.note': `${name}: ${ENV_MULTI} and more`}), scrubber)
    const embedded = exported({
      content: [{type: 'text', text: JSON.stringify({log: `${name}: ${ENV_MULTI} and more`})}],
    })
    const argument = exported({command: `echo ${name}=${ENV_MULTI} done`, nested: [{note: `${name}: ${ENV_MULTI}`}]})

    // #then no word of it reaches any of them, and what is not secret does
    for (const word of words) {
      expect({word, found: JSON.stringify(plain.attributes).includes(word)}).toEqual({word, found: false})
      expect({word, found: embedded.includes(word)}).toEqual({word, found: false})
      expect({word, found: argument.includes(word)}).toEqual({word, found: false})
    }
    expect(plain.attributes['fro_bot.note']).toBe(`${name}: ${REDACTION} and more`)
  })

  it('removes a shorter literal or token at the start of a longer quoted password (last round’s mirror image)', () => {
    // #given a quoted password whose first word is the single-word literal, then more words
    const input = `login password: "${ENV_ONE} second third fourth" done`

    // #when
    const out = scrubSpan(span({'fro_bot.note': input}), scrubber).attributes['fro_bot.note']

    // #then
    expect(out).toBe(`login password: "${REDACTION}" done`)
  })
})

describe('order independence', () => {
  const inputs = corpus(0x5eed_c0de, 4_000)
  const orders: {readonly label: string; readonly order: ScrubMatcher[]}[] = [
    {label: 'as listed', order: matchers},
    {label: 'reversed', order: [...matchers].toReversed()},
    ...[1, 2, 3, 4].map(seed => ({label: `shuffle ${String(seed)}`, order: shuffled(matchers, prng(seed))})),
    {label: 'literals first', order: [matchers.at(-1) as ScrubMatcher, ...matchers.slice(0, -1)]},
  ]

  it('gives the same output and the same count for every order of the matchers, on thousands of inputs', () => {
    // #given thousands of inputs mixing every rule's shape (overlapping, nested, adjacent, repeated), from a fixed seed
    expect(inputs).toHaveLength(4_000)
    const mismatches: string[] = []

    // #when each is scrubbed with every order
    for (const {text} of inputs) {
      const [first, ...rest] = orders.map(({order}) => scrubWithMatchers(text, order))
      for (const [index, other] of rest.entries()) {
        if (other.text !== first?.text || other.redactions !== first.redactions) {
          mismatches.push(`${orders[index + 1]?.label ?? '?'}: ${JSON.stringify(text.slice(0, 120))}`)
        }
      }
    }

    // #then no input differs under any order
    expect(mismatches.slice(0, 5)).toEqual([])
    expect(mismatches).toHaveLength(0)
  })

  it('leaves no 4-character piece of any fixture secret in any output', () => {
    // #given the same corpus and the as-listed order
    const survivors: string[] = []

    // #when
    for (const {text, secrets} of inputs) {
      const {text: out} = scrubWithMatchers(text, matchers)

      // #then
      for (const secret of secrets) {
        for (const gram of fourGrams(secret)) {
          if (out.includes(gram))
            survivors.push(`${gram} of ${secret.slice(0, 12)} in ${JSON.stringify(out.slice(0, 100))}`)
        }
      }
    }
    expect(survivors.slice(0, 5)).toEqual([])
    expect(survivors).toHaveLength(0)
  })

  it('counts one marker per united range, however many rules contributed to it', () => {
    // #given a value that a name/value rule, a token rule and a literal all match at once
    const input = `password: "${TOKENS.githubClassic}" ${ENV_ONE}`

    // #when
    const result = scrubWithMatchers(input, matchers)

    // #then two markers: one for the quoted value (rule, token and nothing else overlap into one range), one for the literal
    expect(result).toEqual({text: `password: "${REDACTION}" ${REDACTION}`, redactions: 2})
    expect((result.text.match(/\[REDACTED\]/g) ?? []).length).toBe(result.redactions)
  })
})

describe('against the sequential design it replaced (inputs with no overlapping matches)', () => {
  const inputs = corpus(0x0d1f_f00d, 6_000)
  const legacy = createLegacyScrubber(LITERALS)

  /** True when no two ranges of any rule overlap or touch: the one case where the old design was already right. */
  const disjoint = (text: string): boolean => {
    const ranges = matchers.flatMap(matcher => matchRanges(matcher, text)).toSorted((a, b) => a.start - b.start)
    return ranges.every((range, index) => index === 0 || range.start > (ranges[index - 1]?.end ?? 0))
  }

  it('produces identical text and count', () => {
    // #given the inputs whose matches do not overlap or touch
    const same = inputs.filter(({text}) => disjoint(text))

    // #when both implementations scrub them
    const differences = same.filter(({text}) => {
      const before = legacy.scrub(text)
      const after = scrubWithMatchers(text, matchers)
      return before.text !== after.text || before.redactions !== after.redactions
    })

    // #then they agree on every one, and there were enough of them to mean something
    expect(same.length).toBeGreaterThan(300)
    expect(differences.slice(0, 3).map(({text}) => text.slice(0, 160))).toEqual([])
    expect(differences).toHaveLength(0)
  })

  it('differs, on purpose, where matches overlap: the old design could leak or split, the union cannot', () => {
    // #given the inputs the new design unites ranges for
    const overlapping = inputs.filter(({text}) => !disjoint(text))
    const leaked = overlapping.filter(({text, secrets}) => {
      const before = legacy.scrub(text).text
      return secrets.some(secret => fourGrams(secret).some(gram => before.includes(gram)))
    })

    // #then there are many such inputs, and the old design is shown to leave a piece of a secret in some of them (the new one
    // never does: see the corpus test above)
    expect(overlapping.length).toBeGreaterThan(1_000)
    expect(leaked.length).toBeGreaterThan(0)
  })

  it('keeps the whitespace between an authorization scheme and its credential (the old rule wrote one space)', () => {
    // #given a scheme word and three blanks
    const input = `Bearer   ${SCHEME_CREDENTIAL}`

    // #then the range is the credential only: the blanks stay as written, where the old rule normalised them
    expect(scrubWithMatchers(input, matchers).text).toBe(`Bearer   ${REDACTION}`)
    expect(legacy.scrub(input).text).toBe(`Bearer ${REDACTION}`)
  })
})

describe('edges of the union', () => {
  const at = (...ranges: [number, number][]): ScrubMatcher => ({
    id: 'fixed',
    find: (_text, _lower, emit) => {
      for (const [start, end] of ranges) emit(start, end)
    },
  })

  it('unites ranges that touch, and keeps ranges one character apart separate', () => {
    // #given 12 characters
    const text = 'abcdefghijkl'

    // #then [0,3) and [3,6) touch and become one marker; [0,3) and [4,6) stay two
    expect(scrubWithMatchers(text, [at([0, 3], [3, 6])])).toEqual({text: `${REDACTION}ghijkl`, redactions: 1})
    expect(scrubWithMatchers(text, [at([0, 3], [4, 6])])).toEqual({
      text: `${REDACTION}d${REDACTION}ghijkl`,
      redactions: 2,
    })
  })

  it('unites overlapping and nested ranges, from one matcher or two, in any order', () => {
    // #given
    const text = 'abcdefghijkl'
    const expected = {text: `${REDACTION}jkl`, redactions: 1}

    // #then
    expect(scrubWithMatchers(text, [at([0, 5], [2, 9])])).toEqual(expected)
    expect(scrubWithMatchers(text, [at([2, 9]), at([0, 5])])).toEqual(expected)
    expect(scrubWithMatchers(text, [at([0, 9]), at([2, 4], [5, 7])])).toEqual(expected)
  })

  it('redacts a match at offset 0 and one that ends the string, and the whole string', () => {
    // #given
    const text = 'abcdefghijkl'

    // #then
    expect(scrubWithMatchers(text, [at([0, 2])]).text).toBe(`${REDACTION}cdefghijkl`)
    expect(scrubWithMatchers(text, [at([10, 12])]).text).toBe(`abcdefghij${REDACTION}`)
    expect(scrubWithMatchers(text, [at([0, 12])])).toEqual({text: REDACTION, redactions: 1})
    expect(scrubWithMatchers(`password=${TOKENS.openai}`, matchers).text).toBe(`password=${REDACTION}`)
    expect(scrubWithMatchers(TOKENS.openai, matchers).text).toBe(REDACTION)
  })

  it('ignores empty and out-of-range ranges instead of failing', () => {
    // #given
    const text = 'abcdef'

    // #then
    expect(scrubWithMatchers(text, [at([3, 3], [4, 2])])).toEqual({text, redactions: 0})
    expect(scrubWithMatchers(text, [at([-5, 2], [4, 99])])).toEqual({text: `${REDACTION}cd${REDACTION}`, redactions: 2})
  })

  it('moves a range edge that would split a surrogate pair outward, so no lone half is left', () => {
    // #given `a😀b`: a=0, high=1, low=2, b=3
    const text = 'a😀b'

    // #when a range starts on the low half, ends after the high half, and covers a pair completely
    const startsInside = scrubWithMatchers(text, [at([2, 4])])
    const endsInside = scrubWithMatchers(text, [at([0, 2])])
    const covers = scrubWithMatchers(text, [at([1, 3])])

    // #then every output is well formed and nothing of the pair remains
    expect(startsInside.text).toBe(`a${REDACTION}`)
    expect(endsInside.text).toBe(`${REDACTION}b`)
    expect(covers.text).toBe(`a${REDACTION}b`)
    for (const result of [startsInside, endsInside, covers]) expect(result.text.isWellFormed()).toBe(true)
  })

  it('leaves a surrogate pair next to a range whole, and cuts a real rule’s 256-character userinfo limit on a pair edge', () => {
    // #given an emoji directly before and after a token, and a userinfo whose 256th character is half of an emoji
    const beside = `😀${TOKENS.openai}😀`
    const userinfo = `https://${'x'.repeat(255)}😀tail@host.test/`

    // #when
    const a = scrubWithMatchers(beside, matchers)
    const b = scrubWithMatchers(userinfo, matchers)

    // #then both outputs are well formed and the pairs that were not part of a range are intact
    expect(a.text).toBe(`😀${REDACTION}😀`)
    expect(b.text.isWellFormed()).toBe(true)
  })

  it('treats marker text in the original input as ordinary text', () => {
    // #given text that already holds the marker, beside a secret, a value that equals it, and a quoted one
    const input = `${REDACTION} ${TOKENS.openai} password: "${REDACTION}" secret=${REDACTION}`

    // #when
    const result = scrubWithMatchers(input, matchers)

    // #then no crash, the secret is gone, and the text that was already the marker is left as text (one more marker where a rule
    // matched it as a value)
    expect(result.text).not.toContain('Q9x8W7e6R5')
    expect(result.text.startsWith(`${REDACTION} ${REDACTION} password: "${REDACTION}"`)).toBe(true)
  })

  describe('the range cap', () => {
    const unit = `${TOKENS.aws} `

    it('scrubs a value with exactly the cap of ranges, and omits one with a single range more, without scanning on', () => {
      // #given texts with the cap and the cap plus one distinct matches
      const scrubber = createScrubber({env: {}})
      const atCap = unit.repeat(MAX_RANGES)
      const over = unit.repeat(MAX_RANGES + 1)

      // #when
      const kept = scrubber.scrub(atCap)
      const started = performance.now()
      const refused = scrubber.scrub(over)
      const elapsed = performance.now() - started

      // #then the first is scrubbed whole, the second is refused with its own reason, and quickly
      expect(kept).toMatchObject({ok: true, redactions: MAX_RANGES})
      expect(refused).toEqual({ok: false, reason: 'too-many-ranges'})
      expect(elapsed).toBeLessThan(3_000)
    })

    it('omits a content attribute with the same marker as any other value it cannot scrub, and never exports it raw', () => {
      // #given a tool result with more matches than the cap, and another attribute that is fine
      const result = scrubSpan(
        span({
          'gen_ai.tool.call.result': contentAttribute(
            {content: [{type: 'text', text: unit.repeat(MAX_RANGES + 1)}]},
            1_048_576,
          ),
          'fro_bot.note': `kept ${TOKENS.openai}`,
        }),
        createScrubber({env: {}}),
      )

      // #then
      expect(result.attributes['gen_ai.tool.call.result']).toBeUndefined()
      expect(result.attributes[MARKER.omitted]).toEqual(['gen_ai.tool.call.result:too-many-ranges'])
      expect(result.attributes['fro_bot.note']).toBe(`kept ${REDACTION}`)
    })
  })
})

describe('the structured pass and the text rules never read each other’s output', () => {
  const scrubber = createScrubber({env: ENV})
  const result = (value: unknown) => scrubSpan(span({a: contentAttribute(value, 65_536)}), scrubber)
  const out = (value: unknown): unknown => JSON.parse(String(result(value).attributes.a))

  it('writes a scrubbed leaf exactly once: its marker is not read back as the start of a value', () => {
    // #given a leaf whose text rule leaves a marker right after a secret-named assignment (reading `[REDACTED]` back would take
    // it for a value and add a bracket: `password: [REDACTED]]`)
    const exported = out({command: `password: ${ENV_MULTI}`})

    // #then it is exactly the one marker
    expect(exported).toEqual({command: `password: ${REDACTION}`})
    expect(result({command: `password: ${ENV_MULTI}`}).attributes[MARKER.redactions]).toBe(1)
  })

  it('writes the compact serialization of an embedded JSON string’s scrubbed parts, and does not scan that text again', () => {
    // #given a tool argument that is a JSON string holding a sensitive key and a text secret in another leaf
    const inner = JSON.stringify({password: 'a b c', note: `password: ${ENV_MULTI}`, fine: 'plain'})

    // #when
    const exported = out({input: inner}) as {input: string}

    // #then the embedded document is the serialization of the parts, each scrubbed from its original text once
    expect(exported.input).toBe(JSON.stringify({password: REDACTION, note: `password: ${REDACTION}`, fine: 'plain'}))
  })

  it('composes both on one value: a sensitive key goes whole, and a secret-shaped key name and value are scrubbed too', () => {
    // #given a sensitive key holding an object, and a key that is itself a token, holding a token
    const exported = out({
      secret: {nested: [TOKENS.openai, {deep: ENV_MULTI}]},
      [TOKENS.githubClassic]: TOKENS.aws,
      list: [`token = "${TOKENS.google} two words"`],
    })

    // #then
    expect(exported).toEqual({
      secret: REDACTION,
      [REDACTION]: REDACTION,
      list: [`token = "${REDACTION}"`],
    })
  })

  it('reads a leaf that is not JSON, or is cut-off JSON, from its original text', () => {
    // #given a truncated JSON string with a quoted password, a JSON string that is a bare string, and plain text
    const exported = out({
      cut: String.raw`{"log": "password: \"${ENV_MULTI} tail`,
      bare: JSON.stringify(`password=${TOKENS.openai}`),
      plain: `${TOKENS.openai} here`,
    }) as Record<string, string>

    // #then no word of any survives
    const text = JSON.stringify(exported)
    for (const word of [...ENV_MULTI.split(' '), 'Q9x8W7e6R5'])
      expect({word, found: text.includes(word)}).toEqual({word, found: false})
  })

  it('leaves an embedded JSON string byte for byte alone when nothing in it was redacted', () => {
    // #given
    const inner = '{ "a" : 1,\n  "b": [ "fine" ] }'

    // #then
    expect(out({input: inner})).toEqual({input: inner})
  })
})
