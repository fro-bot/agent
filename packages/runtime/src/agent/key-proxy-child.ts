import type {Readable} from 'node:stream'
import type {Logger} from '../shared/logger.js'
import type {KeyProxyChildErrorCode} from './key-proxy-wire.js'
import type {KeyProxyServer} from './key-proxy.js'
import {Buffer} from 'node:buffer'
import {
  KEY_PROXY_EXIT_INTERNAL,
  KEY_PROXY_EXIT_INVALID_CONFIG,
  KEY_PROXY_EXIT_START_FAILED,
  parseKeyProxyConfig,
  readKeyProxyFrameLength,
} from './key-proxy-wire.js'
import {startKeyProxy} from './key-proxy.js'

/**
 * The key-proxy child's main loop, with its process streams injected so tests can run it in-process.
 *
 * It reads one framed config from stdin, starts the proxy, prints one ready line and then waits: stdin closing, a
 * shutdown request, or an internal failure ends it. Its output is a fixed set of lines. It never prints a stack, a
 * quoted input, a key or a path, and it prints nothing else on stdout.
 */

export interface KeyProxyChildIo {
  readonly stdin: Readable
  readonly stdout: {readonly write: (chunk: string) => unknown}
  /** Ends the process. Called at most once. */
  readonly exit: (code: number) => void
  /** Longest to wait for the whole frame. Default 10 s. */
  readonly frameTimeoutMs?: number
}

export interface KeyProxyChild {
  /** Stops the proxy and exits 0. */
  readonly requestShutdown: () => void
  /** Prints the fixed error line for `code` and exits non-zero. */
  readonly fail: (code: KeyProxyChildErrorCode) => void
}

const DEFAULT_FRAME_TIMEOUT_MS = 10_000

const EXIT_CODES: Readonly<Record<KeyProxyChildErrorCode, number>> = {
  'invalid-config': KEY_PROXY_EXIT_INVALID_CONFIG,
  'start-failed': KEY_PROXY_EXIT_START_FAILED,
  internal: KEY_PROXY_EXIT_INTERNAL,
}

const SILENT_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warning: () => undefined,
  error: () => undefined,
}

export function runKeyProxyChild(io: KeyProxyChildIo): KeyProxyChild {
  let finished = false
  let proxy: KeyProxyServer | undefined
  let frameTimer: ReturnType<typeof setTimeout> | undefined

  const finish = (code: number, line?: string): void => {
    if (finished) return
    finished = true
    if (frameTimer !== undefined) clearTimeout(frameTimer)
    if (line !== undefined) io.stdout.write(`${line}\n`)
    io.exit(code)
  }

  const fail = (code: KeyProxyChildErrorCode): void => {
    // The error line goes out first; the exit does not wait for a stuck close.
    proxy?.close().catch(() => undefined)
    finish(EXIT_CODES[code], JSON.stringify({error: code}))
  }

  const requestShutdown = (): void => {
    if (finished) return
    const closing = proxy?.close() ?? Promise.resolve()
    closing.then(
      () => finish(0),
      () => finish(0),
    )
  }

  const chunks: Buffer[] = []
  let configured = false

  const onConfigFrame = async (payload: Buffer): Promise<void> => {
    let decoded: unknown
    try {
      decoded = JSON.parse(payload.toString('utf8'))
    } catch {
      fail('invalid-config')
      return
    }
    const config = parseKeyProxyConfig(decoded)
    if (!config.success) {
      fail('invalid-config')
      return
    }
    const started = await startKeyProxy({
      providers: config.data.providers,
      logger: SILENT_LOGGER,
      ...(config.data.ca === undefined ? {} : {ca: config.data.ca}),
    })
    if (!started.success) {
      fail('start-failed')
      return
    }
    proxy = started.data
    if (finished) {
      // A shutdown or a failure won the race while the proxy was starting.
      proxy.close().catch(() => undefined)
      return
    }
    io.stdout.write(`${JSON.stringify({ready: true, port: started.data.port})}\n`)
  }

  const onData = (chunk: Buffer): void => {
    if (finished || configured) return
    chunks.push(chunk)
    const buffered = Buffer.concat(chunks)
    if (buffered.length < 4) return
    const length = readKeyProxyFrameLength(buffered)
    if (length === null) {
      fail('invalid-config')
      return
    }
    if (buffered.length < 4 + length) return
    configured = true
    if (frameTimer !== undefined) clearTimeout(frameTimer)
    onConfigFrame(buffered.subarray(4, 4 + length)).catch(() => fail('internal'))
  }

  const onClosed = (): void => {
    if (finished) return
    if (configured) {
      requestShutdown()
    } else {
      fail('invalid-config')
    }
  }

  frameTimer = setTimeout(() => {
    if (!configured) fail('invalid-config')
  }, io.frameTimeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS)

  io.stdin.on('data', onData)
  io.stdin.once('end', onClosed)
  io.stdin.once('close', onClosed)
  io.stdin.on('error', onClosed)

  return {requestShutdown, fail}
}
