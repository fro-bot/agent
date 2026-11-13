import type {ProviderKeyEntryV2} from './credential-files-v2.js'
import {describe, expect, it} from 'vitest'
import {resolveKeyProxyProviders} from './key-proxy-providers.js'

const CANARY = 'sk-CANARY-do-not-print-0001'

function keys(...ids: string[]): ProviderKeyEntryV2[] {
  return ids.map(providerId => ({providerId, key: `${CANARY}-${providerId}`}))
}

function resolve(ids: string[], config: unknown = null) {
  return resolveKeyProxyProviders({
    keys: keys(...ids),
    opencodeConfig: config === null ? null : typeof config === 'string' ? config : JSON.stringify(config),
  })
}

function expectRefusal(result: ReturnType<typeof resolve>, provider: string) {
  if (result.success) throw new Error('expected a refusal')
  // Every refusal names the provider, says how to fix it, and carries no key or URL credential.
  expect(result.error.message).toContain(provider)
  expect(result.error.message).toMatch(/Fix: /)
  expect(result.error.message).toContain('isolate-agent: false')
  expect(result.error.message).not.toContain(CANARY)
  expect(result.error.message).not.toContain('hunter2')
  return result.error
}

describe('resolveKeyProxyProviders', () => {
  describe('supported providers', () => {
    it('resolves anthropic with no base URL to the default upstream with the Messages protocol', () => {
      // #given an anthropic key and no operator config
      // #when the providers are resolved
      const result = resolve(['anthropic'])

      // #then the plan has no operator base URL and the Messages protocol
      expect(result).toEqual({
        success: true,
        data: [{providerId: 'anthropic', baseUrl: null, protocols: ['anthropic-messages']}],
      })
    })

    it('resolves openai with a cliproxy base URL to that upstream', () => {
      // #given an openai key and an operator base URL
      const result = resolve(['openai'], {provider: {openai: {options: {baseURL: 'https://cliproxy.example.com/v1'}}}})

      // #then the plan carries the operator URL and both OpenAI protocols
      expect(result).toEqual({
        success: true,
        data: [
          {
            providerId: 'openai',
            baseUrl: 'https://cliproxy.example.com/v1',
            protocols: ['openai-responses', 'openai-chat'],
          },
        ],
      })
    })

    it('resolves opencode-go with an operator base URL with all three protocols', () => {
      // #given opencode-go behind a gateway
      const result = resolve(['opencode-go'], {
        provider: {'opencode-go': {options: {baseURL: 'https://gw.example/go'}}},
      })

      // #then all three protocols are planned against that URL
      expect(result).toEqual({
        success: true,
        data: [
          {
            providerId: 'opencode-go',
            baseUrl: 'https://gw.example/go',
            protocols: ['anthropic-messages', 'openai-responses', 'openai-chat'],
          },
        ],
      })
    })

    it('resolves opencode-go with no base URL to the built-in per-protocol defaults', () => {
      // #given opencode-go and no operator URL
      const result = resolve(['opencode-go'])

      // #then it needs no base URL and serves all three protocols
      expect(result).toEqual({
        success: true,
        data: [
          {
            providerId: 'opencode-go',
            baseUrl: null,
            protocols: ['anthropic-messages', 'openai-responses', 'openai-chat'],
          },
        ],
      })
    })

    it('reads the base URL from the V2 providers.<id>.settings shape', () => {
      // #given a V2-shaped operator provider
      const result = resolve(['openai'], {providers: {openai: {settings: {baseURL: 'https://gw.example/v1'}}}})

      // #then the URL is found
      expect(result.success && result.data[0]?.baseUrl).toBe('https://gw.example/v1')
    })

    it('accepts a legacy and a V2 base URL that agree', () => {
      // #given both shapes with the same URL
      const result = resolve(['openai'], {
        provider: {openai: {options: {baseURL: 'https://gw.example/v1'}}},
        providers: {openai: {settings: {baseURL: 'https://gw.example/v1'}}},
      })

      // #then it is accepted
      expect(result.success).toBe(true)
    })

    it('refuses a legacy and a V2 base URL that disagree', () => {
      // #given both shapes with different URLs
      const result = resolve(['openai'], {
        provider: {openai: {options: {baseURL: 'https://gw.example/v1'}}},
        providers: {openai: {settings: {baseURL: 'https://other.example/v1'}}},
      })

      // #then it is refused and neither URL is quoted
      const error = expectRefusal(result, 'openai')
      expect(error.message).not.toContain('gw.example')
      expect(error.message).not.toContain('other.example')
    })

    it('chooses the protocol from the provider package', () => {
      // #given a custom provider id on the openai-compatible package, and one on the Anthropic package
      const result = resolve(['cliproxy', 'claude-gw'], {
        provider: {
          cliproxy: {npm: '@ai-sdk/openai-compatible', options: {baseURL: 'https://gw.example/v1'}},
          'claude-gw': {npm: '@ai-sdk/anthropic', options: {baseURL: 'https://gw.example/v1'}},
        },
      })

      // #then the protocols follow the package
      expect(result.success && result.data.map(plan => [plan.providerId, plan.protocols])).toEqual([
        ['cliproxy', ['openai-responses', 'openai-chat']],
        ['claude-gw', ['anthropic-messages']],
      ])
    })

    it('also reads the V2 package field', () => {
      // #given a V2 provider with a native package
      const result = resolve(['cliproxy'], {
        providers: {
          cliproxy: {package: '@opencode/ai/providers/openai-compatible', settings: {baseURL: 'https://gw.example/v1'}},
        },
      })

      // #then the protocols follow the package
      expect(result.success && result.data[0]?.protocols).toEqual(['openai-responses', 'openai-chat'])
    })

    it('needs no proxy for no keys and no operator providers', () => {
      // #given an empty key set
      const result = resolve([])

      // #then the plan is empty
      expect(result).toEqual({success: true, data: []})
    })

    it('keeps operator settings that do not bypass the proxy', () => {
      // #given an operator provider that only tunes a timeout and a harmless header
      const result = resolve(['anthropic'], {
        provider: {anthropic: {options: {timeout: 600_000, headers: {'x-team': 'a'}}}},
      })

      // #then it is accepted
      expect(result.success).toBe(true)
    })
  })

  describe('refusals', () => {
    it('refuses an http:// upstream with a fix', () => {
      const result = resolve(['openai'], {provider: {openai: {options: {baseURL: 'http://gw.example/v1'}}}})
      const error = expectRefusal(result, 'openai')
      expect(error.kind).toBe('unsafe-upstream')
    })

    it('refuses userinfo in the upstream with a fix and never prints it', () => {
      const result = resolve(['openai'], {provider: {openai: {options: {baseURL: 'https://u:hunter2@gw.example/v1'}}}})
      expectRefusal(result, 'openai')
    })

    it('refuses the cloud metadata address as the upstream', () => {
      const result = resolve(['openai'], {provider: {openai: {options: {baseURL: 'https://169.254.169.254/v1'}}}})
      expectRefusal(result, 'openai')
    })

    it('accepts a private-range https upstream', () => {
      const result = resolve(['openai'], {provider: {openai: {options: {baseURL: 'https://10.1.2.3:8443/v1'}}}})
      expect(result.success).toBe(true)
    })

    it('refuses options.endpoint', () => {
      const result = resolve(['anthropic'], {provider: {anthropic: {options: {endpoint: 'https://x.example'}}}})
      const error = expectRefusal(result, 'anthropic')
      expect(error.kind).toBe('bypass-field')
      expect(error.message).toContain('endpoint')
    })

    it.each([
      ['a provider Authorization header', {provider: {openai: {options: {headers: {Authorization: 'Bearer x'}}}}}],
      ['a provider x-api-key header', {provider: {openai: {options: {headers: {'X-Api-Key': 'x'}}}}}],
      ['a V2 settings header', {providers: {openai: {settings: {headers: {authorization: 'x'}}}}}],
      ['a model header', {provider: {openai: {models: {'gpt-x': {headers: {Authorization: 'Bearer x'}}}}}}],
      [
        'a V2 model settings header',
        {providers: {openai: {models: {'gpt-x': {settings: {headers: {'api-key': 'x'}}}}}}},
      ],
    ])('refuses a credential-bearing header (%s)', (_name, config) => {
      const error = expectRefusal(resolve(['openai'], config), 'openai')
      expect(error.kind).toBe('bypass-field')
      expect(error.message).toContain('headers')
    })

    it.each([
      ['{env:X}', '{env:OPENAI_BASE}/v1'],
      ['{file:/x}', '{file:/etc/x}'],
    ])('refuses %s in a base URL', (_name, baseURL) => {
      const result = resolve(['openai'], {provider: {openai: {options: {baseURL}}}})
      const error = expectRefusal(result, 'openai')
      expect(error.kind).toBe('unsafe-upstream')
      expect(error.message).toContain('{env:}')
    })

    it('refuses a Bedrock provider', () => {
      const result = resolve(['amazon-bedrock'])
      const error = expectRefusal(result, 'amazon-bedrock')
      expect(error.kind).toBe('signing-provider')
    })

    it.each([
      ['@ai-sdk/amazon-bedrock'],
      ['@ai-sdk/google-vertex'],
      ['@ai-sdk/google-vertex/anthropic'],
      ['@ai-sdk/google'],
    ])('refuses a provider on the %s package', npm => {
      const result = resolve(['mine'], {provider: {mine: {npm, options: {baseURL: 'https://gw.example/v1'}}}})
      expect(expectRefusal(result, 'mine').kind).toBe('signing-provider')
    })

    it('refuses a model on a signing package', () => {
      const result = resolve(['openai'], {
        provider: {openai: {models: {m: {provider: {npm: '@ai-sdk/amazon-bedrock'}}}}},
      })
      expect(expectRefusal(result, 'openai').kind).toBe('signing-provider')
    })

    it('refuses an unknown provider with no base URL and tells the operator to set one', () => {
      const result = resolve(['groq'])
      const error = expectRefusal(result, 'groq')
      expect(error.kind).toBe('unmapped-provider')
      expect(error.message).toContain('baseURL')
    })

    it('refuses an unknown provider with a base URL and no recognised package', () => {
      const result = resolve(['groq'], {provider: {groq: {options: {baseURL: 'https://gw.example/v1'}}}})
      expect(expectRefusal(result, 'groq').kind).toBe('unmapped-provider')
    })

    it('refuses an unrecognised package', () => {
      const result = resolve(['mine'], {
        provider: {mine: {npm: 'some-private-package', options: {baseURL: 'https://gw.example/v1'}}},
      })
      expect(expectRefusal(result, 'mine').kind).toBe('unmapped-provider')
    })

    it.each([
      [
        'a V2 model settings base URL',
        {providers: {openai: {models: {m: {settings: {baseURL: 'https://x.example'}}}}}},
      ],
      ['a legacy model provider.api', {provider: {openai: {models: {m: {provider: {api: 'https://x.example'}}}}}}],
      [
        'a legacy model options base URL',
        {provider: {openai: {models: {m: {options: {baseURL: 'https://x.example'}}}}}},
      ],
      ['a model endpoint', {provider: {openai: {models: {m: {options: {endpoint: 'https://x.example'}}}}}}],
    ])('refuses a model-level base URL (%s)', (_name, config) => {
      const error = expectRefusal(resolve(['openai'], config), 'openai')
      expect(error.kind).toBe('bypass-field')
    })

    it.each([
      ['a literal apiKey', {provider: {openai: {options: {apiKey: 'sk-literal'}}}}],
      ['a literal authToken', {provider: {anthropic: {options: {authToken: 'tok'}}}}],
      ['a V2 literal apiKey', {providers: {openai: {settings: {apiKey: 'sk-literal'}}}}],
    ])('refuses %s', (_name, config) => {
      const providerId = JSON.stringify(config).includes('anthropic') ? 'anthropic' : 'openai'
      const error = expectRefusal(resolve([providerId], config), providerId)
      expect(error.kind).toBe('bypass-field')
      expect(error.message).not.toContain('sk-literal')
      expect(error.message).not.toContain('"tok"')
    })

    it('accepts an apiKey reference, which the placeholder replaces', () => {
      const result = resolve(['openai'], {provider: {openai: {options: {apiKey: '{env:OPENAI_API_KEY}'}}}})
      expect(result.success).toBe(true)
    })

    it('refuses an operator provider that has no auth-json key', () => {
      const result = resolve(['anthropic'], {provider: {local: {options: {baseURL: 'https://gw.example/v1'}}}})
      const error = expectRefusal(result, 'local')
      expect(error.kind).toBe('missing-key')
    })

    it('refuses an operator provider with no key when auth-json is empty', () => {
      const result = resolve([], {provider: {local: {options: {baseURL: 'https://gw.example/v1'}}}})
      expect(expectRefusal(result, 'local').kind).toBe('missing-key')
    })

    it('does not echo an operator provider id that has invalid characters', () => {
      const result = resolve(['anthropic'], {provider: {'bad id\n{env:SECRET}': {options: {}}}})
      const message = result.success ? '' : result.error.message
      expect(message).not.toContain('SECRET')
      expect(message).toContain('isolate-agent: false')
    })

    it('reports invalid JSON the way the config builder does', () => {
      const result = resolve(['anthropic'], '{not json')
      expect(result).toEqual({
        success: false,
        error: {kind: 'invalid-config', message: 'opencode-config must be valid JSON'},
      })
    })

    it('rejects a non-object config', () => {
      const result = resolve(['anthropic'], '[1]')
      expect(result.success ? '' : result.error.message).toBe('opencode-config must be a JSON object')
    })

    it('refuses a base URL that is not a string', () => {
      const result = resolve(['openai'], {provider: {openai: {options: {baseURL: 12}}}})
      expect(expectRefusal(result, 'openai').kind).toBe('unsafe-upstream')
    })
  })
})

describe('resolveKeyProxyProviders: every scope of the provider config', () => {
  const SECRET = 'sk-CANARY-scope-walk-0002'
  const OTHER = 'https://other.example/v1'

  const refusal = (config: unknown) => {
    const result = resolve(['openai'], config)
    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a refusal')
    // Every refusal names the provider and a fix, and holds no value from the config.
    expect(result.error.kind).toBe('bypass-field')
    expect(result.error.message).toContain('provider "openai"')
    expect(result.error.message).toMatch(/Fix: /)
    expect(result.error.message).toContain('isolate-agent: false')
    for (const value of [SECRET, 'other.example', 'Bearer']) expect(result.error.message).not.toContain(value)
    return result.error.message
  }

  const native = (provider: Record<string, unknown>) => ({providers: {openai: provider}})
  const legacy = (provider: Record<string, unknown>) => ({provider: {openai: provider}})

  describe('credentials, in the native and legacy shapes', () => {
    it.each([
      ['native provider headers', native({headers: {Authorization: `Bearer ${SECRET}`}}), 'headers', null],
      ['native provider settings.accessToken', native({settings: {accessToken: SECRET}}), 'accessToken', null],
      ['native provider settings.refreshToken', native({settings: {refreshToken: SECRET}}), 'refreshToken', null],
      ['native model settings.apiKey', native({models: {m: {settings: {apiKey: SECRET}}}}), 'apiKey', 'model "m"'],
      [
        'native model settings.authToken',
        native({models: {m: {settings: {authToken: SECRET}}}}),
        'authToken',
        'model "m"',
      ],
      ['native model headers', native({models: {m: {headers: {'X-Api-Key': SECRET}}}}), 'headers', 'model "m"'],
      [
        'native model settings.headers',
        native({models: {m: {settings: {headers: {authorization: SECRET}}}}}),
        'headers',
        'model "m"',
      ],
      [
        'native variant settings.apiKey',
        native({models: {m: {variants: [{id: 'v', settings: {apiKey: SECRET}}]}}}),
        'apiKey',
        'model "m" variant "v"',
      ],
      [
        'native variant headers',
        native({models: {m: {variants: [{id: 'v', headers: {Authorization: SECRET}}]}}}),
        'headers',
        'model "m" variant "v"',
      ],
      [
        'native variant settings.headers',
        native({models: {m: {variants: [{id: 'v', settings: {headers: {'x-api-key': SECRET}}}]}}}),
        'headers',
        'model "m" variant "v"',
      ],
      ['legacy model options.apiKey', legacy({models: {m: {options: {apiKey: SECRET}}}}), 'apiKey', 'model "m"'],
      ['legacy model headers', legacy({models: {m: {headers: {Authorization: SECRET}}}}), 'headers', 'model "m"'],
      [
        'legacy variant options.apiKey (map form)',
        legacy({models: {m: {variants: {fast: {options: {apiKey: SECRET}}}}}}),
        'apiKey',
        'model "m" variant "fast"',
      ],
      [
        'legacy variant headers (map form)',
        legacy({models: {m: {variants: {fast: {headers: {Authorization: SECRET}}}}}}),
        'headers',
        'model "m" variant "fast"',
      ],
      [
        'a variant that sets the key directly (map form)',
        legacy({models: {m: {variants: {fast: {apiKey: SECRET}}}}}),
        'apiKey',
        'model "m" variant "fast"',
      ],
    ])('refuses %s', (_name, config, field, scope) => {
      const message = refusal(config)
      expect(message).toContain(field)
      expect(message).toContain(scope ?? '')
    })

    it('refuses a model-level reference too, because it would replace the placeholder', () => {
      expect(refusal(native({models: {m: {settings: {apiKey: '{env:OPENAI_API_KEY}'}}}}))).toContain('model "m"')
    })
  })

  describe('endpoint overrides, in the native and legacy shapes', () => {
    it.each([
      [
        'native variant settings.baseURL',
        native({models: {m: {variants: [{id: 'direct', settings: {baseURL: OTHER}}]}}}),
        'baseURL',
        'model "m" variant "direct"',
      ],
      [
        'native variant settings.endpoint',
        native({models: {m: {variants: [{id: 'v', settings: {endpoint: OTHER}}]}}}),
        'endpoint',
        'model "m" variant "v"',
      ],
      ['native model settings.baseURL', native({models: {m: {settings: {baseURL: OTHER}}}}), 'baseURL', 'model "m"'],
      ['native model settings.api', native({models: {m: {settings: {api: OTHER}}}}), 'api', 'model "m"'],
      ['legacy model options.baseURL', legacy({models: {m: {options: {baseURL: OTHER}}}}), 'baseURL', 'model "m"'],
      ['legacy model provider.api', legacy({models: {m: {provider: {api: OTHER}}}}), 'api', 'model "m"'],
      [
        'legacy variant options.baseURL (map form)',
        legacy({models: {m: {variants: {direct: {options: {baseURL: OTHER}}}}}}),
        'baseURL',
        'model "m" variant "direct"',
      ],
      [
        'legacy variant provider.api (map form)',
        legacy({models: {m: {variants: {direct: {provider: {api: OTHER}}}}}}),
        'api',
        'model "m" variant "direct"',
      ],
      [
        'an endpoint nested in another provider-level object',
        native({settings: {transport: {endpoint: OTHER}}}),
        'endpoint',
        null,
      ],
    ])('refuses %s', (_name, config, field, scope) => {
      const message = refusal(config)
      expect(message).toContain(field)
      expect(message).toContain(scope ?? '')
    })
  })

  describe('query parameters', () => {
    it.each([
      ['legacy provider options', legacy({options: {queryParams: {'api-version': '1'}}})],
      ['native provider settings', native({settings: {queryParams: {'api-version': '1'}}})],
      ['native model settings', native({models: {m: {settings: {queryParams: {x: '1'}}}}})],
    ])('refuses queryParams in %s, with the remedy', (_name, config) => {
      const message = refusal(config)
      expect(message).toContain('queryParams')
      expect(message).toMatch(/no query string|drop `queryParams`|remove `queryParams`/)
    })
  })

  describe('settings that do not bypass the proxy', () => {
    it('accepts benign provider, model and variant settings in both shapes', () => {
      const result = resolve(['openai'], {
        providers: {
          openai: {
            settings: {timeout: 600_000, headers: {'x-team': 'a'}},
            models: {
              m: {
                name: 'M',
                limit: {context: 1000, output: 100},
                settings: {maxTokens: 50, reasoning: {effort: 'high', budget_tokens: 10}},
                headers: {'x-model': 'b'},
                variants: [{id: 'high', settings: {reasoningEffort: 'high'}}],
              },
            },
          },
        },
        provider: {
          openai: {models: {m: {options: {temperature: 0.2}, variants: {fast: {options: {reasoningEffort: 'low'}}}}}},
        },
      })

      expect(result.success).toBe(true)
    })

    it('does not read a harmless header that happens to be named like a setting', () => {
      const result = resolve(['openai'], native({models: {m: {headers: {'x-api': 'a', 'x-endpoint': 'b'}}}}))

      expect(result.success).toBe(true)
    })

    it('does not echo a model or variant id that is not a plain identifier', () => {
      const message = refusal(native({models: {'bad id\n{env:LEAK}': {settings: {apiKey: SECRET}}}}))
      expect(message).not.toContain('LEAK')
    })
  })
})
