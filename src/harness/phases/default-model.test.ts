import type {OpenCodeV2ServerHandle} from '@fro-bot/runtime'
import {describe, expect, it, vi} from 'vitest'
import {createMockLogger, unwrapErr, unwrapOk} from '../../shared/test-helpers.js'
import {logDefaultModelNotice, suppliedProviderIds, verifyDefaultModelProvider} from './default-model.js'

function handleWith(
  respond: (pathname: string) => Promise<Response>,
): Pick<OpenCodeV2ServerHandle, 'fetch'> & {readonly fetch: ReturnType<typeof vi.fn>} {
  return {fetch: vi.fn(respond)}
}

const providers = (...ids: string[]): Response =>
  new Response(JSON.stringify({data: ids.map(id => ({id}))}), {status: 200})

describe('suppliedProviderIds', () => {
  it('collects auth-json providers and opencode-config providers once each', () => {
    // #given a key for anthropic and a config that declares anthropic and a custom provider
    const result = suppliedProviderIds({
      keyProviderIds: ['anthropic'],
      config: {provider: {anthropic: {options: {baseURL: 'https://gw.example/v1'}}, gateway: {npm: 'x'}}},
    })

    // #then
    expect(result).toEqual(['anthropic', 'gateway'])
  })

  it('leaves out the built-in opencode provider: a key for it is used by the default model', () => {
    // #given
    const result = suppliedProviderIds({keyProviderIds: ['opencode'], config: {provider: {opencode: {options: {}}}}})

    // #then
    expect(result).toEqual([])
  })

  it('is empty when nothing is supplied', () => {
    expect(suppliedProviderIds({keyProviderIds: [], config: {}})).toEqual([])
    expect(suppliedProviderIds({keyProviderIds: [], config: {provider: 'not-an-object'}})).toEqual([])
  })
})

describe('logDefaultModelNotice', () => {
  it('warns once, naming the model, the unused providers and the model input, when credentials are supplied', () => {
    // #given
    const logger = createMockLogger()

    // #when
    logDefaultModelNotice({logger, suppliedProviders: ['anthropic', 'gateway']})

    // #then exactly one warning and no info line
    expect(logger.info).not.toHaveBeenCalled()
    expect(logger.warning).toHaveBeenCalledTimes(1)
    const message = vi.mocked(logger.warning).mock.calls[0]?.[0] ?? ''
    expect(message).toContain('opencode/big-pickle')
    expect(message).toContain('anthropic, gateway')
    expect(message).toContain('not used')
    expect(message).toContain('`model` input')
  })

  it('logs one info line naming the free default when nothing is supplied', () => {
    // #given
    const logger = createMockLogger()

    // #when
    logDefaultModelNotice({logger, suppliedProviders: []})

    // #then
    expect(logger.warning).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledTimes(1)
    const message = vi.mocked(logger.info).mock.calls[0]?.[0] ?? ''
    expect(message).toContain('opencode/big-pickle')
    expect(message).toContain('free')
  })
})

describe('verifyDefaultModelProvider', () => {
  const options = {requestTimeoutMs: 1000}

  it('passes when the server lists the default model provider', async () => {
    // #given
    const handle = handleWith(async () => providers('opencode', 'fake'))

    // #when
    const result = await verifyDefaultModelProvider({...options, handle})

    // #then
    expect(unwrapOk(result)).toBeUndefined()
    expect(handle.fetch.mock.calls[0]?.[0]).toBe('/api/provider')
  })

  it('fails with the cause and the remedy when the server does not list the default model provider', async () => {
    // #given a server whose caller config removed the built-in provider
    const handle = handleWith(async () => providers('fake'))

    // #when
    const result = await verifyDefaultModelProvider({...options, handle})

    // #then
    const message = unwrapErr(result)
    expect(message).toContain('opencode/big-pickle')
    expect(message).toContain('"opencode"')
    expect(message).toContain('enabled_providers')
    expect(message).toContain('disabled_providers')
    expect(message).toContain('`model` input')
  })

  it.each([
    ['a non-200 answer', async () => new Response('{}', {status: 404})],
    ['a body that is not JSON', async () => new Response('nope', {status: 200})],
    ['a body without a provider list', async () => new Response('{}', {status: 200})],
    [
      'a request that throws',
      async () => {
        throw new Error('socket hang up')
      },
    ],
  ])('does not fail the start on %s: the run proceeds as it always did', async (_name, respond) => {
    // #given
    const handle = handleWith(respond)

    // #when
    const result = await verifyDefaultModelProvider({...options, handle})

    // #then
    expect(unwrapOk(result)).toBeUndefined()
  })
})
