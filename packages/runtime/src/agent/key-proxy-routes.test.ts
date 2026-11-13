import {describe, expect, it} from 'vitest'

import {buildKeyProxyUpstream, KEY_PROXY_DEFAULT_PROVIDER_IDS, matchKeyProxyRoute} from './key-proxy-routes.js'

function upstreamOf(options: Parameters<typeof buildKeyProxyUpstream>[0]) {
  const built = buildKeyProxyUpstream(options)
  if (!built.success) throw new Error(`expected an upstream, got: ${built.error}`)
  return built.data
}

describe('buildKeyProxyUpstream', () => {
  it('maps anthropic with no base URL to the default upstream with the Messages routes', () => {
    // #given the anthropic provider and no operator base URL
    // #when the upstream is built
    const upstream = upstreamOf({providerId: 'anthropic', baseUrl: null, protocols: ['anthropic-messages']})

    // #then the origin is the default and Messages is the only inference route
    expect(upstream.origin).toBe('https://api.anthropic.com')
    const messages = matchKeyProxyRoute(upstream.routes, 'POST', '/messages', 'beta=true')
    expect(messages).toMatchObject({auth: 'x-api-key', upstreamPath: '/v1/messages', kind: 'inference'})
    expect(matchKeyProxyRoute(upstream.routes, 'POST', '/messages', '')).toBeDefined()
    expect(matchKeyProxyRoute(upstream.routes, 'POST', '/chat/completions', '')).toBeUndefined()
    expect(matchKeyProxyRoute(upstream.routes, 'POST', '/responses', '')).toBeUndefined()
  })

  it('maps openai with a cliproxy base URL to that upstream', () => {
    // #given an operator base URL for openai
    // #when the upstream is built
    const upstream = upstreamOf({
      providerId: 'openai',
      baseUrl: 'https://cliproxy.example.com/v1',
      protocols: ['openai-responses', 'openai-chat'],
    })

    // #then every protocol path is joined to that URL and uses a Bearer credential
    expect(upstream.origin).toBe('https://cliproxy.example.com')
    expect(matchKeyProxyRoute(upstream.routes, 'POST', '/responses', '')).toMatchObject({
      auth: 'bearer',
      upstreamPath: '/v1/responses',
    })
    expect(matchKeyProxyRoute(upstream.routes, 'POST', '/chat/completions', '')).toMatchObject({
      auth: 'bearer',
      upstreamPath: '/v1/chat/completions',
    })
    expect(matchKeyProxyRoute(upstream.routes, 'POST', '/responses/compact', '')).toMatchObject({
      upstreamPath: '/v1/responses/compact',
    })
  })

  it('resolves opencode-go with an operator base URL to that URL with all three protocols', () => {
    // #given opencode-go behind an operator gateway
    // #when the upstream is built
    const upstream = upstreamOf({
      providerId: 'opencode-go',
      baseUrl: 'https://gateway.example.com/go',
      protocols: ['anthropic-messages', 'openai-responses', 'openai-chat'],
    })

    // #then all three protocol paths hang off the operator URL
    expect(upstream.origin).toBe('https://gateway.example.com')
    expect(matchKeyProxyRoute(upstream.routes, 'POST', '/messages', '')?.upstreamPath).toBe('/go/messages')
    expect(matchKeyProxyRoute(upstream.routes, 'POST', '/responses', '')?.upstreamPath).toBe('/go/responses')
    expect(matchKeyProxyRoute(upstream.routes, 'POST', '/chat/completions', '')?.upstreamPath).toBe(
      '/go/chat/completions',
    )
  })

  it('maps opencode-go defaults per protocol, with the models route as its own entry', () => {
    // #given opencode-go with no operator base URL
    // #when the upstream is built
    const upstream = upstreamOf({
      providerId: 'opencode-go',
      baseUrl: null,
      protocols: ['anthropic-messages', 'openai-responses', 'openai-chat'],
    })

    // #then Messages, Responses and Chat use their fixed bases and the models route is separate
    expect(upstream.origin).toBe('https://opencode.ai')
    expect(matchKeyProxyRoute(upstream.routes, 'POST', '/messages', '')?.upstreamPath).toBe(
      '/inference/go/anthropic/v1/messages',
    )
    expect(matchKeyProxyRoute(upstream.routes, 'POST', '/responses', '')?.upstreamPath).toBe(
      '/inference/go/openai/v1/responses',
    )
    expect(matchKeyProxyRoute(upstream.routes, 'POST', '/chat/completions', '')?.upstreamPath).toBe(
      '/inference/go/openai/v1/chat/completions',
    )
    expect(matchKeyProxyRoute(upstream.routes, 'GET', '/models', '')).toMatchObject({
      upstreamPath: '/inference/go/v1/models',
      kind: 'models',
    })
  })

  it('includes each protocol GET models entry', () => {
    // #given each default provider
    for (const [providerId, protocols] of [
      ['anthropic', ['anthropic-messages']],
      ['openai', ['openai-responses', 'openai-chat']],
    ] as const) {
      // #when the upstream is built
      const upstream = upstreamOf({providerId, baseUrl: null, protocols})

      // #then a GET models route exists and carries the protocol's credential style
      const models = matchKeyProxyRoute(upstream.routes, 'GET', '/models', '')
      expect(models?.kind).toBe('models')
      expect(models?.auth).toBe(providerId === 'anthropic' ? 'x-api-key' : 'bearer')
    }
  })

  it('joins a base path that already ends in /v1 without doubling it, trailing slash or not', () => {
    // #given the same base with and without a trailing slash
    for (const baseUrl of ['https://gw.example.com/v1', 'https://gw.example.com/v1/']) {
      // #when the upstream is built
      const upstream = upstreamOf({providerId: 'openai', baseUrl, protocols: ['openai-chat']})

      // #then the upstream path has a single /v1
      expect(matchKeyProxyRoute(upstream.routes, 'POST', '/chat/completions', '')?.upstreamPath).toBe(
        '/v1/chat/completions',
      )
    }
  })

  it('joins a bare origin to the protocol path exactly, as the unproxied client would', () => {
    // #given a base URL with no path
    const upstream = upstreamOf({providerId: 'openai', baseUrl: 'https://gw.example.com', protocols: ['openai-chat']})

    // #then no /v1 is invented
    expect(matchKeyProxyRoute(upstream.routes, 'POST', '/chat/completions', '')?.upstreamPath).toBe('/chat/completions')
  })

  it('keeps a non-default port in the origin', () => {
    // #given an operator gateway on a port
    const upstream = upstreamOf({
      providerId: 'openai',
      baseUrl: 'https://10.0.0.5:8443/v1',
      protocols: ['openai-chat'],
    })

    // #then private ranges are allowed and the port stays
    expect(upstream.origin).toBe('https://10.0.0.5:8443')
  })

  it.each([
    ['http://', 'http://gw.example.com/v1'],
    ['userinfo', 'https://user:pass@gw.example.com/v1'],
    ['metadata host', 'https://169.254.169.254/v1'],
    ['fragment', 'https://gw.example.com/v1#frag'],
    ['query', 'https://gw.example.com/v1?x=1'],
    ['empty path segment', 'https://gw.example.com//v1'],
    ['not a URL', 'gw.example.com/v1'],
  ])('refuses an unsafe base URL (%s) and never quotes it', (_name, baseUrl) => {
    // #given an unsafe operator base URL
    // #when the upstream is built
    const built = buildKeyProxyUpstream({providerId: 'openai', baseUrl, protocols: ['openai-chat']})

    // #then it is refused without echoing the value
    expect(built.success).toBe(false)
    const message = built.success ? '' : built.error
    expect(message).not.toContain('gw.example.com')
    expect(message).not.toContain('pass')
  })

  it('refuses a provider with no protocols', () => {
    // #given an empty protocol set
    // #when the upstream is built
    const built = buildKeyProxyUpstream({providerId: 'openai', baseUrl: null, protocols: []})

    // #then it is refused
    expect(built.success).toBe(false)
  })

  it('refuses a provider that has no default upstream and no base URL', () => {
    // #given an unknown provider and no base URL
    // #when the upstream is built
    const built = buildKeyProxyUpstream({providerId: 'groq', baseUrl: null, protocols: ['openai-chat']})

    // #then it is refused
    expect(built.success).toBe(false)
  })

  it('lists the providers that have a built-in default upstream', () => {
    expect([...KEY_PROXY_DEFAULT_PROVIDER_IDS].sort()).toEqual(['anthropic', 'openai', 'opencode-go'])
  })
})

describe('matchKeyProxyRoute', () => {
  const upstream = upstreamOf({providerId: 'anthropic', baseUrl: null, protocols: ['anthropic-messages']})

  it('matches only the exact method, path and query', () => {
    // #given the Messages route table
    // #then a different method, a longer path, or an unlisted query does not match
    expect(matchKeyProxyRoute(upstream.routes, 'GET', '/messages', '')).toBeUndefined()
    expect(matchKeyProxyRoute(upstream.routes, 'POST', '/messages/count_tokens', '')).toBeUndefined()
    expect(matchKeyProxyRoute(upstream.routes, 'POST', '/messages', 'beta=false')).toBeUndefined()
    expect(matchKeyProxyRoute(upstream.routes, 'POST', '/messages', 'beta=true&x=1')).toBeUndefined()
    expect(matchKeyProxyRoute(upstream.routes, 'POST', '/Messages', '')).toBeUndefined()
  })
})
