import {Buffer} from 'node:buffer'
import {createScrubber, MAX_LITERAL_CHARS, MIN_LITERAL_CHARS} from '@fro-bot/runtime/tracing/scrub'
import {describe, expect, it, vi} from 'vitest'
import {createSecretRegistry} from './secret-registry.js'

const make = (): {
  registry: ReturnType<typeof createSecretRegistry>
  masker: ReturnType<typeof vi.fn<(v: string) => void>>
} => {
  const masker = vi.fn<(value: string) => void>()
  return {registry: createSecretRegistry(masker), masker}
}

describe('createSecretRegistry', () => {
  describe('mask', () => {
    it('masks through the injected masker and records the value', () => {
      // #given
      const {registry, masker} = make()

      // #when
      registry.mask('mid-run-secret-value')

      // #then
      expect(masker).toHaveBeenCalledWith('mid-run-secret-value')
      expect(registry.literals()).toContain('mid-run-secret-value')
      expect(registry.matchable()).toBe(true)
    })

    it('still masks a value the scrubber cannot match, and marks the registry unmatchable', () => {
      // #given
      const {registry, masker} = make()

      // #when
      registry.mask('short')

      // #then
      expect(masker).toHaveBeenCalledWith('short')
      expect(registry.literals()).not.toContain('short')
      expect(registry.matchable()).toBe(false)
    })

    it('ignores an empty or blank value without masking it', () => {
      // #given
      const {registry, masker} = make()

      // #when
      registry.mask('')
      registry.mask('   ')

      // #then
      expect(masker).not.toHaveBeenCalled()
      expect(registry.matchable()).toBe(true)
    })
  })

  describe('range', () => {
    it('is exactly the range the scrubber matches', () => {
      // #given each length at and around both edges
      const lengths = [MIN_LITERAL_CHARS - 1, MIN_LITERAL_CHARS, 4_152, MAX_LITERAL_CHARS, MAX_LITERAL_CHARS + 1]

      for (const length of lengths) {
        const value = 'q'.repeat(length)
        const {registry} = make()
        const scrubber = createScrubber({env: {}, patterns: []})
        scrubber.addLiterals?.([value])

        // #when
        registry.add(value)

        // #then the registry calls a value matchable exactly when the scrubber redacts it
        const scrubbed = scrubber.scrub(`x ${value} y`)
        const redacted = scrubbed.ok && scrubbed.text.includes('[REDACTED]')
        expect(registry.matchable()).toBe(redacted)
      }
    })
  })

  describe('addSecretEnv', () => {
    it('adds the value of every secret-named variable and no other', () => {
      // #given
      const {registry} = make()

      // #when
      registry.addSecretEnv({
        MY_API_TOKEN: 'token-value-1234',
        DB_PASSWORD: 'password-value-1234',
        PATH: '/usr/local/bin:/usr/bin',
        EMPTY_TOKEN: '',
        UNSET_TOKEN: undefined,
      })

      // #then
      expect(registry.literals()).toEqual(expect.arrayContaining(['token-value-1234', 'password-value-1234']))
      expect(registry.literals()).not.toContain('/usr/local/bin:/usr/bin')
      expect(registry.matchable()).toBe(true)
    })

    it('marks the registry unmatchable for a short secret value', () => {
      // #given
      const {registry} = make()

      // #when
      registry.addSecretEnv({DB_PASSWORD: 'hunt'})

      // #then
      expect(registry.matchable()).toBe(false)
    })
  })

  describe('addAuthJson', () => {
    it('adds every string leaf, however deep, and skips the type tag and non-strings', () => {
      // #given
      const {registry} = make()
      const text = JSON.stringify({
        anthropic: {type: 'api', key: 'sk-ant-api-key-value'},
        github: {type: 'oauth', refresh: 'refresh-token-value', access: 'access-token-value', expires: 1_700_000_000},
        nested: {deep: {deeper: ['array-leaf-secret-1', {k: 'object-in-array-secret'}]}},
      })

      // #when
      registry.addAuthJson(text)

      // #then
      expect(registry.literals()).toEqual(
        expect.arrayContaining([
          'sk-ant-api-key-value',
          'refresh-token-value',
          'access-token-value',
          'array-leaf-secret-1',
          'object-in-array-secret',
        ]),
      )
      expect(registry.literals()).not.toContain('api')
      expect(registry.matchable()).toBe(true)
    })

    it('marks a short credential leaf unmatchable', () => {
      // #given
      const {registry} = make()

      // #when
      registry.addAuthJson(JSON.stringify({provider: {type: 'api', key: 'abc123'}}))

      // #then
      expect(registry.matchable()).toBe(false)
    })

    it('treats text that is not JSON as one secret', () => {
      // #given
      const {registry} = make()

      // #when
      registry.addAuthJson('not json but still a secret')

      // #then
      expect(registry.literals()).toContain('not json but still a secret')
    })
  })

  describe('addOpencodeConfig', () => {
    it('adds in-range string leaves and ignores short or long leaves under ordinary keys', () => {
      // #given
      const {registry} = make()
      const text = JSON.stringify({
        model: 'anthropic/claude-sonnet-4',
        theme: 'dark',
        autoupdate: false,
        prompt: 'p'.repeat(MAX_LITERAL_CHARS + 10),
        mcp: {remote: {type: 'remote', headers: {Authorization: 'Bearer mcp-header-token-value'}}},
      })

      // #when
      registry.addOpencodeConfig(text)

      // #then
      expect(registry.literals()).toEqual(
        expect.arrayContaining(['anthropic/claude-sonnet-4', 'Bearer mcp-header-token-value']),
      )
      expect(registry.matchable()).toBe(true)
    })

    it.each([
      ['a short token', {mcp: {x: {headers: {'X-Api-Key': 'k1'}}}}],
      ['a short password', {provider: {options: {password: 'p4ss'}}}],
      ['an over-long secret', {provider: {options: {apiKey: 'z'.repeat(MAX_LITERAL_CHARS + 1)}}}],
    ])('marks %s under a secret-named key unmatchable', (_name, config) => {
      // #given
      const {registry} = make()

      // #when
      registry.addOpencodeConfig(JSON.stringify(config))

      // #then
      expect(registry.matchable()).toBe(false)
    })

    it('does not run away on a deeply nested document', () => {
      // #given a document nested far past any real config
      const {registry} = make()
      let text = '"leaf-secret-value-1234"'
      for (let index = 0; index < 500; index += 1) text = `{"a":${text}}`

      // #when / #then it returns, and fails closed rather than missing the leaf silently
      expect(() => registry.addOpencodeConfig(text)).not.toThrow()
      expect(registry.matchable()).toBe(false)
    })
  })

  describe('a credential leaf that is a Bearer or Basic value', () => {
    it('registers the token alone, because a message carries it without the scheme', () => {
      // #given a header value in opencode-config and an auth-json entry
      const registry = createSecretRegistry(vi.fn())
      registry.addOpencodeConfig(
        JSON.stringify({mcp: {remote: {headers: {Authorization: 'Bearer mcp-token-leaf-0001'}}}}),
      )
      registry.addAuthJson(JSON.stringify({custom: {type: 'api', key: 'Bearer auth-token-leaf-0002'}}))

      // #then
      expect(registry.literals()).toEqual(
        expect.arrayContaining(['Bearer mcp-token-leaf-0001', 'mcp-token-leaf-0001', 'auth-token-leaf-0002']),
      )
    })

    it('registers the decoded pair and password of a Basic value', () => {
      const registry = createSecretRegistry(vi.fn())
      const encoded = Buffer.from('some-user:some-password-0003').toString('base64')
      registry.addOpencodeConfig(JSON.stringify({headers: {Authorization: `Basic ${encoded}`}}))
      expect(registry.literals()).toEqual(
        expect.arrayContaining([encoded, 'some-user:some-password-0003', 'some-password-0003']),
      )
    })

    it('does not derive anything from a leaf that is not under a credential key', () => {
      const registry = createSecretRegistry(vi.fn())
      registry.addOpencodeConfig(JSON.stringify({note: 'Bearer not-a-credential-0004'}))
      expect(registry.literals()).not.toContain('not-a-credential-0004')
    })
  })

  describe('addTraceCredential', () => {
    it('adds the whole header value', () => {
      // #given
      const {registry} = make()

      // #when
      registry.addTraceCredential([{name: 'X-Scope-Token', value: 'plain-credential-value'}])

      // #then
      expect(registry.literals()).toContain('plain-credential-value')
    })

    it('adds the Bearer token as well as the whole value', () => {
      // #given
      const {registry} = make()

      // #when
      registry.addTraceCredential([{name: 'Authorization', value: 'Bearer bearer-token-abcdef'}])

      // #then
      expect(registry.literals()).toEqual(expect.arrayContaining(['Bearer bearer-token-abcdef', 'bearer-token-abcdef']))
    })

    it('adds the Basic token, the decoded pair and the password', () => {
      // #given
      const {registry} = make()
      const encoded = Buffer.from('collector-user:collector-password').toString('base64')

      // #when
      registry.addTraceCredential([{name: 'Authorization', value: `Basic ${encoded}`}])

      // #then
      expect(registry.literals()).toEqual(
        expect.arrayContaining([
          `Basic ${encoded}`,
          encoded,
          'collector-user:collector-password',
          'collector-password',
        ]),
      )
    })

    it('registers no junk for a Basic value that is not a base64 pair', () => {
      // #given
      const {registry} = make()

      // #when
      registry.addTraceCredential([{name: 'Authorization', value: 'Basic not-base64-pair!'}])

      // #then only the whole value and the token (which is what it is)
      expect(registry.literals().toSorted()).toEqual(['Basic not-base64-pair!', 'not-base64-pair!'].toSorted())
    })

    it('marks a short Basic password unmatchable', () => {
      // #given
      const {registry} = make()
      const encoded = Buffer.from('user-long-enough:pass').toString('base64')

      // #when
      registry.addTraceCredential([{name: 'Authorization', value: `Basic ${encoded}`}])

      // #then
      expect(registry.matchable()).toBe(false)
    })
  })

  describe('more than 128 literals', () => {
    it('keeps every one', () => {
      // #given
      const {registry} = make()
      const values = Array.from({length: 300}, (_value, index) => `secret-literal-${String(index).padStart(4, '0')}`)

      // #when
      for (const value of values) registry.add(value)

      // #then
      expect(registry.literals()).toHaveLength(300)
    })
  })

  describe('unmatchable sources', () => {
    it('is empty while every registered credential is in range, a 4,152-character runner token included', () => {
      // #given the length a JavaScript action's ACTIONS_RUNTIME_TOKEN has on a hosted runner
      const {registry} = make()

      // #when
      registry.addSecretEnv({
        ACTIONS_RUNTIME_TOKEN: 't'.repeat(4_152),
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'u'.repeat(4_152),
      })

      // #then
      expect(registry.matchable()).toBe(true)
      expect(registry.unmatchable()).toEqual({sources: [], total: 0})
      expect(registry.literals()).toHaveLength(2)
    })

    it('names the environment variable of a secret-named value outside the range, with its length and never its value', () => {
      // #given a short and a too-long value in secret-named variables, and an in-range one
      const {registry} = make()
      const tooLong = 'q'.repeat(MAX_LITERAL_CHARS + 1)

      // #when
      registry.addSecretEnv({FOO_TOKEN: 'abc1234', BAR_SECRET: tooLong, OK_PASSWORD: 'in-range-value', PATH: '/bin'})

      // #then
      expect(registry.matchable()).toBe(false)
      expect(registry.unmatchable()).toEqual({
        sources: [
          {source: 'env:FOO_TOKEN', length: 7},
          {source: 'env:BAR_SECRET', length: MAX_LITERAL_CHARS + 1},
        ],
        total: 2,
      })
      expect(JSON.stringify(registry.unmatchable())).not.toContain('abc1234')
      expect(JSON.stringify(registry.unmatchable())).not.toContain(tooLong.slice(0, 20))
    })

    it.each([
      ['a masked value', 'masked-value', (r: ReturnType<typeof make>['registry']) => r.mask('short')],
      ['an added value', 'registered-value', (r: ReturnType<typeof make>['registry']) => r.add('short')],
      ['a named mask', 'cache-restore', (r: ReturnType<typeof make>['registry']) => r.mask('short', 'cache-restore')],
      [
        'an auth-json leaf',
        'auth-json',
        (r: ReturnType<typeof make>['registry']) => r.addAuthJson('{"anthropic":{"type":"api","key":"short"}}'),
      ],
      [
        'an opencode-config leaf',
        'opencode-config',
        (r: ReturnType<typeof make>['registry']) =>
          r.addOpencodeConfig('{"provider":{"x":{"options":{"apiKey":"short"}}}}'),
      ],
      [
        'a trace credential',
        'trace-credential',
        (r: ReturnType<typeof make>['registry']) =>
          r.addTraceCredential([{name: 'Authorization', value: 'Bearer short'}]),
      ],
    ])('labels %s with a fixed category', (_name, label, register) => {
      // #given / #when
      const {registry} = make()
      register(registry)

      // #then the label is the category, with the length of what was registered
      expect(registry.unmatchable().sources[0]?.source).toBe(label)
      expect(registry.matchable()).toBe(false)
    })

    it('lists a source and length once however often it is registered', () => {
      // #given the same short value masked twice, and another of the same length from the same source
      const {registry} = make()
      registry.mask('short1')
      registry.mask('short1')
      registry.mask('other1')

      // #then one entry
      expect(registry.unmatchable()).toEqual({sources: [{source: 'masked-value', length: 6}], total: 1})
    })

    it('reports each source and length once, caps the list, and still counts them all', () => {
      // #given sixty distinct out-of-range values from one source
      const {registry} = make()
      for (let length = 1; length <= 7; length += 1) registry.add('x'.repeat(length), 'repeat')
      registry.add('x'.repeat(3), 'repeat')
      for (let index = 0; index < 60; index += 1) registry.add('y'.repeat(MAX_LITERAL_CHARS + 1 + index), 'long')

      // #then duplicates collapse, the list is bounded, and the total is the number of distinct entries
      const report = registry.unmatchable()
      expect(report.sources.length).toBeLessThanOrEqual(20)
      expect(report.total).toBe(67)
    })
  })
})
