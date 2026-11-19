import type {PendingSpan} from './content.js'

import {describe, expect, it} from 'vitest'

import {
  boundJson,
  collectLiterals,
  contentAttribute,
  createScrubber,
  DEFAULT_CONTENT_LIMITS,
  extractInputMessages,
  extractOutputMessages,
  extractSystemInstructions,
  extractToolArguments,
  extractToolDefinitions,
  extractToolResult,
  MARKER,
  REDACTION,
  SCRUB_PATTERNS,
  scrubbedBrand,
  scrubSpan,
} from './content.js'

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
          apply: text => {
            if (text.includes('xxxx')) scans += 1
            return {text, count: 0}
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

  it('omits a value whose scrub broke its JSON, rather than export text that does not parse', () => {
    // #given a scrubber that mangles the serialization
    const mangling = {scrub: (text: string) => ({ok: true as const, text: `${text}}`, redactions: 1})}

    // #when
    const span = scrubSpan(
      spanWith({attributes: {'gen_ai.tool.call.result': contentAttribute({a: 1}, 65_536)}}),
      mangling,
    )

    // #then
    expect(span.attributes['gen_ai.tool.call.result']).toBeUndefined()
    expect(span.attributes[MARKER.omitted]).toEqual(['gen_ai.tool.call.result:scrub-failed'])
  })

  it('brands a span only through scrubSpan', () => {
    // #given / #when
    const span = scrubSpan(spanWith(), scrubber)

    // #then
    expect(span[scrubbedBrand]).toBe(true)
  })
})

describe('adversarial timing: each pattern on its own worst input', () => {
  const CEILING_MS = 2_000
  const N = 300_000
  const inputs: Readonly<Record<string, readonly string[]>> = {
    'pem-private-key': [
      // Many headers and no end line: a scan to the end per header would be quadratic (1.6 MB took minutes).
      '-----BEGIN PRIVATE KEY-----'.repeat(60_000),
      '-----BEGIN '.repeat(150_000),
      `"${'-----BEGIN PRIVATE KEY-----"'.repeat(60_000)}`,
      `${'-----BEGIN PRIVATE KEY-----\n-----END '.repeat(40_000)}`,
    ],
    'github-token': ['ghp_'.repeat(N / 4), `ghp_${'a'.repeat(N)}`, 'github_pat_'.repeat(N / 11)],
    'aws-access-key-id': ['AKIA'.repeat(N / 4), `AKIA${'A'.repeat(N)}`],
    'vendor-key-prefix': [
      'sk-'.repeat(N / 3),
      `sk-${'a'.repeat(N)}`,
      `SG.${'a'.repeat(N)}`,
      'SG.aaaaaaaaaaaaaaaaaaaa'.repeat(N / 24),
      `AIza${'a'.repeat(N)}`,
    ],
    jwt: [`eyJ${'a'.repeat(N)}`, 'eyJaaaaaaaa.'.repeat(N / 12), `eyJaaaaaaaa.${'a'.repeat(N)}`],
    'auth-scheme-value': [
      'Bearer '.repeat(N / 7),
      `Basic ${'a'.repeat(N)}`,
      'Basic aaaaaaaa'.repeat(N / 14),
      `Token${' '.repeat(N)}a`,
    ],
    'connection-string': ['postgres://'.repeat(N / 11), `redis://${'a'.repeat(N)}`],
    'url-userinfo': ['a://'.repeat(N / 4), `http://${'a'.repeat(N)}`, `http://${'a:'.repeat(N / 2)}`],
    'url-query-secret': [
      '?key='.repeat(N / 5),
      `&${'a'.repeat(N)}`,
      '&aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'.repeat(N / 31),
      `?token=${'a'.repeat(N)}`,
    ],
    'name-value-pair': [
      'password'.repeat(N / 8),
      `password${' '.repeat(N)}`,
      'token: '.repeat(N / 7),
      `secret=${'a'.repeat(N)}`,
      'api_key"'.repeat(N / 8),
      'passwordaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'.repeat(N / 52),
    ],
  }

  it('has an adversarial input for every pattern', () => {
    // #given the pattern list and the input table
    // #when / #then every pattern is exercised
    expect(SCRUB_PATTERNS.map(pattern => pattern.id).toSorted((a, b) => a.localeCompare(b))).toEqual(
      Object.keys(inputs).toSorted((a, b) => a.localeCompare(b)),
    )
  })

  for (const pattern of SCRUB_PATTERNS) {
    it(`${pattern.id} stays under the ceiling on every adversarial input`, () => {
      // #given its inputs
      for (const input of inputs[pattern.id] ?? []) {
        // #when the pattern alone runs over them
        const started = performance.now()
        pattern.apply(input, input.toLowerCase())
        const elapsed = performance.now() - started

        // #then it finishes well inside a generous ceiling (linear time, not exponential or quadratic)
        expect({id: pattern.id, length: input.length, slow: elapsed > CEILING_MS}).toEqual({
          id: pattern.id,
          length: input.length,
          slow: false,
        })
      }
    })
  }

  it('scrubs a hostile mixed megabyte in bounded time', () => {
    // #given every adversarial input at once
    const text = Object.values(inputs).flat().join('\n').slice(0, 1_000_000)

    // #when
    const started = performance.now()
    const result = scrubber.scrub(text)
    const elapsed = performance.now() - started

    // #then
    expect(result.ok).toBe(true)
    expect(elapsed).toBeLessThan(10_000)
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

describe('extraction by named field', () => {
  it('reads system instruction text and nothing else from each part', () => {
    // #given parts carrying metadata that holds the same text again
    const parts = [
      {type: 'text', text: 'base prompt', metadata: {experimental: {instructions: [{key: 'k', text: 'duplicate'}]}}},
      {type: 'text', text: 'second', cache: {type: 'ephemeral'}},
      {type: 'image'},
    ]

    // #when / #then
    expect(extractSystemInstructions(parts)).toEqual([
      {type: 'text', content: 'base prompt'},
      {type: 'text', content: 'second'},
    ])
    expect(extractSystemInstructions('nope')).toBeUndefined()
  })

  it('maps messages to the convention: text, reasoning, tool calls and tool responses, dropping media', () => {
    // #given a history with each part kind and an attachment
    const history = [
      {
        id: 'msg_1',
        role: 'user',
        content: [
          {type: 'text', text: 'read it'},
          {type: 'media', media: {source: {type: 'base64', data: 'AAAA'}}},
        ],
      },
      {
        role: 'assistant',
        content: [
          {type: 'reasoning', text: 'hmm'},
          {type: 'tool-call', id: 'call_1', name: 'read', input: {path: 'a.txt'}},
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            id: 'call_1',
            name: 'read',
            result: {
              type: 'content',
              value: [
                {type: 'text', text: 'file body'},
                {type: 'file', uri: 'file:///secret/path', mime: 'text/plain', name: 'a.txt'},
              ],
            },
          },
        ],
      },
      {role: 'assistant', content: 'plain string content'},
    ]

    // #when
    const out = extractInputMessages(history)

    // #then the shapes follow the convention, ids are not carried, the attachment is counted, and no file location appears
    expect(out?.omittedParts).toBe(1)
    expect(out?.messages).toEqual([
      {role: 'user', parts: [{type: 'text', content: 'read it'}]},
      {
        role: 'assistant',
        parts: [
          {type: 'reasoning', content: 'hmm'},
          {type: 'tool_call', id: 'call_1', name: 'read', arguments: {path: 'a.txt'}},
        ],
      },
      {role: 'tool', parts: [{type: 'tool_call_response', id: 'call_1', response: 'file body\n[file: a.txt]'}]},
      {role: 'assistant', parts: [{type: 'text', content: 'plain string content'}]},
    ])
    expect(JSON.stringify(out)).not.toContain('/secret/path')
    expect(JSON.stringify(out)).not.toContain('AAAA')
  })

  it('maps tool definitions to name, description and parameters', () => {
    // #given the hook's tool map
    const tools = {
      read: {description: 'Read a file', input: {type: 'object', properties: {path: {type: 'string'}}}},
      bare: {},
    }

    // #when / #then
    expect(extractToolDefinitions(tools)).toEqual([
      {
        type: 'function',
        name: 'read',
        description: 'Read a file',
        parameters: {type: 'object', properties: {path: {type: 'string'}}},
      },
      {type: 'function', name: 'bare'},
    ])
    expect(extractToolDefinitions({})).toBeUndefined()
  })

  it('makes tool arguments an object: parses a JSON string, wraps anything else', () => {
    // #given
    // #when / #then
    expect(extractToolArguments({a: 1})).toEqual({a: 1})
    expect(extractToolArguments('{"a":1}')).toEqual({a: 1})
    expect(extractToolArguments('not json')).toEqual({value: 'not json'})
    expect(extractToolArguments(5)).toEqual({value: 5})
    expect(extractToolArguments(undefined)).toBeUndefined()
  })

  it('reads the content the model saw as a tool result, files by name and type only, and the tool-cut flag', () => {
    // #given a result with text, a file, structured output and metadata
    const result = {
      content: [
        {type: 'text', text: 'ok'},
        {type: 'file', uri: 'file:///home/u/.env', mime: 'text/plain', name: '.env'},
      ],
      output: {big: 'structured'},
      metadata: {truncated: true, outputPath: '/tmp/out.txt'},
    }

    // #when
    const out = extractToolResult(result)

    // #then
    expect(out).toEqual({
      value: {
        content: [
          {type: 'text', text: 'ok'},
          {type: 'file', mime: 'text/plain', name: '.env'},
        ],
      },
      ownTruncation: true,
    })
    expect(JSON.stringify(out)).not.toContain('/home/u')
    expect(JSON.stringify(out)).not.toContain('/tmp/out.txt')
    expect(extractToolResult({content: 'plain'})?.value).toEqual({content: [{type: 'text', text: 'plain'}]})
    expect(extractToolResult({output: {a: 1}})?.value).toEqual({output: {a: 1}})
    expect(extractToolResult(undefined)).toBeUndefined()
    expect(extractToolResult({metadata: {}})).toBeUndefined()
  })

  it('builds one assistant output message from reasoning, text and requested tool calls', () => {
    // #given
    const out = extractOutputMessages({
      texts: ['hello'],
      reasoning: ['thinking'],
      toolCalls: [{callId: 'c1', tool: 'read', input: {path: 'a'}}],
    })

    // #then
    expect(out).toEqual([
      {
        role: 'assistant',
        parts: [
          {type: 'reasoning', content: 'thinking'},
          {type: 'text', content: 'hello'},
          {type: 'tool_call', id: 'c1', name: 'read', arguments: {path: 'a'}},
        ],
      },
    ])
    expect(extractOutputMessages({texts: [], reasoning: [], toolCalls: []})).toBeUndefined()
  })
})
