import {describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {logDefaultModelNotice, suppliedProviderIds} from './default-model.js'

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
