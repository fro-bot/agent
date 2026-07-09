import type {Logger} from '../shared/logger.js'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {withScrubbedEnv} from './with-scrubbed-env.js'

function createMockLogger(): Logger {
  return {
    debug: vi.fn<Logger['debug']>(),
    info: vi.fn<Logger['info']>(),
    warning: vi.fn<Logger['warning']>(),
    error: vi.fn<Logger['error']>(),
  }
}

describe('withScrubbedEnv', () => {
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    envSnapshot = {...process.env}
  })

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key]
    }
    for (const [key, value] of Object.entries(envSnapshot)) {
      process.env[key] = value
    }
  })

  it('scrubs GH_TOKEN and GITHUB_TOKEN before fn is called (#1147 canary)', async () => {
    // #given
    process.env.GH_TOKEN = 'ghp_x'
    process.env.GITHUB_TOKEN = 'ghs_x'
    const logger = createMockLogger()

    // #when
    const captured = await withScrubbedEnv(
      async () => ({gh: process.env.GH_TOKEN, ght: process.env.GITHUB_TOKEN}),
      logger,
    )

    // #then
    expect(captured.gh).toBeUndefined()
    expect(captured.ght).toBeUndefined()
  })

  it('restores GH_TOKEN and GITHUB_TOKEN after fn resolves', async () => {
    // #given
    process.env.GH_TOKEN = 'ghp_x'
    process.env.GITHUB_TOKEN = 'ghs_x'
    const logger = createMockLogger()

    // #when
    await withScrubbedEnv(async () => null, logger)

    // #then
    expect(process.env.GH_TOKEN).toBe('ghp_x')
    expect(process.env.GITHUB_TOKEN).toBe('ghs_x')
  })

  it('scrubs a denied var inside fn and restores it after, while keeping an allowlisted var visible throughout', async () => {
    // #given
    process.env.AWS_ACCESS_KEY_ID = 'AKIA_x'
    process.env.OPENCODE_CONFIG_CONTENT = '{}'
    const logger = createMockLogger()

    // #when
    const insideValues = await withScrubbedEnv(
      async () => ({
        aws: process.env.AWS_ACCESS_KEY_ID,
        opencode: process.env.OPENCODE_CONFIG_CONTENT,
      }),
      logger,
    )

    // #then
    expect(insideValues.aws).toBeUndefined()
    expect(insideValues.opencode).toBe('{}')
    expect(process.env.AWS_ACCESS_KEY_ID).toBe('AKIA_x')
    expect(process.env.OPENCODE_CONFIG_CONTENT).toBe('{}')
  })

  it('restores env on throw and rejects with the original error', async () => {
    // #given
    process.env.GH_TOKEN = 'ghp_x'
    const logger = createMockLogger()
    const thrown = new Error('spawn failed')

    // #when / #then
    await expect(
      withScrubbedEnv(async () => {
        throw thrown
      }, logger),
    ).rejects.toThrow(thrown)
    expect(process.env.GH_TOKEN).toBe('ghp_x')
  })

  it('fails closed when filterAgentEnv throws: fn is never called and env is left intact', async () => {
    // #given
    vi.doMock('./filter-env.js', () => ({
      filterAgentEnv: () => {
        throw new Error('filter exploded')
      },
    }))
    vi.resetModules()
    const {withScrubbedEnv: withScrubbedEnvMocked} = await import('./with-scrubbed-env.js')
    process.env.GH_TOKEN = 'ghp_x'
    const logger = createMockLogger()
    const fn = vi.fn(async () => 'should not run')

    // #when / #then
    await expect(withScrubbedEnvMocked(fn, logger)).rejects.toThrow('filter exploded')
    expect(fn).not.toHaveBeenCalled()
    expect(process.env.GH_TOKEN).toBe('ghp_x')

    vi.doUnmock('./filter-env.js')
    vi.resetModules()
  })

  it('logs only a removedCount, never key names or values', async () => {
    // #given
    process.env.GH_TOKEN = 'ghp_x'
    process.env.GITHUB_TOKEN = 'ghs_x'
    const logger = createMockLogger()

    // #when
    await withScrubbedEnv(async () => null, logger)

    // #then
    const infoMock = vi.mocked(logger.info)
    const call = infoMock.mock.calls[0]
    expect(call?.[0]).toBe('Scrubbed agent env for spawn')
    const context = call?.[1]
    expect(context).toBeDefined()
    expect(typeof context?.removedCount).toBe('number')
    expect(Object.keys(context ?? {})).toEqual(['removedCount'])
  })
})
