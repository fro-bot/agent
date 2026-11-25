import type {PendingSpan} from './scrub.js'
import {describe, expect, it} from 'vitest'

import {
  boundJson,
  collectLiterals,
  contentAttribute,
  createScrubber,
  DEFAULT_CONTENT_LIMITS,
  MARKER,
  matchRanges,
  REDACTION,
  SCRUB_PATTERNS,
  scrubbedBrand,
  scrubSpan,
  scrubWithMatchers,
} from './scrub.js'
import {minCpuMs} from './timing.testing.js'

// Fixture secrets are assembled at run time so no scanner mistakes this file for a leak.
const join = (...parts: string[]): string => parts.join('')
const SECRETS = {
  openai: join('sk-', 'Q9x8W7e6R5t4Y3u2I1o0P9a8S7d6'),
  anthropic: join('sk-ant-', 'api03-', 'Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe'),
  githubClassic: join('ghp_', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5'),
  githubFine: join('github_pat_', '11ABCDEFG0aBcDeFgHiJkL_mNoPqRsTuVwXyZ0123456789'),
  aws: join('AKIA', 'IOSFODNN7EXAMPLE'),
  bearer: join('Bearer ', 'f4k3T0k3nValue0123456789'),
  basic: join('Basic ', 'dXNlcjpodW50ZXIyMDI0'),
  jwt: join('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dBjftJeZ4CVPmB92K27uhbUJU1p1r'),
  pem: join('-----BEGIN RSA PRIVATE', ' KEY-----\nMIIEowIBAAKCAQEAfakefakefake\n-----END RSA PRIVATE', ' KEY-----'),
  passwordPair: 'password=hunter2xyz',
  colonPair: 'API_KEY: abcdef123456',
  jsonPair: '"client_secret": "s3cr3tvalue99"',
  connection: join('postgres://', 'app:pw12345@db.internal:5432/prod'),
  userinfo: join('https://', 'deploy:ghx12345@git.example.com/repo.git'),
  query: 'https://api.example.com/v1/items?api_key=abc123def456&page=2',
  slack: join('xox', 'b-123456789012-abcdefghij'),
  google: join('AIza', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'),
} as const

/** The part of each secret that must not survive: the sensitive value itself. */
const NEEDLES: Readonly<Record<keyof typeof SECRETS, string>> = {
  openai: 'Q9x8W7e6R5',
  anthropic: 'Zy9Xw8Vu7Ts6',
  githubClassic: 'aB3dE5fG7hJ9',
  githubFine: '11ABCDEFG0aBc',
  aws: 'IOSFODNN7EXAMPLE',
  bearer: 'f4k3T0k3nValue',
  basic: 'dXNlcjpodW50',
  jwt: 'eyJzdWIiOiIx',
  pem: 'MIIEowIBAAKC',
  passwordPair: 'hunter2xyz',
  colonPair: 'abcdef123456',
  jsonPair: 's3cr3tvalue99',
  connection: 'pw12345',
  userinfo: 'ghx12345',
  query: 'abc123def456',
  slack: '123456789012',
  google: 'A1b2C3d4E5f6',
}

const scrubber = createScrubber()
const scrubText = (text: string): string => {
  const result = scrubber.scrub(text)
  if (!result.ok) throw new Error(`scrub failed: ${result.reason}`)
  return result.text
}

/** Every string anywhere in an exported span: what a recursive walk of the payload would find. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) allStrings(item, out)
  else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      out.push(key)
      allStrings(item, out)
    }
  }
  return out
}

function spanWith(overrides: Partial<PendingSpan> & {attributes?: PendingSpan['attributes']} = {}): PendingSpan {
  return {
    traceId: 't1',
    spanId: 's1',
    parentSpanId: undefined,
    name: 'execute_tool read',
    kind: 'internal',
    startMs: 1,
    endMs: 2,
    attributes: {},
    status: {code: 'unset'},
    events: [],
    ...overrides,
  }
}

describe('scrub patterns', () => {
  it.each(Object.keys(SECRETS) as (keyof typeof SECRETS)[])('removes the %s shape', name => {
    // #given the secret inside ordinary surrounding text
    const text = `before ${SECRETS[name]} after`

    // #when scrubbed
    const out = scrubText(text)

    // #then the sensitive value is gone and the surrounding words survive
    expect(out).not.toContain(NEEDLES[name])
    expect(out).toContain('before')
    expect(out).toContain(REDACTION)
  })

  it('removes each shape wherever a span puts text: tool output, a tool argument, an error message and a name', () => {
    // #given every secret shape in a tool result, a tool argument, an error message, a status and a span name
    for (const name of Object.keys(SECRETS) as (keyof typeof SECRETS)[]) {
      const secret = SECRETS[name]
      const span = scrubSpan(
        spanWith({
          name: `execute_tool ${secret}`,
          attributes: {
            'gen_ai.tool.call.arguments': contentAttribute({command: `curl ${secret}`}, 65_536),
            'gen_ai.tool.call.result': contentAttribute({content: [{type: 'text', text: `output ${secret}`}]}, 65_536),
            'fro_bot.note': `note ${secret}`,
          },
          status: {code: 'error', message: `failed with ${secret}`},
          events: [{name: 'exception', timeMs: 1, attributes: {'exception.message': `boom ${secret}`}}],
        }),
        scrubber,
      )

      // #then no string of the exported span holds the secret, and the marker counts the removals
      const found = allStrings(span).filter(text => text.includes(NEEDLES[name]))
      expect({name, found}).toEqual({name, found: []})
      expect(span.attributes[MARKER.redactions]).toBeGreaterThanOrEqual(5)
    }
  })

  it('keeps JSON valid when a secret sits inside a JSON string', () => {
    // #given a tool result whose text carries a JSON-escaped pair
    const span = scrubSpan(
      spanWith({
        attributes: {
          'gen_ai.tool.call.result': contentAttribute(
            {content: [{type: 'text', text: '{"password": "hunter2xyz", "ok": true}'}]},
            65_536,
          ),
        },
      }),
      scrubber,
    )

    // #then the attribute still parses and the value is gone
    const raw = String(span.attributes['gen_ai.tool.call.result'])
    expect(() => {
      JSON.parse(raw)
    }).not.toThrow()
    expect(raw).not.toContain('hunter2xyz')
  })

  it('removes a PEM block the tool cut short, with no end line, in plain and escaped-newline forms', () => {
    // #given blocks cut before their end line
    const plain = `log:\n${join('-----BEGIN OPENSSH PRIVATE', ' KEY-----')}\nb3BlbnNzaC1rZXktdjEAAAAAfake\nAAAA`
    const escaped = JSON.stringify({
      text: `${join('-----BEGIN PRIVATE', ' KEY-----')}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASfake\n`,
    })

    // #when scrubbed
    const a = scrubText(plain)
    const b = scrubText(escaped)

    // #then the key body is gone; the escaped one still parses and ends where its string ended
    expect(a).not.toContain('b3BlbnNzaC1')
    expect(b).not.toContain('MIIEvQIBAD')
    expect(JSON.parse(b)).toBeTruthy()
  })

  it('removes the value of a secret-named environment variable that has no recognizable shape', () => {
    // #given a plugin environment holding a plain-looking value under a secret name
    const env = {
      SERVICE_ADMIN_TOKEN: 'plainly-ordinary-words',
      OPENCODE_PASSWORD: 'server-pass-98765',
      LANG: 'en_US.UTF-8',
    }
    const local = createScrubber({env})

    // #when text carrying them (raw, and JSON-escaped inside a string) is scrubbed
    const raw = local.scrub('the value plainly-ordinary-words and server-pass-98765 and en_US.UTF-8')
    const escaped = local.scrub(JSON.stringify({a: 'x plainly-ordinary-words y'}))

    // #then both secrets are removed, the unrelated variable's value is not
    expect(raw).toMatchObject({ok: true, redactions: 2})
    expect(raw.ok && raw.text).toBe(`the value ${REDACTION} and ${REDACTION} and en_US.UTF-8`)
    expect(escaped.ok && escaped.text).not.toContain('plainly-ordinary-words')
  })

  it('removes a literal secret that needs JSON escaping, in its escaped form', () => {
    // #given a secret with a quote and a backslash in it
    const secret = String.raw`pa"ss\word-12345`
    const local = createScrubber({env: {DB_PASSWORD: secret}})

    // #when it appears inside serialized JSON
    const result = local.scrub(JSON.stringify({line: `connect with ${secret} now`}))

    // #then it is removed and the JSON still parses
    // The escaped form is what the serialized text holds: `pa\"ss\\word-12345`.
    expect(result.ok && result.text).not.toContain('word-12345')
    expect(result.ok && JSON.parse(result.text)).toBeTruthy()
  })

  it('reads names for selection only: literals are values, short ones are ignored, and names never come back', () => {
    // #given an environment with a short secret, a long one, and an unrelated long value
    const literals = collectLiterals({
      A_TOKEN: 'short',
      B_SECRET: 'long-enough-secret',
      PATH: '/usr/local/bin:/usr/bin',
      OPENCODE_PASSWORD: 'x'.repeat(8),
    })

    // #then only long-enough values of secret-named variables are literals, and no name is among them
    expect(literals).toEqual(expect.arrayContaining(['long-enough-secret', 'xxxxxxxx']))
    expect(literals).not.toContain('short')
    expect(literals).not.toContain('/usr/local/bin:/usr/bin')
    expect(literals.join('|')).not.toMatch(/B_SECRET|OPENCODE_PASSWORD|A_TOKEN/)
  })

  it('removes extra literal secrets such as the trace credential', () => {
    // #given the credential the plugin was configured with
    const local = createScrubber({extraSecrets: ['Basic-credential-123']})

    // #when / #then
    expect(local.scrub('header Basic-credential-123 sent')).toMatchObject({ok: true, text: `header ${REDACTION} sent`})
  })

  it.each([
    ['max_tokens: 8000'],
    ['"max_tokens": 4096'],
    ['Basic information about the project'],
    ['a sk-learn pipeline'],
    ['token usage was low'],
    ['see https://example.com/docs?page=2&sort=asc'],
    ['AKIA is a prefix'],
    ['the key is on the table'],
  ])('leaves ordinary text alone: %s', text => {
    // #given text that only resembles a secret
    // #when / #then it is not changed
    expect(scrubText(text)).toBe(text)
  })

  it('does not scan a value over the input ceiling: it is omitted, with a marker', () => {
    // #given a pattern that records every scan, and a value one character over a small ceiling
    let scans = 0
    const counting = createScrubber({
      limits: {inputCeilingChars: 1000},
      patterns: [
        {
          id: 'counting',
          // Counts scans of the value under test; the span's name is scrubbed too and is not what is being counted.
          find: text => {
            if (text.includes('xxxx')) scans += 1
          },
        },
      ],
    })
    const at = spanWith({attributes: {'gen_ai.tool.call.result': contentAttribute({a: 'x'.repeat(900)}, 65_536)}})
    const over = spanWith({attributes: {'gen_ai.tool.call.result': contentAttribute({a: 'x'.repeat(1000)}, 65_536)}})

    // #when both are scrubbed
    const kept = scrubSpan(at, counting)
    const omitted = scrubSpan(over, counting)

    // #then the one at the ceiling is scanned and kept; the one over is never scanned and is omitted with a marker
    expect(kept.attributes['gen_ai.tool.call.result']).toBeDefined()
    expect(omitted.attributes['gen_ai.tool.call.result']).toBeUndefined()
    expect(omitted.attributes[MARKER.omitted]).toEqual(['gen_ai.tool.call.result:over-input-ceiling'])
    expect(scans).toBe(1)
  })

  it('omits a value the scrubber throws on, and never exports it raw', () => {
    // #given a scrubber that throws, and a span whose every string holds a secret
    const throwing = {
      scrub: (): never => {
        throw new Error('boom')
      },
    }
    const span = scrubSpan(
      spanWith({
        name: `execute_tool ${SECRETS.openai}`,
        attributes: {
          'gen_ai.tool.call.result': contentAttribute({text: SECRETS.openai}, 65_536),
          'fro_bot.note': SECRETS.githubClassic,
          'fro_bot.list': [SECRETS.aws],
        },
        status: {code: 'error', message: SECRETS.jwt},
        events: [{name: 'exception', timeMs: 1, attributes: {'exception.message': SECRETS.bearer}}],
      }),
      throwing,
    )

    // #then nothing raw is in the span, and the markers say what was omitted
    const text = allStrings(span).join('\n')
    for (const needle of ['Q9x8W7e6R5', 'aB3dE5fG7hJ9', 'IOSFODNN7EXAMPLE', 'eyJzdWIiOiIx', 'f4k3T0k3nValue'])
      expect(text).not.toContain(needle)
    expect(span.name).toBe('[omitted]')
    expect(span.attributes['gen_ai.tool.call.result']).toBeUndefined()
    expect(span.attributes[MARKER.omitted]).toEqual(expect.arrayContaining(['gen_ai.tool.call.result:scrub-failed']))
  })

  it('brands a span only through scrubSpan', () => {
    // #given / #when
    const span = scrubSpan(spanWith(), scrubber)

    // #then
    expect(span[scrubbedBrand]).toBe(true)
  })
})

describe('passes do not interact: an earlier marker never makes a later pass skip or split a value', () => {
  /** A literal the plugin's own environment holds, and token shapes, each also the FIRST word of a longer password. */
  const ENV_LITERAL = join('envsecret', '-value-7f3a9c21')
  const withEnv = createScrubber({env: {API_TOKEN: ENV_LITERAL}})
  const text = (input: string, using = withEnv): string => {
    const result = using.scrub(input)
    if (!result.ok) throw new Error(result.reason)
    return result.text
  }
  const FIRST_WORDS: Readonly<Record<string, string>> = {
    'an environment literal': ENV_LITERAL,
    'a GitHub token': SECRETS.githubClassic,
    'an AWS key id': SECRETS.aws,
    'an OpenAI-style key': SECRETS.openai,
    'a JWT': SECRETS.jwt,
    'a Slack token': SECRETS.slack,
    'a bearer value': SECRETS.bearer,
  }
  const TAIL = 'second third fourth-word'

  it.each(Object.entries(FIRST_WORDS))(
    'removes a quoted multi-word password whose first word is %s, in plain text',
    (_label, first) => {
      // #given a quoted password that starts with something an earlier pass would recognise, then more words
      const input = `login ok password: "${first} ${TAIL}" and then done`

      // #when
      const out = text(input)

      // #then no word of the value survives, and what follows the closing quote does
      for (const word of ['second', 'third', 'fourth-word'])
        expect({word, found: out.includes(word)}).toEqual({word, found: false})
      expect(out).toContain('and then done')
    },
  )

  it.each(Object.entries(FIRST_WORDS))(
    'removes the same with single quotes and an escaped layer, first word %s',
    (_label, first) => {
      // #given
      const single = `secret='${first} ${TAIL}' end`
      const escaped = String.raw`client_secret: \"${first} ${TAIL}\" end`

      // #when / #then
      for (const input of [single, escaped]) {
        const out = text(input)
        for (const word of ['second', 'third', 'fourth-word'])
          expect({input, word, found: out.includes(word)}).toEqual({input, word, found: false})
      }
    },
  )

  it.each(Object.entries(FIRST_WORDS))(
    'exports no part of such a password, in a JSON string and in a tool argument, first word %s',
    (_label, first) => {
      // #given the password inside the text of a tool result, inside a JSON string, and inside a nested tool argument
      const result = scrubSpan(
        spanWith({
          attributes: {
            'gen_ai.tool.call.result': contentAttribute(
              {content: [{type: 'text', text: JSON.stringify({log: `password: "${first} ${TAIL}" tail`})}]},
              65_536,
            ),
            'gen_ai.tool.call.arguments': contentAttribute(
              {command: `curl -d 'password: "${first} ${TAIL}"'`, nested: [{note: `secret="${first} ${TAIL}"`}]},
              65_536,
            ),
          },
        }),
        withEnv,
      )

      // #then
      const exported = JSON.stringify(allStrings(result))
      for (const word of ['second', 'third', 'fourth-word'])
        expect({word, found: exported.includes(word)}).toEqual({word, found: false})
      expect(() => {
        JSON.parse(String(result.attributes['gen_ai.tool.call.result']))
      }).not.toThrow()
    },
  )

  it.each([
    ['Authorization: Bearer abcdef123456uvw'],
    ['authorization=Basic dXNlcjpwYXNzd29yZA=='],
    ['"authorization": "Bearer abcdef123456uvw"'],
    ['token: Token abcdef123456uvw9'],
    ['access_token=Digest abc123def456ghi'],
  ])('removes the credential after a scheme word: %s', input => {
    // #given an unquoted value whose first token is the scheme word and whose second is the credential
    const out = text(input)

    // #then the credential is gone, not just the scheme word
    expect(out).not.toMatch(/abcdef123456|dXNlcjpw|abc123def456/)
  })

  it('removes a PEM block inside a quoted password, with the words after it', () => {
    // #given
    const input = `password: "${SECRETS.pem} trailing words" end`

    // #when
    const out = text(input)

    // #then
    expect(out).not.toMatch(/MIIEowIBAAKC|trailing|words/)
  })

  it.each([
    [`?api_key=${SECRETS.githubClassic}&page=2`],
    [`https://x.test/?token=${SECRETS.openai}`],
    [`password: ${SECRETS.connection}`],
    [`token=${SECRETS.jwt} more`],
  ])('removes a token that is the value of a secret-named assignment: %s', input => {
    // #given / #when
    const out = text(input)

    // #then none of the token body is left
    for (const needle of ['aB3dE5fG7hJ9', 'Q9x8W7e6R5', 'eyJzdWIiOiIx', 'pw12345']) expect(out).not.toContain(needle)
  })

  it('removes a password at every depth of JSON-in-JSON escaping, with spaces and an inner quote', () => {
    // #given one, two and three layers of encoding of an object holding a multi-word password
    const layer1 = JSON.stringify({password: String.raw`correct horse \"battery\" staple`, ok: 'fine'})
    const layer2 = JSON.stringify(layer1)
    const layer3 = JSON.stringify(layer2)

    // #when / #then none of the words survive, and the rest does
    for (const input of [layer1, layer2, layer3]) {
      const out = text(input)
      for (const word of ['correct', 'horse', 'battery', 'staple'])
        expect({input, word, found: out.includes(word)}).toEqual({input, word, found: false})
      expect(out).toContain('fine')
    }
  })

  it.each(Object.entries(FIRST_WORDS).filter(([, middle]) => !middle.includes(' ')))(
    'removes an unquoted password with %s in its middle, and what follows it in the same token',
    (_label, middle) => {
      // #given an unquoted value, one token, with a recognisable piece in the middle (the marker an earlier pass would insert
      // contains a closing bracket, which also ends an unquoted value)
      const out = text(`password=pre-${middle}-tailword and more`)

      // #then
      expect(out).not.toContain('tailword')
      expect(out).not.toContain('pre-')
      expect(out).toContain('and more')
    },
  )

  it('treats marker text in the ORIGINAL input as ordinary text: no skip, no crash, no leak of a secret next to it', () => {
    // #given input that already contains the marker text (a model quoting an earlier trace), quoted and unquoted, with a real
    // secret beside it
    const quoted = text(`password: "${REDACTION}" and token: "${REDACTION}" and ${SECRETS.githubClassic}`)
    const bare = withEnv.scrub(`password: ${REDACTION} next ${ENV_LITERAL}`)

    // #then nothing is skipped as "already redacted" (there is no such concept: the matchers see only original text), the
    // secret beside it is gone, and the bare marker (which begins with `[`) is read as an array value, balanced at its `]`, and
    // replaced whole
    expect(quoted).toBe(`password: "${REDACTION}" and token: "${REDACTION}" and ${REDACTION}`)
    expect(bare).toEqual({ok: true, text: `password: ${REDACTION} next ${REDACTION}`, redactions: 2})
  })

  it('reads an unquoted value that contains marker text as the first token, up to its `]` like any other delimiter', () => {
    // #given a value whose first token is `pre-[REDACTED` and whose rest is after a `]`
    const out = text(`password=pre-${REDACTION}-tailword and more`)

    // #then the token before the delimiter is removed and what follows is left, exactly as for `pa]ss-tailword`; the marker
    // text is not special (a secret that contains `]` is cut there by design, as before)
    expect(out).toBe(`password=${REDACTION}]-tailword and more`)
    expect(text('password=pa]ss-tailword and more')).toBe(`password=${REDACTION}]ss-tailword and more`)
  })

  it('does not count one value twice when a literal and an assignment both match it', () => {
    // #given the environment literal as a whole password value
    const result = withEnv.scrub(`password: ${ENV_LITERAL}`)

    // #then one redaction
    expect(result).toMatchObject({ok: true, text: `password: ${REDACTION}`, redactions: 1})
  })
})

describe('a secret-named field is removed whole, not in part', () => {
  const attribute = (value: unknown): string => {
    const span = scrubSpan(
      spanWith({attributes: {'gen_ai.tool.call.arguments': contentAttribute(value, 65_536)}}),
      scrubber,
    )
    return String(span.attributes['gen_ai.tool.call.arguments'])
  }
  const PARTS = [
    'correct',
    'horse',
    'battery',
    'staple',
    'hunter2',
    '123456',
    '654321',
    'inner "quote',
    'cr3t',
    'k1',
    'k2',
  ]

  it('removes quoted, escaped, multi-word, numeric, array, object, boolean and null values of a sensitive key, at any depth', () => {
    // #given sensitive keys holding every shape, at the top, nested and inside arrays
    const exported = attribute({
      password: 'correct horse battery staple',
      nested: {
        deep: {Password: 'inner "quote cr3t', pin: 5, pwd: 123456, secret: ['k1', {a: 'k2'}], token: {a: 'hunter2'}},
      },
      list: [{api_key: 654321}, {authorization: 'Basic hunter2'}, {passphrase: true}, {credential: null}],
    })

    // #then the exported JSON holds no part of any of them
    for (const part of PARTS) expect({part, found: exported.includes(part)}).toEqual({part, found: false})
    expect(JSON.parse(exported)).toMatchObject({
      password: REDACTION,
      nested: {deep: {Password: REDACTION, pwd: REDACTION}},
    })
  })

  it('removes the values inside a JSON string carried in a tool argument, at any depth', () => {
    // #given an argument whose value is itself JSON text, nested and with an escaped quote
    const inner = JSON.stringify({
      password: 'correct horse battery',
      config: {secret: ['k1', 'k2'], api_key: 123456},
      ok: 'fine',
    })
    const exported = attribute({input: inner, list: [JSON.stringify([{client_secret: 'staple hunter2'}])]})

    // #then none of it survives, and the rest does
    for (const part of ['correct', 'horse', 'battery', 'k1', 'k2', '123456', 'staple', 'hunter2']) {
      expect({part, found: exported.includes(part)}).toEqual({part, found: false})
    }
    expect(exported).toContain('fine')
  })

  it('keeps a counter or a limit: max_tokens and token counts are left alone, with numbers', () => {
    // #given counters and limits next to a password
    const exported = JSON.parse(
      attribute({
        max_tokens: 8000,
        tokens: 120,
        token_count: 55,
        input_tokens: 70,
        maxTokens: 4096,
        password: 12345678,
      }),
    ) as Record<string, unknown>

    // #then
    expect(exported).toMatchObject({
      max_tokens: 8000,
      tokens: 120,
      token_count: 55,
      input_tokens: 70,
      maxTokens: 4096,
      password: REDACTION,
    })
  })

  it('does not exempt a counter-looking name whose value is not a number', () => {
    // #given
    const exported = attribute({tokens: 'abcdef-secret-value', max_tokens: 'sk-notanumber-hunter2'})

    // #then
    expect(exported).not.toContain('abcdef')
    expect(exported).not.toContain('hunter2')
  })

  it.each([
    ['a quoted multi-word value', 'login password: "correct horse battery" then more', 'correct'],
    ['a single-quoted value', "secret='correct horse battery' end", 'horse'],
    ['an escaped quote inside the value', String.raw`password: "he said \"correct horse\" there" tail`, 'horse'],
    ['a value in an escaped (JSON-in-JSON) layer', String.raw`password: \"correct horse battery\" tail`, 'battery'],
    ['a numeric password', 'password: 123456 done', '123456'],
    ['a short numeric pin', 'pwd=1234', '1234'],
    ['a numeric token that is not a counter', 'token: 99 end', '99'],
    ['a numeric secret in a url query', 'https://x.test/?api_key=1234567&page=2', '1234567'],
  ])('removes the whole value in free text: %s', (_label, text, part) => {
    // #given / #when
    const out = scrubText(text)

    // #then
    expect(out).not.toContain(part)
    expect(out).toContain(REDACTION)
  })

  it('stops at the closing quote and keeps what follows, and withholds the string when a quote never closes', () => {
    // #given
    expect(scrubText('a password: "x y z" and the rest')).toBe(`a password: "${REDACTION}" and the rest`)

    // #then an unterminated quote does not establish where the value ends: nothing of the string is exported
    expect(scrubber.scrub('password: "x y\nnext line stays')).toEqual({ok: false, reason: 'sensitive-value-unbounded'})
  })

  it.each([
    ['max_tokens: 8000', 'max_tokens: 8000'],
    ['"max_tokens": 4096', '"max_tokens": 4096'],
    ['tokens: 120 used', 'tokens: 120 used'],
    ['token_count=55', 'token_count=55'],
    ['output_tokens: 13', 'output_tokens: 13'],
  ])('leaves a counter alone in free text: %s', (text, expected) => {
    // #given / #when / #then
    expect(scrubText(text)).toBe(expected)
  })
})

/**
 * Why this block replaced the one before it. The old one gave each pattern a few inputs (a prefix repeated, a prefix and a
 * long run of one letter) and failed a pattern only when one run passed 2 s at 300 KB. The JWT pattern was quadratic on
 * `eyJ-` repeated (0.18 s at 20 KB, 0.72 s at 40 KB, 2.9 s at 80 KB) and no input in the table had a `-` in it, so nothing
 * hit the class that lets a near-match start inside its own run. Absolute ceilings also cannot tell a quadratic from a
 * linear pattern at small sizes. This block (1) gives every pattern inputs built from repeated NEAR-matches of its own
 * prefix, with the characters its classes accept, (2) measures through the whole `scrubSpan` path, and (3) compares the
 * time at two sizes eight times apart: linear is about 8x, quadratic 64x, and the limit is 24x.
 */
describe('adversarial timing: growth, not a ceiling', () => {
  const SMALL = 20_000
  const LARGE = 160_000
  /** Linear growth for an 8x size is about 8; quadratic is 64. The limit sits at three times linear. */
  const GROWTH_LIMIT = 24
  /** Below this, a timing is noise and only the absolute ceiling applies. */
  const NOISE_MS = 3
  const CEILING_MS = 3_000
  const rep = (unit: string) => (n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n)
  const run = (head: string, char: string, count: number) => rep(head + char.repeat(count))

  type Input = readonly [name: string, make: (n: number) => string]
  const inputs: Readonly<Record<string, readonly Input[]>> = {
    'pem-private-key': [
      ['headers, no end line', rep('-----BEGIN PRIVATE KEY-----')],
      ['half headers', rep('-----BEGIN ')],
      ['headers in quotes', rep('"-----BEGIN PRIVATE KEY-----"')],
      ['header then a partial end line', rep('-----BEGIN PRIVATE KEY-----\n-----END ')],
      ['header glued to its own prefix', rep('-----BEGIN -----BEGIN PRIVATE KEY-----')],
    ],
    'github-token': [
      ['dense matches, one every 41 characters', rep(join('ghp_', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5 '))],
      ['prefix, 35 chars (one short)', run('ghp_', 'a', 35)],
      ['prefix, 300 chars', run('ghp_', 'a', 300)],
      ['one long run after the prefix', n => `ghp_${'a'.repeat(n)}`],
      ['one long run, then an underscore (the boundary fails after the whole run)', n => `ghp_${'a'.repeat(n)}_`],
      ['runs ending in an underscore, repeated', rep(`ghp_${'a'.repeat(300)}_ `)],
      ['fine-grained run ending in a dash, repeated', rep(`github_pat_${'a'.repeat(300)}- `)],
      ['prefix, 40 chars, glued', run('ghp_', 'a', 40)],
      ['fine-grained, 21 chars', run('github_pat_', 'a', 21)],
      ['prefix repeated', rep('ghp_')],
    ],
    'aws-access-key-id': [
      ['dense matches, one every 21 characters', rep(join('AKIA', 'IOSFODNN7EXAMPLE '))],
      ['prefix, 15 chars', run('AKIA', 'A', 15)],
      ['prefix, 17 chars', run('AKIA', 'A', 17)],
      ['prefix repeated', rep('AKIA')],
    ],
    'vendor-key-prefix': [
      ['sk- run of 19', run('sk-', 'a', 19)],
      ['sk- dashes', rep('sk-')],
      ['SG. with no second dot', run('SG.', 'a', 20)],
      ['SG. dashes', run('SG.', '-', 20)],
      ['AIza one short', run('AIza', 'a', 34)],
      ['dop_v1_ one short', run('dop_v1_', 'a', 39)],
      ['one long run after the prefix', n => `sk-${'a'.repeat(n)}`],
    ],
    jwt: [
      ['dense matches, one every 36 characters', rep(join('eyJhbGciOiJ', '.eyJzdWIiOiIx.abcdefgh '))],
      ['eyJ- repeated (the class takes the dash)', rep('eyJ-')],
      ['eyJ, a dash, repeated, then a dot', n => `${rep('eyJ-')(n)}.`],
      ['eyJ-  with a dash run', run('eyJ', '-', 7)],
      ['header of 7 then a dot', rep('eyJaaaaaaa.')],
      ['two segments, never a third', rep('eyJaaaaaaaa.aaaaaaaa')],
      ['third segment of 3', rep('eyJaaaaaaaa.aaaaaaaa.aaa ')],
      ['eyJ run of 8 then dashes', rep('eyJ--------')],
      ['one long header run', n => `eyJ${'a'.repeat(n)}`],
    ],
    'auth-scheme-value': [
      ['Basic, a short run', rep('Basic aaaaaaa')],
      ['Bearer, a short run', rep('Bearer aaaaaaa')],
      ['Token, letters only (the lookahead fails)', run('Token ', 'a', 30)],
      ['Digest, letters only, glued', run('Digest ', 'a', 100)],
      ['one long letter run', n => `Basic ${'a'.repeat(n)}`],
      ['scheme then spaces', n => `Token${' '.repeat(n)}a`],
    ],
    'connection-string': [
      ['scheme repeated', rep('postgres://')],
      ['scheme, two chars', rep('redis://ab')],
      ['scheme, one long run', n => `mongodb+srv://${'a'.repeat(n)}`],
    ],
    'url-userinfo': [
      ['dense matches, one every 12 characters', rep('https://u:p@h/ ')],
      ['255 chars and no @', run('https://', 'b', 255)],
      ['257 chars and no @', run('https://', 'b', 257)],
      ['one long run and no @', n => `https://${'b'.repeat(n)}`],
      ['one long userinfo then an @', n => `https://${'b'.repeat(n)}@`],
      ['scheme repeated', rep('https://')],
      ['16-char scheme', rep('abcdefghijklmnop://')],
    ],
    'url-query-secret': [
      ['30 chars and no secret word', run('?', 'a', 30)],
      ['29 chars then key, no equals', rep(`?${'a'.repeat(29)}key`)],
      ['key with no equals', rep('?key')],
      ['key= with a short value', rep('&key=ab')],
      ['semicolons', rep(';password')],
    ],
    'name-value-pair': [
      ['dense matches, one every 19 characters', rep('password=abcdefgh ')],
      ['a quoted key, a long whitespace run, no colon', n => `"password"${' \n'.repeat(Math.ceil(n / 2))}x`],
      ['quoted keys each followed by whitespace and a colon', rep('"token" \n\t : 1 ')],
      ['a long run of backslashes inside a key', n => `{"p${'\\'.repeat(n)}ssword": 1}`],
      [
        'a long run of backslashes before every quote',
        n => `{${'\\'.repeat(Math.ceil(n / 2))}"password${'\\'.repeat(Math.ceil(n / 2))}": 1}`,
      ],
      ['many unicode escapes in one key', n => `{"${String.raw`\u0061`.repeat(Math.ceil(n / 6))}password": 1}`],
      ['many keys, each with a unicode escape', rep(String.raw`{"p\u0061ssword": 1} `)],
      ['many keys, each with an invalid escape', rep(String.raw`{"p\uZZ61ssword": 1} `)],
      ['keys at the length bound, with an escape', rep(String.raw`"${'x'.repeat(1_000)}\u0061": 1 `)],
      ['keys over the length bound', rep(String.raw`"${'x'.repeat(1_100)}\u0061": 1 `)],
      ['alternating quotes and escapes with no colon', rep(String.raw`"\u0061" "\n" `)],
      ['quotes at every depth in a row', rep(String.raw`"\"\\\"\\\\\\\"`)],
      ['zero-width characters in keys', rep('{"pa\u200Bss\u2060word": 1} ')],
      ['a quoted key then a long run of spaces', n => `{"password":${' '.repeat(n)}"x"}`],
      ['a quoted key then a long run of newlines', n => `{"password":${'\n'.repeat(n)}"x"}`],
      ['quoted keys each followed by a 300-character gap', rep(`"password":${' '.repeat(300)}"x" `)],
      ['quoted keys each followed by a 255-character gap', rep(`"secret":${'\n'.repeat(255)}1 `)],
      [
        'escaped gaps at depth 1, long',
        n => String.raw`{\"password\":${String.raw`\n  `.repeat(Math.ceil(n / 4))}\"x\"}`,
      ],
      [
        'escaped gaps at depth 3, long',
        n => String.raw`{\\\\\\\\"password\\\\\\\\":${String.raw`\\\\n `.repeat(Math.ceil(n / 6))}1}`,
      ],
      ['a quoted key, whitespace, then an opener never closed', n => `"password":${' \n'.repeat(Math.ceil(n / 4))}{[`],
      [
        'deep alternating nesting, balanced',
        n => `password: ${'{"a":['.repeat(Math.ceil(n / 12))}1${']}'.repeat(Math.ceil(n / 12))}`,
      ],
      [
        'deep alternating nesting, mismatched at the end',
        n => `password: ${'{"a":['.repeat(Math.ceil(n / 12))}1${'}]'.repeat(Math.ceil(n / 12))}`,
      ],
      ['mismatched pairs, repeated', rep('password: {"a": [1}] ')],
      ['nesting at the depth bound, repeated', rep(`token: ${'['.repeat(64)}${']'.repeat(64)} `)],
      ['nesting past the depth bound, repeated', rep(`token: ${'['.repeat(65)}${']'.repeat(65)} `)],
      ['a long run of openers, no close', n => `password: ${'{['.repeat(Math.ceil(n / 2))}`],
      ['unbalanced openers, one per line', rep('password: {[ x\n')],
      ['unbalanced openers, all on one line', rep('secret: {[ pad ')],
      [
        'deeply nested brackets, closed',
        n => `password: ${'['.repeat(Math.ceil(n / 2))}${']'.repeat(Math.ceil(n / 2))}`,
      ],
      ['balanced objects, repeated', rep('token: {"a": [1, {"b": "c"}]} ')],
      ['alternating quotes and backslashes after a name', rep(String.raw`password: {\"a\\"\"b `)],
      ['quotes and backslashes inside a bracket value', n => `password: {${'"\\'.repeat(Math.ceil(n / 2))}`],
      ['escaped layers, three deep, never closed', rep('password: {\\\\\\\\\\\\\\\"a ')],
      ['a bracket value after every kind of name', rep('api_key: [client_secret: {authorization: [')],
      ['dense quoted matches', rep('secret: "ab cd" ')],
      ['the word alone', rep('password')],
      ['the word and 20 name chars', run('password', 'a', 20)],
      ['the word, 19 chars and a quote', rep(`password${'a'.repeat(19)}"`)],
      ['a colon and an eight-digit value', rep('token: 12345678 ')],
      ['an equals and a short value', rep('secret=ab ')],
      ['quote forms', rep('api_key"')],
      ['escaped quotes', rep(String.raw`token\": \"`)],
      ['one long value', n => `secret=${'a'.repeat(n)}`],
      ['a quote that never closes', rep('password: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')],
      ['quotes that close just past the bound', rep(`password: "${'a'.repeat(9_000)}" `)],
      ['an escaped layer that never closes', rep(String.raw`password: \\"aaaaaaaaaaaaaaaaaaaa`)],
      [
        'backslashes inside a quoted value',
        rep('password: "\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"'),
      ],
      ['a numeric value at the exemption edge', rep('password: 12345678 ')],
      ['deep escaped layers that never close', rep(String.raw`password: \\\"aaaaaaaaaaaaaaaaaaaaaaaaaaaa`)],
      ['deep escaped layers with mismatched runs', rep(String.raw`password: \\\"aa\\"aa\\\\\\"`)],
      ['a scheme word then blanks, repeated', rep('authorization: Bearer        ')],
      ['a marker that starts a value, repeated', rep('password: [REDACTED]x ')],
      ['a counter name then a long number', rep('max_tokens: 123456789012 ')],
      ['a long line with no quote at all', n => `password: "${'x '.repeat(n / 2)}`],
    ],
  }

  /** A span whose one content attribute carries `text` the way a tool result does, scrubbed through the whole path. */
  const through = (scrubber: ReturnType<typeof createScrubber>, text: string, attempts = 3): number => {
    const span: PendingSpan = {
      traceId: 't',
      spanId: 's',
      parentSpanId: undefined,
      name: 'x',
      kind: 'internal',
      startMs: 1,
      endMs: 2,
      attributes: {'gen_ai.tool.call.result': contentAttribute({content: [{type: 'text', text}]}, 64 * 1024)},
      status: {code: 'unset'},
      events: [],
    }
    // CPU time, the least of a few runs after a warm-up (see `timing.testing.ts` for why, and how a load-proof test still fails
    // on a real regression).
    return minCpuMs(() => {
      scrubSpan(span, scrubber)
    }, attempts)
  }

  /** Whether growth from `small` to `large` is over the limit (and the shape is big enough for the ratio to mean anything). */
  const overLimit = (small: number, large: number): boolean =>
    large > CEILING_MS || (large > NOISE_MS * GROWTH_LIMIT && large / Math.max(small, NOISE_MS) > GROWTH_LIMIT)
  /** The measurement that decides a suspect shape: many more runs, so one disturbed run cannot condemn it. */
  const RECHECK_ATTEMPTS = 15

  it('has adversarial inputs for every pattern', () => {
    // #given the pattern list and the input table
    // #when / #then every pattern is exercised
    expect(SCRUB_PATTERNS.map(pattern => pattern.id).toSorted((a, b) => a.localeCompare(b))).toEqual(
      Object.keys(inputs).toSorted((a, b) => a.localeCompare(b)),
    )
  })

  for (const pattern of SCRUB_PATTERNS) {
    it(`${pattern.id} grows linearly on every adversarial input, through the whole scrub path`, () => {
      // #given its inputs and a scrubber with every pattern
      const scrubber = createScrubber({env: {}})
      const offenders: string[] = []
      for (const [name, make] of inputs[pattern.id] ?? []) {
        // #when the same shape is scrubbed at two sizes eight times apart (a few runs each)
        const smallText = make(SMALL)
        const largeText = make(LARGE)
        let small = through(scrubber, smallText)
        let large = through(scrubber, largeText)

        // #then the time grew about eight-fold, not sixty-four-fold, and stayed under the ceiling; a shape that looks over the
        // limit is measured again, many more times, and only the least of all its runs counts (CPU time over the ceiling is real
        // at once: load does not add CPU time)
        if (overLimit(small, large) && large <= CEILING_MS) {
          small = Math.min(small, through(scrubber, smallText, RECHECK_ATTEMPTS))
          large = Math.min(large, through(scrubber, largeText, RECHECK_ATTEMPTS))
        }
        if (overLimit(small, large)) {
          offenders.push(`${name}: ${small.toFixed(1)} ms at ${SMALL}, ${large.toFixed(1)} ms at ${LARGE}`)
        }
      }
      expect(offenders).toEqual([])
    }, 60_000)
  }

  it('the literal pass grows linearly with a long literal whose near-matches fill the text', () => {
    // #given 128 secret values of 4,000 characters each that differ from the text only in their last character
    const env: Record<string, string> = {}
    for (let index = 0; index < 128; index += 1)
      env[`SECRET_${index}`] = `${'a'.repeat(3_999)}${String.fromCodePoint(98 + (index % 20))}`
    const scrubber = createScrubber({env})
    const make = (n: number): string => 'a'.repeat(n)

    // #when / #then
    const small = through(scrubber, make(SMALL))
    const large = through(scrubber, make(LARGE))
    expect(large).toBeLessThan(CEILING_MS)
    expect(large / Math.max(small, NOISE_MS)).toBeLessThan(GROWTH_LIMIT)
  })

  it('scrubs a hostile mixed megabyte in bounded time', () => {
    // #given every adversarial input at once
    const text = Object.values(inputs)
      .flat()
      .map(([, make]) => make(20_000))
      .join('\n')
      .slice(0, 1_000_000)

    // #when
    const started = performance.now()
    const result = createScrubber({env: {}}).scrub(text)
    const elapsed = performance.now() - started

    // #then
    expect(result.ok).toBe(true)
    expect(elapsed).toBeLessThan(10_000)
  })
})

describe('the JWT scanner agrees with the pattern it replaced', () => {
  /** The pattern the scanner replaced, kept here as the oracle. */
  const ORACLE = /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{4,}/g
  const jwt = SCRUB_PATTERNS.find(pattern => pattern.id === 'jwt')

  it('gives the same text and the same count as the regex on a thousand random strings', () => {
    // #given strings over the characters the pattern's shape is made of, from a fixed seed
    let seed = 0x2f6e2b1
    const next = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
      return seed / 2 ** 32
    }
    const alphabet = ['eyJ', 'eyJ', 'a', 'B', '-', '_', '.', '.', ' ', '1', 'e', 'y', 'J', '=', 'eyJ-', 'aaaa', 'ey']
    for (let round = 0; round < 1_000; round += 1) {
      const length = 1 + Math.floor(next() * 40)
      let text = ''
      for (let index = 0; index < length; index += 1) text += alphabet[Math.floor(next() * alphabet.length)]
      let count = 0
      const expected = text.replaceAll(ORACLE, () => {
        count += 1
        return REDACTION
      })

      // #when
      const got = jwt === undefined ? undefined : scrubWithMatchers(text, [jwt])

      // #then
      expect({text: got?.text, count: got?.redactions}).toEqual({text: count === 0 ? text : expected, count})
    }
  })

  it('does not match a token that has no word boundary before it', () => {
    // #given
    const glued = `xeyJ${'a'.repeat(8)}.${'b'.repeat(8)}.${'c'.repeat(4)}`

    // #when / #then
    expect(jwt === undefined ? -1 : matchRanges(jwt, glued)).toEqual([])
  })
})

describe('bounding', () => {
  it('cuts a 5 MB tool result to the bound, keeps valid JSON and says it truncated', () => {
    // #given a 5 MB result and the tool-result bound
    const big = 'line of output\n'.repeat(350_000)
    expect(big.length).toBeGreaterThan(5_000_000)

    // #when the span is scrubbed
    const span = scrubSpan(
      spanWith({
        attributes: {'gen_ai.tool.call.result': contentAttribute({content: [{type: 'text', text: big}]}, 65_536)},
      }),
      scrubber,
    )

    // #then it is within the bound, parses, and carries the truncation marker
    const raw = String(span.attributes['gen_ai.tool.call.result'])
    expect(raw.length).toBeLessThanOrEqual(65_536)
    const parsed = JSON.parse(raw) as {content: {text: string}[]}
    expect(parsed.content[0]?.text).toMatch(/…\[truncated \d+ chars\]$/)
    expect(span.attributes[MARKER.truncated]).toEqual(['gen_ai.tool.call.result'])
  })

  it('removes a secret that straddles the truncation boundary', () => {
    // #given a secret that begins just before the bound and ends after it
    const secret = SECRETS.githubClassic
    const filler = 'a'.repeat(65_536 - 200 - 20)
    const text = `${filler} ${secret} ${'b'.repeat(500)}`
    const bound = 65_536 - 200

    // #when scrubbed then bounded at that size
    const span = scrubSpan(
      spanWith({attributes: {'gen_ai.tool.call.result': contentAttribute({content: [{type: 'text', text}]}, bound)}}),
      scrubber,
    )

    // #then no part of the secret is in the exported value
    const raw = String(span.attributes['gen_ai.tool.call.result'])
    expect(raw).not.toContain('ghp_')
    expect(raw).not.toContain('aB3dE5fG')
    expect(span.attributes[MARKER.redactions]).toBe(1)
  })

  it('does not leave a half secret when the cut would fall inside one', () => {
    // #given a bound that falls inside the secret, as it would be written
    const secret = SECRETS.openai
    for (let offset = 0; offset <= secret.length; offset += 1) {
      const text = `${'a'.repeat(500 - offset)} ${secret}${'c'.repeat(200)}`
      const span = scrubSpan(
        spanWith({attributes: {'gen_ai.tool.call.result': contentAttribute({content: [{type: 'text', text}]}, 600)}}),
        scrubber,
      )

      // #then at every offset the exported text holds none of the secret
      expect(String(span.attributes['gen_ai.tool.call.result'])).not.toContain('Q9x8W7')
    }
  })

  it('drops the oldest history messages first and states how many', () => {
    // #given twenty messages of 1 KB each and a bound that fits about ten
    const messages = Array.from({length: 20}, (_, index) => ({
      role: 'user',
      parts: [{type: 'text', content: `m${index}-${'x'.repeat(1000)}`}],
    }))

    // #when
    const span = scrubSpan(
      spanWith({attributes: {'gen_ai.input.messages': contentAttribute(messages, 10_500, true)}}),
      scrubber,
    )

    // #then the newest are kept, in order, the count is on the span, and the value is valid JSON within the bound
    const raw = String(span.attributes['gen_ai.input.messages'])
    const kept = JSON.parse(raw) as {parts: {content: string}[]}[]
    expect(raw.length).toBeLessThanOrEqual(10_500)
    expect(kept.at(-1)?.parts[0]?.content.startsWith('m19-')).toBe(true)
    expect(kept.length + Number(span.attributes[MARKER.dropped('gen_ai.input.messages')])).toBe(20)
    expect(kept[0]?.parts[0]?.content.startsWith(`m${20 - kept.length}-`)).toBe(true)
    expect(span.attributes[MARKER.truncated]).toEqual(['gen_ai.input.messages'])
  })

  it('cuts leaves of the newest message when even one message is over the bound', () => {
    // #given one message far over the bound
    const messages = [{role: 'user', parts: [{type: 'text', content: 'y'.repeat(5000)}]}]

    // #when
    const span = scrubSpan(
      spanWith({attributes: {'gen_ai.input.messages': contentAttribute(messages, 1000, true)}}),
      scrubber,
    )

    // #then
    const raw = String(span.attributes['gen_ai.input.messages'])
    expect(raw.length).toBeLessThanOrEqual(1000)
    expect(JSON.parse(raw)).toHaveLength(1)
    expect(span.attributes[MARKER.dropped('gen_ai.input.messages')]).toBeUndefined()
  })

  it('shares one content budget across a span: later attributes get what the earlier ones left', () => {
    // #given two attributes that each fit alone but not together in a 1,200-character span budget
    const limits = {...DEFAULT_CONTENT_LIMITS, spanContentChars: 1200}
    const first = {text: 'f'.repeat(700)}
    const second = [{role: 'user', parts: [{type: 'text', content: 's'.repeat(700)}]}]

    // #when
    const span = scrubSpan(
      spanWith({
        attributes: {
          'gen_ai.tool.call.arguments': contentAttribute(first, 5000),
          'gen_ai.input.messages': contentAttribute(second, 5000, true),
        },
      }),
      scrubber,
      limits,
    )

    // #then the first kept its full size, the second was cut to the remainder
    expect(String(span.attributes['gen_ai.tool.call.arguments']).length).toBeLessThan(1000)
    const total =
      String(span.attributes['gen_ai.tool.call.arguments']).length +
      String(span.attributes['gen_ai.input.messages']).length
    expect(total).toBeLessThanOrEqual(1200)
  })

  it('omits a value whose bare structure is over the bound', () => {
    // #given many keys and a tiny bound
    const value = Object.fromEntries(Array.from({length: 50}, (_, index) => [`key${index}`, 1]))

    // #when / #then
    expect(boundJson(value, 20, false)).toBeUndefined()
  })

  it('never splits a surrogate pair when it cuts', () => {
    // #given a string of astral characters
    const text = '😀'.repeat(400)

    // #when cut hard
    const bounded = boundJson({text}, 200, false)

    // #then it is valid JSON with no lone surrogate
    expect(bounded).toBeDefined()
    const parsed = JSON.parse(bounded?.json ?? '{}') as {text: string}
    expect(
      [...parsed.text].every(char => char.length === 2 || char.charCodeAt(0) < 0xd8_00 || char.charCodeAt(0) > 0xdf_ff),
    ).toBe(true)
  })

  it('cuts a long plain string such as a status message and says so', () => {
    // #given an error message far over the plain-string limit
    const span = scrubSpan(spanWith({status: {code: 'error', message: 'e'.repeat(20_000)}}), scrubber)

    // #then
    expect(span.status.message?.length ?? 0).toBeLessThanOrEqual(DEFAULT_CONTENT_LIMITS.plainStringChars)
    expect(span.attributes[MARKER.truncated]).toEqual(['status'])
  })

  it('omits a value that cannot be serialized, with a marker', () => {
    // #given a cycle
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    // #when
    const span = scrubSpan(
      spanWith({attributes: {'gen_ai.tool.call.arguments': contentAttribute(cyclic, 5000)}}),
      scrubber,
    )

    // #then
    expect(span.attributes['gen_ai.tool.call.arguments']).toBeUndefined()
    expect(span.attributes[MARKER.omitted]).toEqual(['gen_ai.tool.call.arguments:unserializable'])
  })
})
