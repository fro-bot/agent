import {describe, expect, it} from 'vitest'

import {
  modelProviderId,
  spawnConfigFromConfig,
  spawnConfigFromMergedConfig,
  verifyCredentialGate,
} from './credential-gate-v2.js'

const KEY = 'sk-ant-SUPERSECRETKEY-1234'

function handleWith(respond: (pathname: string) => Response | Promise<Response>): {
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>
  readonly paths: string[]
} {
  const paths: string[] = []
  return {
    paths,
    fetch: async path => {
      paths.push(path)
      return respond(path)
    },
  }
}

function integration(connections: readonly {type: string}[]): Response {
  return new Response(JSON.stringify({data: {connections}}), {status: 200})
}

describe('spawnConfigFromConfig', () => {
  it('counts a {file:} reference under options as configured authentication', () => {
    // #given V1-shaped options, the shape the Action writes
    const config = {
      model: 'anthropic/claude',
      provider: {anthropic: {options: {apiKey: '{file:/run/keys/anthropic.key}'}}},
    }

    // #when
    const result = spawnConfigFromConfig(config)

    // #then
    expect(result).toEqual({model: 'anthropic/claude', authenticatedProviders: ['anthropic']})
  })

  it('counts a {file:} reference under settings as configured authentication', () => {
    const result = spawnConfigFromConfig({provider: {openai: {settings: {apiKey: '{file:/run/keys/openai.key}'}}}})

    expect(result.authenticatedProviders).toEqual(['openai'])
  })

  it.each(['', '   ', '{file:}', '{env:}', '{file:  }'])('does not count %j', apiKey => {
    const result = spawnConfigFromConfig({provider: {anthropic: {options: {apiKey}}}})

    expect(result.authenticatedProviders).toEqual([])
  })

  it('ignores a provider with only a baseURL', () => {
    const result = spawnConfigFromConfig({provider: {custom: {options: {baseURL: 'https://example.test'}}}})

    expect(result.authenticatedProviders).toEqual([])
  })

  it('reports no model for a config without one', () => {
    expect(spawnConfigFromConfig({}).model).toBeUndefined()
  })
})

describe('spawnConfigFromMergedConfig', () => {
  it('does not quote the input when it is not JSON', () => {
    const result = spawnConfigFromMergedConfig(`{"provider": ${KEY}`)

    expect(result.success).toBe(false)
    expect(JSON.stringify(result)).not.toContain(KEY)
  })
})

describe('modelProviderId', () => {
  it('takes the provider half of a provider/model string', () => {
    expect(modelProviderId(' anthropic/claude-sonnet ')).toBe('anthropic')
  })

  it.each([undefined, '', '  ', '/model'])('is undefined for %j', model => {
    expect(modelProviderId(model)).toBeUndefined()
  })
})

describe('verifyCredentialGate', () => {
  it('passes a provider that carries a {file:} reference without asking the server', async () => {
    // #given
    const handle = handleWith(() => new Response('', {status: 500}))

    // #when
    const result = await verifyCredentialGate({
      handle,
      providers: ['anthropic'],
      configuredAuth: ['anthropic'],
      requestTimeoutMs: 1000,
    })

    // #then
    expect(result.success).toBe(true)
    expect(handle.paths).toEqual([])
  })

  it('passes a provider with a stored credential connection', async () => {
    const handle = handleWith(() => integration([{type: 'credential'}]))

    const result = await verifyCredentialGate({handle, providers: ['anthropic'], requestTimeoutMs: 1000})

    expect(result.success).toBe(true)
    expect(handle.paths).toEqual(['/api/integration/anthropic'])
  })

  it('fails closed when the provider has no connection, naming only the provider', async () => {
    const handle = handleWith(() => integration([]))

    const result = await verifyCredentialGate({
      handle,
      providers: ['anthropic'],
      requestTimeoutMs: 1000,
      remedy: 'Set the auth-json input.',
    })

    expect(result).toMatchObject({
      success: false,
      error: {kind: 'credential-missing', providers: ['anthropic']},
    })
    expect(result.success === false && result.error.message).toBe(
      'No credential for provider(s): anthropic. Set the auth-json input.',
    )
  })

  it('fails closed on a non-200 answer and on an unreachable server', async () => {
    const refused = {
      fetch: async (): Promise<Response> => {
        throw new TypeError('connect ECONNREFUSED')
      },
    }

    const notFound = await verifyCredentialGate({
      handle: handleWith(() => new Response('', {status: 404})),
      providers: ['a'],
      requestTimeoutMs: 1000,
    })
    const unreachable = await verifyCredentialGate({handle: refused, providers: ['a'], requestTimeoutMs: 1000})

    expect(notFound.success).toBe(false)
    expect(unreachable.success).toBe(false)
  })
})
