import type {Logger} from '../shared/logger.js'
import net from 'node:net'
import process from 'node:process'
import {createOpencode} from '@opencode-ai/sdk'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {bootstrapOpenCodeServer, waitForServerQuiescence} from './server.js'

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

  it("still returns a failed Result rather than rejecting when the acquired server's close() itself throws", async () => {
    // #given a failure after handle acquisition (as above), but this time close() itself
    // throws — the one path the never-throw contract must survive: the whole function
    // exists to return err() instead of rejecting, and an unguarded cleanup call would
    // turn exactly this case into a rejection instead
    const logger = createMockLogger()
    const closeSpy = vi.fn(() => {
      throw new Error('close() itself failed')
    })
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

    // #when / #then — the promise must resolve, not reject
    const result = await bootstrapOpenCodeServer(controller.signal, logger)
    expect(result.success).toBe(false)
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  describe('shutdown() quiescence', () => {
    it("calls server.close() synchronously before the returned promise's quiescence wait resolves", async () => {
      // #given a bootstrapped handle backed by the mocked SDK — nothing is actually
      // listening on the pinned port (createOpencode never binds it for real), so the
      // quiescence poll should observe the port as already closed on its first attempt
      const logger = createMockLogger()
      const closeSpy = vi.fn()
      vi.mocked(createOpencode).mockImplementation(async options => {
        const port = (options as {port?: number}).port
        return {
          client: {} as never,
          server: {url: `http://127.0.0.1:${String(port)}`, close: closeSpy},
        }
      })
      const controller = new AbortController()
      const bootstrapResult = await bootstrapOpenCodeServer(controller.signal, logger)
      expect(bootstrapResult.success).toBe(true)
      if (!bootstrapResult.success) return

      // #when calling shutdown()
      const shutdownPromise = bootstrapResult.data.shutdown()

      // #then close() has already run synchronously, before the quiescence wait is awaited
      expect(closeSpy).toHaveBeenCalledTimes(1)
      await expect(shutdownPromise).resolves.toEqual({quiesced: true})
    })
  })
})

async function listenOnEphemeralPort(): Promise<{server: net.Server; url: string}> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('failed to bind ephemeral port'))
        return
      }
      resolve({server, url: `http://127.0.0.1:${String(address.port)}`})
    })
  })
}

async function closeServer(server: net.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()))
}

describe('waitForServerQuiescence', () => {
  it('resolves quiesced: true almost immediately when nothing is listening on the port', async () => {
    // #given a port that was briefly bound, then released — mirroring pickFreePort's own
    // bind-then-release trick, and the shape of a mocked SDK that never truly listens
    const {server, url} = await listenOnEphemeralPort()
    await closeServer(server)

    // #when waiting for quiescence with a generous budget
    const startedAt = Date.now()
    const result = await waitForServerQuiescence(url, 2000, 20)
    const elapsedMs = Date.now() - startedAt

    // #then it resolves quiesced: true well within the budget — the very first poll
    // already finds the port closed
    expect(result).toEqual({quiesced: true})
    expect(elapsedMs).toBeLessThan(1000)
  })

  it('resolves quiesced: true once a live listener closes mid-poll (the real quiescence case)', async () => {
    // #given a real listener standing in for a still-live OpenCode child
    const {server, url} = await listenOnEphemeralPort()

    // #when starting the quiescence wait, then closing the listener shortly after —
    // simulating the child finally exiting a couple of poll cycles in
    const waitPromise = waitForServerQuiescence(url, 2000, 20)
    await new Promise(resolve => setTimeout(resolve, 60))
    await closeServer(server)

    // #then the wait observes the closure and reports quiesced: true, not a timeout
    await expect(waitPromise).resolves.toEqual({quiesced: true})
  })

  it('resolves quiesced: false when the port keeps accepting connections past the timeout budget', async () => {
    // #given a listener that never closes — a child that is still alive and did not exit
    // within the wait budget
    const {server, url} = await listenOnEphemeralPort()

    try {
      // #when waiting for quiescence with a short, deliberately-exceeded budget
      const result = await waitForServerQuiescence(url, 120, 20)

      // #then the wait times out rather than hanging, and reports the unconfirmed state
      // honestly instead of assuming success
      expect(result).toEqual({quiesced: false})
    } finally {
      await closeServer(server)
    }
  })

  it('resolves quiesced: false immediately for a URL it cannot parse, rather than throwing out of a cleanup path', async () => {
    // #given a malformed URL that new URL() rejects
    const result = await waitForServerQuiescence('not a url', 500, 20)

    // #then the failure is reported as an unconfirmed quiescence, not an exception
    expect(result).toEqual({quiesced: false})
  })
})
