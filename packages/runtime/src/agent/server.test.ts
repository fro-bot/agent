import type {Logger} from '../shared/logger.js'
import process from 'node:process'
import {createOpencode} from '@opencode-ai/sdk'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {bootstrapOpenCodeServer} from './server.js'

vi.mock('@opencode-ai/sdk', () => ({
  createOpencode: vi.fn(),
}))

function createMockLogger(): Logger {
  return {
    debug: vi.fn<Logger['debug']>(),
    info: vi.fn<Logger['info']>(),
    warning: vi.fn<Logger['warning']>(),
    error: vi.fn<Logger['error']>(),
  }
}

describe('bootstrapOpenCodeServer', () => {
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
    vi.clearAllMocks()
  })

  it('calls createOpencode with 127.0.0.1 hostname and a numeric port, and sets FRO_BOT_OPENCODE_URL before spawn', async () => {
    // #given
    const logger = createMockLogger()
    let capturedEnvUrl: string | undefined
    vi.mocked(createOpencode).mockImplementation(async options => {
      // Capture the env var as observed at spawn time, inside the mock,
      // mirroring how the real child process would inherit it.
      capturedEnvUrl = process.env.FRO_BOT_OPENCODE_URL
      const port = (options as {port?: number}).port
      return {
        client: {} as never,
        server: {url: `http://127.0.0.1:${String(port)}`, close: vi.fn()},
      }
    })
    const controller = new AbortController()

    // #when
    const result = await bootstrapOpenCodeServer(controller.signal, logger)

    // #then
    expect(result.success).toBe(true)
    expect(createOpencode).toHaveBeenCalledTimes(1)
    const callArgs = vi.mocked(createOpencode).mock.calls[0]?.[0]
    expect(callArgs?.hostname).toBe('127.0.0.1')
    expect(typeof callArgs?.port).toBe('number')
    expect(capturedEnvUrl).toBe(`http://127.0.0.1:${String(callArgs?.port)}`)
  })

  it('scrubs denied secrets (e.g. GITHUB_TOKEN) from spawn env and restores them after bootstrap', async () => {
    // #given
    process.env.GITHUB_TOKEN = 'ghp_super_secret'
    const logger = createMockLogger()
    let capturedGithubTokenAtSpawn: string | undefined
    let capturedPinnedUrlAtSpawn: string | undefined
    vi.mocked(createOpencode).mockImplementation(async options => {
      capturedGithubTokenAtSpawn = process.env.GITHUB_TOKEN
      capturedPinnedUrlAtSpawn = process.env.FRO_BOT_OPENCODE_URL
      const port = (options as {port?: number}).port
      return {
        client: {} as never,
        server: {url: `http://127.0.0.1:${String(port)}`, close: vi.fn()},
      }
    })
    const controller = new AbortController()

    // #when
    const result = await bootstrapOpenCodeServer(controller.signal, logger)

    // #then
    expect(result.success).toBe(true)
    expect(capturedGithubTokenAtSpawn).toBeUndefined()
    const callArgs = vi.mocked(createOpencode).mock.calls[0]?.[0]
    expect(capturedPinnedUrlAtSpawn).toBe(`http://127.0.0.1:${String(callArgs?.port)}`)
    expect(process.env.GITHUB_TOKEN).toBe('ghp_super_secret')
  })

  it('leaves FRO_BOT_OPENCODE_URL set in the parent process after bootstrap, matching the server URL', async () => {
    // #given
    const logger = createMockLogger()
    vi.mocked(createOpencode).mockImplementation(async options => {
      const port = (options as {port?: number}).port
      return {
        client: {} as never,
        server: {url: `http://127.0.0.1:${String(port)}`, close: vi.fn()},
      }
    })
    const controller = new AbortController()

    // #when
    const result = await bootstrapOpenCodeServer(controller.signal, logger)

    // #then
    expect(result.success).toBe(true)
    const serverUrl = result.success ? result.data.server.url : undefined
    expect(process.env.FRO_BOT_OPENCODE_URL).toBe(serverUrl)
  })

  it('fails the bootstrap when the actual server URL differs from the pinned port', async () => {
    // #given
    const logger = createMockLogger()
    const closeSpy = vi.fn()
    vi.mocked(createOpencode).mockResolvedValue({
      client: {} as never,
      server: {url: 'http://127.0.0.1:9999', close: closeSpy},
    })
    const controller = new AbortController()

    // #when
    const result = await bootstrapOpenCodeServer(controller.signal, logger)

    // #then
    expect(result.success).toBe(false)
    const message = result.success ? undefined : result.error.message
    expect(message).toContain('http://127.0.0.1:9999')
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('returns an error result when createOpencode fails', async () => {
    // #given
    const logger = createMockLogger()
    vi.mocked(createOpencode).mockRejectedValue(new Error('port taken'))
    const controller = new AbortController()

    // #when
    const result = await bootstrapOpenCodeServer(controller.signal, logger)

    // #then
    expect(result.success).toBe(false)
    const message = result.success ? undefined : result.error.message
    expect(message).toContain('port taken')
  })

  it('passes the default 5000ms bootstrap budget to createOpencode when no timeout is provided', async () => {
    // #given
    const logger = createMockLogger()
    vi.mocked(createOpencode).mockImplementation(async options => {
      const port = (options as {port?: number}).port
      return {
        client: {} as never,
        server: {url: `http://127.0.0.1:${String(port)}`, close: vi.fn()},
      }
    })
    const controller = new AbortController()

    // #when
    const result = await bootstrapOpenCodeServer(controller.signal, logger)

    // #then
    expect(result.success).toBe(true)
    const callArgs = vi.mocked(createOpencode).mock.calls[0]?.[0]
    expect(callArgs?.timeout).toBe(5000)
  })

  it('passes a configured bootstrap budget through to createOpencode', async () => {
    // #given
    const logger = createMockLogger()
    vi.mocked(createOpencode).mockImplementation(async options => {
      const port = (options as {port?: number}).port
      return {
        client: {} as never,
        server: {url: `http://127.0.0.1:${String(port)}`, close: vi.fn()},
      }
    })
    const controller = new AbortController()

    // #when
    const result = await bootstrapOpenCodeServer(controller.signal, logger, 12_000)

    // #then
    expect(result.success).toBe(true)
    const callArgs = vi.mocked(createOpencode).mock.calls[0]?.[0]
    expect(callArgs?.timeout).toBe(12_000)
  })

  it('logs the bootstrap budget and elapsed time on success', async () => {
    // #given
    const logger = createMockLogger()
    vi.mocked(createOpencode).mockImplementation(async options => {
      const port = (options as {port?: number}).port
      return {
        client: {} as never,
        server: {url: `http://127.0.0.1:${String(port)}`, close: vi.fn()},
      }
    })
    const controller = new AbortController()

    // #when
    const result = await bootstrapOpenCodeServer(controller.signal, logger, 7_500)

    // #then
    expect(result.success).toBe(true)
    expect(logger.debug).toHaveBeenCalledWith(
      'OpenCode server bootstrapped',
      expect.objectContaining({timeoutMs: 7_500, elapsedMs: expect.any(Number) as number}),
    )
  })

  it('logs the bootstrap budget and elapsed time on failure', async () => {
    // #given
    const logger = createMockLogger()
    vi.mocked(createOpencode).mockRejectedValue(new Error('Timeout waiting for server to start after 7500ms'))
    const controller = new AbortController()

    // #when
    const result = await bootstrapOpenCodeServer(controller.signal, logger, 7_500)

    // #then
    expect(result.success).toBe(false)
    expect(logger.warning).toHaveBeenCalledWith(
      'Failed to bootstrap OpenCode server',
      expect.objectContaining({timeoutMs: 7_500, elapsedMs: expect.any(Number) as number}),
    )
  })

  it('closes the server on a failure that occurs after the handle was acquired', async () => {
    // #given
    const logger = createMockLogger()
    const closeSpy = vi.fn()
    // Simulate a failure that happens after createOpencode resolves with a live
    // handle — e.g. an unexpected throw between acquisition and return — by making
    // the success-path logger call itself throw once the handle is in hand.
    vi.mocked(logger.debug).mockImplementationOnce(() => {
      throw new Error('unexpected failure after handle acquisition')
    })
    vi.mocked(createOpencode).mockImplementation(async options => {
      const port = (options as {port?: number}).port
      return {
        client: {} as never,
        server: {url: `http://127.0.0.1:${String(port)}`, close: closeSpy},
      }
    })
    const controller = new AbortController()

    // #when
    const result = await bootstrapOpenCodeServer(controller.signal, logger)

    // #then
    expect(result.success).toBe(false)
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })
})
