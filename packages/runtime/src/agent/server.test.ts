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

  it('warns and overwrites FRO_BOT_OPENCODE_URL when the actual server URL differs from the pinned port', async () => {
    // #given
    const logger = createMockLogger()
    vi.mocked(createOpencode).mockResolvedValue({
      client: {} as never,
      server: {url: 'http://127.0.0.1:9999', close: vi.fn()},
    })
    const controller = new AbortController()

    // #when
    const result = await bootstrapOpenCodeServer(controller.signal, logger)

    // #then
    expect(result.success).toBe(true)
    expect(logger.warning).toHaveBeenCalledWith(
      'OpenCode server URL differs from pinned port',
      expect.objectContaining({actualUrl: 'http://127.0.0.1:9999'}),
    )
    expect(process.env.FRO_BOT_OPENCODE_URL).toBe('http://127.0.0.1:9999')
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
})
