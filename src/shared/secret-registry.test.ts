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
      const lengths = [MIN_LITERAL_CHARS - 1, MIN_LITERAL_CHARS, MAX_LITERAL_CHARS, MAX_LITERAL_CHARS + 1]

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
})
